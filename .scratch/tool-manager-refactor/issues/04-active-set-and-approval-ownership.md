# 04 - 活跃集与审批的归属：Map 装全部还是只装活跃

Type: grilling
Status: resolved

## Question

定案 1 说「虽然不同 session 用不同工具，但都是通过 ToolManager」。今天「这一轮能调哪些、
哪些要问」是从账本派生的纯数据 `ToolState`（`session/tool-config.ts` 的 `toolStateOf` /
`followsGlobalOf` / `globalDefaultToolState` / `defaultToolNames`），目录只答「存在什么」；
`fanout.ts:27` 的 `SessionServices.tools` 也带着同一只目录。AGENTS.md 的 tool set 词条写明
「它是状态，绝不是对话」，写在会话 `.json` 快照的 `activeTools` / `approval` 字段里。

请裁决：

- **(a)** Manager 只管「存在什么 + 按名字取实例」，Map 恒装全部实例；活跃集与审批仍由账本派生、
  Agent 决定本轮名单；`SessionServices.tools` 换成 `ToolManager` 但不给它会话状态。
- **(b)** Manager 接管活跃集：`active(state, run)` 移进 Manager，`toolStateOf` / `followsGlobalOf` /
  `defaultToolNames` 一起收编，Agent 只问 Manager 要本轮声明与执行集。
- **(c)** Map 只装**当前活跃**工具（懒加载按 session 的活跃名单建），「不同 session 用不同工具」
  直接体现在 Map 内容上；需回答多会话并发与会话切换时怎么换出。

并定两处读点改从哪只门读：`agent.ts:528` `setActiveTools` 的未知名校验（`new Set(this.tools.names())`）、
`fanout.ts:85` `snapshotOf` 的 `allTools: services.tools.names()`。

➡️ 推荐 **(a)**。定案 1 的「持有**所有**的 Tool」按字面即全部六个；把选择留在账本派生，
Map 就不会成为活跃集的第二个写者（这条判据不因 ADR-0011 被反转而失效）。
(c) 让一张 Map 承载 per-session 状态，正是 02 号票并发问题的放大器。

## Answer

**2026-11-06 定案**（`Type: grilling`，按票面 `➡️` 原样敲定、未推翻；本票代码一行未动）。

### 结论（一句话）

**选 (a)**：`ToolManager` 只答「存在什么 + 按名字取实例」（外加 03 号票定案的执行转发），Map 恒装
**全部**实例、首次访问建满六个且不可变；活跃集与审批仍是**账本派生的纯数据**，由
`session/tool-config.ts` 的四函数一次读出，`Agent` 把「本轮名单」收成这一轮的栈上局部；
`SessionServices.tools` 换类型为 `ToolManager`，仍是 `Agent` 构造注入的那一只进程级服务，
**不带任何会话状态**。两处读点都从 Manager 的「全部名单」门读：`agent.ts:528` →
`new Set(this.tools.names())`、`fanout.ts:85` → `services.tools.names()`；冷读
`session-factory.ts:177` 是同门的第三个读者。`.json` / `.jsonl` 与 `tool_config` entry 格式一字不动。

按 `docs/agents/issue-tracker.md` 与本图「执行票仍一票一会话 / 等 02–06 定案后一次 graduate」，
本票只出决定；代码落地、smoke 改写、文档与 ADR 收账归之后 graduate 的 `task` 票。
**05 / 06 的问题一律不代答**；凡 §2 / §4 与它们重叠处，以 §6 的「未回答」清单为准。

### 0. 先把票面的行号钉到今天的树（`5d92c5e`）

票面点名的都成立：

- `session/tool-config.ts` 收 `registry: ToolRegistry` 的正好**四个**函数：`defaultToolNames`
  （`:18-22`）、`globalDefaultToolState`（`:32-42`）、`toolStateOf`（`:62-76`）、`followsGlobalOf`
  （`:121-133`）。另有 `approvalToolsOf`（`:7-9`，纯映射 helper）与私有 `toolConfigFollowsGlobal`
  （`:89-110`），都不收目录。四个函数对 registry 的使用只有两种：`:20` / `:21` / `:40` / `:71`
  直接调 `.names()`，`:39` / `:70` / `:129` 把它当「已知名单」继续传给另两个派生函数（终点仍是
  `.names()`）；没有第三种——「目录只答『存在什么』」按字面成立，`known` 也只用来
  `narrowToKnown` 收窄会话记录的名字。
- `ToolState`（`tools/manager.ts:96-99`）是 `{ activeToolNames, approvalOverride? }` 纯数据；
  `narrowToKnown`（`:120-122`）、`fillTools`（`:139-150`）、`toolListFor`（`:164-181`）都是无状态函数。
- `fanout.ts:24-28` 的 `SessionServices` 三服务，`:27` 是 `tools: ToolRegistry`；`approvalsOf`
  （`:38-43`）合并目录审批与 `toolStateOf(...).approvalOverride`；`snapshotOf`（`:71-97`）的
  `:85` `allTools: services.tools.names()`、`:86` `activeTools: toolStateOf(...).activeToolNames`、
  `:89` `followsGlobalOf(...)`。**一次派生、三处消费**都在这份文件里。
