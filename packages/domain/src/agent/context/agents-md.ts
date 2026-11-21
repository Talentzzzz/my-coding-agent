import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface AgentsMdFile {
	/** 文件在哪里找到的，绝对路径。 */
	absPath: string;
	content: string;
}

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_CHARS = 32_000;

/**
 * 收集作用于一个工作目录的 `AGENTS.md` 文件。
 *
 * 遍历从 `workDirAbsPath` 向上爬到文件系统根，所以 monorepo 里的仓库会继承外层的约定，并且最后
 * 读取最近的文件：在拼装 prompt 时后到的条目盖过先前的。
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

/** 把收集到的文件折成一个 prompt 段落，最近的文件放在最后。 */
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

/** 从文件系统根到 `start` 的各目录，含两端。 */
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
