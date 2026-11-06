# 05 - register()、懒加载与 smoke 断言的处置

Type: grilling
Status: resolved
Blocked by: 02

## Question

今天 `Registry.register()`（`tools/registry.ts:70`）只服务测试：
`scripts/smoke-session.ts:1018` 自建 registry 塞 `unbounded` 验证写边界归档、
`:1280` 塞 `noop`；`scripts/smoke-tools.ts:233` 用 `build("bash", run)` 测 bash 超时；
`smoke-session.ts:1264` 断言 `active()` **每次返回新对象**、`:1281` 断言
`build("noop", run) === noop`（register 的对象身份）。
换成一张常驻实例 Map 后，这些断言与新形状天然冲突，定案 3 已授权改。

请裁决：

- **(a)** `register()` 保留为 `map.set`，测试工具与内置工具同表；smoke 断言按新形状重写
  （「每次新对象」改成「恒为同一实例」）。
- **(b)** 去掉 `register()`，测试工具改由 `ToolManager` 构造参数注入；`exerciseOutputBackstop`
  用例随之改。
- **(c)** 保留 `register()` 但只准在 Map 首次填充前调用，之后抛错。

并定旧五个方法在 Manager 上的去留：`names()` / `build(name, run)` / `activeNames(state)` /
`active(state, run)` / `register(tool)` —— 哪些保留、哪些删、要不要留别名过渡
（`smoke-tools.ts:733` 还直接用了 `toolDefinitions().names()`，`scripts/mount-session.ts`
从 `@my-agent/core` 导入工具出口）。
若 02 号票定案 (a)，`run` 参数不再需要，`build` 的签名怎么收？

➡️ 推荐 **(a)**：测试注入是既有能力，没必要为一次改名砍掉；断言按新形状改写并补一条
「同一会话的两个请求取到同一个实例」，把新不变量测出来。

## Answer

**2026-11-06 定案**（`Type: grilling`，按票面 `➡️` 原样敲定、未推翻；本票代码一行未动）。

### 结论（一句话）

**选 (a)**：`register()` 保留为往那一张 Map 里 `set`，测试工具与六个内置同表、**随时可加、只加新名字、
不覆盖**；smoke 断言按新形状改写，并补一条「同一会话的两个请求取到同一个实例」。旧五法的去留：
`names()`、`register()` **留**（签名不动）；`build(name, run)` **收成 `get(name)`**——`run` 整个删掉、不叫
`build`；`activeNames(state)`、`active(state, run)` **删**；**不留任何别名过渡**。按 03 §5 #4 另新增
执行入口 `execute(name, toolCallId, params, run, signal?, onUpdate?)`，于是 Manager 的公开面是
`names` / `get` / `execute` / `register` 四个方法，只收名字与一次调用的参数（04 §5 #1）。

按 `docs/agents/issue-tracker.md` 与本图「执行票仍一票一会话 / 等 02–06 定案后一次 graduate」，
本票只出决定；代码落地、smoke 改写、文档与 ADR 收账归之后 graduate 的 `task` 票。**06 的问题一律不代答**
（类名/文件/符号名、ADR 取代指针、逐句文档改写），执行票的内部形状细节也不预切；凡 §2 / §4 与它们
重叠处，以 §6 的「未回答」清单为准。

### 0. 先把票面的行号钉到今天的树（`452ec61`）

票面点名的都成立：

- `tools/registry.ts:19-30` 是旧五法：`names(): string[]`（`:21`）、`build(name, run)`（`:23`）、
  `activeNames(state)`（`:25`）、`active(state, run)`（`:27`）、`register(tool)`（`:29`）。
  `:42-74` 的 `Registry` 持两张事实源：`:44` 的 `local = new Map<string, Tool<any>>()` 存**已经注册好的
  `Tool` 对象**，`:45` 的 `definitions: ToolDefinitions` 存六个工厂。`names():51-53` 是
  `[...definitions.names(), ...local.keys()]`；`build:55-59` 命中 `local` 时**忽略 `run` 直接返回那个对象**、
  否则 `definitions.get(name)?.(run)` 现造；`activeNames:61-64` 只是再 `filter(known)` 一次；
  `active:66-68` 走 `toolListFor(definitions, state, run, [...local.values()])`；`register:70-73` 用
  `this.names().includes(tool.name)` 判重，抛 `Tool already registered: <name>`。
- 三处 smoke 注入逐条对得上：`smoke-session.ts:1018-1025` 自建 registry、`register({ name: "unbounded" })`，
  `:1033` 把它作为 `openSession` 第 4 参传进去，验写边界归档；`:1273-1281` 的 `noop` 与
  `build("noop", run) === noop`（**registered 对象身份**，不是 built-in 的身份）；
  `smoke-tools.ts:233-238` 用 `createToolRegistry(toolDefinitions()).build("bash", { workDirAbsPath, bash })`
  造低上限的 bash 再直调 `execute`，验封顶说明。
- 两条冲突断言：`smoke-session.ts:1264` `registry.active(full, run) !== registry.active(full, run)`
  （数组每次新建）、`:1281` `registry.build("noop", run) === noop`。前者在常驻实例 Map 下按构造为假；
  后者是 `local` 表在同一对象上返回的结果，**恰好是 (a) 要保住的那一半**。
- `smoke-tools.ts:733` 的 `toolDefinitions().names()` 成立，但它是 `tools/manager.ts:81-84` 的
  `sharedDefinitions ??= createToolDefinitions()` 那只**模块级单例**，与 `Registry` 的 `definitions`
  字段是两处独立的「存在什么」读口——换成一张 Map 后不该留第二份名单（02 §2.3 的理由原样适用）。
- `tools/manager.ts:41` 的 `ToolDefinition = (run) => Tool<any>`、`:49-54` 的 `ToolDefinitions`、
  `:57-71` 的六个 lambda、`:164-181` 的 `toolListFor`，以及 `tools/index.ts:46-48` 的
  `createTools(run): Tool<any>[]`，都是「每次现建」这条链上的部件；`core/index.ts:207-220` 把它们与
  `createToolRegistry` / `type ToolRegistry` 一起挂成 `@my-agent/core` 的工具出口。

