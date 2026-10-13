# 02 - `ws` 依赖还是手写 RFC6455

Type: grilling
Status: resolved

## Question

WS 服务端用 `ws` 依赖还是手写 RFC6455（握手、帧、掩码、Ping/Pong、Close）。加依赖要走 `AGENTS.md` 的规则：删一个运行时依赖、或在提交里解释为什么。

## Answer

**手写 RFC6455，不引入 `ws` 依赖**（2026-10-13 用户当面拍板）。称量依据：

- **两条路线要自己接的层相同**（[`../research/ws-multiplex.md`](../../client-server-refactor/research/ws-multiplex.md)）：停写 + 有界队列 + 超时（票 11）、upgrade socket 自持并 `destroy()`（Q4a/4b：两条官方出口都覆盖不到）、心跳与判活。差别只在帧编解码/掩码/Close/Ping 应答与握手。
- **`ws` 不解决难的那半，且写侧语义在跟票 11 打架**：`sendFrame()` 完全忽略 `write()` 的返回值、Sender 里没有 `'drain'` 监听（Q4c：对端停滞时 51198/51210 次 `write()` 返回 `false` 它照写）；`close()` 兜底 30 s 才 destroy。票 11 的写侧规则反正长在 mux 自己身上。
- **手写的风险已被 prototype 消化**：`client-server-refactor/prototype/ws/server.mjs` 就是一份手写 RFC6455 服务器（握手、帧编解码、Close/Ping/Pong），整轮实验（close code 表、ping/pong、Electron 节流、背压）都由它跑出，且全程遵守 §5.5.1。落地实现以它为起点。
- **本仓库目前运行时第三方依赖为零**（`packages/server` 只依赖 workspace 的 `core`）；`ws` 会成为唯一一个，而它买到的只是编解码器这一层。
- **客户端面极窄**：只有 Electron 的 Chromium 与冒烟用的 Node undici。没有任意第三方客户端、没有代理、不需要 permessage-deflate。
- **`ws` 占优的砝码（照实记下）**：协议边角（分片、UTF-8 校验、非法 RSV、控制帧长度 ≤125、close code 校验与 1002 违规路径）是它踩过而我们没踩过的；手写要把这些自己复刻对，验收落在票 08 的冒烟（非法 opcode / RSV1 / 非法 UTF-8 / 非法 close code 各一条）。
- 依据 `AGENTS.md` 依赖规则：本次选择即"不加"——不需要在提交里解释一个没有发生的依赖。

事实已备齐（`research/ws-multiplex.md`）：两条路线要自己接的层相同（票 11 的停写 + 有界队列 + 超时），差别只在帧编解码/掩码/Close/Ping 应答与握手要不要自己写；`ws` 的 socket HWM 16384、`_autoPong` 默认 true、接收侧 close code 校验规则均已核实。手写的代价是研究票 01 判定过的那一份。
