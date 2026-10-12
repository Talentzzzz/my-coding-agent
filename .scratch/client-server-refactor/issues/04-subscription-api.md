# 订阅 API 与引用计数的形状

Type: grilling
Status: open
Blocked by: 03

## Question

**研究票 01 已经把这条前提纠正了**（`../research/dsh-portability.md` §1.1、§1.2）：DSH 的 `retain(session, { source })` / `release()` 是**浏览器侧的对象所有权计数**——不持久化（`SessionRetainInfo` 的 JSDoc 写着 "Local ownership counts, independent of catalog membership and never persisted."），归零只关掉该会话的**逻辑流**，而 Host 不回收会话、agent 不停。所以本图要借的性质是"**客户端显式订阅决定开不开这条逻辑流**"，而不是"服务端按引用计数保活"。服务端仍需要一份"这条连接订阅了哪些会话"的表（否则不知道往哪发），但那份表**与会话的生命周期无关**——那件事归票 09。

引用来源的清单两边也不同：DSH 有 **10 个具名 source 键**，其中 6 个是"一次异步操作期间"的短命持有（还有一个只有声明、没有生产调用点）；本仓库今天的消费者只有"那个正在跑的会话"（`packages/web/src/main.ts:370` 只在 `snapshot.submitting` 时挂流）。窗口形态票（03）定了之后，这里的来源清单才有意义。

要钉死的是：

1. **retain 的时机与粒度**。订阅是按**会话**计数，还是按（标签页 × 会话）？原型（票 03）定了窗口形态之后，引用来源有哪几类？每一类在什么时刻 retain、什么时刻 release？
2. **retain/release 走 REST 还是走 WebSocket 上行帧**。传输换成 WebSocket mux 后（2026-10-12，见 `map.md`「为什么改回 WebSocket」），这条不再只有一个答案：命令面保持 REST 的地图决定没变，但 DSH 的订阅本身就是上行 `open/cancel` 帧（`stream-protocol.ts:235-244`），而"订阅"更接近流控制而非命令。本票要把边界钉死：哪些动作算命令（REST），哪些算流控制（mux 帧）。若走 REST：`POST` 到哪个资源？请求体长什么样？它算不算"必须跑在活跃会话上"的那类请求——也就是它要不要拿一条 `claim`？
3. **归零意味着什么**。今天的答案是"按 claim 回收会话"（`packages/server/src/hub.ts:231-241`），且 release 之后 `RELEASE_GRACE_MS = 2000` 还留着一条只为浏览器自动重连而存在的宽限（`packages/server/src/stream-registry.ts:16`、`docs/architecture.md:248`）。**传输切换后这条宽限的原始理由整体消失**：WebSocket 没有浏览器自动重连，宽限当初要覆盖的东西（EventSource 按 3000/5000 ms 自行重连）不复存在。研究票 02 查出数字本身是错的（Chromium 3000 ms、Firefox 5000 ms 都大于 2000 ms，`../research/sse-multiplex.md` Q1）这条保留为旧文档漂移的记录。本票要决定：宽限随 `EventSource` 一起退场，还是给"重连中的订阅"留一个短宽限（那是票 07 的退避与票 05 的信封定了之后才谈得上的问题）。归零本身是"停止往这条连接发这个会话的内容"，还是"回收会话"？两者是**不同**的决定。
4. **谁负责发基线**。新订阅一个会话时，是 retain 这个动作的**响应**里带一份快照，还是 retain 之后服务端在新通道上推一帧基线？这决定了"订阅"与"基线"是不是同一个原子动作（对比 DSH 的"打开或切换会话 = 基线 + 增量，不是补发"）。
5. **没有订阅者时失败怎么办**——这条的下游是票 08，不在这里决定。

**已定前提**：`claim` 不重命名、不在本票讨论（见票 09）；不引入游标（见票 06）。

## Answer

<!-- 解决时在下面追加。 -->
