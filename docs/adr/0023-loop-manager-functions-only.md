# 0023：`LoopManager` 只认函数——六件依赖回调化，loop 层零 Manager 可见性

日期：2026-11-12 · 状态：已接受（wayfinder 票 003，两轮 grilling 与用户拍板；落地归票 004、守卫升级归票 005，见 `.scratch/wayfinder/loop-zero-manager/`）
取代：[0022](0022-loop-manager-whitelist-callbacks.md) 的**「六件依赖进袋」**——`LoopOptions` 上的 `sessionManager` / `settings` / `tools` / `hooks` 四件 Manager 字段（决定 2「`Agent` 仍是六件服务的持有者」里**递给 loop 的那一半**；判据节 `loopOptions` 完整形状的四个 Manager 槽位；「后果」里「一只 11 字段的参数袋」的四件 Manager 槽位——六件里剩下的 `api` / `systemPrompt` 本就是函数形状，原样保留）——以及决定 7 里「fanout 参数 `(state, session, SessionServices)` **在调用点现建**」的**组装点一半**（`servicesOf` 组装点消除，`publishState` / `approvalsOf` 包成 Agent 传入的回调；fanout 文件与其参数形状不动）。0022 的其余裁决由本 ADR **延续并收紧，不是推翻**：文件分区、零字段对象、单袋形状、静态守卫、出口口径全部不动——变的是边界的定义：白名单从「两条绕回回调」改成「19 动词 + `emit` 一条 sink」，原则一字未动，纪律推到极致
取代者：无

设计过程见 `.scratch/wayfinder/loop-zero-manager/`（票 001 全量触点盘点、票 002 回调面定稿、票 003 起草与接受）；定下的词见 [CONTEXT.md](../../CONTEXT.md)。

## 背景

同一批代码的第五次搬家，这次只隔一天：0022（11-11 深夜拍板，落地与守卫在同一工作夜的 00:29 / 00:49 落下，bcf4de8 / 7f20a2b）把引擎装回 `loop-manager.ts`，白名单定稿两条（`bagOf` / `emit`），六件服务依赖作为「loop 自己用的依赖」进了 `loopOptions`。次日票 001 对刚落地的 `loop-manager.ts` 做全量触点盘点，数出来的事实让 0022 的边界站不住：

- **「六件依赖」的主体不是六件服务对象，是四件 Manager 的 85 个无答辩越界触点**（67 物理行，逐依赖计数为 87 触点）：`sessionManager` 27、`tools` 27、`settings` 19、`hooks` 12——含经 `servicesOf` 现建的 5 个消费点（每行同触三件，已计入各项）；六件里剩下的 `api` 与 `systemPrompt` 各只有 1 个消费点，本来就是函数形状。0022 的白名单给两条回调各写了一段答辩；这 85 处 `sessionManager.` / `settings.` / `tools.` / `hooks.` 一处答辩都没有——它们以「0013 已验证的参数化结论」的名义顺路进了袋，从没走到 0008 的试金石面前。
- **用户这一轮把判据钉成一句话：依赖方向纯度——loop 层零 Manager 可见性。** loop 需要的每样东西都以函数到达；谁提供、从哪来，是 `Agent` 的事。0022 的三层答辩没有一层为「Manager 对象可以进袋」辩护——它辩护的是对象的存在（文件地址）与白名单的收窄（两条），六件依赖是判据没照到的地方。

所以这不是对 0022 判据的否决，是把 0022 自己的判据应用到它自己的袋上。白名单原则说「每一样越过边界的东西都要答出为什么」——0022 把「每一样」悄悄换成了「每一条回调」。

### 正面回答 0022 的判据三层

0022 用三层答辩立住了对象与白名单。逐层检验，没有一层为六件依赖进袋成立：

