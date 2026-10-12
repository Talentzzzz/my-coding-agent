// Ad-hoc transport check: read a session snapshot over server-sent events, accept a prompt over
// HTTP, feed the stream back, stop a run with an abort request, and start a replacement session.
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

/** Turn a byte stream into whole SSE frames: one JSON document per `data:` line, blocks split on a blank line. */
async function readStream(body: ReadableStream<Uint8Array>): Promise<void> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let buffer = "";

	for (;;) {
		const { value, done } = await reader.read();
		if (done) return;
		buffer += decoder.decode(value, { stream: true });

		let boundary = buffer.indexOf("\n\n");
		while (boundary >= 0) {
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			// A `:` line is the keep-alive comment; anything else is not a payload.
			const line = block.split("\n").find((candidate) => candidate.startsWith("data:"));
			if (line !== undefined) {
				const settled = await handleFrame(JSON.parse(line.slice(5).trim()) as { type: string; [key: string]: unknown });
				if (settled) {
					await reader.cancel();
					return;
				}
			}
			boundary = buffer.indexOf("\n\n");
		}
	}
}

/** Open an event stream for one session and read it. */
async function watch(watching: string): Promise<void> {
	sessionId = watching;
	const events = await fetch(`${base}/api/sessions/${encodeURIComponent(watching)}/events`, {
		headers: { accept: "text/event-stream" },
	});
	if (events.status !== 200) throw new Error(`event stream answered ${events.status}`);
	pass(`stream ${events.status} ${events.headers.get("content-type")}`);
	if (!events.body) throw new Error("the event stream had no body");
	await readStream(events.body);
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
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** The parts of a snapshot these checks read. */
interface TreeSession {
	leafId: string | null;
	submitting: boolean;
	messageEntryIds: (string | null)[];
	branchPoints: { entryId: string; options: { entryId: string; label: string; role: string; active: boolean }[] }[];
}

/**
 * Collect a stream's frames in the background.
 *
 * `readStream` above is the blocking half of this: it drives a session and returns when the run is over.
 * A check that has to *hold* a session open while it sends requests needs the same frames without
 * blocking, which is what this is — one claim, kept for as long as the check needs it, exactly the way a
 * window's own stream keeps one.
 */
function collectFrames(body: ReadableStream<Uint8Array>): {
	frames: { type: string; [key: string]: unknown }[];
	stop: () => Promise<void>;
} {
	const frames: { type: string; [key: string]: unknown }[] = [];
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	void (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				let boundary = buffer.indexOf("\n\n");
				while (boundary >= 0) {
					const block = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const line = block.split("\n").find((candidate) => candidate.startsWith("data:"));
					if (line !== undefined) frames.push(JSON.parse(line.slice(5).trim()) as { type: string });
					boundary = buffer.indexOf("\n\n");
				}
			}
		} catch {
			// A cancelled reader is one of the ways this loop ends.
		}
	})();

	return { frames, stop: () => reader.cancel().then(() => undefined) };
}

