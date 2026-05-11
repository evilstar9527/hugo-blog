# Tipsy Studio 中 Logfire 日志接入决策

本文记录当前 `tipsy-studio` 中关于 Logfire 日志接入的决策结论、背景、备选方案和取舍原因。目标不是设计一套理想化的日志体系，而是基于当前代码现状和真实排障方式，选择最合适的落地路径。

## 1. 背景与问题定义

当前项目已经接入了 Logfire，但接入深度有限：

- `apps/api/main.py` 中已经调用了 `logfire.configure(...)`
- `apps/api/main.py` 中已经调用了 `logfire.instrument_fastapi(app)`
- 少量业务点显式调用了 `logfire.info(...)`、`logfire.warning(...)`、`logfire.error(...)`

但目前 Logfire 中主要能看到的是：

- FastAPI 请求相关的 trace / API 调用信息
- 少量显式上报的业务事件

不足的地方在于：

- 大部分真实运行日志仍然来自 Python 标准库 `logging`
- 这些日志主要输出到 stdout
- 它们没有完整进入 Logfire

结果就是，当通过 Logfire 排查问题时，能看到请求入口，但看不到足够丰富的实际运行上下文，信息量有限，不利于还原完整链路。

## 2. 当前代码现状调研结论

以当前仓库代码为准，后端日志体系的现实基础是 Python 标准库 `logging`：

- `apps/api/main.py` 使用 `logging.config.dictConfig(...)` 配置日志
- 各模块普遍使用 `logging.getLogger(__name__)`
- 大量业务日志通过 `logger.info(...)`、`logger.warning(...)`、`logger.error(...)`、`logger.exception(...)` 输出

当前未看到已经落地的第二套日志框架：

- 未看到 `structlog` 的实际接入
- 未看到 `loguru` 的实际接入
- 未看到 OpenTelemetry Logging SDK 作为主日志框架落地

因此，当前项目的日志体系不是“多种方案待选”的空白状态，而是已经明确建立在标准 `logging` 之上。

## 3. 当前主要排障方式

当前排障方式并不是开发者手工盯着日志面板逐行阅读，而是更多通过 Codex / Claude 调用 MCP 去查 Logfire，再结合关键标识定位问题。

实际使用方式大致是：

- 先从用户、接口、报错现象或请求路径拿到线索
- 再通过 `trace_id`、`user_id`、`conversation_id`、`project_id`、`session_id` 等标识收缩范围
- 然后用文本日志 grep 整条链路

在这种工作流里，真正的核心诉求是：

- Logfire 里能看到完整的运行日志
- 关键日志中稳定包含用于检索的标识
- agent 能通过 MCP 把一条链路上的上下文尽量还原出来

这和“为了人类工程师手工浏览而设计一套高度结构化的日志查询系统”不是同一个问题。

## 4. 可选方案对比

### 4.1 方案 A：继续使用标准 `logging`，并接入 Logfire 官方 logging handler

这是当前最匹配项目现状的方案。

优点：

- 与现有代码完全兼容
- 改造成本最低
- 不需要批量重写日志调用
- 可以最快把当前大量业务日志送进 Logfire
- 不改变现有开发习惯

适用目标：

- 先解决“Logfire 中缺少完整运行日志”的核心问题
- 先让 agent 能查到真实业务运行日志，再决定是否需要进一步升级日志体系

这是当前推荐方案。

### 4.2 方案 B：引入 `structlog`

`structlog` 的优势主要在于结构化日志能力更强：

- 便于按固定字段过滤
- 更适合上下文绑定
- 更适合聚合分析、告警和面板
- 与 Logfire 也有官方集成方式

但它当前不适合作为第一步落地方案，原因是：

- 当前仓库并没有 `structlog` 基础设施
- 当前代码已经广泛使用标准 `logging`
- 迁移到 `structlog` 不是一次局部改造，而是日志体系升级
- 迁移成本和心智成本都不低

因此，`structlog` 更适合作为未来可能的演进方向，而不是当前阶段的首选方案。

### 4.3 方案 C：引入 `loguru`