**票面一处需要更正**：`scripts/mount-session.ts` **没有从 `@my-agent/core` 导入任何工具符号**。
`:14-19` 导入的是 `type Session` / `SessionManager` / `createSession` / `assembleSession`，
`:53-58` 调 `assembleSession` 且**不传 `tools`**。它对本票真正要紧的地方在装配侧：
不带 `tools` 时，`assembleSession` → `assemble`（`session-factory.ts:142`）会
`options.tools ?? createToolRegistry(toolDefinitions())` 造一只，`createSessionAgent`（`:285`）再造一只；
带了 `tools` 则两处用同一只，但 `assembleSession:221` 只从 `assemble` 解构四项、**丢掉 `registry`**，
`openAgent:344-351` 也只在 `createSessionAgent` 那一行显式转发 `options.tools`（04 §0 第 4 点原话）。
04 §5 #9 已把这两处收敛列为核对项，而 hub 的冷读是第三个读者——
`hub.ts:251` 构造编排层时不传 tools、`:792` 的 `sessionOptions` 也不带 tools，`hub.ts:335` 的
`readSessionSnapshot` 于是在 `assemble` 里再造一只并在 `:177-182` 真的读它。本票不新增装配约束，
只记 (a) 保留 `register()` 后的一条形体后果：这只冷读目录必须也是那一张 Map，否则 04 §3 的
「冷/热 `allTools` 一致」在测试工具上会破（§2.5、§4）。

票面没点名、但定案必须一并交代的：

1. **生产端与目录查询端今天读的是同一只目录的不同方法**：`agent.ts:999` / `:1288` 的
   `Context.tools` 来自 `tools.active(toolStateOf(...), this.runContext(state))`，而 `:528` 的
   未知名校验与 `fanout.ts:85` 的 `allTools` 从 `this.tools.names()` 读。03 / 04 已定案这两半
   怎么改道与归属，05 只定它们**从 Manager 的哪扇门读**（§2.2）。
2. **三处直调 `Tool.execute`**：`smoke-tools.ts:94` / `:130` / `:238`。02 §2.1 把 `run` 定为
   第三位必填实参后，这三处不只是换 `build`，还要各补一个 `run`（02 §4 / §2.5）。
3. **`smoke-approval-recovery.ts` 是 (a)/(b) 的分水岭**：`:254-260` 造一个假 `readTool`，
   `:268` / `:287` / `:305` 三次直调导出的 `recoverPendingToolCalls`（六个位置实参），
   `:306` 把假 tool 塞进 `Context.tools` 才让恢复机器「找得到」。03 §3 已判这条注入随 (a) 失效，
   而它**没有 Agent、没有 hub**——测试工具只能注进一只它自己造的 Manager（§3.5）。
4. **出口面只有仓内消费者**：全仓 `ToolRegistry` / `toolDefinitions()` / `createTools` 的引用都在
   `packages/core`、`scripts/` 与 `AGENTS.md` / `architecture.md` / ADR 0012 / 0013 共四处文档；
   `packages/server` / `desktop` / `web` 源码零引用，
   只消费快照里的 `string[]`（map「波及面」已核）。所以「别名过渡」没有外部兼容对象（§2.6）。
5. `smoke-session.ts:244-262` 的 `openSession` 第 4 参是 `tools?: ToolRegistry`，`:1954` 调
   `exerciseToolRegistry()`；`smoke-tools.ts:86-90` 的 `tool(name)` helper 每次 `createTools(run)` 现建六个
   再 `find`。两处都随本票的出口面改写（§3.2 / §3.4）。

### 1. 三条路逐条裁决（含各自要动什么）

#### (a) `register()` 保留为 `map.set`，测试工具与内置同表 —— **选**

要动什么：Manager 只持一张 `Map<string, Tool<any>>`；`register()` 先触发 02 §2.3 的首次填充、
再判重、`map.set`；`names()` 直接读键集；`get(name)` 是纯查表；03 的执行入口 `get(name)` 后转发。
`registry.ts:44` 的 `local` 与 `definitions` 两张表合并成一张，`smoke` 的断言按 §3 改写。

四条决定性理由：

1. **测试注入是既有能力，砍它要付生产代码的账**。`exerciseOutputBackstop` 今天只做三件事：
   造一只目录、`register(unbounded)`、把它交给 `openSession`。(a) 下这三步一行不删。
   (b) 要把「加一个工具」从实例级方法改成构造期参数，就得让 `assemble`（`:142`）、
   `createSessionAgent`（`:285`）、`openAgent`（`:344-351`）、hub 的 `createSessionAgent`（`:251`）
   与 `sessionOptions`（`:792`）都认识这份参数，而这些点今天本就要为 04 §5 #9 收敛；
   为一次改名把测试工具的账记到生产装配上，不划算。
2. **`smoke-approval-recovery.ts` 没有宿主可注入**。它直调文件级函数、自己攒 `Context` 与 hooks，
   连 `Agent` 都没有。(a) 让它 `createToolManager()` + `register(readTool)` 两行就能供出执行依赖；
   (b) 仍要让它自己造一只带注入参数的 Manager，只是把同样的两行换了个位置，还顺手删掉了
   `exerciseToolRegistry:1281` 那条 register 身份断言能继续存在的前提。
3. **(a) 不引入第二个「值的写者」**。02 §5 #3 / 04 §5 #1 禁的是「进程级服务改写已有值 / 持
   per-session 状态」；`register()` 只往表里**加新键**，六个内置条目建完即不可变，Map 对象不换。
   在飞请求握着的 `Context.tools` 是它自己 `prepareRequest` 时按活跃名单取出的实例引用，
   `architecture.md` 已写明「一次已经在飞的运行保持它启动时的那套」；新名字只对**下一次**读取可见。
   这正好是 02 §2.3「内置条目不可被覆盖、同名不得覆盖」的兑现方式，不是给它开口子。
4. **与 02 §2.3 的形状无缝**：该节已把 `register()` 列为首次访问的触发者之一，并明写
   「若 05 选保留 `register()`，它只能是往表里加新名字」。本票取它，不改 02 任何决定。

代价照实记：`register()` 让一张进程级表在构造之后仍可增长，因此「表不可变」这句话的准确含义是
**已有条目与 Map 对象不可变、键集可单调增长**；这条口径要进 06 的文档与 ADR 收账（§6）。
另外 `register()` 仍是生产代码不该调的测试接缝（§2.1 末段）。

