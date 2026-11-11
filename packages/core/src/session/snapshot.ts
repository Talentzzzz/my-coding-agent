import type { Message } from "../llm/index.ts";
import type { Api, Model, Usage } from "../llm/index.ts";
import {
	addUsage,
	EMPTY_USAGE,
	type PendingApproval,
	type QueuedPrompt,
	type SessionSnapshot,
	type UsageTotals,
} from "../protocol.ts";
import { thinkingLevelsFor } from "../models.ts";
import type { SessionEntry, SessionManager, Session } from "./session-manager.ts";

/**
 * 一个快照的全部构建材料，已由调用方解析完毕。
 *
 * 每个字段都是定值而不是待查项：模型已经过 `createModel` 或 `placeholderModel`，审批表已经合并过
 * 记录值，工具列表已是注册表的。正是这样，活 session 和冷读者才能用同样的部件构建同一个对象，而不
 * 必有谁替对方干活。
 */
export interface SnapshotInput {
	/**
	 * transcript 自身读取所经的服务——只有袋级的，所以快照仍然不读文件、不写任何东西。
	 */
	sessions: SessionManager;
	/** transcript 自己的状态：下面每次读取的来源袋。 */
	session: Session;
	/** session 运行所在的工作目录，绝对路径。 */
	workDirAbsPath: string;
	/** 已解析：`createModel(row, level)` 或 `placeholderModel()`。 */
	model: Model<Api>;
	approvals: Record<string, boolean>;
	allTools: string[];
	activeTools: string[];
	/** 已由调用方按其持有的设置判断过；见 `SessionSnapshot`。 */
	toolsFollowGlobal: boolean;
	approvalsFollowGlobal: boolean;
	submitting: boolean;
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
 * 一个 session 的状态，从它的 transcript 和递进来的值读出。
 *
 * 纯函数，这正是意义所在：它不构建 `Agent`、不读文件系统、不触碰任何循环。活的 session 从自己循环
 * 正在做的事回答，而本进程*没有*在跑的 session 仅凭 session 文件回答——读一份 transcript 不像跑
 * 一份那么贵，而且读取不会在 hub 里留下痕迹。
 *
 * 冷读者无法知道的五个字段——`submitting`、`queued`、`isRetrying`、`retryAttempt`、
 * `pendingApprovals`——是输入而不是发现，这正是两种回答可比的原因：它们恰好只在这五处不同。
 */
export function sessionSnapshot(input: SnapshotInput): SessionSnapshot {
	const sessions = input.sessions;
	const state = input.session;
	// `.json` 快照：身份和当前选择，已在袋里。
	const meta = sessions.getMeta(state);
	const messages = sessions.buildSessionContext(state).messages;
	return {
		id: state.sessionId,
		workDirAbsPath: input.workDirAbsPath,
		createdAt: new Date(meta.timestamp).getTime(),
		title: sessions.getTitle(state),
		model: input.model.name,
		thinkingLevel: input.model.thinkingLevel ?? "off",
		thinkingLevels: thinkingLevelsFor(),
		approvals: input.approvals,
		allTools: input.allTools,
		activeTools: input.activeTools,
		toolsFollowGlobal: input.toolsFollowGlobal,
		approvalsFollowGlobal: input.approvalsFollowGlobal,
		messages,
		messageEntryIds: sessions.getContextMessageEntryIds(state),
		branchPoints: sessions.getBranchPoints(state),
		leafId: state.leafId,
		...(input.partial === undefined ? {} : { partial: input.partial }),
		...(meta.parentSession === undefined ? {} : { parentSession: meta.parentSession }),
		submitting: input.submitting,
		queued: input.queued,
		isRetrying: input.isRetrying,
		retryAttempt: input.retryAttempt,
		usage: sessionUsage(sessions, state, input.model.contextWindow),
		pendingApprovals: input.pendingApprovals,
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
 * 整个 transcript 的 usage 合计，按文件顺序。
 *
 * 求和遍历文件里的每一条条目，而不是活跃分支的消息，这是对「总数意味着什么」的决定：在叶子早已离开
 * 的那趟树上烧掉的 token 同样是花掉的，压缩的摘要调用的 token 也是——记在它的条目上，但没有 assistant
 * 消息携带它。唯一保持分支相对的字段是 `contextTokens`，因为它根本不是求和：它是窗口此刻多满，这是
 * 叶子所在分支的属性，与别的无关。
 */
export function sessionUsage(sessions: SessionManager, session: Session, contextWindow: number): UsageTotals {
	let totals: UsageTotals = { ...EMPTY_USAGE, contextWindow };
	for (const entry of sessions.getEntries(session)) {
		const usage = entryUsage(entry);
		if (usage) totals = addUsage(totals, usage, contextWindow);
	}
	return { ...totals, contextTokens: branchContextTokens(sessions.buildSessionContext(session).messages) };
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
