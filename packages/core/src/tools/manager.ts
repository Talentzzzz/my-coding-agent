import type { AgentTool } from "@my-agent/loop";
import { DEFAULT_MODE_NAME, type BashSettings, type ModeSettings } from "../config.ts";
import { APPROVAL_TOOLS, type ToolApprovalKey } from "../protocol.ts";
import type { Workspace } from "../workspace.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

/**
 * The tool side of the stateless chain (ADR-0006): the definitions are global and read-only, the
 * per-session choice is pure data ({@link ToolState}), and the executable set is built fresh against
 * the run context every time it is asked for. Nothing here holds a workspace between calls.
 */

// ---------------------------------------------------------------------------- the definitions

/**
 * The value objects one request's tools are built against.
 *
 * The tools resolve paths inside {@link workspace} and run `bash` under {@link bash}; both are
 * per-request facts — the workspace comes from the session header's cwd, the timeouts from the
 * settings read alongside — so they are injected at build time rather than captured when a session
 * is assembled. A value object lives and dies with the request that carries it.
 */
export interface ToolRunContext {
	workspace: Workspace;
	/** The `bash` timeouts; the defaults when the caller names none. */
	bash?: BashSettings;
}

/**
 * One built-in tool as a definition: a factory over the run context.
 *
 * A definition is everything about the tool except the workspace it acts in, which is why it is a
 * function and not an `AgentTool` — an `AgentTool` closes over its workspace, and a registry that
 * held those would hold a workspace per session, which is the residency this file exists to remove.
 */
export type ToolDefinition = (run: ToolRunContext) => AgentTool<any>;

/**
 * The full set of tool definitions this build knows, read-only.
 *
 * There is still no plugin registry: a definition is one factory over the six built-ins, and
 * `executionMode` stays a field on the built tool, not something this catalog decides.
 */
export interface ToolDefinitions {
	/** Every definition's name, in registration order. */
	names(): string[];
	get(name: string): ToolDefinition | undefined;
	all(): ToolDefinition[];
}

/** The six built-ins, in the order the model is offered them. */
export function createToolDefinitions(): ToolDefinitions {
	const definitions = new Map<string, ToolDefinition>([
		["read", (run) => createReadTool(run.workspace)],
		["write", (run) => createWriteTool(run.workspace)],
		["edit", (run) => createEditTool(run.workspace)],
		["glob", (run) => createGlobTool(run.workspace)],
		["grep", (run) => createGrepTool(run.workspace)],
		["bash", (run) => createBashTool(run.workspace, run.bash)],
	]);
	return {
		names: () => [...definitions.keys()],
		get: (name) => definitions.get(name),
		all: () => [...definitions.values()],
	};
}

/**
 * The process-wide definitions, built once.
 *
 * The definitions are constants of this build — the same six for every session, over every
 * workspace — so one shared catalog is the "global read-only, built at startup" form the stateless
 * architecture asks for. Read-only is the point: a session narrows what the model may call through
 * its own {@link ToolState}, never by adding to or reshaping the catalog.
 */
let sharedDefinitions: ToolDefinitions | undefined;
export function toolDefinitions(): ToolDefinitions {
	return (sharedDefinitions ??= createToolDefinitions());
}

// ---------------------------------------------------------------------------- the state

/**
 * The tool choice one session is in, as pure data: what a `tool_config` entry records.
 *
 * `activeToolNames` is what the model may call; `approvalOverride` is the session's own approval
 * map over the workspace's defaults, undefined when the session never chose and follows global.
 * The names may include tools this build no longer knows — the recorded set is narrowed at fill and
 * assembly time, never stored back shortened, so a downgrade and re-upgrade keeps the choice.
 */
export interface ToolState {
	activeToolNames: string[];
	approvalOverride?: Partial<Record<ToolApprovalKey, boolean>>;
}

/** The name the built-in default mode answers to, owned by the settings config (ADR-0005). */
export { DEFAULT_MODE_NAME };

/**
 * The context one fill is answered from: the settings the seed is completed against.
 *
 * `globalTools` is the global default's tool set as the settings files name it, or the full set when
 * they name none; `known` is what this build can actually build, and a name outside it is dropped
 * rather than thrown at — a hand-edited settings file owes the catalog no order and no membership.
 * The default view's approval half needs no input: it is "follow the global approvals", which the
 * readers realize by merging against the live settings.
 */
