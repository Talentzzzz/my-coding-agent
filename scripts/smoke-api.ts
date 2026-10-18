// Ad-hoc transport check: read a session snapshot off the mux, accept a prompt over HTTP, feed the
// run back, stop it with an abort request, and start a replacement session — then prove a branch
// move survives the reap with nothing attached at all.
//
//   node scripts/smoke-api.ts
//
// Start a server first (npm run start -- --cwd .), or point this at one with MY_AGENT_URL. No
// provider key is needed: the run is expected to settle on a provider error, which is still a
// settled run. That failure is a *retryable* one — a refused connection — so the default retry policy
// spends three backoffs, about fourteen seconds, before the run settles; the watchdog below is sized
// for the whole script (two runs plus the tree checks), not for one run, so it catches a hang rather
// than the backoff. Run the server with `retry` disabled in settings to make it immediate.
//
// One check writes the model list and puts it back, so run the server with MY_AGENT_HOME pointing at a
// scratch directory if you mind a round trip through `models.json`:
//   $env:MY_AGENT_HOME = "$env:TEMP\my-agent-smoke"; npm run start
const target = new URL(process.env.MY_AGENT_URL ?? "http://127.0.0.1:8080");
const base = target.origin;

/** The session the stream currently open is watching. */
let sessionId = "";
/** The replacement the first stream asked the server to open, for the second half of this script. */
let replacementId: string | undefined;
let failed = false;

const timer = setTimeout(() => {
	fail("timed out waiting for the run to settle");
	process.exit(1);
}, 150_000);

function fail(message: string): void {
	failed = true;
	process.stdout.write(`\nFAIL: ${message}\n`);
}

