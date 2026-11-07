import { anthropicMessages, type ChatTransport } from "./llm/index.ts";
import { Agent } from "./agent.ts";
import type { OpenAgentOptions } from "./assembly.ts";
import { buildSystemPrompt } from "./context/system-prompt.ts";
import { createHooks, type Hooks } from "./hooks.ts";
import { SessionManager } from "./session/session-manager.ts";
import { approvalToolsOf } from "./session/tool-config.ts";
import { SettingManager } from "./setting-manager.ts";
import { type ToolManager, createToolManager } from "./tools/index.ts";

/**
 * The services one orchestrator coordinates, for a caller that builds one.
 *
 * Everything here is process-level: the ledger, the configuration every settings and model read goes
 * through, the tool table, and the transport. Nothing in it is a session's — which is what lets a host
 * keep one orchestrator for every conversation it runs (ADR-0007 §6). A session's state is not here
 * either: the orchestrator builds it from the transcript it is handed ({@link Agent.open}), over
 * exactly these services, so the two halves of a session's setup cannot be told apart from outside.
 */
export interface SessionAgentServices {
	sessionManager: SessionManager;
	/** The configuration every settings and model read of every session this orchestrator runs goes through. */
	settings: SettingManager;
	/**
	 * The tools callers of this orchestrator share. Omitted means a table of the six built-ins alone;
	 * a test that adds a tool of its own hands in a table of its own, so nothing it registered reaches
	 * a session outside the test.
	 */
	tools?: ToolManager;
	/** The transport every request this orchestrator makes goes over. Defaults to Anthropic Messages. */
	api?: ChatTransport;
}

/**
 * Build the orchestrator: one object over the services, with the seams it dispatches through installed.
 *
 * A host that runs every session of a process calls this once; a caller that wants a session it does
 * not share — a smoke, a test — calls it once per session and opens that session onto it. Either way
 * the two halves of a session's setup are the same two halves, so what the host runs and what a
 * smoke drives cannot drift apart.
 *
 * The defaults are installed on the surface the caller gets back rather than hard-coded in the class,
 * so a host can add a handler after them and refine what they decided. See
 * {@link installDefaultHooks}.
 */
export function createSessionAgent(services: SessionAgentServices): Agent {
	const hooks = createHooks();
	// Resolved once and handed to the orchestrator, which is the only table a run's executable set is
	// read from and the only table a command narrows: a second resolution here would let a caller's own
	// tool reach one and not the other.
	const tools = services.tools ?? createToolManager();
	const agent = new Agent({
		sessionManager: services.sessionManager,
		settings: services.settings,
		tools,
		hooks,
		// The one assembly of a process: the transport is resolved here rather than defaulted inside
		// the orchestrator, so everything a run can leave the process through is decided in one file.
		api: services.api ?? anthropicMessages,
		// Rebuilt whenever the active set or the approval set moves, so the prompt cannot promise tools
		// or approvals the session no longer has. The working directory and the project instructions are
		// handed over per request for the same reason they are not captured: one builder serves every
		// session this orchestrator runs, and both facts belong to the session, not to the builder.
		systemPrompt: (workDirAbsPath, agentsMd, toolNames, approvals) =>
			buildSystemPrompt({
				workDirAbsPath,
				toolNames,
				// Every tool the map gates, not just the active ones: the map is the session's whole
				// choice, and a tool narrowed away is a tool the prompt should still say is gated rather
				// than one it silently drops.
				approvalTools: approvalToolsOf(approvals),
				agentsMd,
			}),
	});
	// The gate is installed on the surface the caller gets back, after construction, because it
	// dispatches through the orchestrator it belongs to (`session.authorize`) — a handler built into
	// the class could only reach half of what it needs.
	installDefaultHooks(hooks, agent);
	return agent;
}

/**
 * The default handler every orchestrator dispatches through.
 *
 * `before_tool` is the approval gate. The session owns the bookkeeping of what the transcript is
 * still waiting on and the UI that answers it; the hook only translates an unanswered approval into
 * the suspend that ends the run (ADR-0006 §5): the call is left dangling in the ledger with no result
 * — that is what the banner is derived from — and the answer arrives over REST to start the recovery
 * run that pairs it and continues.
 *
 * There is no default `after_tool`: a rewrite there is final — the ledger keeps exactly the content
 * the hooks returned — so the seam belongs to whoever has a reason to rewrite. The output backstop
 * that used to live here moved to the write boundary (`finalizeToolResult` in `agent.ts`), where it
 * catches a result nobody bounded without spending a hook on it; a hook that wants to bound a result
 * itself archives the full text with `archiveToolResult` and returns the path in the content.
 */
function installDefaultHooks(hooks: Hooks, session: Agent): void {
	hooks.on("before_tool", async ({ sessionId, toolCallId, toolName, args }) => {
		const needsApproval = await session.authorize(sessionId, toolName, toolCallId, args);
		return needsApproval ? { suspend: true } : undefined;
	});
}

/**
 * Open one session and hand back an orchestrator of its own.
 *
 * The composition a caller wants when it does not share its orchestrator with anything else: a smoke
 * driving a scripted transport, or a test opening one directory by hand. A process that runs many
 * sessions builds the orchestrator once instead and opens each transcript onto it — see the hub —
 * and that is the shape this exists to keep honest: opening a session and resuming one are the same
 * act, whichever of the two roads is taken.
 *
 * The services are resolved *before* the orchestrator is built, and only once: assembly reads the
 * settings through the manager the orchestrator will answer with, so resolving it twice — as this
 * used to — was a second instance that only happened to behave the same because `SettingManager`
 * holds nothing.
 */
export async function openAgent(options: OpenAgentOptions): Promise<Agent> {
	const settings = options.settings ?? new SettingManager();
	const sessionManager = options.sessionManager ?? new SessionManager();
	const tools = options.tools ?? createToolManager();
	const agent = createSessionAgent({
		sessionManager,
		settings,
		tools,
		...(options.api === undefined ? {} : { api: options.api }),
	});
	// The state enters the orchestrator's table here, through the same door the hub uses: the
	// orchestrator was built first and reads nothing at construction, so the order — services, agent,
	// open — is the only one there is.
	await agent.open(options);
	return agent;
}
