# 04 - mux 服务端连接层

Type: task
Status: open
Blocked by: 02, 03

## Question

新建 mux 连接层：连接生命周期、订阅表（键随 `Subscription` 落位，并入票 19 的答案表——搬运不是返工）、写侧有界队列（4 MiB / 10 秒，超限 `1013` 关整条连接）、协议层 Ping/Pong（2000 ms / 容忍 2 次 / 第三次 `terminate()`）+ 连接级心跳（`{ streamId: null, item: { type: "heartbeat", everyMs } }`，5000 ms）、连接级概况载荷（`sessions` / `session_row`）。删除 `http/event-stream.ts` 与 `stream-registry.ts`；`/api/health` 回到 `{ ok, cwd, live }`。`server.close()` 自持 upgrade sockets 并 `destroy()`（票 17：两条官方出口都覆盖不到）。依据：旧图票 04/05/07/09/10/11/16/19 与 ADR 0001 落地清单。
