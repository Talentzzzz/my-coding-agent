# 0006：五个单例服务不持有实例状态——聚合袋拆除，「薄壳门面」条款重开

日期：2026-11-01 · 状态：已接受（pure-services 01 号票拍板，02–08 号票落地）
取代：[0005](0005-stateless-session-architecture.md)（部分——仅其落地序列中票
08/09/16 有意保留的「薄壳门面」条款，其余决定不变）
取代者：[0013](0013-table-holds-live-half-only.md)（部分，2026-11-04 起经会话状态表一线演变、
2026-11-10 定型——决定 3 的 Manager 键控缓存整条删除，冷读改为每次 fill 一份、用完即弃；
决定 4 的活登记处改为 `Agent` 的 `Map<id, AgentState>`、只装 live 半。其余
决定不变）
取代者：[0011](0011-tool-manager-instance-table.md)（部分，2026-11-06——决定 1、
决定 2 的「无状态服务」那半、决定 6 的「不可变」前提，三处都只在**工具域**不再
成立；会话域的同一批决定不变）
取代者：[0012](0012-agent-facade.md)（部分，2026-11-07——决定 6 的**消费面**：进程级
构造注入本身不变，被取代的是「这组进程级东西由 hub 装配、在 hub 手里协调」的旧
叙述——三只 Manager 的构造收进 `createSessionAgent()`、唯一消费者是 core 的编排层，
hub 只认编排层公开面；其余决定不变）

设计过程见 `.scratch/pure-services/`（形状在 2026-11-01 的设计对话敲定，本
ADR 只记合拢后的契约）。

## 背景

ADR-0005 把会话架构改为无状态服务与每请求重放，但其落地（票 08/09/16）有意
留下两处壳：`SessionManager` 与 `SettingsManager` 收成「一行委托的薄壳门面」，
私有状态袋（`private s` 一类的 per-session 字段）原样住在类里，调用方零改动、
留给后续票迁移；`Agent` 也仍持有 `AgentConfig` 混合袋、订阅集合与运行槽等
实例属性。

当初这么定的理由：门面让无状态化可以分两刀走——先落首参收状态的文件级函数
族、调用方后迁，避免一次改动横跨 core 与 server 的全部调用点；私有字段让
TypeScript 的 `private` 继续守账本不变式。

重开的动因：与 0005 拆掉的有状态类同构的问题换了规模回来。**聚合袋**（一个
大对象被各 Manager 互相「补充」）让字段的生命周期与属主脱钩——谁都可以往里
塞，没有人对它的失效负责；门面的私有字段则把「这个方法摸了哪些状态」重新藏
进 `this`，签名上看不见，正是 0005 背景一节批评过的形态。

## 决定

1. **无聚合袋**。五个单例（`Agent` 编排、`SessionManager`、`SettingsManager`、
   `ModelManager`、`ToolManager`）公开方法收 `(id, 请求自己的参数)`——会话域的
   Manager 收 `sessionId`，`SettingsManager` 收工作区键；方法体里每样数据在
   **用到它的那一行**向属主 Manager 现取，拿到的只是局部变量、作为参数传给
   下一步。内部辅助方法收显式参数，不收 id、不收袋。没有聚合类型，Manager
   之间从不互相「补充」一个共享对象。

   **（2026-11-06 Superseded，[0011](0011-tool-manager-instance-table.md)：仅工具域那一项——`ToolManager`
   持一张常驻实例表；「不养聚合袋」这半原样有效。）**
2. **类壳保留**。Manager 是 Spring 式无状态服务：构造只收服务依赖，可构造
   注入；可测性靠传内存袋单测。被拆除的只是 `private s` 一类的 per-session
   实例字段——类不是被删除的函数命名空间。

   **（2026-11-06 Superseded，[0011](0011-tool-manager-instance-table.md)：仅工具域的「无状态」这半
   ——`ToolManager` 的状态就是那张表；「类壳保留、构造注入、可测性靠传内存袋单测」原样有效。）**