- `agent.ts:211` `private readonly tools: ToolRegistry`、`:229` 构造注入；`:245-247` 的
  `private get services()` 每次现攒 `{ sessionManager, settings, tools: this.tools }`，没有持有袋。
  `:528` 是 `setActiveTools`（`:525-538`）里的 `new Set(this.tools.names())`，写入走 `:535`
  `sessionManager.setToolConfig(state.session, [...names], approvalsOf(...))`；`:610` / `:684`
  同样用 `toolStateOf(...)` 把另一半带进同一次 `setToolConfig`。`:753` `authorize` 读
  `approvalsOf(this.services, ...)`。
- `:999` / `:1288` 是 `Context.tools` 的两个生产端：`tools.active(toolStateOf(...), this.runContext(state))`；
  `:1252` 的 `toolState` 还喂 `:1261` 的提示词与 `:1262` 的审批映射。`setToolConfig`
  （`session-manager.ts:1537-1551`）把 `activeTools` 与 `approval` 两个字段**整份一起**写进 `.json`
  快照，`:1873-1875` 一起读回；ADR-0005 决定 3 写明模式选择落在既有 `tool_config` entry，
  「这是**一个决定**」的原句在 `AGENTS.md:95` 的 tool set 词条与 `docs/architecture.md:127`。

票面没点名、但 04 必须一并交代的四处：

1. **冷读是第三个 `names()` 读者，且冷热两路的 `activeTools` 今天有两种拼法**。
   `session-factory.ts:177` `allTools: registry.names()`、`:178` `activeTools: registry.activeNames(tools)`
   （`tools` 是 `:163` 的 `toolStateOf(...)`）、`:182` `followsGlobalOf(..., registry)`。
   `registry.activeNames`（`tools/registry.ts:61-64`）只是再 `filter(known)` 一次，而 `toolStateOf:71`
   已经收窄过，所以 `:178` 与 `fanout.ts:86` 的值相等但写法不同。04 定 (a) 后两条路径都直接吃
   `toolStateOf(...).activeToolNames`，这层重复收窄不再需要（方法去留归 05）。
2. **`Context.tools` 今天同时是「判活闸门」**。`prepareToolCall:2270-2279` 的
   `tools.find(t => t.name === toolCall.name)`，在 `:2273` 的 `if (!tool)` 回 `Tool <name> not found`，
   `docs/architecture.md:125` 说的正是「对**未激活**工具的调用会返回 `Tool <name> not found`」；
   `executeToolCalls:2091` 的 `find(...)?.executionMode` 也只在活跃子集里判顺序/并行。03 定案 (a)
   把两处查找改成 `manager.get(name)`，而 Map 装全部六个（02 §2.3）——若 04 不把活跃名单留在
   引擎手里，一个「已知但被会话禁用」的工具就会**被找到并执行**，顺序/并行判定也会被它带偏。
   这是「活跃集归属」真正要裁的那块，见 §2.4。
3. **`allTools` 是「全部」，不是「当前」**。`protocol.ts:255-258` 写的是「Every tool the session
   registered ... for the header's tool toggles」；窗口把它当全量基准：
   `web/main.ts:507-508` 的 `allTools` 基准与 `:1133` 的 `settings.tools ?? snapshot.allTools`、
   `render/settings.ts:715` / `:931` / `:965` 的同形过滤。`defaultToolNames:20` 也用
   `registry.names()` 当「设置没写 tools 时的全量」。于是 (c) 不只是内部结构变化，见 §1(c)。
4. **装配点今天会造出两只目录**。`session-factory.ts:142`（`assemble`）与 `:285`
   （`createSessionAgent`）各自 `options.tools ?? createToolRegistry(toolDefinitions())`；
   `:221` 的 `assembleSession` 只从 `assemble` 解构 `workDirAbsPath / settings / modelChoice /
   sessionManager`，**不转发 registry**，`:344-351` 的 `openAgent` 也只在 `options.tools` 给了才
   传给 `createSessionAgent`。今天两只目录都无状态、行为等价（`:282-284` 的注释强调编排层
   内部两半必须是同一只，跨 `assemble` 的等价则纯靠无状态）；换成 02 的常驻实例 Map 后，
   恒等不变量要求它们收敛到同一只。执行票的清单要收这一条（§4），
   (b)/(c) 则把它放大成两份可能不一致的会话状态。

### 1. 三条路逐条裁决（含各自要动什么）

#### (a) Manager 只答存在与取实例，选择留账本 —— **选**

要动什么：`ToolManager` 的公开面收**名字**（`names()` / `get(name)` / 03 的执行入口），不收
`ToolState` / `Session` / `AgentState` / `SessionManager` / `SettingManager` / `Hooks`；
`SessionServices.tools`、`Agent.tools`、`Assembled.registry`、`SessionAgentServices.tools`、
`OpenAgentOptions.tools` 五个位置的类型换成 `ToolManager`（名字归 06）；`tool-config.ts` 四函数
的目录侧入参从 `ToolRegistry` 收成 `readonly string[] known`（§2.5）；`:999` / `:1288` 改成按
`toolState.activeToolNames` 从 Map 取实例（03 §2.1）；活跃名单进执行链当判活闸门（§2.4）。
`toolStateOf` / `followsGlobalOf` / `globalDefaultToolState` / `defaultToolNames` /
`approvalsOf` / `setToolConfig` **一个都不搬家**，账本格式与 `tool_config` entry 不动。

