# 断线检测与重连策略

Type: grilling
Status: open

## Question

这是验收第 4 条的全部内容，也是审计里最实的一个洞。

**今天的状况**：唯一的存活信号是每 15 秒一行 SSE 注释 `: ping`（`packages/server/src/http/event-stream.ts:35,63-67`），而客户端只监听 `message`（`packages/web/src/client.ts:131`）——**注释不产生事件，它根本读不到**。于是 `connected` 这个状态位只在请求成功时置 `true`、只在 `fetch` 抛 `TypeError` 时置 `false`（`packages/web/src/main.ts:324-335`）。没有请求在飞时，重启服务器甚至拔网线，`connected` 都是 `true`。更糟的一种：代理**静默断开 TCP**（无 FIN/RST）时，`clientGone` 不会 settle（它挂在 `response.on("close")` 上），`RELEASE_GRACE_MS` 因此永不开始，claim 被永远握着，而 `: ping` 往死 socket 上写还一直"成功"。

要钉死的是：

1. **判活信号**。传输换成 WebSocket 后：服务端判活可以直接用 RFC6455 协议层 Ping/Pong（DSH 的形状，`../research/dsh-portability.md` §4）；客户端一侧的"连接已死"判定要**自己建**——浏览器不把 pong 暴露给 JS，可选形状是读超时 watchdog，或 DSH 式靠"代"超时（`generationReadyTimeoutMs = 15000`）。间隔多少、多久没收到就判定已死、判定之后做什么。
2. **`connected` 的语义**。它今天已经被重定义过一次（`packages/web/src/main.ts:316-323` 的注释："服务器答过一次请求"）。常驻通道之后它应该回到"连接是否活着"，还是分成两个状态（"服务器可达"与"流通道活着"）？下游的 `packages/web/src/render/statusbar.ts:46-55` 与 `composer.setDisabled` 要跟着改。
3. **重连的退避**。浏览器**不会**自动重连 WebSocket——退避完全归客户端，这是换传输后**新增的自建件**。研究票 01 给了 DSH 的确切形状（`../research/dsh-portability.md` §4.1）：退避表 500→1000→2000→4000→8000→10000 ms（cap），实际延迟是 cap 的 50–100%（抖动），"一次尝试"另有硬截止 15000 ms；三方分工是 `ConnectionController` 独占退避时间轴、mux 客户端只做物理替换、每条逻辑流自己的重开节奏。本仓库要照抄这套分工，还是合并成更小的一层（DSH 那套分层的前提是"物理 mux 可复用"，本仓库同样具备这个前提了）。

**换传输后消失的不对称**：DSH 的心跳是 RFC6455 协议层 Ping/Pong（默认 2000 ms，服务端实现，`MAX_MISSED_HEARTBEATS = 2`，第三次 tick `terminate()`——最坏约 6 s 判死），浏览器自动回 pong 但不把 pong 暴露给 JS。SSE 时代"服务端无法主动判客户端死、判定方向只能反着来"的那条核心约束**随 `EventSource` 一起消失**；代价是客户端判活也失去了浏览器的帮助——没有自动重连，也没有可观察的 pong，全要自己建（第 3 条）。
4. **服务端一侧的死连接判定**。今天服务端只能等 `response.on("close")`。心跳写出去了但对面早已消失，服务端要不要主动判定并释放 claim？`docs/architecture.md:263` 把"泄漏的流 = 关不掉的服务器"当成一条承重事实——研究票 02 会核实这个断言。
5. **判定死亡之后，状态怎么收敛**。reconnect 之后每条逻辑流各拿一份新基线（票 06）；但**运行本身**是纯内存的，服务端重启后它已经没了。今天客户端会经历"transcript 冻住 → 悄悄少掉正在进行的那一轮 → 15 秒后 streaming 消失"。新模型要给出一个诚实的表现。

**研究票 02 的事实哪些还承重**（2026-10-12 传输切换后重述）：Q1/Q2 的 `EventSource` 语义（重连间隔、命名心跳、204、`Last-Event-ID`）**全部降级为参考对照**——它们描述的机制随 SSE 退场；唯一还活着的应用是"旧 `/events` 端点在过渡期还跑不跑 SSE"（票 05 决定）。仍然承重的是 Q3：服务端判死之后的清理路径、以及"只要有一条响应没结束，`server.close()` 的回调就不发生"。**WebSocket 侧的平台事实还没有研究票**（票 17）：无自动重连的规范性确认、断开时的 `close` code/reason 与 `error` 事件的确切语义、隐藏窗口节流等，在此之前按"未确认"设计。

## Answer

<!-- 解决时在下面追加。 -->
