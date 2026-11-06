# 03 - 执行改道后 Context.tools 的命运

Type: grilling
Status: resolved
Blocked by: 02

## Question

定案 2 要求「执行也改道 Manager」。今天引擎的工具全部读 `Context.tools`
（ADR-0015 定为**必填 wire 字段**）：`agent.ts:1288` 每请求 `active()` 现建、
`:1849` `toToolDeclaration` 削薄声明、`:2091` `executionMode`、`:2272` `find`、
`:2402` `execute`、`:1534` 压缩摘要 `tools: []`、`:2020` 恢复机器 `recoverPendingToolCalls`、
`:2376` `runToolCall`。ADR-0015 决定 7 还写明「传输层看得见 `execute`，但不调用它」。

请裁决：

- **(a)** `Context.tools` 保留为**声明载体**——放 Map 里实例的引用（或声明视图）给传输层，
  所有查找与执行改走 `manager.get(name)` / Manager 的执行入口；字段仍必填，线协议零改动。
- **(b)** 从 `Context` 删掉 `tools`，传输层的声明改从 Manager 现取；要改 `llm/types.ts` 的
  `Context`、`streamAssistantResponse` 的 `stream` 调用形状与 ADR-0015。
- **(c)** `Context.tools` 仍旧每请求现建，只有执行查找走 Manager；Map 只服务执行、声明仍走工厂，
  等于两套工具来源。

并逐条点名改道覆盖的调用点（`executeToolCalls` / `prepareToolCall` /
`prepareToolCallArguments` / `executePreparedToolCall` / `recoverPendingToolCalls` /
`runToolCall` / 压缩摘要 / `streamAssistantResponse`），以及「Manager 是否也 owns `execute` 本身」
（即 `Tool.execute` 还在 Tool 上，还是搬到 Manager 的方法里）。

➡️ 推荐 **(a)**：改道覆盖全部执行调用点，但 `toToolDeclaration` 仍从 `Context.tools` 读声明，
传输层零改动。(c) 会留下两份工具来源，(b) 把一次 core 重构升级成 wire 重构、面铺得太大。

## Answer

**2026-11-06 定案**（`Type: grilling`，按票面 `➡️` 原样敲定、未推翻；本票代码一行未动）。

### 结论（一句话）

**选 (a)**：`Context.tools` 保留为**声明载体**——仍必填、仍是 `Tool[]`、线协议零改动，元素放
Manager 那张 Map 里的**实例引用**（本请求的活跃子集）；引擎的**全部执行查找与执行**改走
`manager.get(name)` / Manager 的执行入口，`Context.tools` 从此只被传输面读。
`toToolDeclaration` 与 `streamAssistantResponse` 一行不动，压缩摘要的 `tools: []` 一行不动。

**Manager owns 调用，不 owns 实现**：`Tool.execute` 留在 `Tool` 上（沿用 02 号票的
`execute(…, run, …)` 签名）；Manager 新增一个执行入口，内部 `get(name)` 后转发给那个实例的
`execute`，于是全仓生产代码唯一的 `Tool.execute` 调用点从 `agent.ts:2402` 搬进 Manager，引擎不再
直接调用它。参数校验、`prepareArguments`、两道闸门、事件与结果定稿仍归引擎。

按 `docs/agents/issue-tracker.md` 与本图「执行票仍一票一会话 / 等 02–06 定案后一次 graduate」，
本票只出决定；代码落地、smoke 改写、文档与 ADR 收账归之后 graduate 的 `task` 票。
**04 / 05 / 06 的问题一律不代答**；凡 §2 / §4 与它们重叠处，以 §6 的「未回答」清单为准。

### 0. 先把票面的行号钉到今天的树（`91f1748`）

票面八个行号逐条对得上，且「今天引擎的工具全部读 `Context.tools`」成立：

- `agent.ts:997-1000`：`Agent.run` 建 `currentContext`，`:999` 是
  `tools.active(toolStateOf(sessionManager, session, settings, tools), this.runContext(state))`；
  `:1011-1018` 恢复机器入口、`:1081` 流式、`:1101` 批次执行。
- `:1281-1289`：`prepareRequest` 重建这份 `Context`，`:1288` 是同一句 `tools.active(...)`。
  `:1298-1306` 的 `runContext(state)` 是 02 号票认下的 per-run 值唯一生产者。