1. **「对象的价值是文件地址不是持有」——成立，且原样延续。** 本 ADR 不动 `loop-manager.ts`、不动零字段、不动「读 loop 只看一个文件」的目标。转向不关乎对象，只关乎**什么东西越过它的边界**。文件分区论证的是「代码住哪」，本 ADR 论证的是「loop 认识谁」——两件事，0022 自己也是分开写的（决定 1 vs 决定 4）。
2. **「跨边界的是白名单不是字段」——原则成立，0022 没有对它自己的袋执行。** 0022 一边写下「白名单是封闭清单，加第三条要重开本 ADR」，一边让四件 Manager 对象与 85 个触点从另一扇门进出。把原则推到极致，结论自然出现：**每样越过边界的东西都该是一条有答辩的动词**。Manager 对象的问题不是它不好，是它的类型允许 loop 问出动词清单之外的任何问题——`SessionManager` 在袋上，loop 就能调它的全部公开面，而「哪些该问」只活在方法体里，没有任何类型、守卫或文档看得见。19 个动词把「loop 需要什么」从 85 处方法体的散落调用收拢成一个类型上一次性可见的清单。
3. **「0008 批评的是转发形状不是分区」——只对了一半。** 0008 拆掉的 `Loop` 有两个罪状：转发形状（每个问题绕回 `Agent`）与没有信息。0022 正确地指出拆的是前者。但六件依赖进袋把转发形状**换了姿势请了回来**：不再是 7 条显式绕回回调，而是 85 处对编排层自有服务的触点——绕回没有消失，只是溶解进方法体，从「类型上看得见的两条」变成「守卫查不到的 85 处」。0008 的试金石问的是「为什么这个必须绕回编排层」，四件 Manager 的每一处触点都在绕回编排层，只是没人再被要求回答。

一句话：**0022 立了边界却给了六件豁免；本 ADR 撤掉豁免，边界不变，管到底。** 「六件依赖进袋活不过一天」不是因为它错了哪一步推理，而是因为它的判据与它的袋不在同一张纸上——票 001 的盘点只是把两页摆到了一起。

## 决定

1. **`LoopOptions` 上不再有任何 Manager 或服务对象。** `sessionManager` / `settings` / `tools` / `hooks` 四件从袋上删除；袋上剩三件每次调用的值（`state` / `bag` / `start`）、两件既有函数形状（`api` 传输与 `systemPrompt` builder——它们各只有 1 个消费点，本来就是「loop 只认函数」的既有样板）、一条白名单 sink（`emit`）与回调面 19 动词（判据节逐项答辩 + 完整接口）。loop 对三只 Manager 与 hooks 的认识为零。
2. **回调粒度是语义操作分组，不是逐点镜像。** 按「loop 需要什么操作」定动词——读 8、写 6、执行 1、接缝 3、窗口 1（票 002 两轮答辩定稿）；`Agent` 侧实现内部自己摸 Manager / fanout / `toolStateOf`。逐点镜像案被否：那只是把直调换成间调，袋上背 25 个成员不比 85 个触点更可读，且把「怎么做的」泄漏进了边界——动词答「做什么」，不答「怎么做」。
3. **`bagOf` 退出白名单。** 它唯一的运行触点（`recordSelection` 内的开袋）被动词收编：对比盘上基线、需要时开全新袋、三写快照字段，是一个语义操作——拆开只会让 loop 知道「快照 vs 袋」的实现细节。loop 从此没有任何自开袋路径。白名单定稿 **19 动词 + `emit`**，仍是封闭清单：加一条要重开本 ADR。
4. **`servicesOf` 组装点消除。** `publishState` ×4 与 `approvalsOf` ×1 包成 Agent 传入的 `publish` / `approvals` 回调；fanout 文件与其参数形状不动（`Out of scope`），动的只是「谁在调用点现建 `SessionServices`」——从 `loop-manager.ts` 挪进 `Agent.loopOptions()` 的闭包。0022 决定 7 的另一半不动：`dispatchEvent` 组合政策的归属仍是编排层，`emit` 仍是它的出口。
5. **`executeTool` 镜像 `ToolManager.execute`，[ADR-0016](0016-tool-manager-instance-table.md) 不动。** 表还是那张表，`Tool.execute` 的生产唯一入口仍是表自身的 `execute`；消掉的只是 loop 对表的可见性。`activeTool` 的表解析改为对 `activeTools` 返回的 `declared` 按名查（同一派生、同为表实例）——「模型被告知什么与它可以运行什么」的不变量更硬：调用只能解析到本请求声明过的工具。
6. **hooks 拆成三个显式回调**：`rewriteContext` / `decideBeforeTool` / `decideAfterTool`。`Hooks` 服务与 `apply` 门面留在 `Agent` 侧原样；事件与答案类型在 `loop-manager.ts` 结构定义（守卫将禁 import hooks 所在模块），同步点在 `agent.ts` 接线处（形状不合编译即失败）。`toolCallHooks` 包装方法消失——这两条回调就是运行自己的那对闸门；闸门本体（`beforeTool` / `afterTool` 的裁决归一化）留在 loop，suspend 结束运行是引擎机械。
7. **依赖方向与守卫收紧。** 0022 决定 5 的「loop 不 import `agent.ts`」保留；票 005 把 `check-loop-boundary.ts` 升级为**负向再加一条：`loop-manager.ts` 禁 import 三只 Manager 与 hooks 所在模块**，让「loop 不认识任何 Manager」成为机器检查的事实，而不只是类型上的自觉。模块清单的口径归票 005（见「尚未决定」）。
8. **出口口径确认，不改判。** `index.ts` 维持 0022 决定 6 的裁决：不恢复 `LoopManager` / `LoopManagerConfig` 导出；恢复机器 `danglingToolCallsOf` / `recoverPendingToolCalls` 保持从 `./loop-manager.ts` 导出、包对外名字一字不变（`smoke-approval-recovery` 直驱，[0006](0006-stateless-session-architecture.md) §5）。落地带来的形状变化仅是这两个函数的签名从 `manager + hooks` 改为 `declared + executeTool + 两闸门回调`——语义只搬不改，这是本 ADR 对 0022「尚未决定」清单之外唯一一处需要写明的出口实况。

