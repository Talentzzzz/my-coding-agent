// Approval smoke test, in the shape the resident transport gave it. A run that stops for approval has
// to announce the request on the session's wire lane, and the answers endpoint has to let it continue:
// the request is published by the session as a change, the frame that shows the banner is the mux's
// job, and the answer arrives on a completely different request. No provider key is needed — the
// scripted transport makes the tool call.
//
//   node scripts/smoke-approval.ts
//
// Five sections, each on its own graph, so one failure does not cascade into the next:
//
//   1. the round trip — the request reaches the lane, the answer arrives over REST, the settlement
//      comes back on the lane, and a refused answer (an unknown `toolCallId`) leaves no frame behind;
//   2. three *connections* on one session — every window hears the same answer (the ticket-13 defect:
//      the first reader used to take the answer and every later one reported a denial);
//   3. one id, two sessions — an answer reaches only the session it was given on (ticket 19);
//   4. a parked approval — it outlives its host: the reap closes the host once the last hold lets
//      go, and the question survives unanswered and undenied until someone answers it or the process
//      ends (issue 04); the snapshot's suspended marker follows the question through its endings;
//   5. a restart — the cold overview lights the parked row from the snapshot marker, and the
//      session keeps the call answerable.
//
// Two things pinned by `docs/notes.md` §一 and §二 are load-bearing here. The first section's
// `new SessionHub({ workDirAbsPath: root })` names the hub's one directory option: that section
// drives a session it mounted itself, so the hub never has to open one of its own. And no section
// may hold a session open through a *subscription*:
// a subscription takes no hold, so wherever a check needs the host to outlive a request it takes a
// hold of its own (the bench hold), exactly as `smoke-stream` and `smoke-mux` do.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { bootServer, muxUpgrade, sessionListeners } from "../packages/server/src/boot.ts";
import { createMuxServer, type MuxServer } from "../packages/server/src/mux.ts";
import { SessionHub } from "../packages/server/src/hub.ts";
import { SessionController, SystemController } from "../packages/server/src/controllers/sessions.ts";
import { createRoutes } from "../packages/server/src/controllers/routes.ts";
import { Router } from "../packages/server/src/http/routing.ts";
import { createServer } from "../packages/server/src/http.ts";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall } from "./fake-transport.ts";
import { mountSession } from "./mount-session.ts";
import { connect, until, type WireClient } from "./wire/client.ts";
import type { PendingApproval, SessionRow } from "@my-agent/core/protocol";
import { type Agent, createToolManager, type ModelConfig, ModelManager, type Session, SessionManager, sessionMetaPath, setSessionsDir, type SessionMeta } from "@my-agent/core";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
	process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` ${detail}`}\n`);
	if (!ok) failures += 1;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A per-section deadline, so a hang names the section instead of the whole script. */
function deadline(label: string, ms: number): NodeJS.Timeout {
	return setTimeout(() => {
		process.stdout.write(`\nFAIL ${label} did not settle within ${Math.round(ms / 1000)} s\n`);
		process.exit(1);
	}, ms);
}

async function request(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; payload: unknown }> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (body !== undefined) headers["content-type"] = "application/json";
	const response = await fetch(`${base}${path}`, {
		method,
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	return { status: response.status, payload: text.length === 0 ? undefined : (JSON.parse(text) as unknown) };
}

/** Accept a prompt, which is answered before the run has done anything. */
async function prompt(base: string, sessionId: string, text: string): Promise<number> {
	return (await request(base, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/messages`, { text })).status;
}

/** Where one graph's mux is reachable. */
function muxUrl(base: string): string {
	return `${base.replace("http", "ws")}/mux`;
}

/** The parts of a snapshot these checks read. */
interface ReadSession {
	messages: unknown[];
	pendingApprovals: PendingApproval[];
	running: boolean;
}

async function readSession(base: string, sessionId: string): Promise<ReadSession | undefined> {
	const read = await request(base, "GET", `/api/sessions/${encodeURIComponent(sessionId)}`);
	return (read.payload as { session?: ReadSession } | undefined)?.session;
}

/** Poll a read until the session parks at an approval, the way a person waiting for a banner would. */
async function waitParked(base: string, sessionId: string, ms = 15_000): Promise<ReadSession | undefined> {
	const end = Date.now() + ms;
	for (;;) {
		const read = await readSession(base, sessionId);
		if ((read?.pendingApprovals.length ?? 0) > 0) return read;
		if (Date.now() > end) return read;
		await sleep(50);
	}
}

/** The `.json` snapshot a session id names, read straight off the store — the marker's disk half. */
async function readMeta(id: string): Promise<SessionMeta> {
	const jsonl = SessionManager.findSessionFilePathById(id);
	if (jsonl === undefined) throw new Error(`no session file for ${id}`);
	return JSON.parse(await readFile(sessionMetaPath(jsonl), "utf8")) as SessionMeta;
}

// The row every rig's session runs on. Each hub below is given a scratch agent home of its own and
// these rows, so nothing here depends on — or writes to — what the person running it has configured.
const rows: ModelConfig[] = [
	{
		name: "anthropic",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "unused-by-the-scripted-transport",
		id: "claude-sonnet-4-5",
		contextWindow: 200_000,
		maxTokens: 8_192,
	},
];
const modelName = "anthropic";
process.stdout.write(`model ${modelName} via the scripted transport\n`);

