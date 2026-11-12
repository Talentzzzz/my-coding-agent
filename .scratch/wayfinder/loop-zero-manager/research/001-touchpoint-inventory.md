# 001 · loop-manager.ts 六件依赖全量触点盘点

- 对象：`packages/core/src/loop-manager.ts`（实测 1941 行）
- 目的：六件依赖（`sessionManager` / `settings` / `tools` / `hooks` / `api` / `systemPrompt`）回调化重构（loop 只认函数）的事实底座
- 行号以 2026-11-12 Read 全文为准；每行均经 Read 上下文确认归属方法，非仅凭 grep
- 计数口径：**1 触点 = 1 处物理行的依赖使用**（成员调用、向消费者传参、经 `servicesOf` 组装传入）。纯解构行（`const { sessionManager } = loopOptions`）为记账行，单列不计入触点。一行同时触多个依赖时按依赖各计一次（实例总数 > 物理行总数）

## 0. 结构速览

- `LoopOptions`（L94-133）：11 字段 = 三件每次调用的值（`state`/`bag`/`start`）+ 六件服务依赖（`sessionManager` L102、`settings` L104、`tools` L106、`hooks` L108、`systemPrompt` L114-119、`api` L121）+ 两条白名单回调（`bagOf` L126、`emit` L132）
- `servicesOf`（L155-157，文件级）：从袋上现凑 `SessionServices { sessionManager, settings, tools }`
- 类方法（按调用序）：`run` L182 → `runEngine` L254 → `toolCallHooks` L450 → `handleRunFailure` L466 → `finishRun` L489 → `prepareRequest` L502 → `declaredTools` L583 → `runContext` L597 → `recordSelection` L618 → `pumpAttempts` L652 → `retryCallbacks` L716 → `endRetry` L745 → `compactFor` L782 → `trimRecordedArgs` L870 → `clearStaleToolResults` L897 → `compact` L928 → `beforeTool` L950 → `afterTool` L974 → `drainTranscribed` L1000
- 文件级机件：`servicesOf` L155、`streamAssistantResponse` L1067、`failToolCallsFromTruncatedMessage` L1154、`activeTool` L1195、`danglingToolCallsOf` L1206（导出）、`recoverPendingToolCalls` L1239（导出）、`synthesizeToolResult` L1298、`executeToolCalls` L1329、`executeToolCallsSequential` L1349、`executeToolCallsParallel` L1419、`prepareToolCall` L1538、`runToolCall` L1649（未接线）、`executePreparedToolCall` L1682、`finalizeExecutedToolCall` L1719

## 1. 逐触点清单表（67 物理行）

方式：**直调** = 依赖成员/方法直接调用；**传参** = 依赖值递入消费者（纯函数/机件函数/私有方法）；**servicesOf** = 经 `servicesOf(loopOptions)` 现凑成 `SessionServices` 传入 fanout。

