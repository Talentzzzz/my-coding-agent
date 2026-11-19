# 0025：mux 就是连接的 controller——`session stream` 退场，翻译退成纯函数

日期：2026-11-18 · 状态：已接受，**已落地**（同日，`check` 与 8 个 smoke 全绿）
取代：[0024](0024-mux-only-frames.md) 的**决定 4**（「`mux` 只剩接线与存活探测」）与它那张分层
表的 `mux` 行；0024 的决定 1/2/3 与不变量原样保留

它满足 `docs/adr/README.md` 的三条：改回去要把 `frames.ts` 重新装箱成每连接对象、把三只服务
从 `MuxServer` 的构造里摘出来、改回 4 个 smoke 的构造点；下一个人读 `mux.ts` 会问「传输层为
什么认识 `sessionId`」，而这一次答案是**故意的**；放弃的是「一个文件只回答一个层次的问题」
那条判据，换来的是与 REST 侧同形的一份 controller。

## 背景

[ADR-0024](0024-mux-only-frames.md) 把传输劈成三块：`wire` 只发帧，`session stream` 懂会话，
`mux` 只剩 socket 与定时器。它给出的拒绝测试写在分层表里——`mux` 那一格写着「不知道上面任何
一样业务概念」，理由是「下次有人想往 mux 里加一个 `if (sessionId === ...)`，挡住他的就是这张
表」。

一天之后这条把守被用户推翻了，理由不是"那张表写错了"，而是**它把一条连接的状态拆成了两个
对象**：

1. **与 REST 侧不同形。** REST 是 `Router → controller → hub`——Router 解释 URL，controller
   持有请求自己的状态、调服务。WS 侧却是 `mux → 工厂 → stream → hub`：mux 拿到一条 socket，
   然后向一个工厂要另一个对象来管它，而那个对象才是 controller。同一个进程里两条入口，一条
   有 controller、一条有"工厂背后那一层"。
2. **一个连接的状态有两个答案。** `MuxConnection` 装着 `wire`，`SessionStream` 装着观看表、
   扣帧队列与审批读者计数——后三样全是 *连接 × 会话* 的事实。问"这条连接现在在看什么"要先
   问 `MuxConnection` 再跳到它手里那个 `stream`。
3. **no-gap 的两半隔着一个文件。** hub 保证「注册与快照原子」，stream 保证「baseline 帧先于
   本订阅 backlog 的任何帧」；两条互指对方，都靠注释说"另一半在那边"。
4. **`accept()` 的排序理由跟被排序的东西不住一处。** overview 必须先于任何 `open` 写出，这条
   约束一半在 `mux.ts` 的 `accept`，一半在 `muxUpgrade` 的 `waiting` 缓冲，第三半在 `stream` 的
   `start`。

## 决定

1. **`MuxServer` 注入三只服务。** 构造从 `(factory, options)` 改成 `({ hub, projection, answers }, options)`。
   `SessionStreamFactory` 这个类型不存在了：mux 自己 import 它要用的三个类型，方向是
   `mux → hub / projection / 答案表`，与 `projection → hub` 并列，仍然没有回边。
2. **`MuxConnection` 是连接级 controller 实例。** 它持有 `wire`、观看表（`Map<sessionId, Watcher>`）、
   全局列表订阅的句柄，以及一个 `disposed`；动词只有三个——`begin`（心跳 → overview → 全局订阅）、
   `handle`（一个上行帧：`open` / `cancel`）、`dispose`。其余全是私有：`open` / `cancel` /
   `push` / `writeBaseline` / `pushBaseline` / `baselineSink` / `pushApprovalChanges` /
   `failBaseline` / `failStream` / `endStream` / `unwatch` / `overview` / `resync` / `listed`。
   `MuxServer` 只剩连接集合、两个定时器、关停，以及"把一个上行帧交给它"。
