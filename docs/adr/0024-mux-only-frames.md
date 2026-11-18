# 0024：mux 只认帧——`wire` 与 `session stream` 的拆分

日期：2026-11-18 · 状态：已接受，**已落地**（wire-stream-split 01–05 号票：黑盒 smoke、拆 `wire`、
拆 `session stream`、hub 合表、projection 改推 hub、文档同步，见 `.scratch/wire-stream-split/`）
取代：[0001](0001-transport-websocket-mux.md)（部分——「基线与增量之间没有缺口」那段的**住所**：
结论不变，机制半仍在 hub 的 `subscribe`，帧序半从 mux 搬到 `session stream`；传输形态本身不被取代）、
`AGENTS.md` 里「hub 以一张分发表应答订阅」的说法整体退场

它同时满足 `docs/adr/README.md` 的三条：改回去要动 server 的 `wire` / `stream` / `mux` / `hub` /
`projection` / `boot` 与四个 smoke（mux / stream / subscribe / approval）；下一个人读
`mux.ts` 会问「传输层为什么认识 `sessionId`」；而放弃的是「一个文件里读完传输与会话语义」的便利，
换来的是每层只回答自己那一层的问题。所以它是一条 ADR，不是 `docs/notes.md` 里的一行。

## 背景

改造前，`mux.ts` 一个文件同时装着有界队列、背压、ping 与心跳，以及「什么是 baseline、哪个事件
该带 entry、审批横幅什么时候收、哪个目录被放到一边」。hub 有两张按 `sessionId` 键控的表：
「谁在观看」与「谁要事件、谁要状态」，装的是同一批消费者。侧栏的行由 projection 算、由 mux
广播、由连接逐个发——mux 因此认识 projection、行与隐藏目录规则，而 hub 对「这台机器上有哪些
窗口」一无所知。

## 决定

1. **`wire` 只发帧。** 收 `ServerFrame`、写 socket；有界队列（4 MiB）、停滞期限（10 秒）、
   `1013`、协议层 ping（2 秒一次，容忍两次未应答）与应用心跳（5 秒）、关停。它的全部成员是
   `send` / `heartbeat` / `tick` / `notePong` / `log` / `onClose` / `close` 与几个只读度量；
   对 socket 的接口只有 `FrameSink` 的五个成员。它不认识 sessionId、baseline、审批、目录。
2. **`session stream` 懂会话，不认识 socket。** 每连接一个，构造依赖 `wire`、`hub`、
   `projection`、审批答案表。它订阅 hub、装配 overview（过滤隐藏目录）、把事件与快照翻译成帧、
   持有 baseline 前的扣帧队列与本连接的审批读者计数、决定失败的措辞；所有帧经 `wire.send` 写出，
   看不见队列、背压、`1013` 与字节数。`start` / `handle` / `dispose` 是它在一条连接上的全部动词。
3. **`hub` 收敛成一个通道化的 broker。** 一张按会话的订阅表 `Map<sessionId, Set<SessionSubscription>>`、一个
   全局通道 `Set<GlobalSubscription>`。`SessionSubscription` 用实现了哪几个可选方法表达兴趣——`event` / `state` /
   `baseline` / `baselineFailed` / `gone` / `failure`；`GlobalSubscription` 是 `rows` / `gone` / `resync`。
   公开面是 `subscribe` / `snapshotFor` / `subscribeGlobal` / `publishRows` / `publishGone` /
   `publishResync` / `publishFailure`。它不看行的内容，不数连接。
   两个元素类型落地取名 `SessionSubscription` / `GlobalSubscription`——spec 的示意里写作 `订阅` /
   `全局订阅`，而本仓库的标识符一律英文，中文只出现在注释与用户可见文案里。
4. **`mux` 只剩接线与存活探测。** 保留 socket 升级、`accept(sink)`、连接集合、两个定时器、
   关停；连接集合不再参与任何分发。构造收一个工厂 `(wire) => SessionStream`，所以它不 import
   hub / projection / 审批里的任何一个类型。`MuxConnection` 只有 `wire` 与 `stream` 两个字段。

### 分层与允许知道什么

| 层 | 知道 | 不知道 |
|---|---|---|
| `wire` | 帧、字节数、队列、stalled、ping、应用心跳、关闭 | 会话、事件、审批、目录、hub |
| `session stream` | 会话、事件语义、baseline 时机、审批读者计数、隐藏目录过滤、帧措辞 | socket、背压、`1013`、字节数 |
| `hub` | 一个会话有哪些订阅者、全局有哪些订阅者 | 帧、连接数、行的内容 |
| `projection` | 有哪些行 | 谁在看、有几个窗口 |
| `mux` | socket、存活定时器、连接集合 | 上面任何一样业务概念 |

这张表是这条 ADR 的主要产物：下次有人想往 mux 里加一个 `if (sessionId === ...)`，挡住他的就是
这张表——`mux` 那一格写着，它不知道上面任何一样业务概念。

### 为什么是这三刀

会话语义离开 HTTP/WS 仍然成立，队列与背压只在有一条 socket 时才有意义；两者住在一个文件里，
读任何一处都要同时理解另一处，而分层判据要的正是「不知道」比「知道」更可检查。