三条决定性理由：

1. **判据「Map 不是活跃集的第二个写者」在本次反转之后仍然成立**。定案 1 反转的是「不驻留
   实例」这一条（进程级常驻的是**行为**，06 只负责给这笔反转收账），不是「会话选择只有一个
   写者」。`setToolConfig` 仍是 `activeTools` / `approval` 两字段的唯一写者，`toolStateOf` 仍是
   唯一派生，Map 在 02 §2.3 下首次访问建满即不可变——它连写的能力都没有。ADR-0011
   《被放弃的选项》「注入一张表……一个便利参数就是第二个写者」
   （`docs/adr/0011-agent-holds-session-state.md:170-171`）针对的是「表」的归属，本票把选择
   钉在数据与账本一侧，不因那张表的重新引入而作废。
2. **「一个决定两字段」不被拆开**。`toolStateOf` 一次返回 `activeToolNames` 与
   `approvalOverride`；`applyConfig`（`:610-611`）、`respondApproval`（`:684-685`）、
   `setActiveTools`（`:535`）写它们时都整份带上另一半；`followsGlobalOf` 逐半判「沿用全局」；
   提示词用 `approvalToolsOf(approvals)` 声明**包括未激活工具**在内的受闸名单
   （`session-factory.ts:302-305`）。(b) 只把活跃集搬进 Manager、把审批留在 fanout，就把一次
   派生劈成两个属主，冷/热两条快照路径更容易给出不同的「沿用全局」标签。
3. **依赖方向不被反转**。今天是 `session/tool-config.ts` → `tools/manager.ts` 的单向依赖；
   (a) 让会话域只收一份名字数据，工具域零会话依赖。把派生搬进 Manager 会反过来要求工具域
   认识 `Session` / `SessionManager` / `SettingManager`（或让公开方法收另外两只服务加一整份
   会话状态），与 ADR-0007 决定 1「公开方法收 `(id, 请求自己的参数)`」和决定 6「进程级不可变
   配置留构造注入」相冲。

「不同 session 用不同工具，但都是通过 ToolManager」在 (a) 下的兑现方式要说清：**选择是名字
列表，不是对象集合**；每个会话的 `Context.tools` 是同一张 Map 的**不同子集**（03 决定 1），
每次执行都经 `manager.get(name)` 与 Manager 的执行入口（03 决定 4）。定案 1 要的是「共用一只
服务」，不是「Map 内容随会话变」。

#### (b) Manager 接管活跃集 —— **否决**

要动什么：`active(state, run)` 与 `toolStateOf` / `followsGlobalOf` / `defaultToolNames` /
`globalDefaultToolState` 一起收编进 Manager；`fanout.approvalsOf` / `snapshotOf` /
`followsGlobalOf` 的调用点改问 Manager；`session-factory.ts:163-182` 的冷读与 `:285` 的编排层
必须拿到同一只 Manager；`Agent` 的 `:999` / `:1288` 改成「把 state 交给 Manager、一次拿回本轮
声明与执行集」的调用（形状与名字归执行票，这里只描述 (b) 的调用面）。
逐条代价：

1. **Manager 要么持有会话状态，要么收一整袋参数**。答「本会话这一轮启用哪些」必须读
   `.json` 快照的 `activeTools` / `approval` 与目录的 `settings.json`。若 Manager 自己持
   `SessionManager` / `SettingManager` 并按 id 缓存，就是 02 §1(b)/(d) 否掉的「进程级服务持
   per-session 状态」，还多出一个失效归属；若每次把 `(sessions, state, settings)` 传进方法，
   「收编」就只是把一个无状态函数挂到服务类上，零收益，且公开面从「收名字」变成「收另外两只
   服务 + 一整份会话状态」——聚合袋从参数回来了（ADR-0007 决定 1、ADR-0011 被放弃的选项）。
   两条都让 `tools/` 反过来依赖 `session/`。
2. **「一个决定」被劈成两处读取**，见 §1(a) 理由 2。更具体：`approvalsOf`
   （`fanout.ts:38-43`）要的是 `toolStateOf(...).approvalOverride`，派生进了 Manager 之后，
   无状态 fanout 函数就得抱着 `SessionServices` 去调 Manager 上的派生方法，实参是
   `services.sessionManager` / `session` / `services.settings`——一个服务拿另外两只服务当实参，
   跨会话并发时还要保证它们与 Manager 内部可能有的缓存同步。
3. **冷读与热读会出现第二只 Manager**。`readSessionSnapshot` 走 `assemble`（`:142`），
   编排层走 `createSessionAgent`（`:285`），今天两只目录等价是因为它们无状态（§0 第 4 点）。
   一旦 Manager 参与「这一会话选了什么」，两只实例就有了各自可漂移的答案，而
   `fanout.ts:88` 的注释明写冷/热必须一致。要救它就得把 Manager 变成进程单例并改装配，
   那是 06 要收账的另一笔反转，收益仍为零。
