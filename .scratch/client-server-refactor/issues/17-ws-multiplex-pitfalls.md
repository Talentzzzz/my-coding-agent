# 把一条 WebSocket 当作多路复用通道时，浏览器与 Node 的既有陷阱

Type: research
Status: open

## Question

2026-10-12 地图重开了「不用 WebSocket」（见 `map.md`「为什么改回 WebSocket」），传输定为**一条常驻的 WebSocket mux（每标签页一条）**。这张票是研究票 02（`02-sse-multiplex-pitfalls.md`）的镜像：02 把 SSE 侧的平台事实钉死了，WS 侧还全是空的——**在此之前，一切浏览器 WS 行为按"未确认"对待**。请以规范与实现为准，逐条给出结论与出处：

1. **无自动重连**。浏览器 WebSocket 断开后没有任何内建重连——这是本模型最大的一块新增自建件。给出规范性确认（WHATWG WebSockets / RFC 6455 的关闭语义），钉死断开时的可观测信号：`close` 事件的 code/reason 取值表、`error` 事件何时 fire、`readyState` 的可用判据。DSH 的退避形状（`../research/dsh-portability.md` §4.1：cap 表 500→…→10000 ms、实际延迟 50–100%、硬截止 15000 ms）已经够用，本票只补平台事实。
2. **心跳与判活**。RFC6455 的 Ping/Pong 在浏览器里的确切行为（自动回 pong 是规范要求还是实现行为？pong 对 JS 完全不可见吗？）；`ws` 包的 `socket.ping()` / `'pong'` 事件在 **Node 22.19**（引擎下限）上的行为与语义；Electron 的 `backgroundThrottling`（默认 `true`）对隐藏窗口里 WS 收发的影响——研究票 02 对 `EventSource` 的那条问题随传输切换平移过来，仍无答案。
3. **连接上限**。Chromium 的 kWebSocket 组上限 255（`sse-multiplex.md` Q4 引的源码常量）**实测**是否成立；Firefox 的对应值；HTTP 池与 WebSocket 池是否共享名额；"页面导航 + 一条常驻 WS + 普通命令请求"在回环上的实测。结论直接喂给票 16。
4. **服务端生命周期**。`server.close()` 对 **upgrade 之后的 socket** 的记账（DSH 的 WebServer 自建 `upgradedSockets`、关闭时统一 `destroy()`，`../research/dsh-portability.md` §4 末尾——这是"close 覆盖不到升级 socket"的先例证据，但 Node 是否真的覆盖不到要核实）；`closeAllConnections()` 是否覆盖升级 socket；`ws` 的 socket 高水位与背压语义与裸 `net.Socket` 是否一致（票 11 的 HWM 16384 结论来自 `ServerResponse`，WS 侧没有实测）；Node 22.19 与实测版本的差异照票 02 的惯例标注。
5. **客户端实现底座**。Node ≥22 的全局 `WebSocket`（undici）在 22.19 上的可用性与行为——冒烟脚本要用它（票 15），**不要**为此引入 `ws` 依赖；它与浏览器 `WebSocket` 的行为差异（若影响冒烟断言）。
6. **与 SSE 共存的过渡期**。旧 `/events` 若保留（票 05 决定），两种连接并存时第 2、3 条的答案怎么算（SSE 池 6 + WS 池 255 是分开还是共享）。

**已定前提**：传输 = 一条常驻 WebSocket mux（map 已定，本票不重开）；命令面 REST；服务端实现选 `ws` 还是手写 RFC6455 是**本票产出之后**才做的决定（见 map 的 Not yet specified），所以第 2、4 条里凡依赖 `ws` 的行为要与"手写时的规范要求"分开陈述。

**产出**：`.scratch/client-server-refactor/research/ws-multiplex.md`。格式照票 02：结论 + 出处（规范链接、源码行号、或可复现的最小实验），区分"规范保证 / 官方文档 / 实现细节 / 未确认"，附"未确认清单"。不要给本仓库的改造建议。

## Answer

<!-- 解决时在下面追加。 -->