- `:1530-1544`：压缩摘要绕开引擎直接 `model.stream({ messages, system, tools: [] }, …)`（`:1534`）。
- `:1841-1855`：`streamAssistantResponse`，`:1849` `context.tools.map(toToolDeclaration)`，
  `:1852` `model.stream(requestContext, …)`。
- `:2005-2053`：`recoverPendingToolCalls`（**导出**），`:2020` `prepareToolCall`、`:2034`
  `executePreparedToolCall`、`:2035` `finalizeExecutedToolCall`。
- `:2082-2097`：`executeToolCalls`，`:2091` 用 `currentContext.tools.find(...).executionMode` 判
  顺序/并行；`:2099` / `:2161` 两条批次路径分别在 `:2114` / `:2176` 预备、`:2133` / `:2212` 执行。
- `:2250-2262` `prepareToolCallArguments`（收 `tool: Tool<any>`，自己不查表）；
  `:2264-2339` `prepareToolCall`，`:2270` 默认形参 `tools = currentContext.tools`、`:2272` `find`、
  `:2282` `prepareArguments`、`:2283` `validateToolArguments`、`:2329` 把 `tool` 放进 `PreparedToolCall`。
- `:1805-1810` `PreparedToolCall` 持有 `tool`；它今天**只有** `:2402` 一个读者
  （`:2442` / `:2472` 只读 `toolCall` / `args`）。`:2352-2362` `RunToolCallOptions.tools` 是第二份
  工具清单，`:2374-2391` `runToolCall`（`:2371` 注释：今天无人调用）在 `:2376` 把它传给 `prepareToolCall`。
- `:2393-2424` `executePreparedToolCall`，`:2402-2410` 是全仓 `packages/` 里**唯一**的
  `Tool.execute` 调用点（全仓 grep `.execute(` 只此一处）。

票面没点名、但同一条决定必须一并交代的传输面读点（都是「线协议零改动」的核对项）：

- `llm/types.ts:439-476` 单一 `Tool`（声明 + `execute` 同住）、`:516-521` `Context.tools: Tool[]`
  必填、`:195-197` `ChatTransport.stream(model, context, options)`、`:218-222` `StreamFunction`；
  `llm/model.ts:168-170` `Model.stream(context: Context, options)` 直转 `transport.stream`。
- `llm/utils/transcript.ts:32-40` `toToolDeclaration`（只留四个声明字段，返回标 `→ Tool` 的对象，
  靠 `@ts-nocheck` 编译通过；ADR-0015 *后果*已记这处类型不诚实）。
- `llm/api/anthropic-messages.ts:805-813` `convertTools(context.tools, …)`、`:1054-1059` 细粒度
  tool streaming beta 的 `context.tools.length > 0`、`:1096+` `convertTools` 只读声明字段；
  `llm/utils/estimate.ts:96-125` `estimateContextTokens` → `estimateToolsTokens(context.tools)`，
  被 `llm/api/simple-options.ts:11-15` 的 `clampMaxTokensToContext` 用来算 `maxTokens`。
- `scripts/fake-transport.ts:175-179` `serializeContext`、`scripts/smoke-session.ts:348-351`
  `declaredTools(context)`、`scripts/smoke-models.ts:154` / `:274` 两处 `tools: []` wire 捕获；
  `scripts/smoke-approval-recovery.ts:254-260` 的假 `readTool` 与 `:268` / `:287` / `:305` 三处把工具
  塞进 `Context.tools` 的调用（05 号票点名过这片断言区）。
- **不是** `Context.tools`、而是从 `this.tools` 读的目录查询：`agent.ts:528` `setActiveTools` 的
  未知名校验、`:610` / `:684` `toolStateOf`、`session/fanout.ts:85` `allTools`、
  `session/tool-config.ts` 四个函数、`session-factory.ts:142` / `:285` / `:344` 装配点。它们属于
  04 / 05 的「活跃集归属 / 方法去留」，本票不改道，也不代答。

### 1. 三条路逐条裁决（含各自要动什么）

#### (a) 声明载体 + 全量执行改道 —— **选**

一条来源、两个视图：Map 是唯一事实，`Context.tools` 是这次请求递给传输面的那一份**视图**，
引擎的查找与执行都从 Map 出。`llm/`、wire、ADR-0015 决定 2/3/7 全不动；改的只有 `agent.ts`
里那些「拿 `Context.tools` 当执行目录」的读点，与 Manager 新增的执行入口。

