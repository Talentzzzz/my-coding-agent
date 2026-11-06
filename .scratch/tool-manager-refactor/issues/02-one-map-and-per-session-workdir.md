# 02 - 一张 Map 里的实例 Tool 如何承载按会话的 workDirAbsPath

Type: grilling
Status: resolved

## Question

定案 1 要求「所有会话共用一张 `Map<name, Tool>`，持有**全部实例 Tool**，填充尽量懒加载」。
但 `Tool` 闭包绑定工作目录（`tools/manager.ts:33-41` 的 `ToolDefinition` 注释、
`tools/read.ts:30-40` 的 `createReadTool(workDirAbsPath)`），而 `workDirAbsPath` 是**按会话**的
（`agent.ts:1299`、`AGENTS.md` 的 workDirAbsPath 词条）。一张进程常驻的实例 Map 只能绑一个目录。

请裁决四条路，以及它们各自要动什么：

- **(a)** 让 `Tool` 目录无关：`ToolRunContext`（workDir + bash 超时）改为随 `execute` / 每次调用传入，
  Map 一次构造后不可变。动 `llm/types.ts` 的 `Tool`、六个 `createXxxTool`、所有 `Tool` 调用点、smoke。
- **(b)** 懒加载时按当前 run 重建 / 覆盖 Map 条目：Manager 持「最近一次请求」的实例集；
  必须回答两个在飞会话共用时的竞态。
- **(c)** 放弃 per-session workDir，全进程共用一个目录：产品语义变化，定案 3 已授权允许。
- **(d)** Map 按 workDir 键控（二级 Map / 多张）：能保实例常驻，但违背定案 1 的「一个 Map」。

同时把「懒加载」说清楚：首次访问建全部六个，还是按 name 按需建？Map 在进程生命周期内
允许被替换吗？`bash` 超时今天每请求现读（`agent.ts:1304`），新形状下从哪来？

➡️ 推荐 **(a) + 首次访问建全部六个、建完不可变**。理由：唯一同时满足「一张常驻实例 Map」
「按会话 workDir」「多会话并发」的形状，且把「每请求的值」从工具对象移到调用参数，
与 ADR-0006 B 路线的精神同调。代价是动 `Tool` 契约，定案 3 已授权。
(b) 的竞态会让并发会话互相用错目录；(c) 把按会话目录这个产品语义直接丢了；(d) 违背定案。

## Answer

**2026-11-06 定案**（`Type: grilling`，按票面 `➡️` 原样敲定、未推翻；本票代码一行未动）。

### 结论（一句话）

**选 (a) + 首次访问一次建满六个 + 建完不可变、Map 对象本身在进程生命周期内不换。**
`Tool` 目录无关：`ToolRunContext`（`workDirAbsPath` + bash 超时）从「构建期注进闭包」改成
**`Tool.execute` 的必填实参**，由这一次运行自己的栈上局部变量带到每一次调用。Map 里留的是
常量（schema、`label`、`executionMode`、行为），不留任何 per-request 值。bash 超时仍由
`Agent.runContext(state)`（`agent.ts:1298-1306`）每请求从 `SettingManager` 现读，只是改乘同一个
`run` 对象抵达 `execute`，**不新增读取点、不让工具或 Manager 持有设置服务**。

按 `docs/agents/issue-tracker.md` 与本图「执行票仍一票一会话 / 等 02–06 定案后一次 graduate」，
本票只定形状；代码落地、smoke 改写、文档与 ADR 收账归之后 graduate 的 `task` 票。

### 0. 先把票面的行号钉到今天的树

- `tools/manager.ts:26-31` 的 `ToolRunContext` 是 `{ workDirAbsPath, bash?: BashSettings }`；
  `:33-41` 的 `ToolDefinition = (run) => Tool<any>`，注释逐字写着「a `Tool` closes over its working
  directory」；六条 lambda 在 `:58-65`，`bash` 额外闭一份 `timeouts`。
