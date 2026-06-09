---
title: "长期记忆 ingest 30 QPS 吞吐问题复盘"
date: 2026-06-09
draft: false
categories: ["notes"]
---

# 长期记忆 ingest 30 QPS 吞吐问题：从发现到解决的完整复盘

> 时间：2026-06-08 ~ 06-09
> 服务：长期记忆微服务（独立 Python/FastAPI 服务，Kafka 异步 ingest 管道）
> 结论一句话：**30 QPS 下 ingest 处理慢、积压发散，真正根因是「LLM 慢调用期间长期占用 DB 连接 -> 连接池饥饿」，而非 LLM 本身慢或重复消费。在每个只读 DB 阶段后及时释放连接后，单条处理从 6-39s 降到 ~2s，吞吐提升约 7 倍。**

---

## 一、起因：压测目标

需求：评估 **30 QPS 负载下"处理长期记忆"的耗时**，判断系统能否扛住。

长期记忆有两条独立链路：
- **retrieve（读，同步在聊天主链路）**：聊天时调 memory `/v1/memory/retrieve`（向量检索 + embedding），延迟直接加到聊天响应；主应用服务有 1500ms 超时预算。
- **ingest（写，异步 Kafka）**：发消息攒 4 轮后调 `/v1/memory/ingest`，内部 extract -> embed -> resolve -> 落库，含多次 LLM 调用，不阻塞聊天响应。

压测重点是 ingest 端到端处理耗时（用户最关心）。

---

## 二、压测方法与踩的第一个坑：跨境网络

### 方法

- 工具：vegeta 装不上（GitHub 不可达），改用纯 curl 固定 QPS 脚本。
- 端到端耗时**不能靠压测客户端测**（ingest 是 Kafka 异步，HTTP 只测到入队毫秒级），必须从 SigNoz 服务端日志取 `Ingest processed successfully` 的 `lag_ms`（入队 -> 完成）和 `process_ms`（纯处理）。
- ingest 用专用前缀 uid（`stress_<时间戳>_<序号>`，每条唯一，避免 `trace_id=SHA1(uid:cid:session:content)` 去重）。

### 坑 1：本机跨境压测，结果失真

首次从本机（跨境到目标服务所在区域，200-400ms RTT）压测：成功率仅 33.8%、大量 `http2: client conn could not be established`。
**但 SigNoz 显示服务端到达的请求都是 200、处理正常**，瓶颈是客户端/网络，不是服务。
**教训：压测线上服务必须用同区域/同内网的压测机。** 换到同区域云主机后才得到有效数据。

---

## 三、诊断过程中的两次误判（重要教训）

> 这两次误判都来自**查询工具使用错误**，记录下来避免重蹈覆辙。

### 误判一：「重复消费 6.7x」——不存在

- 现象：用 SigNoz `aggregate_logs` 的 `count` 聚合 + `user_id LIKE 'stress_...'` 过滤，得到完成数 5459/6016 远大于输入 900，判断"消息被重复消费 6.7 倍"。
- 查明：**`aggregate_logs` 工具对 attribute 字符串字段（user_id）的 LIKE 过滤不生效**，条件被忽略 -> 把同时段所有真实用户流量并入了 count。
- 真相（按 trace 精确统计）：Processing ingest=900、Ingest processed successfully=900、deepseek_call=900、distinct trace_id=900、unique partition:offset=900 -> **900 输入 = 900 处理，无任何重复消费**。

**教训：SigNoz 按业务标识精确计数，用 `search_logs`（其 user_id LIKE 生效）或 trace 唯一性 / DB 精确统计，不要用 `aggregate_logs` 的 count + 字符串 LIKE。**

### 误判二：「consumer 并发只有 1-2」——不成立

- 现象：某批样本里 `active_ingest_count=1~2`，怀疑 consumer 并发起不来 / event loop 被同步调用阻塞。
- 查明：**那批样本跑在旧 consumer 上**，旧代码没有 `active_ingest_count` 埋点，ClickHouse 对缺失 map key 返回 0/默认值，不是真实并发数。
- 验证方法：查新 consumer 版本特征日志 `Kafka ingest batch enqueued` 是否出现。重压后确认新 consumer 实测 `active_ingest_count=30`、`worker_count=30`、partition 0-29 全用、`semaphore_wait_ms=0`，**并发完全是满的**。