`loguru` 也能和 Logfire 集成，但不适合当前项目：

- `loguru` 的特点是配置简单、开箱即用、默认体验比标准 `logging` 更友好
- 它通常更适合从零开始的新项目，或者原本已经在使用 `loguru` 的代码库
- 它在日志格式化、异常回溯展示、文件 rotation / retention 等方面体验较好
- 当前项目已经全面建立在标准 `logging` 之上
- 引入 `loguru` 会带来双体系复杂度
- 改造收益不足以覆盖迁移成本
- 对当前主要依赖 agent + MCP + `trace_id` / `user_id` / 文本 grep 的排障方式来说，`loguru` 并不会带来决定性收益
- 此外，Logfire 官方文档明确提到一个限制：`loguru` 格式化后的 message 当前不会被 Logfire 做敏感信息 scrub，这对业务日志是一个实际风险

因此不作为当前推荐路径。

### 4.4 方案 D：OpenTelemetry Logging / Collector

这类方案更偏平台化统一观测：

- 适合多服务、多语言、多后端统一采集
- 适合更大的平台层观测建设

但对当前 `tipsy-studio` 来说：

- 这不是解决当前问题的最短路径
- 作为应用内第一步日志接入方案过重
- 当前阶段属于过度设计

因此不作为当前落地方向。

## 5. 为什么当前不用 `structlog`

这次决策的关键，不是判断 `structlog` 好不好，而是判断它是否适合当前阶段。

结论是：当前阶段不适合优先引入 `structlog`。

主要原因如下。

### 5.1 当前目标是补全 Logfire 中的运行日志，不是重建日志体系

当前最突出的问题是：

- Logfire 中只有 API 调用和少量显式事件
- 缺少大量真实业务运行日志

这意味着当前最优先要做的是：

- 让现有日志进入 Logfire

而不是：

- 先把整个后端日志体系重写成另一套结构化方案

如果一开始就引入 `structlog`，会把“日志进入 Logfire”的问题扩大成“日志框架升级”问题，范围不必要地变大。

### 5.2 当前代码已经深度使用标准 `logging`

当前代码库中，日志调用已经形成稳定惯例：

- `logging.getLogger(__name__)`
- `logger.info(...)`
- `logger.warning(...)`
- `logger.error(...)`
- `logger.exception(...)`

这意味着标准 `logging` 不是一个“临时方案”，而是当前系统已经真实使用的日志基础设施。

如果引入 `structlog`，会带来至少以下改造成本：

- 日志初始化配置改造
- 日志上下文绑定策略设计
- 与现有 logger 调用混用的兼容策略
- 新旧日志风格并存的维护问题
- FastAPI / async 场景下上下文传递的一致性问题

这些成本对于当前问题并不划算。

### 5.3 当前排障工作流里，文本日志已经能覆盖大多数需求

当前主要排障方式是：

- 通过 Codex / Claude + MCP 查询 Logfire
- 再用 `trace_id`、`user_id`、`conversation_id` 等关键标识定位链路
- 然后用文本日志回看上下文

在这种模式下，只要满足两个条件，文本日志就已经足够好用：

- 日志能完整进入 Logfire
- 关键日志里稳定包含检索标识

对于大多数单次请求、单用户问题、某条链路错误来说，这已经可以覆盖主要需求。

### 5.4 `structlog` 的优势当前不是主矛盾

`structlog` 真正有价值的场景包括：

- 跨大量请求做聚合分析
- 高度依赖固定字段过滤
- 自动化告警和面板统计
- 需要更严格的上下文绑定和结构化检索

这些能力确实有价值，但当前阶段并不是最主要矛盾。

当前最主要的矛盾仍然是：

- 大量运行日志没有进入 Logfire

在这个问题没解决前，先迁移到 `structlog` 并不会带来最直接的收益。

### 5.5 当前不选 `structlog`，不代表以后永远不用

本次结论是阶段性决策：

- 当前不把 `structlog` 作为第一步
- 未来如果排障模式变了，或者开始大量做聚合分析、告警、按字段统计，再重新评估是否引入结构化日志框架

