# Spec：活半/冷半 baseline 决策上移 hub（`subscribe` 原语）

Status: ready-for-agent

## Problem Statement

窗口用户打开一个会话时享有的 no-gap 保证——「先看到状态，再看到其后的每个变更，按发生顺序」——如今一半是 hub 的原语（`watch` / `snapshotNow` / `snapshotOf`），一半是 mux 遵守的一条**约定**：「`watch` 之后必须在同一同步块内写 baseline」。约定靠 mux 的自觉与 smoke 兜底，而不是机制兜底；并且活半/冷半的 `isLive` 分岔在 mux 里出现两处（open 路径与重发路径）。从维护者视角看，这是一次分层泄漏：**「活半还是冷半、baseline 从哪读」是会话状态的决策，却住在帧层**——按本仓库的分层判据（函数回答的问题离开 HTTP/WS 是否成立），它应当归 hub。

## Solution

hub 新增一个原子订阅原语 `subscribe`：**注册 + 活冷分岔 + baseline 交付**在 hub 内部一体完成——活半在同一同步块内同步交付快照，冷半读盘后异步交付恰好一次。mux 收到的只有「结果」：它不再知道活半冷半的存在，剩下的全部职责是帧本域（连接、帧编解码、backlog 扣帧与冲刷、teardown、overview 装配）。REST 链路、Router、controllers 一个字不动；`watchers` / `feedMap` 簿记不动（ADR-0001、ADR-0023 的边界原样）。

收益的性质：no-gap 的注册-快照原子性从「调用方必须遵守的约定」升级为「hub 的机制」——想违反都没有违反的写法；两处重复的活冷分岔归一；mux 对「活冷」概念失明。

## User Stories

1. As a 窗口用户，I want 打开一个正在运行的会话时立刻看到它的当前状态（含正在写出的 partial），so that 我看到的第一帧就是最新状态而不是上一次落盘的旧状态。
2. As a 窗口用户，I want 打开一个空闲（冷）会话时看到从盘上重放的完整会话记录，so that 我能浏览从未在本窗口观看过的历史。
3. As a 窗口用户，I want 冷会话 baseline 读盘期间开始的运行内容不早于 baseline 帧出现，so that 会话记录永远不会往回跳。
4. As a 窗口用户，I want 对同一会话的重复 open 只刷新状态而不重复订阅，so that 同一条连接上不会出现两份并行的事件流。
5. As a 窗口用户，I want 打开一个不存在的会话时收到带归因的错误帧和干净的流结束，so that 面板给出明确的失败提示而不是永远安静。
6. As a 窗口用户，I want 会话被删除（或进程收摊）时正在观看的流以 end 干净收尾，so that 没有任何面板悬挂在等不来的事件上。
7. As a mux 维护者，I want mux 不再包含任何活半/冷半的会话状态分岔，so that mux 的全部代码只剩帧与连接的本域，职责判据（问题离开 HTTP/WS 是否成立）在代码上成立。
8. As a hub 维护者，I want 「注册与快照原子」由 hub 内部机制保证，so that 未来任何新调用方都写不出违反 no-gap 的用法，而不依赖 smoke 兜底。
9. As a hub 维护者，I want 活冷分岔只存在一处（hub 内部），so that 读法变更（例如快照成本优化）只需要改一个地方。
10. As a smoke 维护者，I want no-gap 的守约检查直接在 hub 缝上进行，so that 检查的是机制本身而不是 mux 是否恰巧遵守约定。
11. As a smoke 维护者，I want 现有 mux 端 smoke 的断言一字不改，so that 它们成为「外部行为不变」的回归保障，实施者不必重新推导帧级契约。
12. As a 未来订阅方（非 WebSocket 的会话观看者），I want 直接调用 hub 的 `subscribe` 拿到与 mux 完全相同的原子订阅语义，so that 新订阅面不必重新实现 no-gap。
13. As a AFK agent 实施者，I want 一份明确列出「搬什么、不搬什么」的边界清单，so that 我不会把 backlog/冲刷这类流本域状态误搬进 hub。
14. As a AFK agent 实施者，I want 冷路径异步性与「onBaseline 恰一次」写进 hub 公开面契约，so that 我不必从 mux 的现有用法反推调用语义。
15. As a 代码审查者，I want no-gap 契约的「两半保证」（hub 机制半 + mux 帧序半）与它们之间的缝写进文档，so that 后续改动知道哪半归谁。
16. As a 桌面外壳维护者，I want 关机路径（close → 报丧 → 清表）行为不变，so that Electron 收摊时序不受本次重构影响。

## Implementation Decisions

