import { resolve as resolvePath } from "node:path";
import type { ChatTransport } from "./llm/index.ts";
import type { SessionSink } from "./agent.ts";
import { createModel } from "./models.ts";
import type { SessionSnapshot } from "./protocol.ts";
import { createAgentState, type AgentState, createLive } from "./session/agent-state.ts";
import { danglingApprovalsOf } from "./session/dangling.ts";
import { type Session, SessionManager } from "./session/session-manager.ts";
import { sessionSnapshot } from "./session/snapshot.ts";
import { resolveSettings, type Settings } from "./settings.ts";
import { SettingManager } from "./setting-manager.ts";
import { type ToolManager, createToolManager } from "./tools/index.ts";

/** 调用方构建一个会话必须提供的东西。其余都在这里查明。 */
export interface OpenAgentOptions {
	/**
	 * 冷读重放所依据的无状态会话服务。
	 *
	 * 只有 {@link readSessionSnapshot} 读它：冷读按被递入的会话点名自己的袋，新造的 manager 行为完全
	 * 一致，因为服务不持有自己的袋（ADR-0006 §2）——调用方自己的实例只改变这次走读用的是*哪*一份
	 * 存储知识。编排层不收它：{@link openAgent} 把 settings、tools 与 transport 接缝转发给工厂，把
	 * 账本留给它构建的 agent，后者拥有自己的那一份。
	 */
	sessionManager?: SessionManager;
	/**
	 * 本会话将要读写的 会话记录，即每次调用点名的那只袋。
	 *
	 * 由调用方构建而不是在这里构建，因为决定打开*哪个*会话——新的、最新的、按 id 点名的——是宿主
	 * 的差事，测试则改开内存里的。
	 */
	session: Session;
	/**
	 * 每次设置与模型读取所经的配置门。
	 *
	 * 省略表示在机器自己的文件之上新造一只 manager——与不带 options 的 hub 会构建的默认相同。在非
	 * 默认 agent home 之下读取的宿主——即 hub——递入自己的，因为回落者无从知道那个 home；测试递入
	 * 内存版，让机器自己的文件永远不被碰。manager 什么都不持有：每次读取都是对其背后文件的一次
	 * 新读，这正是让一次编辑抵达一个从未重开的会话的原因。
	 */
	settings?: SettingManager;
	/**
	 * 本会话每个请求走的传输层。
	 *
	 * 真实进程里省略，表示 Anthropic Messages。smoke 传脚本化的传输层，让运行可以在没有供应商密钥
	 * 的情况下被驱动。只有编排层的构造读它——装配从不发送任何东西，这正是它不在
	 * {@link AssembleAgentStateOptions} 里的原因。
	 */
	api?: ChatTransport;
		/**
		 * 本次装配用来解析工具的表。
		 *
		 * 省略表示装配自己的一张表，装着六个内置——打开一个会话的 smoke 要的就是这个。宿主递入自己的：
		 * hub 为进程保一张表，所以它运行的会话与它只读快照的会话应答同样的工具名、持有同样的实例
		 * （ADR-0011）。测试在注册了自己的工具之后递入一张。
		 */
		tools?: ToolManager;
		/**
		 * 事件与快照离开编排层的出口，透传给工厂。
		 *
		 * 只有订阅了自己打开的会话的调用方——驱动它的 smoke——需要它：hub 经 {@link CreateSessionAgentOptions.sink}
		 * 递入自己的实现，这里只是让它能走与 `openAgent` 相同的组合之路。省略即 no-op，没人听就
		 * 什么也不发生。
		 */
		sink?: SessionSink;
	}

/**
 * {@link Agent.assembleAgentStateBySession} 需要什么：会话记录，仅此而已。
 *
 * 有意比 {@link OpenAgentOptions} 窄。差别是权威性：这扇门属于编排层，所以服务是*它自己的*
 * ——调用方无法递给它第二只 `SettingManager` 或自己的工具表，这正是 `adopt` 曾允许而无人检查的
 * 失配。留在这里的是编排层无法知道的那部分：**哪个** 会话记录（宿主的决定，session manager 的
 * 重放）——会话记录 在 `settings.workDirAbsPath` 上自带工作目录。
 *
 * 模型字段不是宿主控制默认值的把手。面向宿主的动词（`createAndPrompt`、`hold`、`snapshotOf`）
 * 都不收它：会话的模型是一个设置事实，装配在每次打开时从磁盘现读；出生时的选择由
 * `createAndPrompt` 在装配之前落到会话记录自己的快照上。
 */