票面 (a) 里「实例的引用（或声明视图）」这个二选一，本票一并定死：**放实例引用**，
`toToolDeclaration` 照旧每请求削薄。理由：改成声明视图要么给 `llm/types.ts` 加一个窄类型
（决定 3 的必填 `Tool[]` 就变了，等于半个 (b)），要么继续让 `toToolDeclaration → Tool` 说谎；
而 schema 反正每请求都要克隆一份（`transcript.ts:37`），换视图不省任何东西，只多一处要收账的形状。

决定性的一条：`Context.tools` 装的不是「全部工具」，而是**这个会话这次请求启用的子集**
（`prepareRequest:1288` 从 `toolState` 派生；`docs/architecture.md:125` 写明未激活工具的调用要回
`Tool <name> not found`）。Map 装的是全部六个（定案 1）。两者不能互相换算——这正是 (b) 的根子，
见下。

#### (b) 删掉 `Context.tools` —— **否决**

要动什么：`llm/types.ts:516-521` 删字段；`ChatTransport` / `StreamFunction` / `Model.stream`
的 `stream(context: Context)` 形状（`:195-197`、`:218-222`、`model.ts:168-170`）；
`streamAssistantResponse:1847-1855` 构造 `requestContext` 的方式；
`anthropic-messages.ts:805-813` / `:1058`、`estimate.ts:101` + `simple-options.ts:13`、
`transcript.ts:33-40` 全都要另找一份声明清单；`agent.ts:1534` 与 `smoke-models.ts:154` / `:274`
的 `tools: []` 字面量、`fake-transport.ts:176`、`smoke-session.ts:350` 的声明捕获一起改写；
ADR-0015 决定 2/3/7、*后果*与*没有被取代的*两节，`architecture.md:112` / `:119` / `:125`、
`AGENTS.md:36-44` 的 wire 那半句，以及 06 号票要收的账。这是把一次 core 工具域重构升级成
**vendored 传输层 + wire 形状**重构，票面已判「面铺得太大」。

更要命的是**活跃集无处安放**。传输层若「从 Manager 现取」，拿到的只能是 Map 里的全部六个：
要么把会话禁用的工具一并发给模型（产品语义变化，`setActiveTools` 与模式的收窄当场失效），
要么让进程级 Manager 回答「本会话这一轮启用哪些」——把 per-session 选择塞回常驻服务，正是
02 号票 (b)/(d) 与 04 号票 (c) 否掉的形状。要保住子集，只能给 `stream` 再加一个
`activeNames` / `declarations` 参数或 options 字段：那只是把 `tools` 换个名字重新加回请求形状，
决定 3 作废而收益为零。同理 `estimateContextTokens` 要按**这次请求**的声明数算 token 预算，
它也得拿到同一份子集。

还有 ADR-0015 决定 7 的方向：今天传输层「看得见 `execute` 但不调用」是 `toToolDeclaration`
削过之后的一句约定；让传输层反过来握住一个带执行入口的 Manager，只会把这条边界推得更松，
而不是更紧。本图 *Out of scope* 允许 03 定案动 `Context` wire，那是**许可不是要求**；(a) 不付
这份代价就到终点。

#### (c) 声明仍走工厂、只有执行改道 —— **否决**

票面已判「等于两套工具来源」，这里把代价钉死：

1. **与 02 号票已定的形状不变量直接冲突**。02 §2.3 / §5 #3 要求「任意两次 `get(name)` 恒 `===`、
   任意两个会话的活跃集里同名工具恒 `===`」；(c) 下活跃集是每请求现造的新对象，同一会话连着
   两个请求都不相等，这条不变量为假，02 定案的一张 Map 也不再是「全部 Tool」的唯一事实。
2. **声明与执行会各自漂移**。`executionMode`（`:2091`）从 `Context.tools` 的工厂实例读，
   `validateToolArguments`（`:2283`）校验工厂实例的 `parameters`，而 `:2402` 的 `execute` 跑在
   Map 实例上；`prepareArguments` 是工具上的可执行 shim，声明侧那份与执行侧那份可以不是同一个
   实现。05 号票若保留 `register()`，注进一边的自定义工具对另一边就是隐形的。
