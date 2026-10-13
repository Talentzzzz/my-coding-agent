import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { AgentMessage } from "@my-agent/agent";
import { getCurrentSystemMessage, type SystemMessage, type Usage, uuidv7 } from "@my-agent/ai";
import { APP_NAME } from "../config.ts";
import { trimToolCallArgs } from "../context/argtrim.ts";
import { clearToolResult } from "../context/pruning.ts";
import type { SessionRef, SessionRow, ToolApprovalKey } from "../protocol.ts";
import { createCompactionSummaryMessage } from "./messages.ts";
import { normalizePath, resolvePath, sessionPath, sessionsDir, workspaceDir } from "./paths.ts";

/**
 * The on-disk shape this build writes.
 *
 * pi numbers its session format, and the number is kept so a file says which generation wrote it:
 * 1 is flat records with no ids, 2 gave every entry `id`/`parentId` so the file became a tree, and 3
 * renamed the `hookMessage` role to `custom`. Only 3 is produced here, and the entry kinds this build
 * knows are the ones in {@link SessionEntry}.
 *
 * There is deliberately no migration. A file from an older build is refused when it cannot be read as
 * one of ours and left exactly as it is otherwise, because rewriting a session this code does not
 * understand is the one way to lose one.
 */
export const CURRENT_SESSION_VERSION = 3;

export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	/**
	 * The session file this one was forked from.
	 *
	 * A path, not an id, because a fork is traceable to the file it copied, and the file is what a
	 * reader has in hand. The copied entries keep their original ids on top of that.
	 */
	parentSession?: string;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

/**
 * The row this session switched to, recorded as the name it carries.
 *
 * `name` is the row's identity — see `UserModel` — so this entry is what later turns "which model was
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
export function modelChangeName(entry: { name?: string; provider?: string }): string | undefined {
	return entry.name ?? entry.provider;
}

export interface CompactionEntry<T = unknown> {
	type: "compaction";
	id: string;
	parentId: string | null;
	timestamp: string;
	summary: string;
	/** The first entry the model still sees; everything before it was folded into `summary`. */
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Extension-specific data, carried through untouched. */
	details?: T;
	/** Usage from the call that generated the summary, when it is known. */
	usage?: Usage;
	/** The prompt and tool state at this boundary, when the transcript carried one. */
	systemMessage?: SystemMessage;
}

/**
 * A record of tool results this build cleared out of the view.
 *
 * The results stay in the file — this format never rewrites a line — so the record names them instead
 * and {@link buildContextEntries} applies it. That is the same shape as a compaction: an entry that
 * changes what earlier entries mean rather than changing them, which is what keeps the file a full
 * record and the transcript a view of it.
 */
export interface PruneEntry extends SessionEntryBase {
	type: "prune";
	/** The entries whose results this record cleared: still in the file, no longer in the view. */
	clearedEntryIds: string[];
	/** The estimated prompt size before the prune, so the record says what it was worth. */
	tokensBefore: number;
}

/**
 * A record of tool-call arguments this build shortened in the view.
 *
 * Same shape of decision as a prune: the arguments stay whole in the file — this format never
 * rewrites a line — and the record names the message entries whose recorded arguments are shortened,
 * which {@link buildContextEntries} applies. The heavy bodies a `write` or an `edit` carried live in
 * the file they changed; the view keeps only enough of them to say what was written where.
 */
export interface ArgTrimEntry extends SessionEntryBase {
	type: "argtrim";
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

export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| PruneEntry
	| ArgTrimEntry
	| ToolConfigEntry
	| LeafEntry;

/** One line of the file, header included. */
export type FileEntry = SessionHeader | SessionEntry;

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { name: string; modelId: string } | null;
}

export interface SessionInfo {
	path: string;
	id: string;
	/** Working directory the session was started in. Empty for a file whose header has none. */
	cwd: string;
	/** Path to the file this session was forked from, if the header names one. */
	parentSessionPath?: string;
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
	/** The role of that message, so a label can say who speaks. */
	role: string;
	/** True for the alternative the active chain leads through. */
	active: boolean;
}

/**
 * A message the conversation carried on from in more than one way.
 *
 * The entry tree has always had these — an entry may have any number of children — and this is the
 * shape of one a window can draw: the entry on the active chain to hang a switcher on, and the
 * continuations to choose between, in the order they were written.
 */
export interface BranchPoint {
	/** The entry the alternatives hang off, always an entry on the active chain. */
	entryId: string;
	options: BranchOption[];
}

/** One workspace the sidebar groups under, and the sessions stored for it. */
export interface WorkspaceSessions {
	cwd: string;
	sessions: SessionRow[];
}

function createSessionId(): string {
	return uuidv7();
}

