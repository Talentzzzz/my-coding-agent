# 05 · 验证

Type: task
Status: resolved
Resolved: 2026-11-04

## Question

怎么确认这次搬家不是把人骗了：类型过了但运行时行为变了。

## Answer

**基线（改动前）**：`npm run check` 绿（llm / tsconfig / web 三份 tsc + token 审计）。
`smoke-session`、`smoke-approval-recovery`、`smoke-stream`、`smoke-tools`、`smoke-replay`、
`smoke-transcript`、`smoke-liveness`、`smoke-settings`、`smoke-modes` 全绿；`smoke-approval` 在
**改动前**即失败（子进程编排，`1 FAILED` 而所有断言都 ok——既有环境问题，与本次无关）；
`smoke-api` 需要 8080 上已有服务器（`npm run dev`），不作为自包含 smoke。

**改动后**：

- `tsc -p packages/llm` / `tsconfig.json` / `packages/web` 三份全过，token 审计
  `137 defined, 111 referenced`。
- 复跑并全绿：`smoke-session`、`smoke-approval-recovery`、`smoke-stream`、`smoke-tools`、
  `smoke-replay`、`smoke-transcript`、`smoke-liveness`、`smoke-settings`、`smoke-modes`、
  `smoke-branch`、`smoke-projection`、`smoke-approval-queue`、`smoke-approval-endpoint`、
  `smoke-models`。
- `smoke-approval` 仍是同一个既有失败；`smoke-api` 仍需要外部服务器。

覆盖面：审批（suspend / 恢复 / 队列 / 端点）、压缩阶梯（`smoke-transcript` 直接驱动
`maybeCompact`）、分支、投影、重试与流事件、工具批次。没有供应商密钥参与——
`scripts/fake-transport.ts` 是脚本化传输层。