- **hub 公开面新增 `subscribe(sessionId, watcher, sink)`**。契约（来自本次设计讨论，非原型）：
  - `watcher`：形状沿用 `SessionWatcher`——注册同一拍以 feeds 回调（恒交，冷会话同样成立）；`undefined` 仍只在会话删除或进程收摊时到达。
  - `sink.onBaseline(snapshot)`：**恰好一次**。活半在 `subscribe` 返回前的同一同步块内同步回调；冷半在盘上重放完成后异步回调。
  - `sink.onError(error)`：冷读取失败（含未知会话）恰好一次；错误归因的**措辞**（用户可读的帧文案）留在 mux。
  - 返回值：停止观看的退订函数，语义与现 `watch` 相同（宽容、幂等）。
  - 旧 `watch` 的去留（保留为底层或被 `subscribe` 取代）由实施者按调用方数量定；**不得**保留任何「裸注册、分岔交调用方」的公开形状。
- **活冷分岔唯一化**：open 路径与重发路径（对已订阅流的第二个 open、`branch_changed` 触发）共用 hub 侧决策（`subscribe` / rebaseline 语义）。「已欠一份 baseline 不再重读」的去重是 backlog 状态，留 mux。
- **读盘归 hub**：冷 baseline 的盘上重放（现经由 `snapshotOf`）由 hub 内部完成；mux 只收结果或错误。
- **明确不搬的清单**（它们是单条流上的帧秩序，搬动即让 hub 认识帧）：`Subscription.backlog` 的扣帧与按序冲刷、baseline 帧写出的读者计数（审批 show/hide）、冷读取期间的 cancel 竞态检查、`endStream` / `failStream` / teardown、overview 的 projection 装配（projection 建在 hub 之上，hub 不认识自己的派生物）。
- **no-gap 契约一分为二**，两半都写进注释：hub 保证「注册与快照原子」（机制）；mux 保证「baseline 帧先于 backlog 中任何帧写出」（JS 单线程下由同步写天然成立，论证落在代码注释）。
- **冷路径使 hub 公开面新增异步成员**——`hold()` 已有先例，不破戒。
- **签名陷阱**：不得让调用方拿到「一半决策权」（例如返回 `Snapshot | undefined` 让 mux 自己分岔）——那等于没搬。分岔必须在 hub 内部完成后只交付结果。
- **与 ADR 的关系**：是 ADR-0013（per-session 簿记归宿主所有）的**延伸而非矛盾**——本次把「baseline 读法」也归给宿主；与 ADR-0001（命令留 REST）、ADR-0009（open 走 mux 帧）、ADR-0023（传输簿记 watch/feedMap 留传输层）一致，均不动。
- **smoke 对齐**：现检查「mux 是否守约」的断言改为直接测 hub 机制。

## Testing Decisions

- **只测外部行为**，不测内部实现：不检查 mux 内部是否调了某个私有方法，只检查帧序与回调时序的可观察结果。
- **新增一条缝：hub 级 smoke**（不接 WS、不接 mux，直接构造 hub + 脚本化编排层，prior art：smoke-projection.ts 的 hub 级直接构造）。覆盖：
  - 活半：`subscribe` 返回拍即已交 feeds，`onBaseline` 同步到达，且注册后、快照前不可能有事件落入缝隙（以同步 emit 验证）。
  - 冷半：`onBaseline` 异步恰一次，读取期间发布的事件出现在 baseline 交付之后（经调用方扣帧）。
  - 未知会话 / 读盘失败：`onError` 恰一次，`watcher` 不再回调。
  - 删除/收摊：`watcher(undefined)` 到达，退订函数幂等。
- **回归缝（不加断言）**：现有 smoke-mux、smoke-mux-live、smoke-mux-client、smoke-stream 的断言一字不改，仅随装配调整；它们从 mux 公开面钉住帧序行为不变——baseline 帧先于其后一切、endStream、cancel 后不写帧。prior art：smoke-backpressure.ts（写侧有界）、smoke-mux.ts（帧序）。
- 缝总数：**新增一条**（hub 级），其余全部复用。

## Out of Scope

- REST / Router / controllers 的任何改动；命令上帧（command-over-WS）不做。
- `watchers` / `feedMap` 簿记的形状或归属变化（ADR-0023 已裁决）。
- overview / projection 的装配方式变化。
- mux 帧协议、wire 格式、客户端（web 包）的任何改动——本次对客户端完全不可见。
- 不引入 ack / requestId / 帧化命令（ADR-0001）。

## Further Notes

- 分层判据（本次讨论的结论，供实施者复查每个函数的去向）：**这个函数回答的问题，离开 HTTP/WS 还成立吗？成立 → hub；不成立 → 边缘。**
- 文档对齐：`docs/architecture.md` 的 no-gap 段落需随「两半保证」更新；本次是否够格写新 ADR 按 `docs/adr/README.md` 的三条门槛判断（倾向：更新 architecture.md 对应章节 + 必要时 notes.md，而非新 ADR——公开面变化可逆、取舍已在此 spec 记录）。
- 顺序论证的依據是 JS 单线程 + hub 内同步块：`subscribe` 返回后 mux 同步写 baseline 帧，任何 emit 只能发生在下一个事件循环拍——该论证必须随代码注释迁移，不得散佚。
