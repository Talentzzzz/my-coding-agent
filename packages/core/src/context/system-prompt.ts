import { platform } from "node:os";
import type { AgentsMdFile } from "./agents-md.ts";
import { formatAgentsMd } from "./agents-md.ts";

export interface SystemPromptInput {
	workspaceRoot: string;
	toolNames: readonly string[];
	/** Tools that require user approval before they run. */
	approvalTools: readonly string[];
	agentsMd: readonly AgentsMdFile[];
}

const IDENTITY = `You are a coding agent working inside one workspace directory on the user's machine.
You read and change files through tools, run commands, and report what you actually did.

How to work:
- Inspect before you change. Find the relevant files with glob and grep, read them, then edit.
- Prefer the smallest change that solves the problem. Keep the existing style of the file.
- Use edit for targeted changes and write only for new files or a deliberate full rewrite.
- Run the project's own checks (tests, type check, lint) when they exist, and report the result.
- If you are unsure, say so and state what you would need to check.

How to answer:
- Lead with the result. Keep prose short and technical.
- Reference files as path:line so the user can jump to them.
- Never claim a command succeeded unless you ran it and saw the output.
- Do not print secrets, tokens, or full environment dumps.`;

/** Assemble the system prompt from the identity, environment, tools, and project instructions. */
export function buildSystemPrompt(input: SystemPromptInput): string {
	const sections: string[] = [IDENTITY];

	sections.push(
		[
			"## Environment",
			`- Workspace root: ${input.workspaceRoot}`,
			`- Platform: ${platform()}`,
			`- Today: ${new Date().toISOString().slice(0, 10)}`,
		].join("\n"),
	);

	const approval =
		input.approvalTools.length > 0
			? `\nThese tools ask the user for approval before running: ${input.approvalTools.join(", ")}. A denial comes back as a tool error; do not retry the same call, adjust your approach.`
			: "";
	// A session can be opened with no active tools, which is a conversation and not a broken prompt.
	const available = input.toolNames.length === 0 ? "none" : input.toolNames.join(", ");
	sections.push(`## Tools\nAvailable: ${available}.${approval}`);

	const project = formatAgentsMd(input.agentsMd, input.workspaceRoot);
	if (project !== undefined) {
		sections.push(`## Project instructions\nThe user's project ships these instructions. Follow them.\n\n${project}`);
	}

	return sections.join("\n\n");
}
