# 02 · LoopManager 的边界与共享 fan-out 的归属

Type: grilling
Status: resolved
Resolved: 2026-11-04，经与用户逐题敲定（三问选 B：宽边界）

## Question

哪些成员进 `LoopManager`？`emit` / `publish` / `appendMessage` / `dropQueued` / `nextStamp` 这些
「运行时也调、命令面也调」的东西放哪——放 LoopManager 上，还是抽成文件级函数？`prompt` /
`abort` / `settle` 要不要一起搬？

## Answer

**进 LoopManager 的（约 1150 行）：** `run`（原 `startRun`）、`runEngine`、`prepareRequest`、
`runContext`、`recordSelection`、`toolCallHooks`、`beforeTool`、`afterTool`、`handleRunFailure`、
`finishRun`、`pumpAttempts`、`retryCallbacks`、`endRetry`、`drainTranscribed`、`dispatchEvent`、
`maybeCompact` / `compactFor` / `trimRecordedArgs` / `clearStaleToolResults`，以及文件级的引擎机械
（`streamAssistantResponse`、批次执行、恢复机器、`pairLateToolResults`、`messagesOf`、
`ContextOverflow` / `NO_USAGE` / `failureMessage` / `pushTerminal`）。

**留在 Agent 的：** 会话表（`adopt`/`evict`/`drop`/`has`/`agentState`）、读面（`snapshot`/
`getApprovals`/`hasPendingApprovals`/`onChange`/`onEvent`）、命令（`prompt`/`steer`/`followUp`/
`branchTo`/`setActiveTools`/`applyModelSelection`/`applyConfig`）、审批账本（`respondApproval`/
`denyAllApprovals`/`authorize`/`danglingApprovals`）、`settle`/`close`/`abort`、`emitConfigChanged`，
以及一行转发的 `maybeCompact`。`startPromptedRun` 也留在 Agent：写用户消息是会话的事，运行才是
loop 的事，`LoopManager.run` 因此只有一个入口。

**共享部分抽成 `session/fanout.ts` 的文件级函数**：`emitEvent`、`emitQueueUpdate`、
`appendMessageEntry`、`dropQueued`、`publishState`、`snapshotOf`、`approvalsOf`、`nextStamp`，参数是
`(state, SessionServices)`；写入口 `finalizeToolResult` 一并搬过去（`appendMessageEntry` 就是写边界）。
理由：这些既不是运行的私有物（`branchTo`、`applyConfig` 也要发事件），也不是会话表的私有物；做成
任一方的方法，另一方就得伸手进去——那正是 ADR-0008 批评的形状。ADR-0008 决定 3 的
「有状态 → 成员，无状态 → 文件级函数」继续成立。

**`abort` / `settle` / `close` 不搬**：它们读 `state.live.activeRun`（状态自带），abort 之后要扫悬空
审批、把中止落成结果——那是审批账本与端到端等待的事。搬进去会让 LoopManager 认识审批语义。

**结果：`LoopManager` 一次都不回头问 `Agent`**，且这条不是自觉而是编译期可查的：
`loop-manager.ts` 在值的层面不 import `agent.ts`。