4. **与 02/03 已定形状摩擦**。02 决定 3「实例不持 per-call 状态」、决定 4「不按 id 键控」
   约束的是实例表，(b) 虽可辩称只加无状态方法，但「Agent 只问 Manager 要本轮声明与执行集」
   实际要把 `ToolState` 与 `run` 一起塞进 Manager 的公开面；03 决定 5 要求 Manager 与 `run`
   由 `Agent.run` 显式传过执行链，(b) 让 Manager 反过来先知道 state 再吐执行集，方向相反。
5. **账本格式被重新打开**。map.md *Not yet specified* 里那块雾正是「若 04 把活跃集也搬进 Map，
   `toolStateOf` 的派生链与 `tool_config` entry 一起受影响」。(b) 即使不真搬字段，也把「选择」
   从会话域的函数变成服务的能力，未来很容易顺势加缓存或写回；(a) 直接把这块雾关掉。

(b) 唯一的好处——调用点少一层——用 (a) 里一个「按名字批量取实例」的门同样拿得到，且那个门
只收 `readonly string[]`。

#### (c) Map 只装当前活跃工具 —— **否决**（并回答票面点名的两问）

要动什么：Map 的填充从「首次访问建满六个」改成「按某会话的 `activeToolNames` 现建/换出」；
`get(name)` / `names()` 从此答的是「这一刻装了谁」；执行入口、`Context.tools` 的生产端与恢复机器
都要按这个会变的 Map 重新定义「未知名」；`setActiveTools` 的校验、`snapshotOf.allTools`、
`defaultToolNames` 的全量兜底另找一份不变的名单（或接受语义变化）；`session-factory` 的装配与
换出时机要新增一条会话生命周期管理。票面点名要回答的两问，逐条作答：

1. **并发：无解，除非退回 02 已否的形状**。设会话 A（活跃 `{read}`）与 B（活跃 `{bash}`）
   同时在飞。03 定案 (a) 让 `prepareToolCall` 与执行入口各 `manager.get(name)` 一次；只要
   B 的请求边界换过 Map，A 的两次 `get` 就可能分别命中 B 的集合与空集：`get("read")` 返回
   undefined 时 `Tool read not found` 被写进 A 的**账本**（durable，不是界面抖动）；
   命中别人的实例时读写落到别人的目录（02 §1(b) 竞态 1）。`executionMode: "parallel"`
   的同批次重叠让覆盖窗口甚至不需要跨会话；claim 是按会话的
   （`AGENTS.md` claim 词条），不提供跨会话串行。要修只能：按 session id 键控（02 (d)，
   违背「一张 Map」）、每请求重建（02 (b)，两个竞态原地复活）、或给全进程加锁（把所有会话的
   工具调用串行化）。
2. **会话切换 / 换出：同样无解**。谁换出、何时换出、换出后在飞的 `Context.tools` 里那些
   **实例引用**怎么办？03 决定 1 让它们活到整个请求结束，换出就把旧引用与新查找劈成两半
   （02 §1(b) 竞态 2）；审批是「结束重启」（ADR-0006 决定 5，即 AGENTS.md 惯写的「§5」），
   grant 在**新一轮**按名字现取工具
   重跑悬空调用，此刻 Map 可能已换成另一会话的活跃集，于是错的结果被定稿。给条目加引用计数
   或按 id 存多份，就是按 id 键控的表（02 决定 4 明确不许）。
3. **更硬的一条：`names()` 答不了「存在什么」了**。:528 的未知名校验、:85 / `:177` 的
   `allTools`、`defaultToolNames:20` 的全量兜底，四个读点都要**全部**名字。Map 只装活跃集时，
   `allTools` 塌成当前选择，窗口的 `settings.tools ?? snapshot.allTools`（§0 第 3 点）把
   「默认全量」变成「本会话当前选了哪些」；`PUT /api/sessions/{id}/tools` 想把刚禁用的工具
   打开会撞 409 `Unknown tool`（`controllers/sessions.ts:719-733`），且全局默认从此无法自举。
   要补就得再留一份静态全名表——两张事实源，正是 02 §2.3「首次访问建满六个」的理由。
4. **恒等不变量作废、一个决定被劈开**：02 §2.3 的可测不变量「任意两次 `get(name)` 恒 `===`、
   任意两个会话的活跃集里同名工具恒 `===`」（由 **02 票** §5 #3 的不可变表担保）在 (c) 下按构造为假
   （未活跃时 `get` 恒 undefined）；审批映射还能闸住**未激活**工具
   （`session-factory.ts:302-305`），一个只装活跃工具的 Map 表达不了这半张图。
5. 定案 1「持有**所有**的 Tool」按字面被推翻，且 06 要收的账从「重新引入常驻实例表」升级成
   「常驻实例表还承载 per-session 选择」，正是票面「02 号票并发问题的放大器」。

### 2. (a) 的精确形状

#### 2.1 边界一句话：Manager 收名字，不收状态