- `tools/read.ts:30-40` 的 `execute` 把目录闭进 `runRead(workDirAbsPath, params, …)`，
  `tools/bash.ts:41-51` 同理。全仓生产代码**唯一**的 `execute` 调用点是 `agent.ts:2402-2410`，
  签名是 `(toolCallId, params, signal?, onUpdate?)`（`llm/types.ts:460-465`）——**run 不进 execute**。
- 每次请求的值由 `agent.ts:1298-1306` 的 `runContext(state)` 产出：`:1299` 从
  `state.session.sessionSetting.workDirAbsPath` 现取目录、`:1304` 从
  `this.settings.getBashSettings(workDirAbsPath)` 现读超时；消费点两处——`:999`（run 起始的
  `currentContext.tools`）与 `:1288`（`prepareRequest` 的活跃集）。`Context.tools` 是必填的活跃
  可执行集（`llm/types.ts:516-521`，ADR-0015 决定 3）。
- 所以票面那句「一张进程常驻的实例 Map 只能绑一个目录」成立：今天 `Tool` 的**值里含目录**，
  Map 常驻即目录常驻。
- 两处票面没点名、但定案必须一并交代的：`registry.ts:44` 的 `local` 里存的**已经是闭包好目录的
  `Tool` 对象**，且 `:56-57` 的 `build(name, run)` 命中 `local` 时**忽略 run**；
  `smoke-approval-recovery.ts:254-260` 有一个绕过注册表、直接塞进 `currentContext.tools` 的假
  `readTool`，它也要跟新签名。

### 1. 四条路逐条裁决（含各自要动什么）

#### (a) 目录无关 —— **选**

同时满足三条硬约束：一张常驻实例 Map（定案 1）、按会话 workDir（`AGENTS.md` 词条，盘上 `.json`
不动）、多会话并发不串。把「每请求的值」从对象字段移到调用参数，正是 ADR-0006 B 路线
「运行期瞬态全部降为局部变量」在工具域的对应物：常驻的是**行为**，不是状态。代价是动 `Tool`
契约（定案 3 已授权），且改动面是有限点集：六个 `runXxx` 纯函数本来就把 `workDirAbsPath` 当
显式参数收，改动只落在薄薄的 `execute` 包装层。精确形状见 §2，改动面清单见 §4。

#### (b) 懒加载时按当前 run 重建 / 覆盖条目 —— **否决**

要动什么：Manager 得新增「最近一次请求的实例集」字段与一个 `useRun(run)` / `rebuild(run)` 写者；
`Registry.build` / `active` 从纯读变成写；`Agent.run` 每个请求开头先推一次 run；`Context.tools`
与执行查找必须统一到「现取 Map」，否则就是 03 号票 (c) 那种两份工具来源。**票面点名要回答的
两个在飞会话竞态**：

1. **跨会话目录串写**。A（目录 A）与 B（目录 B）同时流式；B 的 `useRun` 覆盖 Map 条目后，
   A 这一轮后半个 `execute` 要么握着已被换掉的旧引用、要么按名字现取到 B 的实例——两条路都
   落进目录 B。`executionMode: "parallel"`（`agent.ts:2091` 的顺序/并行判定）让**同一批次**的
   多个 `execute` 也能重叠，覆盖窗口甚至不需要跨会话。claim 是**按会话**的（`AGENTS.md` claim
   词条，`SessionHub.claim()` 之外没有别的东西持有一个会话），不提供跨会话串行；要救它只能给
   Manager 加全局锁或把 run 按 id 键控——前者把所有会话的工具调用串行化，后者就是 (d)。
2. **恢复/重启与在飞旧引用**。审批是「结束重启」（ADR-0006 §5）：grant 经
   `POST /api/sessions/{id}/approvals/{toolCallId}` 到达后，由 `recoverPendingToolCalls`
   （`agent.ts:1011`、`:2005-2053`）在**新一轮**按名字现取工具重跑悬空调用。此刻条目可能已被
   别的会话覆盖，于是**错目录的结果被写进账本**（durable，不是一次界面抖动）。retry 泵与
   `runToolCall`（`:2374`）同理。