## 判据：回调面逐项答辩与 `LoopOptions` 的完整形状

**判据**（0008 的试金石，推到极致后的新口径）：袋上的**每一个成员**——不再只是回调——都必须答出「为什么 loop 需要它、以这个形状需要」。答不上来就改形状或移出边界。三件值（`state` / `bag` / `start`）与两条既有函数形状（`api` / `systemPrompt`）是保留项（0022 已定、票 002 Q4 确认原样不动）；19 动词逐项答辩如下（全文见票 002 与 `.scratch/wayfinder/loop-zero-manager/research/002-callback-whitelist.md`）：

| # | 动词 | 吸收的触点 | 答辩要点 |
|---|---|---|---|
| 1 | `contextMessages` | `buildSessionContext` ×1 | 唯一触点只消费 messages 半——回调只答 loop 问的那一半，`SessionContext` 的其余不进 loop |
| 2 | `contextEntries` | `buildContextEntries` ×4 | 形状无争议：账本重放出的 entry 视图，填充链与压缩阶梯共用 |
| 3 | `modelCatalog` | `settingsManager.modelCatalog` ×5 | settings 的最大消费面，一个动词 |
| 4 | `activeTools` | `toolStateOf` ×2 + `declaredTools` ×3 | 扩签名返回 `{ names, declared }`：活跃名单与同一派生查表所得的声明数组是一个语义操作（「这次请求的工具面」）；`approvalOverride` 不进 loop |
| 5 | `recordSelection` | `recordedOnDisk` + `bagOf` + `setModel` / `setThinkingLevel` / `flushMeta` | 一个语义操作：对比盘上基线、开袋、三写——拆开只会让 loop 知道「快照 vs 袋」的细节；`bagOf` 随之退出白名单 |
| 6 | `modelChoice` | `modelChoiceOf` ×3 | 「这个会话在哪个模型上」是派生答案（0019），与 3/5 同属选择派生族 |
| 7 | `approvals` | `approvalsOf` ×1 | 生效中的审批映射：闸门默认处理器、快照与 prompt 三者共同的唯一读取点；不与 `publish` 合并（消费者与时机都不同） |
| 8 | `bashSettings` | `getBashSettings` ×2（602 + 259 传参链） | 实时读，形状无争议 |
| 9 | `retrySettings` | `getRetrySettings` ×1 | 不与 8 合并：消费时机不同（run 起点 vs 首次失败），合并迫使每次运行预读 retry |
| 10 | `setSuspended` | `setSuspended` ×1 | 快照显示缓存的一次翻转（0021 语义一字不改） |
| 11 | `appendMessage` | `appendMessageEntry` 链 ×3 | 签名带 `state`：fanout 组装点要清 `live.unwritten` 并发 `entry_appended`——活半的读者在 state 上 |
| 12 | `appendCompaction` / `appendTrimToolCallArgs` / `appendClearToolResults` | 三个账本追加 ×3 | 不设族回调：族回调把账本条目格式知识推进 loop 且丢参数类型；追加的种类是概念归类不是接口形状，Agent 侧实现同为 `sessionManager` 转发 |
| 13 | `executeTool` | `ToolManager.execute` 及解析/调度/传参链 ×16 | 镜像表入口（0016 不动）；解析改对 `declared` 按名查，调度留在 loop |
| 14 | `rewriteContext` | `hooks.apply("context")` ×1 | hooks 三动词之一；事件/答案类型结构定义在 loop-manager.ts |
| 15 | `decideBeforeTool` / `decideAfterTool` | `hooks.apply("before_tool"/"after_tool")` + 直读 ×11 | `toolCallHooks` 包装消失：这两条回调就是运行自己的闸门；裁决归一化留 loop |
| 16 | `publish` | `publishState` ×4 | 窗口契约的发布；组装点挪进 Agent 闭包，fanout 不动 |

