import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { Tool } from "../llm/index.ts";
import { dirname } from "node:path";
import { Type, type Static } from "typebox";
import { displayToolPath, resolveToolPath } from "../workdir.ts";
import { DIFF_MAX_ROWS, fileDiff } from "./diff.ts";
import { textResult, throwIfAborted } from "./types.ts";

const parameters = Type.Object({
	path: Type.String({ description: "File path. Relative paths resolve against the working directory; absolute paths are taken as they are." }),
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
export function createWriteTool(workDirAbsPath: string): Tool<typeof parameters> {
	return {
		name: "write",
		label: "Write",
		description:
			"Write a complete file. Creates missing directories. Refuses to overwrite an existing file unless overwrite is true; prefer edit for small changes.",
		parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			return runWrite(workDirAbsPath, params, signal);
		},
	};
}

export async function runWrite(
	workDirAbsPath: string,
	params: WriteParams,
	signal?: AbortSignal,
): Promise<ReturnType<typeof textResult>> {
	throwIfAborted(signal);
	const absPath = resolveToolPath(workDirAbsPath, params.path);
	const relPath = displayToolPath(workDirAbsPath, absPath);
	const existing = await stat(absPath).catch(() => undefined);
	if (existing?.isDirectory()) throw new Error(`Not a file (it is a directory): ${relPath}`);

	const content = params.content.endsWith("\n") ? params.content : `${params.content}\n`;

	// The file as it was, or undefined for one that is not there. It is read once for both decisions
	// made here — whether this write changes anything, and what the change is — so the answer the model
	// gets and the diff the window gets are the same comparison.
	let before: string | undefined;
	if (existing) {
		if (params.overwrite !== true) {
			throw new Error(
				`${relPath} already exists. Use edit for a targeted change, or pass overwrite: true to replace the whole file.`,
			);
		}
		before = await readFile(absPath, "utf8").catch(() => undefined);
		if (before === content) {
			return textResult(`No change: ${relPath} already has exactly this content.`, { path: relPath, changed: false });
		}
	}

	await mkdir(dirname(absPath), { recursive: true });
	await writeFile(absPath, content, "utf8");
	throwIfAborted(signal);

	const lines = content.split("\n").length - 1;
	const action = existing ? "Replaced" : "Created";
	return textResult(`${action} ${relPath} (${lines} lines, ${content.length} bytes).`, {
		path: relPath,
		changed: true,
		lines,
		// A file nothing could read back has no change to report: a diff against content nobody saw
		// would be a guess dressed up as a record, so the card falls back to the tool's own text.
		...(existing && before === undefined
			? {}
			: { diff: fileDiff(relPath, before ?? "", content, { maxLines: DIFF_MAX_ROWS, created: existing === undefined }) }),
	});
}