因此，这不是否定 `structlog`，而是明确它在当前阶段不是最优解。

## 6. 为什么当前继续用 `logging`

当前继续使用标准 `logging`，是一个正向选择，而不是保守拖延。

原因如下：

- 它与当前代码库完全一致
- 当前所有主要模块已经在使用它
- 它可以用最小改动直接接到 Logfire
- 它可以最快让现有大量业务日志进入 Logfire
- 对当前基于 agent + MCP 的排障方式已经足够有效
- 后续仍然可以在保留 `logging` 的前提下，局部补更稳定的事件字段和结构化信息

换句话说，当前继续用 `logging` 的核心价值是：

- 最小成本解决当前最核心的问题

## 7. 对“文本 grep 是否已经够用”的判断

当前阶段，这个判断基本成立。

多数问题排查时，真正需要的是：

- 从某个错误现象拿到 `trace_id`
- 从某个用户拿到 `user_id`
- 从某次会话拿到 `conversation_id` / `session_id`
- 再顺着这些标识把整条链路日志拉出来

对于这类问题，文本 grep 的可用性通常已经足够，尤其是在：

- 问题主要集中在单次请求或单个用户
- 日志量还没有大到检索成本失控
- 核心目标是还原链路，而不是做统计分析

因此，当前不把“全面结构化日志”作为前置条件。

但这个结论也有边界。如果未来出现下面这些需求，就应重新评估结构化日志：

- 经常需要跨很多请求做聚合分析
- 经常需要按固定字段做统计和筛选
- 需要自动化告警和仪表盘
- agent 查询越来越依赖稳定字段，而不是文本模式匹配

## 8. 最终决策

当前阶段的明确决策如下：

- 保留 Python 标准库 `logging`
- 不引入 `structlog`
- 先将现有标准 `logging` 全量接入 Logfire
- 先解决 Logfire 中缺少实际运行日志的问题

后续增强方向如下：

- 保持 stdout 输出不变
- 同时把日志送进 Logfire
- 对关键链路日志尽量稳定包含 `trace_id`、`user_id`、`project_id`、`session_id`、`sandbox_id` 等检索标识
- 暂不进行全量结构化日志迁移

这是当前阶段的实施基线。

## 9. 后续实施建议

后续实际接入时，应遵循下面原则：

- 保持现有 `logging` 体系，不做大迁移
- 同时保留 stdout 输出和 Logfire 上报
- 优先确保异常、warning、关键 lifecycle 日志进入 Logfire
- 不要求全量日志立即结构化
- 只要求关键日志中持续保留稳定的检索标识

建议优先保证以下链路的日志在 Logfire 中完整可见：

- chat 请求主链路
- sandbox create / wake / sleep / recover
- workspace version publish / restore
- SDK character chat 相关链路
- 关键异常和 fallback 路径

如果后续发现 agent 查询经常受限，再考虑局部补充更强的结构化事件，而不是直接全量迁移日志框架。

## 10. 参考依据

- 项目当前代码现状调研
  - `apps/api/main.py`
  - `apps/api/observability.py`
  - `apps/api` 中大量 `logging.getLogger(__name__)` 使用

- Logfire 官方 logging 集成文档
  - 用于确认标准 `logging` 是 Logfire 的官方支持路径
  - https://pydantic.dev/docs/logfire/integrations/logging/logging/

- Logfire 官方 structlog 集成文档
  - 用于确认 `structlog` 也是官方支持路线，但更适合作为结构化升级方案
  - https://pydantic.dev/docs/logfire/integrations/logging/structlog/

- OpenTelemetry Python 文档
  - 用于评估 OTel logs 在当前阶段不适合作为第一步应用内方案
  - https://opentelemetry.io/docs/languages/python/

## 11. 一句话结论

当前 `tipsy-studio` 的最优路径不是先上 `structlog`，而是先把现有标准 `logging` 完整接入 Logfire；在当前基于 agent + MCP + trace/user id + 文本 grep 的排障方式下，这已经足够解决主要问题。
