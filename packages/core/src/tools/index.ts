import type { Tool } from "../llm/index.ts";
import type { ToolRunContext } from "./manager.ts";
import { toolDefinitions } from "./manager.ts";

export {
	type ToolDefinition,
	type ToolDefinitions,
	type ToolFillContext,
	type ToolRunContext,
	type ToolState,
	createToolDefinitions,
	DEFAULT_MODE_NAME,
	fillTools,
	narrowToKnown,
	toolDefinitions,
	toolListFor,
} from "./manager.ts";
export { createToolRegistry, type ToolRegistry } from "./registry.ts";

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
		default:
			return name;
	}
}

/**
 * The six built-ins, built against one run context.
 *
 * The definitions are how a session gets its tools; this is for callers that want the objects
 * themselves — a smoke exercising a tool by name, a test driving `execute` directly. Each is built
 * fresh against the context given, the same way the run-context assembly builds them.
 */
export function createTools(run: ToolRunContext): Tool<any>[] {
	return toolDefinitions().all().map((definition) => definition(run));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}