3. **Manager 内部键控缓存**。fill-at-open、按 id / 工作区键控、随时可从磁盘
   重建、**藏在自己内部、不被传递**——承接 0005 §3 的缓存规则与前作票 16 的
   裁决（每请求全文重放被否决）。缓存不离开属主正是它与聚合袋的分界：袋子
   会被传来传去，缓存不会。
   **（2026-11-04 Superseded：会话域两个 Manager 的键控缓存
   整条删除，冷读改为每次 fill 一份、用完即弃——live 半的存放见 [0013](0013-table-holds-live-half-only.md)。）**
4. **活的一半例外**。队列、activeRun、订阅集合不能从磁盘现建，居一个按 id
   键控的**窄**登记处，只装「进行中且磁盘上没有」的东西。登记处的归属与命名
   在 03 号票定（候选 `OpenSession`），本 ADR 留指针；`SessionRuntime` 的既有
   窄定义不动——登记处**装着**它，不替换它。不变量不变：进程重启丢弃全部
   条目，重开即重建。
   **（2026-11-04 Superseded：登记处搬进 `Agent` 的
   `Map<id, AgentState>`，判据重写为「装丢了就没了的那一份」；现行为「表只装 live 半」，
   见 [0013](0013-table-holds-live-half-only.md)。）**
5. **modelState 消失**。模型选择随消息到达（`ModelSelection`），没带就从账本
   派生 + `fillModel` 现算——不再有驻留内存的 per-session 模型状态。
6. **进程级不可变配置留作构造注入**。hooks、transport（含 retry 策略）、
   systemPrompt 构建函数不是会话状态，是进程生命周期内不可变的配置，留在
   构造函数上，不参与本 ADR 的拆除。

   **（2026-11-06 Superseded，[0011](0011-tool-manager-instance-table.md)：仅工具域的「不可变」前提
   ——工具表也留在构造注入上，但它可单调增长（`register()` 只增键）；hooks / transport / systemPrompt
   三件本身一字不动。）**

   **（2026-11-07 Superseded，[0012](0012-agent-facade.md)：仅消费面——这组进程级配置仍留在
   构造注入上，但由 `createSessionAgent()` 造好三只 Manager 再递进编排层，编排层是它们在本进程的
   唯一消费者；「hub 装配并协调这组服务」的旧叙述不再成立，hub 只认编排层公开面。）**

## 后果

换来的：

- 状态边界重新回到签名上：每个方法摸了哪些数据在参数表可见——0005 对有状态
  类的批评一致地延伸到实例属性。
- 字段生命周期与属主绑定：缓存失效只由属主 Manager 决定，没有第二个写入者。
- 五个单例全部可构造注入，逻辑可用内存袋单测，不需要先起一个真实会话。

背上的：

- 方法签名变长：每样数据显式传参，代替一次 `this.` 的隐式取用。
- 调用点全量迁移：core 内部与 smokes 里所有持有实例、读属性的调用点都要改
  （02–07 号票），REST 面与 mux 帧则一字不改。
- 活登记处是新增的一个名字，它的归属与命名还有一票（03）要落。

## 不可逆性与代价

回退意味着恢复 `private s`、`AgentConfig` 混合袋与实例上的订阅集合 / 运行槽，
且所有已迁到显式传参的调用点要再改回去——不止一处。难以逆转成立。

## 被取代的是什么

- 票 08/09/16 的「薄壳门面」裁决（0005 落地序列的组成部分，非 0005 原文）：
  `SessionManager` / `SettingsManager` 保留私有状态袋、一行委托的类形态——
  本 ADR 重开这一条；类壳保留，per-session 实例字段全部拆除。0005 的其余
  决定（五单例星形依赖、种子→补齐、fill-at-open 可重建缓存、结束重启审批、
  `tool_result_view`）不变，其中缓存规则被本 ADR 第 3 条承接。
