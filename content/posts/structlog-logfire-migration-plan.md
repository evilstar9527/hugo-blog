---
title: "Tipsy Studio `apps/api` 迁移到 `structlog + Logfire` 的改造方案"
date: 2026-05-11
draft: false
categories: ["notes"]
---

本文给出 `tipsy-studio` 后端 `apps/api` 的结构化日志改造方案。目标不是继续讨论方向，而是沉淀一份可以直接交给实现者执行的实施方案。

本方案以前提决策为基础：

- 后端日志路线改为直接引入 `structlog`
- 范围覆盖整个 `apps/api`
- 保持 Logfire 作为观测后端
- stdout 继续保留开发友好的可读格式
- 本次采用“核心字段统一”，不一次性设计严格全量 schema

## 1. 背景与目标

当前 `apps/api` 已经接入了一部分 Logfire 能力：

- `apps/api/main.py` 中调用了 `logfire.configure(...)`
- `apps/api/main.py` 中调用了 `logfire.instrument_fastapi(app)`
- 少量业务点显式调用了 `logfire.info(...)`、`logfire.warning(...)`、`logfire.error(...)`

但目前观测仍然存在明显缺口：

- 绝大多数真实运行日志仍然来自 Python 标准库 `logging`
- 这些日志主要输出到 stdout
- 它们没有完整、统一地以结构化方式进入 Logfire

随着规模扩大到更高日活，单纯依赖文本 grep 的局限会越来越明显：

- 跨大量请求做聚合分析成本高
- 依赖字符串模式匹配，不够稳定
- 自动化排障、仪表盘和告警对固定字段依赖更强

本次改造目标是：

- 将 `apps/api` 的日志主入口统一为 `structlog`
- 将业务日志升级为结构化事件
- 让结构化日志与 Logfire trace 关联
- 保留本地和容器中可读的 stdout 输出

## 2. 为什么这次直接选 `structlog`

这次不是简单地把日志“接进 Logfire”，而是要建立一个能支撑规模增长的结构化日志体系。基于这个目标，`structlog` 是更合适的选择。

选择 `structlog` 的原因：

- 它适合长期维护结构化事件模型
- 它天然支持上下文绑定，适合请求链路中的 `trace_id`、`user_id`、`project_id`、`session_id`、`sandbox_id` 等字段
- 它与 Logfire 有官方集成方式
- 当前代码中关键主键已经大量存在，适合做渐进式结构化
- 后续无论是 agent 查询、仪表盘、聚合分析还是告警，结构化字段都比字符串插值更稳定

这次不继续只靠标准 `logging + handler` 的原因：

- 这种方案能解决“日志进入 Logfire”的问题
- 但它不能从根上统一日志上下文和事件模型
- 对未来规模下的筛选、聚合、自动化分析支撑不足

这次不选 `loguru` 的原因：

- 当前代码基础不是 `loguru`
- 引入它会形成额外的双体系复杂度
- 相比 `structlog`，它在长期结构化事件模型上不是更优解
- Logfire 官方文档明确提到，`loguru` 格式化后的 message 当前不会被 Logfire 做敏感信息 scrub，这对业务日志是实际风险

## 3. 当前代码现状

当前代码以标准 `logging` 为基础：

- `apps/api/main.py` 使用 `logging.config.dictConfig(...)`
- 模块级 logger 广泛使用 `logging.getLogger(__name__)`
- 日志分布范围不是只在 router，而是覆盖整个后端

当前日志较多的关键模块包括：

- `apps/api/routers/chat.py`
- `apps/api/services/sandbox_service.py`
- `apps/api/services/workspace_versions.py`
- `apps/api/sdk/http.py`
- `apps/api/sdk/handlers/character_chat/*`
- `apps/api/tools/*`
- `apps/api/main.py` 中的后台任务与启动逻辑

现有关键链路中已经存在大量天然结构化字段，只是现在大多嵌在 message 中：

- `trace_id`
- `user_id`
- `project_id`
- `session_id`
- `conversation_id`
- `character_id`
- `sandbox_id`
- `run_id`
- `duration_ms`

这意味着本次迁移的重点不是“创造字段”，而是：

- 统一日志入口
- 统一上下文绑定方式
- 统一事件命名
- 把关键维度从 message 中抽为独立字段

## 4. 总体改造原则

本次改造遵循以下原则：

- 统一日志主入口为 `structlog`
- 统一通过一个集中式模块初始化 stdlib logging、structlog 和 Logfire
- 保留 stdout 可读输出，不强制 stdout JSON 化
- 所有高价值日志必须有稳定 `event`
- 关键主键尽量变成独立字段，而不是只存在于 message 中
- 不要求一次性把所有日志设计成严格 schema
- 优先改主链路和异常路径
- 保留原有业务语义，不做无意义重命名
- 不长期保留“部分模块走 logging、部分模块走 structlog”的双主入口状态

## 5. 基础设施设计

### 5.1 依赖调整

在 `apps/api/pyproject.toml` 中增加 `structlog` 依赖。

### 5.2 新增统一日志初始化模块

新增一个集中式日志模块，推荐命名为：