/**
 * Seed one temp home with the gate's approval map and the scripted rows, and name the home.
 *
 * The approval gate is a settings read the orchestrator makes per request, so the map and the rows
 * have to be on disk before the hub is built; a throwaway manager over a temp home writes them
 * through the real coercion, and the machine's own settings stay out of it. The caller removes the
 * home when its rig comes down.
 */
async function seedApprovalGate(root: string, modelRows: readonly ModelConfig[]): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "my-agent-approval-home-"));
	// 设置归属重构（spec §8）后门面退场：审批映射种进 tools.json，行种进 models.json，各持自己的
	// 文件——同一套持有者，hub 之后按同一套规则读回。
	createToolManager({ home }).applyToolDefaults({ approval: { read: true } });
	new ModelManager({ home: home }).replaceRows(modelRows);
	return home;
}

// ---------------------------------------------------------------------------------------------------
// 1. The round trip, and a refused answer that leaves nothing behind.
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\na run parked at the gate is announced on the wire and answered over REST\n");

const roundTripWatchdog = deadline("the approval round trip", 60_000);

const root = await mkdtemp(join(tmpdir(), "my-agent-approval-"));
const storeRoot = await mkdtemp(join(tmpdir(), "my-agent-approval--store-"));
setSessionsDir(storeRoot);
const fake = createFakeTransport();
// One response per call: a tool call, then the text that ends the run. Both are assistant messages —
// `fakeToolCall` is a content block, not a response on its own.
fake.setResponses([
	fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
	fakeAssistantMessage("done"),
]);
// The hub's one orchestrator sends through the scripted transport, so every session it serves does;
// its gate is the map `seedApprovalGate` put on the temp home's files.
const settingsHome = await seedApprovalGate(root, rows);
const sessionHub = new SessionHub({
	workDirAbsPath: root,
	chatTransport: fake.chatTransport,
	settingsHome,
	modelsHome: settingsHome,
});
// Mounted the way the smoke rigs mount one, so every request below goes through the real hub.
const { id: sessionId } = await mountSession(sessionHub, {
	root,
});
const agent = sessionHub.agent;