#### (b) 去掉 `register()`，测试工具改由 `ToolManager` 构造参数注入 —— **否决**

要动什么：Manager 构造签名多收 `extra: readonly Tool<any>[]`（或一份 definitions 表）；
`session-factory.ts:142` / `:285`、`openAgent:344-351`、hub `:251` / `:792` 全部转发；
`exerciseOutputBackstop` 改成构造时带 `unbounded`、`smoke-approval-recovery` 改成构造时带假 `readTool`；
`exerciseToolRegistry` 的身份断言随 (a) 一样要重写。逐条代价：

1. **删不掉「写」，只是把写挪到构造期**。02 §2.3 的首次填充本身就是一次写（`ensureFilled` 把六个
   实例插进 Map）。(b) 声称的「构造后无写者」在懒加载下并不成立，换来的只是把两种工具拆成
   「构造期给的一份名单」+「首次访问建的六个」两个来源——正是 02 §2.3 否掉按需建的同一理由。
2. **测试能力被绑到进程构造期**。`openAgent:344-351` 只在 `createSessionAgent` 那一行显式转发
   `options.tools`，`assembleSession:221` 把 `assemble` 产出的 `registry` 丢掉，hub 的
   `sessionOptions`（`:792`）与 `snapshotOf`（`:335`）那条冷读路径根本不带 `tools`、会自己造一只
   （§0）。要保住「测试工具在冷/热快照里都在」，(b) 得把注入参数一路铺进这些装配点，
   而 (a) 只需让它们共用**同一只 Manager 实例**——后者本来就是 04 §5 #9 要做的收敛。
3. **恢复机器那个 smoke 无处可省**。它仍得自己造一只 Manager；(b) 只是把 `register(readTool)` 换成
   构造实参，且从此不能在同一只 Manager 上先跑一轮再补一个工具（`:268`/`:287`/`:305` 三次调用
   若想换工具就得重建）。
4. **定案 3 授权改，不等于必须改**。(b) 唯一收益是「公开面少一个方法」，但 04 §5 #1 允许
   `register()` 存在（04 §3 的表甚至把「含 05 若保留 `register()` 加入的名字」写进了 `names()` 语义），
   而 map 的终点是「一张 Map 持有全部 Tool」，(a) 已经到。为少一个方法改动五处生产装配，净负。

#### (c) 保留 `register()` 但只准在 Map 首次填充前调用，之后抛错 —— **否决**

要动什么：Manager 多一个 `filled` 生命周期标志，`register()` 开头判它并抛错；还要重定义
「首次填充」的触发集合，把 `register()` 自己排除或特殊处理；三处 smoke 必须保证注册发生在任何
`names()` 之前。逐条代价：

1. **与 02 §2.3 自相矛盾**。该节明写首次访问包括 `register()` 在内。若 `register()` 先填充再判
   「只准填充前」，同一只 Manager 上注册第二个测试工具就会抛错；若把它豁免，规则实际变成
   「每只 Manager 只准 `register()` 一次」，与票面写的「首次填充前」不是一回事，且没有理由。
2. **隐藏的时间耦合**。`names()` 是 `setActiveTools` 的未知名校验（`agent.ts:528`）、
   `snapshotOf.allTools`（`fanout.ts:85`）、冷读 `allTools`（`session-factory.ts:177`）、
   `toolStateOf` 四函数的 `known` 的共同读口——任何一次装配或快照都会先填满 Map。
   `exerciseOutputBackstop` 是在 `openSession` **之前**注册才侥幸成立的；把「测试能不能注工具」
   系于「此前有没有人读过快照」，是给 smoke 埋一颗与被测行为无关的雷。
3. **多一份常驻状态，却没多买一分不变量**。内置条目不可覆盖已由判重保证，在飞引用不被换掉
   已由「只加新键 + Map 不换」保证（§1(a) 理由 3）；`filled` 标志只是把这两条已成立的事实再记一遍。
4. **三处 smoke 都要为它让路**：`smoke-approval-recovery` 没有宿主、要在直调恢复机器前注册；
   `exerciseToolRegistry` 想在 `names()` 断言之后测 `register()` 的身份与判重；
   `exerciseOutputBackstop` 要在开会话前注册。(a) 下这三处各按自己的顺序写就行。

### 2. (a) 的精确形状

#### 2.1 一张 Map、懒加载与 `register()` 的先后

Manager（**名字/文件归属 06**）构造**零参**：六个内置是 `tools/` 内的一份私有常量，
按 `manager.ts:58-65` 现顺序排成零参工厂，不再从外部注入 `ToolDefinitions`。
`private readonly all = new Map<string, Tool<any>>()`；`ensureFilled()` 用一次 `??=` 式的幂等填充把
六个产物按原顺序插满，此后内置条目不增、不删、不覆盖，Map 对象本身不换（02 §2.3、02 §5 #3）。

- **首次访问的触发集合**：`names()` / `get(name)` / `execute(...)` / `register()` 四个公开方法任一。
  02 §2.3 当时列的是 `names()` / `get(name)` / 活跃集筛选 / `register()`；03 的执行入口是它之后
  新增的第四个公开方法，同样要先 `ensureFilled()`；04 定案 (a) 之后筛选留在引擎与
  `session/tool-config.ts`，读的是 `manager.names()` 返回的名单数据（04 §2.5），
  Manager 自己不再有这个触发者。两条都是既有定案的形状后果，**不是改 02 的决定**。
- **`register(tool)` 的实现顺序**：`ensureFilled()` → `if (this.all.has(tool.name)) throw new Error(
  \`Tool already registered: ${tool.name}\`)` → `this.all.set(tool.name, tool)`。先填充再判重，
  保证「注册过的名字撞内置」也按同一条错拒掉，且后来的懒填充不会覆盖刚注册的对象。
  错误消息沿用 `registry.ts:71` 的原文。`names()` 于是就是 `[...this.all.keys()]`：
  六个内置在前、注册项按调用顺序在后，与今天 `[...definitions.names(), ...local.keys()]` 同序同值。
