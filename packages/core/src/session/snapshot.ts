import type { Message } from "@my-agent/llm";
import type { Api, Model, Usage } from "@my-agent/llm";
import {
	addUsage,
	EMPTY_USAGE,
	type PendingApproval,
	type SessionSnapshot,
	type ToolApprovalKey,
	type UsageTotals,
} from "../protocol.ts";
import { thinkingLevelsFor } from "../models.ts";
import {
	buildSessionContext,
	type SessionEntry,
	type SessionState,
	getContextMessageEntryIds,
	getEntries,
	getBranchPoints,
	getHeader,
	getLeafId,
	getTitle,
} from "./session-manager.ts";

/**
 * Everything one snapshot is built from, already resolved by the caller.
 *
 * Every field is a settled value rather than something to look up: the model has already been through
 * `createModel` or `placeholderModel`, the approval map is already merged over the recorded one, and the
 * tool lists are already the registry's. That is what lets a live session and a cold reader build the
 * same object from the same parts without either one owning the other's job.
 */
export interface SnapshotInput {
	/** The transcript's own state: the bag every read below is taken from. */
	sessionState: SessionState;
	/** The workspace the session runs in, absolute. */
	absWorkspaceRoot: string;
	/** Already settled: `createModel(row, level)` or `placeholderModel()`. */
	model: Model<Api>;
	approvals: Record<ToolApprovalKey, boolean>;
	allTools: string[];
	activeTools: string[];
	/** Already judged by the caller against the settings it holds; see `SessionSnapshot`. */
	toolsFollowGlobal: boolean;
	approvalsFollowGlobal: boolean;
	submitting: boolean;
	queued: number;
	isRetrying: boolean;
	retryAttempt: number;
	pendingApprovals: PendingApproval[];
	/**
	 * The assistant message a live loop is writing right now.
	 *
	 * A cold reader never has one: the store gains a message when it ends. That asymmetry is the
	 * point of the field — a window attaching mid-run needs the characters already sent, and only the
	 * process running the loop has them.
	 */
	partial?: Message;
}

/**
 * The state of one session, read out of its transcript and the values it was handed.
 *
 * Pure, and that is the point: it never constructs an `Agent`, reads the filesystem, or touches a
 * loop. A live session answers with it from what its own loop is doing, and a session this process is
 * *not* running answers with it from the JSONL file alone — so reading a transcript is not as
 * expensive as running one, and a read leaves no trace in the hub.
 *
 * The five fields a cold reader cannot know — `submitting`, `queued`, `isRetrying`, `retryAttempt`,
 * `pendingApprovals` — are inputs rather than discoveries, which is what makes the two answers
 * comparable: they differ in exactly those five and in nothing else.
 */
export function sessionSnapshot(input: SnapshotInput): SessionSnapshot {
	const header = getHeader(input.sessionState);
	const messages = buildSessionContext(input.sessionState).messages;
	return {
		id: input.sessionState.sessionId,
		absCwd: input.absWorkspaceRoot,
		createdAt: header ? new Date(header.timestamp).getTime() : Date.now(),
		title: getTitle(input.sessionState),
		model: input.model.name,
		thinkingLevel: input.model.thinkingLevel ?? "off",
		thinkingLevels: thinkingLevelsFor(),
		approvals: input.approvals,
		allTools: input.allTools,
		activeTools: input.activeTools,
		toolsFollowGlobal: input.toolsFollowGlobal,
		approvalsFollowGlobal: input.approvalsFollowGlobal,
		messages,
		messageEntryIds: getContextMessageEntryIds(input.sessionState),
		branchPoints: getBranchPoints(input.sessionState),
		leafId: getLeafId(input.sessionState),
		...(input.partial === undefined ? {} : { partial: input.partial }),
		...(header?.parentSession === undefined ? {} : { parentSession: header.parentSession }),
		submitting: input.submitting,
		queued: input.queued,
		isRetrying: input.isRetrying,
		retryAttempt: input.retryAttempt,
		usage: sessionUsage(input.sessionState, input.model.contextWindow),
		pendingApprovals: input.pendingApprovals,
	};
}

/** The usage one entry carries, whichever kind holds it. */
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
 * Usage summed over the whole transcript, in file order.
 *
 * The sum walks every entry the file holds rather than the active branch's messages, and that is a
 * decision about what the total means: tokens burned on a way through the tree the leaf has since
 * left were spent all the same, and so were the tokens of a compaction's summary call — recorded on
 * its entry, but no assistant message carries it. The one field that stays branch-relative is
 * `contextTokens`, because it is not a sum at all: it is how full the window is right now, which is
 * a property of the branch the leaf is on and of nothing else.
 */
export function sessionUsage(sessionState: SessionState, contextWindow: number): UsageTotals {
	let totals: UsageTotals = { ...EMPTY_USAGE, contextWindow };
	for (const entry of getEntries(sessionState)) {
		const usage = entryUsage(entry);
		if (usage) totals = addUsage(totals, usage, contextWindow);
	}
	return { ...totals, contextTokens: branchContextTokens(buildSessionContext(sessionState).messages) };
}

/** The context footprint the branch's last usage-carrying assistant message reported. */
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
