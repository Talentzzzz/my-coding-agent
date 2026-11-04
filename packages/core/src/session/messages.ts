import type { Message } from "../llm/index.ts";

/**
 * One compaction checkpoint, as the transcript carries it.
 *
 * A compaction is a top-level session entry rather than a message entry, because that is what makes
 * it findable: `buildContextEntries` looks for the newest one on the branch and starts the retained
 * tail at the entry it names. `sessionEntryToContextMessages` projects that entry as the user turn
 * below — the summary wrapped in tags that mark it as a summary rather than something the user said —
 * so a resumed session, a live one, and the provider all see the same transcript.
 */
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

/**
 * The summary a user message stands for, or undefined when it is an ordinary one.
 *
 * A compaction checkpoint is a user message in the transcript, so callers that must treat it
 * differently from something the user said — title derivation, branch previews, the window's
 * notice rendering — recognize it by its tags rather than by a role of its own.
 */
export function compactionSummaryOf(
	message: Message,
): string | undefined {
	if (message.role !== "user") return undefined;
	const first = Array.isArray(message.content) ? message.content[0] : undefined;
	if (first?.type !== "text") return undefined;
	const text = first.text;
	if (!text.startsWith(COMPACTION_SUMMARY_PREFIX) || !text.endsWith(COMPACTION_SUMMARY_SUFFIX)) return undefined;
	return text.slice(COMPACTION_SUMMARY_PREFIX.length, text.length - COMPACTION_SUMMARY_SUFFIX.length);
}
