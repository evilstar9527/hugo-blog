---
title: "Tipsy Studio Game Plan Mode 最终设计文档"
date: 2026-04-21
draft: false
categories: ["notes"]
---

## 1. 文档目的

本文档定义 Tipsy Studio 中 `Game Plan Mode` 的最终产品形态、数据模型、文档格式、交互流程、Operator 表达方式、Build 交接机制以及实现边界。

本文档的目标是让实现者在不再额外做产品决策的前提下，直接完成：

- `Game Plan Mode` 的前后端落地
- `Game PRD Markdown` 的生成、保存、审批和传递
- `Build Mode` 基于 `Game PRD Markdown` 的稳定接手
- 游戏特有的角色、事件、状态变量和 operator 结构表达

本文档是最终版规范文档，不包含与历史方案的对比说明。

---

## 2. 核心定义

## 2.1 Game Plan Mode 是什么

`Game Plan Mode` 是一个用户侧的游戏规划模式，用来帮助用户明确：

- 要做什么类型的游戏
- 游戏的核心体验是什么
- 世界观和角色是什么
- 玩家如何互动
- 事件如何触发
- operator 如何承担游戏规则
- 首版范围做到哪里

它不是：

- 工程计划模式
- 技术设计模式
- agent task plan 模式
- 文件改动规划模式

它是：

> 一个将模糊创意逐步沉淀为 `Game PRD Markdown` 的产品规划模式。

## 2.2 Game PRD 是什么

`Game PRD` 是一份面向用户与系统都可读的游戏定义文档。

它的作用是：

- 帮用户确认“这就是我要做的游戏”
- 帮 `Build Mode` 确认“接下来应该做什么”

最终产物只保留一种正式格式：

- `Game PRD Markdown`

系统不再把这份游戏定义维护成正式的结构化 `prd_json`。

## 2.3 Build Mode 如何使用它

`Build Mode` 直接消费完整的 `Game PRD Markdown`。

也就是说：

- 用户阶段产出的是 Markdown
- 数据库存的是 Markdown
- 进入构建时传给模型的是 Markdown
- 运行时文档副本也是 Markdown

Markdown 是整个链路里的单一事实来源。

---

## 3. 产品目标

`Game Plan Mode` 的唯一目标是：

> 帮助用户从零到一明确“我要做一个什么样的游戏”，并产出一份完整、可批准、可供 `Build Mode` 直接消费的 `Game PRD Markdown`。

### 3.1 用户真正关心的问题

用户关心的是：

- 游戏题材
- 玩家体验
- 角色关系
- 剧情推进
- 玩法机制
- 结局设计
- 首版完成度

用户不关心的是：

- 技术选型
- 文件结构
- 前后端拆分
- 代码实现步骤
- agent 内部任务列表

因此 `Game Plan Mode` 必须始终聚焦于“游戏定义”，而不是“工程设计”。

### 3.2 明确不负责的事情

`Game Plan Mode` 不负责：

- 写代码
- 技术设计
- 文件规划
- 构建预览
- 修 bug
- 执行资源创建
- 发布

这些都属于 `Build Mode` 的职责。

---

## 4. 用户视角的模式关系

项目页顶部模式切换固定为：

- `Game Plan`
- `Build`

用户理解应当是：

- `Game Plan`：先把游戏想清楚
- `Build`：开始做这个游戏

### 4.1 默认进入逻辑

#### 新项目
- 默认进入 `Game Plan`

#### 已批准 Game Plan 的项目
- 默认进入 `Build`

#### 历史项目且无 Game Plan
- 默认进入 `Build`
- 允许用户手动进入 `Game Plan`

### 4.2 首页输入框语义

首页输入框的语义调整为：

- 游戏想法
- 一句话创意
- 灵感草稿

首页输入进入项目后，保存为：

- `source_prompt`

这段内容只作为 `Game Plan` 的首轮上下文，不再直接触发 `Build`。

---

## 5. 数据模型

## 5.1 正式存储表

新增表：

- `project_game_plans`

