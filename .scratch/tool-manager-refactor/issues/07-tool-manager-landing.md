# 07 - Tool 目录无关与 `ToolManager` 落地：类型、类、出口、装配、smoke 改写

Type: task
Status: resolved

## Question

把 02 / 05 两票的定案落成代码：`Tool` 变成目录无关（`run` 从构建期闭包移到 `execute` 的第三位必填实参），
`ToolRegistry` 换成 `ToolManager`（一张 `Map<name, Tool>` + 四法），进程里只剩一只 Manager，
`smoke` 跟到能编、并按新不变量断言。

**本票结束时 `npm run check` 必须绿、28 条 smoke 按 01 号票口径零新红**——`tsconfig.json` 把 core、
server 与 13 个脚本编在一起，删掉旧符号的任何一笔都得同时改完这些编译面，所以「类 / 出口 / 装配 /
smoke」不能再拆成两票。**引擎的执行来源不在本票改道**（留 08），本票只把 `run` 穿到执行链、
把 `Context.tools` 的生产端改成从 Map 取实例。

### 依据（都已 resolved，照抄，不重开裁决）

- **02 §2.1–§2.5、§5 #1–#6**：`execute(toolCallId, params, run, signal?, onUpdate?)`，`run` 第三位且必填；
  `ToolRunContext` 权威定义迁 `llm/types.ts`、`tools/manager.ts` 用 `export type { … }` 转发（导入路径不变）；
  六个 `createXxxTool` 零参，`execute` 内改读 `run.workDirAbsPath` / `run.bash`；一张 Map 首次访问
  **一次填满六个**、内置条目不增不删不覆盖、Map 对象不换；bash 超时仍由 `Agent.runContext(state)`
  每请求现读、随 `run` 到调用期。
- **05 §2.1–§2.7**：构造零参；`ensureFilled()` 幂等；公开面 `names()` / `get(name)` /
  `execute(name, toolCallId, params, run, signal?, onUpdate?)` / `register(tool)`；`build` / `activeNames` /
  `active` 删且不加批量便利门；`register` = `ensureFilled()` → 同名（含内置）抛
  `Tool already registered: <name>` → `set`；出口删 `createToolRegistry` / `ToolRegistry` / `createTools` /
  `toolDefinitions` / `createToolDefinitions` / `ToolDefinition(s)` / `toolListFor`，留选择/填充那半
  （`fillTools` / `narrowToKnown` / `ToolState` / `ToolFillContext`）；**不留任何别名与兼容壳**。
- **04 §2.5、§5 #8 #9**：四个派生函数与 Manager 之间只传名单数据（`readonly string[] known`，
  调用点现传 `manager.names()`）；`session-factory.ts:142` 与 `:285` 收敛到**同一只** Manager（传同一实例，
  不是各造一只等价的）。
- **03 §2.1**：`Context.tools` 元素是 Map 里的实例引用；**02 决定 4**：`run` 不进 `Context`。

### 改动面

| 子系统 | 落点 |
|---|---|
| 类型 | `llm/types.ts`：`Tool.execute` 加第三位必填 `run`、新增并导出 `ToolRunContext`（紧挨 `Tool`）；`tools/manager.ts` 改为转发；`Context` / wire / `toToolDeclaration` 一行不动（03 §2.5） |
| Manager 类 | `tools/registry.ts` 删除 → 新类住 `tools/manager.ts`（06 §2.1 推荐）：`private readonly all = new Map<string, Tool<any>>()` + `ensureFilled()` + 四法；六个零参工厂收成 `tools/` 内的私有常量，按 `manager.ts:58-65` 原顺序排 |
| 六个工厂 | `read.ts:30-41`、`write.ts:25-36`、`edit.ts:21-32`、`glob.ts:31-42`、`grep.ts:24-35`、`bash.ts:41-52`：零参，`execute` 内 `runXxx(run.workDirAbsPath, params, { signal, onUpdate })`、bash 另加 `timeouts: run.bash` |
| 出口面 | `tools/index.ts`、`core/index.ts:207-220`：按 §2.5 删旧链、加 `createToolManager` / `ToolManager` / `ToolRunContext` |
| 派生链 | `session/tool-config.ts:18, 32, 62, 121` 四函数的目录侧入参改 `readonly string[] known`；调用点 `agent.ts:527/610/684/1252`、`fanout.ts:41/86/89`、`session-factory.ts:163/182` 现传 `manager.names()` |
| 装配 | `agent.ts:66/133/211/229/245-247`、`fanout.ts:24-28`、`session-factory.ts:72/94/142/263/285/344-351`、`core/index.ts`；`:142` 与 `:285` 同一只；hub 冷读（`hub.ts:335` → `assembleSession`）与热侧共用同一只（05 §2.5 的核对项） |
| 引擎（只做 02 那半） | `:999` / `:1288` 按本轮名单 `map(get)` 装 `Context.tools`（不再 `active()`）；`run` 由 `Agent.run` 收成本轮局部、显式穿过 `:2082/:2099/:2161/:2264/:2393`，`:2402` 补第三位实参 |
| smoke | 05 §3.2（`smoke-session.ts:1252-1283` 与 `:1954` 的改名与逐行改写）、§3.3（`SentRequest.instances` + 五条请求级断言）、§3.4（`smoke-tools.ts` 模块级 Manager、三处直调补 `run`、`:733` 改 `names()`）、§3.6（只跟型：`smoke-session.ts:244-262` 的 `openSession` 形参类型）。**`smoke-approval-recovery.ts` 本票不动**——它今天把假 tool 塞进 `Context.tools`，而执行来源仍是 `Context.tools`；05 §3.5 的改写（假 tool 改 `manager.register()`、`:306` 改 `tools: []`）随 08 落地 |
| 文档 | **零改动**（归 10） |

