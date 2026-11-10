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
	renameSync,
	rmSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "../llm/index.ts";
import { type Usage, uuidv7 } from "../llm/index.ts";
import { APP_NAME } from "../config.ts";
import { trimToolCallArgs } from "../context/trim-tool-call-args.ts";
import { clearToolResult } from "../context/clear-tool-results.ts";
import type { SessionRef, SessionRow } from "../protocol.ts";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX, compactionSummaryOf } from "./messages.ts";
import { normalizePath, resolvePath, sessionDir, sessionJsonlPath, sessionMetaPath, sessionPath, sessionsDir } from "./paths.ts";
import { UnknownSessionError } from "./unknown-session.ts";

/**
 * The on-disk shape this build writes.
 *
 * A session is two files, and 5 is the first version that says so: 4 kept everything in one JSONL
 * with the header as line one, and 5 splits it — `<id>.json` holds what the session *is* (the
 * header fields plus the current values of title, model, thinking level, and tool config, rewritten
 * whole on every change), `<id>.jsonl` holds what was *said* (the immutable entry stream, and
 * nothing else). Only 5 is produced here, and the entry kinds this build knows are the ones in
 * {@link SessionEntry}.
 *
 * There is deliberately no migration. A session whose files do not read as a v5 pair is *deleted*,
 * not refused and left in place: the format is owned by this build, a v≤4 file cannot be adopted
 * without a header replay this code no longer has, and keeping it would make every listing pay for
 * a session nothing can ever open again. The deletion points are the listing scan and
 * {@link fillSession} — see {@link settleSessionFiles}.
 */
export const CURRENT_SESSION_VERSION = 5;

/**
 * The `.json` half of a session: what the session *is*, as one atomically rewritten snapshot.
 *
 * The first five fields are the identity a v4 header carried — who the session is, when it was
 * created, where it was opened, and the file it was forked from. The rest are the session's own
 * current choices, the ones v≤4 recorded as last-wins entries (`rename`, `model_change`,
 * `thinking_level_change`, `tool_config`): only the value in force is kept, so the history those
 * entries carried is gone by design — it was never read. A field absent means "never chosen", which
 * is what lets a reader tell a session that chose `off` from one that never chose.
 *
 * Every change rewrites the whole file (temp + rename), because it is a snapshot, not a log — the
 * JSONL beside it is the log, and the two are paired by stem: a session exists exactly when both
 * files do.
 *
 * This is the **disk** shape. In memory a session regroups the choice fields into
 * {@link SessionSetting} — the thinking level folded into `model` — and the translation between the
 * two lives in exactly two places: the fill path merges on the way in, {@link metaOf} splits on the
 * way out. Nothing else on disk changes: the version does not move, and an older session reads
 * as it always did.
 */
export interface SessionMeta {
	version: number;
	id: string;
	/** The ISO stamp the session was created at; the file name leads with the same moment. */
	timestamp: string;
	/** The working directory the session was opened on, absolute. */
	workDir: string;
	/**
	 * The session file this one was forked from or delegated by.
	 *
	 * An absolute path to the source's `.jsonl`, not an id, because a fork is traceable to the file
	 * it copied, and the file is what a reader has in hand. Absolute because a listing compares
	 * paths: a relative one would be resolved against whatever directory the process happens to be
	 * in. The copied entries keep their original ids on top of that.
	 */
	parentSession?: string;
	/** The conversation's own name, when a person gave it one; absent means "derive it". */
	title?: string;
	/** The model row this session last ran on, as the name that identifies it. */
	model?: { name: string; modelId: string };
	/** The thinking level this session last asked at; absent means "never chose". */
	thinkingLevel?: string;
	/** The complete active tool set as of the last change, in registration order. */
	activeTools?: string[];
	/** The complete approval map as of the last change, keyed like the settings file's `approval`. */
	approval?: Record<string, boolean>;
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
 * A record of model spend that owns no message entry: usage the engine never attached to an assistant
 * message in this transcript.
 *
 * The kind exists so a spend with no message of its own has somewhere to land — a run whose
 * transcript belongs to another file, a summary written for compaction — and `operation` names the
 * spend the way a reader would ask about it. A usage entry is money, not conversation: it reaches
 * no message, and it is counted in file order across every branch, because tokens burned on an
 * abandoned way through the tree were burned all the same. An unknown `operation` is read as ordinary
 * usage rather than rejected — the same forward-compatibility rule the file's unknown kinds follow.
 */
export interface UsageEntry extends SessionEntryBase {
	type: "usage";
	/** What the spend is attributed to, as the writer named it. */
	operation: string;
	/** The model row the spend ran on, as its name. */
	model: string;
	usage: Usage;
}

/**
 * The six kinds an entry line can be.
 *
 * Everything else a session once recorded about itself — its name, its model and thinking level, its
 * tool choices — is a *current value*, and lives in the `.json` snapshot beside this stream; and the
 * legacy `tool_result_view` kind is gone outright, because this build stopped writing it and v≤4
 * files are deleted rather than replayed. What is left is exactly the kinds a transcript cannot
 * rewrite in place: the conversation, the two view-shrink records, the checkpoint, the leaf
 * position, and unattributed spend.
 */
export type SessionEntry =
	| MessageEntry
	| CompactionEntry
	| ClearToolResultEntry
	| TrimToolCallArgEntry
	| LeafEntry
	| UsageEntry;

/**
 * The entries of one transcript, keyed by their own id.
 *
 * An entry carries only `parentId`, so every walk up the tree — {@link buildSessionPath}, a branch
 * preview, the id a caller names — is a lookup by id. This map is that lookup, and it is also what
 * makes `generateId` collision-free. Iteration order is file order: it is filled by replaying the
 * JSONL in sequence, and appended to in the same order, so "the last line wins" needs no sort.
 */
export type SessionEntryMapById = Map<string, SessionEntry>;

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
	workDirAbsPath: string;
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

/** One directory the sidebar groups under, and the sessions stored for it. */
export interface DirectorySessions {
	workDirAbsPath: string;
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

/**
 * The model and thinking level this session is on: the `.json` snapshot's current values, with the
 * transcript's last assistant message as the model's weak fallback.
 *
 * The snapshot is the first word — it is where the session's own choices live — and the message
 * fallback survives only for the model, because a message carries the wire id it was answered by
 * even when no choice was ever recorded. The name it reports is the wire id, which is what the row
 * it came from would be called if the user never named it. The walk is branch-relative by
 * construction, but only the fallback is: the snapshot's values are session-level, so moving the
 * leaf no longer switches them.
 */
function getSessionContextSettings(
	setting: SessionSetting,
	chain: SessionEntry[],
): Pick<SessionContext, "thinkingLevel" | "model"> {
	const merged = setting.model;
	let model =
		merged?.name !== undefined && merged?.modelId !== undefined
			? { name: merged.name, modelId: merged.modelId }
			: null;
	if (model === null) {
		for (const entry of chain) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				model = { name: entry.message.model, modelId: entry.message.model };
			}
		}
	}
	return { thinkingLevel: merged?.thinkingLevel ?? "off", model };
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

/** The three view decisions applied to one path, in the order compaction, trim, clear. */
function contextEntriesFromPath(chain: SessionEntry[]): SessionEntry[] {
	return applyClears(applyTrims(contextEntriesFrom(chain), trimmedEntryIds(chain)), clearedEntryIds(chain));
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

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;

/** Parse one JSONL line, or null: one unreadable line must not make the rest of a session unreadable. */
function parseJsonlLine(line: string): SessionEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as SessionEntry;
	} catch {
		return null;
	}
}

/** Read a session's entry stream whole. `absFilePath` is already resolved by the caller. */
function loadJsonlEntries(absFilePath: string): SessionEntry[] {
	if (!existsSync(absFilePath)) return [];

	const entries: SessionEntry[] = [];
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

	// A final line without a trailing newline would otherwise be extended by the next append.
	if (pending) appendFileSync(absFilePath, "\n");
	return entries;
}

