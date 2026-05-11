# 轻量方案：ProjectVersion + ProjectDraft + ProjectTurn + SandboxSnapshot

## 1. 文档目的

本文给出一套比“run + checkpoint + event sourcing + projection”明显更轻的架构方案，目标是在当前项目开发阶段，以更低的理解成本解决以下问题：

- Agent 的 Tool 调用历史需要保存，便于 Continue / 重建
- Agent 每个 QA Turn 需要有明确边界，便于继续和回滚
- Agent 视角下的代码必须始终是最新的
- Code / Character / WorldSettings 需要统一纳入版本管理
- Sandbox 需要通过 Snapshot 快速重建

本方案最终只围绕 4 个核心对象展开：

1. `ProjectVersion`
2. `ProjectDraft`
3. `ProjectTurn`
4. `SandboxSnapshot`

它刻意不引入更重的概念：

- 不做复杂 checkpoint 链
- 不做 event sourcing
- 不做多级 run lineage
- 不做复杂消息 projection 管线
- 不把 ToolCall 单独建成一等主对象

适用前提：

- 当前项目仍在开发中
- 没有线上用户需要兼容
- 允许做较大重构，但希望控制复杂度

## 2. 核心思想

### 2.1 只保留两类项目状态

对项目状态只做两层划分：

#### 正式状态：`ProjectVersion`

表示项目当前稳定、可恢复、可回滚的正式版本。

#### 草稿状态：`ProjectDraft`

表示项目当前尚未完成、但可以恢复和继续的唯一活跃草稿。

这意味着：

- 正式版本只保留一条当前真相链
- 草稿只保留一个当前未完成状态
- 不做多个活跃草稿并存
- 不做每个细粒度步骤一个 checkpoint

### 2.2 Turn 是主要运行边界

本方案不再把 Message、ToolCall、Run、Checkpoint 拆成多个独立层，而是统一收敛到：

- `ProjectTurn`

它表示：

> 一个 QA Turn 中，用户输入、Agent 输出、Tool 调用历史的聚合记录

因此：

- Continue 基于当前 Draft + 最近一个未完成 Turn
- Rollback 基于 Turn 边界
- Tool 调用历史作为 Turn 内部的一部分保存

### 2.3 Snapshot 只是加速恢复，不是事实来源

`SandboxSnapshot` 的职责仅限于：

- 加快 sandbox 重建
- 减少 materialize 成本

它不负责定义代码真相。

## 3. 四个核心对象

## 3.1 `ProjectVersion`

### 定义

项目的正式版本对象。

它表示：

> 当前项目完整且稳定的正式状态

### 包含的状态

#### Code

- 当前代码文件树的 manifest
- 对应 blob 存在 R2

#### Character

- 当前角色数据快照

#### WorldSettings

- 当前世界设定快照

### 建议字段

- `id`
- `project_id`
- `parent_version_id`
- `code_manifest_key`
- `characters_state_json`
- `worldsettings_state_json`
- `summary`
- `created_by_turn_id`
- `created_at`

### 作用

- 项目 head 指向它
- 新 sandbox 默认从它恢复
- rollback 的目标版本是它
- publish 的最终落点是它

### 设计原则

- `ProjectVersion` 只表示正式状态
- Agent 运行过程中不直接修改 `ProjectVersion`
- 只有当一轮工作确认完成时，才由 Draft 提升为新的 `ProjectVersion`

## 3.2 `ProjectDraft`

### 定义

项目当前唯一活跃草稿。

它表示：

> 当前 Agent 还没完成，但已经产生的最新可恢复状态

### 为什么必须有它

如果没有 Draft：

- Agent 运行中断后无法恢复
- Agent 视角看不到最新代码
- Character / WorldSettings 的未提交修改无处落地
- Continue 只能依赖临时内存或 Redis

### 建议字段

- `id`
- `project_id`
- `base_version_id`
- `code_manifest_key`
- `characters_state_json`
- `worldsettings_state_json`
- `status`
  - `running`
  - `interrupted`
  - `paused`
  - `publishing`
- `last_turn_id`
- `snapshot_id`
- `partial_response_json`（可选）
- `created_at`
- `updated_at`

### 包含的内容

#### 代码草稿

当前未提交代码的 manifest。

#### Character 草稿

当前未提交的角色状态。

#### WorldSettings 草稿

当前未提交的世界设定。

#### Partial Response

当前 agent 尚未完成的 assistant partial 输出，用于 UI 恢复。

### 关键语义

一个项目在任意时刻：

- 要么没有 draft
- 要么只有一个 active draft

