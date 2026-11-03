// Wire-surface smoke test: the one home for assertions about the mux protocol itself — the envelope,
// the lane a frame rides, connection-level payloads, uplink tolerance, and the two acceptance edges a
// multiplexed connection exists for. REST commands are smoke-api.ts's subject; nothing here repeats
// them. No provider key is needed — the model is the scripted transport.
//
//   node scripts/smoke-mux.ts
//
// The rig is multi-session on purpose (every other wire-side script is single-session): a connection
// holding two conversations at once is the product shape this transport was reopened for, and it is
// the only place that can be asserted without a browser.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxUpgrade, sessionListeners } from "../packages/server/src/boot.ts";
import { createMuxServer } from "../packages/server/src/mux.ts";
import { SessionHub } from "../packages/server/src/hub.ts";
import { createSessionProjection } from "../packages/server/src/projection.ts";
import { SessionController, SystemController } from "../packages/server/src/controllers/sessions.ts";
import { createRoutes } from "../packages/server/src/controllers/routes.ts";
import { Router } from "../packages/server/src/http/routing.ts";
import { createServer } from "../packages/server/src/http.ts";
import { createFakeTransport, fakeAssistantMessage, type FakeTransport } from "./fake-transport.ts";
import { connect, until, type WireClient } from "./wire/client.ts";
import type { SessionRow, SessionSnapshot, ModelConfig } from "@my-agent/core";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/** The parts of a snapshot these checks read. */
interface ReadSession {
	id: string;
	leafId: string | null;
	submitting: boolean;
	messages: unknown[];
	messageEntryIds: (string | null)[];
	branchPoints: { entryId: string }[];
}

async function readSession(base: string, sessionId: string): Promise<ReadSession | undefined> {
	const read = await request(base, "GET", `/api/sessions/${encodeURIComponent(sessionId)}`);
	return (read.payload as { session?: ReadSession } | undefined)?.session;
}

/** Wait for a run to settle, polling the read path — a branch cannot move under a run in flight. */
async function settleRun(base: string, sessionId: string, ms = 15_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	for (;;) {
		const session = await readSession(base, sessionId);
		if (session?.submitting === false) return true;
		if (Date.now() > deadline) return false;
		await sleep(50);
	}
}

/** The row these checks read off the connection-level stream. */
function rowOf(envelope: unknown): SessionRow | undefined {
	const item = (envelope as { item?: { type?: string; session?: SessionRow } }).item;
	return item?.type === "session_row" ? item.session : undefined;
}

/** How many baselines one lane has carried: a stream can carry more than the one it opened with. */
function baselinesOn(wire: WireClient, sessionId: string): number {
	return wire.items(sessionId).filter((message) => message.type === "baseline").length;
}

/** The newest baseline on one lane — the state the client is being pointed at last. */
function lastBaselineOn(wire: WireClient, sessionId: string): { session: SessionSnapshot } | undefined {
	return wire.items(sessionId).filter((message) => message.type === "baseline").at(-1) as { session: SessionSnapshot } | undefined;
}

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

/** Slow enough that a run is observably in flight; fast enough that the smoke stays sub-minute. */
const TOKENS_PER_SECOND = 400;

