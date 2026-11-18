# 03 - server：mux 迁移到 `subscribe`——活冷分岔出帧层，mux 只剩帧本域

Type: task
Status: done
Blocked-by: 01, 05

## 背景与指针

- Spec：`Z:/my-coding-agent/.scratch/hub-subscribe-baseline/spec.md`（Solution + Implementation Decisions 第 2/4/5 条 + User Stories 7/11/13/16）。
- 现状代码：`packages/server/src/mux.ts`——`open()` L225-261（第一处分岔）、`readColdBaseline()` L284-300、`pushBaseline()` L386-396（第二处分岔）、`writeBaseline()` L360-377、`Subscription` L115-134。
- hub 侧产物：`packages/server/src/hub.ts` 的 `subscribe`（票 01）与 `rebaseline`（票 05）。
- 回归缝（断言一字不改）：`scripts/smoke-mux.ts`、`scripts/smoke-mux-live.ts`、`scripts/smoke-mux-client.ts`、`scripts/smoke-stream.ts`；`smoke-projection.ts` 的 `hub.watch` 用法已随票 01 调整。
- 边界清单的理由：spec Further Notes 的分层判据——「这个函数回答的问题，离开 HTTP/WS 还成立吗？成立 → hub；不成立 → 边缘。」

**本票只动 `packages/server/src/mux.ts`。hub.ts 若发现契约缺口，停下来报告而不是自己改 hub。**

## 改动

### 1. `open()` 迁移：删掉第一处活冷分岔

现 L257-260 的「isLive → snapshotNow 同步写 baseline / else readColdBaseline」整块删除，换成一次 `hub.subscribe(sessionId, watcher, sink)` 调用：

- `watcher` 回调体 = 现 L237-245 的 live 标志 + `bind` 逻辑，一字不差地搬；
- `sink.onBaseline(snapshot)` = 现 `writeBaseline(sessionId, subscription, snapshot)`（活半时它已在 subscribe 返回前同步执行——帧序 no-gap 的 mux 半由「subscribe 返回前同步回调、回调里同步 send」保持）；
- `sink.onError(error)` = 现 `readColdBaseline` 的 catch 体：归因措辞留 mux（`UnknownSessionError → 未知的会话：${sessionId}`，否则 `读不出这个会话的记录：${describe(error)}`）→ `failStream`。竞态守卫（`this.closed`、订阅身份、backlog 状态）原样保留在 mux 侧。
- `readColdBaseline` 整个方法删除——读盘与「活冷分岔」已归 hub，mux 里不再有任何 `hub.snapshotOf` / `hub.isLive` / `hub.snapshotNow` 调用。

### 2. `pushBaseline()` 迁移：删掉第二处活冷分岔

现 L386-396：活半半的 `snapshotNow` 分支与「已欠一份 baseline 不再重读」的 backlog 去重（`subscription.backlog !== null` 检查）都涉及活冷概念。迁移后的形状由两条原则导出（实施者按此设计，允许更简）：

- mux 不再问 isLive。对已持有的订阅重发 baseline：若本订阅的 backlog 已是 null（baseline 已发过、流在走增量），重发的 baseline 经 `push` 扣帧序保证落在已收帧之后——活半下这需要一个同步快照。**契约缺口已由票 05 补齐**：`hub.rebaseline(sessionId, sink)` 在 hub 内做同一个活冷分岔、活半同步交付、冷半异步恰一次；mux 只提供 sink 与自己的帧序守卫（订阅身份、`this.closed`、backlog 状态）。若实现中发现还有别的缺口（需要 hub 再加动词），停下来在报告里说明，不要自己改 hub.ts。
- 「已欠一份 baseline 不再重读」的去重是 backlog 状态（spec Implementation Decisions 第 2 条明文：**留 mux**）。

### 3. 明确不搬的清单（spec 第 4 条，逐项自检不在 diff 里出现）

`Subscription.backlog` 的扣帧与按序冲刷；baseline 帧写出的审批读者计数（`answers.show/hide`）；冷读取期间的 cancel 竞态检查；`endStream` / `failStream` / `teardown`；overview 的 projection 装配。这些留在 mux，一个字不改其职责。

### 4. no-gap 两半保证的 mux 半（spec Implementation Decisions 第 5 条）

在 `open()`（或 `writeBaseline`）的注释里写下：hub 保证注册与快照原子（机制半，指向 hub.ts 的论证）；mux 保证「baseline 帧先于 backlog 中任何帧写出」——JS 单线程下由同步写天然成立：`subscribe` 返回前 `onBaseline` 已同步回调、回调内同步 `send`，任何 emit 只能发生在下一个事件循环拍。两半之间的缝（hub 交付结果、mux 决定帧序）写明。

## 测试

- **回归缝一字不改**（spec Testing Decisions 第 2 条）：`smoke-mux.ts`、`smoke-mux-client.ts`、`smoke-stream.ts` 的断言一行不动；若装配（rig 构造）必须调整，调整不触断言。全部跑绿。
- `npm run check` 绿。
- TDD：迁移前先跑一遍回归 smoke 记录绿基线；迁移后再跑，逐个对比通过集合一致。

### 已知基线（**不是你的活**，别修）

`scripts/smoke-mux-live.ts` 在集成分支 tip（也就是 `master`）上**本来就是红的**，与本次重构无关：它仍用 ADR-0021 之前的老装配 `POST /api/sessions`（不带 `text` 出生消息），于是 400、随后在 `running()` 处 `TypeError` 崩掉。基线输出存于 `.scratch/hub-subscribe-baseline/smoke-mux-live-baseline.txt`。

对它的要求因此降为：**失败集合不扩大**。做法是迁移后跑一遍，把输出与基线逐行比——只允许「一模一样的失败」，不允许出现新的 FAIL 行、新的崩溃点。**不要**去改它的装配或断言（那是另一件事，不在本 spec 范围）。

