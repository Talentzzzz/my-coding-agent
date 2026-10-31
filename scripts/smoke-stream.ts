// Stream lifecycle smoke test, in the shape the resident transport gave it: the claim decides how
// long a session lives, and a subscription decides nothing. A lane watching an idle session takes no
// claim and ends nothing; a run ending does not end the lane — the host going away does, and the host
// goes away when the last claim lets go. The failure section pins where a run that fails under a
// watcher — and one that fails with nobody watching — is heard.
//
//   node scripts/smoke-stream.ts
//
// No provider key is needed: the model is the scripted transport. The test bench holds its own claims
// through the real hub wherever a check needs the host to outlive a run — that is the bench's claim,
// not the subscription's, which is exactly the distinction under test.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxUpgrade, sessionListeners } from "../packages/server/src/boot.ts";
import { createMuxServer } from "../packages/server/src/mux.ts";
import { SessionHub, type HostedSession } from "../packages/server/src/hub.ts";
import { createSessionProjection } from "../packages/server/src/projection.ts";
import { SessionController, SystemController } from "../packages/server/src/controllers/sessions.ts";
import { createRoutes } from "../packages/server/src/controllers/routes.ts";
import { Router } from "../packages/server/src/http/routing.ts";
import { createServer } from "../packages/server/src/http.ts";
import { createFakeTransport, fakeAssistantMessage, type FakeTransport } from "./fake-transport.ts";
import { connect, until, type WireClient } from "./wire/client.ts";
import type { ModelConfig } from "@my-agent/core";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

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

/** Wait for the loop's own end event on a lane. */
async function waitAgentEnd(wire: WireClient, sessionId: string, ms = 15_000): Promise<boolean> {
	return until(
		() =>
			wire.items(sessionId).some(
				(message) => message.type === "event" && (message as { event?: { type?: string } }).event?.type === "agent_end",
			),
		ms,
	);
}

/** Wait for the status frame that says the run is over, whatever road it took to get there. */
async function waitSettled(wire: WireClient, sessionId: string, ms = 15_000): Promise<boolean> {
	return until(
		() => wire.items(sessionId).some((message) => message.type === "status" && (message as { submitting?: boolean }).submitting === false),
		ms,
	);
}

/** Long enough that anything that was going to end an idle lane would have; short enough to stay fast. */
const QUIET_MS = 700;

/** Slow enough that a run is observably in flight; fast enough to keep the whole smoke sub-minute. */
const TOKENS_PER_SECOND = 400;

const rows: ModelConfig[] = [
	{
		name: "scripted",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "unused-by-the-scripted-transport",
		id: "claude-sonnet-4-5",
		contextWindow: 200_000,
		maxTokens: 8_192,
	},
];

interface Rig {
	url: string;
	hub: SessionHub;
	transport: FakeTransport;
	close(): Promise<void>;
}

