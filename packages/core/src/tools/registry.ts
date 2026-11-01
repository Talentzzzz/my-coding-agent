import type { AgentTool } from "@my-agent/loop";
import type { ToolRunContext, ToolState } from "./manager.ts";
import { toolListFor } from "./manager.ts";
import type { ToolDefinitions } from "./manager.ts";

/**
 * The tools one session knows. Structure only: what exists here, not what is chosen.
 *
 * This is the per-session half of the tool chain: the definitions come from the shared read-only
 * {@link ToolDefinitions}, and `register` adds the tools that are the session's own rather than this
 * build's — the delegation pair, a test's custom tool. The choice — which of them the model may call,
 * and which ask for approval — is not held here at all: it is a {@link ToolState} that arrives with
 * each read, derived from the ledger's `tool_config` entries by the session (see `toolStateOf` in
 * `session/tool-config.ts`), because every write of that state lands in the ledger in the same stack
 * and nothing alive outlives it. No workspace is resident either — `active` builds the executable set
 * fresh against the run context it is handed, so the workspace is a value object that arrives with
 * the request and leaves with it.
 */
export interface ToolRegistry {
	/** Every tool name this registry knows: the definitions', then the session-local ones. */
	names(): string[];
	/** Build one tool against a run context, or undefined when the name is not this registry's. */
	build(name: string, run: ToolRunContext): AgentTool<any> | undefined;
	/** What the model may call right now, as names, in the order it is offered them. */
	activeNames(state: ToolState): string[];
	/** The run context's executable set for this choice, built fresh — see {@link toolListFor}. */
	active(state: ToolState, run: ToolRunContext): AgentTool<any>[];
	/** A session-local tool joins the catalog; whether it is active is the choice, not this. */
	register(tool: AgentTool<any>): void;
}

/**
 * One session's catalog over the shared definitions.
 *
 * There is no loadout to hand in: a deliberate choice — the SubAgent child's read-only narrowing —
 * is a {@link ToolState} the caller keeps as its fallback seed, not something a registry opens on,
 * and a session whose choice is nowhere derives the full set, which is what a session that has not
 * chosen runs on.
 */
export function createToolRegistry(definitions: ToolDefinitions): ToolRegistry {
	return new Registry(definitions);
}

class Registry implements ToolRegistry {
	/** Session-local tools, in registration order; the definitions come first in every listing. */
	private readonly local = new Map<string, AgentTool<any>>();
	private readonly definitions: ToolDefinitions;

	constructor(definitions: ToolDefinitions) {
		this.definitions = definitions;
	}

	names(): string[] {
		return [...this.definitions.names(), ...this.local.keys()];
	}

	build(name: string, run: ToolRunContext): AgentTool<any> | undefined {
		const local = this.local.get(name);
		if (local !== undefined) return local;
		return this.definitions.get(name)?.(run);
	}

	activeNames(state: ToolState): string[] {
		const known = new Set(this.names());
		return state.activeToolNames.filter((name) => known.has(name));
	}

	active(state: ToolState, run: ToolRunContext): AgentTool<any>[] {
		return toolListFor(this.definitions, state, run, [...this.local.values()]);
	}

	register(tool: AgentTool<any>): void {
		if (this.names().includes(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
		this.local.set(tool.name, tool);
	}
}
