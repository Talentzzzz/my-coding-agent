# 08 - 引擎执行全量改道 `ToolManager`（03 的六个调用点）

Type: task
Status: resolved
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

## Answer

**2026-11-06 落地**（`Type: task`，按 03 §3 的六个调用点逐条改道；本票只动「执行从哪来」，判活仍归 09，
文档与 ADR 仍归 10）。

### 结论（一句话）

引擎的六个执行调用点全部改道 `ToolManager`：`manager.execute(...)` 成为**生产代码唯一**的
`Tool.execute` 调用点（`manager.ts:164` 那一次转发），预备与执行都经 `manager.get(name)`，
`prepared.tool` 字段与 `RunToolCallOptions.tools` 一并退场，`Context.tools` 从此只被传输面读。
`npm run check` **绿**（`tokens ok: 137 defined, 111 referenced`）；28 条 smoke 实跑 **25 绿 / 3 红**，
其中一条是 01 号票口径下的本机偶发（复跑 1/1 绿、日志与 after-07 逐字节相同），对跑口径即
**26 绿 / 2 既有红、零新红**；`smoke-tools.log` 与 after-07 **逐字节相同**。

### 1. 六个调用点各自怎么改

| 调用点（改后行号） | 改动 |
|---|---|
| `executeToolCalls:2124` | 形参表多一位 `manager: ToolManager`（位置在 `hooks` 之后、`run` 之前）；`:2135` 的 `executionMode` 判定从 `currentContext.tools.find(...)` 改成 `manager.get(tc.name)?.executionMode`；两条批次调用各带 `manager` |
| `executeToolCallsSequential:2143` / `executeToolCallsParallel:2213` | 各多一位 `manager`；`prepareToolCall(...)` 与 `executePreparedToolCall(...)` 的调用点补 `manager` |
| `prepareToolCall:2334` | 删掉 `tools: readonly Tool<any>[] = currentContext.tools` 形参，改收 `manager`（`hooks` 之后、`signal` 之前）；`:2342` `const tool = manager.get(toolCall.name)`；`:2282` `prepareArguments` / `:2283` `validateToolArguments` 函数体一字未动，仍读这个实例的字段 |
| `prepareToolCallArguments:2321` | 一行未动（改道在调用者） |
| `executePreparedToolCall:2479` | 多一位 `manager`；`:2490` 改 `manager.execute(prepared.toolCall.name, prepared.toolCall.id, prepared.args, run, signal, onUpdate)`；`signal` / `onUpdate` / 异常→错误结果的 `try/catch` 原样 |
| `recoverPendingToolCalls:2036`（导出） | 多一位 `manager`（`hooks` 之后、`run` 之前）；函数体的 `prepareToolCall` / `executePreparedToolCall` 各补 `manager`，其余（grant 重跑、deny 合成、孤儿收尾、再度 suspend）一字未改 |
| `runToolCall:2445` | `RunToolCallOptions.tools` 换成 `manager`；预备与执行都从 Manager 走，`options.run` 原样。仍不导出、仍无人调用 |

`PreparedToolCall`（`:1834`）**删掉 `tool` 字段**：它此前唯一读者是 `Tool.execute`，改道后无读者，
留着就是一份「不从它执行却又摆在那儿」的可执行引用。`prepared` 现在只带 `toolCall` 与 `args`，
执行时按 name 现取（两次 `get` 由 02 的恒等不变量担保）。

`agent.ts` 内两处入口：`:1015` 的恢复机器调用补 `tools`（`runEngine` 顶部已解构出的那只），
`:1107` 的 `executeToolCalls` 同理。**明确排除的两处一行未动**：压缩摘要 `tools: []`、
`streamAssistantResponse` 的 `context.tools.map(toToolDeclaration)`（`:1877`）——后者是
`Context.tools` 在 `agent.ts` 里的唯一剩余读点。

### 2. `recoverPendingToolCalls` 的最终签名与三条 smoke 的供值形状

```ts
export async function recoverPendingToolCalls(
	currentContext: Context,
	dangling: DanglingToolCall[],
	recovery: RunRecoveryOptions | undefined,
	hooks: ToolCallHooks,
	manager: ToolManager,          // 本票新增：这一轮用哪张表
	run: ToolRunContext,           // 02 的 per-run 值（07 已加）
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch>;
```

