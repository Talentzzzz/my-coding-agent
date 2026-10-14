import { type Api, type ChatTransport, type Model } from "@my-agent/ai";
import { Agent, type AgentConfig } from "./agent.ts";
import { loadAgentsMd, type AgentsMdFile } from "./context/agents-md.ts";
import { buildSystemPrompt } from "./context/system-prompt.ts";
import { spillOversizedToolResult } from "./context/spill.ts";
import { boundToolContent, createHooks } from "./hooks.ts";
import {
	modelFor,
	modelRefOf,
	placeholderModel,
	resolveModelRef,
	type ModelSource,
	type UserModel,
} from "./models.ts";
import type { SessionSnapshot, ToolApprovalKey } from "./protocol.ts";
import type { SessionManager } from "./session/session-manager.ts";
import { sessionSnapshot } from "./session/snapshot.ts";
import { applyRecordedToolConfig, approvalToolsOf, defaultToolNames, followsGlobalOf } from "./session/tool-config.ts";
import { SettingsManager } from "./settings-manager.ts";
import { createToolRegistry, type ToolRegistry } from "./tools/index.ts";
import { createSubagentTools } from "./tools/subagent.ts";
import { Workspace } from "./workspace.ts";

/** What a caller must supply to build a session. Everything else is discovered here. */
export interface OpenAgentOptions {
	workspaceRoot: string;
	/**
	 * The transcript this session will read and write.
	 *
	 * Built by the caller rather than here, because deciding *which* session to open — a new one, the
	 * newest, one named by id — is the host's job, and a test opens an in-memory one instead.
	 */
	sessionManager: SessionManager;
	models: ModelSource;
	/** Overrides the stored and configured model with a `<name>/<wire id>` ref. */
	model?: string;
	thinkingLevel?: string;
	/**
	 * The transport every request in this session goes over.
	 *
	 * Omitted in the real process, where it means Anthropic Messages. A smoke passes a scripted
	 * transport so the loop can be driven with no provider key.
	 */
	api?: ChatTransport;
	/**
	 * The settings of this workspace.
	 *
	 * Defaults to the agent home's file merged with the workspace's own. A host that runs several
	 * sessions over one workspace builds one and passes it to each, so a change made through any of
	 * them is what the others read; a test passes {@link SettingsManager.inMemory} instead.
	 */
	settingsManager?: SettingsManager;
	/** Defaults to the six built-ins. A test passes a registry of its own to add a tool. */
	tools?: ToolRegistry;
	/**
	 * Whether this session may delegate to a SubAgent. Default true.
	 *
	 * A SubAgent's own session passes false: delegation does not nest, so a child's registry holds
	 * the read-only tools and nothing that could start a grandchild.
	 */
	subagents?: boolean;
}

/**
 * What a session *is*, resolved but not yet activated: the workspace, the settings, the model, and the
 * tool registry already put back on the branch's recorded choices.
 *
 * No `Agent` exists at this point and no entry has been appended. Splitting this out of
 * {@link openAgent} is what lets {@link readSessionSnapshot} answer a transcript this process is not
 * running from the same decisions a live session would have been assembled with, rather than from a
 * second implementation that could disagree.
 */
interface Assembled {
	workspace: Workspace;
	settingsManager: SettingsManager;
	model: Model<Api>;
	registry: ToolRegistry;
	/** The workspace's own instructions, already loaded, for the prompt this session will build. */
	agentsMd: AgentsMdFile[];
	recordedTools: { approval?: Record<ToolApprovalKey, boolean> };
}

/**
 * Resolve what one session is, without activating it.
 *
 * Everything a session needs and nothing that runs: no `Agent` is constructed, no hook is installed,
 * and no entry is appended to the transcript. Both {@link openAgent} and {@link readSessionSnapshot}
 * go through here, which is the property that matters — a session this process is not running is
 * described by the same decisions, in the same order, as the one it would have assembled.
 */
