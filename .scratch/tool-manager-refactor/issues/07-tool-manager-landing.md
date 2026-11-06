# 07 - Tool 目录无关与 `ToolManager` 落地：类型、类、出口、装配、smoke 改写

Type: task
Status: open

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
