import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type ChatTransport,
	createAssistantMessageEventStream,
	createSystemMessage,
	isContextOverflow,
	type Context,
	type JsonValue,
	type Message,
	type RetryCallbacks,
	retryAssistantCall,
	type SimpleStreamOptions,
	toToolDeclaration,
	type Tool,
	type ToolCall,
	type ToolResult,
	type ToolResultMessage,
	type ToolUpdateCallback,
	type Usage,
	validateToolArguments,
} from "./llm/index.ts";
import { type AgentsMdFile, loadAgentsMd } from "./context/agents-md.ts";
import {
	compact as compactTranscript,
	compactionThresholdFor,
	estimateTokens,
	shouldCompact,
	type Summarize,
} from "./context/compaction.ts";
import { clearableToolResultIds, isCacheProbablyExpired } from "./context/clear-tool-results.ts";
import { trimmableToolArgEntryIds } from "./context/trim-tool-call-args.ts";
import type { BashSettings, RetrySettings } from "./config.ts";
import {
	type Model,
	type ModelChoice,
	type ModelConfig,
	modelFor,
	unconfiguredStream,
} from "./models.ts";
import type {
	AgentEvent,
	AgentRequestUpdate,
	RunRecoveryOptions,
	ToolCallAnswer,
	ToolCallOutcome,
} from "./types.ts";
import type { AgentState } from "./session/agent-state.ts";
import { dropQueued, emitEvent, emitQueueUpdate } from "./session/fanout.ts";
import type { PendingMessageQueue } from "./session/queues.ts";
import {
	type Session,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "./session/ledger.ts";
import type { ToolRunContext } from "./llm/types.ts";

/**
 * 一次运行的全部机械（ADR-0022 文件分区不动，边界由 ADR-0023 收紧）：引擎、按请求的填充链、压缩
 * 阶梯、重试泵、两个工具调用闸门，以及收尾。这是这批代码的第五次搬家——0008 并入 `Agent`、0012
 * 立对象、0013 削空、0014 删除、0022 回成对象——这一次动的不是对象，是边界：{@link LoopManager}
 * 仍零字段、零构造参数，两个会话的运行可以同时跑在同一个实例上；变的是「loop 认识谁」。
 *
 * 依赖方向是单向的（ADR-0022 决定 5 延续）：本文件对编排层的认识只有 {@link LoopOptions} 里
 * 递进来的东西——而 ADR-0023 把这条推到极致，袋上**每一个成员**都得是值或函数：三只 Manager 与
 * hooks 对 loop 完全不可见，loop 需要的每样东西都以函数到达（回调面 19 动词 + `emit` 一条 sink），
 * 谁提供、从哪来，是 `Agent` 的事。本文件绝不 import `agent.ts`；`session/fanout.ts` 只用
 * `state` 参数的文件级函数（`emitEvent` / `emitQueueUpdate` / `dropQueued`）。
 */

/** 工具结果如何携带内容：按顺序排列的文本与图片块。与 hooks.ts 的同名别名同一行定义。 */
type ToolResultContent = ToolResult<unknown>["content"];

/** 一次请求的工具面：活跃名单与同一派生查表所得的声明数组，一个回调、一次派生（ADR-0023）。 */
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
 * 一次运行调用的唯一参数袋：三件每次调用的值、两件既有形状（api / systemPrompt）、白名单 sink
 * （emit）与回调面（19 动词）。越过边界的全部在这个类型上一次性可见，三只 Manager 与 hooks 对
 * loop 完全不可见（ADR-0023）。
 *
 * 它是一次调用的参数表，不是被持有的聚合袋：在调用点现凑、用完就丢（ADR-0013 已验证参数化不违反
 * ADR-0007）。运行局部的东西不进袋——模型、abort controller、两个闸门、重试包装的 transport、
 * thinkingLevel 全是运行自己的局部变量（ADR-0022 判据节逐字继承）。
 */
export interface LoopOptions {
	// —— 三件每次调用的值（保留项）——
	/** 这次运行写瞬态的对象：两条队列、在飞运行、partial、重试与挂起位（ADR-0019 的 live 半）。 */
	state: AgentState;
	/** 运行袋：开跑时重放一次盘得到的 transcript，整条运行只带这一只（ADR-0019）。 */
	bag: Session;
	/** 运行起点：打开它的那条消息，或恢复用来关闭悬空调用的答案（见 {@link RunStart}）。 */
	start: RunStart;

	// —— 既有形状（保留项）——
	/**
	 * 从会话的实时设置出发，为模型可以调用的工具构建 prompt。
	 *
	 * 是函数而不是字符串，因为它点名的两样东西会在会话中途变化：活跃工具集，以及其中哪些工具要审批。
	 */
	systemPrompt: (
		workDirAbsPath: string,
		agentsMd: readonly AgentsMdFile[],
		toolNames: readonly string[],
		approvals: Record<string, boolean>,
	) => string;
	/** 每个请求真正离开的地方：传输层，重试策略包上它之前的那个。 */
	api: ChatTransport;
	/**
	 * 白名单 sink（ADR-0022 决定 4 延续，白名单只剩这一条）：事件去向。落盘、清队列、投影的组合
	 * 政策是编排层与窗口契约的另一半，实现住在编排层（`Agent.dispatchEvent`）——与命令面的发布是
	 * 同一契约的两边，分居两文件就会漂移。`runEngine` 内照旧包成 sink 闭包。
	 */
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

/**
 * 压缩入口的参数：复用 {@link LoopOptions} 的八件字段（`start` 与执行链、hooks 三动词不适用），
 * 另带压缩自己的调用值。Pick 链本身就是压缩阶梯的依赖清单（ADR-0023）——不取整袋：压缩不需要
 * 执行链与 hooks，编排层的 `maybeCompact` 只递这些。
 */
export interface CompactOptions
	extends Pick<
		LoopOptions,
		| "state"
		| "bag"
		| "modelCatalog"
		| "modelChoice"
		| "contextEntries"
		| "appendCompaction"
		| "appendTrimToolCallArgs"
		| "appendClearToolResults"
	> {
	/** 要发送的 entry 选集，与填充链每次请求拿到的是同一种答案。 */
	entries: readonly SessionEntry[];
	/** 「现在」，过期缓存与时钟判断所用的时刻。 */
	now: number;
	signal?: AbortSignal;
	transport?: ChatTransport;
}

/** 压缩阶梯要的回调面：{@link CompactOptions} 的 Pick 链去掉两件调用值后剩下的那一份。 */
type CompactCallbacks = Pick<
	LoopOptions,
	"modelCatalog" | "contextEntries" | "appendCompaction" | "appendTrimToolCallArgs" | "appendClearToolResults"
>;

/**
 * 一次运行的全部：入口与出口（{@link LoopManager.run}）、按请求的填充链、压缩阶梯、传输层之下的
 * 重试泵、两个工具调用闸门，以及把运行安顿的收尾。
 *
 * 零字段（ADR-0013 的结论原样有效）：要什么由 {@link LoopOptions} 在调用时给，这里没有任何可以被
 * 两个并发的运行互相覆盖的东西。方法在文件里按调用顺序排，读一次运行从上往下就是它跑的顺序。
 */
export class LoopManager {
	/**
	 * 在 transcript 已有的一切之上，把引擎跑一次。
	 *
	 * 运行有两种起点。被提示的运行递入启动它的那条消息——编排层已持有它，引擎自己的回显绝不能被记录
	 * 两遍。恢复的运行递入审批答案：引擎的恢复遍把它们与上一次运行留下的悬空调用配对并从那里继续，
	 * 所以不写消息、也不回显。
	 *
	 * 运行就活在这里，这正是 loop 不持有运行状态的全部理由：传输层、重试作用域、事件处理器、引擎自己
	 * 的取走点，全部与运行一起构建、闭包在它的局部变量里、运行安顿时丢弃。跨过栈的恰是状态点名的
	 * 东西——队列、在飞运行、订阅者——以及 live 半本身，运行外的读者正是这样看到它的瞬态：运行边走
	 * 边把 partial、模型与重试状态写到 `state.live` 上。清零是运行的第一个动作，所以它绝不继承上一
	 * 次运行留下的东西；`finally` 只退掉模型，空闲会话重新从目录作答——其余读数保持运行结束时的
	 * 样子，停驻在闸门的会话正是这样被读成停驻，直到恢复运行或弃置清扫另作主张。运行所服务的会话
	 * 在开头解析一次，下面的每个闭包都穿同样的局部变量：没有哪个请求重新解析出另一只袋。
	 */
	async run(loopOptions: LoopOptions): Promise<void> {
		const { state, start, bag: transcript } = loopOptions;
		const live = state.live;
		// 运行的读数在同一个地方从零开始：一次运行既不继承上一次运行的模型，也不替它的遗留 partial
		// 或重试状态作答。suspended 是唯一有跨运行生命的标志——一次恢复运行在它还被上一次运行置着的
		// 时候就开始了，这正是重置放在这里而不是 `finally` 里的原因。
		live.partial = undefined;
		live.model = undefined;
		live.suspended = false;
		live.retrying = false;
		live.retryAttempt = 0;

		// 运行的发送策略骑在这一运行每个模型构造时所用的请求对象上。引擎从不知晓它：它向自己持有的
		// 模型要一条流，模型经它应答——所以重试、以及「这个模型背后没有行」的答案，发生在一切可能
		// 报告它们的东西之下。
		const transport: ChatTransport = {
			stream: (model, context, options) => {
				const outer = createAssistantMessageEventStream();
				// 有意不 await：运行拥有流的生命周期，无法重试的失败作为流上的 error 事件回来，而不是
				// 作为流函数的 rejection（引擎的契约本来就禁止它）。
				void this.pumpAttempts(loopOptions, state, transcript, outer, model as Model, context, options);
				return outer;
			},
		};

		try {
			// transcript 与工具按运行构建——引擎不保有自己的状态——而且实际发出的那个请求反正会被
			// 填充链重建两者。引擎的取走点读的是本会话自己的队列，所以不需要任何接线。
			await this.runEngine(loopOptions, transport);
		} finally {
			// 在运行的最后一刻被接受的消息——引擎已经决定不再找了之后——躺在一条无人会取走的队列上，
			// 所以在这里丢弃，而不是带进之后的某次运行。寻常的结束路径到这一步已经清空两条列表，这
			// 正是它对一次正常结束的运行成为空操作的原因。
			//
			// 被挂起的运行是例外：它的队列是恢复运行要取走的，这次运行流式期间有人打的字是他们的，
			// 不是这次运行该扔的。一次有东西被丢的 drop 是窗口尚未听说的队列变更，所以它是唯一在
			// 这里发布的结束路径；停驻的运行留住队列、一言不发。
			if (!live.suspended && dropQueued(state)) emitQueueUpdate(state);
			// 模型随运行一起下来：空闲会话重新从目录作答，这正是「在飞读运行、空闲读选择」成为一种
			// 状态而不是一次泄漏的原因。其余读数保持运行结束时的样子——被挂起运行的标志说的是会话
			// 在停驻，清掉它是恢复运行或弃置清扫的事，不是结束路径的。
			live.model = undefined;
			// 快照的显示缓存跟随运行结束时的标志：被挂起的运行写 true，其余每种结束写 false。这一下
			// 清扫覆盖每一次翻转——清掉标记的是恢复运行的结束，而不是启动它的那个答案。
			loopOptions.setSuspended(transcript, live.suspended);
			// 引擎的 `runEngine` resolve 之前运行不算结束——要等每个 await 了 `agent_end` 的监听者与
			// 引擎自己的 `finally`。所以这是第一个无物在飞的时刻，不在这里发布就永远没人报告它。
			//
			// 放在 `finally` 里而不是 `await` 之后，因为运行的两种结束走的是两条路：正常结束的运行
			// 直接落到这里，而自己的失败处理 reject 了——报告失败的那个落盘恰恰就是坏掉的那个——
			// 的运行以 rejection 的形态抵达这里，放在 `await` 之后的发布会恰好被最需要那一帧的运行
			// 跳过。运行有的每种结束路径都经过这一个块；可能先到的错误帧由得知 rejection 的调用方
			// 通告，不是由会话。
			loopOptions.publish(state, transcript);
		}
	}

	/**
	 * 引擎：一个入口、一个出口，对着现状的 context。
	 *
	 * 这段身体曾是 `packages/loop` 跑的东西，后来是 `Agent` 以自己方法跑的东西（ADR-0008），再后来
	 * 是被 0014 删掉的对象（ADR-0014）；它是零字段 `LoopManager` 的方法（ADR-0022）。它的接缝在袋上：
	 * 运行把自己注册到会话的 live 半上（`live.activeRun`，任何层的 abort 都落在那里），每个事件经
	 * 白名单回调 `emit`——它落盘并扇出——每轮的填充是 {@link LoopManager.prepareRequest}，两个取走点
	 * 排空的都是本会话自己的队列。这里没有任何东西活得比栈久，这正是运行所用的模型是局部变量而不是
	 * 字段的原因：它是请求唯一可能换掉的东西，一个成员会把它递给第二个会话的运行。跨过栈的是 live
	 * 半自己的槽位，供中途读 delta 的快照用。
	 *
	 * 运行要么从一条 prompt 起步——它进入 transcript 的第一个取走点，正是后来的 steer 消息在更晚
	 * 轮次进入的位置——要么是恢复：它对着现状的 transcript 打开，第一个动作是对上一次运行留下的
	 * 悬空调用做恢复遍。返回运行产出的消息。
	 */
	private async runEngine(loopOptions: LoopOptions, transport: ChatTransport): Promise<Message[]> {
		const { state, start, bag: session } = loopOptions;
		// 这次运行的值——目录与 bash 超时——收集一次、由运行发出的每次调用携带：它们是按请求的事实，
		// 如今作为一个值旅行，而不是被某个工具实例闭包（ADR-0016）。
		const run: ToolRunContext = this.runContext(loopOptions, session);
		const live = state.live;
		if (live.activeRun !== undefined) {
			throw new Error(
				"A run is already in flight. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}

		const abortController = new AbortController();
		let settle = () => {};
		const promise = new Promise<void>((done) => {
			settle = done;
		});
		live.activeRun = { promise, resolve: settle, abortController };
		const signal = abortController.signal;

		// 运行所在的那一行。以现状的选择播种；`prepareRequest` 用每个请求真正发送的那一行作答，所以
		// 即使运行死在第一个请求之前，合成的失败仍点着一个真实的模型。live 半上的槽位，是栈外快照读取
		// 它的方式，而不是回头去目录。
		const choice = loopOptions.modelChoice(session, live.openedOn);
		let model: Model = modelFor(choice, loopOptions.modelCatalog(), transport);
		live.model = model;
		const emit: AgentEventSink = (event) => loopOptions.emit(state, session, event);

		try {
			const newMessages: Message[] = [];
			// 这次运行的工具面——活跃名单与同一派生的声明数组，一次回调、一次派生（ADR-0023）。声明
			// 数组是整条链解析调用所依据的栈局部：解析只对着本请求声明过的工具（「模型被告知什么与它
			// 可以运行什么」从同一个对象作答），按请求重新派生的数组在下面的请求边界换入。
			let declared: readonly Tool<any>[] = loopOptions.activeTools(session).declared;
			// 一次运行的工具链：两个闸门、解析与执行，全部是编排层递进来的回调（ADR-0023）。批处理
			// 机件是文件级的、不持有会话，所以运行把自己需要的接缝递给它们。声明数组随每次请求的
			// 答案在下面换入。
			let chain: ToolChain = {
				sessionId: session.sessionId,
				declared,
				executeTool: loopOptions.executeTool,
				decideBeforeTool: loopOptions.decideBeforeTool,
				decideAfterTool: loopOptions.decideAfterTool,
			};
			let currentContext: Context = {
				messages: [...loopOptions.contextMessages(session)],
				// 声明数组的副本：context 携带的是传输层声明用的实例，元素同一（ADR-0016），数组本身
				// 每次请求新建。
				tools: [...declared],
			};

			await emit({ type: "agent_start" });

			// 恢复遍（ADR-0006 §5）：context 里没有工具结果回答的调用会让第一个请求非法，所以每次运行
			// 都在自己的第一轮之前关闭它找到的东西——grant 重跑该调用，deny 与孤儿得到合成的结果。
			// 这里若 suspend（本次运行据以恢复的 grant 没有真正过闸门）则在任何请求之前结束运行。
			let suspendedAtEntry = false;
			const dangling = danglingToolCallsOf(currentContext.messages);
			if (dangling.length > 0) {
				const recovered = await recoverPendingToolCalls(
					dangling,
					{ answers: start.answers },
					chain,
					run,
					signal,
					emit,
				);
				for (const message of recovered.messages) {
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				suspendedAtEntry = recovered.suspended === true;
			}
			if (suspendedAtEntry) {
				// 恢复遍重跑了被 grant 的调用而闸门再次拒绝，所以这次运行以与上一次相同的方式结束
				// ——并为相同的理由留住队列。
				live.suspended = true;
				await emit({ type: "agent_end", messages: newMessages });
				return newMessages;
			}

			// 运行的 prompt 占据第一个取走点：每一轮——包括第一轮——都是 `turn_start`，然后一次
			// drain，然后一个请求。恢复的运行没有 prompt；它恢复出的结果已在 context 里。steer 在每轮
			// 结尾轮询，所以 steer 消息最早也是在第一个响应之后浮现。
			let pendingMessages: Message[] = start.prompt === undefined ? [] : [start.prompt];

			// 外层循环：agent 本要停下之后又来了排队的 follow-up 消息时继续。
			while (true) {
				let hasMoreToolCalls = true;
				// 闸门挂起一个批时置位：运行在那一轮结束，在取走点之前。
				let suspended = false;

				// 内层循环：处理工具调用与 steer 消息。
				while (hasMoreToolCalls || pendingMessages.length > 0) {
					await emit({ type: "turn_start" });

					// 下一个 assistant 响应之前处理排队的消息。运行自己的 prompt 在第一轮在这里排空，
					// 正是 steer 消息在更晚轮次排空的位置。
					for (const message of pendingMessages) {
						await emit({ type: "message_start", message });
						await emit({ type: "message_end", message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					pendingMessages = [];

					// 按请求的填充链（ADR-0006 §2）：收养实时的行，记录选择，把账本重放成视图，超窗则
					// 压缩，用实时的工具与审批答案构建 prompt，交回请求——在这里构建、用一次、丢弃。
					const requestUpdate = await this.prepareRequest(loopOptions, transport, currentContext, signal, state, session);
					if (requestUpdate) {
						currentContext = requestUpdate.context ?? currentContext;
						model = requestUpdate.model ?? model;
						// 本次请求声明过的数组替换上一轮的，所以这条答案携带的调用按模型刚被告知的集合
						// 判断。可选的形式是 update 其余部分的：不在场的字段留下运行已有的东西。两者都在
						// `prepareRequest` 之后读取——用户在两轮之间挪动的集合在下一个答案上生效，绝不
						// 作用于已经在飞的调用。
						chain = { ...chain, declared: currentContext.tools };
						// 这个请求发出时所用的模型，正是运行期间拍下的快照该报告的、表计用来量答案的。
						live.model = model;
					}

					// 请求构建期间运行可能被砍短——来自 `close()` 的 abort、来自窗口的 stop——而
					// `prepareRequest` 有自己的 await（一次压缩摘要、从盘上读的项目指示）。在那之后发出的
					// 请求会走上一条已死的 signal：它返回的任何东西都用不上，而传输层对已中止的调用如何
					// 应答全凭它高兴。在这里结束，与流中途被 abort 的结束相同，只是早到一步。
					if (signal?.aborted === true) throw signal.reason ?? new Error("The run was aborted");

					// 流式读取 assistant 响应。
					const message = await streamAssistantResponse(currentContext, model, signal, emit);
					newMessages.push(message);

					if (message.stopReason === "error" || message.stopReason === "aborted") {
						await emit({ type: "turn_end", message, toolResults: [] });
						await emit({ type: "agent_end", messages: newMessages });
						return newMessages;
					}

					const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");

					const toolResults: ToolResultMessage[] = [];
					hasMoreToolCalls = false;
					if (toolCalls.length > 0) {
						// "length" 停止意味着输出被 token 上限截断，消息里的每个工具调用都可能带着被截断
						// 的参数。全部判失败，而不是执行可能已损坏的调用。
						const executedToolBatch =
							message.stopReason === "length"
								? await failToolCallsFromTruncatedMessage(toolCalls, emit)
								: await executeToolCalls(message, chain, run, signal, emit);
						toolResults.push(...executedToolBatch.messages);
						hasMoreToolCalls = !executedToolBatch.terminate;
						suspended = executedToolBatch.suspended === true;
						if (suspended) live.suspended = true;

						for (const result of toolResults) {
							currentContext.messages.push(result);
							newMessages.push(result);
						}
					}

					await emit({ type: "turn_end", message, toolResults });

					// 被挂起的批在此结束运行：取走点被跳过，所以没有任何新东西被取进闸门已经停下的运行
					// ——被接受的等在队列上、由调用方的运行末尾清扫写出，而对挂起调用的答案从任何运行
					// 之外抵达、启动下一次运行。
					if (suspended) break;

					pendingMessages = await this.drainTranscribed(loopOptions, live.steeringQueue, state, session);
				}

				// 挂起连同运行的 follow-up 侧一起结束：排队的消息从未被取走，会回答它们的运行已经结束。
				if (suspended) break;

				// 运行本要在这里停下。取走 follow-up 队列里的一切。
				const followUpMessages = await this.drainTranscribed(loopOptions, live.followUpQueue, state, session);
				if (followUpMessages.length > 0) {
					// 置为 pending，让内层循环处理它们。
					pendingMessages = followUpMessages;
					emitQueueUpdate(state);
					continue;
				}

				break;
			}

			await emit({ type: "agent_end", messages: newMessages });
			return newMessages;
		} catch (error) {
			// 引擎自身错误编码之外的一次抛出——引擎里的 bug，或逃出了自己处理的落盘——仍以完整的
			// 事件流浮现，让订阅者看到终态。
			await this.handleRunFailure(emit, model, error, signal.aborted);
			return [];
		} finally {
			this.finishRun(state);
		}
	}

	/**
	 * 把一次运行死于其上的失败写成消息，并用它关闭运行的事件流。
	 *
	 * 消息是合成的而不是被报告的：抛出的运行没有 assistant 消息可指，而只见过 `agent_end` 的订阅者
	 * 将无从得知为什么什么都没回来。点名的模型是最后一个请求所用的那个。
	 */
	private async handleRunFailure(
		emit: AgentEventSink,
		model: Model,
		error: unknown,
		aborted: boolean,
	): Promise<void> {
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			model: model.id,
			usage: NO_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies Message;
		await emit({ type: "message_start", message: failureMessage });
		await emit({ type: "message_end", message: failureMessage });
		await emit({ type: "turn_end", message: failureMessage, toolResults: [] });
		await emit({ type: "agent_end", messages: [failureMessage] });
	}

	/** 安顿运行：唤醒空闲等待者睡在其上的 promise，然后交出槽位。 */
	private finishRun(state: AgentState): void {
		state.live.activeRun?.resolve();
		state.live.activeRun = undefined;
	}

	/**
	 * 从账本到请求对象的按请求填充链。
	 *
	 * 顺序：模型从实时的行重新派生（一次编辑无需重开任何东西即生效），记录本次请求所用的选择——每次
	 * 挪动恰好一条 entry，所以从未随消息发出的选择不在文件里——账本被重放成视图，视图超出本模型的
	 * 窗口则压缩，prompt 由实时的工具与审批答案构建，整体作为本轮发送的唯一请求对象返回。这里没有
	 * 任何东西活得比请求久。
	 */
	private async prepareRequest(
		loopOptions: LoopOptions,
		transport: ChatTransport,
		context: Context,
		signal: AbortSignal | undefined,
		state: AgentState,
		session: Session,
	): Promise<AgentRequestUpdate> {
		// 本次请求所用的模型，在任何东西读它之前从实时行构建，因为下面的压缩决策是按它的上下文窗口
		// 计量的，而从片刻之前的窗口取的阈值会压缩错 transcript。这正是「一次编辑无需重开任何东西即
		// 生效」的全部：端点、wire id、窗口、密钥在这里、从目录读，从不在会话装配时捕获。消失的行
		// ——被删的，或在正被使用时改名的——让选择保持原样，替它作答的是 `unconfiguredStream`。
		const catalog = loopOptions.modelCatalog();
		const choice = loopOptions.modelChoice(session, state.live.openedOn);
		const model = modelFor(choice, catalog, transport);
		// 本次请求所用的选择在这里、在由它构建请求的时刻抵达 transcript——从未说过话的会话由它服务的
		// 第一个请求记录。它跑在下面的压缩决策之前，后者按本模型的窗口计量 prompt。
		loopOptions.recordSelection(session, catalog, choice);
		// 一趟决定请求携带什么、以及是否必须摘要：触发器、过期工具结果的清理、摘要读的都是同一批
		// entry，所以决策与请求不可能对 prompt 有多大各执一词。
		const entries = await this.compactFor(
			loopOptions,
			state,
			session,
			loopOptions.contextEntries(session),
			Date.now(),
			signal,
			model,
		);
		// prompt 在这里重建、不被记住：`applyConfig` 能挪审批集、`setActiveTools` 能挪工具集，而模型
		// 必须在下一个请求上被告知两者。两者都在此刻从账本派生，所以刚落下的选择就是 prompt 描述的
		// 东西。
		const toolFace = loopOptions.activeTools(session);
		// 项目指示在这里、按请求读取，而不是从状态上取：磁盘文件的一次编辑应当抵达下一个请求，与
		// 模型行的一次编辑相同，而这段走读只是几次 stat。它的代价是一段 prompt 可能在同一次运行的
		// 两个请求之间变化——工具集出于同样的理由已经如此。
		const agentsMd = await loadAgentsMd(session.sessionSetting.workDirAbsPath);
		const prompt = loopOptions.systemPrompt(
			session.sessionSetting.workDirAbsPath,
			agentsMd,
			toolFace.names,
			loopOptions.approvals(session),
		);
		// 请求携带的工具结果按重放侧读取（`contextEntries` 已应用账本自己的视图记录），所以没有
		// 按请求对它们的另一次遍历：账本里的工具结果已经是喂给模型的那个版本。
		const injected = { sessionId: session.sessionId, messages: messagesOf(entries), systemPrompt: prompt };
		const rewritten = await loopOptions.rewriteContext(injected);
		// 开头的 system 消息被替换而不是追加，其余 system 消息被丢弃：prompt 在本次请求上整体重建，
		// 第二条会描述一个已经不存在状态。想改 prompt 的 hook 返回 `systemPrompt`；往 `messages` 里
		// push system 消息的 hook 会在这里失去它。
		const system = createSystemMessage(rewritten?.systemPrompt ?? injected.systemPrompt);
		// 压缩检查点已经是它所代表的那个 user 轮次——`sessionEntryToContextMessages` 把摘要包进标签
		// ——所以 transcript 原样交给供应商。
		const conversation = pairLateToolResults((rewritten?.messages ?? injected.messages).filter((message) => message.role !== "system"));
		return {
			// 在上面构建，来自本次请求所用的行：运行局部、用一次、丢弃。
			model,
			context: {
				...context,
				messages: system === undefined ? conversation : [system, ...conversation],
				// 本次请求声明的工具数组，元素是表自己的实例（ADR-0016）。引擎把声明放在请求上
				// （`toToolDeclaration`）而不是从 transcript 里读，所以会话中途开启的工具在下一次请求
				// 上抵达模型；执行链对着同一个数组按名解析，两者不可能漂移。
				tools: [...toolFace.declared],
			},
		};
	}

	/**
	 * 这次运行的工具被调用时所用的值对象：从会话自己的 setting 上读的工作目录，以同样方式从设置上读
	 * 的 bash 超时。每次运行收集一次、由它发出的每次调用携带——这里没有任何东西活得比读它的那次
	 * 运行久。
	 */
	private runContext(loopOptions: LoopOptions, session: Session): ToolRunContext {
		const workDirAbsPath = session.sessionSetting.workDirAbsPath;
		return {
			workDirAbsPath,
			// 实时读取，与其他每次设置读取一样：用户挪过的超时抵达下一次运行的调用，无需重开任何东西。
			bash: loopOptions.bashSettings(workDirAbsPath),
		};
	}

	/**
	 * 让一次供应商调用走一遍重试策略，把它泵进引擎读取的那条流。
	 *
	 * 重试住在传输层、引擎之下，因为错误应答是一条硬出口：流以 `stopReason: "error"` 结束的那一刻
	 * 引擎就发出 `turn_end` 与 `agent_end` 并返回，不存在一个更晚的轮次可供改写失败的 assistant
	 * 消息。在引擎之下，失败的尝试根本不是消息：transcript 恰好获得一条 assistant 消息，store 不留
	 * 任何失败，下一个请求没有需要解释的遗留错误。
	 *
	 * `retryAssistantCall` 拥有分类、退避与 abort 规范化——睡梦中被中止会变成 aborted 消息——所以
	 * 这里既不数次数也不睡觉。它要 `() => Promise<AssistantMessage>`，所以每次尝试在这里被抽干、
	 * 它的事件随到随转发；只有终局事件在尝试之后裁决，因为决定这次尝试是不是引擎能保住的那一次的，
	 * 正是它。
	 *
	 * 引擎必须只见到一次 `start`：重试时失败的尝试已经往它的 context 放了一条 partial 消息，第二个
	 * `start` 会追加第二条 assistant 消息而不是替换被弃的那条。所以每个请求 `start` 只转发一次，
	 * 重试尝试的 delta 原地覆写同一个槽位。
	 */
	private async pumpAttempts(
		loopOptions: LoopOptions,
		state: AgentState,
		session: Session,
		outer: AssistantMessageEventStream,
		model: Model,
		context: Context,
		options: SimpleStreamOptions | undefined,
	): Promise<void> {
		const { api } = loopOptions;
		const live = state.live;
		let started = false;
		const produce = async (): Promise<AssistantMessage> => {
			// 没有行的会话没有可发送的东西，所以它以一句「该做什么」作答，而不是向占位端点发请求。
			const inner =
				loopOptions.modelCatalog().find((userModel) => userModel.name === model.name) === undefined
					? unconfiguredStream(model)
					: await api.stream(model, context, options);
			for await (const event of inner) {
				if (event.type === "done" || event.type === "error") continue;
				if (event.type === "start") {
					if (started) continue;
					started = true;
				}
				outer.push(event);
			}
			const message = await inner.result();
			if (message.stopReason === "error" && isContextOverflow(message, model.contextWindow)) {
				// 上下文溢出是压缩的问题、绝非瞬时的：在重试循环把它归类成值得再试的东西之前就拦住它。
				throw new ContextOverflow(message);
			}
			return message;
		};

		// 整个泵读一次：重试循环执行的策略与 `retry_start` 事件报告的 `maxAttempts` 是同一个答案，在
		// 调用点取而不是存起来——退避中途的设置编辑随下一个请求落地，而不是这一次。计数方式与
		// `retryAssistantCall` 自己的一致：数重试，不数调用。
		const retrySettings = loopOptions.retrySettings(session.sessionSetting.workDirAbsPath);
		const maxAttempts = retrySettings.enabled ? retrySettings.maxRetries : 0;
		let final: AssistantMessage;
		try {
			final = await retryAssistantCall(
				produce,
				retrySettings,
				options?.signal,
				this.retryCallbacks(loopOptions, state, session, maxAttempts),
			);
		} catch (error) {
			// 抛异常的流函数破坏了引擎的契约，所以在这里落成一条错误消息，而不是一个没人接的 rejected
			// promise。
			final = error instanceof ContextOverflow ? error.message : failureMessage(model, error);
		}
		// 策略从未宣布结束的重试——运行在上方被砍短——仍要收口，否则 `isRetrying` 会活得比运行久。
		if (live.retrying) this.endRetry(loopOptions, state, session, false, live.retryAttempt, final.errorMessage);
		pushTerminal(outer, final);
		outer.end();
	}

	/**
	 * `retryAssistantCall` 发出的三个通知，一一映射到会话事件。
	 *
	 * `maxAttempts` 由泵递入——这次运行的重试所依据的对策略的唯一一次读取——因为策略为 `retry_start`
	 * 调用的回调不自带策略，这里也不在事件之间存那个答案。
	 */
	private retryCallbacks(loopOptions: LoopOptions, state: AgentState, session: Session, maxAttempts: number): RetryCallbacks {
		const live = state.live;
		return {
			onRetryScheduled: (attempt, scheduledMax, delayMs, errorMessage) => {
				live.retrying = true;
				live.retryAttempt = attempt;
				emitEvent(state, {
					type: "retry_scheduled",
					attempt,
					maxAttempts: scheduledMax,
					delayMs,
					errorMessage,
				});
				loopOptions.publish(state, session);
			},
			onRetryAttemptStart: () => {
				emitEvent(state, {
					type: "retry_start",
					attempt: live.retryAttempt,
					maxAttempts,
				});
				loopOptions.publish(state, session);
			},
			onRetryFinished: (success, attempt, finalError) =>
				this.endRetry(loopOptions, state, session, success, attempt, finalError),
		};
	}

	/** 退出重试状态，说明重试是如何结束的。 */
	private endRetry(
		loopOptions: LoopOptions,
		state: AgentState,
		session: Session,
		success: boolean,
		attempt: number,
		finalError?: string,
	): void {
		state.live.retrying = false;
		state.live.retryAttempt = 0;
		emitEvent(state, { type: "retry_end", success, attempt, finalError });
		loopOptions.publish(state, session);
	}

	// ---------------------------------------------------------------------------- 压缩

	/**
	 * 在下一个请求之前收缩上下文，以该请求应携带的 entry 作答。
	 *
	 * 三步，最便宜的先行。触发器是本会话自己模型的窗口减去一个固定储备，所以同一份 transcript 在小
	 * 窗口模型下压缩、在大窗口模型下不压。触发后，重型工具被记录的参数先被截短——`write` 或 `edit`
	 * 携带的正文已经活在它们改过的文件里，把它们从视图里丢掉不花任何东西、也不花任何请求。然后，若
	 * 供应商大概已忘记缓存，把可重取的结果清空——一小时没有请求，意味着 prompt 正在被全额付费，而
	 * 工具能复现的东西是仅次于最便宜的损失。只有这样仍不够，才把 transcript 折成摘要，那要花一次
	 * 请求；除进行中的那一轮外什么都不逐字保留。
	 *
	 * 摘要之前的两步都是*被记录的*，不留在内存里：`appendTrimToolCallArgs` 与 `appendClearToolResults`
	 * 点名那些 entry，store 自己的视图从此施加它们。于是恢复的进程、运行中的下一个请求、窗口读到的
	 * 都是同一份 transcript，而不是各判各的。
	 *
	 * 造不出的摘要让 transcript 原封不动、以报告而非抛出收场：压缩是一项优化，为它失败一轮，会把
	 * 一个清晰的上下文溢出错误换掉成请求路径内部的一场莫名崩溃。
	 *
	 * 返回要发送的 entry：没有任何一步改变东西时是原样进来的那些，走完足够的一步后是 store 的视图，
	 * 写过检查点后仍是那个视图。计数由 `tool_call_args_trimmed`、`tool_results_cleared` 与
	 * `compaction` 事件报告，不由这个答案报告。
	 */
	private async compactFor(
		loopOptions: CompactCallbacks,
		state: AgentState,
		session: Session,
		entries: readonly SessionEntry[],
		now: number,
		signal: AbortSignal | undefined,
		model: Model,
	): Promise<readonly SessionEntry[]> {
		const threshold = compactionThresholdFor(model.contextWindow);
		if (!shouldCompact(messagesOf(entries), threshold)) return entries;

		const trimmed = this.trimRecordedArgs(loopOptions, state, session, entries);
		if (!shouldCompact(messagesOf(trimmed), threshold)) return trimmed;

		const cleared = this.clearStaleToolResults(loopOptions, state, session, trimmed, now);
		if (!shouldCompact(messagesOf(cleared), threshold)) return cleared;

		// 压缩唯一完成的一件事：与那一轮相同的模型，带着摘要指令。它是调用方的模型——本次请求构建所
		// 用的那一个——所以摘要携带与它所概括的对话相同的密钥、端点与窗口，而不是另起一份配置。
		const summarize: Summarize = async (request) => {
			// 与一轮会碰到的同一个缺席：没有行的会话以一句「该加什么」作答，而不是向占位端点发摘要
			// 请求。
			if (loopOptions.modelCatalog().find((userModel) => userModel.name === model.name) === undefined) {
				return unconfiguredStream(model).result();
			}
			const messages: Message[] = [
				{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() },
			];
			return model
				.stream({ messages, system: createSystemMessage(request.systemPrompt), tools: [] }, {
					// 行的密钥，在这里说出而不是只由模型携带：这是唯一不经引擎的一次调用，而把密钥抄进
					// options 的正是引擎。
					apiKey: model.apiKey,
					maxTokens: request.maxTokens,
					// 一次性的摘要不会再发第二次，为它付缓存的费用买不到任何东西。
					cacheRetention: "none",
					...(request.signal === undefined ? {} : { signal: request.signal }),
				})
				.result();
		};

		let outcome;
		try {
			outcome = await compactTranscript(cleared, model, summarize, signal);
		} catch (error) {
			// abort 不是压缩失败：运行正在结束，transcript 简单地保留它已有的历史。其余的值得大声说
			// 出来，因为下一个请求可能就是溢出的那一个。
			if (signal?.aborted !== true) {
				emitEvent(state, {
					type: "compaction_failed",
					message: error instanceof Error ? error.message : String(error),
				});
			}
			return cleared;
		}
		if (!outcome) return cleared;

		loopOptions.appendCompaction(
			session,
			outcome.summary,
			outcome.firstKeptEntryId,
			outcome.tokensBefore,
			outcome.usage,
		);
		// 在 transcript 移动之后发布，让作出反应的监听者读回相同的数字：`summarized` 是这一趟折进去
		// 的东西，`contextTokens` 是供应商接下来将收到的东西。
		const compacted = loopOptions.contextEntries(session);
		emitEvent(state, {
			type: "compaction",
			summary: outcome.summary,
			firstKeptEntryId: outcome.firstKeptEntryId,
			summarized: outcome.summarized,
			tokensBefore: outcome.tokensBefore,
			contextTokens: estimateTokens(messagesOf(compacted)),
		});
		return compacted;
	}

	/**
	 * 截短重型工具被记录的参数，并记录这件事。
	 *
	 * 这是压缩里最便宜的一步：不发请求、不用等时钟——`write` 或 `edit` 携带的正文已经落在它们改过的
	 * 文件里，视图丢掉它们不会失去机器不持有的任何东西。这也是它跑在清理之前、而不是与它并列的原因
	 * ：清理要有过期的缓存才值得它的缓存失效，而这不需要——当 transcript 超过触发线时，无论缓存
	 * 怎么说，下一个请求都已在麻烦之中。
	 */
	private trimRecordedArgs(
		loopOptions: CompactCallbacks,
		state: AgentState,
		session: Session,
		entries: readonly SessionEntry[],
	): readonly SessionEntry[] {
		const trimmed = trimmableToolArgEntryIds(entries);
		if (trimmed.length === 0) return entries;

		const tokensBefore = estimateTokens(messagesOf(entries));
		loopOptions.appendTrimToolCallArgs(session, trimmed, tokensBefore);
		const view = loopOptions.contextEntries(session);
		emitEvent(state, {
			type: "tool_call_args_trimmed",
			trimmed: trimmed.length,
			tokensBefore,
			contextTokens: estimateTokens(messagesOf(view)),
		});
		return view;
	}

	/**
	 * 当供应商大概已丢弃缓存时，清掉可重取的东西，并记录这件事。
	 *
	 * 温热的缓存正是不这么做的理由：重写供应商已经读过的 prompt 中段，代价超过它省下的 token——
	 * 这正是摘要（一次有意为之、把 transcript 永久缩小的失效）成为温热 transcript 的答案的原因。
	 */
	private clearStaleToolResults(
		loopOptions: CompactCallbacks,
		state: AgentState,
		session: Session,
		entries: readonly SessionEntry[],
		now: number,
	): readonly SessionEntry[] {
		if (!isCacheProbablyExpired(entries, now)) return entries;

		const cleared = clearableToolResultIds(entries);
		if (cleared.length === 0) return entries;

		const tokensBefore = estimateTokens(messagesOf(entries));
		loopOptions.appendClearToolResults(session, cleared, tokensBefore);
		const view = loopOptions.contextEntries(session);
		emitEvent(state, {
			type: "tool_results_cleared",
			cleared: cleared.length,
			tokensBefore,
			contextTokens: estimateTokens(messagesOf(view)),
		});
		return view;
	}

	/**
	 * 对袋点名的会话跑压缩阶梯——编排层 `maybeCompact` 的转交入口。
	 *
	 * 填充链在每个请求里、循环内部跑同样三步；这个公开形状让编排层可以对着自己点名的会话驱动它们，
	 * 演练修剪阶梯的 smoke 正是这么做的。模型在这里现算：从袋上的 `modelChoice` / `modelCatalog`
	 * 两个回调按会话现行的选择派生，编排层只递 {@link CompactOptions} 的 Pick 链（ADR-0023）。
	 */
	async compact(loopOptions: CompactOptions): Promise<readonly SessionEntry[]> {
		const { state, bag, transport } = loopOptions;
		const model = modelFor(
			loopOptions.modelChoice(bag, state.live.openedOn),
			loopOptions.modelCatalog(),
			transport,
		);
		return this.compactFor(loopOptions, state, bag, loopOptions.entries, loopOptions.now, loopOptions.signal, model);
	}

	// ---------------------------------------------------------------------------- 运行的事件半

	/**
	 * 排空一条队列，把每条消息在取走的那一刻写进 transcript。
	 *
	 * 写搭在 drain 上、而不是搭在引擎的回显上：把消息从队列上拿下来，正是运行对它担起责任的时刻，
	 * 所以账本在那里获得它，「既不在队列里也不在存储里」的缝隙永远不会打开。回显从不落盘 user 消息，
	 * 所以没有什么需要被标记为已写。
	 */
	private drainTranscribed(loopOptions: LoopOptions, queue: PendingMessageQueue, state: AgentState, session: Session): Message[] {
		const messages = queue.drain();
		for (const message of messages) {
			loopOptions.appendMessage(state, session, message);
		}
		return messages;
	}
}

// ---------------------------------------------------------------------------- 引擎机件
//
// 下面的一切都是无状态的：一轮的流、一个工具批、恢复遍，以及它们之间传递的形状。它在任何实例之外
// 运行，把两个工具调用闸门当作运行自己的那对回调（{@link ToolChain}），这正是它是一组函数而不是
// 更多方法的原因。恢复机件被导出，因为它是 smoke 直接驱动的契约（ADR-0006 §5）；其余为本文件私有。

/** 一次运行的事件去向。被 await，所以运行只在它发出的东西被处理完之后才安顿。 */
type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * 一次运行的工具链：两个闸门、解析与执行，全部是编排层递进来的回调（ADR-0023）。
 *
 * 批处理机件是文件级的、不持有会话，所以运行把自己需要的接缝递给它们——与这条链上处处一样以实参
 * 抵达，不经过 context。解析只对着 `declared` 按名查：调用只能落到本请求声明过的工具上（ADR-0016
 * 的表不动，消掉的只是 loop 对表的可见性）。
 */
export interface ToolChain {
	/** 运行所在会话的 id：闸门事件点名它。 */
	sessionId: string;
	/** 本次请求声明过的工具：解析所依据的声明数组，元素是表自己的实例。 */
	declared: readonly Tool<any>[];
	/** 运行一次工具调用：`ToolManager.execute` 的动词化。 */
	executeTool: LoopOptions["executeTool"];
	/** 工具调用之前的裁决。 */
	decideBeforeTool: LoopOptions["decideBeforeTool"];
	/** 工具结果上的裁决。 */
	decideAfterTool: LoopOptions["decideAfterTool"];
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
	/**
	 * 闸门挂起了这个批：它停下的那个调用与其后的每个调用都没有结果，运行不再发请求就结束——闸门
	 * 等的答案从任何运行之外抵达，宿主经一次恢复运行续上这些调用。
	 */
	suspended?: boolean;
};

/**
 * 一个过了闸门与 schema 的调用：跑什么、用哪些参数。
 *
 * 它点名工具并携带参数；不携带工具对象。执行时名字经 {@link ToolChain.executeTool} 到表上再解析
 * 一次，所以跑的是表的实例而不是早先取到的引用（表是只增的，两者本就是同一对象——`ToolManager`
 * 自己的 `execute`，ADR-0016）。
 */
type PreparedToolCall = {
	kind: "prepared";
	toolCall: ToolCall;
	args: unknown;
};

type SuspendedToolCall = {
	kind: "suspended";
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: ToolResult<unknown>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: ToolResult<unknown>;
	isError: boolean;
};

type ToolUpdateSink = (partialResult: ToolResult<unknown>) => Promise<void> | void;

type FinalizedToolCallEntry = ToolCallOutcome | (() => Promise<ToolCallOutcome>);

/**
 * 从模型流式读取一条 assistant 响应，进 transcript、出 sink。
 *
 * 模型自带传输层——运行那个包着重试的——所以这里问的是被递入的模型，请求以该模型携带的密钥认证。
 * 工具作为参数、而不是作为消息抵达请求，所以这次请求提供的集合在这里声明：`toToolDeclaration`
 * 保留名字、描述与 schema，丢掉其余。system prompt 留在调用方放它的地方——开头的 system 消息——
 * 请求不带显式 `system` 时传输层从那里读。
 */
async function streamAssistantResponse(
	context: Context,
	model: Model,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<AssistantMessage> {
	const requestContext: Context = {
		messages: context.messages,
		tools: context.tools.map((tool) => toToolDeclaration(tool)),
	};

	const response = await model.stream(requestContext, {
		apiKey: model.apiKey,
		signal,
	});
	// 记录被要求的档位，无论哪个流函数作了答。从请求所用的模型上读，所以 transcript 不会报告一个
	// wire 从未携带过的强度。是 thunk 而不是值：流被抽干之后才有最终消息，下面两个出口都在循环见过
	// 终局事件之后要它。
	const settled = async () =>
		Object.assign(await response.result(), { thinkingLevel: model.thinkingLevel ?? "off" });

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await settled();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await settled();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * 判一条被输出 token 上限截断的 assistant 消息里所有工具调用失败。
 *
 * 流式工具调用参数由尽力而为的 JSON 抢救解析器定稿，所以被截断的消息可能给出参数能解析、能过校验、
 * 但暗中不完整的工具调用。它们没有一个可以安全执行；逐个报错，让模型重新发出。
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: ToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: ToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/** transcript 仍在等的一个工具调用：调用块，与发出它的那条消息。 */
export type DanglingToolCall = {
	toolCall: ToolCall;
	assistantMessage: AssistantMessage;
};

/**
 * 一个运行可凭这个名字调用的实例，前提是本请求声明过它。
 *
 * 解析只对着 {@link ToolChain.declared} 按名查——「模型被告知什么与它可以运行什么」的不变量更硬：
 * 调用只能解析到本请求声明过的工具。声明的元素是表自己的实例（ADR-0016），所以这里拿到的与
 * `ToolManager.execute` 内部解析到的是同一个对象。`undefined` 是两个调用方都当作「不是本次运行会
 * 做的调用」的答案：一个以未知名字一贯得到的那条错误关闭它，另一个让它的模式不参与批的调度决策。
 */
function declaredToolOf(declared: readonly Tool<any>[], name: string): Tool<any> | undefined {
	return declared.find((tool) => tool.name === name);
}

/**
 * context 里没有工具结果消息回答的工具调用，按 transcript 顺序。
 *
 * 调用悬空，是它的运行在结果落地之前就结束——一场崩溃，或结束重启的审批闸门，它有意让自己停下的
 * 调用无人回答。无论哪种，携带它的供应商请求都是非法的，这正是每次运行都在第一个请求之前关闭它
 * 找到的东西的原因。
 */
export function danglingToolCallsOf(messages: Message[]): DanglingToolCall[] {
	const calls: DanglingToolCall[] = [];
	const answered = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			answered.add(message.toolCallId);
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			calls.push({ toolCall: block, assistantMessage: message });
		}
	}
	return calls.filter(({ toolCall }) => !answered.has(toolCall.id));
}

/**
 * 在第一个请求之前，关闭运行带着进来的悬空调用。
 *
 * 结束重启架构的恢复机件（ADR-0006 §5）：答案用它自己关闭调用——grant 让调用走与活跃批相同的步骤
 * 重跑（闸门、校验、执行、`afterToolCall`），所以恢复的调用与模型刚发出的无从区分；deny 合成它的
 * reason 点名的结果。没有答案点名的调用，在 `enablePendingToolRecovery` 允许时以合成的错误结果
 * 关闭。每个被关闭的调用发出活跃批中的对应者会发出的事件，所以窗口与 store 获知它的方式与其他
 * 工具结果一样。
 *
 * 恢复中途再次挂起的闸门——本次运行据以恢复的 grant 并未真正过闸——让恢复原地停下：其余调用保持
 * 悬空、调用方不发请求结束运行，恰如活跃批的 suspend。
 *
 * 导出，因为它是引擎里宿主可以不用一次运行就驱动的唯一部分：钉住这份契约的 smoke 用一组悬空调用、
 * 一组答案、与一次运行的工具链调用它——没有编排层、没有自己的运行。恢复本身是一次运行，所以闸门、
 * 解析与执行像这条链上处处一样以 {@link ToolChain} 抵达：不经过 context。
 */
export async function recoverPendingToolCalls(
	dangling: DanglingToolCall[],
	recovery: RunRecoveryOptions | undefined,
	chain: ToolChain,
	run: ToolRunContext,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const answers = recovery?.answers ?? {};
	const enabled = recovery?.enablePendingToolRecovery !== false;
	const messages: ToolResultMessage[] = [];

	for (const { toolCall } of dangling) {
		const answer = answers[toolCall.id];
		if (answer !== undefined && answer.approved) {
			const preparation = await prepareToolCall(chain, toolCall, signal);
			if (preparation.kind === "suspended") {
				return { messages, terminate: true, suspended: true };
			}
			await emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});
			let finalized: ToolCallOutcome;
			if (preparation.kind === "immediate") {
				finalized = { toolCall, result: preparation.result, isError: preparation.isError };
			} else {
				const executed = await executePreparedToolCall(
					preparation,
					chain,
					run,
					signal,
					emitToolExecutionUpdate(toolCall, emit),
				);
				finalized = await finalizeExecutedToolCall(preparation, executed, chain);
			}
			await emitToolExecutionEnd(finalized, emit);
			const toolResultMessage = createToolResultMessage(finalized);
			await emitToolResultMessage(toolResultMessage, emit);
			messages.push(toolResultMessage);
			continue;
		}
		// 关掉开关是宿主亲自接管这些调用：它们原样发给供应商，这里不为它们合成任何东西。
		if (answer === undefined && !enabled) continue;
		const text =
			answer !== undefined
				? answer.reason ?? `The user denied permission to run ${toolCall.name}.`
				: `Tool call "${toolCall.name}" was left unanswered: the run that issued it ended before a result landed. Issue the call again if it is still needed.`;
		messages.push(await synthesizeToolResult(toolCall, text, emit));
	}
	return { messages, terminate: true };
}

/** 用合成的错误结果关闭一个未答调用，带上活跃批会带的事件。 */
async function synthesizeToolResult(
	toolCall: ToolCall,
	text: string,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	await emit({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});
	const finalized: ToolCallOutcome = {
		toolCall,
		result: createErrorToolResult(text),
		isError: true,
	};
	await emitToolExecutionEnd(finalized, emit);
	const toolResultMessage = createToolResultMessage(finalized);
	await emitToolResultMessage(toolResultMessage, emit);
	return toolResultMessage;
}

/**
 * 执行一条 assistant 消息发出的工具调用：其中任何一个如此说时就串行，否则并行。两条路径都按源顺序
 * 准备调用、把结果写成消息。
 *
 * 模式从声明的实例上读：一个调用的行为是工具的属性，而实例是本请求声明过的东西（ADR-0023 的解析
 * 不变量）。只为本次运行可调用的调用读它——会话已关掉的名字在开始之前就以错误作答，否则让它的模式
 * 参与调度，会让整批围绕一个永不运行的调用安排（一个被禁用的 `bash` 把读批变成串行，正是让它成为
 * 一个判断而非一次查找的案例）。
 */
async function executeToolCalls(
	assistantMessage: AssistantMessage,
	chain: ToolChain,
	run: ToolRunContext,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((block): block is ToolCall => block.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => declaredToolOf(chain.declared, tc.name)?.executionMode === "sequential",
	);
	if (hasSequentialToolCall) {
		return executeToolCallsSequential(assistantMessage, toolCalls, chain, run, signal, emit);
	}
	return executeToolCallsParallel(assistantMessage, toolCalls, chain, run, signal, emit);
}

async function executeToolCallsSequential(
	assistantMessage: AssistantMessage,
	toolCalls: ToolCall[],
	chain: ToolChain,
	run: ToolRunContext,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: ToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		// 在被通告之前准备：被挂起的调用从不被通告——闸门在它那里结束了运行，不写结果，事件保持
		// 沉默，窗口不会为一个从未运行的调用显示卡片。该调用与批中它之后的一切保持未答。
		const preparation = await prepareToolCall(chain, toolCall, signal);
		if (preparation.kind === "suspended") {
			return { messages, terminate: true, suspended: true };
		}
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		let finalized: ToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(
				preparation,
				chain,
				run,
				signal,
				emitToolExecutionUpdate(toolCall, emit),
			);
			finalized = await finalizeExecutedToolCall(preparation, executed, chain);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	assistantMessage: AssistantMessage,
	toolCalls: ToolCall[],
	chain: ToolChain,
	run: ToolRunContext,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];
	let suspended = false;

	for (const toolCall of toolCalls) {
		// 与串行路径一样在被通告之前准备：被挂起的调用得不到事件也得不到结果，其后的调用也不再准备。
		// 上面已排队的调用跑完自己——闸门作答时它们已在途中。
		const preparation = await prepareToolCall(chain, toolCall, signal);
		if (preparation.kind === "suspended") {
			suspended = true;
			break;
		}
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies ToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			if (signal?.aborted) {
				const finalized = {
					toolCall,
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				} satisfies ToolCallOutcome;
				await emitToolExecutionEnd(finalized, emit);
				return finalized;
			}
			const executed = await executePreparedToolCall(
				preparation,
				chain,
				run,
				signal,
				emitToolExecutionUpdate(toolCall, emit),
			);
			const finalized = await finalizeExecutedToolCall(preparation, executed, chain);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: suspended || shouldTerminateToolBatch(orderedFinalizedCalls),
		suspended: suspended || undefined,
	};
}

function shouldTerminateToolBatch(finalizedCalls: ToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: Tool<any>, toolCall: ToolCall): ToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

/**
 * 解析一个调用的工具，带它走完执行之前的各步。
 *
 * 实例来自 {@link declaredToolOf}，先按名查本请求的声明数组：会话已关掉或本请求未声明的名字在这里
 * 解析成空、以未知名字一贯得到的那句话拒绝——产生它的唯一地方在闸门之前，因为没人能运行的调用不是
 * 该去请求许可的调用。`prepareArguments` 与 schema 校验随后读已解析实例的字段，所以模型参数被它
 * 塑形的 shim 与运行它们的代码是同一个对象。
 *
 * `before_tool` 闸门是运行自己的那条回调（ADR-0023）：suspend 在这个调用处结束运行——这里不为它
 * 写结果，调用方在批上看到 `suspended`、结束运行，恢复运行以稍后抵达的答案关闭调用；与它并存的
 * `block` 会写结果，所以 suspend 胜出。裁决归一化（闸门答案 → 引擎的机械）就住在这里。
 */
async function prepareToolCall(
	chain: ToolChain,
	toolCall: ToolCall,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome | SuspendedToolCall> {
	const tool = declaredToolOf(chain.declared, toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		const decided = await chain.decideBeforeTool({
			sessionId: chain.sessionId,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: validatedArgs,
		});
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		// 闸门在这个调用处结束了运行：这里不为它写结果——调用方在批上看到 `suspended`、结束运行，
		// 恢复运行以稍后抵达的答案关闭调用。与它并存的 `block` 会写结果，所以 suspend 胜出。
		if (decided?.suspend === true) {
			return { kind: "suspended" };
		}
		if (decided?.block !== undefined) {
			const result = createErrorToolResult(decided.block.reason || "Tool execution was blocked");
			if (decided.terminate === true) {
				result.terminate = true;
			}
			return {
				kind: "immediate",
				result,
				isError: true,
			};
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

function emitToolExecutionUpdate(toolCall: ToolCall, emit: AgentEventSink): ToolUpdateSink {
	return (partialResult) =>
		emit({
			type: "tool_execution_update",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
			partialResult,
		});
}

/** {@link runToolCall} 的 options。 */
interface RunToolCallOptions {
	/** 一次运行的工具链：闸门、解析与执行（ADR-0023）。 */
	chain: ToolChain;
	/** 本调用自己的运行值：它施展的目录与它运行在下的 bash 超时。 */
	run: ToolRunContext;
	signal?: AbortSignal;
	onUpdate?: ToolUpdateSink;
}

/**
 * 让一个工具调用走与模型发出的调用相同的步骤：参数准备、schema 校验、`before_tool` 闸门、执行、
 * `after_tool` 闸门。不发事件、不加消息。会调用其他工具的工具用它，让闸门（例如权限检查）也作用于
 * 那些调用。
 *
 * 工具失败从不 reject：未知工具、校验错误、被阻止的调用、抛出的错误都以 `isError: true` 返回。
 * 本构建尚无任何东西调用它——想嵌套另一个调用的工具会——所以它留在本文件内部而不导出。
 */
async function runToolCall(toolCall: ToolCall, options: RunToolCallOptions): Promise<ToolCallOutcome> {
	const { chain, run, signal } = options;
	const preparation = await prepareToolCall(chain, toolCall, signal);
	if (preparation.kind === "immediate") {
		return { toolCall, result: preparation.result, isError: preparation.isError };
	}
	// 嵌套调用没有批可挂起、也没有自己的运行可结束，所以 suspend 以它本来的错误结果回来：工具没有
	// 运行，调用方看得到原因。
	if (preparation.kind === "suspended") {
		return {
			toolCall,
			result: createErrorToolResult(`Tool call "${toolCall.name}" was suspended before it ran`),
			isError: true,
		};
	}
	const executed = await executePreparedToolCall(
		preparation,
		chain,
		run,
		signal,
		options.onUpdate ?? (() => {}),
	);
	return finalizeExecutedToolCall(preparation, executed, chain);
}

/**
 * 运行一个过了闸门的调用，经 {@link ToolChain.executeTool} 执行。
 *
 * 名字在这里解析、不随 `prepared` 携带，所以生产代码里唯一的 `Tool.execute` 调用就是表自己的
 * （`ToolManager.execute`，ADR-0016）：引擎拥有的是围绕一次调用的编排——update sink、abort signal、
 * 以及把一次抛出变成模型可读的错误结果。此时仍未知的名字是上游的 bug（闸门先解析），落在同一个
 * catch 里、同样以错误结果收场。
 */
async function executePreparedToolCall(
	prepared: PreparedToolCall,
	chain: ToolChain,
	run: ToolRunContext,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdateSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await chain.executeTool(
			prepared.toolCall.name,
			prepared.toolCall.id,
			prepared.args,
			run,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(Promise.resolve(onUpdate(partialResult)));
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: result.isError === true };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

/**
 * `after_tool` 闸门之后一次工具调用的定稿。闸门的改写即定稿（ADR-0023）：消息带着恰是那个内容
 * 写下——改写是对这个结果唯一会存在的版本的一次裁决，在结果诞生的那一刻作出。
 *
 * 闸门的答案是回调、不是包装方法，所以这里只剩它真正能改的那一件事：content。想约束结果的 hook
 * 自己归档全文（`archiveToolResult`、`context/spill.ts`）并把路径放进它返回的东西；写边界的兜底
 * （fanout 的 `finalizeToolResult`）仍会接住没人约束过的结果。
 */
async function finalizeExecutedToolCall(
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	chain: ToolChain,
): Promise<ToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	try {
		const decided = await chain.decideAfterTool({
			sessionId: chain.sessionId,
			toolCallId: prepared.toolCall.id,
			toolName: prepared.toolCall.name,
			content: result.content,
			isError,
		});
		if (decided?.content !== undefined) {
			// 结构化内容没有随 content 一起被替换，可能已与它不再匹配。
			result = { ...result, content: decided.content };
			delete result.structuredContent;
		}
	} catch (error) {
		result = createErrorToolResult(error instanceof Error ? error.message : String(error));
		isError = true;
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): ToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: ToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: ToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// 无类型工具可以返回没有 content 的结果；规范化，让 null 从不进入会话历史或供应商载荷。
		content: finalized.result.content ?? [],
		// 工具的 details 是账本逐字存储的任意 JSON，所以本文件做的唯一收窄在这里：transcript 的消息
		// 形状说 `JsonValue`，而工具自己的 `details` 有意无类型。
		details: finalized.result.details as JsonValue | undefined,
		usage: finalized.result.usage,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}

/**
 * 一次运行的起点：打开它的那条消息，或恢复用来关闭悬空调用的答案。
 *
 * 两者是备选、不是可同时设置的字段：被提示的运行除了崩溃留下的之外没有可恢复的，恢复的运行没有
 * 新消息——它的第一个动作就是对上一次运行留下的未答调用做恢复遍。
 */
export type RunStart =
	| { prompt: Message; answers?: undefined }
	| { prompt?: undefined; answers: Record<string, ToolCallAnswer> };


/**
 * 从一次上下文溢出的尝试中抛出，让重试策略永远见不到它。
 *
 * `retryAssistantCall` 分类的是 `produce` 返回的东西，所以把溢出挡在重试预算之外的唯一办法就是不
 * 返回它：泵接住这个、以同样的错误消息结束运行，恰如它对待被分类器拒绝的失败那样。
 */
class ContextOverflow {
	readonly message: AssistantMessage;

	constructor(message: AssistantMessage) {
		this.message = message;
	}
}

/** 全零 `Usage`，给一条不是任何供应商产出的消息。 */
const NO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 一次抛了异常的流函数，以引擎结束运行的那个形状。 */
function failureMessage(model: Model, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		model: model.id,
		usage: NO_USAGE,
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/**
 * 以供应商会有的方式结束会话的流。
 *
 * 引擎的终局分支由这个事件驱动，而 `AssistantMessageEventStream.result()` 答的正是它携带的那条
 * 消息，所以这个事件从重试策略敲定的那条消息重建，而不是从产出它的那次尝试复制——被重试过的尝试
 * 自己的终局事件早已被丢弃。
 */
function pushTerminal(outer: AssistantMessageEventStream, message: AssistantMessage): void {
	const { stopReason } = message;
	if (stopReason === "error" || stopReason === "aborted" || stopReason === "pending") {
		// `pending` 意味着流根本没有终局事件就结束了；按它本来的失败报告，而不是当作一轮完成。
		outer.push({ type: "error", reason: stopReason === "pending" ? "error" : stopReason, error: message });
		return;
	}
	outer.push({ type: "done", reason: stopReason, message });
}

/**
 * 把每条迟到的工具结果挪回它所回答的调用旁边。
 *
 * 账本只增不改，所以一个结果可能站在它的调用从未见过的消息之后：一次编排层在运行的恢复遍关闭调用
 * 之前写下的 prompt，或闸门已让调用悬空之后运行在末尾 flush 的一条消息。在磁盘上那个顺序是诚实的
 * ——prompt 确实先于答案——但携带它的供应商请求并不合法：wire 要求每个工具结果待在紧随其自身
 * assistant 消息的 user 轮次里，两轮之后才被回答的调用读起来就像从未被回答。
 *
 * 修补是请求的、绝不是文件的：结果迟到，当它的调用被发出、隔着一条非结果消息未获回答、事后才被
 * 回答；每条迟到结果被提升到携带其调用的 assistant 消息之后，按调用发出的顺序。其余一切留在账本
 * 放它的地方。
 */
function pairLateToolResults(messages: readonly Message[]): Message[] {
	// 哪些结果迟到：一条非结果消息到达时仍开着的调用，被其后任何东西回答都太晚，因为 wire 已经
	// 往前走了。
	const lateIds = new Set<string>();
	{
		const open = new Set<string>();
		for (const message of messages) {
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall") open.add(block.id);
				}
			} else if (message.role === "toolResult") {
				open.delete(message.toolCallId);
			} else if (open.size > 0) {
				for (const id of open) lateIds.add(id);
			}
		}
	}
	if (lateIds.size === 0) return messages as Message[];

	// 迟到的结果，按调用 id 分组，保持账本给出的顺序。
	const late = new Map<string, Message[]>();
	for (const message of messages) {
		if (message.role === "toolResult" && lateIds.has(message.toolCallId)) {
			const grouped = late.get(message.toolCallId) ?? [];
			grouped.push(message);
			late.set(message.toolCallId, grouped);
		}
	}

	const out: Message[] = [];
	for (const message of messages) {
		if (message.role === "toolResult" && lateIds.has(message.toolCallId)) continue;
		out.push(message);
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const grouped = late.get(block.id);
				if (grouped !== undefined) out.push(...grouped);
			}
		}
	}
	return out;
}

/**
 * 一份 entry 选集所代表的那些消息——store 递给请求的同一个投影。
 *
 * 触发器量 prompt 的唯一途径，所以 `compact` 得以比较存储中的 transcript 与清理后的 transcript
 * 而不必构建两次请求。
 */
function messagesOf(entries: readonly SessionEntry[]): Message[] {
	return entries.flatMap((entry) => sessionEntryToContextMessages(entry));
}