3. **第二、第三份来源被留下来**。`prepareToolCall` 的 `tools` 覆盖形参（`:2270`）与
   `RunToolCallOptions.tools`（`:2355`）今天就是绕开 `currentContext.tools` 的两条支路，(c) 不改
   它们；「定案 2：全量改道」落空，将来复活 `runToolCall` 就把 (c) 一起带回来。
4. **现建已经没有理由**。02 §2.2 之后六个工厂零参、无 per-request 值，每请求现建只剩「每请求
   造一个新对象」，零收益、双倍生命周期，还要为它保留 `toolListFor` / `createTools` 这条构造链。

### 2. (a) 的精确形状

#### 2.1 `Context.tools` 是什么、不是什么

`llm/types.ts:516-521` 一行不动：`tools: Tool[]` 必填、空数组合法。它的职责从「引擎的执行目录」
收窄成「**这次请求带哪些声明**」；元素是 Manager 那张 Map 里的实例引用，按活跃名单取出的子集。
`:999` / `:1288` 两个生产者不再 `active(state, run)` 现建（`run` 不进 `Context`，02 决定 4）；
**谁筛活跃名单归 04**，但筛出来的元素必须来自 Map、不得新造——这是 (a) 对 04 唯一的前置约束，
不是替 04 选归属。于是 02 的恒等不变量在 (a) 下可测：`Context.tools` 里每个实例
`=== manager.get(name)`。

引擎从此**不读** `Context.tools` 做任何查找：它读的是 Manager。`toToolDeclaration` 仍是请求出
引擎前唯一的削薄步骤，传输层拿到的形状与今天逐字节同形。

#### 2.2 一条来源，两种读法

- `manager.get(name)`：引擎唯一的查表动作（`executionMode` 判定、`prepareToolCall` 的解析）。
- Manager 的执行入口：全仓唯一的 `Tool.execute` 调用点（名字/签名归 05）。
- `Context.tools`：只被传输面（`:1849` → `Model.stream` → `anthropic-messages.ts` / `estimate.ts`）
  读声明字段。ADR-0015「传输层只读前一半、引擎只用后一半」的分界原样保留，决定 7 不重写。

#### 2.3 执行链怎么拿到 Manager 与 `run`

批次机器是**文件级函数**（`:2082`、`:2099`、`:2161`、`:2264`、`:2393` 等），没有 `this`；
Manager 是 `Agent` 的服务字段（今天这个位置是 `ToolRegistry`，`:211`），`run` 是 `Agent.run` 的栈上局部（02 §2.4）。
两者像 `hooks`（`:992` / `:1161-1169` 的先例）一样由 `Agent.run` **显式当参数传下去**：
`:1011` `recoverPendingToolCalls` 与 `:1101` `executeToolCalls` → 两条批次路径 →
`prepareToolCall` → `executePreparedToolCall` → Manager 执行入口 →
`Tool.execute(toolCallId, params, run, signal, onUpdate)`。`recoverPendingToolCalls` 是导出的
（`:2005`），签名随之多出 Manager（和 02 的 `run`）；宿主/smoke 怎么供这两样归 05。

不设模块级「当前 Manager」、不把它塞进 `Context`、不进 `AgentState.live`（02 决定 4、
ADR-0014）：传参不产生第二个持有者，Manager 仍是那一只进程级服务。

#### 2.4 Manager 是否 owns `execute` 本身 —— **owns 调用，不 owns 实现**

- **`Tool.execute` 留在 `Tool` 上**：`llm/types.ts:460-465`，按 02 号票加第三位必填 `run`；
  六个工厂的薄包装不动。Manager 不按 `name` switch 实现六个行为，也不另存六份闭包。
- **Manager 新增一个执行入口**（名字与旧五法的去留归 05）：内部 `get(name)` 后原样转发
  `Tool.execute(toolCallId, params, run, signal, onUpdate)`。`:2402` 变成
  `manager.execute(...)`，引擎任何位置都不再直接调 `Tool.execute`。
- **Manager 不 owns**：`validateToolArguments`（`:2283`）、`prepareToolCallArguments`（`:2250-2262`）、
  `before_tool` / `after_tool` 闸门、批次事件与结果定稿（`:2099-2244`、`:2426+`）。这些是
  **一次调用的编排**，搬进 Manager 就要让它拿 hooks / 事件 sink / `run`，等于把 per-run 瞬态
  请回进程级服务，正是 02 §1(b) 的否决理由。
