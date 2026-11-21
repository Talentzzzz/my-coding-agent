import type { Api, Message, Model, Usage } from "./types.ts";
import type { BranchPoint, SessionEntry, SessionManager, Session } from "./session/session-manager.ts";
import type { QueuedPrompt } from "./queues.ts";

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

/**
 * 一个快照的全部构建材料，已由调用方解析完毕。
 *
 * 每个字段都是定值而不是待查项：模型已经过 `createModel` 或 `placeholderModel`，审批表已经合并过
 * 记录值，工具列表已是注册表的。正是这样，活 session 和冷读者才能用同样的部件构建同一个对象，而不
 * 必有谁替对方干活。
 */
export interface SnapshotInput {
	/**
	 * 会话记录自身读取所经的服务——只有袋级的，所以快照仍然不读文件、不写任何东西。
	 */
	sessionManager: SessionManager;
	/** 会话记录自己的状态：下面每次读取的来源袋。 */
	session: Session;
	/** session 运行所在的工作目录，绝对路径。 */
	workDirAbsPath: string;
	/** 已解析：`createModel(row, level)` 或 `placeholderModel()`。 */
	model: Model<Api>;
	/** 会话所在的模式座位；undefined 即内置「默认」。 */
	mode?: string;
	/** 已由调用方按其持有的设置判断过；见 `SessionSnapshot`。 */
	running: boolean;
	queued: QueuedPrompt[];
	isRetrying: boolean;
	retryAttempt: number;
	pendingApprovals: PendingApproval[];
	/**
	 * 活 run 此刻正在写的 assistant 消息。
	 *
	 * 冷读者永远没有这个：store 在消息结束时才收到它。这个不对称正是该字段的意义——run 中途接上
	 * 的窗口需要已发送的字符，而只有执行这条 run 的进程才拥有它们。
	 */
	partial?: Message;
}

/**
 * 一个 session 的状态，从它的会话记录和递进来的值读出。
 *
 * 纯函数，这正是意义所在：它不构建 `Agent`、不读文件系统、不触碰任何循环。活的 session 从自己循环
 * 正在做的事回答，而本进程*没有*在跑的 session 仅凭 session 文件回答——读一份会话记录不像跑
 * 一份那么贵，而且读取不会在 hub 里留下痕迹。
 *
 * 冷读者无法知道的五个字段——`running`、`queued`、`isRetrying`、`retryAttempt`、
 * `pendingApprovals`——是输入而不是发现，这正是两种回答可比的原因：它们恰好只在这五处不同。
 */
export function sessionSnapshot(snapshotInput: SnapshotInput): SessionSnapshot {
	const sessionManager = snapshotInput.sessionManager;
	const session = snapshotInput.session;
	// `.json` 快照：身份和当前选择，已在袋里。
	const meta = sessionManager.getMeta(session);
	const messages = sessionManager.buildSessionContext(session).messages;
	return {
		id: session.sessionId,
		workDirAbsPath: snapshotInput.workDirAbsPath,
		createdAt: new Date(meta.timestamp).getTime(),
		title: sessionManager.getTitle(session),
		model: snapshotInput.model.name,
		thinkingLevel: snapshotInput.model.thinkingLevel ?? "off",
		...(snapshotInput.mode === undefined ? {} : { mode: snapshotInput.mode }),
		messages,
		messageEntryIds: sessionManager.getContextMessageEntryIds(session),
		branchPoints: sessionManager.getBranchPoints(session),
		leafId: session.leafId,
		...(snapshotInput.partial === undefined ? {} : { partial: snapshotInput.partial }),
		...(meta.parentSession === undefined ? {} : { parentSession: meta.parentSession }),
		running: snapshotInput.running,
		queued: snapshotInput.queued,
		isRetrying: snapshotInput.isRetrying,
		retryAttempt: snapshotInput.retryAttempt,
		usage: sessionUsage(sessionManager, session, snapshotInput.model.contextWindow),
		pendingApprovals: snapshotInput.pendingApprovals,
	};
}

/** 一条条目携带的 usage，无论由哪种条目持有。 */
export function entryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role !== "assistant") return undefined;
		return (message as { usage?: Usage }).usage;
	}
	if (entry.type === "compaction" || entry.type === "usage") return entry.usage;
	return undefined;
}

/**
 * 整个会话记录的 usage 合计，按文件顺序。
 *
 * 求和遍历文件里的每一条条目，而不是活跃分支的消息，这是对「总数意味着什么」的决定：在叶子早已离开
 * 的那趟树上烧掉的 token 同样是花掉的，压缩的摘要调用的 token 也是——记在它的条目上，但没有 assistant
 * 消息携带它。唯一保持分支相对的字段是 `contextTokens`，因为它根本不是求和：它是窗口此刻多满，这是
 * 叶子所在分支的属性，与别的无关。
 */
export function sessionUsage(sessionManager: SessionManager, session: Session, contextWindow: number): UsageTotals {
	let totals: UsageTotals = { ...EMPTY_USAGE, contextWindow };
	for (const entry of sessionManager.getEntries(session)) {
		const usage = entryUsage(entry);
		if (usage) totals = addUsage(totals, usage, contextWindow);
	}
	return { ...totals, contextTokens: branchContextTokens(sessionManager.buildSessionContext(session).messages) };
}

/** 分支最后一条携带 usage 的 assistant 消息报告的 context 占用。 */
function branchContextTokens(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "assistant") continue;
		const usage = (message as { usage?: Usage }).usage;
		if (usage === undefined) continue;
		return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
	}
	return 0;
}