export interface ToolFillContext {
	modes: readonly ModeSettings[];
	globalTools: readonly string[];
	known: readonly string[];
}

/** Drop the names this build does not know, keeping the order the seed named them in. */
export function narrowToKnown(names: readonly string[], known: readonly string[]): string[] {
	return names.filter((name) => known.includes(name));
}

/**
 * Fill a mode seed into a complete {@link ToolState}.
 *
 * The product is the truth and the seed is only the pointer: an unknown mode name throws, because a
 * session asked to run in a mode nobody defined has no configuration to fall back on and must say so
 * rather than run on one the caller did not mean. A missing or 「默认」 seed is the built-in default
 * mode — the global default's live view, the full tool set and the global approvals — and reads no
 * stored mode entry, because that mode is never stored: what it answers is the settings files
 * themselves, so a change to them is the change to this mode.
 *
 * The default view keeps `approvalOverride` undefined rather than copying the global map in: a copy
 * would freeze the approvals at fill time, while undefined means "the session never chose" and every
 * reader merges against the live settings. A named mode's approval map, by contrast, *is* a choice,
 * and is carried whole.
 */
export function fillTools(modeName: string | undefined, context: ToolFillContext): ToolState {
	if (modeName === undefined || modeName === DEFAULT_MODE_NAME) {
		return { activeToolNames: narrowToKnown(context.globalTools, context.known) };
	}

	const mode = context.modes.find((candidate) => candidate.name === modeName);
	if (mode === undefined) throw new Error(`Unknown mode: ${modeName}`);
	return {
		activeToolNames: narrowToKnown(mode.tools, context.known),
		approvalOverride: { ...mode.approval },
	};
}

// ---------------------------------------------------------------------------- the subagent loadout

/**
 * What the SubAgent's own session may call, and nothing else.
 *
 * Read-only covers the work delegation is for — reading many files, reporting back — and makes "the
 * SubAgent cannot change anything" a property of the loadout, not of model behavior. These three
 * also need no approval under the default approval set, so the child never stalls.
 */
export const SUBAGENT_TOOL_NAMES = ["read", "glob", "grep"] as const;

/**
 * The child session's loadout as one {@link ToolState}: the narrowed set, and every approval off.
 *
 * The approvals are off here rather than left to the settings, because a SubAgent's approval request
 * has no window to answer it — the override is what makes "the child cannot stall" true whatever the
 * workspace's settings say. Delegation does not nest: the child's loadout carries no delegation tool,
 * and its session is built with `subagents: false` to hold the rule structurally.
 */
export function subagentToolState(): ToolState {
	// `APPROVAL_TOOLS` enumerates every key the map gates, so the table it builds is complete — the
	// assertion is where the keys come from, not a cast past the type system.
	const approval = Object.fromEntries(APPROVAL_TOOLS.map((name) => [name, false])) as Record<ToolApprovalKey, boolean>;
	return { activeToolNames: [...SUBAGENT_TOOL_NAMES], approvalOverride: approval };
}

// ---------------------------------------------------------------------------- the run-context assembly

/**
 * The run context's executable set, built fresh: definitions looked up by the active names, each
 * built against the run context, then the session-local tools whose names are active.
 *
 * This is the one place "an active name" becomes "a tool the loop can call", and it builds rather
 * than returns stored tools — the workspace is a per-request value object, so an `AgentTool` cannot
 * outlive the request that asked for the list. Names this build does not know are skipped, the same
 * narrowing a replayed `tool_config` gets: a recorded set is read down to what can run, never thrown
 * at.
 */
export function toolListFor(
	definitions: ToolDefinitions,
	state: ToolState,
	run: ToolRunContext,
	local: readonly AgentTool<any>[] = [],
): AgentTool<any>[] {
	const active = new Set(state.activeToolNames);
	const built: AgentTool<any>[] = [];
	for (const name of definitions.names()) {
		if (!active.has(name)) continue;
		const tool = definitions.get(name)?.(run);
		if (tool !== undefined) built.push(tool);
	}
	for (const tool of local) {
		if (active.has(tool.name)) built.push(tool);
	}
	return built;
}