建议字段如下：

- `id UUID PRIMARY KEY`
- `project_id BIGINT NOT NULL UNIQUE`
- `status VARCHAR(32) NOT NULL`
- `current_stage VARCHAR(32) NOT NULL`
- `source_prompt TEXT NOT NULL DEFAULT ''`
- `markdown_content TEXT NOT NULL DEFAULT ''`
- `open_questions_json JSONB NOT NULL DEFAULT '[]'::jsonb`
- `approved_at TIMESTAMPTZ NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`

### 5.1.1 字段语义

- `project_id`
  - 关联项目

- `status`
  - 当前 Game Plan 状态

- `current_stage`
  - 当前所处阶段

- `source_prompt`
  - 首页输入或最初的游戏灵感

- `markdown_content`
  - 正式版本的 `Game PRD Markdown`
  - 数据库中的主存储

- `open_questions_json`
  - 尚未明确的问题列表
  - 只用于流程控制，不是 PRD 本体

- `approved_at`
  - 用户批准 Game Plan 的时间

### 5.1.2 枚举

`status`：

- `not_started`
- `in_progress`
- `approved`

`current_stage`：

- `positioning`
- `content`
- `gameplay`
- `presentation`

### 5.1.3 约束

- `UNIQUE(project_id)`
- `CHECK(status IN ('not_started', 'in_progress', 'approved'))`
- `CHECK(current_stage IN ('positioning', 'content', 'gameplay', 'presentation'))`

## 5.2 不保留 prd_json

系统不再保留正式的结构化 `prd_json`。

不保留的原因：

- 你已经明确只需要 Markdown
- 最终交给大模型消费的也是 Markdown
- 双存会带来同步复杂度和维护成本
- 角色、operator、事件系统完全可以通过强模板 Markdown 稳定表达

因此：

- 正式内容只存在于 `markdown_content`
- `open_questions_json` 只是辅助流程字段

---

## 6. Markdown 主存储与运行时副本

## 6.1 主存储

数据库表中的：

- `markdown_content`

是正式主存储。

这意味着：

- 用户看到的 Game PRD 来源于它
- `approve` 校验的是它
- `Build` 交接时读取的是它

## 6.2 运行时副本

在 `Start Building` 时，将同一份 Markdown materialize 成一份项目文档：

- `.tipsy/docs/game-prd.md`

### 6.2.1 为什么这样设计

这样做可以复用现有能力：

- 文档树
- DocTag
- markdown 渲染
- 让后续 agent 在 sandbox 内读取 PRD

### 6.2.2 设计原则

原则必须明确：

- 数据库存储是主版本
- `.tipsy/docs/game-prd.md` 是运行时副本

也就是说：

- 更新 Game Plan 时，先更新数据库
- 进入 Build 时，再生成或覆盖 `.tipsy/docs/game-prd.md`
- 运行时副本不反向成为主存储

### 6.2.3 运行时副本的职责

`.tipsy/docs/game-prd.md` 的作用是：

- 为 agent 提供稳定上下文
- 允许通过现有 docs 能力被引用
- 允许被用户在文档树中阅读
- 作为 Build 运行时的可见文档

它不是审批来源，也不是正式编辑主数据源。

---

## 7. Game PRD Markdown 模板

Markdown 必须使用强模板，不能是自由散文。

原因：

- 需要被大模型稳定消费
- 需要承载 operator 与事件系统
- 需要在多轮更新后保持结构稳定

## 7.1 一级标题固定顺序

文档必须始终包含以下一级标题，顺序固定：

1. `# Game Overview`
2. `# Product Positioning`
3. `# World and Story`
4. `# Character Setup`
5. `# Gameplay Structure`
6. `# Operators and Event System`
7. `# Presentation Style`
8. `# MVP Scope`
9. `# Open Questions`
10. `# System Defaults and Recommendations`

即使部分内容为空，也必须保留标题。

## 7.2 章节结构定义

### `# Game Overview`

必须包含：

- `## One-line Pitch`
- `## Current Status`

