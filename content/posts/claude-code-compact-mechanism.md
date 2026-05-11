---
title: "Claude Code `/compact` 机制分析"
date: 2026-05-11
draft: false
categories: ["notes"]
---

## Context（为什么需要这份分析）

用户想弄清楚 Claude Code 的 `compact` 功能在源码层面是如何实现的。这不是一个实现任务，而是一次对 `/Users/jishihe/work/civil-engineering-cloud-claude-code-source-v2.1.88/01-claude-code-source-crack/claude-code-source` 这份泄露源码的逆向阅读。产出就是这份文档——没有要改的代码。

---

## 一、总体架构：三层压缩

Claude Code 对上下文的管理不是单一 compact，而是**按"代价从小到大"四层递进**：

| 层级 | 目标 | 是否调 LLM | 关键文件 |
| --- | --- | --- | --- |
| **snip** | 裁剪被 REPL 显式标记丢掉的旧消息（UI 滚动历史） | 否 | `src/services/compact/snipCompact.ts` |
| **microcompact** | 不改消息数、只把旧 `tool_result`（Read/Bash/Grep/Glob/…）内容清空，靠 cache editing 保住 prompt cache | 否 | `src/services/compact/microCompact.ts` |
| **session memory compact** | 把靠前的消息裁掉 + 塞进一个已经由 background 线程提取好的 "session memory"，**保留最近若干条消息原文** | 否（预先提取好） | `src/services/compact/sessionMemoryCompact.ts` |
| **full compact（经典 /compact）** | 用 LLM 生成结构化摘要，**替换掉整段历史** | 是 | `src/services/compact/compact.ts` + `prompt.ts` |

在 query 主循环里依次执行（`src/query.ts:400-468`）：snip → microcompact → contextCollapse → autoCompactIfNeeded。前面几层没把 token 压到阈值以下，才会走到 LLM 级 compact。

---

## 二、触发路径

### 2.1 手动 `/compact [自定义指令]`

入口定义在 `src/commands/compact/index.ts`：

```ts
const compact = {
  type: 'local',
  name: 'compact',
  description: 'Clear conversation history but keep a summary in context. Optional: /compact [instructions for summarization]',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_COMPACT),
  supportsNonInteractive: true,
  load: () => import('./compact.js'),
}
```

实际执行在 `src/commands/compact/compact.ts:40` 的 `call()`：
1. `getMessagesAfterCompactBoundary(messages)` —— 只截取**上一次 compact 边界之后**的消息，避免重复摘要。
2. 没有自定义指令时先尝试 `trySessionMemoryCompaction`（轻量路径）。
3. 否则先 `microcompactMessages` 缩一轮，再 `compactConversation(...)` 走 LLM 摘要。

### 2.2 自动 autocompact（容量触发）

`src/services/compact/autoCompact.ts` 定义阈值：

```ts
// 为 LLM 输出留 20K tokens
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
const AUTOCOMPACT_BUFFER_TOKENS = 13_000   // 距离硬限还剩 13K 就触发
const MANUAL_COMPACT_BUFFER_TOKENS = 3_000  // 3K 就硬阻塞
```

