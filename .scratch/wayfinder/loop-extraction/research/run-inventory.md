# run-inventory：一次运行（loop/引擎）机械的现状盘点

对象：`packages/core/src/agent.ts`（2947 行）。行号均为当前工作区 HEAD（c667b9f）上的事实，逐一经 Read/Grep 确认，非 ADR 推断。
参照 ADR：0014（现行）、0012、0019。

---

## 1. 十八个私有方法：行号、职责、this.* 访问

引擎小节从 1122 行的分区标题开始，类在 1994 行闭合。方法在文件里按调用顺序排。

| 方法 | 行号 | 职责（一句话） | 读的 this 成员 | 写的 this 成员 |
|---|---|---|---|---|
| `run` | 1143–1201 | 入口：清零 live 读数、包一层带重试泵的 transport、跑 `runEngine`、`finally` 里收尾发布 | `this.pumpAttempts`(1166)、`this.runEngine`(1174)、`this.sessionManager`(1190 setSuspended)、`this.services`(1199) | 无（live.* 经参数 `state` 写） |
| `runEngine` | 1218–1409 | 引擎本体：注册 activeRun、恢复遍、外层 follow-up 循环 + 内层工具循环、每轮 prepareRequest→流式→工具批 | `const {sessionManager, settingsManager, tools} = this`(1224)、`this.runContext`(1227)、`this.toolCallHooks`(1249)、`this.dispatchEvent`(1250 emit 闭包)、`this.declaredTools`(1260,1538)、`this.prepareRequest`(1323)、`this.drainTranscribed`(1381,1388)、`this.handleRunFailure`(1404)、`this.finishRun`(1407) | 无（`live.activeRun/model/suspended` 经参数写） |
| `toolCallHooks` | 1418–1426 | 把两个闸门包成这次运行自己的 `ToolCallHooks` 对象（只读 session id） | `this.beforeTool`(1422)、`this.afterTool`(1424) | 无 |
| `handleRunFailure` | 1434–1454 | 把运行之死合成一条 assistant 消息并用它关掉事件流 | 无 | 无 |
| `finishRun` | 1457–1460 | 唤醒 `settle`/`abort` 等待者、交出 activeRun 槽位 | 无（读写均经参数 `state.live.activeRun`） | 无 |
| `prepareRequest` | 1470–1541 | 按请求填充链：重建模型→记录选择→重放→压缩→建 prompt→hooks 改写→交回请求 | `const {sessionManager, settingsManager, tools, hooks, systemPrompt} = this`(1477)、`this.recordSelection`(1487)、`this.compactFor`(1490)、`this.services`(1513 approvalsOf)、`this.declaredTools`(1538) | 无 |
| `declaredTools`（列表外的辅助） | 1549–1556 | 名单→表实例查找 | `this.tools` 以参数 `manager` 传入，不读 this | 无 |
| `runContext` | 1563–1570 | 收集这次运行的 ToolRunContext（工作目录 + bash 超时） | `this.settingsManager`(1568 getBashSettings) | 无 |
| `recordSelection` | 1584–1599 | 把本次请求所用的模型行/档位落到快照（通常空操作） | `this.sessionManager`(1585 recordedOnDisk/setModel/setThinkingLevel/flushMeta)、`this.bag`(1595) | 无 |
| `pumpAttempts` | 1618–1673 | 重试泵：一次供应商调用过重试策略、抽干事件推进引擎读的那条流 | `const {settingsManager, api} = this`(1626)、`this.retryCallbacks`(1662)、`this.endRetry`(1670) | 无 |
| `retryCallbacks` | 1681–1707 | 三个重试通知 → 会话事件 + live 位的映射 | `this.services`(1694,1702 publishState)、`this.endRetry`(1705) | 无（`live.retrying/retryAttempt` 经参数写） |
| `endRetry` | 1710–1721 | 退出重试状态并发布 | `this.services`(1720) | 无（`state.live.retrying/retryAttempt` 经参数写） |
| `compactFor` | 1748–1825 | 压缩阶梯：截短重型参数→清过期结果→摘要 | `const {sessionManager, settingsManager} = this`(1756)、`this.trimRecordedArgs`(1760)、`this.clearStaleToolResults`(1763) | 无 |
| `trimRecordedArgs` | 1835–1854 | 最便宜的一步：截短 write/edit 记录的参数并记账 | `this.sessionManager`(1840 appendTrimToolCallArgs/buildContextEntries) | 无 |
| `clearStaleToolResults` | 1862–1884 | 缓存大概过期时清可重取的工具结果并记账 | `this.sessionManager`(1868 appendClearToolResults/buildContextEntries) | 无 |
| `beforeTool` | 1898–1912 | `before_tool` 闸门：block/suspend/放行 | `this.hooks`(1904) | 无 |
| `afterTool` | 1921–1937 | `after_tool` 闸门：改写是定稿 | `this.hooks`(1928) | 无 |
| `drainTranscribed` | 1946–1952 | 排空一条队列并把每条消息在取走那一刻落盘 | `this.sessionManager`(1949) | 无 |
| `dispatchEvent` | 1961–1993 | 引擎 sink：partial 槽位、落盘非 user 消息、清队列、扇出、按事件发布 | `this.sessionManager`(1977 经 appendMessageEntry)、`this.services`(1991 publishState) | 无（`live.partial` 经参数写） |

