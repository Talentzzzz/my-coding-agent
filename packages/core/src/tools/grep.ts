import { glob, readFile, stat } from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "@my-agent/agent";
import { resolve } from "node:path";
import { Type, type Static } from "typebox";
import type { Workspace } from "../workspace.ts";
import { DEFAULT_EXCLUDES } from "./glob.ts";
import { truncate, truncateList } from "./truncate.ts";
import { textResult, throwIfAborted } from "./types.ts";

const MAX_MATCHES = 200;
const MAX_FILES_SCANNED = 5_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_LENGTH = 400;

const parameters = Type.Object({
	pattern: Type.String({ description: "Regular expression (JavaScript syntax) to search for" }),
	path: Type.Optional(Type.String({ description: "Directory to search. Defaults to the workspace root." })),
	include: Type.Optional(Type.String({ description: 'Glob for files to search, for example "**/*.ts"' })),
	fixed: Type.Optional(Type.Boolean({ description: "Treat pattern as literal text instead of a regex" })),
});

export type GrepParams = Static<typeof parameters>;

export function createGrepTool(workspace: Workspace): AgentTool<typeof parameters> {
	return {
		name: "grep",
		label: "Grep",
		description:
			"Search file contents with a regular expression. Returns file, line number, and matching lines. Narrow with include or a starting path.",
		parameters,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, onUpdate) {
			return runGrep(workspace, params, { signal, onUpdate });
		},
	};
}

export async function runGrep(
	workspace: Workspace,
	params: GrepParams,
	hooks: { signal?: AbortSignal; onUpdate?: (partial: AgentToolResult<unknown>) => void } = {},
): Promise<AgentToolResult<unknown>> {
	throwIfAborted(hooks.signal);
	const root = params.path === undefined ? workspace.root : workspace.resolve(params.path);
	const info = await stat(root).catch(() => undefined);
	if (!info?.isDirectory()) throw new Error(`Not a directory: ${workspace.display(root)}`);

	let expression: RegExp;
	try {
		expression = new RegExp(params.fixed === true ? escapeRegExp(params.pattern) : params.pattern, "u");
	} catch (error) {
		throw new Error(`Invalid pattern: ${(error as Error).message}`);
	}

	const include = params.include ?? "**/*";
	const files: string[] = [];
	for await (const entry of glob(include, { cwd: root, exclude: DEFAULT_EXCLUDES })) {
		throwIfAborted(hooks.signal);
		if (typeof entry === "string") files.push(entry);
		if (files.length >= MAX_FILES_SCANNED) break;
	}

	const hits: string[] = [];
	let matchCount = 0;
	let scanned = 0;
	for (const relative of files) {
		throwIfAborted(hooks.signal);
		const absolute = resolve(root, relative);
		const fileInfo = await stat(absolute).catch(() => undefined);
		if (!fileInfo?.isFile() || fileInfo.size > MAX_FILE_BYTES) continue;
		scanned += 1;

		const text = await readFile(absolute, "utf8").catch(() => undefined);
		if (text === undefined || text.includes("\u0000")) continue;

		const lines = text.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = (lines[index] ?? "").replace(/\r$/, "");
			if (line.length > MAX_LINE_LENGTH) continue;
			expression.lastIndex = 0;
			if (!expression.test(line)) continue;
			matchCount += 1;
			if (hits.length < MAX_MATCHES) {
				hits.push(`${workspace.display(absolute)}:${index + 1}: ${line.trim().slice(0, MAX_LINE_LENGTH)}`);
			}
			hooks.onUpdate?.(textResult(`${matchCount} matches`));
		}
	}

	const header = `${matchCount} match${matchCount === 1 ? "" : "es"} for ${params.pattern} in ${scanned} files`;
	if (hits.length === 0) return textResult(`${header}: none`, { matches: 0 });

	const { items, dropped } = truncateList(hits, MAX_MATCHES);
	const body = truncate(items.join("\n")).text;
	const suffix = dropped > 0 ? `\n[... ${dropped} more matches not shown; narrow the search ...]` : "";
	return textResult(`${header}\n${body}${suffix}`, { matches: matchCount });
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
