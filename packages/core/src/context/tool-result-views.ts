import type { ToolResultMessage } from "@my-agent/llm";
import type { ToolResultContent } from "../hooks.ts";
import type { SessionEntry } from "../session/session-manager.ts";
import { isClearedToolResult } from "./clear-tool-results.ts";

/**
 * Both halves of a tool result a hook rewrote.
 *
 * The loop stores one message, but two audiences read it: the provider request is served the `shown`
 * half, and the transcript keeps the `stored` half, because bounding what the model sees must not
 * lose what the tool actually produced.
 */
export interface ToolResultView {
	stored: ToolResultContent;
	shown: ToolResultContent;
}

/**
 * The tool-result views one selection of entries carries, keyed by tool call id.
 *
 * A rewrite is recorded as a `tool_result_view` entry written just behind the toolResult message that
 * holds the `stored` half, so replaying pairs each entry back with its message by call id: `shown`
 * from the record, `stored` from the message. This is the query the live session answered from memory
 * before the record existed, rebuilt from the ledger — which is what makes the rewrite survive the
 * process that made it, and what keeps a resumed session serving the model the same bounded result
 * the live one did.
 *
 * Two views do not survive into the answer, both by design:
 *
 * - one whose toolResult message the branch no longer carries (a compaction folded the call away)
 *   has nothing to be shown instead of, and says nothing about any message a request does hold;
 * - one whose result a clear emptied dies with the result: a cleared result exists to tell the model
 *   to re-run the tool, and resurrecting the rewrite through the view would undo the clear.
 *
 * The caller passes the same entries the request is built from, so the answer is already
 * branch-relative: a view recorded on an abandoned way through the tree never reaches it.
 */
export function toolResultViewsOf(entries: readonly SessionEntry[]): Map<string, ToolResultView> {
	const storedOf = new Map<string, ToolResultMessage>();
	const shownOf = new Map<string, ToolResultContent>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult") {
			storedOf.set(entry.message.toolCallId, entry.message);
		} else if (entry.type === "tool_result_view") {
			shownOf.set(entry.toolCallId, entry.shown);
		}
	}

	const views = new Map<string, ToolResultView>();
	for (const [toolCallId, shown] of shownOf) {
		const stored = storedOf.get(toolCallId);
		if (stored === undefined || isClearedToolResult(stored)) continue;
		views.set(toolCallId, { stored: stored.content, shown });
	}
	return views;
}
