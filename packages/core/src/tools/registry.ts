import type { AgentTool } from "@my-agent/loop";
import type { ToolApprovalKey } from "../protocol.ts";
import type { ToolRunContext, ToolState } from "./manager.ts";
import { toolListFor } from "./manager.ts";
import type { ToolDefinitions } from "./manager.ts";

/**
 * The tools one session knows, and which of them the model may call.
 *
 * This is the per-session half of the tool chain: the definitions come from the shared read-only
 * {@link ToolDefinitions}, the choice is a {@link ToolState} this object holds and mutates, and no
 * workspace is resident — `active` builds the executable set fresh against the run context it is
 * handed, so the workspace is a value object that arrives with the request and leaves with it.
 *
 * Definitions and the active set live together because they are one decision: a caller starts from
 * the shared catalog and narrows the set per session — a read-only session, a session without
 * `bash` — without rebuilding any tool object. `register` is for tools that are the session's own
 * rather than this build's — the delegation pair, a test's custom tool — and joins the same state.
 */
export interface ToolRegistry {
	/** Every tool name this registry knows: the definitions', then the session-local ones. */
	names(): string[];
	/** Build one tool against a run context, or undefined when the name is not this registry's. */
	build(name: string, run: ToolRunContext): AgentTool<any> | undefined;
	/** What the model may call right now, as names, in the order it is offered them. */
	activeNames(): string[];
	/** The run context's executable set, built fresh — see {@link toolListFor}. */
	active(run: ToolRunContext): AgentTool<any>[];
	/** The state this registry is, as a copy: what a `tool_config` entry records. */
	toolState(): ToolState;
	/** Reject unknown names by throwing, leaving the previous set in place. */
	setActive(names: string[]): void;
	/** Replace the session's own approval choices, whole. */
	setApprovalOverride(override: Partial<Record<ToolApprovalKey, boolean>>): void;
	/** Lay a patch over the session's own approval choices, keeping the keys the patch does not name. */
	mergeApprovalOverride(patch: Partial<Record<ToolApprovalKey, boolean>>): void;
	/** A session-local tool joins the active set; `setActive` is how the set is narrowed again. */
	register(tool: AgentTool<any>): void;
}

/**
 * One session's loadout over the shared definitions, seeded with a state when the caller has one.
 *
 * `state` is how a deliberate loadout is handed in — the SubAgent child's read-only narrowing, a
 * session whose recorded `tool_config` was replayed before this object was built. Without one the
 * registry opens with every tool active, which is what a session that has not chosen runs on until
 * assembly fills the state for it.
 */
export function createToolRegistry(definitions: ToolDefinitions, state?: ToolState): ToolRegistry {
	return new Registry(definitions, state);
}

class Registry implements ToolRegistry {
	private readonly state: ToolState;
	/** Session-local tools, in registration order; the definitions come first in every listing. */
	private readonly local = new Map<string, AgentTool<any>>();
	private readonly definitions: ToolDefinitions;

	constructor(definitions: ToolDefinitions, state?: ToolState) {
		this.definitions = definitions;
		this.state = state === undefined ? { activeToolNames: definitions.names() } : cloneState(state);
	}

	names(): string[] {
		return [...this.definitions.names(), ...this.local.keys()];
	}

	build(name: string, run: ToolRunContext): AgentTool<any> | undefined {
		const local = this.local.get(name);
		if (local !== undefined) return local;
		return this.definitions.get(name)?.(run);
	}

	activeNames(): string[] {
		const known = new Set(this.names());
		return this.state.activeToolNames.filter((name) => known.has(name));
	}

	active(run: ToolRunContext): AgentTool<any>[] {
		return toolListFor(this.definitions, this.state, run, [...this.local.values()]);
	}

	toolState(): ToolState {
		return cloneState(this.state);
	}

	setActive(names: string[]): void {
		const known = new Set(this.names());
		const unknown = names.filter((name) => !known.has(name));
		if (unknown.length > 0) {
			throw new Error(`Unknown tool${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
		}
		this.state.activeToolNames = [...names];
	}

	setApprovalOverride(override: Partial<Record<ToolApprovalKey, boolean>>): void {
		this.state.approvalOverride = { ...override };
	}

	mergeApprovalOverride(patch: Partial<Record<ToolApprovalKey, boolean>>): void {
		this.setApprovalOverride({ ...this.state.approvalOverride, ...patch });
	}

	register(tool: AgentTool<any>): void {
		if (this.names().includes(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
		this.local.set(tool.name, tool);
		this.state.activeToolNames.push(tool.name);
	}
}

function cloneState(state: ToolState): ToolState {
	return {
		activeToolNames: [...state.activeToolNames],
		...(state.approvalOverride === undefined ? {} : { approvalOverride: { ...state.approvalOverride } }),
	};
}
