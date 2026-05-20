---
title: "Claude Code 记忆系统设计分析"
date: 2026-05-20
draft: false
categories: ["notes"]
---

## Context

这份文档分析的是当前本地源码树：

`/Users/jishihe/work/civil-engineering-cloud-claude-code-source-v2.1.88/01-claude-code-source-crack/claude-code-source`

目标不是复述官方文档里的“Claude 有记忆”，而是从源码出发回答几个设计问题：

1. Claude Code 到底把“记忆”分成了哪几类？
2. 每类记忆存在哪里、什么时候加载、什么时候写入？
3. 它如何避免把所有历史无脑塞进上下文？
4. 它如何和 `/compact`、session resume、agent、team sync 这些系统组合？
5. 这套设计的取舍是什么？

先给结论：Claude Code 的“记忆系统”不是一个单点功能，而是一组分层持久化机制。它把**规则型指令**、**跨会话偏好/事实**、**当前会话工作状态**、**Agent 专属经验**、**团队共享知识**拆成不同数据面，并用不同的注入方式控制上下文成本。

---

## 一、总览：Claude Code 里至少有五种“记忆”

源码里和 memory 有关的机制可以分成五类：

| 类型 | 主要用途 | 生命周期 | 主要路径/文件 | 典型加载方式 |
| --- | --- | --- | --- | --- |
| **CLAUDE.md 指令记忆** | 行为规则、项目约定、用户私有指令 | 长期 | `CLAUDE.md`、`CLAUDE.local.md`、`.claude/rules/*.md`、`~/.claude/CLAUDE.md` | 启动/目录变更时进入 system context |
| **Auto Memory / memdir** | 跨会话的用户偏好、反馈、项目背景、外部引用 | 长期，按项目隔离 | `~/.claude/projects/<project>/memory/` 下的 `MEMORY.md` 和 topic files | `MEMORY.md` 索引常驻；相关 topic 文件按需召回 |
| **Session Memory** | 当前长会话的工作笔记，用于 compact 和连续性恢复 | 当前 session | `session-memory/summary.md` | 后台 post-sampling hook 更新；compact 时可直接作为摘要 |
| **Agent Memory** | 特定自定义 Agent 的专属经验 | 长期，按 agent type 和 scope 隔离 | `~/.claude/agent-memory/<agentType>/`、`.claude/agent-memory/<agentType>/`、`.claude/agent-memory-local/<agentType>/` | Agent system prompt 中加载 |
| **Team Memory** | 同项目团队共享的背景、约定、外部引用 | 长期，服务端同步 | `<auto-memory>/team/` | 本地 prompt 加载 + watcher 与服务端同步 |

这几类“记忆”解决的是不同问题。最重要的边界是：

- `CLAUDE.md` 更像**规则和指令**：它告诉模型“应该怎样工作”。
- `memdir` 更像**知识库和偏好档案**：它告诉模型“过去学到了什么，但要按需确认”。
- `Session Memory` 更像**当前会话工作日志**：它告诉模型“这次长任务现在进展到哪里”。
- `Agent Memory` 更像**角色专属技能笔记**：它只跟某类 agent 绑定。
- `Team Memory` 更像**可同步的共享知识层**：它要额外考虑权限、敏感信息和冲突。

---

## 二、第一层：CLAUDE.md 指令记忆

### 2.1 加载顺序和优先级

`src/utils/claudemd.ts` 顶部注释把这套规则写得很清楚。加载顺序是：

