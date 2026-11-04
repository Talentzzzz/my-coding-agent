# 0011：会话状态搬进 Agent——一张 `Map<id, AgentState>`，四层登记结构合一

日期：2026-11-04 · 状态：已接受，**已落地**（agent-state 01–14 号票；01–05 拍板、06–13 落地、14 号票清旧删废并翻转此行）
取代：[0007](0007-services-drop-instance-state.md)（部分，2026-11-04——决定 3 的 Manager 键控缓存与决定 4 的活登记处归属及判据；其余决定不变）

设计过程见 `.scratch/agent-state/`（票 01–05 是各决定的明细，本 ADR 只记合拢后的结论）。

## 背景

ADR-0006/0007 之后的形状：`Agent` 是无属性编排层，durable 的一半经 `SessionManager.stateOf(id)` 从
fill-at-open 的键控缓存重放，live 的一半（两条队列、在飞运行、订阅集合、跨栈 run 槽、一次打开解析出的
装配）居 hub 持有的活登记处 `OpenSessions`——条目 `OpenSession` 装着 `SessionRuntime` 与 `RunScope`，
共四层；`SettingsManager` 另持一份按目录键控的设置缓存。当初这么定的理由（0007 §3、§4）：缓存随时可从
磁盘重建、藏在自己内部不被传递，就是它与聚合袋的分界；登记处只装「进行中且磁盘上没有」的东西。

重开的动因，是这四层各自长出了一个主人管不住的问题：

1. **同一份会话状态被切成四层、分居三个主人**（hub 的登记处、两个 Manager 的缓存、编排层的 id 调用），
   「这个 id 现在是什么」没有一处能完整回答。`SessionManager.adopt` 与 `OpenSessions.ensure` 两个入口
   语义还不一致——一个最后写赢，一个首触建条目。
2. **缓存的正确性挂在写者唯一上，而写者不唯一**。冷路径与活路径各有一只袋：`hub.rename` 写回的之所以
   是跑动刚记的那份，只是因为 `stateOf` 缓存恰好把两只袋合并成了同一只——删掉缓存，事故窗口立即打开
   （02 号票 §3）；同目录的两个活会话靠共享一只设置袋才即时看到彼此的修改，那是缓存的副产品，不是语义。
3. **「未落盘的会话」需要一个无文件可依的家**。id 交出去之后、第一条消息落盘之前，「这个 id 存在」只能
   由一张内存表回答——今天这张表是 hub 的 `pending`，它和登记处、和 `adopt` 缓存是同一份状态的第三处
   持有（03 号票 §1）。

## 决定

调子先说死：这是**登记处从 hub 搬进 `Agent`**，不是「`Agent` 变成会话」——`Agent` 仍是进程唯一单例、
仍是编排层，只是多一个 Map 属性；per-session 实例的路（0006 的 A 路线）仍然否掉。

1. **一张表，四层合一**。`Agent` 持有 `private readonly sessions: Map<string, AgentState>`；
   `AgentState = { listeners, eventListeners, setting, session, live }`（类型由 07 号票落地）合并
   `OpenSessions` / `OpenSession` / `SessionRuntime` / `RunScope` 的全部内容；构建链固定为
   `fillSession` → `fillSettings` → `live`（先会话后设置——会话记着自己选了哪个模型、哪档思考强度），
   由工厂的 `assembleSession` 一次跑完。
2. **唯一的门**。状态进表的唯一入口是 `Agent.adopt(state)`：**先到先得**——已有该 id 时不覆盖、不抛
   （继承 `OpenSessions.ensure` 的语义，**不是** `SessionManager.adopt` 的最后写赢；覆盖会换掉在飞的
   队列、订阅集合与 run 槽）。表私有、不公开 getter；公开面只有 `has(id)`、`agentState(id)`（缺失抛
   `Session is not open`）、`adopt` / `evict` / `drop` / `close`。`AgentConfig.openSessions` 整条删除，
   **不**换成 `sessions?: Map`——注入一张表等于给表的写者与删者各留第二个（01 号票 §3、§6）。
3. **装配点唯一，留在工厂**。`assembleSession`（原 `ensureSession`）造出 `AgentState`，调用方
   `agent.adopt(state)` 交表；`Agent` 不新增 `SettingsManager` 依赖——构造依赖就是权限，编排层读设置
   的唯一路径仍是随条目进来的 `entry.settings`（今天的 `state.setting`）。冷读继续走私有的 `assemble()`，
   **不进表**。`SessionServices` 删除，`SessionAgentServices` 断开 `extends`。
