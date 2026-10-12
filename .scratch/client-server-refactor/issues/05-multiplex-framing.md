# 多路复用帧协议

Type: grilling
Status: open

## Question

今天的 wire 是 `packages/core/src/protocol.ts:246-279` 的 8 个 `ServerMessage` 成员，**全部由 `packages/server/src/stream-registry.ts` 一个文件发出**，且一条 HTTP 响应 = 一个会话。换成一条常驻通道之后，需要一层信封把 N 个逻辑流分开。

要钉死的是：

1. **分道标识**。`streamId` 是会话 id 本身，还是"订阅 × 会话"的一次句柄（同一个会话被两个消费方订阅时是同一条流还是两条）？—— 这与票 04 的计数粒度互为镜像，所以先解票 04。
2. **帧的种类**。至少需要：开（带基线）、数据、关、错。今天有 `session` / `session_event` / `entry` / `tool_approval_request` / `tool_approval_settled` / `status` / `error` / `stream_end` 八个成员，逐一判定它们在新信封下是"某个逻辑流的一帧"还是"整条连接的一帧"（`status` 与 `tool_approval_*` 尤其模糊）。
3. **`stream_end` 的去处**。D2（`docs/notes.md:45`）把它定为"空闲流与运行结束合用一个终帧"，理由是"对浏览器而言两种结束是同一个事实"。常驻通道里没有"结束这条流"这种生命周期——本票要给出它的替代：**取消订阅**是一个帧，还是 retain/release 请求的副作用？
4. **心跳与判活**。传输换成 WebSocket 后形状变了：RFC6455 的 Ping/Pong 是协议层控制帧，JS **观察不到**（浏览器自动回 pong），但服务端可以用它**主动判客户端死**（DSH 的形状：`ws` 的 `socket.ping()`、`MAX_MISSED_HEARTBEATS = 2`、第三次 tick `terminate()`、默认间隔 2000 ms，`../research/dsh-portability.md` §4）。要钉死的是：服务端判活用协议层 Ping/Pong 还是应用层帧；客户端判活用什么（DSH 没有客户端 watchdog，靠 `$events` 的代 + `ConnectionController`——本仓库的对应物由票 07 定）；心跳是连接级的还是流级的。SSE 时代"心跳必须是命名事件才能被 JS 观察到"的前提**作废**（研究票 02 Q2 的结论保留为历史记录）。
5. **信封的位置**。信封加在 `ServerMessage` 外层（`{ streamId, frame: ServerMessage }`）还是把 `streamId` 塞进每个成员？前者让 `state.ts` 的 reducer（`packages/web/src/state.ts:128-185`）先按流分派再按类型分派，后者污染今天的联合类型。给出取舍与推荐。
6. **写边界的类型**。`packages/server/src/http/event-stream.ts:24` 今天是 `send(message: unknown)`——**唯一的序列化点上协议类型完全不受检查**（审计第 7 节第 10 条）。新信封要不要顺便把它收紧。

**已定前提**（2026-10-12 随传输重开更新，见 `map.md`「为什么改回 WebSocket」）：一条常驻 WebSocket 承载多路复用；旧 `/events` SSE 端点的去留由本票决定；发送路径的命令继续走 REST。DSH 的帧协议 `{streamId, endpoint, payload}` + 下行 `item/error/end`、上行 `open/cancel/item/end`（`../research/dsh-portability.md` §五 判"可搬"）是直接参照。

## Answer

<!-- 解决时在下面追加。 -->