| 行号 | 所在方法 | 依赖.成员 | 方式 |
|---|---|---|---|
| 156 | servicesOf（文件级） | sessionManager+settings+tools 组装 | servicesOf 组装 |
| 226 | run | sessionManager.setSuspended | 直调 |
| 235 | run (finally) | publishState(…servicesOf) | servicesOf |
| 259 | runEngine | settingsManager → this.runContext | 传参 |
| 278 | runEngine | modelChoiceOf(sessionManager, settingsManager) | 传参（纯函数） |
| 279 | runEngine | settingsManager.modelCatalog() | 直调 |
| 281 | runEngine | loopOptions.hooks → this.toolCallHooks | 传参 |
| 289 | runEngine | toolStateOf(sessionManager, settingsManager, tools.names()) | 直调+传参（纯函数） |
| 291 | runEngine | sessionManager.buildSessionContext(session) | 直调 |
| 292 | runEngine | tools → this.declaredTools | 传参 |
| 307 | runEngine | hooks → recoverPendingToolCalls | 传参 |
| 308 | runEngine | tools → recoverPendingToolCalls | 传参 |
| 394 | runEngine | hooks → executeToolCalls | 传参 |
| 394 | runEngine | tools → executeToolCalls | 传参 |
| 413 | runEngine | sessionManager → this.drainTranscribed | 传参 |
| 420 | runEngine | sessionManager → this.drainTranscribed | 传参 |
| 515 | prepareRequest | settingsManager.modelCatalog() | 直调 |
| 516 | prepareRequest | modelChoiceOf(sessionManager, settingsManager) | 传参（纯函数） |
| 527 | prepareRequest | sessionManager.buildContextEntries(session) | 直调 |
| 535 | prepareRequest | toolStateOf(sessionManager, settingsManager, tools.names()) | 直调+传参（纯函数） |
| 543 | prepareRequest | systemPrompt(workDirAbsPath, agentsMd, toolNames, approvals) | 直调 |
| 547 | prepareRequest | approvalsOf(servicesOf(loopOptions), session) | servicesOf |
| 552 | prepareRequest | hooks.apply("context", injected) | 直调 |
| 572 | prepareRequest | tools → this.declaredTools | 传参 |
| 586 | declaredTools | manager.get(name)（= tools 实参） | 直调（参数） |
| 602 | runContext | settingsManager.getBashSettings(workDirAbsPath) | 直调 |
| 620 | recordSelection | sessionManager.recordedOnDisk(session) | 直调 |
| 630 | recordSelection | sessionManager.setModel(bag, row.name, row.id) | 直调 |
| 631 | recordSelection | sessionManager.setThinkingLevel(bag, level) | 直调 |
| 632 | recordSelection | sessionManager.flushMeta(bag) | 直调 |
| 667 | pumpAttempts | settingsManager.modelCatalog().find(…) | 直调 |
| 669 | pumpAttempts | api.stream(model, context, options) | 直调 |
| 689 | pumpAttempts | settingsManager.getRetrySettings(workDirAbsPath) | 直调 |
| 729 | retryCallbacks.onRetryScheduled | publishState(…servicesOf) | servicesOf |
| 737 | retryCallbacks.onRetryAttemptStart | publishState(…servicesOf) | servicesOf |
| 756 | endRetry | publishState(…servicesOf) | servicesOf |
| 806 | compactFor (summarize) | settingsManager.modelCatalog().find(…) | 直调 |
| 841 | compactFor | sessionManager.appendCompaction(session, …) | 直调 |
| 850 | compactFor | sessionManager.buildContextEntries(session) | 直调 |
| 880 | trimRecordedArgs | sessionManager.appendTrimToolCallArgs(session, …) | 直调 |
| 881 | trimRecordedArgs | sessionManager.buildContextEntries(session) | 直调 |
| 910 | clearStaleToolResults | sessionManager.appendClearToolResults(session, …) | 直调 |
| 911 | clearStaleToolResults | sessionManager.buildContextEntries(session) | 直调 |
| 931 | compact | modelChoiceOf(sessionManager, bag, settings, …) | 传参（纯函数） |
| 932 | compact | settings.modelCatalog() | 直调 |
| 957 | beforeTool | hooks.apply("before_tool", …) | 直调 |
| 982 | afterTool | hooks.apply("after_tool", …) | 直调 |
| 1003 | drainTranscribed | appendMessageEntry(state, session, sessionManager, msg) | 传参（fanout 文件级） |
| 1196 | activeTool（文件级） | manager.get(name)（仅当 activeNames.has） | 直调（参数） |
| 1257 | recoverPendingToolCalls | manager → prepareToolCall | 传参 |
| 1271 | recoverPendingToolCalls | manager → executePreparedToolCall | 传参 |
| 1341 | executeToolCalls | activeTool(manager,…)?.executionMode（→manager.get） | 直调（参数） |
| 1344 | executeToolCalls | manager → executeToolCallsSequential | 传参 |
| 1346 | executeToolCalls | manager → executeToolCallsParallel | 传参 |
| 1366 | executeToolCallsSequential | manager → prepareToolCall | 传参 |
| 1385 | executeToolCallsSequential | manager → executePreparedToolCall | 传参 |
| 1436 | executeToolCallsParallel | manager → prepareToolCall | 传参 |
| 1472 | executeToolCallsParallel | manager → executePreparedToolCall | 传参 |
| 1547 | prepareToolCall | activeTool(manager, activeNames, toolCall.name)（→manager.get） | 直调（参数） |
| 1559 | prepareToolCall | hooks.beforeToolCall 存在性直读（ToolCallHooks 包装对） | 直读 |
| 1560 | prepareToolCall | hooks.beforeToolCall(…, signal) 调用 | 直调 |
| 1651 | runToolCall（未接线） | options.manager → prepareToolCall | 传参 |
| 1664 | runToolCall（未接线） | options.manager → executePreparedToolCall | 传参 |
| 1693 | executePreparedToolCall | manager.execute(name, id, args, run, signal, onUpdate) | 直调 |
| 1730 | finalizeExecutedToolCall | hooks.afterToolCall 存在性直读 | 直读 |
| 1732 | finalizeExecutedToolCall | hooks.afterToolCall(…, signal) 调用 | 直调 |
| 454 | toolCallHooks | hooks → this.beforeTool（闭包捕获） | 传参 |
| 456 | toolCallHooks | hooks → this.afterTool（闭包捕获） | 传参 |

