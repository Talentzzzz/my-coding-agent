# 02 · 类型的新家与严格检查

Type: grilling
Status: resolved
Resolved: 2026-11-02，经 grilling 会话与用户逐题敲定

## Question

删掉 `@my-agent/loop` 包后，`AgentTool` / `AgentToolResult` / `AgentEvent` / `QueueMode` 等
类型（core 内 19 个文件的导入来源）搬去哪里？`@ts-nocheck` 是去是留？对外 re-export 怎么办？

## Answer

- **类型集中并入 core 的一个模块**（`protocol.ts` 或新 `types.ts`，实施时按现有文件分工定）；
  core 内 19 个文件的 import 全部改指新家。
- **`packages/core/src/index.ts` 对外的 re-export 原样保留**（`AgentEvent`、`AgentTool` 等），
  外部消费者无感。
- **`@ts-nocheck` 去掉**：合并后的代码过根 tsconfig 的严格检查（合并的最大实际收益之一；
  只用可擦除语法、无 `any` 的既有约定照此执行，第三方类型所迫除外）。
- `QueueMode` / `LoopRuntime` / `ActiveRun` 等随迁；`LoopRuntime` 结构视图消失——Agent 直接
  操作 `SessionRuntime`，不再需要一个只声明一个槽位的间接层。
