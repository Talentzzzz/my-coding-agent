import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "@my-agent/llm";
import { type Usage, uuidv7 } from "@my-agent/llm";
import { APP_NAME } from "../config.ts";
import { trimToolCallArgs } from "../context/trim-tool-call-args.ts";
import { clearToolResult } from "../context/clear-tool-results.ts";
import type { SessionRef, SessionRow, ToolApprovalKey } from "../protocol.ts";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX, compactionSummaryOf } from "./messages.ts";
import { normalizePath, resolvePath, sessionPath, sessionsDir, workspaceDir } from "./paths.ts";

/**
 * The on-disk shape this build writes.
 *
 * pi numbers its session format, and the number is kept so a file says which generation wrote it:
 * 1 is flat records with no ids, 2 gave every entry `id`/`parentId` so the file became a tree, 3
 * renamed the `hookMessage` role to `custom`, and 4 renamed the header's discriminator to
 * `"SessionHeader"`. Only 4 is produced here, and the entry kinds this build knows are the ones in
 * {@link SessionEntry}.
 *
 * There is deliberately no migration. A file from an older build is refused when it cannot be read as
 * one of ours and left exactly as it is otherwise, because rewriting a session this code does not
 * understand is the one way to lose one. A v3 file is refused for that reason: its header says
 * `"session"`, and nothing here reads that word.
 */
export const CURRENT_SESSION_VERSION = 4;

export interface SessionHeader {
	type: "SessionHeader";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	/**
	 * The session file this one was forked from or delegated by.
	 *
	 * An absolute path, not an id, because a fork is traceable to the file it copied, and the file is
	 * what a reader has in hand. Absolute because a listing compares paths: a relative one would be
	 * resolved against whatever directory the process happens to be in. The copied entries keep their
	 * original ids on top of that.
	 */
	parentSession?: string;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
	type: "message";
	message: Message;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

/**
 * The row this session switched to, recorded as the name it carries.
 *
 * `name` is the row's identity — see `ModelConfig` — so this entry is what later turns "which model was
 * this session on" back into a row. `provider` is the field this build wrote before a name was the
 * identity: it held the row's slug. Files are never rewritten, so it is still read, which is what keeps
 * an upgrade from silently dropping the model a transcript recorded. The two are not both written: a
 * new entry carries `name` alone.
 */
export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	name: string;
	modelId: string;
}

/** The row name a stored `model_change` entry names, whether this build or its predecessor wrote it. */
function modelChangeName(entry: { name?: string; provider?: string }): string | undefined {
	return entry.name ?? entry.provider;
}

export interface CompactionEntry extends SessionEntryBase {
	type: "compaction";
	summary: string;
	/** The first entry the model still sees; everything before it was folded into `summary`. */
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Usage from the call that generated the summary, when it is known. */
	usage?: Usage;
}

/**
 * A record of tool results this build cleared out of the view.
 *
 * The results stay in the file — this format never rewrites a line — so the record names them instead
 * and {@link buildContextEntries} applies it. That is the same shape as a compaction: an entry that
 * changes what earlier entries mean rather than changing them, which is what keeps the file a full
 * record and the transcript a view of it.
 */
export interface ClearToolResultEntry extends SessionEntryBase {
	type: "clear_tool_result";
	/** The entries whose results this record cleared: still in the file, no longer in the view. */
	clearedEntryIds: string[];
	/** The estimated prompt size before the clear, so the record says what it was worth. */
	tokensBefore: number;
}

/**
 * A record of tool-call arguments this build shortened in the view.
 *
 * Same shape of decision as a clear: the arguments stay whole in the file — this format never
 * rewrites a line — and the record names the message entries whose recorded arguments are shortened,
 * which {@link buildContextEntries} applies. The heavy bodies a `write` or an `edit` carried live in
 * the file they changed; the view keeps only enough of them to say what was written where.
 */
export interface TrimToolCallArgEntry extends SessionEntryBase {
	type: "trim_tool_call_arg";
	/** The message entries whose recorded tool-call arguments this record shortened. */
	trimmedEntryIds: string[];
	/** The estimated prompt size before the trim, so the record says what it was worth. */
	tokensBefore: number;
}

/**
 * A record of the session's own tool choices: which tools are active and which of them ask for
 * approval.
 *
 * Both maps travel whole — a snapshot, not a delta — because the session file is append-only, so the
 * latest entry is the state and every earlier one is history. The settings files keep their approval
 * set as the default a new session opens on; this entry is where a session that chose differently
 * keeps its own. Nothing here reaches the provider: the request is rebuilt from the live registry
 * every turn, and this entry only restores the registry's state on reopen.
 */
export interface ToolConfigEntry extends SessionEntryBase {
	type: "tool_config";
	/** The complete active tool set as of this change, in registration order. */
	activeTools: string[];
	/** The complete approval map as of this change, keyed like the settings file's `approval`. */
	approval: Record<ToolApprovalKey, boolean>;
}

/**
 * A record of where the conversation moved: the position {@link SessionManager.branch} or
 * {@link SessionManager.resetLeaf} left the leaf at, written when the position actually moved.
 *
 * Appends push the leaf along and need no record — the file's last entry is the position — so this
 * entry is the one exception, and it is what lets a move outlive the process that made it. Like
 * every state entry it is not transcript: it reaches no message, and a fresh reader replays it to
 * put the leaf back where the conversation went.
 */
export interface LeafEntry extends SessionEntryBase {
	type: "leaf";
	/** The position the conversation moved to: an entry id, or null for "before the first entry". */
	leafId: string | null;
}

/**
 * A record that the conversation was given a name of its own.
 *
 * The derived title — the first user message on the branch — stays the fallback, and this entry is
 * what a person's own choice writes over it. The title here is the clean name, already shortened at
 * the write; a fork's `（N）` suffix is a rendering fact and is never stored. Read in file order,
 * last one wins, regardless of which way the branch points — see ADR-0002 for why a rename is a fact
 * about the session rather than about one way through it.
 */
export interface RenameEntry extends SessionEntryBase {
	type: "rename";
	/** The name the conversation was given, shortened the same way a derived title is. */
	title: string;
}

/**
 * A record of model spend that owns no message entry: usage the loop never attached to an assistant
 * message in this transcript.
 *
 * Delegation is the case that forces the kind into existence — a SubAgent runs on its own transcript,
 * so its spend has no assistant message here to ride on — and `operation` names the spend the way a
 * reader would ask about it, `"subagent"` today. A usage entry is money, not conversation: it reaches
 * no message, and it is counted in file order across every branch, because tokens burned on an
 * abandoned way through the tree were burned all the same. An unknown `operation` is read as ordinary
 * usage rather than rejected — the same forward-compatibility rule the file's unknown kinds follow.
 */
export interface UsageEntry extends SessionEntryBase {
	type: "usage";
	/** What the spend is attributed to: `"subagent"` for a delegation's child, for a start. */
	operation: string;
	/** The model row the spend ran on, as its name. */
	model: string;
	usage: Usage;
}

export type SessionEntry =
	| MessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| ClearToolResultEntry
	| TrimToolCallArgEntry
	| ToolConfigEntry
	| LeafEntry
	| RenameEntry
	| UsageEntry;

/**
 * The entries of one transcript, keyed by their own id.
 *
 * An entry carries only `parentId`, so every walk up the tree — {@link buildSessionPath}, a branch
 * preview, the id a caller names — is a lookup by id. This map is that lookup, and it is also what
 * makes `generateId` collision-free. Iteration order is file order: it is filled by replaying the
 * JSONL in sequence, and appended to in the same order, so "the last line wins" needs no sort.
 */
type SessionEntryMapById = Map<string, SessionEntry>;

/**
 * One line of the session's JSONL file, header included.
 *
 * The line is the unit: the header and every entry share nothing but the fact that each occupies one
 * line, which is why this is a union and not a base type — see {@link SessionHeader}.
 */
export type JsonlEntry = SessionHeader | SessionEntry;

/**
 * Whether one line of a session file is its header rather than an entry.
 *
 * `JsonlEntry` is a union, so a reader holds a value that is either one. The header's discriminator
 * is its own type name, which is the one place this format departs from the `MessageEntry` /
 * `"message"` rule: a header is not a kind of entry, and naming it `"session"` made
 * `entry.type === "session"` read like a statement about the entry beside it.
 *
 * The check lives here rather than in the dozen places that step over the header, so the literal
 * appears once on the read side.
 */
function isSessionHeader(entry: JsonlEntry): entry is SessionHeader {
	return entry.type === "SessionHeader";
}

export interface SessionContext {
	messages: Message[];
	thinkingLevel: string;
	model: { name: string; modelId: string } | null;
}