更根本的一条：进程级服务持「最近一次请求」的 per-run 字段，就是给表加了第二个写者
（ADR-0011《被放弃的选项》：「注入一张表等于给表的写者与删者各留第二个」），也把定案 1 的
「常驻实例」偷换成「常驻字段 + 每请求改写」。为它加锁，等于把 (a) 的参数传递重新实现一遍且更慢。

#### (c) 全进程共用一个目录 —— **否决**

要动什么：`workDirAbsPath` 是**会话快照字段**（`agent.ts:1299`），不是进程配置。`session-factory.ts`
的 `assembleSession` / `openAgent`、hub 的 open、`createSession`、`SettingManager` 按目录现读的两份
`settings.json`、`loadAgentsMd(workDirAbsPath)`（`:1257`）、`systemPrompt(workDirAbsPath, …)`、
`archiveToolResult(event, workDirAbsPath)` 的 `.my-agent/tool-results/` 归档、侧边栏 directory 分组、
`GET /api/health.workDirAbsPath`，以及 28 条 smoke 传的 `workDirAbsPath: root` 全挂在它上面；
`AGENTS.md` 的 workDirAbsPath / directory / settings 三条词条要一起重写，快照里那个字段要么迁移、
要么变死字段。

语义代价不是「少一个配置」，而是两个不同项目的会话写进同一个目录：`write` / `edit` 的相对路径、
`bash` 的 cwd、归档位置与每目录设置同时失去隔离，属于**数据写错地方**这一类行为变化。定案 3
「行为红线不设限」授权了付代价，但没要求付；(a) 不付它就能到终点。

#### (d) Map 按 workDir 键控 —— **否决**

要动什么：二级 `Map<workDirAbsPath, Map<name, Tool>>`（或多张 Map）；`names()` /
`activeNames(state)` / `setActiveTools` 的未知名校验（`agent.ts:528`）/ `snapshotOf` 的 `allTools`
（`fanout.ts:85`）都得先选一个 key；`register()` 要决定注进哪张子表；子表随开过的目录单调增长，
还要回答谁删、何时失效——`AGENTS.md` service 词条允许的内部键控缓存前提是「随时可从磁盘重建、
藏在自己内部不被传递」，构造出来的实例连这个前提都不成立。更硬的一条：**bash 超时对同一个目录
也会每请求变**（`:1304` 从设置现读），按 workDir 键控仍把 timeout 绑死在实例里，于是还得做 (a)
的 `execute(run)`，却要维护 N 份副本。最后它字面违背定案 1 的「一张 Map」，并把 per-session 键控
的表请回来（ADR-0011 被放弃的选项）。

### 2. (a) 的精确形状

#### 2.1 `Tool.execute` 与 `ToolRunContext` 的家

```ts
// packages/core/src/llm/types.ts
execute: (
	toolCallId: string,
	params: Static<TParameters>,
	run: ToolRunContext,             // required, third
	signal?: AbortSignal,
	onUpdate?: ToolUpdateCallback<TDetails>,
) => Promise<ToolResult<TDetails>>;
```

`run` 放**第三位且必填**：放到末尾并设成可选，会让「忘了传」在运行时静默落到别人的目录；
必填逼每个调用点说清自己属于哪一次运行。`signal` / `onUpdate` 的顺序与可选性不动，六个工厂
与 `agent.ts:2402` 各加一个实参即可。

**`ToolRunContext` 住 `llm/types.ts`，紧挨 `Tool`**；`tools/manager.ts` 改成
`export type { ToolRunContext } from "../llm/index.ts"`，于是 `tools/index.ts`、`agent.ts`、
smoke 的导入路径一个字不动。三条理由：① 它现在是 `execute` 签名的一部分，而 `execute` 自
ADR-0015 决定 2 起就住在这份文件里；签名要用的类型不与签名同住，就会出现「一个 `Tool`、
两种来源」。② 反过来留在 `tools/manager.ts`、让 `llm/types.ts` 用 type-only import 引回去，
会形成 `tools/manager.ts → llm/types.ts → tools/manager.ts` 的类型环，并让（已折进 core 的）
wire 契约文件依赖工具域。③ `BashSettings` 仍以 `config.ts:124-129` 为权威定义，
`llm/types.ts` 用 `import type { BashSettings } from "../config.ts"`——类型擦除、无运行时依赖、
无环；ADR-0015 已把 llm 折进 core，包边界不再是反对理由。

