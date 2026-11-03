// Projection smoke test: proves the sidebar row store answers "what is every session doing" without
// anyone watching, that a row only moves when something about it changed, and that the new envelope
// types describe the frames a multiplexed connection carries.
// Nothing here reaches a model, so no provider key is needed.
// Run with: node scripts/smoke-projection.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionManager,
	sessionDir,
	type ClientFrame,
	type ConnectionItem,
	type ServerFrame,
	type ServerMessage,
	type SessionRow,
	type ModelConfig,
} from "@my-agent/core";
import { SessionHub } from "../packages/server/src/hub.ts";
import { createSessionProjection } from "../packages/server/src/projection.ts";
import { createFakeTransport, fakeAssistantMessage } from "./fake-transport.ts";

const root = await mkdtemp(join(tmpdir(), "my-agent-projection-"));
let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/** Poll until `ready` holds, so no check guesses at the timing of an async read. */
async function until(ready: () => boolean, ms = 5_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (ready()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return ready();
}

/** Settle the microtask queue plus one macrotask, so a resolved probe has landed. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * The row every session in this smoke runs on.
 *
 * The hub reads its rows from the store the user typed, so one row is all it takes — and the scripted
 * transport answers it, which is what lets a live session's row be driven with no provider key.
 */
const ROW: ModelConfig = {
	name: "faux",
	baseUrl: "http://127.0.0.1:1/v1",
	apiKey: "unused-by-the-scripted-transport",
	id: "faux-1",
	contextWindow: 128_000,
	maxTokens: 16_384,
};

const fake = createFakeTransport();
const hub = new SessionHub({ workDirAbsPath: root, api: fake.api, modelsHome: join(root, "agent-home") });
/** The process's one orchestrator: every session this smoke drives goes through it, by id. */
const agent = hub.agent;
hub.setModelConfigs([ROW]);

try {
	process.stdout.write("a session that exists before anything asks stays out of the store until it speaks\n");
	const first = await hub.newSession();
	hub.release(await hub.claim(first));
	const projection = createSessionProjection(hub);

	// Every row change from here on, as the listener saw it.
	const seen: SessionRow[] = [];
	const stopListening = projection.onRow((row) => seen.push(row));

	// The store is shared with every other run on this machine, so this smoke never assumes it is the
	// only session that exists — it asks about the ones it made. Under the seed→fill lifecycle a
	// session nobody has spoken in has no file (ADR-0006 §3), and no file means no row: the sidebar
	// lists conversations, not intentions.
	/** Assert a session has no row, with the row it found (always undefined) as the detail. */
	const checkAbsent = async (label: string, id: string): Promise<void> => {
		const row = await projection.row(id);
		check(label, row === undefined, String(row));
	};
	const seeded = await projection.row(first);
	check("an unspoken session has no row", seeded === undefined, String(seeded));
	const groupsBefore = await projection.groups();
	check(
		"and no group names its directory yet",
		groupsBefore.every((group) => group.workDirAbsPath !== root),
		JSON.stringify(groupsBefore.map((group) => group.workDirAbsPath)),
	);

	process.stdout.write("the first message is what puts the session in the store\n");
	const spokenHost = await hub.claim(first);
	fake.setResponses([fakeAssistantMessage("a first answer")]);
	await hub.agent.prompt(first, "the conversation starts here");
	check("the row arrived with the run", await until(() => seen.some((row) => row.id === first)));
	hub.release(spokenHost);
	const spokenRow = await projection.row(first);
	check("a spoken session has a row", spokenRow !== undefined, String(spokenRow));
	check("with the working directory as its workDirAbsPath", spokenRow?.workDirAbsPath === root, spokenRow?.workDirAbsPath);
	check("a row carries modified, not only createdAt", typeof spokenRow?.modified === "number" && spokenRow.modified > 0, String(spokenRow?.modified));
	check("and the title is the message the branch starts with", spokenRow?.title === "the conversation starts here", spokenRow?.title);

	process.stdout.write("one scan, however many callers\n");
	// Let the reap of the claim above land before counting publications: it reports the session it lost,
	// which builds the row this projection has not seen yet, and that is a real row appearing rather
	// than a row that moved.
	await settle();
	const quiet = seen.length;
	await settle();
	check("a row that did not move is not published", seen.length === quiet, `${seen.length - quiet} extra`);
	const [rows, groups] = await Promise.all([projection.rows(), projection.groups()]);
	const again = await projection.rows();
	check("both callers see the same rows", JSON.stringify(rows) === JSON.stringify(again));
	check("the rows are the ones the seed found", rows.some((row) => row.id === first));
	const mine = groups.find((group) => group.workDirAbsPath === root);
	check("this directory's group holds this session's row", mine?.sessions.some((row) => row.id === first) === true, JSON.stringify(mine?.workDirAbsPath));
	check(
		"a group is ordered by activity, newest first",
		(mine?.sessions ?? []).every((row, index, all) => index === 0 || (all[index - 1]?.modified ?? 0) >= row.modified),
		JSON.stringify(mine?.sessions.map((row) => row.modified)),
	);
	check(
		"and every row appears in exactly one group",
		groups.reduce((total, group) => total + group.sessions.length, 0) === rows.length,
		`${groups.reduce((total, group) => total + group.sessions.length, 0)} vs ${rows.length}`,
	);

	process.stdout.write("a session created with nobody watching stays out of the store\n");
	const second = await hub.newSession();
	await settle();
	await checkAbsent("a created session reaches no row without a host", second);

	process.stdout.write("an idle host on an unspoken session builds no row either\n");
	const host = await hub.claim(second);
	await settle();
	await checkAbsent("an idle host leaves the store alone", second);
	check("and published nothing", !seen.some((row) => row.id === second), JSON.stringify(seen.map((row) => row.id)));

	process.stdout.write("a run moves the row even though nothing is watching it\n");
	// The whole point of the store: a session runs, and its row says so with no subscriber anywhere.
	// Only the *content* stream would have carried this before, and there is no subscriber here. The
	// first message writes the file, so this run is also the row's birth — the row comes into the
	// store with the run, and the run after this one is what moves a row that already exists.
	const beforeRun = seen.length;
	fake.setResponses([fakeAssistantMessage("answered")]);
	const run = hub.agent.prompt(host.id, "now the row has something to say");
	check("the row arrived during the run", await until(() => seen.some((row) => row.id === second)));
	await run;
	const landed = await projection.row(second);
	check("and the run ended idle", landed?.running === false && landed.pending === 0, JSON.stringify(landed));
	check("the title is read from the branch, not the file", landed?.title === "now the row has something to say", landed?.title);

	// With the row in the store, the next run is the store's headline act: `running` while in flight,
	// republished idle when it settles, all with no subscriber anywhere.
	const beforeSecondRun = seen.length;
	fake.setResponses([fakeAssistantMessage("answered again")]);
	const secondRun = hub.agent.prompt(host.id, "the row is watching itself now");
	check("the row said running while the run was in flight", await until(() => seen.some((row) => row.id === second && row.running === true)));
	await secondRun;
	check("and the second run ended", (await projection.row(second))?.running === false, JSON.stringify(await projection.row(second)));
	check("the row moved more than once for one run", seen.length > beforeSecondRun + 1, `${seen.length - beforeSecondRun} updates`);

	const moved = seen.filter((row) => row.id === second).at(-1);
	check(
		"a message landing pushed modified forward",
		(moved?.modified ?? 0) > (landed?.modified ?? 0),
		`${moved?.modified} vs ${landed?.modified}`,
	);
	// The title names the branch's first user message (ADR-0002), so a second turn moves the row's
	// activity without renaming the conversation.
	check("a later message does not rename the row", moved?.title === "now the row has something to say", moved?.title);

	const settled = seen.length;
	await settle();
	check("an idle session publishes nothing on its own", seen.length === settled, `${seen.length - settled} extra`);

	process.stdout.write("the row survives its host being reaped\n");
	hub.release(host);
	check("the host went away", await until(() => !hub.live.includes(second)));
	const reaped = await projection.row(second);
	check("its row is still there", reaped !== undefined && reaped.id === second, String(reaped?.id));
	check("and says idle rather than claiming to run", reaped?.running === false, JSON.stringify(reaped));
	check("with the title it had while running", reaped?.title === moved?.title, `${reaped?.title} vs ${moved?.title}`);

	process.stdout.write("a row's title follows the branch, not the file\n");
	// The placeholder rule lives at the session level now — an unspoken session has no row at all,
	// which the opening section checked. What the row must do here is carry the title its branch
	// gave it until the branch moves.
	const beforeBranch = await projection.row(first);
	check("the row kept the title its branch gave it", beforeBranch?.title === "the conversation starts here", beforeBranch?.title);
	const branchHost = await hub.claim(first);
	fake.setResponses([fakeAssistantMessage("one"), fakeAssistantMessage("two")]);
	await hub.agent.prompt(first, "first turn");
	await settle();
	// A second turn on the same branch cannot rename the session: the fallback title is the branch's
	// first user message, and that message has not moved.
	check("a message landing does not rename the row", (await projection.row(first))?.title === "the conversation starts here", (await projection.row(first))?.title);
	check(
		"and a cold probe agrees with the live row",
		(await SessionManager.findSessionRowById(first))?.title === "the conversation starts here",
		(await SessionManager.findSessionRowById(first))?.title,
	);

	// The leaf is in memory, so the only way to learn the branch moved is to hear the session say so —
	// and the only way a title can move at all is to drop the messages that gave it, because a branch
	// always runs back to the root. Resetting the leaf and asking again starts a new root, and the file
	// keeps the conversation it replaced alongside the new one.
	agent.sessionManager.resetLeaf(agent.sessionManager.stateOf(first));
	await hub.agent.prompt(first, "a different opening");
	await settle();
	const reopened = await projection.row(first);
	check("a new root is named from the message it started with", reopened?.title === "a different opening", reopened?.title);
	check(
		"and the cold probe agrees with the live row, which is the whole point of one derivation",
		(await SessionManager.findSessionRowById(first))?.title === reopened?.title,
		`${(await SessionManager.findSessionRowById(first))?.title} vs ${reopened?.title}`,
	);
	hub.release(branchHost);
	await until(() => !hub.live.includes(first));
	check("the row is still there after its host", (await projection.row(first)) !== undefined);

	process.stdout.write("a fork knows its parent without a listing beside it\n");
	const source = await hub.newSession();
	const sourceHost = await hub.claim(source);
	fake.setResponses([fakeAssistantMessage("to fork from")]);
	await hub.agent.prompt(source, "the conversation being forked");
	await settle();
	const forked = await hub.fork(source, agent.sessionManager.stateOf(source).leafId);
	await until(() => seen.some((row) => row.id === forked));
	const forkRow = await projection.row(forked);
	check("the fork reaches the store on its own", forkRow !== undefined, forked);
	check(
		"and names the session it came from",
		forkRow?.parentId === source,
		`${forkRow?.parentId} vs ${source}`,
	);
	check("while the session it came from names nobody", (await projection.row(source))?.parentId === undefined, (await projection.row(source))?.parentId);
	hub.release(sourceHost);
	await until(() => !hub.live.includes(source));

	process.stdout.write("the hub tells a process-level listener about sessions nobody watches\n");
	const heard: string[] = [];
	const stopHosting = hub.onHostChange((sessionId, hostSeen) => heard.push(`${sessionId}:${hostSeen === undefined ? "none" : "host"}`));
	const third = await hub.newSession();
	check("a created session is reported with no host", heard.includes(`${third}:none`), heard.join(" "));
	const thirdHost = await hub.claim(third);
	check("and again with one", heard.includes(`${third}:host`), heard.join(" "));
	hub.release(thirdHost);
	await until(() => heard.filter((entry) => entry === `${third}:none`).length === 2);
	check("and once more when it is reaped", heard.filter((entry) => entry === `${third}:none`).length === 2, heard.join(" "));
	stopHosting();
	const afterStop = await hub.newSession();
	await settle();
	check("a listener that stopped hearing stops hearing", !heard.includes(`${afterStop}:none`), heard.join(" "));

	process.stdout.write("observing a session is not the same as claiming it\n");
	let events = 0;
	// Told about the session before it was running, so the observer is attached the moment a host opens.
	const stopObserving = hub.observe(afterStop, (feeds) => {
		if (feeds === undefined) return;
		feeds.onEvent(() => {
			events += 1;
		});
	});
	check("watching it did not assemble anything", !hub.live.includes(afterStop), hub.live.join(","));
	const observedHost = await hub.claim(afterStop);
	check("and it was attached when the host opened", observedHost.claims === 1, `claims=${observedHost.claims}`);
	fake.setResponses([fakeAssistantMessage("seen")]);
	await hub.agent.prompt(afterStop, "does the observer hear this");
	check("the observer saw the run's events", events > 0, `${events} events`);
	hub.release(observedHost);
	await until(() => !hub.live.includes(afterStop));
	check("the host was reaped while observed", !hub.live.includes(afterStop));
	// The row's birth publish and its idle republish are asynchronous reads; wait for the idle one
	// rather than guessing which landed by the time the reap returned.
	check("and the row says idle", await until(() => seen.some((row) => row.id === afterStop && row.running === false)), JSON.stringify(seen.filter((row) => row.id === afterStop)));
	stopObserving();
	check("and the observer let go", !hub.isWatched(afterStop));

	process.stdout.write("the envelope types describe a multiplexed connection\n");
	const item: ServerMessage = { type: "status", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, contextWindow: 100 }, submitting: true, queued: 0, isRetrying: false, retryAttempt: 0 };
	const onAStream: ServerFrame = { streamId: "session-a", item };
	const heartbeat: ConnectionItem = { type: "heartbeat", everyMs: 5_000 };
	const onTheConnection: ServerFrame = { streamId: null, item: heartbeat };
	const rowsBaseline: ServerFrame = { streamId: null, item: { type: "sessions", sessions: [] satisfies SessionRow[] } };
	const oneRow: ServerFrame = { streamId: null, item: { type: "session_row", session: spokenRow as SessionRow } };
	const ended: ServerFrame = { streamId: "session-a", end: true };
	const failed: ServerFrame = { streamId: "session-a", error: { message: "that run could not start" } };

	check("content rides the session's own stream", onAStream.streamId === "session-a" && "item" in onAStream);
	check("a heartbeat rides the connection seat", onTheConnection.streamId === null);
	check("so does the whole table", rowsBaseline.streamId === null && "item" in rowsBaseline);
	check("and one row at a time", oneRow.streamId === null);
	check("a stream ends without saying why", "end" in ended && ended.end === true);
	check("a failure is not a terminal frame", "error" in failed && !("end" in failed));
	check("the three shapes are told apart by field name", ["item", "end", "error"].every((key) => key in onAStream || key in ended || key in failed));

	const open: ClientFrame = { type: "open", sessionId: "session-a" };
	const cancel: ClientFrame = { type: "cancel", sessionId: "session-a" };
	check("a client opens a stream by session id", open.type === "open" && open.sessionId === "session-a");
	check("and cancels one the same way", cancel.type === "cancel" && cancel.sessionId === "session-a");
	check("no frame carries a request id", !("requestId" in open) && !("subscriptionId" in open));

	stopListening();
	projection.close();
	await hub.close();
	check("nothing is left running", hub.live.length === 0, hub.live.join(","));
} finally {
	// Sessions live under the agent home, keyed by the working directory path, so removing the temporary
	// directory is not enough: without this every run leaves an orphan directory behind.
	await rm(sessionDir(root), { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nprojection ok\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);