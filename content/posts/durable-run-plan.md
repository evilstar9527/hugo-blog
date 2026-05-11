
# Durable Run 作业化迁移方案

## Summary

  把当前“HTTP 请求内跑 agent + SSE 仅负责附着输出”的模型，改成“后台 durable job 驱动执行，HTTP 只负责创建 run、附着流、暂停/恢复/注入消息”。

  目标效果：

- 浏览器断开后，run 继续执行，不依赖原始请求协程存活。
- 任意客户端可通过 run_id 重新附着同一个执行中的 run。
- 服务重启后，未完成 run 可被 worker 扫描并恢复或标记失败。
- 当前 ProjectDraft / ProjectTurn / WorkspaceRunState / SSE buffer 继续保留，但职责更清晰。

  默认选择：先做“队列作业化 durable run”，不直接引入外部 workflow 引擎。

## Key Changes

### 1. 抽出 Run 领域模型，停止让 chat.py 直接承载执行状态机

  新增一个明确的 ChatRun 持久化对象，职责是描述一次 agent 执行本身，而不是复用 SSE buffer 或 turn payload 隐式表达。

  建议新增表：

- chat_runs
- 核心字段：
  - run_id
  - project_id
  - session_id
  - draft_id
  - turn_id
  - status: queued | acquiring_lock | restoring_context | running | waiting_for_user | paused | publishing | completed | failed | cancelled
  - worker_id
  - lease_expires_at
  - continuation_of_run_id
  - last_checkpoint_seq
  - last_error
  - created_at / started_at / updated_at / ended_at

  保留现有 ProjectTurn 作为对话与产物视图，但不要再让它兼任运行时真相来源。
  ProjectTurn.assistant_message_json.resume_event_id 继续用于前端展示恢复位置，但运行恢复以 chat_runs 为准。

### 2. 把执行循环搬到独立 worker，不再依赖 HTTP StreamingResponse

  新增后台 worker 模块，例如：

- apps/api/services/chat_run_worker.py
- apps/api/services/chat_run_executor.py
- apps/api/services/chat_run_queue.py

  职责拆分：

- API 路由：
  - 创建 run 记录
  - 入队
  - 立即返回 run_id
  - SSE/轮询仅做附着和消费事件
- Worker：
  - 抢占 run lease
  - 加载上下文
  - 执行 agent loop
  - 持续写 checkpoint、事件流、turn/draft 状态
  - 处理暂停、用户回答、proposal apply/reject、enqueue 消息
- Queue：
  - 可先用 Redis list / stream + DB lease
  - 不要求首版引入 Celery / Temporal / Inngest

  执行入口从“POST /chat 直接跑”改为：

  1. POST /projects/{id}/chat 创建 chat_run
  2. 记录 ProjectTurn(status=running) 与 draft
  3. 将 run_id 推入队列
  4. 返回 run_id
  5. 前端立刻连 /chat/stream/{run_id} 或沿用现有 /chat/resume/{run_id}

### 3. 定义可恢复 checkpoint，恢复执行而不只是恢复 SSE

  当前已有：

- WorkspaceRunState
- ProjectDraft.partial_response_json
- model_messages_json
- RunEventBuffer

  但这些还不足以在进程死掉后真正恢复执行。
  新增 RunCheckpoint 持久化结构，按“工具边界”保存，而不是按 token 级别保存。

  建议 checkpoint 内容：

- run_id
- seq
- phase
- message_history_json
- assistant_steps_json
- tool_calls_json
- task_plan_json
- workspace_run_state_json
- pending_user_interrupt_json
- active_tool_name
- continuation_prompt
- resume_from_checkpoint_kind

  checkpoint 触发点：

- 每次 tool result 完成后
- 每次进入 waiting_for_user
- 每次完成 queued message 注入后
- publish 前
- publish 完成后

  不要尝试在任意 token 中间恢复。
  恢复语义限定为：从最近一个“已完成 tool-return 的稳定边界”继续，这和你们现有 _can_resume_from_tool_checkpoint() 思路一致，但现在要落到持久化 checkpoint，而不是只在单次请求重试里使用。

### 4. 重新定义 API：创建 run、附着流、控制 run

  建议把接口语义改成 run-first：