共同的桥：`this.services`（245–247）现凑 `{sessionManager, settingsManager, tools}`，喂给 fanout 的 `publishState` 与账本的 `approvalsOf`。

## 2. 文件级机械清单（agent.ts 末尾）

引擎机件小节从 2016 行的分区标题开始，到文件尾 2947 行。

| 函数/类型 | 行号 | 职责 |
|---|---|---|
| `changedApprovals` | 2002–2014 | （会话侧，非引擎）config_changed 只带差异键 |
| `AgentEventSink`（类型） | 2023 | 一次运行的事件去向签名 |
| `ExecutedToolCallBatch` 等四个形状 | 2025–2064 | 工具批/调用结果/更新的中间类型 |
| `streamAssistantResponse` | 2074–2153 | 从模型流式读一条 assistant 响应，进 context、出 sink |
| `failToolCallsFromTruncatedMessage` | 2161–2186 | length 截断消息的全部工具调用判失败 |
| `DanglingToolCall`（类型，导出） | 2189–2192 | 悬空调用 = 调用块 + 发出它的消息 |
| `activeTool` | 2202–2204 | 名单先答"可不可以"、表再交实例 |
| `danglingToolCallsOf`（导出） | 2213–2228 | context 里没有结果回答的调用，按 transcript 顺序 |
| `recoverPendingToolCalls`（导出） | 2246–2302 | 恢复机器：grant 重跑、deny/孤儿合成结果、中途再挂起 |
| `synthesizeToolResult` | 2305–2325 | 用合成错误结果关一个未答调用，带全套事件 |
| `executeToolCalls` | 2336–2354 | 工具批分派：任一 sequential 则串行，否则并行 |
| `executeToolCallsSequential` | 2356–2424 | 串行批 |
| `executeToolCallsParallel` | 2426–2517 | 并行批（finalized 列表里混 thunk） |
| `shouldTerminateToolBatch` | 2519–2521 | 批是否全 terminate |
| `prepareToolCallArguments` | 2523–2535 | 工具自带的参数 shim |
| `prepareToolCall` | 2545–2619 | 解析→shim→schema 校验→`beforeToolCall` 闸门 |
| `emitToolExecutionUpdate` | 2621–2630 | 部分结果的 update sink |
| `RunToolCallOptions` / `runToolCall` | 2633–2679 | 嵌套调用走与模型调用相同的步骤（不导出） |
| `executePreparedToolCall` | 2689–2724 | 经 `ToolManager.execute` 执行，收集 update 事件 |
| `finalizeExecutedToolCall` | 2726–2776 | `afterToolCall` 改写定稿 |
| `createErrorToolResult` 等 3 个小工场 | 2778–2814 | 错误结果 / tool_execution_end / ToolResultMessage / 事件对 |
| `RunStart`（类型，导出） | 2822–2824 | 运行起点：prompt 或 answers，二者取一 |
| `ContextOverflow` | 2833–2839 | 溢出从 produce 抛出、绕过重试分类器 |
| `NO_USAGE` | 2842–2849 | 全零 Usage |
| `failureMessage` | 2852–2863 | 抛异常的流函数 → 引擎结束形状的消息 |
| `pushTerminal` | 2872–2880 | 重试策略敲定的消息 → 引擎终局事件 |
| `pairLateToolResults` | 2894–2937 | 迟到工具结果挪回调用旁（只修请求、不修文件） |
| `messagesOf` | 2945–2947 | entry 选集 → 消息投影 |

