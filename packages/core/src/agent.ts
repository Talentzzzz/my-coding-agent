import { assembleSession, type AssembleAgentStateOptions } from "./assembly.ts";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type ChatTransport,
	type Context,
	createAssistantMessageEventStream,
	createSystemMessage,
	isContextOverflow,
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
import type { ToolRunContext } from "./llm/types.ts";
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
import { type HookEvent, type HookResult, type Hooks } from "./hooks.ts";
import {
	type Model,
	type ModelChoice,
	type ModelConfig,
	modelFor,
	normalizeThinkingLevel,
	rowFor,
	type ThinkingLevel,
	unconfiguredStream,
} from "./models.ts";
import type { ConfigPatch, ModelSelection, PendingApproval, PromptBehavior, SessionRow, SessionSnapshot } from "./protocol.ts";
import type { AgentState } from "./session/agent-state.ts";
import { createAgentState, createLive } from "./session/agent-state.ts";
import { danglingApprovalsOf } from "./session/dangling.ts";
import { messageDeltaOf, type SessionEventListener, type SessionListener } from "./session/events.ts";
import {
	appendMessageEntry,
	approvalsOf,
	dropQueued,
	emitEvent,
	emitQueueUpdate,
	nextStamp,
	publishState,
	type SessionServices,
	snapshotOf,
} from "./session/fanout.ts";
import { modelChoiceOf } from "./session/model-choice.ts";
import {
	createSession,
	type DirectorySessions,
	type Session,
	type SessionEntry,
	type SessionInfo,
	SessionManager,
	sessionEntryToContextMessages,
} from "./session/session-manager.ts";
import type { PendingMessageQueue } from "./session/queues.ts";
import { toolStateOf } from "./session/tool-config.ts";
import { UnknownSessionError } from "./session/unknown-session.ts";
import type { SettingsPatch } from "./setting-manager.ts";
import type { SettingManager } from "./setting-manager.ts";
import type { Settings } from "./config.ts";
import type { ToolManager } from "./tools/index.ts";
import { type AgentEvent, type AgentRequestUpdate, type RunRecoveryOptions, type ToolCallAnswer, type ToolCallOutcome } from "./types.ts";

// 事件面定义在发布它的 fanout 旁边（`session/events.ts`），在这里转发出去，因为 `index.ts` 一直
// 都是从本模块为此作答的。
export type { AgentSessionEvent, MessageDelta, SessionEventListener, SessionListener } from "./session/events.ts";

/**
 * 一个编排层所协调的服务，由调用方先行构建。
 *
 * 会话从不加载设置、创建工作目录、读 AGENTS.md 或挑模型：每个方法按 id 点名会话，在需要它的那一
 * 行、从拥有它的服务现取所需——transcript 来自 session manager 的缓存，live 半来自会话自己的状态，
 * 模型来自账本与实时的行。这正是让这个类无状态的（ADR-0007）：除状态表本身外这里没有任何
 * per-session 字段，所以测试把自己的编排层打开一个会话来驱动它（`openAgent`），拥有服务的宿主把
 * 每份 transcript 打开到它保有的那一个上。装配本身住在 `assembly.ts`，那是把「每个会话由什么形状
 * 描述」一次写下的地方。
 *
 * 这些字段没有一个是会话*状态*。本类协调的服务——账本、配置（设置与模型行合起来，一只
 * {@link SettingManager}）、工具表、接缝、prompt builder、传输层——各自持有自己的纯数据状态
 * （ADR-0006 §1–2）；曾经是 `Agent` 私有会话字段的东西已不在：运行期瞬态是运行自己的局部变量
 * （ADR-0006 §5），审批从账本派生，时间戳从文件派生，装配则骑在 open 收进本类所持那张表的状态上
 * （ADR-0011）。
 */
export interface AgentConfig {
	/**
	 * 每次 transcript 读写都要经过的无状态会话服务。
	 *
	 * 拥有一份的宿主——hub，让进程的所有会话共享同一个服务及其唯一的存储知识——递入自己的。服务不
	 * 持有自己的袋：被持有会话的袋是本类那张表应答的那只，冷会话的是 `open(id)`，一次由调用方丢弃的
	 * 重放。
	 */
	sessionManager: SessionManager;
	/**
	 * 每次设置与模型读取所经的配置门。
	 *
	 * 递进来而不是复制，因为配置是会话打开期间最可能变动的东西：manager 什么都不持有，每次读取都是
	 * 对其背后文件的一次新读——面板里修正的密钥、切换的模式、编辑器里加的行——每一件都是下一个请求
	 * 给出的答案。按请求的填充从它在这里找到的目录重新派生会话的模型，所以密钥、端点、窗口、wire id
	 * 都和行一样新鲜。
	 */
	settings: SettingManager;
	/**
	 * 本构建认识的工具，加上调用方在它上面注册的任何东西——测试的自定义工具。
	 * 只有结构：选择不在这里。
	 *
	 * 活跃集与审批映射从会话记录的选择——`.json` 快照的当前值——在每次读取时派生（全局默认的实时
	 * 视图作底），所以选择变动时没有任何东西被改写。表装的是行为、不是目录：请求声明它的名字解析到
	 * 的实例，那些实例执行所用的按请求值经 `execute` 的 `run` 抵达（ADR-0016）。
	 */
	tools: ToolManager;
	/**
	 * 每次分发都经过的接缝：`context`、`before_tool`（审批闸门）、`after_tool`。
	 *
	 * 与工厂安装默认处理器的是同一个实例，因为加处理器的宿主注册在它们之后、精修它们的决定——见
	 * {@link Agent.hooks}。
	 */
	hooks: Hooks;
	/**
	 * 从会话的实时设置出发，为模型可以调用的工具构建 prompt。
	 *
	 * 是函数而不是字符串，因为它点名的两样东西会在会话中途变化：活跃工具集，以及其中哪些工具要审批。
	 * 一条被捕获的 prompt 会向模型提供运行随后拒绝执行的工具，或许诺一个会话已不再要求的审批。工作
	 * 目录与项目指示按请求递交，出于同样的理由。
	 */
	systemPrompt: (
		workDirAbsPath: string,
		agentsMd: readonly AgentsMdFile[],
		toolNames: readonly string[],
		approvals: Record<string, boolean>,
	) => string;
	/**
	 * 本会话每个请求走的传输层。
	 *
	 * 模型是发起请求用的东西，传输层是发送它的方式，所以每个模型都用装配它时的那条传输层构造，之后
	 * 每一个都从行重新派生。由工厂解析（`anthropicMessages`，本应用唯一会说的一种）而不是在这里给
	 * 默认值，因为 smoke 会递入脚本化的。
	 */
	api: ChatTransport;
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
 * 一次运行的全部入参（ADR-0024）：三件每次调用的值，没有依赖面——运行要用的服务全在 `Agent` 自己
 * 身上。运行局部的东西不进这里：模型、abort controller、两个闸门、重试包装的 transport、
 * thinkingLevel 全是运行自己的局部变量。
 */
export interface RunInput {
	/** 这次运行写瞬态的对象：两条队列、在飞运行、partial、重试与挂起位（ADR-0019 的 live 半）。 */
	state: AgentState;
	/** 运行袋：开跑时重放一次盘得到的 transcript，整条运行只带这一只（ADR-0019）。 */
	bag: Session;
	/** 运行起点：打开它的那条消息，或恢复用来关闭悬空调用的答案（见 {@link RunStart}）。 */
	start: RunStart;
}

/** 一次请求的工具面：活跃名单与同一派生查表所得的声明数组，一次派生（ADR-0016）。 */
export interface ActiveTools {
	/** 本次请求活跃的名字：整条链成员判断的唯一依据。 */
	names: readonly string[];
	/** 同一派生按名字查表的声明数组：元素是表自己的实例（ADR-0016）。 */
	declared: readonly Tool<any>[];
}

/**
 * 本进程跑的每一段对话共有的编排服务。
 *
 * 这是无状态架构的编排层（ADR-0006 §1）：四个域是无状态单例，而跨域的顺序——应用输入框的选择、
 * 按 id 解析会话、写下消息、跑引擎、再报告动了什么——住在这里、别无他处，因为它不属于任何单个域。
 *
 * 一次运行的机械是这个类自己的私有方法（ADR-0024）：引擎（`run` / `runEngine`）、按请求的填充链、
 * 压缩阶梯、重试泵与两个工具调用闸门，读的接缝是 `this` 上的服务与每次运行自己的局部变量。三个
 * 运行入口各自把三件值（`state` / `bag` / `start`，见 {@link RunInput}）递给 {@link Agent.run}。
 * 这里的其余一切都是会话自己的命令面——transcript 读取、审批、配置挪动，以及命令作答所经的
 * fanout。
 *
 * 这个类不持有会话状态：方法按 id 点名自己的会话，从 session manager 解析账本袋、从表解析 live 半，
 * 并从这两者重建命令所需的一切。恢复的会话与活跃的会话跑同一条链，这正是它们无从区分的原因。
 */
export class Agent {
	/**
	 * 每次 transcript 读写都要经过的无状态会话服务。
	 *
	 * 公开给越过门面的测试接缝——直接种一份 transcript 的 smoke、改写落盘、或读取被持有袋上记录的
	 * 设置。生产调用方没有路到这里：下面的门面转发宿主可能问的一切，且不存在要跟着保持同步的第二份
	 * 存储状态副本。一次调用所操作的袋从不在这里持有——被持有会话的是表里的那只，冷会话的是
	 * `open(id)` 的那只，而 id 是调用方的。
	 */
	readonly sessionManager: SessionManager;
	/**
	 * 每次设置与模型读取所经的配置门。
	 *
	 * 门面读取存在之后已被藏起：宿主回答设置命令或列出模型行走 {@link Agent.modelCatalog}、
	 * {@link Agent.settings} 及其邻居，任何地方都没有第二份文件副本需要保持同步。见
	 * {@link AgentConfig.settings}。
	 */
	private readonly settingsManager: SettingManager;
	/**
	 * 会话分发所经的接缝，包括 `openAgent` 安装的默认处理器。
	 *
	 * 公开出来，让已经有会话的宿主能在其上加行为：在这里注册的处理器排在默认之后，精修它们的答案。
	 */
	readonly hooks: Hooks;