不支持多个 draft 并存。

这样能显著简化：

- Continue
- Rollback
- Sandbox materialization
- 前端状态判断

### 3.2.1 Draft 的代码语义

`ProjectDraft.code_manifest_key` 表示的是：

> 当前整个项目工作区的草稿文件树

它不是单文件草稿，而是整个代码工作区的草稿快照。

因此一个 Draft 可以自然覆盖：

- 多文件新增
- 多文件修改
- 多文件删除

### 3.2.2 为什么代码继续用 manifest

轻量方案虽然做了概念收缩，但代码部分仍建议保留：

- `code_manifest_key`
- 对应 R2 blob

而不是把整棵文件树直接塞进 PG `jsonb`。

原因：

- 代码天然是多文件结构
- 单个文件可能较大
- 搜索、diff、bundle、materialize 更适合 manifest 语义
- 更贴近当前仓库已有实现

### 3.2.3 `partial_response_json` 的定位

`partial_response_json` 不是核心业务真相，而是一个**可选的 UI 缓存**。

它的作用仅限于：

- 页面刷新后还能显示上一轮未完成的 assistant partial 输出

它不应该：

- 进入模型恢复上下文
- 成为 Continue 的核心依据
- 成为项目状态恢复的真相

因此：

- 如果要进一步简化实现，可以第一阶段不做
- 如果要保留更好的 UI 体验，可以保留，但必须明确它是弱状态

## 3.3 `ProjectTurn`

### 定义

一次完整的 QA Turn 聚合记录。

它表示：

> 用户发起的一轮 agent 工作边界，以及这一轮中的 Agent 输出和 Tool 调用历史

### 为什么它不能省略

如果只有 `Version + Draft + Snapshot`：

- 无法清楚表达“本轮 Turn 做了什么”
- 无法按 Turn 回滚
- Continue 时缺少明确的逻辑边界
- Debug 时很难定位是哪一轮引入的问题

所以 `ProjectTurn` 是必要的最小运行语义对象。

### 建议字段

- `id`
- `project_id`
- `draft_id`
- `base_version_id`
- `status`
  - `running`
  - `completed`
  - `interrupted`
  - `failed`
  - `rolled_back`
- `user_message_json`
- `assistant_message_json`
- `tool_calls_json`
- `started_at`
- `ended_at`

### `tool_calls_json` 的语义

`tool_calls_json` 保存这一轮 Turn 中的工具调用历史，按顺序排列。

示例结构：

```json
[
  {
    "seq": 1,
    "tool_name": "view_file",
    "args": {"file_path": "src/App.tsx"},
    "status": "completed",
    "result": {"message": "..." },
    "started_at": "...",
    "finished_at": "..."
  },
  {
    "seq": 2,
    "tool_name": "edit_file",
    "args": {"file_path": "src/App.tsx"},
    "status": "failed",
    "result": {"error": "..." },
    "started_at": "...",
    "finished_at": "..."
  }
]
```

### 3.3.1 为什么不单独建 `AgentToolCall`

在当前阶段，ToolCall 的真实需求是：

- 属于某个 Turn
- 参与 Continue / 重建
- 用于 UI 展示和审计

而不是：

- 独立分页查询
- 单独做复杂状态机
- 做全局工具维度分析

所以当前阶段直接把 Tool 调用历史放进 `ProjectTurn.tool_calls_json` 更轻，也更贴近真实需求。

如果未来工具历史变得特别多，再拆成独立表也不晚。

### 3.3.2 Tool 历史写入规则

建议在每次工具调用的两个边界更新 Turn：

#### `tool_started`

工具开始前先 append / update 一条记录：

- `tool_name`
- `args`
- `status = started`
- `started_at`

#### `tool_completed` / `tool_failed`

工具结束后更新这条记录：

- `status`
- `result`
- `finished_at`

这样即使中途断开，也能知道：

- 这轮最后执行到哪个工具
- 哪个工具已完成
- 哪个工具开始了但没完成

### 3.3.3 Turn 与 Draft 的关系

- Turn 是过程边界
- Draft 是当前状态容器

也就是说：

- 一个 Draft 在生命周期内可以经历多个 Turn
- 一个 Turn 只负责描述“一轮工作做了什么”
- Draft 始终描述“当前项目未完成状态是什么”

### Continue 的定义

Continue 不是恢复旧进程，而是：

1. 基于当前 `ProjectDraft`
2. 新建一个新的 `ProjectTurn`
3. 继续使用同一个 draft 状态

这样：

