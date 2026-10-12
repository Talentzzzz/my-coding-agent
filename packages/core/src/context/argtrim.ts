import type { SessionEntry } from "../session/session-manager.ts";

/**
 * The tools whose recorded arguments are bulky and read by nobody afterwards.
 *
 * `write` and `edit` carry the full body of what changed — a whole file in `content`, a whole region
 * in `old_string` / `new_string`. Once the call has run, that body is stored twice over: once in the
 * arguments and once in the file on disk. The arguments are what the model is sent every request, and
 * what it could want back from them — the path, the shape of the change — survives a shortening;
 * the body itself is the file's to keep. A tool has to be named here, like in `pruning.ts`: nothing
 * is trimmable by default.
 */
export const ARG_TRIM_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

/** A string argument longer than this is a body rather than a reference, and is a trim candidate. */
export const ARG_TRIM_THRESHOLD_CHARS = 2_000;

/** How much of a trimmed argument survives at the front: enough to say what was written where. */
export const ARG_KEEP_CHARS = 200;

/** What a trimmed argument ends with, so the cut is visible rather than silent. */
export const ARG_TRIM_MARKER = "... [truncated] ...";

/**
 * The entries whose recorded tool-call arguments a trim would shorten.
 *
 * A call only qualifies once its result is on the branch: arguments of a call still awaiting its
 * result belong to the turn in flight, and shortening them mid-turn would show the model a call it
 * does not remember making. A result already recorded means the turn is over and the arguments are
 * nobody's working set any more.
 *
 * The answer is entry ids rather than rewritten entries because a trim is recorded, not applied here:
 * the caller writes the record and `buildContextEntries` shortens what it names, the same way a prune
 * does. Entries an earlier record named come back from the view already short, so they are not
 * candidates again and a second pass has nothing to do.
 */
export function trimmableToolArgEntryIds(entries: readonly SessionEntry[]): string[] {
	const answered = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult") {
			answered.add(entry.message.toolCallId);
		}
	}

	const candidates: string[] = [];
	for (const entry of entries) {
		if (hasTrimmableArgs(entry, answered)) candidates.push(entry.id);
	}
	return candidates;
}

/** The same entry with its recorded tool-call arguments shortened, or the entry unchanged. */
export function trimToolCallArgs(entry: SessionEntry): SessionEntry {
	if (entry.type !== "message" || entry.message.role !== "assistant") return entry;

	let changed = false;
	const content = entry.message.content.map((block) => {
		if (block.type !== "toolCall" || !ARG_TRIM_TOOLS.has(block.name)) return block;
		const args = block.arguments;
		if (typeof args !== "object" || args === null || Array.isArray(args)) return block;

		let argsChanged = false;
		const trimmed: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(args)) {
			if (typeof value === "string" && value.length > ARG_TRIM_THRESHOLD_CHARS) {
				trimmed[key] = `${value.slice(0, ARG_KEEP_CHARS)}${ARG_TRIM_MARKER}`;
				argsChanged = true;
			} else {
				trimmed[key] = value;
			}
		}
		if (!argsChanged) return block;
		changed = true;
		// The values kept are the JsonObject the call already had and the one replaced is a string, so
		// the record is still JSON through and through; the annotation only re-states the block's shape.
		return { ...block, arguments: trimmed as typeof block.arguments };
	});

	return changed ? { ...entry, message: { ...entry.message, content } } : entry;
}

/** Whether one entry holds a trimmable call that has already been answered. */
function hasTrimmableArgs(entry: SessionEntry, answered: ReadonlySet<string>): boolean {
	if (entry.type !== "message" || entry.message.role !== "assistant") return false;
	return entry.message.content.some((block) => {
		if (block.type !== "toolCall" || !ARG_TRIM_TOOLS.has(block.name)) return false;
		if (!answered.has(block.id)) return false;
		const args = block.arguments;
		if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
		return Object.values(args).some((value) => typeof value === "string" && value.length > ARG_TRIM_THRESHOLD_CHARS);
	});
}
