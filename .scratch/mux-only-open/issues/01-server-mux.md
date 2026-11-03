# 01 - 服务端 open 幂等：重复订阅分支拒绝 → 重发基线

Type: task
Status: resolved
Blocked by: 无（本图第一张票，02/03 依赖它）

## Question

`packages/server/src/mux.ts` 的 `open()`（约 :285）对已存在订阅的重复 `open` 今天直接拒绝（发 "这条连接已经订阅了这个会话" 的 error 帧并 `endStream`）。按 ADR-0010 决定 1，把这个分支改为**重发一份基线**（`pushBaseline`），使 `open` 成为幂等原语："给我这个会话现在的快照 + 之后的事件"。

## 要点

- 重复分支重发基线用现成的 `pushBaseline(sessionId, subscription)`（分支移动已在用它），它内部走 `snapshotNow` + 各订阅级 diff 通道（`pushStatus` / `pushApprovalChanges`），幂等性由这些现成路径保证——**不要**手写第二份基线组装。
- 删除拒绝文案后，全仓搜索该中文文案，确认没有别处依赖它（含 smoke）。
- 这个分支正是"send 持有引用、pane 切走又切回"场景的落点：订阅还在、不发 cancel、重 retain 必须能拿到一份带 `partial` 的新快照。实现后对照该场景手动核一遍帧序。
- 帧序不变量（0001 的既有承诺）保持：`open` 之后第一帧仍是 baseline，订阅与基线是同一原子动作。

## 收账

- `npm run check` 绿。
- `smoke-mux-client` 的重复 open 用例按新语义改写（细节归 04 号票，本票先保证行为对）。
- Answer 节记录：改动 diff 要点、帧序核对结果。

## Answer

**`open` 成了幂等原语：重复订阅不再拒绝，而是再送一份基线。**（`packages/server/src/mux.ts`）

- `open()` 的重复分支：`error` + `endStream` → `pushBaseline(sessionId, subscription)`。文案「这条连接已经订阅了这个会话。」全仓已无运行时引用（只剩 `.scratch` 与 ADR-0010 里的记录，不动）。
- `pushBaseline()` 长出一条 idle 岔路，因为 `snapshotNow` 只对在跑的会话成立（`hub.snapshotNow` 对非 live **抛错**——票面没提，但重复 `open` 打在空闲会话上是常态）：
  - 在跑：原样 `push(... snapshotNow())`，同步，基线带 `partial`；
  - 不在跑：`subscription.backlog = []` 再交给现成的 `readColdBaseline()`。盘读是异步的，基线挂回 backlog 才保得住「先状态、后增量」，也才不用手写第二份基线组装（票面要求）。已有基线在路上（`backlog !== null`）时直接返回，免得读出两份。
  - `branch_changed` 走的仍是原来那条 `push`（buffered 时进 backlog），语义未变。
- `writeBaseline()` 的审批记账改成按**差值**移动（`hide` 基线里没了的、`show` 新出现的），不再整份重播：重复基线既不会把同一读者数两次，也不会洗掉已记下的答案——`hide` 到 0 会删条目，再 `show` 回来就成了「未答复」，那会把 grant 报成 deny。
- `endStream()` 的 `forget` 形参随拒绝分支一起删掉（只为它存在）；`failStream()` 的注释按两种入口重写。

**帧序核对（「send 持有引用、pane 切走又切回」，票面要求）**

- live：新基线与 `open` 同一同步块内送出，落在流中间；之后 delta 继续追加（smoke 断言 "the deltas kept coming after it"）。基线带 `partial`——切回正在跑的会话立刻有半句话。
- idle：`open` 期间无 feeds，基线由盘读异步产出；期间若会话开始运行，`bind` 先写基线并清空 backlog，盘读回来见 `backlog === null` 便不再写。一条流只多一份基线。
- 不变量不变：`open` 之后第一帧仍是 baseline，订阅与它仍是同一原子动作；重送的基线不改变这条，只在其后追加。

**`scripts/smoke-mux.ts`**：§2「重复 open 被拒绝」改为「再送一份基线、原流不受影响」；§5 新增「运行中重复 open → 基线带 `partial`、之后 delta 继续」（脚本正文 600 → 2000 字符，让这段窗口够长）；基线计数抽成 `baselinesOn` / `lastBaselineOn`。**注意**：重复 open 的用例在 `smoke-mux.ts`（服务端 wire），不在 `smoke-mux-client.ts`（客户端纯假 socket，没有服务端）；04 号票若仍要客户端侧「第二份基线替换在途流」的断言，得新写，`state.ts` 的 reducer 已有 baseline 替换的用例。

**留给 04**：`docs/architecture.md:386` 的注释「这条逻辑流的第一帧，且只有它一份」在分支移动时就已经不成立，本票后更不成立；本票没动它（该文件工作树里还有另一张未提交票的改动，一并入库会串票），三节改写归 04。

**验证**：`npm run check` 绿；`smoke-mux`、`smoke-mux-client`、`smoke-mux-live`、`smoke-projection`、`smoke-liveness`、`smoke-backpressure`、`smoke-approval{,-endpoint,-queue,-recovery}`、`smoke-stream`、`smoke-boot`、`smoke-replay` 与其余 smoke 全绿（`smoke-api` 需先起服务器，本轮未起，未跑）。

