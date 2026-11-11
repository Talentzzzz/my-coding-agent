# 004：按 ADR-0022 落地——loop 抽出、check 与 smoke 全绿

- label: wayfinder:task
- status: open
- assignee:
- blocked-by: 003-adr-0022

## Question

按已接受的 ADR-0022 搬代码：

1. 新建 `packages/core/src/loop-manager.ts`：0014 决定 1 的 18 个私有方法 + 文件级机械
   （流、工具批次、恢复机器、`pairLateToolResults`、`messagesOf`、`failureMessage`）整体
   迁入；`this` 上的访问按白名单改写成回调或 loopOptions 字段，**方法体的业务逻辑一字
   不改**（0014 决定 1 的「唯一的机械改动」纪律反过来用同样成立）。
2. `Agent` 收缩为编排层：会话表、读面、命令、审批账本、投影；运行入口改为构造
   `loopOptions` 并调 loop；`abort` / `settle` / `close` 不动（见 map 的 Out of scope）。
3. 恢复机器保持导出——精确契约（001 票确认）：smoke-approval-recovery 经 `@my-agent/core`
   包入口（index.ts）import `danglingToolCallsOf` + `recoverPendingToolCalls`，不直接 import
   agent.ts 路径；index.ts 的 agent 出口必须保住。
4. `npm run check` 全绿、smoke 全套与改动前同色；记录前后行数账进 ADR 的「后果」节。

这是本 map 把执行纳入范围的 override 票（见 map Notes）。
