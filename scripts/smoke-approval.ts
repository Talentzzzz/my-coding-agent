// Transport-level approval smoke test: a run that stops for approval must announce the request on the
// session's event stream, and the answers endpoint must let it continue. No provider key is needed —
// the scripted transport makes the tool call.
//
//   node scripts/smoke-approval.ts
//
// This is the one path only the transport can get wrong: the request is published by the session as a
// change, the frame that shows the banner is the stream's job, and the answer arrives on a completely
// different request.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../packages/server/src/http.ts";
import { HostedSession, SessionHub } from "../packages/server/src/hub.ts";
import { EventController } from "../packages/server/src/controllers/events.ts";
import { SessionController, SystemController } from "../packages/server/src/controllers/sessions.ts";
import { createRoutes } from "../packages/server/src/controllers/routes.ts";
import { Router } from "../packages/server/src/http/routing.ts";
import { createStreamRegistry } from "../packages/server/src/stream-registry.ts";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall } from "./fake-transport.ts";
import {
	openAgent,
	SessionManager,
	SettingsManager,
	type ModelSource,
	type UserModel,
	workspaceDir,
} from "@my-agent/core";

const PORT = 8086;
const root = await mkdtemp(join(tmpdir(), "my-agent-approval-"));
const trace = process.env.MY_AGENT_TRACE === "1";
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
	process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` ${detail}`}\n`);
	if (!ok) failures += 1;
}

const watchdog = setTimeout(() => {
	process.stdout.write("\nFAIL the approval round trip did not settle within 60 s\n");
	process.exit(1);
}, 60_000);

const hub = new SessionHub({ workspaceRoot: root });

// The scripted transport stands in for the model. One response per call: a tool call, then the text
// that ends the run. Both steps are assistant messages — `fakeToolCall` is a content block, not a
// response on its own.
const fake = createFakeTransport();
fake.setResponses([
	fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
	fakeAssistantMessage("done"),
]);

// The row the session runs on, and the same one the ref names. This is held here rather than taken
// from the hub: the hub reads the machine's own `models.json`, and a test must not depend on what the
// person running it happens to have configured.
const rows: UserModel[] = [
	{
		name: "anthropic",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "unused-by-the-scripted-transport",
		modelId: "claude-sonnet-4-5",
		contextWindow: 200_000,
		maxTokens: 8_192,
		reasoning: false,
	},
];
const models: ModelSource = { list: () => rows };
const modelRef = "anthropic/claude-sonnet-4-5";
process.stdout.write(`model ${modelRef} via the scripted transport\n`);

// The session is built here rather than by the hub so the scripted transport is in place first.
// Approvals on, and one tool the model will call.
const session = await openAgent({
	workspaceRoot: root,
	sessionManager: SessionManager.create(root),
	models,
	api: fake.api,
	model: modelRef,
	settingsManager: SettingsManager.inMemory({ approval: { read: true } }),
});

// Mount it the way `SessionHub.open()` does, so every path through the server sees this session.
const hosts = (hub as unknown as { hosts: Map<string, { id: string; session: typeof session; claims: number; reaping: boolean }> })
	.hosts;
hosts.set(session.id, { id: session.id, session, claims: 0, reaping: false });

const streams = createStreamRegistry(hub);
const router = new Router(
	createRoutes({
		system: new SystemController(hub),
		sessions: new SessionController(hub, {
			onRunFailure: (sessionId, message) => streams.announce(sessionId, message),
			onApproval: (toolCallId, approved) => streams.rememberApproval(toolCallId, approved),
		}),
		events: new EventController(streams, hub),
	}),
);

const handle = await createServer({ router, clientDir: "packages/web/dist" });
await new Promise<void>((listen) => handle.server.listen(PORT, "127.0.0.1", listen));

try {
	const events = await fetch(`http://127.0.0.1:${PORT}/api/sessions/${session.id}/events`, {
		headers: { accept: "text/event-stream" },
	});
	const reader = events.body?.getReader();
	if (!reader) throw new Error("no stream body");

	const decoder = new TextDecoder();
	let buffer = "";
	const approvals: { toolCallId: string; toolName: string; summary: string }[] = [];
	const settled: { toolCallId: string; approved: boolean }[] = [];
	const events_seen: string[] = [];
	let errors: string[] = [];
	let runEnded = false;

	/** Read frames until the stream ends or the predicate accepts one; `undefined` when it ends. */
	const pump = async (until?: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined> => {
		for (;;) {
			const boundary = buffer.indexOf("\n\n");
			if (boundary < 0) {
				const { value, done } = await reader.read();
				if (done) return undefined;
				buffer += decoder.decode(value, { stream: true });
				continue;
			}
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const line = block.split("\n").find((candidate) => candidate.startsWith("data:"));
			if (line === undefined) continue;

			const frame = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
			if (trace) process.stdout.write(`  frame ${String(frame.type)}\n`);
			if (frame.type === "tool_approval_request") approvals.push(frame.request as (typeof approvals)[number]);
			if (frame.type === "tool_approval_settled") settled.push(frame as unknown as (typeof settled)[number]);
			if (frame.type === "error") errors = [...errors, String(frame.message)];
			if (frame.type === "session_event") {
				const inner = (frame.event as { type?: string })?.type ?? "?";
				events_seen.push(inner);
				if (inner === "agent_end") runEnded = true;
			}
			if (until?.(frame) === true) return frame;
		}
	};

	await pump((frame) => frame.type === "session");
	check("the stream opened with a snapshot", true);

	const accepted = await fetch(`http://127.0.0.1:${PORT}/api/sessions/${session.id}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "read the notes" }),
	});
	check("the prompt was accepted", accepted.status === 202, `status ${accepted.status}`);

	// The run starts and stops at the approval gate: pump until something answers, and fail if the
	// stream ends first. Waiting on a frame that never comes is exactly the bug being looked for.
	const first = await pump((frame) => frame.type === "tool_approval_request" || frame.type === "error" || runEnded);
	if (first === undefined) check("the stream stayed open", false, "it ended before anything asked for approval");
	check("the approval request reached the stream", approvals.length === 1, `saw ${JSON.stringify(approvals)}`);
	check("no run error was reported", errors.length === 0, JSON.stringify(errors));
	if (approvals.length === 0) {
		process.stdout.write(`events: ${events_seen.join(",")}\n`);
		throw new Error("no approval request, so the rest of this test cannot run");
	}

	const request = approvals[0] as (typeof approvals)[number];
	check("the request names the tool that needs approval", request.toolName === "read", JSON.stringify(request));
	check("the request carries what the banner shows", request.summary.length > 0, JSON.stringify(request));

	const answered = await fetch(
		`http://127.0.0.1:${PORT}/api/sessions/${session.id}/approvals/${encodeURIComponent(request.toolCallId)}`,
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true }) },
	);
	check("the answer was accepted", answered.status === 200, `status ${answered.status}`);
	// The ids the browser sends back are opaque and may contain a colon, so this also pins that a path
	// parameter is percent-decoded before the controller sees it.
	const afterAnswer = ((await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${session.id}`)).json()) as {
		session: { pendingApprovals: unknown[] };
	}).session;
	check("the session no longer waits for that approval", afterAnswer.pendingApprovals.length === 0, JSON.stringify(afterAnswer.pendingApprovals));

	// The run continues, so the answer really did reach the waiting tool call.
	const ended = await pump(() => runEnded);
	check("the run finished after the answer", ended !== undefined && runEnded, JSON.stringify(events_seen.slice(-4)));
	check("the approval was settled as granted", settled.some((frame) => frame.approved === true), JSON.stringify(settled));

	const snapshot = ((await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${session.id}`)).json()) as {
		session: { messages: unknown[] };
	}).session;
	check("the tool ran and its result is in the transcript", JSON.stringify(snapshot.messages).includes("notes.txt"));
	check("the model's closing answer is in the transcript", JSON.stringify(snapshot.messages).includes("done"));

	await reader.cancel();
} finally {
	clearTimeout(watchdog);
	await streams.close();
	await hub.close();
	await handle.close();
	await rm(root, { recursive: true, force: true });
	await rm(workspaceDir(root), { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------------------------------
// An approval outlives the last claim, up to the hub's grace.
//
// The phase this covers: a claim answers "is anyone watching", which is not the question "will anyone
// answer". These rigs take their claims through the hub itself, so the reap under test is the real
// one — the earlier section mounts a session by hand and never lets the reap see a zero claim.
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\nan approval waits for its grace before it is called abandoned\n");

const phaseTwoWatchdog = setTimeout(() => {
	process.stdout.write("\nFAIL the parked-approval checks did not settle within 90 s\n");
	process.exit(1);
}, 90_000);

try {
	// Waited out, not denied: the window looked elsewhere and came back.
	const patient = await openRig(60_000, 8087);
	try {
		await driveToApproval(patient);
		const parked = patient.host;
		check("the run parked at the approval", parked.session.hasPendingApprovals);

		// The viewer switches away. The stream's claim outlives it by the reconnect grace, so the reap
		// only begins about two seconds from now — waiting past that is what makes the next assertions
		// land in what used to be the denial window.
		await patient.stream.cancel();
		patient.hub.release(patient.viewer);
		await sleep(3_500);

		check(
			"the approval is still pending well past the old denial window",
			parked.session.hasPendingApprovals,
			"it was denied",
		);
		check("the session was not reaped out from under it", patient.hub.live.includes(parked.id), patient.hub.live.join(","));
		check("and no denial reached the stream", patient.stream.settled.length === 0, JSON.stringify(patient.stream.settled));

		// The person came back: the same session, the same unanswered question, still theirs to answer.
		const again = await patient.hub.claim(parked.id);
		check("claiming it again hands back the same session", again === parked, "the old host was gone, so a new one was built");

		const returned = await attach(`${patient.url}/api/sessions/${parked.id}/events`);
		const opening = await returned.pump((frame) => frame.type === "session");
		const openingApprovals = (opening?.session as { pendingApprovals?: unknown[] } | undefined)?.pendingApprovals ?? [];
		check("the returning window is shown the approval it must answer", openingApprovals.length === 1, JSON.stringify(openingApprovals));

		const toolCallId = patient.stream.approvals[0]?.toolCallId ?? "";
		const answered = await fetch(
			`${patient.url}/api/sessions/${parked.id}/approvals/${encodeURIComponent(toolCallId)}`,
			{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true }) },
		);
		check("the answer was accepted", answered.status === 200, `status ${answered.status}`);

		await returned.pump((frame) => frame.type === "session_event" && returned.state.runEnded);
		check("the run finished after the answer", returned.state.runEnded);
		check(
			"and the approval was settled as granted",
			returned.settled.some((frame) => frame.approved === true),
			JSON.stringify(returned.settled),
		);

		await returned.cancel();
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
	const abandoned = await openRig(30, 8088);
	try {
		await driveToApproval(abandoned);
		const parked = abandoned.host;
		check("the run parked at the approval", parked.session.hasPendingApprovals);

		await abandoned.stream.cancel();
		abandoned.hub.release(abandoned.viewer);

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
	} finally {
		await abandoned.close();
	}

	// Somebody looked, then left again without answering. The reap that was waiting has to step aside
	// for them — and then be startable again, or the session would be stuck in the registry for good
	// with `reaping` still set and no release able to schedule another one.
	const lookedThenLeft = await openRig(3_000, 8089);
	try {
		await driveToApproval(lookedThenLeft);
		const parked = lookedThenLeft.host;
		check("the run parked at the approval", parked.session.hasPendingApprovals);

		await lookedThenLeft.stream.cancel();
		lookedThenLeft.hub.release(lookedThenLeft.viewer);

		// The stream's own claim outlives it by the reconnect grace, so the reap does not begin until
		// that is up. Waiting for it to begin is what makes the next step land inside the grace.
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
	} finally {
		await lookedThenLeft.close();
	}
} finally {
	clearTimeout(phaseTwoWatchdog);
}

process.stdout.write(failures === 0 ? "\napproval ok\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;

// ---------------------------------------------------------------------------------------------------
// The rig the parked-approval checks run on.
// ---------------------------------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `ready` holds, and report whether it did, so no check guesses at a reap's timing. */
async function until(ready: () => boolean, ms = 5_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (ready()) return true;
		await sleep(10);
	}
	return ready();
}

interface Stream {
	readonly approvals: { toolCallId: string; toolName: string; summary: string }[];
	readonly settled: { toolCallId: string; approved: boolean }[];
	readonly state: { runEnded: boolean };
	/** Read frames until the predicate accepts one; `undefined` when the stream ends first. */
	pump(until: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined>;
	cancel(): Promise<void>;
}

/** Attach to one session's event stream, recording the approval frames as they arrive. */
async function attach(url: string): Promise<Stream> {
	const response = await fetch(url, { headers: { accept: "text/event-stream" } });
	const reader = response.body?.getReader();
	if (!reader) throw new Error("no stream body");

	const decoder = new TextDecoder();
	let buffer = "";
	const approvals: Stream["approvals"] = [];
	const settled: Stream["settled"] = [];
	const state = { runEnded: false };

	const pump = async (accept: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined> => {
		for (;;) {
			const boundary = buffer.indexOf("\n\n");
			if (boundary < 0) {
				const { value, done } = await reader.read();
				if (done) return undefined;
				buffer += decoder.decode(value, { stream: true });
				continue;
			}
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const line = block.split("\n").find((candidate) => candidate.startsWith("data:"));
			if (line === undefined) continue;

			const frame = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
			if (frame.type === "tool_approval_request") approvals.push(frame.request as Stream["approvals"][number]);
			if (frame.type === "tool_approval_settled") settled.push(frame as unknown as Stream["settled"][number]);
			if (frame.type === "session_event" && (frame.event as { type?: string })?.type === "agent_end") state.runEnded = true;
			if (accept(frame)) return frame;
		}
	};

	return { approvals, settled, state, pump, cancel: () => reader.cancel() };
}

interface Rig {
	root: string;
	hub: SessionHub;
	session: Awaited<ReturnType<typeof openAgent>>;
	/** The mounted host, as the hub holds it: the object the reap decides about. */
	host: HostedSession;
	url: string;
	/** Set by {@link driveToApproval}: the viewer's own claim, and the stream showing it the run. */
	viewer: HostedSession;
	stream: Stream;
	close(): Promise<void>;
}

/**
 * One isolated server: a hub whose approval grace is the number under test, a session running on a
 * scripted transport of its own, and the real routes in front of it.
 *
 * Only the transport is a stand-in. The session is mounted the way `SessionHub.open()` mounts one, so
 * that every claim below — the viewer's, the stream's, and the request's — is a real claim through the
 * hub and the reap they drive is the real reap.
 */
async function openRig(approvalGraceMs: number, port: number): Promise<Rig> {
	const root = await mkdtemp(join(tmpdir(), "my-agent-approval-grace-"));
	const hub = new SessionHub({ cwd: root, approvalGraceMs });

	const transport = createFakeTransport();
	transport.setResponses([
		fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
		fakeAssistantMessage("done"),
	]);
	const session = await openAgent({
		workspaceRoot: root,
		sessionManager: SessionManager.create(root),
		models,
		api: transport.api,
		model: modelRef,
		settingsManager: SettingsManager.inMemory({ approval: { read: true } }),
	});

	const host = new HostedSession(session, root);
	(hub as unknown as { hosts: Map<string, HostedSession> }).hosts.set(session.id, host);

	const streams = createStreamRegistry(hub);
	const router = new Router(
		createRoutes({
			system: new SystemController(hub),
			sessions: new SessionController(hub, {
				onRunFailure: (sessionId, message) => streams.announce(sessionId, message),
				onApproval: (toolCallId, approved) => streams.rememberApproval(toolCallId, approved),
			}),
			events: new EventController(streams, hub),
		}),
	);
	const handle = await createServer({ router, clientDir: "packages/web/dist" });
	await new Promise<void>((listen) => handle.server.listen(port, "127.0.0.1", listen));

	// A plain carrier for the two things `driveToApproval` fills in, so a check can read them without
	// the rig having to be fully built at construction time.
	const rig: Rig = {
		root,
		hub,
		session,
		host,
		url: `http://127.0.0.1:${port}`,
		viewer: host,
		stream: undefined as unknown as Stream,
		close: async () => {
			await streams.close();
			await hub.close();
			await handle.close();
			await rm(root, { recursive: true, force: true });
			await rm(workspaceDir(root), { recursive: true, force: true }).catch(() => {});
		},
	};
	return rig;
}

/**
 * Attach a viewer, start a run, and bring it to the approval gate — the state every parked-approval
 * check begins from. Leaves `rig.stream`, `rig.viewer`, and `rig.host` ready for the check to use.
 */
async function driveToApproval(rig: Rig): Promise<void> {
	rig.viewer = await rig.hub.claim(rig.session.id);
	rig.stream = await attach(`${rig.url}/api/sessions/${rig.session.id}/events`);
	await rig.stream.pump((frame) => frame.type === "session");

	const accepted = await fetch(`${rig.url}/api/sessions/${rig.session.id}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "read the notes" }),
	});
	if (accepted.status !== 202) throw new Error(`the prompt was not accepted: ${accepted.status}`);

	const request = await rig.stream.pump((frame) => frame.type === "tool_approval_request");
	if (request === undefined) throw new Error("the run never asked for approval");
	if (rig.stream.approvals.length !== 1) throw new Error(`saw ${rig.stream.approvals.length} approval requests`);
}