- **「随时可加」的边界**：不设时间点限制、不设 `filled` 标志；但只加新名字，同名（含内置）一律抛错，
  没有 `unregister` / `clear` / `replace` / 换 Map。**注册项也是目录无关的实例**（02 §5 #3）：
  每次不同的值都走 `execute` 的 `run` 实参，不许在闭包里捕会话值；`smoke` 两个假工具今天不读
  `run`，`execute: async () => ...` 少收参数在 TS 里仍可赋给 `Tool`，**函数体不用改**。
- **测试接缝的口径**：生产代码零 `register()` 调用，只有 `scripts/` 用它；不引入 env 开关或运行时
  守卫去「识别测试」（那要给进程级服务加一份配置），而是在源码注释里写清它只加新名字、
  内置条目不可覆盖（源码注释用英文；文档怎么记归 06）。这也意味着 `names()` / `allTools` /
  `defaultToolNames` 的「全量」在带测试工具的进程里会多一个名字——与今天 `local` 表参与
  `names()` 的行为**逐字等价**（04 §3 的表已按这个语义写）。
- **并发**：两个在飞会话各持本轮 `run`（02 §2.4）与各自的 `activeNames`（04 §2.4），共享的只有
  无状态实例；`register()` 加的新键不改动任何已存在的条目，因此不产生第二个「值的写者」，
  也不需要锁。新名字对已经在飞的那轮不可见、对下一轮可见，与 `architecture.md` 的重建语义一致。

#### 2.2 旧五法的去留（票面点名，逐条作答）

| 旧方法 | 去留 | 新形状 / 去向 | 理由 |
|---|---|---|---|
| `names(): string[]` | **留，签名不动** | `[...this.all.keys()]`，语义是「Map 里全部实例的名字」，含注册项 | 04 §3 的三处读点（`:528` / `fanout.ts:85` / `session-factory.ts:177`）与 04 §2.5 四函数的 `known` 全靠这只门；04 §5 #7 明写「05 若改门名三者同改」，本票不改 |
| `build(name, run)` | **删** | 由新增的 `get(name): Tool<any> \| undefined` 取代 | 02 定案 (a) 后 `Tool` 目录无关，没有「按 run 构建」这回事；03 §2.2 / §2.4 已把引擎唯一查表动作写成 `manager.get(name)`。详见 §2.3 |
| `activeNames(state: ToolState)` | **删** | 活跃名单改吃 `toolStateOf(...).activeToolNames`（04 §2.2 / §3），冷读 `session-factory.ts:178` 同样改吃纯数据 | 04 定案 (a)：活跃集是账本派生的纯数据，Manager 公开面**不收** `ToolState` / 任何会话状态；`toolStateOf:71` 已按 `known` 收窄，这方法只是重复收窄（04 §0 第 1 点） |
| `active(state, run)` | **删，且不加批量便利门** | `:999` / `:1288` 由引擎按本轮 `activeNames` 逐个 `manager.get(name)` 装 `Context.tools`（03 §2.1、04 §2.2） | 04 §2.1 允许留一个「按名字批量取实例」的门（形参只能是 `readonly string[]`），但留它就会有一个**每次返回新数组**的公开方法，正好长得像被本票删掉的「每次现建」语义；两个生产点各一行 `.map(get)` 即可，少一扇门、少一处 06 要收账的出口 |
| `register(tool)` | **留，签名不动** | `map.set`，见 §2.1 | (a)，票面 `➡️`；02 §2.3 与 04 §3 都已为它留好位置 |

新增两法，都是 03 已定案、只把名字/签名在这里敲死：`get(name)`（03 §2.2）与 `execute(...)`
（03 §5 #4、04 §2.1）。于是公开面是 **`names` / `get` / `execute` / `register`** 四个方法，
形参只有名字与一次调用的参数，不出现 `ToolState` / `Session` / `AgentState` / 服务 / `sessionId`
（04 §5 #1 不变）。

#### 2.3 `build` 的签名怎么收（票面点名）

```
build(name: string, run: ToolRunContext): Tool<any> | undefined   // 今天
get(name: string): Tool<any> | undefined                          // 之后
```

`run` **整个删掉，不留可选尾巴**：02 定案 (a) 已把 `ToolRunContext` 从构建期闭包移到
`Tool.execute` 的第三位必填实参（02 §2.1），Map 里存的是无 per-call 状态的实例，
再传 `run` 给查表动作既无处可用，又会把「目录是每次调用的值」这个刚立起来的分界重新搅混。
`build` 这个名字也一并删：**它描述的是「按上下文造一个对象」，而新形状是「从不可变表里取」**；
`registry.build` 今天对内置每次现造、对注册项返回同一对象，这两种行为在 `get` 下统一成同一种
（恒返回同一实例），正是 `:1264` 断言要翻转的根子。未知名仍返回 `undefined`，由
`prepareToolCall:2273-2279` 在闸门前回 `Tool <name> not found`（03 §5 #6；04 §2.4 补的判活也在引擎）。

#### 2.4 执行入口 `execute(...)`（03 §5 #4 交由本票定名定签名）

```
execute(
	name: string,
	toolCallId: string,
	params: unknown,
	run: ToolRunContext,
	signal?: AbortSignal,
	onUpdate?: ToolUpdateCallback<any>,
): Promise<ToolResult<any>>
```

- 04 §2.1 已把这份形参列全（「名字 + `toolCallId` / `params` / `run` / `signal` / `onUpdate`」），
  03 §2.4 自己写的调用形也是 `manager.execute(...)`，本票只是把名字与顺序钉死。
  `params` 的类型按今天 `Tool<any>` 的现状转发（`unknown` + 调用点 `as never`，不新增 `any`），
  具体落法属执行票。
- **`run` 必填、无默认**。02 §2.1 的「第三位且必填」是对 `Tool.execute` 说的；Manager 入口因多了
  前置 `name` 落在第四位，但「忘了传就编译不过」这条保证不变——否则会静默落到别人的目录。
  `signal` / `onUpdate` 的顺序与可选性不动；六个工厂的 `execute` 包装层各多收一个 `run` 形参
  （02 §2.2），`:2402` 则由引擎改调 `manager.execute(...)` 把这一轮的 `run` 显式带下去（02 §2.4）。
