// 协议信封 + 客户端/触发面共用的域词汇网关（分层重构步 2 自 `core/src/protocol.ts` 解散而来，
// spec §2.4）。
//
// 信封住 case 而不是 domain 的理由：trigger 对 domain 盲（域词汇一律经 case 到手），而 frames.ts
// 今天就要信封与 `UnknownSessionError`——信封必须住在 trigger 可达的最近一层。case 在此 role 下
// 是 trigger 与 web 共用的类型网关：web 的 import 面保持单一来源（今天 `@my-agent/core/protocol`，
// 新世界 `@my-agent/case/protocol`）。域词汇本体各归属主（session / llm / tool / agent 根），
// 这里只转发。
import type {
	AgentSessionEvent,
	PendingApproval,
	QueuedPrompt,
	SessionRow,
	SessionRowPatch,
	SessionSnapshot,
	UsageTotals,
} from "@my-agent/domain";

// —— 域词汇网关：上表所有客户端与触发面需要的域词汇，各自属主原址转发 ——

export type {
	AgentSessionEvent,
	MessageDelta,
} from "@my-agent/domain";
export type { Message } from "@my-agent/domain";
export type {
	BranchOption,
	BranchPoint,
	DirectoryGroup,
	SessionRef,
	SessionRow,
	SessionRowPatch,
} from "@my-agent/domain";
export type {
	PendingApproval,
	QueuedPrompt,
	PromptBehavior,
	SessionSnapshot,
	UsageTotals,
} from "@my-agent/domain";
export type {
	ModelInput,
	ModelOption,
	ModelSelection,
} from "@my-agent/domain";
export type { DiffLine, FileDiff } from "@my-agent/domain";
export type {
	BashSettings,
	ConfigPatch,
	GlobalSettingsSnapshot,
	ModeSettings,
	QueueMode,
} from "@my-agent/domain";
// 压缩检查点作为包在这些标签里的 user 消息穿过快照 `messages` 走上 wire，所以标签是 wire 事实：
// 客户端靠它们认出摘要。
export {
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	compactionSummaryOf,
} from "@my-agent/domain";
export {
	APPROVAL_TOOLS,
	addUsage,
	EMPTY_USAGE,
} from "@my-agent/domain";
// `http/errors.ts` 的 404 映射要 instanceof，所以 class 也经网关转发。
export { UnknownSessionError } from "@my-agent/domain";

// —— 触发面需要的其余域词汇（步 3 随 controllers 进 trigger 补齐）：R1 禁 trigger→domain，
// 控制器用到的模型行 coerce、设置面与路径词汇同样只能从本网关到手——网关 role 的直接推论，
// 不是新决策。
export {
	coerceModelConfig,
	DEFAULT_MODE_NAME,
	listModelOptions,
	resolvePath,
	shortenTitle,
	toSessionRef,
} from "@my-agent/domain";
export type {
	Agent,
	GlobalSettings,
	ModelConfig,
	SettingsPatch,
} from "@my-agent/domain";

export type ServerMessage =
	/**
	 * 本会话此刻看起来的一切。
	 *
	 * 逻辑流的第一帧，也是唯一一帧这种类型：再次打开的订阅得到新的 baseline 而不是追加，这让恢复
	 * 收敛到「它现在长什么样」，而不是「我错过了什么」。
	 */
	| { type: "baseline"; session: SessionSnapshot }
	| { type: "event"; event: AgentSessionEvent }
	/**
	 * 会话刚写下的一条消息背后的 entry。
	 *
	 * `entry_appended` 只点名 entry，不点名它装的消息，而会话记录需要这对配对，才能在一条从未
	 * 出现在快照里的消息上提供「从这里 fork」。它与事件并排发送、不是取代它，所以忽略这一帧的客户端
	 * 行为与从前完全一样。
	 */
	| { type: "entry"; entryId: string; messageTimestamp?: number }
	| { type: "approval_request"; request: PendingApproval }
	| { type: "approval_settled"; toolCallId: string }
	| { type: "status"; usage: UsageTotals; running: boolean; queued: QueuedPrompt[]; isRetrying: boolean; retryAttempt: number }
	/**
	 * 某件事在任何请求够不到的地方失败了。
	 *
	 * 主要是没能启动的运行：接受其 prompt 的请求早在失败发生之前就被 202 应答过了，所以这条流是
	 * 剩下唯一能说出这件事的地方。
	 */
	| { type: "error"; message: string };

/**
 * 一条逻辑流在一条连接上的身份：会话 id 本身。
 *
 * 一个会话在一条连接上至多一条逻辑流，所以 id 就是全部地址——没有需要与之保持同步的独立订阅
 * 句柄。`null` 是唯一的保留座位，给属于连接而不属于任何流的载荷。
 */
