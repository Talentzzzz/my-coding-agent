import { assembleSession, type AssembleAgentStateOptions } from "./assembly.ts";
import { type ChatTransport, type Message } from "./llm/index.ts";
import { type AgentsMdFile } from "./context/agents-md.ts";
import type { Hooks } from "./hooks.ts";
import { normalizeThinkingLevel, type ModelConfig } from "./models.ts";
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
} from "./session/session-manager.ts";
import { toolStateOf } from "./session/tool-config.ts";
import { UnknownSessionError } from "./session/unknown-session.ts";
import type { SettingsPatch } from "./setting-manager.ts";
import type { SettingManager } from "./setting-manager.ts";
import type { Settings } from "./config.ts";
import type { ToolManager } from "./tools/index.ts";
import { type AgentEvent, type ToolCallAnswer } from "./types.ts";
import { LoopManager, type LoopOptions, type RunStart } from "./loop-manager.ts";

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
 * 本进程跑的每一段对话共有的编排服务。
 *
 * 这是无状态架构的编排层（ADR-0006 §1）：四个域是无状态单例，而跨域的顺序——应用输入框的选择、
 * 按 id 解析会话、写下消息、跑引擎、再报告动了什么——住在这里、别无他处，因为它不属于任何单个域。
 *
 * 一次运行的机械是 {@link LoopManager}（ADR-0022）：零字段的对象，本类是它在本进程的唯一消费者。
 * 三个运行入口为每次调用现凑一只 {@link LoopOptions}——三件每次调用的值、六件本类持有的服务（账本、
 * 配置、工具表、接缝、prompt builder、传输层）、两条白名单回调（`bagOf` 开袋、`emit` 事件 sink）。
 * 这里的其余一切都是会话自己的命令面——transcript 读取、审批、配置挪动，以及命令作答所经的 fanout。
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
	/** 请求据此构建的 prompt builder；调用它的是 loop 的按请求填充链（`LoopManager.prepareRequest`）。 */
	private readonly systemPrompt: AgentConfig["systemPrompt"];
	/** 请求真正离开的地方：传输层，重试策略包上它之前的那个。 */
	private readonly api: ChatTransport;
	/**
	 * 一次运行的全部机械（ADR-0022）：零字段的对象，要什么由 loopOptions 在调用时给。它不持有任何
	 * 东西，所以两个会话的运行可以同时跑在这一个实例上；本类是它在进程里的唯一消费者。
	 */
	private readonly loop = new LoopManager();
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
	 * 一次运行的参数袋，在调用点现凑（ADR-0022）：`state` / `bag` / `start` 三件每次调用的值、六件
	 * 本类的服务、两条白名单回调——`bagOf` 是开袋的唯一入口（会话表是本类私有的），`emit` 是事件
	 * sink（落盘、清队列、投影的组合政策，实现见 {@link Agent.dispatchEvent}）。它是一次调用的参数表，
	 * 用完就丢，不是被持有的聚合袋（ADR-0007）。
	 */
	private loopOptions(state: AgentState, bag: Session, start: RunStart): LoopOptions {
		return {
			state,
			bag,
			start,
			sessionManager: this.sessionManager,
			settings: this.settingsManager,
			tools: this.tools,
			hooks: this.hooks,
			systemPrompt: this.systemPrompt,
			api: this.api,
			bagOf: (id) => this.bag(id),
			emit: (runState, session, event) => this.dispatchEvent(runState, session, event),
		};
	}

	/**
	 * 把被提示的消息写进 transcript，然后在它之上运行。
	 *
	 * 这里打开的袋就是运行携带的那只：transcript 在这里读一次，把 prompt 作为它的第一次写入，交给
	 * loop（{@link LoopManager.run}），让运行的任何一轮都不必再读它（ADR-0019）。这就是「一次运行一次
	 * 重放」的全部——普通 prompt 花的读与 open 曾经花的相同，之后的每一轮都是在运行已拥有的那只袋上走。
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
		await this.loop.run(this.loopOptions(state, bag, { prompt: message }));
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
		await this.loop.run(this.loopOptions(state, bag, { answers: { [toolCallId]: answer } }));
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
	 * ——演练修剪阶梯的 smoke 正是这么做的。模型由 loop 现算（ADR-0022 决定 3）：本方法只递会话与
	 * 压缩自己的调用值，不再摸设置门。
	 */
	maybeCompact(
		id: string,
		entries: readonly SessionEntry[],
		now: number,
		signal?: AbortSignal,
		transport?: ChatTransport,
	): Promise<readonly SessionEntry[]> {
		const state = this.agentState(id);
		const bag = this.bag(id);
		return this.loop.compact({
			state,
			bag,
			entries,
			now,
			signal,
			transport,
			sessionManager: this.sessionManager,
			settings: this.settingsManager,
		});
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
	// 运行报告的每件事在这里落盘并扇出——这是白名单回调 `emit` 的实现侧（ADR-0022 决定 4），loop 经
	// loopOptions 拿到它。其余一次运行的机械住在 `loop-manager.ts`，由上面的运行入口组袋调用。

	/**
	 * 运行的事件 sink：落盘运行报告的东西，并把它传下去。
	 *
	 * 落盘、清队列、投影的组合政策与命令面的发布（abort / branchTo / denyAllApprovals）同住本文件
	 * ——它们是同一份窗口契约的两半，两个实现者分居两文件就会漂移（ADR-0022 白名单的答辩）。这是
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