- `Agent` 仍持有的 `AgentConfig` 混合袋与实例属性（订阅集合、运行槽）：
  装配产物不再是 `AgentConfig`，而是登记处条目 + 各 Manager 缓存就位
  （03 号票）。

## 没有被取代的

明确不动、读者不该跟着本 ADR 一起重开的：

- [0005](0005-stateless-session-architecture.md) 的其余全部：五单例星形依赖、
  状态是纯数据接口、种子→补齐生命周期、账本 fill-at-open 唯一写者、
  `SessionRuntime` 窄定义、结束重启审批。
- [0001](0001-transport-websocket-mux.md)：REST 命令面 + 常驻 WebSocket mux、
  有界写侧、claim 与订阅分离——本 effort 的适配不碰 wire。
- [0002](0002-queued-writes-at-drain.md)：排队消息在取走点落盘——队列只是
  搬进活登记处，语义不变。
- [0004](0004-modes-are-a-tool-config-choice.md)：模式是工具集与审批集的选择、
  座位按值匹配——`modeName` 仍只是补齐种子。
- compaction「文件永远保留全文、每步裁剪是一条 entry」；retry 装在模型的
  transport 上；subagent 是一对工具、无注册表无嵌套；密钥只在
  `<agent home>/models.json`、只骑在一次请求上。

## 修订（2026-11-01，票 08 收账后）

落地时留了一层没人要的壳：两个 Manager 的每个方法都是一行
`getLeafId(s) { return getLeafId(s); }`，真正的实现是同一文件里同名的文件级
函数。类当时是为了「调用方零改动」才这么写的（票 02/04 的原话），但它把
本 ADR 批评的那件事换了个方向又做了一遍——签名上看得见 `SessionState`，
可代码要读两份，改一处得改两处。

收掉的方式：**一层就够**。`SessionManager` 的 append / 读 / 分支方法
（`appendMessage`、`getBranchPoints`、`buildSessionContext`、`branch` …）
连实现带文档搬进类里，同名的文件级函数删除；`SessionManager` 只额外留一个
`newSession` 函数，因为它是两个构造器（`createSessionState` /
`inMemorySessionState`）的初始化步骤，类里没有调用者。

`SettingsManager` 走的是另一半：那 13 个方法**一个调用者都没有**（core 与
server 一直直接 import 同名函数），所以删的是方法，留下的是函数——把函数体搬
进类反而要让每个拿着 `SettingsState` 的模块先去找一个实例，而 `Agent` 手里
只有袋、没有服务。类因此只剩 `stateOf`，也就是它唯一拥有的东西：缓存。

随之而来的两处形状变化：

- `sessionSnapshot` / `sessionUsage`（`session/snapshot.ts`）与 `toolStateOf` /
  `followsGlobalOf`（`session/tool-config.ts`）改收一个 `SessionManager`，
  因为它们要读账本，而读账本的入口现在是方法。它们仍然不读盘、不写盘。
- `Agent` 的标量 getter（`modelName`、`thinkingLevel`、`thinkingLevels`、
  `activeTools`、`isLooping`、`isRetrying`、`retryAttempt`、`usage`、
  `sessionFile`）删除：`snapshot(id)` 里本来就有这些字段，留着就是同一份答案
  的第二出口。读取面因此只有 `snapshot` 一个入口。
- 纯粹的字段访问器（`getLeafId`、`getEntry`、`getAbsSessionFile`、
  `getSessionId`、`getLeafEntry`、`getEntryCount`、`isPersisted`、
  `getAbsCwd`、`getAbsSessionDir`、`usesDefaultSessionDir`）一并删除——它们
  包的就是一次字段读，调用点直接读 `SessionState` 的字段。

§2「类壳保留」不变：类还在、可构造注入、程序集里只有一份；变的只是壳里不再
是转发。
