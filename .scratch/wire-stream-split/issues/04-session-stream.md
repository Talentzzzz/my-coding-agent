# 04 - 拆出 `session stream`：会话语义离开 mux，侧栏广播改由 hub 扇出

Type: task
Status: ready-for-agent
Blocked-by: 03

## 背景与指针

- Spec：`Implementation Decisions / ### session stream`、`### mux`、`### 审批答案表` 三节 + `不变量` 第 1/3/4 条 + User Stories 6/8/9/10/12/13/19/20/26。
- 现状代码（全部住在 `packages/server/src/mux.ts`，880 行）：
  - `Subscription`（每订阅的 `pending` 审批集 + `backlog`）L108-134
  - `MuxConnection`：`handle` L206-216、`open` L225-267、`teardown` L274-279、`cancel` L288-291、`bind` L298-317、`push` L324-331、`writeBaseline` L339-356、`pushBaseline` L368-372、`baselineSink` L381-393、`pushEntry` L400-406、`pushStatus` L408-417、`pushApprovalChanges` L424-444、`failBaseline` L453-456、`failStream` L463-466、`endStream` L475-479、`announce` L482-485、`sendSessions` L488-490、`sendRow` L493-495、`sendGone` L498-500
  - `ApprovalAnswers` / `createApprovalAnswers` L646-702
  - `MuxServer`：`connections` L710、`answers` L718、`stopRows`/`stopGone` L721-722、构造 L728-750（projection 的两条监听器）、`accept` L759-774、`announce` L801-803、`rememberApproval` L806-808、`listed` L815-817、`overview` L820-822、`broadcastSessions` L829-832
- 接线：`packages/server/src/boot.ts` L90-139（bootServer）、L154-225（`muxUpgrade`，造 `FrameSink` —— **这一段不动**）、L234-256（`sessionListeners`）
- 其他消费方：`scripts/smoke-mux.ts` L120、`scripts/smoke-stream.ts` L103、`scripts/smoke-approval.ts` L781（三处 `createMuxServer(hub, projection, …)` 装配）、`scripts/smoke-backpressure.ts` L77-82（`ApprovalAnswers` stub 的 import）

**这是本次重构最大的一张票**，因为它必须原子地换掉两条互相纠缠的路（会话流 + 行的广播）：只换其中一个，侧栏或流会在一张票的时间里坏掉。按下面的步骤**分步落地、每步都跑黑盒 smoke**，全部步骤在同一张票、同一个分支里。

## 改动

### 第 1 步：`approvals.ts`（整张审批答案表搬到业务侧）

新文件 `packages/server/src/approvals.ts`：把 `ShownApproval` / `ApprovalAnswers` / `createApprovalAnswers` **原样**搬出 `mux.ts`。注释里保留那条承重的理由（`remember` 的前提是"有订阅正在展示它"——记忆与可见性是同一件事的两面，所以整张表一起搬，不拆两半；spec `### 审批答案表`）。

`mux.ts` 不再知道这个类型的一个字。

### 第 2 步：`stream.ts`（会话流）

新文件 `packages/server/src/stream.ts`：

```ts
export interface SessionStream {
  /** 应用心跳 → overview（过滤隐藏目录）→ 注册全局订阅。顺序即现状。 */
  start(): Promise<void>;
  /** 一个上行帧：`open` / `cancel`。 */
  handle(text: string): void;
  /** 退掉所有会话订阅、摘全局订阅、让 wire 关闭。 */
  dispose(): void;
}

export function createSessionStream(
  wire: Wire,
  deps: { hub: SessionHub; projection: SessionProjection; answers: ApprovalAnswers },
): SessionStream;
```

搬进去的东西，一条不漏：

- **自持一张 `Map<sessionId, 订阅>`**：这既是"我在订什么"，也是断线时唯一的反向索引（spec User Story 13）。
- 每订阅的 `backlog`（baseline 发出前扣住的帧）与 `pending`（本连接已告诉过窗口的审批，按 `toolCallId`）；原 `Subscription` 的注释（load-bearing 的那几条：为什么 `backlog: null` 表示已发出、为什么 `teardown` 是列表）随之搬。
- `open(id)`：已在订 → `hub.snapshotFor(id, sink)` 重发（不重复订阅，ADR-0009 决定 1）；否则造一个订阅元素（`baseline` / `baselineFailed` / `event` / `state` / `gone`）交给 `hub.subscribe`——baseline 由 hub 在同一同步块里交付，`writeBaseline` 里写出并冲刷 backlog。
- `cancel(id)`：摘订阅（退订 + 清 `answers` 的读者计数）。
- 帧翻译全部搬进来：`push` / `writeBaseline` / `pushBaseline` / `pushEntry` / `pushStatus` / `pushApprovalChanges` / `failBaseline` / `failStream` / `endStream`。
- **错误措辞**（`未知的会话：${id}` / `读不出这个会话的记录：…`）与 `describe()` 搬进来——hub 交原始 `error`，话由这里说。
- **隐藏目录过滤**搬进来：overview（`projection.rows()` 过滤）与每一个 `rows` 回调都过 `hub.listsDirectory(row.workDirAbsPath)`，规则本身仍向 hub 要（一个规则一个家）。
- `start()` 里注册**全局订阅**（`hub.subscribeGlobal`）：`rows` → `session_row` 帧；`gone` → `session_gone`；`resync` → 重新读 `projection.rows()` 并整份发 `sessions`。这三帧**没有 streamId**（连接级），走的是同一个 wire 队列。
- `dispose()`：退掉所有会话订阅、摘全局订阅、`wire.close()`。

