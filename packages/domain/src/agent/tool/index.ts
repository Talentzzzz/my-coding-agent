export {
	type BashSettings,
	type ModeSettings,
	type ToolDefaults,
	type ToolDefaultsPatch,
	type ToolFillContext,
	type ToolManagerOptions,
	type ToolRunContext,
	type ToolState,
	createToolManager,
	DEFAULT_MODE_NAME,
	fillTools,
	narrowToKnown,
	ToolManager,
} from "./manager.ts";

// `describeToolCall` 自分层重构步 4 起住 agent 根 types.ts 共享内核（§2.3）：agent/dangling.ts
// 消费它，R2 下 session 不得 import 本包。经根模块取：import { describeToolCall } from "../types.ts"。
export { describeToolCall } from "../types.ts";
