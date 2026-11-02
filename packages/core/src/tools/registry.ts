import type { AgentTool } from "../types.ts";
import type { ToolRunContext, ToolState } from "./manager.ts";
import { toolListFor } from "./manager.ts";
import type { ToolDefinitions } from "./manager.ts";

/**
 * The tools this build knows. Structure only: what exists here, not what is chosen.
 *
 * Process structure, not a session's: the definitions come from the shared read-only
 * {@link ToolDefinitions}, and `register` adds tools a caller means every session of this catalog to
 * know — a test's custom tool. A session's own tools (the delegation pair) are assembly products and
 * live on its registry entry; {@link registryView} is the one place the two halves are put together.
 * The choice — which of them the model may call, and which ask for approval — is not held here at
 * all: it is a {@link ToolState} that arrives with each read, derived from the ledger's `tool_config`
 * entries by the session (see `toolStateOf` in `session/tool-config.ts`), because every write of that
 * state lands in the ledger in the same stack and nothing alive outlives it. No workspace is resident
 * either — `active` builds the executable set fresh against the run context it is handed, so the
 * workspace is a value object that arrives with the request and leaves with it.
 */
export interface ToolRegistry {
	/** Every tool name this registry knows: the definitions', then the registered ones. */
	names(): string[];
	/** Build one tool against a run context, or undefined when the name is not this registry's. */
	build(name: string, run: ToolRunContext): AgentTool<any> | undefined;
	/** What the model may call right now, as names, in the order it is offered them. */
	activeNames(state: ToolState): string[];
	/** The run context's executable set for this choice, built fresh — see {@link toolListFor}. */
	active(state: ToolState, run: ToolRunContext): AgentTool<any>[];
	/** A tool joins the catalog; whether it is active is the choice, not this. */
	register(tool: AgentTool<any>): void;
}

/**
 * The catalog one process knows: the build's definitions, plus whatever a caller registered.
 *
 * There is no loadout to hand in: a deliberate choice — the SubAgent child's read-only narrowing —
 * is a {@link ToolState} the caller keeps as its fallback seed, not something a registry opens on,
 * and a session whose choice is nowhere derives the full set, which is what a session that has not
 * chosen runs on.
 */
export function createToolRegistry(definitions: ToolDefinitions): ToolRegistry {
	return new Registry(definitions);
}

/**
 * The catalog as one session sees it: this registry's tools, plus the tools that session has of its own.
 *
 * The session-local half lives on the registry entry rather than here (ADR-0007 §4): the delegation
 * pair closes over the transcript it reports to, which is an assembly product, while the registry is
 * process structure. This view is how the two meet without either holding the other — it is built per
 * resolution, holds nothing, and behaves exactly like a registry that had them registered.
 */
export function registryView(registry: ToolRegistry, local: readonly AgentTool<any>[]): ToolRegistry {
	if (local.length === 0) return registry;
	// A name the session holds is the session's, in every answer this view gives: a registered tool and
	// a session's own one are one entry of the catalog, not two.
	const shadowed = new Set(local.map((tool) => tool.name));
	const names = (): string[] => [...registry.names().filter((name) => !shadowed.has(name)), ...shadowed];
	return {
		names,
		build: (name, run) => local.find((tool) => tool.name === name) ?? registry.build(name, run),
		activeNames: (state) => {
			const known = new Set(names());
			return state.activeToolNames.filter((name) => known.has(name));
		},
		// The base's order first — definitions, then the tools registered on it — and the session's own
		// after them, which is where a registry that had them registered would have put them.
		active: (state, run) => {
			const active = new Set(state.activeToolNames);
			const base = registry.active(state, run).filter((tool) => !shadowed.has(tool.name));
			return [...base, ...local.filter((tool) => active.has(tool.name))];
		},
		register: (tool) => registry.register(tool),
	};
}

class Registry implements ToolRegistry {
	/** Registered tools, in registration order; the definitions come first in every listing. */
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
