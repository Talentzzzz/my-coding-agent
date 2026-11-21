import type {
	AgentSessionEvent,
	ClientFrame,
	PendingApproval,
	ServerFrame,
	SessionRow,
	SessionRowPatch,
	SessionSnapshot,
} from "@my-agent/case/protocol";
import { UnknownSessionError } from "@my-agent/domain";

/**
 * 会话语义 → 帧：**只有函数**，没有类型、没有状态、没有生命周期。
 *
 * 这一层回答的是"同一件事在线上长什么样"——两个方向都是：下行的会话语义怎么翻译成帧，上行的
 * 文本怎么读回一个 `ClientFrame`。它的全部输出都能由输入算出来：一条快照换成一份 baseline、
 * 一次变更换成一份 status、一份待审批集合与上一条比出差量。状态属于持有一条连接的那个对象
 * （`mux.ts` 的 `MuxConnection`），因为它全是*连接 × 会话*的事实——谁在看、看到哪儿、还欠哪
 * 一份 baseline。
 *
 * 拆出去的理由与"为什么不删掉"是同一个：帧的形状是协议事实，改它要看的是 `core/protocol`；
 * 观看的生命周期是连接事实，改它要看的是 `mux.ts`。两者住在一个文件里时，读任何一个都得同时
 * 理解另一个（ADR-0025）。
 */

/**
 * 读一个上行 frame，不是 frame 的东西一律返回 `undefined`。
 *
 * 这是服务器唯一的信任边界：它之上的一切都在 `ClientFrame` 值上工作并信任它们，所以形状在这里
 * 确立、且仅在这里。它刻意*不是*一个校验框架——两个动作没法被滥用成别的什么，为此引入一个
 * schema 库的代价比它要保护的东西还高。
 *
 * 两个拒绝背后都有明确的策略。不是 JSON 的、或不属于两个已知动作的 frame，由调用者丢弃并记日志，
 * 而不是断开连接：否则手写 smoke 脚本里的一个小错就会让窗口再也打不开，而"刷新一下就好"值得
 * 一行日志。
 *
 * 对不存在的会话发 `open`、或对已订阅的会话发 `open`，*不*在这里丢弃——那些是要应答的，连接层
 * 才是持有状态、能够应答的一方。
 */
export function parseClientFrame(text: string): ClientFrame | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

	const record = value as Record<string, unknown>;
	// 服务器不认识的字段被忽略而不是拒绝：`window` 在协议里有定义但暂无意义（没有任何东西产生它），发送它的客户端不该因此受罚。
	if (record.type === "open") {
		if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return undefined;
		return {
			type: "open",
			sessionId: record.sessionId,
			...(record.window === undefined ? {} : { window: record.window }),
		};
	}
	if (record.type === "cancel") {
		if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return undefined;
		return { type: record.type, sessionId: record.sessionId };
	}
	return undefined;
}

/** 一次快照的待审批集合，按 `toolCallId`——"一个 id 在一个会话内唯一"由 provider 的 `tool_use` 语义背书。 */
export function pendingOf(snapshot: SessionSnapshot): Map<string, PendingApproval> {
	return new Map(snapshot.pendingApprovals.map((approval) => [approval.toolCallId, approval]));
}

/** 两个待审批集合之间，对一个观看而言真正动了的那些。 */
export interface ApprovalDiff {
	/** 新出现的：要上报为 `approval_request`。 */
	appearing: PendingApproval[];
	/** 消失的：要上报为 `approval_settled`。 */
	disappearing: string[];
}

/**
 * 差量。
 *
 * 按集合而不是按帧：一个窗口只该知道"从我上次看到的样子到现在动了什么"，而它的"上次"就是它自己
 * 手里那份表。同一份差量服务两个调用点——baseline 替换时只换表、状态变更时连帧一起发。
 */
export function approvalDiff(
	previous: ReadonlyMap<string, PendingApproval>,
	current: ReadonlyMap<string, PendingApproval>,
): ApprovalDiff {
	const appearing: PendingApproval[] = [];
	for (const [toolCallId, approval] of current) {
		if (!previous.has(toolCallId)) appearing.push(approval);
	}
	const disappearing: string[] = [];
	for (const toolCallId of previous.keys()) {
		if (!current.has(toolCallId)) disappearing.push(toolCallId);
	}
	return { appearing, disappearing };
}

