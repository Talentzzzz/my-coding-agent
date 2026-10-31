import type { PendingApproval } from "../protocol.ts";
import { describeToolCall } from "../tools/index.ts";
import type { SessionEntry } from "./session-manager.ts";

/**
 * The tool calls the transcript is still waiting on, read out of the ledger rather than held in
 * memory (ADR-0006 §5): a call the view's assistant messages carry and no tool result in the same
 * view answers.
 *
 * This is the derived state the approval flow runs on. Under the end-restart semantics an approval
 * that is waiting *is* a dangling call — the run has ended, the tool result has not landed, and the
 * answer arrives over REST to close it — so the banner, the endpoint's 409 check, and the deny
 * sweep all read this one derivation instead of keeping a second, memory-resident list in step
 * with the file. A cleared result is not a dangling call: the clear empties what the model is
 * shown, and the result message itself stays in the view to answer its call.
 *
 * The entries are the branch's context view — the same selection a request is built from — so a
 * call the model would re-send without a result is exactly a call this reports.
 */
export function danglingApprovalsOf(entries: readonly SessionEntry[]): PendingApproval[] {
	const calls: PendingApproval[] = [];
	const answered = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			answered.add(message.toolCallId);
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			calls.push({
				toolCallId: block.id,
				toolName: block.name,
				args: block.arguments,
				summary: describeToolCall(block.name, block.arguments),
			});
		}
	}
	return calls.filter((call) => !answered.has(call.toolCallId));
}