- `apps/api/logging_config.py`

这个模块负责：

- 初始化 stdlib logging
- 初始化 structlog processor 链
- 配置 Logfire 的 `StructlogProcessor`
- 暴露统一的 logger 获取方式

实现上需要满足两个目标：

- `structlog` 成为业务代码使用的主 logger
- 标准库 logging 仍然作为底层兼容层存在，便于框架和第三方库输出日志

### 5.3 processor 链要求

processor 链至少包含以下能力：

- `merge_contextvars`
- level 信息
- logger name
- timestamp
- stack / exception formatting
- Logfire processor
- 控制台 renderer

关键约束：

- `merge_contextvars` 必须放在 processor 链最前面
- 异常日志必须保留 stack trace
- 控制台 renderer 应保证本地和容器日志可读

### 5.4 `main.py` 中的初始化调整

`apps/api/main.py` 中现有 `configure_logging()` 需要收敛到新模块：

- 不再以 `dictConfig(...)` 为最终主方案
- 由统一日志模块完成 logging / structlog / Logfire 配置
- 应用启动时先完成日志初始化，再创建 FastAPI app 和注册 Logfire instrumentation

## 6. 请求级上下文绑定方案

这是本次改造的核心部分。

如果只把 logger 换成 `structlog`，但没有设计完整的上下文绑定策略，最终仍然会得到一套“结构化外壳 + 零散字段”的半成品体系。

### 6.1 请求入口绑定

在 FastAPI 请求入口增加统一 middleware，负责：

- 每次请求开始时调用 `clear_contextvars()`
- 绑定当前请求可以稳定获得的上下文字段

建议默认绑定以下通用字段：

- `trace_id`
- `request_path`
- `request_method`

### 6.2 业务字段绑定

不同链路可以拿到更多业务字段，这些字段应在业务入口显式补充绑定，而不是强行都放在 middleware 里。

建议统一纳入上下文的字段包括：

- `user_id`
- `project_id`
- `session_id`
- `conversation_id`
- `character_id`
- `sandbox_id`
- `run_id`

原则如下：

- middleware 只绑定“请求一开始就一定能拿到”的字段
- 业务代码在拿到实体或参数后，显式补 bind 业务字段
- 不伪造未知字段
- 拿不到就不写

### 6.3 请求结束与上下文隔离

上下文隔离规则明确如下：

- 每次请求进入时必须 `clear_contextvars()`
- 不依赖请求结束时自动隐式清理来维持正确性
- 下一次请求开始时重新 clear + bind

### 6.4 后台任务与非请求路径

后台任务和非请求上下文不能强行绑定请求字段。

策略如下：

- 不绑定无意义的 `request_path` / `request_method`
- 在进入具体业务动作时手动绑定可用主键

典型示例：

- `_sleep_checker()` 绑定 `project_id`、`session_id`
- `sandbox` 相关后台恢复逻辑绑定 `project_id`、`sandbox_id`

### 6.5 与现有 trace 逻辑的关系

对于 SDK 和 chat 路由，当前已经有 `trace_id` 生成逻辑，应直接复用，不重新发明 trace 规则。

本次方案要求：

- 仍由现有 Logfire / FastAPI instrumentation 生成和传递 trace
- structlog 上下文负责把 `trace_id` 与业务字段带到每条结构化日志中

## 7. 事件命名与字段规范

### 7.1 事件命名

每条高价值日志都必须有稳定 `event`。

事件名规则：

- 优先沿用当前点分风格
- 使用稳定、可筛选、可聚合的名字
- 避免把事件语义藏在自然语言 message 里

推荐示例：

- `sandbox.wake.start`
- `sandbox.wake.completed`
- `sandbox.wake.failed`
- `sandbox.create.completed`
- `chat.stream.failed`
- `chat.completed`
- `sdk.respond.persist_failed`
- `sdk.reply.stream_failed`
- `workspace.restore.completed`

### 7.2 核心字段统一规范

本次不定义全量严格 schema，但以下字段是统一的核心字段集合：

- `event`
- `trace_id`
- `user_id`
- `project_id`
- `session_id`
- `conversation_id`
- `character_id`
- `sandbox_id`
- `run_id`
- `duration_ms`
- `status`
- `error_type`
- `error_message`

要求如下：

- 能获取时就写
- 不能获取时就省略
- 不用占位假值污染日志

### 7.3 异常日志要求

异常日志必须同时满足：

- 保留 stack trace
- 暴露结构化错误类型
- 暴露结构化错误摘要

建议统一字段：

- `error_type`
- `error_message`

### 7.4 性能日志要求

涉及耗时的日志统一使用独立字段：

- `duration_ms`

不要继续只把耗时拼到 message 中。

### 7.5 message 的职责

message 可以保留，但职责要缩小：

- 用于人类阅读
- 用于控制台快速浏览

不再依赖 message 承担：

- 主检索键
- 主业务语义
- 主聚合维度

## 8. 模块迁移顺序

本次改造建议按下面顺序推进，避免范围过大而失控。

### 第一阶段：基础设施与上下文绑定