async function openRig(): Promise<Rig> {
	const root = await mkdtemp(join(tmpdir(), "my-agent-mux-"));
	const transport = createFakeTransport({ tokensPerSecond: TOKENS_PER_SECOND });
	const hub = new SessionHub({ workDirAbsPath: root, api: transport.api });
	hub.setModelConfigs(rows);

	const projection = createSessionProjection(hub);
	const mux = createMuxServer(hub, projection, { heartbeatIntervalMs: 150 });
	const router = new Router(
		createRoutes({
			system: new SystemController(hub),
			sessions: new SessionController(hub, sessionListeners(mux, projection)),
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

const rig = await openRig();

try {
	// ---------------------------------------------------------------------------------------------
	// 1. Connection-level payloads: the overview and the heartbeat, in either order.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a connection opens with the overview and a heartbeat\n");

	const wire: WireClient = await connect(`${rig.url.replace("http", "ws")}/mux`);
	const overview = await wire.waitForConnection((envelope) => (envelope.item?.type ?? "") === "sessions");
	check("the connection-level overview arrived", overview !== undefined);
	const heartbeat = await wire.waitForConnection((envelope) => (envelope.item?.type ?? "") === "heartbeat");
	check("so did a heartbeat", heartbeat !== undefined);
	const everyMs = (heartbeat?.item as { everyMs?: number } | undefined)?.everyMs;
	check("the heartbeat names its own interval", typeof everyMs === "number" && everyMs > 0, String(everyMs));
	// Both arrive; which came first is deliberately not asserted (ticket 07: the baseline may precede
	// the heartbeat), and neither kind of frame may ride a session's streamId.
	check(
		"neither of them rode a session's stream",
		wire.frames
			.filter((frame) => frame.streamId !== null)
			.every((frame) => "item" in frame && !["sessions", "heartbeat", "session_row"].includes((frame.item as { type: string }).type)),
	);

	// ---------------------------------------------------------------------------------------------
	// 2. Lanes: a stream's first frame is its baseline; a second open is one more of them.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("one session, one lane, one baseline\n");

	const created = await request(rig.url, "POST", "/api/sessions");
	const laneId = (created.payload as { sessionId: string }).sessionId;
	const lane = await wire.open(laneId);
	check("the first frame on the stream is the session's baseline", lane.id === laneId);
	check("and an idle session says so", lane.submitting === false, String(lane.submitting));

	// A second `open` asks for the same thing the first one asked for — this session's state now, then
	// everything after it — so it is answered with one more baseline on the stream that already exists,
	// and the subscription underneath is left alone (ADR-0010 decision 1). This is the frame a pane
	// needs after going away while something else still held the session: no `cancel` was sent, so a
	// re-sent baseline is the only answer the trip back can have.
	//
	// Polled rather than sampled after a fixed sleep: the baseline is read off the session's file, and
	// the frame is what is being waited for, not a duration.
	const beforeDuplicate = baselinesOn(wire, laneId);
	wire.send({ type: "open", sessionId: laneId });
	check("the duplicate open was answered with another baseline", await until(() => baselinesOn(wire, laneId) > beforeDuplicate, 5_000), JSON.stringify(wire.endOf(laneId)));
	// The stream it already had is untouched: no error, no end, and still the same subscription — the
	// check below proves it by using the lane again.
	check(
		"and the stream it already had is untouched",
		wire.endOf(laneId).errors.length === 0 && !wire.endOf(laneId).ended,
		JSON.stringify(wire.endOf(laneId)),
	);

	// ---------------------------------------------------------------------------------------------
	// 3. A failed open: error, then end, on the stream that asked — and the connection stays.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("an unknown session is an error frame, not a dropped connection\n");

	wire.send({ type: "open", sessionId: "does-not-exist" });
	check("the unknown open was answered with an error", await until(() => wire.endOf("does-not-exist").errors.length > 0, 5_000), JSON.stringify(wire.endOf("does-not-exist")));
	check("and an end", await until(() => wire.endOf("does-not-exist").ended, 5_000), JSON.stringify(wire.endOf("does-not-exist")));
	// The connection itself is untouched: a mistake on one lane must not cost the others. The next
	// check proves the channel is alive by using it again.

	// ---------------------------------------------------------------------------------------------
	// 4. Uplink tolerance: nonsense frames are dropped, not fatal.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("nonsense uplink is dropped and logged, not fatal\n");

	wire.send({ type: "teleport", sessionId: laneId });
	wire.send({ note: "not even a frame" });
	wire.sendRaw("this is not JSON at all");
	// Proof of life comes from the one payload only a working connection produces on its own: the
	// heartbeat keeps its interval, and three of them mean three round trips of the timer survived
	// the nonsense.
	const heartbeatsBefore = wire.connection().filter((envelope) => envelope.item?.type === "heartbeat").length;
	await sleep(600);
	const heartbeatsAfter = wire.connection().filter((envelope) => envelope.item?.type === "heartbeat").length;
	check("heartbeats kept their interval through the nonsense", heartbeatsAfter > heartbeatsBefore, `${heartbeatsBefore} -> ${heartbeatsAfter}`);

	// ---------------------------------------------------------------------------------------------
	// 5. Acceptance edge 1: one connection, two sessions, lanes never cross.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("one connection subscribes to two sessions at once\n");

	const second = await request(rig.url, "POST", "/api/sessions");
	const otherId = (second.payload as { sessionId: string }).sessionId;
	const other = await wire.open(otherId);
	check("the second stream opened with its own baseline", other.id === otherId && otherId !== laneId);

	rig.transport.setResponses([fakeAssistantMessage("a".repeat(2000))]);
	check("the prompt was accepted", (await prompt(rig.url, laneId, "say something long")) === 202);
	const running = await wire.waitFor(laneId, (message) => message.type === "status" && (message as { submitting?: boolean }).submitting === true, 10_000);
	check("the run announced itself on its own lane", running !== undefined);

	// The re-attach half of the same edge, and the case a duplicate `open` exists for: something else
	// still holds this session (here the run), the pane went away and came back, so a second `open`
	// lands on a subscription that is still live. The baseline it answers with is the session's state
	// *now* — `partial` included — so the window draws the sentence so far instead of waiting for a
	// delta to start painting. Waiting for the first delta is what makes `partial` exist: it is the
	// running message, so a re-attach before the answer began would honestly carry none.
	await until(
		() =>
			wire
				.items(laneId)
				.some((message) => message.type === "event" && (message as { event: { type: string } }).event.type === "message_update"),
		10_000,
	);
	const laneEvents = (): number => wire.items(laneId).filter((message) => message.type === "event").length;
	const eventsBeforeReattach = laneEvents();
	const baselinesBeforeReattach = baselinesOn(wire, laneId);
	wire.send({ type: "open", sessionId: laneId });
	check("a duplicate open mid-run is answered with a baseline too", await until(() => baselinesOn(wire, laneId) > baselinesBeforeReattach, 5_000), JSON.stringify(wire.endOf(laneId)));
	const reattached = lastBaselineOn(wire, laneId);
	check("and that baseline is the live state, partial answer included", reattached?.session.partial !== undefined, JSON.stringify(reattached?.session.partial));
	// Frame order, the property the whole thing rests on: the baseline arrives *inside* the stream and
	// the deltas keep appending to it — not a second stream, not an end, nothing replayed twice.
	check("the deltas kept coming after it", await until(() => laneEvents() > eventsBeforeReattach, 10_000), `${eventsBeforeReattach} events before`);

	// While the run streams, the idle lane must stay quiet and the heartbeats keep coming.
	await sleep(300);
	const heartbeatsDuring = wire.connection().filter((envelope) => envelope.item?.type === "heartbeat").length;
	check("heartbeats kept arriving during the run", heartbeatsDuring > 0, String(heartbeatsDuring));
	const idleLaneFrames = wire.items(otherId).filter((message) => message.type === "event");
	check("the idle lane received no event of the other session's run", idleLaneFrames.length === 0, String(idleLaneFrames.length));

	// Every event frame the run produced sat on the running session's lane — and on no other.
	const eventLanes = new Set(
		wire.frames.filter((frame) => "item" in frame && (frame.item as { type: string }).type === "event").map((frame) => frame.streamId),
	);
	check(
		"the run's content sat only on its own lane",
		eventLanes.size === 1 && eventLanes.has(laneId),
		JSON.stringify([...eventLanes]),
	);
	check("the run settled", await settleRun(rig.url, laneId));

	// ---------------------------------------------------------------------------------------------
	// 6. Acceptance edge 2 (the active half): cancel, change elsewhere, open — the new baseline is
	//    what it looks like now, and it is a replacement, not an append.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a lane dropped and reattached converges on now\n");

	wire.cancel(laneId);
	// The change happens with nothing watching the lane: a prompt from another window, on a session
	// this connection just stopped listening to.
	rig.transport.setResponses([fakeAssistantMessage("second answer")]);
	check("the prompt was accepted", (await prompt(rig.url, laneId, "another run, unseen")) === 202);
	check("that run settled", await settleRun(rig.url, laneId));
	// The run's own claim was the last one, so the host closes as soon as it settles. Waiting for the
	// reap to finish makes the re-open below an honest cold open: a subscription that races the reap
	// can bind to a host that is about to be torn out from under it, and the assertion would be about
	// that timing instead of about convergence.
	check("the session was reaped once nothing claimed it", await until(() => !rig.hub.live.includes(laneId), 10_000), rig.hub.live.join(","));

	const baselinesBefore = baselinesOn(wire, laneId);
	const reopened = await wire.open(laneId);
	const fresh = lastBaselineOn(wire, laneId);
	const stored = await readSession(rig.url, laneId);
	check("reopening answered with a baseline", reopened.id === laneId);
	check(
		"it is a second baseline, not a continuation",
		baselinesOn(wire, laneId) === baselinesBefore + 1,
		`${baselinesBefore} -> ${baselinesOn(wire, laneId)}`,
	);
	check(
		"and it says what the session looks like now, not what it looked like before",
		fresh !== undefined && stored !== undefined && fresh.session.messages.length === stored.messages.length,
		`baseline=${fresh?.session.messages.length} stored=${stored?.messages.length}`,
	);

	// ---------------------------------------------------------------------------------------------
	// 7. A branch move under an open lane rides as a whole new baseline.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a changed tree is everyone's business: it arrives as a baseline\n");

	// Two runs give the first user message a continuation, which is what makes it a branch point.
	// The bench claim keeps the host alive across both runs and the move: the moment its claims hit
	// zero the host is reaped and the lane would be ended under it ("the watched session went away"),
	// which is the lifecycle working as designed — the claim decides how long the session lives, and
	// the test bench is the claim-holder here.
	const bench = await rig.hub.claim(laneId);
	rig.transport.setResponses([fakeAssistantMessage("one"), fakeAssistantMessage("two")]);
	check("the first prompt was accepted", (await prompt(rig.url, laneId, "branch here")) === 202);
	check("it settled", await settleRun(rig.url, laneId));
	check("the second prompt was accepted", (await prompt(rig.url, laneId, "and continue")) === 202);
	check("it settled", await settleRun(rig.url, laneId));

	const before = await readSession(rig.url, laneId);
	const branchEntry = before?.messageEntryIds.find((id): id is string => typeof id === "string");
	check("the session has a message entry to branch at", branchEntry !== undefined);
	if (branchEntry !== undefined && before !== undefined) {
		const baselinesAt = baselinesOn(wire, laneId);
		const moved = await request(rig.url, "POST", `/api/sessions/${encodeURIComponent(laneId)}/branch`, { entryId: branchEntry, descend: false });
		check("the branch move was accepted", moved.status === 200, String(moved.status));

		// Wait for the count to grow, then read the newest one: `waitFor` matches from the beginning,
		// and this lane already carries baselines from the sections above.
		const grew = await until(() => baselinesOn(wire, laneId) > baselinesAt, 5_000);
		const changed = lastBaselineOn(wire, laneId);
		check(
			"the subscription was told — by a whole new baseline, not a difference",
			grew && baselinesOn(wire, laneId) === baselinesAt + 1,
			`${baselinesAt} -> ${baselinesOn(wire, laneId)}`,
		);
		check("and the move is inside it", changed?.session.leafId === branchEntry, JSON.stringify(changed?.session.leafId));
	}

	// The bench claim goes back: the reap that follows ends the lane, and that is the expected order
	// of events, not a failure of the lane.
	rig.hub.release(bench);
	check("the lane ends when the host it watched goes away", await until(() => wire.endOf(laneId).ended, 10_000), JSON.stringify(wire.endOf(laneId)));

	// ---------------------------------------------------------------------------------------------
	// 8. Acceptance edge 3 (the overview half): a run with no subscriber still moves its row.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a run nobody watches still moves its sidebar row\n");

	const unwatched = await request(rig.url, "POST", "/api/sessions");
	const unwatchedId = (unwatched.payload as { sessionId: string }).sessionId;
	const rowsForSession = (): SessionRow[] =>
		wire
			.connection()
			.map(rowOf)
			.filter((row): row is SessionRow => row?.id === unwatchedId);
	// A session with nothing said in it has no file, and so no row: the first message is what puts
	// both down. There is therefore no "before" stamp to compare against here — the run is what
	// creates the row, and the two checks below say exactly that.
	const modifiedBefore = rowsForSession()[0]?.modified;

	rig.transport.setResponses([fakeAssistantMessage("unwatched run ".repeat(20))]);
	check("the prompt was accepted", (await prompt(rig.url, unwatchedId, "run without a viewer")) === 202);
	// The running:true row is the anchor: "finished" below means a row that arrived *after* it, not
	// just any row that says false — the pre-run row says false too, and this rig's scripted answer
	// carries a timestamp older than the prompt, so its entry never advances `modified` and the two
	// rows share a stamp. Arrival order is the only honest "after" here.
	check("the run announced itself on its row", await until(() => rowsForSession().some((row) => row.running === true), 5_000), JSON.stringify(rowsForSession()));
	const runningIndex = rowsForSession().findIndex((row) => row.running === true);
	check("it settled", await settleRun(rig.url, unwatchedId));
	// `submitting` turns false in the loop before the session publishes that fact, so the row that
	// says `running: false` can land a tick after the read path already answers.
	await until(() => rowsForSession().some((row, index) => index > runningIndex && row.running === false), 5_000);

	// The row went up and came back down, and the file's last message moved it forward — all of it
	// observed on the connection-level seat, with no logical stream open for that session.
	const allRows = rowsForSession();
	const finishedIndex = allRows.findIndex((row, index) => index > runningIndex && row.running === false);
	const settledRow = allRows[allRows.length - 1];
	check("the row reported the run while it was in flight", runningIndex >= 0, JSON.stringify(allRows.map((row) => row.running)));
	check("and reported it finished afterwards", finishedIndex > runningIndex, JSON.stringify(allRows));
	check(
		"a session with nothing said in it had no sidebar row",
		modifiedBefore === undefined,
		`before=${modifiedBefore}`,
	);
	check(
		"and the run stamped the row it created",
		settledRow !== undefined && settledRow.modified > 0,
		`before=${modifiedBefore} after=${settledRow?.modified}`,
	);

	// ---------------------------------------------------------------------------------------------
	// 9. Shutdown: the server lets go of its connections, and the rig closes.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("shutdown takes the connections with it\n");

	const started = Date.now();
	await rig.close();
	check("closing the rig with a live connection returns", Date.now() - started < 5_000, `${Date.now() - started} ms`);
	const closed = await wire.closed();
	check("the client saw the connection end", typeof closed.code === "number");

	await wire.close().catch(() => {});
} catch (error) {
	failures += 1;
	process.stdout.write(`\nFAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	try {
		await rig.close();
	} catch {
		// The rig may already be closed by the shutdown check above.
	}
} finally {
	process.stdout.write(failures === 0 ? "\nmux ok\n" : `\n${failures} failure(s)\n`);
	process.exitCode = failures === 0 ? 0 : 1;
}