	private readonly tools: ToolManager;
	/** 请求据此构建的 prompt builder；调用它的是按请求填充链（`prepareRequest`）。 */
	private readonly systemPrompt: AgentConfig["systemPrompt"];
	/** 请求真正离开的地方：传输层，重试策略包上它之前的那个。 */
	private readonly api: ChatTransport;
	/**
	 * 本进程所知各会话的 live 半，按 id 为键（ADR-0019）。
	 *
	 * 一个会话一只袋，它只装文件回答不了的东西：订阅者、队列、在飞的运行，以及——在第一条消息给它
	 * 文件之前——transcript 本身。持久的那一半**不**在这里：需要 transcript 的每个操作都现开它
	 * （一次运行在其开头开一次，一条命令按其长度开一次）然后丢掉，这正是让陈旧的袋不可能存在的原因。
	 * 状态经 {@link Agent.assembleAgentStateBySession} 进表、经 {@link Agent.evict} /
	 * {@link Agent.remove} 出表：一个写者、一个删除者，中间没有别的调用者。
	 */
	private readonly sessions = new Map<string, AgentState>();

	/**
	 * 每个会话的持有者数量，按 id 为键。
	 *
	 * 仍然是一个计数，但不再是把 transcript 留在内存里的那个计数——transcript 从不留着。它回答的是
	 * 此刻*谁在用*这个会话，这是删除与收割动手前要问的问题：一个 hold 意味着有人在改它或跑它，而在
	 * 其脚下拆掉一个会话，正是绝不可以做的事。
	 */
	private readonly holds = new Map<string, number>();

	constructor(config: AgentConfig) {
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settings;
		this.tools = config.tools;
		this.hooks = config.hooks;
		this.systemPrompt = config.systemPrompt;
		this.api = config.api;
		// 这里不构建任何 per-session 的东西：状态由 `open` 在这些服务之上装配，id 在每个方法的开头
		// 对着下面的表现取。这里也不构建任何运行期对象：一次运行持有的一切都是它自己的局部变量。
	}

	/**
	 * fanout 调用与装配读取所经的三个服务，在调用点现凑。
	 *
	 * 不是字段：被持有的袋正是 ADR-0007 删掉的东西，而这三个各自已是本类的字段——这就是
	 * `session/fanout.ts` 与 `assembleSession` 要的形状，在要它的地方构建。
	 */
	private get services(): SessionServices {
		return { sessionManager: this.sessionManager, settings: this.settingsManager, tools: this.tools };
	}

	// ---------------------------------------------------------------------------- 解析

	/**
	 * 会话的 transcript，作为调用方在一次操作的长度内拥有的那只袋。
	 *
	 * 这就是「不缓存」的全部（ADR-0019）：出生的会话是一次重放，在这里取、调用方用完即丢——本进程
	 * 持有的东西因此不可能陈旧，而在一个同步块里先读后写的写者，绝不可能写出一个别人已经越过的版本。
	 * 唯一的例外是文件还不存在的会话：重放造不出它，它的袋在第一条消息落盘之前就是 live 半的字段，
	 * 而这次转移就发生在这里——已经出生的袋在这里被丢掉，绝不再往下带。
	 *
	 * 开一次并为一次运行留住袋的调用方，正是一次运行只花一次重放而不是每操作一次的原因：它们持有的
	 * 是一个运行局部变量，由运行自己闭包。
	 */
	private bag(id: string): Session {
		const state = this.sessions.get(id);
		const unwritten = state === undefined ? undefined : this.unwrittenOf(state);
		return unwritten ?? this.sessionManager.open(id);
	}

	/**
	 * 会话因还没有文件而仍留着的那只袋，一旦有了文件就是 `undefined`。
	 *
	 * 字段在这里清除，而不是在生出文件的那次写入处，因为出生不总是编排层的：自己往袋上追加的调用方
	 * （对未写会话调 `sessionManager.appendMessage`）也会给它文件，而这个字段的每个读者都必须认同：
	 * 那一刻起袋就不再是会话唯一的副本。让它经过一个函数读取，正是让这是一条规则而不是五条的原因。
	 */
	private unwrittenOf(state: AgentState): Session | undefined {
		const bag = state.live.unwritten;
		if (bag === undefined) return undefined;
		if (!bag.fileCreated) return bag;
		state.live.unwritten = undefined;
		return undefined;
	}

	/**
	 * 构建一个会话的 live 半并放进表里。唯一的入口，也是唯一装配的门——`assembleSession` 加上那张
	 * 表：装配与先到先得的插入是一步，下面的读回正是这两者不该拆开的原因。
	 *
	 * transcript 如今是*入参*而不是产物（ADR-0019）：装配解析会话由设置而来的那一半（队列模式，以及
	 * 它播种到袋上的模型选择），那只袋留不留取决于一个事实——有没有文件。出生的袋在这里被丢掉，因为
	 * 重放随时能再造它；未写的袋被留下，因为没有别的什么能。
	 *
	 * 服务按构造即本类自己的，所以「表里的每个状态都是在该编排层的服务之上装配的」是一个事实而不是
	 * 约定。先到先得：已在表里的状态被保留、绝不替换，因为它要替换的那个装着队列、订阅者与在飞的
	 * 运行——而重新进入一个被持有的 id 是寻常的幂等动作，不是错误。
	 */
	private async assembleAgentStateBySession(options: AssembleAgentStateOptions): Promise<AgentState> {
		const id = options.session.sessionId;
		const held = this.sessions.get(id);
		if (held !== undefined) return held;
		const state = await assembleSession(this.services, options);
		this.insert(state);
		return this.sessions.get(id) ?? state;
	}

	/** 先到先得的插入。{@link Agent.assembleAgentStateBySession} 是它唯一的调用者，这正是它的用途。 */
	private insert(state: AgentState): void {
		if (this.sessions.has(state.sessionId)) return;
		this.sessions.set(state.sessionId, state);
	}

	/**
	 * 一个会话的空 live 半。
	 *
	 * 队列模式按 transcript 点名的目录定作用域，且经设置门实时读取，所以给一个会话 live 半，来自它
	 * 自己的一次小装配——要它的那条路自己决定留不留：{@link Agent.ensureState} 把它归档在 id 下，
	 * 读取则造一个然后扔掉。
	 */
	private liveHalfOf(bag: Session): AgentState {
		const workDirAbsPath = bag.sessionSetting.workDirAbsPath;
		return createAgentState(
			bag.sessionId,
			createLive(this.settingsManager.getSteeringMode(workDirAbsPath), this.settingsManager.getFollowUpMode(workDirAbsPath)),
		);
	}

	/**
	 * 给一个会话 live 半，如果它没有。
	 *
	 * 各动词共享的机件部分：已知的 id 原样不动，冷的 id 得到一个空的 live 半——一次重放，为了得知
	 * 它的队列模式按哪个目录定作用域，然后连同来时的袋一起扔掉。什么也不指名的 id 在 store 的
	 * `open` 内拒绝（{@link UnknownSessionError}），传输层把它应答成 404。
	 */
	private ensureState(id: string): AgentState {
		const held = this.sessions.get(id);
		if (held !== undefined) return held;
		const state = this.liveHalfOf(this.bag(id));
		this.sessions.set(id, state);
		return state;
	}

	/**
	 * 把一个会话的 live 半从表里丢掉，当没有东西持有它时。
	 *
	 * 驱逐判据（ADR-0011，issue 04）：没有在飞的运行、没有停在审批闸门的调用、没有未写的袋——文件
	 * 尚未出生的会话没有任何东西可供重建，丢掉它的 live 半等于删掉这个 id，它的生命随第一条消息或
	 * 进程结束，绝不随清扫结束。拒绝（返回 `false`）是给点名了一个仍被持有的会话的调用方的答案。
	 */
	evict(id: string): boolean {
		const state = this.sessions.get(id);
		if (state === undefined) return false;
		if (state.live.activeRun !== undefined || state.live.suspended) return false;
		if (this.unwrittenOf(state) !== undefined) return false;
		return this.sessions.delete(id);
	}

	/**
	 * id 所点名会话的 live 半，或说明本进程从未碰过它的拒绝。
	 *
	 * 每个对会话动手的方法都经它解析，transcript 则另外经 {@link Agent.bag}——现在两个问题由两次
	 * 调用回答，因为它们有两条不同的生命周期。
	 */
	private agentState(id: string): AgentState {
		const state = this.sessions.get(id);
		if (state === undefined) throw new UnknownSessionError(id);
		return state;
	}

	// ---------------------------------------------------------------------------- 会话门面
	//
	// 宿主操作会话所经的脸面：生命周期随被持有与冷的两条路在每个方法内部统一、取代
	// `agentState().session.*` 的窄状态读取，以及设置与模型目录的转发。这里的每个方法要么按 id 点名
	// 自己的会话、从 `this` 现取所需，要么转发一次调用给拥有它的服务——它们谁都不持有任何东西
	// （ADR-0007）。

	/**
	 * 会话当前的状态，从它磁盘上现有的 transcript 读出。
	 *
	 * 读取就是一次重放、仅此而已（ADR-0019）：transcript 被打开，快照从它上面取下，袋被丢弃。它不
	 * 注册状态、不取 hold——来看一眼的调用方不留下任何可供再看的东西，这正是这条读取在短暂变成一次
	 * 装配之前一直遵守的规则，也是一次裸 REST 读只花一次重放而不花一次驻留的原因。本进程*正在*运行
	 * 的会话以同样的方式作答，外加它的 live 半补充的部分，两条路经过同一个函数（`snapshotOf`），
	 * 所以它们不可能漂移。
	 *
	 * 什么也不指名的 id 在 store 的 `open` 内拒绝——就是那个 404，原封未动。
	 */
	async snapshotOf(id: string): Promise<SessionSnapshot> {
		const bag = this.bag(id);
		const held = this.sessions.get(id);
		return snapshotOf(held ?? this.liveHalfOf(bag), bag, this.services);
	}

	/**
	 * 给会话一个自己的名字，作为其 `.json` 快照上的 title 存储。
	 *
	 * 一个同步块——重放，然后是落盘的 setter——不取 hold：标题是关于会话的事实，不是关于其中某一条
	 * 路的事实，引擎从不读标题。运行中途重写快照落地而不惊动正在进行的轮次，且因为每次写入都是自己的
	 * 一次重放，这个写不可能带上另一个写者已经越过的值。什么也不指名的 id 在 store 的 `open` 内拒绝，
	 * 一直就是那个 404。
	 */
	setTitle(id: string, title: string): void {
		this.sessionManager.setTitle(this.bag(id), title);
	}

