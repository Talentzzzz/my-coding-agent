import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolResultContent } from "../hooks.ts";

/**
 * The tool-result size at which the full text leaves the context and moves to a file.
 *
 * Well-behaved tools bound their own output (`tools/truncate.ts`, 60,000 characters) and paginate what
 * they can, so a result over this line is one a tool did not bound. Roughly 20k tokens: one result of
 * this size is a meaningful share of a context window, which is more than any single answer deserves.
 * Deliberately above the per-tool budget, so a result a tool already bounded never touches this.
 */
export const SPILL_RESULT_CHARS = 80_000;

/** How much of a spilled result the model still sees, at each end. */
export const SPILL_KEEP_CHARS = 2_000;

/**
 * Where a spilled result lives, under the working directory: `.my-agent/tool-results/<session id>/`.
 *
 * The directory is the session's own project, so the archive sits beside the files the result is
 * about and a session that walks away from it leaves the archive where a person would look. Nothing
 * about the path is a boundary: a result is archived there because that is the useful place for it.
 */
const SPILL_DIR_PARTS = [".my-agent", "tool-results"] as const;

/** One filename segment a session id, a tool name, or a call id cannot break. */
function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** The file one result's full text belongs in, by session and call, so a view can be rebuilt later. */
export function spillPathFor(
	workDirAbsPath: string,
	sessionId: string,
	toolName: string,
	toolCallId: string,
): { absPath: string; relPath: string } {
	const segments = [...SPILL_DIR_PARTS, safeSegment(sessionId), `${safeSegment(toolCallId)}-${safeSegment(toolName)}.txt`];
	return {
		absPath: join(workDirAbsPath, ...segments),
		relPath: segments.join("/"),
	};
}

/** The text of a result's blocks that are text, joined in order. Images and other blocks are not in it. */
export function spillText(content: ToolResultContent): string {
	return content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** The size at which `spillOversizedToolResult` archives rather than passes a result through. */
function oversizedText(content: ToolResultContent): string | undefined {
	let total = 0;
	for (const block of content) {
		if (block.type !== "text") continue;
		total += block.text.length;
	}
	if (total <= SPILL_RESULT_CHARS) return undefined;
	return spillText(content);
}

/** Write one archive file whole. False when the write failed, so the caller can fall back to the clip. */
export function writeSpillFile(absPath: string, text: string): boolean {
	try {
		if (!existsSync(absPath)) {
			mkdirSync(dirname(absPath), { recursive: true });
			writeFileSync(absPath, text, "utf8");
		}
	} catch {
		return false;
	}
	return true;
}

/**
 * The content a model reads for an archived result: head and tail around a notice naming the file.
 *
 * Anything that is not text — an image block — passes through after the notice. A text short enough
 * that head and tail would overlap is kept whole: the archive already holds it, and a view that
 * duplicated characters to save them would be absurd.
 */
export function spillView(content: ToolResultContent, text: string, relPath: string, keepChars: number): ToolResultContent {
	const notice =
		`\n\n[... the full output was saved to ${relPath}; ` +
		`use the read tool on that file if you need the rest ...]\n\n`;
	if (text.length <= keepChars * 2) {
		return [{ type: "text", text: `${text}${notice}` }, ...content.filter((block) => block.type !== "text")];
	}
	const head = text.slice(0, keepChars);
	const tail = text.slice(text.length - keepChars);
	const omitted = `\n\n[... ${text.length - head.length - tail.length} characters omitted — the full output was saved to ${relPath}; ` +
		`use the read tool on that file if you need the rest ...]\n\n`;
	return [{ type: "text", text: `${head}${omitted}${tail}` }, ...content.filter((block) => block.type !== "text")];
}

/**
 * Archive one oversized result and answer with the view the model should see, or `undefined`.
 *
 * `undefined` means "not oversized", or the file could not be written — the caller falls back to the
 * hard clip in `boundToolContent` rather than showing a notice that names a file that is not there.
 * The path is derived from the session and the call id, which is what makes the archive findable for
 * as long as the working directory exists.
 */
export function spillOversizedToolResult(
	workDirAbsPath: string,
	sessionId: string,
	toolName: string,
	toolCallId: string,
	content: ToolResultContent,
): ToolResultContent | undefined {
	const text = oversizedText(content);
	if (text === undefined) return undefined;

	const { absPath, relPath } = spillPathFor(workDirAbsPath, sessionId, toolName, toolCallId);
	if (!writeSpillFile(absPath, text)) return undefined;
	return spillView(content, text, relPath, SPILL_KEEP_CHARS);
}