export function assertValidSessionId(id: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

/** A short entry id no entry in `byId` already uses. */
function generateId(byId: { has(id: string): boolean }): string {
	for (let attempt = 0; attempt < 100; attempt++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	return randomUUID();
}

function buildEntryIndex(entries: SessionEntry[], byId?: Map<string, SessionEntry>): Map<string, SessionEntry> {
	if (byId) return byId;
	const index = new Map<string, SessionEntry>();
	for (const entry of entries) index.set(entry.id, entry);
	return index;
}

/**
 * The chain from the root to `leafId`, parent links followed, inclusive.
 *
 * `leafId` defaults to the last entry, and `null` means "before the first entry" and yields an empty
 * chain. An id no entry has falls back to the same default as a missing one, which is what lets a
 * caller walk the whole log without naming an entry.
 */
function buildSessionPath(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	if (leafId === null) return [];
	const index = buildEntryIndex(entries, byId);
	let leaf: SessionEntry | undefined;
	if (leafId) leaf = index.get(leafId);
	leaf ??= entries[entries.length - 1];
	if (!leaf) return [];

	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? index.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
}

/** The model and thinking level the branch was last set to, read from the entries that recorded it. */
function getSessionContextSettings(path: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
	let thinkingLevel = "off";
	let model: { name: string; modelId: string } | null = null;

	for (const entry of path) {
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
 * A compaction entry stands for everything it replaced: the summary, plus the prompt that was in
 * force at the boundary when the transcript carried one. Every other entry kind is state, not
 * conversation, and contributes nothing.
 */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
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
		const summary = createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
		return entry.systemMessage ? [entry.systemMessage, summary] : [summary];
	}
	return [];
}

/**
 * The entries that make up the current context, following the branch from the root to the leaf.
 *
 * Three decisions recorded as entries are applied here, and they are the only things that make this
 * differ from the raw branch: a compaction entry is a checkpoint — the newest one on the branch is
 * kept, the entries before the one it names are dropped, and everything from `firstKeptEntryId` on is
 * kept — a `prune` entry names tool results whose text is cleared, and an `argtrim` entry names
 * assistant messages whose recorded tool-call arguments are shortened. Older compactions that happen
 * to fall inside the retained range are retained too; the newest one is what contributes the summary.
 *
 * Applying all three here is what keeps the request, the snapshot, and a resumed process on one
 * transcript: the file keeps every line, and every reader derives the same view from it.
 */
export function buildContextEntries(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const path = buildSessionPath(entries, leafId, byId);
	return applyPrunes(
		applyArgTrims(contextEntriesFrom(path), trimmedEntryIds(path)),
		clearedEntryIds(path),
	);
}

/** The branch with its newest checkpoint applied: the checkpoint itself, then everything it kept. */
function contextEntriesFrom(path: SessionEntry[]): SessionEntry[] {
	let compaction: CompactionEntry | null = null;
	for (const entry of path) {
		if (entry.type === "compaction") compaction = entry;
	}
	if (!compaction) return path;

	const compactionIndex = path.findIndex((entry) => entry.id === compaction.id);
	if (compactionIndex < 0) return path;

	const contextEntries: SessionEntry[] = [compaction];
	let foundFirstKept = false;
	for (let index = 0; index < compactionIndex; index++) {
		const entry = path[index]!;
		if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
		// The prompt is carried by the compaction entry itself, so a system message this side of the
		// cut is skipped rather than replayed twice.
		if (foundFirstKept && !(entry.type === "message" && entry.message.role === "system")) {
			contextEntries.push(entry);
		}
	}
	contextEntries.push(...path.slice(compactionIndex + 1));
	return contextEntries;
}

/** Every entry id a `prune` record on this branch cleared. Read from the branch, not from the view. */
function clearedEntryIds(path: SessionEntry[]): Set<string> {
	const cleared = new Set<string>();
	for (const entry of path) {
		if (entry.type !== "prune") continue;
		for (const id of entry.clearedEntryIds) cleared.add(id);
	}
	return cleared;
}

/** The view, with the results a prune record named cleared in place. */
function applyPrunes(entries: SessionEntry[], cleared: ReadonlySet<string>): SessionEntry[] {
	if (cleared.size === 0) return entries;
	return entries.map((entry) => (cleared.has(entry.id) ? clearToolResult(entry) : entry));
}

/** Every entry id an `argtrim` record on this branch named. Read from the branch, not from the view. */
function trimmedEntryIds(path: SessionEntry[]): Set<string> {
	const trimmed = new Set<string>();
	for (const entry of path) {
		if (entry.type !== "argtrim") continue;
		for (const id of entry.trimmedEntryIds) trimmed.add(id);
	}
	return trimmed;
}

/** The view, with the recorded arguments an `argtrim` record named shortened in place. */
function applyArgTrims(entries: SessionEntry[], trimmed: ReadonlySet<string>): SessionEntry[] {
	if (trimmed.size === 0) return entries;
	return entries.map((entry) => (trimmed.has(entry.id) ? trimToolCallArgs(entry) : entry));
}

/**
 * Build the transcript the model is sent, from a branch of the entries.
 *
 * This is the one function that turns storage into a request, and it is why a resumed session and a
 * live one cannot drift: both go through here.
 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	const path = buildSessionPath(entries, leafId, byId);
	const { thinkingLevel, model } = getSessionContextSettings(path);
	const messages = buildContextEntries(entries, leafId, byId).flatMap(sessionEntryToContextMessages);
	return { messages, thinkingLevel, model };
}

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
const SESSION_HEADER_READ_BUFFER_SIZE = 4096;
/** Bound synchronous header discovery while still allowing a large cwd or custom metadata field. */
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;

class SessionHeaderScanLimitError extends Error {
	constructor(filePath: string) {
		super(`Session header exceeds ${MAX_SESSION_HEADER_SCAN_BYTES}-byte scan limit: ${filePath}`);
		this.name = "SessionHeaderScanLimitError";
	}
}

function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		// One unreadable line must not make the rest of a session unreadable.
		return null;
	}
}