- **两次查表是可接受的**：`prepareToolCall` 为校验与 shim 先 `get(name)` 一次，执行入口再
  `get(name)` 一次。02 §2.3 的 Map 不可变 + 恒等不变量保证两次拿到同一个实例；
  `PreparedToolCall.tool`（`:1808`）遂不必留可执行引用，避免 prepared 记录成为工具的第二持有者
  （执行票若为省一次查表而保留引用，也必须是同一 Map 实例，不改语义）。
- **未知名行为不变**：仍在 `prepareToolCall` 的闸门前回今天那句 `Tool ${name} not found`
  错误结果（`:2273-2279`、`architecture.md:125`），执行入口不重复判活。异常→错误结果、
  `signal` / `onUpdate` 的转发、审批 grant 重跑的语义全不变。

三条理由：① ADR-0015 决定 2 把声明与执行合进**一个** `Tool`，搬走 `execute` 就是把刚合上的
类型拆回两个，决定 7 的分界与 `Context.tools` 的元素类型要一起重写；② 02 号票的
`execute(…, run, …)` 已经把「行为在实例上、per-request 值在实参里」定死，Manager 没理由接手
实现；③ 定案 2 说的是「Manager 内部拿 Map 里的 Tool 调用」，不是「把六个实现搬进 Manager」。

#### 2.5 「线协议零改动」的核对清单（都不动）

`llm/types.ts:516-521` / `:195-197` / `:218-222`、`model.ts:168-170`；
`streamAssistantResponse:1847-1855` 与 `toToolDeclaration`（`transcript.ts:33-40`）；
`anthropic-messages.ts:805-813` / `:1054-1059` / `:1096+`；
`estimate.ts:96-125` 与 `simple-options.ts:11-15`；压缩摘要 `:1534` 的 `tools: []` 与
`smoke-models.ts:154` / `:274`；`fake-transport.ts:176` 与 `smoke-session.ts:350` 的声明捕获；
ADR-0015 决定 2/3/7 与 *没有被取代的* 一节。06 号票仍要为「重新引入常驻实例表的工具服务」
收账（名字、新 ADR、取代指针），但那不是「因为 03 动了 wire」——03 没动。

### 3. 改道覆盖的调用点，逐条点名

| 调用点 | 今天 | (a) 之后 | 执行改道？ |
|---|---|---|---|
| `executeToolCalls` `:2082-2097`（含 `:2099` / `:2161` 两条批次路径） | `:2091` `currentContext.tools.find(...).executionMode` 判顺序/并行 | 改 `manager.get(tc.name)?.executionMode`；两条路径的 `prepareToolCall` / `executePreparedToolCall` 顺链接收 Manager + `run` | **是** |
| `prepareToolCall` `:2264-2339` | `:2270` 默认 `tools = currentContext.tools`、`:2272` `find` | 删掉 `tools` 覆盖形参，改 `manager.get(toolCall.name)`；`:2282` `prepareArguments` / `:2283` `validateToolArguments` 仍读这个 Manager 实例的字段，函数体不动；未知名错误结果不变 | **是** |
| `prepareToolCallArguments` `:2250-2262` | 收 `tool: Tool<any>`，自己不查表 | 一行不动；改道在调用者——传进来的必须是 Manager 解析出的那个实例 | **是（传递覆盖，零改动）** |
| `executePreparedToolCall` `:2393-2424` | `:2402` 全仓唯一 `prepared.tool.execute` | 改调 Manager 执行入口（按 name 现取 + 转发 `run`）；`PreparedToolCall.tool` 不再留可执行引用；`signal` / `onUpdate` / 异常→错误结果不变 | **是** |
| `recoverPendingToolCalls` `:2005-2053`（导出） | grant 经 `:2020` / `:2034` 复用同一条预备→执行链，工具从 `currentContext.tools` 解析 | `:1011` 的入口把这一轮的 Manager + `run` 传进去（审批是「结束重启」后的新一轮，ADR-0006 §5）；导出签名随之扩展，宿主/smoke 怎么供归 05；`smoke-approval-recovery.ts:305` 把假 tool 塞进 `Context.tools` 的做法随 (a) 失效 | **是** |
| `runToolCall` `:2374-2391`（今天无人调用） | `RunToolCallOptions.tools`（`:2355`）经 `:2376` 传成第二份清单 | 删 `options.tools`；预备与执行都走 Manager，补 `run` 实参（02 §2.4）。仍不导出、仍无人调用，但形状不许留第二来源 | **是（形状覆盖，零行为）** |
| 压缩摘要 `:1530-1544` | `:1534` 直接 `model.stream({ ..., tools: [] })`，绕过引擎 | 原样保留：没有工具、没有查找、没有执行；`Context.tools` 必填所以空数组照写，不引 Manager，两处 wire 捕获不动 | **否，明确排除** |
| `streamAssistantResponse` `:1841-1855` | `:1849` `toToolDeclaration` 从 `Context.tools` 削薄，`:1852` `model.stream(requestContext)` | 原样保留：它不是执行点，是传输面的声明出口；这正是 (a) 相对 (b) 的全部收益 | **否，明确排除** |