### 边界（不做）

- **不改引擎的执行来源**：`prepareToolCall:2272` 仍 `find(currentContext.tools)`、
  `executePreparedToolCall:2402` 仍 `prepared.tool.execute`——那是 08。本票只补 `run` 实参。
- **不把 `activeNames` 穿进执行链做判活**——那是 09（本票只在 `:999` / `:1288` 用它的局部值来装数组）。
- 不写 ADR、不改 `AGENTS.md` / `docs/architecture.md` / `README.md` / `docs/notes.md`——那是 10。
- 不留别名 / 兼容壳（05 §2.6 三条理由）；不动 `.json` / `.jsonl` / `tool_config` 格式与 wire。
- 不跑 `npm install`（依赖走 `node scripts/install-deps.ts .`）；改源码用编辑器工具，不走 shell 文本往返。

### 验收

- `npm run check` **绿**，`tokens ok: 137 defined, 111 referenced`。
- 28 条 smoke 与 01 号票基线对跑：**26 绿 / 2 既有红**（`smoke-api` 缺服务器、`smoke-liveness` 本机时序），
  **零新红**；偶发红按 01 号票口径单独复跑定性。
- 新断言按 05 §3 逐条在：`get("bash") === get("bash")`（`:1264` 翻转）、`get("nope") === undefined`、
  `names()` 六个内置按序且 `register` 前仍是 6、两条判重抛错、§3.3 的五条请求级断言
  （`instances` 元素 `=== manager.get`、两请求同名元素 `===`、两个数组 `!==`、`sent[1].tools` 收窄、跨会话同一实例）。
- `smoke-tools.ts` 三处直调 `execute` 补 `run`；bash 上限用例的文本与判据不动，只把「构造期闭包」换成「调用期 run」。
- grep：`packages/` 与 `scripts/` 里 `ToolRegistry` / `createToolRegistry` / `createTools` / `toolDefinitions` /
  `createToolDefinitions` / `toolListFor` / `ToolDefinition` **归零**。
- 预期 `smoke-tools.log` 与基线逐字节相同（工具行为未变）；不等要逐行说明归因。

### 交接（给 08 / 09）

`## Answer` 记：改了哪些文件、四法最终签名、六条新断言的落点与输出、`check` / smoke 数字与日志路径
（`../smoke-runs/after-07/`）、以及两条接缝——**`run` 已穿到 `:2402`、执行来源仍是 `prepared.tool`**；
**`activeNames` 已在 `:999` 派生但未进执行链**。

## Answer

**2026-11-06 落地**（`Type: task`，按票面与 02–06 的定案逐条落成；本票代码已改，文档与 ADR 留 10）。

### 结论（一句话）

`Tool` 已目录无关（`run` 是 `execute` 的第三位必填实参，权威定义搬进 `llm/types.ts`），`ToolRegistry`
换成 `ToolManager`（一张 `Map<string, Tool<any>>` 加 `names` / `get` / `execute` / `register` 四法，
零参构造），进程里只剩一只（`openAgent` 把 `assemble` 造的那只交给 `createSessionAgent`，hub 自己持一只
给冷热两条路），`smoke` 跟到能编并按恒等不变量断言。`npm run check` **绿**
（`tokens ok: 137 defined, 111 referenced`），28 条 smoke **26 绿 / 2 既有红、零新红**，
`smoke-tools.log` 223 行与基线**逐字节相同**。