export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const entries: FileEntry[] = [];
	let pending = "";
	const fd = openSync(resolvedFilePath, "r");
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
				const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex));
				if (entry) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		const finalEntry = parseSessionEntryLine(pending);
		if (finalEntry) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}

	// A file with no header is not a session; refuse it rather than adopting its lines.
	if (entries.length === 0) return entries;
	const header = entries[0]!;
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") return [];

	// A final line without a trailing newline would otherwise be extended by the next append.
	if (pending) appendFileSync(resolvedFilePath, "\n");
	return entries;
}

/**
 * Read one physical line while looking for the session header.
 *
 * Returns `undefined` to keep scanning past a blank or malformed line, `null` for a parsed non-header
 * entry, and the header once it is found — so a file whose first lines are junk still opens.
 */
function parseSessionHeaderCandidate(line: string): SessionHeader | null | undefined {
	if (!line.trim()) return undefined;
	const entry = parseSessionEntryLine(line);
	if (!entry) return undefined;
	if (entry.type !== "session" || typeof (entry as { id?: unknown }).id !== "string") return null;
	return entry;
}

function readSessionHeader(filePath: string): SessionHeader | null {
	const fd = openSync(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
		const lineChunks: string[] = [];
		let scannedBytes = 0;

		while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
			const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes);
			const bytesRead = readSync(fd, buffer, 0, readLength, null);
			if (bytesRead === 0) {
				lineChunks.push(decoder.end());
				return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
			}
			scannedBytes += bytesRead;

			const chunk = decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = chunk.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				lineChunks.push(chunk.slice(lineStart, newlineIndex));
				const header = parseSessionHeaderCandidate(lineChunks.join(""));
				if (header !== undefined) return header;
				lineChunks.length = 0;
				lineStart = newlineIndex + 1;
				newlineIndex = chunk.indexOf("\n", lineStart);
			}
			lineChunks.push(chunk.slice(lineStart));
		}

		// Probe for EOF so a header that ends exactly at the scan limit is still read.
		const probe = Buffer.allocUnsafe(1);
		if (readSync(fd, probe, 0, probe.length, null) === 0) {
			lineChunks.push(decoder.end());
			return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
		}
		throw new SessionHeaderScanLimitError(filePath);
	} finally {
		closeSync(fd);
	}
}

function readSessionHeaderForDiscovery(filePath: string): SessionHeader | null {
	try {
		return readSessionHeader(filePath);
	} catch {
		// Discovery is best-effort: one unreadable or oversized file must not hide the other sessions.
		return null;
	}
}

function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolvePath(cwd) === resolvedCwd;
}

/** The newest session file in `dir`, preferring one whose header names `cwd` when it is given. */
export function findMostRecentSession(dir: string, cwd?: string): string | null {
	const resolvedDir = normalizePath(dir);
	const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
	try {
		const files = readdirSync(resolvedDir)
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => join(resolvedDir, file))
			.map((path) => ({ path, mtime: statSync(path).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);

		for (const { path } of files) {
			const header = readSessionHeaderForDiscovery(path);
			if (header && (!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd))) return path;
		}
		return null;
	} catch {
		return null;
	}
}

function isMessageWithContent(message: AgentMessage): boolean {
	return typeof (message as { role?: unknown }).role === "string" && "content" in message;
}