落地时把这条写进源码注释：**传输层既不读也不构造 `run`**。ADR-0015 决定 7
「传输层看得见 `execute`，但不调用它」由「看得见一个方法」扩成「看得见一个它永远拿不到的
实参」，分界不变、反而更清楚；这条分界在文档里怎么记、要不要新 ADR，归 06。
**本票的形状不要求动 `Context` 或 wire**：`Context.tools` 今天仍是必填字段
（`llm/types.ts:516-521`），但它最终装实例引用还是声明载体、传输层声明是否改从 Manager 现取，
是 03 号票的问题，02 不预决；无论 03 选哪条，目录无关的 `Tool.execute` 这一半不变。若 03 维持
`Context.tools` 作声明载体，`toToolDeclaration`（`llm/utils/transcript.ts:33-40`，只保留四个
声明字段）一行不动。

#### 2.2 六个 `createXxxTool`

六个工厂一律**零参**；`execute` 内改成 `runRead(run.workDirAbsPath, params, { signal, onUpdate })`
与 `runBash(run.workDirAbsPath, params, { signal, onUpdate, timeouts: run.bash })`，其余四个同形。
`runRead` / `runWrite` / `runEdit` / `runGlob` / `runGrep` / `runBash` 的签名**不动**（它们本来就
把目录当显式参数收），`workdir.ts:19-23` 的 `resolveToolPath`、`:33-38` 的 `displayToolPath`
与「每个工具路径都经过它、绝对路径原样、没有围栏」的约定不动；`bash.ts:73` 的
`hooks.timeouts ?? DEFAULT_BASH_SETTINGS` 兜底不动（测试直接构造时 `run.bash` 缺省走默认值）。
`label` / `parameters` / `executionMode` 全是常量，天然可共享。六个内置都不设
`prepareArguments` / `outputSchema` / `replay` / `constrainedSampling`，因此
`prepareToolCallArguments`（`:2250-2262`）、`executionMode` 查找（`:2091`）、`replay`（全仓无
读取点）**不受签名变化影响**。

#### 2.3 一张 Map、懒加载、不可变

Manager（名字归 06）构造时持 `private readonly all = new Map<string, Tool<any>>()`；**首次访问**
（`names()` / `get(name)` / 活跃集筛选 / `register()` 任一）用一次 `??=` 把六个零参工厂的产物按
`manager.ts:58-65` 的现有顺序**全部**插入；此后内置条目不增、不删、不覆盖，Map 对象本身不换
（不 `clear`、不重新赋值）。

- **为什么首次访问建全部六个，而不是按 name 按需**：`names()` / `activeNames(state)` /
  `setActiveTools` 的未知名校验（`agent.ts:528`）/ `snapshotOf` 的 `allTools`（`fanout.ts:85`）
  在任何工具被执行**之前**就要答出完整名单；按需建会逼出第二份「存在什么」的静态名单，与 Map
  成为两个事实源。目录无关之后六个构造只是对象字面量（无 I/O、无设置读、无目录），惰性本身
  几乎没有收益——定案 1 的「填充尽量懒加载」按「首次访问一次填满」兑现，不按 name 逐个建。
- **Map 在进程生命周期内不允许被替换**：在飞的 `Context.tools` 持有实例引用，换 Map 会让旧引用
  与新查找分裂（正是 (b) 的第二个竞态），也会重新打开「表的写者与删者是谁」（ADR-0011）。
  要换工具集 = 换进程 / 换一个 Manager 实例，不是改活表。由此得出一条**可测的形状不变量**：
  同一进程里任意两次 `get(name)` 恒 `===`，任意两个会话的活跃集里同名工具恒 `===`；把它写成
  哪条 smoke、旧断言怎么改，归 05。