**教训：判断某版本代码是否真生效，要查该版本新增的特征日志，不能假设最新代码已部署；缺失字段在日志库里返回默认值，别据此推断。**

---

## 四、有效压测数据的演进

### 阶段 1：旧 consumer（数据部分不可信）

- 单条 process_ms ~3.5s（低并发样本），lag 发散。

### 阶段 2：切换更直接的 LLM 服务路径

- 低并发样本单条 process_ms 降到 ~1.9s。
- 但 30 QPS 下 lag 仍发散到 200s+。

### 阶段 3：新 consumer + 满 30 并发，暴露真问题

关键发现：
- 并发**确实满了**（active=30, worker=30, semaphore_wait=0），不是并发起不来。
- **但满 30 并发时，单条 process_ms 从低并发的 1.9s 飙到 6~39s（劣化 3-20 倍）。**
- lag 发散到 ~265s，900 条要 3-5 分钟消化。
- 有效吞吐 ~2 条/s，远不及 30 QPS 输入。

当时的初步归因是"LLM 高并发下被限流排队"。但这个归因**不完全对**，下一步的阶段耗时埋点揭示了真相。

---

## 五、真正的根因：DB 连接池饥饿 x LLM 慢调用

### 关键观察

- `kafka_max_concurrent_ingest = 30`（全局在飞 ingest 上限，30 个 worker）
- DB pool 配置：`pool_size=5, max_overflow=10`（共 **15** 连接）

### 根因机制

优化前的 `process_ingest`：每个 ingest 在 checkpoint（幂等检查）、dedupe、vector search 这些**只读 DB 阶段**之后，紧接着 extract / embed / resolve（**慢 LLM 调用，几秒~几十秒**），而这期间**始终持有同一个 DB 连接不释放**。

于是：**30 个并发 ingest 抢 15 个 DB 连接**，而持有连接的 worker 又卡在等 LLM 返回，形成典型的**连接池饥饿 x 慢外部调用叠加**。一半 worker 拿不到连接干等，导致单条端到端耗时被放大到 6-39s。

**所以"30 并发下单条变慢"的主因不是 LLM 本身慢，而是 DB 连接竞争。** 这也解释了为什么并发从 12 调到 30 反而更差（更多 worker 抢同样 15 个连接）。

---

## 六、解决方法

### 核心改动（长期记忆服务核心模块）

把 `process_ingest` 重构成清晰的 A-E 五阶段，**在每个只读 DB 阶段后立即 `_release_read_transaction()`（= `session.rollback()`）释放连接**，让 LLM 调用期间不占 DB 连接：

| 阶段 | 内容 | DB | 释放点 |
|---|---|---|---|
| checkpoint | 幂等检查 `_is_ingest_processed` | 只读 | yes，后释放 |
| extract | 抽取候选 | LLM | 不占连接 |
| dedupe | 指纹去重 `_get_mempoint_by_source` | 只读 | yes，后释放 |
| embed | 批量 embedding | LLM | 不占连接 |
| search | pgvector 相似检索 | 只读 | yes，后释放 |
| resolve | 合并/替换决策 | LLM | 不占连接 |
| write | 串行写入 + commit | 读写 | 长事务，无法中途释放（保证原子性） |

释放后下一阶段 DB 操作自动从 pool 重新拿连接（SQLAlchemy async session 在 rollback 后处于无活动事务态，下次 execute 自动 begin）。释放点之前都是纯只读查询，没有 pending 的 ORM 写状态，rollback 安全。

### 配套改动