定稿 **19 动词 + `emit`**：001 盘点的 68 归档实例与 12 草案外行（对应 67 物理行、逐依赖计数 87 触点）100% 着落，无剩余。`LoopOptions` 完整接口：

```ts
/** 一次请求的工具面：活跃名单与同一派生查表所得的声明数组，一个回调、一次派生。 */
export interface ActiveTools {
	/** 本次请求活跃的名字：整条链成员判断的唯一依据。 */
	names: readonly string[];
	/** 同一派生按名字查表的声明数组：元素是表自己的实例（ADR-0016）。 */
	declared: readonly Tool<any>[];
}

/** hooks 三动词的事件与答案：结构定义在本文件，与 HookMap 的同步点在 agent.ts 的接线处。 */
export interface ContextInjection {
	sessionId: string;
	messages: Message[];
	systemPrompt: string;
}
export interface ContextRewrite {
	messages?: Message[];
	systemPrompt?: string;
}
export interface BeforeToolEvent {
	sessionId: string;
	toolCallId: string;
	toolName: string;
	args: unknown;
}
export interface BeforeToolDecision {
	block?: { reason: string };
	args?: unknown;
	terminate?: boolean;
	suspend?: boolean;
}
export interface AfterToolEvent {
	sessionId: string;
	toolCallId: string;
	toolName: string;
	content: ToolResultContent;
	isError: boolean;
}
export interface AfterToolDecision {
	content?: ToolResultContent;
}

/**
 * 一次运行调用的唯一参数袋：三件每次调用的值、两件既有形状（api / systemPrompt）、
 * 白名单 sink（emit）与回调面（19 动词）。越过边界的全部在这个类型上一次性可见，
 * 三只 Manager 与 hooks 对 loop 完全不可见（ADR-0023）。
 */
export interface LoopOptions {
	// —— 三件每次调用的值（保留项）——
	/** 这次运行写瞬态的对象：两条队列、在飞运行、partial、重试与挂起位（ADR-0019 的 live 半）。 */
	state: AgentState;
	/** 运行袋：开跑时重放一次盘得到的 transcript，整条运行只带这一只（ADR-0019）。 */
	bag: Session;
	/** 运行起点：打开它的那条消息，或恢复用来关闭悬空调用的答案。 */
	start: RunStart;

	// —— 既有形状（保留项）——
	/** 每个请求真正离开的地方：传输层，重试策略包上它之前的那个。 */
	api: ChatTransport;
	/** prompt builder：活跃工具集与审批映射点名的东西会中途变化，所以是函数不是字符串。 */
	systemPrompt: (
		workDirAbsPath: string,
		agentsMd: readonly AgentsMdFile[],
		toolNames: readonly string[],
		approvals: Record<string, boolean>,
	) => string;
	/** 白名单 sink：事件去向（落盘、清队列、投影的组合政策，实现是 `Agent.dispatchEvent`）。 */
	emit: (state: AgentState, session: Session, event: AgentEvent) => Promise<void> | void;

	// —— 回调面 · 读（8）——
	/** 运行打开时对着的那份消息（`buildSessionContext` 的 messages 半）。 */
	contextMessages: (session: Session) => readonly Message[];
	/** 账本重放出的 entry 视图：填充链与压缩阶梯共用的答案。 */
	contextEntries: (session: Session) => readonly SessionEntry[];
	/** 本构建认识的模型行。 */
	modelCatalog: () => readonly ModelConfig[];
	/** 这个会话现在在哪个模型上（`chosen` = 运行局部的 `live.openedOn`）。 */
	modelChoice: (session: Session, chosen?: ModelChoice) => ModelChoice;
	/** 本次请求活跃的工具名单与同一派生的声明数组。 */
	activeTools: (session: Session) => ActiveTools;
	/** 生效中的审批映射：闸门默认处理器、快照与 prompt 三者共同的唯一读取点。 */
	approvals: (session: Session) => Record<string, boolean>;
	/** bash 工具允许一条命令运行多久（实时读）。 */
	bashSettings: (workDirAbsPath: string) => BashSettings;
	/** 供应商调用的重试策略（实时读）。 */
	retrySettings: (workDirAbsPath: string) => RetrySettings;

	// —— 回调面 · 写（6）——
	/** 把本次请求所用的选择写进会话：对比盘上基线，需要时在 Agent 的表上开新袋补写。 */
	recordSelection: (session: Session, catalog: readonly ModelConfig[], choice: ModelChoice) => void;
	/** 快照显示缓存的挂起标志翻转。 */
	setSuspended: (session: Session, suspended: boolean) => void;
	/** 追加一条消息条目并宣布（fanout 组装点：清 `live.unwritten`、发 `entry_appended`）。 */
	appendMessage: (state: AgentState, session: Session, message: Message) => void;
	/** 账本追加：压缩摘要。 */
	appendCompaction: (
		session: Session,
		summary: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		usage?: Usage,
	) => string;
	/** 账本追加：截短重型工具被记录的参数。 */
	appendTrimToolCallArgs: (session: Session, trimmedEntryIds: readonly string[], tokensBefore: number) => string;
	/** 账本追加：清掉缓存大概已过期的工具结果。 */
	appendClearToolResults: (session: Session, clearedEntryIds: readonly string[], tokensBefore: number) => string;

	// —— 回调面 · 执行（1）——
	/** 运行一次工具调用：查工具并转发（`ToolManager.execute` 的动词化，ADR-0016 不动）。 */
	executeTool: (
		name: string,
		toolCallId: string,
		params: unknown,
		run: ToolRunContext,
		signal?: AbortSignal,
		onUpdate?: ToolUpdateCallback<any>,
	) => Promise<ToolResult<any>>;

	// —— 回调面 · 接缝（3，hooks 三动词）——
	/** 改写给供应商的内容。 */
	rewriteContext: (injected: ContextInjection) => Promise<ContextRewrite>;
	/** 在工具调用之前裁决：阻止、精修参数、终止或挂起（审批闸门）。 */
	decideBeforeTool: (event: BeforeToolEvent) => Promise<BeforeToolDecision>;
	/** 在工具结果上裁决：改写即定稿。 */
	decideAfterTool: (event: AfterToolEvent) => Promise<AfterToolDecision>;

	// —— 回调面 · 窗口（1）——
	/** 全量快照广播（fanout 组装点，`publishState` 的动词化）。 */
	publish: (state: AgentState, session: Session) => void;
}
```

