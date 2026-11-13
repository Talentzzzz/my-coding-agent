---
status: closed
closed: 2026-11-13
assignee: workbuddy
---

# 002 类型与导出的新家

## Question

七个接缝类型、`ActiveTools`、`ToolChain`、`RunStart`、`AgentEventSink` 在文件消失后各住哪里；
`index.ts` 的恢复机器 re-export 指向谁。

## Resolution

### 整组删除（六个）

`ContextInjection` / `ContextRewrite` / `BeforeToolEvent` / `BeforeToolDecision` / `AfterToolEvent` /
`AfterToolDecision`（loop-manager.ts 83–113）。它们原本为了「结构定义在 loop、`HookMap` 在
`hooks.ts`、同步点在 `agent.ts` 的接线处」这条三地关系而存在；合并后消费点与 `HookMap` 同处一个
调用现场，直接用派生类型：`HookEvent<"context">` / `HookResult<"before_tool">` 等。
**「同步点」这件事消失**，不是被搬走——这是本图少见的、真正的净删除。

### 随文件迁到 `agent.ts` 的类型

| 类型 | 位置 | 说明 |
|---|---|---|
| `RunInput` | 模块级、`Agent` 类之前 | 新定义（见票 001 §E），导出 |
| `RunStart` | 同上 | 原 loop-manager.ts 1761 行，原样搬 |
| `ActiveTools` | 同上 | 原 75 行，原样搬，导出 |
| `AgentEventSink` | 机件一节 | 原 989 行 |
| `ToolChain` | 机件一节 | 原 998 行 |

`ToolChain` 的三个字段原先写的是 `RunInput["executeTool"]` 这类下标查询——那张接口没了，改成三个
显式别名（放在 `ToolChain` 之上）：

```ts
type ToolChainExecute = (
	name: string,
	toolCallId: string,
	params: unknown,
	run: ToolRunContext,
	signal?: AbortSignal,
	onUpdate?: ToolUpdateCallback<any>,
) => Promise<ToolResult<any>>;
type ToolChainDecideBefore = (event: HookEvent<"before_tool">) => Promise<HookResult<"before_tool">>;
type ToolChainDecideAfter = (event: HookEvent<"after_tool">) => Promise<HookResult<"after_tool">>;
```

不做别名而行内展开亦可，但 `ToolChain` 会从 12 行涨到 30 行；别名让「链是什么」仍然一眼看完。
`partialResult` 在 `executePreparedToolCall` 里的隐式 any 由 `ToolChainExecute` 的第六参消掉。

### import 面的增减

新增（原本只在 loop-manager.ts 里）：`AssistantMessage` / `AssistantMessageEventStream` /
`createAssistantMessageEventStream` / `createSystemMessage` / `isContextOverflow` / `JsonValue` /
`RetryCallbacks` / `retryAssistantCall` / `SimpleStreamOptions` / `toToolDeclaration` / `ToolCall` /
`ToolResult` / `ToolResultMessage` / `ToolUpdateCallback` / `Usage` / `validateToolArguments`（均自
`./llm/index.ts`）、`loadAgentsMd`、压缩四件（`compact` / `compactionThresholdFor` / `estimateTokens` /
`shouldCompact` / `Summarize`）、`clearableToolResultIds` / `isCacheProbablyExpired` /
`trimmableToolArgEntryIds`、`Model` / `ModelChoice` / `modelFor` / `unconfiguredStream`、
`AgentRequestUpdate` / `RunRecoveryOptions` / `ToolCallOutcome`、`PendingMessageQueue`、
`sessionEntryToContextMessages`、`ToolRunContext`、**`HookEvent` / `HookResult`**。

删除：`import { LoopManager, type CompactOptions, type RunInput, type RunStart } from
"./loop-manager.ts";`。

口径：`Session` / `SessionEntry` 仍从 `session/session-manager.ts` 取（agent.ts 一直如此，不受
0023 那条守卫约束——守卫连同文件一起作废）。`session/ledger.ts` 那套「值类型安新家」的搬家不必
回滚：它现在只是被人 import 的一个模块，留着无害，也不值得再搬一次。

### `index.ts`

```ts
export { danglingToolCallsOf, recoverPendingToolCalls } from "./agent.ts";
```

注释里「恢复机器住在 `loop-manager.ts`」那句同步改。包对外名字一字不变。
`scripts/smoke-approval-recovery.ts` 若从 `@my-agent/core` 取，无需改动；若直取源文件，路径同步。
