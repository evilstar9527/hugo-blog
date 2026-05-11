---
title: "旧方案 vs 新方案：Chat 流式链路详细对比"
date: 2026-05-11
draft: false
categories: ["notes"]
---

更新时间：2026-04-15 22:23 CST

## 1. 背景

当前有两套聊天流式方案：

- 旧方案：`POST /projects/{project_id}/chat`
- 新方案：`POST /projects/{project_id}/chat/runs` + `GET /projects/{project_id}/chat/runs/{chat_run_id}/events`

两套方案都能支持流式返回、断线重连和基于 `run_id` 的恢复，但它们的职责边界不同。

核心区别不是“接口从 1 个变成 2 个”，而是：

- 旧方案里，请求本身既承担“创建 run”，也承担“执行任务”，还承担“推流”
- 新方案里，run 先被创建出来，事件流消费与 run 身份分离

这使得新方案在 SSE 断连、代理空闲超时、终态补发、resume 语义上更稳定。

---

## 2. 旧方案概览

### 2.1 接口形态

- `POST /projects/{project_id}/chat`
- 首次请求直接返回 `text/event-stream`
- `run_id` 通过 SSE 响应头 `X-Chat-Run-Id` 返回
- 断线恢复依赖 `GET /projects/{project_id}/chat/resume/{chat_run_id}`

### 2.2 旧方案时序

```text
Browser                     API                         Agent/LLM                 Buffer
   |                         |                              |                       |
   | POST /chat              |                              |                       |
   |------------------------>|                              |                       |
   |                         | 创建 run_id                  |                       |
   |                         | 启动 agent                   |                       |
   |                         | 开始 SSE 响应                |                       |
   |<===== SSE stream =======|                              |                       |
   |  从响应头拿 X-Chat-Run-Id |                              |                       |
   |                         | 持续转发 token/tool/status    |                       |
   |<===== text/tool ========|<========= stream ============|                       |
   |                         |                              |                       |
   |   连接中断/LB timeout    X                              |                       |
   |------------------------x|                              |                       |
   |                         | 尝试 detach/drain            |---------------------->|
   |                         |                              |                       |
   | GET /chat/resume/{id}   |                              |                       |
   |------------------------>|                              |                       |
   |<==== replay/tail =======|<-----------------------------|                       |
```

### 2.3 旧方案中 buffer 的职责

旧方案的 buffer 主要是“事件缓存层”，不是独立的 run 控制面。它做的是：

- 为每条 SSE 事件生成递增 `event_id`
- 将事件写入 Redis，供 resume 时 replay
- 在主连接断开后，如果 detached drain 仍在运行，继续接收后台事件
- 记录 `terminal` 状态，供 resume 判断 run 是否结束
- 在没有终态事件但 run 已经不活跃时，通过 `mark_orphaned()` 注入兜底 error

旧方案的 buffer 不做这些事情：

- 不负责创建 run
- 不负责保存原始请求 payload
- 不负责区分“这个 run 是否已经被首次执行”
- 不负责重新启动执行

所以旧方案的 buffer 本质上是：

- `event log`

而不是：

- `event log + run control state`

### 2.4 旧方案的优点

- 接口简单，前端一步发起即可
- 语义直观：发请求就开始跑
- 兼容已有直接消费 SSE 的调用方

### 2.5 旧方案的结构性问题

旧方案最大的问题是“连接生命周期”和“任务生命周期”天然耦合。

具体体现在：

1. 同一个请求同时承担四个职责

- 创建 `run_id`
- 启动 agent
- 执行 agent loop
- 将事件实时写到当前这条 SSE 连接

2. 同一个调用栈既是执行栈，又是网络发送栈

一旦 HTTP 连接断开、`StreamingResponse` 被取消、代理超时，就很容易影响到执行流程本身。

3. 服务端必须显式补各种例外逻辑

例如：

- 连接断开后是否要 detach
- detach 后谁负责 drain
- drain 期间如何继续 keepalive
- 终态 `done/error` 是先发给客户端还是先写 buffer
- `send_failed` 之后如何兜底终态

4. resume 语义偏被动

resume 只能“补看已经发生的事件”，因为 run 本身还是最初那个 `/chat` 请求带起来的。

### 2.6 旧方案最典型的故障模式

在真实场景中，旧方案最容易出现这些问题：