export interface SessionInfo {
	/** The session file, absolute. */
	absPath: string;
	id: string;
	/** Working directory the session was started in, absolute. Empty for a file whose header has none. */
	absCwd: string;
	/** The absolute path of the file this session was forked from, if the header names one. */
	absParentSessionPath?: string;
	/**
	 * Id of the session this one was forked from, when that session is in the same directory.
	 *
	 * Not read from the file: the header names the parent's path, and its id is only knowable where
	 * both ends of the fork are listed at once. See {@link linkForkParents}.
	 */
	parentId?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	/**
	 * The conversation's name, derived exactly as a live session derives it.
	 *
	 * One derivation for a row's title, whether or not this process is running it: the first user
	 * message with text on the active branch, shortened to 72 characters. It is not the file's first
	 * user message — that one is `firstMessage`, and the two differ once the leaf has moved, so reading
	 * a title that changes when a host is reaped would be a visible flicker for no reason.
	 */
	title: string;
	firstMessage: string;
	allMessagesText: string;
}

/**
 * One alternative continuation of a branch point.
 *
 * `entryId` is the one stable thing here: it is a child of the branch point, written once. The tip the
 * choice leads to is deliberately absent — a branch grows at its tip, so a remembered tip would be a
 * stale pointer the moment that branch was continued, and a window holding one would rewind to a place
 * the conversation had already left. The server descends from `entryId` when the choice is made.
 */
export interface BranchOption {
	/** The entry this alternative begins at: a child of the branch point. */
	entryId: string;
	/** One line of the first message below it, for the switcher's label. */
	label: string;
	/** True for the alternative the active chain leads through. */
	active: boolean;
}

/**
 * A message the conversation carried on from in more than one way.
 *
 * The entry tree has always had these — an entry may have any number of children — and this is the
 * shape of one a window can draw: the entry to hang a switcher on, and the continuations to choose
 * between, in the order they were written. Every point in the log is reported, not only the ones the
 * active chain runs through: a fork below a way nobody is reading is still a fork, and a page whose
 * tree changed shape because the leaf moved would be answering "where can I go back to" with a
 * different conversation.
 */
export interface BranchPoint {
	/** The entry the alternatives hang off. */
	entryId: string;
	/**
	 * The entry to hang the alternatives' cards under, as the window draws them.
	 *
	 * A page places cards by entry: a user message on the line, or an alternative some earlier point
	 * already drew. This is the nearest such entry at or above the point — for a point on the chain
	 * that is the user message it answers, and for one below a way nobody is reading it is that way's
	 * own card, so the descent stays in the column the way is in. Always the point's own id or an
	 * ancestor's, never an entry beside it.
	 */
	anchor: string;
	/**
	 * One line of the user message at or above the point: the question the point's message answers,
	 * or the point's own text when the point is a user's.
	 *
	 * A branch taken from an assistant answer has no user text of its own to name it by, and the
	 * answer is not what a card says — a card named by its answer would read as prose the tree does not
	 * carry — so the question is the line an option with no text of its own falls back to. Empty only
	 * for a conversation that opens with an assistant.
	 */
	prompt: string;
	options: BranchOption[];
}

/**
 * One user message in the session, as the branch page draws it.
 *
 * The page is a line of **questions**, not a list of forks: what a person recognises as a place they
 * can go back to is the thing they asked. So this is folded from the whole entry tree rather than the
 * active chain — a question whose way was left behind is still a question, and it is exactly the card
 * a reader is looking for after a rewind took the rest of the line out of the transcript.
 *
 * `parentId` is the nearest user message **above** it, not the entry's own parent: the entries between
 * two questions are one round's work, and a card hangs off the question that opened the round before.
 */
export interface UserWay {
	/** The user message entry: the card's identity, and the id a move names. */
	entryId: string;
	/** The user message this one follows on its own way; null for the first question of a line. */
	parentId: string | null;
	/** One line of what was asked. */
	label: string;
	/**
	 * Where a press on the card lands: the last message of the round this question opened.
	 *
	 * Only when that message is an assistant's, because the point of landing there is that the next
	 * prompt is typed **after** an answer rather than in place of one. A round that stopped mid-tool
	 * has no answer to keep, so its card lands on the question itself.
	 */
	landingId: string;
	/** True when this message sits on the chain the leaf is on. */
	active: boolean;
}

/** One workspace the sidebar groups under, and the sessions stored for it. */
export interface WorkspaceSessions {
	absCwd: string;
	sessions: SessionRow[];
}

function createSessionId(): string {
	return uuidv7();
}

/** A short entry id no entry in the map already uses. */
function generateId(sessionEntryMapById: { has(id: string): boolean }): string {
	for (let attempt = 0; attempt < 100; attempt++) {
		const id = randomUUID().slice(0, 8);
		if (!sessionEntryMapById.has(id)) return id;
	}
	return randomUUID();
}

/** Index a list of entries by id. Only readers that do not own a `SessionManager` need this. */
function buildEntryIndex(entries: SessionEntry[]): SessionEntryMapById {
	const index: SessionEntryMapById = new Map();
	for (const entry of entries) index.set(entry.id, entry);
	return index;
}

/**
 * The last entry in file order.
 *
 * The map is filled by replaying the file, and appended to in the same order, so its last value is
 * the last line. That is why a fallback can be a walk of the map rather than a copy of the entry
 * list — nothing is allocated, and the cost is only paid when the caller named no position.
 */
function lastEntryOf(sessionEntryMapById: SessionEntryMapById): SessionEntry | undefined {
	let last: SessionEntry | undefined;
	for (const entry of sessionEntryMapById.values()) last = entry;
	return last;
}

/**
 * The chain from the root to `leafId`, parent links followed, inclusive.
 *
 * `leafId` defaults to the last entry, and `null` means "before the first entry" and yields an empty
 * chain. An id no entry has falls back to the same default as a missing one, which is what lets a
 * caller walk the whole log without naming an entry.
 */
function buildSessionPath(sessionEntryMapById: SessionEntryMapById, leafId?: string | null): SessionEntry[] {
	if (leafId === null) return [];
	let leaf: SessionEntry | undefined;
	if (leafId) leaf = sessionEntryMapById.get(leafId);
	leaf ??= lastEntryOf(sessionEntryMapById);
	if (!leaf) return [];

	const chain: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		chain.push(current);
		current = current.parentId ? sessionEntryMapById.get(current.parentId) : undefined;
	}
	chain.reverse();
	return chain;
}