`ToolManager` 的公开面只接受**名字**与一次调用的参数：`names(): string[]`（全部实例的名字）、
`get(name): Tool | undefined`、03 新增的执行入口（名字 + `toolCallId` / `params` / `run` /
`signal` / `onUpdate`）。**不出现** `ToolState` / `Session` / `AgentState` / `SessionManager` /
`SettingManager` / `Hooks` / `sessionId` 任何一个形参或字段；不按 id 键控、不设「当前会话」
字段、不缓存活跃集。若 05 保留一个「按名字批量取实例」的便利方法，它的形参只能是
`readonly string[]`——**收名单 = (a)，收状态 = (b)**，这条就是分界线。Map 仍按 02 §2.3：
首次访问一次建满六个、内置条目与 Map 对象不可替换、实例无 per-call 状态。

#### 2.2 活跃集：一次派生、本轮名单是栈上局部

`toolStateOf(sessions, state, settings, known)` 仍返回 `{ activeToolNames, approvalOverride }`
纯数据，仍在 `session/tool-config.ts`，仍每次读取现算（`known` 是 §2.5 的名单数据）。
`prepareRequest:1252` 与 `Agent.run:999` 各自把 `toolState.activeToolNames` 收成**这一请求的局部**
`activeNames`；`:999` / `:1288` 的 `Context.tools` 改为 `activeNames` 逐个 `manager.get(name)`
（03 决定 1：元素是那一张 Map 里的实例引用；02 决定 4：`run` 不进 `Context`）。
提示词（`:1261`）、快照（`:86` / `session-factory.ts:178`）、「沿用全局」判定（`:89` / `:182`）
与执行链的判活（§2.4）吃的都是同一份派生，没有第二个「本会话选了什么」的答案。
因为 `toolStateOf:71` 已按 `known` 收窄，`activeNames ⊆ manager.names()`，于是
`get(name)` 对名单内每个名字恒命中——03 §2.4 的「两次 `get` 拿到同一实例」与 02 的恒等
不变量自然成立。

#### 2.3 审批：不动，仍与活跃集同属一个决定

`approvalsOf(services, session)`（`fanout.ts:38-43`）留在 fanout：目录审批 +
`toolStateOf(...).approvalOverride`；`authorize`（`:753`）、`snapshotOf:84`、提示词（`:1262`）、
三条写路径（`:535` / `:611` / `:685`）一个不动。Manager 没有审批字段、没有审批方法、没有
审批状态。`setToolConfig` 继续把 `activeTools` 与 `approval` 整份一起写进 `.json`，
`tool_config` entry 的语义与格式一字不动；ADR-0005 决定 3、AGENTS.md 的 tool set / mode
词条都继续成立。**本图 map.md「会话账本格式是否要动」这块雾就此关掉：不动。**

#### 2.4 本轮名单必须进执行链（03 与 04 的交汇，票面未点名但必须定）

03 把 `prepareToolCall:2272` 与 `executeToolCalls:2091` 的 `find` 改成 `manager.get(name)`，
而 Map 装全部六个；于是「**未激活**工具的调用回 `Tool <name> not found`」
（`docs/architecture.md:125`）这条既有行为不能靠 `get` 自己维持。定：

- `activeNames`（§2.2；数组或现攒的 `Set<string>` 由执行票选，下文用 `.has()` 只表示判活）
  作为本轮局部，与 Manager、`run` 一样由 `Agent.run` 显式传过
  `:1011` 恢复机器 → `:1101` → `:2082` / `:2099` / `:2161` → `:2264` → `:2393` 这条链
  （03 §2.3 / 决定 5 的传参先例），在 `:1063-1070` 每次 `prepareRequest` 返回后随
  `currentContext` 一起换成这一轮那份（`requestUpdate` 缺省时沿用上一轮）；
  不进 `Context`、不进 `AgentState.live`、不设模块级全局。
- `prepareToolCall` 在闸门前用 `activeNames.has(name)` 判活，落空仍回今天那句
  `Tool <name> not found`（`:2273-2279`）；命中才 `manager.get(name)` 做校验与 shim。
  `executeToolCalls:2091` 的 `executionMode` 判定同样先判活，否则一个已被禁用的 `bash`
  会把整批翻成 sequential。执行入口不重复判活（03 §2.4），异常→错误结果、审批恢复语义不变。
- 判活归**引擎**（03 §2.4「校验 / 闸门 / 事件 / 定稿仍归引擎」），不归 Manager：Manager 只答
  「这个名字存在吗、给我实例」，答不了「这个会话这一轮准不准」。(c) 之所以看着简单，正是
  想让 `get` 顺带当闸门；代价 §1(c) 已逐条否掉。
- **与 03 的衔接要说死**：03 §5 #6 的「未知名仍回 `Tool <name> not found`」在它写下时
  「找得到」=「在活跃子集里」；Map 装全部六个之后，这句话只能读作「**不在本轮名单**」，
  否则一个已禁用工具会被 `get` 找到并执行。本票补的是 (a)「Agent 决定本轮名单」这一半在
  执行链上的落点，**不改 03 的任何决定**；03 与 04 须并读才得到完整形状。

#### 2.5 四个派生函数的入参：只收名单数据