**smoke 依赖（导出不能断）**：全仓库没有任何脚本直接 import `core/src/agent(.ts)` 路径；`scripts/smoke-approval-recovery.ts:23–37` 经包入口 `@my-agent/core` import `danglingToolCallsOf` 与 `recoverPendingToolCalls`（`packages/core/src/index.ts` 第二条 agent 出口：`export { danglingToolCallsOf, recoverPendingToolCalls } from "./agent.ts"`）。`RunStart`/`DanglingToolCall` 类型未出现在 scripts，但同文件导出。结论：这两个函数 + 类型导出是 smoke 契约（ADR-0006 §5），任何抽取都必须保住 `index.ts` 的这条出口。

## 3. this.* 访问点分类：编排层语义 vs loop 可自答

判据沿 0012 的方向延续：订阅者表/eventListeners、审批账本、hold、投影、会话表 live 半 = **编排层语义**（白名单回调候选）；读设置、建模型（modelFor/modelChoiceOf）、ToolManager、账本 transcript 操作、`api` 传输层、systemPrompt builder、以及 fanout 文件级函数 = **loop 可自答**（跟着 loop 走或作参数——0012 时代它们正是六件依赖）。

### 编排层语义访问点（白名单回调候选，共 7 类 12 处）

1. **事件 sink 整体** — `this.dispatchEvent`（runEngine:1250 的 emit 闭包 `(event) => this.dispatchEvent(state, session, event)`）。它内部做：partial 槽位、`appendMessageEntry` 落盘（经 `this.sessionManager`:1977）、`dropQueued`/`emitQueueUpdate`、`emitEvent`（订阅者表 eventListeners）、`publishState`（投影）。**这是白名单回调的第一个现成样本**——引擎只 await 它，其余编排语义都藏在它身后。
2. **投影** — `this.services` 递给 `publishState`：run:1199、retryCallbacks:1694/1702、endRetry:1720、dispatchEvent:1991。
3. **审批账本** — `this.services` 递给 `approvalsOf`：prepareRequest:1513（prompt 描述的审批映射）。
4. **会话表** — `this.bag`（recordSelection:1595，为落选择开一只新袋；内部读 `this.sessions` Map）。
5. **快照显示缓存** — `this.sessionManager.setSuspended`（run:1190）。
6. **接缝 hooks** — `this.hooks`：beforeTool:1904、afterTool:1928、prepareRequest:1518（`context` hook）。注意默认 `before_tool` 处理器回调 `Agent.authorize`（1020–1022，经 `this.services`+`this.bag` 读审批映射）——hooks 本身就是编排边界的现成通道。
7. **live 半槽位**（经参数而非 this，但语义属编排）：`live.activeRun` 注册/清零（runEngine:1240、finishRun:1458–1459）、`live.partial/model/suspended/retrying/retryAttempt` 读写遍布 run/runEngine/retryCallbacks/dispatchEvent。

### loop 可自答访问点（共 6 类，全是 0012 的六件依赖的形状）

