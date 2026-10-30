import type { AgentTool } from "@my-agent/loop";
import type { SettingsManager } from "../settings-manager.ts";
import type { Workspace } from "../workspace.ts";
import { createToolRegistry } from "./registry.ts";

export { createToolRegistry, type ToolRegistry } from "./registry.ts";

/** Names of the built-in tools. Adding a tool means adding a case here and a file next to this one. */
export type ToolName = "read" | "write" | "edit" | "glob" | "grep" | "bash";

export const TOOL_NAMES: readonly ToolName[] = ["read", "write", "edit", "glob", "grep", "bash"];

/**
 * The built-in loadout as a plain list.
 *
 * `createToolRegistry` is how a session gets its tools; this is for callers that only want the six
 * objects, and it goes through the registry so there is one place that knows what the loadout is.
 * Each tool is one `AgentTool` from pi-agent-core with a workspace bound by closure, so a tool cannot
 * touch anything outside the workspace even by accident.
 */
export function createTools(workspace: Workspace, settingsManager?: SettingsManager): AgentTool<any>[] {
	return createToolRegistry(workspace, settingsManager).all();
}

/** Short human-readable summary of a tool call, for the approval prompt and the transcript. */
export function describeToolCall(name: string, args: unknown): string {
	const record = isRecord(args) ? args : {};
	switch (name) {
		case "read":
		case "write":
		case "edit":
		case "glob":
		case "grep":
			return `${name} ${stringField(record, "path") ?? stringField(record, "pattern") ?? ""}`.trim();
		case "bash": {
			const command = stringField(record, "command") ?? "";
			return command.length > 160 ? `${command.slice(0, 157)}...` : command;
		}
		case "SubAgent": {
			// The delegation prompt is the call's identity in the transcript; the background flag rides along.
			const prompt = stringField(record, "prompt") ?? "";
			const suffix = record["run_in_background"] === true ? " (background)" : "";
			const summary = prompt.length > 160 ? `${prompt.slice(0, 157)}...` : prompt;
			return `SubAgent${suffix} ${summary}`.trim();
		}
		case "SubAgentControl":
			return `SubAgentControl ${stringField(record, "action") ?? ""} ${stringField(record, "id") ?? ""}`.trim();
		default:
			return name;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}