### `# Product Positioning`

必须包含：

- `## Genre`
- `## Subgenre`
- `## Target Audience`
- `## Core Fantasy`
- `## Emotional Tone`
- `## References`

### `# World and Story`

必须包含：

- `## World Setting`
- `## Premise`
- `## Opening Hook`
- `## Main Conflict`
- `## Player Goal`

### `# Character Setup`

必须包含：

- `## Player Role`
- `## Protagonist`
- `## Love Interests`
- `## Supporting Characters`

### `# Gameplay Structure`

必须包含：

- `## Interaction Model`
- `## Chapter Structure`
- `## Branching Model`
- `## Ending Design`
- `## State Variables`

### `# Operators and Event System`

必须包含：

- `## Key Event Flow`
- `## Character-bound Events`
- `## Operator List`
- `## Trigger Conditions`
- `## Effects and State Changes`

### `# Presentation Style`

必须包含：

- `## Visual Direction`
- `## UI Style`
- `## Writing Style`
- `## Asset Requirements`
- `## Recommended Template`

### `# MVP Scope`

必须包含：

- `## MVP Definition`
- `## Phase 2 Ideas`
- `## Out of Scope`

### `# Open Questions`

必须包含：

- 尚未明确的问题列表

若当前没有未决问题，也必须写：

- `- None`

### `# System Defaults and Recommendations`

必须包含：

- 系统帮用户补上的默认值
- 推荐模板
- 推荐首版边界

这个章节用于承载之前可能会落在 JSON 中的默认值信息。

---

## 8. Markdown 内部写法规范

为了让 `Build Mode` 稳定解析，文档中与机制相关的对象必须使用统一写法。

## 8.1 标识符规范

所有后续需要被 Build 引用的对象都必须有稳定 key。

推荐格式：

- 角色：`li_1`, `side_1`
- 事件：`event_ch1_meet_li_1`
- operator：`op_li_1_confession_gate`
- 变量：`affection.li_1`

允许字符：

- 小写字母
- 数字
- `_`
- `.`

## 8.2 角色条目写法

角色条目统一使用以下格式：

```md
- `li_1` 沈知远
  - Identity: 集团继承人
  - Personality: 克制、审慎、控制欲强
  - Relationship Tension: 一边警告主角远离，一边不断为她开路
  - Event Roles: first_meet_target / route_owner / confession_target
  - Bound Operators: op_li_1_first_impression / op_li_1_confession_gate
```

要求：

- 每个攻略对象至少有一个稳定 key
- 如果该角色参与事件或 operator，必须写出绑定关系

## 8.3 章节条目写法

```md
- 第 1 章：危险的入职日
  - Goal: 建立世界观并完成与男主1初遇
  - Required Events: event_ch1_meet_li_1
  - Possible End States: affection.li_1 >= 1
```

## 8.4 状态变量写法

```md
- `affection.li_1`
  - Type: integer
  - Scope: character
  - Initial Value: 0
  - Visible to Player: No
  - Purpose: 决定男主1路线推进与结局
```

## 8.5 事件写法

```md
- `event_ch1_meet_li_1` 与男主1初遇
  - Chapter: 1
  - Participants: protagonist / li_1
  - Preconditions: None
  - Player Input: dialog_choice
  - Effects: affection.li_1 + 1；unlock.scene.archive_room
  - Next Events: event_ch2_archive_room
```

## 8.6 Operator 写法

```md
- `op_li_1_confession_gate` 男主1告白触发规则
  - Type: event_trigger
  - Bound Characters: li_1
  - Watched Variables: affection.li_1 / flag.archive_clue_found
  - Trigger Conditions: affection.li_1 >= 60 且 flag.archive_clue_found == true
  - Effects: enqueue_event:event_li_1_confession；set route.li_1.locked_in = true
  - Notes: 首版只做一次性触发
```

### Operator 类型建议

首版推荐支持以下类型：

- `event_trigger`
- `branch_gate`
- `state_transition`
- `ending_gate`
- `cooldown_rule`

---