function extractTextContent(message: AgentMessage): string {
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

function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
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
async function buildSessionInfo(filePath: string, signal?: AbortSignal, fileStats?: Stats): Promise<SessionInfo | null> {
	try {
		const stats = fileStats ?? (await stat(filePath));
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

		const lines = createInterface({
			input: createReadStream(filePath, { encoding: "utf8", signal }),
			crlfDelay: Number.POSITIVE_INFINITY,
		});

		for await (const line of lines) {
			const entry = parseSessionEntryLine(line);
			if (!entry) continue;
			if (!header) {
				if (entry.type !== "session") return null;
				header = entry;
				continue;
			}
			leafId = entry.id;
			// The header has already been consumed above, so this is one of the id-bearing kinds — and
			// the ones a branch walks through (model and tool changes) are recorded here too.
			parentOf.set(entry.id, (entry as { parentId?: string | null }).parentId ?? null);
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
			path: filePath,
			id: header.id,
			cwd: typeof header.cwd === "string" ? header.cwd : "",
			...(header.parentSession === undefined ? {} : { parentSessionPath: header.parentSession }),
			created: new Date(header.timestamp),
			modified,
			messageCount,
			title: titleOfBranch(parentOf, userTextOf, leafId),
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
	return "New session";
}

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

interface SessionFileCandidate {
	path: string;
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
	const byPath = new Map<string, string>();
	for (const session of sessions) byPath.set(fileKey(session.path), session.id);

	for (const session of sessions) {
		if (session.parentSessionPath === undefined) continue;
		const parentId = byPath.get(fileKey(session.parentSessionPath));
		if (parentId === undefined || parentId === session.id) continue;
		session.parentId = parentId;
	}
}

/** A path a lookup can key on: resolved, and case-folded where the filesystem is. */
function fileKey(path: string): string {
	const resolved = resolvePath(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function listSessionsFromDir(dir: string, signal?: AbortSignal): Promise<SessionInfo[]> {
	signal?.throwIfAborted();
	if (!existsSync(dir)) return [];

	try {
		const dirEntries = await readdir(dir);
		const files: SessionFileCandidate[] = dirEntries
			.filter((file) => file.endsWith(".jsonl"))
			.sort((a, b) => b.localeCompare(a))
			.map((file) => ({ path: join(dir, file) }));
		const results = await mapWithConcurrency(
			files,
			MAX_CONCURRENT_SESSION_INFO_LOADS,
			async (file) => buildSessionInfo(file.path, signal, file.stats),
			signal,
		);
		const sessions = results.filter((info): info is SessionInfo => info !== null);
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
	/** The role of that message, so a label can say who speaks. */
	role: string;
}

/** One short line naming what a message says, for a branch switcher's label. */
function previewOfMessage(message: AgentMessage): { label: string; role: string } {
	const text = extractTextContent(message).replace(/\s+/g, " ").trim();
	const role = typeof (message as { role?: unknown }).role === "string" ? String(message.role) : "";
	if (text.length === 0) return { label: "", role };
	return { label: text.length > 64 ? `${text.slice(0, 61)}...` : text, role };
}

/**
 * The session store: an append-only tree of entries in one JSONL file.
 *
 * Every entry carries an id and its parent's id, so the file reads as a tree and `leafId` is where the
 * conversation currently is. Appending creates a child of the leaf; {@link branch} moves the leaf to
 * an earlier entry — and records the move as a {@link LeafEntry}, so a fresh reader restores it — so a
 * new line of work continues from there without touching what was already written. Files are never
 * rewritten — the one exception is a file this build has to repair to be readable at all — which is
 * what lets an entry kind or a field this build does not understand be carried through untouched.
 *
 * Use {@link buildSessionContext} to get the messages a provider should be sent: it follows the branch
 * from root to leaf and folds in the newest compaction.
 */
export class SessionManager {
	private sessionId = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	/** False until the header has reached the file; see {@link hasConversation}. */
	private flushed = false;
	private fileEntries: FileEntry[] = [];
	private byId = new Map<string, SessionEntry>();
	private leafId: string | null = null;

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
		preloadedFileEntries?: FileEntry[],
	) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.persist = persist;
		if (persist && this.sessionDir && !existsSync(this.sessionDir)) mkdirSync(this.sessionDir, { recursive: true });

		if (sessionFile) {
			this.setSessionFileInternal(sessionFile, preloadedFileEntries);
		} else if (preloadedFileEntries?.length) {
			this.loadEntries(preloadedFileEntries, newSessionOptions);
		} else {
			this.newSession(newSessionOptions);
		}
	}

	/** Point this manager at another session file, for resume and for following a fork. */
	setSessionFile(sessionFile: string): void {
		this.setSessionFileInternal(sessionFile);
	}

	private setSessionFileInternal(sessionFile: string, preloadedFileEntries?: FileEntry[]): void {
		this.sessionFile = resolvePath(sessionFile);
		if (existsSync(this.sessionFile)) {
			const entries = preloadedFileEntries ?? loadEntriesFromFile(this.sessionFile);
			if (entries.length === 0) {
				const explicitPath = this.sessionFile;
				// An empty file is adopted and given a header. A non-empty file that did not parse as a
				// session is refused, because overwriting it could destroy something we cannot read.
				if (statSync(explicitPath).size > 0) {
					throw new Error(`Session file is not a valid ${APP_NAME} session: ${explicitPath}`);
				}
				this.newSession();
				this.sessionFile = explicitPath;
				this.rewriteFile();
				this.flushed = true;
				return;
			}

			this.loadEntries(entries);
			this.flushed = true;
			return;
		}

		const explicitPath = this.sessionFile;
		this.newSession();
		this.sessionFile = explicitPath; // keep a path the caller named even though the file is not there yet
	}

	/** Start a fresh session in this manager, discarding whatever it held. Returns the file path. */
	newSession(options?: NewSessionOptions): string | undefined {
		if (options?.id !== undefined) assertValidSessionId(options.id);
		this.sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			...(options?.parentSession === undefined ? {} : { parentSession: options.parentSession }),
		};
		this.fileEntries = [header];
		this.byId.clear();
		this.leafId = null;
		this.flushed = false;

		if (this.persist) this.sessionFile = sessionPath(this.getSessionDir(), this.sessionId, timestamp);
		return this.sessionFile;
	}

	private loadEntries(entries: FileEntry[], options?: NewSessionOptions): void {
		const header = entries.find((entry) => entry.type === "session") as SessionHeader | undefined;
		if (header) {
			this.fileEntries = entries;
			this.sessionId = header.id;
		} else {
			this.newSession(options);
			this.fileEntries = this.fileEntries.concat(entries);
		}
		this.buildIndex();
	}

	private buildIndex(): void {
		this.byId.clear();
		this.leafId = null;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			this.byId.set(entry.id, entry);
			if (entry.type === "leaf") {
				// The record names where the conversation went; every other kind *is* where it went, by
				// having been appended. File order is the last word, so a later entry of any kind
				// supersedes what an earlier record said, the way an old `model_change` expires. A
				// recorded null is a position of its own — "before the first entry" — and only a target
				// the file does not hold (only a hand-edited file can manage that) falls back to the
				// record's own tree position, the same family of answer `buildSessionPath` gives an
				// unknown id.
				this.leafId = entry.leafId === null || this.byId.has(entry.leafId) ? entry.leafId : (entry.parentId ?? null);
			} else {
				this.leafId = entry.id;
			}
		}
	}

	private rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		const fd = openSync(this.sessionFile, "w");
		try {
			for (const entry of this.fileEntries) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
		} finally {
			closeSync(fd);
		}
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	usesDefaultSessionDir(): boolean {
		return this.sessionDir === workspaceDir(this.cwd);
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	/** True once the session holds a user or assistant message, which is what makes it worth keeping. */
	private hasConversation(): boolean {
		return this.fileEntries.some(
			(entry) => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
		);
	}

	private persistEntry(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) return;

		if (!this.flushed) {
			if (!this.hasConversation()) return;
			const fd = openSync(this.sessionFile, "wx");
			try {
				for (const existing of this.fileEntries) writeFileSync(fd, `${JSON.stringify(existing)}\n`);
			} finally {
				closeSync(fd);
			}
			this.flushed = true;
			return;
		}

		appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
	}

	private appendEntry(entry: SessionEntry): void {
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		this.persistEntry(entry);
	}

	/**
	 * Append a message as a child of the leaf and advance the leaf. Returns the new entry's id.
	 *
	 * A compaction summary is deliberately not accepted here: it has to be a top-level entry so that
	 * {@link buildContextEntries} can find it, which is what {@link appendCompaction} is for.
	 */
	appendMessage(message: AgentMessage): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
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
			id: generateId(this.byId),
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
			id: generateId(this.byId),
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
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			activeTools: [...activeTools],
			approval: { ...approval },
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
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		details?: T,
		usage?: Usage,
	): string {
		const timestamp = new Date().toISOString();
		const systemMessage = getCurrentSystemMessage(this.buildSessionContext().messages);
		const id = generateId(this.byId);
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id,
			parentId: this.leafId,
			timestamp,
			summary,
			firstKeptEntryId: firstKeptEntryId ?? id,
			tokensBefore,
			...(details === undefined ? {} : { details }),
			...(usage === undefined ? {} : { usage }),
			...(systemMessage ? { systemMessage: { ...systemMessage, timestamp: new Date(timestamp).getTime() } } : {}),
		};
		this.appendEntry(entry);
		return entry.id;
	}

	/**
	 * Record that tool results were cleared: the named entries keep their place in the file and lose
	 * their text in the view.
	 *
	 * Unlike a compaction there is nothing to hold back — the results are cleared precisely because a
	 * run can reproduce them — so the record is only the ids and what the prune was worth.
	 */
	appendPrune(clearedEntryIds: readonly string[], tokensBefore: number): string {
		const entry: PruneEntry = {
			type: "prune",
			id: generateId(this.byId),
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
	 * Like a prune, there is nothing to hold back — the arguments named belong to calls whose results
	 * are already on the branch — so the record is only the ids and what the trim was worth.
	 */
	appendArgTrim(trimmedEntryIds: readonly string[], tokensBefore: number): string {
		const entry: ArgTrimEntry = {
			type: "argtrim",
			id: generateId(this.byId),
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
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	/** Every entry that follows `parentId`, in file order. */
	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) children.push(entry);
		}
		return children;
	}

	/**
	 * The branch points of the active chain, in chain order.
	 *
	 * A child counts as an alternative only when a message is reachable through it: this format carries
	 * state entries too — a model change, a tool config, a prune, a compaction, a leaf record — and a
	 * conversation cannot be resumed at one of those, so counting them would offer an empty
	 * alternative. A state entry in front of a message is descended through for the same reason:
	 * rewinding, switching the model, and asking again is one alternative, not two.
	 */
	getBranchPoints(): BranchPoint[] {
		const chain = this.getBranch();
		const onChain = new Set(chain.map((entry) => entry.id));
		const children = this.childrenIndex();
		const memo = new Map<string, SubtreeDescription>();
		const points: BranchPoint[] = [];

		for (const entry of chain) {
			const options: BranchOption[] = [];
			for (const child of children.get(entry.id) ?? []) {
				const described = this.subtreeDescription(child.id, children, memo);
				if (!described.message) continue;
				options.push({
					entryId: child.id,
					label: described.label,
					role: described.role,
					active: onChain.has(child.id),
				});
			}
			if (options.length > 1) points.push({ entryId: entry.id, options });
		}
		return points;
	}

	/**
	 * The newest tip of the subtree `entryId` roots: where that line of work would be resumed.
	 *
	 * The descent follows the last child written at each step, over every entry kind, because a branch
	 * whose last entry is a compaction or a model change stopped there too.
	 */
	getBranchTip(entryId: string): string {
		if (!this.byId.has(entryId)) throw new Error(`Entry ${entryId} not found`);
		return this.subtreeDescription(entryId, this.childrenIndex(), new Map()).tip;
	}

	/** Every entry's children, in file order, built in one pass over the log. */
	private childrenIndex(): Map<string, SessionEntry[]> {
		const index = new Map<string, SessionEntry[]>();
		for (const entry of this.byId.values()) {
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
		memo.set(entryId, { tip: entryId, message: false, label: "", role: "" });

		const entry = this.byId.get(entryId);
		const descents = (children.get(entryId) ?? []).map((child) =>
			this.subtreeDescription(child.id, children, memo),
		);
		const own = entry?.type === "message" ? previewOfMessage(entry.message) : undefined;
		let label = own?.label ?? "";
		let role = own?.role ?? "";
		let message = own !== undefined;
		if (!message) {
			const below = descents.find((descent) => descent.message);
			if (below !== undefined) {
				message = true;
				label = below.label;
				role = below.role;
			}
		}

		const described: SubtreeDescription = {
			// The newest child is the last written, and the file is in write order.
			tip: descents.length === 0 ? entryId : descents[descents.length - 1]!.tip,
			message,
			label,
			role,
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
		let current = startId ? this.byId.get(startId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	buildContextEntries(): SessionEntry[] {
		return buildContextEntries(this.getEntries(), this.leafId, this.byId);
	}

	buildSessionContext(): SessionContext {
		return buildSessionContext(this.getEntries(), this.leafId, this.byId);
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
		const header = this.fileEntries.find((entry) => entry.type === "session");
		return header ? (header as SessionHeader) : null;
	}

	/** Number of entries, header aside, without copying them the way {@link getEntries} does. */
	getEntryCount(): number {
		return this.byId.size;
	}

	/** Every entry, header aside, in file order. Use the `append*` methods to add more. */
	getEntries(): SessionEntry[] {
		return this.fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
	}

	/**
	 * The conversation's own name: the first user message on the branch, or a placeholder.
	 *
	 * Read from the whole branch rather than from the compacted context, so summarizing the oldest turn
	 * away cannot rename the session. That also keeps it in step with the name the picker derives from
	 * the file, which scan every message entry rather than the model's view of them.
	 */
	getTitle(): string {
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
		if (!this.byId.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
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
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			leafId,
		};
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.persistEntry(entry);
	}

	// =========================================================================
	// Construction and discovery
	// =========================================================================

	/**
	 * Start a session in `cwd`, stored under `sessionDir` or the workspace's default directory.
	 *
	 * The header is written immediately rather than at the first message. A session this process is
	 * running is addressable by id — a browser that reloads asks for it by id — and an id that is not
	 * in its file yet cannot be found.
	 */
	static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : workspaceDir(cwd);
		const manager = new SessionManager(cwd, dir, undefined, true, options);
		manager.flushed = true;
		manager.rewriteFile();
		return manager;
	}

	/** Open one session file, deriving the cwd and the session directory from it when they are not given. */
	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		const resolvedPath = resolvePath(path);
		let header: SessionHeader | null = null;
		let preloadedFileEntries: FileEntry[] | undefined;
		if (cwdOverride === undefined && existsSync(resolvedPath)) {
			try {
				header = readSessionHeader(resolvedPath);
			} catch (error) {
				if (!(error instanceof SessionHeaderScanLimitError)) throw error;
				// The bounded scan is a discovery shortcut; a full load is authoritative for a file with
				// an unusually large header.
				preloadedFileEntries = loadEntriesFromFile(resolvedPath);
				const firstEntry = preloadedFileEntries[0];
				header = firstEntry?.type === "session" ? firstEntry : null;
			}
		}
		const cwd = cwdOverride ?? (header ? getSessionHeaderCwd(header) : undefined) ?? process.cwd();
		const dir = sessionDir ? normalizePath(sessionDir) : dirname(resolvedPath);
		return new SessionManager(cwd, dir, resolvedPath, true, undefined, preloadedFileEntries);
	}

	/**
	 * The newest session in `cwd`'s directory, or a new one — header already written — when there is none.
	 *
	 * New sessions are written here for the same reason {@link create} writes them: what this returns has
	 * to be findable by id, or resuming by id would fail on the session the user is about to talk to.
	 */
	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : workspaceDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== workspaceDir(cwd);
		const mostRecent = findMostRecentSession(dir, filterCwd ? cwd : undefined);
		return mostRecent
			? new SessionManager(cwd, dir, mostRecent, true)
			: SessionManager.create(cwd, sessionDir);
	}

	/** A session that is never written to disk. */
	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions): SessionManager {
		return new SessionManager(cwd, "", undefined, false, options);
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
		sourcePath: string,
		targetCwd: string,
		entryId: string | null,
		sessionDir?: string,
		options?: NewSessionOptions,
	): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const resolvedTargetCwd = resolvePath(targetCwd);
		const sourceEntries = loadEntriesFromFile(resolvedSourcePath);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${resolvedSourcePath}`);
		}
		const sourceHeader = sourceEntries.find((entry) => entry.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) throw new Error(`Cannot fork: source session has no header: ${resolvedSourcePath}`);

		const entries = sourceEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
		const branch = entryId === null ? entries : buildSessionPath(entries, entryId);
		if (entryId !== null && branch.length === 0) {
			throw new Error(`Session ${sourceHeader.id} has no entry ${entryId}`);
		}

		const dir = sessionDir ? normalizePath(sessionDir) : workspaceDir(resolvedTargetCwd);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		if (options?.id !== undefined) assertValidSessionId(options.id);
		const newSessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const newSessionFile = sessionPath(dir, newSessionId, timestamp);
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: resolvedTargetCwd,
			parentSession: resolvedSourcePath,
		};
		writeFileSync(newSessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
		for (const entry of branch) appendFileSync(newSessionFile, `${JSON.stringify(entry)}\n`);

		return new SessionManager(resolvedTargetCwd, dir, newSessionFile, true);
	}

	/** The file for an exact session id, without loading any transcript. */
	static findById(cwd: string, id: string, sessionDir?: string): string | undefined {
		const dir = sessionDir ? normalizePath(sessionDir) : workspaceDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== workspaceDir(cwd);
		const resolvedCwd = resolvePath(cwd);

		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".jsonl")) continue;
				const path = join(dir, file);
				const header = readSessionHeaderForDiscovery(path);
				if (header?.id !== id) continue;
				if (filterCwd && !sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd)) continue;
				return path;
			}
		} catch {
			// Exact discovery is best-effort, like list(): a missing directory is no sessions.
		}
		return undefined;
	}

	/** Every session stored for `cwd`, newest activity first. */
	static async list(cwd: string, sessionDir?: string, signal?: AbortSignal): Promise<SessionInfo[]> {
		const dir = sessionDir ? normalizePath(sessionDir) : workspaceDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== workspaceDir(cwd);
		const resolvedCwd = resolvePath(cwd);
		const sessions = (await listSessionsFromDir(dir, signal)).filter(
			(session) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd),
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
		let entries: string[];
		try {
			entries = readdirSync(sessionsDir(), { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(sessionsDir(), entry.name));
		} catch {
			// No sessions directory is the normal first run.
			return [];
		}

		const groups: WorkspaceSessions[] = [];
		for (const dir of entries) {
			const newest = findMostRecentSession(dir);
			if (newest === null) continue;
			const header = readSessionHeaderForDiscovery(newest);
			const cwd = header === null ? undefined : getSessionHeaderCwd(header);
			if (cwd === undefined || cwd === "") continue;

			const sessions = (await SessionManager.list(cwd, dir, signal)).map(toSessionRow);
			if (sessions.length === 0) continue;
			groups.push({ cwd, sessions });
		}

		return groups.sort((a, b) => newestAt(b) - newestAt(a));
	}

	/**
	 * The one row a single session file describes, or `undefined` when it is not one.
	 *
	 * The listing answers the same question for every session at once, which is the wrong cost when
	 * exactly one file is what changed — a session just created, or just forked. This reads that one
	 * file and stops, so a session appearing costs one parse rather than a scan of the machine.
	 */
	static async rowFor(filePath: string, signal?: AbortSignal): Promise<SessionRow | undefined> {
		const info = await buildSessionInfo(filePath, signal);
		if (info === null) return undefined;
		// A fork's parent is named by *path* in the header, so it is knowable from one file alone once
		// that path is resolved to an id — which matters because a fork reaches a store one row at a
		// time, where the listing that would have linked it is not in play.
		if (info.parentId === undefined && info.parentSessionPath !== undefined) {
			const parent = readSessionHeaderForDiscovery(info.parentSessionPath);
			const parentId = parent?.id;
			if (parentId !== undefined && parentId !== info.id) info.parentId = parentId;
		}
		return toSessionRow(info);
	}

	/**
	 * The one row a session id names, from whichever workspace holds it.
	 *
	 * The id-addressed half of {@link rowFor}, for a caller holding an id rather than a path.
	 */
	static async rowForId(id: string, signal?: AbortSignal): Promise<SessionRow | undefined> {
		const path = SessionManager.findAnywhere(id);
		if (path === undefined) return undefined;
		return SessionManager.rowFor(path, signal);
	}

	/**
	 * The file for a session id, whichever workspace it belongs to.
	 *
	 * A session opened from the sidebar may live in a workspace this process was not started over, and
	 * its header — not the server's root — is what says which directory its tools resolve inside.
	 */
	static findAnywhere(id: string): string | undefined {
		let entries: string[];
		try {
			entries = readdirSync(sessionsDir(), { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(sessionsDir(), entry.name));
		} catch {
			return undefined;
		}

		for (const dir of entries) {
			try {
				for (const file of readdirSync(dir)) {
					if (!file.endsWith(".jsonl")) continue;
					const path = join(dir, file);
					if (readSessionHeaderForDiscovery(path)?.id === id) return path;
				}
			} catch {
				// One unreadable directory must not hide a session stored in another.
				continue;
			}
		}
		return undefined;
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
		const group = groups.get(row.cwd);
		if (group === undefined) groups.set(row.cwd, [row]);
		else group.push(row);
	}
	return [...groups.entries()]
		.map(([cwd, sessions]) => ({ cwd, sessions: byModified(sessions) }))
		.sort((a, b) => newestAt(b) - newestAt(a));
}

/** Most recently active first, on a copy so two callers cannot reorder each other's view. */
export function byModified(rows: readonly SessionRow[]): SessionRow[] {
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
		cwd: info.cwd,
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
export function toSessionRow(info: SessionInfo): SessionRow {
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
export function deriveTitle(messages: readonly AgentMessage[]): string {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const text = shortenTitle(textOf((message as { content?: unknown }).content));
		if (text.length > 0) return text;
	}
	return "New session";
}

/**
 * The one rule for shortening a title: collapse its whitespace, then cut it at 72 characters.
 *
 * Shared rather than written twice because the two callers answer different questions about *which*
 * message they are shortening — a live session walks its branch, a scan walks the file — and a row
 * whose title jumped the moment its host was reaped would be the flicker this sharing exists to stop.
 */
function shortenTitle(text: string): string {
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
