import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { AgentTool } from "@my-agent/agent";
import { dirname } from "node:path";
import { Type, type Static } from "typebox";
import type { Workspace } from "../workspace.ts";
import { DIFF_MAX_ROWS, fileDiff } from "./diff.ts";
import { textResult, throwIfAborted } from "./types.ts";

const parameters = Type.Object({
	path: Type.String({ description: "File path, relative to the workspace root or absolute inside it" }),
	content: Type.String({ description: "Complete file content. Trailing newline is added when missing." }),
	overwrite: Type.Optional(
		Type.Boolean({ description: "Replace an existing file. Defaults to false; use edit for small changes." }),
	),
});

export type WriteParams = Static<typeof parameters>;

/**
 * `write` creates files, or replaces them when `overwrite` is set.
 *
 * Refusing to clobber by default matters: a model that means "adjust one line" but calls `write`
 * with a reconstructed file silently destroys the parts it did not reproduce.
 */
export function createWriteTool(workspace: Workspace): AgentTool<typeof parameters> {
	return {
		name: "write",
		label: "Write",
		description:
			"Write a complete file. Creates missing directories. Refuses to overwrite an existing file unless overwrite is true; prefer edit for small changes.",
		parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			return runWrite(workspace, params, signal);
		},
	};
}

export async function runWrite(
	workspace: Workspace,
	params: WriteParams,
	signal?: AbortSignal,
): Promise<ReturnType<typeof textResult>> {
	throwIfAborted(signal);
	const absolute = workspace.resolve(params.path);
	const display = workspace.display(absolute);
	const existing = await stat(absolute).catch(() => undefined);
	if (existing?.isDirectory()) throw new Error(`Not a file (it is a directory): ${display}`);

	const content = params.content.endsWith("\n") ? params.content : `${params.content}\n`;

	// The file as it was, or undefined for one that is not there. It is read once for both decisions
	// made here — whether this write changes anything, and what the change is — so the answer the model
	// gets and the diff the window gets are the same comparison.
	let before: string | undefined;
	if (existing) {
		if (params.overwrite !== true) {
			throw new Error(
				`${display} already exists. Use edit for a targeted change, or pass overwrite: true to replace the whole file.`,
			);
		}
		before = await readFile(absolute, "utf8").catch(() => undefined);
		if (before === content) {
			return textResult(`No change: ${display} already has exactly this content.`, { path: display, changed: false });
		}
	}

	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, content, "utf8");
	throwIfAborted(signal);

	const lines = content.split("\n").length - 1;
	const action = existing ? "Replaced" : "Created";
	return textResult(`${action} ${display} (${lines} lines, ${content.length} bytes).`, {
		path: display,
		changed: true,
		lines,
		// A file nothing could read back has no change to report: a diff against content nobody saw
		// would be a guess dressed up as a record, so the card falls back to the tool's own text.
		...(existing && before === undefined
			? {}
			: { diff: fileDiff(display, before ?? "", content, { maxLines: DIFF_MAX_ROWS, created: existing === undefined }) }),
	});
}
