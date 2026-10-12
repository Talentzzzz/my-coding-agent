// Run-scoped stream smoke test: a stream exists for a run, ends when the run ends, and ends itself
// when it attached to nothing running. No provider key is needed — the model is the scripted transport.
//
//   node scripts/smoke-stream.ts
//
// This is the transport half of the phase. What it is really checking is that the browser is *told* to
// close: `EventSource` reconnects after a normal end, so a stream the server ends without a
// `stream_end` frame comes back, and an idle session would be pinned in `hub.live` by a heartbeat that
// no assertion about state can see. Every check below is therefore about a frame or about a claim.
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
import { createFakeTransport, fakeAssistantMessage, type FakeTransport } from "./fake-transport.ts";
import type { SessionSnapshot, UserModel } from "@my-agent/core";

/** Short enough that both waits below are driven rather than slept through. */
const IDLE_GRACE_MS = 150;
/** The release grace is not configurable, so waits that cross it are given room rather than changed. */
const PAST_RELEASE_GRACE_MS = 6_000;

const root = await mkdtemp(join(tmpdir(), "my-agent-stream-"));
let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `ready` holds, so nothing here guesses at a reap's or a timer's exact timing. */
async function until(ready: () => boolean, ms = 5_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (ready()) return true;
		await sleep(10);
	}
	return ready();
}

type Frame = { type: string; [key: string]: unknown };

interface Feed {
	readonly frames: Frame[];
	/** Whether the server ended this response, as opposed to the reader being cancelled. */
	readonly ended: boolean;
	waitFor(type: string, ms?: number): Promise<Frame | undefined>;
	/** Wait for one of the loop's own events, which arrive inside a `session_event` frame. */
	waitForEvent(type: string, ms?: number): Promise<Frame | undefined>;
	/** Wait for the response to end, which is the other half of the terminal frame's promise. */
	waitForEnd(ms?: number): Promise<boolean>;
	cancel(): Promise<void>;
}

/**
 * Read one event stream in the background.
 *
 * A cancelled reader raises, so `ended` tells the two ends apart: a response the server finished is
 * the case this phase is about, and a reader this script cancelled is this script's own doing.
 */
function feed(response: Response): Feed {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const frames: Frame[] = [];
	let buffer = "";
	let ended = false;

	void (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) {
					ended = true;
					return;
				}
				buffer += decoder.decode(value, { stream: true });
				let boundary = buffer.indexOf("\n\n");
				while (boundary >= 0) {
					const block = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const line = block.split("\n").find((candidate) => candidate.startsWith("data:"));
					if (line !== undefined) frames.push(JSON.parse(line.slice(5).trim()) as Frame);
					boundary = buffer.indexOf("\n\n");
				}
			}
		} catch {
			// A cancelled reader lands here, which is not the server ending the response.
		}
	})();

	return {
		frames,
		get ended() {
			return ended;
		},
		async waitFor(type: string, ms = 5_000): Promise<Frame | undefined> {
			const found = await until(() => frames.some((frame) => frame.type === type), ms);
			return found ? frames.find((frame) => frame.type === type) : undefined;
		},
		async waitForEvent(type: string, ms = 5_000): Promise<Frame | undefined> {
			const found = await until(() => frames.some((frame) => sessionEvent(frame) === type), ms);
			return found ? frames.find((frame) => sessionEvent(frame) === type) : undefined;
		},
		async waitForEnd(ms = 5_000): Promise<boolean> {
			return until(() => ended, ms);
		},
		cancel: () => reader.cancel().then(() => undefined),
	};
}

/** The row the scripted transport answers for, held here so this never reads the machine's own rows. */
const rows: UserModel[] = [
	{
		name: "scripted",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "unused-by-the-scripted-transport",
		modelId: "claude-sonnet-4-5",
		contextWindow: 200_000,
		maxTokens: 8_192,
		reasoning: false,
	},
];
const modelRef = "scripted/claude-sonnet-4-5";

interface Rig {
	url: string;
	hub: SessionHub;
	/** One session, mounted on its own scripted transport, created through the real routes. */
	session: HostedSession;
	transport: FakeTransport;
	close(): Promise<void>;
}

const rig = await openRig(8090);