另点名两处票面未列、同样要说清的：

- `:999` / `:1288` 是**生产端**，不是执行查找：受 §2.1 约束（元素必须来自 Map、`run` 不接），
  筛选归属归 04。
- `:528` / `session/fanout.ts:85` / `session/tool-config.ts` / `session-factory.ts:142,285,344`
  从 `this.tools` 读目录，不是 `Context.tools`：归 04 / 05，本票不改道。

### 4. 改动面清单（交给执行票；本票不动）

| 子系统 | 落点 |
|---|---|
| 类型 / wire | **零改动**；§2.5 那一列是执行票的「核对不动」清单，不是改动清单 |
| 引擎 `agent.ts` | `:999` / `:1288`（生产端元素改从 Map 取）、`:1011`（恢复入口传 Manager + run）、`:1101` → `:2082` / `:2091` / `:2099` / `:2161`（链上带 Manager + run）、`:2250-2262`（不动，传递覆盖）、`:2264-2339`（`get` 取代 `find`、删 `tools` 形参）、`:1805-1810`（`PreparedToolCall` 收敛）、`:2352-2391`（删 `RunToolCallOptions.tools`）、`:2393-2424`（`:2402` 改走 Manager）、`:1298-1306` 保留 |
| Manager（名字归 06、方法名与 `register()` 归 05） | 新增执行入口：`get(name)` + 转发 `Tool.execute(…, run, …)`；Map 形状与懒加载仍按 02 §2.3 |
| 服务装配 | `AgentConfig.tools` / `Agent.tools`（`:133` / `:211`）、`SessionServices.tools`（`fanout.ts:27`）、`session-factory.ts` 三个构造点：换成 Manager 的线怎么落归 04 / 05 |
| smoke | 要跟的读点：`smoke-approval-recovery.ts:254-260, 268, 287, 305`（假 tool 与三处 Context 字面量）、`fake-transport.ts:175-179`、`smoke-session.ts:348-351` 的声明捕获、`smoke-models.ts:154, 274` 的两处 `tools: []`（不动）；断言怎么改写归 05 |
| 文档 / ADR（归 06） | 会被本票推翻、收账票要核对的现文：`docs/architecture.md:119`「`Context.tools` 里装的就是这些可执行集合本身」、`:125`「循环执行的东西」、`AGENTS.md:36-37`「它调的是 `Tool.execute`」、`:42-48` tool 词条；ADR-0015 决定 7 的分界陈述在 (a) 下**仍成立**，按 `docs/adr/README.md:44` 只增不改原文，是否新开 ADR 与取代指针全归 06 |

### 5. 决定记录（下游可直接依赖）