记账行（解构/整袋转交，不计触点）：L183（run：state/start/bag）、L256（runEngine：sessionManager/settingsManager/tools）、L510（prepareRequest：四件+systemPrompt）、L520（prepareRequest → recordSelection 整袋）、L619（recordSelection）、L661（pumpAttempts：settingsManager/api）、L697（pumpAttempts → retryCallbacks 整袋）、L791（compactFor）、L929（compact）、L935（compact → compactFor 整袋）。

## 2. servicesOf 消费点

`servicesOf` 定义于 L155-157，组装 `{ sessionManager, settings, tools }`。全部消费点 5 处：

| 行号 | 方法 | 调用 |
|---|---|---|
| 235 | run（finally） | publishState(state, transcript, servicesOf(loopOptions)) |
| 547 | prepareRequest | approvalsOf(servicesOf(loopOptions), session)（递入 systemPrompt 的审批映射） |
| 729 | retryCallbacks.onRetryScheduled | publishState(state, session, servicesOf(loopOptions)) |
| 737 | retryCallbacks.onRetryAttemptStart | publishState(state, session, servicesOf(loopOptions)) |
| 756 | endRetry | publishState(state, session, servicesOf(loopOptions)) |

即 publishState ×4（L235/729/737/756）、approvalsOf ×1（L547）。

## 3. 文件级纯函数（自收 Manager 作参数）及 loop 传入的实参

| 纯函数 | 参数表 | 调用行 | loop 传入 |
|---|---|---|---|
| toolStateOf（./session/tool-config.ts） | (sessionManager, session, settingsManager, toolNames) | 289（runEngine）、535（prepareRequest） | (sessionManager, session, settingsManager, tools.names()) |
| modelChoiceOf（./session/model-choice.ts） | (sessionManager, session, settingsManager, openedOn) | 278（runEngine）、516（prepareRequest）、931（compact） | (sessionManager, session, settingsManager, live.openedOn) |
| appendMessageEntry（./session/fanout.ts） | (state, session, sessionManager, message) | 1003（drainTranscribed） | (state, session, sessionManager, message) |
| appendMessageEntry 同族（不收 Manager） | dropQueued(state) L219、emitQueueUpdate(state) L219/424、emitEvent(state, …) 多处 | — | 仅 state，不触六件依赖 |
| sessionEntryToContextMessages（messagesOf 内 L1939） | (entry) | — | 不触六件依赖 |

## 4. hooks 的两种用法

**用法一：hooks.apply（Hooks 上的分发方法，三个 hook 名）**

| hook 名 | 行号 | 所在方法 |
|---|---|---|
| "context" | 552 | prepareRequest |
| "before_tool" | 957 | beforeTool |
| "after_tool" | 982 | afterTool |

