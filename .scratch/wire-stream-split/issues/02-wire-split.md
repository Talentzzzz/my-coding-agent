# 02 - 拆出 `wire`：帧、字节、队列、停滞、ping、心跳全部搬进 `wire.ts`

Type: task
Status: ready-for-agent
Blocked-by: 01

## 背景与指针

- Spec：`Implementation Decisions / 分层与允许知道什么` 的 `wire` 行、`### mux` 的「保留」与「删除」两段、`不变量` 第 1 条。
- 现状代码：`packages/server/src/mux.ts`
  - 常量 L23-61（`PING_INTERVAL_MS` / `MAX_MISSED_PONGS` / `HEARTBEAT_INTERVAL_MS` / `STALL_BUDGET_BYTES` / `STALL_DEADLINE_MS` / `CLOSE_TRY_AGAIN_LATER` / `CLOSE_GOING_AWAY` / 两行 reason）
  - `FrameSink` L68-83、`MuxOptions` / `ResolvedMuxOptions` L90-106
  - 写侧：`queue`/`queuedBytes`/`stalled`/`stalledSince`/`stallTimer`/`missedPongs`/`closed` L144-160，`send` L186-199，`tick` L512-522，`notePong` L525-527，`missed`/`queuedByteLength`/`isClosed` L530-541，`close` L549-560，`markStalled` L567-574，`enqueue` L576-581，`pump` L588-601，`onStallDeadline` L608-615，`clearStallTimer` L617-621，`sizeOf` L632-634，`describe` L641-643
  - `heartbeat()` L502-505（帧内容 `{ streamId: null, item: { type: "heartbeat", everyMs } }`）
- 消费方：`packages/server/src/boot.ts` L8（`FrameSink` 导入）、L154-225 `muxUpgrade`（造 `FrameSink`）；`scripts/smoke-backpressure.ts` L22（`MuxConnection` / `ApprovalAnswers` / `FrameSink` / `ResolvedMuxOptions`）、L128/164/188/227/255（`new MuxConnection(sink, hub, options, answers)`）。

**本票是纯搬移，行为零变化。** 黑盒 smoke（票 01）必须一字不改地通过（除 `openRig()` 装配函数外——本票不要求改它）。

## 改动

### 1. 新文件 `packages/server/src/wire.ts`

搬进 spec 给 `wire` 列的**全部**职责，一项不多：

- `FrameSink`（原样搬，含它的四成员注释：`send` 的返回值是停滞策略唯一依赖的信号）
- `WireOptions`（原 `MuxOptions` 的六个字段改名沿用：`pingIntervalMs` / `maxMissedPongs` / `heartbeatIntervalMs` / `stallBudgetBytes` / `stallDeadlineMs` / `log`）+ `ResolvedWireOptions` + `resolveWireOptions(options)`（把 `createMuxServer` 里那段补默认值搬到一处）
- 七个常量与两行 reason
- `class Wire`：

```ts
class Wire {
  constructor(sink: FrameSink, options: ResolvedWireOptions)
  send(frame: ServerFrame): void      // 原 MuxConnection.send，一字不改（含「`false` 意味着这帧已进 socket 缓冲、绝不能重写」那条）
  heartbeat(): void                   // 原 MuxConnection.heartbeat
  tick(): void                        // 原 MuxConnection.tick（ping 一轮 + 容忍度）
  notePong(): void
  get missed(): number
  get queuedByteLength(): number
  get isClosed(): boolean
  close(): void                       // 原 MuxConnection.close 的**帧侧一半**：丢弃队列、清停滞簿记、清定时器
}
```

`Wire` 不知道任何会话概念：文件里不得出现 `sessionId`、`baseline`、审批、`SessionHub`、`SessionProjection` 这些词（注释除外）。

文件头写一段注释说明这一层知道什么、不知道什么（spec 那张表里 `wire` 的两行），以及**帧序不变量的第一半**：一条连接上的所有帧只经同一个 `Wire` 队列写出，所以"先 baseline 后增量"由队列顺序保证，不靠约定。

### 2. `mux.ts` 的 `MuxConnection` 改为持有一只 `Wire`

- 构造改为 `new MuxConnection(wire, hub, options, answers)`，或保留 `(sink, hub, options, answers)` 而内部 `this.wire = new Wire(sink, resolveWireOptions(options))`——**取后者**：`accept(sink)` 的签名不变，票 01 的 `openRig()` 一个字都不用改，这正是本票"零行为变化"的一部分。
- `send` → `this.wire.send(frame)`（保留原 JSDoc 里"同步且 void 是服务器其余部分依赖的接口"那段，挪到 `Wire.send` 上，`MuxConnection.send` 只留一行转发 + 一句"帧由 wire 写出"）。
- `tick` / `notePong` / `missed` / `queuedByteLength` / `isClosed` / `heartbeat` 全部转发给 wire。
- `close()`：先 `this.closed = true`、摘订阅（现状顺序，见 L549-560），再 `this.wire.close()`；`closed` 标志本票仍留在 mux（它管的是"还收不收上行帧"）。
- `pump` / `enqueue` / `markStalled` / `onStallDeadline` / `clearStallTimer` / `sizeOf` 从 mux.ts 删除（搬进 wire.ts）。
- mux.ts 里一个业务概念都不许删除（会话语义本票原样留着，票 03/04 才搬）：`open`/`cancel`/`bind`/`push`/`writeBaseline`/`pushBaseline`/审批差异这一整套本票不动。

### 3. 消费方

- `boot.ts`：`FrameSink` 的 import 改从 `./wire.ts`；`MuxOptions` 若是从 mux 导入的，改从 wire 导入（`createMuxServer(hub, projection, options)` 的第三参类型随之改）。
- `scripts/smoke-backpressure.ts`：`MuxConnection` → `new Wire(sink, resolveWireOptions({...}))`；`payloadFrame` 直接用 `wire.send`。**断言一条都不改**（它断言的全是写入行为：`false` 之后不越队、预算、截止时间、恢复后按序）。`ApprovalAnswers` 的 stub（L77-82）本票还从 mux.ts 导入——它随票 04 搬走。

## 测试

- `npm run check` 绿。
- `node scripts/smoke-subscribe.ts`（票 01 的产物）全绿，除 `openRig()` 外一字未改。
- `node scripts/smoke-backpressure.ts` 全绿（断言未改）。
- `node scripts/smoke-mux.ts`、`node scripts/smoke-stream.ts`、`node scripts/smoke-mux-client.ts`、`node scripts/smoke-liveness.ts` 全绿。
- 自查：`grep -n "sessionId\|baseline\|Approval" packages/server/src/wire.ts` 只应命中注释。

## Comments

- 实施记录：`Wire` 的关闭只有帧侧一半（丢弃队列、清停滞簿记与定时器）。`tick` 超出容忍度和停滞期限这两条路径自关 wire 之后，订阅的 `teardown` 要等 mux 下一次 `pingAll` / `heartbeatAll` 读到 `isClosed` 才经由 `forget` → `close()` 完成；在此期间 wire 已丢弃一切写入，且生产路径上 `sink.close` / `terminate` 已使 socket 不再交付上行帧，故帧面上不可观察。若后续票希望恢复「同步摘订阅」，需要给 wire 加一个关闭回调（不在本票，未做）。
- `scripts/smoke-backpressure.ts` 里的 `ApprovalAnswers` stub（连同它的导入）在改用 `Wire` 后已无消费点；按本票要求原样留给票 04 搬走，未删除。