- `getEffectiveContextWindowSize(model)` = 模型 context window - 为 summary 预留的 output tokens。
- `getAutoCompactThreshold(model)` = 有效窗 - 13K buffer。
- `shouldAutoCompact()` 在每轮 query 开始前估算 token 数，超过阈值就返回 true。
- **熔断**：连续 3 次 compact 失败后停止尝试（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES`），防止 session 死锁空转烧钱。
- 递归保护：querySource 是 `'session_memory'` / `'compact'` / `'marble_origami'` 时直接 return，避免 forked agent 自己再去 compact。

---

## 三、核心压缩算法：`compactConversation`

位于 `src/services/compact/compact.ts:387`。端到端流程：

```
┌─ 1. PreCompact hooks ─────────────────────────────────────────────────┐
│   executePreCompactHooks({ trigger:'auto'|'manual', customInstructions })
│   hook 可以改写 customInstructions / 加显示文案                       │
├─ 2. 拼 summary prompt ────────────────────────────────────────────────┤
│   getCompactPrompt(customInstructions)                                │
│   = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT + (Additional Instructions)│
│     + NO_TOOLS_TRAILER                                                │
├─ 3. 走 forked agent 调模型 ───────────────────────────────────────────┤
│   runForkedAgent({                                                    │
│     promptMessages: [summaryRequest],                                 │
│     cacheSafeParams,     ← 复用主线程 system prompt / tools / 消息前缀  │
│     canUseTool: createCompactCanUseTool(),  ← 拒绝所有工具调用          │
│     maxTurns: 1,                                                      │
│     skipCacheWrite: true                                              │
│   })                                                                  │
│   //   ↑ 复用 prompt cache 是关键。experiment 表明主路 98% 命中率，     │
│   //   否则每次 compact 会多烧几十 B tokens/day                        │
├─ 4. 退化路径：forked agent 失败 → queryModelWithStreaming 裸调         │
│    system = "You are a helpful AI assistant tasked with summarizing   │
│             conversations."                                           │
│    thinking = disabled，tools 仅 [FileReadTool] 保留                   │
│    messages = stripImages(stripReinjectedAttachments(                 │
│                 getMessagesAfterCompactBoundary(messages) +           │
│                 summaryRequest))                                      │
├─ 5. prompt_too_long 兜底 ─────────────────────────────────────────────┤
│   summary 开头 = "API Error: prompt is too long" → truncateHeadFor    │
│   PTLRetry() 砍掉最老的一组 API round，重试（最多 MAX_PTL_RETRIES 次）  │
├─ 6. 清状态 + 重建附件 ────────────────────────────────────────────────┤
│   context.readFileState.clear()                                       │
│   并行生成：                                                           │
│    ┌ createPostCompactFileAttachments —— 把压缩前被读过的文件重读     │
│    │    （上限 5 个文件，每文件 5K tokens，总 50K tokens）             │
│    ├ createAsyncAgentAttachmentsIfNeeded                              │
│    ├ createPlanAttachmentIfNeeded / createPlanModeAttachmentIfNeeded  │
│    ├ createSkillAttachmentIfNeeded —— 已调用过的 skill 原文          │
│    │    （上限 5 个，每个 5K，总 25K）                                 │
│    └ getDeferredToolsDeltaAttachment / AgentListing / MCP Instructions│
│    // 总之：把"主动上下文"重新塞回去，LLM 摘要里没覆盖的死信息（刚读    │
│    // 的代码、当前 plan、用到的 skill）靠这些 attachment 复活          │
├─ 7. SessionStart hooks（复用 'compact' 触发语义）                     │
├─ 8. 构造 boundary + summaryMessage ───────────────────────────────────┤
│   boundaryMarker = createCompactBoundaryMessage('auto'|'manual', …)   │
│   //   ↑ type:'system', subtype:'compact_boundary'，content="Conversa │
│   //     tion compacted"。未来 getMessagesAfterCompactBoundary 会反向  │
│   //     扫描、只保留这之后的消息。                                     │
│   summaryMessages = [ createUserMessage({                             │
│     content: getCompactUserSummaryMessage(summary, suppressFollow…)   │
│     isCompactSummary: true,                                           │
│     isVisibleInTranscriptOnly: true                                   │
│   }) ]                                                                │
├─ 9. formatCompactSummary —— 去 <analysis>，把 <summary> 变成          │
│     "Summary:\n..." 可读文本                                          │
├─10. 埋点 tengu_compact（preToken / postToken / 缓存命中率 / …）       │
├─11. notifyCompaction() —— 重置 prompt cache 基线，避免后续把 compact  │
│     自身导致的 cache drop 误报成 cache break                          │
├─12. PostCompact hooks ────────────────────────────────────────────────┤
└─13. return CompactionResult { boundaryMarker, summaryMessages, attach…│
                               hookResults, userDisplayMessage, … }     │