## 9. Game Plan 的交互流程

整体固定分为 4 个阶段：

1. `positioning`
2. `content`
3. `gameplay`
4. `presentation`

每轮交互原则：

- 一次只问 1 到 2 个问题
- 每个问题都提供推荐选项
- 用户可以自由补充
- 用户可以选择“先用推荐值”
- 每阶段完成时，系统更新整份 Markdown 文档

## 9.1 Stage 1: 游戏定位

目标：

- 明确类型
- 明确目标用户
- 明确核心幻想
- 明确情绪基调
- 形成一句话概述

推荐问题：

1. 你想做哪类游戏？
2. 最想让玩家体验到什么感觉？
3. 主要是给谁玩的？
4. 如果只用一句话介绍，它是什么？

推荐选项：

- 类型：
  - 恋爱互动小说
  - 视觉小说
  - 聊天叙事游戏
  - 轻养成剧情游戏

- 情绪基调：
  - 甜宠治愈
  - 拉扯暧昧
  - 狗血上头
  - 悬疑压迫
  - 温柔陪伴

默认建议：

- 类型默认：恋爱互动小说
- 情绪默认：甜宠治愈

## 9.2 Stage 2: 内容设定

目标：

- 明确世界观
- 明确主角
- 明确攻略对象
- 明确开场
- 明确主冲突

推荐问题：

1. 故事发生在什么世界？
2. 玩家扮演谁？
3. 开场最抓人的一幕是什么？
4. 主角最想达成什么？
5. 有几个攻略对象？
6. 每个攻略对象一句话人设是什么？

推荐选项：

- 世界观：
  - 现代都市
  - 校园
  - 古风架空
  - 西方奇幻
  - 末世幻想

- 玩家身份：
  - 女主本人
  - 可自定义姓名的主角
  - 外来者 / 穿越者 / 转学生

默认建议：

- 攻略对象默认数量：2

## 9.3 Stage 3: 玩法结构

这是最关键的阶段，因为它决定游戏不是单纯的文案，而是可运行的机制设计。

目标：

- 明确玩家如何推进剧情
- 明确章节结构
- 明确状态变量
- 明确关键事件流
- 明确 operator 骨架
- 明确结局判定

推荐问题：

1. 玩家主要通过什么方式影响剧情？
2. 首版准备做几章？
3. 每章最重要的一件事是什么？
4. 哪些关键事件必须发生？
5. 是否有角色专属事件？
6. 这些事件在什么条件下触发？
7. 游戏里有哪些关键状态变量？
8. 哪些变量决定路线推进或结局？
9. 会有哪些结局？
10. 结局怎么判定？

推荐选项：

- 互动方式：
  - 对话选项
  - 场景选择
  - 送礼互动
  - 轻数值推进

- 触发方式：
  - 好感度达到阈值
  - 关键选项触发
  - 前置事件完成
  - 日期 / 章节推进
  - 多条件组合

- 变量类型：
  - 好感度
  - 信任值
  - 怀疑值
  - 是否获得关键线索
  - 是否进入某路线

默认建议：

- 每个攻略对象至少 1 个角色专属关键事件
- 每条路线至少 1 个 `branch_gate`
- 每个结局至少 1 个 `ending_gate`

## 9.4 Stage 4: 表现与交付

目标：

- 明确视觉方向
- 明确 UI 风格
- 明确文风
- 明确资源需求
- 明确 MVP 范围

推荐问题：

1. 你希望整体看起来是什么风格？
2. 文案更像小说、剧本还是聊天？
3. 首版必须有哪些资源？
4. 哪些内容做到就算首版完成？
5. 有哪些内容明确不要进首版？

推荐选项：

- 视觉方向：
  - 女性向韩漫感
  - 轻古风
  - 清新校园
  - 暗色悬疑

- UI 风格：
  - 立绘对话式
  - 聊天叙事式
  - 单场景视觉小说式

- 文案风格：
  - 第一人称沉浸
  - 第三人称叙事
  - 对话驱动

默认建议：