### 1. 四法最终签名

```ts
class ToolManager {
	names(): string[];                                              // 键集：六内置在前、注册项按调用顺序在后
	get(name: string): Tool<any> | undefined;                        // 恒返回同一实例；未知名 undefined
	execute(                                                         // 生产代码唯一 Tool.execute 调用点
		name: string,
		toolCallId: string,
		params: unknown,
		run: ToolRunContext,                                          // 必填、无默认
		signal?: AbortSignal,
		onUpdate?: ToolUpdateCallback<any>,
	): Promise<ToolResult<any>>;
	register(tool: Tool<any>): void;                                 // ensureFilled → 判重 → set
	private ensureFilled(): void;                                    // 首次访问一次填满六个，size>0 即已填
}
export function createToolManager(): ToolManager;                  // 零参

// 与之配套的契约（llm/types.ts）
execute: (toolCallId: string, params: Static<TParameters>, run: ToolRunContext, signal?, onUpdate?) => …
```

六法之外没有别名、没有 `build` / `activeNames` / `active`、没有批量便利门（05 §2.6）。

### 2. 改了哪些文件（20 个，含 1 删除）

| 子系统 | 文件 | 落点 |
|---|---|---|
| 类型 | `llm/types.ts` | `ToolRunContext` 紧挨 `Tool` 新增并导出（`bash?: BashSettings` 从 `config.ts` 类型导入）；`Tool.execute` 加第三位必填 `run`；注释写明「传输层既不读也不构造 `run`」 |
| Manager | `tools/manager.ts` | 新类 + `createToolManager()`；`private readonly all` + `ensureFilled`；`ToolRunContext` 改为 `export type { … }` 转发；六个零参工厂收成 `builtIns` 私有常量，按原顺序 read/write/edit/glob/grep/bash；删 `ToolDefinition(s)` / `createToolDefinitions` / `toolDefinitions` / `toolListFor`；留 `ToolState` / `ToolFillContext` / `fillTools` / `narrowToKnown` / `DEFAULT_MODE_NAME` |
| 旧类 | ~~`tools/registry.ts`~~（删除） | `ToolRegistry` 接口、`createToolRegistry()` 与私有 `Registry` 一起删 |
| 六个工厂 | `read.ts` / `write.ts` / `edit.ts` / `glob.ts` / `grep.ts` / `bash.ts` | 全部零参；`execute` 内改读 `run.workDirAbsPath`，bash 另加 `timeouts: run.bash`；六个 `runXxx` 签名与 `workdir.ts` 未动 |
| 出口 | `tools/index.ts`、`core/index.ts` | 删 `createToolRegistry` / `ToolRegistry` / `createTools` / `toolDefinitions` / `ToolDefinition(s)` / `toolListFor`；加 `createToolManager` / `ToolManager`，`ToolRunContext` 路径不变 |
| 派生链 | `session/tool-config.ts` | `defaultToolNames` / `globalDefaultToolState` / `toolStateOf` / `followsGlobalOf` 第四参改 `readonly string[] known` |
| 引擎 | `agent.ts` | `run` 在 `runEngine` 顶部收成本轮局部（`:973`），穿过恢复机器与两条执行路径到 `executePreparedToolCall`；`:1003` / `:1293` 起用私有 `declaredTools()` 按本轮名单 `map(get)` 装 `Context.tools`（不再 `active()`）；四处 `toolStateOf` 调用点现传 `tools.names()` |
| 装配 | `session-factory.ts` | `Assembled.registry` → `tools`；两处构造点收成 `createToolManager()`；`assembleSession` 多返回 `tools`；`openAgent` 把它传给 `createSessionAgent`（**同一只**，不再各造一只） |
| 装配 | `fanout.ts`、`hub.ts` | `SessionServices.tools: ToolManager`；hub 持 `readonly tools: ToolManager`，编排层与 `sessionOptions`（冷读 `readSessionSnapshot` / `assembleSession`）都传同一只 |
| smoke | `smoke-session.ts` / `smoke-tools.ts` / `smoke-approval-recovery.ts` | 见 §3、§4 |

`packages/server` 其余、`desktop`、`web` 源码零改动；`.json` / `.jsonl` / `tool_config` 与 wire 一字未动。

### 3. 新断言：落点与输出

`scripts/smoke-session.ts` 的 `exerciseToolRegistry` → `exerciseToolManager`（`:1252` 起，`:2001` 调用），
15 条断言全绿：