文件头注释写清分层（spec 那张表里 `session stream` 的两行）与**帧序不变量的另一半**：本层保证 baseline 帧先于它自己 backlog 里的任何帧写出；与 hub 的"注册与快照原子"之间的缝是本层 `subscribe` 的返回拍。这段论证从 `mux.ts` L238-243 搬过来改写，不许散佚。

### 第 3 步：`mux.ts` 只剩接线与存活探测

保留：常量挪走后剩下的 close code 用法、`MuxServer` 的 `connections`、两个定时器、`accept`、`handle`、`notePong`、`forget`、`size`、`close`、`upgrade` 相关的 `shuttingDown`。

删除（spec `### mux` 的清单）：`open` / `cancel` / `bind` / `push` / `writeBaseline` / `pushBaseline` / `pushStatus` / `pushEntry` / `pushApprovalChanges` / `endStream` / `failBaseline` / `listed` / `overview` / `broadcastSessions` / `sendRow` / `sendGone` / `announce` / `rememberApproval` / `Subscription` / `MuxConnection` 的会话语义 / `projection` 字段与两条监听器。

形状：

```ts
export type SessionStreamFactory = (wire: Wire) => SessionStream;
export function createMuxServer(factory: SessionStreamFactory, options: MuxOptions = {}): MuxServer;
```

- `accept(sink)` 的**签名不变**：内部 `const wire = new Wire(sink, resolveWireOptions(this.options))`，`const stream = this.factory(wire)`，登记 `{ wire, stream }`，然后 `await stream.start()`（**必须 await**：现状 `accept` 返回前 overview 已经写出，`muxUpgrade` 的 waiting 缓冲区依赖这一点——在 `accept` 返回之前到达的上行帧必须晚于 overview 才被 replay），最后 `sink.ping()`。
- **wire 自己关掉一条连接时，订阅必须当场摘掉**（票 02 的遗留，`## Comments` 记着）：今天 `Wire` 因停滞期限或 ping 容忍度耗尽而自关，`MuxConnection` 的 `closed` 标志与订阅 teardown 要等到下一次 `pingAll` / `heartbeatAll` 撞见 `isClosed` 才发生，这中间 session stream 还在为一个不再有读者的连接翻译帧（帧被 wire 丢弃，所以不可观察，但 spec User Story 6「关掉窗口后后端立刻停止为它造帧」正是这句话）。本票给 `Wire` 一个**关闭回调**（构造选项或 `onClose(listener)`，一个就够），mux 在造 wire 时挂上"从集合里忘记这条连接并 `stream.dispose()`"，让自关与外部 `close()` 走同一条收尾路径。`forget(connection)` 保持幂等。
- `handle(connection, text)` → `connection.stream.handle(text)`；`forget` → `stream.dispose()` + 出集合。
- 两个定时器：`tick()`/`notePong()` 走 wire，`heartbeatAll()` 走 `wire.heartbeat()`。
- `close()`：`shuttingDown = true`、清定时器、对每条 `stream.dispose()`、清集合。**不再有** `stopRows`/`stopGone`。
- **mux.ts 的 import 里不得再有** `SessionHub` / `SessionProjection` / `PendingApproval` / `SessionRow` / `SessionSnapshot` / `AgentSessionEvent` / `UnknownSessionError` / `./hub.ts` / `./projection.ts`（spec User Story 12 的机械证据；`grep` 自查一行写得进 PR 描述）。

### 第 4 步：`boot.ts` 接线

- `const answers = createApprovalAnswers();`
- `const mux = createMuxServer((wire) => createSessionStream(wire, { hub, projection, answers }), options.mux ?? {});`
- `sessionListeners` 改为收 `{ hub, answers }` + `projection`：`onRunFailure` → `console.error` + `hub.publishFailure(sessionId, message)`；`onApproval` → `answers.remember(...)`；`onCreated`/`onRenamed`/`onRemoved` 不变；`onDirectoryListingChanged` → `hub.publishResync()`。
- `muxUpgrade` 一个字不改。`BootedServer` 的公开面不变（`mux` 仍然是 `MuxServer`，`hub`、`projection` 仍在）。

### 第 5 步：`projection.ts` 把行交给 hub

- `publish()` 末了 → `hub.publishRows(next)`；`forget()` → `hub.publishGone(sessionId)`。
- 删 `RowListener` / `RowGoneListener` / `onRow` / `onGone` / `listeners` / `goneListeners`（它们唯一的消费者是 mux 的两条监听器，第 3 步已删）。`SessionProjection` 接口随之瘦身。
- 依赖方向从此是 `projection → hub`（spec 不变量 4），`hub → 无人`。

## 测试

- `node scripts/smoke-subscribe.ts`（票 01）全绿，**只允许改 `openRig()` 一个函数**（`createMuxServer` 的第一参从 `(hub, projection)` 变成工厂）。断言一字不改。
- `node scripts/smoke-mux.ts` L120、`smoke-stream.ts` L103、`smoke-approval.ts` L781 的三处装配按新 `createMuxServer` 形状改（断言不动）。
- `npm run check` 绿（含 `check-server-facade`）。
- 全量 smoke（`README.md` L135-159 清单）：与改动前逐条同色，零新红。
- 机械自查写进 PR/提交信息：`grep -n "sessionId\|baseline\|Approval\|Projection" packages/server/src/mux.ts` 只命中注释；`grep -n "from \"./mux.ts\"" packages/server/src/**/*.ts` 只剩 boot 与 http 层。

## Comments
