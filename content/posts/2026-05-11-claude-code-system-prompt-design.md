# Claude Code 系统提示词设计整理

## 目标

这份文档整理 Claude Code 在一次 query 中如何构造最终发给模型的 prompt，重点说明：

- system prompt 由哪些模块组成
- 哪些内容其实不在 system，而是在 messages 里
- CLAUDE.md、memory、git status、日期、MCP 指令分别从哪里进入
- prompt cache 为什么要把 system prompt 切成静态和动态两段
- 本地日志默认能看到什么，不能看到什么

这里说的“最终 prompt”不是单一字符串，而是一次 API 请求中的两部分：

1. `system` blocks
2. `messages` 数组

Claude Code 的设计重点不是把所有东西硬拼成一大段文本，而是把不同来源的信息按职责分层，再在发请求前统一装配。

---

## 一、总览：最终请求是怎么拼出来的

核心链路可以概括成：

```text
getSystemPrompt()
+ getSystemContext()
+ getUserContext()
+ 当前会话消息
        ↓
query.ts 中组装
        ↓
services/api/claude.ts 中规范化并追加前缀
        ↓
buildSystemPromptBlocks()
        ↓
anthropic.beta.messages.create(...)
```

更具体一点：

```text
静态 system sections
+ 动态 system sections
+ systemContext(git status 等)
= fullSystemPrompt

userContext(claudeMd, currentDate 等)
+ 原始 messages
= messages with prepended meta context

fullSystemPrompt + normalized messages + tools
= 最终 API 请求
```

关键文件：

- `src/query.ts`
- `src/utils/queryContext.ts`
- `src/constants/prompts.ts`
- `src/context.ts`
- `src/utils/api.ts`
- `src/services/api/claude.ts`
- `src/constants/system.ts`
- `src/utils/claudemd.ts`
- `src/memdir/memdir.ts`

---

## 二、最上游：先取三类基础材料

在 `src/utils/queryContext.ts` 里，Claude Code 会先取三类基础输入：

1. `defaultSystemPrompt`
2. `userContext`
3. `systemContext`

对应实现：

- `fetchSystemPromptParts()` in `src/utils/queryContext.ts`
- `getSystemPrompt()` in `src/constants/prompts.ts`
- `getUserContext()` in `src/context.ts`
- `getSystemContext()` in `src/context.ts`

这一步的设计很清楚：

- `system prompt` 负责长期稳定的行为规则
- `systemContext` 负责当前环境快照
- `userContext` 负责以 meta message 形式注入的补充上下文

也就是说，Claude Code 并没有把所有上下文都塞进 system prompt，而是故意拆成了两条通道。

---

## 三、system prompt 的主体：`getSystemPrompt()`

`src/constants/prompts.ts` 是 system prompt 的主装配器。

### 3.1 静态部分

在 `getSystemPrompt()` 的返回结果里，前半段是静态内容，也就是跨 turn 尽量稳定的部分。主要包含：

1. Intro
   - 说明“你是 Claude Code，Anthropic 的官方 CLI”
   - 说明核心任务是帮助用户完成软件工程任务

2. `# System`
   - 用户看到的文本规则
   - 工具权限模型
   - 如何对待 `<system-reminder>`
   - 如何对待外部工具返回数据
   - hook 机制
   - 上下文自动压缩

3. `# Doing tasks`
   - 软件工程任务的默认行为规范
   - 不要过度设计
   - 优先修改已有文件
   - 安全要求
   - 不要虚报验证结果
   - 遇到 Claude Code 本身的问题时如何建议用户 `/issue` 或 `/share`

4. `# Executing actions with care`
   - 哪些操作需要谨慎
   - 哪些操作风险大
   - 为什么不能随便用破坏性命令

5. `# Using your tools`
   - 优先用专用工具
   - 何时用 Bash
   - 何时用 Agent
   - 何时用 Skill

6. `# Tone and style`
   - 输出风格
   - 引用代码位置格式
   - 工具调用前不要写冒号

7. `# Communicating with the user` 或 `# Output efficiency`
   - 用户可见文本的写法
   - 什么时候要给进度更新
   - 简洁但不能丢关键信息

这些静态 sections 主要在 `src/constants/prompts.ts` 里定义：

- `getSimpleIntroSection()`
- `getSimpleSystemSection()`
- `getSimpleDoingTasksSection()`
- `getActionsSection()`
- `getUsingYourToolsSection()`
- `getSimpleToneAndStyleSection()`
- `getOutputEfficiencySection()`

### 3.2 动态部分

在静态部分后面，Claude Code 会追加动态 sections。动态 sections 的定义在 `src/constants/prompts.ts` 的 `dynamicSections` 数组。

这部分通常包括：