/**
 * Read a session's `.json` snapshot, or refuse it.
 *
 * An unreadable file, one without the identity fields, and one whose version is not this build's
 * are all the same answer: not a session of this build. The caller decides what a refusal means —
 * {@link fillSession} turns it into a prune-and-throw, discovery into a skip.
 */
function readMetaFile(absJsonPath: string): SessionMeta {
	const raw = JSON.parse(readFileSync(absJsonPath, "utf8")) as SessionMeta;
	if (
		typeof raw?.id !== "string" ||
		typeof raw?.timestamp !== "string" ||
		typeof raw?.workDir !== "string" ||
		raw.workDir === ""
	) {
		throw new Error(`Session file is not a valid ${APP_NAME} session: ${absJsonPath}`);
	}
	if (raw.version !== CURRENT_SESSION_VERSION) {
		throw new Error(`Session version ${String(raw.version)} is not this build's ${CURRENT_SESSION_VERSION}: ${absJsonPath}`);
	}
	return raw;
}

/**
 * Read a session's `.json` snapshot for discovery: best-effort, null on anything.
 *
 * `absPath` may name either half — a caller that holds the `.jsonl` in hand derives the snapshot
 * path from it rather than rescanning the directory. Discovery is best-effort: one unreadable or
 * wrong-version file must not hide the other sessions.
 */
function readMetaForDiscovery(absPath: string): SessionMeta | null {
	try {
		return readMetaFile(absPath.endsWith(".json") ? absPath : sessionMetaPath(absPath));
	} catch {
		return null;
	}
}

function sessionWorkDirMatches(metaWorkDir: string | undefined, workDirAbsPath: string): boolean {
	return metaWorkDir !== undefined && metaWorkDir !== "" && resolvePath(metaWorkDir) === workDirAbsPath;
}

/**
 * Delete both halves of a session this build cannot open.
 *
 * v5 keeps no migration and no quarantine: a pair this build refuses is a session nothing can ever
 * open again, so keeping it would make every listing pay for a ghost. The trigger points are the
 * store scans ({@link settleSessionFiles}) and {@link fillSession} — every reader that proves a
 * pair unopenable removes it, and the store stays a list of sessions rather than also a graveyard.
 */
function pruneSessionFiles(absJsonPath: string, absJsonlPath: string): void {
	try {
		rmSync(absJsonPath, { force: true });
	} catch {
		// A failed deletion must not mask the reason the pair failed; the next scan tries again.
	}
	try {
		rmSync(absJsonlPath, { force: true });
	} catch {
		// Same: the pair is dead either way, and the next scan cleans up what this pass could not.
	}
}

/** One stem's two files, as a store scan found them. */
interface SessionFilePair {
	absJson?: string;
	absJsonl?: string;
}

/**
 * Pair a store's files by stem and remove everything this build cannot open.
 *
 * A session is a `.json` + `.jsonl` pair sharing a stem, and the `.json` is the commit marker: it
 * is written last at birth, so an unpaired half is a birth that died partway, and a version that is
 * not this build's is a file an older generation wrote. Both are deleted here — the scan is the one
 * place that walks every file, so it is the one place an unopenable pair can be retired without a
 * second pass. What comes back is the readable remainder, metas already in hand.
 *
 * The pruning cannot catch a birth in progress: this whole function is one synchronous block, and
 * so is a birth (`persistEntry`), and one process never runs both at once — the concurrent-write
 * case is outside the format's charter.
 */
function settleSessionFiles(absDir: string): { absJson: string; absJsonl: string; meta: SessionMeta }[] {
	const pairs = new Map<string, SessionFilePair>();
	for (const file of readdirSync(absDir)) {
		const dot = file.lastIndexOf(".");
		if (dot <= 0) continue;
		const ext = file.slice(dot);
		if (ext !== ".json" && ext !== ".jsonl") continue;
		const pair = pairs.get(file.slice(0, dot)) ?? {};
		if (ext === ".json") pair.absJson = join(absDir, file);
		else pair.absJsonl = join(absDir, file);
		pairs.set(file.slice(0, dot), pair);
	}

	const settled: { absJson: string; absJsonl: string; meta: SessionMeta }[] = [];
	for (const pair of pairs.values()) {
		if (pair.absJson === undefined || pair.absJsonl === undefined) {
			pruneSessionFiles(pair.absJson ?? "", pair.absJsonl ?? "");
			continue;
		}
		try {
			const meta = readMetaFile(pair.absJson);
			// The stream cannot legally be empty while the snapshot exists — a birth writes the whole
			// log before the snapshot — so an empty stream is a pair that died partway.
			if (statSync(pair.absJsonl).size === 0) {
				pruneSessionFiles(pair.absJson, pair.absJsonl);
				continue;
			}
			settled.push({ absJson: pair.absJson, absJsonl: pair.absJsonl, meta });
		} catch {
			pruneSessionFiles(pair.absJson, pair.absJsonl);
		}
	}
	return settled;
}