- 推荐模板：角色立绘对话模板
- 默认 MVP：完成 1 条主线 + 至少 2 个结局

---

## 10. Operator 与事件系统的产品定位

Tipsy Studio 的游戏不是静态剧情文档，而是显著带有：

- 规则触发
- 状态变化
- 角色绑定事件
- 分支判定
- 结局 gate

因此 `Operator 与事件系统` 不是技术附录，而是 `Game PRD` 的核心章节。

### 10.1 为什么必须写进 Game PRD

如果文档里只有：

- 角色设定
- 世界观
- 剧情概述

但没有：

- 哪些事件会发生
- 事件何时触发
- 哪些状态变量参与判定
- 哪些角色绑定哪些规则

那么 Build 会出现以下问题：

1. 角色只有资料卡，没有机制职责
2. 事件链无法稳定生成
3. operator 会被 Build 临时猜测
4. 路线和结局条件容易跑偏

所以本产品的明确要求是：

> 在 Game Plan 阶段就把 operator 作为游戏机制对象定义出来。

### 10.2 首版范围建议

为了控制复杂度，首版范围建议：

- 每个攻略对象最多 2 到 3 个关键 operator
- operator 以 `event_trigger / branch_gate / ending_gate` 为主
- 触发条件先用自然语言或半结构化短句表达
- 不要求用户写 DSL

---

## 11. 长文本粘贴与自动整理

用户很可能已经在别处写过：

- 角色设定
- 世界观草稿
- 剧情摘要
- 玩法想法

系统必须支持大段文本直接输入。

处理原则：

1. 系统先理解用户文本
2. 按固定 Markdown 模板整理
3. 生成当前版本 `Game PRD Markdown`
4. 把缺失内容写入 `# 未决问题`

优先映射关系：

- 世界观相关 -> `# World and Story`
- 角色相关 -> `# Character Setup`
- 玩法与事件相关 -> `# Gameplay Structure` 与 `# Operators and Event System`
- 风格与资源相关 -> `# Presentation Style`

---

## 12. 运行约束

`Game Plan Mode` 采用强提示约束。

每轮系统提醒必须明确：

1. 当前处于 `Game Plan Mode`
2. 当前目标是完成 `Game PRD Markdown`
3. 当前不是工程设计阶段
4. 不要开始构建
5. 不要输出技术任务拆解
6. 当前回合只允许：
   - 提问
   - 整理文档
   - 汇总阶段结果
   - 引导批准 Game Plan

模型在 `Game Plan` 中不应输出：

- 文件修改计划
- 技术选型说明
- 代码实现清单
- tool 执行路径

---

## 13. Approve 与 Build 交接

## 13.1 Approve Game Plan

按钮名称：

- `Approve Game Plan`

执行后：

- `status = approved`
- `approved_at = now()`

含义：

> 用户确认这份 Markdown 已经足够作为首版 Build 的正式输入。

## 13.2 批准前的完整度校验

进入 `approved` 前，Markdown 至少必须满足以下条件：

- 存在一级标题：
  - `# Product Positioning`
  - `# World and Story`
  - `# Character Setup`
  - `# Gameplay Structure`
  - `# Operators and Event System`
  - `# Presentation Style`
  - `# MVP Scope`
- `# Character Setup` 中至少有 1 个攻略对象
- `# Gameplay Structure` 中至少包含：
  - 互动方式
  - 章节结构
  - 结局设计
  - 状态变量
- `# Operators and Event System` 中至少包含：
  - 1 个事件
  - 1 个状态变量引用
  - 1 个 operator
- `# MVP Scope` 中 `MVP Definition` 非空

## 13.3 Start Building

按钮名称：

- `Start Building`

保留两种策略：

- `continue_context`
- `restart_from_prd`

默认推荐：

- `restart_from_prd`

原因：

- 避免 planning 对话噪音污染 Build
- 保证 Build 的输入单一且稳定

## 13.4 Build kickoff 输入

Build kickoff 采用固定模板：