1. `session_guidance`
   - 当前会话下的工具使用建议
   - 例如什么时候应该让用户自己跑 `! command`
   - 什么时候该用 Agent 或 Explore
   - skills 如何触发

2. `memory`
   - memory 机制说明
   - 告诉模型 persistent memory 在哪里
   - 哪些记忆该存，哪些不该存
   - `MEMORY.md` 如何做索引

3. `ant_model_override`
   - Anthropic 内部场景下的额外 suffix
   - external 构建通常不会有

4. `env_info_simple`
   - 当前环境信息
   - working directory、是否 git repo、平台、shell、OS、模型信息、知识截止时间

5. `language`
   - 用户配置了语言偏好时追加

6. `output_style`
   - 用户配置了自定义输出风格时追加

7. `mcp_instructions`
   - 各个 MCP server 自己提供的 instructions

8. `scratchpad`
   - scratchpad 相关指令

9. `frc`
   - function result clearing 相关指令

10. `summarize_tool_results`
    - 工具结果摘要策略

11. feature flag 控制的额外 section
    - numeric length anchors
    - token budget
    - brief
    - proactive 相关能力

这部分的意义是：

- 静态 prompt 负责通用行为原则
- 动态 prompt 负责当前会话和当前环境的变化面

这样才能兼顾稳定性和灵活性。

---

## 四、`CLI sysprompt prefix` 其实只有一句话

在 `src/services/api/claude.ts` 中，真正发送请求前，还会把 `getCLISyspromptPrefix()` 的结果插到最前面。

这个前缀定义在 `src/constants/system.ts`。

它一共有 3 个候选值：

1. 默认交互式 CLI

```text
You are Claude Code, Anthropic's official CLI for Claude.
```

2. 非交互式，并且带 appendSystemPrompt

```text
You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.
```

3. 非交互式，但没有 appendSystemPrompt

```text
You are a Claude agent, built on Anthropic's Claude Agent SDK.
```

所以 `CLI sysprompt prefix` 不是一大段规则，它只是一个“身份和运行形态声明”。

它不包含：

- tools 说明
- git status
- CLAUDE.md
- 日期
- memory 内容

这些都来自别的层。

---

## 五、真正发出前，system prompt 还会再包两层

在 `src/services/api/claude.ts` 中，system prompt 最后会被组装成：

1. `getAttributionHeader(fingerprint)`
2. `getCLISyspromptPrefix(...)`
3. `...systemPrompt`
4. 某些可选附加指令
   - advisor instructions
   - chrome tool search instructions

所以最终的 `systemPrompt` 不是只有 `prompts.ts` 出来的正文，还多了两层外围包装：

### 5.1 Attribution header

这部分来自 `src/constants/system.ts` 的 `getAttributionHeader()`。

它大概长这样：

```text
x-anthropic-billing-header: cc_version=...; cc_entrypoint=...;
```

它更像一个通过 request body 携带的内部标记，而不是面向模型语义的提示词内容。

### 5.2 CLI prefix

就是上一节说的那句身份声明。

这个设计说明 Claude Code 并不把“身份”硬编码在正文 sections 里，而是作为独立前缀插入，方便缓存分层和后续拆分。

---

## 六、systemContext：git status 这类信息其实走 system 通道

`src/context.ts` 里的 `getSystemContext()` 会构造 systemContext。

默认最重要的一项是：

- `gitStatus`

其内容包括：

- 当前 branch
- main branch
- git user
- 工作区 status snapshot
- 最近 commits

注意这里强调的是“snapshot at the start of the conversation”，也就是一个会话开始时的快照，不会自动更新。

在 `src/query.ts` 里，Claude Code 会这样做：

```ts
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)
```

而 `appendSystemContext()` 在 `src/utils/api.ts` 里的实现非常直接：

- 把 `systemContext` 的 key/value 直接拼成文本
- 追加到 system prompt 末尾

所以像下面这些东西，其实属于 system prompt 的一部分：

- `gitStatus`
- 某些 cache breaker 注入

这就是为什么你在 prompt 结构里应该把 git status 视为 system 层附加上下文，而不是 user message。

---

## 七、userContext：CLAUDE.md 和日期其实走首条 meta user message

与 `systemContext` 不同，`userContext` 不是 append 到 system prompt，而是通过 `prependUserContext()` 插入到 `messages` 最前面。

实现位于 `src/utils/api.ts`。

它会构造一条 meta user message，内容格式类似：

```text
<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
...
# currentDate
...
IMPORTANT: this context may or may not be relevant...
</system-reminder>
```

也就是说：

- `claudeMd` 不在 system prompt 里
- `currentDate` 也不在 system prompt 里
- 它们在 messages 数组里，而且是第 0 条 meta user message

这个设计非常重要，因为它说明 Claude Code 区分了两种东西：