	/**
	 * 把一个会话的一个分支复制成源会话旁边的一个新会话，报出新 id。
	 *
	 * 先定位源，然后只读：它的文件不动，它自己的 leaf 不移，本进程正在运行的会话也从它正在写的文件
	 * 上 fork，所以没有 hold 被打扰，活跃轮次保住它原本在写的东西。两个新文件在本函数返回之前同步
	 * 写完，所以交回去的 id 在调用方拿到它时就可以打开。什么都不注册：没人持有的 fork 没有 live 半
	 * 可留，它的第一次触碰会给自己一个。
	 */
	forkFrom(sourceId: string, entryId: string | null): string {
		const source = this.sessions.get(sourceId);
		const absSourcePath =
			(source === undefined ? undefined : this.unwrittenOf(source)?.sessionFileAbsPath) ??
			SessionManager.findSessionFilePathById(sourceId);
		if (absSourcePath === undefined) throw new Error(`Unknown session: ${sourceId}`);
		return this.sessionManager.forkFrom(absSourcePath, entryId).sessionId;
	}

	/**
	 * 在一个目录里启动会话并注册它的 live 半；报回的就是这个 id。
	 *
	 * 创建不写任何东西：文件随第一条消息出现，所以在这个调用与那条消息之间，袋*就是*会话的存在
	 * ——唯一一份重放造不出来的 transcript，也是 live 半有那个字段的原因（ADR-0019）。因此创建只是
	 * 对设置的一次 `await`——装配自己的读取——而它唯一的失败模式（一个读不了的设置文件）与接下来
	 * 那次打开会撞上的失败相同，只是更早：id 不会在创建失败时被递出去。
	 *
	 * 不以参数收模型：会话打开在哪个模型上是一个设置事实，每个请求现读，所以面板里修正的行就是这个
	 * 会话运行的行。
	 */
	async create(workDirAbsPath: string): Promise<string> {
		const bag = createSession(workDirAbsPath);
		const state = await this.assembleAgentStateBySession(this.openOptions(bag));
		return state.sessionId;
	}

	/**
	 * 对一个会话取一个 hold：这个调用方在用它。
	 *
	 * 门面的动词「我现在需要这个会话」。一个变更请求与一次运行各按自己的长度取一个、用
	 * {@link Agent.release} 还回；订阅不取，因为观看既不改会话也不让轮次活着（ADR-0001）。live 半
	 * 顺路创建，因为运行和队列需要有个地方待——而表与文件都不指名的 id 在 store 的 `open` 内以
	 * {@link UnknownSessionError} 拒绝，传输层把它应答成 404。
	 *
	 * 调用方永远不必说的是「有没有东西在内存里」：那是本类的簿记。计数按 id 而不按调用方——同一会话
	 * 上的两个请求就是两个 hold，最后还回的那个才让收割可以取走 live 半。
	 */
	async hold(id: string): Promise<void> {
		this.ensureState(id);
		this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
	}

	/**
	 * 还回一个 hold。状态接下来怎样是判据的决定，不是本方法的：问的是 {@link Agent.evict} 这个
	 * 调用者，它在运行在飞或审批停驻时拒绝。
	 *
	 * 对没人持有的 id 宽容：release 是调用方撤销自己的 hold，答一句「没有东西可还」会把一次簿记
	 * 失误变成收尾中间的一场异常。
	 */
	release(id: string): void {
		const held = this.holds.get(id) ?? 0;
		if (held <= 1) this.holds.delete(id);
		else this.holds.set(id, held - 1);
	}

	/**
	 * 一个会话此刻有多少持有者——收割与删除动手前读的那个数，让谁都不会关掉或忘掉一个还有人正在用
	 * 的会话。
	 */
	holdsOf(id: string): number {
		return this.holds.get(id) ?? 0;
	}

	/**
	 * 删除 id 点名的会话：它在磁盘上的文件（若有），以及本进程为它持有的状态。一个操作，因为
	 * 「有没有文件？」不是调用方的问题。
	 *
	 * 三种情况，在这里裁决而不是交给调用方：磁盘上有文件的会话——移除文件、忘掉状态；创建了但从未
	 * 说过话的——文件从未写下，忘掉状态就是全部删除；什么也不指名的 id——以 {@link
	 * UnknownSessionError} 拒绝，传输层把它应答成 404。先文件、后状态：一次失败的 unlink 留下的是
	 * 一张还能为同一 id 作答的表。
	 *
	 * 不取 hold、不停运行：传输层在请求之前先把会话安顿好（在那里，删除忙碌的会话是一个 409），
	 * 宿主、观察者与 hold 都是它的簿记，不是本类的。
	 *
	 * 这是表的无条件出口，与 {@link Agent.evict} 的条件出口并列：用户已经删了这个会话，判据一概
	 * 不适用——状态再没有什么可保护的了。排队与在飞的一切随它而去，正如进程重启会杀掉它们一样。
	 */
	async remove(id: string): Promise<void> {
		const onDisk = SessionManager.findSessionFilePathById(id) !== undefined;
		if (!onDisk) {
			if (this.sessions.delete(id)) return;
			throw new UnknownSessionError(id);
		}
		await this.sessionManager.remove(id);
		this.sessions.delete(id);
	}

	/**
	 * 本会话 transcript 所在的文件，还没有文件时为 `undefined`。
	 *
	 * 创建了但从未说过话的会话没有文件，这里就是回答这一点而不是猜测的地方：未写的袋点名它的出生
	 * 将要走的路径，出生会话的路径由 store 自己的查找给出。纯数据，不重放；fork 自己找源，从不经过
	 * 这里。
	 */
	fileAbsPathOf(id: string): string | undefined {
		const state = this.sessions.get(id);
		const unwritten = state === undefined ? undefined : this.unwrittenOf(state);
		return unwritten?.sessionFileAbsPath ?? SessionManager.findSessionFilePathById(id);
	}

	/**
	 * 会话是否有在飞的运行，以 wire 报告的形状（`submitting`）。
	 * 本进程不知道不等于在提交：没人运行的会话不可能正在轮次中间。
	 */
	isSubmitting(id: string): boolean {
		return this.sessions.get(id)?.live.activeRun !== undefined;
	}

	/**
	 * 会话现行的标题：记录的那个，否则是分支的首条 user 消息。
	 *
	 * 每次读取都从 transcript 现状派生，所以重命名与第一条消息的作答方式与快照相同——这是行与头部
	 * 唯一不许各执一词的规则。一次重放，发生在一个手势（重命名、挪分支）上而不是一帧上：追加的消息
	 * 在 `entry_appended` 上自带标题。
	 */
	titleOf(id: string): string {
		return this.sessionManager.getTitle(this.bag(id));
	}

	// ---------------------------------------------------------------------------- 设置门面
	//
	// 配置转发，宿主曾直接在 manager 上做的每次调用对应一个。它们谁都不持有任何东西：每一个都是对
	// {@link Agent.settings} 背后文件的一次新读或新写，所以一次变更就是下一次读取的答案，没有需要
	// 失效的东西。

	/** 用户录入的模型，按设置面板里的顺序。 */
	modelCatalog(): readonly ModelConfig[] {
		return this.settingsManager.modelCatalog();
	}

	/** 替换全部存储行。整表写入让名字与文件不漂移。 */
	replaceModels(models: readonly ModelConfig[]): void {
		this.settingsManager.replaceModels(models);
	}

	/** 侧边栏搁置的目录，按绝对路径。永远是列表，从不是 `undefined`。 */
	hiddenDirectories(workDirAbsPath: string): string[] {
		return this.settingsManager.getHiddenDirectories(workDirAbsPath);
	}

	/** 对一个目录的设置应用部分变更，返回前写回。 */
	applySettings(workDirAbsPath: string, patch: SettingsPatch): void {
		this.settingsManager.applySettings(workDirAbsPath, patch);
	}

	/** 一个目录当前生效的全部设置，合并并补默认后的副本。 */
	settings(workDirAbsPath: string): Settings {
		return this.settingsManager.getSettings(workDirAbsPath);
	}

	// ---------------------------------------------------------------------------- 存储扫描
	//
	// 发现类读取，转发出去，让宿主只能经过本类够到 store 的列表。每个都从磁盘上的文件作答，不持有
	// 任何东西。

	/** 为 `workDirAbsPath` 存储的每个会话，按最近活动排序。 */
	listSessions(workDirAbsPath: string, sessionDirAbsPath?: string, signal?: AbortSignal): Promise<SessionInfo[]> {
		return SessionManager.list(workDirAbsPath, sessionDirAbsPath, signal);
	}

	/**
	 * 是否有任何已存会话把 `workDirAbsPath` 记为自己的——恢复一个文件系统已失去的工作目录时问的就是
	 * 这个。与其他 store 级读取一样是一次转发：store 的内容是 manager 的知识，在这里点名，让没有
	 * 调用方越过这门面去够它。
	 */
	hasSessionsFor(workDirAbsPath: string): boolean {
		return SessionManager.hasSessionsFor(workDirAbsPath);
	}

	/** 本机器为其存储过会话的每个目录，各带自己的列表。 */
	listDirectories(signal?: AbortSignal): Promise<DirectorySessions[]> {
		return SessionManager.listDirectories(signal);
	}

	/** 会话 id 点名的唯一一行，来自持有它的那个目录，没有则为 `undefined`。 */
	findSessionRowById(id: string, signal?: AbortSignal): Promise<SessionRow | undefined> {
		return SessionManager.findSessionRowById(id, signal);
	}

	/**
	 * 本类打开一份 transcript 时它被装配所依据的 options：只有 transcript，因为它自带工作目录，打开
	 * 在哪一行上是装配现读的设置事实。服务按构造即本类自己的——这是装配门所依赖的保证，也是它们
	 * 不在这里出现的原因。
	 */
	private openOptions(session: Session): AssembleAgentStateOptions {
		return { session };
	}

	// ---------------------------------------------------------------------------- 读取面