1. **读设置** — `settingsManager`：runEngine:1224、prepareRequest:1477、runContext:1568、pumpAttempts:1626、compactFor:1756。
2. **建模型** — `modelFor`/`modelChoiceOf`/`rowFor`（导入函数，非 this）：runEngine:1246–1247、prepareRequest:1483–1484、maybeCompact:1091–1093、recordSelection:1587。
3. **执行工具** — `tools`（ToolManager）：runEngine:1224、prepareRequest:1477/1538（`declaredTools` 经参数）。
4. **账本 transcript 操作** — `sessionManager`：buildSessionContext/buildContextEntries（runEngine:1259、prepareRequest:1493、trim/clear 两步）、appendCompaction/appendTrimToolCallArgs/appendClearToolResults（compactFor 族）、recordedOnDisk/setModel/setThinkingLevel/flushMeta（recordSelection:1586–1598）、appendMessageEntry 经 fanout（drainTranscribed:1949、dispatchEvent:1977）。
5. **传输层** — `api`（pumpAttempts:1634）与 prompt builder `systemPrompt`（prepareRequest:1477/1509）。
6. **fanout 文件级函数** — `emitEvent`/`publishState`/`appendMessageEntry`/`dropQueued`/`emitQueueUpdate`（session/fanout.ts，参数是 `(state, session, services)`）：它们不是 this 访问点，抽走时作参数跟着 loop 走即可；唯一的 coupling 是它们要 `services` 袋，而 `this.services` 又是编排层的桥。

### 每方法分类小结

- `run`：sink 组装（编排）+ setSuspended/发布（编排）+ 泵/引擎调用（内部）。**以编排语义收尾。**
- `runEngine`：六个 this 依赖解构（可自答）+ emit 闭包（编排入口）+ 队列 drain（fanout，可自答）+ activeRun 注册（live 半语义）。
- `toolCallHooks`/`beforeTool`/`afterTool`：纯接缝转发（hooks = 编排边界的白名单候选）。
- `handleRunFailure`/`finishRun`：零 this 访问，任意分类下都干净。
- `prepareRequest`：五件依赖解构 + services→approvalsOf（审批账本，编排）——是编排语义密度最高的填充环节。
- `runContext`/`pumpAttempts`：纯设置 + api，**完全可自答**。
- `retryCallbacks`/`endRetry`：live 位（编排）+ emitEvent/publishState（编排）——重试报告天然贴着订阅者。
- `compactFor` 族：账本写 + emitEvent，账本是依赖（可自答）、事件是编排。
- `recordSelection`：**唯一摸会话表的方法**（this.bag）。
- `drainTranscribed`/`dispatchEvent`：账本落盘 + 扇出，落盘可自答、扇出是编排。

## 4. 三处运行入口

| 入口 | 行号 | 现在怎么进 run | 传什么 |
|---|---|---|---|
| `startPromptedRun` | 725–735 | `bag(id)` 开一只袋 → `nextStamp`/`appendMessageEntry` 写 prompt 消息（经 `this.sessionManager`）→ `publishState` → `await this.run(state, { prompt: message }, bag)` | `(state, {prompt: Message}, bag)` |
| `respondApproval`（恢复路径） | 939–960 | `agentState(id)` → 空闲检查 → `bag(id)` → `danglingApprovals` 找调用 → grant 时先把选择写快照（`setToolConfig`/`approvalsOf`/`toolStateOf`，全经 this）→ `publishState` → `await this.run(state, { answers }, bag)` | `(state, {answers: Record<id, ToolCallAnswer>}, bag)` |
| `maybeCompact` | 1082–1097 | **不进 run**：`agentState` + `bag` → 自己用 `modelChoiceOf`+`modelCatalog`+`modelFor` 算模型 → 直接 `this.compactFor(state, bag, entries, now, signal, model)` | `(state, bag, entries, now, signal, model)` |

`run` 本体签名：`private async run(state: AgentState, start: RunStart, transcript: Session)`（1143–1147）。`RunStart` 是文件级导出（2822–2824）：`{prompt}` 与 `{answers}` 二选一。

