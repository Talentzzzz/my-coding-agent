# DSH 的哪些传输机制可以直接搬到这里

Type: research
Status: resolved

## Question

`deepseek-harness-master/` 是同工作区的第三方参考树，它的传输是"HTTP 一元 RPC + 一条 WebSocket mux"。本图要借的是它的**性质**，不是它的实现。请针对下列四件事，逐条判定"**哪些是纯传输层、能在 `node:http` + 单进程 + 无插件图的环境里重建；哪些依赖 Cordis 插件图、Typert 代码生成或浏览器插件生命周期，搬过来只会得到一个半成品**"：

1. **引用计数订阅**。`retain(session, { source })` / `release()` 的计数由谁持有——gateway、session-controller、还是 client connection？计数归零时服务端到底停止做什么（停止发布？关掉逻辑流？回收会话？）？上游引用来源有哪几类（视图、标签、subagent 面板、侧边栏），各自在哪一行 retain？
2. **客户端的窗口与基线**。开一条逻辑流时的"开场基线"由谁决定（客户端请求条数？服务端给窗口？），本地窗口是原子替换还是追加？总结文档 §9 说"在客户端窗口代码里没有找到淘汰常量"——请确认这条，并说明长时间运行的会话在被引用期间窗口是否持续增长。
3. **概况与内容分道**。侧边栏的"是否在跑 / 标题 / 时间"走的是哪一条通道、投影 store 由谁维护、更新时机在哪？它与逐条内容通道在协议层是分开的两条流，还是同一条流上的另一类帧？
4. **重连的两层**。物理层（mux 重建连接的退避表）与逻辑层（每条流自己重开、拿新基线替换本地）分别落在哪个文件/函数？"通知类不重放"这条规则在代码里的体现是什么？

**范围**：以 `deepseek-harness-master/` 的实际源码为准，不要只读它的 README 与 `tmp/dsh-client-server-summary.md`（那份总结是二手笔记，已知它自己也留了一个未确认点，见第 2 条）。至少覆盖 `packages/api/gateway/`、`packages/api/session-controller/`、`packages/client/connection/`、`packages/host/webserver/`、以及两份 agent note（`.agents/notes/implemented/architecture/2026-09-19-remote-duplex-stream.md`、`2026-08-18-session-history-and-event-transport.md`）。

**产出**：`.scratch/client-server-refactor/research/dsh-portability.md`。每条结论都要有 `文件:行号` 引用。最后给一张"可搬 / 需重写 / 搬不动"的三列表，并对"需重写"的每一条说明重写的形状。不要给本仓库的改造建议，只报告 DSH 的事实与可移植性判定。

## Answer

资产文件：[`research/dsh-portability.md`](../research/dsh-portability.md)（每条结论均带 `deepseek-harness-master/` 内的 `文件:行号`，并附与二手笔记的逐条对账）。

**要点**

1. **引用计数是浏览器侧的机制，不是服务端机制。** 计数器在 `packages/api/session-controller/src/client/sessions/service.ts:243`（`ClientSessions.scopes`）与 `:536-539` / `:540-550` 的加减一处，`retainedBy` 按 source 分别计数（`client/contract/sessions.ts:42-46`）。归零时 `retireScope()`（`service.ts:576-585`）做的是：标记 record 失效 → `manager.drop()`（`client/sessions/manager.ts:184-191`）→ `Session.dispose()` 关掉该会话的 journal 逻辑流（`client/sessions/session.ts:599-611`）。**Host 什么都不停止**，也不回收会话（`packages/api/session-controller/README.zh.md:76`「不保活 Host Agent」）；"没人订阅就不推送"是 `history.ts:124-175` 的 follower 生命周期带来的后果，不是计数驱动的。
2. **上游引用来源共 10 个声明合并的 source 键**，分两类：长命持有 `mainView`（声明 `ui-session/src/client/index.ts:183`，调用 `ui-workspace/src/client/navigation.ts:382`）、`sidebarView`（`ui-sidebar-right/src/client/session-view.ts:6`/`:33`）、`sidebarChat`（`ui-subagent/src/client/sidebar-chat/index.tsx:30`/`:109`）；一次操作期间的短命持有 `workspaceOperation`、`commandCatalog`、`skillCatalog`、`goalActivation`、`referenceCandidates`、`gateway`、`controllerOperation`。其中 `controllerOperation` **只有声明没有生产调用点**。
3. **开场基线由客户端决定**：`HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }`（`client/sessions/session.ts:52`、`:54`、`:631`），服务端只兜底 `DEFAULT_MAX_MESSAGES = 50`（`history.ts:38`）；切页算法 `paginate()` 在 `history.ts:392-427`。本地窗口**原子替换**（`client/contract/events.ts:148-151`，由 `journal-stream.ts:288-303` 的 `replace` 驱动）。
4. **二手笔记 §9 的未确认点：确认。** 客户端窗口没有任何淘汰常量：窗口是 `leaf|concat` 不可变树（`client/contract/events.ts:37-58`），`append` 只往后接（`:167-174`），唯一会缩小的 `settleAssistant()`（`:181-196`）只丢当前 attempt 的 transient 行。**被引用的长跑会话窗口随每条 durable 事件线性增长**；`assistant-stream.ts:48` 的 `publishedSeqs: Set<number>` 同样只增不减。
5. **概况与内容分道成立，而且是三条逻辑流**：每会话一条 `session.follow` journal（`client/transport.ts:137-169`）；全 Host 一条 `session.control` 快照流（Host `control.ts:42-53`，帧 `types.ts:579-581`，客户端 `transport.ts:115-134`）承载投影值（title 等），store 是 `manager.ts:101` 的 `ProjectionValueStore`，更新时机是 Host `sessionProjections.onChanged` → `control.ts:22-30`；`running` 则**既不在这两条上**，走 `$events` 转发事件（`index.ts:181` → `client/index.ts:118-120`）。三者同在 `/api/remote.mux` 上按 `streamId` 分道（`stream-protocol.ts:7`、`:235-257`），**不是同一条流上的两类帧**。
6. **重连两层**：物理层是 `ws` + `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'`（`stream-server.ts:7`、`stream-protocol.ts:7`），退避表在 `ConnectionController`（`client/connection/src/client/connection.ts:139-147`；默认 cap 500→1000→2000→4000→8000→10000，实延 50–100% cap，`recovery-config.ts:6`、`:26-28`），心跳是协议层 Ping/Pong（`stream-server.ts:105-124`，默认 2000ms，`gateway/src/index.ts:137`）。逻辑层每条流自己重开（`remote-stream.ts:132-142`、`:160-197`），每个新 generation 用 `replace` 换掉本地（`journal-stream.ts:261-303`、`snapshot-stream.ts:71-89`）。**"通知不重放"只覆盖 `emit`**：`broadcastRemoteEvent` 不排队（`gateway/src/index.ts:539-547`），但**未结算的 waterfall 会重投给新 generation**（`:512-513`）。