try {
	process.stdout.write(`stream scoped to the run (idle grace ${IDLE_GRACE_MS} ms)\n`);

	check("the session this script drives is idle to begin with", await until(() => !rig.hub.live.includes(rig.session.id), PAST_RELEASE_GRACE_MS), rig.hub.live.join(","));

	// ---------------------------------------------------------------------------------------------
	// An idle stream ends itself, and says so.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a stream on an idle session ends itself\n");

	const idle = await attach(rig.url, rig.session.id);
	check("it opens with the snapshot", (await idle.waitFor("session")) !== undefined);

	const terminal = await idle.waitFor("stream_end", IDLE_GRACE_MS + 4_000);
	check("the stream reported its end", terminal !== undefined, JSON.stringify(idle.frames.map((frame) => frame.type)));
	check("the response then ended", await idle.waitForEnd());
	check(
		"and nothing claims a run ended, because none started",
		!idle.frames.some((frame) => sessionEvent(frame) === "agent_end"),
		JSON.stringify(idle.frames.map((frame) => frame.type)),
	);
	check(
		"the session is reaped once the stream is gone",
		await until(() => !rig.hub.live.includes(rig.session.id), PAST_RELEASE_GRACE_MS),
		rig.hub.live.join(","),
	);

	// ---------------------------------------------------------------------------------------------
	// A read is not a stream: the window's path for an idle session takes no claim and opens nothing.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("reading an idle session takes no claim and opens no stream\n");

	let claims = 0;
	const claim = rig.hub.claim.bind(rig.hub);
	rig.hub.claim = async (id?: string) => {
		claims += 1;
		return claim(id);
	};

	const cold = await read(rig.url, rig.session.id);
	check("GET /api/sessions/{id} answers 200", cold.status === 200, `status=${cold.status}`);
	check("and reports the session as idle", cold.session?.submitting === false, String(cold.session?.submitting));
	check("the read never claimed it", claims === 0, `claims=${claims}`);
	check("so nothing is running it", !rig.hub.live.includes(rig.session.id), rig.hub.live.join(","));
	check("and nothing is streaming it", rig.hub.live.length === 0, rig.hub.live.join(","));
	check("an unknown id is still 404", (await read(rig.url, "0123456789abcdef")).status === 404);
	check("and an unknown id is never claimed either", claims === 0, `claims=${claims}`);
	const refusedStream = await tryAttach(rig.url, "0123456789abcdef");
	check(
		"an unknown id opens no stream",
		refusedStream.status === 404,
		`status=${refusedStream.status} body=${refusedStream.body}`,
	);

	// ---------------------------------------------------------------------------------------------
	// A run ended ends the stream, immediately after the run's own last frame.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a run ended ends the stream\n");

	rig.transport.setResponses([fakeAssistantMessage("transport ok")]);
	const running = await attach(rig.url, rig.session.id);
	check("the stream opened on the idle session", (await running.waitFor("session")) !== undefined);
	check("the prompt was accepted", (await prompt(rig.url, rig.session.id, "say it")) === 202);

	check("the run's own end reached the stream", (await running.waitForEvent("agent_end", 10_000)) !== undefined);
	const frameTypes = running.frames.map((frame) =>
		frame.type === "session_event" ? `event:${String(sessionEvent(frame))}` : frame.type,
	);
	check(
		"the terminal frame came after it",
		frameTypes.indexOf("stream_end") > frameTypes.indexOf("event:agent_end"),
		frameTypes.join(","),
	);
	check("and the response ended right after it", await running.waitForEnd());
	check(
		"the session is reaped once the run is over",
		await until(() => !rig.hub.live.includes(rig.session.id), PAST_RELEASE_GRACE_MS),
		rig.hub.live.join(","),
	);

	// ---------------------------------------------------------------------------------------------
	// A stream attached *to* a run is ended by that run, not by its own grace.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a stream that attaches to a run already in flight\n");

	// Long enough that the run is certainly still going when the second stream arrives.
	rig.transport.setResponses([fakeAssistantMessage("a".repeat(4_000))]);
	const first = await attach(rig.url, rig.session.id);
	await first.waitFor("session");
	check("the prompt was accepted", (await prompt(rig.url, rig.session.id, "long answer")) === 202);
	check("the run started", (await first.waitForEvent("agent_start", 10_000)) !== undefined);

	const second = await attach(rig.url, rig.session.id);
	const opening = await second.waitFor("session");
	check(
		"attaching mid-run reports the run",
		((opening?.session as { submitting?: boolean } | undefined)?.submitting ?? false) === true,
		JSON.stringify(opening?.session),
	);

	// The idle grace is 150 ms; a stream that arrived on a session reporting `submitting: true` must
	// still be here well after it, because what ends it is the run, not the grace.
	await sleep(IDLE_GRACE_MS * 6);
	check("and the idle grace does not end it", !second.ended);

	check("the run's end ended the stream that started it", await first.waitForEnd(15_000));
	check("and the one that attached to it", await second.waitForEnd(15_000));
	check(
		"both announced the end",
		first.frames.some((frame) => frame.type === "stream_end") &&
			second.frames.some((frame) => frame.type === "stream_end"),
	);

	// ---------------------------------------------------------------------------------------------
	// A read while a run is in flight is still not a claim.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("reading a running session is not a claim either\n");

	rig.transport.setResponses([fakeAssistantMessage("b".repeat(4_000))]);
	const live = await attach(rig.url, rig.session.id);
	await live.waitFor("session");
	check("the prompt was accepted", (await prompt(rig.url, rig.session.id, "another long answer")) === 202);
	check("the run started", (await live.waitForEvent("agent_start", 10_000)) !== undefined);

	const beforeRead = claims;
	const during = await read(rig.url, rig.session.id);
	check("a read during a run answers", during.status === 200, `status=${during.status}`);
	check("and reports the run", during.session?.submitting === true, String(during.session?.submitting));
	check("the read took no claim of its own", claims === beforeRead, `claims=${claims - beforeRead}`);

	// ---------------------------------------------------------------------------------------------
	// Shutdown waits for nothing.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("shutdown waits for nothing\n");
	const started = Date.now();
	await rig.close();
	check("closing the server with a run in flight returns", Date.now() - started < 15_000, `${Date.now() - started} ms`);
	check("and no session is left running", rig.hub.live.length === 0, rig.hub.live.join(","));
	await rm(root, { recursive: true, force: true });
} catch (error) {
	failures += 1;
	process.stdout.write(`\nFAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	try {
		await rig.close();
	} catch {
		// The rig may already be closed by the shutdown check above.
	}
	await rm(root, { recursive: true, force: true }).catch(() => {});
} finally {
	process.stdout.write(failures === 0 ? "\nstream ok\n" : `\n${failures} failure(s)\n`);
	process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------------------------------
// The rig.
// ---------------------------------------------------------------------------------------------------

/** Attach to one session's stream over the real route. */
async function attach(base: string, sessionId: string): Promise<Feed> {
	const response = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/events`, {
		headers: { accept: "text/event-stream" },
	});
	if (response.status !== 200 || !response.body) throw new Error(`the stream answered ${response.status}`);
	return feed(response);
}

