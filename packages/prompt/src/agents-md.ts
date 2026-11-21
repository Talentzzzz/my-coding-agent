// 项目指示文件的纯文本半（2026-11-21 自 domain 的 context 包迁入 @my-agent/prompt）：类型与格式化
// 住这里；触盘的收集半（向上遍历、读文件、单文件大小上限）是存储事实，随端口化迁 infra 的
// AgentsMdStore（AgentsMdRepository 的实现）——本包零触盘，与 domain 的 R3 同一口径。
// 收集预算（MAX_TOTAL_CHARS）是 prompt 文本的政策，留在这里。
import { join } from "node:path";

export interface AgentsMdFile {
	/** 文件在哪里找到的，绝对路径。 */
	absPath: string;
	content: string;
}

const MAX_TOTAL_CHARS = 32_000;

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