- **`register()` 与首次填充的先后**：02 只钉死「内置条目不可被覆盖、同名不得覆盖」；若 05 选
  保留 `register()`，它只能是往表里**加新名字**；「只准填充前调用」还是「随时可加」归 05 定，
  本票不预告。
- 实例必须**无 per-call 状态**：每次不同的值都是 `execute` 的实参，工具对象不得自带可变字段或
  在闭包里捕获会话值。这条是 (a) 并发正确的前提；文档与 ADR 怎么落它归 06。

#### 2.4 run 由谁携带 —— 图上「并发」那条 fog 的答案

`Agent.runContext(state)`（`:1298-1306`）仍是唯一生产者；`Agent.run` 在**这一轮**把它收成一个
栈上的局部 `run`，显式穿过 `executeToolCalls`（`:2082`）→ `prepareToolCall`（`:2264`）→
`executePreparedToolCall`（`:2393`）→ `Tool.execute(…, run, …)`；`recoverPendingToolCalls`
（`:2005-2053`）取同一轮的 `run`，`runToolCall`（`:2374`，今天无人调用）随链条补参。这是 run 必须
穿过的链；**03 号票问的「执行改道要覆盖哪些调用点」是另一问，本票不代答**。`:999` / `:1288`
按活跃名单取出的工具不再接 run（若 03 维持现 `Context.tools` 的形状，装的就是 Map 里的实例引用；
**`Context.tools` 最终装实例引用还是声明视图归 03**）。两种 03 结局都不影响本票结论：执行查找
落到 Map、run 由调用栈带。活跃名单由谁筛选也归 04。

- **不设「当前 run」字段、不按 session id 键控、不把 run 塞进 `Context` 或 `AgentState.live`**：
  前者是 (b)、中者是 (d)，后者把 per-run 值写回会话状态，ADR-0011 对「注入一张表」的论证原样
  适用。两个在飞会话各持自己的 `run` 局部变量，共享的只是无状态 `Tool`；`parallel` 批次里同一
  实例的多个 `execute` 各带这一轮的 run，也互不干扰。**没有第二个写者，也没有按 id 的第三张表。**
- 行为等价：今天 `runContext` 在 `:999` 与 `:1288` 求两次值、工具按 `:1288` 那份构建，等于
  「一次供应商请求一份」；新形状一轮一份 `run`，粒度相同。审批 grant 后的新一轮重新求值，与
  今天新一轮重新 `active()` 现建一样，都用恢复时刻的目录与超时——ADR-0006 §5 的恢复语义不变。

#### 2.5 `bash` 超时从哪来

仍是 `agent.ts:1304` 的 `this.settings.getBashSettings(workDirAbsPath)`（`setting-manager.ts:145-146`
每次现读），值仍放 `ToolRunContext.bash`，只是**从构建期闭包改乘 `execute` 的 run 实参**；
`bash.execute` 读 `run.bash` 交给 `runBash` 的 hooks。不新增设置读取点、不让 Tool / Manager 持
`SettingManager`、也不改成「每次 `execute` 现读」——那会把语义从每请求悄悄放大成每调用，还让
工具依赖服务。`DEFAULT_BASH_SETTINGS` 兜底、`bashOr()` 的 ceiling 压缩、以及
`smoke-tools.ts:231-244` 那条「低上限会封顶并在结果里说明」的断言全部保留，只是把构造方式
从 `build("bash", { workDirAbsPath, bash })` 换成 `execute(…, { workDirAbsPath, bash }, …)`。
「改了 timeout 下一次请求生效」（`:1302-1303` 的注释）不变。

### 3. 懒加载三问（票面点名，逐条作答）

