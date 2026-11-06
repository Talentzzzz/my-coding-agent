# 0006：会话架构改为无状态服务与每请求重放，审批改为结束重启

日期：2026-10-31 · 状态：已接受（stateless-agent 01–06 号票拍板，08–16 号票落地）
取代者：[0007](0007-services-drop-instance-state.md)（部分，2026-11-01——仅重开落地序列中票 08/09/16 的「薄壳门面」条款，其余决定不变）
取代者：[0016](0016-tool-manager-instance-table.md)（部分，2026-11-06——决定 1 里 `ToolManager` 那一项，以及决定 3 的 B 路线里「工具不驻留内存」那一半；账本一域与其余决定不变）

设计过程见 `.scratch/stateless-agent/`（票 01–06 是各决定的明细，本 ADR 只记合拢后的结论）。

## 背景

改造前的形态:每会话一个有状态的 `Agent` 实例(持有队列、审批、模型选择等
十几个私有字段)与一个有状态的 `SessionManager` 实例(持有账本索引与
leafId);`SettingsManager` 按工作区实例化;工具审批用 `pendingApprovals` 里的
`resolve` 闭包把运行挂起在内存里等。

当初这么定的理由:对象即会话句柄,`private` 让 TypeScript 编译器守账本不变式
(leafId / entry 索引 / anchor),桌面单进程不需要外部状态存储。

重开的动因:有状态类把「会话的哪些字段被哪个方法摸了」藏进 `this`,类越来越大
(`agent.ts` 1738 行)且账本不变式刚出过分支 bug;而 AgentScope Java 2.x 的实践
(`ReActAgent` 的 stateCache + AgentStateStore)证明同一问题存在一个更可测的形态:
无状态执行器 + 纯数据状态 + 显式的每请求重放。

## 决定

1. **五个无状态单例**,依赖为单向星形:`SessionManager`(账本)、
   `SettingsManager`(设置)、`ModelManager`(模型)、`ToolManager`(工具)
   平级互不依赖;`Agent` 做编排(跨域顺序与跨域不变式的唯一居所)。hub 只懂
   协议,不做编排。形式上无字段类与函数模块等价。

   **（2026-11-06 Superseded，[0016](0016-tool-manager-instance-table.md)：`ToolManager` 那一项——
   本构建的工具服务持一张常驻实例表；其余四项不变。）**
2. **状态全部是纯数据接口**(零方法、零对象句柄),方法首参收状态。种子→补齐
   (seed→fill)生命周期:前端只传名字(sessionId / modeName /
   `{modelName, thinkingLevel}`),幂等补齐函数每请求可重跑;打开会话与恢复
   会话走同一条补齐链。
3. **B 路线：每请求从磁盘与配置重放。**账本、设置、模型、工具不驻留内存；
   每请求的派生物（运行上下文）现建现传，**不进任何袋**；loop 只认识传入的
   context，对状态袋一无所知。账本一域的落地口径：状态由 `fillSession` 在
   **打开时**一次性重放，host 在手时该 manager 是文件**唯一写者**（claim
   保证），追加即时落盘，内存状态从不与磁盘分叉——这正是后果一节允许的
   **可从磁盘重建的缓存**；冷读、重开、重启恢复走同一条 `fillSession`，
   「打开会话 = 恢复会话」仍由结构保证。每请求全文重放被明确否决：它会
   打破 pending 会话流程（`create()` 后文件尚不存在），换来的只是单写者
   规则已经保证的东西。

   **（2026-11-06 Superseded，[0016](0016-tool-manager-instance-table.md)：仅「工具不驻留内存」那一半
   ——工具对象已驻留；「每请求的派生物现建现传、不进任何袋」与账本一域（单写者、fill-at-open、冷读
   同链）的原判不变。）**
4. **`SessionRuntime` 是唯一的跨栈内存态**:`{ steeringQueue, followUpQueue,
   activeRun? }`——「正在进行的、磁盘上没有的」。hub 持
   `Map<sessionId, SessionRuntime>`;进程重启后从零重建,无需恢复机制。
5. **审批改为「结束重启」**：等待审批时本轮运行结束，tool call 在账本中悬空
   （有 tool_use 无 tool_result）；答案经 REST 到达后由 loop 的恢复机器按
   toolCallId 配对、合成工具结果、续跑；孤儿悬空 call 合成错误结果收尾。
   内存挂起（`pendingApprovals` 的 Promise 机制）删除。进程关停不对悬空
   call 落 deny——transcript 是唯一状态，重启继承的该是一个仍可回答的问题，
   而不是一次没人做出的拒绝；abort 则等运行沉降后照落 deny 收尾。
6. **`shown` 半边落成 entry**(`tool_result_view`):hook 改写的工具结果
   双份视图从账本补齐,不再驻留内存。

## 后果

换来的:

- 状态边界显式:每个方法摸了哪些状态在签名上可见;逻辑可构造裸状态单测。
- 「打开会话 = 恢复会话」由同一条补齐链结构化保证,不再是两套代码的约定。
- 运行期瞬态全部降为局部变量;`AgentState` 之类的会话大袋不存在。
- 磁盘是唯一事实:进程崩溃后除信箱(允许丢)外一切可重建。

背上的:

- 每请求 O(账本全文) 的重放成本。桌面规模可接受;若实测不过关,升级方案是
  把可重建的缓存加回内存(设计承诺不变:缓存必须可从磁盘重建),阈值**尚未
  实测**,本 ADR 的成立不依赖它。
- `packages/loop` 常驻一套恢复机器(扫描/配对/合成)——悬空 tool call 从
  崩溃异常变为主路径。
- 窗口语义变化:等审批显示为「本轮运行结束」,答案到达后新轮恢复。
- 同会话并发下「重放 + 追加」的原子性依赖现有 claim 机制的覆盖范围,细节
  在实施中验证。

## 不可逆性与代价

回退意味着恢复三个有状态类(`Agent`/`SessionManager`/`SettingsManager` 的
实例形态)、审批的 Promise 挂起机制、以及 loop 恢复机器的下线——不止一处,
且中途数据(新 entry kind `tool_result_view`)需要迁移读法。难以逆转成立。

## 被取代的是什么

- `docs/architecture.md` 中「每会话一个 Agent 实例、一个 SessionManager
  实例」的 assembly/持有模型,及 `AGENTS.md` `## 术语` 中 session/
  assembly 词条的相应表述——本 ADR 落地时同步改写这两处。
- 审批的内存挂起语义(`pendingApprovals` + `resolve` 闭包 + 宽限期内等待)。

## 没有被取代的

明确不动、读者不该跟着本 ADR 一起重开的:

- [ADR-0001](0001-transport-websocket-mux.md):REST 命令面 + 常驻 WebSocket
  mux、有界写侧、claim 与订阅分离——全部保持。
- [ADR-0003](0003-queued-writes-at-drain.md):排队消息在取走点落盘——信箱里
  没消费的消息本来就不落盘,语义不冲突。
- [ADR-0005](0005-modes-are-a-tool-config-choice.md):模式是工具集与审批集的
  选择、座位按值匹配——`modeName` 只是补齐种子,实际配置仍以 `tool_config`
  entry 为准。
- compaction 的「文件永远保留全文、每步裁剪是一条 entry」;retry 装在模型的
  transport 上;subagent 是一对工具、无注册表无嵌套;密钥只在
  `<agent home>/models.json`、只骑在一次请求上。
