import type { AgentMessage } from "@my-agent/agent";
import type { Usage } from "@my-agent/ai";
import type { AgentSessionEvent } from "./agent.ts";
import type { AppearanceSettings, BashSettings } from "./config.ts";
import type { BranchPoint } from "./session/session-manager.ts";

export type { AgentSessionEvent } from "./agent.ts";
export type { BranchOption, BranchPoint } from "./session/session-manager.ts";
export type { BashSettings, WorkspacePaging } from "./config.ts";

export interface SessionRef {
	id: string;
	cwd: string;
	createdAt: number;
	title: string;
	/**
	 * The session this one was forked from, when that session is stored beside it.
	 *
	 * Absent for a root session, and for a fork whose parent is not in the same list — another
	 * workspace's directory, or a file moved by hand. A client draws a missing parent as a root rather
	 * than inventing a place for it.
	 */
	parentId?: string;
}

/**
 * One sidebar row: the stored identity plus the activity facts only a running process knows.
 *
 * The last three fields are what separates this from {@link SessionRef}. `modified` was already
 * computed by the store for ordering and simply never sent; `running` and `pending` have no stored
 * form at all, because they are facts about *this* process's loop rather than about the transcript.
 *
 * A field earns its place here only when it stays true with nothing subscribed to any content: a row
 * that freezes the moment nobody is watching is the exact failure this type exists to prevent. Token
 * counts deliberately do not qualify — they belong to the session's own stream, and lifting them here
 * would send every pane one column's numbers.
 */
export interface SessionRow extends SessionRef {
	/** Last activity: the newest timestamped user or assistant message, or `createdAt` if none. */
	modified: number;
	/** This process is running it right now. */
	running: boolean;
	/** Approvals waiting for an answer. */
	pending: number;
}

/**
 * The stored sessions of one workspace, for the sidebar's groups.
 *
 * The groups come from the store rather than from the server's own root: one process is bound to one
 * workspace, but every workspace this machine has ever run in has its sessions on disk beside it.
 */
export interface WorkspaceGroup {
	cwd: string;
	sessions: SessionRow[];
}

/**
 * One model the user entered, as a client sees it.
 *
 * The API key is deliberately absent — a client may add or replace one, but it is never sent one
 * back, so a key cannot leak through a page that merely renders the list. `hasApiKey` is what the
 * form shows instead, so "a key is stored" and "this row has no key" stay distinguishable.
 *
 * `name` is the row's identity, so it is both what the panel shows and what the client sends back to
 * name this row. `api` is reported for the transcript's sake and is always the same value: this app
 * speaks one transport, so it is a fact about the build rather than a field the form edits.
 */
export interface ModelOption {
	name: string;
	api: string;
	baseUrl: string;
	modelId: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	/**
	 * Every level a session on this row can be in, lowest first, "off" included when the model has it.
	 *
	 * Travelled with the row rather than derived by the client, which has no way to know what an
	 * endpoint takes: a composer that moves the model needs the new row's own list, and it needs it
	 * before the move reaches the server.
	 */
	thinkingLevels: string[];
	/** The level a session opened on this row starts at. */
	defaultThinkingLevel: string;
	hasApiKey: boolean;
}

/** One row as a client submits it. An omitted `apiKey` leaves whatever is stored in place. */
export interface ModelInput {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	modelId?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	defaultThinkingLevel?: string;
}

/**
 * Which model answers a message, and how hard it is asked to think.
 *
 * It travels with the message rather than as a session command of its own, because neither half is
 * true until a request is made with it: a choice that was never used is not something that happened,
 * so it is not an entry in the transcript and not a config change. Absent fields leave that half as
 * the session already has it.
 */
export interface ModelSelection {
	/** `<name>/<wire id>`, the ref the settings panel and the transcript both use. */
	model?: string;
	thinkingLevel?: string;
}

/** What the settings panel reads and writes. */
export interface SettingsSnapshot {
	appearance: AppearanceSettings;
	/** The global default active tool set; absent means every tool the build knows. */
	tools?: string[];
	approval: Record<ToolApprovalKey, boolean>;
	/** How long the `bash` tool lets one command run. */
	bash: BashSettings;
	model?: string;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Tokens of the most recent request's prompt, for the context meter. */
	contextTokens: number;
	contextWindow: number;
}

export interface PendingApproval {
	toolCallId: string;
	toolName: string;
	args: unknown;
	summary: string;
}

/**
 * One line of a file a tool changed.
 *
 * The numbers are the file's own: 1-based, in the old file and in the new one, so a window can show
 * where a change landed without reading anything back. A line only the old file has carries no new
 * number, and the other way round; a `skip` row stands for unchanged lines the report left out.
 */
export interface DiffLine {
	kind: "add" | "remove" | "context" | "skip";
	oldLine: number | null;
	newLine: number | null;
	text: string;
	/**
	 * The half-open range of `text` that changed, when one removed line and the added line that
	 * follows it are the same line rewritten. Absent when the line changed as a whole, where the
	 * row's own color already says everything the mark would.
	 */
	changed?: [number, number];
	/** Unchanged lines this `skip` row stands in for. */
	skipped?: number;
}