同一个会话的同一批消费者没有理由住两个容器。「新加一个消费者该挂哪张表」在今天只能靠读实现
回答；合成一张之后，这个问题消失，查一次表就答完。

侧栏的扇出属于 hub，不属于 mux。行由唯一知道行的地方（projection）推给唯一知道「这个会话的
事分给谁」的地方（hub），再由每条连接自己的 `session stream` 发出去；mux 手里有连接表，但
「有哪些窗口」是它唯一不需要知道的事。

### 协议零变化

帧格式、`ClientFrame` / `ServerFrame`、前端一行不改。这次是职责搬家：同样的一串帧由同一批输入
产生、按同一个顺序到达客户端，变的只是它们在进程内经过谁的手。

### 不变量

1. **帧序**：一条连接上的所有帧——流上的、`session_row`、心跳、`end`——只经同一个 wire 队列
   写出，所以「先 baseline 后增量」由队列顺序保证，不靠约定。
2. **恰好一次**：`baseline` 与 `error` 互斥、各至多一次。hub 的 `deliverBaseline` 用 `delivered`
   守交付，`subscribe` 的退订函数用 `cancelled` 终结冷半读盘在飞的窗口；`subscribe` 与
   `snapshotFor` 共用这一处判活与交付的守门。
3. **删除顺序**：流先 `end`、行后 `gone`。路径是 `hub.remove` → 订阅的 `gone()`（`stream` 里
   `endStream`）→ controller 的 `onRemoved` → projection 的 `forget` → `hub.publishGone`。
   所以窗口不会先丢掉行、再收到一条来自已不存在会话的帧。
4. **依赖方向**：`projection → hub`、`session stream → hub`、`session stream → projection`、
   `hub → 无人`、`mux → wire`。任何一侧新增反向依赖都算破坏。

## 与 spec 的偏离

实施中实际发生的八条，逐条记下来：

1. **`SessionSubscription` 有六个可选方法，不是四个。** spec 列了 `event` / `state` / `baseline` / `gone`；
   实况还要 `baselineFailed`——baseline 的失败半，要初始状态的人必然也要它的失败，
   `SubscriptionSink` 的那两口拆不掉——与 `failure`——一次运行在会话流上说的那句失败，原
   mux 向会话流宣布运行失败那个方法的收件人。spec 漏了这两个名字。
2. **`hub.publishFailure(sessionId, message)` 是公开面的第六条，spec 的清单里没有。**
   那个宣布方法退场后 `onRunFailure` 没有别的去处；形状与 `publishRows` 同一条原则：只转发载荷、
   不看内容、不判断谁在看。
3. **全局订阅除 `rows` / `gone` 外还要 `resync`。** `publishResync` 无载荷（「整表变了」），
   总得有一个收件方法；它对应的是连接级的一整份新 `sessions` 帧，而不是任何 `session_row`。
4. **`createMuxServer(factory, options)` 收工厂，`accept(sink)` 的签名保持不变。** `accept` 内部
   造 `Wire` 再交工厂，所以测试装置与 `muxUpgrade` 都不用动——多出来的是构造参数，不是 socket
   那一侧的接口。
5. **票 04 把「会话流传出」与「行的广播改由 hub 扇出」放进同一张票。** 只做前者，侧栏会在一张
   票的时间里坏掉：行还在 mux 里广播，而 mux 已经不认 projection 了。这两件事的落点不同，但拆开
   没有一段可以独立成立的中间态。
6. **`Wire` 多了 `onClose(listener)` 与 `log(line)`。** 前者让「wire 自关」与「外部 close」走
   同一条收尾路径——订阅当场摘掉，不等下一轮定时器撞见 `isClosed`；后者承接从 mux 搬来的
   「丢弃看不懂的上行帧」那一行诊断，让一条连接的日志只有一个可被接管的出口。
7. **`SessionProjection` 瘦身，`MuxConnection` 只剩两个字段。** projection 的 `onRow` /
   `onGone` 与两个监听器集合退场，行只经 `hub.publishRows` / `publishGone` 出门
   （`scripts/smoke-projection.ts` 改用 `hub.subscribeGlobal({ rows })` 观察）；
   `MuxConnection` 不再有连接自己的订阅表，只剩 `wire` + `stream`。
8. **`hub.subscribeGlobal(sub)` 是公开面清单之外的成员。** spec 只给了「一个全局通道
   `Set<GlobalSubscription>`」，没给登记它的动词；它是那个通道的唯一入口，不登记就收不到 `rows`
   （`gone` 同样经它）。

## 被取代的是什么

名字与形状一起退场：`feedMap`、`watchers`、`isWatched`、`SessionFeeds`、`SessionWatcher`、
`rebaseline`、`MuxServer.announce`、`rememberApproval`、`broadcastSessions` 在代码与两份实况文档
里都不再存在——`rebaseline` 的继任者是 `snapshotFor`，宣布的继任者是 `publishFailure` 加订阅的
`failure`，整表重发的继任者是 `publishResync`。