### 改成单个 loopOptions 参数袋要补什么

1. **袋子形状**：`{ state, bag, start }` 三件是每次调用变化的；六件依赖（sessionManager、settings、tools、hooks、systemPrompt、api）目前是 `this` 字段——若 loop 抽成对象/闭包，这六件要么进 loopOptions（0012 的 `LoopManagerConfig` 原样回归），要么做成白名单回调袋里的固定槽。
2. **maybeCompact 的缺口**：它绕过 run 直达 `compactFor`，且自己算模型。loopOptions 化后需要 loop 暴露一个压缩入口，袋里带 `{ state, bag, entries, now, signal, transport? }`，模型由 loop 内部从 settings+live.openedOn 现算（把 1091–1095 四行搬进去），否则 `maybeCompact` 仍要摸 settingsManager。
3. **respondApproval 的前置账**：找悬空调用、grant 记选择、publishState 这三步是审批账本语义（编排层），必须留在 Agent；它交给 loop 的只有 `{answers}` + bag。缺口是：`danglingApprovals` 读的 `this.sessionManager.buildContextEntries` 与 loop 恢复遍读的是同一只袋——loopOptions 必须保证传同一只袋实例（现状靠 startPromptedRun/respondApproval 各自 `bag(id)` 一次保证，ADR-0019 §2）。
4. **startPromptedRun 的写消息**：`nextStamp`/`appendMessageEntry` 经 sessionManager——留在编排层，loop 只收 `{prompt: Message}`；消息已落袋，引擎回显不重写（1141 的注释链）。
5. **emit 回调**：loopOptions 至少要带一个 `emit`/`onEvent` 白名单回调（现成的 `dispatchEvent` 签名 `(state, session, event)` 即可），否则 runEngine:1250 的闭包 `(event) => this.dispatchEvent(...)` 无处安放。
6. **live 半写权**：loop 写 `live.partial/model/suspended/retrying/retryAttempt/activeRun`——这些经参数 `state` 已可行；loopOptions 带上 `state` 即可，无需新的 accessor。

## 5. 事件 sink 现状

**emit 闭包（1250 行）**：

```ts
const emit: AgentEventSink = (event) => this.dispatchEvent(state, session, event);
```

构造点在 `runEngine` 内、activeRun 注册之后：闭包捕获运行栈上的 `state`（AgentState 参数）与 `session`（run-local 袋参数），转发给 `this.dispatchEvent`。`AgentEventSink` 类型在 2023 行：`(event: AgentEvent) => Promise<void> | void`——被 await，所以运行只在写入落地后安顿。这一个闭包随后作为实参穿过：恢复遍（1280）、流式（1343）、工具批（1362）、失败处理（1404）。

**dispatchEvent（1961–1993）**用到的东西：

- `state.live`：`partial` 槽位（message_update 留存、message_end/agent_end 清）、`suspended`（agent_end 时判断是否清队列）；
- `messageDeltaOf`（session/events.ts）算 delta，`emitEvent(state, …)` 打进 eventListeners（订阅者表）；
- `appendMessageEntry(state, session, this.sessionManager, …)`：message_end 且非 user 时落盘（账本服务）；
- `dropQueued(state)` + `emitQueueUpdate(state)`：agent_end 且非 suspended 时清队列；
- `publishState(state, session, this.services)`：message_start/message_end/turn_end 三类事件后发布（投影）。

即：**一个 dispatchEvent = live 半 + 订阅者表 + 账本落盘 + 队列 + 投影**。它正是引擎曾被递入的 `Loop.subscribe` 回调的继任者（1958 行注释自认），是白名单回调的第一个现成样本——把 `dispatchEvent` 的签名抽成回调，引擎就不再摸任何编排语义。

## 6. 0012 时代参照：**loop-manager.ts 无法从 git 取回**

票面要求 `git show <rev>:packages/core/src/loop-manager.ts`，但**该文件从未进入任何提交**：

