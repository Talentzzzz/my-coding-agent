import { resolve as resolvePath } from "node:path";
import type { ChatTransport } from "./llm/index.ts";
import { type ModelChoice, type ModelConfig, modelFor } from "./models.ts";
import type { SessionSnapshot } from "./protocol.ts";
import { createAgentState, type AgentState, createLive } from "./session/agent-state.ts";
import { danglingApprovalsOf } from "./session/dangling.ts";
import { modelChoiceOf } from "./session/model-choice.ts";
import { type Session, SessionManager } from "./session/session-manager.ts";
import { sessionSnapshot } from "./session/snapshot.ts";
import { followsGlobalOf, toolStateOf } from "./session/tool-config.ts";
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
	/** 用一行的名字覆盖存储的默认。 */
	model?: string;
	thinkingLevel?: string;
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
}

/**
 * {@link Agent.assembleAgentStateBySession} 需要什么：会话记录，以及——走测试那条组合之路时
 * ——该打开在哪一行。
 *
 * 有意比 {@link OpenAgentOptions} 窄。差别是权威性：这扇门属于编排层，所以服务是*它自己的*
 * ——调用方无法递给它第二只 `SettingManager` 或自己的工具表，这正是 `adopt` 曾允许而无人检查的
 * 失配。留在这里的是编排层无法知道的那部分：**哪个** 会话记录（宿主的决定，session manager 的
 * 重放）——会话记录 在 `sessionSetting.workDirAbsPath` 上自带工作目录。
 *
 * 模型字段不是宿主控制默认值的把手。面向宿主的动词（`create`、`hold`、`snapshotOf`）都不收它：
 * 会话的模型是一个设置事实，下面的装配在每次打开时从磁盘现读。只有 `openAgent`——smoke 驱动的
 * 单 会话记录 组合——会传一个，让脚本化的运行可以在不写设置文件的情况下打开在自己的一行上。
 */
export interface AssembleAgentStateOptions {
	/** 要装配并放进表里的 会话记录；它自带工作目录。 */
	session: Session;
	/** 仅测试的覆盖：本次组合打开所在的那一行，取代设置的默认。 */
	model?: string;
	thinkingLevel?: string;
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
	/** 会话的模型选择：行的名字与档位，不含行自身拥有的任何事实。 */
	modelChoice: ModelChoice;
	/** 本次装配读到的各行，让按选择构建模型的调用方不必重读。 */
	rows: readonly ModelConfig[];
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
	const workDirAbsPath = resolvePath(options.session.sessionSetting.workDirAbsPath);
	// 项目设置文件住在工作目录之下，所以从同一路径找到：`<workDirAbsPath>/.my-agent/settings.json`，
	// 叠在 agent home 自己的文件之上。什么都不缓存：每次读取都是对调用方递入的那只 manager 背后
	// 文件的一次新读。
	const rows = settings.modelCatalog();
	// 选择是客户端自己的：行的名字与档位，不含行拥有的任何事实。其背后的事实——端点、密钥、窗口、
	// compat——在构造模型的时刻从这份目录现读，本次装配如此，之后的每个请求也如此，所以对行的
	// 编辑抵达下一条消息时，这里没有任何东西需要刷新。
	//
	// 它是派生的而不是在这里计算的（ADR-0013），因为会话之后每次读取都得从刚重放的那只袋回答同一个
	// 问题：`modelChoiceOf` 就是那个答案，本次调用是它加上调用方的覆盖。没有行的会话照样打开，
	// `Agent` 用一句「该加什么」替它作答：`modelFor` 在完全无名的状态下构建占位模型的事实，拒绝
	// 发送的是传输层。
	const modelChoice: ModelChoice = modelChoiceOf(sessionManager, options.session, settings, {
		...(options.model === undefined ? {} : { name: options.model }),
		...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
	});
	// 表的内容是行为而不是目录，所以一张表服务所有会话。这里同样不做任何选择：活跃集与审批在每次
	// 读取时从账本派生，以全局默认的实时视图作底。
	return { workDirAbsPath, settings, modelChoice, rows, tools, sessionManager };
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
	const { workDirAbsPath, modelChoice, rows } = await assemble(sessionManager, settings, tools, options);
	// 与活跃会话运行的是同一套派生——账本叠在全局默认的实时视图上——所以冷读回答的是活跃会话打开
	// 时所在的选择，而不把它重放进任何东西。
	const toolState = toolStateOf(sessionManager, options.session, settings, tools.names());
	return sessionSnapshot({
		sessionManager,
		session: options.session,
		workDirAbsPath,
		// 快照只从模型上读名字、档位与窗口；请求对象在这里与在一次请求里一样是即抛的。用本次装配已经
		// 读过的行构建，所以一次冷读只花文件一次。
		model: modelFor(modelChoice, rows),
		// 与 `Agent.getApprovals` 执行的是同一个合并：目录的默认，叠上会话自己记录的选择。两半都不可
		// 省，否则头部的开关会显示一个活跃会话并没有的闸门。
		approvals: { ...settings.getApprovals(workDirAbsPath), ...toolState.approvalOverride },
		// 用派生的选择从表上读取，让开关与活跃会话的完全一致。
		allTools: tools.names(),
		activeTools: toolState.activeToolNames,
		// 对着这个目录自己的设置判断，与活跃会话的 getter 同法：冷读与活跃快照在这里必须一致，否则
		// 会话一从打开变成仅读取，面板的「沿用全局」标签就会翻面。
		...followsGlobalOf(sessionManager, options.session, settings, tools.names()),
		submitting: false,
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
 * 产出的是**live 半**——两条队列、它们的模式，以及唯一一份重放造不出来的 会话记录（ADR-0013）。
 * 递进来的 会话记录 是*入参*，不是成员：出生的袋在这里被丢掉，因为 `bag(id)` 会按需再重放一次；
 * 未出生的袋留在 `live.unwrittenSession` 上，因为在第一条消息造出文件之前，没有别的什么能回答它。
 * 工作目录留在那只袋上（之后每次调用都重放它），设置从来不是任何状态的一部分——它们经编排层持有
 * 的 {@link SettingManager} 实时读取。
 *
 * 模型选择既不保留也不播种：每次读取都派生它（`session/model-choice.ts`），这是袋被丢掉之后唯一
 * 能幸存的形状。派生无法重现的选择只剩一件——*调用方*点名的那一行——所以只有它落在
 * `live.openedOn` 上。
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
	// config 补丁原地挪动队列上的模式——会话记录 *不是*它的一部分（ADR-0013）。唯一的例外是文件
	// 还不存在的袋：重放造不出它，所以它是 live 半自己的字段，直到第一次写入把它落盘。
	const live = createLive(settings.getSteeringMode(workDirAbsPath), settings.getFollowUpMode(workDirAbsPath));
	if (!session.fileCreated) live.unwrittenSession = session;
	// 装配解析出的选择由之后每次读取*派生*（`modelChoiceOf`），不播种到袋上：播种的袋是一份副本，
	// 而副本正是重放要丢掉的东西。派生无法重现的只有调用方点名的覆盖——没有任何东西把它写进
	// 会话记录——所以保住的只有它，放在它所属的 live 半上。
	if (options.model !== undefined || options.thinkingLevel !== undefined) {
		live.openedOn = {
			...(options.model === undefined ? {} : { name: options.model }),
			...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
		};
	}
	return createAgentState(session.sessionId, live);
}