3. **翻译退成纯函数。** 新文件 `frames.ts`：帧构造（`sessions` / `row` / `gone` / `baseline` /
   `event` / `entry` / `status` / `approvalRequest` / `approvalSettled` / `failure` / `refusal` /
   `end`）、审批差量（`pendingOf` / `approvalDiff`）、失败措辞（`baselineFailureText`）。**只有
   函数**：没有类型、没有状态、没有生命周期。凡是"由输入算得出输出"的都住这里，凡是"这条连接
   已经看到哪儿"的都住 `MuxConnection`。
4. **`wire` 一个字不动。** 队列、背压、`1013`、两份定时器、`onClose` / `log` 全部原样——这次搬的
   是它上面的那一层。

### 现在的分层表

| 层 | 知道 | 不知道 |
|---|---|---|
| `wire` | 帧、字节数、队列、stalled、ping、应用心跳、关闭 | 会话、事件、审批、目录、hub |
| `frames` | 一种会话语义在线上长什么样、审批差量怎么算、失败怎么说 | 连接、订阅、backlog、socket、谁在看 |
| `mux`（controller） | socket、存活定时器、连接集合，**以及这条连接在看的每个会话、baseline 时机、审批读者计数、隐藏目录过滤** | 会话的持久化、模型、工具、账本 |
| `hub` | 一个会话有哪些订阅者、全局有哪些订阅者 | 帧、连接数、行的内容 |
| `projection` | 有哪些行 | 谁在看、有几个窗口 |

与 0024 的差异只在第三行：`session stream` 那一行并进 `mux`，而"帧长什么样"另立一行 `frames`。

## 不变量（全部沿用 0024）

1. **帧序**：一条连接上的所有帧只经同一个 wire 队列写出。
2. **两半保证**：hub 保证「注册与快照原子」（`subscribe` 返回前的同一个同步块），`mux` 保证
   「baseline 帧先于本观看 backlog 的任何帧」；缝仍是 `subscribe` 的返回拍。
3. **恰好一次**：hub 的 `delivered` / `cancelled` 不动；`baselineSink` 的 `wanted()` 守卫原样搬进
   `MuxConnection`。
4. **删除顺序**：流先 `end`（`MuxConnection.endStream`），行后 `gone`（`projection.forget` →
   `hub.publishGone`）。
5. **订阅不占持有。** 观看不让会话运行，也不阻止它关闭（ADR-0023）。
6. **依赖方向**：`wire → 无人`、`mux → wire / frames / hub / projection / 答案表`、
   `frames → 协议类型`、`projection → hub`、`hub → 无人`。

## 后果

换来的：

- **两条入口同形**：REST 是 `Router → controller → hub`，WS 是 `MuxServer → MuxConnection → hub`。
  新增一条连接级命令时，改的是 `MuxConnection.handle` 里的一个 `if`，与在 `routes.ts` 表里加一
  行是同一个动作。
- **一个连接的状态一个答案**：`MuxConnection` 就是"这条连接"，问它即可。
- **no-gap 的两半同住一个文件**，那句"缝在 `subscribe` 的返回拍"不用跨文件指认。
- **少一个类型、少一层跳转**：`SessionStream`、`SessionStreamFactory`、`createSessionStream` 与
  `boot.ts` 里那次工厂构造都不存在了；`mux.ts` 547 行，比拆开时的 147 + 441 行略小。

背上的：

- **`mux.ts` 同时回答两个层次的问题**：socket 存活与"这个窗口该收到哪些帧"。这是本次明确认下
  的代价——0024 那张表用"不知道"换可检查性，这里用"知道"换对称与一处状态。
- **mux 认识 `sessionId`。** 0024 的拒绝测试因此失效，取代它的是本节上面那张表：`mux` 不认识
  的是**会话的持久化与引擎**，而不是"哪些会话"。
- **`frames.ts` 是一个新的公共面。** 帧形状变了要同时改 `core/protocol` 与这里；它不是可以随手
  内联进 `mux.ts` 的私有实现——纯函数是这次唯一保住的"翻译不跟生命周期混住"。