- 新增 `structlog` 依赖
- 新增统一日志初始化模块
- 在 `main.py` 中接入新的初始化逻辑
- 增加 FastAPI 请求级 contextvars 绑定 middleware

### 第二阶段：全局与主生命周期

- `apps/api/main.py`
- 启动日志
- 后台任务日志
- 全局异常和中间件相关日志

### 第三阶段：sandbox 主链路

- `apps/api/services/sandbox_service.py`
- 优先迁移 create / wake / recover / sleep 相关日志
- 这些事件天然适合结构化，且主键字段清晰

### 第四阶段：chat 主链路

- `apps/api/routers/chat.py`
- 优先迁移 run、stream、pause、resume、error、completed 相关日志

### 第五阶段：SDK 主链路

- `apps/api/sdk/http.py`
- `apps/api/sdk/handlers/character_chat/*`
- 优先迁移 respond / reply / regenerate / completion_flow 相关异常与关键事件

### 第六阶段：workspace 与运行态

- `apps/api/services/workspace_versions.py`
- 优先迁移 restore / publish / runtime reconcile / rollback 相关日志

### 第七阶段：tools 与 agent runtime

- `apps/api/tools/*`
- `apps/api/tools/runtime.py`
- `apps/api/tools/agent_toolset.py`

### 第八阶段：收尾模块

- 其余零散 services / repositories / routes
- 清理残留 `logging.getLogger(__name__)`

阶段约束：

- 新改动模块统一使用 structlog
- 已迁移模块不再新增标准 `logging` 主 logger 用法

## 9. 与 Logfire 的集成方式

Logfire 相关策略保持清晰分工：

- 保留 `logfire.configure(...)`
- 保留 `logfire.instrument_fastapi(app)`
- 结构化业务日志通过 Logfire 官方 `StructlogProcessor` 进入 Logfire

职责分工如下：

- Logfire instrumentation 提供请求级 trace 能力
- structlog 提供结构化业务事件与上下文
- 两者通过 `trace_id` 和业务字段关联

对于当前 `apps/api/observability.py` 中少量显式 `logfire.info/warning/error(...)`：

- 能改成统一 structlog logger 的尽量改
- 避免长期存在两套事件语义
- 如果短期保留，也要保证事件命名与字段规范一致

## 10. 兼容与回退策略

本次改造需要控制风险，但不能因此把目标变成长期双体系。

兼容策略如下：

- 允许短期桥接标准 logging，用于框架和第三方库兼容
- 业务代码的主 logger 最终统一到 structlog
- 如果某些低价值日志点短期来不及完全结构化，可先桥接输出
- 但这不能阻塞主链路迁移

回退与边界策略如下：

- 不做一次性全量 message 重写
- 优先保证事件名和字段稳定
- 本地 stdout 必须保持可读
- 拿不到完整上下文时允许缺字段，但不允许伪造字段

## 11. 验证方案

改造完成后，至少验证以下内容。

### 11.1 启动与基础设施

- 应用启动无日志初始化错误
- 本地 stdout 保持可读控制台输出
- 日志不会输出成难读原始对象

### 11.2 请求链路

- 普通 API 请求在 Logfire 中可见结构化事件
- 每条请求链路至少能稳定关联 `trace_id`

### 11.3 Chat 链路

- chat 主链路能在 Logfire 中按以下字段检索：
  - `trace_id`
  - `project_id`
  - `session_id`
  - `run_id`

### 11.4 SDK character chat 链路

- SDK character chat 能按以下字段检索：
  - `trace_id`
  - `user_id`
  - `session_id`
  - `character_id`

### 11.5 Sandbox 生命周期

- sandbox create / wake / sleep / recover 能按以下字段检索：
  - `project_id`
  - `session_id`
  - `sandbox_id`

### 11.6 异常链路

- 异常路径能看到 stack trace
- 异常路径能看到结构化 `error_type` 与 `error_message`

### 11.7 回归验证

- 跑后端现有测试，至少覆盖：
  - chat
  - sdk
  - tool runtime
- 确认日志改造没有引入业务行为回归

## 12. 风险与后续演进

本次改造的主要风险在于异步应用中的上下文管理。

重点风险：

- `structlog` 在 FastAPI / Starlette 这类异步环境中必须严格使用 `contextvars`
- 如果请求入口不做 `clear_contextvars()`，上下文可能串请求
- 如果业务字段绑定时机不统一，日志字段会不稳定

这也是为什么本次方案要求：

- 请求入口统一 clear + bind
- 业务入口显式补 bind
- 不依赖隐式上下文传递

后续演进边界如下：

- 本次只覆盖 `apps/api`
- 不涉及前端日志体系
- 不涉及沙箱内 Node/Vite 进程日志统一结构化
- 如果未来要把沙箱日志、前端日志、外部任务日志也统一进 Logfire，应作为下一阶段单独设计

## 13. 一句话结论

本次改造不是“把现有日志送到 Logfire”这么简单，而是要把 `apps/api` 的日志主入口统一到 `structlog`，建立一套能支撑更大规模排障、聚合分析和自动化观测的结构化日志体系。