- Turn 边界清晰
- 状态机简单
- 审计也更容易

### Rollback 的定义

建议只支持 **Turn 粒度回滚**，不支持更细粒度恢复。

#### 未完成 Turn 回滚

- 直接丢弃当前 draft
- 回到 `base_version_id`

#### 已完成 Turn 回滚

- 回滚到上一个 `ProjectVersion`

### 3.3.4 Runtime Intent 的处理方式

轻量方案里不再单独维护 `runtime_intents_json` 作为核心状态。

运行时意图直接作为 `tool_calls_json` 中的普通工具历史记录，例如：

- `tool_name = install_package`
- `tool_name = restart_dev_server`

这样可以直接复用：

- 顺序
- 参数
- 结果
- 状态
- Continue 上下文

如果未来发现 runtime intent 需要独立状态机，再单独拆表；第一阶段不建议先上。

## 3.4 `SandboxSnapshot`

### 定义

用于快速恢复 sandbox 的快照对象。

它表示：

> 某个 ProjectVersion 或 ProjectDraft 的 sandbox 可恢复副本

### 建议字段

- `id`
- `project_id`
- `source_kind`
  - `version`
  - `draft`
- `source_id`
- `e2b_snapshot_ref`
  或 `bundle_key`
- `status`
- `created_at`

### 作用

- 项目打开时快速恢复正式版本
- interrupted draft 继续时快速恢复草稿
- 降低大工作区 materialize 成本

### 重要限制

`SandboxSnapshot` 只是缓存和加速器，不是代码真相。

如果 Snapshot 丢失：

- 仍然可以从 `ProjectVersion` / `ProjectDraft` 重建

## 4. 组件职责分配

## 4.1 PostgreSQL

负责保存结构化状态：

- `ProjectVersion`
- `ProjectDraft`
- `ProjectTurn`
- `SandboxSnapshot` 元数据
- `SandboxSession` 元数据

PG 是项目和运行状态的主控制面。

## 4.2 R2

负责保存实际内容：

- code manifest
- code blob
- snapshot bundle

R2 用于内容持久化，不直接提供活跃工作区文件系统。

说明：

- Code 继续使用 `manifest + blob`
- Character / WorldSettings 在轻量方案中直接使用 `jsonb`

## 4.3 Redis

只保留瞬态能力：

- SSE buffer
- lock
- session heartbeat

Redis 不能作为 Continue 或版本恢复的真相来源。

## 4.4 E2B

负责：

- 执行 agent tool 需要的命令
- 运行 dev server
- 提供 preview
- 恢复 sandbox snapshot

E2B 是执行环境，不是代码真相。

## 5. 代码读取与 Agent 视角

## 5.1 最重要的原则

> Agent 视角下的代码必须始终是最新的

因此：

- `view_file`
- `search_code`
- `find_files`

都必须优先读取 `ProjectDraft`，而不是直接读 sandbox。

## 5.2 读取优先级

### 如果项目存在 active draft

所有只读文件工具都读取：

- `ProjectDraft.code_manifest_key`

### 如果项目不存在 draft

所有只读文件工具都读取：

- `ProjectVersion.code_manifest_key`

## 5.3 Sandbox 的定位

sandbox 不是 agent 的逻辑视图来源，而是执行副本。

只有在需要执行命令、运行 preview、安装依赖时，才需要把 draft 或 version materialize 到 sandbox。

## 6. 典型工作流

## 6.1 开始一个新的 Turn

1. 用户发起新的消息
2. 如果项目没有 active draft：
   - 从 `ProjectVersion` 派生 `ProjectDraft`
3. 创建新的 `ProjectTurn`
4. Agent 开始工作，所有修改都写到 `ProjectDraft`

## 6.2 Tool 调用

每次 tool 调用时：

1. 在 `ProjectTurn.tool_calls_json` 中记录 `tool_started`
2. 执行工具逻辑
3. 工具结果写回 `ProjectDraft`
4. 更新 `ProjectTurn.tool_calls_json` 中对应记录为 `completed/failed`

如果工具本质上代表运行时意图，例如：

- `install_package`
- `restart_dev_server`

则仍然作为普通 tool history 处理，不再额外维护一份 draft 级 intents JSON。

## 6.3 Turn 中断

如果运行中断：

- `ProjectTurn.status = interrupted`
- `ProjectDraft.status = interrupted`
- partial response 可选保留在 draft 中
- tool call 历史保留在 turn 中

此时项目仍然保留一个可恢复的 active draft。

## 6.4 Continue

Continue 的实现：