async function assemble(options: OpenAgentOptions): Promise<Assembled> {
	const workspace = new Workspace(options.workspaceRoot);
	// The project settings file is looked up beside the workspace, so it is resolved after the
	// workspace is: `<workspace>/.my-agent/settings.json`, over the agent home's own file.
	const settingsManager = options.settingsManager ?? SettingsManager.create(workspace.root);
	const settings = settingsManager.getSettings();
	const agentsMd = await loadAgentsMd(workspace.root);
	const recorded = options.sessionManager.getRecordedSettings();
	const row = selectModel(options.models, options.model ?? recordedRefOf(recorded.model) ?? settings.model);
	// A session with no row still runs, on the placeholder: see `placeholderModel`. What it cannot do
	// is send anything, and `Agent` answers for it with the sentence that says what to add.
	//
	// The level is settled here and handed over *on the model*, so a session is never on one row and
	// asked at a level that belongs to another. The row's own default is what a new session opens on:
	// the levels are the model's, so the default has to be the row's rather than the workspace's.
	const level =
		row === undefined
			? undefined
			: options.thinkingLevel ?? recorded.thinkingLevel ?? row.defaultThinkingLevel;
	const model: Model<Api> = row === undefined ? placeholderModel() : modelFor(row, level);
	const registry = options.tools ?? createToolRegistry(workspace, settingsManager);	// The level the model came back with, which is the level a subagent inherits: `modelFor` already
	// settled what the row's default means for this model, so asking again here could only disagree.
	const thinkingLevel = model.thinkingLevel ?? "off";

	// Delegation is part of assembly rather than of `createToolRegistry`, because a child needs the
	// model and the transcript this session resolved — things only the factory has in hand. The
	// SubAgent's own sessions pass `subagents: false`, so a child can never spawn a grandchild.
	if (options.subagents !== false) {
		const sessionFile = options.sessionManager.getSessionFile();
		for (const tool of createSubagentTools({
			workspace,
			models: options.models,
			...(row === undefined ? {} : { modelRef: modelRefOf(row) }),
			thinkingLevel,
			...(options.api === undefined ? {} : { api: options.api }),
			...(sessionFile === undefined ? {} : { parentSessionFile: sessionFile }),
		})) {
			registry.register(tool);
		}
	}

	// The tool set and approvals the session itself chose, replayed from its `tool_config` entries. A
	// session with no entry opens on the global default — the settings files' own tool set, or the
	// registry's full set when they name none — which is the choice it never made. A caller-supplied
	// registry is the exception: its active set *is* a deliberate loadout (the SubAgent child's
	// read-only narrowing, a test's custom tool), so with no entry the set is kept, not defaulted.
	//
	// The registry is settled here, after the subagent tools, so the default the files name can
	// include a delegation tool and the replay is the last word on the active set.
	const recordedTools = applyRecordedToolConfig(
		options.sessionManager,
		registry,
		options.tools === undefined ? defaultToolNames(settingsManager, registry) : registry.activeNames(),
	);

	return { workspace, settingsManager, model, registry, agentsMd, recordedTools };
}

/**
 * Read one session's state without activating it.
 *
 * The cold half of {@link openAgent}: it goes through the same {@link assemble}, so the workspace, the
 * model, the thinking levels, the tool set, and the approval map are what a live session over this
 * transcript would have had — and it stops there. No `Agent`, no loop, no hooks; the fields a loop
 * would have answered are supplied as the idle values they are, because there is no run to report on.
 *
 * Like assembly it appends nothing. Reading a transcript must not be an event in it, or opening a
 * session's history would be indistinguishable from using it.
 */
export async function readSessionSnapshot(options: OpenAgentOptions): Promise<SessionSnapshot> {
	const { workspace, settingsManager, model, registry, recordedTools } = await assemble(options);
	return sessionSnapshot({
		sessionManager: options.sessionManager,
		workspaceRoot: workspace.root,
		model,
		// The same merge `Agent.getApprovals` performs: the workspace's defaults with the session's own
		// recorded choices over them. Neither half is optional, or the header's toggles would show a
		// gate the live session does not have.
		approvals: { ...settingsManager.getApprovals(), ...recordedTools.approval },
		// Read off the registry *after* the replay, so the toggles match a live session's exactly.
		allTools: registry.all().map((tool) => tool.name),
		activeTools: registry.activeNames(),
		// Judged against this workspace's own settings, the same way the live session's getter does it:
		// a cold read and a live snapshot must agree here, or the panel would flip its "沿用全局" label
		// the moment a session went from open to merely read.
		...followsGlobalOf(options.sessionManager, settingsManager, registry),
		submitting: false,
		queued: 0,
		isRetrying: false,
		retryAttempt: 0,
		pendingApprovals: [],
	});
}

