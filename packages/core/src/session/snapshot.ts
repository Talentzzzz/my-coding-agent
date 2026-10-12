import type { AgentMessage } from "@my-agent/agent";
import type { Api, Model, Usage } from "@my-agent/ai";
import {
	addUsage,
	EMPTY_USAGE,
	type PendingApproval,
	type SessionSnapshot,
	type ToolApprovalKey,
	type UsageTotals,
} from "../protocol.ts";
import { thinkingLevelsFor } from "../models.ts";
import type { SessionManager } from "./session-manager.ts";

/**
 * Everything one snapshot is built from, already resolved by the caller.
 *
 * Every field is a settled value rather than something to look up: the model has already been through
 * `modelFor` or `placeholderModel`, the approval map is already merged over the recorded one, and the
 * tool lists are already the registry's. That is what lets a live session and a cold reader build the
 * same object from the same parts without either one owning the other's job.
 */
export interface SnapshotInput {
	sessionManager: SessionManager;
	workspaceRoot: string;
	/** Already settled: `modelFor(row, level)` or `placeholderModel()`. */
	model: Model<Api>;
	approvals: Record<ToolApprovalKey, boolean>;
	allTools: string[];
	activeTools: string[];
	submitting: boolean;
	queued: number;
	isRetrying: boolean;
	retryAttempt: number;
	pendingApprovals: PendingApproval[];
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
	const header = input.sessionManager.getHeader();
	const messages = input.sessionManager.buildSessionContext().messages;
	return {
		id: input.sessionManager.getSessionId(),
		cwd: input.workspaceRoot,
		createdAt: header ? new Date(header.timestamp).getTime() : Date.now(),
		title: input.sessionManager.getTitle(),
		model: `${input.model.name}/${input.model.id}`,
		thinkingLevel: input.model.thinkingLevel ?? "off",
		thinkingLevels: thinkingLevelsFor(input.model),
		approvals: input.approvals,
		allTools: input.allTools,
		activeTools: input.activeTools,
		messages,
		messageEntryIds: input.sessionManager.getContextMessageEntryIds(),
		branchPoints: input.sessionManager.getBranchPoints(),
		leafId: input.sessionManager.getLeafId(),
		...(header?.parentSession === undefined ? {} : { parentSession: header.parentSession }),
		submitting: input.submitting,
		queued: input.queued,
		isRetrying: input.isRetrying,
		retryAttempt: input.retryAttempt,
		usage: foldUsage(messages, input.model.contextWindow),
		pendingApprovals: input.pendingApprovals,
	};
}

/** Usage summed over the transcript. */
export function foldUsage(messages: readonly AgentMessage[], contextWindow: number): UsageTotals {
	let totals: UsageTotals = { ...EMPTY_USAGE, contextWindow };
	for (const message of messages) {
		const usage = assistantUsage(message);
		if (usage) totals = addUsage(totals, usage, contextWindow);
	}
	return totals;
}

function assistantUsage(message: AgentMessage): Usage | undefined {
	if (message.role !== "assistant") return undefined;
	return (message as { usage?: Usage }).usage;
}
