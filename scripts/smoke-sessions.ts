// Session-registry smoke test: proves one agent loop per session id, that a session survives losing
// its last connection, and that the two files a session is (the `.json` snapshot and the `.jsonl`
// entry stream) are what a later connection gets back.
// Nothing here reaches a model, so no provider key is needed. Run with: node scripts/smoke-sessions.ts
import { appendFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import type { Message } from "@my-agent/core";
import { bootServer } from "../packages/server/src/boot.ts";
import { SessionHub } from "../packages/server/src/hub.ts";
import {
	CURRENT_SESSION_VERSION,
	type AgentState,
	createAgentState,
	createLive,
	createSession,
	createSessionAgent,
	fillSession,
	openAgent,
	readSessionSnapshot,
	SessionManager,
	inMemorySettingManager,
	SettingManager,
	sessionDir,
	type SessionSnapshot,
	type Session,
} from "@my-agent/core";

/** The ledger's operations are the service's methods, so a script holds one to call them on. */
const store = new SessionManager();

const root = await mkdtemp(join(tmpdir(), "my-agent-sessions-"));
let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

interface ReadAnswer {
	status: number;
	/** Absent when the read was refused, which is what a 404 looks like here. */
	session?: SessionSnapshot;
}

/**
 * One read over the real route table, so a status code here is the status code a client sees.
 *
 * Written on `node:http` with `agent: false` rather than on `fetch`, because this script starts a
 * server inside its own process: a pooled keep-alive socket outlives `close()`, and the explicit
 * `process.exit` at the end of this file then tears the loop down mid-notification. One connection
 * per request leaves nothing behind for that exit to race.
 */
function get(url: string): Promise<ReadAnswer> {
	return new Promise((resolve, reject) => {
		const call = request(url, { agent: false, headers: { accept: "application/json" } }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
			});
			response.on("end", () => {
				const payload = body.length === 0 ? {} : (JSON.parse(body) as { session?: SessionSnapshot });
				resolve({ status: response.statusCode ?? 0, session: payload.session });
			});
		});
		call.on("error", reject);
		call.end();
	});
}

/** A user message the transcript accepts; nothing here goes near a model. */
function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/** One request against the booted server, for the endpoints this script exercises besides reads. */
function call(method: string, url: string, body?: unknown): Promise<{ status: number; payload: Record<string, unknown> }> {
	return new Promise((resolvePromise, reject) => {
		const headers: Record<string, string> = { accept: "application/json" };
		if (body !== undefined) headers["content-type"] = "application/json";
		const call_ = request(url, { agent: false, method, headers }, (response) => {
			let text = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				text += chunk;
			});
			response.on("end", () => {
				resolvePromise({
					status: response.statusCode ?? 0,
					payload: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
				});
			});
		});
		call_.on("error", reject);
		call_.end(body === undefined ? undefined : JSON.stringify(body));
	});
}

/** Entry ids in file order, for comparing a fork against the branch it copied. */
function ids(entries: readonly { id: string }[]): string {
	return entries.map((entry) => entry.id).join(",");
}

/** The messages of a state's current branch, which is what a provider would be sent. */
function messagesOf(state: Session): Message[] {
	return store.buildSessionContext(state).messages;
}

/** Replay the stored file for a session id, the way a later process would. */
function openFile(id: string): Session {
	const path = SessionManager.findSessionFilePathById(id);
	if (path === undefined) throw new Error(`no session file for ${id}`);
	return fillSession(path);
}

/** The snapshot path of a session: same stem as the `.jsonl` stream, `.json` for the `.json` file. */
function snapshotPathOf(jsonlPath: string): string {
	return jsonlPath.replace(/\.jsonl$/, ".json");
}

/**
 * The hub's own session service: the one whose open the hub's cold paths go through. The tests
 * append directly to the transcript rather than speaking to a provider, which is what the id-keyed
 * `Agent` no longer exposes.
 */
function hubSessions(hub: SessionHub): SessionManager {
	return (hub as unknown as { sessions: SessionManager }).sessions;
}

/**
 * The orchestrator's state for an id — the per-session object a claim adopts and a close drops.
 *
 * This is what "one session per id" means now: the orchestrator is the process's own and answers by
 * id, so what a reopen can build a second of is a *state* (the queues, the live half, the assembly),
 * never the object that serves them. A cast into the orchestrator's private table, because the
 * probe wants `undefined` rather than a throw; when the hub adapts (issue 12) these identity
 * assertions move onto behavior and the probe goes away.
 */
function entryOf(hub: SessionHub, id: string): AgentState | undefined {
	return (hub.agent as unknown as { sessions: Map<string, AgentState> }).sessions.get(id);
}

/** The bag behind a hosted session: the one the orchestrator's table holds and its turns write through. */
function bagOf(hub: SessionHub, id: string): Session {
	return hub.agent.agentState(id).session;
}