`CompactOptions` 连带改形：Pick 链上不再有 Manager 字段，pick 的正是压缩阶梯要的回调与值——`Pick<LoopOptions, "state" | "bag" | "modelCatalog" | "modelChoice" | "contextEntries" | "appendCompaction" | "appendTrimToolCallArgs" | "appendClearToolResults">` + `entries / now / signal? / transport?`。不取整袋：压缩不需要执行链与 hooks 三动词，Pick 链本身就是压缩阶梯的依赖清单。

## 后果

换来的：

- **loop 层零 Manager 可见性。** 三只 Manager 与 hooks 对 loop 完全不可见；「越过边界的全部」在一个类型上一次性可见——没有一个字段能问出动词清单之外的问题。001 盘点的触点全部有着落：四件 Manager 的 85 个改走动词，`api` / `systemPrompt` 两个保留项确认原样——散在方法体里的越界从此不存在。
- **依赖方向双向可检查。** 0022 的守卫只查「不 import `agent.ts`」；票 005 升级后连「不 import Manager / hooks 模块」也是机器事实。85 处触点若是回潮，任何一处都要先把一个 Manager 塞回袋——类型与守卫同时报错。
- **白名单答辩覆盖 100% 触点。** 0022 的答辩管 2 条、其余 23 个成员只有「0013 已验证」的整体豁免；本 ADR 的答辩管袋上每一个成员。后来的人不必再猜「哪些曾经是候选」——候选就是袋上的 25 个成员，答案就在判据节。
- **一条更硬的不变量。** 工具调用只能解析到本请求声明过的工具（`declared` 按名查）——「模型被告知什么与它可以运行什么」从两条派生并成一条。
- **`CompactOptions` 即依赖清单。** Pick 链上没有 Manager 字段，压缩阶梯要什么一眼可见。