/**
 * What one tool call did to one file.
 *
 * A tool that changes a file answers with this in `AgentToolResult.details`, beside the text the
 * model reads: the text is written for a model, and this is written for the window. Both are the
 * same change, so the view never has to parse the text — and the tool's text stays short, which for
 * a whole-file `write` is the difference between naming the file and paying for it twice.
 *
 * It rides inside the loop's own `tool_execution_end` event, so the wire needed no member for it, and
 * the loop records the whole result — so the transcript keeps the report beside the tool's text. No
 * provider ever sees it: a request carries a tool result's content and only its content.
 */
export interface FileDiff {
	/** The file as the workspace displays it, the same path the tool's own text names. */
	path: string;
	lines: DiffLine[];
	added: number;
	removed: number;
	/** True when the file did not exist before, so every line is an addition. */
	created: boolean;
	/** Rows left out of `lines` because the change was longer than the report's bound. */
	omitted: number;
}

export interface SessionSnapshot {
	id: string;
	cwd: string;
	createdAt: number;
	title: string;
	model: string;
	thinkingLevel: string;
	/** Thinking levels this model accepts, including "off". */
	thinkingLevels: string[];
	/** Tools that currently require approval. */
	approvals: Record<ToolApprovalKey, boolean>;
	/** Every tool the session registered, in registration order, for the header's tool toggles. */
	allTools: string[];
	/** Tools the model may call right now. */
	activeTools: string[];
	/**
	 * Whether the branch's last recorded tool set equals the current global default.
	 *
	 * The two maps ride one `tool_config` entry, but a user may have moved only one of them, so each
	 * half is judged on its own. True for a branch with no entry at all: a session that never chose
	 * *is* on the global default. Equality is against the global value *now* — a session reset and
	 * then left behind by a later default change reports false, which is the honest answer.
	 */
	toolsFollowGlobal: boolean;
	/** The approval map's half of the same judgement. */
	approvalsFollowGlobal: boolean;
	messages: AgentMessage[];
	/**
	 * The entry id behind each message in `messages`, in the same order.
	 *
	 * A transcript that did not watch a message being written still needs to name the entry a fork
	 * starts from, so the session fills this from its session manager. The compaction summary has no
	 * message entry of its own.
	 */
	messageEntryIds: (string | null)[];
	/**
	 * Where the active chain carried on from a message in more than one way.
	 *
	 * The entries have always been a tree, so a chain is one path through it; this is what a window
	 * needs to draw the rest of the tree and to move through it. Only the entry ids of the alternatives
	 * travel, not where they lead: those ids are written once, while a branch grows at its tip, so a
	 * remembered tip would be a place the conversation had already left.
	 */
	branchPoints: BranchPoint[];
	/** The session this one was forked from, if it is a fork; absent for a root session. */
	parentSession?: string;
	/** The entry the session is on: the tip of its chain, or null before the first entry. */
	leafId: string | null;
	submitting: boolean;
	/** User messages accepted mid-run that the loop has not drained yet. */
	queued: number;
	/** True while a transient provider failure is waiting out its backoff. */
	isRetrying: boolean;
	/** The 1-based retry attempt in flight, or 0 when no retry is pending. */
	retryAttempt: number;
	usage: UsageTotals;
	pendingApprovals: PendingApproval[];
}

/**
 * A change to what the session holds without a message: the approval map and the two queue modes.
 *
 * The model and the thinking level are deliberately absent. Both are chosen in the composer and both
 * arrive with the message they belong to ({@link ModelSelection}), because recording one that no
 * request was made with would put a decision in the transcript that never took effect.
 */
export type ConfigPatch = {
	approval?: Partial<Record<ToolApprovalKey, boolean>>;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
};

export type ToolApprovalKey = "read" | "write" | "edit" | "glob" | "grep" | "bash";

/**
 * Every tool an approval key can name, in the order the window offers them.
 *
 * The map is keyed by *tool*, not by the tools a session happens to have active, so the set of keys is
 * the loadout's and not the session's: a prompt that says which tools are gated, or a settings file
 * that is normalised on write, iterates this rather than the active names.
 */
export const APPROVAL_TOOLS: readonly ToolApprovalKey[] = ["read", "write", "edit", "glob", "grep", "bash"];

/** How many queued messages one drain point injects. Mirrors pi-agent-core's `QueueMode`. */
export type QueueMode = "all" | "one-at-a-time";

/** What a message sent while the agent is streaming does to the run. */
export type PromptBehavior = "steer" | "followUp";

