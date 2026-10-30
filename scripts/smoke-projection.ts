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
	workspaceDir,
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
const hub = new SessionHub({ absCwd: root, api: fake.api });
hub.setModelConfigs([ROW]);

try {
	process.stdout.write("a session that exists before anything asks gets a row\n");
	const first = await hub.newSession();
	hub.release(await hub.claim(first));
	const projection = createSessionProjection(hub);

	// Every row change from here on, as the listener saw it.
	const seen: SessionRow[] = [];
	const stopListening = projection.onRow((row) => seen.push(row));

	// The store is shared with every other run on this machine, so this smoke never assumes it is the
	// only session that exists — it asks about the ones it made.
	const seeded = await projection.row(first);
	check("the session has a row", seeded !== undefined, String(seeded));
	check("and it is idle", seeded?.running === false && seeded.pending === 0, JSON.stringify(seeded));
	check("with the workspace as its absCwd", seeded?.absCwd === root, seeded?.absCwd);
	check("a row carries modified, not only createdAt", typeof seeded?.modified === "number" && seeded.modified > 0, String(seeded?.modified));

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
	const mine = groups.find((group) => group.absCwd === root);
	check("this workspace's group holds this session's row", mine?.sessions.some((row) => row.id === first) === true, JSON.stringify(mine?.absCwd));
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

	process.stdout.write("a session created with nobody watching still gets a row\n");
	const second = await hub.newSession();
	check(
		"a created session reaches the store without a host",
		await until(() => seen.some((row) => row.id === second)),
		JSON.stringify(seen.map((row) => row.id)),
	);
	const newRow = await projection.row(second);
	check("and it is a row of its own", newRow !== undefined && newRow.id !== first, newRow?.id);
	check("an unrun session is idle", newRow?.running === false && newRow.pending === 0, JSON.stringify(newRow));

	process.stdout.write("a host opening leaves an idle row alone\n");
	const host = await hub.claim(second);
	await settle();
	const running = await projection.row(second);
	check("an idle host leaves the row idle", running?.running === false, JSON.stringify(running));
	check(
		"and does not republish a row that says the same thing",
		seen.filter((row) => row.id === second).length === 1,
		`${seen.filter((row) => row.id === second).length} publishes`,
	);

	process.stdout.write("a run moves the row even though nothing is watching it\n");
	// The whole point of the store: a session runs, and its row says so with no subscriber anywhere.
	// Only the *content* stream would have carried this before, and there is no subscriber here.
	const beforeRun = seen.length;
	fake.setResponses([fakeAssistantMessage("answered")]);
	const run = host.session.prompt("now the row has something to say");
	await until(() => seen.some((row) => row.id === second && row.running === true));
	check("the row said running while the run was in flight", seen.some((row) => row.id === second && row.running));
	await run;
	check("and the run ended", (await projection.row(second))?.running === false, JSON.stringify(await projection.row(second)));
	check("the row moved more than once for one run", seen.length > beforeRun + 1, `${seen.length - beforeRun} updates`);

	const moved = seen.filter((row) => row.id === second).at(-1);
	check("a message landing moved the row", moved !== undefined && moved.title.includes("now the row"), moved?.title);
	check(
		"and pushed modified forward",
		(moved?.modified ?? 0) > (seeded?.modified ?? 0),
		`${moved?.modified} vs ${seeded?.modified}`,
	);
	check("the title is read from the branch, not the file", moved?.title.startsWith("now the row") === true, moved?.title);

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
	const beforeBranch = await projection.row(first);
	check("an untouched session is named by the placeholder", beforeBranch?.title === "新会话", beforeBranch?.title);
	const branchHost = await hub.claim(first);
	fake.setResponses([fakeAssistantMessage("one"), fakeAssistantMessage("two")]);
	await branchHost.session.prompt("first turn");
	await settle();
	check("a message landing named the row", (await projection.row(first))?.title === "first turn", (await projection.row(first))?.title);
	check(
		"and a cold probe agrees with the live row",
		(await SessionManager.findSessionRowById(first))?.title === "first turn",
		(await SessionManager.findSessionRowById(first))?.title,
	);

	// The leaf is in memory, so the only way to learn the branch moved is to hear the session say so —
	// and the only way a title can move at all is to drop the messages that gave it, because a branch
	// always runs back to the root. Resetting the leaf and asking again starts a new root, and the file
	// keeps the conversation it replaced alongside the new one.
	branchHost.session.sessionManager.resetLeaf();
	await branchHost.session.prompt("a different opening");
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
	await sourceHost.session.prompt("the conversation being forked");
	await settle();
	const forked = await hub.fork(source, sourceHost.session.sessionManager.getLeafId());
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
	await observedHost.session.prompt("does the observer hear this");
	check("the observer saw the run's events", events > 0, `${events} events`);
	hub.release(observedHost);
	await until(() => !hub.live.includes(afterStop));
	check("the host was reaped while observed", !hub.live.includes(afterStop));
	check("and the row says idle", (await projection.row(afterStop))?.running === false);
	stopObserving();
	check("and the observer let go", !hub.isWatched(afterStop));

	process.stdout.write("the envelope types describe a multiplexed connection\n");
	const item: ServerMessage = { type: "status", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, contextWindow: 100 }, submitting: true, queued: 0, isRetrying: false, retryAttempt: 0 };
	const onAStream: ServerFrame = { streamId: "session-a", item };
	const heartbeat: ConnectionItem = { type: "heartbeat", everyMs: 5_000 };
	const onTheConnection: ServerFrame = { streamId: null, item: heartbeat };
	const rowsBaseline: ServerFrame = { streamId: null, item: { type: "sessions", sessions: [] satisfies SessionRow[] } };
	const oneRow: ServerFrame = { streamId: null, item: { type: "session_row", session: seeded as SessionRow } };
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
	// Sessions live under the agent home, keyed by the workspace path, so removing the temporary
	// workspace is not enough: without this every run leaves an orphan directory behind.
	await rm(workspaceDir(root), { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nprojection ok\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);