**用法二：ToolCallHooks 成员直读（toolCallHooks L450 包装出的运行自有那对回调）**

| 成员 | 行号 | 所在方法 |
|---|---|---|
| hooks.beforeToolCall | 1559（直读）、1560（调用） | prepareToolCall（文件级） |
| hooks.afterToolCall | 1730（直读）、1732（调用） | finalizeExecutedToolCall（文件级） |

链路：`loopOptions.hooks`（L281）→ `toolCallHooks` 包装成闭包对（L453-457，内部转调 `this.beforeTool`/`this.afterTool`，即 L454/456 两行传参）→ 闭包对以 `ToolCallHooks` 实参流经 recoverPendingToolCalls（L307）/executeToolCalls（L394）→ prepareToolCall/finalizeExecutedToolCall 直读成员 → 闭包回到 `hooks.apply("before_tool"/"after_tool")`（L957/982）。

## 5. CompactOptions

L140：`CompactOptions extends Pick<LoopOptions, "state" | "bag" | "sessionManager" | "settings">`

Pick 链携带的 Manager 字段：**sessionManager、settings 两件**（另带 state/bag 两件非 Manager 值，以及自有字段 entries/now/signal?/transport?，L142-146）。消费点：L929 解构 → L931 modelChoiceOf、L932 modelCatalog，再整袋递入 compactFor（L935）。

## 6. 工具执行入口：ToolManager 被触达的全部路径

入口值 = `loopOptions.tools`（runEngine L256 解构后以 `tools` 流转；机件层一律作形参 `manager`）。

- **A · 名单派生**：L289 `tools.names()` → toolStateOf → activeToolNames（活跃名单成员判断的唯一来源）
- **B · 请求声明**：L292/L572 `declaredTools(tools, activeNames)` → L586 `manager.get(name)` → 元素为表实例的 `Tool[]` → L1075 `toToolDeclaration`（对 Tool 对象，不再触表）
- **C · 执行链（Tool.execute 所在）**：runEngine L394（活跃批）/ L308（恢复遍）传 tools → `executeToolCalls`/`recoverPendingToolCalls(manager)` → L1341 `activeTool(manager,…)?.executionMode`（串/并行调度判定）→ `prepareToolCall` L1547 `activeTool` → `manager.get`（L1196，名单先行、表后解析）→ `executePreparedToolCall` L1693 **`manager.execute(name, id, args, run, signal, onUpdate)`** —— 生产代码里唯一的 `Tool.execute` 调用就是表自己的（注释 L1677-1680、L1032 明言）
- **D · 审批/发布面**：tools 经 `servicesOf` 进 fanout：L547 approvalsOf、L235/729/737/756 publishState
- 嵌套执行（预留）：`runToolCall` L1649 经 `options.manager`（类型字段 L1628）走同一 prepare→execute→finalize 链（L1651/1664），当前无调用方

## 7. 按 16 动词草案归类

说明：草案编号列出 15 项，其中第 8 项含三个追加动词；本表沿用其编号。物理行 394 同时携带 hooks 与 tools，按动词各归一次，故「归档实例 68 > 物理行 67」。