/** The newest session in `absDir`, preferring one whose meta names that directory `workDirAbsPath` when it is given. */
function findMostRecentSession(absDir: string, workDirAbsPath?: string): string | null {
	const workDirAbsPathResolved = workDirAbsPath ? resolvePath(workDirAbsPath) : undefined;
	try {
		const candidates = settleSessionFiles(absDir)
			.map(({ absJsonl }) => ({ absPath: absJsonl, mtime: statSync(absJsonl).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);

		for (const { absPath } of candidates) {
			const meta = readMetaForDiscovery(absPath);
			if (meta === null) continue;
			if (workDirAbsPathResolved !== undefined && !sessionWorkDirMatches(meta.workDir, workDirAbsPathResolved)) continue;
			// A session on disk holds a message by construction: both files are born with the first
			// one (persistEntry), so nothing here can be a creation nobody spoke in.
			return absPath;
		}
		return null;
	} catch {
		return null;
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
 * One session, summarized for a picker: who it is, when it moved, and enough text to search it.
 *
 * The scan is split the way the format is: identity fields — id, workDir, parent, created, a
 * recorded title — come from the `.json` snapshot, and the message statistics come from a line pass
 * over the `.jsonl`, which is the only half that has to be parsed entry by entry. The scan's caller
 * ({@link settleSessionFiles}) has already paired the files and pruned the unopenable, so a meta in
 * hand here means a session this build can open.
 *
 * `modified` prefers the last message's own stamp over the meta's, because a session that is being
 * appended to right now has a birthtime that says nothing about its age.
 */
async function buildSessionInfo(
	absJsonPath: string,
	absJsonlPath: string,
	meta: SessionMeta,
	signal?: AbortSignal,
): Promise<SessionInfo | null> {
	try {
		const stats = await stat(absJsonlPath);
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let lastActivityTime: number | undefined;
		/**
		 * The branch, as two tables, read in the loop that was already reading every entry.
		 *
		 * The recorded title is gone with the `rename` entry — the snapshot holds it now — so the
		 * only thing a title still needs from the scan is the *derived* fallback: the first user
		 * message on the branch the leaf is on. That needs the same parent links a reader follows,
		 * and collecting them here costs one `Map` in a pass that already parses each line.
		 */
		const parentOf = new Map<string, string | null>();
		const userTextOf = new Map<string, string>();
		/** The last entry of any kind, which is where a branch read from the file starts. */
		let leafId: string | undefined;

		const lines = createInterface({
			input: createReadStream(absJsonlPath, { encoding: "utf8", signal }),
			crlfDelay: Number.POSITIVE_INFINITY,
		});

		for await (const line of lines) {
			const entry = parseJsonlLine(line);
			if (!entry) continue;
			leafId = entry.id;
			parentOf.set(entry.id, entry.parentId);
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

		const metaTime = new Date(meta.timestamp).getTime();
		const modified =
			typeof lastActivityTime === "number" && lastActivityTime > 0
				? new Date(lastActivityTime)
				: !Number.isNaN(metaTime)
					? new Date(metaTime)
					: stats.mtime;

		return {
			absPath: absJsonlPath,
			id: meta.id,
			workDirAbsPath: meta.workDir,
			...(meta.parentSession === undefined ? {} : { absParentSessionPath: meta.parentSession }),
			created: new Date(meta.timestamp),
			modified,
			messageCount,
			title: meta.title ?? titleOfBranch(parentOf, userTextOf, leafId),
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
		// The scan pairs the files and prunes what it cannot open (settleSessionFiles), so what is
		// left here is exactly the sessions this build can open.
		const pairs = settleSessionFiles(absDir);
		const results = await mapWithConcurrency(
			pairs,
			MAX_CONCURRENT_SESSION_INFO_LOADS,
			async (pair) => buildSessionInfo(pair.absJson, pair.absJsonl, pair.meta, signal),
			signal,
		);
		// A file with no message in it is a creation nobody spoke in, not a conversation: the sidebar
		// is a list of conversations, so it is left out here rather than drawn as「新会话」. Under v5
		// nothing on disk can be empty — both files are born with the first message — so this is a
		// guard against a corrupt pair rather than a filter the writers need.
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
 * One session's own choices, regrouped out of the disk snapshot's flat fields.
 *
 * This is a memory grouping only — the `.json` on disk keeps its flat shape ({@link SessionMeta}),
 * and the fill path / {@link metaOf} are the only two translation points between the two. The
 * thinking level lives inside `model` rather than beside it: a session's level and its row are one
 * choice the input box sends together, so memory holds them as one object. Every field but the
 * working directory is absent until chosen, exactly as the disk fields are.
 */
export interface SessionSetting {
	/** The working directory the session was opened on, absolute. */
	workDirAbsPath: string;
	/**
	 * The session file this one was forked from or delegated by, as the disk's `parentSession` names
	 * it: the source's `.jsonl`, absolute — a path, not an id, because a fork is traceable to the
	 * file it copied and the file is what a reader has in hand. The name follows the state's shape;
	 * the value is whatever the disk carries, so an older session reads unchanged.
	 */
	parentSessionId?: string;
	/** The conversation's own name, when a person gave it one; absent means "derive it". */
	title?: string;
	/**
	 * The model choice in force, with the thinking level it was asked at: `name` / `modelId` name the
	 * row, `thinkingLevel` is the level the session last chose. Each part is absent until chosen — a
	 * level recorded with no row is a model with only `thinkingLevel`, which the disk splits back
	 * into two fields on the way out.
	 */
	model?: { name?: string; modelId?: string; thinkingLevel?: string };
	/** The complete active tool set as of the last change, in registration order. */
	activeTools?: string[];
	/** The complete approval map as of the last change, keyed like the settings file's `approval`. */
	approval?: Record<string, boolean>;
}

/**
 * The pure-data state of one session's ledger: what the session operations read and write, and
 * nothing else.
 *
 * Every session operation is a file-level function taking a `Session` as its first parameter —
 * no method holds this state between calls (the `SessionManager` class at the bottom of this file is
 * the stateless service over these functions: it adds the fill-at-open cache and nothing else). The
 * state is plain data on purpose: which function touches which field is visible
 * in the signatures, and a test can construct a bare state and call any operation on it directly.
 *
 * The fields are what the two files replay into. The identity is the bag's own — id, creation stamp,
 * the two file paths — and {@link SessionSetting} holds the `.json` snapshot's current choices,
 * regrouped in memory: the disk file stays flat, and the fill path / {@link metaOf} are the only
 * translation points. `jsonlEntries` is the `.jsonl` entry stream: every entry
 * carries an id and its parent's id, so the stream reads as a tree and `leafId` is where the
 * conversation currently is. Appending creates a child of the leaf; {@link branch} moves the leaf to
 * an earlier entry — and records the move as a {@link LeafEntry}, so a fresh reader restores it — so
 * a new line of work continues from there without touching what was already written. The entry
 * stream is never rewritten once it holds an entry, which is what lets an entry kind or a field this
 * build does not understand be carried through untouched; only the snapshot is rewritten whole, and
 * only on a change to a value it holds.
 *
 * Use {@link buildSessionContext} to get the messages a provider should be sent: it follows the
 * branch from root to leaf and folds in the newest compaction.
 */
export interface Session {
	sessionId: string;
	/** The ISO stamp the session was created at; the file name leads with the same moment. */
	timestamp: string;
	/** The `.jsonl` entry stream's path, absolute; the `.json` snapshot lives at the same stem. */
	sessionFileAbsPath?: string;
	/** The session directory, absolute; null for a session that is never written. */
	sessionDirAbsPath: string | null;
	persist: boolean;
	/**
	 * True once this session's files exist and hold the log as of the last write.
	 *
	 * It decides how the next write happens: false means nothing has been written yet, so the first
	 * entry worth keeping creates both files — the entry stream and the meta snapshot — at once;
	 * true means entries append and meta changes rewrite the snapshot. See {@link persistEntry}.
	 */
	fileCreated: boolean;
	/** The session's own choices, as the memory regrouping of the disk snapshot's flat fields. */
	sessionSetting: SessionSetting;
	jsonlEntries: SessionEntry[];
	sessionEntryMapById: SessionEntryMapById;
	leafId: string | null;
}

/**
 * Merge a disk snapshot's flat choice fields into the memory's regrouped setting.
 *
 * The one direction of the disk↔memory translation that reads a file: the thinking level folds
 * into `model`, everything else moves under its new name unchanged. Absent means absent — a
 * session that never chose keeps every field off the object, so "never chose" and "chose the
 * default" stay distinguishable.
 */
function sessionSettingOf(meta: SessionMeta): SessionSetting {
	return {
		workDirAbsPath: meta.workDir,
		...(meta.parentSession === undefined ? {} : { parentSessionId: meta.parentSession }),
		...(meta.title === undefined ? {} : { title: meta.title }),
		...(meta.model === undefined && meta.thinkingLevel === undefined
			? {}
			: { model: { ...meta.model, ...(meta.thinkingLevel === undefined ? {} : { thinkingLevel: meta.thinkingLevel }) } }),
		...(meta.activeTools === undefined ? {} : { activeTools: meta.activeTools }),
		...(meta.approval === undefined ? {} : { approval: meta.approval }),
	};
}

/**
 * Split the merged model choice back into the disk snapshot's two flat fields.
 *
 * The row is written only when both of its names are present — a model object carrying only a
 * thinking level is a level recorded with no row, and the disk holds that as `thinkingLevel` alone.
 * A session this build wrote always has both names on the row, so the split is lossless for
 * everything the disk can legally hold.
 */
function recordedModelOf(
	model: SessionSetting["model"],
): Pick<SessionMeta, "model" | "thinkingLevel"> {
	if (model === undefined) return {};
	const { name, modelId, thinkingLevel } = model;
	return {
		...(name === undefined || modelId === undefined ? {} : { model: { name, modelId } }),
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
	};
}

/**
 * The disk snapshot one session's memory state writes: the flat {@link SessionMeta} rebuilt from
 * the regrouped {@link SessionSetting}.
 *
 * The one direction of the disk↔memory translation that writes a file — {@link writeMetaFile}
 * serializes this, and `getMeta` hands the same shape to readers. The identity fields come from the
 * bag's own: the version is always this build's (the read side refuses anything else), and the
 * creation stamp travels on the bag because the file name cannot give it back losslessly.
 */
function metaOf(s: Session): SessionMeta {
	const setting = s.sessionSetting;
	return {
		version: CURRENT_SESSION_VERSION,
		id: s.sessionId,
		timestamp: s.timestamp,
		workDir: setting.workDirAbsPath,
		...(setting.parentSessionId === undefined ? {} : { parentSession: setting.parentSessionId }),
		...(setting.title === undefined ? {} : { title: setting.title }),
		...recordedModelOf(setting.model),
		...(setting.activeTools === undefined ? {} : { activeTools: setting.activeTools }),
		...(setting.approval === undefined ? {} : { approval: setting.approval }),
	};
}

/**
 * A state for a new session under `sessionDirInput` (default: the directory's own store), ready
 * for the first append.
 *
 * The session *directory* may be created here, but no file is: the files appear with the first entry
 * worth keeping — the gate in {@link persistEntry} (`hasConversation`) — so a session nobody has
 * spoken in leaves no transcript on disk and no row in the sidebar. That is the whole point of
 * building the state rather than writing a snapshot: the store is a record of conversations, and a
 * conversation with no message in it is not one yet.
 *
 * The cost is the id's addressability until that first message: {@link findSessionFilePathById} scans
 * the stores, so an id with no file cannot be found there. A caller that hands the id out and has
 * to answer for it later therefore holds the state (or the `SessionManager` shell around it) for the
 * length of that window — `SessionHub` holds it for the length of that window.
 */
export function createSession(
	workDirInput: string,
	sessionDirInput?: string,
	parentSessionFileInput?: string,
): Session {
	const absDir = sessionDirInput ? normalizePath(sessionDirInput) : sessionDir(workDirInput);
	if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });
	const s: Session = {
		sessionId: "",
		timestamp: "",
		sessionDirAbsPath: absDir,
		persist: true,
		fileCreated: false,
		sessionSetting: { workDirAbsPath: resolvePath(workDirInput) },
		jsonlEntries: [],
		sessionEntryMapById: new Map(),
		leafId: null,
	};
	newSession(s, parentSessionFileInput);
	return s;
}

/** A state for a session that is never written to disk. */
export function inMemorySession(workDirInput: string = process.cwd(), parentSessionFileInput?: string): Session {
	const s: Session = {
		sessionId: "",
		timestamp: "",
		sessionDirAbsPath: null,
		persist: false,
		fileCreated: false,
		sessionSetting: { workDirAbsPath: resolvePath(workDirInput) },
		jsonlEntries: [],
		sessionEntryMapById: new Map(),
		leafId: null,
	};
	newSession(s, parentSessionFileInput);
	return s;
}

/**
 * Replay a session's two files into a fresh {@link Session}: the one entry point that turns a path
 * on disk into the state the session operations work on.
 *
 * The `.json` snapshot gives the identity and the current choices; the `.jsonl` replays the entry
 * tree; the leaf is placed from the stream. A pair this build cannot open is *deleted*, not refused
 * and left in place — a v≤4 file, an unpaired half, a wrong version are all sessions nothing can
 * ever open again, and keeping them would put a ghost in every scan — and then the open throws. The
 * path may name either half: a caller that holds the `.jsonl` in hand passes it, and the snapshot
 * is found at the same stem.
 */
export function fillSession(absFilePath: string): Session {
	const absPath = resolvePath(absFilePath);
	const absJsonl = absPath.endsWith(".json") ? sessionJsonlPath(absPath) : absPath;
	const absJson = sessionMetaPath(absJsonl);
	if (!existsSync(absJsonl)) {
		// Unpaired either way: prune whatever half exists and refuse the open.
		if (existsSync(absJson)) pruneSessionFiles(absJson, absJsonl);
		throw new Error(`Session file does not exist: ${absJsonl}`);
	}
	let meta: SessionMeta;
	try {
		meta = readMetaFile(absJson);
	} catch (error) {
		pruneSessionFiles(absJson, absJsonl);
		throw error;
	}
	const entries = loadJsonlEntries(absJsonl);
	if (entries.length === 0) {
		// The entry stream cannot legally be empty while the snapshot exists: a birth writes both,
		// so an empty stream is a pair that died partway. Prune it with the rest.
		pruneSessionFiles(absJson, absJsonl);
		throw new Error(`Session file is not a valid ${APP_NAME} session: ${absJsonl}`);
	}
	const s: Session = {
		sessionId: meta.id,
		timestamp: meta.timestamp,
		sessionFileAbsPath: absJsonl,
		sessionDirAbsPath: dirname(absJsonl),
		persist: true,
		fileCreated: true,
		sessionSetting: sessionSettingOf(meta),
		jsonlEntries: entries,
		sessionEntryMapById: new Map(),
		leafId: null,
	};
	buildIndex(s);
	return s;
}

/**
 * Start a fresh session in `s`, discarding whatever it held. Returns the file path.
 *
 * `parentSessionFile` is the absolute path of the session this one descends from — a fork's
 * source — and it lands on the snapshot as `parentSession`. Undefined means
 * a root session. A relative path is resolved here against the process's cwd, which is the same
 * base a listing uses when it matches parent to child; recording it as given would let the two
 * sides disagree the moment the process ran somewhere else.
 *
 * The two constructors above are its only callers: a bag is born here, and every later write goes
 * through the service's append and record methods.
 */
export function newSession(s: Session, parentSessionFile?: string): string | undefined {
	s.sessionId = createSessionId();
	s.timestamp = new Date().toISOString();
	s.sessionSetting = {
		workDirAbsPath: s.sessionSetting.workDirAbsPath,
		...(parentSessionFile === undefined ? {} : { parentSessionId: resolvePath(parentSessionFile) }),
	};
	s.jsonlEntries = [];
	s.sessionEntryMapById.clear();
	s.leafId = null;
	s.fileCreated = false;

	const dir = s.sessionDirAbsPath;
	if (s.persist && dir !== null) s.sessionFileAbsPath = sessionPath(dir, s.sessionId, s.timestamp);
	return s.sessionFileAbsPath;
}

/** Index `s`'s entries by id and place the leaf, in file order. */
function buildIndex(s: Session): void {
	s.sessionEntryMapById.clear();
	s.leafId = null;
	for (const entry of s.jsonlEntries) {
		s.sessionEntryMapById.set(entry.id, entry);
		if (entry.type === "leaf") {
			// The record names where the conversation went; every other kind *is* where it went, by
			// having been appended. File order is the last word, so a later entry of any kind
			// supersedes what an earlier record said. A recorded null is a position of its own —
			// "before the first entry" — and only a target the file does not hold (only a
			// hand-edited file can manage that) falls back to the record's own tree position, the
			// same family of answer `buildSessionPath` gives an unknown id.
			s.leafId = entry.leafId === null || s.sessionEntryMapById.has(entry.leafId) ? entry.leafId : (entry.parentId ?? null);
		} else {
			s.leafId = entry.id;
		}
	}
}

/** True once the session holds a user or assistant message, which is what makes it worth keeping. */
function hasConversation(s: Session): boolean {
	return s.jsonlEntries.some(
		(entry) => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
	);
}

/**
 * Rewrite the `.json` snapshot whole: write a sibling temp file, then rename it over the snapshot.
 *
 * A snapshot wants one write, not an append — and a reader scanning the store must never catch it
 * half-written, which is what the rename buys: the temp is written, closed, and moved into place in
 * one step, so every reader either sees the old snapshot or the new one, never a torn one. The
 * rename is within one directory, so it is atomic on the filesystems this runs on.
 */
function writeMetaFile(s: Session): void {
	const absJsonl = s.sessionFileAbsPath;
	if (absJsonl === undefined) return;
	const absJson = sessionMetaPath(absJsonl);
	const absTemp = `${absJson}.${process.pid}.tmp`;
	const fd = openSync(absTemp, "wx");
	try {
		writeFileSync(fd, `${JSON.stringify(metaOf(s), null, "\t")}\n`);
	} finally {
		closeSync(fd);
	}
	renameSync(absTemp, absJson);
}

/**
 * Write one entry to disk, or hold it back when the files do not exist yet.
 *
 * The gate is deliberate: a session earns its files with its first message (`hasConversation`), so a
 * session nobody has spoken in never lands on disk. The first write that passes the gate creates
 * both files at once — the whole entry stream, then the meta snapshot as the commit marker — because
 * there was nothing there to have received them; the snapshot is written **last** so a birth that
 * dies partway leaves an unpaired half, which the store scans prune rather than keep. From then on
 * (`fileCreated`) each entry appends by itself and each meta change rewrites the snapshot.
 */
export function persistEntry(s: Session, entry: SessionEntry): void {
	if (!s.persist || !s.sessionFileAbsPath) return;

	if (!s.fileCreated) {
		if (!hasConversation(s)) return;
		const fd = openSync(s.sessionFileAbsPath, "wx");
		try {
			for (const existing of s.jsonlEntries) writeFileSync(fd, `${JSON.stringify(existing)}\n`);
		} catch (error) {
			// A stream that did not make it to disk leaves nothing behind; the next gated write
			// retries the birth from the same in-memory log.
			closeSync(fd);
			rmSync(s.sessionFileAbsPath, { force: true });
			throw error;
		}
		closeSync(fd);
		writeMetaFile(s);
		s.fileCreated = true;
		return;
	}

	appendFileSync(s.sessionFileAbsPath, `${JSON.stringify(entry)}\n`);
}

/** Add `entry` to the log as the new leaf, in memory and on disk. */
function appendEntry(s: Session, entry: SessionEntry): void {
	s.jsonlEntries.push(entry);
	s.sessionEntryMapById.set(entry.id, entry);
	s.leafId = entry.id;
	persistEntry(s, entry);
}

/**
 * Apply one change to the snapshot, and rewrite the file when it actually changed.
 *
 * The mutation lands on the in-memory setting first — that is the bag every reader answers from — and
 * the disk copy follows only when the session has files to rewrite. A session whose files are not
 * born yet keeps the change in memory alone: {@link persistEntry} writes the snapshot at birth, so
 * a choice made before the first message survives without breaking the "no conversation, no files"
 * rule. `change` returns false for a no-op, which is what keeps a run of identical writes from
 * costing a rewrite each.
 */
function recordMeta(s: Session, change: (setting: SessionSetting) => boolean): void {
	if (!change(s.sessionSetting)) return;
	if (s.persist && s.fileCreated) writeMetaFile(s);
}

/** Set equality over two tool-name lists: the recorded set is a choice, not an order. */
function sameToolSet(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name) => right.includes(name));
}

/** Field equality over the two approval maps, over every key either side names. */
function metasApprovalEqual(left: Record<string, boolean>, right: Record<string, boolean>): boolean {
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) {
		if (left[key] !== right[key]) return false;
	}
	return true;
}

// =========================================================================
// Tree traversal
// =========================================================================

/** Every entry's children, in file order, built in one pass over the log. */
function childrenIndex(s: Session): Map<string, SessionEntry[]> {
	const index = new Map<string, SessionEntry[]>();
	for (const entry of s.sessionEntryMapById.values()) {
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
function subtreeDescription(
	s: Session,
	entryId: string,
	children: Map<string, SessionEntry[]>,
	memo: Map<string, SubtreeDescription>,
): SubtreeDescription {
	const cached = memo.get(entryId);
	if (cached !== undefined) return cached;
	// Seeded before the descent: this is what a file hand-edited into a cycle finds when it comes
	// back around, so the walk ends there instead of spinning.
	memo.set(entryId, { tip: entryId, message: false, label: "" });

	const entry = s.sessionEntryMapById.get(entryId);
	const descents = (children.get(entryId) ?? []).map((child) =>
		subtreeDescription(s, child.id, children, memo),
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
 * Write one leaf record as a child of the leaf it leaves behind, without moving the leaf.
 *
 * The caller sets {@link Session.leafId} right after: an append advances the leaf, and this one
 * must not — the record's place in the tree and the position it reports are two facts, each with its
 * own field.
 */
function appendLeafRecord(s: Session, leafId: string | null): void {
	const entry: LeafEntry = {
		type: "leaf",
		id: generateId(s.sessionEntryMapById),
		parentId: s.leafId,
		timestamp: new Date().toISOString(),
		leafId,
	};
	s.jsonlEntries.push(entry);
	s.sessionEntryMapById.set(entry.id, entry);
	persistEntry(s, entry);
}

/**
 * The session service: the ledger's operations, and the file I/O under them.
 *
 * Every per-session method takes its {@link Session} as the first parameter and does the work
 * here — there is no second layer of same-named file-level functions to forward to, so a caller
 * reading this file reads the implementation. The class holds no per-session state (ADR-0007 §2)
 * and no cache: a bag is owned by whoever filled or built it, and the orchestrator's table
 * (`Agent`) is the only place a running session's bag is held between calls.
 *
 * What the class does own is the store's format knowledge: how an id becomes a file path
 * ({@link SessionManager.findSessionFilePathById}), how a file becomes a bag
 * ({@link fillSession}, with its pruning and version refusal), and how a write reaches the disk
 * (`persistEntry`, `writeMetaFile`).
 */
export class SessionManager {
	/**
	 * Append a message as a child of the leaf and advance the leaf. Returns the new entry's id.
	 *
	 * A compaction summary is deliberately not accepted here: it has to be a top-level entry so that
	 * {@link SessionManager.buildContextEntries} can find it, which is what {@link appendCompaction}
	 * is for.
	 */
	appendMessage(s: Session, message: Message): string {
		const entry: MessageEntry = {
			type: "message",
			id: generateId(s.sessionEntryMapById),
			parentId: s.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		appendEntry(s, entry);
		return entry.id;
	}

	/**
	 * Record the thinking level this session last asked at, as the snapshot's current value.
	 *
	 * Not an entry: the level is a *current value*, so the `.json` snapshot holds it and the history
	 * of what it was before is gone by design — nothing ever read it. A session whose files are not
	 * born yet carries the change in memory; {@link persistEntry} writes the snapshot at birth, so
	 * the choice survives without breaking the "no conversation, no files" rule.
	 */
	setThinkingLevel(s: Session, thinkingLevel: string): void {
		recordMeta(s, (setting) => {
			if (setting.model?.thinkingLevel === thinkingLevel) return false;
			setting.model = { ...(setting.model ?? {}), thinkingLevel };
			return true;
		});
	}

	/**
	 * Record the model row this session last ran on, as the snapshot's current value.
	 *
	 * `name` is the row's identity — see `ModelConfig` — so this is what later turns "which model
	 * was this session on" back into a row. Not an entry: the choice is a *current value*, and the
	 * snapshot holds only what is in force. A rename is deliberately not this: a rename is the same
	 * model under another name, and the refs built from the old name are already accounted for.
	 */
	setModel(s: Session, name: string, modelId: string): void {
		recordMeta(s, (setting) => {
			if (setting.model?.name === name && setting.model.modelId === modelId) return false;
			setting.model = { ...(setting.model ?? {}), name, modelId };
			return true;
		});
	}

	/**
	 * Rewrite the snapshot from the bag, whatever the change detectors think.
	 *
	 * The setters' gates compare against the bag — the bag is what every reader answers from — so a
	 * change already in the bag but not yet on the disk passes them silently: the disk holds the
	 * choice the session was last made with, and the bag the one in force can differ from it. This is
	 * the escape hatch: the whole bag goes to the snapshot in one atomic rewrite. A session whose
	 * files are not born yet keeps the bag as it is; the birth write picks it up whole.
	 */
	flushMeta(s: Session): void {
		if (s.persist && s.fileCreated) writeMetaFile(s);
	}

	/**
	 * Record the session's tool choices: the active set and the approval map, both whole.
	 *
	 * A snapshot rather than a delta, because the reader takes the value in force — the same
	 * contract the model and level follow. Both maps are always present, so one call made for a
	 * tool change carries the approval set along and the other way round.
	 */
	setToolConfig(s: Session, activeTools: string[], approval: Record<string, boolean>): void {
		recordMeta(s, (setting) => {
			if (
				setting.activeTools !== undefined &&
				sameToolSet(setting.activeTools, activeTools) &&
				setting.approval !== undefined &&
				metasApprovalEqual(setting.approval, approval)
			) {
				return false;
			}
			setting.activeTools = [...activeTools];
			setting.approval = { ...approval };
			return true;
		});
	}

	/**
	 * Record the conversation's own name, over the derived one.
	 *
	 * The title is expected already shortened — the endpoint that takes a user's typing applies
	 * {@link shortenTitle} before it gets here, so what lands in the snapshot is what a row shows.
	 * Not an entry: the name is a fact about the session rather than about one way through it (the
	 * reading ADR-0002 argued for from file order), and the snapshot states it directly.
	 */
	setTitle(s: Session, title: string): void {
		recordMeta(s, (setting) => {
			if (setting.title === title) return false;
			setting.title = title;
			return true;
		});
	}

	/**
	 * Record spend that owns no message entry, attributed to `operation` on `model`.
	 *
	 * The whole spend travels in one entry, summed by the writer — a delegation runs many requests on
	 * its own transcript, and this file wants the total, not the receipt list. Zero-usage records are
	 * the caller's to skip: an entry costs a line, and a spend of nothing is not a fact worth one.
	 */
	appendUsage(s: Session, operation: string, model: string, usage: Usage): string {
		const entry: UsageEntry = {
			type: "usage",
			id: generateId(s.sessionEntryMapById),
			parentId: s.leafId,
			timestamp: new Date().toISOString(),
			operation,
			model,
			usage,
		};
		appendEntry(s, entry);
		return entry.id;
	}

	/**
	 * Record a compaction checkpoint: everything up to `firstKeptEntryId` is replaced by `summary`.
	 *
	 * `firstKeptEntryId` of null means this compaction keeps no earlier entry, so the checkpoint is the
	 * whole remaining history and the entry points at itself.
	 */
	appendCompaction(
		s: Session,
		summary: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		usage?: Usage,
	): string {
		const timestamp = new Date().toISOString();
		const id = generateId(s.sessionEntryMapById);
		const entry: CompactionEntry = {
			type: "compaction",
			id,
			parentId: s.leafId,
			timestamp,
			summary,
			firstKeptEntryId: firstKeptEntryId ?? id,
			tokensBefore,
			...(usage === undefined ? {} : { usage }),
		};
		appendEntry(s, entry);
		return entry.id;
	}

	/**
	 * Record that tool results were cleared: the named entries keep their place in the file and lose
	 * their text in the view.
	 *
	 * Unlike a compaction there is nothing to hold back — the results are cleared precisely because a
	 * run can reproduce them — so the record is only the ids and what the clear was worth.
	 */
	appendClearToolResults(s: Session, clearedEntryIds: readonly string[], tokensBefore: number): string {
		const entry: ClearToolResultEntry = {
			type: "clear_tool_result",
			id: generateId(s.sessionEntryMapById),
			parentId: s.leafId,
			timestamp: new Date().toISOString(),
			clearedEntryIds: [...clearedEntryIds],
			tokensBefore,
		};
		appendEntry(s, entry);
		return entry.id;
	}

	/**
	 * Record that tool-call arguments were shortened: the named entries keep their place in the file
	 * and lose the heavy bodies of their arguments in the view.
	 *
	 * Like a clear, there is nothing to hold back — the arguments named belong to calls whose results
	 * are already on the branch — so the record is only the ids and what the trim was worth.
	 */
	appendTrimToolCallArgs(s: Session, trimmedEntryIds: readonly string[], tokensBefore: number): string {
		const entry: TrimToolCallArgEntry = {
			type: "trim_tool_call_arg",
			id: generateId(s.sessionEntryMapById),
			parentId: s.leafId,
			timestamp: new Date().toISOString(),
			trimmedEntryIds: [...trimmedEntryIds],
			tokensBefore,
		};
		appendEntry(s, entry);
		return entry.id;
	}

	/** Every entry that follows `parentId`, in file order. */
	getChildren(s: Session, parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of s.sessionEntryMapById.values()) {
			if (entry.parentId === parentId) children.push(entry);
		}
		return children;
	}

	/**
	 * The branch points of the log, in file order.
	 *
	 * A child counts as an alternative only when a message is reachable through it: this format carries
	 * state entries too — a tool-result clear, a compaction, a leaf record — and a
	 * conversation cannot be resumed at one of those, so counting them would offer an empty
	 * alternative. A state entry in front of a message is descended through for the same reason:
	 * rewinding, trimming the view, and asking again is one alternative, not two.
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
	getBranchPoints(s: Session): BranchPoint[] {
		const chain = this.getBranch(s);
		const onChain = new Set(chain.map((entry) => entry.id));
		const children = childrenIndex(s);
		const memo = new Map<string, SubtreeDescription>();

		// Pass one: which entries were carried on from in more than one way, and what each
		// continuation amounts to. Nothing is placed yet — an anchor is only knowable once every point
		// is known, because a card is either a user message on the line or an earlier point's option.
		const forks: { entry: SessionEntry; options: BranchOption[] }[] = [];
		for (const entry of s.sessionEntryMapById.values()) {
			const options: BranchOption[] = [];
			for (const child of children.get(entry.id) ?? []) {
				const described = subtreeDescription(s, child.id, children, memo);
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
			let current: SessionEntry | undefined = s.sessionEntryMapById.get(entryId);
			while (current !== undefined) {
				if (isCard(current)) return current.id;
				current = current.parentId === null ? undefined : s.sessionEntryMapById.get(current.parentId);
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
			const entry = s.sessionEntryMapById.get(entryId);
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
	getBranchTip(s: Session, entryId: string): string {
		if (!s.sessionEntryMapById.has(entryId)) throw new Error(`Entry ${entryId} not found`);
		return subtreeDescription(s, entryId, childrenIndex(s), new Map()).tip;
	}

	/**
	 * Walk from `fromId` to the root, in path order, every entry kind included.
	 *
	 * This is the raw branch; {@link SessionManager.buildContextEntries} is the same walk with
	 * compaction applied, and is what a provider request is built from.
	 */
	getBranch(s: Session, fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const startId = fromId ?? s.leafId;
		let current = startId ? s.sessionEntryMapById.get(startId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? s.sessionEntryMapById.get(current.parentId) : undefined;
		}
		path.reverse();
		return path;
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
	 */
	buildContextEntries(s: Session): SessionEntry[] {
		return contextEntriesFromPath(buildSessionPath(s.sessionEntryMapById, s.leafId));
	}

	/**
	 * Build the transcript the model is sent, from a branch of the entries.
	 *
	 * This is the one method that turns storage into a request, and it is why a resumed session and a
	 * live one cannot drift: both go through here. The path is walked once and shared by the settings
	 * read and the view, so asking for both costs one walk rather than two.
	 */
	buildSessionContext(s: Session): SessionContext {
		const chain = buildSessionPath(s.sessionEntryMapById, s.leafId);
		const { thinkingLevel, model } = getSessionContextSettings(s.sessionSetting, chain);
		const messages = contextEntriesFromPath(chain).flatMap(sessionEntryToContextMessages);
		return { messages, thinkingLevel, model };
	}

	/**
	 * The model and thinking level the session's snapshot on disk records, each undefined when it
	 * never chose.
	 *
	 * The disk copy, not the bag, is the write baseline for a caller that commits a choice: the bag
	 * already carries the choice in force, so comparing against it is self-comparison and never sees
	 * a difference. Read fresh each call, not cached, so the baseline is the file's own. A session
	 * whose files are not born yet has no snapshot to read and answers with the empty record — the
	 * birth write picks the bag up whole.
	 */
	recordedOnDisk(s: Session): { model?: { name: string; modelId: string }; thinkingLevel?: string } {
		if (!s.fileCreated || s.sessionFileAbsPath === undefined) return {};
		return recordedModelOf(sessionSettingOf(readMetaFile(sessionMetaPath(s.sessionFileAbsPath))).model);
	}

	/**
	 * The model and thinking level this session is on, each undefined when it never chose.
	 *
	 * {@link SessionManager.buildSessionContext} answers with those values and the defaults to run with.
	 * This is for a caller that has to tell "the session chose off" from "the session never chose" —
	 * assembly, which decides whether a stored value may override the settings file. The snapshot is
	 * the first word and the transcript the fallback: the model falls back to the branch's last
	 * assistant message, which can only name a row the user left unnamed.
	 */
	getRecordedSettings(s: Session): { model?: { name: string; modelId: string }; thinkingLevel?: string } {
		const recorded: { model?: { name: string; modelId: string }; thinkingLevel?: string } =
			recordedModelOf(s.sessionSetting.model);
		if (recorded.model === undefined) {
			// Only ever a fallback, and a weak one: a message records the wire id it was answered by,
			// not the row's identity, so this can only name a row the user left unnamed. See
			// {@link getSessionContextSettings}.
			for (const entry of this.getBranch(s)) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					recorded.model = { name: entry.message.model, modelId: entry.message.model };
				}
			}
		}
		return recorded;
	}

	/**
	 * The tool choices this session last recorded, each undefined when it never chose.
	 *
	 * Undefined is meaningful and is what this exists to preserve: a session that never chose opens
	 * on the defaults, while one that did reopens exactly as its user left it. The snapshot is the
	 * whole answer, so this reads the session rather than the branch — which is also what changed
	 * with the two-file split: moving the leaf no longer switches these values, because they are the
	 * session's, not a branch's.
	 */
	getRecordedToolConfig(s: Session): { activeTools?: string[]; approval?: Record<string, boolean> } {
		return { activeTools: s.sessionSetting.activeTools, approval: s.sessionSetting.approval };
	}

	/**
	 * The entry id behind each message in {@link SessionManager.buildSessionContext}'s list, in the same order.
	 *
	 * A compaction checkpoint produces messages that belong to no message entry, so those read as null.
	 * This is what a transcript needs to offer "fork from here" on a message it never watched being
	 * written.
	 */
	getContextMessageEntryIds(s: Session): (string | null)[] {
		const ids: (string | null)[] = [];
		for (const entry of this.buildContextEntries(s)) {
			const produced = sessionEntryToContextMessages(entry).length;
			for (let index = 0; index < produced; index++) ids.push(entry.type === "message" ? entry.id : null);
		}
		return ids;
	}

	/**
	 * The `.json` snapshot's flat shape, rebuilt from the session's regrouped setting: identity and
	 * current choices. Always present on a built session.
	 */
	getMeta(s: Session): SessionMeta {
		return metaOf(s);
	}

	/** Every entry in file order. Use the `append*` methods to add more. */
	getEntries(s: Session): SessionEntry[] {
		return s.jsonlEntries;
	}

	/**
	 * The conversation's own name: a recorded title if there is one, else the branch's first user
	 * message, else a placeholder.
	 *
	 * The recorded title comes from the snapshot, and that placement is deliberate: the left column
	 * draws one row per session, not per way through it, so a name a person gave the session does not
	 * stop being theirs because the leaf moved — which is exactly the reading ADR-0002 argued for,
	 * now stated by the format instead of reconstructed from file order. The branch walk below stays
	 * exactly as it was — it is the fallback, and summarizing the oldest turn away still cannot
	 * rename the session.
	 */
	getTitle(s: Session): string {
		if (s.sessionSetting.title !== undefined) return s.sessionSetting.title;
		return deriveTitle(this.getBranch(s).flatMap(sessionEntryToContextMessages));
	}

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
	 * the position already held writes nothing, the same guard the meta setters apply to their own
	 * writes: a run of no-op moves costs no file.
	 */
	branch(s: Session, branchFromId: string): void {
		if (!s.sessionEntryMapById.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		if (s.leafId === branchFromId) return;
		appendLeafRecord(s, branchFromId);
		s.leafId = branchFromId;
	}

	/** Move the leaf before the first entry, so the next append becomes a new root. */
	resetLeaf(s: Session): void {
		if (s.leafId === null) return;
		appendLeafRecord(s, null);
		s.leafId = null;
	}

	/**
	 * Replay the session `id` names into a bag this call owns: no registration, no cache, and the
	 * caller drops it when it is done.
	 *
	 * This is the cold path, and the only one: a session this process is running is written through
	 * the bag its orchestrator holds (`Agent`'s table), never through a replay of its file — the
	 * snapshot is written whole, so a stale bag would revert whatever that session's turns just
	 * recorded. What it answers is a pair that was born: the `.json` snapshot is the birth's commit
	 * marker, so an id it matches names a `.jsonl` beside it, and an id neither file names is refused
	 * with the same sentence every reader of this store uses. A pair that exists but cannot be opened
	 * is pruned by {@link fillSession} itself, so this is a read that can delete.
	 *
	 * A cold write is two moves, not three — this for the bag, then a setter, which writes the file
	 * itself (`setTitle` records the meta, and recording persists). There is no third persist verb to
	 * remember, and no dirty state to flush. Safety here is not a hold's work: while a session is
	 * held, its only writer is the bag the orchestrator holds; when it is not held, one cold write is
	 * one synchronous block no other writer can step into — and the two windows never overlap,
	 * because the cold path only serves sessions nothing holds.
	 */
	open(id: string): Session {
		const absPath = SessionManager.findSessionFilePathById(id);
		if (absPath === undefined) throw new UnknownSessionError(id);
		return fillSession(absPath);
	}

	// =========================================================================
	// Construction and discovery
	// =========================================================================

	/**
	 * Copy a branch of a session into a new session beside its source, and name what was written.
	 *
	 * `entryId` is the entry the branch ends at, or null for the whole log. The new snapshot points at
	 * the source's entry stream as `parentSession`, and the copied entries keep the ids and parent
	 * links the source wrote, which is what makes a fork traceable back to where it came from. The
	 * snapshot's current choices travel whole — title, model, level, tool config — because those are
	 * the session's own values now, not entries a branch replay could restore. The working directory
	 * is the source header's own: the fork is written where its source lives, and the caller is not
	 * asked to replay the file to learn where that is.
	 *
	 * The source is only read: a fork is a new pair of files, and the session it came from is never
	 * rewritten. The fork fills nothing and registers nothing — the files are the whole of what it
	 * returns, and the new session's first bag comes from its first {@link open}, which reads the
	 * pair just written. Both files are written synchronously before this returns, with the snapshot
	 * last (`wx`, the birth's commit marker), so an id handed out here is openable by the time the
	 * caller has it.
	 */
	forkFrom(
		sourcePathInput: string,
		entryId: string | null,
		sessionDirInput?: string,
	): { sessionId: string; sessionFileAbsPath: string } {
		const absSourcePath = resolvePath(sourcePathInput);
		const absSourceJsonl = absSourcePath.endsWith(".json") ? sessionJsonlPath(absSourcePath) : absSourcePath;
		const sourceMeta = readMetaFile(sessionMetaPath(absSourceJsonl));
		const sourceEntries = loadJsonlEntries(absSourceJsonl);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${absSourceJsonl}`);
		}

		const branch = entryId === null ? sourceEntries : buildSessionPath(buildEntryIndex(sourceEntries), entryId);
		if (entryId !== null && branch.length === 0) {
			throw new Error(`Session ${sourceMeta.id} has no entry ${entryId}`);
		}

		// The header is the workDir's one authority: it named the source's tools' frame, and the fork
		// lives in the same conversation, so it keeps the same frame.
		const absTargetWorkDir = resolvePath(sourceMeta.workDir);
		const absDir = sessionDirInput ? normalizePath(sessionDirInput) : sessionDir(absTargetWorkDir);
		if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const absNewSessionFile = sessionPath(absDir, newSessionId, timestamp);
		const meta: SessionMeta = {
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			workDir: absTargetWorkDir,
			parentSession: absSourceJsonl,
			...(sourceMeta.title === undefined ? {} : { title: sourceMeta.title }),
			...(sourceMeta.model === undefined ? {} : { model: sourceMeta.model }),
			...(sourceMeta.thinkingLevel === undefined ? {} : { thinkingLevel: sourceMeta.thinkingLevel }),
			...(sourceMeta.activeTools === undefined ? {} : { activeTools: sourceMeta.activeTools }),
			...(sourceMeta.approval === undefined ? {} : { approval: sourceMeta.approval }),
		};
		writeFileSync(absNewSessionFile, branch.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { flag: "wx" });
		writeFileSync(sessionMetaPath(absNewSessionFile), `${JSON.stringify(meta, null, "\t")}\n`, { flag: "wx" });

		return { sessionId: newSessionId, sessionFileAbsPath: absNewSessionFile };
	}

	/** Every session stored for `workDir`, newest activity first. */
	static async list(workDirInput: string, sessionDirInput?: string, signal?: AbortSignal): Promise<SessionInfo[]> {
		const absDir = sessionDirInput ? normalizePath(sessionDirInput) : sessionDir(workDirInput);
		const filterWorkDir = sessionDirInput !== undefined && absDir !== sessionDir(workDirInput);
		const workDirAbsPath = resolvePath(workDirInput);
		const sessions = (await listSessionsFromDir(absDir, signal)).filter(
			(session) => !filterWorkDir || sessionWorkDirMatches(session.workDirAbsPath, workDirAbsPath),
		);
		return sortSessionInfos(sessions);
	}

	/**
	 * Every directory this machine has stored sessions for, each with its own list.
	 *
	 * The sidebar groups by directory, and one process is only ever started in one of them, so the
	 * grouping has to come from the store rather than from the server's own root. The workDir is read from
	 * a session header instead of being decoded back out of the directory name: the name dashes the
	 * separators out of a path, which is readable but not reversible.
	 *
	 * Directories come back most recently active first, and the empty ones — a store left behind by
	 * a session whose file was deleted — are dropped rather than shown as headless groups.
	 */
	static async listDirectories(signal?: AbortSignal): Promise<DirectorySessions[]> {
		let absDirs: string[];
		try {
			absDirs = readdirSync(sessionsDir(), { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(sessionsDir(), entry.name));
		} catch {
			// No sessions directory is the normal first run.
			return [];
		}

		const groups: DirectorySessions[] = [];
		for (const absDir of absDirs) {
			const absNewest = findMostRecentSession(absDir);
			if (absNewest === null) continue;
			const meta = readMetaForDiscovery(absNewest);
			const workDirAbsPath = meta?.workDir;
			if (workDirAbsPath === undefined || workDirAbsPath === "") continue;

			const sessions = (await SessionManager.list(workDirAbsPath, absDir, signal)).map(toSessionRow);
			if (sessions.length === 0) continue;
			groups.push({ workDirAbsPath, sessions });
		}

		return groups.sort((a, b) => newestAt(b) - newestAt(a));
	}

	/**
	 * The one row a session id names, from whichever directory holds it, or `undefined` when no file
	 * does.
	 *
	 * The listing answers the same question for every session at once, which is the wrong cost when
	 * exactly one session is what changed — one just created, or just forked, or one the store picked
	 * up by hand. So this locates that one session and parses only it: a session appearing costs one
	 * parse rather than a scan of the machine. The locate half is the snapshot read, not a transcript
	 * read; only the session that matched has its `.jsonl` parsed.
	 */
	static async findSessionRowById(id: string, signal?: AbortSignal): Promise<SessionRow | undefined> {
		const absPath = SessionManager.findSessionFilePathById(id);
		if (absPath === undefined) return undefined;
		const meta = readMetaForDiscovery(absPath);
		if (meta === null) return undefined;
		const info = await buildSessionInfo(sessionMetaPath(absPath), absPath, meta, signal);
		if (info === null) return undefined;
		// A fork's parent is named by *path* in the snapshot, so it is knowable from one session alone
		// once that path is resolved to an id — which matters because a fork reaches a store one row at
		// a time, where the listing that would have linked it is not in play.
		if (info.parentId === undefined && info.absParentSessionPath !== undefined) {
			const parent = readMetaForDiscovery(info.absParentSessionPath);
			const parentId = parent?.id;
			if (parentId !== undefined && parentId !== info.id) info.parentId = parentId;
		}
		return toSessionRow(info);
	}

	/**
	 * The path of the entry stream a session id names, searching every directory store on this
	 * machine.
	 *
	 * A session opened from the sidebar may live in a directory this process was not started in, and
	 * its snapshot — not the server's root — is what says which directory its tools resolve inside.
	 * The search is snapshot reads only: every candidate `.json` is opened and closed whole, so a
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
					if (!file.endsWith(".json")) continue;
					const absJson = join(absDir, file);
					const meta = readMetaForDiscovery(absJson);
					// A `.json` is only ever written beside its `.jsonl` — the snapshot is the birth's
					// commit marker — so an id match here can answer with the stream path directly.
					if (meta?.id === id) return sessionJsonlPath(absJson);
				}
			} catch {
				// One unreadable directory must not hide a session stored in another.
				continue;
			}
		}
		return undefined;
	}

	/**
	 * Delete the session an id names, from whichever directory holds it.
	 *
	 * One session, not a directory: a directory's sessions share one store, so anything wider than
	 * the two files one session is named by is a different conversation's transcript. Throwing for an
	 * unknown id rather than answering "already gone" keeps the two failures apart — the caller
	 * decides what a second delete means, and the hub turns it into a status the client can show.
	 *
	 * Pure file I/O: whatever table held a live bag for this id is someone else's, and the caller
	 * that decided the session is gone forgets that half itself (`Agent.remove`).
	 */
	async remove(id: string): Promise<void> {
		const absPath = SessionManager.findSessionFilePathById(id);
		if (absPath === undefined) throw new UnknownSessionError(id);
		await rm(absPath);
		await rm(sessionMetaPath(absPath));
	}

}

/** The most recent activity in a group, for ordering the sidebar's directories. */
function newestAt(group: DirectorySessions): number {
	return group.sessions.reduce((newest, session) => Math.max(newest, session.modified), 0);
}

/**
 * Group rows by directory and order them the way the sidebar draws them.
 *
 * Newest activity first within a group, and groups ordered by their own newest row. Exported because
 * the server's projection holds the same rows and has to order them the same way — a store and a
 * reader that each sorted for themselves would disagree the moment a row moved.
 */
export function groupSessionsByDirectory(rows: readonly SessionRow[]): DirectorySessions[] {
	const groups = new Map<string, SessionRow[]>();
	for (const row of rows) {
		const group = groups.get(row.workDirAbsPath);
		if (group === undefined) groups.set(row.workDirAbsPath, [row]);
		else group.push(row);
	}
	return [...groups.entries()]
		.map(([workDirAbsPath, sessions]) => ({ workDirAbsPath, sessions }))
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
		workDirAbsPath: info.workDirAbsPath,
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