**与 `tmp/dsh-client-server-summary.md` 矛盾之处（6 条，出处见资产文件相应小节的证实/证伪标注）**

| # | 笔记的说法 | 实际 |
|---|---|---|
| 1 | §5 把引用计数写成服务端通道生命周期 | 计数完全在浏览器 Client 对象层；`packages/api/gateway/` 与 session-controller 的 Host face 都没有它 |
| 2 | §5「引用归零 → 通道关闭」 | 客户端关该会话的 journal 流；Host 不回收会话、agent 不停（资产 §1.2） |
| 3 | §5 引用来源列了 4 类"视图/标签/面板/侧边栏" | 真实是 10 个具名 source 键，其中 6 个是"一次异步操作期间"的短命持有；`controllerOperation` 无生产调用点 |
| 4 | §7「通知类不重放」当铁律 | 例外：pending 的 `waterfall`（审批/提问）会重放给新 generation（`gateway/src/index.ts:512-513`） |
| 5 | §10「上行没有生产消费方」 | 只对 mux 上行帧成立；审批/提问的回答**在生产里**走上行，只是走独立的 unary `$events/result`（`stream-protocol.ts:13`、`client/remote-events.ts:218-223`） |
| 6 | §9「有明确上限（上行 inbox 缓冲、窗口预算）」 | 上行 inbox 有上限（`streamInboxBytes`，默认 262144，`gateway/src/index.ts:138`/`:204`）；**窗口预算在客户端会话窗口里不存在** |

总结 §6 的 50/500/2-turn 数字、§7 的退避序列、§2 的"SSE 只用于 `/plugins/events`"三条**与源码一致**；总结 §8 与 §1 未逐行核对，标未确认。

**可搬 / 需重写 / 搬不动**：完整表、逐条理由与重写形状见资产文件 §五。该表按 SSE 前提写成，传输换 WebSocket 后哪些判定翻转，见 `map.md` Notes 的声明。

**2026-10-12，票 11 解决时追加（本票仍 open，这里登记一条本票顺手核实的 DSH 事实：它下行的写侧不处理背压）**：票 11 要回答"`write()` 返回 `false` 之后怎么办"，于是把 DSH 的对应位置读了一遍——`deepseek-harness-master/packages/api/gateway/src/stream-server.ts:274-293` 的 `RemoteStreamMuxConnection.send()`：它把每个下行帧串到一条 `this.writes` 的 Promise 链上，并**等 `ws.send(text, cb)` 的回调**才算这次写完成。这条链**是**一种背压（上游 `await` 它，所以逻辑流的泵会在写不出去时停住），但它**没有任何字节或时间上限**：等待者会一直堆，而 `bufferedAmount` 一次都没被检查过。也就是说 DSH 把"无界缓冲"从 socket 的队列搬进了自己那条 Promise 链，**不能当作"背压已经解决"的先例**。本仓库的写侧路径不同（`send()` 同步、不 `await`），所以票 11 另定了一对有界参数（4 MiB / 10 秒，超限关连接）——见 `issues/11-backpressure.md` 的 `## Answer`。**本票的十五条判定不受影响**（它回答的是"能不能搬"，而这一条根本不在可搬清单里）。