| 断言 | 行 | 输出 |
|---|---|---|
| `names()` 六个内置按注册顺序 | `:1265` | `ok names() holds the six built-ins in registration order` |
| `get(name)` 取到命名的工具 | `:1266` | `ok get() returns the named tool` |
| `get("nope") === undefined` | `:1267` | `ok get() returns undefined for a name nobody knows` |
| `executionMode` 是实例上的常量 | `:1268` | `ok executionMode is a field on the instance` |
| **`get("bash") === get("bash")`**（`:1264` 翻转） | `:1269` | `ok get() answers the same instance every time` |
| `register` 前 `names()` 仍是 6 | `:1270` | `ok while names() keeps every tool` |
| 未知名被 `narrowToKnown` 读掉、不抛错 | `:1271` | `ok and a name this build does not know is dropped by the read, not thrown at` |
| `register(noop)` → `get("noop") === noop` | `:1282` | `ok register() adds the tool to the table` |
| 同名二次注册抛 `Tool already registered: noop` | `:1288` | `ok and a second registration of one name is refused` |
| `register({...noop, name:"read"})` 抛同一错 | `:1295` | `ok and so is one that would overwrite a built-in` |
| 请求级①：本轮执行的实例 `=== manager.get("probe")` | `:1331` | `ok the request ran the table's own instance` |
| 请求级②：两个请求同一元素 `===` | `:1332` | `ok and the next request ran that same one` |
| 请求级③：两条请求的工具**列表**仍各自新建 | `:1333` | `ok while the request's tool list itself is new per request` |
| 请求级④：收窄后第二次请求只声明 `["read","probe"]`、不含 `noop` | `:1334` | `ok the choice, not the table, decides what a request declares` |
| 请求级⑤：第二个会话的同一元素 `=== manager.get("probe")` | `:1345` | `ok another session ran that same instance too` |

`SentRequest` 加 `instances`（`:305`），`recordRequests` 的回调改收 `Context` 并存下本次请求的工具列表；
`declaredTools` 一字未动（05 §3.6）。

`smoke-tools.ts`：模块级 `const manager = createToolManager()`（`:57`）、`tool(name)` 改 `manager.get(name)`、
`run = { workDirAbsPath: root }` 常量，三处直调 `execute` 补第三位实参（`:95` / `:134` / bash 上限用例），
bash 上限从「构造期闭包」换成「调用期 run」（`:237-247`），`exerciseFillTools` 的 `known` 改 `manager.names()`
（`:740`）；七条填充断言一字未动。

`smoke-approval-recovery.ts` 只在三处 `recoverPendingToolCalls` 调用补 `run` 实参——**编译所迫**（该导出函数的
签名随 02 §2.4 多一位），05 §3.5 的注入改写（假 tool 改 `manager.register()`、`:306` 的 `tools: [readTool]` 改
`[]`）**未做**，仍归 08。

### 4. 验收

- `npm run check`：**绿**，`tokens ok: 137 defined, 111 referenced`；`check.log` 与基线**逐字节相同**
  （本机 `npm`/`npx` 的 Node 引导在本轮有 segfault，三条命令按 `package.json` 的同一串直接以 `node` 跑，
  输出与 `npm run check` 一致）。
- 28 条 smoke（`run-all.sh` 无服务器口径）：**26 绿 / 2 既有红**，红集合仍是
  `{ smoke-api（缺服务器）, smoke-liveness（本机时序） }`，**零新红**。
- 逐份 diff 28 条日志：只有 5 份与基线不等，全部登记在案——`smoke-boot`（随机端口 / 临时 home / UUID）、
  `smoke-approval`（基线那份是 01 号票首轮偶发红的日志，本轮绿）、`smoke-liveness`（毫秒数与 FAIL 组合）、
  `smoke-session`（本票的断言改写）、`smoke-api-with-server`（基线独有、不参与这 28 份对跑）。
  **`smoke-tools.log` 223 行逐字节相同**（工具行为未变）。
- `smoke-desktop-observability` 在本轮串行跑到它时红了一次（`it waited the budget it was given`，24 ms 预算
  紧挨 24 s 的 `smoke-approval` 之后），单独复跑 **4/4 绿**、日志与基线逐字节相同，按 01 号票口径判为
  本机时序偶发，不算新红；`after-07/summary.txt` 末尾记了这一笔，`rerun-smoke-desktop-observability-1.log`
  一并留着。
