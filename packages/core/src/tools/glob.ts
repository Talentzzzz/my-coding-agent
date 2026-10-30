import { glob, stat } from "node:fs/promises";
import type { AgentTool } from "@my-agent/loop";
import { isAbsolute, resolve } from "node:path";
import { Type, type Static } from "typebox";
import type { Workspace } from "../workspace.ts";
import { truncateList } from "./truncate.ts";
import { textResult, throwIfAborted } from "./types.ts";

const MAX_RESULTS = 500;

/** Directories that are never interesting and are expensive to walk. */
export const DEFAULT_EXCLUDES = [
	"**/node_modules/**",
	"**/.git/**",
	"**/dist/**",
	"**/build/**",
	"**/.next/**",
	"**/target/**",
	"**/__pycache__/**",
];

const parameters = Type.Object({
	pattern: Type.String({
		description: 'Glob pattern such as "**/*.ts" or "src/**/test_*.py", matched against paths relative to the search root',
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in. Defaults to the workspace root." })),
});

export type GlobParams = Static<typeof parameters>;

export function createGlobTool(workspace: Workspace): AgentTool<typeof parameters> {
	return {
		name: "glob",
		label: "Glob",
		description:
			"Find files by glob pattern. Returns paths sorted by modification time, newest first. Use it to locate files before reading them.",
		parameters,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, onUpdate) {
			return runGlob(workspace, params, { signal, onUpdate });
		},
	};
}

export async function runGlob(
	workspace: Workspace,
	params: GlobParams,
	hooks: { signal?: AbortSignal; onUpdate?: (partial: ReturnType<typeof textResult>) => void } = {},
): Promise<ReturnType<typeof textResult>> {
	throwIfAborted(hooks.signal);
	const absRoot = params.path === undefined ? workspace.absRoot : workspace.resolve(params.path);
	const info = await stat(absRoot).catch(() => undefined);
	if (!info?.isDirectory()) throw new Error(`Not a directory: ${workspace.display(absRoot)}`);

	const matches: string[] = [];
	for await (const entry of glob(params.pattern, {
		cwd: absRoot,
		exclude: DEFAULT_EXCLUDES,
	})) {
		throwIfAborted(hooks.signal);
		if (typeof entry !== "string") continue;
		matches.push(entry);
	}

	const withStats = await Promise.all(
		matches.map(async (relPath) => {
			const absPath = isAbsolute(relPath) ? relPath : resolve(absRoot, relPath);
			const stats = await stat(absPath).catch(() => undefined);
			return { relPath, mtime: stats?.mtimeMs ?? 0, size: stats?.size ?? 0 };
		}),
	);
	withStats.sort((a, b) => b.mtime - a.mtime);

	const { items, dropped } = truncateList(withStats, MAX_RESULTS);
	const relRoot = workspace.display(absRoot);
	const header = `${withStats.length} file${withStats.length === 1 ? "" : "s"} matching ${params.pattern} in ${relRoot}`;
	const body = items.map((item) => `${item.relPath} (${item.size} B)`).join("\n");
	const suffix = dropped > 0 ? `\n[... ${dropped} more matches not shown; narrow the pattern ...]` : "";
	hooks.onUpdate?.(textResult(`${withStats.length} matches`));
	return textResult(body.length > 0 ? `${header}\n${body}${suffix}` : `${header}: none`, { count: withStats.length });
}