**本票定的边界**：四个派生函数与 Manager 之间只传一份「已知名单」的**数据**，不再收
`ToolRegistry` / `ToolManager` 对象、更不收会话状态。落地的最小形状是把目录侧入参收成
`readonly string[] known`，调用点现传 `manager.names()`（`agent.ts:527/610/684/1252`、
`fanout.ts:41/86/89`、`session-factory.ts:163/182`）；**具体形参形状属执行票**，但不许把
Manager 对象请回派生链。理由：它们本来就只调 `.names()`（§0），收一整个服务对象既
把进程服务带进会话域的纯数据派生，又让 06 多一处类型要收账；收一份名字数组后这四个函数
是「账本 + 设置 + 一份名单」的纯函数，零服务依赖，与 ADR-0006 B 路线「现建现传」同调。
`names()` 每次都是 Map 键的现读，多读几次没有缓存要失效。`approvalToolsOf` /
`toolConfigFollowsGlobal` / `narrowToKnown` / `fillTools` 的形状与归属不动（文件与符号名归 06）。

#### 2.6 `SessionServices.tools` 换类型，不换职责

`fanout.ts:24-28` 的 `SessionServices.tools: ToolManager`，由 `agent.ts:245-247` 那个现攒的
getter 从 `this.tools`（`:211`，构造注入、进程级一只）填入；不新增字段、不传会话状态、不给
Manager 加 setter。fanout 的全部函数仍是无状态 `(state, SessionServices)` 文件级函数。
`Assembled.registry`（`session-factory.ts:94`）、`SessionAgentServices.tools`（`:263`）、
`OpenAgentOptions.tools`（`:72`）、`AgentConfig.tools`（`agent.ts:133`）一并换成同一类型，
装配点收敛到 §4 那一条。

### 3. 两处读点改从哪只门读（票面点名，逐条作答）

| 读点 | 今天 | (a) 之后 | 语义 |
|---|---|---|---|
| `agent.ts:528` `setActiveTools` 未知名校验 | `new Set(this.tools.names())` | `new Set(this.tools.names())`，`this.tools: ToolManager` | **全部实例的名字**（Map 键集，含 05 若保留 `register()` 加入的名字）；不是 `activeNames`，否则禁用过的工具永远无法重新启用，`PUT /tools` 会回 409 |
| `fanout.ts:85` `snapshotOf.allTools` | `services.tools.names()` | `services.tools.names()`，`SessionServices.tools: ToolManager` | 同上；`protocol.ts:255` 的「Every tool ... for the header's tool toggles」与窗口的全量基准不变 |
| `session-factory.ts:177` 冷读 `allTools`（票面未点名） | `registry.names()` | `manager.names()` | 第三读者同门，保证 `fanout.ts:88` 说的冷/热快照一致 |

- 本节的「门」指 Manager 答「存在什么」的那**一个**读口（今天叫 `names()`），沿用票面
  「改从哪只门读」的说法；它不是活跃集查询。两处（加冷读第三处）**都从这只门读**，
  即 02 那张 Map 的键集；绝不能改成
  `activeNames(state)` 或 `toolStateOf(...).activeToolNames` 之流。05 若给 `names()` 改名/改签名，
  三者一起随门改，但语义仍是「Map 里全部实例的名字」。
- `activeTools` 则相反：热读 `fanout.ts:86` 已是 `toolStateOf(...).activeToolNames`，
  冷读 `session-factory.ts:178` 收成同一份纯数据，不再借 Manager 的 `activeNames(state)`
  重复收窄（方法去留归 05，语义上 Manager 不该再收 `ToolState`）。
- `tool-config.ts` 四函数与 `fanout.ts:41/89` 的「目录侧」读点按 §2.5 收成 `known` 数据，
  其来源仍是同一只 `manager.names()`。**门只有一只，读它的人有多处。**

### 4. 改动面清单（交给执行票；本票不动）