```

调用方（`src/commands/compact/compact.ts` 或 `autoCompact.ts`）拿到 result 后再做 `runPostCompactCleanup()`、`suppressCompactWarning()`、`markPostCompaction()`、`notifyCompaction()`，然后把新消息数组交回 REPL。

---

## 四、摘要提示词（这才是"compact 究竟让 LLM 做什么"的答案）

都在 `src/services/compact/prompt.ts`。

### 4.1 前导（`NO_TOOLS_PREAMBLE`）

```
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
```

注释里写得很露骨：fork 出去的 agent 继承了主线程**全部工具定义**（为了 cache key 对上才能命中 prompt cache），但 Sonnet 4.6+ 的 adaptive-thinking 有 2.79% 概率无视弱指令去调工具 → maxTurns=1 浪费掉 → 所以把"不准调工具"作为最粗暴的前置指令。

### 4.2 主体（`BASE_COMPACT_PROMPT`）

要求模型产出**九段结构化摘要**：

1. **Primary Request and Intent** —— 用户原始请求
2. **Key Technical Concepts** —— 技术名词列表
3. **Files and Code Sections** —— 看过/改过的文件，**要求贴代码片段**
4. **Errors and fixes** —— 坑 + 用户反馈
5. **Problem Solving** —— 解决了什么
6. **All user messages** —— **所有非 tool_result 的用户消息全列出来**（最关键、最怕丢）
7. **Pending Tasks**
8. **Current Work** —— 压缩前最后在干什么，要贴文件名 + 代码片段
9. **Optional Next Step** —— 下一步，**要求引用最近对话原话**避免漂移

产出格式固定为：

```
<analysis>
[思考草稿；formatCompactSummary 会剥掉]
</analysis>

<summary>
1. Primary Request and Intent: …
…
9. Optional Next Step: …
</summary>
```

### 4.3 结尾（`NO_TOOLS_TRAILER`）

```
REMINDER: Do NOT call any tools. Respond with plain text only — an
<analysis> block followed by a <summary> block. Tool calls will be
rejected and you will fail the task.
```

### 4.4 两个变体

- `PARTIAL_COMPACT_PROMPT` —— 只摘要"最近消息"，前面保留原文（`partialCompactConversation`，用于 `direction='from'`）。
- `PARTIAL_COMPACT_UP_TO_PROMPT` —— 摘要前半、后半保留原文，会命中 cache prefix。

### 4.5 用户自定义指令拼接

```ts
if (customInstructions && customInstructions.trim() !== '') {
  prompt += `\n\nAdditional Instructions:\n${customInstructions}`
}
```

`/compact focus on test failures` 里的 `focus on test failures` 就拼在这里。

---

## 五、压缩后的会话长什么样

`getCompactUserSummaryMessage`（`prompt.ts:337`）产出的**单条 user 消息**：

```
This session is being continued from a previous conversation that ran
out of context. The summary below covers the earlier portion of the
conversation.

Summary:
1. Primary Request and Intent:
   ...
…
9. Optional Next Step:
   ...

If you need specific details from before compaction (like exact code
snippets, error messages, or content you generated), read the full
transcript at: <transcriptPath>

Recent messages are preserved verbatim.     ← 仅在保留尾部时追加

