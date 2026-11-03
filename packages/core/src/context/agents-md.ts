import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface AgentsMdFile {
	/** Where the file was found, absolute. */
	absPath: string;
	content: string;
}

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_CHARS = 32_000;

/**
 * Collect the `AGENTS.md` files that apply to a working directory.
 *
 * The walk climbs from `workDirAbsPath` to the file-system root, so a repo inside a monorepo inherits the outer
 * conventions, and reads the nearest file last: later entries override earlier ones in the assembled
 * prompt.
 */
export async function loadAgentsMd(workDirAbsPath: string): Promise<AgentsMdFile[]> {
	const files: AgentsMdFile[] = [];
	for (const absDirectory of ancestors(workDirAbsPath)) {
		for (const name of ["AGENTS.md", "CLAUDE.md"]) {
			const absPath = join(absDirectory, name);
			const info = await stat(absPath).catch(() => undefined);
			if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
			const content = await readFile(absPath, "utf8").catch(() => undefined);
			if (content === undefined || content.trim().length === 0) continue;
			files.push({ absPath, content: content.trim() });
		}
	}
	return files;
}

/** Fold the collected files into one prompt section, nearest file last. */
export function formatAgentsMd(files: readonly AgentsMdFile[], workDirAbsPath: string): string | undefined {
	if (files.length === 0) return undefined;
	let budget = MAX_TOTAL_CHARS;
	const sections: string[] = [];
	for (const file of files.toReversed()) {
		const label = file.absPath === join(workDirAbsPath, "AGENTS.md") ? "AGENTS.md" : file.absPath;
		const content = file.content.length > budget ? `${file.content.slice(0, budget)}\n[... truncated ...]` : file.content;
		budget -= content.length;
		sections.push(`### ${label}\n${content}`);
		if (budget <= 0) break;
	}
	return sections.reverse().join("\n\n");
}

/** Directories from the file-system root down to `start`, inclusive. */
function ancestors(startInput: string): string[] {
	const directories: string[] = [];
	let absCurrent = resolve(startInput);
	for (;;) {
		directories.push(absCurrent);
		const absParent = dirname(absCurrent);
		if (absParent === absCurrent) break;
		absCurrent = absParent;
	}
	return directories.reverse();
}
