// The tool side of this build: one table of every tool it knows, and the pure-data choice of which
// of them a session may call (ADR-0016).
//
// The table is resident and the choice is not. What sits in the table is behaviour only — six
// directory-free instances, plus whatever a test registered — so holding them costs a process
// lifetime of constants rather than a session's worth of state. Everything a call needs that changes
// between requests (the working directory, the `bash` timeouts) arrives on `execute`'s `run`, which
// is what lets one instance serve every session.

import type { Tool, ToolResult, ToolRunContext, ToolUpdateCallback } from "../llm/index.ts";
import { DEFAULT_MODE_NAME, type ModeSettings } from "../config.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

/**
 * The per-request values a tool acts with, re-exported from the wire types.
 *
 * It is `execute`'s third parameter, so its home is beside `Tool` (ADR-0015 §2): this re-export keeps
 * every existing import path — `tools/index.ts`, `agent.ts`, the smokes — pointing at the same name.
 */
export type { ToolRunContext };

// ---------------------------------------------------------------------------- the state

/**
 * The tool choice one session is in, as pure data: what the session's `.json` snapshot records.
 *
 * `activeToolNames` is what the model may call; `approvalOverride` is the session's own approval
 * map over the global defaults, undefined when the session never chose and follows global.
 * The names may include tools this build no longer knows — the recorded set is narrowed at fill and
 * assembly time, never stored back shortened, so a downgrade and re-upgrade keeps the choice.
 */
export interface ToolState {
	activeToolNames: string[];
	approvalOverride?: Record<string, boolean>;
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

// ---------------------------------------------------------------------------- the table

/**
 * The six built-ins, in the order the model is offered them. Zero-argument factories: a tool closes
 * over nothing, so the table can hold the products for the life of the process.
 */
const builtIns: readonly (() => Tool<any>)[] = [
	() => createReadTool(),
	() => createWriteTool(),
	() => createEditTool(),
	() => createGlobTool(),
	() => createGrepTool(),
	() => createBashTool(),
];

/**
 * The tools one process knows: a `Map<name, Tool>` holding every instance, plus the registered ones.
 *
 * Structure only — what exists here, not what is chosen. The choice is a {@link ToolState} derived
 * per read from the ledger (`toolStateOf` in `session/tool-config.ts`), so this table never answers
 * "may this session call it": the engine answers that against the names it derived. Whether a
 * registered tool is offered is the same question, answered in the same place.
 *
 * What this class also owns is the call: {@link ToolManager.execute} resolves a name and forwards to
 * the instance it names, so a caller that holds a name and this call's `run` values needs nothing
 * else to run a tool. The behaviour stays on the instance, and the validation, the gates, the
 * events, and the result write-back stay in the engine.
 */
export class ToolManager {
	/** Every tool this process knows, in the order the model is offered them. Never replaced. */
	private readonly all = new Map<string, Tool<any>>();

	/**
	 * Names of every tool this table holds: the six built-ins, then whatever was registered.
	 *
	 * Read, not remembered — the keys are the table's own, so a name registered later shows up on the
	 * next read and nothing has to be invalidated.
	 */
	names(): string[] {
		this.ensureFilled();
		return [...this.all.keys()];
	}

	/**
	 * One tool by name, or undefined when this build does not have it.
	 *
	 * The same object every time: the table is filled once and entries are never replaced, so a run
	 * that held an instance at `prepareRequest` and one that looks it up mid-batch see the same tool.
	 */
	get(name: string): Tool<any> | undefined {
		this.ensureFilled();
		return this.all.get(name);
	}

	/**
	 * Run one tool call: look the tool up and forward, with this call's own run values.
	 *
	 * It does not decide whether the call is allowed, and it does not validate: an unknown name here
	 * is a bug upstream — the engine resolves and gates a name before it asks for the call — so it
	 * throws rather than synthesizing a second result the model could see.
	 */
	async execute(
		name: string,
		toolCallId: string,
		params: unknown,
		run: ToolRunContext,
		signal?: AbortSignal,
		onUpdate?: ToolUpdateCallback<any>,
	): Promise<ToolResult<any>> {
		const tool = this.get(name);
		if (tool === undefined) throw new Error(`Tool not found: ${name}`);
		return tool.execute(toolCallId, params as never, run, signal, onUpdate);
	}

	/**
	 * Put a tool in the table. It joins; whether it is offered is the choice, not this.
	 *
	 * The fill happens first, so a name that collides with a built-in is refused by the same rule that
	 * refuses two registrations of one name — and a later fill can never overwrite what was just
	 * registered. Only new names are accepted: no unregister, no replace, no second table.
	 */
	register(tool: Tool<any>): void {
		this.ensureFilled();
		if (this.all.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
		this.all.set(tool.name, tool);
	}

	/**
	 * Fill the table with the six built-ins, once.
	 *
	 * On first touch rather than in the constructor, because a process that assembles a session and
	 * never runs a tool should not pay for six instances — and because the fill has to happen before
	 * any read that answers "what exists", which is every public method here. Filling all six at once
	 * rather than one per name is what keeps this table the only answer to "what exists": a per-name
	 * fill would need a static list of names beside it, and two lists can disagree.
	 *
	 * A non-empty table is a filled one: `register` fills before it writes, so nothing can be in here
	 * without the six already in place.
	 */
	private ensureFilled(): void {
		if (this.all.size > 0) return;
		for (const create of builtIns) {
			const tool = create();
			this.all.set(tool.name, tool);
		}
	}
}

/** The table one process knows. Built zero-argument: the built-ins are this build's constants. */
export function createToolManager(): ToolManager {
	return new ToolManager();
}