4. **表装的是「丢了就没了的那一份」**——这是对 0007 §4 判据的**重写**，不是引用：登记处不再只装
   「进行中且磁盘上没有」的东西。盘上有文件的会话也进表（它有队列与订阅），盘上什么都没有的会话也进表
   （它的 id 只活在这里）；`fileCreated === false` 的袋是这条判据最纯粹的样本。由此：**建 id 即入表**
   （创建 = `createSession` + `assembleSession` + `adopt`，`pending` 表删除）；**「打开」指这个进程握着
   它**，与「有人看」（observers）、「在跑」（hosts 的 claim 与在飞运行）互不换算，且 `hosts ⊆ 表`——
   删表只在 host 已删之后；hub 的三条判据（`has` / `snapshotOf` / `open`）从 hosted / pending / 盘
   三分支压成**表 / 盘**两分支。**活会话永不走冷路**：`hosts` 里有的 id，读写都走表里那只袋——整只快照
   写回会把跑动刚记的模型、档位、工具集静默退回旧值。冷读是 `SessionManager.open(id)`：fill 一份、
   不登记、调用方用完就丢；冷写就是 `open` 加既有 setter（`recordMeta` / `persistEntry` 自己落盘），
   没有第三个 persist 动词，安全靠「一次冷写是一段同步块」，不靠 claim。fork 的两侧都不经过袋：
   `forkFrom` 只写文件、不 fill、不入表。
5. **两个 Manager 不再持有任何缓存**。`SessionManager.states`、`SettingsManager.states`、
   `SessionManager.adopt` 删除，`stateOf` 删除、不留别名——`SessionManager` 侧的迁移是**换源**不是改名：
   编排层的 15 处 `stateOf(id)` 变成 `agentStateOf(id).session`（把 `stateOf` 机械替换成 `open` 会编译
   通过、运行丢数据）。
6. **删除权随表**。hub 不再有表：有判据的驱逐是 `Agent.evict(id)`，不带判据的删除（`remove`、宿主收摊）
   是 `Agent.drop(id)`——两个动词不合并，因为删一个正被看的会话合法而 `evict` 会拒绝；`clear()` 取消，
   表随编排层对象一起消失（不造第二个绕过逐会话判据的入口）。**驱逐判据七条、分居两处**（hub 侧第四条
   为 13 号票所补）：hub 侧 `observers` 空、没有等待结果的引用（send 引用的信号，mux 的 `wait` / `unwait`
   帧报告，不拿 claim）、`claims === 0`、`hosts` 里没有它；Agent 侧 `live.activeRun === undefined`、
   `live.suspended === false`、`state.session.fileCreated === true`（没有另一半的会话一清就是删 id，
   所以 `fileCreated === false` 永不驱逐——寿命到首条消息落盘、`remove` 或进程退出）。**时机是边沿试、
   全量查**：每条让判据从假变真的边沿（最后订阅离开、最后一个等待结果的引用释放、run 收尾、恢复收尾、
   claim 释放、首条消息落盘）触发一次、当场全量重查；边沿漏接是安全的（多驻留一阵，下一条边沿兜住），
   删除点同步全查是硬要求。mux 只报告「少了一个看的人」和「有一个/没有人在等结果」，删除权在 `Agent`
   ——cancel（连同它的等效事件：关窗、刷新、断网、背压踢连接）是连接级的话，判据本身没有一样在帧上；
   `wait` 是唯一的客户端自报，它不是判据的事实来源（run 是否在飞仍只有服务端知道），只是把「我还在等」
   这句话送到服务端——客户端的引用计数是副本，副本的迟到由这条判据买单（13 号票）。
7. **设置是打开时读到的一份快照**。一次写入只作用于发起命令那个会话的袋，同目录其余会话下次 open 时
   refill；正在跑的会话读旧值与 Live 规则同调。会话级（快照的 `activeTools` / `approval` 字段）与
   目录级（`modes` / `retry` / 默认 `approval`）的边界不变——袋还是那个袋，只是每个会话一份、不再共享。
8. **审批宽限与 reap 的 deny 删除**。「没人回答就拒」退化成「下一次运行的恢复机器把孤儿合成错误结果」；
   `suspended` 队列照旧保留（恢复运行要取走），`suspended` 本身挡驱逐。

## 后果

换来的：

- 会话状态只有一个主人：表的写者、删者各一个，「这个 id 现在是什么」由一处回答；`pending` 表、
  `SessionManager.adopt`、`OpenSessions` / `OpenSession` / `SessionRuntime` / `RunScope` 四层名字清零。
- 打开即建、无人看且无运行即清：切走的会话不再常驻；「正确性挂在缓存上」的那些暗保证（冷写回退、
  设置共享）改成显式规则（活会话不走冷路、设置是快照）。
- 冷读集合从「没在跑」缩成「不握」，失败文本与判据随之统一（`Session is not open`）。

背上的：

- `jsonlEntries` 常驻内存——原本每个请求重放一遍，现在活多久占多久。长会话的空闲上限（要不要再加
  超时或按 token 上限淘汰）未决，登记在地图 Not yet specified。