- `git log --all --oneline -- packages/core/src/loop-manager.ts` → 空；`--follow` 与通配 `*loop-manager.ts` → 同样空。
- 对全部 208 个提交的树做 `git ls-tree -r | grep loop-manager`：任何一棵树里都没有 `packages/core/src/loop-manager.ts`，只有 `.scratch/loop-manager/`（map.md + 5 张 issue）与两份 ADR。
- `git stash list` 空；`git fsck --dangling` 的 blob 中无 LoopManager 残留。

原因在提交本身：**511fc09**「在制收账：LoopManager 三部曲落地（ADR-0012 立对象、0013 改参数、0014 当日推翻删除）」把工作区里先行的三次搬动**一次性入库**——对象建立、削依赖、删除都发生在两次提交之间的工作区里，入库时 `loop-manager.ts` 已经不存在了（该提交的 stat 只有 agent.ts 重写 3682 行 + fanout/events 新文件 + ADR 三份）。ADR-0014「不可逆性」一节「一天之内第三次搬同一批代码」说的正是这段窗口期。

**替代证据**（0012 时代形状的两条来源）：

1. `.scratch/loop-manager/`（仍在工作区，历史版本在 e36befb 可取）：`map.md` 记录五张票的边界拍板——引擎+填充链+压缩+重试+闸门+sink 归 LoopManager，会话表/命令/审批/投影留 Agent，fanout 抽 `session/fanout.ts`；`issues/01-injection.md` 记录构造注入形状：`AgentConfig` 必填 `loop: LoopManager`，`api`/`systemPrompt`/`hooks` 从 AgentConfig 移出归 `LoopManagerConfig`，`createSessionAgent` 组装。
2. ADR-0012 决定 2/4 的文字：六件依赖 = 账本（sessionManager）、`SettingManager`、`ToolRegistry`（tools）、`Hooks`、prompt builder（systemPrompt）、`base: ChatTransport`（api）；`AgentState` 作参数递进，事件与投影走 fanout 文件级函数。构造签名即 `new LoopManager(config: LoopManagerConfig)`，其中 `LoopManagerConfig = { sessionManager, settings, tools, hooks, systemPrompt, api }`（AgentConfig 同步瘦身为 `{ sessionManager, settings, tools, loop }`）。

因此 `old-loop-manager.ts` 无法存盘；本节即第 6 项的完整替代记录。若需要 0012 前夜的代码形状，最近似的历史快照是 **511fc09^ 的 `packages/core/src/agent.ts`**（ADR-0008 状态、引擎首次并入 Agent 的版本，改写前 3682 行 diff 的旧侧），可按需取 `git show 511fc09^:packages/core/src/agent.ts`。

---

## 摘要

- run 一族总行数 ≈ **1805**：成员引擎段 1122–1994（873 行）+ 文件级机件 2016–2947（932 行），占 agent.ts（2947 行）的 61%。
- 编排层语义访问点 **7 类 12 处**：dispatchEvent 整体（sink 样本）、publishState×5（run/retryCallbacks×2/endRetry/dispatchEvent）、approvalsOf（prepareRequest）、this.bag（recordSelection）、setSuspended（run）、this.hooks×3（beforeTool/afterTool/context hook）、live 半槽位（经参数）。
- loop 可自答访问点 **6 类**（≈25 处）：settingsManager×5、tools×3、sessionManager 账本操作×12、api、systemPrompt、fanout 函数——恰好是 0012 六件依赖的形状。
- 三处入口改 loopOptions 的缺口：maybeCompact 绕过 run 直达 compactFor 且自带模型计算；respondApproval 的审批前置账（找调用/grant 记选择/发布）必须留在编排层且与 loop 共享同一只袋；loopOptions 需补 emit 白名单回调（dispatchEvent 签名现成）+ 六件依赖或其回调化。
- old-loop-manager.ts：**不存在于任何提交**（511fc09 一次性入库时已删），无法取回；替代证据为 `.scratch/loop-manager/` 设计文档 + ADR-0012 文字 + `git show 511fc09^:packages/core/src/agent.ts`。