- 方法体只有 `get(name)` + 原样转发 `Tool.execute(toolCallId, params, run, signal, onUpdate)`，
  成为**生产代码唯一**的 `Tool.execute` 调用点（03 §5 #4）。`get` 落空时抛
  `Tool ${name} not found` 作防御：`executePreparedToolCall` 现成的 `try/catch` 会把它变成错误结果，
  行为不变；这不是第二道判活闸门（04 §2.4 的 `activeNames.has(name)` 仍在引擎侧）。
  校验 / shim / 两道闸门 / 事件 / 定稿一律不进 Manager（03 §2.4）。

#### 2.5 出口面：`createTools` / `toolDefinitions` / `toolListFor` 与 `core/index.ts`

02 §4 把 `tools/index.ts:46-48` 的 `createTools(run)` 交给 05 收，04 §4 把 `core/index.ts:207-220`
的出口面交给 05/06 一起定。本票定「哪些出口还在」，**具体类名/符号名归 06**：

- **删**：`createToolRegistry`、`type ToolRegistry`、`createTools`、`toolDefinitions`、
  `createToolDefinitions`、`type ToolDefinition(s)`、`toolListFor`。理由：六个工厂收成零参后
  `ToolDefinition = (run) => Tool` 这个类型描述的是已经不存在的东西；`toolListFor` 唯一的
  生产读者是 `registry.active`（`:67`），`createTools(run)` 唯一的读者是 `smoke-tools.ts:87`，
  `toolDefinitions()` 剩余读者是三处装配点与 `smoke-tools.ts:733`。留任何一个，都是在
  「一张 Map」之外再留一份「存在什么」或「怎么造」的事实源（02 §2.3）。
- **留**：`describeToolCall`、`fillTools`、`narrowToKnown`、`type ToolState`、
  `type ToolRunContext`（02 §2.1 让它从 `llm/types.ts` 经 `tools/manager.ts` 转发，导入路径不变）、
  `DEFAULT_MODE_NAME` 等与「选择/填充」有关的既有出口（文件与符号名归 06）。
- **加**：新 Manager 的构造工厂与类型（名字归 06），**零参**；`session-factory.ts:142` / `:285`
  从 `createToolRegistry(toolDefinitions())` 收成 `createToolManager()`。04 §5 #9 要求的
  「两处收敛到同一只」因此是**传同一实例**，不是「两边各自造一只等价的」。
- **`smoke-tools.ts:733`** 改读 `manager.names()`（脚本自己那只模块级 Manager，§3.4），
  `exerciseFillTools` 的 `known` / `globalTools` 仍是同样的六个名字、断言一字不动；
  不再有 `toolDefinitions().names()` 这份并列名单。
- **`scripts/mount-session.ts`**（§0 的更正）：今天不导入工具符号，之后也不需要导入；
  它仍只调 `assembleSession`（那条路径今天把 `assemble` 的 `registry` 丢掉、不读名字）。
  但 (a) 下有一条形体后果要交执行票核对：hub 的冷读
  （`hub.ts:335` → `readSessionSnapshot` → `assemble`，`:177` 真的读 `allTools`）必须拿到
  **同一只 Manager**，否则一只注册了测试工具的 Manager 只在热侧可见，
  04 §3「冷/热快照一致」在 `allTools` 上就破了。这是 (a) 与 04 §3 / §5 #9 的推论与核对项，
  **不是本票新增的装配约束**。
- `packages/server` / `desktop` / `web` 源码零改动：它们只消费快照字符串数组，
  `.json` / `.jsonl` / `tool_config` entry 格式一字不动（04 §5 #2 #3）。

#### 2.6 别名过渡：**不留**

不保留 `build` / `activeNames` / `active` 的别名，也不留 `createToolRegistry` / `toolDefinitions` /
零参 `createTools()` 这类兼容壳。三条理由：① 全仓消费者都在 `packages/core` 与 `scripts/`，
外部进程只认 `string[]`（§0 第 4 点），graduate 的执行票一次会话就能把所有调用点改完，
没有需要跨版本兼容的调用方；② `build` / `active` 这两个名字描述的是被 02/03/04 推翻的
「每请求现建」，留着就是两个名字一扇门，还会把「恒等不变量」写成一半真一半假；
③ map 的 *Destination* 明写「`ToolRegistry` 及其旧名词全仓清零」，别名会让这条验收当场失守，
并给 06 多留一处要收账的名字。若执行票确实想要一个「全部实例」的便利函数，它只能委托
**同一只 Manager** 的 `names()` / `get()`，不得另造 Map；本票判不需要。

#### 2.7 「每次新对象」翻成「恒为同一实例」时，恒等的是**元素**不是数组

`:1264` 那句断言测的是 `active()` 返回的**数组**每次新建。03 §2.1 / 04 §2.2 之后
`Context.tools` 仍然是每个请求**重建的数组**（活跃子集按本轮名单现取），所以新断言不能写成
「两次 `Context.tools` 相等」。准确的不变量是 02 §2.3 / §5 #3 的两半，且都是**实例级**的：

1. 同一进程任意两次 `get(name)` 恒 `===`，且 `===` 请求里 `Context.tools` 的同名元素；
2. 同一会话的两个请求、以及任意两个会话的活跃集里，同名工具恒 `===`。

改写后的数组关系恰好反过来：`sent[0].instances !== sent[1].instances`（数组仍每次新建），
但 `sent[0].instances[i] === sent[1].instances[i]`（元素恒同一）。§3.3 把两条都写成断言。

### 3. smoke 断言怎么改写（交给执行票，逐点）

#### 3.1 `smoke-session.ts:1015-1033` `exerciseOutputBackstop` —— 保留注入，只换构造

`createToolRegistry(toolDefinitions())` → `createToolManager()`（名字归 06），
`registry.register({ ...unbounded })` → `manager.register({ ... })` 原样，
`openSession({}, {}, undefined, registry)` → 传这只 `manager`。断言**一条不改**：
模型请求在预算内、有 `characters omitted`、账本存的是截短版、全文归档在 `.my-agent/tool-results/`、
结果不是 error。因为注册发生在开会话前，`toolStateOf` 的默认全量（来自 `names()`）包含
`unbounded`，这个调用仍会经 Manager 的 `execute` 入口落到写边界。假工具的 `execute` 不收 `run`
也照样类型合法（§2.1）。(b) 会逼这个用例改装配，(c) 会逼它抢在任何 `names()` 之前注册——
两条都是无收益的改动。