- **阶段耗时埋点**：新增 `checkpoint_ms / extract_ms / dedupe_ms / embed_ms / search_ms / resolve_ms / write_ms / total_ms`，写进 `ingest resolved` 日志，以后瓶颈一目了然，不用再猜。
- embedder 模块：embedding 加显式 timeout、有限 retry、Retry-After 支持、`embedding_call` 日志、失败后 hash fallback。
- LLM client 模块：关闭 SDK 内置隐藏重试，避免双层 retry 干扰耗时判断。
- config 模块：新增 embedding base url、connect/read timeout、retry 配置。
- 补测试：DB 只读事务释放、embedding retry/fallback。

---

## 七、优化后压测验证（同样 30 QPS x 30s x 900 条）

### 阶段耗时拆解（埋点直接给出）

| 阶段 | 耗时 | 性质 |
|---|---|---|
| checkpoint_ms | **0** | DB 只读，已释放 |
| dedupe_ms | **1** | DB 只读 |
| extract_ms | ~1.5s | LLM，大头 |
| embed_ms | 0.2~2.3s | embedding，波动 |
| search_ms | **3~4ms** | DB 向量检索 |
| resolve_ms | 0（本压测全 CREATE）| 真实场景才有 |
| write_ms | **9~12ms** | DB 写 |
| **total_ms** | **~2s（1.6~3.9s）** | |

**所有 DB 阶段都降到个位数 ms，证明连接竞争被彻底消除。剩余耗时全是纯 LLM 调用（extract+embed），是合理下限。**

### 前后对比

| 指标 | 优化前（满30并发）| 优化后 | 改善 |
|---|---|---|---|
| 单条 process_ms | 6~39s | **~2s** | 快 3-20 倍 |
| lag_ms 峰值 | ~265s | **~64s** | 降 4 倍 |
| 总消化时长 | 3~5 分钟 | **<=2 分钟** | 快 2 倍+ |
| 有效吞吐 | ~2 条/s | **~15 条/s** | **提升约 7 倍** |
| 换算可支撑聊天 QPS（x4）| ~8 | **~60** | |

---

## 八、结论与遗留

### 结论

1. **真正瓶颈是 DB 连接池饥饿**（LLM 慢调用期间霸占连接，30 并发抢 15 连接），不是 LLM 本身慢、不是重复消费、不是 consumer 并发起不来。
2. **解决手段：只读 DB 阶段后及时释放连接**，使 15 个连接足以服务 30 并发的短促 DB 操作。配合阶段耗时埋点，瓶颈从此可观测。
3. 优化后单条 ~2s、吞吐 ~15 条/s，30 QPS 突发能在 2 分钟消化；换算可稳态支撑约 60 聊天 QPS。

### 进一步优化方向（如需再榨吞吐）

- 当前耗时全在 LLM：extract（~1.5s）+ embed（0.2-2.3s 波动较大）。
- embed 换更稳定/更快的 embedding 源可降波动。
- 评估 extract+resolve 合并为更少的 LLM 往返。
- 找 `kafka_max_concurrent_ingest` 最优值（并发与单条耗时存在 tradeoff，但 DB 释放后该问题已大幅缓解）。

### 方法论沉淀（已可入排查规范）

1. 压测线上服务必须用同区域压测机，跨境网络会淹没一切。
2. ingest 是 Kafka 异步，端到端耗时看 SigNoz `lag_ms`/`process_ms`，不是压测客户端延迟。
3. SigNoz `aggregate_logs` 对 attribute 字符串字段 LIKE 过滤不可靠，精确计数用 `search_logs` / trace 唯一性 / DB。
4. 判断某版本是否生效，查该版本新增特征日志；缺失字段在日志库返回默认值，别据此推断。
5. **慢外部调用（LLM/HTTP）期间不要持有稀缺资源（DB 连接）**，这是本次最核心的工程教训。
6. 加**阶段耗时埋点**是定位"整体慢但不知慢在哪"的最有效手段。

### 待办

清理压测垃圾数据（多批 `stress_*` 前缀数据）：

```sql
-- instance memory-service / database memory_db
DELETE FROM memory_points     WHERE user_id LIKE 'stress_%';
DELETE FROM memory_summaries  WHERE user_id LIKE 'stress_%';
-- 执行前先 SELECT count 确认范围
```