背上的：

- **参数袋从 11 字段变成 25 字段**（三值 + 两形 + sink + 19 动词）。每个入口要凑齐的更多——但凑的全是 `Agent.loopOptions()` 闭包里现成的一行转发，不是新逻辑。
- **`Agent` 侧长出一只大闭包。** 19 动词 + `emit` 的实现全部住在 `loopOptions()` 的闭包里（对照表见票 002 §4，落地归票 004）；`servicesOf` 与 `toolCallHooks` 消失，换来的是接线处的规模。`agent.ts` 不再收缩而是横长——这是买「loop 零 Manager 可见性」的价格，付在编排层。
- **人工判据这条照旧背上。** 守卫升级后仍查不出「这条动词该不该存在」——第三条动词可以在不改守卫的情况下被塞进袋。封闭清单 + 重开本 ADR 是自觉，不是类型。
- **实况文档窗口期照旧。** `AGENTS.md` 的 engine 词条、`docs/architecture.md`、根 `README.md` 今天描述的是 0022 落地后的形状（六件依赖在袋上）；票 004 落地时改指 0023。窗口期内 ADR 与实况不同是**有意的**：一个记决定，一个记实况。
- **行数账与落地偏差归票 004 补。** 本 ADR 接受时代码仍在 0022 形状上（`agent.ts` 1172 行、`loop-manager.ts` 1940 行、`LoopOptions` 11 字段含四件 Manager）；本次是机械改写（`this.xxx` → `loopOptions.xxx` → 回调调用），预期行数位移很小，落地后如实记账。

## 尚未决定

按 `docs/adr/README.md` 的写法，以下两件在本 ADR 接受时未定，单独列在这里；**上面每一条决定都不依赖它们**——取代关系、回调面定稿、出口口径在这两件的任意取值下逐字相同。唯一的耦合是票 005 守卫的**模块清单口径**：禁令本身（决定 7）已定，扫哪些模块、按模块还是按类型标识符命中是它的自由度。

1. **类型驻地口径**：`Session` / `SessionEntry` 现与 `SessionManager` 同模块（`session-manager.ts`），`ToolRunContext` / `ToolUpdateCallback` 现经 `tools/index.ts`——「禁 Manager 模块」的守卫若按模块禁，这两个值类型的 import 面会误伤；口径是先给值类型安新家，还是按 Manager 类型标识符禁。归票 005，与落地（票 004）一并定。
2. **落地后的行数账与偏差**：由票 004 补进「后果」。

## 不可逆性与代价

三条门槛逐条成立：

- **难逆转。** 回去要把四件 Manager 塞回袋、把 19 动词覆盖的 85 处触点重写回直调、把 `servicesOf` 与 `toolCallHooks` 请回来、把守卫的负向规则删掉——不止一处，不止一个文件。十天之内第五次搬同一批代码（0022 的「九天内第四次」刚写下一天），这条链本身要求每一步都写下「为什么这次不一样」。
- **没有上下文会让人困惑。** 0022 立起「白名单是封闭清单」，次日同一张图把它改成 20 条；四份 ADR（0012/0013/0014/0022）连读已经够绕，若没有「判据没照到自己的袋」这条主线，第一反应必然是「白名单原则才定一天就自己推翻」。区别不是原则变了——是原则第一次覆盖了全部越界者。
- **是真实取舍。** 换来零 Manager 可见性与双向可检查的边界，付更宽的袋、更大的 Agent 闭包、第五次搬迁的历史成本。被放弃的选项各有代价：维持 0022 就继续让 85 个无答辩触点跨边界、守卫照不到；逐点镜像只是把直调换间调，袋上背 25 个镜像成员更难读；把 hooks 整个对象递回袋上是禁令面上唯一的回头路，守卫会当场拦下。

## 被取代的是什么