#### 3.2 `smoke-session.ts:1252-1283` 断言区 —— 改名 + 逐行重写

函数与 `:1954` 的调用点从 `exerciseToolRegistry` 改成 `exerciseToolManager`（名字随 06 的定名）。
`const registry = createToolRegistry(toolDefinitions())` → `const manager = createToolManager()`；
`const full = { activeToolNames: registry.names() }` 与 `run = { workDirAbsPath: root }` 两行删
（`run` 不再进任何目录方法，02 决定 4）。逐行：

| 今天 | 之后 |
|---|---|
| `:1259` `names()` 六内置按注册顺序 | **留**，措辞改成「Map 持有六个内置、按注册顺序」 |
| `:1260` `activeNames(full)` 等于全量 | **删**；活跃名单改由 `toolStateOf` 派生，这条行为由 `exerciseFillTools`（`smoke-tools.ts:732-775`）与 `exerciseActiveTools:1304-1319` 覆盖 |
| `:1261` `build("bash", run)?.name === "bash"` | `get("bash")?.name === "bash"` |
| `:1262` `build("nope", run) === undefined` | `get("nope") === undefined` |
| `:1263` `build("bash", run)?.executionMode === "sequential"` | `get("bash")?.executionMode === "sequential"`（**常量在实例上**，不随会话变） |
| `:1264` `active(full, run) !== active(full, run)`「每次新对象」 | **翻转**：`get("bash") === get("bash")`，「恒为同一实例」；另见 §3.3 的请求级断言 |
| `:1265` `active(full, run).every(...)` 名字同序 | **删**；声明名单由 `exerciseActiveTools:1306/1319` 断言，元素身份由 §3.3 断言 |
| `:1268` / `:1269` 收窄后的 `activeNames` / `active` | **删**（方法已删）；收窄语义落到 `:1271` 的 `narrowToKnown` 与 §3.3 第二次请求 |
| `:1270` `names().length === 6` | **留**，仍放在 `register()` 之前 |
| `:1271` 未知名被读掉、不抛错 | `narrowToKnown(["read", "nope"], manager.names())` 等于 `["read"]`（从 `@my-agent/core` 补一个导入），被测对象从目录方法换成纯数据函数 |
| `:1273-1281` `noop` + 身份断言 | `manager.register(noop)`；`get("noop") === noop && manager.names().includes("noop")`；并补两条判重：`register(noop)` 再抛 `Tool already registered: noop`、`register({...noop, name: "read"})` 抛同一错（02 §2.3「内置不可覆盖」的可测面） |
| `:1282` 「选择而非目录决定要不要提供」 | 移到 §3.3 的真会话：两次请求之间 `setActiveTools(sid, ["read"])`，第二次请求声明的工具是 `["read"]`、不含 `noop` |

#### 3.3 新增不变量：「同一会话的两个请求取到同一个实例」（票面点名）

把改写后的练习做成**两步**：前半是 §3.2 的纯 Manager 形状断言；后半用**这只 Manager**
开一个真会话，跑两个请求，测 02 §5 #3 的可测不变量。

- **捕获**：给 `SentRequest`（`smoke-session.ts:307-318`）加一个 `instances: readonly Tool<any>[]`，
  在 `recordRequests:327-345` 的回调里从 `context.tools` 原样存下引用（不是 `declaredTools` 的
  名字数组）。其余断言只读已有字段，多一个字段不引起别的改动；执行票也可选等价的专用捕获器，
  但**必须量到真实的 `Context.tools` 元素**，不能拿 `manager.get()` 自己跟自己比来冒充请求级验证。
- **驱动**：`recordRequests(sent, [fakeAssistantMessage("first"), fakeAssistantMessage("second")])`，
  `openSession({}, {}, undefined, manager)`；两次 `prompt` + `settle` 之间调
  `setActiveTools(sid, ["read"])`（照 `exerciseActiveTools:1308-1316` 的先例）。
- **断言**（`read` 两次都在活跃集里，不受收窄影响）：
  1. `sent[0].instances.find(t => t.name === "read") === manager.get("read")`
     —— 03 §2.1：`Context.tools` 装的就是那一张 Map 里的实例引用；
  2. `sent[0].instances.find(...) === sent[1].instances.find(...)`
     —— **本票新不变量**：同一会话的两个请求取到同一个实例（且跨一次配置变更仍成立）；
  3. `sent[0].instances !== sent[1].instances`
     —— 数组仍每请求新建（§2.7），把「恒等」钉在元素上，防止后来又把断言写反；
  4. `sent[1].tools` 等于 `["read"]` 且不含 `noop` —— 接住 `:1282` 的原意；
  5. 02 §2.3 的另一半「任意两个会话的活跃集里同名工具恒 `===`」：同一只 `manager` 再开一个
     会话发一条消息，其 `read` 元素 `=== manager.get("read")`。两半都由 02 §5 #3 担保，
     一并写进这条练习，执行票可自行决定合并方式。

#### 3.4 `scripts/smoke-tools.ts`

- 脚本顶部加一只模块级 `const manager = createToolManager()`；`tool(name):86-90` 从
  `createTools({ workDirAbsPath: root }).find(...)` 改成 `manager.get(name)`，保留
  `if (!found) throw new Error(\`no tool named ${name}\`)`。这样 `:87` / `:130` / `:233` 三处
  用的是**同一张 Map**，而不是每次现建六个。
- `call():92-101` 与 `:130` 的直调补 02 §2.1 的第三位必填实参：
  `tool(name).execute("test", args, run, undefined, undefined)`，`run = { workDirAbsPath: root }`。
  `:238` 的 capped 用例按 02 §2.5 原样改写：
  `manager.get("bash")` 的 `execute("test", { command: "echo y", timeout_ms: 1_000_000 },
  { workDirAbsPath: root, bash: { defaultTimeoutMs: 60_000, maxTimeoutMs: 1_000 } }, undefined, undefined)`，
  保留 `:237` 的 `if (!cappedTool) throw` 守卫；「低上限会封顶并在结果里说明」这条断言的
  文本与判据不动，只把「构造期闭包」换成「调用期 run」。
- `:733` `toolDefinitions().names()` → `manager.names()`；`exerciseFillTools` 的七条断言一字不动
  （`known` 仍是那六个名字，因为这只脚本不注册任何工具）。