/**
 * Build one session: discover the workspace, the prompt, the tools, and the default model, then hand
 * the result to {@link Agent}.
 *
 * The resolution is {@link assemble}; this adds what only a live session has — the hooks, whose
 * handlers need the session they belong to, and the object itself.
 */
export async function openAgent(options: OpenAgentOptions): Promise<Agent> {
	const { workspace, settingsManager, model, registry, agentsMd, recordedTools } = await assemble(options);
	const hooks = createHooks();

	const config: AgentConfig = {
		workspace,
		sessionManager: options.sessionManager,
		models: options.models,
		...(options.api === undefined ? {} : { api: options.api }),
		settingsManager,
		tools: registry,
		hooks,
		...(recordedTools.approval === undefined ? {} : { approvalOverride: recordedTools.approval }),
		// Rebuilt whenever the active set or the approval set moves, so the prompt cannot promise tools
		// or approvals the session no longer has.
		systemPrompt: (toolNames, approvals) =>
			buildSystemPrompt({
				workspaceRoot: workspace.root,
				toolNames,
				// Every tool the map gates, not just the active ones: the map is the session's whole
				// choice, and a tool narrowed away is a tool the prompt should still say is gated rather
				// than one it silently drops.
				approvalTools: approvalToolsOf(approvals),
				agentsMd,
			}),
		model,
	};

	const session = new Agent(config);

	// The defaults, on the same surface the session hands back. Registered here rather than hard-coded
	// in the class so a host can add a handler after them and refine what they decided.
	//
	// `before_tool`: the approval gate. The session owns the pending-approval bookkeeping and the UI
	// that answers it; the hook only translates a denial into a block.
	hooks.on("before_tool", async ({ toolCallId, toolName, args }) => {
		const reason = await session.authorize(toolName, toolCallId, args);
		return reason === undefined ? undefined : { block: { reason } };
	});
	// `after_tool`: the output backstop. Every built-in tool bounds its own output; this catches the
	// tool that forgets. A result too large for the context is archived into the workspace whole and
	// the model is served its head and tail plus the archive's path, so nothing is lost that cannot be
	// read back; when the archive cannot be written, the hard clip in `boundToolContent` is the floor.
	hooks.on("after_tool", (event) => {
		const spilled = spillOversizedToolResult(workspace, session.id, event.toolName, event.toolCallId, event.content);
		const content = spilled ?? boundToolContent(event.content);
		return content === undefined ? undefined : { content };
	});

	// Assembly records nothing. A session that opens on another model or another level than the branch
	// last used has not *used* either yet: both reach the transcript in `recordSelection`, at the moment
	// the first request is built from them. That is what keeps a session opened and never spoken to
	// from growing entries, and it is the same rule the composer's choices follow.
	return session;
}

/** The ref a transcript's `model_change` entry recorded: the row name and the wire id it named. */
function recordedRefOf(model: { name: string; modelId: string } | undefined): string | undefined {
	return model === undefined ? undefined : `${model.name}/${model.modelId}`;
}

/**
 * The row this session opens on: what the caller named, else whatever the user entered first.
 *
 * There is no preferred default any more. The old list of known-good ids was a guess at which vendor
 * the user had a key for, and with rows the user types themselves the first one they wrote is a
 * better answer than any guess: it exists, and it is theirs.
 *
 * `undefined` means there are no rows at all, which the caller answers with the placeholder rather
 * than throwing: a session has to be buildable for the window to open far enough to say what is
 * missing, and an exception here would surface as a server that serves no session.
 */
function selectModel(models: ModelSource, ref: string | undefined): UserModel | undefined {
	const rows = models.list();
	if (ref !== undefined) {
		const row = resolveModelRef(rows, ref);
		if (row) return row;
	}
	return rows[0];
}
