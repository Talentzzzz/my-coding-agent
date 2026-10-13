# Map：mux 落地——客户端-服务端模式对齐 dsh

Status: charting

## Destination

把 `.scratch/client-server-refactor/` 已钉死的传输架构**落进代码与文档**：一条常驻 WebSocket mux（上行 `open` / `item` / `end` / `cancel`，下行逻辑流 `item` / `error` / `end` 加连接级心跳与概况）、REST 命令面原样（`abort` 留在 `POST /api/sessions/{id}/abort`）、以基线为准的恢复。终点 = 四条验收边在冒烟中全绿 + 文档（`docs/architecture.md`、`AGENTS.md` 术语、`README.md`、`docs/notes.md`）改写到与落地后实况一致。

**验收边**（照抄旧图，权威判据）：

1. 一个标签页能同时订阅 N 个会话，各自的 transcript 逐条更新。
2. 一条逻辑流被丢弃后重新挂上，收敛到"现在长什么样"。
3. 发送不再依赖"先 attach 再 POST"——无人观看时的失败不会丢失。
4. 客户端能在**不发请求**的情况下发现连接已死。

## Notes

**继承**：本图不重开任何已决事项。`.scratch/client-server-refactor/map.md` 的 Decisions so far（票 01–19）与 `docs/adr/0001-transport-websocket-mux.md` 是全部上游决定的权威出处；研究资产三份（`dsh-portability.md`、`sse-multiplex.md`、`ws-multiplex.md`）与装置（`prototype/ws/`、`prototype/backpressure-stalled-peer.mjs`）直接沿用。旧图 Status 已改为 charted。

**2026-10-13 用户拍板的补充决定**（对齐 dsh 的字面边界，ADR 0001 无冲突）：

- **abort 留在 REST**（`POST /api/sessions/{id}/abort`）。dsh 的"中止运行"同样是一元 RPC（`session-controller/src/client/contract/session.ts:107-114` 的 `cancel()`），不在 mux 上。
- **不引入 ack / requestId**。dsh 上行帧没有回执；订阅成败由"open 之后有没有第一帧"表达，abort 的结果由 `session_event` 流表达。
- **命名**：mux 上行 `cancel` = 取消订阅（关一条逻辑流，同 dsh）；**中止运行只叫 `abort`**，且只在 REST 上。两个词不混用。
- 用户草图中的"abort 帧 + ack"经核实为对 dsh 的误读（dsh 的 `cancel` 帧是关流不是停 agent；上行无 ack），按上述决定修正，不进 wire。
- **WS 服务端手写 RFC6455，不引入 `ws` 依赖**（见 [Decisions so far](issues/02-transport-deps.md)）。

**动手前必读**：旧图 Notes 全节（含重开清单与平台事实纪律）、ADR 0001 的落地清单（本图 ticket 的划分依据）、`research/ws-multiplex.md` 的未确认清单（"仍然悬着"的那批不许当已知用）。

**惯例**：文档与注释用中文；改完跑 `npm run check` 与对应 smoke；冒烟策略照旧图票 15（`scripts/wire/` 两个装置 + `smoke-mux.ts` / `smoke-liveness.ts` / `smoke-backpressure.ts` + 既有脚本换帧解析）。

## Decisions so far

- [abort 与 ack 的边界（用户 2026-10-13 拍板）](issues/01-wire-boundary.md)：abort 留 REST、不引入 ack/requestId、`cancel`=取消订阅 / `abort`=中止运行。本票在用户当面拍板时即时解决，作为其余票的命名与边界前提。
- [WS 服务端手写 RFC6455，不引入 `ws` 依赖（用户 2026-10-13 拍板）](issues/02-transport-deps.md)：两条路线要自己接的层相同，差别只在编解码/握手；`ws` 的写侧语义与票 11 打架、prototype 的手写服务器已被整轮实测消化、仓库运行时第三方依赖保持为零。票 04 与票 08 由此解阻。

## Not yet specified

- **D1 连带面**：两栏刷新后各自恢复到哪个会话（旧图票 03/04 遗留）；每页加载只调一次 `GET /api/sessions/current` 的约束（旧图票 09）在落地时怎么落。
- **第三个在跑的会话怎么表示**（旧图票 03 未答项）——并排两栏画不下；落地到 UI 时再看是否真的会出现。
- **旧图"仍然悬着"的平台事实**（Chromium 255/256 差 1、Electron 隐藏窗口冻结、`ws` 持续停滞形态等）：以 `research/ws-multiplex.md` 未确认清单为准，落地遇到时再补测，不预先票化。

## Out of scope

- 命令面上 WS（含 abort 帧化）、ack/requestId 机制、命名空间 RPC 信封——2026-10-13 拍板，见 Decisions。
- `packages/ai` / `packages/agent` 的任何改动；插件 / MCP 机制；本机信任栅栏——照抄旧图边界。
- 旧图 Out of scope 各条原样继承。
