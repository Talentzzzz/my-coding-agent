# 09 - 本轮名单进执行链：先判活再取实例（04 §2.4）

Type: task
Status: resolved
Blocked by: 08

## Question

08 之后 Map 装全部六个，`manager.get(name)` 找得到**禁用**的工具——「未激活工具的调用回
`Tool <name> not found`」这条既有行为（`docs/architecture.md:125`）于是缺一半。按 04 §2.4 把本轮
`activeNames` 作为栈上局部显式穿过执行链，让 `prepareToolCall` 与 `executionMode` 判定**先判活再取实例**。

### 依据（都已 resolved）

- **04 §2.2**：`toolStateOf(...)` 仍返回 `{ activeToolNames, approvalOverride }` 纯数据、仍每次现算；
  `prepareRequest:1252` 与 `Agent.run:999` 各把 `activeToolNames` 收成这一请求的局部；
  `:1063-1070` 每次 `prepareRequest` 返回后随 `currentContext` 换成这一轮那份（`requestUpdate` 缺省时沿用上一轮）。
- **04 §2.4**：`activeNames`（数组或 `Set` 由本票选）与 Manager、`run` 一样显式传过
  `:1011` 恢复机器 → `:1101` → `:2082` / `:2099` / `:2161` → `:2264` → `:2393`；
  `prepareToolCall` 在闸门前 `activeNames.has(name)` 判活，落空仍回今天那句 `Tool <name> not found`
  （`:2273-2279`）；命中才 `manager.get(name)`；`executeToolCalls:2091` 的 `executionMode` 判定同样先判活，
  否则一个已被禁用的 `bash` 会把整批翻成 sequential。
- **04 §2.4 的衔接**：03 §5 #6 的「未知名」在 Map 装全部六个之后只能读作「**不在本轮名单**」；
  本票补的正是这一半，**不改 03 / 04 的任何决定**。
- **04 §5 #5**：判活归引擎，不归 Manager——Manager 只答「这个名字存在吗、给我实例」，
  答不了「这个会话这一轮准不准」；执行入口不重复判活（03 §2.4）。
- **05 §3.5 的后半**：`recoverPendingToolCalls` 还要拿本轮 `activeNames`；分传还是合对象、放第几位归本票。

### 改动面

| 落点 | 动作 |
|---|---|
| `agent.ts:1252` / `:999` | 派生本轮 `activeNames`（07 已在 `:999` 用过它的局部值装数组，本票把它收成一份可传的值） |
| `agent.ts:1063-1070` | `prepareRequest` 返回后换掉本轮那份；`requestUpdate` 缺省时沿用上一轮 |
| `agent.ts:1011` / `:1101` | 入口把 `activeNames` 一并传下去（`recoverPendingToolCalls` 签名在 08 已加 Manager + `run`，本票补第三个值） |
| `agent.ts:2082` / `:2091` / `:2099` / `:2161` | 两条批次路径链上带 `activeNames`；`:2091` 先判活再读 `executionMode` |
| `agent.ts:2264-2339` | 闸门前 `activeNames.has(name)`，落空回 `Tool <name> not found`（用的是今天那段代码，不新增来源） |
| `scripts/smoke-approval-recovery.ts:268-311` | 三个调用点补本轮名单（`["read"]` 量级），断言不动 |

### 边界（不做）

- 不改 `Context.tools` 的元素（03 决定 1 不变）、不回退 08 的改道。
- 不把 `activeNames` 塞进 `Context` / `AgentState.live` / Manager / 模块级全局；不给 Manager 加判活方法。
- 不动 `setToolConfig` / 审批 / 账本格式（04 §5 #2 #3 的零改动面）。
- 不改文档与 ADR（归 10）。

### 验收

- `npm run check` 绿。
- 28 条 smoke 对跑 **26 绿 / 2 既有红、零新红**；`smoke-session.ts:1342-1343`「禁用工具仍回 not found」
  仍绿，并且**路径经判活**（不是靠 `get` 找不到）。
- 新增一条可测断言（本票定形）：一个会话禁用 `bash` 后，`executionMode` 判定不因 `get("bash")` 命中
  而把批次翻成 sequential——具体断言形式按 04 §2.4 写的两处行为定。
- `smoke-approval-recovery` 绿：grant 重跑仍经 Manager，且名单外的工具不被执行。

### 交接（给 10）

`## Answer` 记：`activeNames` 的最终形态（数组 / `Set`、传参位置、`recoverPendingToolCalls` 的完整签名）、
两处判活落点、新断言、check / smoke 数字（`../smoke-runs/after-09/`）、以及「代码面到此收口，
只剩文档收账与全量验收」。

## Answer

**2026-11-06 落地**（`Type: task`，按 04 §2.4 把本轮名单收成栈上局部穿过执行链；文档与 ADR 仍归 10）。

### 结论（一句话）