export interface AssembleAgentStateOptions {
	/** 要装配并放进表里的 会话记录；它自带工作目录。 */
	session: Session;
}

/**
 * 一个会话*是*什么，已解析但尚未激活：工作目录、设置、模型，以及它运行用的工具。
 *
 * 此刻没有 `Agent` 存在，也没有追加任何 entry。把它从编排层的打开里拆出来——并住在这个文件里
 * 而不是旁边——正是让 {@link readSessionSnapshot} 能用与活跃会话装配时相同的决定来回答一份本进程
 * 并未运行的 会话记录 的原因，而不是用一个可能各执一词的第二实现。
 */
interface Assembled {
	/** 工作目录，绝对路径。 */
	workDirAbsPath: string;
	/** 本会话每次设置与模型读取所经的 manager。 */
	settings: SettingManager;
	/** 两半组合出的有效视图：活跃工具集、有效审批、模式座位与完整模型行（ADR-0019）。 */
	resolved: Settings;
	/** 本构建认识的工具：每进程一张表，这里只为读它的名字。 */
	tools: ToolManager;
	/** 会话服务，在这里只解析一次，让一次装配的每个消费者共享它。 */
	sessionManager: SessionManager;
}

/**
 * 解析一个会话是什么，而不激活它。
 *
 * 会话需要的一切，与运行无关的东西一样没有：不构造 `Agent`，不安装 hook，不往 会话记录 追加
 * entry。编排层的打开（经 {@link assembleSession}）与 {@link readSessionSnapshot} 都经过这里，
 * 这才是要紧的性质——本进程未运行的会话，由与它本该被装配时相同的决定、相同的顺序描述。
 *
 * 服务是必填实参，不是带回落的 options：打开的服务按构造即其编排层自己的，冷读没有编排层可取，
 * 在下面解析一套新的。本文件不从 `agent.ts` 导入任何东西，这是硬规则而不只是事实：
 * `Agent.assembleAgentStateBySession` 是它在激活侧唯一的调用者，反向导入会闭上
 * `agent.ts` → `assembly.ts` → `agent.ts` 这个循环。
 */
async function assemble(sessionManager: SessionManager, settings: SettingManager, tools: ToolManager, options: AssembleAgentStateOptions): Promise<Assembled> {
	// workDirAbsPath 变成绝对路径的唯一一处，让之后每次对该 entry `workDirAbsPath` 的读取——工具的
	// run context、prompt、快照——都是同一个值。目录是 会话记录 自己的：`createSession` 种下时已
	// 解析、重放时恢复，所以这里没有覆盖——会话自己决定住在哪里，没有调用方递入第二个答案。
	const workDirAbsPath = resolvePath(options.session.settings.workDirAbsPath);
	// 两半组合出的有效视图（ADR-0019）：global 侧与目录的各行在这里各现读一次，会话侧的选择来自
	// 袋自己。它是派生的而不是被存下的（ADR-0013），因为会话之后每次读取都得从刚重放的那只袋回答
	// 同一个问题。没有行的会话照样打开，`Agent` 用一句「该加什么」替它作答：占位行在完全无名的状态
	// 下承担事实，拒绝发送的是传输层。
	const resolved = resolveSettings(options.session, settings.getSettings(), settings.modelCatalog(), tools.names());
	// 表的内容是行为而不是目录，所以一张表服务所有会话。这里同样不做任何选择：活跃集与审批已经
	// 组合在 `resolved` 里，之后的每次读取都重算一次。
	return { workDirAbsPath, settings, resolved, tools, sessionManager };
}

/**
 * 不激活就读取一个会话的状态。
 *
 * {@link openAgent} 的冷半：走同一个 {@link assemble}，所以工作目录、模型、思考档位、工具集与
 * 审批映射，就是这份 会话记录 上的活跃会话本该有的——而且到此为止。没有 `Agent`，没有循环，
 * 没有 hooks；循环本该回答的字段以它们本来的空闲值给出，因为没有运行可供报告。
 *
 * 与装配一样，它什么都不追加。读 会话记录 不得成为 会话记录 里的事件，否则打开一个会话的
 * 历史就与使用它无从区分了。
 */