export type ServerMessage =
	/**
	 * Everything this session looks like right now.
	 *
	 * The first frame on a logical stream, and the only one of its kind: a subscription that is opened
	 * again gets a new one rather than an append, which is what makes recovery converge on "what this
	 * looks like now" instead of on "what I missed".
	 */
	| { type: "baseline"; session: SessionSnapshot }
	| { type: "event"; event: AgentSessionEvent }
	/**
	 * The entry behind a message the session just wrote.
	 *
	 * `entry_appended` names an entry but not the message it holds, and a transcript needs the pairing
	 * to offer "fork from here" on a message that never appeared in a snapshot. It is sent beside the
	 * event, not instead of it, so a client that ignores this frame behaves exactly as before.
	 */
	| { type: "entry"; entryId: string; messageTimestamp?: number }
	| { type: "approval_request"; request: PendingApproval }
	| { type: "approval_settled"; toolCallId: string; approved: boolean }
	| { type: "status"; usage: UsageTotals; submitting: boolean; queued: number; isRetrying: boolean; retryAttempt: number }
	/**
	 * Something failed outside any request's reach.
	 *
	 * A run that could not start, mainly: the request that accepted its prompt was answered 202 long
	 * before the failure, so this stream is the only place left to say so.
	 */
	| { type: "error"; message: string };

/**
 * One logical stream's identity on one connection: the session id itself.
 *
 * A session has at most one logical stream per connection, so the id is the whole address — there is
 * no separate subscription handle to keep in sync with it. `null` is the one reserved seat for
 * payloads that belong to the connection rather than to any stream.
 */
export type StreamId = string;

/**
 * A failure attributed to one logical stream (or to the connection itself).
 *
 * Not a terminal frame: the stream stays open, and what the client does next depends on whether the
 * stream ever carried a baseline rather than on why it failed.
 */
export interface StreamFailure {
	/** For a person to read — today the one string `announce(sessionId, message)` carries. */
	message: string;
}

/**
 * Payloads that ride the connection-level seat, `streamId: null`.
 *
 * They are a separate union rather than more `ServerMessage` members because every one of them names
 * no session: a heartbeat is about the channel, and a row is about the whole machine. A client routes
 * by `streamId` first, so everything here lands on the store that belongs to no column.
 */
export type ConnectionItem =
	/** How often the server emits this, so the client can size its own read timeout. */
	| { type: "heartbeat"; everyMs: number }
	/** Every row this process knows, once per connection. A replacement, not an append. */
	| { type: "sessions"; sessions: SessionRow[] }
	/** One row changed. The whole row, because a row is small and idempotent beats a diff here. */
	| { type: "session_row"; session: SessionRow }
	/**
	 * One row went away: the session behind it was deleted. The id is the whole payload, because
	 * dropping is the only thing a client can do with it — there is no state left to describe.
	 */
	| { type: "session_gone"; sessionId: string };

/**
 * One logical stream's frame: its content, its end, or a failure attributed to it.
 *
 * Three shapes at one level, told apart by field name rather than by a discriminant — `item` carries
 * its own `type`, so an outer `type` would say the same thing twice and make "outer and inner
 * disagree" a representable state.
 *
 * `item` holds only {@link ServerMessage}: the connection-level payloads belong to no session, and
 * letting one ride a column's `streamId` would make "which session is this for" answerable two ways.
 */
export type StreamFrame =
	| { item: ServerMessage }
	| { end: true }
	| { error: StreamFailure };

/**
 * The connection's own frame: a payload belonging to no session, or the failure of the connection.
 *
 * A separate type from {@link StreamFrame} rather than a wider `item` on it, because the two travel on
 * different keys and a client routes them differently: one to a column, the other to the store behind
 * all of them.
 */
export type ConnectionFrame =
	| { item: ConnectionItem }
	| { error: StreamFailure };

/**
 * One WebSocket message: an envelope around a frame, told apart by which key carries the id.
 *
 * `streamId` is the session id when the frame belongs to one logical stream and `null` when it belongs
 * to the connection, so the pair of types makes "a connection-level payload on a session's stream" and
 * the reverse unrepresentable rather than merely discouraged.
 *
 * The envelope is deliberately outside {@link ServerMessage} rather than a field inside each of its
 * members: several callers construct protocol messages with no stream behind them at all (a REST read,
 * a fork), and inlining the id would force them to invent one.
 */
export type ServerFrame =
	| ({ streamId: StreamId } & StreamFrame)
	| ({ streamId: null } & ConnectionFrame);

/**
 * What a client may send. Two actions, no envelope — the frame is the protocol.
 *
 * Commands stay on REST. A frame that arrives with an unknown `type` is dropped and logged rather
 * than closing the connection: the only two actions here cannot be abused into anything, and turning
 * a stray frame into a dead page costs more than a log line.
 */
export type ClientFrame =
	| { type: "open"; sessionId: string; window?: unknown }
	| { type: "cancel"; sessionId: string };

export const EMPTY_USAGE: UsageTotals = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	contextWindow: 0,
};

/** Fold one assistant message's usage into the session totals. */
export function addUsage(totals: UsageTotals, usage: Usage, contextWindow: number): UsageTotals {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return {
		input: totals.input + usage.input,
		output: totals.output + usage.output,
		cacheRead: totals.cacheRead + usage.cacheRead,
		cacheWrite: totals.cacheWrite + usage.cacheWrite,
		cost: totals.cost + usage.cost.total,
		contextTokens: promptTokens + usage.output,
		contextWindow,
	};
}