/** Wait for a collected frame to match. Waiting on the stream beats sleeping and hoping. */
async function awaitFrame(
	frames: readonly { type: string; [key: string]: unknown }[],
	match: (frame: { type: string; [key: string]: unknown }) => boolean,
	ms = 10_000,
): Promise<{ type: string; [key: string]: unknown } | undefined> {
	const deadline = Date.now() + ms;
	for (;;) {
		const found = frames.find(match);
		if (found !== undefined) return found;
		if (Date.now() > deadline) return undefined;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Returns true once the stream should be abandoned. */
async function handleFrame(message: { type: string; [key: string]: unknown }): Promise<boolean> {
	if (message.type === "session") {
		const session = message.session as {
			id: string;
			cwd: string;
			model: string;
			thinkingLevels: string[];
			approvals: Record<string, boolean>;
			messages: unknown[];
		};
		pass(
			`\nsession ${session.id}\n  cwd=${session.cwd}\n  model=${session.model}\n  thinking=${session.thinkingLevels.join(",")}\n  approvals=${JSON.stringify(session.approvals)}\n  messages=${session.messages.length}`,
		);

		// The second stream is the point of it: the server named a session, and this script attached to
		// it over HTTP exactly as a tab would. Nothing left to wait for.
		if (replacementId !== undefined && session.id === replacementId) return true;

		// A prompt is accepted, never awaited: this is the whole reason the transport is HTTP plus a
		// stream rather than one long request.
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

	if (message.type === "tool_approval_request") {
		const approval = message.request as { toolName: string; toolCallId: string };
		pass(`approval requested for ${approval.toolName}`);
		await request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approval.toolCallId)}`, {
			approved: false,
		});
		return false;
	}

	if (message.type === "session_event") {
		const event = message.event as {
			type: string;
			assistantMessageEvent?: { type: string; delta?: string };
			message?: { role?: string; errorMessage?: string; stopReason?: string };
		};
		if (process.env.MY_AGENT_TRACE === "1") pass(`  event ${event.type}`);
		if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta ?? "");
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
		// touching the stream, which is the whole difference from sending a command over the stream.
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

	if (message.type === "error") {
		fail(`server error: ${String(message.message)}`);
		return true;
	}
	return false;
}

async function main(): Promise<void> {
	pass(`target ${base}`);

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

	// A session that does not exist must be a 404 on the stream URL too, not a stream that opens.
	const missing = await request("GET", "/api/sessions/does-not-exist");
	if (missing.status !== 404) fail(`an unknown session answered ${missing.status}, expected 404`);

	// The tree over HTTP, under a stream held the way a window holds one: attached with the prompt whose
	// run it watches, because that is the shape this phase gives a stream. The claim it takes is what
	// keeps the leaf alive long enough for the move below to stay in memory.
	const tree = await request("POST", "/api/sessions");
	const treeId = (tree.payload as { sessionId: string }).sessionId;

	// A prompt is persisted before its run fails, and the failure does record an assistant message, so
	// the message this branches at is on the chain with one continuation behind it already.
	const held = await fetch(`${base}/api/sessions/${encodeURIComponent(treeId)}/events`, {
		headers: { accept: "text/event-stream" },
	});
	if (held.status !== 200 || !held.body) throw new Error(`the stream for the tree session answered ${held.status}`);
	const collected = collectFrames(held.body);

	const asked = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/messages`, { text: "branch at this message" });
	if (asked.status !== 202) fail(`a prompt on the session to branch answered ${asked.status}, expected 202`);
	if (!(await settleRun(treeId))) fail("the run never settled, so the branch could not be checked");

	const read = await request("GET", `/api/sessions/${encodeURIComponent(treeId)}`);
	const before = (read.payload as { session: TreeSession }).session;
	const entry = before.messageEntryIds.find((id): id is string => typeof id === "string");
	if (entry === undefined) {
		fail("the session to branch at has no message entry");
	} else {
		// The move has to be made inside a claim, because the leaf lives in memory and the run above
		// ended the stream that was holding one: the window that rewinds and asks again is the window
		// whose next run takes the claim, and this attaches for that run the way it does.
		const againHeld = await fetch(`${base}/api/sessions/${encodeURIComponent(treeId)}/events`, {
			headers: { accept: "text/event-stream" },
		});
		if (againHeld.status !== 200 || !againHeld.body) throw new Error(`the second stream answered ${againHeld.status}`);
		const againFrames = collectFrames(againHeld.body);

		const moved = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/branch`, { entryId: entry, descend: false });
		const after = (moved.payload as { session?: TreeSession }).session;
		if (moved.status !== 200) fail(`a branch move answered ${moved.status}, expected 200`);
		else if (after?.leafId !== entry) fail(`the branch landed on ${String(after?.leafId)}, expected ${entry}`);
		else pass("branch move accepted (200), and the leaf is the entry it named");

		if (!Array.isArray(after?.branchPoints)) fail("the snapshot carried no branch points");
		else if (after.branchPoints.length > 0) fail(`one chain reported ${after.branchPoints.length} branch point(s)`);
		else pass("a snapshot reports the branch points it has, none for one chain");

		// The move has to reach the window as a fresh snapshot, which is what stops a second window
		// showing the old chain.
		const reported = await awaitFrame(
			againFrames.frames,
			(frame) => frame.type === "session" && (frame.session as { leafId?: string | null } | undefined)?.leafId === entry,
		);
		if (reported === undefined) fail("no stream frame reported the moved leaf, so a second window would keep showing the old chain");
		else pass("the move was sent to the stream as a fresh snapshot");

		// Asking again from the entry it was rewound to is what turns that entry into a branch point: the
		// new message is a child of it rather than a continuation of its tip.
		const again = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/messages`, { text: "and another way" });
		if (again.status !== 202) fail(`the second prompt answered ${again.status}, expected 202`);
		if (!(await settleRun(treeId))) fail("the second run never settled");

		const reread = await request("GET", `/api/sessions/${encodeURIComponent(treeId)}`);
		const points = (reread.payload as { session: TreeSession }).session.branchPoints;
		const point = points.find((candidate) => candidate.entryId === entry);
		if (points.length !== 1 || point === undefined) fail(`the entry became ${points.length} branch point(s), not one`);
		else if (point.options.length !== 2) fail(`the branch point has ${point.options.length} options, expected 2`);
		else if (point.options.filter((option) => option.active).length !== 1) fail("no single option is marked active");
		else pass(`the rewound entry is a branch point: ${point.options.map((option) => `${option.role}:${option.label}`).join(" | ")}`);

		const announced = await awaitFrame(
			againFrames.frames,
			(frame) =>
				frame.type === "session" &&
				((frame.session as { branchPoints?: { entryId: string }[] } | undefined)?.branchPoints ?? []).some(
					(candidate) => candidate.entryId === entry,
				),
		);
		if (announced === undefined) fail("the stream never reported the new branch point, so a window's switcher would wait for a reload");
		else pass("the append that made a branch point was sent to the stream too");
		await againFrames.stop();

		const noEntry = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/branch`, {});
		if (noEntry.status !== 400) fail(`a branch with no entryId answered ${noEntry.status}, expected 400`);
		const unknownEntry = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/branch`, { entryId: "no-such-entry" });
		if (unknownEntry.status !== 409) fail(`a branch at an unknown entry answered ${unknownEntry.status}, expected 409`);
		const unknownSession = await request("POST", "/api/sessions/does-not-exist/branch", { entryId: "x" });
		if (unknownSession.status !== 404) fail(`a branch on an unknown session answered ${unknownSession.status}, expected 404`);

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
		}
	}

	await collected.stop();

	await watch((first.payload as { sessionId: string }).sessionId);

	// Reaching here means the first stream was abandoned for the replacement session it asked for.
	if (replacementId === undefined) {
		fail("the first stream ended without a replacement session");
	} else {
		pass(`replacement ${replacementId}`);
		await watch(replacementId);
	}

	clearTimeout(timer);
	pass(`\n${failed ? "FAILED" : "api ok"}`);
	process.exit(failed ? 1 : 0);
}

await main();