| 原结论 | 本次 |
|---|---|
| [0001](0001-transport-websocket-mux.md) 的「基线与增量之间没有缺口」：建条目、取基线、挂监听、发基线在同一个任务里 | **修订住所，结论原样**。机制半仍是 hub 的 `subscribe`（注册、活冷分岔、baseline 交付在同一个同步块）；帧序半从 mux 搬到 `session stream`（baseline 先于本订阅 backlog 的任何帧）。 |
| `AGENTS.md` 的 `SessionFeeds` 与「hub 以 `feedMap` 应答」 | **取代**。一张按会话的订阅表加一个全局通道；`SessionSubscription` 用可选方法表达兴趣，窗口与侧栏同住一个 `Set`。 |
| [0013](0013-table-holds-live-half-only.md) 落地一节「hub 查自己的 `feedMap` 同步遍历分发；`SessionFeeds` / `SessionObserver` 形状不变」 | **修订**。那描述的是 0013 当时的按 id 分发面；两张表已合成一张，形状由本 ADR 定。0013 的「表只装 live 半」本身不动。 |
| spec 里 hub 公开面的那张清单 | **补齐**。多出 `publishFailure` 与全局订阅的 `resync`（偏离 2、3）。 |

## 没有被取代的

- **协议与帧格式。** `ServerFrame` / `ClientFrame` / `ServerMessage` 一个字不改，前端零改动。
- **两半保证与 `baseline` 恰好一次。** 机制半在 hub、帧序半在 `session stream`，缝仍是
  `subscribe` 的返回拍：hub 交结果（快照或原始 error），帧序与失败措辞归业务侧。
- **订阅与 hold 永不互相换算**（[0001](0001-transport-websocket-mux.md)、
  [0023](0023-holds-into-session-manager-veto-delete.md)）。订阅不占闸、不让会话运行；
  取消订阅只是停止转发，不中止运行。
- **审批答案表的键控。** 仍按会话一张表；变的是住址——整张表搬到业务侧，boot 创建一份、注入
  每条流、跨连接共享，mux 对它一无所知。
- **删除顺序与 202 语义。** 流先 `end`、行后 `gone`；删除的否决序与应答先到不变。

## 后果

换来的：

- mux 不再 import 任何业务类型，「传输层」这个名字重新只指传输。
- hub 的两个容器各答一个问题：一个会话的订阅者查一张表，这台机器的列表查一个通道。
- projection 只推一处，侧栏路径变成 `projection → hub → session stream`，中间不再经过 mux。
- 每层「允许知道什么」有一张表可引用，新增代码先对表。

背上的：

- 多一层间接：连接的业务侧由工厂函数造，读 `boot.ts` 要跟着工厂跳到 `stream.ts`。
- 每连接一个 `SessionStream` 对象与一张订阅表；关闭时必须显式 `dispose`（wire 自关由
  `onClose` 接到同一条路径）。
- `wire` 多了两个不属于帧的成员（`onClose` / `log`），它们服务于「一条连接的收尾只有一处」
  与「一条连接的日志只有一处」，不是帧策略本身。
- 测试装置的接缝从「mux 收 sink」变成「mux 收工厂」，自建对象图的 smoke 要多给一个工厂。

## 不可逆性与代价

- **难逆转。** 改回去要动 `wire.ts` / `stream.ts` / `mux.ts` / `hub.ts` / `projection.ts` /
  `boot.ts` 与四个 smoke；会话语义一旦搬出 mux，再搬回去等于重写一遍翻译层。
- **没有上下文会让人困惑。** 读 `mux.ts` 只看到 socket 与定时器，会问「帧是谁装的」；答案是
  `stream.ts`，而两半保证的缝在 `hub.subscribe` 的返回拍——这三处的关系只在这条 ADR 里。
- **是一次真实取舍。** 放弃的是「一个文件读完传输与会话语义」的直白；换来的是分层判据可执行、
  hub 只剩订阅与扇出、侧栏不再穿过 mux。代价是多一次跳转与一个每连接对象。

## 落地

- 代码：`packages/server/src/wire.ts`（`Wire`、`FrameSink`、预算与两个定时器）、
  `stream.ts`（`createSessionStream`、扣帧队列、审批读者计数、隐藏目录过滤、失败措辞）、
  `mux.ts`（`SessionStreamFactory`、`MuxConnection` 两字段、连接集合只做存活与关停）、
  `hub.ts`（`SessionSubscription` / `GlobalSubscription`、一张表加一个通道、`publishFailure` / `publishResync`）、
  `projection.ts`（行只推 hub）、`boot.ts`（答案表一份、工厂注入）、`approvals.ts`（整张表在
  业务侧）。
- smoke：`smoke-projection.ts` 改用 `hub.subscribeGlobal({ rows })` 观察行；其余 wire 表面
  断言仍只看客户端收到了什么帧、按什么顺序。
- 文档：本 ADR；`AGENTS.md` 的 `transport` 条目与新增的 `wire` / `session stream` 两条；
  `docs/architecture.md` 的*谁拥有一个会话*与*wire*两节。