| # | 决定 | 约束谁 |
|---|---|---|
| 1 | 选 (a)：`Context.tools` 保留为必填 `Tool[]` 声明载体，元素是 Manager Map 里的**实例引用**（活跃子集），线协议与 `llm/` 零改动 | 执行票、04、06 |
| 2 | `Context.tools` 只被传输面读；引擎任何执行查找都不读它。`toToolDeclaration` / `streamAssistantResponse` / 压缩摘要 `tools: []` 一行不动；ADR-0015 决定 2/3/7 的现状陈述在 (a) 下仍成立（06 是否加取代指针另论） | 执行票、06 |
| 3 | 改道覆盖 §3 的六个执行调用点（含无人调用的 `runToolCall` 与导出的恢复机器）；压缩摘要与 `streamAssistantResponse` 明确排除；`prepareToolCall` 的 `tools` 形参与 `RunToolCallOptions.tools` 删除 | 执行票、05 |
| 4 | Manager owns 调用、不 owns 实现：`Tool.execute`（含 02 的 `run` 实参）留在 `Tool` 上；Manager 新增执行入口做 `get(name)` + 转发，成为全仓唯一 `Tool.execute` 调用点；校验 / shim / 闸门 / 事件 / 定稿仍归引擎 | 执行票、05、06 |
| 5 | Manager 与 `run` 由 `Agent.run` 像 `hooks` 一样显式传过执行链；不设全局、不进 `Context` / `AgentState.live`；两次 `get(name)` 由 02 的恒等不变量担保 | 执行票 |
| 6 | 未知名仍由 `prepareToolCall` 在闸门前回 `Tool <name> not found`；异常→错误结果、审批恢复语义不变 | 执行票、05 |
| 7 | 否 (b)：`Context.tools` 承载的是 per-request 活跃子集，删它要么把未启用工具发给模型、要么把 per-session 状态塞回常驻服务、要么把 `tools` 换个名字加回 `stream`；且要动 vendored 传输层与 ADR-0015。否 (c)：与 02 的恒等不变量冲突，留两份构造源与多条旁路 | 06、执行票 |

### 6. 本票没有回答的（别当成已定）

`Context.tools` 的活跃名单**由谁筛**、`SessionServices.tools` 与审批的归属（04）；Manager 的
名字与执行入口的**方法名/签名**、旧五法去留、`register()`、`createTools(run)` 的收法、smoke
断言与 `recoverPendingToolCalls` 宿主怎么供 Manager + run（05）；`ToolManager` 名字冲突、是否
新开 ADR、历史 ADR 取代指针与文档归属（06）；执行票怎么切、何时 graduate（本图
*Not yet specified*，等 02–06 全定案后一次 graduate）。§2 / §4 写的是 (a) **必然带来**的形状
后果与要跟的读点，不是替这四张票做选择。

### 7. 验收（2026-11-06 与 01 号票基线对跑）

本票未改任何 `packages/` 源码或 `scripts/smoke-*.ts`；按图「每票收账跑 `npm run check`」是本票的
验收项，下面这遍全套 28 条对跑是实现流程要求的收尾复跑、不是本票新增的验收门槛。本票是 grilling
决策票、零代码改动，TDD 无适用接缝。

- `npm run check`：**绿**，`tokens ok: 137 defined, 111 referenced`；`check.log` 与基线逐字节相同。
- 28 条 smoke（`run-all.sh` 无服务器口径）：**26 绿 / 2 既有红**，红集合仍是
  `{ smoke-api（缺服务器）, smoke-liveness（本机时序） }`，没有第三条稳定红；`smoke-approval`
  本轮 24 s 正常收尾、绿，无 01 号票那种偶发红。`smoke-api.log` 与基线逐字相同
  （`the mux connection failed`）；`smoke-liveness` 只红在票面那条预算内断言（本轮 **2350 ms**，
  基线 1943 / 1898 ms、after-02 2116 ms，预算 1650 ms），与 01 号票「同一条脚本不同轮次 FAIL
  组合并不一致」的口径一致。
- 逐份 diff 28 条日志：只有 3 份与基线不等——`smoke-boot`（随机端口 / 临时 home / UUID）、
  `smoke-approval`（基线那份是 01 号票首轮偶发红的日志，本轮绿）、`smoke-liveness`（毫秒数与
  FAIL 组合），全在 01 号票 §5 登记的随机量 / 归因清单里；**`smoke-tools.log` 223 行逐字节相同**。
- 全部输出落在 `../smoke-runs/after-03/`（日志与运行产物不入提交；`check.log`、`summary.txt`、
  28 份 `<name>.log` 可按 01 号票命令复跑）。本票没有跑 `smoke-api` 的「起服务器后 ok」那一遍——
  本轮无源码改动，那条结论按 01 号票 §4 原样沿用。
- `Status` 翻 `resolved`；`map.md` 的 Decisions so far 追加 03 指针、Not yet specified 清掉 03 那块雾
  并把毕业清单更新为「按 02 / 03 票的清单核」、Out of scope 记下 03 未启用「动 `Context` wire」的许可。

