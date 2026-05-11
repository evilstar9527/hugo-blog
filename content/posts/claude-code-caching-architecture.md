# Claude Code 缓存设计架构文档

> **源码依据**：`/Users/jishihe/work/civil-engineering-cloud-claude-code-source-v2.1.88/01-claude-code-source-crack/claude-code-source/src`
> 所有行号与路径都指向该目录。

---

## 1. 背景与问题域

LLM Agent 的每一轮请求都要把 `system + tools + 完整消息历史` 再发给模型。随着对话变长，延迟与成本线性增长。Anthropic 官方提供了 **prompt caching**（`cache_control: { type: 'ephemeral' }`）：服务端按请求前缀的字节比对命中缓存，5min 或 1h TTL 内复用已经预填（prefill）过的 KV，延迟下降一个数量级。

能用好这个能力的前提是："下一次请求的前缀字节必须完全等于上一次"。Claude Code 的缓存设计整个就是围绕这一条约束来组织的。

设计目标：
1. 每轮请求尽可能多地命中服务端缓存（`cache_read_input_tokens` 最大化）。
2. 系统 prompt 的动态变化（时间、cwd、git、CLAUDE.md）不能污染可缓存前缀。
3. 工具集在会话内字节稳定（GrowthBook flag 翻转不能引起 tools 漂移）。
4. 长对话能在不丢失语义的前提下"回收"老的 tool_result 负载。
5. 当缓存意外失效时，能自动定位并报告根因。

---

## 2. 顶层架构：请求的三层前缀结构

一个发给 Anthropic API 的请求被切成三段，每段各自管理缓存：

```
┌─────────────────────────────────────────────────────────────┐
│  system: TextBlockParam[]                                   │
│   ├── [0] attribution header        (cache_scope=null)      │
│   ├── [1] 静态指令 + 工具说明        (cache_scope=global)   │ ← 块边界 cache_control
│   └── [2] 动态上下文 (时间/cwd/git)  (cache_scope=null)     │
├─────────────────────────────────────────────────────────────┤
│  tools: BetaToolUnion[]                                     │
│   ├── tool_1                                                │
│   ├── tool_2                                                │
│   └── tool_N                        (ttl=1h, scope=org)     │ ← 最后一个 tool 上的 cache_control
├─────────────────────────────────────────────────────────────┤
│  messages: MessageParam[]                                   │
│   ├── msg_1 (user)                                          │
│   ├── msg_2 (assistant)                                     │
│   ├── ...  ← 旧 tool_result 携带 cache_reference            │
│   └── msg_N (user)  最后一个 content block (ttl=1h)         │ ← 全局唯一 cache_control 断点
└─────────────────────────────────────────────────────────────┘
```

**关键约束**：一次请求里 `cache_control` 断点 ≤ 4（API 上限），且**最后一个断点必须落在 messages 的最后一条**——只有这样，下一轮新追加的内容才会被写入"可读前缀"里。

---

## 3. 分层实现

### 3.1 System Prompt：静态 / 动态边界

**文件**：`utils/api.ts:321 splitSysPromptPrefix()`
**常量**：`constants/prompts.ts:114 SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'`

system prompt 被设计成**字符串数组**，不是单个大字符串。数组中插入一个哨兵字符串 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 作为"静态 | 动态"的分水岭。

```ts
// constants/prompts.ts: 拼装 system prompt
[
  BILLING_HEADER,
  CLI_SYSPROMPT_PREFIX,         // 包含版本、identity
  ...STATIC_INSTRUCTIONS,        // 工作方式、Tool usage 规范
  ...TOOL_USAGE_DESCRIPTIONS,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY, // <-- 边界
  ...SESSION_SPECIFIC_GUIDANCE,  // 依赖 isNonInteractive / hasSkills 等运行期标志
  CWD_AND_TIME,
  CLAUDE_MD_CONTENT,
]
```

**切分规则**（`splitSysPromptPrefix` 输出 3~4 个 `TextBlockParam`）：

| 段 | cacheScope | 合并规则 |
|---|---|---|
| attribution header | `null` | 不打 cache_control |
| CLI 前缀 | `null` 或 `org` | 账单级别的小变量 |
| 边界之前的所有静态段 | `'global'` | 合并成一个 TextBlock，**所有组织共享同一个服务端缓存条目** |
| 边界之后 | `null` | 不缓存 |

**关键注释**（`constants/prompts.ts:343-350`）：边界之后的每个条件开关都会"让 Blake2b 前缀 hash 翻倍（2^N 种变体）"，所以凡是运行期才确定的文案必须放到边界之后。