function pass(message: string): void {
	process.stdout.write(`${message}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function request(method: string, path: string, body?: unknown): Promise<{ status: number; payload: unknown }> {
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

// --- The mux ------------------------------------------------------------------------------------

/**
 * One envelope off the mux: a logical stream's frame, or a connection-level payload at `streamId: null`.
 *
 * The connection-level frames — heartbeat, session rows — belong to no session this script reads, so
 * the sequential reader below skips them rather than asserting anything about their order: a heartbeat
 * may arrive before the first baseline, and a row may arrive at any time.
 */
interface Envelope {
	streamId: string | null;
	item?: { type: string; [key: string]: unknown };
	end?: true;
	error?: { message: string };
}

const frames: Envelope[] = [];
const ws = new WebSocket(`${base.replace(/^http/, "ws")}/mux`);
const channelOpen = new Promise<void>((resolve, reject) => {
	ws.addEventListener("open", () => resolve());
	ws.addEventListener("error", () => reject(new Error("the mux connection failed")));
});
ws.addEventListener("message", (event) => {
	frames.push(JSON.parse(String(event.data)) as Envelope);
});

/** Send one uplink frame. Commands stay on REST; the only two actions here are subscribe and cancel. */
function send(frame: { type: string; [key: string]: unknown }): void {
	ws.send(JSON.stringify(frame));
}

/** Frames already consumed by the sequential reader below. */
let cursor = 0;

/**
 * The next frame on one session's stream, in arrival order.
 *
 * One cursor rather than one per watcher, because this script watches one session at a time: a watch
 * consumes until it returns, and the next watch picks up where it left off.
 */
async function nextEnvelope(id: string, deadline: number): Promise<Envelope | undefined> {
	for (;;) {
		while (cursor < frames.length) {
			const frame = frames[cursor++]!;
			if (frame.streamId === id) return frame;
		}
		if (Date.now() > deadline) return undefined;
		await sleep(25);
	}
}

/**
 * Wait for a session's run to settle.
 *
 * A branch cannot move while a run is in flight — the loop appends to the leaf — so the tree checks
 * below have to see the provider failure finish first. This is also what makes the 409 below a real
 * answer rather than a race with an unsettled prompt.
 */
async function settleRun(id: string, ms = 30_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	for (;;) {
		const read = await request("GET", `/api/sessions/${encodeURIComponent(id)}`);
		const session = (read.payload as { session?: { submitting?: boolean } }).session;
		if (session?.submitting === false) return true;
		if (Date.now() > deadline) return false;
		await sleep(100);
	}
}

/** The parts of a snapshot these checks read. */
interface TreeSession {
	leafId: string | null;
	submitting: boolean;
	messageEntryIds: (string | null)[];
	branchPoints: { entryId: string; options: { entryId: string; label: string; role: string; active: boolean }[] }[];
}

/** Handle one payload from the watched session's stream. Returns true once the watch should end. */
async function handleItem(id: string, item: { type: string; [key: string]: unknown }): Promise<boolean> {
	if (item.type === "baseline") {
		const session = item.session as {
			id: string;
			cwd: string;
			model: string;
			thinkingLevels: string[];
			approvals: Record<string, boolean>;
			messages: unknown[];
		};
		pass(
			`\nbaseline ${session.id}\n  cwd=${session.cwd}\n  model=${session.model}\n  thinking=${session.thinkingLevels.join(",")}\n  approvals=${JSON.stringify(session.approvals)}\n  messages=${session.messages.length}`,
		);

		// The second stream is the point of it: the server named a session, and this script attached
		// to it over the mux exactly as a tab would. Nothing left to wait for.
		if (replacementId !== undefined && session.id === replacementId) return true;

		// A prompt is accepted, never awaited: this is the whole reason the transport is HTTP plus a
		// resident channel rather than one long request.
		const accepted = await request("POST", `/api/sessions/${encodeURIComponent(session.id)}/messages`, {
			text: "Reply with exactly: transport ok",
		});
		if (accepted.status !== 202) fail(`prompt answered ${accepted.status}, expected 202`);
		else pass("prompt accepted (202)");

		// The composer's model and level ride on this body rather than as a config change of their own,
		// so a malformed selection has to be refused here — before the message is persisted. A session
		// that gained a message it never ran would be a transcript of something that did not happen.
		const refused = await request("POST", `/api/sessions/${encodeURIComponent(session.id)}/messages`, {
			text: "this must not be stored",
			thinkingLevel: 5,
		});
		if (refused.status !== 400) fail(`a malformed selection answered ${refused.status}, expected 400`);
		else pass("a malformed selection is refused (400)");
		return false;
	}

	if (item.type === "approval_request") {
		const approval = item.request as { toolName: string; toolCallId: string };
		pass(`approval requested for ${approval.toolName}`);
		await request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approval.toolCallId)}`, {
			approved: false,
		});
		return false;
	}

	if (item.type === "event") {
		const event = item.event as {
			type: string;
			delta?: { kind?: string; text?: string };
			message?: { role?: string; errorMessage?: string; stopReason?: string };
		};
		if (process.env.MY_AGENT_TRACE === "1") pass(`  event ${event.type}`);
		// A streamed update is a delta now: the characters that arrived, not the message so far.
		if (event.type === "message_update" && event.delta?.kind === "text") {
			process.stdout.write(event.delta.text ?? "");
			return false;
		}
		if (event.type === "message_end" && event.message?.stopReason !== undefined) {
			pass(
				`\n[${event.message.role} stop=${event.message.stopReason}${event.message.errorMessage ? ` error=${event.message.errorMessage}` : ""}]`,
			);
			return false;
		}
		if (event.type !== "agent_end") return false;

		// The stop path, on the same session, on a request of its own. It must be answered without
		// touching the stream, which is the whole difference from sending a command over the channel.
		const stopped = await request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/abort`);
		if (stopped.status !== 200) fail(`abort answered ${stopped.status}, expected 200`);
		else pass("abort accepted (200)");

		// Now switch sessions the way a tab does: ask for a replacement, then read its stream.
		pass("requesting a replacement session");
		const replacement = await request("POST", "/api/sessions");
		if (replacement.status !== 201) {
			fail(`new session answered ${replacement.status}, expected 201`);
			return true;
		}
		replacementId = (replacement.payload as { sessionId: string }).sessionId;
		return true;
	}

	if (item.type === "error") {
		fail(`server error: ${String(item.message)}`);
		return true;
	}
	return false;
}

/** Open one logical stream for a session and read it until its turn ends. */
async function watch(watching: string): Promise<void> {
	sessionId = watching;
	send({ type: "open", sessionId: watching });
	const deadline = Date.now() + 120_000;
	for (;;) {
		const frame = await nextEnvelope(watching, deadline);
		if (frame === undefined) {
			fail(`the stream for ${watching} went quiet`);
			return;
		}
		if (frame.error !== undefined) {
			fail(`the stream for ${watching} failed: ${frame.error.message}`);
			return;
		}
		if (frame.end === true) {
			pass(`stream ${watching} ended`);
			return;
		}
		if (frame.item !== undefined && (await handleItem(watching, frame.item))) return;
	}
}

async function main(): Promise<void> {
	pass(`target ${base}`);
	try {
		await channelOpen;
		pass("mux channel open");
	} catch (error) {
		fail(String(error));
		process.exit(1);
	}

	const health = await request("GET", "/api/health");
	pass(`health ${health.status} ${JSON.stringify(health.payload)}`);

	const models = await request("GET", "/api/models");
	pass(`models ${models.status} (${(models.payload as { models?: unknown[] }).models?.length ?? 0})`);

	// A row's name is its identity, so the list endpoint is the one place a collision can be caught before
	// it reaches disk: two rows named the same would make every transcript naming that name ambiguous.
	// The name is deliberately unlikely to collide with anything the person running this has imported.
	// The trailing check restores what it found, since this is the one request here that persists.
	const existing = (models.payload as { models?: unknown[] }).models ?? [];
	const probe = `smoke-api-${Date.now()}`;
	const row = { name: probe, baseUrl: "http://127.0.0.1:1/v1", modelId: "smoke-api-model" };
	const saved = await request("PUT", "/api/models", { models: [...existing, row] });
	if (saved.status !== 200) fail(`importing a row answered ${saved.status}, expected 200`);
	else pass("a row with a name of its own is imported");
	const collision = await request("PUT", "/api/models", { models: [...existing, row, { ...row, modelId: "other" }] });
	if (collision.status !== 400) fail(`a duplicate name answered ${collision.status}, expected 400`);
	else pass("a duplicate name is refused with 400");
	const restored = await request("PUT", "/api/models", { models: existing });
	if (restored.status !== 200) fail(`restoring the model list answered ${restored.status}, expected 200`);
	else pass("and the list it was given is put back");

	// The default a new session opens on is the one settings field that names a row, so it is the one
	// that can name a row that is not there. A typo is refused rather than stored: `selectModel` falls
	// back to the first row, so a stored-but-wrong default would look like a preference that quietly did
	// nothing. Only the refusal is checked — accepting one writes the settings file, and this script
	// leaves the machine as it found it.
	const unknownDefault = await request("PATCH", "/api/settings", {
		patch: { model: `${probe}-gone/smoke-api-model` },
	});
	if (unknownDefault.status !== 409) fail(`an unknown default model answered ${unknownDefault.status}, expected 409`);
	else pass("a default model that names no row is refused (409)");

	const first = await request("POST", "/api/sessions");
	if (first.status !== 201) throw new Error(`could not create a session: ${first.status}`);
	pass(`created ${(first.payload as { sessionId: string }).sessionId}`);

	// A session that does not exist must be a 404 on the read URL, not a snapshot of nothing.
	const missing = await request("GET", "/api/sessions/does-not-exist");
	if (missing.status !== 404) fail(`an unknown session answered ${missing.status}, expected 404`);

	// The tree over HTTP, with nothing attached at any point. A move is recorded by the store the
	// moment it happens, so it survives the reap that follows the run — no stream has to hold the
	// session's hand, and the run below doubles as the acceptance edge that says sending does not
	// depend on attaching first: its frames go nowhere, and it is recorded all the same.
	const tree = await request("POST", "/api/sessions");
	const treeId = (tree.payload as { sessionId: string }).sessionId;

	// A prompt is persisted before its run fails, and the failure does record an assistant message, so
	// the message this branches at is on the chain with one continuation behind it already.
	const asked = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/messages`, { text: "branch at this message" });
	if (asked.status !== 202) fail(`a prompt on the session to branch answered ${asked.status}, expected 202`);
	if (!(await settleRun(treeId))) fail("the run never settled, so the branch could not be checked");

	const read = await request("GET", `/api/sessions/${encodeURIComponent(treeId)}`);
	const before = (read.payload as { session: TreeSession }).session;
	const entry = before.messageEntryIds.find((id): id is string => typeof id === "string");
	if (entry === undefined) {
		fail("the session to branch at has no message entry");
	} else {
		const moved = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/branch`, { entryId: entry, descend: false });
		const after = (moved.payload as { session?: TreeSession }).session;
		if (moved.status !== 200) fail(`a branch move answered ${moved.status}, expected 200`);
		else if (after?.leafId !== entry) fail(`the branch landed on ${String(after?.leafId)}, expected ${entry}`);
		else pass("branch move accepted (200), and the leaf is the entry it named");

		if (!Array.isArray(after?.branchPoints)) fail("the snapshot carried no branch points");
		else if (after.branchPoints.length > 0) fail(`one chain reported ${after.branchPoints.length} branch point(s)`);
		else pass("a snapshot reports the branch points it has, none for one chain");

		// Nothing is attached, so nothing holds the session: the move's own request was the last claim,
		// and the host closes as soon as it settles — within milliseconds, there being no grace period
		// left (the one the SSE streams served went with them). This wait is what makes the cold read
		// below honest: a session still hosted would answer with the same live snapshot and prove
		// nothing.
		await sleep(2_000);

		// The cold read answers from the file, and the leafId it reports is the moved entry — "because
		// the leaf is persisted" made observable: the move lives in the file, not in some resident
		// Agent. Were the leaf memory-only, a reaped session would answer with its file's last entry —
		// the leaf record itself, not the entry it names.
		const cold = await request("GET", `/api/sessions/${encodeURIComponent(treeId)}`);
		const coldLeaf = (cold.payload as { session: TreeSession }).session.leafId;
		if (coldLeaf !== entry) fail(`the cold read reports leafId ${String(coldLeaf)}, expected the moved ${entry}`);
		else pass("the move survived the reap: a cold read reports the leaf the file recorded");

		// The next prompt is assembled from the file by a brand-new host, and it continues from the
		// recorded position: the message it writes is a child of the moved entry, which is what turns
		// that entry into a branch point.
		const again = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/messages`, { text: "and another way" });
		if (again.status !== 202) fail(`the second prompt answered ${again.status}, expected 202`);
		if (!(await settleRun(treeId))) fail("the second run never settled");

		const reread = await request("GET", `/api/sessions/${encodeURIComponent(treeId)}`);
		const points = (reread.payload as { session: TreeSession }).session.branchPoints;
		const point = points.find((candidate) => candidate.entryId === entry);
		if (points.length !== 1 || point === undefined) fail(`the entry became ${points.length} branch point(s), not one`);
		else if (point.options.length !== 2) fail(`the branch point has ${point.options.length} options, expected 2`);
		else if (point.options.filter((option) => option.active).length !== 1) fail("no single option is marked active");
		else pass(`the next prompt continued from the moved leaf: ${point.options.map((option) => `${option.role}:${option.label}`).join(" | ")}`);

		const noEntry = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/branch`, {});
		if (noEntry.status !== 400) fail(`a branch with no entryId answered ${noEntry.status}, expected 400`);
		const unknownEntry = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/branch`, { entryId: "no-such-entry" });
		if (unknownEntry.status !== 409) fail(`a branch at an unknown entry answered ${unknownEntry.status}, expected 409`);
		const unknownSession = await request("POST", "/api/sessions/does-not-exist/branch", { entryId: "x" });
		if (unknownSession.status !== 404) fail(`a branch on an unknown session answered ${unknownSession.status}, expected 404`);

		// An approval answer for an id nothing is waiting on is a conflict, not a silent no-op: the
		// request was understood and refused. This session is idle, so every id is unanswerable here —
		// and a refused attempt must reach nothing, which the run staying settled confirms on the REST
		// face alone.
		const unknownApproval = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/approvals/no-such-call`, { approved: true });
		if (unknownApproval.status !== 409) fail(`an approval for an unanswerable id answered ${unknownApproval.status}, expected 409`);
		else if (!JSON.stringify(unknownApproval.payload).includes("not a pending approval")) fail(`the 409 body does not say what was refused: ${JSON.stringify(unknownApproval.payload)}`);
		else pass("an approval for an id nothing waits on is refused (409)");

		const fork = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/forks`, { entryId: entry });
		const forkedId = (fork.payload as { sessionId?: string }).sessionId;
		if (fork.status !== 201 || forkedId === undefined) {
			fail(`forking the session to branch answered ${fork.status}`);
		} else {
			const sessions = await request("GET", "/api/sessions");
			const listed = (sessions.payload as { sessions: { id: string; parentId?: string }[] }).sessions.find(
				(session) => session.id === forkedId,
			);
			if (listed?.parentId !== treeId) fail(`the fork lists parentId=${String(listed?.parentId)}, expected ${treeId}`);
			else pass("the listing gives a fork its parent by id, which is what the tree is drawn from");

			// The rename and the delete, over the same surface the row menu uses. A rename creates one
			// entry — 201 — and answers with the name it stored; a blank one is refused before the
			// file hears about it. A delete answers 200 and the session is a 404 ever after.
			const named = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/title`, { title: "改过的名字" });
			if (named.status !== 201) fail(`a rename answered ${named.status}, expected 201`);
			else if ((named.payload as { title?: string }).title !== "改过的名字") fail(`a rename answered ${JSON.stringify(named.payload)}`);
			else pass("a rename is accepted (201) and carries the stored name");
			const blank = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/title`, { title: "   " });
			if (blank.status !== 400) fail(`a blank rename answered ${blank.status}, expected 400`);
			else pass("a blank name is refused (400)");

			const removed = await request("DELETE", `/api/sessions/${encodeURIComponent(forkedId)}`);
			if (removed.status !== 200) fail(`a delete answered ${removed.status}, expected 200`);
			else pass("a delete is accepted (200)");
			const goneRead = await request("GET", `/api/sessions/${encodeURIComponent(forkedId)}`);
			if (goneRead.status !== 404) fail(`the deleted session answered ${goneRead.status}, expected 404`);
			else pass("and the deleted session is a 404 ever after");
			const again = await request("DELETE", `/api/sessions/${encodeURIComponent(forkedId)}`);
			if (again.status !== 404) fail(`a second delete answered ${again.status}, expected 404`);
			else pass("a second delete is a 404, not a silent no-op");
		}
	}

	await watch((first.payload as { sessionId: string }).sessionId);

	// Reaching here means the first stream was abandoned for the replacement session it asked for.
	if (replacementId === undefined) {
		fail("the first stream ended without a replacement session");
	} else {
		pass(`replacement ${replacementId}`);
		await watch(replacementId);
	}

	ws.close();
	clearTimeout(timer);
	pass(`\n${failed ? "FAILED" : "api ok"}`);
	process.exit(failed ? 1 : 0);
}

await main();