- 代理/LB 60s 或 120s idle timeout 导致 SSE 断流
- 前端 resume 成功，但 detached drain 没接管好
- agent 实际继续跑了，但终态事件没有写入 buffer
- `chat.stream.send_failed` 后 run 静默结束，前端永远看不到 `done/error`

这类问题不是功能缺失，而是架构天然耦合导致恢复路径复杂、状态边界模糊。

---

## 3. 新方案概览

### 3.1 接口形态

- `POST /projects/{project_id}/chat/runs`
- `GET /projects/{project_id}/chat/runs/{chat_run_id}/events`

可选恢复仍可基于：

- `Last-Event-ID`
- Redis buffer replay

### 3.2 新方案时序

```text
Browser                     API                         Agent/LLM                 Buffer
   |                         |                              |                       |
   | POST /chat/runs         |                              |                       |
   |------------------------>|                              |                       |
   |                         | 创建 run_id                  |                       |
   |                         | 保存请求 payload              |---------------------->|
   |<-- {chat_run_id} -------|                              |                       |
   |                         |                              |                       |
   | GET /chat/runs/{id}/events (EventSource)              |                       |
   |------------------------>|                              |                       |
   |                         | mark_execution_started       |                       |
   |                         | 读取 payload                  |                       |
   |                         | 启动 agent                   |---------------------->|
   |<===== SSE stream =======|                              |                       |
   |                         | 每条业务事件先写 buffer       |---------------------->|
   |<===== text/tool ========|<========= stream ============|                       |
   |                         |                              |                       |
   | 连接中断/LB timeout      x                              |                       |
   |------------------------x|                              |                       |
   |                         | agent 可继续跑 / detached     |                       |
   |                         | 终态仍可写 buffer             |---------------------->|
   |                         |                              |                       |
   | EventSource 自动重连     |                              |                       |
   | GET /chat/runs/{id}/events + Last-Event-ID            |                       |
   |------------------------>|                              |                       |
   |<==== 从 buffer 回放 =====|<-----------------------------|                       |
   |<==== 然后继续 tail ======|                              |                       |
```

### 3.3 新方案中 buffer 的职责

新方案里 buffer 不再只是事件仓库，还承载了 run 控制元数据：

- `request_payload`
- `execution_started`
- `active`
- `terminal`
- `pause_requested`
- `last_event_id`

所以新方案中的 buffer 更接近：

- `event log + run control metadata`

这使得 `run_id` 成为一个独立存在的对象，而不是只能附着在第一次 `/chat` 请求上。

### 3.4 新方案的优点

1. run 身份先于 SSE 连接存在

前端不需要等 SSE 首次建立成功后再去拿 `run_id`。`run_id` 在 `POST /chat/runs` 返回时已经确定。

2. EventSource 自动重连更自然

`GET /events` 是纯消费语义，非常适合浏览器原生 `EventSource`。

3. 终态更容易先落 buffer，再尝试发送

这是新方案应该具备、也正在补齐的方向，但不能简单理解成“当前部署版本已经完全保证”。

从架构上说，新方案更适合做到：

- terminal event 先落 buffer
- 当前连接发送失败时，resume 仍能补到终态

但从 incident 来看，这个保证在部署版本里尚未完全闭环，见 5.4 节。

4. 连接断开语义更清晰

现在更接近：

- run 是服务端状态
- SSE 只是一个订阅窗口

5. 可观测性更好

现在可以明确区分：

- `create run`
- `start execution`
- `resume consume`
- `terminal persisted`

而不是所有行为都挤在一条 `/chat` 请求内。

---

## 4. 为什么新方案更稳

### 4.1 旧方案的问题不是“不能恢复”，而是“恢复链条太长”

旧方案要想可靠恢复，必须同时保证：

- 主连接断了以后 generator 不把 task 一起杀掉
- detached drain 正确接管
- detached drain 期间 keepalive 继续发送
- 终态事件必须先写 buffer，再尝试发给客户端
- resume 客户端重连时能正确 replay

这些任何一个点出问题，都会出现：

- agent 还在跑，但前端看起来像停了
- 终态没补回来
- run 静默终止

### 4.2 新方案把“run 存在性”从连接里拿出来了

这是最关键的变化。

在旧方案里：

- “我有一个 run” 和 “我有一条正在打开的 `/chat` SSE 连接” 高度绑定

在新方案里：

- run 先通过 `/chat/runs` 成立
- `/events` 只是消费它