1. **首次访问建全部六个**。首个访问动作是任何一次读（`names()` 也算），不是第一次执行；理由 §2.3。
2. **Map 在进程生命周期内不允许被替换**：内置条目不可覆盖、Map 对象不换；`register()` 只能加
   新名字（去留与时机归 05）。理由 §2.3。
3. **`bash` 超时从 `Agent.runContext(state)` 来**：每请求从 `SettingManager` 现读，随 run 到达
   `execute`；细节 §2.5。

### 4. 改动面清单（交给执行票；本票不动）

| 子系统 | 落点 |
|---|---|
| 类型 | `llm/types.ts:439-476`（`execute` 加 `run`、新增/转发 `ToolRunContext`）、`:516-521`（`Context` 是否动归 03）；`tools/manager.ts:26-31 / 41 / 49-54 / 57-84 / 164-181`（`ToolRunContext` 改 re-export；形状上不再有工厂，具体方法名 / 签名归 05）；`tools/index.ts:46-48`（`createTools(run)` 的签名随 05 收） |
| 实例表 | `registry.ts:19-30, 42-74` → 一张 `Map<name, Tool>`（方法名与 `register` 归 05）；`session/tool-config.ts` 四个函数的 `registry: ToolRegistry` 形状（`defaultToolNames` / `globalDefaultToolState` / `toolStateOf` / `followsGlobalOf`） |
| 六个工厂 | `read.ts:30-41`、`write.ts:25-36`、`edit.ts:21-32`、`glob.ts:31-42`、`grep.ts:24-35`、`bash.ts:41-52`；`workdir.ts` 不动 |
| 引擎 | `agent.ts:999 / 1288`（活跃集不再接 run）、`:1298-1306`（保留，产出 run）、`:2082 / 2099 / 2161 / 2264 / 2374 / 2393`（把 run 穿过执行链）、`:2402`（唯一 `execute` 加实参）、`:1011 / 2005-2053`（恢复机器同轮 run）；`:1849` `toToolDeclaration`、`:2250-2262` `prepareArguments`、`:2091` `executionMode`、`:2452-2462` `structuredContent` 不变 |
| 服务装配 | `agent.ts:66, 102-133, 211, 528`、`session-factory.ts:23, 72, 94, 142, 163, 177-178, 263, 285, 289, 349`、`session/fanout.ts:24-28, 41, 85-89`、`core/index.ts:207-220`（出口面随 05/06 定） |
| smoke | 形状上要跟的读点：`smoke-tools.ts:86-94, 130, 231-244, 732-766`（3 处直调 `execute`、bash 上限用例、`known` 名单）、`smoke-session.ts:244-262, 1015-1033, 1242-1283`（registry 断言区、`openSession` 形参）、`smoke-approval-recovery.ts:254-260`（假 tool 补形参）、`smoke-models.ts:154, 274`（`tools: []` 不变）；断言怎么改写归 05 |
| 文档（归 06） | 会被本票推翻、需在收账票核对的现文：`AGENTS.md` 的 tool / service / workDirAbsPath 词条；`docs/architecture.md:119` 那句「一个 `Tool` 闭包着自己的工作目录」整句失效、`:125-127` 跟着改；ADR 0006 决定 3「工具不驻留内存」、0007 决定 1/2/6、0011 被放弃的「注入一张表」、0015 决定 2/3/7 相关的现状陈述。按 `docs/adr/README.md:44` 只增不改原文；名字、取代指针、是否新开 ADR 与文档归属全归 06 定 |

### 5. 决定记录（下游可直接依赖）

