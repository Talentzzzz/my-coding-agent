export {
	type ToolFillContext,
	type ToolRunContext,
	type ToolState,
	createToolManager,
	DEFAULT_MODE_NAME,
	fillTools,
	narrowToKnown,
	ToolManager,
} from "./manager.ts";

/** tool call 的简短人类可读摘要，供审批 prompt 和会话记录用。 */
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}