这样连接断了以后，不会先丢 run 身份。

### 4.3 新方案允许“执行”和“观察”被区分

当前实现还不是彻底后台化，但已经明显往这个方向靠：

- run 是独立 id
- `/events` 可以是首次执行，也可以是 resume
- buffer 里除了事件，还有控制状态

这比旧方案那种“请求即任务”更容易推理和排障。

### 4.4 detached drain 在当前新方案里仍然是必要恢复层

需要特别说明：新方案虽然引入了 `/chat/runs + /events`，但在真正的后台 run 模型落地前，detached drain 仍然不可替代。

原因是：

- 当前首次执行仍由 `/events` 触发
- 执行逻辑仍运行在处理这条 `/events` 请求的进程/协程里
- 一旦当前连接断开，必须有 detached drain 或 detached finalize 接管，才能把后续事件持续写入 buffer

因此，当前新方案并不是“有了 run_id 就不再需要 detached drain”，而是：

- run 身份与连接解耦了一部分
- 但执行仍未完全脱离当前请求
- detached drain 仍然是把“连接断开”和“任务继续执行”桥接起来的关键恢复机制

这也是为什么针对 detached drain / detached finalize 做的 Fix 1-4 仍然有实际价值。

---

## 5. 当前新方案仍然存在的边界

新方案更稳，但不是彻底解耦。

### 5.1 当前版本里，首次执行仍然由 `/events` 触发

目前实现是：

- `POST /chat/runs` 只创建 `chat_run_id`，保存 request payload
- 第一个 `GET /chat/runs/{id}/events` 调用 `mark_execution_started()`
- 然后才真正进入 `_agent_chat_impl(...)`

这意味着：

- run 已创建，不代表已执行
- `/events` 仍同时承担“启动执行”和“消费事件”两个职责

这比旧方案好很多，但这里存在一个比“create run 非幂等”更紧迫的竞态风险：

- 第一个 `/events` 请求将 `execution_started` 置为 `true`
- 但如果连接在 agent 真正开始执行前就断开，可能出现“状态已标记为 started，但实际上没有任何执行在跑”
- 此时后续 `/events` 重连会认为“已经有人在执行”，转而只做 tail / resume
- 结果是前端一直等不到任何事件，而 run 也不会真正开始

也就是说，当前 `execution_started` 更像“某个请求赢得了启动资格”，而不是“agent 已经稳定进入 running 状态”。

这说明当前新方案还缺少明确的 run 状态机，例如：

- `created`
- `starting`
- `running`
- `completed`
- `failed`

如果没有这类持久化状态，仅靠 Redis 中一个 `execution_started` 标志，仍然会有“started 但未真正 running”的空洞状态。

### 5.2 create run 还不是幂等的

`POST /chat/runs` 每次都会新建一个 `uuid4()`。

因此：

- LLM/agent 内部 retry 不会新建 `run_id`
- EventSource 自动重连不会新建 `run_id`
- 但如果客户端重复发起 `POST /chat/runs`，会创建新的 run

所以当前设计的假设是：

- 只重连 `/events`
- 不自动重试 `create run`

如果要进一步稳，需要补：

- `Idempotency-Key`
- 或 `client_run_id`
- 或 request hash 去重

### 5.3 创建阶段和执行阶段的校验时机发生了后移

在旧 `/chat` 中，很多前置校验在一个请求里立即完成。

在新方案中，一部分校验可能会在 `/events` 首次执行时才暴露，例如：

- active sandbox 是否存在
- continuation draft 是否匹配
- model 与 input_images 能力是否兼容

这不是逻辑缺失，而是语义变化：

- 旧方案：创建并执行在同一个时刻校验
- 新方案：创建成功后，首次执行时再完成一部分校验

### 5.4 终态先落 buffer 的保证尚未在部署版本中完全实现

从架构方向看，新方案比旧方案更适合做到“终态先落 buffer，再尝试发给当前连接”。但这并不代表当前部署版本已经完全具备该保证。

在 run `96af7419` 的 incident 中，出现了这样的链路：

- agent 在 detached drain 下继续运行
- finalize 阶段发生 Vite build 失败
- 服务端尝试发送 error 事件时走到 `chat.stream.send_failed`
- 之后没有看到终态 `done/error` 被成功持久化到 buffer
- 前端即使再次 resume，也看不到终态