**MCP 降级路径**：如果当前会话接了 MCP 工具（tool 集本身就是组织特定的），`splitSysPromptPrefix` 被传入 `skipGlobalCacheForSystemPrompt=true`，三段全部降到 `org` 作用域，不再走 `global`。

### 3.2 Tools：会话内字节稳定 + 末尾断点

**文件**：`utils/api.ts:119 toolToAPISchema()`、`utils/toolSchemaCache.ts`

每个 tool schema 的生成分两步：

1. **Base schema 会话级缓存**（`toolSchemaCache`）：`name / description / input_schema / strict / eager_input_streaming` 这些不变量计算一次就缓存。
   - Cache key 通常是 `tool.name`；MCP / StructuredOutput 工具带 `inputJSONSchema`，key 改用 `${name}:${stringify(schema)}` 以避免冲突。
   - 动机：避免 GrowthBook flag (`tengu_tool_pear`、`tengu_fgts`) 或 `tool.prompt()` 本身的输出抖动把 tools 字节搅乱。
2. **Per-request overlay**：在 base schema 上叠加本次请求的 `defer_loading` 和 `cache_control`——通过显式字段拷贝，不污染 base。

```ts
type BetaToolWithExtras = BetaTool & {
  strict?: boolean
  defer_loading?: boolean
  cache_control?: {
    type: 'ephemeral'
    scope?: 'global' | 'org'
    ttl?: '5m' | '1h'
  }
}
```

**断点位置**：tools 数组上通常只给**最后一个 tool** 挂 `cache_control`，整个 tools 段成为可缓存前缀的一部分。

### 3.3 Messages：全局唯一断点位于最后一条

**文件**：`services/api/claude.ts:3063 addCacheBreakpoints()`

```ts
const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
const result = messages.map((msg, index) => {
  const addCache = index === markerIndex
  ...
})
```

**为什么只打一个**（`claude.ts:3078-3088` 原注释）：
> Exactly one message-level cache_control marker per request. Mycro's turn-to-turn eviction frees local-attention KV pages at any cached prefix position NOT in `cache_store_int_token_boundaries`. With two markers the second-to-last position is protected and its locals survive an extra turn even though nothing will ever resume from there — with one marker they're freed immediately.

断点只打在最后一条消息的**最后一个 content block** 上：

- `userMessageToMessageParam` (`claude.ts:588`) 和 `assistantMessageToMessageParam` (`claude.ts:633`) 都只给 `content[length-1]` 挂 `cache_control`。
- Assistant 消息会跳过 `thinking` 和 `redacted_thinking` 块（它们不能带 cache_control）。

**skipCacheWrite 模式**（fire-and-forget 子代理）：marker 挪到倒数第二条——这样写操作落在"已经存在的前缀边界"上，服务端去重为 no-op 合并，子代理不会把自己的尾巴写进 KV cache 污染主线程。

### 3.4 Tool Result：cache_reference 的引用机制

**文件**：`services/api/claude.ts:3164-3207`

在 cache 断点**之前**的所有 `tool_result` 块，会被追加一个 `cache_reference` 字段：

```ts
msg.content[j] = Object.assign({}, block, {
  cache_reference: block.tool_use_id,
})
```

这让服务端可以：

- 按 `tool_use_id` 从缓存中取回之前那次的 tool_result 完整内容；
- 客户端下一轮可以把该 tool_result 的 `content` 清空（只留引用），大幅缩小 request body；
- 配合 microcompact 做"负载回收但保留语义"。

---

## 4. 横切关注点

### 4.1 `getCacheControl()`：统一的 cache_control 工厂

**文件**：`services/api/claude.ts:358`

```ts
export function getCacheControl({ scope, querySource } = {}) {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}
```

所有地方需要 `cache_control` 的地方都走这一个工厂，保证 TTL / scope 的取值**在一次请求内一致**——一旦不一致，服务端会把它当成新的缓存条目。

### 4.2 TTL 决策：`should1hCacheTTL()` 的会话级 latch

**文件**：`services/api/claude.ts:393`

决定 1h 还是 5m 的逻辑包含：

1. **Bedrock 第三方**：通过 env `ENABLE_PROMPT_CACHING_1H_BEDROCK` 自助开启。
2. **第一方**：只对 Anthropic 员工账号或订阅用户开启，且不在 overage 状态。
3. **GrowthBook allowlist**：按 `querySource` 前缀匹配（如 `repl_main_thread*`、`sdk`、`agent:*`）。

