# 01 - abort 与 ack 的边界

Type: grilling
Status: resolved

## Question

abort 是否帧化（放 mux 上行）、要不要引入 requestId/ack 回执机制、`cancel` 与中止运行如何命名——2026-10-13 经用户当面拍板解决。

## Answer

- **abort 留在 REST**（`POST /api/sessions/{id}/abort`）。dsh 的"中止运行"同样是一元 RPC（`session-controller/src/client/contract/session.ts:107-114` 的 `cancel(): Promise<RemoteResult<{accepted:true}>>`），不在 mux 上。
- **不引入 ack / requestId**。dsh 上行帧没有回执；订阅成败由"open 之后有没有第一帧"表达，abort 的结果由 `session_event` 流表达。
- **命名**：mux 上行 `cancel` = 取消订阅（关一条逻辑流，同 dsh）；**中止运行只叫 `abort`**，且只在 REST 上。两词不混用。
- 用户草图中的"abort 帧 `{type:"cancel", requestId}` + 每帧 ack"经核实为对 dsh 的误读（dsh 的 mux `cancel` 帧是关流不是停 agent，`stream-server.ts:189-191`；上行无回执，`stream-protocol.ts:233-239`），按上述决定修正，不进 wire。