export type StreamId = string;

/**
 * 归到一条逻辑流（或连接本身）名下的失败。
 *
 * 不是终结帧：流保持打开，客户端下一步做什么取决于这条流是否曾携带 baseline，而不是取决于它为何
 * 失败。
 */
export interface StreamFailure {
	/** 给人读的——如今是 `publishFailure(sessionId, message)` 携带的唯一一个字符串。 */
	message: string;
}

/**
 * 乘坐连接级座位（`streamId: null`）的载荷。
 *
 * 它们是单独一个 union 而不是更多 `ServerMessage` 成员，因为每个都不点名会话：心跳关于信道，
 * 一行关于整台机器。客户端先按 `streamId` 路由，所以这里的一切都落在不属于任何栏目的那个存储上。
 */
export type ConnectionItem =
	/** 服务器发出它的频率，客户端据此定自己的读超时。 */
	| { type: "heartbeat"; everyMs: number }
	/** 本进程认识的每一行，每条连接一次。是替换，不是追加。 */
	| { type: "sessions"; sessions: SessionRow[] }
	/**
	 * 一行变了。通常是一份增量——事件自带什么就带什么，客户端逐字段合并；完整行出现在出生、fork
	 * 与存储型改名上，那是服务端唯一读盘的时刻。缺席的字段读作"没动"，所以同一行到达两次或乱序
	 * 到达，得到的都是同一张表——幂等性与整行版本相同，只是字的数量更少。
	 */
	| { type: "session_row"; session: SessionRowPatch }
	/**
	 * 一行消失了：它背后的会话被删除。id 就是全部载荷，因为丢弃是客户端对它唯一能做的事——已经
	 * 没有状态可供描述了。
	 */
	| { type: "session_gone"; sessionId: string };

/**
 * 一条逻辑流的帧：它的内容、它的结束，或归到它名下的失败。
 *
 * 同一层的三种形状，靠字段名区分而不是靠判别字段——`item` 自带 `type`，外层再放一个 `type` 会把
 * 同一件事说两遍，并让「外层与内层不一致」成为可表示的状态。
 *
 * `item` 只装 {@link ServerMessage}：连接级载荷不属于任何会话，让其中之一骑在某栏的 `streamId`
 * 上，会让「这是给哪个会话的」出现两种答案。
 */
export type StreamFrame =
	| { item: ServerMessage }
	| { end: true }
	| { error: StreamFailure };

/**
 * 连接自己的帧：不属于任何会话的载荷，或连接的失败。
 *
 * 与 {@link StreamFrame} 分开成类型，而不是在它上面放宽 `item`，因为两者走在不同的键上、客户端的
 * 路由也不同：一个进栏目，另一个进所有栏目背后的那个存储。
 */
export type ConnectionFrame =
	| { item: ConnectionItem }
	| { error: StreamFailure };

/**
 * 一条 WebSocket 消息：帧外面的一层信封，靠哪个键携带 id 来区分。
 *
 * 帧属于某条逻辑流时 `streamId` 是会话 id，属于连接时是 `null`，这对类型让「连接级载荷出现在会话
 * 的流上」与反过来都不可表示，而不只是不被鼓励。
 *
 * 信封有意留在 {@link ServerMessage} 之外而不是成为其每个成员内部的字段：好几个调用方构造协议
 * 消息时背后根本没有流（一次 REST 读、一次 fork），把 id 内联进去会逼它们凭空编一个。
 */
export type ServerFrame =
	| ({ streamId: StreamId } & StreamFrame)
	| ({ streamId: null } & ConnectionFrame);

/**
 * 客户端可以发送什么。两个动作，没有信封——帧就是协议。
 *
 * 命令留在 REST。`open` / `cancel` 是订阅的两个词，各自回答"这条连接订了什么"与"不再订"——
 * 曾经的 `wait` / `unwait`（send 引用的服务端信号）已由 [ADR-0022](../../../docs/adr/0022-drop-send-reference.md)
 * 撤销：单用户产品里，删除守卫三道（holds / isRunning / hasPendingApprovals）就够，send 引用防的
 * 那个断网窗口本就不受保护。带着未知 `type` 到达的帧被丢弃并记录日志，而不是关掉连接：两个动作
 * 没有一个能被滥用成什么，而把一个走错门的帧变成一页死掉的白屏，代价高于一行日志。
 */
export type ClientFrame =
	| { type: "open"; sessionId: string; window?: unknown }
	| { type: "cancel"; sessionId: string };