**关键设计**：这两个判断结果在 session 启动时 latch 到 bootstrap state (`getPromptCache1hEligible`, `getPromptCache1hAllowlist`)。原因：

> Latch eligibility in bootstrap state for session stability — prevents mid-session overage flips from changing the cache_control TTL, which would bust the server-side prompt cache (~20K tokens per flip).

即：**同一会话的 TTL 值必须不变**，否则每一次翻转都是一次 cache break。

### 4.3 缓存失效检测：Phase 1 记录 / Phase 2 诊断

**文件**：`services/api/promptCacheBreakDetection.ts`

一个独立的诊断子系统，分两阶段工作：

**Phase 1 `recordPromptState()` (L247)**：每次 API 调用**之前**，把本次的状态指纹化：

- `systemHash` = 剥离 cache_control 后的 system 字节 hash
- `toolsHash` = 剥离 cache_control 后的 tools 字节 hash
- `cacheControlHash` = 只保留 cache_control 字段的 hash（用于检测 scope/TTL 翻转）
- `perToolHashes` = 每个 tool 的独立 hash（解释"77% 的 tool break 来自 schema 描述漂移"）
- 以及 model / fastMode / betas / autoMode / overage / effort / extraBody 等

与上一次对比，差异写入 `pendingChanges` 暂存。

**Phase 2 `checkResponseForCacheBreak()` (L437)**：响应返回后，读 `cache_read_input_tokens`：

- 若 `cacheReadTokens >= prevCacheRead * 0.95` 或绝对下跌 `< 2000`，**不视作 break**（正常抖动）。
- 否则把 pending changes 翻译成人类可读原因，比如：
  - `model changed (sonnet-4-6 → opus-4-7)`
  - `tools changed (+1/-0 tools)`
  - `system prompt changed (+120 chars)`
  - `possible 5min TTL expiry (prompt unchanged)`
- 写 `tengu_prompt_cache_break` 事件 + `cache-break-xxxx.diff` 供工程师排查。

**跟踪键隔离**：`getTrackingKey()` 按 `querySource` + `agentId` 分桶，子代理并发不会相互污染。容量 `MAX_TRACKED_SOURCES=10`，LRU 淘汰。

### 4.4 上下文压缩：microcompact & cache_edits

**文件**：`services/compact/microCompact.ts`、`services/compact/compact.ts`

两种触发场景：

- **时间触发**（`timeBasedMicrocompact`, L402）：距离上一次主循环助理消息超过阈值（默认 5min），主动压缩老的 tool_result。
- **Token 触发**：接近 context 上限时触发。

**压缩动作**：

1. 扫描所有 `tool_result` 块，按 `COMPACTABLE_TOOLS` 白名单筛选。
2. 保留最近 `keepRecent` 条完整内容，更早的：
   - 将本地 content 清空或置为简短摘要；
   - 在最后一条 user message 里插入 `cache_edits` 块，声明 `{ type: 'delete', cache_reference: <tool_use_id> }`；
   - 服务端按 reference 从缓存读取原文，但本地不再持有长文本。
3. 这些 `cache_edits` 被 `pin` 到 `pinnedEdits[]`，下次请求会再次在同一位置插入，保证服务端视图一致。
4. `notifyCacheDeletion()` 告知 cache break 检测器"下一次 `cache_read` 下跌是预期的"，避免误报。

**compact vs microcompact**：

- microcompact：只动 tool_result 负载，保留消息结构，不触发额外 LLM 调用。
- 全量 compact：触发一个 LLM 调用总结整段历史，用总结替换历史消息；之后调用 `notifyCompaction()` 重置 cache baseline。

---

## 5. 端到端请求装配流程

```
用户输入
  ↓
构造 messages (追加 user turn)
  ↓
┌────────────────────────────┐
│ recordPromptState()        │ Phase 1: 状态指纹化
│  - hash system / tools ... │
│  - diff vs previous state  │
└────────────────────────────┘
  ↓
timeBasedMicrocompact() 检查是否需要压缩老 tool_result
  ↓
┌────────────────────────────────────────────────┐
│ buildSystemPromptBlocks(systemPrompt)          │
│   → splitSysPromptPrefix()                     │
│   → 3~4 个 TextBlockParam                      │
│   → 静态段挂 cache_control scope=global        │
├────────────────────────────────────────────────┤
│ getTools() → toolToAPISchema(每个)             │
│   → toolSchemaCache 读/写                      │
│   → 最后一个 tool 挂 cache_control             │
├────────────────────────────────────────────────┤
│ addCacheBreakpoints(messages)                  │
│   → 最后一条消息的最后一个 block 挂 marker     │
│   → 旧 tool_result 挂 cache_reference          │
│   → 插入 pinnedEdits (如有)                    │
└────────────────────────────────────────────────┘
  ↓
POST /v1/messages
  ↓
响应 usage: { cache_creation_input_tokens, cache_read_input_tokens, ... }
  ↓
┌────────────────────────────┐
│ checkResponseForCacheBreak │ Phase 2: 用 pendingChanges 解释意外下跌
└────────────────────────────┘
```

