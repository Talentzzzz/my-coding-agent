import type { Message } from "./llm/index.ts";
import type { Usage } from "./llm/index.ts";
import type { ModelConfig } from "./llm/index.ts";
import type { AgentSessionEvent } from "./agent.ts";
import type { AppearanceSettings, BashSettings, ModeSettings } from "./config.ts";
import type { BranchPoint } from "./session/session-manager.ts";
import type { QueueMode } from "./types.ts";

export type { Message } from "./llm/index.ts";
export type { AgentSessionEvent } from "./agent.ts";
export type { MessageDelta } from "./agent.ts";
export type { BranchOption, BranchPoint } from "./session/session-manager.ts";
export type { BashSettings, DirectoryPaging, ModeSettings } from "./config.ts";
// 压缩检查点作为包在这些标签里的 user 消息穿过快照 `messages` 走上 wire，所以标签是 wire 事实：
// 客户端靠它们认出摘要。
export {
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	compactionSummaryOf,
} from "./session/messages.ts";

export interface SessionRef {
	id: string;
	/** 本会话工作的目录，绝对路径：头部记录的是解析后的路径。 */
	workDirAbsPath: string;
	createdAt: number;
	title: string;
	/**
	 * 本会话从哪个会话 fork 而来，前提是那个会话就存在旁边。
	 *
	 * 根会话缺失，父会话不在同一份列表里的 fork 也缺失——另一个目录的存储，或被手工挪走的文件。
	 * 客户端把缺失的父画成根，而不是替它编造一个位置。
	 */
	parentId?: string;
}

/**
 * 侧边栏的一行：存储的身份，加上列表化时补充的活动事实。
 *
 * 最后三个字段是它与 {@link SessionRef} 的分界。`modified` 本就由存储为排序算好，只是从不发送。
 * `running` 完全没有存储形态——它是*本*进程循环的事实，从来不是会话记录的。`pending` 是带存储
 * 缓存的账本事实：快照的 `suspended` 标记把冷行点亮成 1（计数不存储），开着该会话的进程用从账本
 * 派生的精确计数覆盖它。
 *
 * 一个字段能在这里占位，仅当没有任何东西订阅内容时它仍然为真：一旦无人注视就冻结的行，正是这个
 * 类型要防的失败。token 计数有意不够格——它们属于会话自己的流，抬到这里就是给每个窗格发一整列
 * 数字。
 */
export interface SessionRow extends SessionRef {
	/** 最近活动：最新的带时间戳 user 或 assistant 消息，没有则是 `createdAt`。 */
	modified: number;
	/** 本进程此刻正在运行它。 */
	running: boolean;
	/** 正在等答案的审批数。 */
	pending: number;
}

/**
 * 一个目录的已存会话，用于侧边栏的分组。
 *
 * 分组来自存储而不是服务器自己的根：一个进程在一个目录里启动，但这台机器跑过的每个目录的会话都
 * 在磁盘上各自待着。
 */
export interface DirectoryGroup {
	workDirAbsPath: string;
	sessions: SessionRow[];
}

/**
 * 用户输入的一个模型，以客户端看到的样子。
 *
 * API 密钥有意缺席——客户端可以添加或替换一把，但永远不会被回发一把，所以密钥无法经由仅仅渲染
 * 列表的页面泄露。表单显示的是 `hasApiKey`，让「存了密钥」与「这一行没有密钥」保持可区分。
 *
 * `name` 是行的身份，所以既是面板显示的，也是客户端指名这一行时回发的。`api` 是为会话记录而
 * 报告的，且永远是同一个值：本应用只说一种传输层，所以它是关于构建的事实，不是表单编辑的字段。
 */
export interface ModelOption {
	/** wire id，也是提交 config 时指名该模型所用的字段。 */
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	contextWindow: number;
	maxTokens: number;
	/**
	 * 该行上的会话可能处于的每个档位，从低到高。
	 *
	 * 每行都是同样四个——effort 是 wire 携带的唯一强度——但报告出来而不是假定出来，这样无论行是
	 * 存储的、本地种下的还是会话快照描述的，输入框读的都是同一个形状。
	 */
	thinkingLevels: string[];
	hasApiKey: boolean;
}

/**
 * 一行被客户端提交时的样子。
 *
 * 每个字段都可选，这正是它与 {@link ModelConfig} 的全部差别：省略的字段让已存的值原地不动，这才让
 * 「补丁」（这一行的密钥是新的）成为可表达的东西——整份 config 得把行里已有的每条事实重述一遍。
 * 形状是派生的而不是重述的，所以加进 config 的字段客户端就能发，不在这份列表里的（`api`、`input`、
 * `cost`）就不能。
 */
export type ModelInput = Partial<
	Pick<ModelConfig, "id" | "name" | "baseUrl" | "apiKey" | "contextWindow" | "maxTokens">
>;

/**
 * 哪个模型回答一条消息，以及被要求多用力地思考。
 *
 * 它随消息一起走，而不是作为会话自己的命令，因为两半在被请求真正使用之前都不为真：从未被用过的
 * 选择不是发生过的事，所以它不是会话记录的条目，也不是配置变更。缺失的字段让那一半保持会话
 * 已有的样子。
 */
