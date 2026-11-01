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
//   4. a parked approval — it outlives the last claim only up to the hub's grace, and an
//      abandonment is a denial rather than a lost question;
//   5. a restart — a second process seeds no pending approval, and the transcript keeps the call.
//
// Two things pinned by `docs/notes.md` §一 and §二 are load-bearing here. The first section's
// `new SessionHub({ workspaceRoot: root })` is deliberately left alone (the hub's option is `absCwd`):
// that section drives a session it mounted itself and never asks the hub to resolve a workspace, and
// "fixing" it would change the one thing the note says not to touch — it is also why this file stays
// outside `npm run check`'s `include`. And no section may hold a session open through a *subscription*:
// a subscription takes no claim, so wherever a check needs the host to outlive a request it takes a
// claim of its own (the bench claim), exactly as `smoke-stream` and `smoke-mux` do.
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { bootServer, muxUpgrade, sessionListeners } from "../packages/server/src/boot.ts";
import { createMuxServer, type MuxServer } from "../packages/server/src/mux.ts";
import { HostedSession, SessionHub } from "../packages/server/src/hub.ts";
import { createSessionProjection } from "../packages/server/src/projection.ts";
import { SessionController, SystemController } from "../packages/server/src/controllers/sessions.ts";
import { createRoutes } from "../packages/server/src/controllers/routes.ts";
import { Router } from "../packages/server/src/http/routing.ts";
import { createServer } from "../packages/server/src/http.ts";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall } from "./fake-transport.ts";
import { connect, until, type WireClient } from "./wire/client.ts";
import type { PendingApproval } from "@my-agent/core/protocol";
import {
	openAgent,
	createSessionState,
	SettingsManager,
	type Agent,
	type ModelSource,
	type ModelConfig,
	workspaceDir,
} from "@my-agent/core";

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
	submitting: boolean;
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

// The row every rig's session runs on. Held here rather than read from the hub: the hub reads the
// machine's own `models.json`, and a test must not depend on what the person running it happens to
// have configured.
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
const models: ModelSource = { list: () => rows };
const modelName = "anthropic";
process.stdout.write(`model ${modelName} via the scripted transport\n`);

// ---------------------------------------------------------------------------------------------------
// 1. The round trip, and a refused answer that leaves nothing behind.
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\na run parked at the gate is announced on the wire and answered over REST\n");

const roundTripWatchdog = deadline("the approval round trip", 60_000);

const root = await mkdtemp(join(tmpdir(), "my-agent-approval-"));
// `docs/notes.md` §一: left exactly as written, `workspaceRoot` included, even though `HubOptions`
// declares `absCwd`. This section mounts the session by hand and never asks the hub to resolve a
// workspace, which is the only reason it works — and why the note says not to "fix" it.
const hub = new SessionHub({ workspaceRoot: root });
const fake = createFakeTransport();
// One response per call: a tool call, then the text that ends the run. Both are assistant messages —
// `fakeToolCall` is a content block, not a response on its own.
fake.setResponses([
	fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
	fakeAssistantMessage("done"),
]);
const session = await openAgent({
	absWorkspaceRoot: root,
	sessionState: createSessionState(root),
	models,
	api: fake.api,
	model: modelName,
	settingsManager: SettingsManager.inMemory({ approval: { read: true } }),
});
// Mounted the way `SessionHub.open()` mounts one, so every request below claims through the real hub.
(hub as unknown as { hosts: Map<string, HostedSession> }).hosts.set(session.id, new HostedSession(session, root));