async function openRig(): Promise<Rig> {
	const root = await mkdtemp(join(tmpdir(), "my-agent-stream-"));
	const transport = createFakeTransport({ tokensPerSecond: TOKENS_PER_SECOND });
	const hub = new SessionHub({ absCwd: root, api: transport.api });
	hub.setModelConfigs(rows);

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
		hub,
		transport,
		close: async () => {
			await hub.close();
			await handle.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

/**
 * Make every assistant message persist fail, on this host only.
 *
 * This is the seam ticket 08 named for the mechanical-failure shape: the transcript is the thing that
 * broke, so nothing about the failure can be written where failures usually go. The user message
 * still lands — `prompt` writes it before the loop starts — so the patch lets it through.
 */
function sabotagePersistence(host: HostedSession): void {
	const manager = host.session.sessionManager as unknown as {
		appendMessage: (message: { role?: string }) => string;
	};
	const original = manager.appendMessage.bind(manager);
	manager.appendMessage = (message) => {
		if (message.role !== "user") throw new Error("smoke-stream: 磁盘写不进去了");
		return original(message);
	};
}

const rig = await openRig();
const wire = await connect(`${rig.url.replace("http", "ws")}/mux`);

// The claim counter is the load-bearing instrument of this smoke (docs/notes.md §二 bug 4: to verify
// "x takes no claim", count `hub.claim` calls — never read `hub.live`, which a released claim vanishes
// from within a tick).
let claims = 0;
{
	const realClaim = rig.hub.claim.bind(rig.hub);
	(rig.hub as unknown as { claim: (id?: string) => Promise<HostedSession> }).claim = async (id?: string) => {
		claims += 1;
		return realClaim(id);
	};
}

try {
	// ---------------------------------------------------------------------------------------------
	// 1. A lane on an idle session: no claim, no host, no end.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a lane on an idle session claims nothing and ends nothing\n");

	const created = await request(rig.url, "POST", "/api/sessions");
	const idleId = (created.payload as { sessionId: string }).sessionId;
	const idle = await wire.open(idleId);
	check("the lane opened with the snapshot", idle.id === idleId);
	check("and an idle session says so", idle.submitting === false, String(idle.submitting));
	check("subscribing took no claim", claims === 0, `claims=${claims}`);

	await sleep(QUIET_MS);
	check("the lane is still there — nothing ended it", !wire.endOf(idleId).ended, JSON.stringify(wire.endOf(idleId)));
	check("and nothing is hosting the session", !rig.hub.live.includes(idleId), rig.hub.live.join(","));

	// A read is not a claim either — the window's cold path. A session that does not exist is a 404,
	// and its read claims nothing because it never gets that far.
	const cold = await request(rig.url, "GET", `/api/sessions/${encodeURIComponent(idleId)}`);
	check("a cold read answers", cold.status === 200, String(cold.status));
	const missing = await request(rig.url, "GET", "/api/sessions/does-not-exist");
	check("an unknown session is a 404", missing.status === 404, String(missing.status));
	check("and neither read claimed anything", claims === 0, `claims=${claims}`);

	// ---------------------------------------------------------------------------------------------
	// 2. A run ending does not end the lane; the claim's release does.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a run ends, the lane stays, the claim decides the rest\n");

	// The bench holds a claim for as long as it wants the host alive — the same hand a window's send
	// reference plays, taken through the hub so the reap under test is the real one.
	const bench = await rig.hub.claim(idleId);
	rig.transport.setResponses([fakeAssistantMessage("a".repeat(500))]);
	check("the prompt was accepted", (await prompt(rig.url, idleId, "say something long")) === 202);
	check("the run's own end reached the lane", await waitAgentEnd(wire, idleId));
	check("and the status frame said so too", await waitSettled(wire, idleId));

	await sleep(QUIET_MS);
	check("no end arrived after the run — nothing about the run ends a lane", !wire.endOf(idleId).ended, JSON.stringify(wire.endOf(idleId)));
	check("the host is still there, held by the bench's claim", rig.hub.live.includes(idleId), rig.hub.live.join(","));

	// The lane is still usable: the same subscription carries the next run.
	rig.transport.setResponses([fakeAssistantMessage("b".repeat(500))]);
	check("the second prompt was accepted", (await prompt(rig.url, idleId, "and again")) === 202);
	check("and its frames reached the same lane", await waitAgentEnd(wire, idleId));

	// Now the claim goes back, and the order of events is the whole point: the host goes away, and the
	// lane ends because the session it watched is gone — not because anything ended it directly.
	rig.hub.release(bench);
	check("the session was reaped once the last claim let go", await until(() => !rig.hub.live.includes(idleId), 10_000), rig.hub.live.join(","));
	check("and the lane ended with the host it watched", await until(() => wire.endOf(idleId).ended, 5_000), JSON.stringify(wire.endOf(idleId)));

	// ---------------------------------------------------------------------------------------------
	// 3. Attaching to a run already in flight: the baseline says so, and the lane lives through it.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a lane that opens on a run already in flight\n");

	const again = await rig.hub.claim(idleId);
	rig.transport.setResponses([fakeAssistantMessage("c".repeat(600))]);
	check("the prompt was accepted", (await prompt(rig.url, idleId, "one more long answer")) === 202);
	check("the run started", await until(() => rig.hub.live.includes(idleId), 5_000), rig.hub.live.join(","));

	const midflight = await wire.open(idleId);
	check("the mid-run baseline reports the run", midflight.submitting === true, String(midflight.submitting));
	// `ended` on the wire client is "ever ended" and idleId's lane ended once in the section above,
	// so the assertions here count ends across this open instead of reading the flag.
	const endsAtOpen = wire.endOf(idleId).ends;
	await sleep(QUIET_MS);
	check("and nothing ends the lane while the run goes on", wire.endOf(idleId).ends === endsAtOpen, JSON.stringify(wire.endOf(idleId)));
	check("the run ended on the lane", await waitAgentEnd(wire, idleId));
	check("and the lane outlived it, claim still held", wire.endOf(idleId).ends === endsAtOpen, JSON.stringify(wire.endOf(idleId)));
	rig.hub.release(again);
	check("released, the host went, the lane went with it", await until(() => wire.endOf(idleId).ends === endsAtOpen + 1, 5_000), JSON.stringify(wire.endOf(idleId)));

	// ---------------------------------------------------------------------------------------------
	// 4. A run that fails under a watcher: the error frame, the settled frame, the log, the reap.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a run that fails under a watcher is heard in three places\n");

	const watched = await request(rig.url, "POST", "/api/sessions");
	const watchedId = (watched.payload as { sessionId: string }).sessionId;
	const watchedBench = await rig.hub.claim(watchedId);
	sabotagePersistence(watchedBench);
	const watchedLane = await wire.open(watchedId);
	check("the lane opened on the session about to fail", watchedLane.id === watchedId);

	const logged: string[] = [];
	const realError = console.error;
	console.error = (...parts: unknown[]) => {
		logged.push(parts.map(String).join(" "));
	};

	rig.transport.setResponses([fakeAssistantMessage("never lands")]);
	check("the prompt was accepted", (await prompt(rig.url, watchedId, "this run will fail")) === 202);
	check("the failure was announced on the lane", await until(() => wire.items(watchedId).some((message) => message.type === "error"), 10_000), JSON.stringify(wire.items(watchedId).map((message) => message.type)));
	check("the lane was told the run was over", await waitSettled(wire, watchedId));
	console.error = realError;

	check("and the server logged what no frame could carry", logged.length > 0, JSON.stringify(logged));
	check("the transcript is exactly what the failure let survive", ((await request(rig.url, "GET", `/api/sessions/${encodeURIComponent(watchedId)}`)).payload as { session: { messages: unknown[] } }).session.messages.length === 1);

	// The bench claim still holds the host; letting it go reaps the session. No leak.
	rig.hub.release(watchedBench);
	check("the session was reaped once the claim let go", await until(() => !rig.hub.live.includes(watchedId), 10_000), rig.hub.live.join(","));

	// ---------------------------------------------------------------------------------------------
	// 5. The same failure with nobody watching: the log is the only place it is still audible.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a run that fails with nobody watching is heard only in the log\n");

	const unwatched = await request(rig.url, "POST", "/api/sessions");
	const unwatchedId = (unwatched.payload as { sessionId: string }).sessionId;
	const unwatchedBench = await rig.hub.claim(unwatchedId);
	sabotagePersistence(unwatchedBench);

	const loggedAlone: string[] = [];
	console.error = (...parts: unknown[]) => {
		loggedAlone.push(parts.map(String).join(" "));
	};
	rig.transport.setResponses([fakeAssistantMessage("also never lands")]);
	check("the prompt was accepted", (await prompt(rig.url, unwatchedId, "this run fails alone")) === 202);
	// Acceptance edge 3's server-side half: no lane is open on this session anywhere, so what keeps it
	// alive is the run and nothing else. The bench claim goes back first, on purpose — held, it would
	// be the thing answering this question instead of the run, which is exactly the assertion the
	// hand-off for this section exists to make. The reap that follows has nothing to settle through
	// but the run itself, so the session is still here.
	rig.hub.release(unwatchedBench);
	check(
		"a run nobody watches still holds its own session open",
		rig.hub.live.includes(unwatchedId),
		rig.hub.live.join(","),
	);
	// The run's end is observable without any lane: the read path answers `submitting: false` once
	// the loop has finished. Only then is the log capture closed — restoring it earlier would race
	// the failure out of the window it is meant to watch. (A hand-rolled poll, because `until` takes
	// a synchronous predicate and an async one would be read as always-true.)
	const settleDeadline = Date.now() + 10_000;
	for (;;) {
		const read = await request(rig.url, "GET", `/api/sessions/${encodeURIComponent(unwatchedId)}`);
		if (((read.payload as { session?: { submitting?: boolean } }).session?.submitting ?? true) === false) break;
		if (Date.now() > settleDeadline) break;
		await sleep(50);
	}
	console.error = realError;

	check("no lane existed to announce on, and the log line went out anyway", loggedAlone.length > 0, JSON.stringify(loggedAlone));
	check("and nothing leaked: the session was reaped", await until(() => !rig.hub.live.includes(unwatchedId), 10_000), rig.hub.live.join(","));

	// ---------------------------------------------------------------------------------------------
	// 6. The streamed answer crosses the wire as deltas, and a lane opened mid-run is handed the rest.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a streamed answer crosses the wire as deltas\n");

	/** The text of an assistant message, as the wire sends it on a start/end/baseline. */
	const textOf = (message: unknown): string => {
		const content = (message as { content?: unknown } | undefined)?.content;
		if (!Array.isArray(content)) return "";
		return content
			.map((block) =>
				typeof block === "object" && block !== null && (block as { type?: string }).type === "text"
					? String((block as { text?: unknown }).text ?? "")
					: "",
			)
			.join("");
	};
	const updatesOf = (client: WireClient, sessionId: string) =>
		client
			.items(sessionId)
			.map((message) => (message.type === "event" ? message.event : undefined))
			.filter((event): event is { type: "message_update"; delta: { kind: string; text: string } } => event?.type === "message_update");

	const deltaAnswer = "x".repeat(2_400);
	const deltaSession = await request(rig.url, "POST", "/api/sessions");
	const deltaId = (deltaSession.payload as { sessionId: string }).sessionId;
	const deltaBench = await rig.hub.claim(deltaId);
	const deltaLane = await wire.open(deltaId);
	check("the lane opened on the new session", deltaLane.id === deltaId);

	rig.transport.setResponses([fakeAssistantMessage(deltaAnswer)]);
	check("the prompt was accepted", (await prompt(rig.url, deltaId, "say something very long")) === 202);
	check("the run started producing", await until(() => updatesOf(wire, deltaId).length > 0, 5_000));

	// A second lane, opened while the answer is still arriving. Its baseline is the only frame that
	// can carry what this window missed — the deltas after it are the rest of the answer.
	const late = await connect(`${rig.url.replace("http", "ws")}/mux`);
	const lateBaseline = await late.open(deltaId);
	const partialText = textOf(lateBaseline.partial);
	check("the mid-run baseline carries the in-flight message", lateBaseline.partial !== undefined);
	check(
		"…and it is the characters that already arrived",
		partialText.length > 0 && deltaAnswer.startsWith(partialText),
		`${partialText.length} chars`,
	);

	check("the run ended", await waitAgentEnd(wire, deltaId));

	const updates = updatesOf(wire, deltaId);
	check("every update is a delta, with no second copy of the message", updates.every((event) => !("message" in event) && !("assistantMessageEvent" in event)), JSON.stringify(Object.keys(updates[0] ?? {})));
	check("the deltas concatenate to the answer", updates.map((event) => event.delta.text).join("") === deltaAnswer, `${updates.map((event) => event.delta.text).join("").length}/${deltaAnswer.length}`);
	const sizes = wire.frames
		.filter((frame) => frame.streamId === deltaId && "item" in frame && frame.item.type === "event" && frame.item.event.type === "message_update")
		.map((frame) => JSON.stringify(frame).length);
	// The envelope plus one provider chunk, whatever the answer has grown to. The whole message does
	// still cross the wire once — on `message_end`, where it is the thing being recorded.
	check("no update frame is a copy of the answer", Math.max(...sizes) < 300, `largest ${Math.max(...sizes)} bytes of ${deltaAnswer.length}`);
	const endSizes = wire.frames
		.filter((frame) => frame.streamId === deltaId && "item" in frame && frame.item.type === "event" && frame.item.event.type === "message_end")
		.map((frame) => JSON.stringify(frame).length);
	check("the answer itself travels once, whole, at the end", endSizes.some((size) => size > deltaAnswer.length), `${endSizes.join("/")} bytes`);

	const lateText = partialText + updatesOf(late, deltaId).map((event) => event.delta.text).join("");
	check("baseline plus the rest is the whole answer", lateText === deltaAnswer, `${lateText.length}/${deltaAnswer.length}`);

	await late.close();
	rig.hub.release(deltaBench);
	check("the delta session was reaped", await until(() => !rig.hub.live.includes(deltaId), 10_000), rig.hub.live.join(","));

	// ---------------------------------------------------------------------------------------------
	// 7. Shutdown waits for nothing.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("shutdown waits for nothing\n");

	rig.transport.setResponses([fakeAssistantMessage("d".repeat(600))]);
	check("the prompt was accepted", (await prompt(rig.url, idleId, "a run for shutdown to stop")) === 202);
	check("the run started", await until(() => rig.hub.live.includes(idleId), 5_000), rig.hub.live.join(","));

	const started = Date.now();
	await rig.close();
	check("closing with a run in flight and a lane attached returns", Date.now() - started < 5_000, `${Date.now() - started} ms`);
	check("and no session is left running", rig.hub.live.length === 0, rig.hub.live.join(","));
} catch (error) {
	failures += 1;
	process.stdout.write(`\nFAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	try {
		await rig.close();
	} catch {
		// The rig may already be closed by the shutdown check above.
	}
} finally {
	process.stdout.write(failures === 0 ? "\nstream ok\n" : `\n${failures} failure(s)\n`);
	process.exitCode = failures === 0 ? 0 : 1;
}