	/**
	 * id 所点名会话的状态，由每次读取都经过的那个唯一构造者构建。
	 *
	 * 这就是全部读取面：调用方曾按名字逐个去问的每个标量——行、档位、工具集、重试状态——都是这里的
	 * 一个字段，所以只有一个答案，而不是一个需要跟着它保持同步的逐字段 getter。
	 *
	 * 构造者是 `snapshotOf`（`session/fanout.ts`），fanout 发布所经的同一个函数，所以一帧与一次 REST
	 * 读不可能各执一词：只有活跃会话知道的那五个字段——`submitting`、`queued`、`isRetrying`、
	 * `retryAttempt`、`pendingApprovals`——从 live 半上读，空闲状态则以它持有的空闲值作答。这是
	 * {@link Agent.snapshotOf} 的同步孪生：它在此刻重放 transcript，因为它的调用方是同步的帧构建者。
	 */
	snapshot(id: string): SessionSnapshot {
		const bag = this.bag(id);
		return snapshotOf(this.sessions.get(id) ?? this.liveHalfOf(bag), bag, this.services);
	}

	/**
	 * 现行的审批映射：目录的设置，叠上本会话自己的选择。
	 *
	 * 闸门、快照与 prompt 的唯一读取点——三者回答同一个问题，所以谁都不许绕过它直奔设置。会话自己的
	 * 一半是记录的选择，连同它被写下的那个工具集一起从 `.json` 快照上读。一次重放，发生在命令上而不
	 * 是一帧上。
	 */
	getApprovals(id: string): Record<string, boolean> {
		return approvalsOf(this.services, this.bag(id));
	}

	/**
	 * transcript 是否握着一个没人回答的工具调用。
	 *
	 * 只有空闲的会话报告它。在运行*中途*悬空的调用是一个正在落地的结果，不是等人的问题，报告它会让
	 * 每个工具批都闪一次横幅；等答案的调用是那些运行已经结束的。
	 */
	hasPendingApprovals(id: string): boolean {
		if (this.sessions.get(id)?.live.activeRun !== undefined) return false;
		return this.danglingApprovals(this.bag(id)).length > 0;
	}

	/** 订阅会话的状态。返回的函数用于退订。 */
	onChange(id: string, listener: SessionListener): () => void {
		const listeners = this.agentState(id).listeners;
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	/** 订阅会话的事件。返回的函数用于退订。 */
	onEvent(id: string, listener: SessionEventListener): () => void {
		const listeners = this.agentState(id).eventListeners;
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	// ---------------------------------------------------------------------------- 运行生命周期

	/**
	 * 追加一条用户消息，并运行引擎直到 agent 停下。
	 *
	 * `selection` 是输入框的模型与档位，在这里应用、由随后的请求记录。两者都随消息而来、而不是作为
	 * 自己的命令，所以从未随消息发出的选择无处可留。
	 *
	 * 运行正在流式时，消息被排队而不是被拒绝：`steer` 在当前轮次的下一个取走点注入，`followUp` 等
	 * agent 本要停下的那一刻。无论哪种，消息都以未写的状态交给引擎，取走它的那次 drain 才是 store
	 * 记录的——被取走的消息是这场对话已经抵达的，所以文件在模型遇见它的位置、在它打断的那个答案
	 * 之后获得它。运行从未取走的消息随运行被丢弃（fanout 的 `dropQueued`）：发送契约是 fire-and-forget，
	 * 排队从未许诺落盘。
	 */
	async prompt(id: string, text: string, options: { behavior?: PromptBehavior; selection?: ModelSelection } = {}): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;

		// 输入框的选择随消息抵达，所以这是两半各自唯一被应用的地方。一条到不了这里的消息——空的、
		// 被拒发的——什么也不挪动。
		if (options.selection !== undefined) this.applyModelSelection(id, options.selection);

		const state = this.agentState(id);
		if (state.live.activeRun !== undefined) {
			const bag = this.bag(id);
			const message: Message = {
				role: "user",
				content: [{ type: "text", text: trimmed }],
				timestamp: nextStamp(this.sessionManager, bag),
			};
			const queue = options.behavior ?? "followUp";
			if (queue === "steer") state.live.steeringQueue.enqueue(message);
			else {
				state.live.followUpQueue.enqueue(message);
				emitQueueUpdate(state);
			}
			publishState(state, bag, this.services);
			return;
		}

		await this.startPromptedRun(state, trimmed);
	}

	/**
	 * 把一条消息送进正在运行的轮次的下一个取走点。
	 *
	 * 与 {@link Agent.prompt} 带 `behavior: "steer"` 是同一个会话——单独点名是因为在协议的语汇里它是
	 * 自己的答案：被 steer 的消息由它打断的那个轮次消费。对空闲会话它就是一次普通 prompt，因为没有
	 * 人在跑的消息无从 steer。
	 */
	steer(id: string, text: string, options: { selection?: ModelSelection } = {}): Promise<void> {
		return this.prompt(id, text, { ...options, behavior: "steer" });
	}

	/**
	 * 为运行结束后的时刻排队一条消息。
	 *
	 * 与 {@link Agent.prompt} 带 `behavior: "followUp"` 是同一个会话：消息等到 agent 本要停下的那一刻，
	 * 它增加的深度就是输入框显示的那个。
	 */
	followUp(id: string, text: string, options: { selection?: ModelSelection } = {}): Promise<void> {
		return this.prompt(id, text, { ...options, behavior: "followUp" });
	}

	/**
	 * 把被提示的消息写进 transcript，然后在它之上运行。
	 *
	 * 这里打开的袋就是运行携带的那只：transcript 在这里读一次，把 prompt 作为它的第一次写入，交给
	 * {@link Agent.run}，让运行的任何一轮都不必再读它（ADR-0019）。这就是「一次运行一次重放」的全部
	 * ——普通 prompt 花的读与 open 曾经花的相同，之后的每一轮都是在运行已拥有的那只袋上走。
	 */
	private async startPromptedRun(state: AgentState, trimmed: string): Promise<void> {
		const bag = this.bag(state.sessionId);
		const message: Message = {
			role: "user",
			content: [{ type: "text", text: trimmed }],
			timestamp: nextStamp(this.sessionManager, bag),
		};
		appendMessageEntry(state, bag, this.sessionManager, message);
		publishState(state, bag, this.services);
		await this.run({ state, bag, start: { prompt: message } });
	}

	// ---------------------------------------------------------------------------- 一次运行
	//
	// 一次运行的引擎与它的机械（ADR-0024）：这些方法是编排层自己的，读的接缝是 `this` 上的服务——
	// 三只 Manager、hooks、prompt builder、传输层——加上每次运行自己的局部变量（模型、abort
	// controller、事件 sink、重试包装的 transport）。方法在文件里按调用顺序排，读一次运行从上往下
	// 就是它跑的顺序。

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
	private async run(input: RunInput): Promise<void> {
		const { state, start, bag: transcript } = input;
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
				void this.pumpAttempts(state, transcript, outer, model as Model, context, options);
				return outer;
			},
		};

		try {
			// transcript 与工具按运行构建——引擎不保有自己的状态——而且实际发出的那个请求反正会被
			// 填充链重建两者。引擎的取走点读的是本会话自己的队列，所以不需要任何接线。
			await this.runEngine(input, transport);
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
			this.sessionManager.setSuspended(transcript, live.suspended);
			// 引擎的 `runEngine` resolve 之前运行不算结束——要等每个 await 了 `agent_end` 的监听者与
			// 引擎自己的 `finally`。所以这是第一个无物在飞的时刻，不在这里发布就永远没人报告它。
			//
			// 放在 `finally` 里而不是 `await` 之后，因为运行的两种结束走的是两条路：正常结束的运行
			// 直接落到这里，而自己的失败处理 reject 了——报告失败的那个落盘恰恰就是坏掉的那个——
			// 的运行以 rejection 的形态抵达这里，放在 `await` 之后的发布会恰好被最需要那一帧的运行
			// 跳过。运行有的每种结束路径都经过这一个块；可能先到的错误帧由得知 rejection 的调用方
			// 通告，不是由会话。
			publishState(state, transcript, this.services);
		}
	}