- POST /projects/{project_id}/chat-runs
  - 创建新 run 或 continuation run
  - 返回 run_id, stream_url, status
- GET /projects/{project_id}/chat-runs/{run_id}/stream
  - SSE 附着到运行事件
  - 内部仍可复用现有 RunEventBuffer
- GET /projects/{project_id}/chat-runs/{run_id}
  - 查询 run 状态、当前阶段、waiting reason、saved_files
- POST /projects/{project_id}/chat-runs/{run_id}/pause
- POST /projects/{project_id}/chat-runs/{run_id}/resume
  - 对 paused 或 waiting_for_user run 生效
- POST /projects/{project_id}/chat-runs/{run_id}/input
  - 统一承载 queued user message / question answer / proposal decision
  - 不再分散为 continuation 请求参数和多个分支语义

  现有 /chat/resume/{chat_run_id} 可以短期兼容，内部转发到新的 run stream。

### 5. 让 worker 具备 lease 和 crash recovery

  要点：

- worker 抢 run 时更新 worker_id + lease_expires_at
- 执行期间周期性续租
- 如果 worker 崩溃，lease 过期后其他 worker 可接管
- 接管逻辑：
  - 读取最新 checkpoint
  - 恢复 sandbox 连接或按 draft manifest 重建
  - 从 checkpoint 指定的 continuation point 继续
- 如果接管时发现 checkpoint 不可恢复：
  - 将 run 标记 failed
  - 写 terminal 事件
  - 不让 run 永远挂在 running

  这一步是 durable run 的核心。
  没有 lease，就只是“后台任务”；有 lease + checkpoint，才是“可恢复执行”。

### 6. 把 sandbox 生命周期从“请求 keepalive”改成“worker keepalive”

  当前 keepalive 在 chat.py 的执行循环里。迁移后改为：

- worker 负责 refresh_sandbox_lifecycle
- worker 在 lease 续租时顺带刷新 sandbox TTL
- run 附着的 SSE 客户端不再承担任何 keepalive 责任

  恢复时的 sandbox 策略：

- 优先 reconnect 当前 session.e2b_sandbox_id
- 失效时按 ProjectDraft.code_manifest_key 恢复 workspace
- 再执行 reconcile_sandbox_runtime
- 只有在 checkpoint 标记“已进入 publishing 且未完成”时，才允许重试 publish；否则只恢复到 pre-publish 状态

### 7. 收敛当前 chat.py 的职责

  apps/api/routers/chat.py 需要逐步瘦身到三类逻辑：

- request validation / auth
- run creation / control / stream attach
- legacy compatibility glue

  从中迁出的逻辑：

- agent loop
- queue interrupt 注入
- finalize workspace
- checkpoint flush
- detached drain
- worker keepalive

  这样 chat.py 不再是 runtime 内核，只是 transport adapter。

## Test Plan

  必须覆盖以下场景：

- 创建 run 后立即断开 SSE，worker 继续执行并最终完成。
- 两个客户端同时附着同一 run_id，都能看到一致事件流。
- worker 进程在 tool result 后崩溃，run 被新 worker 从最近 checkpoint 接管并继续。
- worker 在 text streaming 中崩溃，恢复后从最近稳定 checkpoint 继续，不重复执行已完成工具。
- waiting_for_user 状态下服务重启，用户提交 answer 后 run 继续。
- proposal apply / reject 在 run-first API 下仍能正确更新资源并继续执行。
- sandbox 已被回收时，run 接管流程能用 draft manifest 恢复。
- publish 过程中失败时，不产生重复版本，也不丢失 draft。
- pause 请求到达后，run 最终进入 paused，后续 resume 可继续。
- 同一 project 同时只允许一个持有 lock 的活跃 run，冲突时返回明确错误。

## Assumptions

- 首版继续使用 Redis + Postgres，不引入 Temporal / Celery / Inngest。
- 恢复粒度限定为“tool checkpoint 级”，不追求 token 级精确续跑。
- RunEventBuffer 继续保留，职责是“事件回放与多端附着”，不是运行时真相。
- ProjectDraft 继续作为 workspace 草稿真相来源；ChatRun 只表示执行状态。
- 首版只支持单 run 单 project lock，不做同项目多并发 agent run。