`activeNames` 是 `ReadonlySet<string>`，在 `runEngine` 入口与 `prepareRequest` 各派生一次、随
`AgentRequestUpdate` 在请求边界换掉，与 Manager、`run` 一样显式穿过恢复机器与两条批次路径；
`prepareToolCall` 与 `executionMode` 判定**先判活再取实例**，`Tool <name> not found` 仍只有
`prepareToolCall` 一处产出。`npm run check` **绿**（`tokens ok: 137 defined, 111 referenced`）；
28 条 smoke 实跑 **25 绿 / 3 红**，其中第三条是本机轮换的偶发（本轮 `smoke-mux-live`，复跑 1/1 绿），
对跑口径 **26 绿 / 2 既有红、零新红**。

### 1. `activeNames` 的最终形态

| 项 | 定稿 |
|---|---|
| 类型 | **`ReadonlySet<string>`**（票面「数组或 `Set` 由本票选」） |
| 生成 | `new Set(toolStateOf(...).activeToolNames)` 就地现攒，一行、无包装函数；两处派生各一个，不缓存、不共享 |
| `runEngine` 那份 | `:1005` `let activeNames: ReadonlySet<string>`，与 `currentContext` 同时建；`:1008` 的 `declaredTools` 直接吃它 |
| `prepareRequest` 那份 | `:1275` 从同一份 `toolState.activeToolNames` 派生，`:1314` 用于 `declaredTools`，并随更新返回 |
| 更换点 | `:1085` `activeNames = requestUpdate.activeNames ?? activeNames`，与 `context` / `model` 同一行组、同一语义（缺省沿用上一轮） |
| 载体 | `AgentRequestUpdate.activeNames?: ReadonlySet<string>`（`types.ts:184`）——**不进** `Context`、**不进** `AgentState.live`、**不进** Manager，不设模块级全局 |

传参位置：**`manager` 之后、`run` 之前**。08 §5.3 写明它「没有为 09 的 `activeNames` 预留空位」，
只在 §6 给了「`hooks` 之后、`run` 之前」与「紧挨 `manager`」两个候选——本票取前者（与 `manager` 相邻、
与 `run` 这个 per-run 值同段），恢复机器与两条批次路径逐位一致。
`recoverPendingToolCalls` 的完整签名（`agent.ts:2070`）：

```ts
export async function recoverPendingToolCalls(
	currentContext: Context,
	dangling: DanglingToolCall[],
	recovery: RunRecoveryOptions | undefined,
	hooks: ToolCallHooks,
	manager: ToolManager,
	activeNames: ReadonlySet<string>,   // 本票新增
	run: ToolRunContext,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch>;
```

### 2. 两处判活落点

两处问的是**同一个问题**，所以答案只有一个来源：`agent.ts:2021` 的 `activeTool(manager, activeNames, name)`
——先 `activeNames.has(name)`，命中才 `manager.get(name)`，落空回 `undefined`。两处各读它的一个投影：

| 落点 | 改法 |
|---|---|
| `prepareToolCall:2386` | `const tool = activeTool(manager, activeNames, toolCall.name);` —— `if (!tool)` 那段**一字未改**，`Tool <name> not found` 仍只有这一个来源；命中才做 `prepareArguments` / `validateToolArguments` / 闸门 |
| `executeToolCalls:2174` | `activeTool(manager, activeNames, tc.name)?.executionMode === "sequential"` —— 被禁用的 `bash` 不再把整批翻成 sequential |

执行入口**不重复判活**：`executePreparedToolCall` / `manager.execute` 一行未动，`manager.get` 落空仍是
bug 兜底（03 §2.4）。判活只归引擎，Manager 没有新增任何判活方法。
`runToolCall`（无人调用）的 `RunToolCallOptions` 多一个必填 `activeNames`，与批次链同形。
`declaredTools` 的形参从 `readonly string[]` 放宽到 `Iterable<string>`（`Set` 与数组都能喂）。

### 3. 断言（本票定形）

- `scripts/smoke-session.ts` `exerciseDeactivatedToolCall`（`:1400`）按 08 §6 翻回四条
  「`the deactivated call ran and failed` / `with a not-found error rather than a result` /
  `the tool did not touch the directory` / `the transcript records it as an errored tool result`」，
  并**补两条钉住「路径经判活」**：`switched back on, the same call runs` / `and reaches the directory`
  —— 同一张表、同一个名字，只是重新启用，调用就跑了；拒绝因此来自名单而不是 `get` 找不到。
- **新增 `exerciseDeactivatedToolBatch`（`:1451`）**，即票面要求的那条 `executionMode` 断言：
  会话禁用 `bash`，一条 assistant 消息里同时给 `read`（parallel）与 `bash`（sequential，已禁用），
  断言事件序为 `start:read, start:bash, end:bash, end:read` —— 两条都在任何结果落定前被宣告，
  即批次仍是 parallel；若按表读 `executionMode`，序会变成 `start:read, end:read, start:bash, end:bash`。
  （这条在 08 的树上实测红，正是该缺口；落地后绿。）同一练习还断言被禁用的那次以
  `not found` 的**错误结果**收尾（读的是 `isError` 与文本，不是「出现过 `end:bash`」——成功执行也会
  产生那个名字）。