	/**
	 * 引擎：一个入口、一个出口，对着现状的 context。
	 *
	 * 这段身体曾是 `packages/loop` 跑的东西，后来是 `Agent` 以自己方法跑的东西（ADR-0008），又抽成
	 * 对象再删掉（0012→0014→0022→0023），最终由 ADR-0024 并回本类——它是 `Agent` 的私有方法，读的
	 * 是 `this`。运行把自己注册到会话的 live 半上（`live.activeRun`，任何层的 abort 都落在那里），
	 * 每个事件经 `emit`——它落盘并扇出——每轮的填充是 {@link Agent.prepareRequest}，两个取走点
	 * 排空的都是本会话自己的队列。这里没有任何东西活得比栈久，这正是运行所用的模型是局部变量而不是
	 * 字段的原因：它是请求唯一可能换掉的东西，一个成员会把它递给第二个会话的运行。跨过栈的是 live
	 * 半自己的槽位，供中途读 delta 的快照用。
	 *
	 * 运行要么从一条 prompt 起步——它进入 transcript 的第一个取走点，正是后来的 steer 消息在更晚
	 * 轮次进入的位置——要么是恢复：它对着现状的 transcript 打开，第一个动作是对上一次运行留下的
	 * 悬空调用做恢复遍。返回运行产出的消息。
	 */
	private async runEngine(input: RunInput, transport: ChatTransport): Promise<Message[]> {
		const { state, start, bag: session } = input;
		// 这次运行的值——目录与 bash 超时——收集一次、由运行发出的每次调用携带：它们是按请求的事实，
		// 如今作为一个值旅行，而不是被某个工具实例闭包（ADR-0016）。
		const run: ToolRunContext = this.runContext(session);
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
		const choice = this.modelChoice(session, live.openedOn);
		let model: Model = modelFor(choice, this.modelCatalog(), transport);
		live.model = model;
		const emit: AgentEventSink = (event) => this.dispatchEvent(state, session, event);

		try {
			const newMessages: Message[] = [];
			// 这次运行的工具面——活跃名单与同一派生的声明数组，一次回调、一次派生（ADR-0023）。声明
			// 数组是整条链解析调用所依据的栈局部：解析只对着本请求声明过的工具（「模型被告知什么与它
			// 可以运行什么」从同一个对象作答），按请求重新派生的数组在下面的请求边界换入。
			let declared: readonly Tool<any>[] = this.activeTools(session).declared;
			// 一次运行的工具链：两个闸门、解析与执行，全部以箭头递进——批处理机件是文件级的、不
			// 持有会话，所以运行把自己需要的接缝递给它们。声明数组随每次请求的答案在下面换入。
			let chain: ToolChain = {
				sessionId: session.sessionId,
				declared,
				executeTool: (name, toolCallId, params, run, signal, onUpdate) =>
					this.executeTool(name, toolCallId, params, run, signal, onUpdate),
				decideBeforeTool: (event) => this.decideBeforeTool(event),
				decideAfterTool: (event) => this.decideAfterTool(event),
			};
			let currentContext: Context = {
				messages: [...this.sessionManager.buildSessionContext(session).messages],
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
					const requestUpdate = await this.prepareRequest(transport, currentContext, signal, state, session);
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

					pendingMessages = await this.drainTranscribed(live.steeringQueue, state, session);
				}

				// 挂起连同运行的 follow-up 侧一起结束：排队的消息从未被取走，会回答它们的运行已经结束。
				if (suspended) break;

				// 运行本要在这里停下。取走 follow-up 队列里的一切。
				const followUpMessages = await this.drainTranscribed(live.followUpQueue, state, session);
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

	// —— 运行的读写面 ——

	/** 账本重放出的 entry 视图：填充链与压缩阶梯共用的答案。 */
	private contextEntries(session: Session): readonly SessionEntry[] {
		return this.sessionManager.buildContextEntries(session);
	}

	/** 这个会话现在在哪个模型上（`chosen` = 运行局部的 `live.openedOn`）；四参数派生（ADR-0019）。 */
	private modelChoice(session: Session, chosen?: ModelChoice): ModelChoice {
		return modelChoiceOf(this.sessionManager, session, this.settingsManager, chosen);
	}

	/** 本次请求活跃的工具名单与同一派生查表所得的声明数组，一次派生（ADR-0016）。 */
	private activeTools(session: Session): ActiveTools {
		const names = toolStateOf(this.sessionManager, session, this.settingsManager, this.tools.names()).activeToolNames;
		// 声明数组与名单是同一次派生的两半：按名字到唯一的表上取，元素是表自己的实例
		// （ADR-0016）。表只增，所以同一名字在两次请求间解析到同一实例。
		const declared: Tool<any>[] = [];
		for (const name of names) {
			const tool = this.tools.get(name);
			if (tool !== undefined) declared.push(tool);
		}
		return { names, declared };
	}

	/**
	 * 把本次请求所用的选择写进会话：对比盘上基线，需要时在表上开新袋补写。
	 *
	 * 请求所用的模型已经是生效中的选择——输入框挪动时已把它写上快照（ADR-0019）——所以这里只补
	 * 手势无从得知的部分：该行此刻应答的 wire id，与规范化后的档位。因此它通常是一次空操作，而非
	 * 空时，写入经过**全新的**袋而不是运行的那只：快照被整体重写，而在运行开始时打开的副本可能带着
	 * 某个其后被人挪过的选择。两个字段都显式设置，所以快照里的其他东西无论哪种情况都不被触碰。
	 *
	 * 它对比的基线是文件的、不是袋的——`recordedOnDisk` 读的是快照，所以同一选择上的多轮运行只花
	 * 一次读、零次写。没有行应答的选择不记录行：没有 wire id 可写，而它所属的请求即将被传输层拒绝
	 * 而非发送。开袋走 {@link Agent.bag}——会话表是本类私有的。
	 */
	private recordSelection(session: Session, catalog: readonly ModelConfig[], choice: ModelChoice): void {
		const recorded = this.sessionManager.recordedOnDisk(session);
		const row = rowFor(choice, catalog);
		const level = normalizeThinkingLevel(choice.thinkingLevel) as ThinkingLevel;
		if (
			level === recorded.thinkingLevel &&
			(row === undefined || (row.name === recorded.model?.name && row.id === recorded.model?.modelId))
		) {
			return;
		}
		const bag = this.bag(session.sessionId);
		if (row !== undefined) this.sessionManager.setModel(bag, row.name, row.id);
		this.sessionManager.setThinkingLevel(bag, level);
		this.sessionManager.flushMeta(bag);
	}

	// —— 执行与两个闸门 ——

	/** 运行一次工具调用：查工具并转发（`ToolManager.execute` 的动词化，ADR-0016 不动）。 */
	private executeTool(
		name: string,
		toolCallId: string,
		params: unknown,
		run: ToolRunContext,
		signal?: AbortSignal,
		onUpdate?: ToolUpdateCallback<any>,
	): Promise<ToolResult<any>> {
		return this.tools.execute(name, toolCallId, params, run, signal, onUpdate);
	}

	/** 改写给供应商的内容。无处理器时 apply 以 undefined 作答，归一成空决定——这条归一是语义。 */
	private async rewriteContext(injected: HookEvent<"context">): Promise<HookResult<"context">> {
		return (await this.hooks.apply("context", injected)) ?? {};
	}

	/** 在工具调用之前裁决：阻止、精修参数、终止或挂起（审批闸门）。 */
	private async decideBeforeTool(event: HookEvent<"before_tool">): Promise<HookResult<"before_tool">> {
		return (await this.hooks.apply("before_tool", event)) ?? {};
	}

	/** 在工具结果上裁决：改写即定稿。 */
	private async decideAfterTool(event: HookEvent<"after_tool">): Promise<HookResult<"after_tool">> {
		return (await this.hooks.apply("after_tool", event)) ?? {};
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
		const catalog = this.modelCatalog();
		const choice = this.modelChoice(session, state.live.openedOn);
		const model = modelFor(choice, catalog, transport);
		// 本次请求所用的选择在这里、在由它构建请求的时刻抵达 transcript——从未说过话的会话由它服务的
		// 第一个请求记录。它跑在下面的压缩决策之前，后者按本模型的窗口计量 prompt。
		this.recordSelection(session, catalog, choice);
		// 一趟决定请求携带什么、以及是否必须摘要：触发器、过期工具结果的清理、摘要读的都是同一批
		// entry，所以决策与请求不可能对 prompt 有多大各执一词。
		const entries = await this.compactFor(
			state,
			session,
			this.contextEntries(session),
			Date.now(),
			signal,
			model,
		);
		// prompt 在这里重建、不被记住：`applyConfig` 能挪审批集、`setActiveTools` 能挪工具集，而模型
		// 必须在下一个请求上被告知两者。两者都在此刻从账本派生，所以刚落下的选择就是 prompt 描述的
		// 东西。
		const toolFace = this.activeTools(session);
		// 项目指示在这里、按请求读取，而不是从状态上取：磁盘文件的一次编辑应当抵达下一个请求，与
		// 模型行的一次编辑相同，而这段走读只是几次 stat。它的代价是一段 prompt 可能在同一次运行的
		// 两个请求之间变化——工具集出于同样的理由已经如此。
		const agentsMd = await loadAgentsMd(session.sessionSetting.workDirAbsPath);
		const prompt = this.systemPrompt(
			session.sessionSetting.workDirAbsPath,
			agentsMd,
			toolFace.names,
			approvalsOf(this.services, session),
		);
		// 请求携带的工具结果按重放侧读取（`contextEntries` 已应用账本自己的视图记录），所以没有
		// 按请求对它们的另一次遍历：账本里的工具结果已经是喂给模型的那个版本。
		const injected = { sessionId: session.sessionId, messages: messagesOf(entries), systemPrompt: prompt };
		const rewritten = await this.rewriteContext(injected);
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
	private runContext(session: Session): ToolRunContext {
		const workDirAbsPath = session.sessionSetting.workDirAbsPath;
		return {
			workDirAbsPath,
			// 实时读取，与其他每次设置读取一样：用户挪过的超时抵达下一次运行的调用，无需重开任何东西。
			bash: this.settingsManager.getBashSettings(workDirAbsPath),
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
		state: AgentState,
		session: Session,
		outer: AssistantMessageEventStream,
		model: Model,
		context: Context,
		options: SimpleStreamOptions | undefined,
	): Promise<void> {
		const api = this.api;
		const live = state.live;
		let started = false;
		const produce = async (): Promise<AssistantMessage> => {
			// 没有行的会话没有可发送的东西，所以它以一句「该做什么」作答，而不是向占位端点发请求。
			const inner =
				this.modelCatalog().find((userModel) => userModel.name === model.name) === undefined
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
		const retrySettings = this.settingsManager.getRetrySettings(session.sessionSetting.workDirAbsPath);
		const maxAttempts = retrySettings.enabled ? retrySettings.maxRetries : 0;
		let final: AssistantMessage;
		try {
			final = await retryAssistantCall(
				produce,
				retrySettings,
				options?.signal,
				this.retryCallbacks(state, session, maxAttempts),
			);
		} catch (error) {
			// 抛异常的流函数破坏了引擎的契约，所以在这里落成一条错误消息，而不是一个没人接的 rejected
			// promise。
			final = error instanceof ContextOverflow ? error.message : failureMessage(model, error);
		}
		// 策略从未宣布结束的重试——运行在上方被砍短——仍要收口，否则 `isRetrying` 会活得比运行久。
		if (live.retrying) this.endRetry(state, session, false, live.retryAttempt, final.errorMessage);
		pushTerminal(outer, final);
		outer.end();
	}

	/**
	 * `retryAssistantCall` 发出的三个通知，一一映射到会话事件。
	 *
	 * `maxAttempts` 由泵递入——这次运行的重试所依据的对策略的唯一一次读取——因为策略为 `retry_start`
	 * 调用的回调不自带策略，这里也不在事件之间存那个答案。
	 */
	private retryCallbacks(state: AgentState, session: Session, maxAttempts: number): RetryCallbacks {
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
				publishState(state, session, this.services);
			},
			onRetryAttemptStart: () => {
				emitEvent(state, {
					type: "retry_start",
					attempt: live.retryAttempt,
					maxAttempts,
				});
				publishState(state, session, this.services);
			},
			onRetryFinished: (success, attempt, finalError) =>
				this.endRetry(state, session, success, attempt, finalError),
		};
	}

	/** 退出重试状态，说明重试是如何结束的。 */
	private endRetry(
		state: AgentState,
		session: Session,
		success: boolean,
		attempt: number,
		finalError?: string,
	): void {
		state.live.retrying = false;
		state.live.retryAttempt = 0;
		emitEvent(state, { type: "retry_end", success, attempt, finalError });
		publishState(state, session, this.services);
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
		state: AgentState,
		session: Session,
		entries: readonly SessionEntry[],
		now: number,
		signal: AbortSignal | undefined,
		model: Model,
	): Promise<readonly SessionEntry[]> {
		const threshold = compactionThresholdFor(model.contextWindow);
		if (!shouldCompact(messagesOf(entries), threshold)) return entries;

		const trimmed = this.trimRecordedArgs(state, session, entries);
		if (!shouldCompact(messagesOf(trimmed), threshold)) return trimmed;

		const cleared = this.clearStaleToolResults(state, session, trimmed, now);
		if (!shouldCompact(messagesOf(cleared), threshold)) return cleared;

		// 压缩唯一完成的一件事：与那一轮相同的模型，带着摘要指令。它是调用方的模型——本次请求构建所
		// 用的那一个——所以摘要携带与它所概括的对话相同的密钥、端点与窗口，而不是另起一份配置。
		const summarize: Summarize = async (request) => {
			// 与一轮会碰到的同一个缺席：没有行的会话以一句「该加什么」作答，而不是向占位端点发摘要
			// 请求。
			if (this.modelCatalog().find((userModel) => userModel.name === model.name) === undefined) {
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

		this.sessionManager.appendCompaction(
			session,
			outcome.summary,
			outcome.firstKeptEntryId,
			outcome.tokensBefore,
			outcome.usage,
		);
		// 在 transcript 移动之后发布，让作出反应的监听者读回相同的数字：`summarized` 是这一趟折进去
		// 的东西，`contextTokens` 是供应商接下来将收到的东西。
		const compacted = this.contextEntries(session);
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
		state: AgentState,
		session: Session,
		entries: readonly SessionEntry[],
	): readonly SessionEntry[] {
		const trimmed = trimmableToolArgEntryIds(entries);
		if (trimmed.length === 0) return entries;

		const tokensBefore = estimateTokens(messagesOf(entries));
		this.sessionManager.appendTrimToolCallArgs(session, trimmed, tokensBefore);
		const view = this.contextEntries(session);
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
		state: AgentState,
		session: Session,
		entries: readonly SessionEntry[],
		now: number,
	): readonly SessionEntry[] {
		if (!isCacheProbablyExpired(entries, now)) return entries;

		const cleared = clearableToolResultIds(entries);
		if (cleared.length === 0) return entries;

		const tokensBefore = estimateTokens(messagesOf(entries));
		this.sessionManager.appendClearToolResults(session, cleared, tokensBefore);
		const view = this.contextEntries(session);
		emitEvent(state, {
			type: "tool_results_cleared",
			cleared: cleared.length,
			tokensBefore,
			contextTokens: estimateTokens(messagesOf(view)),
		});
		return view;
	}

	/**
	 * 对一只袋点名的会话跑压缩阶梯——{@link Agent.maybeCompact} 的落点。
	 *
	 * 填充链在每个请求里、循环内部跑同样三步；这个私有形状让编排层可以对着自己点名的会话驱动它们，
	 * 演练修剪阶梯的 smoke 正是这么做的。模型在这里现算：按会话现行的选择从目录派生。
	 */
	private async compact(
		state: AgentState,
		bag: Session,
		entries: readonly SessionEntry[],
		now: number,
		signal?: AbortSignal,
		transport?: ChatTransport,
	): Promise<readonly SessionEntry[]> {
		const model = modelFor(this.modelChoice(bag, state.live.openedOn), this.modelCatalog(), transport);
		return this.compactFor(state, bag, entries, now, signal, model);
	}

	// ---------------------------------------------------------------------------- 运行的事件半

	/**
	 * 排空一条队列，把每条消息在取走的那一刻写进 transcript。
	 *
	 * 写搭在 drain 上、而不是搭在引擎的回显上：把消息从队列上拿下来，正是运行对它担起责任的时刻，
	 * 所以账本在那里获得它，「既不在队列里也不在存储里」的缝隙永远不会打开。回显从不落盘 user 消息，
	 * 所以没有什么需要被标记为已写。
	 */
	private drainTranscribed(queue: PendingMessageQueue, state: AgentState, session: Session): Message[] {
		const messages = queue.drain();
		for (const message of messages) {
			appendMessageEntry(state, session, this.sessionManager, message);
		}
		return messages;
	}

	/**
	 * 停下会话当前的运行，并等它安顿。
	 *
	 * 安顿的意思是：引擎完成它正在进行的那一轮的落盘，包括工具结果。abort 落在运行的控制器上——运行
	 * 在运行时注册的那个——结束的运行把它在写的东西写完，所以被停下的轮次在磁盘上是一轮完整的轮次。
	 * transcript 本会显示为没有结果的调用由 {@link Agent.denyAllApprovals} 关闭，所以 abort 不会留下
	 * 下一个请求无法再问的问题。
	 *
	 * 只在等退避走完的重试也被同一次调用取消：abort signal 正是 `retryAssistantCall` 睡觉所等的那个，
	 * 所以它返回一条 aborted 消息而不是睡到底。这里不必知道运行是活的还是在退避中。
	 */
	async abort(id: string): Promise<void> {
		const state = this.agentState(id);
		// 只读一次：运行在安顿时自己清掉自己的注册，而这个 promise 正是等待那次安顿的东西。
		const active = state.live.activeRun;
		active?.abortController.abort();
		await (active?.promise ?? Promise.resolve());
		// 运行在自己的 `finally` 里——空闲 promise resolve 之后的那个微任务——丢掉自己的槽位；也要等
		// 那个，好让下面的清扫看到的是它定义所在的那个空闲会话。
		while (state.live.activeRun !== undefined) await Promise.resolve();
		this.denyAllApprovals(id, "The run was aborted.");
		// 与一次正常结束的运行发布的是同一个结束、出于同样的理由：abort 正是一次没人要求停下的运行
		// 报告自己已停的方式。见 {@link Agent.prompt}。
		publishState(state, this.bag(id), this.services);
	}

	// ---------------------------------------------------------------------------- 配置挪动

	/**
	 * 把对话挪到自己这棵树的另一条分支上。
	 *
	 * store 从来就是一棵树——一条 entry 可以有任意多个孩子——而这是窗口在其中移动的唯一方式。leaf
	 * 落在 `entryId` 子树最新的尖端上，所以选择一个备选，会把它的整体带回它停下的那个点上，下一条
	 * prompt 从那里继续。什么都不删除：被离开的分支保有自己的 entry，仍可按 id 触达，从它们中的
	 * 任何一个 fork 仍复制它本来会复制的东西。
	 *
	 * `descend: false` 是同一手势的另一半——退回到某条消息本身，让下一条 prompt 在它那里开出一条
	 * *新的*备选，而不是延续已有的一条。在已存在的备选之间切换与退回以造一条新的，是一个操作的
	 * 两个端。
	 *
	 * 运行在飞时拒绝，因为运行向 leaf 追加：在它之下挪动，会把那一轮剩下的部分归入一个那一轮并没有
	 * 在回答的分支。
	 */
	branchTo(id: string, entryId: string, descend = true): string {
		const state = this.agentState(id);
		if (state.live.activeRun !== undefined) throw new Error("A run is in flight: the branch cannot move under it");

		const bag = this.bag(id);
		const leafId = descend ? this.sessionManager.getBranchTip(bag, entryId) : entryId;
		this.sessionManager.branch(bag, leafId);
		// 挪动不搭任何配置报告：模型、档位与工具选择如今是会话自己的值（`.json` 快照），挪 leaf 不改
		// 它们中的任何一个——不像它们还从分支的 entry 上重放的那些日子。
		emitEvent(state, { type: "branch_changed", leafId });
		publishState(state, this.bag(id), this.services);
		return leafId;
	}

	/**
	 * 收窄模型可以调用的工具。未知的名字抛错，会话保持原样。
	 *
	 * 变更记录在会话的 `.json` 快照上、在下一个请求上生效：填充链随每个请求从账本派生选择，所以
	 * 模型在下一条 prompt 构建时被告知收窄后的集合。
	 */
	setActiveTools(id: string, names: string[]): void {
		const state = this.agentState(id);
		const bag = this.bag(id);
		const previous = toolStateOf(this.sessionManager, bag, this.settingsManager, this.tools.names()).activeToolNames;
		const known = new Set(this.tools.names());
		const unknown = names.filter((name) => !known.has(name));
		if (unknown.length > 0) {
			throw new Error(`Unknown tool${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
		}
		if (names.length === previous.length && names.every((name, index) => name === previous[index])) return;

		this.sessionManager.setToolConfig(bag, [...names], approvalsOf(this.services, bag));
		publishState(state, this.bag(id), this.services);
		this.emitConfigChanged(state, { tools: [...names] });
	}

	/**
	 * 把本会话指向另一行、另一档，或两者。
	 *
	 * 选择是会话持有的一个值，所以在这里落到 `.json` 快照上——而且自 ADR-0019 起*立即*：调用之间
	 * 不留袋，未记录的选择无处可活，所以写入发生在手势上而不是下一个请求上。放弃的是「没人随消息
	 * 发出的选择不在文件里」；保住的是要紧的那条不变量：本次调用之后读快照，得到的就是新的模型与
	 * 档位，无论之后是否真的有请求。
	 *
	 * 所选模型没有容身的档位被拒绝而不是被钳制，因为调用方是输入框、它提供的就是它要挪去的那行的
	 * 档位；"off" 是例外，总是接受，因为它表示「这个模型最安静的样子」。
	 */
	applyModelSelection(id: string, selection: ModelSelection): void {
		const state = this.agentState(id);
		// 什么都没点名就没有事可做，这正是调用方发普通消息的方式。
		if (selection.model === undefined && selection.thinkingLevel === undefined) return;

		const bag = this.bag(id);
		const setting = bag.sessionSetting;
		// 现行的选择，不只是记录的那个：没人选过模型的会话也有一条——设置的默认，派生方式与每次读取
		// 完全一样（ADR-0019）——而只点名档位的手势必须连带指名那一行才记录得下来。
		const inForce = modelChoiceOf(this.sessionManager, bag, this.settingsManager, state.live.openedOn);
		const previousName = setting.model?.name ?? inForce.name;
		const previousLevel = normalizeThinkingLevel(setting.model?.thinkingLevel ?? inForce.thinkingLevel);

		const name = selection.model ?? previousName;
		const userModel = this.settingsManager.modelCatalog().find((userModel) => userModel.name === name);
		if (userModel === undefined) throw new Error(`Unknown model: ${name}`);

		// 选择是客户端的选择，按到达时的原样写到会话自己的 setting 上：行的名字、该行此刻应答的
		// wire id，以及调用方点名的档位或已在生效的那个。wire id 随写入一起走，因为这*就是*那次写入
		// （ADR-0019）：载着它的袋在本函数返回的那一刻就被丢掉，而磁盘格式只在两个名字都在场时才记
		// 一行——不带 id 的写入会让文件里根本没有模型，下一次重放会答「从未选择过」。
		const renamed = previousName !== userModel.name;
		setting.model = {
			// 换名时连它所属的 wire id 一起丢掉；该行自己的 id 无论如何都会在下面补上位置。
			...(renamed ? {} : setting.model),
			name: userModel.name,
			modelId: userModel.id,
			thinkingLevel: selection.thinkingLevel ?? normalizeThinkingLevel(setting.model?.thinkingLevel),
		};
		// 快照从袋上整体重写，这就是为什么一次调用就是完整的写入：上面那个 setter 留在袋上的，正是
		// 文件此后必须持有的东西。
		this.sessionManager.flushMeta(bag);

		publishState(state, bag, this.services);
		this.emitConfigChanged(state, {
			...(setting.model.name === previousName ? {} : { model: userModel.name }),
			...(normalizeThinkingLevel(setting.model.thinkingLevel) === previousLevel
				? {}
				: { thinkingLevel: setting.model.thinkingLevel }),
		});
	}

	/**
	 * 更新设置并落盘。审批变更在下一个工具调用上生效。
	 *
	 * 补丁的两半住在不同的地方。审批是会话级的：它合并进本会话自己的选择、记录在它的 `.json` 快照
	 * 上，所以同一目录上的另一个会话不受影响。其余经 {@link SettingManager} 交给设置——它拥有那些
	 * 文件——并落到运行时的队列上，队列在每次取走时读模式。
	 *
	 * 模型与思考档位完全不属于补丁。它们在输入框里选、随属于它们的消息抵达（{@link ModelSelection}），
	 * 所以这里没有可应用的：没有请求跟上的配置变更就不是配置变更。
	 */
	applyConfig(id: string, patch: ConfigPatch): void {
		const state = this.agentState(id);
		const bag = this.bag(id);
		const workDirAbsPath = bag.sessionSetting.workDirAbsPath;
		const previousApprovals = approvalsOf(this.services, bag);
		if (patch.approval !== undefined) {
			// 快照记录生效中的整张映射——设置叠上本会话的选择——这正是账本每次读取作答的形状。
			const approvals = { ...previousApprovals, ...patch.approval };
			const activeToolNames = toolStateOf(this.sessionManager, bag, this.settingsManager, this.tools.names()).activeToolNames;
			this.sessionManager.setToolConfig(bag, activeToolNames, approvals);
		}
		// 补丁的其余部分经 manager 交给设置，写入归它所有：变更落在文件上，之后的每次读取——本会话
		// 的与该目录上任何其他会话的——都从它们作答。
		this.settingsManager.applySettings(workDirAbsPath, patch.approval === undefined ? patch : { ...patch, approval: undefined });
		state.live.steeringQueue.mode = this.settingsManager.getSteeringMode(workDirAbsPath);
		state.live.followUpQueue.mode = this.settingsManager.getFollowUpMode(workDirAbsPath);
		const after = this.bag(id);
		publishState(state, after, this.services);
		this.emitConfigChanged(state, {
			approvals: changedApprovals(previousApprovals, approvalsOf(this.services, after)),
		});
	}

	// ---------------------------------------------------------------------------- 审批

	/**
	 * transcript 仍在等的工具调用，以审批流看到的形状。
	 *
	 * 从账本派生、从不持有（ADR-0006 §5）：一个正在等的审批*就是*视图里的悬空调用，答案经 REST 抵达
	 * 关闭它。运行在飞时为何一个都不报，见 {@link Agent.hasPendingApprovals}。
	 */
	private danglingApprovals(session: Session): PendingApproval[] {
		return danglingApprovalsOf(this.sessionManager.buildContextEntries(session));
	}

	/**
	 * 这个 id 是否点着一个没人回答的工具调用。只读。
	 *
	 * 审批端点在回答之前检查它，因为检查必须在不回答的前提下发生：一个答案会启动关闭该调用的恢复
	 * 运行，而报告落定的帧正是从它落地时的变更构建的——先记录答案，正是让那一帧不被读回答案的人读成
	 * 一次 deny 的原因。未知 id 是端点的 409，不是无声的空操作：一个什么都不回答也不吭声的按钮，
	 * 比一个客户端能显示的错误更糟。
	 */
	hasPendingApproval(id: string, toolCallId: string): boolean {
		if (this.sessions.get(id)?.live.activeRun !== undefined) return false;
		return this.danglingApprovals(this.bag(id)).some((call) => call.toolCallId === toolCallId);
	}

	/**
	 * 回答一个未答的工具调用，并恢复提出它的那次运行。
	 *
	 * 结束重启链的应答半（ADR-0006 §5）：提出调用的运行已经结束，调用在账本里悬空，答案启动关闭它
	 * 的那次运行。引擎的恢复遍按 id 把答案与调用配对——grant 让调用穿过闸门与工具本身重跑，deny 用
	 * 「按下 deny」写下的那句话关闭它——运行从那里继续，所以模型看到调用已解决并在同一次运行里继续。
	 * grant 还会把该工具的审批选择——该工具不再问——记到会话的 `.json` 快照上，与配置补丁是同一个
	 * 动作：恢复遍让调用重新过闸门，而闸门只放行映射不再闸住的工具。
	 *
	 * 没有任何东西在等的 id 被忽略：调用方先检查过、又回答了它。答案没有点名的悬空调用由恢复遍作为
	 * 孤儿关闭——这正是崩溃留下多个调用时，恢复后的请求仍对供应商合法的原因。
	 */
	async respondApproval(id: string, toolCallId: string, approved: boolean): Promise<void> {
		const state = this.agentState(id);
		if (state.live.activeRun !== undefined) return;
		// 一次重放服务整个调用：答案在它里面查——而答案是 grant 时，它记录的选择也经同一只袋写下，
		// 赶在关闭该调用的那一次运行在这只袋上开始之前。
		const bag = this.bag(id);
		const call = this.danglingApprovals(bag).find((candidate) => candidate.toolCallId === toolCallId);
		if (call === undefined) return;
		const answer: ToolCallAnswer = approved
			? { approved: true }
			: { approved: false, reason: `The user denied permission to run ${call.toolName}.` };
		if (approved) {
			// grant 是会话对该工具自己的选择，以生效中的整张映射、把该工具翻成关的方式记录——与配置
			// 补丁是同一个动作。
			const approvals = { ...approvalsOf(this.services, bag), [call.toolName]: false };
			const activeToolNames = toolStateOf(this.sessionManager, bag, this.settingsManager, this.tools.names()).activeToolNames;
			this.sessionManager.setToolConfig(bag, activeToolNames, approvals);
		}
		// 在运行开始之前说出：选择是会话自己的、现在就落，而调用本身保持悬空，直到运行的恢复遍关闭它。
		publishState(state, bag, this.services);
		await this.run({ state, bag, start: { answers: { [toolCallId]: answer } } });
	}

	/**
	 * 用「无人回答」的理由关闭每一个未答的工具调用。
	 *
	 * 理由随答案进入 transcript：每个被关闭调用的工具结果说的是实际发生了什么——运行被中止、没有
	 * 窗口回答——而不是「按下 deny」写下的同一句话，那会把一次弃置记录成一个选择。
	 *
	 * 只有空闲的会话关闭任何东西：运行中途悬空的调用是引擎自己正要写的结果，在这里关闭会把答案写
	 * 两遍。
	 *
	 * 队列随之清空。被挂起的运行保有自己的队列，因为它等的那次恢复运行正是会取走它们的；本函数就是
	 * 「不会有恢复运行了」的通告，所以被接受的东西将永远无人取走——一个没人会降低的深度，是会话在
	 * `settle` 上永远等不完的原因。
	 */
	denyAllApprovals(id: string, reason: string): void {
		const state = this.agentState(id);
		if (state.live.activeRun !== undefined) return;
		const bag = this.bag(id);
		const dangling = this.danglingApprovals(bag);
		if (dangling.length === 0) return;
		for (const call of dangling) this.appendDanglingResult(state, bag, call, { approved: false, reason });
		// 弃置清扫是一个停驻会话的阅读终点：不会再有恢复运行，suspended 标志再没有可说的——而它若
		// 一直立着，会让状态自己的驱逐永远被拒（判据读这个标志）。
		state.live.suspended = false;
		// 快照的显示缓存跟随标志：这里没有运行来清扫它。
		this.sessionManager.setSuspended(bag, false);
		if (dropQueued(state)) emitQueueUpdate(state);
		publishState(state, bag, this.services);
	}

	/** 写下关闭一个悬空调用的结果，并像其他消息一样通告该 entry。 */
	private appendDanglingResult(
		state: AgentState,
		bag: Session,
		call: PendingApproval,
		answer: { approved: boolean; reason?: string },
	): void {
		const text = answer.approved
			? `The user approved running ${call.toolName}. Issue the call again to run it.`
			: answer.reason ?? `The user denied permission to run ${call.toolName}.`;
		const message: Message = {
			role: "toolResult",
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			content: [{ type: "text", text }],
			details: {},
			isError: !answer.approved,
			timestamp: Date.now(),
		};
		appendMessageEntry(state, bag, this.sessionManager, message);
	}

	/**
	 * 被设置标记为需要审批的工具是否仍需要用户的答案。
	 *
	 * 这是闸门的裁决，不是它的措辞：返回的只是这个调用此刻可否运行。在结束重启语义下，需要答案的
	 * 调用既得不到 block 也得不到结果——`before_tool` 闸门把这个答案变成结束运行、让调用在账本里
	 * 悬空的 suspend，答案经 REST 抵达、启动关闭它的恢复运行。映射不闸的工具不经询问直接运行。
	 */
	async authorize(id: string, name: string, _toolCallId: string, _args: unknown): Promise<boolean> {
		return approvalsOf(this.services, this.bag(id))[name] === true;
	}

	// ---------------------------------------------------------------------------- 等待与收尾

	/**
	 * 等当前运行结束、它的写入落盘，而不停下任何东西。已空闲的运行立即返回。
	 *
	 * 排队消息是接受它的那次运行的一部分，所以运行被取到尽头：一轮安顿时队列仍可能非空，而这正是
	 * 等「transcript 已完整」的调用方绝不能在其上 resolve 的情况。{@link Agent.close} 先停运行，
	 * 这正是它能终止的原因。
	 *
	 * 被闸门结束的运行视为已安顿、不被等待：它的队列留给恢复运行，`stillBusy` 把悬空调用读作
	 * 「一个问题，不是工作」——与 {@link Agent.close} 把可停驻的调用留给人的读法相同。没有这条，一
	 * 个停驻的会话在安顿它的每个调用方眼里都像是忙的——首当其冲的是上面 hub 的收割。
	 *
	 * 待处理的重试同样是运行的一部分，所以等它而不是绕过它：重试在引擎正 await 的那条流里跑，这
	 * 让 agent 在整个退避期间都非空闲，条件放在这里，正是为了那件事万一变化时这一点仍然成立。
	 */
	async settle(id: string): Promise<void> {
		const state = this.agentState(id);
		// 经闭包读取：运行槽位在下面的 await 之间被重新赋值，在它们之前取的窄化会让检查器断定
		// 这个槽位在此处永远为空。
		const stillBusy = (): boolean =>
			(state.live.followUpQueue.size > 0 && this.danglingApprovals(this.bag(id)).length === 0) ||
			state.live.retrying === true;
		for (;;) {
			await (state.live.activeRun?.promise ?? Promise.resolve());
			// 运行在空闲 promise resolve 之后一个微任务才丢掉自己的槽位；也要等那个，让安顿的调用方
			// 看到的是空闲的会话——以及运行结束时悬空的调用——而不是一个还在写完尾巴的。与 `abort`
			// 的有界等待相同。
			while (state.live.activeRun !== undefined) await Promise.resolve();
			if (!stillBusy()) return;
		}
	}

	/**
	 * 停下运行（若有），并等会话安静下来。
	 *
	 * 悬着的调用仍是一个问题：transcript 是唯一的状态（ADR-0006 §5），重开时从账本派生并再次显示它，
	 * 那时抵达的答案启动关闭它的运行。close 不替用户作答——退出时曾写下的 deny 把弃置记录成选择，
	 * 继承它们的重开继承的是一句谎话。{@link Agent.abort} 是有意的停止，deny 是它的答案；进程关闭
	 * 与已经 deny 过的收割都会落到这里。
	 *
	 * 表不持有的 id 无运行可停、无事可等，所以对它立即返回——调用方从不先分支判断成员资格。这正是
	 * 吸收「是否还欠一次 close」复查的原因：某个驱逐边缘曾在问题与 close 之间把状态丢掉，而与它赛跑
	 * 的 close 不过是对着空无的 close。
	 */
	async close(id: string): Promise<void> {
		const state = this.sessions.get(id);
		if (state === undefined) return;
		state.live.activeRun?.abortController.abort();
		await this.settle(id);
	}

	/**
	 * 对按 id 点名的会话跑压缩阶梯。
	 *
	 * 填充链在每个请求里、循环内部跑同样三步；这个公开形状让调用方可以对着自己点名的会话驱动它们
	 * ——演练修剪阶梯的 smoke 正是这么做的。本方法只递会话与压缩自己的调用值：模型与上下文由
	 * {@link Agent.compact} 现算。
	 */
	maybeCompact(
		id: string,
		entries: readonly SessionEntry[],
		now: number,
		signal?: AbortSignal,
		transport?: ChatTransport,
	): Promise<readonly SessionEntry[]> {
		return this.compact(this.agentState(id), this.bag(id), entries, now, signal, transport);
	}

	// ---------------------------------------------------------------------------- 配置报告

	/** 只带变动字段地报告一次配置变更；一个都没动时保持沉默。 */
	private emitConfigChanged(
		state: AgentState,
		changes: {
			model?: string;
			thinkingLevel?: string;
			approvals?: Record<string, boolean>;
			tools?: string[];
		},
	): void {
		if (
			changes.model === undefined &&
			changes.thinkingLevel === undefined &&
			changes.approvals === undefined &&
			changes.tools === undefined
		) {
			return;
		}
		emitEvent(state, { type: "config_changed", ...changes });
	}

	// ---------------------------------------------------------------------------- 事件契约
	//
	// 运行报告的每件事在这里落盘并扇出——引擎经自己的 `emit` sink 调用它，与命令面的发布（abort /
	// branchTo / denyAllApprovals）是同一份窗口契约的两半。引擎与其机件是本类的方法与本文件的
	// 文件级函数（ADR-0024）。

	/**
	 * 运行的事件 sink：落盘运行报告的东西，并把它传下去。
	 *
	 * 落盘、清队列、投影的组合政策与命令面的发布（abort / branchTo / denyAllApprovals）同住本文件
	 * ——它们是同一份窗口契约的两半，两个实现者分居两文件就会漂移。这是
	 * 运行唯一的监听者——loop await 它，这正是运行只在写入落地之后才算安顿的原因——运行的瞬态
	 * 是这个处理器的闭包，而不是会话上的任何东西。它也是引擎不需要自己的监听者注册表的原因。
	 */
	private async dispatchEvent(state: AgentState, session: Session, event: AgentEvent): Promise<void> {
		const live = state.live;
		if (event.type === "message_update") {
			// 热路径：每个供应商 delta 一个事件。留住运行中的消息，供必须把错过的文本交给中途挂上来的
			// 用户的 baseline 使用；只发布自上一帧以来动了的部分。这里什么都不写——消息结束时才落盘。
			live.partial = event.message;
			const delta = messageDeltaOf(event);
			if (delta !== undefined) emitEvent(state, { type: "message_update", delta });
			return;
		}
		if (event.type === "message_end" || event.type === "agent_end") live.partial = undefined;
		if (event.type === "message_end") {
			// 回显从不落盘 user 消息：每一条到达引擎时都已经写好——运行开始前的 prompt，取走时的排队
			// 消息。引擎通告的其余东西没有别的写者，在这里按现状写下——落到这里时内容已是定稿（写边界
			// 是最后一次改写）。
			if (event.message.role !== "user") {
				appendMessageEntry(state, session, this.sessionManager, event.message);
			}
		}
		if (event.type === "agent_end" && !live.suspended) {
			// 仍在队列里的消息是运行从未抵达的——一次 abort、一场失败、一条恰在引擎停止寻找的时刻到达
			// 的 prompt。没有人会取走它，而发送契约是 fire-and-forget：它随运行而去，队列清空、深度
			// 归零，这正是 `settle()` 所等的。见 `dropQueued`。
			//
			// 被闸门结束的运行是唯一的例外，在这里检查而不只在 `run` 的 `finally` 里，因为这里先触发：
			// 恢复运行会取走这一次留下的东西，所以深度保持不降、窗口继续显示它。
			if (dropQueued(state)) emitQueueUpdate(state);
		}
		emitEvent(state, event);
		if (event.type === "message_start" || event.type === "message_end" || event.type === "turn_end") {
			publishState(state, session, this.services);
		}
	}
}

/**
 * 取值有差异的审批键，没有差异时为 undefined。
 *
 * `config_changed` 只携带动过的东西，所以一次重发当前设置的 `applyConfig`——重连或未改动的表单正是
 * 这样做的——不得声称任何东西变了。
 */
function changedApprovals(
	before: Record<string, boolean>,
	after: Record<string, boolean>,
): Record<string, boolean> | undefined {
	const changed: Record<string, boolean> = {};
	let moved = false;
	for (const [key, value] of Object.entries(after)) {
		if (before[key] === value) continue;
		changed[key] = value;
		moved = true;
	}
	return moved ? changed : undefined;
}

// ---------------------------------------------------------------------------- 引擎机件
//
// 一次运行的文件级机件（ADR-0024 随引擎一并搬入）：一轮的流、一个工具批、恢复遍，以及它们之间
// 传递的形状。它们不持有会话，把两个工具调用闸门当作运行递进来的那对回调（{@link ToolChain}），
// 这正是它们是一组函数而不是方法的原因。恢复机件被导出，因为它是 smoke 直接驱动的契约
// （ADR-0006 §5）；其余为本模块私有。

/** 一次运行的事件去向。被 await，所以运行只在它发出的东西被处理完之后才安顿。 */
type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** 执行动词的形状：`ToolManager.execute` 的镜像，`name` 是首参（票 001 §D）。 */
type ToolChainExecute = (
	name: string,
	toolCallId: string,
	params: unknown,
	run: ToolRunContext,
	signal?: AbortSignal,
	onUpdate?: ToolUpdateCallback<any>,
) => Promise<ToolResult<any>>;

/** 工具调用之前的裁决。 */
type ToolChainDecideBefore = (event: HookEvent<"before_tool">) => Promise<HookResult<"before_tool">>;

/** 工具结果上的裁决。 */
type ToolChainDecideAfter = (event: HookEvent<"after_tool">) => Promise<HookResult<"after_tool">>;

/**
 * 一次运行的工具链：两个闸门、解析与执行。批处理机件是文件级的、不持有会话，所以运行把自己需要的
 * 接缝以实参递给它们——与这条链上处处一样以实参抵达，不经过 context。解析只对着 `declared` 按名
 * 查：调用只能落到本请求声明过的工具上（ADR-0016）。
 */
export interface ToolChain {
	/** 运行所在会话的 id：闸门事件点名它。 */
	sessionId: string;
	/** 本次请求声明过的工具：解析所依据的声明数组，元素是表自己的实例。 */
	declared: readonly Tool<any>[];
	/** 运行一次工具调用：`ToolManager.execute` 的动词化。 */
	executeTool: ToolChainExecute;
	/** 工具调用之前的裁决。 */
	decideBeforeTool: ToolChainDecideBefore;
	/** 工具结果上的裁决。 */
	decideAfterTool: ToolChainDecideAfter;
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