/** Poll until `ready` holds, and report whether it did, so no test guesses at a reap's timing. */
async function until(ready: () => boolean, ms = 5_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (ready()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return ready();
}

const hub = new SessionHub({ workDirAbsPath: root });

try {
	process.stdout.write("one session per id\n");
	// The id is asked for first and then claimed by name, which is the only shape production has: a
	// request never omits the id, so "which session is current" is `GET /api/sessions/current`'s
	// question and not the claim's.
	const landing = await hub.currentSessionId();
	const first = await hub.claim(landing);
	const second = await hub.claim(landing);
	check("two connections with no id share one entry", entryOf(hub, first.id) === entryOf(hub, second.id));
	check("both claims are counted", first.claims === 2, `claims=${first.claims}`);
	check("the hub runs it once", hub.live.length === 1, hub.live.join(","));

	process.stdout.write("claiming by id\n");
	// The entry a claim opened: the one thing a second claim must not build a second of.
	const runningEntry = entryOf(hub, first.id);
	const again = await hub.claim(first.id);
	check("returns the entry already running", entryOf(hub, again.id) === runningEntry);
	check("claims add up", first.claims === 3, `claims=${first.claims}`);

	process.stdout.write("a claim outlives the connections that dropped it\n");
	hub.release(again);
	hub.release(second);
	check("still running with one claim left", first.claims === 1 && hub.live.includes(first.id));
	await new Promise((resolve) => setTimeout(resolve, 50));
	check("a claimed session is never forgotten", hub.live.includes(first.id));

	process.stdout.write("the last release forgets an idle session\n");
	const reapedEntry = entryOf(hub, first.id);
	hubSessions(hub).appendMessage(bagOf(hub, first.id), userMessage("survives the reap"));
	hub.release(first);
	check("the session is closed and dropped", await until(() => !hub.live.includes(first.id)));

	process.stdout.write("the JSONL file is what survives\n");
	const reopened = await hub.claim(first.id);
	check("reopening builds a different registry entry", entryOf(hub, reopened.id) !== reapedEntry);
	check(
		"and it still carries the transcript",
		JSON.stringify(hub.agent.snapshot(reopened.id).messages).includes("survives the reap"),
	);
	await hub.close();

	process.stdout.write("new_session moves the landing spot\n");
	const created = await hub.newSession();
	const landed = await hub.claim(await hub.currentSessionId());
	check("an unnamed claim lands on the newest session", landed.id === created, `${landed.id} vs ${created}`);

	process.stdout.write("a fork is the branch up to one entry\n");
	const parentId = await hub.newSession();
	const parent = await hub.claim(parentId);
	const parentFile = hub.agent.agentState(parent.id).session.sessionFileAbsPath ?? "";
	const entryOne = hubSessions(hub).appendMessage(bagOf(hub, parentId), userMessage("first"));
	hubSessions(hub).appendMessage(bagOf(hub, parentId), userMessage("second"));

	const forkedId = await hub.fork(parentId, entryOne);
	// Read the file the fork wrote, before a session opens over it and records its own model.
	const forkedFile = openFile(forkedId);
	const branch = hubSessions(hub).getBranch(bagOf(hub, parentId), entryOne);
	check("the fork is a new session id", forkedId !== parentId, `${forkedId} vs ${parentId}`);
	check(
		"it holds the prefix through that message",
		messagesOf(forkedFile).length === 1 && JSON.stringify(messagesOf(forkedFile)).includes("first"),
		`${messagesOf(forkedFile).length} messages`,
	);
	check(
		"with the same entry ids",
		ids(store.getEntries(forkedFile)) === ids(branch),
		`${ids(store.getEntries(forkedFile))} vs ${ids(branch)}`,
	);
	check(
		"and the message entry ids line up",
		JSON.stringify(store.getContextMessageEntryIds(forkedFile)) === JSON.stringify([entryOne]),
		JSON.stringify(store.getContextMessageEntryIds(forkedFile)),
	);
	check("its leaf is that entry's id", forkedFile.leafId === entryOne, String(forkedFile.leafId));
	check("the header names the file it came from", store.getMeta(forkedFile)?.parentSession === parentFile, String(store.getMeta(forkedFile)?.parentSession));
	check(
		"the source keeps the entries the fork did not take",
		hubSessions(hub).getChildren(bagOf(hub, parentId), entryOne).length === 1,
		`children=${hubSessions(hub).getChildren(bagOf(hub, parentId), entryOne).length}`,
	);

	const forked = await hub.claim(forkedId);
	check("the fork runs as a session of its own", entryOf(hub, forked.id) !== entryOf(hub, parent.id));
	check("and it reports the file it came from", hubSessions(hub).getMeta(bagOf(hub, forkedId))?.parentSession === parentFile);

	process.stdout.write("forking without an entry copies the whole log\n");
	const whole = fillSession(new SessionManager().forkFrom(parentFile, null, sessionDir(root)).sessionFileAbsPath);
	check("every entry came with it", ids(store.getEntries(whole)) === ids(hubSessions(hub).getEntries(bagOf(hub, parentId))));
	check("and the transcript matches", messagesOf(whole).length === messagesOf(bagOf(hub, parentId)).length);
	check("its leaf is the source's leaf", whole.leafId === bagOf(hub, parentId).leafId);
	check("it points back at the source too", store.getMeta(whole)?.parentSession === parentFile);

	process.stdout.write("forking leaves the source alone\n");
	const before = await readFile(parentFile, "utf8");
	const leafBefore = bagOf(hub, parentId).leafId;
	const secondFork = openFile(await hub.fork(parentId, entryOne));
	check("the source keeps its own leaf", bagOf(hub, parentId).leafId === leafBefore);
	check("its file is byte-identical afterwards", (await readFile(parentFile, "utf8")) === before);
	check("the claim on it survived", parent.claims === 1 && hub.live.includes(parentId), `claims=${parent.claims}`);

	process.stdout.write("a fork and its parent run side by side\n");
	check("both are live", hub.live.includes(parentId) && hub.live.includes(forkedId));
	const forkBefore = JSON.stringify(messagesOf(bagOf(hub, forkedId)));
	const forkLeaf = bagOf(hub, forkedId).leafId;
	hubSessions(hub).appendMessage(bagOf(hub, parentId), userMessage("only the parent"));
	check(
		"appending to the parent leaves the fork's transcript alone",
		JSON.stringify(messagesOf(bagOf(hub, forkedId))) === forkBefore,
	);
	check("and the fork's leaf did not move", bagOf(hub, forkedId).leafId === forkLeaf);
	const parentBefore = JSON.stringify(messagesOf(bagOf(hub, parentId)));
	hubSessions(hub).appendMessage(bagOf(hub, forkedId), userMessage("only the fork"));
	check(
		"appending to the fork leaves the parent's transcript alone",
		JSON.stringify(messagesOf(bagOf(hub, parentId))) === parentBefore,
	);

	process.stdout.write("reopening a fork reports where it came from\n");
	const leafAtClose = bagOf(hub, forkedId).leafId;
	const messagesAtClose = messagesOf(bagOf(hub, forkedId)).length;
	hub.release(forked);
	check("the fork is closed and dropped", await until(() => !hub.live.includes(forkedId)));
	const forkEntry = entryOf(hub, forked.id);
	const reread = openFile(forkedId);
	check("reopening reports its parent session", store.getMeta(reread)?.parentSession === parentFile);
	check("and the same leaf", reread.leafId === leafAtClose, `${reread.leafId} vs ${leafAtClose}`);
	// Counted before the release: the drop takes the bag with it, so what the file kept is compared
	// against what the session had when it was still held.
	check("with the messages it had", messagesOf(reread).length === messagesAtClose, `${messagesOf(reread).length} vs ${messagesAtClose}`);
	const reopenedFork = await hub.claim(forkedId);
	check("a claimed reopen builds a different registry entry", entryOf(hub, reopenedFork.id) !== forkEntry);
	check("and still reports the session it came from", hubSessions(hub).getMeta(bagOf(hub, forkedId))?.parentSession === parentFile);

	process.stdout.write("forking a session nobody is watching\n");
	hub.release(reopenedFork);
	await until(() => !hub.live.includes(forkedId));
	const onDisk = openFile(forkedId);
	const cold = await hub.fork(forkedId, onDisk.leafId);
	check("an on-disk session forks too", cold !== forkedId && cold !== parentId, cold);
	check("it is not running until someone claims it", !hub.live.includes(cold));
	const coldFile = openFile(cold);
	check("its branch ends where it was told to", coldFile.leafId === onDisk.leafId);
	check("and it points at the session it came from", store.getMeta(coldFile)?.parentSession === SessionManager.findSessionFilePathById(forkedId));
	check("the other fork is a session of its own", secondFork.sessionId !== forkedId && secondFork.sessionId !== cold);

	process.stdout.write("a listing resolves a fork's parent\n");
	// The header names the source's *file path*, because that is what a reader of one file has in hand;
	// the sidebar draws a tree, so the listing is where that path becomes the id of the session it names.
	const list = await SessionManager.list(root);
	const listed = new Map(list.map((info) => [info.id, info]));
	check("the fork points at the session it came from", listed.get(forkedId)?.parentId === parentId, String(listed.get(forkedId)?.parentId));
	check("and a fork of a fork points at its own source", listed.get(cold)?.parentId === forkedId, String(listed.get(cold)?.parentId));
	check("while a root session has no parent", listed.get(parentId)?.parentId === undefined, String(listed.get(parentId)?.parentId));
	check(
		"every parent an id of a session in the same list",
		list.every((info) => info.parentId === undefined || listed.has(info.parentId)),
		list.map((info) => `${info.id}<-${info.parentId ?? ""}`).join(" "),
	);

	// The sidebar reads the directory groups rather than one directory, so the same link has to survive
	// that path: a fork listed under a directory has to name a parent that is listed with it.
	const groups = await SessionManager.listDirectories();
	const group = groups.find((candidate) => candidate.sessions.some((session) => session.id === forkedId));
	check("the directory listing carries the same parent", group?.sessions.find((session) => session.id === forkedId)?.parentId === parentId, JSON.stringify(group?.sessions.map((session) => [session.id, session.parentId])));
	check(
		"and every parent it names is in its own group",
		(group?.sessions ?? []).every(
			(session) => session.parentId === undefined || (group?.sessions ?? []).some((other) => other.id === session.parentId),
		),
		JSON.stringify(group?.sessions.map((session) => [session.id, session.parentId])),
	);

	process.stdout.write("a rename is stored and outlives a reopen\n");
	// The rename is the title on the session's `.json` snapshot, read back by every path
	// that names a session — the live manager, the scan, and the fork that copies the whole log.
	{
		const renamedId = await hub.newSession();
		const host = await hub.claim(renamedId);
		hubSessions(hub).appendMessage(bagOf(hub, renamedId), userMessage("改名的会话"));
		await hub.rename(renamedId, "新名字");
		check("a live session reports the stored name", hub.agent.snapshot(host.id).title === "新名字", hub.agent.snapshot(host.id).title);

		hub.release(host);
		check("the renamed session closes", await until(() => !hub.live.includes(renamedId)));
		const rescanned = await SessionManager.findSessionRowById(renamedId);
		check("the file's row carries the stored name", rescanned?.title === "新名字", rescanned?.title);
		const reopened = await hub.claim(renamedId);
		check("a reopen reports it too", hub.agent.snapshot(reopened.id).title === "新名字", hub.agent.snapshot(reopened.id).title);

		const renameFork = await hub.fork(renamedId, null);
		const forkRow = await SessionManager.findSessionRowById(renameFork);
		check("a fork lands with the source's stored name", forkRow?.title === "新名字", forkRow?.title);
		await hub.rename(renameFork, "另一条");
		check(
			"renaming the fork leaves the source alone",
			(await SessionManager.findSessionRowById(renamedId))?.title === "新名字" &&
				(await SessionManager.findSessionRowById(renameFork))?.title === "另一条",
			`${(await SessionManager.findSessionRowById(renamedId))?.title} / ${(await SessionManager.findSessionRowById(renameFork))?.title}`,
		);
		await hub.release(reopened);
	}

	process.stdout.write("a meta change rewrites the snapshot whole\n");
	// The v5 format's central promise, driven by the same four setters production uses: a choice
	// rewrites the `.json` snapshot by temp+rename and never touches the `.jsonl` append stream. The
	// atomicity itself has no outside observer — a rename is one step — so what the checks below
	// pin is its observable half: the log untouched, no half-written temp left behind, and a choice
	// that changes nothing leaving the file exactly as it was.
	{
		const metaId = await hub.newSession();
		const host = await hub.claim(metaId);
		hubSessions(hub).appendMessage(bagOf(hub, metaId), userMessage("重写的会话"));
		const jsonlPath = bagOf(hub, metaId).sessionFileAbsPath!;
		const jsonPath = snapshotPathOf(jsonlPath);
		const logBefore = await readFile(jsonlPath, "utf8");
		check("the snapshot sits beside the stream it commits", existsSync(jsonPath));

		hubSessions(hub).setTitle(bagOf(hub, metaId), "重写的名字");
		hubSessions(hub).setModel(bagOf(hub, metaId), "row-a", "model-a");
		hubSessions(hub).setThinkingLevel(bagOf(hub, metaId), "high");
		hubSessions(hub).setToolConfig(bagOf(hub, metaId), ["read"], { bash: true });
		check("the stream is byte-identical after the choices", (await readFile(jsonlPath, "utf8")) === logBefore);
		const stored = JSON.parse(await readFile(jsonPath, "utf8")) as Record<string, unknown>;
		check(
			"the snapshot carries every current value and the identity",
			stored.title === "重写的名字" &&
				JSON.stringify(stored.model) === JSON.stringify({ name: "row-a", modelId: "model-a" }) &&
				stored.thinkingLevel === "high" &&
				JSON.stringify(stored.activeTools) === JSON.stringify(["read"]) &&
				JSON.stringify(stored.approval) === JSON.stringify({ bash: true }) &&
				stored.version === CURRENT_SESSION_VERSION &&
				stored.id === metaId,
			JSON.stringify(stored),
		);
		check(
			"no temp file survived the rewrite",
			readdirSync(sessionDir(root)).every((name) => !name.endsWith(".tmp")),
			JSON.stringify(readdirSync(sessionDir(root))),
		);

		// A choice is a *change*: recording what the snapshot already says must not rewrite it, or
		// every no-op patch would cost a temp+rename. The wait gives a rewrite a measurable mtime to
		// land in — same-value or not, a write cannot land with the file's own earlier timestamp.
		const quiet = statSync(jsonPath).mtimeMs;
		await new Promise((resolve) => setTimeout(resolve, 20));
		hubSessions(hub).setTitle(bagOf(hub, metaId), "重写的名字");
		hubSessions(hub).setToolConfig(bagOf(hub, metaId), ["read"], { bash: true });
		check("an unchanged value does not rewrite the snapshot", statSync(jsonPath).mtimeMs === quiet, `${statSync(jsonPath).mtimeMs} vs ${quiet}`);

		// The restore seam: a reopen is fillSession, and the recorded answers come back whole — the
		// same parts the snapshot path a window reads is built from.
		hub.release(host);
		check("the session goes idle", await until(() => !hub.live.includes(metaId)));
		const restored = fillSession(jsonlPath);
		check(
			"a reopen restores the model and level",
			JSON.stringify(store.getRecordedSettings(restored)) ===
				JSON.stringify({ model: { name: "row-a", modelId: "model-a" }, thinkingLevel: "high" }),
			JSON.stringify(store.getRecordedSettings(restored)),
		);
		check(
			"and the tool choices",
			JSON.stringify(store.getRecordedToolConfig(restored)) === JSON.stringify({ activeTools: ["read"], approval: { bash: true } }),
			JSON.stringify(store.getRecordedToolConfig(restored)),
		);

		// A fork is a new pair of files, and the source's current values travel whole: title, model,
		// level, tool config — the session's own facts now, not entries a branch replay could restore.
		const carryId = await hub.fork(metaId, null);
		const carryFile = openFile(carryId);
		const carryJson = snapshotPathOf(carryFile.sessionFileAbsPath!);
		check("a fork is two files on disk", existsSync(carryJson) && existsSync(carryFile.sessionFileAbsPath!));
		const carryMeta = store.getMeta(carryFile);
		check(
			"the fork's snapshot carries the source's current values",
			carryMeta?.title === "重写的名字" &&
				carryMeta?.model?.name === "row-a" &&
				carryMeta?.model?.modelId === "model-a" &&
				carryMeta?.thinkingLevel === "high" &&
				carryMeta?.activeTools?.join(",") === "read" &&
				carryMeta?.approval?.bash === true,
			JSON.stringify(carryMeta),
		);
		check("and names the source's stream as its parent", carryMeta?.parentSession === jsonlPath, String(carryMeta?.parentSession));
	}

	process.stdout.write("an unknown id fails instead of quietly starting one\n");
	const missing = await hub.claim("0123456789abcdef").then(
		() => undefined,
		(error: unknown) => error,
	);
	check("claiming an unknown id rejects", missing instanceof Error, String(missing));
	check("and nothing entered the registry", !hub.live.includes("0123456789abcdef"));

	process.stdout.write("the settings files name the tools a session that never chose opens on\n");
	// The global default tool set is a settings field, so the seam is assembly itself: a session with
	// no recorded choice opens on the configured set, and one that chose keeps its own. Everything
	// here runs on an in-memory settings manager, so no file outside the temporary
	// working directory is ever touched.
	const settingsRoot = await mkdtemp(join(tmpdir(), "my-agent-settings-"));
	try {
		const settings = inMemorySettingManager({ tools: ["read", "bash"] }, []);
		const state = createSession(settingsRoot);
		const sessionId = state.sessionId;
		const options = {
			workDirAbsPath: settingsRoot,
			session: state,
			settings,
		};

		const cold = await readSessionSnapshot(options);
		check("a session with no entry opens on the settings' tool set", cold.activeTools.join(",") === "read,bash", cold.activeTools.join(","));
		check("and reports both halves as following global", cold.toolsFollowGlobal && cold.approvalsFollowGlobal);

		const live = await openAgent(options);
		try {
			// The one message the branch test below can rewind to with nothing recorded after it.
			const firstEntry = store.appendMessage(state, userMessage("before any choice"));

			live.setActiveTools(sessionId, ["read"]);
			check("a recorded choice wins over the default", live.snapshot(sessionId).activeTools.join(",") === "read", live.snapshot(sessionId).activeTools.join(","));
			check("and stops reporting the tools as global", live.snapshot(sessionId).toolsFollowGlobal === false);
			check("while the untouched approval half still follows global", live.snapshot(sessionId).approvalsFollowGlobal === true);

			live.applyConfig(sessionId, { approval: { bash: false } });
			check("a recorded approval stops its half too", live.snapshot(sessionId).approvalsFollowGlobal === false);

			// The reset *holds* the global values, so the judgement has to be field
			// equality and not "a choice exists" — the trap the panel's label would fall into otherwise.
			live.setActiveTools(sessionId, ["bash", "read"]);
			check("re-recording the global set reads as following global again", live.snapshot(sessionId).toolsFollowGlobal === true);

			// A branch move changes the leaf and nothing else: the recorded choices are the session's
			// own now, so the set it recorded stays in force.
			live.branchTo(sessionId, firstEntry, false);
			check("a branch move leaves the recorded set in force", live.snapshot(sessionId).activeTools.join(",") === "bash,read", live.snapshot(sessionId).activeTools.join(","));

			live.setActiveTools(sessionId, ["grep"]);
			const recold = await readSessionSnapshot(options);
			check(
				"the cold read answers the judgement exactly as the live snapshot does",
				recold.toolsFollowGlobal === live.snapshot(sessionId).toolsFollowGlobal &&
					recold.approvalsFollowGlobal === live.snapshot(sessionId).approvalsFollowGlobal,
				`${recold.toolsFollowGlobal}/${recold.approvalsFollowGlobal} vs ${live.snapshot(sessionId).toolsFollowGlobal}/${live.snapshot(sessionId).approvalsFollowGlobal}`,
			);
		} finally {
			await live.close(sessionId);
		}
	} finally {
		await rm(sessionDir(settingsRoot), { recursive: true, force: true });
		await rm(settingsRoot, { recursive: true, force: true });
	}

	process.stdout.write("reading a session does not assemble one\n");
	// Phase 1 in one section: a read answers from the JSONL log, leaves the registry exactly as it was,
	// and agrees field-for-field with what claiming the same transcript reports — because both build
	// their snapshot from the same parts.
	const http = await bootServer({ workDirAbsPath: root, port: 0 });
	try {
		const readId = await http.hub.newSession();
		const opened = await http.hub.claim(readId);
		hubSessions(http.hub).appendMessage(bagOf(http.hub, readId), userMessage("read me"));
		hubSessions(http.hub).appendMessage(bagOf(http.hub, readId), userMessage("and me"));
		http.hub.release(opened);
		check("the session is idle before the read", await until(() => !http.hub.live.includes(readId)), http.hub.live.join(","));

		// The phase's contract as a counter, because the registry cannot show it on its own: a claim
		// that is given straight back is reaped out of `live` within a tick — before a client can even
		// read the response — so the map is back where it started either way. Counting the entry point
		// is what actually catches a read that assembles; the `live` checks below are the state the
		// caller is promised, and they hold whatever the read did.
		let claims = 0;
		const claim = http.hub.claim.bind(http.hub);
		http.hub.claim = async (sessionId?: string) => {
			claims += 1;
			return claim(sessionId);
		};

		const firstRead = await get(`${http.url}/api/sessions/${readId}`);
		check("GET /api/sessions/{id} answers 200", firstRead.status === 200, `status=${firstRead.status}`);
		check("the cold transcript is not empty", (firstRead.session?.messages.length ?? 0) === 2, `${firstRead.session?.messages.length} messages`);
		// This is the whole phase in one line: reading a transcript never takes a claim on it.
		check("and the read never claimed the session", claims === 0, `claims=${claims}`);
		check("so nothing is running it", !http.hub.live.includes(readId), http.hub.live.join(","));
		// The read is also the window's decision about whether to attach a stream: a snapshot that
		// reports `submitting: false` is one the window renders without opening one, which is why the
		// claim count above is the whole evidence — an attach would have claimed through the hub.
		check("and it reports the session as idle", firstRead.session?.submitting === false, String(firstRead.session?.submitting));

		const secondRead = await get(`${http.url}/api/sessions/${readId}`);
		check(
			"reading it twice gives the same answer",
			JSON.stringify(secondRead.session) === JSON.stringify(firstRead.session),
		);
		check("and still nothing was claimed", claims === 0, `claims=${claims}`);

		const unknownRead = await get(`${http.url}/api/sessions/0123456789abcdef`);
		check("an unknown id is still 404", unknownRead.status === 404, `status=${unknownRead.status}`);
		check("and an unknown id is never claimed either", claims === 0, `claims=${claims}`);

		// What the cold read must agree with. Claiming it here is the deliberate claim, and the only
		// one this section makes: everything the transcript can answer has to come out the same.
		const live = await http.hub.claim(readId);
		check("a claim is what runs it", claims === 1 && live.id === readId, `claims=${claims}`);
		const liveSnapshot = http.hub.agent.snapshot(live.id);
		http.hub.release(live);

		// Everything a transcript can answer must be identical; only what a loop answers may differ.
		const fromTranscript = [
			"messages",
			"messageEntryIds",
			"branchPoints",
			"leafId",
			"title",
			"model",
			"thinkingLevel",
			"thinkingLevels",
			"allTools",
			"activeTools",
			"toolsFollowGlobal",
			"approvalsFollowGlobal",
			"approvals",
			"usage",
		] as const satisfies readonly (keyof SessionSnapshot)[];
		const mismatched = fromTranscript.filter(
			(field) => JSON.stringify(firstRead.session?.[field]) !== JSON.stringify(liveSnapshot[field]),
		);
		check("the cold read matches the live session field for field", mismatched.length === 0, mismatched.join(","));

		const onlyALoopAnswers = new Set<keyof SessionSnapshot>([
			"submitting",
			"queued",
			"isRetrying",
			"retryAttempt",
			"pendingApprovals",
		]);
		const keys = [...new Set([...Object.keys(firstRead.session ?? {}), ...Object.keys(liveSnapshot)])] as (keyof SessionSnapshot)[];
		const differing = keys.filter(
			(field) => JSON.stringify(firstRead.session?.[field]) !== JSON.stringify(liveSnapshot[field]),
		);
		check(
			"and differs only in what a loop answers",
			differing.every((field) => onlyALoopAnswers.has(field)),
			differing.join(","),
		);

		process.stdout.write("POST /api/sessions takes the directory it is given\n");
		// The directory is not a fence, so a first session in a directory the process has
		// never worked in is refused by nothing more than "exists and is a directory".
		const elsewhere = await mkdtemp(join(tmpdir(), "my-agent-elsewhere-"));
		try {
			const created = await call("POST", `${http.url}/api/sessions`, { workDirAbsPath: elsewhere });
			check("a new directory is accepted (201)", created.status === 201, `status=${created.status}`);
			const landed = String(created.payload.sessionId ?? "");
			const landedRead = await get(`${http.url}/api/sessions/${landed}`);
			check(
				"and the session runs where it was told",
				resolve(landedRead.session?.workDirAbsPath ?? "") === resolve(elsewhere),
				`${landedRead.session?.workDirAbsPath}`,
			);
			// A session writes nothing until its first message, so a listing taken at creation cannot
			// name it — and that is the rule rather than a race: the sidebar lists conversations, and a
			// conversation nobody has said anything in is not one. Speaking once is what puts it there.
			check(
				"the answer's listing does not name a session with nothing said in it",
				!(created.payload.sessions as { id: string }[]).some((session) => session.id === landed),
			);
			const spoke = await http.hub.claim(landed);
			hubSessions(http.hub).appendMessage(bagOf(http.hub, landed), userMessage("a first message"));
			http.hub.release(spoke);
			const groups = ((await call("GET", `${http.url}/api/directories`)).payload.directories as {
				workDirAbsPath: string;
				sessions: { id: string }[];
			}[]) ?? [];
			const group = groups.find((candidate) => resolve(candidate.workDirAbsPath) === resolve(elsewhere));
			check(
				"and lists it under that directory once it has a message",
				(group?.sessions ?? []).some((session) => session.id === landed),
				JSON.stringify(group?.sessions),
			);

			await writeFile(join(elsewhere, "a-file"), "not a directory\n");
			const missing = await call("POST", `${http.url}/api/sessions`, { workDirAbsPath: join(elsewhere, "no-such-dir") });
			check("a directory that does not exist is refused (400)", missing.status === 400, `status=${missing.status}`);
			const notDir = await call("POST", `${http.url}/api/sessions`, { workDirAbsPath: join(elsewhere, "a-file") });
			check("a path that is not a directory is refused (400)", notDir.status === 400, `status=${notDir.status}`);
			const wrongType = await call("POST", `${http.url}/api/sessions`, { workDirAbsPath: 42 });
			check("a non-string workDirAbsPath is refused (400)", wrongType.status === 400, `status=${wrongType.status}`);
			const bodyless = await call("POST", `${http.url}/api/sessions`);
			check("an empty POST still creates (201)", bodyless.status === 201, `status=${bodyless.status}`);
			const bodylessRead = await get(`${http.url}/api/sessions/${String(bodyless.payload.sessionId ?? "")}`);
			check("and it runs where the server does", resolve(bodylessRead.session?.workDirAbsPath ?? "") === resolve(root), bodylessRead.session?.workDirAbsPath);
		} finally {
			await rm(sessionDir(elsewhere), { recursive: true, force: true });
			await rm(elsewhere, { recursive: true, force: true });
		}

		process.stdout.write("the settings endpoint validates the default tool set\n");
		// Only refusals here: an accepted write lands in the real agent home's settings file, and this
		// script does not own that file. The accepted shape is proven on the seam above.
		const notArray = await call("PATCH", `${http.url}/api/settings`, { patch: { tools: "read" } });
		check("`tools` must be an array (400)", notArray.status === 400, `status=${notArray.status}`);
		const notNames = await call("PATCH", `${http.url}/api/settings`, { patch: { tools: [42] } });
		check("every entry must be a string (400)", notNames.status === 400, `status=${notNames.status}`);

		process.stdout.write("a directory can be renamed and put aside\n");
		// 票 06's two directory commands, end to end. A directory is listed by making a session in it,
		// which is the only road one enters the sidebar by — and the reason this section can run against
		// a directory of its own instead of the server's root, whose name the sections after this one
		// still refer to. The agent home is a scratch one so the settings this writes are not the
		// machine's own.
		{
			const home = await mkdtemp(join(tmpdir(), "my-agent-agent-home-"));
			const host = await mkdtemp(join(tmpdir(), "my-agent-directories-"));
			const http = await bootServer({ workDirAbsPath: root, port: 0, settingsHome: home });
			const listed = async (): Promise<string[]> =>
				(((await call("GET", `${http.url}/api/directories`)).payload.directories as { workDirAbsPath: string }[]) ?? []).map(
					(group) => resolve(group.workDirAbsPath),
				);
			const before = join(host, "before");
			const other = join(host, "other");
			try {
				for (const dir of [before, other]) await mkdir(dir, { recursive: true });

				const created = await call("POST", `${http.url}/api/sessions`, { workDirAbsPath: before });
				const id = String(created.payload.sessionId ?? "");
				const elsewhere = await call("POST", `${http.url}/api/sessions`, { workDirAbsPath: other });
				// A directory earns its group by holding a conversation, and a session has no file until
				// its first message — so each of these says one thing before the sidebar can draw it.
				const speak = async (sessionId: string, text: string): Promise<void> => {
					const host = await http.hub.claim(sessionId);
					hubSessions(http.hub).appendMessage(bagOf(http.hub, sessionId), userMessage(text));
					http.hub.release(host);
				};
				await speak(id, "before");
				await speak(String(elsewhere.payload.sessionId ?? ""), "other");
				check("two new directories are listed as two groups", (await listed()).includes(resolve(before)) && (await listed()).includes(resolve(other)));

				const malformed = await call("POST", `${http.url}/api/directories/hide`, { workDirAbsPath: 42 });
				check("hiding with a non-string path is refused (400)", malformed.status === 400, `status=${malformed.status}`);

				// A name is a label, so the refusals a move needed — a target already taken, a missing
				// parent — have nothing to answer here. What is left is whether the path is one this
				// machine lists, and whether a name arrived at all.
				const unknown = await call("POST", `${http.url}/api/directories/rename`, { workDirAbsPath: join(host, "nowhere"), name: "x" });
				check("naming a directory this machine does not list is a 404", unknown.status === 404, `status=${unknown.status}`);
				const wrongName = await call("POST", `${http.url}/api/directories/rename`, { workDirAbsPath: before, name: 42 });
				check("a non-string name is refused (400)", wrongName.status === 400, `status=${wrongName.status}`);

				const named = await call("POST", `${http.url}/api/directories/rename`, { workDirAbsPath: before, name: "改过的名字" });
				check("naming a directory is accepted (200)", named.status === 200, `status=${named.status}`);
				check("the answer names the path it was asked about", resolve(String(named.payload.workDirAbsPath ?? "")) === resolve(before), JSON.stringify(named.payload));
				const namedSet = (named.payload.settings as { directoryNames?: Record<string, string> })?.directoryNames ?? {};
				check("and the settings carry the label", namedSet[resolve(before)] === "改过的名字", JSON.stringify(namedSet));
				const storedNames = ((await call("GET", `${http.url}/api/settings`)).payload.settings as { directoryNames?: Record<string, string> })
					?.directoryNames ?? {};
				check("a later read sees it too", storedNames[resolve(before)] === "改过的名字", JSON.stringify(storedNames));

				// Nothing on disk moves, which is the whole difference from the folder rename this
				// replaced: the directory, the store keyed by it, and the header's workDirAbsPath all stay put.
				check("the folder is exactly where it was", existsSync(before));
				const kept = await get(`${http.url}/api/sessions/${id}`);
				check("the session still names its own directory", resolve(kept.session?.workDirAbsPath ?? "") === resolve(before), kept.session?.workDirAbsPath);
				check("and its transcript is still under that key", (await SessionManager.list(before)).some((session) => session.id === id));
				check("the listing draws the path, not the label", (await listed()).includes(resolve(before)));

				const cleared = await call("POST", `${http.url}/api/directories/rename`, { workDirAbsPath: before, name: "  " });
				const clearedSet = (cleared.payload.settings as { directoryNames?: Record<string, string> })?.directoryNames ?? {};
				check("an empty name takes the label back (200)", cleared.status === 200 && (clearedSet[resolve(before)] ?? "") === "", JSON.stringify(cleared.payload));

				const hidden = await call("POST", `${http.url}/api/directories/hide`, { workDirAbsPath: before });
				check("hiding a directory is accepted (200)", hidden.status === 200, `status=${hidden.status}`);
				check("the answer's listing no longer draws the group", !((hidden.payload.directories as { workDirAbsPath: string }[]) ?? []).some((group) => resolve(group.workDirAbsPath) === resolve(before)));
				check(
					"and the stored setting records it",
					((hidden.payload.settings as { hiddenDirectories?: string[] })?.hiddenDirectories ?? []).some((path) => resolve(path) === resolve(before)),
				);
				check("the next listing leaves it out too", !(await listed()).includes(resolve(before)));
				check("but the folder is exactly where it was", existsSync(before));
				check("and the transcript is untouched", (await SessionManager.list(before)).some((session) => session.id === id));
				check("the other directory is still listed", (await listed()).includes(resolve(other)));

				const restored = await call("PATCH", `${http.url}/api/settings`, { patch: { hiddenDirectories: [] } });
				check("an empty hidden list is stored as a choice (200)", restored.status === 200, `status=${restored.status}`);
				check("and the group comes back", (await listed()).includes(resolve(before)));

				// 删除 is not a one-way door, and this is the door: the transcripts and the folder were
				// never touched, so a new session in that directory is the user saying they want it listed
				// again. Nothing else in the window can un-hide one, which is why the road has to exist.
				const hiddenAgain = await call("POST", `${http.url}/api/directories/hide`, { workDirAbsPath: before });
				check("hiding it a second time is accepted (200)", hiddenAgain.status === 200, `status=${hiddenAgain.status}`);
				check("and it leaves the listing again", !(await listed()).includes(resolve(before)));
				const reborn = await call("POST", `${http.url}/api/sessions`, { workDirAbsPath: before });
				check("a new session in it is accepted (201)", reborn.status === 201, `status=${reborn.status}`);
				check("a new session in a put-aside directory lists it again", (await listed()).includes(resolve(before)));
				const storedHidden =
					(((await call("GET", `${http.url}/api/settings`)).payload.settings as { hiddenDirectories?: string[] })?.hiddenDirectories ?? []);
				check("and the stored list no longer names it", !storedHidden.some((path) => resolve(path) === resolve(before)), JSON.stringify(storedHidden));

				// A user can rename a folder behind this process's back. The transcripts stay in the store,
				// so the group is still listed — and a new session there puts the directory back instead of
				// failing on a path nothing on screen says is gone.
				await rm(before, { recursive: true, force: true });
				check("the directory itself is gone", !existsSync(before));
				const putBack = await call("POST", `${http.url}/api/sessions`, { workDirAbsPath: before });
				check("a new session puts the directory back (201)", putBack.status === 201, `status=${putBack.status}`);
				check("and the folder exists again", existsSync(before));
				void elsewhere;
			} finally {
				for (const dir of [before, other]) await rm(sessionDir(dir), { recursive: true, force: true });
				for (const dir of [before, other]) await rm(dir, { recursive: true, force: true });
				await rm(host, { recursive: true, force: true });
				await http.close();
				await rm(home, { recursive: true, force: true });
			}
		}

		process.stdout.write("a rename stores a name and a delete removes the session\n");
		// The two row-menu actions the window offers, over the real route table: a rename lands as one
		// entry and answers 201, a blank one is refused before anything is written, and a delete takes
		// the file with it — refusing first while a claim is still held.
		{
			const victim = await http.hub.newSession();
			const host = await http.hub.claim(victim);
			hubSessions(http.hub).appendMessage(bagOf(http.hub, victim), userMessage("要删的会话"));
			http.hub.release(host);
			check("the victim goes idle", await until(() => !http.hub.live.includes(victim)), http.hub.live.join(","));

			const blank = await call("POST", `${http.url}/api/sessions/${victim}/title`, { title: "   " });
			check("a blank name is refused (400)", blank.status === 400, `status=${blank.status}`);
			const wrongType = await call("POST", `${http.url}/api/sessions/${victim}/title`, { title: 42 });
			check("a non-string name is refused (400)", wrongType.status === 400, `status=${wrongType.status}`);
			const named = await call("POST", `${http.url}/api/sessions/${victim}/title`, { title: "新名字" });
			check("a rename is accepted (201)", named.status === 201, `status=${named.status}`);
			check("the answer carries the stored name", named.payload.title === "新名字", JSON.stringify(named.payload));
			const reread = await get(`${http.url}/api/sessions/${victim}`);
			check("and the snapshot reports it", reread.session?.title === "新名字", reread.session?.title);

			const busy = await http.hub.claim(victim);
			const refused = await call("DELETE", `${http.url}/api/sessions/${victim}`);
			check("deleting a claimed session is refused (409)", refused.status === 409, `status=${refused.status}`);
			http.hub.release(busy);
			check("the claim lets go", await until(() => !http.hub.live.includes(victim)));

			const removed = await call("DELETE", `${http.url}/api/sessions/${victim}`);
			check("an idle session is deleted (200)", removed.status === 200, `status=${removed.status}`);
			check("the answer says what happened", removed.payload.removed === true, JSON.stringify(removed.payload));
			const gone = await get(`${http.url}/api/sessions/${victim}`);
			check("and then it is a 404", gone.status === 404, `status=${gone.status}`);
			const second = await call("DELETE", `${http.url}/api/sessions/${victim}`);
			check("a second delete is a 404 too", second.status === 404, `status=${second.status}`);
			check("and the file is really gone", SessionManager.findSessionFilePathById(victim) === undefined);
		}
	} finally {
		await http.close();
	}

	process.stdout.write("the stateless form replays the ledger per request\n");
	// The session operations, called with a bare Session. A state is transient — built by
	// fillSession from the file, discarded when the request ends — so nothing here holds a state
	// between sections except where a check says otherwise.
	{
		const statelessRoot = await mkdtemp(join(tmpdir(), "my-agent-stateless-"));
		try {
			const s = createSession(statelessRoot);
			check("a fresh state has a path but no file yet", s.sessionFileAbsPath !== undefined && !existsSync(s.sessionFileAbsPath));
			const one = store.appendMessage(s, userMessage("stateless first"));
			store.appendMessage(s, userMessage("stateless second"));
			check("the first message created the file", s.sessionFileAbsPath !== undefined && existsSync(s.sessionFileAbsPath));
			check("and the context follows the leaf", store.buildSessionContext(s).messages.length === 2);

			const replayed = fillSession(s.sessionFileAbsPath!);
			check(
				"a replay lands on the same leaf",
				replayed.leafId === s.leafId,
				`${replayed.leafId} vs ${s.leafId}`,
			);
			check(
				"and rebuilds the same transcript",
				JSON.stringify(store.buildSessionContext(replayed).messages) === JSON.stringify(store.buildSessionContext(s).messages),
			);
			check("and the same title", store.getTitle(replayed) === store.getTitle(s));

			store.branch(replayed, one);
			check("a stateless branch moves the leaf", replayed.leafId === one, String(replayed.leafId));
			check("while the state appended to stays put", s.leafId !== one, String(s.leafId));
			const rebranched = fillSession(s.sessionFileAbsPath!);
			check("the branch move is replayed from the file", rebranched.leafId === one, String(rebranched.leafId));

			// The service's open: one replay per call, no registration, the caller drops the bag. Two
			// opens answer two bags on purpose — there is no cache to reuse, and anything that needed
			// "the same bag twice" is a held session's business, the orchestrator table's.
			const service = new SessionManager();
			const cold = service.open(s.sessionId);
			check(
				"the service and the stateless form agree",
				JSON.stringify(store.buildSessionContext(cold).messages) === JSON.stringify(store.buildSessionContext(replayed).messages),
			);
			store.appendMessage(cold, userMessage("written through the cold bag"));
			const throughCold = fillSession(s.sessionFileAbsPath!);
			check(
				"a write through the cold bag reaches the file",
				throughCold.leafId === cold.leafId &&
					JSON.stringify(store.buildSessionContext(throughCold).messages) === JSON.stringify(store.buildSessionContext(cold).messages),
			);
			let refused = false;
			try {
				new SessionManager().open("no session has this id");
			} catch {
				refused = true;
			}
			check("open refuses an id with no file behind it", refused);
		} finally {
			await rm(sessionDir(statelessRoot), { recursive: true, force: true });
			await rm(statelessRoot, { recursive: true, force: true });
		}
	}

	process.stdout.write("the orchestrator's table keys the live half by id\n");
	// ADR-0011: the table on the orchestrator holds exactly what cannot be rebuilt from disk — the
	// queues, the run in flight, the subscriber sets. `adopt` is its one way in, first-come: a state
	// already there is kept, never replaced, because the one it would replace holds the live half.
	// The exits are two and deliberately different: `evict` refuses unless the criteria hold, and
	// `drop` does not ask. There is no clear — the table lives and dies with the orchestrator itself.
	{
		const agent = createSessionAgent({ sessionManager: new SessionManager(), settings: new SettingManager({ models: [] }) });
		// The seed's assembly fields are irrelevant to what this block pins — the table and its
		// doors — so it hands the placeholder answers a session with no row would carry.
		const settings = inMemorySettingManager({});
		const session = createSession(tmpdir());
		const seed = () =>
			createAgentState(session, createLive(settings.getSteeringMode(tmpdir()), settings.getFollowUpMode(tmpdir())));
		const state = seed();
		agent.adopt(state);
		check("adopt is the one way in, and the id answers it", agent.agentState(session.sessionId) === state);
		agent.adopt(seed());
		check("re-adopting an id keeps the state already there", agent.agentState(session.sessionId) === state);
		check("an unborn session refuses to be evicted", agent.evict(session.sessionId) === false);
		check("drop removes the state whatever it holds", agent.drop(session.sessionId) === true && agent.drop(session.sessionId) === false);
		let refused = false;
		try {
			agent.agentState(session.sessionId);
		} catch {
			refused = true;
		}
		check("an id no longer in the table refuses to answer", refused);
	}

	process.stdout.write("a pair this build cannot open is deleted, not kept\n");
	// v5 keeps no migration and no quarantine: a v≤4 file (header-in-JSONL, no snapshot), an unpaired
	// half, and a wrong version are all sessions nothing can ever open again, so every reader that
	// proves a pair unopenable removes it. Both trigger points are driven here: the listing scan and
	// the open. Handwritten, because no build that writes v5 would ever produce one.
	{
		const legacyRoot = await mkdtemp(join(tmpdir(), "my-agent-legacy-"));
		try {
			const dir = sessionDir(legacyRoot);
			await mkdir(dir, { recursive: true });
			const stamp = new Date().toISOString();
			const entries = [
				JSON.stringify({ type: "message", id: "lg-u1", parentId: null, timestamp: stamp, message: { role: "user", content: [{ type: "text", text: "a v4 conversation" }] } }),
			];

			// --- A v≤4 file: one JSONL, header line first, no snapshot --------------------------------
			const v4File = join(dir, "2026-01-01T00-00-00-000Z_v4session.jsonl");
			await writeFile(
				v4File,
				[JSON.stringify({ type: "SessionHeader", version: 4, id: "v4session", timestamp: stamp, workDir: legacyRoot }), ...entries].join("\n") + "\n",
				"utf8",
			);

			// --- An unpaired snapshot and a wrong-version pair -----------------------------------------
			const orphanJson = join(dir, "2026-01-01T00-00-01-000Z_orphan.json");
			await writeFile(orphanJson, JSON.stringify({ version: CURRENT_SESSION_VERSION, id: "orphan", timestamp: stamp, workDir: legacyRoot }), "utf8");
			const wrongStem = join(dir, "2026-01-01T00-00-02-000Z_wrong");
			await writeFile(`${wrongStem}.json`, JSON.stringify({ version: CURRENT_SESSION_VERSION + 1, id: "wrong", timestamp: stamp, workDir: legacyRoot }), "utf8");
			await writeFile(`${wrongStem}.jsonl`, `${entries.join("\n")}\n`, "utf8");

			const listed = await SessionManager.list(legacyRoot);
			check("the listing returns none of them", listed.length === 0, JSON.stringify(listed.map((info) => info.id)));
			check("the v4 file is gone", !existsSync(v4File));
			check("the unpaired snapshot is gone", !existsSync(orphanJson));
			check("the wrong-version pair is gone", !existsSync(`${wrongStem}.json`) && !existsSync(`${wrongStem}.jsonl`));

			// --- The open prunes too: an unpaired stream is refused and removed -----------------------
			const aloneStem = join(dir, "2026-01-01T00-00-03-000Z_alone");
			await writeFile(`${aloneStem}.jsonl`, `${entries.join("\n")}\n`, "utf8");
			let refused = false;
			try {
				fillSession(`${aloneStem}.jsonl`);
			} catch {
				refused = true;
			}
			check("opening an unpaired stream throws", refused);
			check("and the open deleted it", !existsSync(`${aloneStem}.jsonl`));
		} finally {
			await rm(sessionDir(legacyRoot), { recursive: true, force: true });
			await rm(legacyRoot, { recursive: true, force: true });
		}
	}

	process.stdout.write("shutdown settles everything\n");
	await hub.close();
	check("nothing is left running", hub.live.length === 0);
} finally {
	// Sessions live under the agent home, keyed by the working directory path, so removing the temporary
	// directory is not enough: without this every run leaves an orphan directory behind.
	await rm(sessionDir(root), { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nsessions ok\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
