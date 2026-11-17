// Session-registry smoke test: proves one agent loop per session id, that a session survives losing
// its last connection, and that the two files a session is (the `.json` snapshot and the `.jsonl`
// entry stream) are what a later connection gets back.
// Nothing here reaches a model, so no provider key is needed. Run with: node scripts/smoke-sessions.ts
import { appendFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import { createAssistantMessageEventStream, type ChatTransport, type Message, type ModelConfig } from "@my-agent/core";
import { bootServer } from "../packages/server/src/boot.ts";
import { createFakeTransport, fakeAssistantMessage } from "./fake-transport.ts";
import { SessionHub } from "../packages/server/src/hub.ts";
import {
	CURRENT_SESSION_VERSION,
	type Agent,
	type AgentState,
	createSession,
	createSessionAgent,
	fillSession,
	openAgent,
	readSessionSnapshot,
	SessionManager,
	UnknownSessionError,
	inMemorySettingManager,
	SettingManager,
	setSessionsDir,
	resolveSettings,
	type SessionSnapshot,
	type Session,
} from "@my-agent/core";
// 仅测试的接缝住在它保护的方法旁边（仿 `setSessionsDir` 的先例）；直呼源文件，不经包的公开面。
import { setRemoveGate } from "../packages/core/src/session/session-manager.ts";

/** The ledger's operations are the service's methods, so a script holds one to call them on. */
const store = new SessionManager();

const root = await mkdtemp(join(tmpdir(), "my-agent-sessions-"));
const storeRoot = await mkdtemp(join(tmpdir(), "my-agent-sessions-store-"));
setSessionsDir(storeRoot);
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

/** A user message the session accepts; nothing here goes near a model. */
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

/** The messages of a session's current branch, which is what a provider would be sent. */
function messagesOf(session: Session): Message[] {
	return store.buildSessionContext(session).messages;
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
 * append directly to the session rather than speaking to a provider, which is what the id-keyed
 * `Agent` no longer exposes.
 */
function hubSessions(hub: SessionHub): SessionManager {
	return hub.agent.sessionManager;
}

/**
 * The orchestrator's state for an id — the per-session object a hold assembles and a close drops.
 *
 * This is what "one session per id" means now: the orchestrator is the process's own and answers by
 * id, so what a reopen can build a second of is a *state* (the queues, the live half, the assembly),
 * never the object that serves them. A cast into the orchestrator's private table, because the
 * probe wants `undefined` rather than a throw, and the state object is not the facade's to give.
 */
function entryOf(agent: Agent, id: string): AgentState | undefined {
	return (agent as unknown as { agentStateMap: Map<string, AgentState> }).agentStateMap.get(id);
}

/**
 * The bag behind a session, for the seeding appends below — the one test-only write that still needs
 * the bag itself.
 *
 * There is no held bag to borrow any more (ADR-0013), and no unborn bag to fall back on either
 * (ADR-0021: a session exists only once it has spoken, so an id this script holds always has a file):
 * every operation replays the file, so a test that wants to write one opens its own, and the write it
 * makes is a write to the file like any other.
 */
function bagOf(hub: SessionHub, id: string): Session {
	return hubSessions(hub).open(id);
}

/** The id of a session's first user entry — the birth message's entry under ADR-0021. */
function birthEntryId(bag: Session): string {
	const entry = store.getEntries(bag).find((candidate) => candidate.type === "message" && candidate.message.role === "user");
	if (entry === undefined) throw new Error("no user entry in the ledger");
	return entry.id;
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

/** 供模型解析用的最小行：脚本化 transport 作答， baseUrl 永不被打到。 */
const vetoRows: ModelConfig[] = [
	{
		name: "anthropic",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "unused-by-the-scripted-transport",
		id: "claude-sonnet-4-5",
		contextWindow: 200_000,
		maxTokens: 8_192,
	},
];

/**
 * 把第一次供应商请求钉在流式半空的可控 gate（仿 smoke-approval-queue 的 gatedApi）：删除动手时
 * 「运行还在飞」因此是事实而不是猜测。abort 信号也放行——真正的 transport 尊重自己的 signal；
 * 被放行后剧本照常流完，被停下的轮次在磁盘上是一轮完整的轮次。
 */
function vetoGate(): { api: ChatTransport; held(): boolean; sawAbort(): boolean; release(): void } {
	const fake = createFakeTransport();
	fake.setResponses([fakeAssistantMessage("被删除打断前的最后一条回答")]);
	const inner = fake.api.stream.bind(fake.api);
	let held = false;
	let aborted = false;
	let release!: () => void;
	const released = new Promise<void>((done) => {
		release = done;
	});
	const api: ChatTransport = {
		stream: (model, context, options) => {
			const outer = createAssistantMessageEventStream();
			void (async () => {
				held = true;
				await Promise.race([
					released,
					new Promise<void>((resolve) => {
						options?.signal?.addEventListener(
							"abort",
							() => {
								aborted = true;
								resolve();
							},
							{ once: true },
						);
					}),
				]);
				const answer = inner(model, context, options);
				for await (const event of answer) outer.push(event);
				outer.end(await answer.result());
			})();
			return outer;
		},
	};
	return {
		api,
		held: () => held,
		sawAbort: () => aborted,
		// 供排错用：从外面强制放行，正常路径里只有 abort 信号会到。
		release,
	};
}

const hub = new SessionHub({ workDirAbsPath: root });

try {
	process.stdout.write("one session per id\n");
	// The id is asked for first and then held by name, which is the only shape production has: a
	// request never omits the id, so "which session is current" is `GET /api/sessions/current`'s
	// question and not the hold's. Startup selects nothing — the landing answer is `null` until an
	// explicit creation happens, and the session below is held by the id that creation returned.
	check("nothing is selected before anything is created", (await hub.currentSessionId()) === null);
	const landing = await hub.birth({ text: "出生的第一条消息" });
	// hold 簿记已迁入 SessionManager（票 03）：hub 上不再有计数表可断言，外部行为是出生自己留下
	// 的状态——失败的出生运行散了自己的袋，文件已在盘上，没有多出来的活半。
	check("the birth leaves the session idle", !hub.isLive(landing), String(hub.isLive(landing)));

	process.stdout.write("the file is the whole session\n");
	hubSessions(hub).appendMessage(bagOf(hub, landing), userMessage("survives the reap"));
	check("and nothing was ever assembled for it", !hub.isLive(landing), String(hub.isLive(landing)));

	process.stdout.write("the JSONL file is what survives\n");
	check(
		"and it still carries the session",
		JSON.stringify(hub.agent.snapshot(landing).messages).includes("survives the reap"),
	);
	await hub.close();

	process.stdout.write("new_session moves the landing spot\n");
	const created = await hub.birth({ text: "出生即落点" });
	check("the landing follows the newest session", (await hub.currentSessionId()) === created, `${await hub.currentSessionId()} vs ${created}`);

	process.stdout.write("a fork is the branch up to one entry\n");
	// Birth is the first message (ADR-0021), so the parent is born with its fork point on the ledger:
	// the birth message's own entry is the one the fork below hangs from, and everything after it is
	// seeded the ordinary way.
	const parentId = await hub.birth({ text: "first" });
	const parentFile = hub.agent.fileAbsPathOf(parentId) ?? "";
	const entryOne = birthEntryId(bagOf(hub, parentId));
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

	check("and it reports the file it came from", hubSessions(hub).getMeta(bagOf(hub, forkedId))?.parentSession === parentFile);

	process.stdout.write("forking without an entry copies the whole log\n");
	const whole = fillSession(new SessionManager().forkFrom(parentFile, null).sessionFileAbsPath);
	check("every entry came with it", ids(store.getEntries(whole)) === ids(hubSessions(hub).getEntries(bagOf(hub, parentId))));
	check("and the session matches", messagesOf(whole).length === messagesOf(bagOf(hub, parentId)).length);
	check("its leaf is the source's leaf", whole.leafId === bagOf(hub, parentId).leafId);
	check("it points back at the source too", store.getMeta(whole)?.parentSession === parentFile);

	process.stdout.write("forking leaves the source alone\n");
	const before = await readFile(parentFile, "utf8");
	const leafBefore = bagOf(hub, parentId).leafId;
	const secondFork = openFile(await hub.fork(parentId, entryOne));
	check("the source keeps its own leaf", bagOf(hub, parentId).leafId === leafBefore);
	check("its file is byte-identical afterwards", (await readFile(parentFile, "utf8")) === before);
	check("nothing was assembled by any of the forks", !hub.isLive(parentId), String(hub.isLive(parentId)));

	process.stdout.write("a fork and its parent run side by side\n");
	const forkBefore = JSON.stringify(messagesOf(bagOf(hub, forkedId)));
	const forkLeaf = bagOf(hub, forkedId).leafId;
	hubSessions(hub).appendMessage(bagOf(hub, parentId), userMessage("only the parent"));
	check(
		"appending to the parent leaves the fork's session alone",
		JSON.stringify(messagesOf(bagOf(hub, forkedId))) === forkBefore,
	);
	check("and the fork's leaf did not move", bagOf(hub, forkedId).leafId === forkLeaf);
	const parentBefore = JSON.stringify(messagesOf(bagOf(hub, parentId)));
	hubSessions(hub).appendMessage(bagOf(hub, forkedId), userMessage("only the fork"));
	check(
		"appending to the fork leaves the parent's session alone",
		JSON.stringify(messagesOf(bagOf(hub, parentId))) === parentBefore,
	);

	process.stdout.write("reopening a fork reports where it came from\n");
	const leafAtClose = bagOf(hub, forkedId).leafId;
	const messagesAtClose = messagesOf(bagOf(hub, forkedId)).length;
	const reread = openFile(forkedId);
	check("reopening reports its parent session", store.getMeta(reread)?.parentSession === parentFile);
	check("and the same leaf", reread.leafId === leafAtClose, `${reread.leafId} vs ${leafAtClose}`);
	// Counted before the release: the drop takes the bag with it, so what the file kept is compared
	// against what the session had when it was still held.
	check("with the messages it had", messagesOf(reread).length === messagesAtClose, `${messagesOf(reread).length} vs ${messagesAtClose}`);
	check("and still reports the session it came from", hubSessions(hub).getMeta(bagOf(hub, forkedId))?.parentSession === parentFile);

	process.stdout.write("forking a session nobody is watching\n");
	const onDisk = openFile(forkedId);
	const cold = await hub.fork(forkedId, onDisk.leafId);
	check("an on-disk session forks too", cold !== forkedId && cold !== parentId, cold);
	check("it is not running until someone holds it", !hub.isLive(cold), String(hub.isLive(cold)));
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
		const renamedId = await hub.birth({ text: "改名的会话" });
		await hub.rename(renamedId, "新名字");
		check("a live session reports the stored name", hub.agent.snapshot(renamedId).title === "新名字", hub.agent.snapshot(renamedId).title);

		const rescanned = await SessionManager.findSessionRowById(renamedId);
		check("the file's row carries the stored name", rescanned?.title === "新名字", rescanned?.title);
		check("a reopen reports it too", hub.agent.snapshot(renamedId).title === "新名字", hub.agent.snapshot(renamedId).title);

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
	}

	process.stdout.write("a meta change rewrites the snapshot whole\n");
	// The v5 format's central promise, driven by the same four setters production uses: a choice
	// rewrites the `.json` snapshot by temp+rename and never touches the `.jsonl` append stream. The
	// atomicity itself has no outside observer — a rename is one step — so what the checks below
	// pin is its observable half: the log untouched, no half-written temp left behind, and a choice
	// that changes nothing leaving the file exactly as it was.
	{
		const metaId = await hub.birth({ text: "重写的会话" });
		const jsonlPath = bagOf(hub, metaId).sessionFileAbsPath!;
		const jsonPath = snapshotPathOf(jsonlPath);
		const logBefore = await readFile(jsonlPath, "utf8");
		check("the snapshot sits beside the stream it commits", existsSync(jsonPath));

		hubSessions(hub).setTitle(bagOf(hub, metaId), "重写的名字");
		hubSessions(hub).setModel(bagOf(hub, metaId), "row-a", "model-a");
		hubSessions(hub).setThinkingLevel(bagOf(hub, metaId), "high");
		hubSessions(hub).setMode(bagOf(hub, metaId), "reader");
		hubSessions(hub).setApprovalOverride(bagOf(hub, metaId), { bash: true });
		check("the stream is byte-identical after the choices", (await readFile(jsonlPath, "utf8")) === logBefore);
		const stored = JSON.parse(await readFile(jsonPath, "utf8")) as Record<string, unknown>;
		check(
			"the snapshot carries every current value and the identity",
			stored.title === "重写的名字" &&
				JSON.stringify(stored.model) === JSON.stringify({ name: "row-a", modelId: "model-a" }) &&
				stored.thinkingLevel === "high" &&
				stored.mode === "reader" &&
				JSON.stringify(stored.approval) === JSON.stringify({ bash: true }) &&
				stored.version === CURRENT_SESSION_VERSION &&
				stored.id === metaId,
			JSON.stringify(stored),
		);
		check(
			"no temp file survived the rewrite",
			readdirSync(storeRoot).every((name) => !name.endsWith(".tmp")),
			JSON.stringify(readdirSync(storeRoot)),
		);

		// A choice is a *change*: recording what the snapshot already says must not rewrite it, or
		// every no-op patch would cost a temp+rename. The wait gives a rewrite a measurable mtime to
		// land in — same-value or not, a write cannot land with the file's own earlier timestamp.
		const quiet = statSync(jsonPath).mtimeMs;
		await new Promise((resolve) => setTimeout(resolve, 20));
		hubSessions(hub).setTitle(bagOf(hub, metaId), "重写的名字");
		hubSessions(hub).setMode(bagOf(hub, metaId), "reader");
		hubSessions(hub).setApprovalOverride(bagOf(hub, metaId), { bash: true });
		check("an unchanged value does not rewrite the snapshot", statSync(jsonPath).mtimeMs === quiet, `${statSync(jsonPath).mtimeMs} vs ${quiet}`);

		// The restore seam: a reopen is fillSession, and the recorded answers come back whole — the
		// same parts the snapshot path a window reads is built from.
		const restored = fillSession(jsonlPath);
		check(
			"a reopen restores the model and level",
			JSON.stringify(store.getRecordedSettings(restored)) ===
				JSON.stringify({ model: { name: "row-a", modelId: "model-a" }, thinkingLevel: "high" }),
			JSON.stringify(store.getRecordedSettings(restored)),
		);
		check(
			"and the tool choices",
			JSON.stringify(store.getRecordedToolConfig(restored)) === JSON.stringify({ mode: "reader", approval: { bash: true } }),
			JSON.stringify(store.getRecordedToolConfig(restored)),
		);

		// A fork is a new pair of files, and the source's current values travel whole: title, model,
		// level, mode pointer, approval delta — the session's own facts now, not entries a branch
		// replay could restore.
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
				carryMeta?.mode === "reader" &&
				carryMeta?.approval?.bash === true,
			JSON.stringify(carryMeta),
		);
		check("and names the source's stream as its parent", carryMeta?.parentSession === jsonlPath, String(carryMeta?.parentSession));
	}

	process.stdout.write("an unknown id fails instead of quietly starting one\n");
	// hold 的存在性校验随簿记退场（票 03）：id 是否有所指现在是 Manager 的地址解析。facade 的
	// 窄读对无所指的 id 回答「没有」——不拼装、不出生。
	check("an unknown id resolves to no file", hub.agent.fileAbsPathOf("0123456789abcdef") === undefined);
	check("and nothing entered the registry", !hub.isLive("0123456789abcdef"), String(hub.isLive("0123456789abcdef")));

	process.stdout.write("the settings files name the tools a session that never chose opens on\n");
	// The global default tool set is a settings field, and the mode pointer is the session's own
	// choice, so the seam is assembly itself: a session with no recorded pointer opens on the
	// configured set through the default mode, and one that points at a preset keeps its own. A
	// preset's tools are read live, so the snapshot's seat and the resolved set are checked where
	// they live. Everything here runs on an in-memory settings manager, so no file outside the
	// temporary working directory is ever touched.
	const settingsRoot = await mkdtemp(join(tmpdir(), "my-agent-settings-"));
	try {
		const settings = inMemorySettingManager(
			{ tools: ["read", "bash"], modes: [{ name: "reader", tools: ["read"], approval: {} }] },
			[],
		);
		const session = createSession(settingsRoot);
		const sessionId = session.sessionId;
		const options = {
			session,
			settings,
		};
		const known = ["read", "write", "edit", "glob", "grep", "bash"];
		// 活会话的袋在第一条消息后作废：有文件就读，还没有就返回出生时的那只（它仍是 live 半上唯一
		// 的一份，ADR-0013）。
		const replayed = (): Session => {
			const path = SessionManager.findSessionFilePathById(sessionId);
			return path === undefined ? session : fillSession(path);
		};
		const resolvedOf = (): string[] => resolveSettings(replayed(), settings.getSettings(), [], known).tools;

		const cold = await readSessionSnapshot(options);
		check("a session with no entry reports the default seat", cold.mode === undefined, cold.mode);

		const live = await openAgent(options);
		try {
			// The one message the branch test below can rewind to with nothing recorded after it.
			const firstEntry = store.appendMessage(session, userMessage("before any choice"));

			check(
				"the default view resolves the configured set",
				JSON.stringify(resolvedOf()) === JSON.stringify(["read", "bash"]),
				JSON.stringify(resolvedOf()),
			);

			live.applyConfig(sessionId, { mode: "reader" });
			check("a recorded pointer wins over the default", live.snapshot(sessionId).mode === "reader", live.snapshot(sessionId).mode);
			check("and the resolved set is the preset's", JSON.stringify(resolvedOf()) === JSON.stringify(["read"]), JSON.stringify(resolvedOf()));

			live.applyConfig(sessionId, { approval: { bash: false } });
			check("an approval delta records beside the pointer", JSON.stringify(store.getRecordedToolConfig(replayed()).approval) === JSON.stringify({ bash: false }), JSON.stringify(store.getRecordedToolConfig(replayed()).approval));

			// The pointer is the seat, not a value: `null` is the「回到默认」gesture, and the recorded
			// delta survives the return — the session's own choice is not the mode's to erase.
			live.applyConfig(sessionId, { mode: null });
			check("returning to the default clears the pointer", live.snapshot(sessionId).mode === undefined, String(live.snapshot(sessionId).mode));
			check("and the delta survives the return", store.getRecordedToolConfig(replayed()).approval?.bash === false, JSON.stringify(store.getRecordedToolConfig(replayed()).approval));

			// A branch move changes the leaf and nothing else: the recorded choices are the session's
			// own now, so the pointer it recorded stays in force.
			live.branchTo(sessionId, firstEntry, false);
			check("a branch move leaves the recorded pointer in force", live.snapshot(sessionId).mode === undefined, String(live.snapshot(sessionId).mode));

			live.applyConfig(sessionId, { mode: "reader" });
			// The cold read takes a bag, and the one the assembly handed over stopped being current
			// the moment the session was born: a cold read of a spoken session is a replay (ADR-0013).
			const recold = await readSessionSnapshot({ ...options, session: fillSession(session.sessionFileAbsPath ?? "") });
			check(
				"the cold read answers the seat exactly as the live snapshot does",
				recold.mode === live.snapshot(sessionId).mode,
				`${recold.mode} vs ${live.snapshot(sessionId).mode}`,
			);
		} finally {
			await live.close(sessionId);
		}
	} finally {
		await rm(settingsRoot, { recursive: true, force: true });
	}

	process.stdout.write("reading a session does not assemble one\n");
	// Phase 1 in one section: a read answers from the JSONL log, leaves the registry exactly as it was,
	// and agrees field-for-field with what the facade answers directly — because both build
	// their snapshot from the same parts.
	const http = await bootServer({ workDirAbsPath: root, port: 0 });
	try {
		const readId = await http.hub.birth({ text: "read me" });
		hubSessions(http.hub).appendMessage(bagOf(http.hub, readId), userMessage("and me"));
		check("the session is idle before the read", !http.hub.isLive(readId), String(http.hub.isLive(readId)));

		const firstRead = await get(`${http.url}/api/sessions/${readId}`);
		check("GET /api/sessions/{id} answers 200", firstRead.status === 200, `status=${firstRead.status}`);
		// Birth writes two entries (the user message and the failed run's error message), and the append
	// above adds the third — each birth is +2 against the ledger under ADR-0021.
	check("the cold session is not empty", (firstRead.session?.messages.length ?? 0) === 3, `${firstRead.session?.messages.length} messages`);
		// This is the whole phase: a read never runs the session — the read is also the window's
		// decision about whether to attach a stream, and a snapshot that reports `running: false` is
		// one the window renders without opening one.
		check("and it reports the session as idle", firstRead.session?.running === false, String(firstRead.session?.running));

		const secondRead = await get(`${http.url}/api/sessions/${readId}`);
		check(
			"reading it twice gives the same answer",
			JSON.stringify(secondRead.session) === JSON.stringify(firstRead.session),
		);

		const unknownRead = await get(`${http.url}/api/sessions/0123456789abcdef`);
		check("an unknown id is still 404", unknownRead.status === 404, `status=${unknownRead.status}`);

		// What the cold read must agree with. The facade's own snapshot is the comparison point:
		// everything the session file can answer has to come out the same.
		const liveSnapshot = http.hub.agent.snapshot(readId);

		// Everything the session file can answer must be identical; only what a loop answers may differ.
		const fromLog = [
			"messages",
			"messageEntryIds",
			"branchPoints",
			"leafId",
			"title",
			"model",
			"thinkingLevel",
			"mode",
			"usage",
		] as const satisfies readonly (keyof SessionSnapshot)[];
		const mismatched = fromLog.filter(
			(field) => JSON.stringify(firstRead.session?.[field]) !== JSON.stringify(liveSnapshot[field]),
		);
		check("the cold read matches the live session field for field", mismatched.length === 0, mismatched.join(","));

		const onlyALoopAnswers = new Set<keyof SessionSnapshot>([
			"running",
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
			const created = await call("POST", `${http.url}/api/sessions`, { text: "出生在别处", workDirAbsPath: elsewhere });
			check("a new directory is accepted (201)", created.status === 201, `status=${created.status}`);
			const landed = String(created.payload.sessionId ?? "");
			const landedRead = await get(`${http.url}/api/sessions/${landed}`);
			check(
				"and the session runs where it was told",
				resolve(landedRead.session?.workDirAbsPath ?? "") === resolve(elsewhere),
				`${landedRead.session?.workDirAbsPath}`,
			);
			// Birth is the first message (ADR-0021), so the answer's listing names the session it just
			// created: a conversation exists the moment it is born, and the sidebar draws it at once.
			check(
				"the answer's listing names the session it just born",
				(created.payload.sessions as { id: string }[]).some((session) => session.id === landed),
			);
			const groups = ((await call("GET", `${http.url}/api/directories`)).payload.directories as {
				workDirAbsPath: string;
				sessions: { id: string }[];
			}[]) ?? [];
			const group = groups.find((candidate) => resolve(candidate.workDirAbsPath) === resolve(elsewhere));
			check(
				"and lists it under that directory at birth",
				(group?.sessions ?? []).some((session) => session.id === landed),
				JSON.stringify(group?.sessions),
			);

			await writeFile(join(elsewhere, "a-file"), "not a directory\n");
			const missing = await call("POST", `${http.url}/api/sessions`, { text: "x", workDirAbsPath: join(elsewhere, "no-such-dir") });
			check("a directory that does not exist is refused (400)", missing.status === 400, `status=${missing.status}`);
			const notDir = await call("POST", `${http.url}/api/sessions`, { text: "x", workDirAbsPath: join(elsewhere, "a-file") });
			check("a path that is not a directory is refused (400)", notDir.status === 400, `status=${notDir.status}`);
			const wrongType = await call("POST", `${http.url}/api/sessions`, { text: "x", workDirAbsPath: 42 });
			check("a non-string workDirAbsPath is refused (400)", wrongType.status === 400, `status=${wrongType.status}`);
			const bodyless = await call("POST", `${http.url}/api/sessions`);
			check("an empty POST is refused (400)", bodyless.status === 400, `status=${bodyless.status}`);
			const textless = await call("POST", `${http.url}/api/sessions`, { workDirAbsPath: elsewhere });
			check("a POST with no text is refused (400)", textless.status === 400, `status=${textless.status}`);
		} finally {
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

			const created = await call("POST", `${http.url}/api/sessions`, { text: "before", workDirAbsPath: before });
			const id = String(created.payload.sessionId ?? "");
			const elsewhere = await call("POST", `${http.url}/api/sessions`, { text: "other", workDirAbsPath: other });
			// Birth is the first message (ADR-0021): each of these arrives with its conversation already
			// spoken, which is what earns the directory its group in the sidebar.
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
				check("and its session is still under that key", (await SessionManager.list(before)).some((session) => session.id === id));
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
				check("and the session is untouched", (await SessionManager.list(before)).some((session) => session.id === id));
				check("the other directory is still listed", (await listed()).includes(resolve(other)));

				const restored = await call("PATCH", `${http.url}/api/settings`, { patch: { hiddenDirectories: [] } });
				check("an empty hidden list is stored as a choice (200)", restored.status === 200, `status=${restored.status}`);
				check("and the group comes back", (await listed()).includes(resolve(before)));

				// 删除 is not a one-way door, and this is the door: the sessions and the folder were
				// never touched, so a new session in that directory is the user saying they want it listed
				// again. Nothing else in the window can un-hide one, which is why the road has to exist.
				const hiddenAgain = await call("POST", `${http.url}/api/directories/hide`, { workDirAbsPath: before });
				check("hiding it a second time is accepted (200)", hiddenAgain.status === 200, `status=${hiddenAgain.status}`);
				check("and it leaves the listing again", !(await listed()).includes(resolve(before)));
				const reborn = await call("POST", `${http.url}/api/sessions`, { text: "领回来", workDirAbsPath: before });
				check("a new session in it is accepted (201)", reborn.status === 201, `status=${reborn.status}`);
				check("a new session in a put-aside directory lists it again", (await listed()).includes(resolve(before)));
				const storedHidden =
					(((await call("GET", `${http.url}/api/settings`)).payload.settings as { hiddenDirectories?: string[] })?.hiddenDirectories ?? []);
				check("and the stored list no longer names it", !storedHidden.some((path) => resolve(path) === resolve(before)), JSON.stringify(storedHidden));

				// A user can rename a folder behind this process's back. The sessions stay in the store,
				// so the group is still listed — and a new session there puts the directory back instead of
				// failing on a path nothing on screen says is gone.
				await rm(before, { recursive: true, force: true });
				check("the directory itself is gone", !existsSync(before));
				const putBack = await call("POST", `${http.url}/api/sessions`, { text: "放回来", workDirAbsPath: before });
				check("a new session puts the directory back (201)", putBack.status === 201, `status=${putBack.status}`);
				check("and the folder exists again", existsSync(before));
				void elsewhere;
			} finally {
				for (const dir of [before, other]) await rm(dir, { recursive: true, force: true });
				await rm(host, { recursive: true, force: true });
				await http.close();
				await rm(home, { recursive: true, force: true });
			}
		}

		process.stdout.write("a rename stores a name and a delete removes the session\n");
		// The two row-menu actions the window offers, over the real route table: a rename lands as one
		// entry and answers 201, a blank one is refused before anything is written, and a delete takes
		// the file with it — answered 202 and accepted no matter who was using the session, veto-style.
		{
			const victim = await http.hub.birth({ text: "要删的会话" });
			const blank = await call("POST", `${http.url}/api/sessions/${victim}/title`, { title: "   " });
			check("a blank name is refused (400)", blank.status === 400, `status=${blank.status}`);
			const wrongType = await call("POST", `${http.url}/api/sessions/${victim}/title`, { title: 42 });
			check("a non-string name is refused (400)", wrongType.status === 400, `status=${wrongType.status}`);
			const named = await call("POST", `${http.url}/api/sessions/${victim}/title`, { title: "新名字" });
			check("a rename is accepted (201)", named.status === 201, `status=${named.status}`);
			check("the answer carries the stored name", named.payload.title === "新名字", JSON.stringify(named.payload));
			const reread = await get(`${http.url}/api/sessions/${victim}`);
			check("and the snapshot reports it", reread.session?.title === "新名字", reread.session?.title);

			// 否决式（票 03）：删除不再被「有人在用」拒绝——409 退场。空闲删除即 202，应答先到；
			// 读是 404；第二次删除也是 404；文件真消失。
			const removed = await call("DELETE", `${http.url}/api/sessions/${victim}`);
			check("an idle session is deleted (202)", removed.status === 202, `status=${removed.status}`);
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
				"and rebuilds the same session",
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
			store.appendMessage(cold, userMessage("written through the cold session"));
			const throughCold = fillSession(s.sessionFileAbsPath!);
			check(
				"a write through the cold session reaches the file",
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
			await rm(statelessRoot, { recursive: true, force: true });
		}
	}

	process.stdout.write("the manager holds the file pairs it touches\n");
	// holds 迁入 SessionManager（票 01）：触碰文件对的公开方法在自己的长度内持闸，remove 是唯一跨
	// await 的持有者。断言全部走外部可观察面——开出来的袋、盘上的文件——不偷看 Manager 内部的计数
	// 表。会话直接经 bare service（store）驱动，文件落在 storeRoot，不起 HTTP。
	{
		const gateSession = createSession(root);
		store.appendMessage(gateSession, userMessage("born under the gate"));
		const gateId = gateSession.sessionId;

		// 两次进闸解析出同一个文件键：两次 open 给出同一条 `.jsonl` 路径，经其中一只袋写入，从另
		// 一次重放里读得回来——同一条目，就是同一把钥匙。
		const first = store.open(gateId);
		const second = store.open(gateId);
		check(
			"two opens answer the same file",
			first.sessionFileAbsPath !== undefined && first.sessionFileAbsPath === second.sessionFileAbsPath,
			`${first.sessionFileAbsPath} vs ${second.sessionFileAbsPath}`,
		);
		store.appendMessage(second, userMessage("written through the second open"));
		const reread = store.open(gateId);
		check(
			"and a write through one open reaches what both name",
			JSON.stringify(store.getEntries(reread)).includes("written through the second open"),
		);

		// 无所指 id 在进闸之前就被拒绝：id → 文件的解析发生在闸前，解析不出就没有可保护的东西。
		let openRefusal: unknown;
		try {
			store.open("0123456789abcdef");
		} catch (error) {
			openRefusal = error;
		}
		check("open refuses an unknown id with UnknownSessionError", openRefusal instanceof UnknownSessionError, String(openRefusal));
		const removeRefusal = await store.remove("0123456789abcdef").then(() => "removed" as const, (error: unknown) => error);
		check("and so does remove, before the gate", removeRefusal instanceof UnknownSessionError, String(removeRefusal));

		// 删除闸内的写被拒：remove 在两步 rm 之间的可控 gate 里挂起，此刻对该会话的 meta setter、
		// append 与冷 open 全部读作「没有这个会话」；放行后删除完成，盘上无任何残留文件。
		{
			const victim = store.open(gateId);
			let entered = false;
			let release!: () => void;
			const held = new Promise<void>((done) => {
				release = done;
			});
			setRemoveGate(async () => {
				entered = true;
				await held;
			});
			const removing = store.remove(gateId);
			try {
				check("the removal reaches the gate between the two rm steps", await until(() => entered));
				// 中间态的形状（票 04）：rm 刻意先删 `.json`（诞生的提交标记）后删 `.jsonl`（流），所以
				// 闸中此刻看到的正是半途夭折的诞生——提交标记已走、流还在，对一切查 meta 的读者读作
				// 「没有这个会话」。
				const midJsonl = victim.sessionFileAbsPath!;
				check(
					"the commit marker goes first, the stream waits in the middle",
					!existsSync(snapshotPathOf(midJsonl)) && existsSync(midJsonl),
				);
				check("and the id reads as missing mid-removal", SessionManager.findSessionFilePathById(gateId) === undefined);
				let titleRefusal: unknown;
				try {
					store.setTitle(victim, "闸内的名字");
				} catch (error) {
					titleRefusal = error;
				}
				check("a meta setter inside the gate reads as missing", titleRefusal instanceof UnknownSessionError, String(titleRefusal));
				let appendRefusal: unknown;
				try {
					store.appendMessage(victim, userMessage("too late"));
				} catch (error) {
					appendRefusal = error;
				}
				check("an append inside the gate reads as missing too", appendRefusal instanceof UnknownSessionError, String(appendRefusal));
				let coldRefusal: unknown;
				try {
					store.open(gateId);
				} catch (error) {
					coldRefusal = error;
				}
				check("and a cold open during the removal is refused, not half-read", coldRefusal instanceof UnknownSessionError, String(coldRefusal));
			} finally {
				release();
				await removing;
				setRemoveGate(undefined);
			}
			check("the removal finished once the gate let go", SessionManager.findSessionFilePathById(gateId) === undefined);
			check(
				"and no file of the session survived",
				readdirSync(storeRoot).every((name) => !name.startsWith(gateId)),
				JSON.stringify(readdirSync(storeRoot)),
			);
		}

		// 删除与在途写入撞车（票 04，User Story 4）：删除前就已开好的袋在删除途中到达的写入，一律读作
		// 「没有这个会话」；放行后删除完成——无孤儿文件，扫描也清不出任何诈尸的行。
		{
			const collideSession = createSession(root);
			store.appendMessage(collideSession, userMessage("撞车的会话"));
			const collideId = collideSession.sessionId;
			const stale = store.open(collideId);
			let entered = false;
			let release!: () => void;
			const held = new Promise<void>((done) => {
				release = done;
			});
			setRemoveGate(async () => {
				entered = true;
				await held;
			});
			const removing = store.remove(collideId);
			try {
				check("the colliding removal reaches the gate", await until(() => entered));
				let appendRefusal: unknown;
				try {
					store.appendMessage(stale, userMessage("删除之后才到的写入"));
				} catch (error) {
					appendRefusal = error;
				}
				check("an append from a bag opened before the deletion is refused", appendRefusal instanceof UnknownSessionError, String(appendRefusal));
				let titleRefusal: unknown;
				try {
					store.setTitle(stale, "删除之后才到的名字");
				} catch (error) {
					titleRefusal = error;
				}
				check("and so is a meta setter from the same stale bag", titleRefusal instanceof UnknownSessionError, String(titleRefusal));
			} finally {
				release();
				await removing;
				setRemoveGate(undefined);
			}
			check("the deletion finished once the gate let go", SessionManager.findSessionFilePathById(collideId) === undefined);
			check(
				"no orphan file survived the collision",
				readdirSync(storeRoot).every((name) => !name.startsWith(collideId)),
				JSON.stringify(readdirSync(storeRoot)),
			);
			check(
				"and no scan resurrects the deleted session",
				!(await SessionManager.list(root)).some((info) => info.id === collideId),
			);
		}

		// 半途夭折的诞生由扫描自愈（票 04）：先提交标记后流是刻意的 rm 顺序——rm 的两步之间到达的
		// 读者看到的正是未配对的流。这里手写这个状态（与闸中删除产出的形状一致，参照上面 v4 遗物的
		// 写法），看列表扫描把它清掉，而不是给中间态发明新的原子性。
		{
			const halfBornStem = join(storeRoot, "2026-01-01T00-00-04-000Z_halfborn");
			await writeFile(
				`${halfBornStem}.jsonl`,
				`${JSON.stringify({ type: "message", id: "hb-u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "a half-born conversation" }] } })}\n`,
				"utf8",
			);
			check("the half-born pair looks exactly like the mid-removal state", existsSync(`${halfBornStem}.jsonl`) && !existsSync(`${halfBornStem}.json`));
			const listed = await SessionManager.list(root);
			check("the scan lists none of it", !listed.some((info) => info.id === "halfborn"), JSON.stringify(listed.map((info) => info.id)));
			check("and the scan swept the half-born stream", !existsSync(`${halfBornStem}.jsonl`));
		}

		// 宽容释放不随搬家消失：同一 id 先以未诞生的袋多次在闸外做选择（表上无条目、无进出），再以
		// 诞生袋连续多轮进/出闸，交错之后一切照常——没有泄漏的计数让任何一步失败。
		{
			const lenient = createSession(root);
			store.setTitle(lenient, "闸外的名字");
			store.setModel(lenient, "row-a", "model-a");
			check("an unborn bag takes choices with no file to protect", !existsSync(lenient.sessionFileAbsPath!));
			store.appendMessage(lenient, userMessage("the birth"));
			const lenientId = lenient.sessionId;
			for (let cycle = 0; cycle < 3; cycle++) {
				store.appendMessage(store.open(lenientId), userMessage(`cycle ${cycle}`));
			}
			const settled = store.open(lenientId);
			check(
				"choices made outside the gate survive the birth",
				store.getTitle(settled) === "闸外的名字" && store.getMeta(settled).model?.name === "row-a",
				JSON.stringify(store.getMeta(settled)),
			);
			check("and every gate cycle landed in the one file", store.getEntries(settled).length === 4, String(store.getEntries(settled).length));
		}
	}

	process.stdout.write("the orchestrator's table keys the live half by id\n");
	// ADR-0013: the table on the orchestrator holds exactly what cannot be rebuilt from disk — the
	// queues, the run in flight, the subscriber sets. `open` is its one way in, and it assembles
	// first-come: a state already there is kept, never replaced, because the one it would replace
	// holds the live half. The exits are two and deliberately different: the run's own end path
	// (idle states die with the run that carried them) and `deleteSessionBySessionId`, which does
	// not ask. There is no clear — the table lives and dies with the orchestrator itself.
	{
		const agent = createSessionAgent({ settings: new SettingManager({ models: [] }) });
		const session = createSession(tmpdir());
		// The door is class-private (`hold` / `createAndPrompt` are the verbs a caller spells);
		// this block exercises the table itself — first-come-wins, membership, the delete exit — so it
		// reaches in the same way `entryOf` does, the cast the one road across.
		const door = agent as unknown as { assembleAgentStateBySession(options: { session: Session }): Promise<AgentState> };
		const agentState = await door.assembleAgentStateBySession({ session });
		check("open is the one way in, and the id answers it", entryOf(agent, session.sessionId) === agentState);
		check("re-opening an id keeps the state already there", (await door.assembleAgentStateBySession({ session })) === agentState);
		// No file behind it, so forgetting the state is the whole removal — and only that half, which
		// is why the second attempt refuses as an id nothing names.
		await agent.deleteSessionBySessionId(session.sessionId);
		check("an id no longer in the table answers nothing", entryOf(agent, session.sessionId) === undefined);
		check("deleting it again refuses", (await agent.deleteSessionBySessionId(session.sessionId).then(() => "deleted", () => "refused")) === "refused");
	}

	process.stdout.write("a delete vetoes a run in flight\n");
	// 票 02 的否决式：删除不再要求调用方先把会话安顿好——运行在飞则删除自己中止它、等引擎收尾，
	// 然后在文件闸内删掉文件对、出表。core 级断言（不经 HTTP）：可控 gate 把一次运行钉在流式
	// 半空，直接调 deleteSessionBySessionId，看删除赢。
	{
		const gate = vetoGate();
		const session = createSession(root);
		// 会话随第一条消息出生（ADR-0021）：对袋直接追加让文件落地，不跑引擎、不耗剧本。
		store.appendMessage(session, userMessage("删除动手时还在跑的会话"));
		const id = session.sessionId;
		const agent = await openAgent({
			session,
			api: gate.api,
			settings: inMemorySettingManager({}, vetoRows),
		});

		const running = agent.prompt(id, "删除动手时我还在流式", { selection: { model: "anthropic" } });
		check("the run reaches the transport gate", await until(() => gate.held()));
		check("and the file pair exists while it streams", SessionManager.findSessionFilePathById(id) !== undefined);

		const removed = await agent.deleteSessionBySessionId(id).then(
			() => true,
			(error: unknown) => {
				void gate.release();
				void running.catch(() => undefined);
				return String(error);
			},
		);
		check("the delete of a running session succeeds (the veto wins)", removed === true, String(removed));
		check("the run received the abort", gate.sawAbort());
		check("the aborted run has settled", await until(() => !agent.isRunning(id)));
		void running.catch(() => undefined);
		check("the table no longer holds the live half", entryOf(agent, id) === undefined);
		check("the file pair is gone", SessionManager.findSessionFilePathById(id) === undefined);
		check(
			"and no file of the session survived on disk",
			readdirSync(storeRoot).every((name) => !name.startsWith(id)),
			JSON.stringify(readdirSync(storeRoot)),
		);
	}

	process.stdout.write("a pair this build cannot open is deleted, not kept\n");
	// v5 keeps no migration and no quarantine: a v≤4 file (header-in-JSONL, no snapshot), an unpaired
	// half, and a wrong version are all sessions nothing can ever open again, so every reader that
	// proves a pair unopenable removes it. Both trigger points are driven here: the listing scan and
	// the open. Handwritten, because no build that writes v5 would ever produce one.
	{
		const legacyRoot = await mkdtemp(join(tmpdir(), "my-agent-legacy-"));
		try {
			const dir = storeRoot;
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
			await rm(legacyRoot, { recursive: true, force: true });
		}
	}

	process.stdout.write("shutdown settles everything\n");
	await hub.close();
	check("nothing is left running", !hub.isLive(landing) && !hub.isLive(created), "a live half survived shutdown");
} finally {
	// The store was pointed at a scratch directory, so removing it takes every session this run
	// wrote with it.
	await rm(storeRoot, { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nsessions ok\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