export interface ModelSelection {
	/** 行的名字——设置面板显示、会话记录记录的身份。 */
	model?: string;
	thinkingLevel?: string;
}

/** 设置面板读与写的东西。 */
export interface GlobalSettingsSnapshot {
	appearance: AppearanceSettings;
	/** 全局默认活跃工具集；缺失表示本构建认识的所有工具。 */
	tools?: string[];
	/**
	 * 用户的模式，整体存放，按选择器列出的顺序；缺失表示没有定义过。
	 *
	 * 内置默认模式有意不在其中：它是实时读取的全局默认（ADR-0004），客户端用 `tools` 与 `approval`
	 * 拼出它，而不是期望有一行。
	 */
	modes?: ModeSettings[];
	/**
	 * 侧边栏不列出的目录，按绝对路径；缺失表示没有搁置过任何目录。
	 *
	 * 带在这里而不是只留在服务器，因为这是窗口画它收到的列表必须知道的事：一个目录因谁也看不见的
	 * 原因从 `GET /api/directories` 里消失，就是一个没有任何解释的凭空消失的分组。
	 */
	hiddenDirectories?: string[];
	/**
	 * 侧边栏为目录显示的名字，按绝对路径；缺失表示每个分组都用文件夹自己的名字。
	 *
	 * 与 `hiddenDirectories` 并排携带、且出于同样的理由：窗口画的是分组的标题，而它画的名字无法从
	 * 快照持有的其他任何东西推导出来——它是用户敲下的视图，不是目录的属性。
	 */
	directoryNames?: Record<string, string>;
	approval: Record<string, boolean>;
	/** `bash` 工具允许一条命令运行多久。 */
	bash: BashSettings;
	model?: string;
	/** 窗口是否已种下内置默认行；见 `Settings.defaultModelSeeded`。 */
	defaultModelSeeded?: boolean;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** 最近一次请求的 prompt 的 token 数，供上下文表使用。 */
	contextTokens: number;
	contextWindow: number;
}

export interface PendingApproval {
	toolCallId: string;
	toolName: string;
	args: unknown;
	summary: string;
}

/**
 * 工具改动的文件中的一行。
 *
 * 行号是文件自己的：1 起算，旧文件与新文件各有一套，所以窗口不用回读任何东西就能显示改动落在哪里。
 * 只有旧文件有的行不带新行号，反之亦然；`skip` 行代表报告省略的未改动行。
 */
export interface DiffLine {
	kind: "add" | "remove" | "context" | "skip";
	oldLine: number | null;
	newLine: number | null;
	text: string;
	/**
	 * `text` 中发生变化的那段半开区间，用于「一行删除加紧随其后的新增」其实是同一行被重写的情形。
	 * 整行变更时缺失，那种情况下行本身的颜色已把标记想说的话说完了。
	 */
	changed?: [number, number];
	/** 这条 `skip` 行所代表的未改动行数。 */
	skipped?: number;
}

/**
 * 一次工具调用对一个文件做了什么。
 *
 * 改动文件的工具在 `ToolResult.details` 里以此作答，与模型读的文本并列：文本写给模型，这份写给
 * 窗口。两者是同一处改动，所以视图永远不必解析文本——工具的文本也得以保持简短，对整个文件的
 * `write` 而言，这就是「点一下文件名」与「把内容再付一遍钱」的差别。
 *
 * 它搭引擎自己的 `tool_execution_end` 事件走，wire 无需为它加成员，而引擎记录的是整个结果
 * ——会话记录便把这份报告存在工具文本旁边。任何供应商都看不到它：请求携带工具结果时只携带
 * content。
 */
export interface FileDiff {
	/** 文件按工作目录的显示方式——目录内相对，之外绝对。 */
	relPath: string;
	lines: DiffLine[];
	added: number;
	removed: number;
	/** 文件此前不存在时为 true，每一行都是新增。 */
	created: boolean;
	/** 因改动超出报告上限而未进 `lines` 的行数。 */
	omitted: number;
}

/**
 * 一条已被接受但尚未取走的用户消息，以 wire 携带的样子。
 *
 * 队列只活在运行会话的进程里，没有任何持久形态，所以这个轻量视图——按发送原样的文本，和它领到的
 * 时间戳——就是窗口能被告知的全部。它搭快照、`status` 帧与 `queue_update` 事件走，那是队列变更
 * 抵达客户端的三条路。
 */
export interface QueuedPrompt {
	/** 消息文本，按发送者写下的原样。 */
	text: string;
	/** 消息打戳的时间，epoch 毫秒。 */
	timestamp: number;
}

