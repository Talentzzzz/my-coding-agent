// 项目指示收集的端口（@my-agent/prompt 自带，session-repository.ts 的同形先例）：prompt 包对磁盘
// 只认自己声明的接口——收集 AGENTS.md / CLAUDE.md 是触盘动词，infra 实现、组合根注入，本包造不出
// infra，端口全必填。
import type { AgentsMdFile } from "./agents-md.ts";

export interface AgentsMdRepository {
	/**
	 * 收集作用于一个工作目录的项目指示文件。
	 *
	 * 遍历从 `workDirAbsPath` 向上爬到文件系统根，返回顺序为根先、最近的后——拼装 prompt 时
	 * 后到的条目盖过先前的。单个文件过大或读不出来时静默跳过；内容已 trim，空文件不进结果。
	 */
	collect(workDirAbsPath: string): Promise<AgentsMdFile[]>;
}