这说明在部署版本里，`send_failed` 路径的 fallback 仍不完整：

- 当前连接发送失败
- 并不自动等价于“terminal error 已经安全进入 buffer”

因此这里必须区分：

- 架构方向：新方案更容易实现“terminal 先落 buffer”
- 当前现实：部署版本尚未完全实现这一点，仍存在 run 静默终止的风险

这也是当前最致命的 gap 之一。

---

## 6. 旧方案 vs 新方案总结对比

| 维度 | 旧方案 `/chat` | 新方案 `/chat/runs + /events` |
|------|----------------|-------------------------------|
| run_id 获取方式 | SSE 响应头返回 | JSON 直接返回 |
| 执行触发方式 | `/chat` 请求立即触发 | 当前由首次 `/events` 触发 |
| SSE 语义 | 创建 + 执行 + 推流混合 | 更接近纯消费 |
| buffer 角色 | 事件缓存 | 事件缓存 + run 控制元数据 |
| 断线重连 | resume 补拉 | EventSource + Last-Event-ID 更自然 |
| 终态可靠性 | 更依赖当前连接是否活着 | 架构上更适合先落 buffer 再补发，但部署版本尚未完全闭环 |
| 幂等风险 | 单请求路径，重连复杂 | `create run` 非幂等，需要额外处理 |
| 观测性 | 日志语义混杂 | 可拆分 create/start/resume/finalize |
| 生命周期耦合 | 高 | 明显降低，但未彻底消除 |

---

## 7. 推荐结论

### 7.1 当前新方案值得保留

从稳定性角度看，新方案方向是正确的，原因如下：

- run 身份先独立存在
- EventSource 自动重连更自然
- buffer 已经不只是补看历史，还承载执行控制元数据
- 终态补发和 detached finalize 更容易收敛

但必须强调：

- 这是方向正确，不等于当前部署版本已经收口所有关键故障路径
- 尤其是 `send_failed -> terminal 未入 buffer` 这类问题，当前仍需继续修

### 7.2 短期建议

建议继续沿当前方案收口，而不是回退：

1. 保证 terminal event 永远先落 buffer
2. 保证 detached finalize 路径只做一次终态写入
3. 只允许 `/events` 自动重连，不自动重试 `/chat/runs`
4. 增强 `/events` 的 start/resume 观测日志
5. 补“started 但未真正 running”竞态的状态恢复机制

### 7.3 中期建议

如果要进一步彻底解耦，建议把执行触发也从 `/events` 中拿掉：

- `POST /chat/runs` 直接启动后台执行
- `/events` 永远只负责订阅

但这个方向不能只靠 `asyncio.create_task()` 在当前 API 进程里完成，而是需要补齐完整的后台运行基础设施。

至少要解决这些难点：

1. 后台执行载体

- 不能只依赖 in-process `asyncio.create_task()`
- 因为 API 进程重启、部署滚动、worker crash 都会直接丢失任务
- 需要独立 worker、task queue，或其他可恢复的后台执行机制

2. run 状态机持久化

- 不能只靠 Redis TTL + `execution_started`
- 需要在 DB 中持久化至少这些状态：`created -> starting -> running -> completed/failed`
- 这样前端和恢复逻辑才能区分“已经执行”“正在启动”“启动失败”“已结束”

3. 中间态可观测性

- 前端要能处理“run 创建成功，但执行尚未开始”这个中间态
- 否则用户会看到一个合法的 `run_id`，但没有任何事件，不知道是还没启动还是已经卡死

4. 进程崩溃后的恢复

- 如果 worker 在 `starting` 或 `running` 阶段 crash，需要有 lease/heartbeat/recovery 机制
- 否则 run 状态仍可能卡死在中间态

达到这一状态后：

- run 生命周期将真正独立于任意一条 HTTP/SSE 连接
- `/events` 会退化成纯观察接口
- 架构边界会更清晰，恢复链也会更短

---

## 8. 一句话总结

旧方案的问题不是“没有 buffer”，而是：

- buffer 只是事件缓存，任务仍然绑在 `/chat` 请求上

新方案的改进点是：

- run 先存在，buffer 既保存事件，也开始保存 run 控制状态

因此新方案更适合做：

- 断线重连
- Last-Event-ID 回放
- detached 执行
- 终态补偿

但当前版本还没有完全做到“执行与连接彻底分离”，仍建议继续演进到真正的后台 run 模型。