逐条对照 [0022](0022-loop-manager-whitelist-callbacks.md)。「被取代」只限下列各条；0022 的其余决定作为裁决与理由**继续有效**：

- **决定 2**（`LoopManager` 零字段、零构造参数；`Agent` 仍是六件服务的持有者）：零字段、零构造参数、不进 `AgentConfig`、装配点唯一——全部不动。「六件服务……以及组装 `loopOptions` 都要用」那一半作废：袋上不再有 Manager，`Agent` 持有六件服务的理由只剩命令面、fanout 组装与回调实现自己的用途。
- **决定 3**（三处运行入口各组装一只 `loopOptions`）：不动。袋的内容按本 ADR 改，组袋的入口与「同一只 bag」纪律原样。
- **决定 4**（白名单封闭清单，定稿两条 `bagOf` / `emit`）：作为清单作废、作为纪律延续。`bagOf` 退出（收编进 `recordSelection`，loop 不再自开袋）；`emit` 保留为唯一的 sink；清单改写为 19 动词 + `emit`，「加一条要重开本 ADR」原样有效。
- **决定 7**（不随搬迁微调：fanout 分工不改）的**组装点一半**：作废。fanout 文件、无状态文件级函数、参数 `(state, session, SessionServices)` 的形状全部不动；动的只是 `SessionServices` 的现建点——从 loop 的 `servicesOf` 挪进 `Agent.loopOptions()` 闭包。决定 7 的另一半（retry 事件直调 fanout、`dispatchEvent` 组合政策归属编排层、`emit` 是它的出口）不动。
- **判据节的 `loopOptions` 完整形状**（11 字段：三值 + 六件依赖 + 两条回调）：作废，换本 ADR 判据节的形状。「不进袋」清单（模型、abort controller、闸门、transport、`thinkingLevel` 全是运行局部量）**逐字继承**。
- **「后果」的两条**：「一只 11 字段的参数袋」的六件槽位作废（袋子变宽的账本 ADR 重记）；「守卫只查『不 import agent.ts』」由票 005 的升级收窄（「白名单是人工判据」这条背上的**原样继承**）。

## 没有被取代的

- **0022 的文件分区与全部结构决定**：`loop-manager.ts` 的存在、18 方法与文件级机械的迁入纪律（方法体业务逻辑一字不改）、0008 决定 3 的「有状态 → 成员、无状态 → 文件级」分界、三处入口组袋、「读 loop 只看一个文件」的目标——不动。本 ADR 改的是边界的密度，不是边界的位置。
- **0008 的试金石**：「为什么这个必须绕回编排层」继续是唯一判据，且本 ADR 第一次把它应用到袋上的每一个成员。0008 那句「没有信息的对象」仍是试金石：一个只有转发没有语义分组的回调面（逐点镜像）就是它的还魂。
- **0013 的零字段与并发安全结论**：继续成立。19 动词仍是一次调用的参数表，不是聚合袋（0013 已验证参数化不违反 0007）；两条并发 run 之间没有任何可被互相覆盖的字段。被收窄的只是「六件以对象随调用递进」的形状——它们不再以对象过边界。
- **0019 的 bag 语义**：一次运行读一次盘、`live.unwritten` 只活在表上——不动；开袋路径从「`bagOf` 唯一入口」变为「`recordSelection` 内部、由编排层实现」，唯一性反而更硬（loop 侧连开袋动词都没有了）。
- **0016 的工具实例表**：表是表的，`Tool.execute` 的生产唯一入口仍是 `ToolManager.execute`；挡掉的只是 loop 的可见性（0017 的消费边界同思路：Manager 的消费者收进编排层）。
- **0017 的消费边界**：三只 Manager 由 `createSessionAgent()` 构造、唯一消费者是编排层、server 只认 `Agent` 公开面、`check-server-facade` 不动。本 ADR 是同一条边界的延长线：连 core 内部的 loop 也不再是 Manager 的消费者。
- **0006 §5 的结束重启审批**：恢复机器、悬空扫描、答案配对、孤儿收尾语义一字不改；两个函数的导出保持（决定 8），签名变化只是形状。
- **0021 的 `suspended` 显示标记**、**0007 的无属性服务**（`Hooks` 服务留 Agent 侧原样）、**fanout 文件与参数形状**、**abort / settle / close 不进 loop**、**命令面 REST + 常驻 mux**、订阅与 hold 分离——一律不动。