1. system-level behavior rules
2. conversation-level contextual hints

CLAUDE.md 更接近第二种。

---

## 八、`claudeMd` 的真实来源不是一个文件，而是一组文件汇总

`src/utils/claudemd.ts` 负责加载用户和项目指令文件。

它的加载层级大致是：

1. managed memory
   - 例如 `/etc/claude-code/CLAUDE.md`

2. user memory
   - `~/.claude/CLAUDE.md`

3. project memory
   - 项目根目录及向上路径中的 `CLAUDE.md`
   - `.claude/CLAUDE.md`
   - `.claude/rules/*.md`

4. local memory
   - `CLAUDE.local.md`

而且支持 `@include`，所以一份 CLAUDE.md 还可能再引入别的文本文件。

最后这些内容会被 `getClaudeMds(...)` 汇总成一大段 `claudeMd` 字符串，进入 `userContext`。

所以从设计上看：

- CLAUDE.md 是用户/项目定制规则层
- 它不是底层 runtime system prompt 模板本身
- 它是通过“上下文注入”覆盖默认行为的

这也解释了为什么代码里专门有一句：

```text
IMPORTANT: These instructions OVERRIDE any default behavior...
```

Claude Code 想让模型把这些文件视为高优先级补充规则。

---

## 九、memory prompt 和 CLAUDE.md 不是一回事

源码里这两个概念很容易混，但职责完全不同。

### 9.1 `loadMemoryPrompt()`

这个函数在 `src/memdir/memdir.ts`。

它生成的是“记忆系统使用规则”，比如：

- memory 存放目录在哪里
- 有哪些 memory type
- 哪些该存、哪些不该存
- 怎么写 frontmatter
- 怎么维护 `MEMORY.md`

这部分进入 system prompt 的动态 section。

### 9.2 `claudeMd`

这个来自 `src/utils/claudemd.ts`，是实际的用户和项目规则正文。

它不是 memory 机制说明，而是具体内容，比如：

- 项目协作偏好
- 输出语言要求
- 操作规范
- 用户自己的工作方式

这部分进入首条 meta user message。

简化说：

- memory prompt = “如何使用记忆系统”
- claudeMd = “用户和项目到底要求你做什么”

---

## 十、messages 不是原样直发，还会再规范化

到了 `src/services/api/claude.ts`，Claude Code 会对消息流做进一步处理。

主要步骤有：

1. `normalizeMessagesForAPI(messages, filteredTools)`
   - 统一 message 结构
   - 规范 tool use/tool result 格式

2. 针对 model 能力做后处理
   - 不支持 tool search 的模型会 strip 掉对应字段

3. `ensureToolResultPairing(messagesForAPI)`
   - 修复 tool_use / tool_result 不成对的问题

4. strip 掉不兼容 blocks
   - 比如 advisor block 没开 beta 时去掉

5. 控制媒体数量
   - 超过上限时裁剪旧媒体

6. 某些场景下注入额外 meta user message
   - 例如 `<available-deferred-tools>`

这说明“最终 messages”也不是单纯的用户对话历史，而是一个经过修正、注入、约束后的规范化消息流。

---

## 十一、prompt cache 的关键设计：静态和动态边界

Claude Code 在 prompt 设计上有一个非常重要的优化点：

- `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`

定义在 `src/constants/prompts.ts`。

它的作用是把 system prompt 分成：

1. 静态部分
2. 动态部分

然后 `splitSysPromptPrefix()` in `src/utils/api.ts` 会据此拆分缓存作用域：

- attribution header: 不缓存或特殊处理
- CLI prefix: org scope
- 静态正文: global scope
- 动态正文: 不走全局缓存

这背后的设计目的很明确：

- 通用规则尽量跨 session 复用缓存
- 会变化的内容，如 env、language、MCP、memory prompt 等，单独挂在后面
- 避免因为一个小变动把整个大 system prompt 的 cache key 打碎

这也是为什么 Claude Code 的 system prompt 不是“随便 join 一下字符串”，而是显式建模成 `string[]` blocks 再拆。

---

## 十二、从模型视角看，最终请求结构可以近似理解为这样

```text
SYSTEM:
1. x-anthropic-billing-header ...
2. You are Claude Code, Anthropic's official CLI for Claude.
3. 静态 system sections
   - intro
   - system
   - doing tasks
   - actions
   - using tools
   - tone/style
   - output efficiency
4. 动态 system sections
   - session guidance
   - memory prompt
   - env info
   - language/output style
   - MCP instructions
   - scratchpad / summarize tool results / frc / brief / token budget 等
5. systemContext
   - gitStatus
   - cacheBreaker(如果有)

MESSAGES:
0. prependUserContext 生成的 meta user message
   - claudeMd
   - currentDate
1. 额外 meta user message
   - 例如 available-deferred-tools
2. 用户真实输入
3. 历史 assistant messages
4. tool use / tool result messages
```

