# 08 - 引擎执行全量改道 `ToolManager`（03 的六个调用点）

Type: task
Status: open
Blocked by: 07

## Question

按 03 §3 把引擎（`agent.ts`）的六个执行调用点全部改道 Manager：`Manager.execute(...)` 成为
**生产代码唯一**的 `Tool.execute` 调用点；预备与执行都经 `manager.get(name)`，`prepared.tool` 不再
承担执行；`prepareToolCall` 的 `tools` 覆盖形参与 `RunToolCallOptions.tools` 不再作执行来源；
未知名仍由 `prepareToolCall` 在闸门前回 `Tool <name> not found`。

07 已经把 `run` 穿到 `:2402`、把 `Context.tools` 的生产端改成 Map 实例；本票只换「执行从哪来」。

### 依据（都已 resolved）

- **03 §3 的六个调用点**（逐条照抄，含两处明确排除）：
  `executeToolCalls:2082-2097`（`:2091` 的 `executionMode` 判定改 `manager.get(tc.name)?.executionMode`，
  两条批次路径 `:2099` / `:2161` 带上 Manager + `run`）；
  `prepareToolCall:2264-2339`（删 `tools` 覆盖形参，`:2272` 改 `manager.get`；`:2282` `prepareArguments`
  与 `:2283` `validateToolArguments` 仍读这个实例的字段、函数体不动）；
  `prepareToolCallArguments:2250-2262`（一行不动，改道在调用者）；
  `executePreparedToolCall:2393-2424`（`:2402` 改 `manager.execute(name, toolCallId, params, run, signal, onUpdate)`）；
  `recoverPendingToolCalls:2005-2053`（导出的恢复机器，`:2020` / `:2034` 复用同一条链，由 `:1011` 传这一轮的
  Manager + `run`）；
  `runToolCall:2374-2391`（今天无人调用；`RunToolCallOptions.tools` 不再作执行来源，仍不导出）。
  **明确排除**：压缩摘要 `:1530-1544`（`tools: []` 原样）、`streamAssistantResponse:1841-1855`
  （`toToolDeclaration` 原样）。
- **03 §2.4**：Manager owns 调用、不 owns 实现；两次 `get(name)` 由 02 的恒等不变量担保；
  校验 / shim / 两道闸门 / 事件 / 定稿 / `signal` / `onUpdate` / 异常→错误结果全留在引擎。
- **03 §2.3 / 决定 5**：Manager 与 `run` 像 `hooks` 先例一样显式传参，不设模块级全局、不进 `Context`、
  不进 `AgentState.live`。
- **03 §5 #6**：未知名仍在闸门前（`:2273-2279`）回 `Tool <name> not found`；**执行入口不重复判活**
  （「不在本轮名单」那一半是 09）。
- **05 §3.5 / §2.4**：`get` 落空怎么兜（交给 `executePreparedToolCall` 现成的 `try/catch` 或闸门前拦）
  属本票的形状细节；但**不得**变成第二道判活闸门、不得新增第二个 `Tool <name> not found` 来源。

### 改动面

| 落点 | 动作 |
|---|---|
| `agent.ts:2082-2097` / `:2091` / `:2099` / `:2161` | 批次链带 Manager + `run`；`executionMode` 从 `manager.get` 读 |
| `agent.ts:2264-2339` | 删 `:2270` 的 `tools` 默认形参与 `:2272` 的 `find`，改 `manager.get(toolCall.name)` |
| `agent.ts:2393-2424` | `:2402` 改 `manager.execute(...)`；`prepared.tool` 不再承担执行（`:1805-1810` 字段去留由本票定，语义是「不从它执行」） |
| `agent.ts:2352-2391` | `RunToolCallOptions.tools` 不再作执行来源，预备与执行都走 Manager，补 `run` |
| `agent.ts:1011` / `:2005` | 恢复机器入口显式多收 Manager + `run`（参数布局归本票），三条 smoke 调用点同步补值 |
| `scripts/smoke-approval-recovery.ts:254-311` | 05 §3.5：假 `readTool` 保留（`execute` 不收 `run` 仍合法），但改由**练习自己造的 Manager** `register()` 供出；三次调用的 Context 字面量（`:269` / `:288` / `:306`）**都写 `tools: []`**（`:306` 的 `[readTool]` 正是要改的那处）；三个 `recoverPendingToolCalls` 调用点补 Manager + `run` |

### 边界（不做）

- 不引入本轮名单判活（`activeNames.has`）——那是 09；本票只保证「找得到」= 「在 Map 里」，
  并**在 Answer 里写明**这个中间态（禁用工具此刻会被 `get` 找到，正是 09 补的缺口）。
- 不改 `Context.tools` 的元素来源（07 已定）、不动 wire、不动 `toToolDeclaration`。
- 不碰 `session/tool-config.ts` / 装配（07 已改完）。
- 不改文档与 ADR（归 10）。

### 验收

- `npm run check` 绿。
- 28 条 smoke 对跑 **26 绿 / 2 既有红、零新红**；`smoke-approval-recovery` 绿——**且它走的正是新路**：
  没有 Agent、没有 hub，只有练习自己造的一只 Manager，假 tool 经 `register()` 进来、三处 `Context.tools` 都是 `[]`。
- `grep -n "\.execute(" packages/core/src/agent.ts` 只剩 Manager 入口那一处（`:2402` 附近），
  `prepared.tool` 无执行读点；`Tool <name> not found` 仍只在 `prepareToolCall` 一处产出。
- `smoke-session.ts:1342-1343`「禁用工具仍回 not found」仍绿（此刻靠 07 的 Map + 名单，09 才把它钉进执行链）。

### 交接（给 09）

`## Answer` 记：六个调用点各自改法、`recoverPendingToolCalls` 的最终签名与三条 smoke 调用点的供值形状、
check / smoke 数字（`../smoke-runs/after-08/`）、以及**「禁用工具在 08 之后仍会被 get 找到」这个已知缺口**。