- `scripts/smoke-approval-recovery.ts`：三个既有调用点补 `new Set(["read_fixture"])`（`:276`），
  **既有 25 条断言一字未动**；新增第四条场景（同一个 grant、`new Set<string>()`）把恢复路径上的判活钉住，
  三条断言：`a granted call outside the run's list is refused, not run`（回 `Tool read_fixture not found`）、
  `and the gate was not asked about it`（`gatesAsked` 相对上一场景的**增量**为零）、
  `with the fixture's own code never entered`（`ranFixture === 0`）。

### 4. 验收

- `npm run check`：**绿**，exit 0，`tokens ok: 137 defined, 111 referenced`；`after-09/check.log`。
- 28 条 smoke（`run-all.sh` 无服务器口径）：**25 绿 / 3 红**，红集合
  `{ smoke-api（缺服务器，既有）, smoke-liveness（本机时序，既有）, smoke-mux-live（本轮偶发） }`。
  `smoke-mux-live` 28 s 前两条 `FAIL`（`未订阅任何会话也收到整表` / `行带 modified/running/pending`，
  连接基线的时序），单独复跑 **1/1 绿**（`after-09/rerun-smoke-mux-live-1.log`，`mux live ok`、0 条 FAIL）。
  同一套脚本上一轮全跑时 `smoke-mux-live` 绿、第三条红是 `smoke-approval`（`the second process answered
  /api/health`，复跑亦 1/1 绿）——**第三条红在本机是轮换的**，与 01 号票对 `smoke-liveness`
  「同一条脚本不同轮次 FAIL 组合不一致」的口径同类，都是起进程 / 连基线的时序，不是断言。
  按 01 口径 ⇒ **零新红**。
- 逐份 diff 28 条日志（对 after-08）：6 份不等——`smoke-session`（本票断言）、
  `smoke-approval-recovery`（只多三行）、`smoke-boot` / `smoke-liveness` / `smoke-mux-live`
  （随机量、毫秒数与连接基线，登记在案）、`smoke-desktop-observability`（08 那轮偶发红、本轮绿）；
  **`smoke-tools.log` 223 行逐字节相同**。
- `smoke-approval-recovery` 绿，走的是新路：grant 重跑仍 `manager.get` / `manager.execute` 经 Manager，
  名单外的那次连闸门都没到。
- 全部输出在 `../smoke-runs/after-09/`（`check.log`、`summary.txt`、28 份 `<name>.log`、
  `rerun-smoke-mux-live-1.log`；日志与临时 home 不入提交）。

### 5. 与票面的偏差（照实记）

1. **`smoke-approval-recovery` 不止「补值」**：改动面写「三个调用点补本轮名单，断言不动」，
   验收又要求「名单外的工具不被执行」——后者在只补值的情况下不可测，于是**新增**一个场景与三条断言
   （既有 25 条未动），装置只是两个计数器（`ranFixture` / `gatesAsked`，后者按增量读）。
2. **`declaredTools` 形参放宽**：票面没点名，但 `activeNames` 取 `Set` 之后，`readonly string[]` 收不下它；
   放宽成 `Iterable<string>` 比每处 `[...activeNames]` 干净，语义不变。
3. **`runToolCall` 的 `RunToolCallOptions` 多一个必填 `activeNames`**：它在同一条链上、无人调用，
   票面只点名 `:2393` 那一段；按「同一条链同一种形状」补上，避免一个能不判活的旁路。
4. **两处判活共用一个模块级函数 `activeTool`**（`:2021`）：04 §2.4 把「未激活 → not found」与
   「未激活不参与 `executionMode`」写成两条要求，但那是同一个问题；写成两个表达式就是两条可以各自
   漂移的规则。它不持有任何东西，也不是 Manager 上的判活方法（04 §5 #5 的边界由「函数留在引擎侧」守住）。
5. **`exerciseDeactivatedToolCall` 补的两条（重新启用即照跑）超出验收的「新增一条」**：验收点名的是
   `executionMode` 那条（已单独成 `exerciseDeactivatedToolBatch`）；这两条是「路径经判活」的正面证据，
   不加就只剩「回 not found」这一个方向。

### 6. 交接（给 10）

**代码面到此收口**：04 §2.4 的两处判活、03 的六个调用点、07 的装配、05 的方法面都已落地，
只剩文档收账与全量验收（10 / 11）。10 只需要按 06 §3 的清单改写，本票让以下现文**重新成真**、
不需要再补注：

- `docs/architecture.md:125` 的「对**未激活**工具的调用会返回 `Tool <name> not found`」——
  08 之后它只剩声明那一半（见 08 §4），本票把判活钉进 `prepareToolCall` 后完整成立；
  要改的只是「判活发生在哪」这一句（06 §3 已把这条列进清单）。
- `AGENTS.md` tool 词条里「`active(state, run)` 现建可执行集合」整段仍由 07 的改写负责，与 09 无关。
- 本票**没有**改任何 `.json` / `.jsonl` 格式、审批映射、`tool_config` entry、wire（04 §5 #2 #3 零改动面）。
