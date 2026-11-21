// 项目指示收集的实现（ADR-0031）：@my-agent/prompt 声明的 AgentsMdRepository 端口的 fs 半——
// 自 domain 的 context 包迁入（原 agents-md.ts 的 loadAgentsMd 触盘半）。向上遍历、读文件、单文件
// 大小上限是存储事实，住 infra；纯格式化与总量预算住 prompt 包。
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AgentsMdFile, AgentsMdRepository } from "@my-agent/prompt";

const MAX_FILE_BYTES = 64 * 1024;

/** 项目指示收集实现：无状态，一个实例服务所有会话。 */
export class AgentsMdStore implements AgentsMdRepository {
	async collect(workDirAbsPath: string): Promise<AgentsMdFile[]> {
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