/** 连接自己的一帧：不属于任何会话的载荷。 */
export function sessions(rows: readonly SessionRow[]): ServerFrame {
	return { streamId: null, item: { type: "sessions", sessions: [...rows] } };
}

/** 一行变了。通常是增量（缺席字段读作"没动"），完整行出现在出生与存储型改名上；两种都幂等。 */
export function row(session: SessionRowPatch): ServerFrame {
	return { streamId: null, item: { type: "session_row", session } };
}

/** 一行消失了。id 就是全部 payload：丢弃它是客户端唯一能做的事。 */
export function gone(sessionId: string): ServerFrame {
	return { streamId: null, item: { type: "session_gone", sessionId } };
}

/** 一条逻辑流的起点，也是它重发时的全部内容。 */
export function baseline(streamId: string, session: SessionSnapshot): ServerFrame {
	return { streamId, item: { type: "baseline", session } };
}

/** 运行中的一次变更，原样转交。 */
export function event(streamId: string, change: AgentSessionEvent): ServerFrame {
	return { streamId, item: { type: "event", event: change } };
}

/**
 * `entry_appended` 所指的 entry，附上会话记录用于排序的时间戳。
 *
 * 时间戳随事件而来而不是回读：这里对每条追加的消息只跑一次，而回读会话记录要解析整份日志只为
 * 一个数字（ADR-0013）。
 */
export function entry(streamId: string, entryId: string, at: number | undefined): ServerFrame {
	return {
		streamId,
		item: { type: "entry", entryId, ...(typeof at === "number" ? { messageTimestamp: at } : {}) },
	};
}

/** 一行状态：这次快照里窗口要跟着动的那几个数。 */
export function status(streamId: string, snapshot: SessionSnapshot): ServerFrame {
	return {
		streamId,
		item: {
			type: "status",
			usage: snapshot.usage,
			running: snapshot.running,
			queued: snapshot.queued,
			isRetrying: snapshot.isRetrying,
			retryAttempt: snapshot.retryAttempt,
		},
	};
}

/** 一个刚出现的待审批：窗口据此画横幅。 */
export function approvalRequest(streamId: string, request: PendingApproval): ServerFrame {
	return { streamId, item: { type: "approval_request", request } };
}

/**
 * 一个消失了的待审批：它不再等答案了。
 *
 * 这帧只说"定案了"，不说"定成了什么"——结果的措辞由那次关闭的执行事件自己说（grant 是恢复运行
 * 重发调用的执行，deny 是合成结果的结束事件）。settled 帧的职责只是让不再有答案可等的等待收场。
 */
export function approvalSettled(streamId: string, toolCallId: string): ServerFrame {
	return { streamId, item: { type: "approval_settled", toolCallId } };
}

/**
 * 一次运行在任何请求够不到的地方说的那句失败。
 *
 * 与 {@link refusal} 是两种形状：这一条是流的内容（`item.type === "error"`），流继续活着；
 * 那一条是流的失败（外层 `error`），由发起 `open` 的那次尝试读。
 */
export function failure(streamId: string, text: string): ServerFrame {
	return { streamId, item: { type: "error", message: text } };
}

/** 一次尝试的失败：带归因的 error 帧。 */
export function refusal(streamId: string, text: string): ServerFrame {
	return { streamId, error: { message: text } };
}

/** 这条流再无话可说。 */
export function end(streamId: string): ServerFrame {
	return { streamId, end: true };
}

/**
 * 一份 baseline 读不出来时对用户说的话。
 *
 * 归因住在帧层而不是 hub：hub 交的是原始 error 对象，它不知道帧上的话怎么说。这里最常见的情形是
 * id 什么都不指，它自己那句话比一个读取失败更清楚。
 */
export function baselineFailureText(sessionId: string, error: unknown): string {
	return error instanceof UnknownSessionError
		? `未知的会话：${sessionId}`
		: `读不出这个会话的记录：${describe(error)}`;
}

/**
 * 出了什么问题，用客户端能展示的话说。
 *
 * 只有 `Error` 一种情况值得关心：读取失败带着它自己的消息，那本来就是一句能对客户端说出口的话。
 * 其余都是 bug，按 bug 命名而不是插值——帧不是把堆栈递给浏览器的地方。
 */
function describe(error: unknown): string {
	return error instanceof Error ? error.message : "未知的错误";
}
