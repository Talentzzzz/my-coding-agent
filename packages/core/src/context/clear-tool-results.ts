import type { ToolResultMessage } from "../llm/index.ts";
import type { SessionEntry } from "../session/session-manager.ts";

/**
 * The tools whose output running them again would produce.
 *
 * A result from one of these is a copy of something that outlives the conversation: the file is still
 * on disk to read, the command is still there to run. Dropping it costs a re-run and nothing else.
 *
 * Everything else is kept whatever its age, and that is the point of listing these rather than the
 * ones to protect: a report, a task's state, or any other answer the conversation itself produced
 * cannot be recovered by asking again, so losing it would lose work instead of tokens.
 * A tool that can be re-run has to be named here; nothing is prunable by default.
 */
export const REFETCHABLE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob", "bash", "edit", "write"]);

/**
 * How long the transcript can sit untouched before the provider's cache is assumed to be gone.
 *
 * A cached prompt is one the provider re-reads none of. Once that is gone, every result nobody has
 * looked at since is paid for in full to occupy the window, which is what makes dropping them the
 * cheapest thing compaction can do — it costs no request at all.
 */
const CACHE_EXPIRY_MS = 60 * 60 * 1000;

/** How many of the newest re-fetchable results survive a clear, however old they are. */
const KEPT_TOOL_RESULTS = 5;

/**
 * What a cleared result says instead of what the tool printed.
 *
 * Short on purpose: a clear empties results in bulk, so a notice that explains itself at length would
 * spend a real share of what it just freed. It still has to say *why* the text is gone, because a
 * model that reads an unexplained empty result re-runs the tool to find out what happened.
 */
export function clearedToolResultText(toolName: string): string {
	return `[cleared after an hour idle — run ${toolName} again if you need this]`;
}

/**
 * Whether the provider has probably dropped the cache for this transcript.
 *
 * The clock is the newest assistant message — the last provider call — and not the newest entry: the
 * message a user just typed is seconds old and says nothing about whether the prompt before it is
 * still cached, so counting from that would mean this never fires.
 */
export function isCacheProbablyExpired(entries: readonly SessionEntry[], now: number): boolean {
	let lastCall: number | undefined;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const at = Date.parse(entry.timestamp);
		if (Number.isFinite(at)) lastCall = at;
	}
	return lastCall !== undefined && now - lastCall >= CACHE_EXPIRY_MS;
}

/**
 * Which results a clear would empty: every re-fetchable one except the newest {@link KEPT_TOOL_RESULTS}.
 *
 * A result that already carries the notice is not a candidate again, which is what makes a second
 * clear a no-op rather than another record naming the same entries.
 *
 * The answer is entry ids rather than a rewritten transcript because a clear is recorded, not applied
 * here: the caller writes the record and `buildContextEntries` clears what it names, so a resumed
 * process reads the same view without re-deciding anything.
 */
export function clearableToolResultIds(entries: readonly SessionEntry[]): string[] {
	const candidates: string[] = [];
	for (const entry of entries) {
		if (refetchableToolName(entry) === undefined) continue;
		if (isCleared(entry)) continue;
		candidates.push(entry.id);
	}
	return candidates.slice(0, Math.max(0, candidates.length - KEPT_TOOL_RESULTS));
}

/** The tool a result answers, when that tool is one a run can reproduce the output of. */
function refetchableToolName(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return undefined;
	// The name travels on the result itself, so a result whose call has already been compacted away is
	// still prunable; a file that lost the field simply reads as "not a tool we know", which keeps it.
	const name: unknown = entry.message.toolName;
	return typeof name === "string" && REFETCHABLE_TOOLS.has(name) ? name : undefined;
}

/**
 * Whether one tool result already reads as cleared, so a clear has nothing left to do to it.
 *
 * The check reads the content rather than any record of the clear, because the question is asked of
 * entries the view has already applied the clear to — and of a view that carries no clear record at
 * all. Whatever emptied the result, the notice is what the model would read, and one notice is
 * indistinguishable from another by design.
 */
export function isClearedToolResult(message: ToolResultMessage): boolean {
	const content = message.content;
	return (
		content.length === 1 &&
		content[0]?.type === "text" &&
		content[0].text === clearedToolResultText(message.toolName)
	);
}

/** Whether an entry already reads as cleared, so a clear has nothing left to do to it. */
function isCleared(entry: SessionEntry): boolean {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return false;
	return isClearedToolResult(entry.message);
}

/** The same entry with its result text replaced. Images and other blocks go with it: they were fetchable too. */
export function clearToolResult(entry: SessionEntry): SessionEntry {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return entry;
	return {
		...entry,
		message: { ...entry.message, content: [{ type: "text", text: clearedToolResultText(entry.message.toolName) }] },
	};
}
