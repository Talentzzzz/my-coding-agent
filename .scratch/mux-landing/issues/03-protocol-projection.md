# 03 - 协议类型与概况投影

Type: task
Status: open

## Question

落 `packages/core/src/protocol.ts` 的三层类型（`ServerMessage` / `StreamFrame` / `ServerFrame`·`ClientFrame`，信封 `{ streamId, item }`）与 `SessionRow`；新建 `packages/server/src/projection.ts`（`SessionProjection`，进程内一份 store，目录扫描只是 seed），hub 加 host 级观察点与 `observe(sessionId, observer)`。依据：旧图票 05/09/10 与 ADR 0001 的落地清单。不依赖 `ws` 依赖选择。
