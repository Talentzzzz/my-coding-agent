import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface AgentsMdFile {
	path: string;
	content: string;
}

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_CHARS = 32_000;

/**
 * Collect `AGENTS.md` files that apply to a workspace.
 *
 * The walk climbs from the workspace root to the file-system root, so a repo inside a monorepo
 * inherits the outer conventions, and reads the nearest file last: later entries override earlier
 * ones in the assembled prompt.
 */
export async function loadAgentsMd(workspaceRoot: string): Promise<AgentsMdFile[]> {
	const files: AgentsMdFile[] = [];
	for (const directory of ancestors(workspaceRoot)) {
		for (const name of ["AGENTS.md", "CLAUDE.md"]) {
			const path = join(directory, name);
			const info = await stat(path).catch(() => undefined);
			if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
			const content = await readFile(path, "utf8").catch(() => undefined);
			if (content === undefined || content.trim().length === 0) continue;
			files.push({ path, content: content.trim() });
		}
	}
	return files;
}

/** Fold the collected files into one prompt section, nearest file last. */
export function formatAgentsMd(files: readonly AgentsMdFile[], workspaceRoot: string): string | undefined {
	if (files.length === 0) return undefined;
	let budget = MAX_TOTAL_CHARS;
	const sections: string[] = [];
	for (const file of files.toReversed()) {
		const label = file.path === join(workspaceRoot, "AGENTS.md") ? "AGENTS.md" : file.path;
		const content = file.content.length > budget ? `${file.content.slice(0, budget)}\n[... truncated ...]` : file.content;
		budget -= content.length;
		sections.push(`### ${label}\n${content}`);
		if (budget <= 0) break;
	}
	return sections.reverse().join("\n\n");
}

/** Directories from the file-system root down to `start`, inclusive. */
function ancestors(start: string): string[] {
	const directories: string[] = [];
	let current = resolve(start);
	for (;;) {
		directories.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return directories.reverse();
}
