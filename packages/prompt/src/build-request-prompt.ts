// 一次组合出请求的 system prompt（自 domain 的 context/manager.ts 迁入——ContextManager 类解散，
// 这个组合点成了新包的公开门面）。
//
// 项目指示在这里、按请求读取，而不是从状态上取：磁盘文件的一次编辑应当抵达下一个请求。审批工具的
// 映射（`approvalToolsOf`）由 Agent 在调用前做——settings 知识归 agent 根；工具集同样由调用方递进
// 来，一条被捕获的 prompt 不会向模型许诺会话已不再拥有的工具或审批。
import type { AgentsMdRepository } from "./agents-md-repository.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

export async function buildRequestPrompt(
	instructions: AgentsMdRepository,
	workDirAbsPath: string,
	toolNames: readonly string[],
	approvalTools: readonly string[],
): Promise<string> {
	const agentsMd = await instructions.collect(workDirAbsPath);
	return buildSystemPrompt({ workDirAbsPath, toolNames, approvalTools, agentsMd });
}