/** The model and thinking level the branch was last set to, read from the entries that recorded it. */
function getSessionContextSettings(chain: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
	let thinkingLevel = "off";
	let model: { name: string; modelId: string } | null = null;

	for (const entry of chain) {
		if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
		else if (entry.type === "model_change") {
			const name = modelChangeName(entry);
			if (name !== undefined) model = { name, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			// A message carries the wire id it was answered by, never the row's identity: the identity
			// only ever lived on the `model_change` entries this build writes. So this is the fallback
			// for a transcript that recorded no change, and the name it reports is the wire id — which is
			// what the row it came from would be called if the user never named it.
			model = { name: entry.message.model, modelId: entry.message.model };
		}
	}

	return { thinkingLevel, model };
}

/**
 * Project one selected entry into the messages the model sees.
 *
 * A compaction entry stands for everything it replaced: the summary alone, projected as the user
 * turn it stands for and wrapped in the tags `compactionSummaryOf` recognizes — a user message is
 * what the provider is sent, so that is the shape the transcript carries. Every other entry kind is
 * state, not conversation, and contributes nothing. The prompt is not among them: it is rebuilt from
 * settings and the live tool set on every request, so no entry has to carry it.
 */
export function sessionEntryToContextMessages(entry: SessionEntry): Message[] {
	if (entry.type === "message") {
		const message = entry.message;
		// Session files are parsed without validation, so a hand-edited or older file can hold a
		// message with null or missing content. Repair it rather than handing the provider a shape it
		// cannot read.
		if (message.role === "system" && message.content == null) return [{ ...message, content: "" }];
		if (
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
			message.content == null
		) {
			return [{ ...message, content: [] }];
		}
		return [message];
	}
	if (entry.type === "compaction") {
		const summary: Message = {
			role: "user",
			content: [
				{
					type: "text",
					text: `${COMPACTION_SUMMARY_PREFIX}${entry.summary}${COMPACTION_SUMMARY_SUFFIX}`,
				},
			],
			timestamp: new Date(entry.timestamp).getTime(),
		};
		return [summary];
	}
	return [];
}

/**
 * The entries that make up the current context, following the branch from the root to the leaf.
 *
 * Three decisions recorded as entries are applied here, and they are the only things that make this
 * differ from the raw branch: a compaction entry is a checkpoint — the newest one on the branch is
 * kept, the entries before the one it names are dropped, and everything from `firstKeptEntryId` on is
 * kept — a `clear_tool_result` entry names tool results whose text is cleared, and a `trim_tool_call_arg` entry names
 * assistant messages whose recorded tool-call arguments are shortened. Older compactions that happen
 * to fall inside the retained range are retained too; the newest one is what contributes the summary.
 *
 * Applying all three here is what keeps the request, the snapshot, and a resumed process on one
 * transcript: the file keeps every line, and every reader derives the same view from it.
 *
 * Deliberately module-private. It takes the store's own map and leaf, and a caller rebuilding those
 * from outside would have to reproduce `buildIndex`'s rules for the header and for a `leaf` record —
 * rules nothing in this signature promises. The way to read a transcript is `SessionManager`.
 */
function buildContextEntries(
	sessionEntryMapById: SessionEntryMapById,
	leafId?: string | null,
): SessionEntry[] {
	return contextEntriesFromPath(buildSessionPath(sessionEntryMapById, leafId));
}

/** The three view decisions applied to one path, in the order compaction, trim, clear. */
function contextEntriesFromPath(chain: SessionEntry[]): SessionEntry[] {
	return applyClears(
		applyTrims(contextEntriesFrom(chain), trimmedEntryIds(chain)),
		clearedEntryIds(chain),
	);
}

/** The branch with its newest checkpoint applied: the checkpoint itself, then everything it kept. */
function contextEntriesFrom(chain: SessionEntry[]): SessionEntry[] {
	let compaction: CompactionEntry | null = null;
	for (const entry of chain) {
		if (entry.type === "compaction") compaction = entry;
	}
	if (!compaction) return chain;

	const compactionIndex = chain.findIndex((entry) => entry.id === compaction.id);
	if (compactionIndex < 0) return chain;

	const contextEntries: SessionEntry[] = [compaction];
	let foundFirstKept = false;
	for (let index = 0; index < compactionIndex; index++) {
		const entry = chain[index]!;
		if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
		if (foundFirstKept) {
			contextEntries.push(entry);
		}
	}
	contextEntries.push(...chain.slice(compactionIndex + 1));
	return contextEntries;
}

/** Every entry id a `clear_tool_result` record on this branch cleared. Read from the branch, not from the view. */
function clearedEntryIds(chain: SessionEntry[]): Set<string> {
	const cleared = new Set<string>();
	for (const entry of chain) {
		if (entry.type !== "clear_tool_result") continue;
		for (const id of entry.clearedEntryIds) cleared.add(id);
	}
	return cleared;
}

/** The view, with the results a clear record named emptied in place. */
function applyClears(entries: SessionEntry[], cleared: ReadonlySet<string>): SessionEntry[] {
	if (cleared.size === 0) return entries;
	return entries.map((entry) => (cleared.has(entry.id) ? clearToolResult(entry) : entry));
}

/** Every entry id a `trim_tool_call_arg` record on this branch named. Read from the branch, not from the view. */
function trimmedEntryIds(chain: SessionEntry[]): Set<string> {
	const trimmed = new Set<string>();
	for (const entry of chain) {
		if (entry.type !== "trim_tool_call_arg") continue;
		for (const id of entry.trimmedEntryIds) trimmed.add(id);
	}
	return trimmed;
}

/** The view, with the recorded arguments a trim record named shortened in place. */
function applyTrims(entries: SessionEntry[], trimmed: ReadonlySet<string>): SessionEntry[] {
	if (trimmed.size === 0) return entries;
	return entries.map((entry) => (trimmed.has(entry.id) ? trimToolCallArgs(entry) : entry));
}

/**
 * Build the transcript the model is sent, from a branch of the entries.
 *
 * This is the one function that turns storage into a request, and it is why a resumed session and a
 * live one cannot drift: both go through here. The path is walked once and shared by the settings
 * read and the view, so asking for both costs one walk rather than two.
 *
 * Module-private for the reason {@link buildContextEntries} records; `SessionManager.buildSessionContext`
 * is the entry point.
 */
function buildSessionContext(
	sessionEntryMapById: SessionEntryMapById,
	leafId?: string | null,
): SessionContext {
	const chain = buildSessionPath(sessionEntryMapById, leafId);
	const { thinkingLevel, model } = getSessionContextSettings(chain);
	const messages = contextEntriesFromPath(chain).flatMap(sessionEntryToContextMessages);
	return { messages, thinkingLevel, model };
}

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
const SESSION_HEADER_READ_BUFFER_SIZE = 4096;
/**
 * The ceiling on the header line. The header is line one by construction, so this bounds the one
 * field that can grow without limit — the workspace path — and refuses a file that is not a session.
 */
const MAX_SESSION_HEADER_BYTES = 1024 * 1024;

/**
 * The wire kinds earlier builds wrote for the two view-shrink records, under their old names.
 *
 * Files are never rewritten, so an older session still carries `prune` and `argtrim` lines; the
 * parser maps them to the current kinds so their recorded view edits keep applying. Write side is
 * the current names only.
 */
const LEGACY_ENTRY_KINDS: Readonly<Record<string, string>> = {
	prune: "clear_tool_result",
	argtrim: "trim_tool_call_arg",
};

function parseJsonlLine(line: string): JsonlEntry | null {
	if (!line.trim()) return null;
	try {
		const entry = JSON.parse(line) as JsonlEntry;
		const currentKind = LEGACY_ENTRY_KINDS[entry.type];
		return currentKind ? ({ ...entry, type: currentKind } as JsonlEntry) : entry;
	} catch {
		// One unreadable line must not make the rest of a session unreadable.
		return null;
	}
}

/** Read a session file whole. `absFilePath` is already resolved by the caller. */
function loadJsonlEntries(absFilePath: string): JsonlEntry[] {
	if (!existsSync(absFilePath)) return [];

	const entries: JsonlEntry[] = [];
	let pending = "";
	const fd = openSync(absFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);

		for (;;) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const entry = parseJsonlLine(pending.slice(lineStart, newlineIndex));
				if (entry) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		const finalEntry = parseJsonlLine(pending);
		if (finalEntry) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}

	// A file with no header is not a session; refuse it rather than adopting its lines.
	if (entries.length === 0) return entries;
	const header = entries[0]!;
	if (!isSessionHeader(header) || typeof (header as { id?: unknown }).id !== "string") return [];

	// A final line without a trailing newline would otherwise be extended by the next append.
	if (pending) appendFileSync(absFilePath, "\n");
	return entries;
}

/**
 * Read the session header: line one, and nothing else.
 *
 * Every writer in this tree puts the header on the first line, so this reads until the first newline
 * and stops — it never searches for a header further down. The chunked read is about the line's
 * length, not about scanning: a header carries the workspace path, which has no size limit of its
 * own, so no single buffer can be assumed to cover it. A file whose first line is not a header
 * throws, because guessing at a repair is worse than refusing the file.
 */
function readSessionHeader(absFilePath: string): SessionHeader {
	const fd = openSync(absFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
		const lineChunks: string[] = [];
		let scannedBytes = 0;

		for (;;) {
			const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_BYTES - scannedBytes);
			if (readLength <= 0) {
				throw new Error(`Session header exceeds ${MAX_SESSION_HEADER_BYTES} bytes: ${absFilePath}`);
			}
			const bytesRead = readSync(fd, buffer, 0, readLength, null);
			if (bytesRead === 0) {
				lineChunks.push(decoder.end());
				break;
			}
			scannedBytes += bytesRead;

			const chunk = decoder.write(buffer.subarray(0, bytesRead));
			const newlineIndex = chunk.indexOf("\n");
			if (newlineIndex === -1) {
				lineChunks.push(chunk);
				continue;
			}
			lineChunks.push(chunk.slice(0, newlineIndex));
			break;
		}

		return parseSessionHeaderLine(lineChunks.join(""), absFilePath);
	} finally {
		closeSync(fd);
	}
}

/** Parse the header line, or refuse the file: a first line that is not a header is not a session. */
function parseSessionHeaderLine(line: string, absFilePath: string): SessionHeader {
	const entry = parseJsonlLine(line);
	if (entry === null || !isSessionHeader(entry) || typeof (entry as { id?: unknown }).id !== "string") {
		throw new Error(`Session file is not a valid ${APP_NAME} session: ${absFilePath}`);
	}
	return entry;
}

function readSessionHeaderForDiscovery(absFilePath: string): SessionHeader | null {
	try {
		return readSessionHeader(absFilePath);
	} catch {
		// Discovery is best-effort: one unreadable or oversized file must not hide the other sessions.
		return null;
	}
}

function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const headerCwd = (header as { cwd?: unknown }).cwd;
	return typeof headerCwd === "string" ? headerCwd : undefined;
}

function sessionCwdMatches(headerCwd: string | undefined, absCwd: string): boolean {
	return headerCwd !== undefined && headerCwd !== "" && resolvePath(headerCwd) === absCwd;
}

