import type { AgentTool } from "@my-agent/loop";
import type { SettingsManager } from "../settings-manager.ts";
import type { Workspace } from "../workspace.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

/**
 * The tools one session knows about, and which of them the model may call.
 *
 * Definitions and the active set live together because they are one decision: a caller registers the
 * tools it has and narrows the set per session — a read-only session, a session without `bash` —
 * without rebuilding any tool object. There is still no plugin registry: a definition is one
 * `AgentTool`, and `executionMode` stays a field on it, not something this set decides.
 */
export interface ToolRegistry {
	/** Every registered tool, in registration order. */
	all(): AgentTool<any>[];
	get(name: string): AgentTool<any> | undefined;
	/** What the model may call, in registration order. */
	active(): AgentTool<any>[];
	activeNames(): string[];
	/** Reject unknown names by throwing, leaving the previous set in place. */
	setActive(names: string[]): void;
	/** A registered tool joins the active set; `setActive` is how the set is narrowed again. */
	register(tool: AgentTool<any>): void;
}

/**
 * The six built-in tools, all active.
 *
 * `settingsManager` is what lets `bash` run on the configured timeouts; without one it takes the
 * defaults, which is what a test or a SubAgent's read-only registry wants.
 */
export function createToolRegistry(workspace: Workspace, settingsManager?: SettingsManager): ToolRegistry {
	return new Registry([
		createReadTool(workspace),
		createWriteTool(workspace),
		createEditTool(workspace),
		createGlobTool(workspace),
		createGrepTool(workspace),
		createBashTool(workspace, settingsManager),
	]);
}

class Registry implements ToolRegistry {
	private readonly tools = new Map<string, AgentTool<any>>();
	/** Names, not tools: the active list is always derived in registration order. */
	private activeSet = new Set<string>();

	constructor(tools: AgentTool<any>[]) {
		for (const tool of tools) this.register(tool);
	}

	all(): AgentTool<any>[] {
		return [...this.tools.values()];
	}

	get(name: string): AgentTool<any> | undefined {
		return this.tools.get(name);
	}

	active(): AgentTool<any>[] {
		return this.all().filter((tool) => this.activeSet.has(tool.name));
	}

	activeNames(): string[] {
		return this.active().map((tool) => tool.name);
	}

	setActive(names: string[]): void {
		const unknown = names.filter((name) => !this.tools.has(name));
		if (unknown.length > 0) {
			throw new Error(`Unknown tool${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
		}
		this.activeSet = new Set(names);
	}

	register(tool: AgentTool<any>): void {
		if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
		this.tools.set(tool.name, tool);
		this.activeSet.add(tool.name);
	}
}
