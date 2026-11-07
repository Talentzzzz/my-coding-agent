# 03 · 代码落地

Type: task
Status: resolved
Resolved: 2026-11-04

## Question

把边界兑现：三个新文件怎么分、`agent.ts` 怎么瘦、装配点怎么改。

## Answer

- `packages/core/src/session/events.ts`（新，157 行）——从 `agent.ts` 搬出 `SessionListener`、
  `MessageDelta`、`AgentSessionEvent`、`SessionEventListener` 与 `messageDeltaOf`；`agent.ts` 原样
  re-export，`index.ts` 的出口不变。
- `packages/core/src/session/fanout.ts`（新，196 行）——见 02：八个文件级函数 + `SessionServices`
  + 写边界 `finalizeToolResult`。`Agent.snapshot` 与 `publish` 现在都走同一个 `snapshotOf`。
- `packages/core/src/loop-manager.ts`（新，1942 行）——`LoopManagerConfig`、`LoopManager`、
  `RunStart`、引擎机械、`danglingToolCallsOf` / `recoverPendingToolCalls`（继续导出，
  `smoke-approval-recovery` 直接驱动）。
- `packages/core/src/agent.ts`（2916 → 809 行）——只剩编排层；`AgentConfig` 换成
  `{ sessionManager, settings, tools, loop }`。
- `session-factory.ts` 一处组装两件东西；`index.ts` 增 `LoopManager` / `LoopManagerConfig` 出口，
  恢复机器改从 `loop-manager.ts` 出口。

搬迁方式：一次性切分脚本按行号切片产出字节一致的新文件，再以 Edit 收尾（调用点替换、`snapshot`
改为转发、删掉两个已成死代码的私有包装）。脚本与原件只用于本次搬迁，不留在仓库里。