- 全部输出在 `../smoke-runs/after-07/`（`check.log`、`summary.txt`、28 份 `<name>.log`；日志与临时 home 不入提交）。
- grep：`packages/` 与 `scripts/` 里 `ToolRegistry` / `createToolRegistry` / `createTools` / `toolDefinitions` /
  `createToolDefinitions` / `toolListFor` / `ToolDefinition` **归零**。

### 5. 两条接缝（给 08 / 09）

- **`run` 已穿到执行点、执行来源仍是 `prepared.tool`**：`executePreparedToolCall`（`:2420`）现在收 `run`，
  `:2430` 是 `prepared.tool.execute(id, args, run, signal, onUpdate)`。查找仍是
  `prepareToolCall:2297` 的 `tools.find(t => t.name === toolCall.name)`，`prepared.tool` 仍是执行来源，
  还没走到 `manager.execute(...)`。
- **`activeNames` 已在 `:1003` / `:1293` 派生但未进执行链**：两处都从
  `toolStateOf(…, tools.names()).activeToolNames` 取名单再 `declaredTools()` 装数组；判活仍是
  `Context.tools` 里有没有这个名字（08 / 09 改道时把它带进执行链）。

### 6. 与票面的偏差（照实记，逐条有理由）

1. **05 §3.3 的捕获口径**：票面说「在 `recordRequests` 的回调里从 `context.tools` 原样存下实例引用」，
   但传输层拿到的是**声明**——`streamAssistantResponse:1870` 用 `toToolDeclaration` 逐条重建（03 §2.5 明确
   不动这一行），所以 `context.tools` 里没有实例可比。实例身份改在**它被解引用的那一处**量：注册一只
   `probe`，`execute` 里记 `this`，断言 `ran[0] === manager.get("probe")`、`ran[0] === ran[1]`、
   跨会话 `ran[2] === …`——这三条量到的就是「这一轮 `Context.tools` 的哪一个元素被真的执行了」，
   不是 `manager.get()` 自己跟自己比。`SentRequest.instances` 仍按票面加，装的是本次请求的工具列表，
   用来断「列表每请求新建」。
2. **`prepareToolCall` 不接 `run`**：02 §2.4 把 `:2264` 列进穿参链，但该函数不执行工具（执行只在
   `executePreparedToolCall`），接了就是死参数；改为不接，`run` 从 `executeToolCalls*` / `recoverPendingToolCalls`
   直接给到 `executePreparedToolCall`。
3. **`createSessionAgent` 保留 `?? createToolManager()` 兜底**：04 §5 #9 的「同一只」在 `openAgent` 路径上
   已成立（`assemble` 造、`createSessionAgent` 收同一实例）；直接调 `createSessionAgent` 的调用者
   （`smoke-sessions.ts:888`）没有装配可共用，兜底给它自己一只，不跨调用者共享——这不是两只等价的表并存
   在同一条路径上。
4. **bash 超时是一轮一读，不是每个供应商请求一读**：`run` 按 02 §2.4 决定 4 收在 `runEngine` 顶部，
   而一轮里可能有多次供应商请求；`prepareRequest` 旧路径每次重读设置。差集只有「一轮进行中改了超时」这一种，
   用户可见语义（下一条消息生效）不变；`runContext` 的注释已改成「下一轮的调用生效」。
5. **`core/index.ts` 没有把 `ToolFillContext` 一并导出**：05 §2.5 的出口清单只列
   `describeToolCall` / `fillTools` / `narrowToKnown` / `ToolState` / `ToolRunContext`，不多加。
6. **源码注释引用 `ADR-0016`**（10 处）：06 已定号，正文由 10 落；本票不写 ADR，故此刻是前向引用。

### 7. 给 08 / 09 / 10

- 08 改执行来源时，`executePreparedToolCall:2430` 换成 `manager.execute(prepared.tool.name, …)`，
  `prepareToolCall:2297` 的 `find(currentContext.tools)` 换 `manager.get(name)` + 本轮 `activeNames` 判活；
  `Context.tools` 仍是声明载体（03 (a)），`toToolDeclaration` 一行不用改。
- 09 把 `:1003` / `:1293` 的局部 `activeToolNames` 带进执行链后，`prepareToolCall` 的默认
  `tools = currentContext.tools` 才可退场。
- 10 的文档面：`AGENTS.md:27` / `:44-48`、`docs/architecture.md:119` / `:121` / `:125`、0016 新 ADR 与四行
  取代者指针、`docs/adr/README.md` 清单；`README.md` / `docs/notes.md` 零命中，只需核对。