const roundTrip = await serve(hub);
try {
	// The bench holds a claim for the length of these checks. A subscription takes none — that is the
	// model — so without it the reap that follows the run's own claim would end the lane in the middle
	// of the assertions below.
	const bench = await hub.claim(session.id);
	const wire = await connect(muxUrl(roundTrip.url));

	const baseline = await wire.open(session.id);
	check("the lane opened on the session's baseline", baseline.id === session.id, `baseline=${baseline.id}`);
	check("and the session starts idle", baseline.submitting === false, String(baseline.submitting));

	check("the prompt was accepted", (await prompt(roundTrip.url, session.id, "read the notes")) === 202);

	// The run starts and stops at the gate: wait for the frame that shows the banner, and fail if the
	// lane ends first. Waiting on a frame that never comes is exactly the bug being looked for.
	const asked = await wire.waitFor(session.id, (message) => message.type === "approval_request", 10_000);
	check(
		"the approval request reached the lane",
		asked?.type === "approval_request",
		JSON.stringify(wire.items(session.id).map((message) => message.type)),
	);
	check(
		"the lane stayed open while it waited",
		!wire.endOf(session.id).ended && wire.endOf(session.id).errors.length === 0,
		JSON.stringify(wire.endOf(session.id)),
	);
	if (asked?.type !== "approval_request") throw new Error("no approval request, so the rest of this section cannot run");

	const request0: PendingApproval = asked.request;
	check("the request names the tool that needs approval", request0.toolName === "read", JSON.stringify(request0));
	check("the request carries what the banner shows", (request0.summary ?? "").length > 0, JSON.stringify(request0));

	// The refused answer comes first. An id nothing is waiting on is a conflict, and the refusal must
	// put no frame on the lane: this is ticket 14's "the failed request does not pollute the
	// differences", the exact other side of ticket 13's `[true, false, false]` defect. It is also why
	// the settlement count below is asserted to be one rather than "at least one".
	const refused = await request(roundTrip.url, "POST", `/api/sessions/${session.id}/approvals/no-such-call`, { approved: true });
	check("an unknown toolCallId is a conflict", refused.status === 409, `status ${refused.status} ${JSON.stringify(refused.payload)}`);
	check(
		"and the refusal says what was refused",
		JSON.stringify(refused.payload).includes("not a pending approval"),
		JSON.stringify(refused.payload),
	);
	check(
		"and the refusal put no settlement on the lane",
		wire.items(session.id).every((message) => message.type !== "approval_settled"),
		JSON.stringify(wire.items(session.id).map((message) => message.type)),
	);

	// The ids the browser sends back are opaque and may contain a colon, so this also pins that a path
	// parameter is percent-decoded before the controller sees it.
	const answered = await request(
		roundTrip.url,
		"POST",
		`/api/sessions/${session.id}/approvals/${encodeURIComponent(request0.toolCallId)}`,
		{ approved: true },
	);
	check("the real answer was accepted", answered.status === 200, `status ${answered.status}`);

	const settled = await wire.waitFor(session.id, (message) => message.type === "approval_settled", 10_000);
	check(
		"the lane was told the approval was settled",
		settled?.type === "approval_settled",
		JSON.stringify(wire.items(session.id).map((message) => message.type)),
	);
	const settlements = wire.items(session.id).filter((message) => message.type === "approval_settled");
	check(
		"and exactly one answer reached it: the one that was given",
		settlements.length === 1 && settlements[0]?.approved === true,
		JSON.stringify(settlements),
	);

	// The run continues, so the answer really did reach the waiting tool call.
	check(
		"the run finished after the answer",
		(await wire.waitFor(session.id, (message) => message.type === "status" && message.submitting === false, 10_000)) !== undefined,
		JSON.stringify(wire.items(session.id).map((message) => message.type)),
	);
	const transcript = await readSession(roundTrip.url, session.id);
	check("the tool ran and its result is in the transcript", JSON.stringify(transcript?.messages ?? []).includes("notes.txt"));
	check("the model's closing answer is in the transcript", JSON.stringify(transcript?.messages ?? []).includes("done"));

	await wire.close();
	hub.release(bench);
} finally {
	clearTimeout(roundTripWatchdog);
	await roundTrip.close();
	await rm(root, { recursive: true, force: true });
	await rm(workspaceDir(root), { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------------------------------
// 2. One answer, every window showing the question.
//
// The defect this pins: how an approval was answered used to be read out of one registry-wide set and
// deleted as it was read, so the first stream to run its difference reported the grant and every other
// one reported a denial — an answer that changed with the number of windows, and a plain lie in all
// but one of them. A subscription is a *connection × session* pair, so three windows are three
// connections; one connection carries one lane per session, not three.
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\nevery window on a session hears how an approval was answered\n");

const sharedWatchdog = deadline("the shared-answer checks", 60_000);

const shared = await openRig(60_000);
try {
	const bench = await shared.hub.claim(shared.session.id);
	// Every window is attached before anything runs, so the request is a difference frame on each of
	// them rather than part of a baseline — which is the path under test.
	const windows: WireClient[] = [];
	for (let index = 0; index < 3; index += 1) {
		const window = await connect(muxUrl(shared.url));
		await window.open(shared.session.id);
		windows.push(window);
	}
	check("three connections are open on the one session", windows.length === 3);

	check("the prompt was accepted", (await prompt(shared.url, shared.session.id, "read the notes")) === 202);

	const shown = await Promise.all(
		windows.map((window) => window.waitFor(shared.session.id, (message) => message.type === "approval_request", 10_000)),
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
		`/api/sessions/${shared.session.id}/approvals/${encodeURIComponent(toolCallId)}`,
		{ approved: true },
	);
	check("the answer was accepted", answered.status === 200, `status ${answered.status}`);

	// The settled frame is what the answer produced, and waiting for it is what puts it in hand: the
	// run's own last status is older than it (the gate's run already ended), so the status alone
	// cannot tell this wait when the answer has landed.
	await Promise.all(
		windows.map((window) => window.waitFor(shared.session.id, (message) => message.type === "approval_settled", 10_000)),
	);

	const reported = windows.map((window) =>
		window.items(shared.session.id).find((message) => message.type === "approval_settled"),
	);
	check(
		"every window was told the approval was settled",
		reported.every((frame) => frame !== undefined),
		JSON.stringify(reported.map((frame) => frame?.type ?? "none")),
	);
	check(
		"and every window was told the same answer: the one that was given",
		reported.every((frame) => frame?.approved === true),
		JSON.stringify(reported),
	);

	await Promise.all(windows.map((window) => window.close().catch(() => {})));
	shared.hub.release(bench);
} finally {
	clearTimeout(sharedWatchdog);
	await shared.close();
}

// ---------------------------------------------------------------------------------------------------
// 3. One id, two sessions: an answer belongs to the session it was given on.
//
// The defect this pins: the answers table was keyed by toolCallId alone, so two sessions whose
// providers happened to number their calls the same way — several Anthropic-compatible endpoints do
// (`call_0`, `call_1`) — shared one entry, and the second session's identical approval leaving any
// other way read the first session's answer as its own. The mux's table is keyed by session first; the
// scripted transports are told to hand both sessions the same id, which is the case the wire's random
// `toolu_…` ids only make improbable.
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\nan answer reaches only the session it was given on\n");

const crossWatchdog = deadline("the cross-session checks", 60_000);

const cross = await openCrossRig();
try {
	const [firstSession, secondSession] = cross.sessions;
	const firstBench = await cross.hub.claim(firstSession.id);
	const secondBench = await cross.hub.claim(secondSession.id);
	const firstWire = await connect(muxUrl(cross.url));
	const secondWire = await connect(muxUrl(cross.url));
	const [firstBaseline, secondBaseline] = await Promise.all([
		firstWire.open(firstSession.id),
		secondWire.open(secondSession.id),
	]);
	check(
		"two sessions on one hub are both watchable",
		firstBaseline.id === firstSession.id && secondBaseline.id === secondSession.id,
	);
	check("and both started idle", !firstBaseline.submitting && !secondBaseline.submitting);

	for (const parked of cross.sessions) {
		const accepted = await prompt(cross.url, parked.id, "read the notes");
		if (accepted !== 202) throw new Error(`the prompt was not accepted: ${accepted}`);
	}

	const [firstAsked, secondAsked] = await Promise.all([
		firstWire.waitFor(firstSession.id, (message) => message.type === "approval_request", 10_000),
		secondWire.waitFor(secondSession.id, (message) => message.type === "approval_request", 10_000),
	]);
	const firstId = firstAsked?.type === "approval_request" ? firstAsked.request.toolCallId : "";
	const secondId = secondAsked?.type === "approval_request" ? secondAsked.request.toolCallId : "";
	check("and both approvals carry the same toolCallId", firstId.length > 0 && firstId === secondId, `${firstId} vs ${secondId}`);
	if (firstId.length === 0 || firstId !== secondId) {
		throw new Error("the two sessions did not park on the same id, so the rest of this section cannot run");
	}

	// The first session's answer is a grant; the second session's identical id leaves by a different
	// road — an abort denies it — and the frame that takes its banner down is built from that denial,
	// never from the first session's grant.
	const granted = await request(
		cross.url,
		"POST",
		`/api/sessions/${firstSession.id}/approvals/${encodeURIComponent(firstId)}`,
		{ approved: true },
	);
	check("the first session's answer was accepted", granted.status === 200, `status ${granted.status}`);

	const stopped = await request(cross.url, "POST", `/api/sessions/${secondSession.id}/abort`);
	check("the second session was aborted", stopped.status === 200, `status ${stopped.status}`);

	await Promise.all([
		firstWire.waitFor(firstSession.id, (message) => message.type === "approval_settled", 10_000),
		secondWire.waitFor(secondSession.id, (message) => message.type === "approval_settled", 10_000),
	]);

	const reported = [firstWire, secondWire].map((wire, index) =>
		wire.items(cross.sessions[index]?.id ?? "").find((message) => message.type === "approval_settled"),
	);
	check("the answered session was told its own grant", reported[0]?.approved === true, JSON.stringify(reported));
	check(
		"the aborted session was told a denial, not the other session's grant",
		reported[1]?.approved === false,
		JSON.stringify(reported),
	);

	await Promise.all([firstWire.close().catch(() => {}), secondWire.close().catch(() => {})]);
	cross.hub.release(firstBench);
	cross.hub.release(secondBench);
} finally {
	clearTimeout(crossWatchdog);
	await cross.close();
}

// ---------------------------------------------------------------------------------------------------
// 4. A parked approval outlives the last claim, up to the hub's grace.
//
// The phase this covers: a claim answers "is anyone running or changing this", which is not the
// question "will anyone answer". The rigs take their claims through the hub itself, so the reap under
// test is the real one — the sections above mount a session by hand and keep a bench claim on it.
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\nan approval waits for its grace before it is called abandoned\n");

const graceWatchdog = deadline("the parked-approval checks", 90_000);

try {
	// Waited out, not denied: the viewer looked elsewhere and came back.
	const patient = await openRig(60_000);
	try {
		const { wire, viewer } = await driveToApproval(patient);
		const parked = patient.host;
		check("the run parked at the approval", parked.session.hasPendingApprovals);

		// The viewer switches away, and its claim is the *only* thing keeping the session open — a
		// subscription takes none. So this release is what starts the reap, and the run parked at the
		// gate is what the reap must not settle through.
		wire.cancel(patient.session.id);
		patient.hub.release(viewer);
		await sleep(1_500);

		check("the approval is still pending well past the old denial window", parked.session.hasPendingApprovals, "it was denied");
		check("the session was not reaped out from under it", patient.hub.live.includes(parked.id), patient.hub.live.join(","));
		check(
			"and no denial reached the lane",
			wire.items(patient.session.id).every((message) => message.type !== "approval_settled"),
			JSON.stringify(wire.items(patient.session.id).map((message) => message.type)),
		);

		// The person came back: the same session, the same unanswered question, still theirs to answer.
		const again = await patient.hub.claim(parked.id);
		check("claiming it again hands back the same session", again === parked, "the old host was gone, so a new one was built");

		const returned = await wire.open(patient.session.id);
		check(
			"the returning window is shown the approval it must answer",
			returned.pendingApprovals.length === 1,
			JSON.stringify(returned.pendingApprovals),
		);

		const toolCallId = pendingId(wire, patient.session.id);
		const answered = await request(
			patient.url,
			"POST",
			`/api/sessions/${parked.id}/approvals/${encodeURIComponent(toolCallId)}`,
			{ approved: true },
		);
		check("the answer was accepted", answered.status === 200, `status ${answered.status}`);

		check(
			"the approval was settled as granted",
			await until(() => wire.items(patient.session.id).some((message) => message.type === "approval_settled" && message.approved === true), 8_000),
			JSON.stringify(wire.items(patient.session.id).filter((message) => message.type === "approval_settled")),
		);
		check(
			"and the recovery run it started finished",
			await until(async () => ((await readSession(patient.url, parked.id))?.submitting ?? true) === false, 8_000),
		);

		await wire.close().catch(() => {});
		patient.hub.release(again);
		check(
			"the session is closed once the run is over and nobody holds it",
			await until(() => !patient.hub.live.includes(parked.id), 8_000),
			patient.hub.live.join(","),
		);
	} finally {
		await patient.close();
	}

	// Abandoned for real: nobody came back, so the run must not be parked forever.
	const abandoned = await openRig(30);
	try {
		const { wire, viewer } = await driveToApproval(abandoned);
		const parked = abandoned.host;
		check("the run parked at the approval", parked.session.hasPendingApprovals);

		wire.cancel(abandoned.session.id);
		abandoned.hub.release(viewer);

		check(
			"an approval nobody came back to is denied after the grace",
			await until(() => !parked.session.hasPendingApprovals, 8_000),
			"it was still pending",
		);
		check(
			"and the session is then reaped out of the registry",
			await until(() => !abandoned.hub.live.includes(parked.id), 8_000),
			abandoned.hub.live.join(","),
		);
		await wire.close().catch(() => {});
	} finally {
		await abandoned.close();
	}

	// Somebody looked, then left again without answering. The reap that was waiting has to step aside
	// for them — and then be startable again, or the session would be stuck in the registry for good
	// with `reaping` still set and no release able to schedule another one.
	const lookedThenLeft = await openRig(3_000);
	try {
		const { wire, viewer } = await driveToApproval(lookedThenLeft);
		const parked = lookedThenLeft.host;
		check("the run parked at the approval", parked.session.hasPendingApprovals);

		wire.cancel(lookedThenLeft.session.id);
		lookedThenLeft.hub.release(viewer);

		check("the reap begins once the last claim is gone", await until(() => parked.reaping, 6_000));

		const back = await lookedThenLeft.hub.claim(parked.id);
		check("the returning viewer gets the session back", back === parked);
		check(
			"the reap stepped aside rather than denying a question someone came back for",
			await until(() => !parked.reaping, 6_000),
			"it stayed reaping, so no later release could ever reap this session",
		);
		check("and the approval is still unanswered", parked.session.hasPendingApprovals);

		// ...and now they leave without answering. The session must still be reapable.
		lookedThenLeft.hub.release(back);
		check(
			"leaving without answering parks again, and the grace runs out for real",
			await until(() => !parked.session.hasPendingApprovals, 8_000),
			"it stayed pending, so nothing reaped it",
		);
		check(
			"so the session is not stuck in the registry",
			await until(() => !lookedThenLeft.hub.live.includes(parked.id), 8_000),
			lookedThenLeft.hub.live.join(","),
		);
		await wire.close().catch(() => {});
	} finally {
		await lookedThenLeft.close();
	}
} finally {
	clearTimeout(graceWatchdog);
}

// ---------------------------------------------------------------------------------------------------
// 5. A restart seeds no pending approval.
//
// The property this pins under the end-restart architecture (ADR-0006 §5): the transcript is the
// only state, so the waiting call survives the restart *as a question* — the new process derives it
// from the ledger the way the old one did, and the banner it shows is still answerable. What must
// NOT survive is a memory-resident promise: nothing here is "an entry remembers it", and the child
// is a real `main.ts` over the same agent home and the same workspace, so it can only see what the
// first one left on disk. (The answer itself is not exercised: the child speaks to real providers.)
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\nan approval survives a restart as the question it still is\n");

const restartWatchdog = deadline("the restart checks", 90_000);

const restartRoot = await mkdtemp(join(tmpdir(), "my-agent-approval-restart-"));
const restartFake = createFakeTransport();
restartFake.setResponses([
	fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
	fakeAssistantMessage("done"),
]);
const first = await bootServer({ absCwd: restartRoot, port: 0, api: restartFake.api });
let restartSessionId = "";
try {
	const landing = (await (await fetch(`${first.url}/api/sessions/current`)).json()) as { sessionId: string };
	restartSessionId = landing.sessionId;
	check("the first process landed on a session", restartSessionId.length > 0, restartSessionId);

	const turned = await request(first.url, "PATCH", `/api/sessions/${encodeURIComponent(restartSessionId)}`, {
		approval: { read: true },
	});
	check("the read tool was put behind the gate", turned.status === 200, String(turned.status));
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
	[join("packages", "server", "src", "main.ts"), "--cwd", restartRoot, "--port", String(childPort)],
	{
		stdio: "ignore",
		env: {
			...process.env,
			// Explicit, never inherited-by-luck: the child must read the same sessions the parent wrote.
			MY_AGENT_HOME: process.env.MY_AGENT_HOME ?? join(homedir(), ".my-agent"),
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
		const wire = await connect(muxUrl(childBase));
		const baseline = await wire.open(restartSessionId);
		check(
			"the new process still shows the call that was parked",
			baseline.pendingApprovals.length === 1,
			JSON.stringify(baseline.pendingApprovals),
		);
		check(
			"and the transcript still holds the call that was parked",
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
	await rm(workspaceDir(restartRoot), { recursive: true, force: true }).catch(() => {});
}

process.stdout.write(failures === 0 ? "\napproval ok\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;

// ---------------------------------------------------------------------------------------------------
// The apparatus: one graph per section, and the rigs built on it.
// ---------------------------------------------------------------------------------------------------

/** One server over a hub: the real routes and the mux in front of them, the way `bootServer` wires it. */
interface Graph {
	url: string;
	mux: MuxServer;
	close(): Promise<void>;
}

async function serve(hub: SessionHub): Promise<Graph> {
	const projection = createSessionProjection(hub);
	const mux = createMuxServer(hub, projection, { heartbeatIntervalMs: 150 });
	const router = new Router(
		createRoutes({
			system: new SystemController(hub),
			sessions: new SessionController(hub, sessionListeners(mux)),
		}),
	);
	const handle = await createServer({ router, clientDir: "packages/web/dist", onUpgrade: muxUpgrade(mux) });
	await new Promise<void>((listen) => handle.server.listen(0, "127.0.0.1", listen));
	const url = `http://127.0.0.1:${(handle.server.address() as { port: number }).port}`;
	return {
		url,
		mux,
		close: async () => {
			projection.close();
			mux.close();
			await hub.close();
			await handle.close();
		},
	};
}

interface Rig {
	root: string;
	hub: SessionHub;
	session: Agent;
	/** The mounted host, as the hub holds it: the object the reap decides about. */
	host: HostedSession;
	url: string;
	close(): Promise<void>;
}

/**
 * One isolated server: a hub whose approval grace is the number under test, a session running on a
 * scripted transport of its own, and the real routes and mux in front of it.
 *
 * Only the transport is a stand-in. The session is mounted the way `SessionHub.open()` mounts one, so
 * that every claim below — the viewer's and the reap it drives — is a real claim through the hub.
 */
async function openRig(approvalGraceMs: number): Promise<Rig> {
	const root = await mkdtemp(join(tmpdir(), "my-agent-approval-grace-"));
	const hub = new SessionHub({ absCwd: root, approvalGraceMs });

	const transport = createFakeTransport();
	transport.setResponses([
		fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
		fakeAssistantMessage("done"),
	]);
	const session = await openAgent({
		absWorkspaceRoot: root,
		sessionState: createSessionState(root),
		models,
		api: transport.api,
		model: modelName,
		settingsManager: SettingsManager.inMemory({ approval: { read: true } }),
	});

	const host = new HostedSession(session, root);
	(hub as unknown as { hosts: Map<string, HostedSession> }).hosts.set(session.id, host);

	const graph = await serve(hub);
	return {
		root,
		hub,
		session,
		host,
		url: graph.url,
		close: async () => {
			await graph.close();
			await rm(root, { recursive: true, force: true });
			await rm(workspaceDir(root), { recursive: true, force: true }).catch(() => {});
		},
	};
}

interface CrossRig {
	hub: SessionHub;
	/** Two sessions, each parked on the same scripted toolCallId once prompted. */
	sessions: Agent[];
	url: string;
	close(): Promise<void>;
}

/**
 * One server, two sessions, one answers table between them: the shape under test.
 *
 * Each session runs a scripted transport of its own, but both are told the same toolCallId — the
 * collision a random-id provider only makes improbable. Both are mounted the way `SessionHub.open()`
 * mounts one, so the answers table they share is the real one.
 */
async function openCrossRig(): Promise<CrossRig> {
	const root = await mkdtemp(join(tmpdir(), "my-agent-approval-cross-"));
	const hub = new SessionHub({ absCwd: root, approvalGraceMs: 60_000 });
	const sessions: Agent[] = [];
	for (let index = 0; index < 2; index += 1) {
		const transport = createFakeTransport();
		transport.setResponses([
			// The same id from both transports: what a provider that numbers its calls does to two
			// sessions parked at once, and what the wire's random ids only make improbable.
			fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" }, { id: "call_shared" })),
			fakeAssistantMessage("done"),
		]);
		const session = await openAgent({
			absWorkspaceRoot: root,
			sessionState: createSessionState(root),
			models,
			api: transport.api,
			model: modelName,
			settingsManager: SettingsManager.inMemory({ approval: { read: true } }),
		});
		(hub as unknown as { hosts: Map<string, HostedSession> }).hosts.set(session.id, new HostedSession(session, root));
		sessions.push(session);
	}

	const graph = await serve(hub);
	return {
		hub,
		sessions,
		url: graph.url,
		close: async () => {
			await graph.close();
			await rm(root, { recursive: true, force: true });
			await rm(workspaceDir(root), { recursive: true, force: true }).catch(() => {});
		},
	};
}

/**
 * Attach a viewer, start a run, and bring it to the approval gate — the state every parked-approval
 * check begins from. The viewer's own claim is what keeps the host open across the run: a
 * subscription takes none.
 */
async function driveToApproval(rig: Rig): Promise<{ wire: WireClient; viewer: HostedSession }> {
	const viewer = await rig.hub.claim(rig.session.id);
	const wire = await connect(muxUrl(rig.url));
	await wire.open(rig.session.id);

	if ((await prompt(rig.url, rig.session.id, "read the notes")) !== 202) {
		throw new Error("the prompt was not accepted");
	}
	const asked = await wire.waitFor(rig.session.id, (message) => message.type === "approval_request", 10_000);
	if (asked?.type !== "approval_request") throw new Error("the run never asked for approval");
	return { wire, viewer };
}

/** The id of the approval one lane is showing. */
function pendingId(wire: WireClient, sessionId: string): string {
	const asked = wire.items(sessionId).find((message) => message.type === "approval_request");
	return asked?.type === "approval_request" ? asked.request.toolCallId : "";
}

/** One free port, taken and released: `main.ts` refuses `--port 0`, so the child needs a real one. */
async function freePort(): Promise<number> {
	const probe = createTcpServer();
	await new Promise<void>((listen) => probe.listen(0, "127.0.0.1", listen));
	const port = (probe.address() as { port: number }).port;
	await new Promise<void>((close) => probe.close(() => close()));
	return port;
}