/** Whether one session's stream opens at all, and the status when it does not. */
async function tryAttach(base: string, sessionId: string): Promise<{ status: number; body: string }> {
	const response = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/events`, {
		headers: { accept: "text/event-stream" },
	});
	const body = await response.text();
	return { status: response.status, body };
}

/** Accept a prompt, which is answered before the run has done anything. */
async function prompt(base: string, sessionId: string, text: string): Promise<number> {
	const response = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	});
	return response.status;
}

/** One read of a snapshot: the window's path for a session, and the cold path under it. */
async function read(base: string, sessionId: string): Promise<{ status: number; session?: SessionSnapshot }> {
	const response = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}`, {
		headers: { accept: "application/json" },
	});
	if (!response.ok) return { status: response.status };
	const body = (await response.json()) as { session: SessionSnapshot };
	return { status: response.status, session: body.session };
}

/** The inner event of a `session_event` frame, or undefined for any other frame. */
function sessionEvent(frame: Frame): string | undefined {
	if (frame.type !== "session_event") return undefined;
	return (frame.event as { type?: string } | undefined)?.type;
}

/**
 * One isolated server: the real hub, the real routes, and a session on a scripted transport.
 *
 * Only the model is a stand-in. The session is created through `POST /api/sessions` and opened through
 * `hub.claim`, so every claim below — the stream's, the read's, the request's — is a real claim through
 * the real hub, and the registry's idle grace is the one under test rather than a guess about
 * production's fifteen seconds.
 */
async function openRig(port: number): Promise<Rig> {
	const hub = new SessionHub({ cwd: root });
	hub.setUserModels(rows);

	const streams = createStreamRegistry(hub, { idleGraceMs: IDLE_GRACE_MS });
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
	const url = `http://127.0.0.1:${port}`;

	// The one thing a smoke has to add to the real hub: the transport. Sessions are built inside
	// `SessionHub.open`, so there is no option to hand a double to, and this seam is what keeps the
	// paths under test — creation, claiming, streaming, reading — the production ones. Only the model
	// is scripted; a session that is reopened later gets the same double.
	// Kept slow enough that a run is observably in flight: every check below that reads a session *during*
	// a run is racing a scripted answer otherwise, and a race is not what is being tested here.
	const transport = createFakeTransport({ tokensPerSecond: 300 });
	const open = (hub as unknown as { open(id: string): Promise<HostedSession> }).open.bind(hub);
	(hub as unknown as { open(id: string): Promise<HostedSession> }).open = async (id: string) => {
		const host = await open(id);
		(host.session as unknown as { api: unknown }).api = transport.api;
		return host;
	};

	const created = await fetch(`${url}/api/sessions`, { method: "POST" });
	const { sessionId } = (await created.json()) as { sessionId: string };
	// Claimed and released, so the checks below start from the state the window is normally in: a
	// session that exists on disk and is running nothing. Reading it is then the cold path.
	const session = await hub.claim(sessionId);
	hub.release(session);

	return {
		url,
		hub,
		session,
		transport,
		close: async () => {
			await streams.close();
			await hub.close();
			await handle.close();
		},
	};
}