## 被取代的是什么

| 原结论 | 本次 |
|---|---|
| [0024](0024-mux-only-frames.md) 决定 4「`mux` 只剩接线与存活探测；构造收一个工厂，因此不 import hub / projection / 审批里的任何一个类型」 | **取代**。构造收三只服务；`MuxConnection` 三个动词里两个（`begin` / `handle`）直接对 hub 说话。 |
| 0024 分层表的 `session stream` 行与 `mux` 行 | **合并重写**。会话语义进 `mux`，帧形状独立成 `frames`（见上面的新表）。 |
| 0024 后果里「多一层间接：连接的业务侧由工厂函数造，读 `boot.ts` 要跟着工厂跳到 `stream.ts`」 | **撤销**。`boot.ts` 一行 `createMuxServer({ hub, projection, answers }, ...)`，没有跳转。 |
| 0024 后果里「测试装置的接缝从『mux 收 sink』变成『mux 收工厂』」 | **撤销**。接缝回到 `accept(sink)`，自建对象图的 smoke 只多给三只依赖。 |
| 0024 落地清单里的 `stream.ts` 与 `SessionStream` | **退场**。文件删除；`MuxConnection` 从两字段变成"这条连接本身"。 |

## 没有被取代的

- **0024 决定 1**：`wire` 只发帧，不认识 sessionId、baseline、审批、目录。一个字不改。
- **0024 决定 2 的实质**：会话语义仍然"懂会话、不认识 socket"——它现在住在 `MuxConnection`
  里，而那个类对 socket 的接口仍然只有 `wire.send`。
- **0024 决定 3**：hub 是一张按会话的订阅表加一个全局通道，两张元素类型与七个公开方法不变。
- **协议与帧格式**：`ServerFrame` / `ClientFrame` / `ServerMessage` 一个字不改，前端零改动。
- **审批答案表整张在业务侧**，按会话键控，boot 造一份、注入每条连接、跨连接共享。
- **no-gap 的结论与两半的住所**（机制半在 hub，帧序半在连接层）、**删除顺序**、**订阅不占持有**。

## 不可逆性与代价

- **难逆转**：改回去要把 `frames.ts` 的十二个函数重新装箱成一个每连接对象、把三只服务从
  `MuxServer` 的构造里摘出来、恢复工厂类型，并改 4 个 smoke 的构造点。
- **没有上下文会让人困惑**：读 `mux.ts` 会看到 ping 定时器与审批横幅相邻，第一反应是"这两件事
  为什么在一个文件里"。答案是：它们是同一个对象的两件事——一条连接的存活，与这条连接该收到什么。
  这个答案只在本 ADR 里。
- **是一次真实取舍**：0024 用"每层只回答自己那一层"换可检查性；这里用可检查性换同形、换一处
  状态、换少一层间接。两条都成立，先后选了不同的那一半。

## 落地

- 代码：`packages/server/src/frames.ts`（新，165 行，纯函数）、`mux.ts`（547 行——
  `MuxDeps`、`MuxConnection` 三动词、`MuxServer` 只留连接与定时器）、`boot.ts`（一行注入）、
  `hub.ts`（三处注释里的 `SessionStream` 改成 `MuxConnection`）；`stream.ts` 删除。
- smoke：`smoke-stream` / `smoke-mux` / `smoke-subscribe` / `smoke-approval` 只改构造点与一行
  import，断言一条没动——它们本来就是从客户端看帧，而这次协议零变化。
- 验证：`npm run check` 绿（含 `check-server-facade`——`unwatch` 这个名字是为了避开它对
  `.release(` 的禁令，那条禁令属于 ADR-0023 的持有簿记词汇）；`smoke-subscribe` /
  `smoke-mux` / `smoke-stream` / `smoke-approval` / `smoke-backpressure` / `smoke-liveness` /
  `smoke-boot` / `smoke-sessions` / `smoke-mux-live` 全绿（`smoke-api` 需要外部服务器，未跑）。
