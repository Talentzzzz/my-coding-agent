import type { Message } from "./llm/index.ts";
import type { Usage } from "./llm/index.ts";
import type { ModelConfig } from "./llm/index.ts";
import type { AgentSessionEvent } from "./agent.ts";
import type { AppearanceSettings, BashSettings, ModeSettings } from "./config.ts";
import type { BranchPoint } from "./session/session-manager.ts";
import type { QueueMode } from "./types.ts";

export type { Message } from "./llm/index.ts";
export type { AgentSessionEvent } from "./agent.ts";
export type { MessageDelta } from "./agent.ts";
export type { BranchOption, BranchPoint } from "./session/session-manager.ts";
export type { BashSettings, DirectoryPaging, ModeSettings } from "./config.ts";
// The compaction checkpoint crosses the wire inside snapshot `messages` as a user message wrapped
// in these tags, so the tags are wire facts: the client recognizes the summary by them.
export {
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	compactionSummaryOf,
} from "./session/messages.ts";

export interface SessionRef {
	id: string;
	/** The directory this session works in, absolute: the header recorded a resolved path. */
	workDirAbsPath: string;
	createdAt: number;
	title: string;
	/**
	 * The session this one was forked from, when that session is stored beside it.
	 *
	 * Absent for a root session, and for a fork whose parent is not in the same list — another
	 * directory's store, or a file moved by hand. A client draws a missing parent as a root rather
	 * than inventing a place for it.
	 */
	parentId?: string;
}

/**
 * One sidebar row: the stored identity plus the activity facts a listing adds.
 *
 * The last three fields are what separates this from {@link SessionRef}. `modified` was already
 * computed by the store for ordering and simply never sent. `running` has no stored form at all —
 * it is a fact about *this* process's loop, never about the transcript. `pending` is a ledger fact
 * with a stored cache: the snapshot's `suspended` marker lights a cold row as 1 (the count is not
 * stored), and a process with the session open overlays the exact count derived from the ledger.
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
 * The stored sessions of one directory, for the sidebar's groups.
 *
 * The groups come from the store rather than from the server's own root: one process is started in
 * one directory, but every directory this machine has ever run in has its sessions on disk beside it.
 */
export interface DirectoryGroup {
	workDirAbsPath: string;
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
	/** The wire id, which is also the field a submitted config names this row's model by. */
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	contextWindow: number;
	maxTokens: number;
	/**
	 * Every level a session on this row can be in, lowest first.
	 *
	 * The same four for every row — an effort is the one strength the wire carries — but reported
	 * rather than assumed, so the composer reads one shape whether the row is stored, planted locally
	 * or described by a session snapshot.
	 */
	thinkingLevels: string[];
	hasApiKey: boolean;
}

/**
 * One row as a client submits it.
 *
 * Every field is optional, and that is the entire difference from a {@link ModelConfig}: an omitted
 * field leaves whatever is stored in place, which is what makes a patch ("this row's key is new")
 * expressible at all — a whole config would have to repeat every fact the row already had. The shape
 * is derived rather than restated, so a field added to a config is a field a client can send, and one
 * that is not in this list (`api`, `input`, `cost`) is one it cannot.
 */
export type ModelInput = Partial<
	Pick<ModelConfig, "id" | "name" | "baseUrl" | "apiKey" | "contextWindow" | "maxTokens">
>;

/**
 * Which model answers a message, and how hard it is asked to think.
 *
 * It travels with the message rather than as a session command of its own, because neither half is
 * true until a request is made with it: a choice that was never used is not something that happened,
 * so it is not an entry in the transcript and not a config change. Absent fields leave that half as
 * the session already has it.
 */
export interface ModelSelection {
	/** The row's name — the identity the settings panel shows and the transcript records. */
	model?: string;
	thinkingLevel?: string;
}