参数布局的口径：**服务在前、这一轮的值次之、瞬态在后**（`hooks, manager` → `run` → `signal, emit`），
与批次链（`hooks, manager, run, signal, emit`）逐位对齐，读一处就够。`activeNames` 在 09 落在
`manager` 之后、`run` 之前的位置——本票不预放空位。

`scripts/smoke-approval-recovery.ts`（`:249-327`）三条调用点的供值形状：

- 练习自造一只表：`:266` `const manager = createToolManager()`、`:267` `manager.register(readTool)`。
  **没有 Agent、没有 hub**，只有这两行——这正是 05 §3.5 说的那条差别。
- 三处 `Context` 字面量**都写 `tools: []`**（`:276` / `:297` / `:318`；第三处原文是 `[readTool]`）；
  每次调用在第 5 位多一个 `manager` 实参，`run` 仍是 `{ workDirAbsPath: process.cwd() }`。
- 假 tool 的 `execute: async () => …` 不收 `run`，仍合法（07 的签名里 `run` 是必填实参，而少收实参的
  函数对多参签名是合法赋值）。
- **名字从 `read` 改成 `read_fixture`**：表拒绝与内置同名（`Tool already registered: read`，05 §2.1），
  而这只假 tool 必须进表才「找得到」。`dangling` 那条 transcript 里的 tool call 名随之改，断言不动。

### 3. 验收

- `npm run check`：**绿**，exit 0，`tokens ok: 137 defined, 111 referenced`；`after-08/check.log`。
- 28 条 smoke（`run-all.sh` 无服务器口径）：**25 绿 / 3 红**，红集合
  `{ smoke-api（缺服务器，既有）, smoke-liveness（本机时序 12 s，既有）, smoke-desktop-observability（偶发） }`。
  最后一条是 07 号票记过的同一处：24 ms 预算紧挨 `smoke-approval` 之后跑，串行时偶发
  `it waited the budget it was given, not the default 24 ms`；单独复跑 **1/1 绿**，日志与 after-07 那份
  **逐字节相同**（`after-08/rerun-smoke-desktop-observability-1.log`）。按 01 号票口径 ⇒ **零新红**。
- 逐份 diff 28 条日志（对 after-07）：只有 4 份不等，全部登记在案——`smoke-boot`（随机端口 / 临时 home /
  UUID）、`smoke-liveness`（毫秒数与 FAIL 组合）、`smoke-desktop-observability`（本轮偶发红那一份）、
  `smoke-session`（本票的断言改写，见 §4）；**`smoke-tools.log` 223 行逐字节相同**（工具行为未变）。
- `smoke-approval-recovery` 绿，25 条断言全在，走的是新路（见 §2）。
- grep：
  `grep -n "\.execute(" packages/core/src/agent.ts` → 只剩 `:2490` 的 `manager.execute(`；
  全 `packages/` 生产代码只剩两处——`agent.ts:2490`（Manager 入口的调用）与 `manager.ts:164`
  （Manager 内部对 `Tool.execute` 的唯一转发）；`prepared.tool` **归零**；
  `Tool <name> not found` 仍只在 `prepareToolCall`（`:2346`）一处产出。
- 全部输出在 `../smoke-runs/after-08/`（`check.log`、`summary.txt`、28 份 `<name>.log`、
  `rerun-smoke-desktop-observability-1.log`）。

### 4. 已知缺口：禁用工具在 08 之后仍会被 `get` 找到

`prepareToolCall` 现在问的是「表里有没有这个名字」，而表恒装六个内置 + 注册项。所以一个被
`setActiveTools` 关掉的工具，模型若仍点名，**会被找到并执行**——「未激活工具的调用回
`Tool <name> not found`」这条既有行为（`docs/architecture.md:125`）此刻只剩声明那一半（模型不再被告知它）。
这正是 04 §2.4 预言的中间态，由 09 把本轮 `activeNames` 穿进执行链补回（两处：`prepareToolCall` 闸门前、
`executionMode` 判定前）。