export interface SessionSnapshot {
	id: string;
	workDirAbsPath: string;
	createdAt: number;
	title: string;
	/** 会话所在行的名字。 */
	model: string;
	thinkingLevel: string;
	/** 会话所在的模式名，窗口直接显示的座位；undefined 即内置「默认」（跟随全局默认，或指针悬空）。 */
	mode?: string;
	messages: Message[];
	/**
	 * `messages` 里每条消息背后的 entry id，顺序一致。
	 *
	 * 没有亲眼看着消息写下的会话记录仍需要指名 fork 从哪条 entry 开始，所以会话从自己的 session
	 * manager 填这一栏。压缩摘要没有属于自己的消息条目。
	 */
	messageEntryIds: (string | null)[];
	/**
	 * 本会话日志里每一个曾以不止一条路走下去的地方。
	 *
	 * entry 从来就是一棵树，链只是穿过它的其中一条路；这是窗口画出树的其余部分并在其中移动所需的
	 * 全部信息。是整棵树，不只是链上的——挪动 leaf 不得改变窗口所画树的形状——`options[].active`
	 * 是回答「这些里哪个是我所在的链」的唯一字段。走的只有各备选的 entry id，不是它们通向哪里：
	 * 那些 id 只写一次，而分支在自己的尖端生长，记住一个尖端就是记住一个对话早已离开的地方。
	 */
	branchPoints: BranchPoint[];
	/** 若是 fork：从哪个会话派生而来；根会话缺失。 */
	parentSession?: string;
	/** 会话所在的 entry：链的尖端，第一条 entry 之前为 null。 */
	leafId: string | null;
	/**
	 * 此刻正在写下的 assistant 消息，当本进程正在运行时。
	 *
	 * 只有活跃会话能回答它——存储在消息结束时才得到它——它的存在是为了让运行中途挂上来的窗口不
	 * 必等一句自己从未见过开头的句子：baseline 画这些字符，随后的 delta 接着追加。已落定的
	 * 会话记录与一切冷读都缺失。
	 */
	partial?: Message;
	/** 有在飞的运行——loop 正在跑；活半作答，冷读恒 false（文件只记录已完成的事）。 */
	running: boolean;
	/** 运行中途被接受、尚未被取走的用户消息，按窗口绘制它们的样子。 */
	queued: QueuedPrompt[];
	/** 瞬时供应商失败正在等退避走完时为 true。 */
	isRetrying: boolean;
	/** 在飞的重试是第几次（1 起算），没有待处理的重试时为 0。 */
	retryAttempt: number;
	usage: UsageTotals;
	pendingApprovals: PendingApproval[];
}

/**
 * 不带消息地对会话所持之物做的变更：模式指针、会话的审批增量与两个队列模式。
 *
 * 模型与思考档位有意缺席。两者都在输入框里选择、都随属于它们的消息抵达（{@link ModelSelection}），
 * 因为记录一个没有请求真正用过它的选择，等于在会话记录里放一条从未生效的决定。
 */
export type ConfigPatch = {
	/**
	 * 会话要指向的模式：settings `modes` 表里的一个名字；`null` 即指回内置「默认」（指针缺席）。
	 * 省略的键保持现行值。指向不存在的预设会被拒绝——说出来，而不是按默认悄悄跑。
	 */
	mode?: string | null;
	/**
	 * 会话自己的审批增量，按工具名为键：会话在个别工具上的明确决定（grant 的「不再问」、补丁写下
	 * 的键），叠在模式解析出的审批基线之上；省略的键保持现行值。
	 */
	approval?: Record<string, boolean>;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
};

/**
 * 窗口设置提供审批开关的工具，按提供的顺序。
 *
 * 审批映射本身以工具名为键，不绑定这份列表：设置文件或会话快照可以点名任何工具，报告哪些工具被
 * 闸的读取者遍历的是映射而不是它。这份列表只是窗口的默认 offerings——本构建出厂的配置，不是
 * 映射能装什么的限制。
 */
export const APPROVAL_TOOLS: readonly string[] = ["read", "write", "edit", "glob", "grep", "bash"];

/**
 * 一个取走点注入多少条排队消息。
 *
 * 引擎自己的类型，转发而不是重述：wire 与队列回答的是同一个问题，第二份声明就是第二件要跟着第一
 * 份保持同步的东西。
 */
export type { QueueMode } from "./types.ts";

/** agent 流式期间发送的消息对运行做什么。 */
export type PromptBehavior = "steer" | "followUp";

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
	| { type: "approval_settled"; toolCallId: string; approved: boolean }
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
	/** 给人读的——如今是 `announce(sessionId, message)` 携带的唯一一个字符串。 */
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
	/** 一行变了。发整行，行很小，幂等胜过 diff。 */
	| { type: "session_row"; session: SessionRow }
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

export const EMPTY_USAGE: UsageTotals = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	contextWindow: 0,
};

/** 把一条 assistant 消息的 usage 并进会话总计。 */
export function addUsage(totals: UsageTotals, usage: Usage, contextWindow: number): UsageTotals {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return {
		input: totals.input + usage.input,
		output: totals.output + usage.output,
		cacheRead: totals.cacheRead + usage.cacheRead,
		cacheWrite: totals.cacheWrite + usage.cacheWrite,
		cost: totals.cost + usage.cost.total,
		contextTokens: promptTokens + usage.output,
		contextWindow,
	};
}
