// Session-registry smoke test: proves one agent loop per session id, that a session survives losing
// its last connection, and that the JSONL file is what a later connection gets back.
// Nothing here reaches a model, so no provider key is needed. Run with: node scripts/smoke-sessions.ts
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import type { Message } from "@my-agent/llm";
import { bootServer } from "../packages/server/src/boot.ts";
import { SessionHub } from "../packages/server/src/hub.ts";
import {
	openAgent,
	readSessionSnapshot,
	SessionManager,
	SettingsManager,
	workspaceDir,
	type SessionSnapshot,
} from "@my-agent/core";

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

/** The messages of a manager's current branch, which is what a provider would be sent. */
function messagesOf(manager: SessionManager): Message[] {
	return manager.buildSessionContext().messages;
}

/** Open the stored file for a session id, the way a later process would. */
function openFile(id: string): SessionManager {
	const path = SessionManager.findSessionFilePathById(id);
	if (path === undefined) throw new Error(`no session file for ${id}`);
	return SessionManager.open(path);
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

const hub = new SessionHub({ absCwd: root });

try {
	process.stdout.write("one session per id\n");
	// The id is asked for first and then claimed by name, which is the only shape production has: a
	// request never omits the id, so "which session is current" is `GET /api/sessions/current`'s
	// question and not the claim's.
	const landing = await hub.currentSessionId();
	const first = await hub.claim(landing);
	const second = await hub.claim(landing);
	check("two connections with no id share one session", first.session === second.session);
	check("both claims are counted", first.claims === 2, `claims=${first.claims}`);
	check("the hub runs it once", hub.live.length === 1, hub.live.join(","));

	process.stdout.write("claiming by id\n");
	const again = await hub.claim(first.id);
	check("returns the session already running", again.session === first.session);
	check("claims add up", first.claims === 3, `claims=${first.claims}`);

	process.stdout.write("a claim outlives the connections that dropped it\n");
	hub.release(again);
	hub.release(second);
	check("still running with one claim left", first.claims === 1 && hub.live.includes(first.id));
	await new Promise((resolve) => setTimeout(resolve, 50));
	check("a claimed session is never forgotten", hub.live.includes(first.id));

	process.stdout.write("the last release forgets an idle session\n");
	first.session.sessionManager.appendMessage(userMessage("survives the reap"));
	hub.release(first);
	check("the session is closed and dropped", await until(() => !hub.live.includes(first.id)));

	process.stdout.write("the JSONL file is what survives\n");
	const reopened = await hub.claim(first.id);
	check("reopening builds a different session object", reopened.session !== first.session);
	check(
		"and it still carries the transcript",
		JSON.stringify(reopened.session.snapshot.messages).includes("survives the reap"),
	);
	await hub.close();

	process.stdout.write("new_session moves the landing spot\n");
	const created = await hub.newSession();
	const landed = await hub.claim(await hub.currentSessionId());
	check("an unnamed claim lands on the newest session", landed.id === created, `${landed.id} vs ${created}`);

	process.stdout.write("a fork is the branch up to one entry\n");
	const parentId = await hub.newSession();
	const parent = await hub.claim(parentId);
	const parentFile = parent.session.sessionFile ?? "";
	const entryOne = parent.session.sessionManager.appendMessage(userMessage("first"));
	parent.session.sessionManager.appendMessage(userMessage("second"));

	const forkedId = await hub.fork(parentId, entryOne);
	// Read the file the fork wrote, before a session opens over it and records its own model.
	const forkedFile = openFile(forkedId);
	const branch = parent.session.sessionManager.getBranch(entryOne);
	check("the fork is a new session id", forkedId !== parentId, `${forkedId} vs ${parentId}`);
	check(
		"it holds the prefix through that message",
		messagesOf(forkedFile).length === 1 && JSON.stringify(messagesOf(forkedFile)).includes("first"),
		`${messagesOf(forkedFile).length} messages`,
	);
	check(
		"with the same entry ids",
		ids(forkedFile.getEntries()) === ids(branch),
		`${ids(forkedFile.getEntries())} vs ${ids(branch)}`,
	);
	check(
		"and the message entry ids line up",
		JSON.stringify(forkedFile.getContextMessageEntryIds()) === JSON.stringify([entryOne]),
		JSON.stringify(forkedFile.getContextMessageEntryIds()),
	);
	check("its leaf is that entry's id", forkedFile.getLeafId() === entryOne, String(forkedFile.getLeafId()));
	check("the header names the file it came from", forkedFile.getHeader()?.parentSession === parentFile, String(forkedFile.getHeader()?.parentSession));
	check(
		"the source keeps the entries the fork did not take",
		parent.session.sessionManager.getChildren(entryOne).length === 1,
		`children=${parent.session.sessionManager.getChildren(entryOne).length}`,
	);

	const forked = await hub.claim(forkedId);
	check("the fork runs as a session of its own", forked.session !== parent.session);
	check("and it reports the file it came from", forked.session.sessionManager.getHeader()?.parentSession === parentFile);

	process.stdout.write("forking without an entry copies the whole log\n");
	const whole = SessionManager.forkFrom(parentFile, root, null, workspaceDir(root));
	check("every entry came with it", ids(whole.getEntries()) === ids(parent.session.sessionManager.getEntries()));
	check("and the transcript matches", messagesOf(whole).length === messagesOf(parent.session.sessionManager).length);
	check("its leaf is the source's leaf", whole.getLeafId() === parent.session.sessionManager.getLeafId());
	check("it points back at the source too", whole.getHeader()?.parentSession === parentFile);

	process.stdout.write("forking leaves the source alone\n");
	const before = await readFile(parentFile, "utf8");
	const leafBefore = parent.session.sessionManager.getLeafId();
	const secondFork = openFile(await hub.fork(parentId, entryOne));
	check("the source keeps its own leaf", parent.session.sessionManager.getLeafId() === leafBefore);
	check("its file is byte-identical afterwards", (await readFile(parentFile, "utf8")) === before);
	check("the claim on it survived", parent.claims === 1 && hub.live.includes(parentId), `claims=${parent.claims}`);

	process.stdout.write("a fork and its parent run side by side\n");
	check("both are live", hub.live.includes(parentId) && hub.live.includes(forkedId));
	const forkBefore = JSON.stringify(messagesOf(forked.session.sessionManager));
	const forkLeaf = forked.session.sessionManager.getLeafId();
	parent.session.sessionManager.appendMessage(userMessage("only the parent"));
	check(
		"appending to the parent leaves the fork's transcript alone",
		JSON.stringify(messagesOf(forked.session.sessionManager)) === forkBefore,
	);
	check("and the fork's leaf did not move", forked.session.sessionManager.getLeafId() === forkLeaf);
	const parentBefore = JSON.stringify(messagesOf(parent.session.sessionManager));
	forked.session.sessionManager.appendMessage(userMessage("only the fork"));
	check(
		"appending to the fork leaves the parent's transcript alone",
		JSON.stringify(messagesOf(parent.session.sessionManager)) === parentBefore,
	);

	process.stdout.write("reopening a fork reports where it came from\n");
	const leafAtClose = forked.session.sessionManager.getLeafId();
	hub.release(forked);
	check("the fork is closed and dropped", await until(() => !hub.live.includes(forkedId)));
	const reread = openFile(forkedId);
	check("reopening reports its parent session", reread.getHeader()?.parentSession === parentFile);
	check("and the same leaf", reread.getLeafId() === leafAtClose, `${reread.getLeafId()} vs ${leafAtClose}`);
	check("with the messages it had", messagesOf(reread).length === messagesOf(forked.session.sessionManager).length);
	const reopenedFork = await hub.claim(forkedId);
	check("a claimed reopen builds a different session object", reopenedFork.session !== forked.session);
	check("and still reports the session it came from", reopenedFork.session.sessionManager.getHeader()?.parentSession === parentFile);

	process.stdout.write("forking a session nobody is watching\n");
	hub.release(reopenedFork);
	await until(() => !hub.live.includes(forkedId));
	const onDisk = openFile(forkedId);
	const cold = await hub.fork(forkedId, onDisk.getLeafId());
	check("an on-disk session forks too", cold !== forkedId && cold !== parentId, cold);
	check("it is not running until someone claims it", !hub.live.includes(cold));
	const coldFile = openFile(cold);
	check("its branch ends where it was told to", coldFile.getLeafId() === onDisk.getLeafId());
	check("and it points at the session it came from", coldFile.getHeader()?.parentSession === SessionManager.findSessionFilePathById(forkedId));
	check("the other fork is a session of its own", secondFork.getSessionId() !== forkedId && secondFork.getSessionId() !== cold);

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

	// The sidebar reads the workspace groups rather than one directory, so the same link has to survive
	// that path: a fork listed under a workspace has to name a parent that is listed with it.
	const groups = await SessionManager.listWorkspaces();
	const group = groups.find((candidate) => candidate.sessions.some((session) => session.id === forkedId));
	check("the workspace listing carries the same parent", group?.sessions.find((session) => session.id === forkedId)?.parentId === parentId, JSON.stringify(group?.sessions.map((session) => [session.id, session.parentId])));
	check(
		"and every parent it names is in its own group",
		(group?.sessions ?? []).every(
			(session) => session.parentId === undefined || (group?.sessions ?? []).some((other) => other.id === session.parentId),
		),
		JSON.stringify(group?.sessions.map((session) => [session.id, session.parentId])),
	);

	process.stdout.write("a rename is stored and outlives a reopen\n");
	// The rename is one entry appended to the file (ADR-0002), read back in file order by every path
	// that names a session — the live manager, the scan, and the fork that copies the whole log.
	{
		const renamedId = await hub.newSession();
		const host = await hub.claim(renamedId);
		host.session.sessionManager.appendMessage(userMessage("改名的会话"));
		await hub.rename(renamedId, "新名字");
		check("a live session reports the stored name", host.session.snapshot.title === "新名字", host.session.snapshot.title);

		hub.release(host);
		check("the renamed session closes", await until(() => !hub.live.includes(renamedId)));
		const rescanned = await SessionManager.findSessionRowById(renamedId);
		check("the file's row carries the stored name", rescanned?.title === "新名字", rescanned?.title);
		const reopened = await hub.claim(renamedId);
		check("a reopen reports it too", reopened.session.snapshot.title === "新名字", reopened.session.snapshot.title);

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

	process.stdout.write("an unknown id fails instead of quietly starting one\n");
	const missing = await hub.claim("0123456789abcdef").then(
		() => undefined,
		(error: unknown) => error,
	);
	check("claiming an unknown id rejects", missing instanceof Error, String(missing));
	check("and nothing entered the registry", !hub.live.includes("0123456789abcdef"));

	process.stdout.write("the settings files name the tools a session that never chose opens on\n");
	// The global default tool set is a settings field, so the seam is assembly itself: a session with
	// no `tool_config` entry opens on the configured set, one with an entry keeps its own, and a
	// branch move onto an unrecorded chain restores the default rather than the previous branch's set.
	// Everything here runs on an in-memory settings manager, so no file outside the temporary
	// workspace is ever touched.
	const settingsRoot = await mkdtemp(join(tmpdir(), "my-agent-settings-"));
	try {
		const settings = SettingsManager.inMemory({ tools: ["read", "bash"] });
		const manager = SessionManager.create(settingsRoot);
		const options = {
			absWorkspaceRoot: settingsRoot,
			sessionManager: manager,
			models: { list: () => [] },
			settingsManager: settings,
		};

		const cold = await readSessionSnapshot(options);
		check("a session with no entry opens on the settings' tool set", cold.activeTools.join(",") === "read,bash", cold.activeTools.join(","));
		check("and reports both halves as following global", cold.toolsFollowGlobal && cold.approvalsFollowGlobal);

		const live = await openAgent(options);
		try {
			// The one message the branch test below can rewind to with nothing recorded after it.
			const firstEntry = manager.appendMessage(userMessage("before any choice"));

			live.setActiveTools(["read"]);
			check("a recorded choice wins over the default", live.snapshot.activeTools.join(",") === "read", live.snapshot.activeTools.join(","));
			check("and stops reporting the tools as global", live.snapshot.toolsFollowGlobal === false);
			check("while the untouched approval half still follows global", live.snapshot.approvalsFollowGlobal === true);

			live.applyConfig({ approval: { bash: false } });
			check("a recorded approval stops its half too", live.snapshot.approvalsFollowGlobal === false);

			// The reset is a new entry that *holds* the global values, so the judgement has to be field
			// equality and not "an entry exists" — the trap the panel's label would fall into otherwise.
			live.setActiveTools(["bash", "read"]);
			check("re-recording the global set reads as following global again", live.snapshot.toolsFollowGlobal === true);

			// A branch move onto a chain that recorded nothing lands on the settings' answer, not on
			// the chain that was just left.
			live.branchTo(firstEntry, false);
			check("a branch onto an unrecorded chain restores the default", live.snapshot.activeTools.join(",") === "read,bash", live.snapshot.activeTools.join(","));

			live.setActiveTools(["grep"]);
			const recold = await readSessionSnapshot(options);
			check(
				"the cold read answers the judgement exactly as the live snapshot does",
				recold.toolsFollowGlobal === live.snapshot.toolsFollowGlobal &&
					recold.approvalsFollowGlobal === live.snapshot.approvalsFollowGlobal,
				`${recold.toolsFollowGlobal}/${recold.approvalsFollowGlobal} vs ${live.snapshot.toolsFollowGlobal}/${live.snapshot.approvalsFollowGlobal}`,
			);
		} finally {
			await live.close();
		}
	} finally {
		await rm(workspaceDir(settingsRoot), { recursive: true, force: true });
		await rm(settingsRoot, { recursive: true, force: true });
	}

	process.stdout.write("reading a session does not assemble one\n");
	// Phase 1 in one section: a read answers from the JSONL log, leaves the registry exactly as it was,
	// and agrees field-for-field with what claiming the same transcript reports — because both build
	// their snapshot from the same parts.
	const http = await bootServer({ absCwd: root, port: 0 });
	try {
		const readId = await http.hub.newSession();
		const opened = await http.hub.claim(readId);
		opened.session.sessionManager.appendMessage(userMessage("read me"));
		opened.session.sessionManager.appendMessage(userMessage("and me"));
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
		const liveSnapshot = live.session.snapshot;
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
		// The workspace is only the tools' fence, so a first session in a directory the process has
		// never worked in is refused by nothing more than "exists and is a directory".
		const elsewhere = await mkdtemp(join(tmpdir(), "my-agent-elsewhere-"));
		try {
			const created = await call("POST", `${http.url}/api/sessions`, { absCwd: elsewhere });
			check("a new directory is accepted (201)", created.status === 201, `status=${created.status}`);
			const landed = String(created.payload.sessionId ?? "");
			const landedRead = await get(`${http.url}/api/sessions/${landed}`);
			check(
				"and the session runs where it was told",
				resolve(landedRead.session?.absCwd ?? "") === resolve(elsewhere),
				`${landedRead.session?.absCwd}`,
			);
			// A session writes nothing until its first message, so a listing taken at creation cannot
			// name it — and that is the rule rather than a race: the sidebar lists conversations, and a
			// conversation nobody has said anything in is not one. Speaking once is what puts it there.
			check(
				"the answer's listing does not name a session with nothing said in it",
				!(created.payload.sessions as { id: string }[]).some((session) => session.id === landed),
			);
			const spoke = await http.hub.claim(landed);
			spoke.session.sessionManager.appendMessage(userMessage("a first message"));
			http.hub.release(spoke);
			const groups = ((await call("GET", `${http.url}/api/workspaces`)).payload.workspaces as {
				absCwd: string;
				sessions: { id: string }[];
			}[]) ?? [];
			const group = groups.find((candidate) => resolve(candidate.absCwd) === resolve(elsewhere));
			check(
				"and lists it under that directory once it has a message",
				(group?.sessions ?? []).some((session) => session.id === landed),
				JSON.stringify(group?.sessions),
			);

			await writeFile(join(elsewhere, "a-file"), "not a directory\n");
			const missing = await call("POST", `${http.url}/api/sessions`, { absCwd: join(elsewhere, "no-such-dir") });
			check("a directory that does not exist is refused (400)", missing.status === 400, `status=${missing.status}`);
			const notDir = await call("POST", `${http.url}/api/sessions`, { absCwd: join(elsewhere, "a-file") });
			check("a path that is not a directory is refused (400)", notDir.status === 400, `status=${notDir.status}`);
			const wrongType = await call("POST", `${http.url}/api/sessions`, { absCwd: 42 });
			check("a non-string absCwd is refused (400)", wrongType.status === 400, `status=${wrongType.status}`);
			const bodyless = await call("POST", `${http.url}/api/sessions`);
			check("an empty POST still creates (201)", bodyless.status === 201, `status=${bodyless.status}`);
			const bodylessRead = await get(`${http.url}/api/sessions/${String(bodyless.payload.sessionId ?? "")}`);
			check("and it runs where the server does", resolve(bodylessRead.session?.absCwd ?? "") === resolve(root), bodylessRead.session?.absCwd);
		} finally {
			await rm(workspaceDir(elsewhere), { recursive: true, force: true });
			await rm(elsewhere, { recursive: true, force: true });
		}

		process.stdout.write("the settings endpoint validates the default tool set\n");
		// Only refusals here: an accepted write lands in the real agent home's settings file, and this
		// script does not own that file. The accepted shape is proven on the seam above.
		const notArray = await call("PATCH", `${http.url}/api/settings`, { patch: { tools: "read" } });
		check("`tools` must be an array (400)", notArray.status === 400, `status=${notArray.status}`);
		const notNames = await call("PATCH", `${http.url}/api/settings`, { patch: { tools: [42] } });
		check("every entry must be a string (400)", notNames.status === 400, `status=${notNames.status}`);

		process.stdout.write("a workspace can be renamed and put aside\n");
		// 票 06's two workspace commands, end to end. A workspace is created by making a session in it,
		// which is the only road one enters the sidebar by — and the reason this section can run against
		// a directory of its own instead of the server's root, whose name the sections after this one
		// still refer to. The agent home is a scratch one so the settings this writes are not the
		// machine's own.
		{
			const home = await mkdtemp(join(tmpdir(), "my-agent-agent-home-"));
			const host = await mkdtemp(join(tmpdir(), "my-agent-workspaces-"));
			const http = await bootServer({ absCwd: root, port: 0, settingsHome: home });
			const listed = async (): Promise<string[]> =>
				(((await call("GET", `${http.url}/api/workspaces`)).payload.workspaces as { absCwd: string }[]) ?? []).map(
					(group) => resolve(group.absCwd),
				);
			const before = join(host, "before");
			const other = join(host, "other");
			try {
				for (const dir of [before, other]) await mkdir(dir, { recursive: true });

				const created = await call("POST", `${http.url}/api/sessions`, { absCwd: before });
				const id = String(created.payload.sessionId ?? "");
				const elsewhere = await call("POST", `${http.url}/api/sessions`, { absCwd: other });
				// A directory earns its group by holding a conversation, and a session has no file until
				// its first message — so each of these says one thing before the sidebar can draw it.
				const speak = async (sessionId: string, text: string): Promise<void> => {
					const host = await http.hub.claim(sessionId);
					host.session.sessionManager.appendMessage(userMessage(text));
					http.hub.release(host);
				};
				await speak(id, "before");
				await speak(String(elsewhere.payload.sessionId ?? ""), "other");
				check("two new directories are listed as two workspaces", (await listed()).includes(resolve(before)) && (await listed()).includes(resolve(other)));

				const malformed = await call("POST", `${http.url}/api/workspaces/hide`, { absCwd: 42 });
				check("hiding with a non-string path is refused (400)", malformed.status === 400, `status=${malformed.status}`);

				// A name is a label, so the refusals a move needed — a target already taken, a missing
				// parent — have nothing to answer here. What is left is whether the path is one this
				// machine lists, and whether a name arrived at all.
				const unknown = await call("POST", `${http.url}/api/workspaces/rename`, { absCwd: join(host, "nowhere"), name: "x" });
				check("naming a workspace this machine does not list is a 404", unknown.status === 404, `status=${unknown.status}`);
				const wrongName = await call("POST", `${http.url}/api/workspaces/rename`, { absCwd: before, name: 42 });
				check("a non-string name is refused (400)", wrongName.status === 400, `status=${wrongName.status}`);

				const named = await call("POST", `${http.url}/api/workspaces/rename`, { absCwd: before, name: "改过的名字" });
				check("naming a workspace is accepted (200)", named.status === 200, `status=${named.status}`);
				check("the answer names the path it was asked about", resolve(String(named.payload.absCwd ?? "")) === resolve(before), JSON.stringify(named.payload));
				const namedSet = (named.payload.settings as { workspaceNames?: Record<string, string> })?.workspaceNames ?? {};
				check("and the settings carry the label", namedSet[resolve(before)] === "改过的名字", JSON.stringify(namedSet));
				const storedNames = ((await call("GET", `${http.url}/api/settings`)).payload.settings as { workspaceNames?: Record<string, string> })
					?.workspaceNames ?? {};
				check("a later read sees it too", storedNames[resolve(before)] === "改过的名字", JSON.stringify(storedNames));

				// Nothing on disk moves, which is the whole difference from the folder rename this
				// replaced: the directory, the store keyed by it, and the header's absCwd all stay put.
				check("the folder is exactly where it was", existsSync(before));
				const kept = await get(`${http.url}/api/sessions/${id}`);
				check("the session still names its own directory", resolve(kept.session?.absCwd ?? "") === resolve(before), kept.session?.absCwd);
				check("and its transcript is still under that key", (await SessionManager.list(before)).some((session) => session.id === id));
				check("the listing draws the path, not the label", (await listed()).includes(resolve(before)));

				const cleared = await call("POST", `${http.url}/api/workspaces/rename`, { absCwd: before, name: "  " });
				const clearedSet = (cleared.payload.settings as { workspaceNames?: Record<string, string> })?.workspaceNames ?? {};
				check("an empty name takes the label back (200)", cleared.status === 200 && (clearedSet[resolve(before)] ?? "") === "", JSON.stringify(cleared.payload));

				const hidden = await call("POST", `${http.url}/api/workspaces/hide`, { absCwd: before });
				check("hiding a workspace is accepted (200)", hidden.status === 200, `status=${hidden.status}`);
				check("the answer's listing no longer draws the group", !((hidden.payload.workspaces as { absCwd: string }[]) ?? []).some((group) => resolve(group.absCwd) === resolve(before)));
				check(
					"and the stored setting records it",
					((hidden.payload.settings as { hiddenWorkspaces?: string[] })?.hiddenWorkspaces ?? []).some((path) => resolve(path) === resolve(before)),
				);
				check("the next listing leaves it out too", !(await listed()).includes(resolve(before)));
				check("but the folder is exactly where it was", existsSync(before));
				check("and the transcript is untouched", (await SessionManager.list(before)).some((session) => session.id === id));
				check("the other workspace is still listed", (await listed()).includes(resolve(other)));

				const restored = await call("PATCH", `${http.url}/api/settings`, { patch: { hiddenWorkspaces: [] } });
				check("an empty hidden list is stored as a choice (200)", restored.status === 200, `status=${restored.status}`);
				check("and the group comes back", (await listed()).includes(resolve(before)));

				// 删除 is not a one-way door, and this is the door: the transcripts and the folder were
				// never touched, so a new session in that directory is the user saying they want it listed
				// again. Nothing else in the window can un-hide one, which is why the road has to exist.
				const hiddenAgain = await call("POST", `${http.url}/api/workspaces/hide`, { absCwd: before });
				check("hiding it a second time is accepted (200)", hiddenAgain.status === 200, `status=${hiddenAgain.status}`);
				check("and it leaves the listing again", !(await listed()).includes(resolve(before)));
				const reborn = await call("POST", `${http.url}/api/sessions`, { absCwd: before });
				check("a new session in it is accepted (201)", reborn.status === 201, `status=${reborn.status}`);
				check("a new session in a put-aside workspace lists it again", (await listed()).includes(resolve(before)));
				const storedHidden =
					(((await call("GET", `${http.url}/api/settings`)).payload.settings as { hiddenWorkspaces?: string[] })?.hiddenWorkspaces ?? []);
				check("and the stored list no longer names it", !storedHidden.some((path) => resolve(path) === resolve(before)), JSON.stringify(storedHidden));

				// A user can rename a folder behind this process's back. The transcripts stay in the store,
				// so the group is still listed — and a new session there puts the directory back instead of
				// failing on a path nothing on screen says is gone.
				await rm(before, { recursive: true, force: true });
				check("the workspace directory is gone", !existsSync(before));
				const putBack = await call("POST", `${http.url}/api/sessions`, { absCwd: before });
				check("a new session puts the directory back (201)", putBack.status === 201, `status=${putBack.status}`);
				check("and the folder exists again", existsSync(before));
				void elsewhere;
			} finally {
				for (const dir of [before, other]) await rm(workspaceDir(dir), { recursive: true, force: true });
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
			host.session.sessionManager.appendMessage(userMessage("要删的会话"));
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

	process.stdout.write("shutdown settles everything\n");
	await hub.close();
	check("nothing is left running", hub.live.length === 0);
} finally {
	// Sessions live under the agent home, keyed by the workspace path, so removing the temporary
	// workspace is not enough: without this every run leaves an orphan directory behind.
	await rm(workspaceDir(root), { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nsessions ok\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