- 同目录两个活会话各有一份设置快照：一次设置修改不再即时抵达其他活会话，要等它们重开。
- 驱逐会丢队列：未取走的 steer / followUp 消息随袋一起消失。
- **审批可以悬空到进程重启**：宽限计时器与 reap 的 deny 删除后，「没人回答」的收尾完全交给下一次
  运行的恢复机器。
- 一次冷触碰 = 一次全量重放（改十次名重放十次）。改名是人的手势不是热路径，接受；若长会话改名开始
  肉疼，出路是给「只改快照」一条只读头的写 API，那是另一个形状，不在本图。
- 未落盘的会话（`fileCreated === false`）按判据不进驱逐，寿命到首条消息或 `remove`／进程退出——与
  今天 `pending` 条目同长，但持有者从 hub 换成了表。

## 不可逆性与代价

回退意味着恢复四层登记结构、两个 Manager 的键控缓存、hub 的 `clear()` 与审批宽限状态机、`pending`
表，以及所有已改为 `adopt` / `evict` / `drop` / `open(id)` 的调用点——不止一处，且冷写回退那类事故
窗口会随缓存的恢复一起回来。难以逆转成立。

## 被取代的是什么

逐条对照 [0007](0007-services-drop-instance-state.md)：

- **决定 3（Manager 内部键控缓存）**：`SessionManager.states`、`SettingsManager.states` 与两个 `stateOf`
  删除——「fill-at-open、随时可从磁盘重建」的缓存对这两个 Manager 不复存在。会话状态整份搬进 `Agent`
  的表（决定 1），冷读改为 `SessionManager.open(id)` 每次 fill 一份、用完即弃（决定 4/5）。当初买这条的
  理由——缓存不离开属主所以不是聚合袋——由更强的形式兑现：表只有一个写者、一个删者。
- **决定 4（活的一半例外）**：登记处的归属从 hub 搬进 `Agent`；「只装『进行中且磁盘上没有』」整句重写为
  「装丢了就没了的那一份」——盘上有文件的会话也进表，`fileCreated === false` 的会话也进表（决定 4）；
  驱逐从「宿主收摊」变成六条判据、边沿试全量查（决定 6）。`SessionRuntime` 的窄定义**内容**原样并入
  `AgentState.live`，被删的是分层与名字；进程重启丢弃全部条目、重开即重建的不变量不变。
- **0007 的其余决定不变**：决定 1/2/5/6（无聚合袋、类壳保留、modelState 消失、进程级不可变配置留构造
  注入）原样有效，见下一节。

## 被放弃的选项

- **保持无状态 + 每请求重放（0006 的 B 路线）**：live 的一半不可从磁盘重建，重放只回答 durable 半；
  而删掉缓存之后正确性不再免费——02 号票 §3 逐行演示了冷袋如何把跑动的快照写回旧值。每请求重放对冷读
  保留（`open(id)` 就是它），对活会话放弃。
- **表留在 hub、`Agent` 只借读**：hub 仍能 `clear()` 一张 Agent 正在读的表，而「Agent 自己再判一次」
  没有落点；表的写者与删者各变成两个，买不到本图唯一要的东西。
- **注入一张表（`AgentConfig.sessions?: Map`）**：与上一条同罪——一个便利参数就是第二个写者；`adopt`
  一个动词就够表达注入能表达的全部四件事。
- **cancel 即删**（04 号票 §2）：订阅归零是驱逐的**触发器**之一，不是**判据**；REST（审批答案、rename）
  不过帧，「open 建、cancel 删」留不出它们的路径。
- **按目录扇出设置修改（05 号票 (b)）**：需要一张「目录 → 会话」反查表，正是这次要删的那类表。
- **把 `Agent` 变成 per-session 实例（0006 的 A 路线）**：一个进程一个编排层的裁决不变。

## 没有被取代的

明确不动、读者不该跟着本 ADR 一起重开的：

- [0006](0006-stateless-session-architecture.md) 的结束重启审批、种子→补齐生命周期、host 在手时
  账本唯一写者、`tool_result_view` 已删的定局；[0007](0007-services-drop-instance-state.md) 的决定 1/2/5/6
  （无聚合袋、类壳保留、modelState 消失、进程级不可变配置留构造注入）。
- `SessionRuntime` 的**语义**：队列、在飞运行、订阅集合的窄定义原样并入 `AgentState.live`——被删除的
  是分层与名字，不是内容。
- [0001](0001-transport-websocket-mux.md) 的订阅不拿 claim、命令留 REST；[0003](0003-queued-writes-at-drain.md)
  的取走点落盘——队列搬进 `live`，语义不变。
- 两文件格式（[0009](0009-session-two-file-format.md)）、压缩三步、retry 装在 transport 上、
  密钥只骑在一次请求上。