| 动词 | 覆盖成员 | 触点行 | 合计 |
|---|---|---|---|
| 1 contextMessages | buildSessionContext | 291 | 1 |
| 2 contextEntries | buildContextEntries | 527、850、881、911 | 4 |
| 3 modelCatalog | modelCatalog | 279、515、667、806、932 | 5 |
| 4 activeTools | toolStateOf（+tools.names()） | 289、535 | 2 |
| 5 recordSelection | setModel/setThinkingLevel/flushMeta | 630、631、632 | 3 |
| 6 recordedOnDisk | recordedOnDisk | 620 | 1 |
| 7 setSuspended | setSuspended | 226 | 1 |
| 8 账本追加×3 | appendCompaction / appendTrimToolCallArgs / appendClearToolResults | 841、880、910 | 3 |
| 9 bashSettings | getBashSettings | 602（+259 传参链） | 2 |
| 10 retrySettings | getRetrySettings | 689 | 1 |
| 11 executeTool | ToolManager.execute 及其名字解析/调度/传参链 | 1693（execute 本体）、586→见草案外 b、1196、1341、1547（解析）、308、1257、1271、1344、1346、1366、1385、1436、1472、1651、1664（传参链）、394（tools 半行） | 16 |
| 12 rewriteContext | hooks.apply("context") | 552 | 1 |
| 13 decideBeforeTool/decideAfterTool | hooks.apply("before_tool"/"after_tool") + beforeToolCall/afterToolCall 直读 + 接线 | 957、982、1559、1560、1730、1732（实质 6）+ 281、307、454、456、394（hooks 半行）（接线 5） | 11 |
| 14 publish | publishState | 235、729、737、756 | 4 |
| 15 approvals | approvalsOf | 547 | 1 |
| **归入草案合计** | | | **56 / 68 实例（≈82%）** |

注：动词 11 的传参链行（1257、1271、1344 等）严格口径下只是 manager 的流转而非成员触达；若把动词 11 收窄为 `manager.execute` 一处，这些行应移入草案外 b 类。

## 8. 草案外形状（12 行）

| 类 | 行号 | 内容 | 建议归属 |
|---|---|---|---|
| a · modelChoice | 278、516、931 | modelChoiceOf(sessionManager, session, settingsManager, openedOn) —— 从 live 行+设置门现算模型选择，供 modelFor/recordSelection 消费 | 新增动词「modelChoice」（与 3/5 同属选择派生族） |
| b · declaredTools | 292、572、586 | tools → declaredTools → manager.get(name)，按请求构建声明数组（元素为表实例） | 并入动词 4，扩为「activeTools 及其声明面」 |
| c · stream | 669 | api.stream(model, context, options) —— 六件依赖之一 api 的唯一消费点 | 新增动词「send/stream」 |
| d · systemPrompt | 543 | systemPrompt(workDirAbsPath, agentsMd, toolNames, approvals) —— 六件依赖之一，已是回调形状 | 新增动词「systemPrompt」（或视为已完成的样板） |
| e · 消息追加 | 413、420、1003 | drainTranscribed(sessionManager,…) → appendMessageEntry(state, session, sessionManager, msg) —— 排空队列时落账本 | 并入动词 8，扩为账本追加×4 |
| f · servicesOf 组装 | 156 | 三件依赖现凑 SessionServices 的机制行本身 | 机制行，回调化后随 publish/approvals 两动词的实现消失，不需动词 |

## 9. 汇总数字

| 依赖 | 触点行数 | 主要动词归属 |
|---|---|---|
| sessionManager | 27 | 1/2/5/6/7/8 ×3/e（追加族 19 处，占其 70%） |
| settings | 19 | 3（catalog ×5）、4/9/10、modelChoice ×3、servicesOf 面 ×5 |
| tools | 27 | 11（执行链 15）、4（names ×2）、b（声明 3）、servicesOf 面 ×5 |
| hooks | 12 | 12 ×1、13 ×11 |
| api | 1 | 草案外 c |
| systemPrompt | 1 | 草案外 d |
| **六件合计** | **87 实例 / 67 物理行** | 归入草案 56 实例（≈82%），草案外 12 行 |

- 触点最多的方法是 `runEngine`（16 行）与 `prepareRequest`（9 行）；机件层的触点全部集中在工具执行链（tools）与 finalize（hooks）
- 直调 vs servicesOf：直调/传参 60 行，经 servicesOf 6 行（156 组装 + 235/547/729/737/756 五个消费点）
- 白名单回调两条不在六件内：bagOf ×1（L629，recordSelection）、emit ×1（L282，runEngine 包成 sink 后贯穿全程）
- 回调化时的新形状参照：`api` 与 `systemPrompt` 已经是「loop 只认函数」的样板（各 1 个消费点）；sessionManager 的 19 处追加/读改族与 tools 的执行链是本次改造的主体