```text
Build the first playable version of the game based on the following Game PRD markdown.
Treat this markdown as the source of truth.

[完整 Game PRD Markdown]
```

同时增加硬约束：

- Follow the Game PRD as the source of truth.
- Prioritize MVP scope only.
- Do not introduce anything listed under out-of-scope.
- Preserve the intended operators, event flow, and state-variable relationships.

## 13.5 Build 强制消费规则

Build 必须把以下章节视为强制输入：

- `# Character Setup`
- `# Gameplay Structure`
- `# Operators and Event System`
- `# Presentation Style`
- `# MVP Scope`

Build 不允许：

- 忽略 operator 章节
- 把 operator 仅当作文案说明
- 擅自删除角色绑定事件
- 擅自扩大 MVP 范围
- 把 `明确不做` 中的内容偷偷加进首版

---

## 14. API 设计

## 14.1 项目接口

`GET /projects/{id}` 返回新增字段：

- `game_plan_status`
- `game_plan_stage`
- `has_approved_game_plan`

## 14.2 Game Plan 接口

- `GET /projects/{id}/game-plan`
  - 返回：
    - `status`
    - `current_stage`
    - `source_prompt`
    - `markdown_content`
    - `open_questions`

- `PUT /projects/{id}/game-plan`
  - 用于保存当前 Markdown 和流程状态

- `POST /projects/{id}/game-plan/approve`

- `POST /projects/{id}/game-plan/start-build`
  - 返回 build kickoff message
  - 同时可触发生成 `.tipsy/docs/game-prd.md`

## 14.3 Chat 接口

`POST /projects/{id}/chat`

新增：

- `mode: "game_plan" | "build"`

说明：

- `scenario` 继续只用于模型选择
- `mode` 决定当前处于游戏规划还是构建

---

## 15. 前端类型

建议新增：

- `GamePlanStatus = "not_started" | "in_progress" | "approved"`
- `GamePlanStage = "positioning" | "content" | "gameplay" | "presentation"`
- `GamePlanDocument`
  - `markdownContent: string`
  - `openQuestions: string[]`

不再需要：

- `GamePrd`
- 任意 `prd_json` 类型

---

## 16. 验收标准

## 16.1 产品验收

- 新项目默认进入 `Game Plan`
- 首页输入进入项目后成为 `source_prompt`
- 用户在 `Game Plan` 中不会看到工程任务拆解
- 用户最终得到一份完整的 `Game PRD Markdown`

## 16.2 数据验收

- `project_game_plans.markdown_content` 正常读写
- `.tipsy/docs/game-prd.md` 可在 Start Building 时生成
- 数据库主存储与运行时副本职责清晰
- 不再生成或维护 `prd_json`

## 16.3 Build 交接验收

- `Approve Game Plan` 前会检查 Markdown 完整度
- `Start Building` 会把完整 Markdown 作为 Build 主输入
- Build 不会忽略 `Operator 与事件系统`
- Build 不会越过 `MVP 范围`
- Build 不会引入 `明确不做` 的内容

## 16.4 Operator 特性验收

- 角色条目中可表达绑定事件和绑定规则
- 文档中可稳定表达：
  - 关键事件
  - 状态变量
  - operator
- Build 不会丢失角色与 operator 的绑定关系

---

## 17. V1 明确不做的事情

V1 不包含：

- 自动生成首个可玩版本
- PRD 历史版本管理
- 多份 Game Plan 对比
- 复杂 DSL 编辑器
- 把 Markdown 再反向同步成正式 JSON 结构
- 协作审批流

---

## 18. 一句话总结

`Game Plan Mode` 的正式产物，不是工程计划，也不是结构化 JSON，而是一份强模板、半结构化、可直接传给大模型的 `Game PRD Markdown`。  
数据库中的 `markdown_content` 是正式主存储；`.tipsy/docs/game-prd.md` 是进入 Build 时生成的运行时副本。  
`Build Mode` 必须将这份 Markdown 视为唯一事实来源，并据此创建角色、世界观、事件流、状态变量、operator 以及首版游戏体验。