/** The newest session file in `absDir`, preferring one whose header names the workspace `absCwd` when it is given. */
function findMostRecentSession(absDir: string, absCwd?: string): string | null {
	const absCwdResolved = absCwd ? resolvePath(absCwd) : undefined;
	try {
		const files = readdirSync(absDir)
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => join(absDir, file))
			.map((absPath) => ({ absPath, mtime: statSync(absPath).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);

		for (const { absPath } of files) {
			const header = readSessionHeaderForDiscovery(absPath);
			if (header === null) continue;
			if (absCwdResolved !== undefined && !sessionCwdMatches(getSessionHeaderCwd(header), absCwdResolved)) continue;
			// A header with nothing after it is a creation nobody spoke in — only a file written before
			// sessions deferred that write can look like this. Resuming it would open an empty
			// conversation while the sidebar, which filters the same way, shows real ones.
			if (!hasMessageEntry(absPath)) continue;
			return absPath;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Whether a session file holds a message, which is what makes it a conversation rather than a header
 * a creation left behind. Stops at the first one: the header is line one and the first message follows
 * it closely, so this is a read of a few hundred bytes for every file that matters.
 */
function hasMessageEntry(absFilePath: string): boolean {
	try {
		for (const line of readFileSync(absFilePath, "utf8").split("\n")) {
			if (line === "") continue;
			if ((JSON.parse(line) as { type?: unknown }).type === "message") return true;
		}
		return false;
	} catch {
		return false;
	}
}

function isMessageWithContent(message: Message): boolean {
	return typeof (message as { role?: unknown }).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => {
			return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
		})
		.map((block) => block.text)
		.join(" ");
}

function getMessageActivityTime(entry: MessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const messageTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof messageTimestamp === "number") return messageTimestamp;

	const parsed = new Date(entry.timestamp).getTime();
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * One session file, summarized for a picker: who it is, when it moved, and enough text to search it.
 *
 * `modified` prefers the last message's own stamp over the header's, because a session that is being
 * appended to right now has a birthtime that says nothing about its age.
 */
async function buildSessionInfo(absFilePath: string, signal?: AbortSignal, fileStats?: Stats): Promise<SessionInfo | null> {
	try {
		const stats = fileStats ?? (await stat(absFilePath));
		let header: SessionHeader | null = null;
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let lastActivityTime: number | undefined;
		/**
		 * The branch, as two tables, read in the loop that was already reading every entry.
		 *
		 * A title has to name the branch the session is *on*, not the first message the file happens
		 * to hold, so the scan needs the same parent links a reader follows. Collecting them here costs
		 * one `Map` in a pass that already parses each line — as against a second read of the file.
		 *
		 * Every entry records its parent, not only the messages: a branch runs through model and tool
		 * changes on its way back to the root, and a walk that stopped at the first one would never
		 * reach the messages before it.
		 */
		const parentOf = new Map<string, string | null>();
		const userTextOf = new Map<string, string>();
		/** The last entry of any kind, which is where a branch read from the file starts. */
		let leafId: string | undefined;
		/**
		 * The last rename entry's title, in file order.
		 *
		 * A rename is a fact about the session rather than about one way through it (ADR-0002), so the
		 * scan reads it the same way the live manager does: last one in the file wins, before any
		 * branch walk starts.
		 */
		let renamedTitle: string | undefined;

		const lines = createInterface({
			input: createReadStream(absFilePath, { encoding: "utf8", signal }),
			crlfDelay: Number.POSITIVE_INFINITY,
		});

		for await (const line of lines) {
			const entry = parseJsonlLine(line);
			if (!entry) continue;
			if (!header) {
				if (!isSessionHeader(entry)) return null;
				header = entry;
				continue;
			}
			leafId = entry.id;
			// The header has already been consumed above, so this is one of the id-bearing kinds — and
			// the ones a branch walks through (model and tool changes) are recorded here too.
			parentOf.set(entry.id, (entry as { parentId?: string | null }).parentId ?? null);
			if (entry.type === "rename") renamedTitle = entry.title;
			if (entry.type !== "message") continue;
			messageCount++;

			const activityTime = getMessageActivityTime(entry);
			if (typeof activityTime === "number") lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);

			const message = entry.message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const text = extractTextContent(message);
			if (!text) continue;
			allMessages.push(text);
			if (!firstMessage && message.role === "user") firstMessage = text;
			if (message.role === "user" && !userTextOf.has(entry.id)) userTextOf.set(entry.id, text);
		}

		if (!header) return null;

		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : Number.NaN;
		const modified =
			typeof lastActivityTime === "number" && lastActivityTime > 0
				? new Date(lastActivityTime)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: stats.mtime;

		return {
			absPath: absFilePath,
			id: header.id,
			absCwd: typeof header.cwd === "string" ? header.cwd : "",
			...(header.parentSession === undefined ? {} : { absParentSessionPath: header.parentSession }),
			created: new Date(header.timestamp),
			modified,
			messageCount,
			title: renamedTitle ?? titleOfBranch(parentOf, userTextOf, leafId),
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		signal?.throwIfAborted();
		return null;
	}
}

/**
 * The first user message on the branch that ends at `leafId`, shortened — or the placeholder.
 *
 * Walked from the leaf back to the root and then reversed, which is the same path
 * {@link SessionManager.getBranch} reports for a live session, so a scanned row and a running one
 * name the same conversation. An entry with no recorded parent ends the walk, and so does one the
 * tables do not hold: a file written by another build can name a parent this scan never saw, and a
 * shorter title is a better answer than none.
 */
function titleOfBranch(
	parentOf: ReadonlyMap<string, string | null>,
	userTextOf: ReadonlyMap<string, string>,
	leafId: string | undefined,
): string {
	const walked: string[] = [];
	let current = leafId;
	while (current !== undefined && parentOf.has(current)) {
		walked.push(current);
		current = parentOf.get(current) ?? undefined;
	}
	walked.reverse();
	for (const id of walked) {
		const text = userTextOf.get(id);
		if (text === undefined) continue;
		const title = shortenTitle(text);
		if (title.length > 0) return title;
	}
	return "新会话";
}

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

interface SessionFileCandidate {
	absPath: string;
	stats?: Stats;
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	map: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (nextIndex < items.length) {
			signal?.throwIfAborted();
			const index = nextIndex++;
			results[index] = await map(items[index]!, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return results;
}

function sortSessionInfos(sessions: SessionInfo[]): SessionInfo[] {
	return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/**
 * Give every fork the id of the session it came from, when both are in this listing.
 *
 * The header records the source's *file path*, because that is what a reader holding one file has in
 * hand. A listing is the first place where both ends of a fork are known at once, so the path is
 * resolved here to the id a client opens a session by — an id, not a path, because it is what every
 * other row of the sidebar is named by. A parent outside this directory stays unresolved and the fork
 * appears as a root, which is the honest reading: nothing here could open it either.
 */
function linkForkParents(sessions: SessionInfo[]): void {
	const byAbsPath = new Map<string, string>();
	for (const session of sessions) byAbsPath.set(absPathKey(session.absPath), session.id);

	for (const session of sessions) {
		if (session.absParentSessionPath === undefined) continue;
		const parentId = byAbsPath.get(absPathKey(session.absParentSessionPath));
		if (parentId === undefined || parentId === session.id) continue;
		session.parentId = parentId;
	}
}

/** A path a lookup can key on: resolved, and case-folded where the filesystem is. */
function absPathKey(absPath: string): string {
	const absResolved = resolvePath(absPath);
	return process.platform === "win32" ? absResolved.toLowerCase() : absResolved;
}

async function listSessionsFromDir(absDir: string, signal?: AbortSignal): Promise<SessionInfo[]> {
	signal?.throwIfAborted();
	if (!existsSync(absDir)) return [];

	try {
		const dirEntries = await readdir(absDir);
		const files: SessionFileCandidate[] = dirEntries
			.filter((file) => file.endsWith(".jsonl"))
			.sort((a, b) => b.localeCompare(a))
			.map((file) => ({ absPath: join(absDir, file) }));
		const results = await mapWithConcurrency(
			files,
			MAX_CONCURRENT_SESSION_INFO_LOADS,
			async (file) => buildSessionInfo(file.absPath, signal, file.stats),
			signal,
		);
		// A file with no message in it is a creation nobody spoke in, not a conversation: the sidebar
		// is a list of conversations, so it is left out here rather than drawn as「新会话」. This is
		// the same rule `persistEntry` writes by — a session earns its file with its first message —
		// applied to the read side, so the two cannot disagree about what exists.
		const sessions = results.filter((info): info is SessionInfo => info !== null && info.messageCount > 0);
		linkForkParents(sessions);
		return sessions;
	} catch {
		signal?.throwIfAborted();
		return [];
	}
}

/** What the subtree below one entry amounts to, for {@link SessionManager.getBranchPoints}. */
interface SubtreeDescription {
	/** The newest tip below the entry, or the entry itself when nothing follows it. */
	tip: string;
	/** True when a message entry is reachable, which is what makes a child a real alternative. */
	message: boolean;
	/** A one-line preview of the earliest message below, or empty when there is none. */
	label: string;
}

/**
 * How much of a message's first sentence a branch label carries.
 *
 * A card shows one ellipsised line and nothing else — no hover unfolds the rest — so the bound is
 * sized for a real sentence rather than for a row, and a sentence that needs more is simply cut by the
 * stylesheet: a branch option travels in every snapshot, and these ride whole, which is why the label
 * is a preview at all and not the message. The alternatives that are not on the active chain have no
 * message in the snapshot to read from, so there is nothing longer to fall back to. See ticket
 * `.scratch/ui-pass` 02.
 */
export const BRANCH_LABEL_MAX = 200;

/** One short line naming what a message says, for a branch switcher's label. */
function previewOfMessage(message: Message): string {
	const text = extractTextContent(message).replace(/\s+/g, " ").trim();
	if (text.length === 0) return "";
	return text.length > BRANCH_LABEL_MAX ? `${text.slice(0, BRANCH_LABEL_MAX - 3)}...` : text;
}

/**
 * The session store: an append-only tree of entries in one JSONL file.
 *
 * Every entry carries an id and its parent's id, so the file reads as a tree and `leafId` is where the
 * conversation currently is. Appending creates a child of the leaf; {@link branch} moves the leaf to
 * an earlier entry — and records the move as a {@link LeafEntry}, so a fresh reader restores it — so a
 * new line of work continues from there without touching what was already written. A file is never
 * rewritten once it holds an entry, which is what lets an entry kind or a field this build does not
 * understand be carried through untouched.
 *
 * Use {@link buildSessionContext} to get the messages a provider should be sent: it follows the branch
 * from root to leaf and folds in the newest compaction.
 */
export class SessionManager {
	private sessionId = "";
	private absSessionFile: string | undefined;
	/** The session directory, absolute; null for a session that is never written. */
	private absSessionDir: string | null;
	private absCwd: string;
	private persist: boolean;
	/**
	 * True once this session's file exists and holds the log as of the last write.
	 *
	 * It decides how the next write happens: false means nothing has been written yet, so the first
	 * entry worth keeping creates the file and writes the whole log; true means appends go straight
	 * to disk. See {@link persistEntry}.
	 */
	private fileCreated = false;
	private jsonlEntries: JsonlEntry[] = [];
	private readonly sessionEntryMapById: SessionEntryMapById = new Map();
	private leafId: string | null = null;

	private constructor(
		cwdInput: string,
		sessionDirInput: string | null,
		sessionFile: string | undefined,
		persist: boolean,
		parentSessionFile?: string,
	) {
		this.absCwd = resolvePath(cwdInput);
		this.absSessionDir = sessionDirInput === null ? null : normalizePath(sessionDirInput);
		this.persist = persist;
		if (persist && this.absSessionDir !== null && !existsSync(this.absSessionDir)) {
			mkdirSync(this.absSessionDir, { recursive: true });
		}

		if (sessionFile) {
			this.loadSessionFile(sessionFile);
		} else {
			this.newSession(parentSessionFile);
		}
	}

	/** Take over an existing session file. A file this build cannot read is refused, never overwritten. */
	private loadSessionFile(sessionFile: string): void {
		this.absSessionFile = resolvePath(sessionFile);
		const entries = loadJsonlEntries(this.absSessionFile);
		if (entries.length === 0) {
			throw new Error(`Session file is not a valid ${APP_NAME} session: ${this.absSessionFile}`);
		}
		this.loadEntries(entries);
		this.fileCreated = true;
	}

	/**
	 * Start a fresh session in this manager, discarding whatever it held. Returns the file path.
	 *
	 * `parentSessionFile` is the absolute path of the session this one descends from — a fork's
	 * source, or a subagent's parent — and it lands on the header as `parentSession`. Undefined means
	 * a root session. A relative path is resolved here against the process's cwd, which is the same
	 * base a listing uses when it matches parent to child; recording it as given would let the two
	 * sides disagree the moment the process ran somewhere else.
	 */
	newSession(parentSessionFile?: string): string | undefined {
		this.sessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "SessionHeader",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.absCwd,
			...(parentSessionFile === undefined ? {} : { parentSession: resolvePath(parentSessionFile) }),
		};
		this.jsonlEntries = [header];
		this.sessionEntryMapById.clear();
		this.leafId = null;
		this.fileCreated = false;

		const dir = this.getAbsSessionDir();
		if (this.persist && dir !== null) this.absSessionFile = sessionPath(dir, this.sessionId, timestamp);
		return this.absSessionFile;
	}

	private loadEntries(entries: JsonlEntry[]): void {
		// loadJsonlEntries refuses a file whose first entry is not the header, so this finds one.
		const header = entries.find(isSessionHeader);
		if (header === undefined) throw new Error(`Session file has no header: ${this.absSessionFile}`);
		this.jsonlEntries = entries;
		this.sessionId = header.id;
		this.buildIndex();
	}

	private buildIndex(): void {
		this.sessionEntryMapById.clear();
		this.leafId = null;
		for (const entry of this.jsonlEntries) {
			if (isSessionHeader(entry)) continue;
			this.sessionEntryMapById.set(entry.id, entry);
			if (entry.type === "leaf") {
				// The record names where the conversation went; every other kind *is* where it went, by
				// having been appended. File order is the last word, so a later entry of any kind
				// supersedes what an earlier record said, the way an old `model_change` expires. A
				// recorded null is a position of its own — "before the first entry" — and only a target
				// the file does not hold (only a hand-edited file can manage that) falls back to the
				// record's own tree position, the same family of answer `buildSessionPath` gives an
				// unknown id.
				this.leafId = entry.leafId === null || this.sessionEntryMapById.has(entry.leafId) ? entry.leafId : (entry.parentId ?? null);
			} else {
				this.leafId = entry.id;
			}
		}
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getAbsCwd(): string {
		return this.absCwd;
	}

	/** The directory this session's file lives in, absolute, or null when it is never written. */
	getAbsSessionDir(): string | null {
		return this.absSessionDir;
	}

	usesDefaultSessionDir(): boolean {
		return this.absSessionDir !== null && this.absSessionDir === workspaceDir(this.absCwd);
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getAbsSessionFile(): string | undefined {
		return this.absSessionFile;
	}

	/** True once the session holds a user or assistant message, which is what makes it worth keeping. */
	private hasConversation(): boolean {
		return this.jsonlEntries.some(
			(entry) => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
		);
	}

	private persistEntry(entry: SessionEntry): void {
		if (!this.persist || !this.absSessionFile) return;

		if (!this.fileCreated) {
			if (!this.hasConversation()) return;
			const fd = openSync(this.absSessionFile, "wx");
			try {
				for (const existing of this.jsonlEntries) writeFileSync(fd, `${JSON.stringify(existing)}\n`);
			} finally {
				closeSync(fd);
			}
			this.fileCreated = true;
			return;
		}

		appendFileSync(this.absSessionFile, `${JSON.stringify(entry)}\n`);
	}

	private appendEntry(entry: SessionEntry): void {
		this.jsonlEntries.push(entry);
		this.sessionEntryMapById.set(entry.id, entry);
		this.leafId = entry.id;
		this.persistEntry(entry);
	}

	/**
	 * Append a message as a child of the leaf and advance the leaf. Returns the new entry's id.
	 *
	 * A compaction summary is deliberately not accepted here: it has to be a top-level entry so that
	 * {@link buildContextEntries} can find it, which is what {@link appendCompaction} is for.
	 */
	appendMessage(message: Message): string {
		const entry: MessageEntry = {
			type: "message",
			id: generateId(this.sessionEntryMapById),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this.appendEntry(entry);
		return entry.id;
	}

	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.sessionEntryMapById),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this.appendEntry(entry);
		return entry.id;
	}

	appendModelChange(name: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.sessionEntryMapById),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name,
			modelId,
		};
		this.appendEntry(entry);
		return entry.id;
	}

	/**
	 * Record the session's tool choices: the active set and the approval map, both whole.
	 *
	 * A snapshot rather than a delta, because the reader replays the branch and takes the last entry —
	 * the same contract as `model_change`, which also records the value, not the move. Both maps are
	 * always present, so one entry written for a tool change carries the approval set along and the
	 * other way round.
	 */
	appendToolConfig(activeTools: string[], approval: Record<ToolApprovalKey, boolean>): string {
		const entry: ToolConfigEntry = {
			type: "tool_config",
			id: generateId(this.sessionEntryMapById),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			activeTools: [...activeTools],
			approval: { ...approval },
		};
		this.appendEntry(entry);
		return entry.id;
	}

	/**
	 * Record the conversation's own name, over the derived one.
	 *
	 * The title is expected already shortened — the endpoint that takes a user's typing applies
	 * {@link shortenTitle} before it gets here, so what lands in the file is what a row shows. Like
	 * every state entry this one is not transcript: it reaches no message, and a reader takes the
	 * last one in file order, whichever way the branch points.
	 */
	appendRename(title: string): string {
		const entry: RenameEntry = {
			type: "rename",
			id: generateId(this.sessionEntryMapById),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			title,
		};
		this.appendEntry(entry);
		return entry.id;
	}

	/**
	 * Record spend that owns no message entry, attributed to `operation` on `model`.
	 *
	 * The whole spend travels in one entry, summed by the writer — a delegation runs many requests on
	 * its own transcript, and this file wants the total, not the receipt list. Zero-usage records are
	 * the caller's to skip: an entry costs a line, and a spend of nothing is not a fact worth one.
	 */
	appendUsage(operation: string, model: string, usage: Usage): string {
		const entry: UsageEntry = {
			type: "usage",
			id: generateId(this.sessionEntryMapById),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			operation,
			model,
			usage,
		};
		this.appendEntry(entry);
		return entry.id;
	}

	/**
	 * Record a compaction checkpoint: everything up to `firstKeptEntryId` is replaced by `summary`.
	 *
	 * `firstKeptEntryId` of null means this compaction keeps no earlier entry, so the checkpoint is the
	 * whole remaining history and the entry points at itself.
	 */
	appendCompaction(
		summary: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		usage?: Usage,
	): string {
		const timestamp = new Date().toISOString();
		const id = generateId(this.sessionEntryMapById);
		const entry: CompactionEntry = {
			type: "compaction",
			id,
			parentId: this.leafId,
			timestamp,
			summary,
			firstKeptEntryId: firstKeptEntryId ?? id,
			tokensBefore,
			...(usage === undefined ? {} : { usage }),
		};
		this.appendEntry(entry);
		return entry.id;
	}

	/**
	 * Record that tool results were cleared: the named entries keep their place in the file and lose
	 * their text in the view.
	 *
	 * Unlike a compaction there is nothing to hold back — the results are cleared precisely because a
	 * run can reproduce them — so the record is only the ids and what the clear was worth.
	 */
	appendClearToolResults(clearedEntryIds: readonly string[], tokensBefore: number): string {
		const entry: ClearToolResultEntry = {
			type: "clear_tool_result",
			id: generateId(this.sessionEntryMapById),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			clearedEntryIds: [...clearedEntryIds],
			tokensBefore,
		};
		this.appendEntry(entry);
		return entry.id;
	}

	/**
	 * Record that tool-call arguments were shortened: the named entries keep their place in the file
	 * and lose the heavy bodies of their arguments in the view.
	 *
	 * Like a clear, there is nothing to hold back — the arguments named belong to calls whose results
	 * are already on the branch — so the record is only the ids and what the trim was worth.
	 */
	appendTrimToolCallArgs(trimmedEntryIds: readonly string[], tokensBefore: number): string {
		const entry: TrimToolCallArgEntry = {
			type: "trim_tool_call_arg",
			id: generateId(this.sessionEntryMapById),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			trimmedEntryIds: [...trimmedEntryIds],
			tokensBefore,
		};
		this.appendEntry(entry);
		return entry.id;
	}

	// =========================================================================
	// Tree traversal
	// =========================================================================

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.sessionEntryMapById.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.sessionEntryMapById.get(id);
	}

	/** Every entry that follows `parentId`, in file order. */
	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.sessionEntryMapById.values()) {
			if (entry.parentId === parentId) children.push(entry);
		}
		return children;
	}

	/**
	 * The branch points of the log, in file order.
	 *
	 * A child counts as an alternative only when a message is reachable through it: this format carries
	 * state entries too — a model change, a tool config, a tool-result clear, a compaction, a leaf record — and a
	 * conversation cannot be resumed at one of those, so counting them would offer an empty
	 * alternative. A state entry in front of a message is descended through for the same reason:
	 * rewinding, switching the model, and asking again is one alternative, not two.
	 *
	 * The walk covers **every** entry rather than only the active chain's, which is what makes the tree
	 * a property of the conversation instead of of the leaf's current position: rewind to the first
	 * question and the forks further down are still there to draw, where a chain-relative report would
	 * quietly drop them — a page that forgets half the tree the moment the leaf moves. `options[].active`
	 * is what stays chain-relative, and it is the only thing that should be.
	 *
	 * File order is also the order a client can fold the points in: a point's `anchor` is one of its
	 * own ancestors, and an entry is never written before its parent, so the card a point hangs under
	 * is always already placed when the point arrives.
	 */
	getBranchPoints(): BranchPoint[] {
		const chain = this.getBranch();
		const onChain = new Set(chain.map((entry) => entry.id));
		const children = this.childrenIndex();
		const memo = new Map<string, SubtreeDescription>();

		// Pass one: which entries were carried on from in more than one way, and what each
		// continuation amounts to. Nothing is placed yet — an anchor is only knowable once every point
		// is known, because a card is either a user message on the line or an earlier point's option.
		const forks: { entry: SessionEntry; options: BranchOption[] }[] = [];
		for (const entry of this.sessionEntryMapById.values()) {
			const options: BranchOption[] = [];
			for (const child of children.get(entry.id) ?? []) {
				const described = this.subtreeDescription(child.id, children, memo);
				if (!described.message) continue;
				options.push({
					entryId: child.id,
					label: described.label,
					active: onChain.has(child.id),
				});
			}
			if (options.length > 1) forks.push({ entry, options });
		}
		const forkIds = new Set(forks.map((fork) => fork.entry.id));

		/** True for an entry a window draws a card for: a question on the line, or a taken way. */
		const isCard = (entry: SessionEntry): boolean => {
			if (onChain.has(entry.id)) return entry.type === "message" && entry.message.role === "user";
			// Off the line, only a fork's own continuation becomes a card. An on-chain entry is
			// excluded above rather than here: the chain's own continuation is drawn as the line's
			// next card, and stopping a descent at it would name a card that does not exist.
			return entry.parentId !== null && forkIds.has(entry.parentId);
		};

		/** The nearest card at or above `entryId`, or undefined for a point nothing can host. */
		const anchorOf = (entryId: string): string | undefined => {
			let current: SessionEntry | undefined = this.sessionEntryMapById.get(entryId);
			while (current !== undefined) {
				if (isCard(current)) return current.id;
				current = current.parentId === null ? undefined : this.sessionEntryMapById.get(current.parentId);
			}
			return undefined;
		};

		const prompts = new Map<string, string>();
		/** The nearest question at or above `entryId`, walked up the entry's own parent links. */
		const nearestPrompt = (entryId: string): string => {
			const cached = prompts.get(entryId);
			if (cached !== undefined) return cached;
			// Seeded before the descent for the same reason `subtreeDescription` seeds its memo: a file
			// hand-edited into a cycle has to end the walk rather than spin.
			prompts.set(entryId, "");
			const entry = this.sessionEntryMapById.get(entryId);
			let prompt = "";
			if (entry !== undefined) {
				const own = entry.type === "message" ? previewOfMessage(entry.message) : "";
				if (entry.type === "message" && entry.message.role === "user" && own.length > 0) {
					prompt = own;
				} else if (entry.parentId !== null) {
					prompt = nearestPrompt(entry.parentId);
				}
			}
			prompts.set(entryId, prompt);
			return prompt;
		};

		// Pass two: the points, each with the card its alternatives hang under. A point no card can
		// host keeps its own id, which the client has no card for — dropped there rather than drawn in
		// a place it does not belong.
		return forks.map((fork) => ({
			entryId: fork.entry.id,
			anchor: anchorOf(fork.entry.id) ?? fork.entry.id,
			prompt: nearestPrompt(fork.entry.id),
			options: fork.options,
		}));
	}

	/**
	 * The newest tip of the subtree `entryId` roots: where that line of work would be resumed.
	 *
	 * The descent follows the last child written at each step, over every entry kind, because a branch
	 * whose last entry is a compaction or a model change stopped there too.
	 */
	getBranchTip(entryId: string): string {
		if (!this.sessionEntryMapById.has(entryId)) throw new Error(`Entry ${entryId} not found`);
		return this.subtreeDescription(entryId, this.childrenIndex(), new Map()).tip;
	}

	/** Every entry's children, in file order, built in one pass over the log. */
	private childrenIndex(): Map<string, SessionEntry[]> {
		const index = new Map<string, SessionEntry[]>();
		for (const entry of this.sessionEntryMapById.values()) {
			if (entry.parentId === null) continue;
			const siblings = index.get(entry.parentId);
			if (siblings === undefined) index.set(entry.parentId, [entry]);
			else siblings.push(entry);
		}
		return index;
	}

	/**
	 * What an alternative amounts to: where the subtree below `entryId` ends, and how to label it.
	 *
	 * Memoized per entry, so one call describes the whole log once however many branch points ask.
	 */
	private subtreeDescription(
		entryId: string,
		children: Map<string, SessionEntry[]>,
		memo: Map<string, SubtreeDescription>,
	): SubtreeDescription {
		const cached = memo.get(entryId);
		if (cached !== undefined) return cached;
		// Seeded before the descent: this is what a file hand-edited into a cycle finds when it comes
		// back around, so the walk ends there instead of spinning.
		memo.set(entryId, { tip: entryId, message: false, label: "" });

		const entry = this.sessionEntryMapById.get(entryId);
		const descents = (children.get(entryId) ?? []).map((child) =>
			this.subtreeDescription(child.id, children, memo),
		);
		const own = entry?.type === "message" ? previewOfMessage(entry.message) : undefined;
		let label = own ?? "";
		let message = own !== undefined;
		if (!message) {
			const below = descents.find((descent) => descent.message);
			if (below !== undefined) {
				message = true;
				label = below.label;
			}
		}
		const described: SubtreeDescription = {
			// The newest child is the last written, and the file is in write order.
			tip: descents.length === 0 ? entryId : descents[descents.length - 1]!.tip,
			message,
			label,
		};
		memo.set(entryId, described);
		return described;
	}

	/**
	 * Walk from `fromId` to the root, in path order, every entry kind included.
	 *
	 * This is the raw branch; {@link buildContextEntries} is the same walk with compaction applied, and
	 * is what a provider request is built from.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.leafId;
		let current = startId ? this.sessionEntryMapById.get(startId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? this.sessionEntryMapById.get(current.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	buildContextEntries(): SessionEntry[] {
		return buildContextEntries(this.sessionEntryMapById, this.leafId);
	}

	buildSessionContext(): SessionContext {
		return buildSessionContext(this.sessionEntryMapById, this.leafId);
	}

	/**
	 * The model and thinking level the active branch was last set to, each undefined when it never was.
	 *
	 * {@link buildSessionContext} answers with those values and the defaults to run with. This is for a
	 * caller that has to tell "the session chose off" from "the session never chose" — assembly, which
	 * decides whether a stored value may override the settings file.
	 */
	getRecordedSettings(): { model?: { name: string; modelId: string }; thinkingLevel?: string } {
		const recorded: { model?: { name: string; modelId: string }; thinkingLevel?: string } = {};
		for (const entry of this.getBranch()) {
			if (entry.type === "thinking_level_change") recorded.thinkingLevel = entry.thinkingLevel;
			else if (entry.type === "model_change") {
				const name = modelChangeName(entry);
				if (name !== undefined) recorded.model = { name, modelId: entry.modelId };
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				// Only ever a fallback, and a weak one: a message records the wire id it was answered by,
				// not the row's identity, so this can only name a row the user left unnamed. See
				// {@link getSessionContextSettings}.
				recorded.model = { name: entry.message.model, modelId: entry.message.model };
			}
		}
		return recorded;
	}

	/**
	 * The tool choices the active branch was last recorded with, each undefined when it never was.
	 *
	 * Undefined is meaningful and is what this exists to preserve: a session with no `tool_config`
	 * entry opens on the defaults, while one with an entry reopens exactly as its user left it. Like
	 * {@link getRecordedSettings}, this reads the branch, not the file, so a fork answers with the
	 * choices in force where it split off.
	 */
	getRecordedToolConfig(): { activeTools?: string[]; approval?: Record<ToolApprovalKey, boolean> } {
		const recorded: { activeTools?: string[]; approval?: Record<ToolApprovalKey, boolean> } = {};
		for (const entry of this.getBranch()) {
			if (entry.type === "tool_config") {
				recorded.activeTools = entry.activeTools;
				recorded.approval = entry.approval;
			}
		}
		return recorded;
	}

	/**
	 * The entry id behind each message in {@link buildSessionContext}'s list, in the same order.
	 *
	 * A compaction checkpoint produces messages that belong to no message entry, so those read as null.
	 * This is what a transcript needs to offer "fork from here" on a message it never watched being
	 * written.
	 */
	getContextMessageEntryIds(): (string | null)[] {
		const ids: (string | null)[] = [];
		for (const entry of this.buildContextEntries()) {
			const produced = sessionEntryToContextMessages(entry).length;
			for (let index = 0; index < produced; index++) ids.push(entry.type === "message" ? entry.id : null);
		}
		return ids;
	}

	getHeader(): SessionHeader | null {
		return this.jsonlEntries.find(isSessionHeader) ?? null;
	}

	/** Number of entries, header aside, without copying them the way {@link getEntries} does. */
	getEntryCount(): number {
		return this.sessionEntryMapById.size;
	}

	/** Every entry, header aside, in file order. Use the `append*` methods to add more. */
	getEntries(): SessionEntry[] {
		return this.jsonlEntries.filter((entry): entry is SessionEntry => !isSessionHeader(entry));
	}

	/**
	 * The conversation's own name: a recorded rename if there is one, else the branch's first user
	 * message, else a placeholder.
	 *
	 * The rename is read in **file order**, not along the branch, and that is deliberate: the left
	 * column draws one row per session, not per way through it, so a name a person gave the session
	 * does not stop being theirs because the leaf moved. The branch walk below stays exactly as it
	 * was — it is the fallback, and summarizing the oldest turn away still cannot rename the session.
	 */
	getTitle(): string {
		for (let index = this.jsonlEntries.length - 1; index >= 0; index--) {
			const entry = this.jsonlEntries[index];
			if (entry?.type === "rename") return entry.title;
		}
		return deriveTitle(this.getBranch().flatMap(sessionEntryToContextMessages));
	}

	// =========================================================================
	// Branching
	// =========================================================================

	/**
	 * Move the leaf to an earlier entry, so the next append starts a new branch from it.
	 *
	 * Nothing is modified or deleted: the entries after the old leaf are still in the file, still
	 * reachable by id, and are simply no longer on the active branch.
	 *
	 * A move that actually changes the position is recorded as one {@link LeafEntry}, which is what
	 * lets a process that reopens the file put the leaf back where the conversation went. The record
	 * is appended as a child of the leaf it leaves behind and does not advance it — the tree position
	 * says where the append happened, the `leafId` field says where the conversation went. Moving to
	 * the position already held writes nothing, the same guard `recordSelection` applies to its own
	 * entries: a run of no-op moves costs no file.
	 */
	branch(branchFromId: string): void {
		if (!this.sessionEntryMapById.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		if (this.leafId === branchFromId) return;
		this.appendLeafRecord(branchFromId);
		this.leafId = branchFromId;
	}

	/** Move the leaf before the first entry, so the next append becomes a new root. */
	resetLeaf(): void {
		if (this.leafId === null) return;
		this.appendLeafRecord(null);
		this.leafId = null;
	}

	/**
	 * Write one leaf record as a child of the leaf it leaves behind, without moving the leaf.
	 *
	 * The caller sets {@link leafId} right after: an append advances the leaf, and this one must not —
	 * the record's place in the tree and the position it reports are two facts, each with its own
	 * field.
	 */
	private appendLeafRecord(leafId: string | null): void {
		const entry: LeafEntry = {
			type: "leaf",
			id: generateId(this.sessionEntryMapById),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			leafId,
		};
		this.jsonlEntries.push(entry);
		this.sessionEntryMapById.set(entry.id, entry);
		this.persistEntry(entry);
	}

	// =========================================================================
	// Construction and discovery
	// =========================================================================

	/**
	 * Start a session in `cwdInput`, stored under `sessionDirInput` or the workspace's default directory.
	 *
	 * `parentSessionFile` is the absolute path of the session this one descends from, recorded on the
	 * header as `parentSession`; undefined starts a root session. See {@link newSession}.
	 *
	 * Nothing is written here. The file appears with the first entry worth keeping — the gate in
	 * {@link persistEntry} (`hasConversation`) — so a session nobody has spoken in leaves no trace on
	 * disk and no row in the sidebar. That is the whole point of building it here rather than writing
	 * a header: the store is a record of conversations, and a conversation with no message in it is
	 * not one yet.
	 *
	 * The cost is the id's addressability until that first message: {@link findSessionFilePathById} reads header
	 * files, so an id with no file cannot be found there. A caller that hands the id out and has to
	 * answer for it later therefore keeps the returned manager instead of rediscovering it —
	 * `SessionHub` holds it for the length of that window.
	 */
	static create(cwdInput: string, sessionDirInput?: string, parentSessionFileInput?: string): SessionManager {
		const absDir = sessionDirInput ? normalizePath(sessionDirInput) : workspaceDir(cwdInput);
		return new SessionManager(cwdInput, absDir, undefined, true, parentSessionFileInput);
	}

	/**
	 * Open one session file, deriving the workspace and the session directory from the file itself.
	 *
	 * The path is the whole input, so a path that names nothing is an error rather than a new session
	 * at that path: a mistyped path must not come back as an empty transcript, and must not leave a
	 * stray file behind on the way.
	 */
	static open(pathInput: string): SessionManager {
		const absPath = resolvePath(pathInput);
		if (!existsSync(absPath)) throw new Error(`Session file does not exist: ${absPath}`);
		const header = readSessionHeader(absPath);
		const absCwd = getSessionHeaderCwd(header) ?? process.cwd();
		return new SessionManager(absCwd, dirname(absPath), absPath, true);
	}

	/** A session that is never written to disk. */
	static inMemory(cwdInput: string = process.cwd(), parentSessionFileInput?: string): SessionManager {
		return new SessionManager(cwdInput, null, undefined, false, parentSessionFileInput);
	}

	/**
	 * Copy a branch of a session file into a new session under `targetCwd`.
	 *
	 * `entryId` is the entry the branch ends at, or null for the whole log. The new header points at the
	 * source file as `parentSession`, and the copied entries keep the ids and parent links the source
	 * wrote, which is what makes a fork traceable back to where it came from.
	 *
	 * The source is only read: a fork is a new file, and the file it came from is never rewritten.
	 */
	static forkFrom(
		sourcePathInput: string,
		targetCwdInput: string,
		entryId: string | null,
		sessionDirInput?: string,
	): SessionManager {
		const absSourcePath = resolvePath(sourcePathInput);
		const absTargetCwd = resolvePath(targetCwdInput);
		const sourceEntries = loadJsonlEntries(absSourcePath);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${absSourcePath}`);
		}
		const sourceHeader = sourceEntries.find(isSessionHeader);
		if (!sourceHeader) throw new Error(`Cannot fork: source session has no header: ${absSourcePath}`);

		const entries = sourceEntries.filter((entry): entry is SessionEntry => !isSessionHeader(entry));
		const branch = entryId === null ? entries : buildSessionPath(buildEntryIndex(entries), entryId);
		if (entryId !== null && branch.length === 0) {
			throw new Error(`Session ${sourceHeader.id} has no entry ${entryId}`);
		}

		const absDir = sessionDirInput ? normalizePath(sessionDirInput) : workspaceDir(absTargetCwd);
		if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const absNewSessionFile = sessionPath(absDir, newSessionId, timestamp);
		const header: SessionHeader = {
			type: "SessionHeader",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: absTargetCwd,
			parentSession: absSourcePath,
		};
		writeFileSync(absNewSessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
		for (const entry of branch) appendFileSync(absNewSessionFile, `${JSON.stringify(entry)}\n`);

		return new SessionManager(absTargetCwd, absDir, absNewSessionFile, true);
	}

	/** Every session stored for `cwd`, newest activity first. */
	static async list(cwdInput: string, sessionDirInput?: string, signal?: AbortSignal): Promise<SessionInfo[]> {
		const absDir = sessionDirInput ? normalizePath(sessionDirInput) : workspaceDir(cwdInput);
		const filterCwd = sessionDirInput !== undefined && absDir !== workspaceDir(cwdInput);
		const absCwd = resolvePath(cwdInput);
		const sessions = (await listSessionsFromDir(absDir, signal)).filter(
			(session) => !filterCwd || sessionCwdMatches(session.absCwd, absCwd),
		);
		return sortSessionInfos(sessions);
	}

	/**
	 * Every workspace this machine has stored sessions for, each with its own list.
	 *
	 * The sidebar groups by workspace, and one process is only ever bound to one of them, so the
	 * grouping has to come from the store rather than from the server's own root. The cwd is read from
	 * a session header instead of being decoded back out of the directory name: the name dashes the
	 * separators out of a path, which is readable but not reversible.
	 *
	 * Workspaces come back most recently active first, and the empty ones — a directory left behind by
	 * a session whose file was deleted — are dropped rather than shown as headless groups.
	 */
	static async listWorkspaces(signal?: AbortSignal): Promise<WorkspaceSessions[]> {
		let absDirs: string[];
		try {
			absDirs = readdirSync(sessionsDir(), { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(sessionsDir(), entry.name));
		} catch {
			// No sessions directory is the normal first run.
			return [];
		}

		const groups: WorkspaceSessions[] = [];
		for (const absDir of absDirs) {
			const absNewest = findMostRecentSession(absDir);
			if (absNewest === null) continue;
			const header = readSessionHeaderForDiscovery(absNewest);
			const absCwd = header === null ? undefined : getSessionHeaderCwd(header);
			if (absCwd === undefined || absCwd === "") continue;

			const sessions = (await SessionManager.list(absCwd, absDir, signal)).map(toSessionRow);
			if (sessions.length === 0) continue;
			groups.push({ absCwd, sessions });
		}

		return groups.sort((a, b) => newestAt(b) - newestAt(a));
	}

	/**
	 * The one row a session id names, from whichever workspace holds it, or `undefined` when no file
	 * does.
	 *
	 * The listing answers the same question for every session at once, which is the wrong cost when
	 * exactly one session is what changed — one just created, or just forked, or one the store picked
	 * up by hand. So this locates that one file and parses only it: a session appearing costs one
	 * parse rather than a scan of the machine. The locate half is the header read, not a transcript
	 * read; only the file that matched is parsed whole.
	 */
	static async findSessionRowById(id: string, signal?: AbortSignal): Promise<SessionRow | undefined> {
		const absPath = SessionManager.findSessionFilePathById(id);
		if (absPath === undefined) return undefined;
		const info = await buildSessionInfo(absPath, signal);
		if (info === null) return undefined;
		// A fork's parent is named by *path* in the header, so it is knowable from one file alone once
		// that path is resolved to an id — which matters because a fork reaches a store one row at a
		// time, where the listing that would have linked it is not in play.
		if (info.parentId === undefined && info.absParentSessionPath !== undefined) {
			const parent = readSessionHeaderForDiscovery(info.absParentSessionPath);
			const parentId = parent?.id;
			if (parentId !== undefined && parentId !== info.id) info.parentId = parentId;
		}
		return toSessionRow(info);
	}

	/**
	 * The path of the file a session id names, searching every workspace on this machine.
	 *
	 * A session opened from the sidebar may live in a workspace this process was not started over, and
	 * its header — not the server's root — is what says which directory its tools resolve inside. The
	 * search is header reads only: every candidate file is opened for its first line and closed, so a
	 * miss costs one cheap read per session rather than one transcript parse per session.
	 */
	static findSessionFilePathById(id: string): string | undefined {
		let entries: string[];
		try {
			entries = readdirSync(sessionsDir(), { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(sessionsDir(), entry.name));
		} catch {
			return undefined;
		}

		for (const absDir of entries) {
			try {
				for (const file of readdirSync(absDir)) {
					if (!file.endsWith(".jsonl")) continue;
					const absPath = join(absDir, file);
					if (readSessionHeaderForDiscovery(absPath)?.id === id) return absPath;
				}
			} catch {
				// One unreadable directory must not hide a session stored in another.
				continue;
			}
		}
		return undefined;
	}

	/**
	 * Delete the file a session id names, from whichever workspace holds it.
	 *
	 * One file, not a directory: a workspace's sessions share a directory, so anything wider than the
	 * one `.jsonl` the header names is a different conversation's transcript. Throwing for an unknown
	 * id rather than answering "already gone" keeps the two failures apart — the caller decides what
	 * a second delete means, and the hub turns it into a status the client can show.
	 */
	static async remove(id: string): Promise<void> {
		const absPath = SessionManager.findSessionFilePathById(id);
		if (absPath === undefined) throw new Error(`Unknown session: ${id}`);
		await rm(absPath);
	}

}

/** The most recent activity in a group, for ordering the sidebar's workspaces. */
function newestAt(group: WorkspaceSessions): number {
	return group.sessions.reduce((newest, session) => Math.max(newest, session.modified), 0);
}

/**
 * Group rows by workspace and order them the way the sidebar draws them.
 *
 * Newest activity first within a group, and groups ordered by their own newest row. Exported because
 * the server's projection holds the same rows and has to order them the same way — a store and a
 * reader that each sorted for themselves would disagree the moment a row moved.
 */
export function groupSessionsByWorkspace(rows: readonly SessionRow[]): WorkspaceSessions[] {
	const groups = new Map<string, SessionRow[]>();
	for (const row of rows) {
		const group = groups.get(row.absCwd);
		if (group === undefined) groups.set(row.absCwd, [row]);
		else group.push(row);
	}
	return [...groups.entries()]
		.map(([absCwd, sessions]) => ({ absCwd, sessions }))
		.sort((a, b) => newestAt(b) - newestAt(a));
}

/** Most recently active first, on a copy so two callers cannot reorder each other's view. */
function byModified(rows: readonly SessionRow[]): SessionRow[] {
	return [...rows].sort((a, b) => b.modified - a.modified);
}

/**
 * The picker's view of a session: the id a client opens it by, and what to label it with.
 *
 * `SessionInfo` carries more than the wire needs — a path, a search blob, a message count — so the
 * narrowing happens in one place rather than in every server route that lists sessions.
 */
export function toSessionRef(info: SessionInfo): SessionRef {
	return {
		id: info.id,
		absCwd: info.absCwd,
		createdAt: info.created.getTime(),
		title: info.title,
		...(info.parentId === undefined ? {} : { parentId: info.parentId }),
	};
}

/**
 * One row of the sidebar, for a session nothing is running.
 *
 * A file can say where a session was last active and what it is called; it cannot say whether this
 * process is running it, because that fact was never written down. So the two live fields are
 * structurally `false` and `0` here — not a guess, and not "unknown": a session with no host is not
 * running and has no approval waiting, and a caller that wants the live values overlays them from the
 * snapshot rather than reading them off the disk.
 */
function toSessionRow(info: SessionInfo): SessionRow {
	return {
		...toSessionRef(info),
		modified: info.modified.getTime(),
		running: false,
		pending: 0,
	};
}

/**
 * The conversation's name: the first user message with text, shortened for a picker.
 *
 * Derived from the transcript rather than stored, so it follows a session that is still being written
 * and does not have to be migrated when the first message changes.
 */
export function deriveTitle(messages: readonly Message[]): string {
	for (const message of messages) {
		if (message.role !== "user") continue;
		// A compaction checkpoint is a user turn by shape but not by speaker; a resumed session whose
		// context starts at one must not be named by the summary it retained.
		if (compactionSummaryOf(message) !== undefined) continue;
		const text = shortenTitle(textOf((message as { content?: unknown }).content));
		if (text.length > 0) return text;
	}
	return "新会话";
}

/**
 * The one rule for shortening a title: collapse its whitespace, then cut it at 72 characters.
 *
 * Shared rather than written twice because the callers answer different questions about *which*
 * string they are shortening — a live session walks its branch, a scan walks the file, and the
 * rename endpoint truncates a user's typing — and a row whose title jumped between those worlds
 * would be the flicker this sharing exists to stop. Exported because the endpoint that stores a
 * rename is the controller's, and the rule has to be the store's, not the caller's copy of it.
 */
export function shortenTitle(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > 72 ? `${collapsed.slice(0, 69)}...` : collapsed;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
				return String((block as { text?: unknown }).text ?? "");
			}
			return "";
		})
		.join(" ");
}