| 子系统 | 落点 |
|---|---|
| 目录 / 类型 | `tools/registry.ts:19-30, 42-74` → `ToolManager`（类名/出口归 06、方法名与 `register()` 归 05）；`tools/index.ts:18` 与 `core/index.ts:207-220` 的出口面随 05/06 定；`tools/manager.ts` 的 `ToolState` / `narrowToKnown` / `fillTools` / `toolListFor` 归属不动 |
| 派生链 | `session/tool-config.ts:18, 32, 62, 121` 四函数的目录侧入参（前两个是第 3 参、后两个是第 4 参）收成名单数据 `readonly string[] known`；调用点 `agent.ts:527/610/684/1252`、`fanout.ts:41/86/89`、`session-factory.ts:163/182` 现传 `manager.names()`；`:178` 改吃纯数据 |
| 服务装配 | `fanout.ts:27` `SessionServices.tools`、`agent.ts:133/211/229/245-247`、`session-factory.ts:72/94/142/263/285/344-351`、`core/index.ts` 出口；核对项：`:142` 与 `:285` 须收敛到同一只 Manager（§0 第 4 点、02 §5 #3 的推论），`openAgent` 的 `assemble` → `createSessionAgent` 转发怎么落由执行票定 |
| 引擎 | `agent.ts:999/1288` 按名单从 Map 取实例（03 决定 1，不再接 `run`）；`:1252` 的 `toolState` 派生出本轮 `activeNames`；`:1011/1101/2082/2091/2099/2161/2264/2393` 显式带上 Manager + `run` + `activeNames`，`prepareToolCall` 与 `executionMode` 先判活（§2.4）；`:1298-1306` `runContext` 保留 |
| 审批 / 账本 | **零改动**：`fanout.ts:38-43`、`agent.ts:753/535/611/685`、`session-manager.ts:1537-1551` 的 `setToolConfig`、`.json` / `.jsonl` / `tool_config` entry 格式、`protocol.ts` wire |
| 文档 / ADR（归 06） | 会被本票推翻或需核对的现文：`AGENTS.md` tool / service / tool set 词条，`docs/architecture.md:119` 工具契约节「工具那一侧分三样东西」「五个方法」「不在注册表里、也不在任何一处被持有」，以及 `:125` 那句「未激活工具的调用会返回 Tool not found」在 §2.4 下**仍成立但要改述判活位置**；ADR 0005 / 0006 / 0007 / 0011 / 0015 的现状陈述按 `docs/adr/README.md:43-44`（只增不改、改写已接受的 ADR 时不改原文）处理 |
| smoke（归 05） | 要跟的读点已在 02 §4 / 03 §4 / 05 票面列出：`smoke-tools.ts:86-94/130/231-244/732-766`、`smoke-session.ts:244-262/1015-1033/1242-1283`、`smoke-approval-recovery.ts:254-260`；另有六条脚本读 `allTools` / `activeTools`（`smoke-modes` / `smoke-mux-client` / `smoke-replay` / `smoke-session` / `smoke-sessions` / `smoke-tools`）。04 新增的可测形状是「冷/热 `allTools` 恒等于 Map 全名表、禁用工具可重新启用、禁用工具的调用仍回 not found」 |

### 5. 决定记录（下游可直接依赖）

| # | 决定 | 约束谁 |
|---|---|---|
| 1 | 选 (a)：Manager 只答「存在什么 + 按名取实例（+03 的执行转发）」，公开面只收名字与调用参数，**不收任何会话状态 / 服务 / id**；Map 恒装全部实例（02 §2.3 不可变） | 执行票、05、06 |
| 2 | 活跃集与审批仍是账本派生的纯数据，四函数留 `session/tool-config.ts`、不搬进 Manager；`toolStateOf` 仍是唯一派生，`setToolConfig` 仍是两字段唯一写者 | 执行票、06 |
| 3 | 一个决定两字段不拆：`approvalsOf` 留 fanout，Manager 无审批字段/方法/状态；`.json` / `.jsonl` / `tool_config` entry 格式一字不动，map.md 那块雾关闭 | 执行票、06 |
| 4 | `Agent` 把 `toolStateOf(...).activeToolNames` 收成本轮栈上局部 `activeNames`，`:999` / `:1288` 按名单从 Map 取实例装 `Context.tools`（03 决定 1），不接 `run` | 执行票 |
| 5 | `activeNames` 与 Manager、`run` 一样显式穿过执行链；`prepareToolCall` 与 `executionMode` 先判活再 `get`，落空仍回 `Tool <name> not found`；判活归引擎，不归 Manager。**这是 (a)「Agent 决定本轮名单」与 03 §5 #6 在 Map 装全部六个后的唯一自洽读法，不是改 03 的决定** | 执行票 |
| 6 | `SessionServices.tools: ToolManager`，仍是 `Agent` 构造注入、进程级一只，由现攒的 `services` getter 填入；fanout 函数仍无状态 | 执行票、06 |
| 7 | 两处读点（加冷读第三处）都从 Manager 的**全部名单**门读，语义是 Map 键集；`activeTools` 一律吃 `toolStateOf(...).activeToolNames`；05 若改门名三者同改 | 执行票、05 |
| 8 | 四函数与 Manager 之间**只传名单数据**（推荐形状 `readonly string[] known`、调用点现传 `manager.names()`；具体形参属执行票），会话域派生零服务依赖、工具域零会话依赖——这是「不给 Manager 会话状态」的另一半，不是替 05 定方法签名 | 执行票 |
| 9 | 执行票须把 `session-factory.ts:142` 与 `:285` 收敛到同一只 Manager（今天会造两只无状态目录）——这是 **02 §5 #3「一张 Map + 恒等不变量」的直接推论与核对项，不是本票新增的装配约束** | 执行票 |
| 10 | 否 (b)：把 durable 选择的派生搬进进程服务，要么持 per-session 状态、要么让公开面收另外两只服务加整份会话状态，劈开「一个决定」、反转依赖方向、放大冷/热双实例问题。否 (c)：并发与换出两问都只能退回 02 已否的键控表 / 每请求重建 / 全局锁，且 `names()` 答不了「存在什么」，`allTools` 与默认全量当场失真 | 06、执行票 |

### 6. 本票没有回答的（别当成已定）

`ToolManager` 的名字冲突与历史 ADR 取代指针、是否新开 ADR、AGENTS.md / architecture.md /
README / notes 的逐句改写与文档归属（06）；旧五法 `names()` / `build()` / `activeNames()` /
`active()` / `register()` 的去留与别名、执行入口的方法名与签名、`createTools(run)` 的收法、
smoke 断言怎么重写、`recoverPendingToolCalls` 宿主怎么供 Manager + `run`（05）；
执行票怎么切、何时 graduate（本图 *Not yet specified*，等 02–06 全定案后一次 graduate）。
§2 / §4 写的是 (a) **必然带来**的形状后果与要跟的读点，不是替 05 / 06 做选择；
`activeNames` 这个**方法**留不留归 05，本票只定「活跃名单是纯数据、引擎判活、Manager 不收它」。