export async function readSessionSnapshot(options: OpenAgentOptions): Promise<SessionSnapshot> {
	// 冷读没有编排层可取服务，回落的三只在这里原地构造。新造的 manager 行为完全一致：
	// manager 什么都不持有（ADR-0006 §2），所以调用方自己的实例改变的只是读*哪些*
	// 文件与存储——hub 递入自己那份正是为此。
	const sessionManager = options.sessionManager ?? new SessionManager();
	const settings = options.settings ?? new SettingManager();
	const tools = options.tools ?? createToolManager();
	const { workDirAbsPath, resolved } = await assemble(sessionManager, settings, tools, options);
	return sessionSnapshot({
		sessionManager,
		session: options.session,
		workDirAbsPath,
		// 快照只从模型上读名字、档位与窗口；请求对象在这里与在一次请求里一样是即抛的。用本次装配
		// 组合出的行现建，所以一次冷读只花文件一次。
		model: createModel(resolved.model.config, resolved.model.thinkingLevel),
		// 与活跃会话运行的是同一套组合（`resolveSettings`）：冷读与活跃快照在这里必须一致，否则
		// 会话一从打开变成仅读取，座位就会翻面。
		mode: resolved.mode,
		running: false,
		queued: [],
		isRetrying: false,
		retryAttempt: 0,
		// 与活跃会话完全一样地从账本派生：一次已结束的运行——闸门的或崩溃的——留下的悬空调用，冷读
		// 也显示它，因为关闭它的答案经 REST 抵达，送给碰巧在运行该会话的那个进程。
		pendingApprovals: danglingApprovalsOf(sessionManager.buildContextEntries(options.session)),
	});
}

/**
 * 装配一个会话的状态：seed→fill 生命周期的 seed 半（ADR-0005 §2）。
 *
 * 产出的是**live 半**——两条队列、它们的模式，仅此而已（ADR-0013）。递进来的 会话记录 是*入参*，
 * 不是成员：出生的袋在这里被丢掉，因为 `bag(id)` 会按需再重放一次——会话记录以文件为唯一形态，
 * 重放随时能再造它。工作目录留在那只袋上（之后每次调用都重放它），设置从来不是任何状态的一部分
 * ——它们经编排层持有的 {@link SettingManager} 实时读取。
 *
 * 模型选择既不保留也不播种：每次读取都派生它（`session/model-choice.ts`），这是袋被丢掉之后唯一
 * 能幸存的形状。
 *
 * 服务是必填实参而不是 options，这让窄门的保证成为结构性的：唯一调用者是
 * {@link Agent.assembleAgentStateBySession}，它递自己的三只，调用方无法够到这个函数去在第二只
 * `SettingManager` 之上装配状态——`adopt` 曾允许而无人检查的失配，在此无处发生。这里只构建、
 * 不注册。注册是同一扇门的事：它调用本函数，把结果按先到先得放进表里，交回表实际持有的那个状态。
 * 不从包导出也是同一个理由：外部装配的状态进不了任何表，公开的装配就是一个没有读者的面。
 *
 * 什么都不记录：打开后从未说话的会话不长 entry，打开在另一行或另一档的会话也不写——落笔发生在
 * 真正做出选择时（`applyModelSelection`）或第一个请求被构建时（`recordSelection`）。
 */
export async function assembleSession(sessionManager: SessionManager, settings: SettingManager, tools: ToolManager, options: AssembleAgentStateOptions): Promise<AgentState> {
	const { workDirAbsPath } = await assemble(sessionManager, settings, tools, options);
	const session = options.session;
	// 首次触碰创建状态：live 半是空的——它的队列模式是设置此刻的答案，经 manager 实时读取；之后的
	// config 补丁原地挪动队列上的模式——会话记录 *不是*它的一部分（ADR-0013）。
	const global = settings.getSettings();
	const live = createLive(global.steeringMode, global.followUpMode);
	return createAgentState(session.sessionId, live);
}
