import { platform } from "node:os";
import type { AgentsMdFile } from "./agents-md.ts";
import { formatAgentsMd } from "./agents-md.ts";

export interface SystemPromptInput {
	/** 相对路径解析的基准目录，命令启动的目录。不是边界。 */
	workDirAbsPath: string;
	toolNames: readonly string[];
	/** 运行前需要用户审批的工具。 */
	approvalTools: readonly string[];
	agentsMd: readonly AgentsMdFile[];
}

const IDENTITY = `You are a coding agent working directly on the user's machine.
You read and change files through tools, run commands, and report what you actually did.

How to work:
- Inspect before you change. Find the relevant files with glob and grep, read them, then edit.
- Relative paths resolve against your working directory; absolute paths are taken as given, and the
  rest of the machine is reachable too. Leave the directory when the task needs it.
- Prefer the smallest change that solves the problem. Keep the existing style of the file.
- Use edit for targeted changes and write only for new files or a deliberate full rewrite.
- Run the project's own checks (tests, type check, lint) when they exist, and report the result.
- If you are unsure, say so and state what you would need to check.

How to answer:
- Lead with the result. Keep prose short and technical.
- Reference files as path:line so the user can jump to them.
- Never claim a command succeeded unless you ran it and saw the output.
- Do not print secrets, tokens, or full environment dumps.`;

/** 由身份、环境、工具和项目说明拼装 system prompt。 */
export function buildSystemPrompt(input: SystemPromptInput): string {
	const sections: string[] = [IDENTITY];

	sections.push(
		[
			"## Environment",
			`- Working directory: ${input.workDirAbsPath}`,
			`- Platform: ${platform()}`,
			`- Today: ${new Date().toISOString().slice(0, 10)}`,
		].join("\n"),
	);

	const approval =
		input.approvalTools.length > 0
			? `\nThese tools ask the user for approval before running: ${input.approvalTools.join(", ")}. A denial comes back as a tool error; do not retry the same call, adjust your approach.`
			: "";
	// session 可以不带任何激活工具打开，那是一段对话，不是一个坏掉的 prompt。
	const available = input.toolNames.length === 0 ? "none" : input.toolNames.join(", ");
	sections.push(`## Tools\nAvailable: ${available}.${approval}`);

	const project = formatAgentsMd(input.agentsMd, input.workDirAbsPath);
	if (project !== undefined) {
		sections.push(`## Project instructions\nThe user's project ships these instructions. Follow them.\n\n${project}`);
	}

	return sections.join("\n\n");
}