1. Managed memory，例如 `/etc/claude-code/CLAUDE.md`
2. User memory，例如 `~/.claude/CLAUDE.md`
3. Project memory，例如项目内的 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`
4. Local memory，例如项目内的 `CLAUDE.local.md`

注意源码注释里有一句关键设计：

> Files are loaded in reverse order of priority, i.e. the latest files are highest priority with the model paying more attention to them.

也就是说，越靠近当前工作目录、越私有的规则越晚加载，模型更容易遵守。

### 2.2 目录向上查找

Project 和 Local memory 不是只看 cwd 当前目录，而是从当前目录一路向上查到 root。这样 monorepo 的根目录规则和子模块规则可以同时生效：

- 根目录 `CLAUDE.md` 写全局项目约定
- 子目录 `packages/mobile/CLAUDE.md` 写 mobile 专属约定
- `.claude/rules/*.md` 可以把规则拆成多个文件
- frontmatter 里的 `paths` 可以约束规则只对某些路径生效

这套机制本质上是“层级化 instruction discovery”。

### 2.3 @include

CLAUDE.md 支持 `@path` include：

- `@./relative/path`
- `@~/home/path`
- `@/absolute/path`
- `@path` 默认相对当前文件

被 include 的文件会作为独立 memory entry 加载到包含者之前，同时用 processed path 集合防止循环引用。

源码也做了文本文件白名单，避免把图片、PDF、二进制文件意外塞进上下文。`TEXT_FILE_EXTENSIONS` 明确列出 `.md`、`.txt`、`.json`、`.ts`、`.go`、`.sql` 等扩展。

### 2.4 为什么这层不等同于 Auto Memory

`CLAUDE.md` 的内容会被包装成：

```text
Codebase and user instructions are shown below. Be sure to adhere to these instructions.
IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.
```

这说明它是强指令。而 Auto Memory 的设计反而强调“可能过期，需要验证”。这两个系统不能混用：

- 把项目当前架构写进 memory，容易 stale。
- 把用户长期偏好写进 CLAUDE.md，容易污染团队共享规则。

源码在 `memoryTypes.ts` 里也明确禁止把“代码模式、架构、文件路径、项目结构、git 历史”保存成 memory，因为这些应该从当前代码和 git 里读。

---

## 三、第二层：Auto Memory / memdir

Auto Memory 是 Claude Code 里更接近“长期记忆”的系统，主要代码在：

- `src/memdir/paths.ts`
- `src/memdir/memdir.ts`
- `src/memdir/memoryTypes.ts`
- `src/memdir/memoryScan.ts`
- `src/memdir/findRelevantMemories.ts`
- `src/services/extractMemories/*`
- `src/utils/attachments.ts`

### 3.1 开关和路径解析

`isAutoMemoryEnabled()` 的优先级链路：

1. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1/true`：关闭
2. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0/false`：强制开启
3. `CLAUDE_CODE_SIMPLE` / `--bare`：关闭
4. remote 模式但没有 `CLAUDE_CODE_REMOTE_MEMORY_DIR`：关闭
5. settings.json 里的 `autoMemoryEnabled`
6. 默认开启

Auto Memory 的默认目录是：

```text
<memoryBase>/projects/<sanitized-git-root>/memory/
```

其中 `memoryBase` 默认是 `~/.claude`，也可以被 `CLAUDE_CODE_REMOTE_MEMORY_DIR` 覆盖。

这里有一个很重要的设计：项目 key 优先使用 canonical git root，而不是 cwd。这解决了 worktree 问题：同一个 repo 的不同 worktree 能共享同一套项目记忆。

### 3.2 数据结构：MEMORY.md 是索引，topic file 是实体

Auto Memory 目录里有一个入口：

```text
MEMORY.md
```

但它不是存放全部记忆的地方。源码反复强调：

```text
MEMORY.md is an index, not a memory.
Each entry should be one line, under ~150 characters.
Never write memory content directly into MEMORY.md.
```

真正的记忆应该写成独立 topic file，例如：

```markdown
---
name: testing-preference
description: User prefers integration tests against real services for migration work
type: feedback
---

Use real database-backed integration tests for migration-related changes.

Why: mocked tests previously passed while production migrations failed.
How to apply: when touching database migrations, avoid mocks unless the user explicitly narrows the test scope.
```

`MEMORY.md` 只放短索引：

```markdown
- [Testing preference](testing-preference.md) — database migration tests should use real DBs
```

这样有两个好处：

1. 常驻上下文只放轻量索引。
2. 详细内容可以按需召回，避免每次 query 都加载所有历史。

### 3.3 四种 memory type

`src/memdir/memoryTypes.ts` 定义了闭合分类：

```ts
export const MEMORY_TYPES = [
  'user',
  'feedback',
  'project',
  'reference',
] as const
```

四类含义：

| type | 保存什么 | 例子 | 默认风险 |
| --- | --- | --- | --- |
| `user` | 用户角色、目标、知识背景、沟通偏好 | 用户是资深 Go 工程师，但刚接触 React | 容易变成对用户的主观评价 |
| `feedback` | 用户给 Claude 的行为反馈 | 不要在每次回复末尾总结 diff | 容易把个人偏好误升为团队规则 |
| `project` | 当前项目中代码/git 不能直接推导出的背景 | 合规要求推动 auth rewrite | 容易过期 |
| `reference` | 外部系统指针 | Linear 项目、Grafana dashboard、Slack channel | 外部链接可能失效 |

源码刻意禁止保存：

- 代码模式、架构、文件路径、项目结构
- git history、最近改动、谁改了什么
- debugging recipe
- 已经写在 CLAUDE.md 里的东西
- 当前任务临时状态

这是一条很关键的产品判断：**Memory 存的是“代码外的持久上下文”，不是替代 grep/git/read 的缓存。**

### 3.4 常驻注入：只注入 MEMORY.md

`getMemoryFiles()` 会在 Auto Memory 开启时尝试读取 `getAutoMemEntrypoint()`，也就是 `<auto-memory>/MEMORY.md`，类型标为 `AutoMem`。

然后 `getClaudeMds()` 会把它放进 instruction context：

```text
Contents of <path> (user's auto-memory, persists across conversations):

<content>
```

为了防止索引无限膨胀，`memdir.ts` 对 `MEMORY.md` 做了两个限制：

- 最多 200 行
- 最多 25KB

超出时会截断，并追加 warning，要求把 detail 移到 topic files。

### 3.5 按需召回：相关 topic file 最多 5 个

Claude Code 不会每次把所有 topic memory 都塞进上下文。真正的召回链路在 `src/utils/attachments.ts`：

1. 每个 user turn 开始时，`startRelevantMemoryPrefetch()` 从最近用户消息里取 query。
2. `findRelevantMemories()` 扫描 memory directory 的 `.md` 文件 frontmatter。
3. 用一个 sideQuery 调默认 Sonnet，让它从 manifest 里选择最多 5 个“确定有用”的 memory。
4. `readMemoriesForSurfacing()` 读取这些文件，限制行数和字节数。
5. 如果 prefetch 在工具执行后已经完成，就作为 `relevant_memories` attachment 注入。

这条链路有几个细节很有意思：

- selector 只看 filename、description、type、mtime，不直接看全文，成本低。
- 不确定就不选，prompt 明确要求 selective。
- 如果最近正在使用某个 tool，不要召回这个 tool 的普通 reference doc，避免噪音；但 warnings/gotchas 仍可召回。
- `readFileState` 会去重：如果模型已经通过 Read/Write/Edit 看过某个 memory 文件，就不重复注入。
- 一个 session 里已经 surfaced 的 memory 也会被排除，直到 compact 后消息被裁掉，才允许再次浮现。

这是一个典型的“两级索引 + LLM ranker + attachment 注入”设计。

### 3.6 后台写入：extractMemories forked agent

Auto Memory 的写入有两条路：

1. 主模型根据 system prompt 主动写 memory。
2. 后台 extraction agent 在 turn 结束后补写。

`src/services/extractMemories/extractMemories.ts` 的注释写得很直白：

```text
It runs once at the end of each complete query loop ...
Uses the forked agent pattern (runForkedAgent) — a perfect fork of the main conversation that shares the parent's prompt cache.
```

触发点在 stop hooks：当主循环结束、没有继续 tool call 时，后台 forked agent 读取最近若干消息，更新 auto-memory directory。

这个后台 agent 的权限被限制得很窄：

- 允许 `Read`
- 允许 `Grep`
- 允许 `Glob`
- 允许 read-only `Bash`
- 只允许在 memory directory 内 `Edit` / `Write`
- 不允许 MCP、Agent、写型 Bash 等

同时还有一个互斥逻辑：如果主模型这轮已经写了 memory 文件，后台 extractor 就跳过，避免重复写。

### 3.7 写入提示词的策略

`services/extractMemories/prompts.ts` 里给 extraction agent 的 prompt 很强约束：

- 只能用最近 N 条消息更新记忆。
- 不要 grep 源码验证，不要读代码确认模式，不要跑 git。
- 先看 existing memory manifest，优先更新已有文件，不要重复创建。
- 写文件要并行读、并行写，最多 5 turns。
- 同样遵守四类 memory taxonomy。

这说明后台抽取不是“总结代码状态”，而是“把对话中暴露出的稳定偏好/背景提取出来”。

---

## 四、第三层：Session Memory

Session Memory 和 Auto Memory 名字相近，但目标完全不同。

Auto Memory 是跨会话长期记忆；Session Memory 是**当前会话连续性笔记**，主要用于：

1. 长任务中周期性维护当前状态。
2. `/compact` 时直接复用已有 session notes，避免再调 LLM 总结全历史。
3. away summary / summary 类功能获取当前会话背景。

相关文件：

- `src/services/SessionMemory/sessionMemory.ts`
- `src/services/SessionMemory/sessionMemoryUtils.ts`
- `src/services/SessionMemory/prompts.ts`
- `src/services/compact/sessionMemoryCompact.ts`

### 4.1 文件路径和模板

Session Memory 文件由 `getSessionMemoryPath()` 决定，注释里描述形状为：

```text
{projectDir}/{sessionId}/session-memory/summary.md
```

默认模板在 `prompts.ts`：

```markdown
# Session Title
# Current State
# Task specification
# Files and Functions
# Workflow
# Errors & Corrections
# Codebase and System Documentation
# Learnings
# Key results
# Worklog
```

这些 section 很像 compact summary，但区别是：Session Memory 是后台持续维护的 live notes，而 compact summary 是上下文爆掉时一次性生成的替代消息。

### 4.2 触发阈值

`sessionMemoryUtils.ts` 默认配置：

```ts
minimumMessageTokensToInit: 10000
minimumTokensBetweenUpdate: 5000
toolCallsBetweenUpdates: 3
```

`shouldExtractMemory()` 的逻辑：

1. 当前上下文 token 低于 10k 时，不初始化。
2. 初始化后，距离上次抽取至少增长 5k tokens。
3. 同时满足：
   - 工具调用数达到阈值；或
   - 最后一个 assistant turn 没有 tool call，即自然停顿点。

这避免每轮都更新 session notes，也避免在工具调用链中间记录一个不稳定状态。

### 4.3 post-sampling hook

`initSessionMemory()` 注册 post-sampling hook，但只在这些条件下生效：

- 非 remote mode
- auto compact enabled
- querySource 是 `repl_main_thread`
- feature gate `tengu_session_memory` 开启

这一点很关键：Session Memory 是为 compact 服务的，所以它尊重 auto-compact 开关。用户关掉自动上下文管理，Session Memory 也不启动。

### 4.4 更新方式：只允许 Edit 一个文件

Session Memory 更新也走 `runForkedAgent()`。它先用 `FileReadTool` 读取当前 `summary.md`，再让 forked agent 只做一件事：

```text
Use the Edit tool with file_path: {{notesPath}}
```

权限层面也只允许：

```ts
Edit on exact memoryPath
```

不允许读源码、跑命令、开 agent。这和 Auto Memory extractor 的设计不同：Session Memory 只是在“当前 conversation 已经知道的内容”上维护笔记。

### 4.5 与 compact 的集成

`sessionMemoryCompact.ts` 会在 compact 前先尝试用 Session Memory：

1. 等待正在进行的 session memory extraction，最多 15 秒。
2. 读取 `summary.md`。
3. 如果文件还是空模板，就回退到传统 full compact。
4. 如果可用，就用它构造 compact summary message。
5. 同时保留一段最近原文消息。

保留最近消息的默认配置：

```ts
minTokens: 10000
minTextBlockMessages: 5
maxTokens: 40000
```

它还会小心调整保留起点，避免切断：

- `tool_use` / `tool_result` 对
- 同一个 assistant message id 下的 thinking block

这说明 Session Memory compact 的设计目标不是“压得最狠”，而是“用已有 notes 替代旧历史，同时保留足够 tail 原文保证 API invariants 和任务连续性”。

---

## 五、第四层：Agent Memory

Agent Memory 在 `src/tools/AgentTool/agentMemory.ts`。它是给自定义 agent 使用的持久记忆，scope 有三种：

| scope | 路径 | 特点 |
| --- | --- | --- |
| `user` | `<memoryBase>/agent-memory/<agentType>/` | 用户级，跨项目 |
| `project` | `<cwd>/.claude/agent-memory/<agentType>/` | 项目级，可进版本库 |
| `local` | `<cwd>/.claude/agent-memory-local/<agentType>/` 或 remote memory mount | 本机/环境私有 |

Agent definition 可以有 frontmatter：

```yaml
memory: user
```

加载 agent 时，`loadAgentMemoryPrompt(agentType, scope)` 会把一段 `Persistent Agent Memory` 加到该 agent 的 system prompt。底层复用 `buildMemoryPrompt()`，所以 agent memory 也有：

- `MEMORY.md` 索引
- topic files
- 四类 memory taxonomy
- “不要保存代码可推导信息”的规则

Agent Memory 的隔离点在 recall 逻辑里也能看到：如果用户 prompt 里 @-mentioned 了某个 agent，相关记忆搜索会只搜该 agent 的 memory dir，而不是全局 auto-memory dir。

这避免了“主线程用户记忆”和“某个专业 agent 的经验”互相污染。

---

## 六、第五层：Team Memory

Team Memory 是 Auto Memory 的共享扩展，主要代码：

- `src/memdir/teamMemPaths.ts`
- `src/memdir/teamMemPrompts.ts`
- `src/services/teamMemorySync/*`

### 6.1 路径

Team Memory 是 auto-memory 的子目录：

```text
<auto-memory>/team/
<auto-memory>/team/MEMORY.md
```

它要求 Auto Memory 先开启：

```ts
if (!isAutoMemoryEnabled()) return false
```

### 6.2 prompt 层面的 private/team 路由

Team Memory 开启时，系统 prompt 会变成 combined memory prompt：

- private directory: auto memory root
- team directory: `<auto-memory>/team/`

四类 memory type 会带 scope 指导：

- `user`：always private
- `feedback`：默认 private，只有项目级约定才 team
- `project`：强烈倾向 team
- `reference`：通常 team

同时明确禁止把敏感数据写进共享 team memory。

### 6.3 服务端同步

`teamMemorySync/index.ts` 注释说明 API：

```text
GET /api/claude_code/team_memory?repo={owner/repo}
GET /api/claude_code/team_memory?repo={owner/repo}&view=hashes
PUT /api/claude_code/team_memory?repo={owner/repo}
```

同步语义：

- Pull：server wins，本地文件被服务端覆盖。
- Push：只上传 hash 不同的 key。
- Delete 不传播：本地删文件不会删除服务端，下次 pull 会恢复。

Team Memory 用 git remote 推导 repo identity，并要求 first-party OAuth。它还有：

- secret scanning
- 250KB 单文件上限
- PUT body 约 200KB 分批
- structured 413 处理
- 409 conflict retry
- watcher debounce 2 秒后 push

### 6.4 路径安全

Team Memory 写入路径校验比普通 memory 更严格：

- 拒绝 null byte
- 拒绝 URL-encoded traversal
- 拒绝 Unicode normalization traversal
- 拒绝 backslash
- 拒绝 absolute key
- 用 `realpathDeepestExisting()` 检测 symlink escape

这是因为 team memory 会和服务端同步，攻击面更大。一个恶意 repo 如果能通过 symlink 把 team memory 写到 `~/.ssh/authorized_keys` 这类位置，后果很严重，所以这里做了两段式 containment check。

---

## 七、读取链路：记忆如何进入模型上下文

从上下文注入角度看，Claude Code 的 memory 分三种加载路径。

### 7.1 启动时 system context 注入

`getMemoryFiles()` 发现：

- managed/user/project/local `CLAUDE.md`
- `.claude/rules/*.md`
- auto-memory `MEMORY.md`
- team-memory `MEMORY.md`

然后 `getClaudeMds()` 把它们拼成 system context。

这类内容是每次 query 都有的，适合短、稳定、高优先级的东西。

### 7.2 文件读触发的 nested memory

当模型读取某个文件时，`attachments.ts` 会检查从 cwd 到目标文件路径之间是否有更近的 `CLAUDE.md` / `.claude/rules`，并生成 `nested_memory` attachment。

这解决了一个问题：启动时只能加载 cwd 相关规则，但用户可能后来让模型打开另一个子目录的文件。那时需要动态补充那个子目录的局部规则。

### 7.3 user query 触发的 relevant memories

Auto Memory topic files 不常驻，而是走 `startRelevantMemoryPrefetch()`：

```text
last user prompt -> memory manifest -> Sonnet selector -> read selected files -> relevant_memories attachment
```

这个 prefetch 不阻塞主模型。它和主循环并行跑，等工具执行后如果已经完成就注入；没完成则跳过，下一个 iteration 再试。

这是一种很实用的延迟策略：记忆召回提升质量，但不能拖慢每次响应。

---

## 八、写入链路：记忆如何被保存

### 8.1 主模型直接写

主模型 system prompt 明确说：

- 用户要求 remember：立即写
- 用户要求 forget：找到并删除相关 entry
- 优先更新已有文件，避免重复
- topic file 要带 frontmatter
- `MEMORY.md` 只放索引

由于 FileWrite/Edit 本身经过权限系统，主模型写 memory 仍受工具权限和路径校验约束。

### 8.2 Auto Memory 后台抽取

当主模型没有写 memory 时，`extractMemories` 在 stop hook 中补写：

```text
完整主上下文 fork -> 最近消息 -> memory extraction prompt -> 只允许 memory 目录写入
```

它是 best-effort，失败只打 debug log，不打扰用户。

### 8.3 Session Memory 后台维护

Session Memory 是 post-sampling hook，达到 token 和 tool-call 阈值后运行。它不写 topic files，也不维护索引，只更新当前 session 的 `summary.md`。

### 8.4 Team Memory watcher 同步

Team Memory 本地写入后，watcher 2 秒 debounce，然后 push 到服务端。服务端内容也会在启动时 pull 回本地。

---

## 九、和 compact 的关系

Claude Code 的 compact 系统和 memory 系统有两种组合方式。

### 9.1 Auto Memory 不直接替代 compact

Auto Memory 是跨会话事实和偏好，不应该保存当前任务临时状态。因此它不会直接作为 compact summary。

如果用户当前任务很长，应该靠 Session Memory 或传统 compact summary 保持连续性，而不是把“当前做了哪些文件、测试跑到哪里”写进长期 memory。

### 9.2 Session Memory 可以替代传统 compact summary

`trySessionMemoryCompaction()` 会在 compact 前尝试：

- 如果 session memory 有有效内容，就用它构造 summary message。
- 再保留最近一段原文消息。
- 如果结果 token 仍超出 auto compact threshold，则放弃，回退传统 compact。

这有两个优势：

1. 不需要在上下文快爆时再调一次大 summary LLM。
2. 因为 session notes 是持续维护的，可能比临时 compact summary 更稳定。

但它也有风险：如果 session notes 漏了关键信息，compact 后就会丢。因此它仍保留 10k-40k tokens 的最近原文作为 tail。

---

## 十、安全和抗污染设计

Claude Code memory 系统里有很多“防记忆污染”的设计。

### 10.1 类型边界

`memoryTypes.ts` 反复强调：

- Memory 不保存可从代码/git/CLAUDE.md 推导的信息。
- Memory 不保存当前任务临时状态。
- Memory 对具体函数、文件、flag 的声明必须在使用前重新验证。
- 如果用户要求 ignore memory，就按 MEMORY.md 为空处理，不能引用、比较或提及。

这其实是在对抗 LLM memory 最常见的问题：陈旧上下文伪装成事实。

### 10.2 索引和内容分离

`MEMORY.md` 只做索引，topic file 存详细内容。索引限制 200 行 / 25KB。这样可以：

- 控制常驻上下文
- 避免用户几年后积累的 memory 把 system prompt 撑爆
- 让召回可以按 query 精选

### 10.3 权限最小化

后台 extractor 的工具权限是最小化的：

- Auto Memory extractor 只能写 memory dir。
- Session Memory extractor 只能 Edit 一个精确文件。
- Compact summarizer 拒绝所有工具。
- Team Memory 写入要通过 symlink-aware path validation。

这些限制让“后台记忆维护”不会变成隐形 agent 随便改项目文件。

### 10.4 去重和互斥

- 主模型已写 memory，则 background extractor 跳过。
- 已经 surfaced 的 memory 不重复注入。
- readFileState 记录已读 memory，防止同 turn 重复。
- `MEMORY.md` 文件作为 index，不允许重复 topic。

---

## 十一、设计评价

### 11.1 优点

**第一，分层非常清楚。**

Claude Code 没有把所有“过去的信息”都塞到同一个数据库里，而是按用途拆分：

- 行为规则走 CLAUDE.md
- 长期偏好走 memdir
- 当前任务状态走 Session Memory
- agent 经验走 Agent Memory
- 团队共享走 Team Memory

这比单一 vector memory 更可控。

**第二，默认是文件系统，而不是黑盒数据库。**

记忆都是 markdown 文件，用户可以 `/memory` 打开、编辑、删除、审查。这个选择牺牲了一些自动化检索能力，但换来可解释性和可迁移性。

**第三，召回不是全量注入。**

常驻的只有索引，topic files 用 sideQuery 选择最多 5 个。这是上下文成本和记忆能力之间比较务实的折中。

**第四，强调“使用前验证”。**

记忆被视为历史 claim，不被视为当前 truth。这对代码助手尤其重要，因为代码库变化很快。

### 11.2 缺点和风险

**第一，系统复杂度高。**

仅 memory 相关就横跨：

- `claudemd`
- `memdir`
- `extractMemories`
- `SessionMemory`
- `AgentTool`
- `teamMemorySync`
- `attachments`
- `compact`

调试一个“为什么某条记忆没出现”可能要查 gate、settings、feature flag、索引、frontmatter、selector、readFileState、prefetch 是否按时完成。

**第二，强依赖 LLM 自律。**

虽然 prompt 禁止保存代码可推导信息，但主模型或 extractor 仍可能误判，把 ephemeral 信息写成长记忆。

**第三，索引质量决定召回质量。**

Relevant memory selector 主要看 filename 和 description。如果 description 写得差，topic file 再有价值也可能召回不到。

**第四，feature gate 很多。**

不少行为受 GrowthBook gate 控制，例如 extract mode、skip index、relevant memory prefetch、team memory。这意味着不同构建/用户 cohort 下实际行为可能不一致。

### 11.3 一个核心产品判断

这套系统的核心判断是：

> 记忆不是为了让模型“记住所有事情”，而是为了让模型在未来对话中知道“哪些历史信息值得重新看，并以什么方式验证”。

所以它不用单一 embedding store，而用：

- `MEMORY.md` 作为人工可读索引
- topic markdown 作为可审计事实
- LLM selector 作为轻量召回
- read/grep/git 作为最终事实来源

这是为 coding agent 场景定制的 memory 设计，而不是聊天机器人式 persona memory。

---

## 十二、关键源码索引

| 模块 | 文件 | 作用 |
| --- | --- | --- |
| CLAUDE.md 加载 | `src/utils/claudemd.ts` | 指令记忆发现、include、规则加载、AutoMem/TeamMem entrypoint 注入 |
| Auto Memory 路径 | `src/memdir/paths.ts` | auto memory 开关、路径解析、remote memory dir、override |
| Auto Memory prompt | `src/memdir/memdir.ts` | memory system prompt、MEMORY.md 截断、daily log mode |
| Memory taxonomy | `src/memdir/memoryTypes.ts` | user/feedback/project/reference 四类记忆和保存规则 |
| Memory scan | `src/memdir/memoryScan.ts` | 扫描 topic files frontmatter，生成 manifest |
| Relevant recall | `src/memdir/findRelevantMemories.ts` | sideQuery 选择最多 5 个相关 memory |
| Attachment 注入 | `src/utils/attachments.ts` | nested_memory、relevant_memories、prefetch、去重 |
| Auto extraction | `src/services/extractMemories/extractMemories.ts` | 后台 forked agent 写长期 memory |
| Extraction prompt | `src/services/extractMemories/prompts.ts` | 后台抽取规则和工具限制 |
| Session Memory | `src/services/SessionMemory/sessionMemory.ts` | 当前会话 notes 更新 hook |
| Session Memory prompt | `src/services/SessionMemory/prompts.ts` | summary.md 模板、更新 prompt、截断 |
| Session Memory compact | `src/services/compact/sessionMemoryCompact.ts` | 用 session memory 替代传统 compact summary |
| Agent Memory | `src/tools/AgentTool/agentMemory.ts` | agent 专属 memory path 和 prompt 注入 |
| Team Memory path | `src/memdir/teamMemPaths.ts` | team memory 路径、安全校验 |
| Team Memory prompt | `src/memdir/teamMemPrompts.ts` | private/team combined prompt |
| Team sync | `src/services/teamMemorySync/index.ts` | 服务端 pull/push、hash、冲突、限制 |
| Team watcher | `src/services/teamMemorySync/watcher.ts` | fs.watch + debounce push |

---

## 总结

Claude Code 的记忆系统是一个文件系统优先、分层明确、强约束写入、按需召回的设计。它没有试图让模型永远带着所有历史，而是把历史拆成：

- 必须遵守的规则
- 可能有用的长期背景
- 当前会话的工作状态
- agent 专属经验
- 团队共享知识

然后分别用 system prompt、attachment、forked agent、watcher sync、compact integration 组合起来。

从工程角度看，它最大的价值不是“模型有记忆”，而是**记忆的边界被产品化了**：什么该记、什么不该记、什么时候读、读了以后是否可信、怎么写、写到哪里、谁能共享、如何避免污染，都在源码里有明确机制。对于 coding agent 来说，这比一个泛用向量库式 memory 更重要。