**这条缺口与票面「验收」第 4 条互斥**，落地时已与用户确认口径：改道之后
`scripts/smoke-session.ts` 的 `exerciseDeactivatedToolCall`（`:1408`）必然变红（工具真的跑了、文件真被写），
「仍绿」在物理上不成立。裁决是**改断言钉住中间态**（用户选定）：该练习现在断言
「仍被表找到并执行」（`:1424` 起四条），注释与函数文档点名 09 把它翻回 `Tool write not found`。
09 号票的验收因此要连着这一处一起翻——它写的「仍绿，并且路径经判活」在 09 落地后成立，在 08 这一笔上是
「绿，但断言的是缺口」。

### 5. 与票面的偏差（照实记）

1. **验收第 4 条按 §4 处理**：不是「仍绿」，而是「改断言钉住中间态」。这是本票唯一一处产品断言的改动，
   理由与裁决见 §4；除这四条外 `smoke-session.log` 与 after-07 逐字节相同。
2. **`PreparedToolCall.tool` 删除而非保留**：票面把这个字段的去留留给本票，语义是「不从它执行」；
   实测改道后它没有任何读者（`finalizeExecutedToolCall` 只读 `toolCall` / `args`），留下就是死字段。
3. **`recoverPendingToolCalls` 的参数位置**：票面说「参数布局归本票」；`manager` 放在 `hooks` 之后、
   `run` 之前，与批次链逐位对齐（§2）。没有为 09 的 `activeNames` 预留空位。
4. **假 tool 改名 `read_fixture`**：票面没点名，但 `register()` 拒绝与内置同名，不改名这条注入根本进不去表。
5. **`smoke-approval-recovery` 的三处 `Context.tools` 都写 `[]`**：按票面；其中第一、二处原本就是 `[]`，
   只有第三处从 `[readTool]` 改过来。
6. **`streamAssistantResponse` 的一处注释措辞**：该函数在票面的排除面上（`toToolDeclaration` 原样，
   行为一字未动），但它的文档注释里「the executable set the run holds is declared here」在本票之后为假，
   改成「the set this request offers is declared here」。只此一个从句，wire 与行为零改动；
   若要严格执行「排除面零触碰」，这一行可以回退给 10 号票。

### 6. 给 09

- 两处判活落点已经就位、只差名单：`prepareToolCall:2342` 的 `manager.get(toolCall.name)` 前面加
  `activeNames.has(...)`（落空仍回 `:2346` 那句，不新增来源）；`executeToolCalls:2135` 的
  `manager.get(tc.name)?.executionMode` 同样先判活，否则被禁用的 `bash` 会把整批翻成 sequential。
- 传参链：`runEngine:1015` / `:1107` → 两条批次路径 → `prepareToolCall`；`manager` 的座位就是 09 的
  `activeNames` 该坐的位置（`hooks` 之后、`run` 之前，或紧挨 `manager`）。
- `scripts/smoke-session.ts:1408` 的四条断言要翻回 `not found` / 「did not touch the directory」/
  「errored tool result」，函数文档里点名 09 那段注释一并删。
- `executePreparedToolCall` 不重复判活（03 §2.4）：`manager.execute` 落空仍是一条 `Tool not found:` 的
  错误结果，那是 bug 兜底、不是第二道闸门。

### 7. 给 10

本票让以下现文变成假话（按 06 §3 只增不改，正文原文保留、就地补注 + 逐句改写）：

- `AGENTS.md:36`「它调的是 `Tool.execute`」——现在是 `manager.execute`；
  `:42-48` 的 tool 词条里「目录是 `createToolRegistry`…`active(state, run)` 现建可执行集合」整段。
- `docs/architecture.md:119`「`Context.tools` 里装的就是这些可执行集合本身」；
  `:125` 那句「循环执行的东西」与「对未激活工具的调用会返回 `Tool <name> not found`」——
  后者在 08 与 09 之间只剩声明那一半（见 §4），09 落地后才完整成立。
- ADR-0015 *后果*「`prepareRequest` 建它、引擎用它」——引擎已不用它执行（03 §2.5 已把这条列进 06 的
  收账清单）。