---

## 6. 设计原则小结

1. **字节稳定优先**：任何会让同一会话 tools/system 字节变化的机制（feature flag、schema 重生成）都要被冻结在 session boot 时。
2. **静态与动态分离**：高频变化的值（时间、cwd、git）必须位于所有 cache 断点之后；需要随时间变化但仍想缓存的值（effort、TTL 资格）必须 latch。
3. **单一断点在末尾**：不贪多断点，让"新内容"恰好增量写入末尾。
4. **引用替代重传**：长 tool_result 用 cache_reference，让服务端缓存成为内容存储。
5. **可观测即正确**：每一次缓存未命中都要有自动归因，否则你不知道什么时候悄悄退化了。

---

## 7. 源码索引表

| 主题 | 文件 | 关键位置 |
|---|---|---|
| system prompt 切分与 global scope | `utils/api.ts` | `splitSysPromptPrefix` L321 |
| 动态边界哨兵 | `constants/prompts.ts` | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` L114 |
| session-specific 指引（必须在边界后） | `constants/prompts.ts` | `getSessionSpecificGuidanceSection` L352 |
| tool schema 组装 + cache 覆盖 | `utils/api.ts` | `toolToAPISchema` L119 |
| tool schema 会话级缓存 | `utils/toolSchemaCache.ts` | — |
| `getCacheControl` 工厂 | `services/api/claude.ts` | L358 |
| TTL 资格 latch | `services/api/claude.ts` | `should1hCacheTTL` L393 |
| user/assistant 消息挂 cache_control | `services/api/claude.ts` | L588-674 |
| 唯一 message-level marker | `services/api/claude.ts` | `addCacheBreakpoints` L3063-3106 |
| tool_result 加 cache_reference | `services/api/claude.ts` | L3164-3207 |
| 构建 system blocks（请求时） | `services/api/claude.ts` | `buildSystemPromptBlocks` L3213 |
| 缓存失效检测 Phase 1 | `services/api/promptCacheBreakDetection.ts` | `recordPromptState` L247 |
| 缓存失效检测 Phase 2 | `services/api/promptCacheBreakDetection.ts` | `checkResponseForCacheBreak` L437 |
| 压缩后重置 baseline | `services/api/promptCacheBreakDetection.ts` | `notifyCompaction` L689 |
| 时间触发 microcompact | `services/compact/microCompact.ts` | `timeBasedMicrocompact` L402 |
| 基于 cache_edits 的 microcompact | `services/compact/microCompact.ts` | L253, L296 |
| compact 后清理 | `services/compact/postCompactCleanup.ts` | — |

---

## 8. 可以借鉴到自建 Agent 的四条最小规则

1. **把 system prompt 拆成"静态段 + 动态段"两个 TextBlock**，仅给静态段挂 `cache_control: { type: 'ephemeral', ttl: '1h' }`。
2. **tools 数组的最后一个工具**挂一个 `cache_control`，让整段 tools 跟在 system 静态段之后形成可缓存前缀。
3. **每次请求只在 `messages[-1]` 的最后一个 content block 上打一个 `cache_control`**；旧消息保持原样，不要修改字节。
4. **每次请求后打印 `cache_read_input_tokens / cache_creation_input_tokens`**；若 cache_read 连续两次为 0 或骤降，立即比对本次 vs 上次 request 的 `json.dumps(system)` / `json.dumps(tools)` 差异，就能定位到具体哪个字段漂了。

---

## 9. 如何验证本文档对应的实现行为

- 阅读 `services/api/claude.ts:3063-3106` 确认 markerIndex 逻辑。
- 阅读 `utils/api.ts:321-435` 确认三种切分模式。
- 运行 Claude Code 并开启 `--debug`，观察 `[PROMPT CACHE BREAK]` 日志与 `cache-break-*.diff` 产物。
- 用 `tengu_api_success` 事件里的 `cache_read_input_tokens / cache_creation_input_tokens` 验证稳态下 read/create 比。