| # | 决定 | 约束谁 |
|---|---|---|
| 1 | `Tool` 目录无关；`ToolRunContext` 是 `execute` 的**第三位必填实参**，四个可选/常量字段语义不变 | 执行票、03、05 |
| 2 | `ToolRunContext` 权威定义在 `llm/types.ts`，`tools/manager.ts` 转发；`BashSettings` 仍属 `config.ts`；传输层不读不构造 `run` | 执行票、06 |
| 3 | 一张 `Map<name, Tool>`，首次访问一次建满六个、内置条目不可覆盖、Map 对象不换；实例不持 per-call 状态 | 执行票、04、05、06 |
| 4 | run 是 `Agent.run` 的栈上局部，显式穿过执行链；不设「当前 run」字段、不按 id 键控、不进 `Context` / `AgentState.live` | 执行票、03、04 |
| 5 | bash 超时仍由 `Agent.runContext(state)` 每请求现读，随 run 到 `execute`；无新读取点、默认值兜底与封顶语义不变 | 执行票、05 |
| 6 | 六个 `runXxx`、`resolveToolPath` / `displayToolPath`、无围栏约定不变；本票**不要求**动 `toToolDeclaration` 与 wire（03 决定是否动） | 执行票、03 |
| 7 | 否 (b) 的两条竞态、否 (c) 的语义代价、否 (d) 的键控表——三者的理由分别落在「第二个写者」「数据写错地方」「违背定案 1 + timeout 仍要 per-call」 | 06、执行票 |

**本票没有回答的**（别当成已定）：`Context.tools` 是实例引用还是声明视图、执行改道覆盖的全部
调用点、`toToolDeclaration` 与 wire 是否动（03）；活跃集与审批的归属（04）；`register()` 去留、
五个旧方法的名字与签名、smoke 断言怎么重写（05）；`ToolManager` 名字冲突、历史 ADR 的取代指针、
是否新开 ADR 与文档归属（06）；执行票怎么切、何时 graduate（本图 `Not yet specified`，等 02–06
全定案后一次 graduate）。§2 / §4 写的是本票形状**必然带来**的后果与要跟的读点，不是替这四张票
做选择；凡与它们的问题重叠处，以上面这张「未回答」清单为准。

### 6. 验收（2026-11-06 与 01 号票基线对跑）

本票未改任何 `packages/` 源码或 `scripts/smoke-*.ts`；入库的 `run-all.sh` 是 01 号票基线留下的
既有脚本，本轮只把它纳入版本控制、内容一字未动。按图「每票收账跑 `npm run check`」是本票的
验收项；下面这遍全套 28 条对跑是本次实现流程要求的收尾复跑，不是本票新增的验收门槛。
与 01 号票基线对跑，**零新红成立**：

- `npm run check`：**绿**，`tokens ok: 137 defined, 111 referenced`；`check.log` 与基线逐字节相同。
- 28 条 smoke（`run-all.sh` 无服务器口径）：**26 绿 / 2 既有红**，红集合仍是
  `{ smoke-api（缺服务器）, smoke-liveness（本机时序） }`，没有第三条稳定红，也没有
  `smoke-approval` 那种偶发红（本轮 22 s 正常收尾、绿）。`smoke-api.log` 与基线逐字相同
  （`the mux connection failed`）；`smoke-liveness` 只红在票面那条预算内断言（本轮 2116 ms，
  基线 1943 / 1898 ms，预算 1650 ms），与 01 号票记的「同一条脚本不同轮次 FAIL 组合不一致」一致。
- 逐份 diff 28 条日志：只有 3 份与基线不等——`smoke-boot`（随机端口 / 临时 home / UUID）、
  `smoke-approval`（错误消息里的 UUID）、`smoke-liveness`（毫秒数与 FAIL 组合），
  全在 01 号票 §5 登记的随机量清单里；**`smoke-tools.log` 223 行逐字节相同**。
- 全部输出落在 `../smoke-runs/after-02/`（日志与临时 home 不入提交；`check.log`、
  `summary.txt`、28 份 `<name>.log` 可复跑）。本票没有跑 `smoke-api` 的「起服务器后 ok」那一遍
  ——本轮无源码改动，那条结论按 01 号票 §4 原样沿用。
- `Status` 翻 `resolved`，`map.md` 的 Decisions so far 追加一条上下文指针、Not yet specified
  清掉本票已答的三块雾（`ToolRunContext` 归属 / 并发 / 懒加载三问），并标出 03 / 05 的阻塞已解除。