### 7. 验收（2026-11-06 与 01 号票基线对跑）

本票未改任何 `packages/` 源码或 `scripts/smoke-*.ts`；按图「每票收账跑 `npm run check`」是本票的
验收项，下面这遍全套 28 条对跑是实现流程要求的收尾复跑、不是本票新增的验收门槛。本票是 grilling
决策票、零代码改动，TDD 无适用接缝。

- `npm run check`：**绿**，`tokens ok: 137 defined, 111 referenced`；`check.log` 与基线逐字节相同。
- 28 条 smoke（`run-all.sh` 无服务器口径）：首轮 **25 绿 / 3 红**，第三条红是 `smoke-approval`
  6 s 崩在 `wire: open … 之后没有等到基线`（`scripts/wire/client.ts:209` 的 5 s 等待超时），
  与 01 号票 §3 登记的偶发红同一处；**单独复跑 2/2 绿**（两份日志各 68 行、正常收尾）。按 01 号票
  口径定性为偶发、不计入既有红，于是稳态仍是 **26 绿 / 2 既有红**，红集合
  `{ smoke-api（缺服务器）, smoke-liveness（本机时序） }`，**零新红成立**。
  `smoke-api.log` 与基线逐字相同（`the mux connection failed`）；`smoke-liveness` 首轮 3 个 FAIL
  （baseline 0 / second connection 10 / re-opened with fresh baseline 0，预算那条本轮恰好 ok），
  单独复跑 2/2 仍红、各 4 个 FAIL、预算断言 **2680 / 2611 ms**（预算 1650 ms）——与 01 号票
  「同一条脚本在不同轮次 FAIL 组合并不一致」的口径一致，仍是同一条既有红。
- 逐份 diff 28 条脚本日志：只有 3 份与基线不等——`smoke-boot`（随机端口 / 临时 home / UUID）、
  `smoke-approval`（错误消息里的 UUID；基线那份本身也是 01 号票首轮偶发红的日志）、
  `smoke-liveness`（毫秒数与 FAIL 组合），全在 01 号票 §5 登记的随机量 / 归因清单里；
  **`smoke-tools.log` 223 行逐字节相同**。基线独有的 `smoke-api-with-server.log` 不参与这 28 份对跑。
- 全部输出落在 `../smoke-runs/after-04/`（`check.log`、`summary.txt`、28 份 `<name>.log`、
  两份 `rerun-smoke-approval-*.log`、两份 `rerun-smoke-liveness-*.log`；日志与临时 home 不入提交）。
  本票没有跑 `smoke-api` 的「起服务器后 ok」那一遍——本轮无源码改动，那条结论按 01 号票 §4 原样沿用。
- `Status` 翻 `resolved`；`map.md` 的 Decisions so far 追加 04 指针、Not yet specified 关掉
  「会话账本格式是否要动」这块雾并把毕业清单更新为「按 02 / 03 / 04 票的清单核」。
- code-review（固定点 `5d92c5e`，Standards / Spec 双轴）后的尾修另成一笔：补上 (c) 的
  「要动什么」段，把 §2.5 / §5 #8 #9 从「新签名 / 新装配约束」收成「边界约束 + 02 §5 #3 的
  推论与核对项」，把 §2.4 与 03 §5 #6 的衔接写死（「未知名」在 Map 装全部六个后须读作
  「不在本轮名单」）；修正 §0 / §4 的事实口径（四函数对 registry 的两种用法、`:39/:70/:129`
  是转发而非 `.names()`、`AGENTS.md:95` 与 `architecture.md:127` 才是「一个决定」原句、
  `web/main.ts:507-508` 与 `:1133` 的归属、ADR-0006 决定 5、`docs/adr/README.md:43-44`、
  目录侧入参是两处第 3 参 / 两处第 4 参）；给「门」下定义，给 `activeNames` 注明数组或
  `Set` 由执行票选。计数：Standards 轴 **0 硬违规 / 5 判断项**，Spec 轴
  **missing 1 / scope-creep 3 / wrong 5**，尾修逐条处理。**未采纳（判断性意见）**：决定记录里
  file:line 枚举的重复（03 号票已记同口径）、「05 若改门名三者同改」的前瞻钩子（守住 (a)/(b)
  分界所需）。两轴交叉核对另确认：§2.4 相对 03 §5 #6 是**补定、非字面矛盾**（03 只断言
  「未知名」，对禁用工具不置一词；`activeNames ⊆ manager.names()` 让 03 的断言在 04 下仍真），
  故只在 Spec 轴记一次 scope-creep、不双算。归档一条 03 侧旧瑕疵（**不属本提交、本票不改 03**）：
  03 §2.4 写「未知名行为不变」却引 `architecture.md:125`，而 :125 原句讲的是「**未激活**
  工具」——这正是禁用工具缺口的根因，04 §2.4 补回的正是 :125 的完整语义。