- 导入面：删 `createToolRegistry` / `createTools` / `toolDefinitions`，加新 Manager 的构造工厂。

#### 3.5 `scripts/smoke-approval-recovery.ts` —— (a) 保住的那条注入

- `:254-260` 的假 `readTool` 保留（类型 `Tool`，`execute` 不收 `run` 仍合法）。
- `:306` 「把假 tool 塞进 `Context.tools` 才找得到」按 03 §3 失效：三次调用（`:268` / `:287` / `:305`）
  的 Context 字面量都写 `tools: []`，改由练习自己造的 `manager.register(readTool)` 供出工具。
  这是 (a) 与 (b) 最具体的差别：这个 smoke **没有 Agent、没有 hub**，只有一只它自己造的 Manager。
- `recoverPendingToolCalls`（导出，六个位置实参）按 03 §2.3 要多拿 Manager 与 `run`，
  按 04 §2.4 还要拿本轮 `activeNames`。本票定**边界**：宿主传**一个**执行依赖对象，
  内容至少 `{ manager, run, activeNames }`，由 `Agent.run:1011` 从这一轮的栈上局部显式攒出；
  三个 smoke 调用点各传一份字面量（`run: { workDirAbsPath: root }`、`activeNames: ["read"]`）。
  不把 Manager 塞进 `Context`、不设模块级全局、不把签名摊成八个位置参数（03 §2.3 / 02 决定 4 /
  04 §2.4 的同一条分界）。对象叫什么、放第几位、内部怎么穿过执行链，属执行票的形状细节。

#### 3.6 只跟型、不改断言的读点

`smoke-session.ts:244-262` 的 `openSession` 第 4 参类型 `ToolRegistry` → 新 Manager 类型；
`smoke-models.ts:154` / `:274` 的 `tools: []` wire 捕获、`fake-transport.ts:175-179` 的
`serializeContext`、`smoke-session.ts:348-351` 的 `declaredTools` 都不动——§3.3 只给
`SentRequest` 加字段、改 `recordRequests` 的回调，不改这个函数（03 §2.5）。04 §4 列的六条读 `allTools` / `activeTools` 的脚本
（`smoke-modes` / `smoke-mux-client` / `smoke-replay` / `smoke-session` / `smoke-sessions` /
`smoke-tools`）断言不动：`names()` 语义仍是「Map 全部名字」，冷/热快照恒等关系不变。
`smoke-session.ts:1342-1343` 「禁用工具仍回 not found」在 04 §2.4 的 `activeNames.has()` 判活下
继续成立，不因 Manager 装全部六个而失效。

### 4. 改动面清单（交给执行票；本票不动）

| 子系统 | 落点 |
|---|---|
| Manager / 类型 | `tools/registry.ts:19-30, 42-74` → 一张 Map + `ensureFilled` + 四法 `names` / `get` / `execute` / `register`（类名/文件名归 06）；`tools/manager.ts:26-31, 41, 49-54, 57-84, 164-181` 删 `ToolDefinition(s)` / `toolDefinitions` / `toolListFor`、`ToolRunContext` 按 02 §2.1 转发、六个零参工厂收成私有常量；`tools/index.ts:18, 46-48` 与 `core/index.ts:207-220` 按 §2.5 增删出口 |
| 引擎 `agent.ts` | `:66/:133/:211` 类型；`:528/:999/:1288` 从 `names()` / `get()` 读（04 §2.2 / §3）；`:1011/:2005` 恢复机器多收一个执行依赖对象（§3.5）；`:2091/:2272` 的 `find` 改 `get`（03 §3，先 `activeNames` 判活，04 §2.4）；`:2402` 改 `manager.execute(...)`；`:1298-1306` `runContext` 不动；`:1805-1810` / `:2352-2391` 不再作执行来源（03 §3） |
| 装配 | `session-factory.ts:23/72/94/142/163/177-178/182/263/285/344-351`、`session/fanout.ts:27/41/85-89`、`session/tool-config.ts` 四函数的 `known`（04 §2.5）；核对项：`:142` 与 `:285` 收敛到同一只（04 §5 #9），hub `:251/:792/:335` 的冷读路径也读它（§2.5） |
| smoke | `smoke-session.ts:8-34`（导入）、`:244-262`（形参）、`:307-351`（`SentRequest` 增 `instances`）、`:1015-1033`、`:1252-1283`、`:1954`；`smoke-tools.ts:7-52`（导入）、`:86-101`、`:130`、`:231-244`、`:733`；`smoke-approval-recovery.ts:254-260, 268-311`；其余按 §3.6 只跟型 |
| 文档 / ADR（归 06） | 会被本票推翻的现文：`AGENTS.md` tool 词条「五个方法 / `active(state, run)` 现建 / 没有插件注册表」，`docs/architecture.md:119`「注册表因此只有 `names` / `build` / `activeNames` / `active` / `register` 五个方法」与「`toolDefinitions()` 是六个内置的定义」，`map.md` *Destination* 的「旧名词全仓清零」判据。按 `docs/adr/README.md:43-44` 只增不改原文；逐句改写与取代指针全归 06 |

### 5. 决定记录（下游可直接依赖）