1. 找到当前项目的 `ProjectDraft`
2. 创建新的 `ProjectTurn`
3. Agent 读取当前 draft 的最新代码
4. Agent 可参考上一轮 Turn 的工具历史和对话历史
5. 继续工作

Continue 不等于恢复旧进程，而是：

> 基于当前 Draft，新开一个 Turn

## 6.5 Publish

如果当前工作完成，需要正式提交：

1. 从 `ProjectDraft` 生成新的 `ProjectVersion`
2. 更新 `project.current_version_id`
3. 清除 `active_draft_id`
4. 可异步生成对应的 `SandboxSnapshot`

## 6.6 Rollback

### 回滚未完成 Draft

- 删除 active draft
- 回到对应的 base version

### 回滚已提交版本

- 把项目 head 切回某个旧 `ProjectVersion`

## 7. Character 与 WorldSettings 的版本管理

## 7.1 为什么要和 Code 一起管理

你的需求已经明确：

- Turn 相关版本管理不仅有代码
- 还包括 character、worldsettings 等

因此不能继续把它们当作完全独立的领域单独处理。

## 7.2 在 `ProjectVersion` 中的表现

正式版本中保存：

- `characters_state_json`
- `worldsettings_state_json`

这样回滚一个版本时，三者一起回滚：

- Code
- Character
- WorldSettings

## 7.3 在 `ProjectDraft` 中的表现

草稿中同样保存：

- `characters_state_json`
- `worldsettings_state_json`

这样一次 Turn 修改任意一种资源，都能统一纳入草稿语义。

## 8. 为什么这个方案比重方案更轻

## 8.1 少了什么

它刻意不做：

- 复杂 checkpoint 体系
- 每次副作用一个恢复点
- 事件溯源
- projection pipeline
- 多层 revision lineage
- 独立 ToolCall 主表

## 8.2 保留了什么

它保留了当前最关键的业务能力：

- Turn 历史
- Tool 调用与结果历史
- Draft 恢复
- 正式 Version
- Snapshot 快速恢复

## 8.3 代价

它的限制也很明确：

- 不适合多个 agent 并发改同一项目
- 不支持极细粒度中间恢复
- 不适合非常复杂的运行期事件审计
- 如果单个 Turn 的 tool 历史过大，后续可能需要把 `tool_calls_json` 拆表

但对当前项目阶段，这些限制通常是可接受的。

## 9. 收敛后的推荐结构

基于当前讨论，推荐进一步收敛为：

### `ProjectVersion`

- `code_manifest_key`
- `characters_state_json`
- `worldsettings_state_json`

### `ProjectDraft`

- `code_manifest_key`
- `characters_state_json`
- `worldsettings_state_json`
- `partial_response_json`（可选）

### `ProjectTurn`

- `user_message_json`
- `assistant_message_json`
- `tool_calls_json`
- `status`

### `SandboxSnapshot`

- 仅做恢复加速器

换句话说：

- 去掉 `runtime_intents_json`
- 去掉独立 `AgentToolCall` 主对象
- 保留 `partial_response_json` 但降级为可选 UI 缓存
- Character / WorldSettings 改用 `jsonb`
- Code 继续使用 `manifest + blob`
- Tool 历史并入 `ProjectTurn.tool_calls_json`

## 10. 推荐实现顺序

## Phase 1

先落：

- `ProjectDraft`
- `ProjectTurn`
- 统一读取 Draft 的代码视图

目标：

- 先解决 Continue
- 先解决 Agent 视角代码一致性

## Phase 2

再落：

- `ProjectVersion`
- Draft -> Version 的 publish
- Version rollback

目标：

- 形成稳定的正式版本体系

## Phase 3

最后补：

- `SandboxSnapshot`
- sandbox 快速恢复优化

目标：

- 提升恢复效率，而不是改变真相结构

## 11. 最终结论

轻量方案的核心不是减少功能，而是减少概念层级。

对当前项目来说，更合适的不是重型的：

- run
- checkpoint
- event
- projection
- revision tree

而是更直接的：

- `ProjectVersion`：正式状态
- `ProjectDraft`：当前草稿
- `ProjectTurn`：一轮 QA Turn 的完整记录
- `SandboxSnapshot`：sandbox 恢复加速器

一句话概括：

> 用 Draft 表达“当前未完成状态”，用 Turn 表达“本轮工作边界 + Agent 输出 + Tool 历史”，用 Version 表达“正式版本”，用 Snapshot 表达“恢复加速”。

这套方案比重方案更容易理解，也更适合当前阶段快速重构落地。
