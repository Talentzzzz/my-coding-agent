import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolResultContent } from "../hooks.ts";
import type { Workspace } from "../workspace.ts";

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

/** Where a spilled result lives, inside the workspace: `.my-agent/tool-results/<session id>/`. */
const SPILL_DIR_PARTS = [".my-agent", "tool-results"] as const;

/** One filename segment a session id, a tool name, or a call id cannot break. */
function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** The file one result's full text belongs in, by session and call, so a view can be rebuilt later. */
export function spillPathFor(
	workspace: Workspace,
	sessionId: string,
	toolName: string,
	toolCallId: string,
): { absolute: string; display: string } {
	const segments = [...SPILL_DIR_PARTS, safeSegment(sessionId), `${safeSegment(toolCallId)}-${safeSegment(toolName)}.txt`];
	return {
		absolute: join(workspace.root, ...segments),
		display: segments.join("/"),
	};
}

/** The text a result carries, with the blocks it is made of joined in order. */
function resultText(content: ToolResultContent): string | undefined {
	let total = 0;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type !== "text") continue;
		total += block.text.length;
		parts.push(block.text);
	}
	if (total <= SPILL_RESULT_CHARS) return undefined;
	return parts.join("\n");
}

/**
 * Archive one oversized result and answer with the view the model should see, or `undefined`.
 *
 * `undefined` means "not oversized", or the file could not be written — the caller falls back to the
 * hard clip in `boundToolContent` rather than showing a notice that names a file that is not there.
 * The path is derived from the session and the call id, which is what lets `forModel` rebuild the same
 * view for a result an earlier process stored, without a record in the transcript.
 */
export function spillOversizedToolResult(
	workspace: Workspace,
	sessionId: string,
	toolName: string,
	toolCallId: string,
	content: ToolResultContent,
): ToolResultContent | undefined {
	const text = resultText(content);
	if (text === undefined) return undefined;

	const { absolute, display } = spillPathFor(workspace, sessionId, toolName, toolCallId);
	try {
		if (!existsSync(absolute)) {
			mkdirSync(dirname(absolute), { recursive: true });
			writeFileSync(absolute, text, "utf8");
		}
	} catch {
		return undefined;
	}

	const head = text.slice(0, SPILL_KEEP_CHARS);
	const tail = text.slice(text.length - SPILL_KEEP_CHARS);
	const notice =
		`\n\n[... ${text.length - head.length - tail.length} characters omitted — the full output was saved to ${display}; ` +
		`use the read tool on that file if you need the rest ...]\n\n`;
	// The text blocks collapse into one: the archive holds them all, and the view is about what the
	// model reads first. Anything that is not text — an image block — passes through after it.
	return [{ type: "text", text: `${head}${notice}${tail}` }, ...content.filter((block) => block.type !== "text")];
}