| # | 决定 | 约束谁 |
|---|---|---|
| 1 | 选 (a)：`register()` 保留为 `map.set`，测试工具与六个内置同表，随时可加、只加新名字、同名（含内置）抛 `Tool already registered: <name>`；Map 对象与已有条目永不可替换 | 执行票、06 |
| 2 | Map 首次访问一次填满六个零参工厂的产物；触发者是 `names` / `get` / `execute` / `register` 四个公开方法；`register()` 先 `ensureFilled()` 再判重再 `set`；`names()` = 键集，内置在前、注册项按调用顺序在后 | 执行票 |
| 3 | 旧五法：`names()`、`register()` 留且签名不动；`build(name, run)` 删并由 `get(name)` 取代（`run` 整个删）；`activeNames(state)` / `active(state, run)` 删；**不留别名、不加批量便利门** | 执行票、06 |
| 4 | 新增执行入口 `execute(name, toolCallId, params, run, signal?, onUpdate?)`：`run` 必填无默认，内部 `get(name)` 后转发，是生产代码唯一 `Tool.execute` 调用点；落空抛 `Tool <name> not found` 由现成 `try/catch` 兜底，不是第二道判活 | 执行票 |
| 5 | Manager 公开面只有 `names` / `get` / `execute` / `register`，只收名字与一次调用的参数；不收 `ToolState` / 服务 / id（04 §5 #1 原样） | 执行票、06 |
| 6 | 出口面删 `createToolRegistry` / `type ToolRegistry` / `createTools` / `toolDefinitions` / `createToolDefinitions` / `type ToolDefinition(s)` / `toolListFor`；留 `describeToolCall` / `fillTools` / `narrowToKnown` / `type ToolState` / `type ToolRunContext`；加零参的新 Manager 工厂与类型（名字归 06） | 执行票、06 |
| 7 | `scripts/mount-session.ts` 今天不导入工具符号（票面事实更正）；(a) 的形体后果是冷读（`readSessionSnapshot` / hub `snapshotOf`）必须也读同一只 Manager，否则 04 §3 的冷/热 `allTools` 一致性在注册项上破——这是 04 §3 / §5 #9 的推论与核对项，不是新装配约束 | 执行票、06 |
| 8 | 恒等不变量是**实例级**：`Context.tools` 数组仍每请求新建，元素恒 `=== manager.get(name)`；02 §2.3 的三条读法（同进程两次 `get`、同一会话跨请求、跨会话同名元素）都要在 smoke 里测到 | 执行票 |
| 9 | smoke 改写：`exerciseOutputBackstop` 保留注册、只换构造；registry 断言区改名并逐行按 §3.2 重写（`:1264` 翻成「恒为同一实例」、`:1281` 改成 `get("noop") === noop` + 判重）；补 §3.3 的请求级身份断言（含「数组仍新建」「跨会话同一实例」） | 执行票 |
| 10 | `smoke-tools.ts` 三处直调 `execute` 补 `run`（02 §2.1）、bash 上限按 02 §2.5 从构造期改调用期、`:733` 改读 `manager.names()`；`smoke-approval-recovery.ts` 的假 tool 改 `manager.register()`，`Context.tools` 写 `[]`，恢复机器由宿主显式传**一个**执行依赖对象 | 执行票 |
| 11 | 否 (b)：删不掉懒填充这次写，却要把测试工具摊进五处生产装配，并让没有宿主的恢复机器 smoke 仍得自己造 Manager；否 (c)：与 02 §2.3「`register()` 是首次访问触发者」自相矛盾，把测试能力系于「此前有没有人读过 `names()`」，多一个 `filled` 标志却不增加不变量 | 06、执行票 |
| 12 | 代价记账：`register()` 让键集在构造后可单调增长，故「表不可变」=「已有条目 + Map 对象不可变」；生产零调用，源码注释写清边界（英文），文档与 ADR 的措辞归 06 | 06 |

### 6. 本票没有回答的（别当成已定）

`ToolManager` 的类名 / 文件 / 符号名、`ToolRegistry` 的历史含义冲突、是否新开 ADR、取代指针、
`AGENTS.md` / `architecture.md` / `README` / `notes.md` 的逐句改写与文档归属（06）；
`createToolManager()` 的**具体名字**、六个零参常量放哪个文件、`params` 的精确类型与 `as never`
的落法、`Context.tools` 生产端 `.map(get)` 的窄化写法（`filter` 还是私有 helper）、
执行依赖对象的名字与参数位置、恢复机器内部怎么把 Manager + `run` + `activeNames` 传过执行链、
`SentRequest.instances` 之外的等价捕获器、§3.2 里被删断言在脚本中的最终排布（执行票）；
执行票怎么切、何时 graduate（本图 *Not yet specified*：02–05 已定案，**06 仍待定**，毕业时按
02 / 03 / 04 / 05 票的清单核，不重开裁决）。§2 / §4 写的是 (a) 与既有定案**必然带来**的形状后果与
要跟的读点，不是替 06 或执行票做选择。

### 7. 验收（2026-11-06 与 01 号票基线对跑）

本票未改任何 `packages/` 源码或 `scripts/smoke-*.ts`；按图「每票收账跑 `npm run check`」是本票的
验收项，下面这遍全套 28 条对跑是实现流程要求的收尾复跑、不是本票新增的验收门槛。本票是 grilling
决策票、零代码改动，TDD 无适用接缝。

- `npm run check`：**绿**，`tokens ok: 137 defined, 111 referenced`；`check.log` 与基线逐字节相同。
- 28 条 smoke（`run-all.sh` 无服务器口径）：**26 绿 / 2 既有红**，红集合仍是
  `{ smoke-api（缺服务器）, smoke-liveness（本机时序） }`，没有第三条稳定红；`smoke-approval`
  本轮 23 s 正常收尾、绿，无 01 号票首轮那种偶发红。`smoke-api.log` 与基线逐字相同
  （`the mux connection failed`）；`smoke-liveness` 本轮 **1 个 FAIL**——预算内断言 **2291 ms**
  （预算 1650 ms），基线那份是 4 个 FAIL 且组合不同，与 01 号票「同一条脚本在不同轮次 FAIL
  组合并不一致」的口径一致，仍是同一条既有红。**零新红成立。**
- 逐份 diff 28 条日志：只有 3 份与基线不等——`smoke-boot`（随机端口 / 临时 home / UUID）、
  `smoke-approval`（基线那份本身是 01 号票首轮偶发红的日志，本轮绿）、`smoke-liveness`
  （毫秒数与 FAIL 组合），全在 01 号票 §5 登记的随机量 / 归因清单里；
  **`smoke-tools.log` 223 行逐字节相同**。基线独有的 `smoke-api-with-server.log` 不参与这 28 份对跑。
- 全部输出落在 `../smoke-runs/after-05/`（`check.log`、`summary.txt`、28 份 `<name>.log`；
  日志与临时 home 不入提交）。本票没有跑 `smoke-api` 的「起服务器后 ok」那一遍——本轮无源码改动，
  那条结论按 01 号票 §4 原样沿用。
- `Status` 翻 `resolved`；`map.md` 的 Decisions so far 追加 05 指针，Not yet specified 把毕业清单
  更新为「02 / 03 / 04 / 05 已定案、06 仍待定」并关掉「方法面 / `register()` / smoke 断言」这块雾。