/** What the settings panel reads and writes. */
export interface SettingsSnapshot {
	appearance: AppearanceSettings;
	/** The global default active tool set; absent means every tool the build knows. */
	tools?: string[];
	/**
	 * The user's modes, whole, in the order the picker lists them; absent means none were defined.
	 *
	 * The built-in default mode is deliberately not among them: it is the global defaults read live
	 * (ADR-0005), so the client assembles it from `tools` and `approval` rather than expecting a row.
	 */
	modes?: ModeSettings[];
	/**
	 * Directories the sidebar does not list, by absolute path; absent means none are put aside.
	 *
	 * Carried here rather than kept to the server because it is what the window has to know to draw the
	 * list it was sent: a directory missing from `GET /api/directories` for a reason no one can see
	 * would be a group that vanished with nothing to explain it.
	 */
	hiddenDirectories?: string[];
	/**
	 * The names the sidebar shows for directories, by absolute path; absent means every group wears
	 * the folder's own name.
	 *
	 * Carried beside `hiddenDirectories` and for the same reason: the window draws a group's heading,
	 * and the name it draws is not derivable from anything else the snapshot holds — it is a view the
	 * user typed, not a property of the directory.
	 */
	directoryNames?: Record<string, string>;
	approval: Record<string, boolean>;
	/** How long the `bash` tool lets one command run. */
	bash: BashSettings;
	model?: string;
	/** Whether the window already planted its built-in default row; see `Settings.defaultModelSeeded`. */
	defaultModelSeeded?: boolean;
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
 * A tool that changes a file answers with this in `ToolResult.details`, beside the text the
 * model reads: the text is written for a model, and this is written for the window. Both are the
 * same change, so the view never has to parse the text — and the tool's text stays short, which for
 * a whole-file `write` is the difference between naming the file and paying for it twice.
 *
 * It rides inside the engine's own `tool_execution_end` event, so the wire needed no member for it, and
 * the engine records the whole result — so the transcript keeps the report beside the tool's text. No
 * provider ever sees it: a request carries a tool result's content and only its content.
 */
export interface FileDiff {
	/** The file as the working directory displays it — relative when inside it, absolute otherwise. */
	relPath: string;
	lines: DiffLine[];
	added: number;
	removed: number;
	/** True when the file did not exist before, so every line is an addition. */
	created: boolean;
	/** Rows left out of `lines` because the change was longer than the report's bound. */
	omitted: number;
}

/**
 * One accepted-but-undrained user message, as the wire carries it.
 *
 * The queue lives in the process running the session and in nothing durable, so this light-weight
 * view — the text as sent, and the stamp it was given — is all a window can be told. It rides the
 * snapshot, the `status` frame, and the `queue_update` event, which are the three roads a queue
 * change can reach a client by.
 */
export interface QueuedPrompt {
	/** The message's text, as the sender wrote it. */
	text: string;
	/** When the message was stamped, in epoch milliseconds. */
	timestamp: number;
}

export interface SessionSnapshot {
	id: string;
	workDirAbsPath: string;
	createdAt: number;
	title: string;
	/** The row's name the session is on. */
	model: string;
	thinkingLevel: string;
	/** Thinking levels this model accepts, including "off". */
	thinkingLevels: string[];
	/** Tools that currently require approval, keyed by tool name. */
	approvals: Record<string, boolean>;
	/** Every tool the session registered, in registration order, for the header's tool toggles. */
	allTools: string[];
	/** Tools the model may call right now. */
	activeTools: string[];
	/**
	 * Whether the session's recorded tool set equals the current global default.
	 *
	 * The two maps ride one recorded choice, but a user may have moved only one of them, so each
	 * half is judged on its own. True for a session with no recorded choice at all: a session that
	 * never chose *is* on the global default. Equality is against the global value *now* — a session
	 * reset and then left behind by a later default change reports false, which is the honest answer.
	 */
	toolsFollowGlobal: boolean;
	/** The approval map's half of the same judgement. */
	approvalsFollowGlobal: boolean;
	messages: Message[];
	/**
	 * The entry id behind each message in `messages`, in the same order.
	 *
	 * A transcript that did not watch a message being written still needs to name the entry a fork
	 * starts from, so the session fills this from its session manager. The compaction summary has no
	 * message entry of its own.
	 */
	messageEntryIds: (string | null)[];
	/**
	 * Every place in this session's log where it carried on in more than one way.
	 *
	 * The entries have always been a tree, so a chain is one path through it; this is what a window
	 * needs to draw the rest of the tree and to move through it. All of it, not only the chain's —
	 * moving the leaf must not change the shape of the tree a window draws — and `options[].active`
	 * is the one field that answers "which of these is the chain I am on". Only the entry ids of the
	 * alternatives travel, not where they lead: those ids are written once, while a branch grows at
	 * its tip, so a remembered tip would be a place the conversation had already left.
	 */
	branchPoints: BranchPoint[];
	/** The session this one was forked from, if it is a fork; absent for a root session. */
	parentSession?: string;
	/** The entry the session is on: the tip of its chain, or null before the first entry. */
	leafId: string | null;
	/**
	 * The assistant message being written right now, when this process is running one.
	 *
	 * Only a live session can answer it — the store gains the message when it ends — and it exists so
	 * a window that attaches mid-run is not left waiting for the rest of a sentence whose beginning it
	 * never saw: the baseline draws these characters, and the deltas that follow append to them.
	 * Absent for a settled transcript and for every cold read.
	 */
	partial?: Message;
	submitting: boolean;
	/** User messages accepted mid-run that the run has not drained yet, as the window draws them. */
	queued: QueuedPrompt[];
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
	/** The approval entries that moved, keyed by tool name; keys left out keep the value in force. */
	approval?: Record<string, boolean>;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
};

/**
 * The tools the window's settings offer approval toggles for, in the order it offers them.
 *
 * The approval maps themselves are keyed by tool name, so they are not bound to this list: a
 * settings file or a session snapshot may name any tool, and the readers that report which tools
 * are gated iterate the map rather than this. The list is only the window's default offering —
 * the loadout this build ships, not a limit on what a map may carry.
 */
export const APPROVAL_TOOLS: readonly string[] = ["read", "write", "edit", "glob", "grep", "bash"];

/**
 * How many queued messages one drain point injects.
 *
 * The engine's own type, re-exported rather than restated: the wire and the queues answer the same
 * question, and a second declaration would be a second thing to keep in step with the first.
 */
export type { QueueMode } from "./types.ts";

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
	| { type: "status"; usage: UsageTotals; submitting: boolean; queued: QueuedPrompt[]; isRetrying: boolean; retryAttempt: number }
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
 * What a client may send. Four actions, no envelope — the frame is the protocol.
 *
 * Commands stay on REST. `open` / `cancel` are the subscription's two words; `wait` / `unwait` carry
 * the one fact a subscription deliberately does not carry (ADR-0001: watching keeps nothing alive) —
 * that this connection is still waiting for a run's result on the session, the send reference's
 * server-side signal (issue 13). It takes no hold: it does not keep a session running, it only
 * asks the eviction judgment to wait until the waiter has been answered. A frame that arrives with
 * an unknown `type` is dropped and logged rather than closing the connection: none of the four
 * actions can be abused into anything, and turning a stray frame into a dead page costs more than a
 * log line.
 */
export type ClientFrame =
	| { type: "open"; sessionId: string; window?: unknown }
	| { type: "cancel"; sessionId: string }
	| { type: "wait"; sessionId: string }
	| { type: "unwait"; sessionId: string };

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