Continue the conversation from where it left off without asking the
user any further questions. Resume directly — do not acknowledge the
summary, do not recap what was happening, do not preface with "I'll
continue" or similar. Pick up the last task as if the break never
happened.                                   ← suppressFollowUpQuestions
```

autocompact 会设 `suppressFollowUpQuestions=true`，手动 `/compact` 不会。最终新消息序列：

```
[旧 boundary / 旧 summary]          ← 若本会话之前就 compact 过，这里保留
[SystemCompactBoundaryMessage]      ← 本次分隔符
[UserMessage（上面那段摘要）]
[file attachments]                  ← 重读的 ≤5 个文件
[plan / skill / 工具 delta attachments]
[SessionStart hook messages]
```

---

## 六、其它关键设计点

### 6.1 Cache-sharing fork
`runForkedAgent` 保证 fork 出去的 compact 调用与主线程 `cacheSafeParams` 完全一致（system prompt、tools、消息前缀、thinking 配置），这样 Anthropic API 侧 prompt cache 能命中主线程那一份——省出 ~38B tokens/day 的 cache_creation。

### 6.2 图片/文档剥离
`stripImagesFromMessages` 把 user 消息和 `tool_result` 里嵌套的 `image` / `document` block 换成 `[image]` / `[document]` 文本占位——一方面摘要用不着，另一方面图片会把 compact 自身的 request 撑爆。

### 6.3 prompt_too_long 重试
如果 compact 请求**自己**触发了 413，用 `truncateHeadForPTLRetry` 砍掉最老一组 API round 再试（最多 `MAX_PTL_RETRIES` 次）。这是 CC-1180 bug 的修复——以前用户直接卡死无法恢复。

### 6.4 Post-compact 文件重读
Compact 后 `context.readFileState.clear()` 会被清掉，`createPostCompactFileAttachments` 会挑最近读过的最多 5 个文件、每个最多 5K tokens、共 50K tokens 重新 Read 一遍塞回来。**这就是为什么 compact 后代码细节通常不会丢**——摘要里可能写了"修改了 foo.ts 的 bar 函数"，但真正可供 LLM 继续编辑的原文是通过 attachment 再喂一次进来的。

### 6.5 Boundary 概念
`createCompactBoundaryMessage` 插一条 `subtype: 'compact_boundary'` 的 system 消息到历史里。REPL UI 还是能看到全历史（可以滚回去），但是所有发给 API 的消息集合都是 `getMessagesAfterCompactBoundary(messages)` 反向扫到第一条 boundary 之后的。这就是 UI 和 API 视图解耦的方式。

### 6.6 Session memory compact（实验路径）
无自定义指令时优先尝试：
- 后台线程一直在抽取 session memory（工具输出纲要 + 决策点）。
- 触发时不调 LLM，直接用已提取好的 memory 文本生成"摘要"，**保留最近 10K–40K tokens 的原消息**（`DEFAULT_SM_COMPACT_CONFIG`）。
- 更便宜、对最近上下文无损；有自定义指令时回退到经典路径。

### 6.7 Reactive compact
在 `REACTIVE_COMPACT` feature flag 下，autocompact 关闭、只有当 API 真返回 413 (`prompt_too_long`) 时才就地压缩——更激进地利用 context。

---

## 七、一句话总结

**Claude Code 的 compact = "让模型用一份固定的九段式结构化 prompt 对整段对话做自我摘要 → 插一条 boundary → 清文件缓存 → 把最近读过的文件/调过的 skill/当前 plan 作为 attachment 重新注入"**。配合 microcompact 的 tool_result 清空、session memory 的后台预提取、forked agent 的 prompt cache 复用、PTL 重试熔断，形成一套"压缩代价阶梯 + 摘要永远可重入 + 缓存不破坏"的组合拳。

---

## 关键文件索引

| 文件 | 作用 |
| --- | --- |
| `src/commands/compact/index.ts` | `/compact` 命令注册 |
| `src/commands/compact/compact.ts` | `/compact` 的本地命令 `call()` 逻辑 |
| `src/services/compact/prompt.ts` | 全部摘要 prompt 字面量 + `formatCompactSummary` |
| `src/services/compact/compact.ts` | `compactConversation` / `partialCompactConversation` / `streamCompactSummary` / 附件重建 |
| `src/services/compact/autoCompact.ts` | 阈值计算、`shouldAutoCompact`、`autoCompactIfNeeded`、熔断 |
| `src/services/compact/microCompact.ts` | 清理旧 tool_result 的轻量预压缩 |
| `src/services/compact/sessionMemoryCompact.ts` | 不调 LLM 的 session-memory 版压缩 |
| `src/services/compact/postCompactCleanup.ts` | 压缩后通用清理钩子 |
| `src/utils/messages.ts:4530+` | `createCompactBoundaryMessage` / `findLastCompactBoundaryIndex` / `getMessagesAfterCompactBoundary` |
| `src/query.ts:400-468` | 主循环里 snip → microcompact → contextCollapse → autocompact 的调度 |
| `src/utils/forkedAgent.ts` | `runForkedAgent`（复用主线程 prompt cache 调 compact） |

## 验证建议（如果想动手跑一遍）

- 在项目根执行 `rg -n "NO_TOOLS_PREAMBLE" src/` 确认 prompt 字面量只此一家。
- `DEBUG=true` 跑一次会话，找 log `autocompact: tokens=... threshold=... effectiveWindow=...` 观察阈值。
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50` 可把触发阈值压到 50%，便于手动复现。
- 触发后在 `~/.claude/projects/*/` 的 transcript 里搜 `subtype":"compact_boundary"` 看实际边界消息结构。