这个结构基本就是 Claude Code prompt 设计的本质。

---

## 十三、为什么要把 CLAUDE.md 放在 userContext，而不是 system prompt 里

从设计上看，这么做有几个好处。

### 13.1 减少基础 system prompt 波动

如果把 CLAUDE.md 直接拼到 system prompt 里，那么每个项目、每个用户、每次规则变化都会直接打碎 system cache。

放到 `prependUserContext()` 里，可以把“默认系统行为模板”和“用户项目自定义说明”分层。

### 13.2 语义更准确

Claude Code 自带规则是产品级 runtime contract。

而 CLAUDE.md 更像“当前工作上下文中的高优先级补充说明”。

把它包装成 `<system-reminder>` user meta message，语义上更接近“这里有额外上下文，请按需使用，但优先级很高”。

### 13.3 更适合项目级定制

CLAUDE.md 本来就是用户和项目自定义层，天然更接近 conversation context，而不是产品内核提示词模板。

---

## 十四、本地日志能看到哪一层

从源码看，默认本地能看到的是 transcript，不是完整最终请求。

### 14.1 默认 transcript

`src/utils/sessionStorage.ts` 会把会话记录写到：

- `~/.claude/projects/<project-slug>/<sessionId>.jsonl`

这里通常能看到：

- user message
- assistant message
- tool_use
- tool_result
- attachment
- 一些 metadata

但通常看不到：

- 完整 system prompt blocks
- 完整 tools schema
- 最终 `anthropic.beta.messages.create(...)` 的原始 request body

### 14.2 history

`~/.claude/history.jsonl` 主要是输入历史，不是完整 prompt。

### 14.3 dump-prompts

真正会把 request body 落盘的是：

- `src/services/api/dumpPrompts.ts`
- 输出目录：`~/.claude/dump-prompts/<sessionOrAgentId>.jsonl`

这里会写：

- `init` 记录：system、tools、metadata
- `message` 记录：新 user messages
- `response` 记录：模型响应

但这条路径默认有条件，external 用户通常不开。

所以默认本地日志只够看“对话和工具轨迹”，不够看“完整最终 prompt”。

---

## 十五、这一套设计的几个核心取舍

### 15.1 不是单字符串，而是分层 block 设计

好处：

- 方便缓存
- 方便附加前缀
- 方便只替换动态部分
- 方便做不同 cache scope

### 15.2 把 runtime 行为规则和项目上下文分离

- 产品内核规则进 system
- 项目/用户规则进 userContext
- 环境快照进 systemContext

这让每一层的职责很清楚。

### 15.3 把可缓存部分和高波动部分分离

这是 Claude Code prompt engineering 里最工程化的一点。

重点不是“提示词写得多聪明”，而是“提示词结构怎么减少 token churn”。

### 15.4 把 message 流也当成 prompt 设计的一部分

Claude Code 没有把 prompt 只理解成 system 文本。

它同样重视：

- 哪些 meta message 要 prepend
- 工具消息怎样规范化
- 哪些内容该留在 messages 层而不是塞进 system

这个视角比“只研究 system prompt 正文”更接近真实实现。

---

## 十六、结论

Claude Code 的最终 prompt 设计，可以归纳成一句话：

> 用静态 system 模板定义默认行为，用动态 system sections 注入当前能力和环境，用 systemContext 追加运行时快照，用首条 meta user message 注入 CLAUDE.md 和日期，再把整个消息流规范化后发送给模型。

如果只盯着某一段 system 文本，很容易误判实际结构。真正重要的是这四层：

1. CLI prefix 和 attribution header
2. system prompt sections
3. systemContext
4. prepended userContext + normalized messages

Claude Code 的 prompt 设计本质上是一个分层上下文装配系统，不只是一个长 prompt 模板。

---

## 附：最值得读的源码入口

如果后续还要继续深入，优先看这几个入口：

1. `src/query.ts`
   - 看 query 时如何组装 `fullSystemPrompt` 和 `messages`

2. `src/constants/prompts.ts`
   - 看 system prompt 的静态和动态 sections

3. `src/context.ts`
   - 看 `getUserContext()` 和 `getSystemContext()` 的边界

4. `src/utils/api.ts`
   - 看 `appendSystemContext()`、`prependUserContext()`、`splitSysPromptPrefix()`

5. `src/services/api/claude.ts`
   - 看最终发送 API 前的规范化和包装

6. `src/utils/claudemd.ts`
   - 看 CLAUDE.md 汇总逻辑

7. `src/memdir/memdir.ts`
   - 看 memory prompt 的生成逻辑
