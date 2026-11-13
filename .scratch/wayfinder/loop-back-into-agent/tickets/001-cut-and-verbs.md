---
status: closed
closed: 2026-11-13
assignee: workbuddy
---

# 001 机械搬家切法与动词落地口径

## Question

14 个成员怎么进 `Agent`（名字、可见性、参数），19 个动词各自留成方法还是直调？

## Resolution

### A. 成员：原样迁入，名字不变，全部私有

`loop-manager.ts` 的类体在 254–980 行，14 个成员。迁入后前缀与可见性：

| 成员 | 迁入后的签名 |
|---|---|
| `run` | `private async run(input: RunInput): Promise<void>` |
| `runEngine` | `private async runEngine(input: RunInput, transport: ChatTransport): Promise<Message[]>` |
| `prepareRequest` | `private async prepareRequest(transport, context, signal, state, session): Promise<AgentRequestUpdate>` |
| `runContext` | `private runContext(session: Session): ToolRunContext` |
| `pumpAttempts` | `private async pumpAttempts(state, session, outer, model, context, options): Promise<void>` |
| `retryCallbacks` | `private retryCallbacks(state, session, maxAttempts): RetryCallbacks` |
| `endRetry` | `private endRetry(state, session, success, attempt, finalError?): void` |
| `handleRunFailure` | `private async handleRunFailure(emit, model, error, aborted): Promise<void>` |
| `finishRun` | `private finishRun(state: AgentState): void` |
| `drainTranscribed` | `private drainTranscribed(queue, state, session): Message[]` |
| `compactFor` | `private async compactFor(state, session, entries, now, signal, model): readonly SessionEntry[]` |
| `trimRecordedArgs` | `private trimRecordedArgs(state, session, entries): readonly SessionEntry[]` |
| `clearStaleToolResults` | `private clearStaleToolResults(state, session, entries, now): readonly SessionEntry[]` |
| `compact` | `private async compact(state, bag, entries, now, signal?, transport?)` |

`run` 原本是公开入口，但调用方只有本类的 `startPromptedRun` 与审批恢复那一处，一并私有。

### B. 九个方法失去一个参数

合并后它们读 `this`，不再需要第一只袋。**这条必须做**：留着就是一只没名字的新袋。

| 方法 | 参数 |
|---|---|
| `prepareRequest` | `input` 删除（6 → 5） |
| `runContext` | `input` 删除（2 → 1） |
| `pumpAttempts` | `input` 删除（8 → 7） |
| `retryCallbacks` | `input` 删除（4 → 3） |
| `endRetry` | `input` 删除（6 → 5） |
| `drainTranscribed` | `input` 删除（4 → 3） |
| `compactFor` | `CompactCallbacks` 删除（7 → 6） |
| `trimRecordedArgs` | `CompactCallbacks` 删除（4 → 3） |
| `clearStaleToolResults` | `CompactCallbacks` 删除（5 → 4） |

调用点同步改（`this.prepareRequest(transport, …)`、`this.endRetry(state, …)` 等）。

### C. 19 动词的落地表

单行镜像就是 0023 自己否掉的那件事：**只有带逻辑或 ≥3 处复用的才留成方法**，其余直调。

| 动词 | 去处 |
|---|---|
| `contextEntries` | **方法**（×4） |
| `modelChoice` | **方法**（×3，四参数派生） |
| `activeTools` | **方法**（×2，名单 + 声明一次派生） |
| `recordSelection` | **方法**（约 20 行逻辑） |
| `executeTool` | **方法**（作 `ToolChain` 的值传递） |
| `rewriteContext` / `decideBeforeTool` / `decideAfterTool` | **方法**（`?? {}` 归一是语义，且作值传递） |
| `contextMessages` | 直调 `this.sessionManager.buildSessionContext(sessionX).messages` |
| `modelCatalog` | 直调既有公开方法 `this.modelCatalog()` |
| `approvals` | 直调 `approvalsOf(this.services, sessionX)` |
| `bashSettings` | 直调 `this.settingsManager.getBashSettings(workDirAbsPath)` |
| `retrySettings` | 直调 `this.settingsManager.getRetrySettings(session.sessionSetting.workDirAbsPath)` |
| `publish` | 直调 `publishState(stateX, sessionX, this.services)` |
| `setSuspended` | 直调 `this.sessionManager.setSuspended(transcript, live.suspended)` |
| `appendCompaction` / `appendTrimToolCallArgs` / `appendClearToolResults` | 直调 `this.sessionManager.<同名>` |
| `appendMessage` | 直调 `appendMessageEntry(stateX, sessionX, this.sessionManager, message)` |
| `systemPrompt` | 字段 `this.systemPrompt(...)` |
| `api` | 字段 `this.api` |
| `emit` | 直调 `this.dispatchEvent(stateX, sessionX, event)` |

新增的 8 个方法聚成两小节（`// —— 运行的读写面 ——` 与 `// —— 执行与两个闸门 ——`），放在
`prepareRequest` 之前。

### D. 三个 `ToolChain` 值是箭头函数，`name` 必须是首参

`ToolChain.executeTool` 的签名是 `(name, toolCallId, params, run, signal?, onUpdate?)`——私有方法
作值传递时丢 `this`，所以链里写：

```ts
executeTool: (name, toolCallId, params, run, signal, onUpdate) =>
	this.executeTool(name, toolCallId, params, run, signal, onUpdate),
decideBeforeTool: (event) => this.decideBeforeTool(event),
decideAfterTool: (event) => this.decideAfterTool(event),
```

漏掉 `name` 会在 `executePreparedToolCall` 里变成六个 `implicitly has an 'any'` 错误。
代码库不用 `.bind`，别在这一处开先例。

### E. `RunInput` 是三件值，不是袋

```ts
export interface RunInput {
	state: AgentState;
	bag: Session;
	start: RunStart;
}
```

它没有依赖面：服务全在 `this` 上。所以它不需要答辩，也不算 0023 那只袋的还魂。15 个签名各拆三个
位置参数比一个三字段值对象更难读。

### F. 实测

按 A–E 机械搬完（未做注释收口、未删旧文件）实测 `agent.ts` **2820 行**，`Agent` 类约 2450 行。
这不是估算，是跑过一遍的行数——票 004 的代价栏可以引用它。
