import type { AgentMessage } from "@my-agent/agent";
import type { Message } from "@my-agent/ai";

/**
 * One compaction checkpoint, as the transcript carries it.
 *
 * A compaction is a top-level session entry rather than a message entry, because that is what makes
 * it findable: `buildContextEntries` looks for the newest one on the branch and starts the retained
 * tail at the entry it names. The message below is what that entry becomes when the model is asked to
 * continue — a user turn holding the summary — so a resumed session and a live one see the same
 * transcript.
 */
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// The agent loop type-checks the transcript it hands back with `AgentMessage`, so the extra role has
// to be declared there or every event carrying one would need a cast.
declare module "@my-agent/agent" {
	interface CustomAgentMessages {
		compactionSummary: CompactionSummaryMessage;
	}
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	when: string,
): CompactionSummaryMessage {
	return { role: "compactionSummary", summary, tokensBefore, timestamp: new Date(when).getTime() };
}

/**
 * The transcript as the provider is sent it.
 *
 * Custom roles cannot reach a provider — `TranscriptContext.messages` is pi-ai's own `Message` union —
 * so a compaction checkpoint becomes the user turn it stands for, wrapped in tags that mark it as a
 * summary rather than something the user said.
 */
export function convertToLlm(messages: readonly AgentMessage[]): Message[] {
	const converted: Message[] = [];
	for (const message of messages) {
		if (message.role === "compactionSummary") {
			converted.push({
				role: "user",
				content: [
					{
						type: "text",
						text: `${COMPACTION_SUMMARY_PREFIX}${message.summary}${COMPACTION_SUMMARY_SUFFIX}`,
					},
				],
				timestamp: message.timestamp,
			});
			continue;
		}
		if (
			message.role === "system" ||
			message.role === "user" ||
			message.role === "assistant" ||
			message.role === "toolResult"
		) {
			converted.push(message);
		}
	}
	return converted;
}