const roundTrip = await serve(sessionHub);
try {
	const wire = await connect(muxUrl(roundTrip.url));

	const baseline = await wire.open(sessionId);
	check("the lane opened on the session's baseline", baseline.id === sessionId, `baseline=${baseline.id}`);
	check("and the session starts idle", baseline.running === false, String(baseline.running));

	check("the prompt was accepted", (await prompt(roundTrip.url, sessionId, "read the notes")) === 202);

	// The run starts and stops at the gate: wait for the frame that shows the banner, and fail if the
	// lane ends first. Waiting on a frame that never comes is exactly the bug being looked for.
	const asked = await wire.waitFor(sessionId, (message) => message.type === "approval_request", 10_000);
	check(
		"the approval request reached the lane",
		asked?.type === "approval_request",
		JSON.stringify(wire.items(sessionId).map((message) => message.type)),
	);
	check(
		"the lane stayed open while it waited",
		!wire.endOf(sessionId).ended && wire.endOf(sessionId).errors.length === 0,
		JSON.stringify(wire.endOf(sessionId)),
	);
	if (asked?.type !== "approval_request") throw new Error("no approval request, so the rest of this section cannot run");

	const request0: PendingApproval = asked.request;
	check("the request names the tool that needs approval", request0.toolName === "read", JSON.stringify(request0));
	check("the request carries what the banner shows", (request0.summary ?? "").length > 0, JSON.stringify(request0));

	// The refused answer comes first. An id nothing is waiting on is a conflict, and the refusal must
	// put no frame on the lane: this is ticket 14's "the failed request does not pollute the
	// differences", the exact other side of ticket 13's `[true, false, false]` defect. It is also why
	// the settlement count below is asserted to be one rather than "at least one".
	const refused = await request(roundTrip.url, "POST", `/api/sessions/${sessionId}/approvals/no-such-call`, { approved: true });
	check("an unknown toolCallId is a conflict", refused.status === 409, `status ${refused.status} ${JSON.stringify(refused.payload)}`);
	check(
		"and the refusal says what was refused",
		JSON.stringify(refused.payload).includes("not a pending approval"),
		JSON.stringify(refused.payload),
	);
	check(
		"and the refusal put no settlement on the lane",
		wire.items(sessionId).every((message) => message.type !== "approval_settled"),
		JSON.stringify(wire.items(sessionId).map((message) => message.type)),
	);

	// The ids the browser sends back are opaque and may contain a colon, so this also pins that a path
	// parameter is percent-decoded before the controller sees it.
	const answered = await request(
		roundTrip.url,
		"POST",
		`/api/sessions/${sessionId}/approvals/${encodeURIComponent(request0.toolCallId)}`,
		{ approved: true },
	);
	check("the real answer was accepted", answered.status === 200, `status ${answered.status}`);

	const settled = await wire.waitFor(sessionId, (message) => message.type === "approval_settled", 10_000);
	check(
		"the lane was told the approval was settled",
		settled?.type === "approval_settled",
		JSON.stringify(wire.items(sessionId).map((message) => message.type)),
	);
	const settlements = wire.items(sessionId).filter((message) => message.type === "approval_settled");
	check(
		"and exactly one settlement reached it: the frame no longer carries the verdict — the run's own events do",
		settlements.length === 1 && settlements[0]?.type === "approval_settled",
		JSON.stringify(settlements),
	);
	// The verdict is not a flag on the frame or the event — it is the result's own text: a grant lets
	// the tool run (whatever its outcome, it is the tool's own result), a denial says so in words.
	check(
		"the outcome reached the lane as the granted call's own execution end",
		wire.items(sessionId).some(
			(message) =>
				message.type === "event" &&
				message.event.type === "tool_execution_end" &&
				message.event.toolCallId === request0.toolCallId &&
				!resultTextOf(message).includes("denied permission"),
		),
		JSON.stringify(wire.items(sessionId).filter((message) => message.type === "event").map((message) => (message as { event: { type: string } }).event.type)),
	);

	// The run continues, so the answer really did reach the waiting tool call.
	check(
		"the run finished after the answer",
		(await wire.waitFor(sessionId, (message) => message.type === "status" && message.running === false, 10_000)) !== undefined,
		JSON.stringify(wire.items(sessionId).map((message) => message.type)),
	);
	const sessionView = await readSession(roundTrip.url, sessionId);
	check("the tool ran and its result is in the session", JSON.stringify(sessionView?.messages ?? []).includes("notes.txt"));
	check("the model's closing answer is in the session", JSON.stringify(sessionView?.messages ?? []).includes("done"));

	await wire.close();
} finally {
	clearTimeout(roundTripWatchdog);
	await roundTrip.close();
	await rm(settingsHome, { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
	await rm(storeRoot, { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------------------------------
// 2. One answer, every window showing the question.
//
// The property this pins: an answer reaches every window on the session, not just the one that gave
// it. A subscription is a *connection × session* pair, so three windows are three connections; one
// connection carries one lane per session, not three. The settled frame tells each lane the question
// left the ledger; the outcome rides the run's own events, which every subscriber hears.
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\nevery window on a session hears how an approval was answered\n");

const sharedWatchdog = deadline("the shared-answer checks", 60_000);

const shared = await openRig();
try {
	// Every window is attached before anything runs, so the request is a difference frame on each of
	// them rather than part of a baseline — which is the path under test.
	const windows: WireClient[] = [];
	for (let index = 0; index < 3; index += 1) {
		const window = await connect(muxUrl(shared.url));
		await window.open(shared.sessionId);
		windows.push(window);
	}
	check("three connections are open on the one session", windows.length === 3);

	check("the prompt was accepted", (await prompt(shared.url, shared.sessionId, "read the notes")) === 202);

	const shown = await Promise.all(
		windows.map((window) => window.waitFor(shared.sessionId, (message) => message.type === "approval_request", 10_000)),
	);
	check(
		"every window was shown the approval",
		shown.every((frame) => frame?.type === "approval_request"),
		JSON.stringify(shown.map((frame) => frame?.type ?? "none")),
	);
	if (shown.some((frame) => frame?.type !== "approval_request")) {
		throw new Error("the approval request never reached one of the windows");
	}
	const toolCallId = (shown[0] as { request: PendingApproval }).request.toolCallId;

	const answered = await request(
		shared.url,
		"POST",
		`/api/sessions/${shared.sessionId}/approvals/${encodeURIComponent(toolCallId)}`,
		{ approved: true },
	);
	check("the answer was accepted", answered.status === 200, `status ${answered.status}`);

	// The settled frame is what the answer produced, and waiting for it is what puts it in hand: the
	// run's own last status is older than it (the gate's run already ended), so the status alone
	// cannot tell this wait when the answer has landed.
	await Promise.all(
		windows.map((window) => window.waitFor(shared.sessionId, (message) => message.type === "approval_settled", 10_000)),
	);

	const reported = windows.map((window) =>
		window.items(shared.sessionId).find((message) => message.type === "approval_settled"),
	);
	check(
		"every window was told the approval was settled",
		reported.every((frame) => frame !== undefined),
		JSON.stringify(reported.map((frame) => frame?.type ?? "none")),
	);
	// The verdict is not on the settled frame; it rides the run's own execution events, which every
	// subscriber hears. That is the replacement for the old per-connection answer tables: one fact,
	// one announcer, every reader.
	check(
		"and every window saw the granted call run to its own execution end — not a denial",
		windows.every((window) =>
			window.items(shared.sessionId).some(
				(message) =>
					message.type === "event" &&
					message.event.type === "tool_execution_end" &&
					message.event.toolCallId === toolCallId &&
					!resultTextOf(message).includes("denied permission"),
			),
		),
		JSON.stringify(windows.map((window) => window.items(shared.sessionId).filter((message) => message.type === "event").map((message) => (message as { event: { type: string } }).event.type))),
	);

	await Promise.all(windows.map((window) => window.close().catch(() => {})));
} finally {
	clearTimeout(sharedWatchdog);
	await shared.close();
}

// ---------------------------------------------------------------------------------------------------
// 3. One id, two sessions: an outcome belongs to the session it belongs to.
//
// The case this pins: two sessions whose providers happen to number their calls the same way —
// several Anthropic-compatible endpoints do (`call_0`, `call_1`) — must never hear each other's
// outcomes. Frames are keyed to each session's own lane, and the outcome rides that session's own
// execution events, so one session's grant is structurally unable to arrive on the other's window.
// The scripted transports are told to hand both sessions the same id, which is the case the wire's
// random `toolu_…` ids only make improbable.
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\nan answer reaches only the session it was given on\n");

const crossWatchdog = deadline("the cross-session checks", 60_000);

const cross = await openCrossRig();
try {
	const [firstSession, secondSession] = cross.sessions;
	const first = firstSession!;
	const second = secondSession!;
	const firstWire = await connect(muxUrl(cross.url));
	const secondWire = await connect(muxUrl(cross.url));
	const [firstBaseline, secondBaseline] = await Promise.all([
		firstWire.open(first.id),
		secondWire.open(second.id),
	]);
	check(
		"two sessions on one hub are both watchable",
		firstBaseline.id === first.id && secondBaseline.id === second.id,
	);
	check("and both started idle", !firstBaseline.running && !secondBaseline.running);

	for (const parked of cross.sessions) {
		const accepted = await prompt(cross.url, parked.id, "read the notes");
		if (accepted !== 202) throw new Error(`the prompt was not accepted: ${accepted}`);
	}

	const [firstAsked, secondAsked] = await Promise.all([
		firstWire.waitFor(first.id, (message) => message.type === "approval_request", 10_000),
		secondWire.waitFor(second.id, (message) => message.type === "approval_request", 10_000),
	]);
	const firstId = firstAsked?.type === "approval_request" ? firstAsked.request.toolCallId : "";
	const secondId = secondAsked?.type === "approval_request" ? secondAsked.request.toolCallId : "";
	check("and both approvals carry the same toolCallId", firstId.length > 0 && firstId === secondId, `${firstId} vs ${secondId}`);
	if (firstId.length === 0 || firstId !== secondId) {
		throw new Error("the two sessions did not park on the same id, so the rest of this section cannot run");
	}

	// The first session's answer is a grant; the second session's identical id leaves by a different
	// road — an abort denies it — and each lane tells its own ending: the grant's tool execution on
	// one, the abandonment sweep's denial on the other. The banner-taking-down frame is identical on
	// both; the outcomes are what must not cross.
	const granted = await request(
		cross.url,
		"POST",
		`/api/sessions/${first.id}/approvals/${encodeURIComponent(firstId)}`,
		{ approved: true },
	);
	check("the first session's answer was accepted", granted.status === 200, `status ${granted.status}`);

	const stopped = await request(cross.url, "POST", `/api/sessions/${second.id}/abort`);
	check("the second session was aborted", stopped.status === 200, `status ${stopped.status}`);

	await Promise.all([
		firstWire.waitFor(first.id, (message) => message.type === "approval_settled", 10_000),
		secondWire.waitFor(second.id, (message) => message.type === "approval_settled", 10_000),
	]);

	// The verdict is not on the settled frame — each session's lane tells its own story through the
	// execution events of whatever closed the call: the grant ran the tool; the abort's abandonment
	// sweep wrote the denial. Same id, two lanes, two different endings, each on its own side.
	const eventsOf = (wire: WireClient, sessionId: string) =>
		wire.items(sessionId).filter((message): message is Extract<typeof message, { type: "event" }> => message.type === "event");
	const firstEnd = eventsOf(firstWire, first.id).find(
		(message) => message.event.type === "tool_execution_end" && message.event.toolCallId === firstId,
	);
	const secondEnd = eventsOf(secondWire, second.id).find(
		(message) => message.event.type === "tool_execution_end" && message.event.toolCallId === secondId,
	);
	check(
		"the granted session's lane heard its own call run — the tool's own result, not a denial",
		firstEnd?.event.type === "tool_execution_end" && !resultTextOf(firstEnd).includes("denied permission"),
		JSON.stringify(firstEnd),
	);
	check(
		"the aborted session's lane heard its own abandonment, not the other session's grant",
		secondEnd?.event.type === "tool_execution_end" && resultTextOf(secondEnd).includes("aborted"),
		JSON.stringify(secondEnd),
	);

	await Promise.all([firstWire.close().catch(() => {}), secondWire.close().catch(() => {})]);
} finally {
	clearTimeout(crossWatchdog);
	await cross.close();
}

// ---------------------------------------------------------------------------------------------------
// 4. A parked approval outlives everyone who was showing it.
//
// The phase this covers: a parked bag stays in the orchestrator's table, and with it the queues a
// recovery run must drain — so the question survives as the ledger's, to be answered later or
// carried to the next process. The sidebar row is part of that survival: the hub keeps the
// row lit from the bag while it stands. The snapshot's `suspended` marker is the disk half of the
// same survival: the park writes it, an answer's recovery run and an abort's abandonment sweep
// clear it, and a fork carries it to a session nobody has opened.
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\na parked approval outlives its host, unanswered and undenied\n");

const parkedWatchdog = deadline("the parked-approval checks", 90_000);

try {
	// Left while parked: the viewer goes, and the question waits for whoever comes back.
	const patient = await openRig();
	try {
		const { wire } = await driveToApproval(patient);
		const parked = patient.sessionId;
		check("the run parked at the approval", patient.agent.snapshot(parked).pendingApprovals.length > 0);
		const parkedMeta = await readMeta(parked);
		check("and the snapshot carries the suspended marker", parkedMeta.suspended === true, JSON.stringify(parkedMeta));

		// The viewer switches away. Nothing marks the session as "in use" any more — the parked state
		// stays on its own, and the question stays.
		wire.cancel(patient.sessionId);
		check("and the state stayed: the parked bag refuses removal", patient.sessionHub.isLive(parked), String(patient.sessionHub.isLive(parked)));
		// The sidebar's own road: a fresh connection's overview is the hub's current truth.
		// The question outlives the host, so the row must still carry it — a hard zero at the reap
		// is the dot going out while the question stands. The connection stays open to hear the row
		// go quiet once the answer lands.
		const sidebar = await connect(muxUrl(patient.url));
		const overview = await sidebar.waitForConnection((envelope) => envelope.item?.type === "sessions", 8_000);
		const parkedRow = ((overview?.item?.sessions ?? []) as SessionRow[]).find((row) => row.id === parked);
		check(
			"the sidebar row still reports the question with nobody watching",
			parkedRow?.pending === 1 && parkedRow?.running === false,
			JSON.stringify(parkedRow),
		);
		check("the approval is still pending, undenied", patient.agent.snapshot(parked).pendingApprovals.length > 0, "it was denied");
		check(
			"and no denial reached the lane",
			wire.items(patient.sessionId).every((message) => message.type !== "approval_settled"),
			JSON.stringify(wire.items(patient.sessionId).map((message) => message.type)),
		);

		// The person came back, and the state is the one the parked run left: the queues, the
		// parked flag, exactly what a recovery run must drain. Identity is the orchestrator's private
		// business, so the assertion probes the table the way the other smokes do; the facade answers
		// in pure data and never hands a bag out.
		const entryOf = (): { live: unknown; session?: unknown } | undefined =>
			(patient.sessionHub.agent as unknown as { agentStateMap: Map<string, { live: unknown; session?: unknown }> }).agentStateMap.get(parked);
		const liveHalf = entryOf()?.live;
		check("the state is still in the table for the returning window", entryOf() !== undefined && patient.sessionHub.isLive(parked), String(patient.sessionHub.isLive(parked)));
		check("whose live half is the same object the parked run left", liveHalf !== undefined && entryOf()?.live === liveHalf);

		const returned = await wire.open(patient.sessionId);
		check(
			"the returning window is shown the approval it must answer",
			returned.pendingApprovals.length === 1,
			JSON.stringify(returned.pendingApprovals),
		);

		const toolCallId = pendingId(wire, patient.sessionId);
		const answered = await request(
			patient.url,
			"POST",
			`/api/sessions/${parked}/approvals/${encodeURIComponent(toolCallId)}`,
			{ approved: true },
		);
		check("the answer was accepted", answered.status === 200, `status ${answered.status}`);

		check(
			"the approval was settled",
			await until(() => wire.items(patient.sessionId).some((message) => message.type === "approval_settled"), 8_000),
			JSON.stringify(wire.items(patient.sessionId).filter((message) => message.type === "approval_settled")),
		);
		check(
			"and the grant reached the lane as the call's own execution end — the tool's result, not a denial",
			await until(
				() =>
					wire.items(patient.sessionId).some(
						(message) =>
							message.type === "event" &&
							message.event.type === "tool_execution_end" &&
							!resultTextOf(message).includes("denied permission"),
					),
				8_000,
			),
			JSON.stringify(wire.items(patient.sessionId).filter((message) => message.type === "event").map((message) => (message as { event: { type: string } }).event.type)),
		);
		check(
			"and the recovery run it started finished",
			await until(async () => ((await readSession(patient.url, parked))?.running ?? true) === false, 8_000),
		);
		const recoveredMeta = await readMeta(parked);
		check(
			"the marker is gone once the recovery run closed the call",
			recoveredMeta.suspended === undefined,
			JSON.stringify(recoveredMeta),
		);
		check(
			"the row goes quiet on the wire once the answer lands",
			(await sidebar.waitForConnection((envelope) => {
				if (envelope.item?.type !== "session_row") return false;
				const row = envelope.item.session as SessionRow;
				return row.id === parked && row.pending === 0;
			}, 8_000)) !== undefined,
			JSON.stringify(sidebar.connection().map((envelope) => envelope.item?.type)),
		);
		await sidebar.close().catch(() => {});

		await wire.close().catch(() => {});
		check(
			"the state dispersed once the recovery run finished",
			await until(() => !patient.sessionHub.isLive(parked), 8_000),
			String(patient.sessionHub.isLive(parked)),
		);
	} finally {
		await patient.close();
	}

	// Nobody ever comes back: no grace runs out and nothing is denied — the question hangs, in the
	// ledger and in the state the table keeps, until a later answer or the process itself. That is
	// the cost the grace's deletion was taken for (issue 04 §4), stated here rather than hidden.
	const abandoned = await openRig();
	try {
		const { wire } = await driveToApproval(abandoned);
		const parked = abandoned.sessionId;
		check("the run parked at the approval", abandoned.agent.snapshot(parked).pendingApprovals.length > 0);

		wire.cancel(abandoned.sessionId);
		check("and the state stayed parked", abandoned.sessionHub.isLive(parked), String(abandoned.sessionHub.isLive(parked)));
		// Read the way a returning window would — over REST, through the same snapshot the lane's
		// baseline is built from: the question is derived from the ledger, so this is also what the
		// next process would be shown.
		check(
			"an approval nobody came back to is never denied",
			await until(async () => ((await readSession(abandoned.url, parked))?.pendingApprovals.length ?? 0) === 1, 8_000),
			"the question is not showing",
		);
		const sidebar = await connect(muxUrl(abandoned.url));
		const overview = await sidebar.waitForConnection((envelope) => envelope.item?.type === "sessions", 8_000);
		const parkedRow = ((overview?.item?.sessions ?? []) as SessionRow[]).find((row) => row.id === parked);
		check(
			"and the row keeps reporting a question nobody came back to",
			parkedRow?.pending === 1,
			JSON.stringify(parkedRow),
		);
		await sidebar.close().catch(() => {});
		await wire.close().catch(() => {});
	} finally {
		await abandoned.close();
	}

	// The marker's third ending: an abort is the abandonment sweep, and it clears the marker without
	// a run — no recovery is coming, so the snapshot must stop saying the question stands.
	const aborted = await openRig();
	try {
		const { wire } = await driveToApproval(aborted);
		const parked = aborted.sessionId;
		check("the run parked at the approval", aborted.agent.snapshot(parked).pendingApprovals.length > 0);
		check("the snapshot carries the suspended marker", (await readMeta(parked)).suspended === true);

		const stopped = await request(aborted.url, "POST", `/api/sessions/${parked}/abort`);
		check("the abort was accepted", stopped.status === 200, String(stopped.status));
		const sweptMeta = await readMeta(parked);
		check(
			"the abandonment sweep cleared the marker without a run",
			sweptMeta.suspended === undefined,
			JSON.stringify(sweptMeta),
		);
		check("and it swept the state with it", await until(() => !aborted.sessionHub.isLive(parked), 8_000), String(aborted.sessionHub.isLive(parked)));
		await wire.close().catch(() => {});
	} finally {
		await aborted.close();
	}

	// A fork of a parked session is parked itself: the ledger's dangling call is copied whole, so the
	// marker travels with it — and the fork's row lights up with no hold ever opening it.
	const forked = await openRig();
	try {
		const { wire } = await driveToApproval(forked);
		const parked = forked.sessionId;
		check("the run parked at the approval", forked.agent.snapshot(parked).pendingApprovals.length > 0);

		// Attached before the fork, so the row's first publish is heard rather than raced. The
		// overview is the registration proof: it is sent once the mux owns the connection, so a
		// publish after it cannot miss this connection.
		const sidebar = await connect(muxUrl(forked.url));
		await sidebar.waitForConnection((envelope) => envelope.item?.type === "sessions", 8_000);
		const created = await request(forked.url, "POST", `/api/sessions/${parked}/forks`, { entryId: null });
		const forkId = ((created.payload ?? {}) as { sessionId?: string }).sessionId ?? "";
		check("the fork was created", created.status === 201 && forkId.length > 0, String(created.status));
		if (forkId.length === 0) throw new Error("the fork was not created, so the rest of this rig cannot run");
		const forkMeta = await readMeta(forkId);
		check("the fork's snapshot carries the marker", forkMeta.suspended === true, JSON.stringify(forkMeta));
		const forkRowFrame = await sidebar.waitForConnection(
			(envelope) => envelope.item?.type === "session_row" && (envelope.item.session as SessionRow).id === forkId,
			8_000,
		);
		const forkRow = forkRowFrame?.item?.session as SessionRow | undefined;
		check(
			"the fork's row lights up untouched",
			forkRow?.pending === 1 && forkRow?.running === false,
			JSON.stringify(forkRow),
		);
		await sidebar.close().catch(() => {});
		await wire.close().catch(() => {});
	} finally {
		await forked.close();
	}
} finally {
	clearTimeout(parkedWatchdog);
}

// ---------------------------------------------------------------------------------------------------
// 5. A restart: the cold overview lights the parked row, and the question survives answerable.
//
// The property this pins under the end-restart architecture (ADR-0005 §5): the session file is the
// only state, so the waiting call survives the restart *as a question* — the new process derives it
// from the ledger the way the old one did, and the banner it shows is still answerable. The sidebar
// does not pay that derivation on startup: the snapshot's `suspended` marker lights the row in the
// cold overview, before anything opens the session. What must NOT survive is a memory-resident
// promise: nothing here is "an entry remembers it", and the child is a real `main.ts` over the same
// agent home and the same working directory, so it can only see what the first one left on disk.
// (The answer itself is not exercised: the child speaks to real providers.)
//
// The rig's one subtlety is the store: `setSessionsDir` is an in-process override, while the child
// only knows `MY_AGENT_HOME/sessions`. Both roads must name the same files, so this section owns a
// scratch home of its own — the parent points the override at its `sessions`, the child's env points
// at the home. The switch is safe because the sections above are done with the store they shared.
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\nan approval survives a restart as the question it still is\n");

const restartWatchdog = deadline("the restart checks", 90_000);

const restartRoot = await mkdtemp(join(tmpdir(), "my-agent-approval-restart-"));
const restartHome = await mkdtemp(join(tmpdir(), "my-agent-approval-restart-home-"));
setSessionsDir(join(restartHome, "sessions"));
// One home for both processes: the rows the parent's prompt resolves are the rows the child reads.
new ModelManager({ home: restartHome }).replaceRows(rows);
const restartFake = createFakeTransport();
const first = await bootServer({ workDirAbsPath: restartRoot, port: 0, chatTransport: restartFake.chatTransport, settingsHome: restartHome });
let restartSessionId = "";
try {
	// Startup selects nothing now, so the session this half drives is the one an explicit creation
	// returned — the landing answer is the pin's business, not this smoke's.
	// Birth 即第一条消息（ADR-0021），这次 birth run 自己落定（剧本队列为空 → 一条瞬时错误消息，
	// 不耗剧本）；工具调用的剧本因此在 birth 之后、prompt 之前才上队。
	const created = await request(first.url, "POST", "/api/sessions", { text: "the restart conversation" });
	restartSessionId = ((created.payload ?? {}) as { sessionId?: string }).sessionId ?? "";
	check("the restart session was created", created.status === 201 && restartSessionId.length > 0, String(created.status));

	const turned = await request(first.url, "PATCH", `/api/sessions/${encodeURIComponent(restartSessionId)}`, {
		approval: { read: true },
	});
	check("the read tool was put behind the gate", turned.status === 200, String(turned.status));
	restartFake.setResponses([
		fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
		fakeAssistantMessage("done"),
	]);
	check("the prompt was accepted", (await prompt(first.url, restartSessionId, "read the notes")) === 202);
	const parked = await waitParked(first.url, restartSessionId);
	check("the run parked at the approval", (parked?.pendingApprovals.length ?? 0) === 1, JSON.stringify(parked?.pendingApprovals));
} finally {
	await first.close();
}

// `main.ts` refuses `--port 0`, so the child needs a real one; readiness is polled off `/api/health`,
// never parsed out of a child's stdout (its shutdown handler owns that stream).
const childPort = await freePort();
const child = spawn(
	process.execPath,
	[join("packages", "server", "src", "main.ts"), "--workDir", restartRoot, "--port", String(childPort)],
	{
		stdio: "ignore",
		env: {
			...process.env,
			// Explicit, never inherited-by-luck: the child must read the same sessions the parent wrote.
			MY_AGENT_HOME: restartHome,
		},
	},
);
try {
	const childBase = `http://127.0.0.1:${childPort}`;
	let healthy = false;
	{
		const end = Date.now() + 15_000;
		while (Date.now() < end) {
			try {
				if ((await fetch(`${childBase}/api/health`)).ok) {
					healthy = true;
					break;
				}
			} catch {
				// not up yet
			}
			await sleep(100);
		}
	}
	check("the second process answered /api/health", healthy);

	if (healthy) {
		// The cold read comes first, on a connection that opens nothing: the overview is the seed's
		// own answer, and the parked row must light up from the snapshot's marker — no host, no
		// replay, no ledger pairing. This is the sidebar's first glance after a restart.
		const sidebar = await connect(muxUrl(childBase));
		const overview = await sidebar.waitForConnection((envelope) => envelope.item?.type === "sessions", 8_000);
		const coldRow = ((overview?.item?.sessions ?? []) as SessionRow[]).find((row) => row.id === restartSessionId);
		check(
			"the cold overview lights the parked session's row",
			(coldRow?.pending ?? 0) >= 1,
			JSON.stringify(coldRow),
		);
		check(
			"and the row is not running: no run survived the restart",
			coldRow?.running === false,
			JSON.stringify(coldRow),
		);
		await sidebar.close().catch(() => {});

		const wire = await connect(muxUrl(childBase));
		const baseline = await wire.open(restartSessionId);
		check(
			"the new process still shows the call that was parked",
			baseline.pendingApprovals.length === 1,
			JSON.stringify(baseline.pendingApprovals),
		);
		check(
			"and the session still holds the call that was parked",
			JSON.stringify(baseline.messages).includes("notes.txt"),
			String(JSON.stringify(baseline.messages).length),
		);
		await wire.close().catch(() => {});
	}
} finally {
	const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
	// On POSIX this rides into `main.ts`'s own SIGTERM handler; on Windows the request terminates the
	// child outright. Either way the exit must arrive, which is the part a shell depends on.
	child.kill("SIGTERM");
	await Promise.race([exited, sleep(5_000)]);
	clearTimeout(restartWatchdog);
	await rm(restartRoot, { recursive: true, force: true });
	await rm(restartHome, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\napproval ok\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;

// ---------------------------------------------------------------------------------------------------
// The apparatus: one graph per section, and the rigs built on it.
// ---------------------------------------------------------------------------------------------------

/** One server over a hub: the real routes and the mux in front of them, the way `bootServer` wires it. */
interface Graph {
	url: string;
	muxServer: MuxServer;
	sessionHub: SessionHub;
	close(): Promise<void>;
}

async function serve(sessionHub: SessionHub): Promise<Graph> {
	const muxServer = createMuxServer({ sessionHub }, { heartbeatIntervalMs: 150 });
	const listeners = sessionListeners({ sessionHub });
	const router = new Router(
		createRoutes({
			systemController: new SystemController(sessionHub, listeners),
			sessionController: new SessionController(sessionHub, listeners),
		}),
	);
	const httpServerHandle = await createServer({ router, clientDir: "packages/web/dist", onUpgrade: muxUpgrade(muxServer) });
	await new Promise<void>((listen) => httpServerHandle.server.listen(0, "127.0.0.1", listen));
	const url = `http://127.0.0.1:${(httpServerHandle.server.address() as { port: number }).port}`;
	return {
		url,
		muxServer,
		sessionHub,
		close: async () => {
			muxServer.close();
			await sessionHub.close();
			await httpServerHandle.close();
		},
	};
}

interface Rig {
	root: string;
	sessionHub: SessionHub;
	agent: Agent;
	/** The id the mount created — what every id-keyed call below names. */
	sessionId: string;
	/** The session the mount created — the one the orchestrator's table should hold. */
	session: Session;
	url: string;
	close(): Promise<void>;
}

/**
 * One isolated server: a hub over a session it runs on a scripted transport, and the real routes and
 * mux in front of it.
 *
 * Only the transport is a stand-in. The session is mounted the way `SessionHub.open()` mounts one, so
 * that every hold below — the viewer's and the ones the parked-approval sections drive — is a real hold through the hub.
 */
async function openRig(): Promise<Rig> {
	const root = await mkdtemp(join(tmpdir(), "my-agent-approval-"));
	const transport = createFakeTransport();
	transport.setResponses([
		fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
		fakeAssistantMessage("done"),
	]);
	// The hub's one orchestrator sends through the scripted transport, so the session it is about to
	// serve is answered by it. The gate is a settings read the orchestrator makes per request, so the
	// approval map and the rows are seeded onto temp-home files first — the machine's own settings
	// stay out of it.
	const settingsHome = await seedApprovalGate(root, rows);
	const sessionHub = new SessionHub({
		workDirAbsPath: root,
		chatTransport: transport.chatTransport,
		settingsHome,
		modelsHome: settingsHome,
	});
	// The graph first, the mount second: the hub learns the mounted session the way the real
	// process learns a birth — through the refresh the controller's listener would drive. A mount
	// the hub never hears about is a row it never follows, and the row would never wear the
	// live fields.
	const graph = await serve(sessionHub);
	const { id: sessionId, session } = await mountSession(sessionHub, {
		root,
	});
	await graph.sessionHub.refreshRow(sessionId);

	return {
		root,
		sessionHub,
		agent: sessionHub.agent,
		sessionId,
		session,
		url: graph.url,
		close: async () => {
			await graph.close();
			await rm(settingsHome, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
			await rm(storeRoot, { recursive: true, force: true }).catch(() => {});
		},
	};
}

/** One opened session and the id it is keyed by — an `Agent` answers only by id now. */
interface Mounted {
	id: string;
	agent: Agent;
}

interface CrossRig {
	sessionHub: SessionHub;
	/** Two sessions, each parked on the same scripted toolCallId once prompted. */
	sessions: Mounted[];
	url: string;
	close(): Promise<void>;
}

/**
 * One server, two sessions, one answers table between them: the shape under test.
 *
 * Both sessions park on the same toolCallId — the collision a random-id provider only makes
 * improbable — and they share the one transport a process has, as the second half of the same point:
 * an answer is keyed by its session, not by the call. Both are mounted the way `SessionHub.open()`
 * mounts one, so the answers table they share is the real one.
 */
async function openCrossRig(): Promise<CrossRig> {
	const root = await mkdtemp(join(tmpdir(), "my-agent-approval-cross-"));
	// One transport for both sessions, as the process has one: the scripted queue holds two identical
	// tool calls — the same id both sessions park on, which is what a provider that numbers its calls
	// does, and what the wire's random ids only make improbable — and the two closing answers.
	const transport = createFakeTransport();
	transport.setResponses([
		fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" }, { id: "call_shared" })),
		fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" }, { id: "call_shared" })),
		fakeAssistantMessage("done"),
		fakeAssistantMessage("done"),
	]);
	// The gate both sessions park on is a settings read the orchestrator makes per request, so the
	// approval map and the rows are seeded onto temp-home files first, the same way openRig's are.
	const settingsHome = await seedApprovalGate(root, rows);
	const sessionHub = new SessionHub({
		workDirAbsPath: root,
		chatTransport: transport.chatTransport,
		settingsHome,
		modelsHome: settingsHome,
	});
	const sessions: Mounted[] = [];
	for (let index = 0; index < 2; index += 1) {
		const { id } = await mountSession(sessionHub, {
			root,
			});
		sessions.push({ id, agent: sessionHub.agent });
	}

	const graph = await serve(sessionHub);
	return {
		sessionHub,
		sessions,
		url: graph.url,
		close: async () => {
			await graph.close();
			await rm(settingsHome, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
			await rm(storeRoot, { recursive: true, force: true }).catch(() => {});
		},
	};
}

/**
 * Attach a viewer, start a run, and bring it to the approval gate — the state every parked-approval
 * check begins from.
 */
async function driveToApproval(rig: Rig): Promise<{ wire: WireClient }> {
	const wire = await connect(muxUrl(rig.url));
	await wire.open(rig.sessionId);

	if ((await prompt(rig.url, rig.sessionId, "read the notes")) !== 202) {
		throw new Error("the prompt was not accepted");
	}
	const asked = await wire.waitFor(rig.sessionId, (message) => message.type === "approval_request", 10_000);
	if (asked?.type !== "approval_request") throw new Error("the run never asked for approval");
	return { wire };
}

/** The id of the approval one lane is showing. */
function pendingId(wire: WireClient, sessionId: string): string {
	const asked = wire.items(sessionId).find((message) => message.type === "approval_request");
	return asked?.type === "approval_request" ? asked.request.toolCallId : "";
}

/**
 * The text a tool execution end event closed its call with — the verdict's only home now.
 *
 * The answer is not a flag anywhere on the wire: a grant's end event carries whatever the tool
 * itself produced, and a denial carries the sentence the close wrote. Distinguishing them reads
 * the words, which is exactly what the window does.
 */
function resultTextOf(message: { type: "event" } & { event: { type: string; result?: unknown } }): string {
	if (message.event.type !== "tool_execution_end") return "";
	const content = (message.event.result as { content?: { text?: string }[] } | undefined)?.content ?? [];
	return content.map((block) => block.text ?? "").join("");
}

/** One free port, taken and released: `main.ts` refuses `--port 0`, so the child needs a real one. */
async function freePort(): Promise<number> {
	const probe = createTcpServer();
	await new Promise<void>((listen) => probe.listen(0, "127.0.0.1", listen));
	const port = (probe.address() as { port: number }).port;
	await new Promise<void>((close) => probe.close(() => close()));
	return port;
}
