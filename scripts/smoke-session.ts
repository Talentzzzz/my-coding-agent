// Session-level smoke test: drives a real Agent against the scripted transport, so streaming,
// queueing, and steering are testable without a provider key.
// Run with: node scripts/smoke-session.ts
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@my-agent/loop";
import type { Message } from "@my-agent/llm";
import type { AssistantMessage, ChatTransport, SimpleStreamOptions } from "@my-agent/llm";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall, type FakeResponseStep } from "./fake-transport.ts";
import {
	createToolRegistry,
	MAX_TOOL_RESULT_BYTES,
	openAgent,
	SessionManager,
	SettingsManager,
	Workspace,
	type Agent,
	type AgentSessionEvent,
	type FileDiff,
	type ModelSource,
	type Settings,
	type SessionEntry,
	type ToolRegistry,
	type ModelConfig,
	workspaceDir,
} from "@my-agent/core";

// `@my-agent/llm` and `@my-agent/loop` are workspace packages, linked into the repository root's
// node_modules so scripts resolve them the same way `packages/core` does.

const root = await mkdtemp(join(tmpdir(), "my-agent-session-"));
let failures = 0;

// A hung step must fail loudly rather than leave the script running: every exercise prints a heading,
// so the last heading printed names the step that hung.
const watchdog = setTimeout(() => {
	process.stdout.write("\nFAIL the run did not settle within 60 s\n");
	process.exit(1);
}, 60_000);

/**
 * The row every session in this smoke runs on.
 *
 * One row and one scripted transport, because that is what the app has: a model is a row the user
 * typed, and the only thing standing between it and a request is the key in that row. A check that
 * needs a second model adds a second row.
 */
const ROW: ModelConfig = {
	name: "faux",
	baseUrl: "http://127.0.0.1:1/v1",
	apiKey: "unused-by-the-scripted-transport",
	id: "faux-1",
	contextWindow: 128_000,
	maxTokens: 16_384,
	reasoning: false,
};

/** The rows the sessions read. Shared, so every check counts responses from one queue. */
const rows: ModelConfig[] = [ROW];
const models: ModelSource = { list: () => rows };
const fake = createFakeTransport();

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/**
 * Run a promise with a deadline that records a failure when it is exceeded.
 *
 * `ok: false` means the timeout fired, which is why callers assert on `ok` rather than the value:
 * a `void` promise resolving to `undefined` would otherwise look identical to a timeout.
 */
async function within<T>(label: string, ms: number, work: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<{ ok: false }>((resolve) => {
		timer = setTimeout(() => {
			check(`${label} settles`, false, `still pending after ${ms} ms`);
			resolve({ ok: false });
		}, ms);
	});
	try {
		const value = await Promise.race([work.then((value) => ({ ok: true as const, value })), timeout]);
		return value;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

interface Gate {
	/** Let the held provider call answer. Safe to call more than once. */
	release(): void;
	/** How many provider calls have been held so far. */
	readonly held: number;
	/** How many provider calls have reached this transport. */
	readonly calls: number;
}

/**
 * A transport whose first `hold` calls stop inside the request.
 *
 * The scripted transport answers as soon as the loop asks, which leaves no window in which to send a
 * message mid-run. Delaying the first call is what makes "while streaming" observable at all. The
 * gate is applied before the session is built, because `Agent` captures the transport when it
 * constructs its `Loop`.
 */
function gatedTransport(hold = 1): { api: ChatTransport; gate: Gate } {
	const call = fake.api.stream.bind(fake.api);
	let held = 0;
	let calls = 0;
	const releases: (() => void)[] = [];

	const stream: ChatTransport["stream"] = async (model, context, options) => {
		calls += 1;
		if (held < hold) {
			held += 1;
			await new Promise<void>((resolve) => releases.push(resolve));
		}
		return call(model, context, options);
	};

	return {
		api: { stream },
		gate: {
			release: () => {
				for (const resolve of releases.splice(0)) resolve();
			},
			get held() {
				return held;
			},
			get calls() {
				return calls;
			},
		},
	};
}

/**
 * The shared rows, with the one row reporting a different context window.
 *
 * Compaction's trigger is the model's own window minus a fixed 33k reserve, so a session-level check
 * of it moves the window rather than a setting. Only the row is copied: the scripted responses and
 * `fake.state` stay the shared ones every check counts on.
 */
function windowedRows(contextWindow: number): ModelSource {
	return { list: () => rows.map((row) => ({ ...row, contextWindow })) };
}

/**
 * Wait until a run has actually reached the provider, or record a failure.
 *
 * Waiting for `isLooping` alone is not enough: the session reports that before `prepareRequest` runs, so
 * a test that released the gate on that signal could release it before the call arrived, and the call
 * would then wait for a release that already happened.
 */
async function whenStreaming(session: Agent, gate: Gate, ms = 5_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < ms) {
		if (session.isLooping && gate.held >= 1) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	check("a run reached the provider", false, `streaming=${session.isLooping} held=${gate.held} after ${ms} ms`);
}

/** Poll until `ready` holds, so a check reads a state the loop reaches asynchronously. */
async function until(ready: () => boolean, ms = 5_000): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < ms) {
		if (ready()) return true;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return ready();
}

/**
 * The retry policy these checks run with.
 *
 * The backoff is 10 ms because these are assertions about *whether* an attempt is retried, not about
 * how long the package sleeps; the policy's own arithmetic is the dependency's to test.
 */
function retryPolicy(overrides: Partial<Settings["retry"]> = {}): Settings["retry"] {
	return { enabled: true, maxRetries: 3, baseDelayMs: 10, maxAgentDelayMs: 60_000, ...overrides };
}

function settings(overrides: Partial<Settings> = {}): Settings {
	return {
		approval: { read: false, write: false, edit: false, glob: false, grep: false, bash: false },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		retry: retryPolicy(),
		...overrides,
	};
}

/** What one run is driven through: which rows a session reads, and which transport it sends over. */
interface RunOptions {
	models?: ModelSource;
	api?: ChatTransport;
}

/**
 * One session over its own transcript, with settings that live in memory.
 *
 * `SettingsManager.inMemory` is the seam that keeps these runs off the developer's
 * `~/.my-agent/settings.json`: it has the same shape as the file-backed manager, so a config change
 * here is written and read back exactly as it would be for real —just nowhere.
 */
async function openSession(
	overrides: Partial<Settings> = {},
	run: RunOptions = {},
	model?: string,
	tools?: ToolRegistry,
): Promise<Agent> {
	const sessionManager = SessionManager.create(root);
	return openAgent({
		absWorkspaceRoot: root,
		sessionManager,
		models: run.models ?? models,
		api: run.api ?? fake.api,
		model,
		settingsManager: SettingsManager.inMemory(settings(overrides)),
		tools,
	});
}

function textsOf(session: Agent): string[] {
	return session.snapshot.messages.filter((message) => message.role === "user").map((message) => textOf(message));
}

/** Every entry in the log, header aside, including branches the session is no longer on. */
function entriesOf(session: Agent): SessionEntry[] {
	return session.sessionManager.getEntries();
}

/**
 * Every message ever written, not just the ones still in context.
 *
 * A compaction removes messages from the model's view, never from the file, so "the store kept it" is
 * always a question about this list rather than about the transcript.
 */
function allMessages(session: Agent): Message[] {
	return entriesOf(session).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

/** Each stored message as "role:text", in store order — the shape most ordering assertions compare. */
function orderOf(session: Agent): string[] {
	return allMessages(session).map((message) => `${message.role}:${textOf(message)}`);
}

/** Ids of the message entries whose text matches, in log order. */
function entryIdsFor(session: Agent, text: string): string[] {
	return entriesOf(session)
		.filter((entry) => entry.type === "message" && textOf(entry.message) === text)
		.map((entry) => entry.id);
}

function textOf(message: Message): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const typed = block as { type?: unknown; text?: unknown };
			return typed.type === "text" ? String(typed.text ?? "") : "";
		})
		.join("");
}

interface SentRequest {
	/** System text the provider was handed: the prompt the model actually received. */
	prompt: string;
	/** Tool names that request declared available. */
	tools: string[];
	/** Every message's text, in the order the provider was handed them. */
	texts: string[];
	/** Every message's role, in the same order. */
	roles: string[];
	/** The key the request would have authenticated with, as the transport was handed it. */
	apiKey: string | undefined;
}

/**
 * Script the next provider calls and record what each request carried.
 *
 * The response factory is handed the transcript the provider was sent, and that is the only place the
 * prompt the model received can be read back: `snapshot` reports the conversation, not the prompt. The
 * same is true of a tool result a hook rewrote: only the request says what the model was shown.
 */
function recordRequests(seen: SentRequest[], responses: AssistantMessage[]): void {
	fake.setResponses(
		responses.map((response) => (
			context: { messages: readonly unknown[]; tools?: readonly { name?: string }[] },
			options?: SimpleStreamOptions,
		) => {
			seen.push({
				prompt: context.messages
					.filter((message) => (message as { role?: string }).role === "system")
					.map((message) => textOf(message as Message))
					.join("\n\n"),
				tools: declaredTools(context),
				texts: context.messages.map((message) => textOf(message as Message)),
				roles: context.messages.map((message) => String((message as { role?: string }).role ?? "")),
				apiKey: options?.apiKey,
			});
			return response;
		}),
	);
}

/** Tool names the request declares. They travel on the context, not inside a message. */
function declaredTools(context: { tools?: readonly { name?: string }[] }): string[] {
	return (context.tools ?? []).map((tool) => String(tool.name));
}

/** The tools line of the prompt, which is the part of it the active set decides. */
function availableTools(prompt: string): string {
	return prompt.match(/## Tools\nAvailable: ([^\n]*)/)?.[1] ?? "";
}

/** The tools the prompt says ask for approval, which is the part of it the approval set decides. */
function approvalTools(prompt: string): string {
	return prompt.match(/ask the user for approval before running: ([^.]*)\./)?.[1] ?? "";
}

/** The text of the transcript's tool results, oldest first. */
function toolResultTexts(session: Agent): string[] {
	return allMessages(session)
		.filter((message) => message.role === "toolResult")
		.map((message) => textOf(message));
}

/**
 * A follow-up sent mid-run is accepted, queued, and drained when the turn ends.
 *
 * The transcript must hold both user messages exactly once, and in the order the loop took them: the
 * queued message is written when the loop echoes it — behind the answer it interrupted — rather than
 * when it was accepted.
 */
async function exerciseFollowUp(): Promise<void> {
	process.stdout.write("followUp\n");
	fake.setResponses([fakeAssistantMessage("first answer"), fakeAssistantMessage("second answer")]);
	const { api: gatedApi, gate } = gatedTransport();
	const session = await openSession({}, { api: gatedApi });
	// Counted from here rather than asserted absolutely: the queue is shared by every exercise, so
	// what this check is about is the calls this run made.
	const base = fake.state.callCount;

	const echoed: string[] = [];
	session.onEvent((event) => {
		if (event.type === "message_end" && event.message.role === "user") echoed.push(textOf(event.message));
	});

	const running = session.prompt("first question");
	await whenStreaming(session, gate);
	check("the first run is streaming", session.isLooping === true);
	check("the provider call is held open", gate.held === 1, String(gate.held));
	check("nothing is queued yet", session.snapshot.queued === 0, String(session.snapshot.queued));

	const queued = await within("followUp prompt", 5_000, session.prompt("second question", { behavior: "followUp" }));
	check("followUp resolves mid-run instead of throwing", queued.ok);
	check("snapshot.queued is 1 before the turn ends", session.snapshot.queued === 1, String(session.snapshot.queued));

	gate.release();
	await within("the run", 10_000, running);
	await within("settle()", 10_000, session.settle());

	const users = textsOf(session);
	check("the transcript holds both user messages", users.length === 2, JSON.stringify(users));
	check("the first exactly once", users.filter((text) => text === "first question").length === 1, JSON.stringify(users));
	check("the second exactly once", users.filter((text) => text === "second question").length === 1, JSON.stringify(users));
	// The loop's own emit of the drained message *is* the write — nothing wrote it at acceptance — so
	// "once" here means the echo landed, not that a duplicate was deduplicated away.
	check("the drain point injected the queued message", echoed.includes("second question"), JSON.stringify(echoed));
	check("two provider calls were made", fake.state.callCount - base === 2, String(fake.state.callCount - base));
	check("nothing is queued after settling", session.snapshot.queued === 0, String(session.snapshot.queued));

	await session.close();
}

/**
 * `steer` is taken without waiting for the turn; `followUp` waits for it to end.
 *
 * One held provider call gives the injection a window, and what the two queues do in it is what
 * separates them: a steered message goes into the running turn, so the depth a composer shows stays
 * zero, while a follow-up is still waiting and counted. Neither is written yet — the loop's echo is
 * the write — so the entry lands behind the answer it interrupted, and once.
 */
async function exerciseSteerVersusFollowUp(): Promise<void> {
	process.stdout.write("steer versus followUp\n");
	const scenarios = [
		{ behavior: "steer" as const, counted: false },
		{ behavior: "followUp" as const, counted: true },
	];

	for (const scenario of scenarios) {
		fake.setResponses([fakeAssistantMessage("first answer"), fakeAssistantMessage("second answer")]);
		const { api: gatedApi, gate } = gatedTransport();
		const session = await openSession({}, { api: gatedApi });

		const running = session.prompt("question one");
		await whenStreaming(session, gate);
		await session.prompt("queued now", { behavior: scenario.behavior });

		const duringStreaming = entryIdsFor(session, "queued now");
		check(
			`${scenario.behavior} is not written while the run is streaming`,
			duringStreaming.length === 0,
			JSON.stringify(duringStreaming),
		);
		check(
			scenario.counted ? "and the queue counts it" : "and the queue does not count it",
			session.snapshot.queued === (scenario.counted ? 1 : 0),
			String(session.snapshot.queued),
		);

		gate.release();
		await within("the run", 10_000, running);
		await within("settle()", 10_000, session.settle());

		const after = entryIdsFor(session, "queued now");
		check(`${scenario.behavior} is in the store exactly once`, after.length === 1, JSON.stringify(after));
		// The order is the reason the write waits for the drain: the store's order is the order the loop
		// replayed, which is what the next request is built from and what a baseline replays.
		const order = orderOf(session);
		check(
			`${scenario.behavior} is filed behind the answer it interrupted`,
			JSON.stringify(order) ===
				JSON.stringify(["user:question one", "assistant:first answer", "user:queued now", "assistant:second answer"]),
			JSON.stringify(order),
		);
		await session.close();
	}
}

/**
 * A message accepted mid-run is filed behind the answer it interrupted, and the next request reads it
 * there.
 *
 * This is what the deferred write buys, and it is two facts rather than one: the store's order, and
 * the provider's view of it. `prepareRequest` builds the second out of the first, so a session whose
 * file puts the follow-up in front of the answer would send the model exactly that.
 */
async function exerciseAcceptedOrder(): Promise<void> {
	process.stdout.write("accepted message order\n");
	const sent: SentRequest[] = [];
	recordRequests(sent, [fakeAssistantMessage("first answer"), fakeAssistantMessage("second answer")]);
	const { api: gatedApi, gate } = gatedTransport();
	const session = await openSession({}, { api: gatedApi });

	const running = session.prompt("question one");
	await whenStreaming(session, gate);
	await session.prompt("asked while it was answering", { behavior: "followUp" });
	check(
		"nothing is written at acceptance",
		entryIdsFor(session, "asked while it was answering").length === 0,
		JSON.stringify(entryIdsFor(session, "asked while it was answering")),
	);

	gate.release();
	await within("the run", 10_000, running);
	await within("settle()", 10_000, session.settle());

	const order = orderOf(session);
	check(
		"the store reads the way the loop replayed it",
		JSON.stringify(order) ===
			JSON.stringify(["user:question one", "assistant:first answer", "user:asked while it was answering", "assistant:second answer"]),
		JSON.stringify(order),
	);
	check(
		"the first request carried the question alone",
		JSON.stringify(sent[0]?.texts.slice(1)) === JSON.stringify(["question one"]),
		JSON.stringify(sent[0]?.texts),
	);
	check(
		"the request the follow-up opened carried it behind that answer",
		JSON.stringify(sent[1]?.roles.slice(1)) === JSON.stringify(["user", "assistant", "user"]),
		JSON.stringify(sent[1]?.roles),
	);
	check(
		"with the texts in the same order",
		JSON.stringify(sent[1]?.texts.slice(1)) ===
			JSON.stringify(["question one", "first answer", "asked while it was answering"]),
		JSON.stringify(sent[1]?.texts),
	);

	await session.close();
}

/**
 * A message accepted mid-run that the run never reaches is still written, once, at the end.
 *
 * An abort is the ordinary way this happens: the loop stops before its next drain point, so nothing
 * will ever take the message off the queue. Letting it go would lose words the user typed and would
 * leave the depth above zero — which is what `settle()` waits on.
 */
async function exerciseAbortFlushesAccepted(): Promise<void> {
	process.stdout.write("abort flushes the queue\n");
	fake.setResponses([fakeAssistantMessage("an answer that never lands")]);
	const { api: gatedApi, gate } = gatedTransport();
	const session = await openSession({}, { api: gatedApi });

	const running = session.prompt("question before the abort");
	await whenStreaming(session, gate);
	await session.prompt("typed while it was answering", { behavior: "followUp" });
	check("the run is streaming with one message queued", session.isLooping && session.snapshot.queued === 1, String(session.snapshot.queued));

	const aborting = session.abort();
	// The held call has to answer before the aborted run can end; the abort's own signal is what turns
	// that answer into the end.
	gate.release();
	await within("the run", 10_000, running);
	await within("abort()", 10_000, aborting);
	await within("settle()", 10_000, session.settle());

	const order = orderOf(session);
	check("the aborted run still ends with what the user typed", order.at(-1) === "user:typed while it was answering", JSON.stringify(order));
	check(
		"written exactly once",
		order.filter((line) => line === "user:typed while it was answering").length === 1,
		JSON.stringify(order),
	);
	check("and the queue is empty, which is what settle() waits on", session.snapshot.queued === 0, String(session.snapshot.queued));

	await session.close();
}

/** `followUpMode: "one-at-a-time"` drains one queued message per turn, not the whole queue. */
async function exerciseQueueMode(): Promise<void> {
	process.stdout.write("one-at-a-time\n");
	const base = fake.state.callCount;
	fake.setResponses([fakeAssistantMessage("answer one"), fakeAssistantMessage("answer two"), fakeAssistantMessage("answer three")]);
	const { api: gatedApi, gate } = gatedTransport(2);
	const session = await openSession({ followUpMode: "one-at-a-time" }, { api: gatedApi });

	const running = session.prompt("turn one");
	await whenStreaming(session, gate);
	await session.prompt("turn two", { behavior: "followUp" });
	await session.prompt("turn three", { behavior: "followUp" });
	check("two messages are queued", session.snapshot.queued === 2, String(session.snapshot.queued));

	// Release the first turn. The loop then starts exactly one queued turn and stops inside that
	// request, which is the hold that makes the drain count observable.
	gate.release();
	await gateHeld(gate);
	check("exactly one queued message was drained", session.snapshot.queued === 1, String(session.snapshot.queued));
	check("and the loop has started its second request", gate.calls === 2, String(gate.calls));
	// The drained message is in the transcript, the waiting one is still only on a queue — the depth is
	// what reports it, and since the write waits for the drain the transcript shows it too.
	const soFar = orderOf(session);
	check(
		"the transcript holds the drained message and not the waiting one",
		JSON.stringify(soFar) === JSON.stringify(["user:turn one", "assistant:answer one", "user:turn two"]),
		JSON.stringify(soFar),
	);

	gate.release();
	await within("the run", 10_000, running);
	await within("settle()", 10_000, session.settle());
	check("the rest drained once the run ended", session.snapshot.queued === 0, String(session.snapshot.queued));
	check("all three user messages are present", textsOf(session).length === 3, JSON.stringify(textsOf(session)));
	check("three provider calls were made", fake.state.callCount - base === 3, `${fake.state.callCount - base}`);

	await session.close();
}

/** Wait until the gate has held the call it was waiting for and the provider has actually been asked. */
async function gateHeld(gate: Gate, held = 2, ms = 5_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < ms) {
		if (gate.held >= held && gate.calls >= held) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	check("the next provider call was reached", false, `held=${gate.held} calls=${gate.calls} after ${ms} ms`);
}

/** A listener can read the live queue depth and streaming state while the run is in flight. */
async function exerciseLiveStates(): Promise<void> {
	process.stdout.write("live states\n");
	fake.setResponses([fakeAssistantMessage("only answer"), fakeAssistantMessage("queued answer")]);
	const { api: gatedApi, gate } = gatedTransport();
	const session = await openSession({}, { api: gatedApi });

	const queuedSeen: number[] = [];
	const streamingSeen: boolean[] = [];
	session.onEvent(() => {
		queuedSeen.push(session.snapshot.queued);
		streamingSeen.push(session.isLooping);
	});

	const running = session.prompt("live question");
	await whenStreaming(session, gate);
	await session.prompt("live follow-up", { behavior: "followUp" });
	check("the snapshot reports the queue while the run is live", session.snapshot.queued === 1, String(session.snapshot.queued));

	gate.release();
	await within("the run", 10_000, running);
	await within("settle()", 10_000, session.settle());

	check("a listener saw the streaming window", streamingSeen.includes(true), JSON.stringify(streamingSeen));
	check("and the queued count went from 0 to 1 to 0", queuedSeen.includes(0) && queuedSeen.includes(1), JSON.stringify(queuedSeen));
	check("the transcript kept both messages", textsOf(session).length === 2, JSON.stringify(textsOf(session)));

	await session.close();
}

/** A short name for an event, for the failure details when an order assertion breaks. */
function labelOf(event: AgentSessionEvent): string {
	if (event.type === "message_start" || event.type === "message_end") return `${event.type}:${event.message.role}`;
	return event.type;
}

/**
 * One listener sees the whole session vocabulary: the write `prompt` made, the loop's own
 * message_start/message_end, the queue depth, and every entry as it lands.
 *
 * Flattening is what makes this readable from one subscription: the loop's events and the session's
 * own members arrive in one stream, ordered by what actually happened. For the message that started
 * the run that means the write comes first; for a drained one it means the queue reports the
 * acceptance, the entry lands at the drain, and the loop's own echo follows.
 */
async function exerciseEventStream(): Promise<void> {
	process.stdout.write("session events\n");
	fake.setResponses([fakeAssistantMessage("first answer"), fakeAssistantMessage("second answer")]);
	const { api: gatedApi, gate } = gatedTransport();
	const session = await openSession({}, { api: gatedApi });

	const seen: AgentSessionEvent[] = [];
	session.onEvent((event) => seen.push(event));

	const running = session.prompt("event question one");
	await whenStreaming(session, gate);
	await session.prompt("event question two", { behavior: "followUp" });

	gate.release();
	await within("the run", 10_000, running);
	await within("settle()", 10_000, session.settle());

	const persisted = entriesOf(session).filter((entry) => entry.type === "message").map((entry) => entry.id);
	// Only the message entries: the first request of a branch that records nothing also announces the
	// `model_change` and `thinking_level_change` it writes, and those are checked where they are written.
	const appended = seen.flatMap((event) =>
		event.type === "entry_appended" && event.kind === "message" ? [event.entryId] : [],
	);
	const trace = JSON.stringify(seen.map(labelOf));

	const first = seen[0];
	check(
		"the optimistic write is the first event, before the loop starts",
		first !== undefined && first.type === "entry_appended" && first.entryId === persisted[0],
		trace,
	);
	check(
		"every persisted message entry was announced, in store order",
		JSON.stringify(appended) === JSON.stringify(persisted),
		`appended=${JSON.stringify(appended)} store=${JSON.stringify(persisted)}`,
	);

	const asked = seen.findIndex((event) => event.type === "message_start" && event.message.role === "user");
	const answered = seen.findIndex((event) => event.type === "message_end" && event.message.role === "assistant");
	check("the loop's own message_start reaches the same listener", asked > 0, trace);
	check("and so does its message_end", answered > asked, trace);

	const queuedEntry = entryIdsFor(session, "event question two")[0];
	const written = seen.findIndex((event) => event.type === "entry_appended" && event.entryId === queuedEntry);
	const queuedUpdate = seen.findIndex((event) => event.type === "queue_update" && event.queued === 1);
	const drainedStart = seen.findIndex(
		(event) => event.type === "message_start" && event.message.role === "user" && textOf(event.message) === "event question two",
	);
	const drainedEnd = seen.findIndex(
		(event) => event.type === "message_end" && event.message.role === "user" && textOf(event.message) === "event question two",
	);
	check(
		"the queue reports the message while nothing is written yet",
		queuedUpdate >= 0 && written > queuedUpdate && queuedUpdate < drainedStart,
		`queue=${queuedUpdate} write=${written} start=${drainedStart}`,
	);
	check(
		"the write is the drain, in the same breath as the echo and before its end",
		written === drainedStart + 1 && drainedEnd === drainedStart + 2,
		`start=${drainedStart} write=${written} end=${drainedEnd}`,
	);
	check("and the depth returns to zero once drained", seen.some((event) => event.type === "queue_update" && event.queued === 0), trace);

	await session.close();
}

/**
 * Compaction replaces history with a summary the model wrote, and announces both.
 *
 * The summary is one extra provider call, so the scripted responses carry it in the order the requests
 * happen: answer, answer, summary, then the answer to the prompt whose request triggered the
 * compaction. What the assertions are really about is the transcript: the summarized messages leave the
 * model's view, the summary takes their place, and the file keeps everything.
 */
async function exerciseCompactionEvent(): Promise<void> {
	process.stdout.write("compaction event\n");
	const base = fake.state.callCount;
	const summary = "SUMMARY: the user asked two questions and both were answered.";
	const sent: SentRequest[] = [];
	recordRequests(sent, [
		fakeAssistantMessage("answer one"),
		fakeAssistantMessage("answer two"),
		fakeAssistantMessage(summary),
		fakeAssistantMessage("answer three"),
	]);
	// A 33,035-token window is the smallest one whose reserve is still the full 33k, which puts the
	// trigger at 35 estimated tokens: between the transcript the second question produces (~27) and the
	// one the third produces (~41), so exactly one compaction happens, on the third request. Nothing is
	// kept verbatim, so the cut lands on the newest turn start —the question just asked —and the two
	// completed exchanges are what it folds in.
	const session = await openSession({}, { models: windowedRows(33_035) });

	const announced: Extract<AgentSessionEvent, { type: "compaction" }>[] = [];
	session.onEvent((event) => {
		if (event.type === "compaction") announced.push(event);
	});

	const questions = [
		"question one with enough words to estimate tokens",
		"question two with enough words to estimate tokens",
		"question three with enough words to estimate tokens",
	];
	for (const text of questions) {
		const run = await within("a run", 10_000, session.prompt(text));
		check(`"${text.slice(0, 12)}..." completes`, run.ok);
	}
	await within("settle()", 10_000, session.settle());

	check("exactly one compaction was announced", announced.length === 1, JSON.stringify(announced.length));
	const event = announced[0];
	check("carrying the summary the model produced", event?.summary === summary, JSON.stringify(event?.summary));
	// The third prompt is already written when its request is prepared, so the cut lands on that turn
	// start and the two completed exchanges are what the summary stands for.
	check("with the messages it stands for", event?.summarized === 4, JSON.stringify(event?.summarized));
	check("and a live estimate of what is still in context", (event?.contextTokens ?? 0) > 0, JSON.stringify(event?.contextTokens));
	check("four provider calls were made: three answers and one summary", fake.state.callCount - base === 4, String(fake.state.callCount - base));
	// The summary is a request like any other, so it authenticates like one: the key rides on the model
	// the summary is made with, which is what makes compaction work on a session whose row has a key and
	// whose key the loop is not there to copy in — this call never travels through the loop.
	check("and the summary carried the row's key", sent[2]?.apiKey === ROW.apiKey, String(sent[2]?.apiKey));

	// The transcript the provider was sent for the third question is where compaction shows: the two
	// summarized exchanges are gone, and the summary is there in their place.
	const last = sent[3];
	check(
		"the next request carries the summary",
		(last?.texts ?? []).some((text) => text.includes(summary)),
		JSON.stringify(last?.texts),
	);
	check(
		"and no longer carries what it replaced",
		(last?.texts ?? []).every((text) => !text.includes("question one") && !text.includes("answer one")),
		JSON.stringify(last?.texts),
	);
	check(
		"the prompt it was asked still is",
		(last?.texts ?? []).some((text) => text === questions[2]),
		JSON.stringify(last?.texts),
	);

	// The file is the record of everything: the summarized messages are still entries, and the
	// compaction is one entry of its own naming where the model picks up again.
	const entryTypes = entriesOf(session).map((entry) => entry.type);
	check("the transcript still holds every message", allMessages(session).length === 6, JSON.stringify(allMessages(session).length));
	check("and one compaction entry", entryTypes.filter((type) => type === "compaction").length === 1, JSON.stringify(entryTypes));
	const kept = entriesOf(session).find((entry) => entry.type === "message" && textOf(entry.message) === questions[2]);
	check("whose first kept entry is the surviving turn", event?.firstKeptEntryId === kept?.id, `${event?.firstKeptEntryId} vs ${kept?.id}`);

	await session.close();
}

/** `applyConfig` says what moved and nothing else: unchanged fields stay out of the event. */
async function exerciseConfigChanged(): Promise<void> {
	process.stdout.write("config changed\n");
	// A second row gives the source a second model, so a model change is observable at all. Both are
	// answered by the same scripted transport: nothing here sends a request.
	const twoRows: ModelConfig[] = [ROW, { ...ROW, name: "faux2" }];
	const session = await openSession({}, { models: { list: () => twoRows } }, "faux/faux-1");

	const seen: Extract<AgentSessionEvent, { type: "config_changed" }>[] = [];
	session.onEvent((event) => {
		if (event.type === "config_changed") seen.push(event);
	});

	session.applyConfig({ approval: { bash: true } });
	check("one config_changed for the approval", seen.length === 1, JSON.stringify(seen));
	check(
		"carrying only the approval that changed",
		JSON.stringify(seen[0]) === JSON.stringify({ type: "config_changed", approvals: { bash: true } }),
		JSON.stringify(seen[0]),
	);

	session.applyConfig({ approval: { bash: true } });
	check("re-applying the same value says nothing", seen.length === 1, JSON.stringify(seen));
	session.applyConfig({});
	check("an empty patch says nothing", seen.length === 1, JSON.stringify(seen));

	session.applyConfig({ approval: { bash: false, read: true } });
	check(
		"only the two approvals that moved are reported",
		seen.length === 2 && JSON.stringify(Object.entries(seen[1]?.approvals ?? {}).sort()) === JSON.stringify([["bash", false], ["read", true]]),
		JSON.stringify(seen[1]),
	);

	// The composer's choice, which is not a config patch: it moves the session and nothing else.
	session.applyModelSelection({ model: "faux2" });
	check(
		"a model change carries the model alone",
		seen.length === 3 && JSON.stringify(seen[2]) === JSON.stringify({ type: "config_changed", model: "faux2" }),
		JSON.stringify(seen[2]),
	);
	session.applyModelSelection({ model: "faux2" });
	check("re-selecting the current model says nothing", seen.length === 3, JSON.stringify(seen));

	check("the row does not reason, so its only level is off", JSON.stringify(session.thinkingLevels) === JSON.stringify(["off"]), JSON.stringify(session.thinkingLevels));
	session.applyModelSelection({ thinkingLevel: "off" });
	check("so re-applying it says nothing", seen.length === 3, JSON.stringify(seen));

	// The whole point of choosing on the composer: a choice no request was made with is not something
	// that happened, so nothing about it is in the transcript. Both rows are the same wire id, so this
	// is the level half as well — neither has been asked at yet.
	check(
		"and none of it is written down before a request uses it",
		session.sessionManager.getRecordedSettings().model === undefined &&
			session.sessionManager.getRecordedSettings().thinkingLevel === undefined,
		JSON.stringify(session.sessionManager.getRecordedSettings()),
	);

	await session.close();
}

/**
 * A `before_tool` handler the test registers sees the call, and its refusal becomes a tool error.
 *
 * The handler is registered after the session's own defaults, so this is also the order the seam
 * promises: a host's handler runs second and can refine what the approval gate decided.
 */
async function exerciseBeforeToolHook(): Promise<void> {
	process.stdout.write("before_tool hook\n");
	const seen: { toolCallId: string; toolName: string; args: unknown }[] = [];
	const sent: SentRequest[] = [];
	recordRequests(sent, [
		fakeAssistantMessage(fakeToolCall("read", { path: "never-read.txt" })),
		fakeAssistantMessage("understood"),
	]);
	const session = await openSession();

	session.hooks.on("before_tool", (event) => {
		seen.push({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
		return { block: { reason: "the smoke test refused this call" } };
	});

	await within("the run", 10_000, session.prompt("read never-read.txt"));
	await within("settle()", 10_000, session.settle());

	check("the handler saw the scripted call", seen.length === 1 && seen[0]?.toolName === "read", JSON.stringify(seen));
	check("with the call's own id", (seen[0]?.toolCallId ?? "").length > 0, JSON.stringify(seen));
	check("and its validated arguments", JSON.stringify(seen[0]?.args).includes("never-read.txt"), JSON.stringify(seen[0]?.args));

	const errored = allMessages(session).find(
		(message) => message.role === "toolResult" && textOf(message).includes("the smoke test refused this call"),
	);
	check(
		"the block is an errored tool result",
		errored !== undefined && (errored as { isError?: boolean }).isError === true,
		JSON.stringify(allMessages(session).map((message) => [message.role, textOf(message).slice(0, 30)])),
	);
	check(
		"which the next request carries, so the model can see it",
		(sent[1]?.texts ?? []).some((text) => text.includes("the smoke test refused this call")),
		JSON.stringify(sent[1]?.texts),
	);
	check("and the tool never ran", (sent[1]?.texts ?? []).every((text) => !text.includes("File not found")), JSON.stringify(sent[1]?.texts));
	check(
		"the run carried on to an answer",
		session.snapshot.messages.some((message) => message.role === "assistant" && textOf(message) === "understood"),
	);

	await session.close();
}

/**
 * A test `after_tool` handler rewrites what the model is shown, and the transcript keeps what the tool
 * returned: the seam decides the context, the store decides the record.
 */
async function exerciseAfterToolHook(): Promise<void> {
	process.stdout.write("after_tool hook\n");
	await writeFile(join(root, "hook.txt"), "the tool's own words", "utf8");
	const sent: SentRequest[] = [];
	recordRequests(sent, [
		fakeAssistantMessage(fakeToolCall("read", { path: "hook.txt" })),
		fakeAssistantMessage("read it"),
		fakeAssistantMessage("still replaced"),
	]);
	const session = await openSession();

	session.hooks.on("after_tool", (event) =>
		event.toolName === "read" ? { content: [{ type: "text", text: "REPLACED BY THE TEST HOOK" }] } : undefined,
	);

	await within("the first run", 10_000, session.prompt("read hook.txt"));
	await within("settle()", 10_000, session.settle());
	await within("the second run", 10_000, session.prompt("and what did it say"));
	await within("settle()", 10_000, session.settle());

	const first = sent[1]?.texts ?? [];
	check("the request after the call carries what the hook put there", first.some((text) => text.includes("REPLACED BY THE TEST HOOK")), JSON.stringify(first));
	check("and not what the tool returned", first.every((text) => !text.includes("the tool's own words")), JSON.stringify(first));
	check("a later request still carries it", (sent[2]?.texts ?? []).some((text) => text.includes("REPLACED BY THE TEST HOOK")), JSON.stringify(sent[2]?.texts));
	check(
		"while the transcript kept the tool's own output",
		toolResultTexts(session).some((text) => text.includes("the tool's own words")),
		JSON.stringify(toolResultTexts(session)),
	);

	await session.close();
}

/**
 * The output backstop clips a result the tool did not bound, and the transcript keeps it whole.
 *
 * The tool is registered by this test because every built-in bounds its own output; a tool that forgets
 * is exactly what the session-level budget is for.
 */
async function exerciseOutputBackstop(): Promise<void> {
	process.stdout.write("output backstop\n");
	const huge = `HEAD-${"A".repeat(MAX_TOOL_RESULT_BYTES)}-TAIL-MARKER`;
	const registry = createToolRegistry(new Workspace(root));
	registry.register({
		name: "unbounded",
		label: "unbounded",
		description: "Returns more than the session's budget; registered by the smoke test.",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: huge }] }),
	});

	const sent: SentRequest[] = [];
	recordRequests(sent, [
		fakeAssistantMessage(fakeToolCall("unbounded", {})),
		fakeAssistantMessage("clipped"),
		fakeAssistantMessage("again"),
	]);
	const session = await openSession({}, {}, undefined, registry);

	const delivered: string[] = [];
	session.onEvent((event) => {
		if (event.type === "tool_execution_end") delivered.push(textOf({ content: event.result?.content } as Message));
	});

	await within("the run", 10_000, session.prompt("run the unbounded tool"));
	await within("settle()", 10_000, session.settle());

	const shown = (sent[1]?.texts ?? []).find((text) => text.includes("HEAD-")) ?? "";
	check(
		"the transcript holds the tool's whole output",
		toolResultTexts(session).some((text) => text.length === huge.length && text.includes("-TAIL-MARKER")),
		JSON.stringify(toolResultTexts(session).map((text) => text.length)),
	);
	check(
		"the backstop clipped what the loop carried",
		delivered.some((text) => text.includes("characters omitted")),
		JSON.stringify(delivered.map((text) => text.length)),
	);
	check("so the request the model received is inside the budget", Buffer.byteLength(shown) <= MAX_TOOL_RESULT_BYTES, `${Buffer.byteLength(shown)} bytes`);
	check("with a notice that it was clipped", shown.includes("characters omitted"), shown.slice(0, 80));
	check("and it is shorter than what the tool returned", shown.length < huge.length, `${shown.length} of ${huge.length}`);
	check(
		"the stored result is not an error",
		allMessages(session).every((message) => (message as { isError?: boolean }).isError !== true),
		JSON.stringify(allMessages(session).map((message) => message.role)),
	);

	await session.close();
}

/**
 * The prompt is rebuilt every request, so an approval change reaches the model on the next one.
 *
 * Asserted from the request the provider received: the leading system message is the only place the
 * prompt exists, because the loop holds no prompt of its own and the store holds no prompt.
 */
async function exerciseApprovalPrompt(): Promise<void> {
	process.stdout.write("approval prompt\n");
	const sent: SentRequest[] = [];
	recordRequests(sent, [fakeAssistantMessage("first answer"), fakeAssistantMessage("second answer")]);
	const session = await openSession();

	await within("the first run", 10_000, session.prompt("what needs approval"));
	await within("settle()", 10_000, session.settle());
	check("no tool asks for approval yet", approvalTools(sent[0]?.prompt ?? "") === "", JSON.stringify(approvalTools(sent[0]?.prompt ?? "")));

	session.applyConfig({ approval: { bash: true } });
	await within("the second run", 10_000, session.prompt("and now"));
	await within("settle()", 10_000, session.settle());

	check(
		"the next request's leading system message names bash",
		approvalTools(sent[1]?.prompt ?? "") === "bash",
		JSON.stringify(approvalTools(sent[1]?.prompt ?? "")),
	);
	check("and that message still leads the request", sent[1]?.roles[0] === "system", JSON.stringify(sent[1]?.roles));
	check(
		"carrying the tool declarations as well",
		JSON.stringify(sent[1]?.tools) === JSON.stringify(session.activeTools),
		JSON.stringify(sent[1]?.tools),
	);
	check("the approval is in the snapshot too", session.snapshot.approvals.bash === true, JSON.stringify(session.snapshot.approvals));

	await session.close();
}

/**
 * A denial that came from somewhere other than a pressed "deny" says so in the transcript.
 *
 * The reason rides the answer into the tool result, so an approval a grace timer denied is recorded
 * as what happened — not as the same sentence a press of the button writes, which would record an
 * abandonment as a user's choice. A denial through `approve` itself carries no reason, and that is
 * the one case the fallback sentence is true for, so it keeps it.
 */
async function exerciseApprovalDenial(): Promise<void> {
	process.stdout.write("approval denial reason\n");

	const script = [fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("done")];

	// Denied by the abandonment path: the reason rides the answer into the tool result.
	const abandoned = await openSession({ approval: { read: true } });
	recordRequests([], script);
	const parked = within("the run to the gate", 10_000, abandoned.prompt("read the notes"));
	check(
		"the run parked at the approval",
		await until(() => abandoned.snapshot.pendingApprovals.length === 1),
		JSON.stringify(abandoned.snapshot.pendingApprovals),
	);
	const waiting = abandoned.snapshot.pendingApprovals[0]?.toolCallId ?? "";
	check("the predicate names the waiting call", abandoned.hasPendingApproval(waiting), waiting);
	check("an id nothing waits on is not pending", !abandoned.hasPendingApproval("no-such-call"));

	abandoned.denyAllApprovals("No window answered this approval.");
	check("the predicate cleared once the answer arrived", !abandoned.hasPendingApproval(waiting));
	const deniedRun = await parked;
	check("the denied run finished", deniedRun.ok);
	await within("settle()", 10_000, abandoned.settle());

	const denialResults = toolResultTexts(abandoned);
	check(
		"the tool result carries the denial's own reason",
		denialResults.some((text) => text.includes("No window answered this approval.")),
		JSON.stringify(denialResults),
	);
	check(
		"and not the sentence a pressed deny writes",
		denialResults.every((text) => !text.includes("The user denied permission to run")),
		JSON.stringify(denialResults),
	);
	check("the run carried on to an answer", abandoned.snapshot.messages.some((message) => message.role === "assistant" && textOf(message) === "done"));

	await abandoned.close();

	// Denied by a pressed "deny": no reason rides the answer, so the fallback sentence is the truth.
	const refused = await openSession({ approval: { read: true } });
	recordRequests([], script);
	const refusedRun = within("the second run to the gate", 10_000, refused.prompt("read the notes"));
	check(
		"the second run parked at the approval",
		await until(() => refused.snapshot.pendingApprovals.length === 1),
		JSON.stringify(refused.snapshot.pendingApprovals),
	);
	refused.approve(refused.snapshot.pendingApprovals[0]?.toolCallId ?? "", false);
	const refusedResult = await refusedRun;
	check("the refused run finished", refusedResult.ok);
	await within("settle()", 10_000, refused.settle());

	const refusedResults = toolResultTexts(refused);
	check(
		"a pressed deny still says the user denied it",
		refusedResults.some((text) => text.includes("The user denied permission to run read.")),
		JSON.stringify(refusedResults),
	);

	await refused.close();
}

/**
 * Every tool change is resent with the request, never declared as a later system message.
 *
 * The leading system message is rebuilt from the live active set before each request, so a tool
 * switched off between two requests is absent from the second one's tool list and no extra system
 * message is appended to carry the change.
 */
async function exerciseToolChangeResend(): Promise<void> {
	process.stdout.write("tool change resend\n");
	const sent: SentRequest[] = [];
	recordRequests(sent, [fakeAssistantMessage("first answer"), fakeAssistantMessage("second answer")]);
	const session = await openSession();

	await within("the first run", 10_000, session.prompt("which tools do you have"));
	await within("settle()", 10_000, session.settle());

	const dropped = "bash";
	const narrowed = session.snapshot.activeTools.filter((name) => name !== dropped);
	session.setActiveTools(narrowed);
	await within("the second run", 10_000, session.prompt("and now"));
	await within("settle()", 10_000, session.settle());

	check("the first request declared the tool", sent[0]?.tools.includes(dropped) === true, JSON.stringify(sent[0]?.tools));
	check(
		"the change was resent as the complete list on the next request",
		JSON.stringify(sent[1]?.tools) === JSON.stringify(narrowed),
		JSON.stringify(sent[1]?.tools),
	);
	check(
		"the request still opens with one system message",
		sent[1]?.roles.filter((role) => role === "system").length === 1,
		JSON.stringify(sent[1]?.roles),
	);
	check(
		"and no system message was recorded for the change",
		session.snapshot.messages.every((message) => message.role !== "system"),
		JSON.stringify(session.snapshot.messages.map((message) => message.role)),
	);

	await session.close();
}

/**
 * The registry on its own: definitions, the active set, and the one rule that keeps them apart.
 *
 * `executionMode` is checked here because it is the reason the registry stores no such state: it is a
 * field on each tool, so narrowing the active set cannot change how a tool runs.
 */
async function exerciseToolRegistry(): Promise<void> {
	process.stdout.write("tool registry\n");
	const registry = createToolRegistry(new Workspace(root));
	const builtIns = ["read", "write", "edit", "glob", "grep", "bash"];

	check("all() holds the six built-ins in registration order", JSON.stringify(registry.all().map((tool) => tool.name)) === JSON.stringify(builtIns), JSON.stringify(registry.all().map((tool) => tool.name)));
	check("and every one starts active", JSON.stringify(registry.activeNames()) === JSON.stringify(builtIns), JSON.stringify(registry.activeNames()));
	check("get() finds a registered tool", registry.get("bash")?.name === "bash");
	check("get() returns undefined for a name nobody registered", registry.get("nope") === undefined);
	check("executionMode is a field on the tool", registry.get("bash")?.executionMode === "sequential", String(registry.get("bash")?.executionMode));

	registry.setActive(["read"]);
	check("setActive narrows active()", JSON.stringify(registry.activeNames()) === JSON.stringify(["read"]), JSON.stringify(registry.activeNames()));
	check("while all() keeps every definition", registry.all().length === 6, String(registry.all().length));

	let threw = false;
	try {
		registry.setActive(["read", "nope"]);
	} catch {
		threw = true;
	}
	check("setActive throws on an unknown name", threw);
	check("and the active set is untouched by the throw", JSON.stringify(registry.activeNames()) === JSON.stringify(["read"]), JSON.stringify(registry.activeNames()));

	const noop: AgentTool<any> = {
		name: "noop",
		label: "noop",
		description: "Does nothing; registered by the smoke test.",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "noop" }] }),
	};
	registry.register(noop);
	check("register() adds the tool and makes it callable", registry.get("noop") === noop && registry.activeNames().includes("noop"), JSON.stringify(registry.activeNames()));
}

/**
 * Deactivating a tool takes it out of the snapshot, the prompt, and the declarations the model gets.
 *
 * The prompt is read back from the provider request rather than from the registry: a prompt that still
 * named `write` would advertise a tool the loop then refuses to run.
 */
async function exerciseActiveTools(): Promise<void> {
	process.stdout.write("active tools\n");
	const sent: SentRequest[] = [];
	recordRequests(sent, [fakeAssistantMessage("first answer"), fakeAssistantMessage("second answer")]);
	const session = await openSession();

	const changes: string[][] = [];
	session.onEvent((event) => {
		if (event.type === "config_changed" && event.tools !== undefined) changes.push(event.tools);
	});

	await within("the run", 10_000, session.prompt("what can you do"));
	await within("settle()", 10_000, session.settle());
	check("the registry reports the built-ins and the delegation pair", JSON.stringify(session.snapshot.allTools) === JSON.stringify(["read", "write", "edit", "glob", "grep", "bash", "SubAgent", "SubAgentControl"]), JSON.stringify(session.snapshot.allTools));
	check("and the model was offered write", availableTools(sent[0]?.prompt ?? "").includes("write"), JSON.stringify(availableTools(sent[0]?.prompt ?? "")));
	check("which the request also declared", sent[0]?.tools.includes("write") === true, JSON.stringify(sent[0]?.tools));

	const narrowed = ["read", "edit", "glob", "grep", "bash"];
	session.setActiveTools(narrowed);
	check("snapshot.activeTools loses write", JSON.stringify(session.snapshot.activeTools) === JSON.stringify(narrowed), JSON.stringify(session.snapshot.activeTools));
	check("get activeTools() loses write", JSON.stringify(session.activeTools) === JSON.stringify(narrowed), JSON.stringify(session.activeTools));
	check("allTools still reports every registered tool", session.snapshot.allTools.length === 8, JSON.stringify(session.snapshot.allTools));
	check("the change is announced, so a client needs no new snapshot", JSON.stringify(changes) === JSON.stringify([narrowed]), JSON.stringify(changes));

	await within("the run", 10_000, session.prompt("and now"));
	await within("settle()", 10_000, session.settle());
	check("the next prompt no longer offers write", availableTools(sent[1]?.prompt ?? "").includes("write") === false, JSON.stringify(availableTools(sent[1]?.prompt ?? "")));
	check("while keeping the other tools", availableTools(sent[1]?.prompt ?? "").includes("read") && availableTools(sent[1]?.prompt ?? "").includes("bash"), JSON.stringify(availableTools(sent[1]?.prompt ?? "")));
	check("and the request declares the narrower set", JSON.stringify(sent[1]?.tools) === JSON.stringify(narrowed), JSON.stringify(sent[1]?.tools));
	check("both asks are in the transcript", textsOf(session).length === 2, JSON.stringify(textsOf(session)));

	await session.close();
}

/** A scripted call to a tool that is not active is a tool error, and the tool never runs. */
async function exerciseDeactivatedToolCall(): Promise<void> {
	process.stdout.write("deactivated tool call\n");
	const session = await openSession();
	session.setActiveTools(["read", "edit", "glob", "grep", "bash"]);

	const ends: { toolName: string; isError: boolean; text: string }[] = [];
	session.onEvent((event) => {
		if (event.type === "tool_execution_end") {
			ends.push({ toolName: event.toolName, isError: event.isError, text: textOf({ content: event.result?.content } as Message) });
		}
	});

	recordRequests([], [fakeAssistantMessage(fakeToolCall("write", { path: "blocked.txt", content: "nope" })), fakeAssistantMessage("done")]);
	await within("the run", 10_000, session.prompt("write blocked.txt"));
	await within("settle()", 10_000, session.settle());

	check("the deactivated call ran and failed", ends.length === 1 && ends[0]?.toolName === "write" && ends[0]?.isError === true, JSON.stringify(ends));
	check("with a not-found error rather than a result", ends[0]?.text.includes("not found") === true, JSON.stringify(ends[0]?.text));
	check("the tool did not touch the workspace", (await access(join(root, "blocked.txt")).then(() => true, () => false)) === false);
	check(
		"the transcript records it as an errored tool result",
		allMessages(session).some((message) => (message as { role?: string; isError?: boolean }).role === "toolResult" && (message as { isError?: boolean }).isError === true),
		JSON.stringify(allMessages(session).map((message) => message.role)),
	);
	check("the run carried on to an answer", session.snapshot.messages.some((message) => message.role === "assistant" && textOf(message) === "done"));

	await session.close();
}

/** An unknown name is refused before anything moves, so the session keeps the set it had. */
async function exerciseUnknownTool(): Promise<void> {
	process.stdout.write("unknown tool\n");
	const session = await openSession();
	const before = JSON.stringify(session.activeTools);

	const seen: AgentSessionEvent[] = [];
	session.onEvent((event) => seen.push(event));

	let threw = false;
	try {
		session.setActiveTools(["read", "nope"]);
	} catch {
		threw = true;
	}
	check("setActiveTools throws on an unknown name", threw);
	check("the session keeps its previous active set", JSON.stringify(session.activeTools) === before, `${before} -> ${JSON.stringify(session.activeTools)}`);
	check("and no change was announced", seen.every((event) => event.type !== "config_changed"), JSON.stringify(seen.map(labelOf)));

	fake.setResponses([fakeAssistantMessage("still here")]);
	const run = await within("the run", 10_000, session.prompt("still working?"));
	check("the session still runs after the refusal", run.ok);
	await within("settle()", 10_000, session.settle());
	check("and answers", session.snapshot.messages.some((message) => message.role === "assistant" && textOf(message) === "still here"));

	await session.close();
}

/** No active tools is a conversation without tools, not a broken session. */
async function exerciseEmptyToolSet(): Promise<void> {
	process.stdout.write("empty tool set\n");
	const sent: SentRequest[] = [];
	recordRequests(sent, [fakeAssistantMessage("a conversation it is")]);
	const session = await openSession();

	session.setActiveTools([]);
	check("an empty active set is allowed", JSON.stringify(session.snapshot.activeTools) === "[]", JSON.stringify(session.snapshot.activeTools));
	check("with nothing active and everything still registered", session.snapshot.allTools.length === 8, JSON.stringify(session.snapshot.allTools));

	const run = await within("the run", 10_000, session.prompt("hello without tools"));
	check("a session with no tools still holds a conversation", run.ok);
	await within("settle()", 10_000, session.settle());

	check("the model was told there are none", availableTools(sent[0]?.prompt ?? "") === "none.", JSON.stringify(availableTools(sent[0]?.prompt ?? "")));
	check("and was offered no declarations at all", JSON.stringify(sent[0]?.tools) === "[]", JSON.stringify(sent[0]?.tools));
	check("the question is in the transcript", textsOf(session).includes("hello without tools"), JSON.stringify(textsOf(session)));
	check("and so is the answer", session.snapshot.messages.some((message) => message.role === "assistant" && textOf(message) === "a conversation it is"));

	await session.close();
}

/** One failed provider call, in the shape the scripted transport streams: an error with no content. */
function failedAttempt(errorMessage: string): AssistantMessage {
	return fakeAssistantMessage("", { stopReason: "error", errorMessage });
}

/** A retry event, flattened to the fields these checks assert on. */
interface RetryTrace {
	type: string;
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
	errorMessage?: string;
	success?: boolean;
	finalError?: string;
}

/**
 * Two retryable failures and then a success: one turn, three calls, one assistant message.
 *
 * The failed attempts must be invisible everywhere the conversation is read: the transcript, the
 * transcript the model is sent next, and the user's own text, which `prompt` persisted before the
 * first attempt and which no retry may write again.
 */
async function exerciseRetry(): Promise<void> {
	process.stdout.write("retry\n");
	const base = fake.state.callCount;
	const sent: SentRequest[] = [];
	recordRequests(sent, [
		failedAttempt("503 service unavailable"),
		failedAttempt("overloaded"),
		fakeAssistantMessage("recovered"),
		fakeAssistantMessage("second answer"),
	]);
	const session = await openSession();

	const trace: RetryTrace[] = [];
	const live: { retrying: boolean; attempt: number }[] = [];
	session.onEvent((event) => {
		if (event.type === "retry_scheduled") {
			trace.push({
				type: event.type,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			});
			live.push({ retrying: session.isRetrying, attempt: session.retryAttempt });
			return;
		}
		if (event.type === "retry_start") {
			trace.push({ type: event.type, attempt: event.attempt, maxAttempts: event.maxAttempts });
			return;
		}
		if (event.type === "retry_end") {
			trace.push({ type: event.type, attempt: event.attempt, success: event.success, finalError: event.finalError });
		}
	});

	await within("the run", 10_000, session.prompt("retry question"));
	await within("settle()", 10_000, session.settle());

	check(
		"each failure is announced, waited out, and closed once",
		JSON.stringify(trace.map((event) => event.type)) ===
			JSON.stringify(["retry_scheduled", "retry_start", "retry_scheduled", "retry_start", "retry_end"]),
		JSON.stringify(trace),
	);
	check(
		"the first retry carries its attempt, budget, backoff and error",
		JSON.stringify(trace[0]) ===
			JSON.stringify({ type: "retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "503 service unavailable" }),
		JSON.stringify(trace[0]),
	);
	check("the backoff doubles per attempt", trace[2]?.delayMs === 20, JSON.stringify(trace[2]));
	check(
		"and the loop ends on the successful retry",
		JSON.stringify(trace[4]) === JSON.stringify({ type: "retry_end", attempt: 2, success: true }),
		JSON.stringify(trace[4]),
	);
	check(
		"the snapshot reports the attempt while it waits",
		JSON.stringify(live) === JSON.stringify([{ retrying: true, attempt: 1 }, { retrying: true, attempt: 2 }]),
		JSON.stringify(live),
	);

	check("three provider calls answered one question", fake.state.callCount - base === 3, String(fake.state.callCount - base));
	check(
		"the transcript holds one user turn",
		JSON.stringify(textsOf(session)) === JSON.stringify(["retry question"]),
		JSON.stringify(textsOf(session)),
	);
	const assistants = session.snapshot.messages.filter((message) => message.role === "assistant");
	check(
		"and one assistant message, the answer that came back",
		assistants.length === 1 && textOf(assistants[0]!) === "recovered",
		JSON.stringify(assistants.map(textOf)),
	);
	check(
		"no failed attempt reached the transcript",
		allMessages(session).every(
			(message) => !textOf(message).includes("503") && !textOf(message).includes("overloaded"),
		),
		JSON.stringify(allMessages(session).map((message) => [message.role, textOf(message)])),
	);
	check(
		"and nothing is retrying once it answered",
		session.isRetrying === false && session.retryAttempt === 0 && session.snapshot.isRetrying === false,
		`retrying=${session.isRetrying} attempt=${session.retryAttempt}`,
	);

	await within("the second run", 10_000, session.prompt("second question"));
	await within("settle()", 10_000, session.settle());

	const next = sent[3];
	check(
		"the next request carries the question exactly once",
		(next?.texts ?? []).filter((text) => text === "retry question").length === 1,
		JSON.stringify(next?.texts),
	);
	check(
		"and no leftover error message",
		(next?.texts ?? []).every((text) => !text.includes("503") && !text.includes("overloaded")),
		JSON.stringify(next?.texts),
	);
	check(
		"with one assistant message in front of it",
		(next?.roles ?? []).filter((role) => role === "assistant").length === 1,
		JSON.stringify(next?.roles),
	);

	await session.close();
}

/**
 * A failure the classifier calls deterministic is not retried, and the run ends as it always did.
 *
 * A quota or billing error is the case that matters: retrying it costs the user more failures and the
 * same message, and only delays the error they have to act on.
 */
async function exerciseNonRetryableError(): Promise<void> {
	process.stdout.write("non-retryable error\n");
	const base = fake.state.callCount;
	fake.setResponses([failedAttempt("insufficient_quota: billing hard limit reached")]);
	const session = await openSession();

	const trace: string[] = [];
	session.onEvent((event) => {
		if (event.type.startsWith("retry_")) trace.push(event.type);
	});

	await within("the run", 10_000, session.prompt("quota question"));
	await within("settle()", 10_000, session.settle());

	check("the provider was asked once", fake.state.callCount - base === 1, String(fake.state.callCount - base));
	check("nothing was retried", trace.length === 0, JSON.stringify(trace));
	check(
		"the error is what the run ends on",
		session.snapshot.messages.some(
			(message) =>
				message.role === "assistant" &&
				`${(message as { errorMessage?: string }).errorMessage ?? ""}`.includes("insufficient_quota"),
		),
		JSON.stringify(session.snapshot.messages.map((message) => [message.role, textOf(message)])),
	);
	check(
		"and nothing claims to be retrying",
		session.isRetrying === false && session.retryAttempt === 0,
		`retrying=${session.isRetrying} attempt=${session.retryAttempt}`,
	);

	await session.close();
}

/** The budget runs out: the last error is the transcript's, and the session stops retrying. */
async function exerciseRetryExhaustion(): Promise<void> {
	process.stdout.write("retry exhausted\n");
	const base = fake.state.callCount;
	fake.setResponses([
		failedAttempt("503 first"),
		failedAttempt("503 second"),
		failedAttempt("503 third"),
		fakeAssistantMessage("never reached"),
	]);
	const session = await openSession({ retry: retryPolicy({ maxRetries: 2 }) });

	const trace: RetryTrace[] = [];
	session.onEvent((event) => {
		if (event.type === "retry_scheduled") {
			trace.push({ type: event.type, attempt: event.attempt, maxAttempts: event.maxAttempts });
		}
		if (event.type === "retry_end") {
			trace.push({ type: event.type, attempt: event.attempt, success: event.success, finalError: event.finalError });
		}
	});

	await within("the run", 10_000, session.prompt("doomed question"));
	await within("settle()", 10_000, session.settle());

	check("the budget is the first call plus maxRetries", fake.state.callCount - base === 3, String(fake.state.callCount - base));
	check(
		"two retries were scheduled and closed",
		JSON.stringify(trace) ===
			JSON.stringify([
				{ type: "retry_scheduled", attempt: 1, maxAttempts: 2 },
				{ type: "retry_scheduled", attempt: 2, maxAttempts: 2 },
				{ type: "retry_end", attempt: 2, success: false, finalError: "503 third" },
			]),
		JSON.stringify(trace),
	);
	check(
		"the last error is the one the transcript shows",
		session.snapshot.messages.some(
			(message) => message.role === "assistant" && (message as { errorMessage?: string }).errorMessage === "503 third",
		),
		JSON.stringify(session.snapshot.messages.map((message) => [message.role, textOf(message)])),
	);
	check(
		"and the session stopped retrying",
		session.isRetrying === false &&
			session.retryAttempt === 0 &&
			session.snapshot.isRetrying === false &&
			session.snapshot.retryAttempt === 0,
		`retrying=${session.isRetrying} attempt=${session.retryAttempt}`,
	);

	await session.close();
}

/**
 * `abort()` during the backoff cancels the retry, not just a live call.
 *
 * The session does not implement the cancellation: the run's abort signal is the one the retry sleeps
 * on, so the sleep ends, the package normalizes the attempt to an aborted message, and the run
 * finishes. What has to hold is that `settle()` returns long before the backoff would have.
 */
async function exerciseRetryAbort(): Promise<void> {
	process.stdout.write("retry abort\n");
	const base = fake.state.callCount;
	fake.setResponses([failedAttempt("503 while aborted"), fakeAssistantMessage("never reached")]);
	// A backoff long enough to be cancelled inside it, and short enough to fail fast if it is not.
	const session = await openSession({ retry: retryPolicy({ baseDelayMs: 1_000 }) });

	const scheduled = new Promise<void>((resolve) => {
		session.onEvent((event) => {
			if (event.type === "retry_scheduled") resolve();
		});
	});

	const running = session.prompt("abort question");
	await within("the backoff", 5_000, scheduled);
	check(
		"the retry is pending, not the provider",
		session.isRetrying === true && session.retryAttempt === 1,
		String(session.retryAttempt),
	);

	const aborted = await within("abort()", 5_000, session.abort());
	check("abort() returns", aborted.ok);
	const settled = await within("settle()", 2_000, session.settle());
	check("settle() resolves instead of waiting out the backoff", settled.ok);
	check("the retry is over", session.isRetrying === false && session.retryAttempt === 0, `retrying=${session.isRetrying}`);
	check("the provider was asked once", fake.state.callCount - base === 1, String(fake.state.callCount - base));
	check(
		"the partial turn is on disk",
		entryIdsFor(session, "abort question").length === 1,
		JSON.stringify(entriesOf(session).map((entry) => entry.type)),
	);

	await within("the run", 5_000, running);
	await session.close();
}

/** `retry.enabled: false` is the behaviour before retries existed, failure for failure. */
async function exerciseRetryDisabled(): Promise<void> {
	process.stdout.write("retry disabled\n");
	const base = fake.state.callCount;
	fake.setResponses([failedAttempt("503 no retries for me"), fakeAssistantMessage("plain answer")]);
	const session = await openSession({ retry: retryPolicy({ enabled: false }) });

	const trace: string[] = [];
	session.onEvent((event) => {
		if (event.type.startsWith("retry_")) trace.push(event.type);
	});

	await within("the failed run", 10_000, session.prompt("no retry question"));
	await within("settle()", 10_000, session.settle());

	check("one call, as before", fake.state.callCount - base === 1, String(fake.state.callCount - base));
	check("no retry was announced", trace.length === 0, JSON.stringify(trace));
	check(
		"the error ends the run, as before",
		session.snapshot.messages.some(
			(message) =>
				message.role === "assistant" &&
				(message as { errorMessage?: string }).errorMessage === "503 no retries for me",
		),
		JSON.stringify(session.snapshot.messages.map((message) => [message.role, textOf(message)])),
	);

	fake.setResponses([fakeAssistantMessage("plain answer")]);
	await within("the healthy run", 10_000, session.prompt("and now normally"));
	await within("settle()", 10_000, session.settle());

	check(
		"a healthy call still streams through untouched",
		session.snapshot.messages.some((message) => message.role === "assistant" && textOf(message) === "plain answer"),
		JSON.stringify(session.snapshot.messages.map((message) => [message.role, textOf(message)])),
	);
	check(
		"and the snapshot never claims to be retrying",
		session.isRetrying === false && session.snapshot.retryAttempt === 0,
		`retrying=${session.isRetrying}`,
	);

	await session.close();
}

/**
 * Context overflow is not transient, so the retry budget is not spent on it.
 *
 * It stays compaction's problem: `prepareRequest` compacts before every request, and an overflow that
 * still reaches the provider is reported as the failure it is. The message here deliberately reads
 * like a transient one, so what keeps it out of the retry loop is the overflow check and not the
 * classifier's word list.
 */
async function exerciseContextOverflow(): Promise<void> {
	process.stdout.write("context overflow is not transient\n");
	const base = fake.state.callCount;
	fake.setResponses([
		failedAttempt("503 prompt is too long: 250000 tokens > 200000 maximum"),
		fakeAssistantMessage("never reached"),
	]);
	const session = await openSession();

	const trace: string[] = [];
	session.onEvent((event) => {
		if (event.type.startsWith("retry_")) trace.push(event.type);
	});

	await within("the run", 10_000, session.prompt("overflow question"));
	await within("settle()", 10_000, session.settle());

	check("an overflow is asked once", fake.state.callCount - base === 1, String(fake.state.callCount - base));
	check("no retry was scheduled for it", trace.length === 0, JSON.stringify(trace));
	check(
		"and the overflow is what the run ends on",
		session.snapshot.messages.some(
			(message) =>
				message.role === "assistant" &&
				`${(message as { errorMessage?: string }).errorMessage ?? ""}`.includes("prompt is too long"),
		),
		JSON.stringify(session.snapshot.messages.map((message) => [message.role, textOf(message)])),
	);
	check(
		"with nothing left retrying",
		session.isRetrying === false && session.retryAttempt === 0,
		`retrying=${session.isRetrying}`,
	);

	await session.close();
}

/**
 * A summarization that fails leaves the transcript exactly as it was and says so.
 *
 * This is the case that matters most about summary-based compaction: the summary is what replaces the
 * history, so a partial or failed one must never become the checkpoint. The third request is where the
 * failure shows —it still carries both earlier exchanges, because nothing was folded away.
 */
async function exerciseCompactionFailure(): Promise<void> {
	process.stdout.write("compaction failure\n");
	const sent: SentRequest[] = [];
	recordRequests(sent, [
		fakeAssistantMessage("answer one"),
		fakeAssistantMessage("answer two"),
		failedAttempt("summarization blew up"),
		fakeAssistantMessage("answer three"),
	]);
	const session = await openSession({}, { models: windowedRows(33_035) });

	const announced: string[] = [];
	session.onEvent((event) => {
		if (event.type === "compaction" || event.type === "compaction_failed") announced.push(event.type);
	});

	const questions = [
		"question one with enough words to estimate tokens",
		"question two with enough words to estimate tokens",
		"question three with enough words to estimate tokens",
	];
	for (const text of questions) {
		const run = await within("a run", 10_000, session.prompt(text));
		check(`"${text.slice(0, 12)}..." completes`, run.ok);
	}
	await within("settle()", 10_000, session.settle());

	check("the failure is announced and no compaction is", JSON.stringify(announced) === JSON.stringify(["compaction_failed"]), JSON.stringify(announced));
	check(
		"nothing was written as a checkpoint",
		entriesOf(session).every((entry) => entry.type !== "compaction"),
		JSON.stringify(entriesOf(session).map((entry) => entry.type)),
	);
	check(
		"so the next request still carries what it would have replaced",
		(sent[3]?.texts ?? []).some((text) => text.includes("question one")) &&
			(sent[3]?.texts ?? []).some((text) => text.includes("answer one")),
		JSON.stringify(sent[3]?.texts),
	);
	check("and the run carried on to an answer", session.snapshot.messages.some((message) => message.role === "assistant" && textOf(message) === "answer three"));

	await session.close();
}

/**
 * The model a request is made with is derived from the live row, key and all.
 *
 * This is the whole of what the provider registry used to do, and the reason the key can ride on the
 * model at all: the row is read before every request and turned into a model there, so nothing about
 * it — not the key, not the endpoint, not the window, not the wire id — is captured when the session
 * is assembled. The second half is the case that only works because of it: editing a row while a
 * session is open, which must reach the very next message without reopening anything.
 */
async function exerciseModelFromRow(): Promise<void> {
	process.stdout.write("the model comes from the row\n");

	const sent: { key: string | undefined; baseUrl: string; id: string; alsoInOptions: string | undefined }[] = [];
	const recording: ChatTransport = {
		stream: (model, context, options) => {
			sent.push({
				key: model.apiKey,
				baseUrl: model.baseUrl,
				id: model.id,
				alsoInOptions: options?.apiKey,
			});
			return fake.api.stream(model, context, options);
		},
	};

	const keyedRows: ModelConfig[] = [{ ...ROW, name: "keyed", apiKey: "first-key", baseUrl: "http://127.0.0.1:1/v1" }];
	const source: ModelSource = { list: () => keyedRows };
	fake.setResponses([fakeAssistantMessage("answered")]);
	const session = await openSession({}, { models: source, api: recording });
	await within("the run", 10_000, session.prompt("hello"));
	check("the model carries the row's key", sent[0]?.key === "first-key", String(sent[0]?.key));
	check(
		"and the transport is handed the same key",
		sent[0]?.alsoInOptions === "first-key",
		String(sent[0]?.alsoInOptions),
	);
	check("the model names the row it came from", session.modelName === "keyed", session.modelName);

	// No catalog is rebuilt and no session reopened: the row is read again before the next request, so
	// every field of it is as fresh as the file was — not just the key.
	const changesOf = (): number => entriesOf(session).filter((entry) => entry.type === "model_change").length;
	const changesBefore = changesOf();
	keyedRows[0]!.apiKey = "corrected-key";
	keyedRows[0]!.baseUrl = "http://127.0.0.1:2/v1";
	fake.setResponses([fakeAssistantMessage("answered again")]);
	await within("the second run", 10_000, session.prompt("again"));
	check("a corrected key is used by the next message", sent[1]?.key === "corrected-key", String(sent[1]?.key));
	check("and so is a moved endpoint", sent[1]?.baseUrl === "http://127.0.0.1:2/v1", String(sent[1]?.baseUrl));
	// Neither of those is part of what the transcript claims about the model, so neither may append a
	// line to the file: a session that had its key corrected is not a session that changed model.
	check("and neither appends a model_change entry", changesOf() === changesBefore, `${changesOf()} vs ${changesBefore}`);

	// A wire id that moves is a different model answering, and the transcript says so — once.
	keyedRows[0]!.id = "faux-2";
	fake.setResponses([fakeAssistantMessage("answered a third time")]);
	await within("the third run", 10_000, session.prompt("and again"));
	check("a renamed wire id reaches the request", sent[2]?.id === "faux-2", String(sent[2]?.id));
	check("and the session stays on the row it came from", session.modelName === "keyed", session.modelName);
	check("and is recorded once as a model change", changesOf() === changesBefore + 1, String(changesOf()));
	fake.setResponses([fakeAssistantMessage("answered a fourth time")]);
	await within("the fourth run", 10_000, session.prompt("once more"));
	check("while a request on the same id records nothing", changesOf() === changesBefore + 1, String(changesOf()));

	await session.close();
}

/**
 * The composer's model and level travel with the message, and reach the file only when a request uses
 * them.
 *
 * Both halves are one selection, and neither is a config change of its own: the transcript's account of
 * what answered a turn is built from what a request actually carried, so a choice no request was made
 * with must not appear in it — and a session opened and never spoken to must grow no entries at all.
 */
async function exerciseModelSelection(): Promise<void> {
	process.stdout.write("the composer's choice travels with the message\n");

	// Sonnet 4.5 rather than a newer family, because it has no native `max`: that is what makes the
	// refusal below observable. The row carries its own default level, which is where a new session
	// starts — not the workspace's, since the levels belong to the model.
	const thinkerRows: ModelConfig[] = [
		{ ...ROW, name: "thinker", id: "claude-sonnet-4-5", reasoning: true, defaultThinkingLevel: "low" },
	];
	const scripted = createFakeTransport();
	scripted.setResponses([fakeAssistantMessage("first")]);
	const session = await openSession({}, { models: { list: () => thinkerRows }, api: scripted.api });

	check("a session opens on the row's own default level", session.thinkingLevel === "low", session.thinkingLevel);
	check(
		"and offers only the levels that model has",
		JSON.stringify(session.thinkingLevels) === JSON.stringify(["off", "low", "medium", "high"]),
		JSON.stringify(session.thinkingLevels),
	);

	const levelsOf = (): number => entriesOf(session).filter((entry) => entry.type === "thinking_level_change").length;
	session.applyModelSelection({ thinkingLevel: "high" });
	check("choosing a level moves the session", session.thinkingLevel === "high", session.thinkingLevel);
	check("and writes nothing until a request uses it", levelsOf() === 0, String(levelsOf()));

	await within("the run", 10_000, session.prompt("hello", { selection: { thinkingLevel: "high" } }));
	check("the request is asked at that level", scripted.state.thinkingLevels.at(-1) === "high", String(scripted.state.thinkingLevels.at(-1)));
	check("and the transcript records it once", levelsOf() === 1, String(levelsOf()));

	scripted.setResponses([fakeAssistantMessage("second")]);
	await within("the second run", 10_000, session.prompt("again"));
	check("a later turn on the same level records nothing", levelsOf() === 1, String(levelsOf()));
	check("while still being asked at it", scripted.state.thinkingLevels.at(-1) === "high", String(scripted.state.thinkingLevels.at(-1)));

	// A level the model has no room for is refused rather than folded away, because the caller is a
	// composer that offered the levels of the row it is moving within.
	let refused = "";
	try {
		session.applyModelSelection({ thinkingLevel: "max" });
	} catch (error) {
		refused = (error as Error).message;
	}
	check("a level the model does not have is refused", refused.includes("max"), refused);
	check("leaving the session where it was", session.thinkingLevel === "high", session.thinkingLevel);

	await session.close();
}

try {
	await exerciseModelFromRow();
	await exerciseModelSelection();
	await exerciseFollowUp();
	await exerciseSteerVersusFollowUp();
	await exerciseAcceptedOrder();
	await exerciseAbortFlushesAccepted();
	await exerciseQueueMode();
	await exerciseLiveStates();
	await exerciseEventStream();
	await exerciseCompactionEvent();
	await exerciseCompactionFailure();
	await exerciseConfigChanged();
	await exerciseBeforeToolHook();
	await exerciseAfterToolHook();
	await exerciseOutputBackstop();
	await exerciseApprovalPrompt();
	await exerciseToolChangeResend();
	await exerciseToolRegistry();
	await exerciseActiveTools();
	await exerciseDeactivatedToolCall();
	await exerciseFileDiffReport();
	await exerciseBranching();
	await exerciseBranchToolConfig();
	await exerciseLeafDurability();

/**
 * The diff a file-changing tool reports reaches the event stream.
 *
 * That is the whole path the window depends on: the tool puts the report in its result's `details`, the
 * loop carries the result through the `after_tool` hook, and the session emits it on
 * `tool_execution_end` like any other event —which is the frame the server forwards verbatim. Nothing
 * stores it, so this is the only place it can be checked end to end.
 */
async function exerciseFileDiffReport(): Promise<void> {
	process.stdout.write("tool diff report\n");
	recordRequests([], [
		fakeAssistantMessage(fakeToolCall("write", { path: "report.txt", content: "one\ntwo\n" })),
		fakeAssistantMessage(fakeToolCall("edit", { path: "report.txt", old_string: "two", new_string: "three" })),
		fakeAssistantMessage("done"),
	]);
	const session = await openSession();

	const reports: { toolName: string; diff?: FileDiff }[] = [];
	session.onEvent((event) => {
		if (event.type !== "tool_execution_end") return;
		reports.push({ toolName: event.toolName, diff: (event.result?.details as { diff?: FileDiff } | undefined)?.diff });
	});

	await within("the run", 10_000, session.prompt("write report.txt and then edit it"));
	await within("settle()", 10_000, session.settle());

	const written = reports.find((report) => report.toolName === "write")?.diff;
	check("a new file's report arrives with the tool result", written?.created === true && written.added === 2, JSON.stringify(written));
	check(
		"numbered in the file it created",
		written?.lines.map((line) => `${line.kind}${line.newLine ?? "-"}:${line.text}`).join("|") === "add1:one|add2:two",
		JSON.stringify(written?.lines),
	);

	const edited = reports.find((report) => report.toolName === "edit")?.diff;
	check("and so does an edit's", edited?.added === 1 && edited.removed === 1, JSON.stringify(edited));
	check(
		"with the line it replaced and the line it wrote",
		edited?.lines.map((line) => `${line.kind}${line.oldLine ?? "-"}${line.newLine ?? "-"}:${line.text}`).join("|") ===
			"context11:one|remove2-:two|add-2:three",
		JSON.stringify(edited?.lines),
	);
	check(
		"while the transcript keeps the tool's text beside the report",
		toolResultTexts(session).some((text) => text.includes("Created report.txt")) &&
			JSON.stringify(allMessages(session)).includes('"created":true'),
		JSON.stringify(toolResultTexts(session)),
	);

	await session.close();
}

/**
 * Delegation through the `SubAgent` tool, against the same scripted transport the parent runs on.
 *
 * The responses are scripted as factories that classify each request off its transcript rather than
 * by call order, because parent and child interleave: a request carrying a `SubAgent` tool call is
 * the parent's next turn, one whose user message carries a delegation marker is the child's, and
 * anything else is the parent's first turn.
 */
async function exerciseSubagent(): Promise<void> {
	process.stdout.write("subagent delegation\n");
	const SYNC_MARKER = "SYNC-DELEGATION-MARKER";
	const BG_MARKER = "BG-DELEGATION-MARKER";

	function hasToolCallNamed(context: { messages: readonly unknown[] }, name: string): boolean {
		return context.messages.some((message) => {
			const content = (message as { content?: unknown }).content;
			return (
				Array.isArray(content) &&
				content.some((block) => (block as { type?: unknown }).type === "toolCall" && (block as { name?: unknown }).name === name)
			);
		});
	}

	/** Tool-result texts already in a provider request's transcript, for scripting the control turn. */
	function toolResultTextsIn(context: { messages: readonly unknown[] }): string[] {
		return context.messages
			.filter((message) => (message as { role?: unknown }).role === "toolResult")
			.map((message) => textOf(message as Message));
	}

	/** What the model is asked to run, classified off the request the provider was handed. */
	function classify(context: { messages: readonly unknown[] }): "parent-start" | "parent-next" | "parent-control" | "child" {
		if (hasToolCallNamed(context, "SubAgentControl")) return "parent-control";
		if (hasToolCallNamed(context, "SubAgent")) return "parent-next";
		if (context.messages.some((message) => {
			const text = textOf(message as Message);
			return text.includes(SYNC_MARKER) || text.includes(BG_MARKER);
		})) {
			return "child";
		}
		return "parent-start";
	}

	// --- Phase 1: a synchronous delegation, the report as the tool result ------------------------
	const sent: SentRequest[] = [];
	const syncSession = await openSession();
	check("a session carries the delegation pair by default", syncSession.snapshot.allTools.includes("SubAgent") && syncSession.snapshot.allTools.includes("SubAgentControl"), JSON.stringify(syncSession.snapshot.allTools));

	// The same recording `recordRequests` does, inlined: the factory here has to classify the
	// request itself, so it records what it was handed as it answers it.
	const respondSync = (context: {
		messages: readonly unknown[];
		tools?: readonly { name?: string }[];
	}): AssistantMessage => {
		sent.push({
			prompt: context.messages
				.filter((message) => (message as { role?: string }).role === "system")
				.map((message) => textOf(message as Message))
				.join("\n\n"),
			tools: declaredTools(context),
			texts: context.messages.map((message) => textOf(message as Message)),
			roles: context.messages.map((message) => String((message as { role?: string }).role ?? "")),
		});
		const kind = classify(context);
		if (kind === "parent-next") return fakeAssistantMessage("parent done");
		if (kind === "child") return fakeAssistantMessage("SYNC REPORT");
		return fakeAssistantMessage(fakeToolCall("SubAgent", { prompt: `${SYNC_MARKER} report what you find.` }));
	};
	// A scripted step is consumed by one call, and parent and child interleave, so the classifying
	// factory is queued once per call the exercise could make.
	fake.setResponses(Array.from({ length: 8 }, () => respondSync));
	await within("sync delegation", 15_000, syncSession.prompt("delegate some reading"));
	await within("settle()", 10_000, syncSession.settle());
	check("the report came back as the tool result", toolResultTexts(syncSession).includes("SYNC REPORT"), JSON.stringify(toolResultTexts(syncSession)));
	check("the parent answered after it", allMessages(syncSession).some((message) => message.role === "assistant" && textOf(message) === "parent done"));

	const childRequest = sent.find((request) => request.texts.some((text) => text.includes(SYNC_MARKER)));
	check("the child request declared only the read-only set", JSON.stringify(childRequest?.tools) === JSON.stringify(["read", "glob", "grep"]), JSON.stringify(childRequest?.tools));
	const parentRequest = sent.find((request) => request.tools.includes("SubAgent"));
	check("the parent's request declared the delegation pair", parentRequest !== undefined && parentRequest.tools.includes("SubAgentControl"), JSON.stringify(parentRequest?.tools));

	// The child transcript is a session like any other, filed under `subagents/` with the parent
	// recorded in its header —on disk, but out of the directory the sidebar lists.
	const childDir = join(workspaceDir(root), "subagents");
	const childFiles = readdirSync(childDir).filter((file) => file.endsWith(".jsonl"));
	check("the child transcript is on disk under subagents/", childFiles.length === 1, JSON.stringify(childFiles));
	if (childFiles[0] !== undefined) {
		const header = JSON.parse(readFileSync(join(childDir, childFiles[0]), "utf8").split("\n")[0] ?? "{}") as { parentSession?: string };
		check("and its header names the parent session", header.parentSession === syncSession.sessionFile, JSON.stringify(header.parentSession));
	}

	// The child's spend owns no message entry in this transcript, so it arrives as its own record and
	// the total folds it in file order — money from a transcript of its own, on the session's books.
	// The fake transport estimates every answer's usage, so the assertions are structural: one entry,
	// attributed to the delegation, and a total whose excess over the messages' own sum is exactly it.
	const usageEntries = entriesOf(syncSession).filter((entry) => entry.type === "usage");
	check(
		"the delegation recorded its spend as one usage entry",
		usageEntries.length === 1 &&
			usageEntries[0]?.type === "usage" &&
			usageEntries[0].operation === "subagent" &&
			usageEntries[0].usage.totalTokens > 0,
		JSON.stringify(usageEntries),
	);
	const messageOutput = entriesOf(syncSession).reduce((sum, entry) => {
		const usage = entry.type === "message" && entry.message.role === "assistant" ? entry.message.usage : undefined;
		return sum + (usage?.output ?? 0);
	}, 0);
	const recordedOutput = usageEntries[0]?.type === "usage" ? usageEntries[0].usage.output : 0;
	check(
		"the session total counts the child's spend on top of the messages' own",
		syncSession.usage.output === messageOutput + recordedOutput,
		JSON.stringify({ total: syncSession.usage.output, messages: messageOutput, recorded: recordedOutput }),
	);
	await syncSession.close();

	// --- Phase 2: a background job, collected through SubAgentControl ----------------------------
	const bgSession = await openSession();
	const respondBg = (context: { messages: readonly unknown[] }): AssistantMessage => {
		const kind = classify(context);
		if (kind === "parent-control") {
			return toolResultTextsIn(context).includes("BACKGROUND REPORT")
				? fakeAssistantMessage("collected")
				: fakeAssistantMessage("still collecting");
		}
		if (kind === "parent-next") {
			// The `SubAgent` tool call stays on the transcript for every later turn, so the collect
			// turn is told apart from the turn right after the spawn by the parent's answer already
			// being on the record.
			const parentAnswered = context.messages.some((message) => (message as { role?: unknown }).role === "assistant" && textOf(message as Message) === "bg parent done");
			if (parentAnswered) {
				// The job id only exists once the spawn has answered, so it is read back out of the
				// transcript the same way the model would read it.
				const result = context.messages.map((message) => textOf(message as Message)).find((text) => text.includes("started in the background"));
				const id = result?.match(/SubAgent job (\S+) started/)?.[1] ?? "missing";
				return toolResultTextsIn(context).includes("BACKGROUND REPORT")
					? fakeAssistantMessage("collected")
					: fakeAssistantMessage(fakeToolCall("SubAgentControl", { id, action: "output" }));
			}
			return fakeAssistantMessage("bg parent done");
		}
		if (kind === "child") return fakeAssistantMessage("BACKGROUND REPORT");
		return fakeAssistantMessage(fakeToolCall("SubAgent", { prompt: `${BG_MARKER} work in the background.`, run_in_background: true }));
	};
	fake.setResponses(Array.from({ length: 12 }, () => respondBg));
	await within("background spawn", 15_000, bgSession.prompt("delegate without waiting"));
	await within("settle()", 10_000, bgSession.settle());
	const spawnResult = toolResultTexts(bgSession).find((text) => text.includes("started in the background"));
	const bgId = spawnResult?.match(/SubAgent job (\S+) started/)?.[1];
	check("the spawn answered with a job id instead of a report", bgId !== undefined && spawnResult?.includes("BACKGROUND REPORT") === false, JSON.stringify(spawnResult));
	check("the parent's own turn answered while the job ran", allMessages(bgSession).some((message) => message.role === "assistant" && textOf(message) === "bg parent done"));

	await within("collect the background report", 15_000, bgSession.prompt("collect the report"));
	await within("settle()", 10_000, bgSession.settle());
	check("SubAgentControl returned the finished job's report", toolResultTexts(bgSession).includes("BACKGROUND REPORT"), JSON.stringify(toolResultTexts(bgSession)));
	check("and the parent answered after it", allMessages(bgSession).some((message) => message.role === "assistant" && textOf(message) === "collected"));
	await bgSession.close();

	// --- Phase 3: a control call for a job that does not exist is a tool error -------------------
	const missingSession = await openSession();
	const sentMissing: SentRequest[] = [];
	recordRequests(sentMissing, [
		fakeAssistantMessage(fakeToolCall("SubAgentControl", { id: "missing", action: "output" })),
		fakeAssistantMessage("moved on"),
	]);
	await within("unknown job", 15_000, missingSession.prompt("collect a job that does not exist"));
	await within("settle()", 10_000, missingSession.settle());
	check("an unknown job id fails the call", toolResultTexts(missingSession).some((text) => text.includes("Unknown SubAgent job: missing")), JSON.stringify(toolResultTexts(missingSession)));
	await missingSession.close();

	// --- Phase 4: subagents: false builds a session without the pair -----------------------------
	const bare = await openAgent({
		absWorkspaceRoot: root,
		sessionManager: SessionManager.create(root),
		models,
		settingsManager: SettingsManager.inMemory(settings()),
		subagents: false,
	});
	check("subagents: false leaves the delegation tools out", !bare.snapshot.allTools.includes("SubAgent") && !bare.snapshot.allTools.includes("SubAgentControl"), JSON.stringify(bare.snapshot.allTools));
	await bare.close();
}

/**
 * Branching inside one session: an entry may have several children, and this is the conversation
 * moving between them.
 *
 * The check that matters is the *request*. After a move, what the provider is handed has to be the
 * branch the window is showing and not the tail that was abandoned, because the store is what every
 * request is built from —the loop keeps a copy of the conversation, and it must not win.
 */
async function exerciseBranching(): Promise<void> {
	process.stdout.write("branching inside a session\n");
	const session = await openSession();
	const sent: SentRequest[] = [];
	recordRequests(sent, [
		fakeAssistantMessage("answer one"),
		fakeAssistantMessage("second answer"),
		fakeAssistantMessage("third answer"),
		fakeAssistantMessage("fourth answer"),
	]);

	await within("the first turn", 15_000, session.prompt("question one"));
	const firstId = entryIdsFor(session, "question one")[0] ?? "";
	await within("the second turn", 15_000, session.prompt("question two"));
	check(
		"a message the conversation carried on from one way is not a branch point",
		session.snapshot.branchPoints.length === 0,
		JSON.stringify(session.snapshot.branchPoints),
	);

	const events: AgentSessionEvent[] = [];
	session.onEvent((event) => events.push(event));

	// --- Rewinding to a message and asking again is what makes a second alternative ---------------
	const landed = session.branchTo(firstId, false);
	check("rewinding lands on the entry itself", landed === firstId, `${landed} vs ${firstId}`);
	check("and the transcript is the chain through it", textsOf(session).join(",") === "question one", textsOf(session).join(","));
	check("while the abandoned turn stays in the store", allMessages(session).some((message) => textOf(message) === "question two"));
	check(
		"the move is announced with the leaf it landed on",
		events.some((event) => event.type === "branch_changed" && event.leafId === firstId),
		JSON.stringify(events.map((event) => event.type)),
	);

	await within("the third turn", 15_000, session.prompt("question three"));
	const asked = (sent[2]?.texts ?? []).join("|");
	check("the next request carries the rewound branch", asked.includes("question three") && asked.includes("question one"), JSON.stringify(sent[2]?.texts));
	check("and none of the tail that was left behind", asked.includes("question two") === false && asked.includes("second answer") === false, JSON.stringify(sent[2]?.texts));
	check(
		"the append behind a message that was carried on from is announced as a change to the tree",
		events.filter((event) => event.type === "branch_changed").length === 2,
		JSON.stringify(events.filter((event) => event.type === "branch_changed")),
	);

	const points = session.snapshot.branchPoints;
	check("the first message is now a branch point", points.length === 1 && points[0]?.entryId === firstId, JSON.stringify(points));
	check("with both of its continuations", points[0]?.options.length === 2, JSON.stringify(points[0]?.options));
	check(
		"each labelled by the first thing it leads to",
		(points[0]?.options ?? []).map((option) => option.label).join("|") === "answer one|question three",
		JSON.stringify(points[0]?.options),
	);
	check(
		"and the one on screen marked",
		points[0]?.options[0]?.active === false && points[0]?.options[1]?.active === true,
		JSON.stringify(points[0]?.options),
	);

	// --- Choosing the other alternative lands on where *it* stopped ------------------------------
	const alternative = points[0]?.options[0]?.entryId ?? "";
	session.branchTo(alternative, true);
	check(
		"choosing an alternative restores its own tip",
		textsOf(session).join(",") === "question one,question two",
		textsOf(session).join(","),
	);
	await within("the fourth turn", 15_000, session.prompt("question four"));
	const resumed = (sent[3]?.texts ?? []).join("|");
	check("and the request continues on that branch", resumed.includes("question four") && resumed.includes("second answer"), JSON.stringify(sent[3]?.texts));
	check("without the alternative that was left", resumed.includes("question three") === false && resumed.includes("third answer") === false, JSON.stringify(sent[3]?.texts));
	check(
		"both alternatives are still one branch point",
		session.snapshot.branchPoints.length === 1 && session.snapshot.branchPoints[0]?.options.length === 2,
		JSON.stringify(session.snapshot.branchPoints),
	);
	check(
		"nothing was deleted on the way",
		["question three", "third answer", "question four", "fourth answer"].every((text) =>
			allMessages(session).some((message) => textOf(message) === text),
		),
		JSON.stringify(allMessages(session).map(textOf)),
	);

	await session.close();

	// --- A move while a run is in flight would file the turn under the wrong branch ---------------
	const { api: gatedApi, gate } = gatedTransport(1);
	const busy = await openSession({}, { api: gatedApi });
	recordRequests([], [fakeAssistantMessage("slow answer")]);
	const running = busy.prompt("hold the turn");
	await whenStreaming(busy, gate);
	const heldId = entryIdsFor(busy, "hold the turn")[0] ?? "";
	const refused = ((): unknown => {
		try {
			busy.branchTo(heldId, true);
			return undefined;
		} catch (error) {
			return error;
		}
	})();
	check("moving the branch mid-run is refused", refused instanceof Error, String(refused));
	check("and says the run is what refuses it", refused instanceof Error && refused.message.includes("in flight"), String(refused));
	gate.release();
	await within("the held turn", 15_000, running);
	await within("settle()", 10_000, busy.settle());
	check("the refused move left the leaf where the turn put it", busy.snapshot.branchPoints.length === 0, JSON.stringify(busy.snapshot.branchPoints));
	await busy.close();
}

/**
 * The tool choices belong to the branch, exactly as the conversation does.
 *
 * A session records what it chose as `tool_config` entries, so a move has to land on the target
 * branch's choices rather than keep whatever the branch it left had. Otherwise one session answers two
 * ways: the live session keeps a config the file no longer holds where its leaf now is, while
 * reopening that same file restores the target branch's. This drives both moves and, after each, reads
 * the live maps, the snapshot, the event every other window sees, and the prompt the model is handed.
 */
async function exerciseBranchToolConfig(): Promise<void> {
	process.stdout.write("tool config belongs to the branch\n");
	const session = await openSession();
	const sent: SentRequest[] = [];
	recordRequests(sent, [
		fakeAssistantMessage("first answer"),
		fakeAssistantMessage("second answer"),
		fakeAssistantMessage("third answer"),
	]);

	await within("the first turn", 15_000, session.prompt("config branch question one"));
	const firstId = entryIdsFor(session, "config branch question one")[0] ?? "";
	await within("the second turn", 15_000, session.prompt("config branch question two"));
	const secondId = entryIdsFor(session, "config branch question two")[0] ?? "";

	const events: AgentSessionEvent[] = [];
	session.onEvent((event) => events.push(event));

	// --- The first branch is narrowed and gates `bash` ------------------------------------------
	const narrowed = session.snapshot.activeTools.filter((name) => name !== "bash");
	session.setActiveTools(narrowed);
	session.applyConfig({ approval: { bash: true } });
	// The leaf is read now, while the session is still on this branch: `getBranchTip` follows the last
	// child written, so once a second branch exists, descending from the first message reaches *that*
	// one instead. The branch is addressed by its own tip from here on.
	const firstTip = session.sessionManager.getLeafId() ?? "";
	check("the narrow set is in force", session.snapshot.activeTools.includes("bash") === false, JSON.stringify(session.snapshot.activeTools));
	check("with the approval this branch chose", session.snapshot.approvals.bash === true, JSON.stringify(session.snapshot.approvals));

	// --- The second branch is the full set, ungated again ---------------------------------------
	// The approval is a choice of its own: a tool change records the map as it stands, and does not
	// reset it, so un-gating `bash` here is what the second branch actually chose.
	session.setActiveTools([...session.snapshot.allTools]);
	session.applyConfig({ approval: { bash: false } });
	const secondTip = session.sessionManager.getLeafId() ?? "";
	check("the full set is back", session.snapshot.activeTools.includes("bash") === true, JSON.stringify(session.snapshot.activeTools));
	check("and its approval with it", session.snapshot.approvals.bash === false, JSON.stringify(session.snapshot.approvals));

	// --- Moving onto the first branch restores its choices --------------------------------------
	const before = events.length;
	session.branchTo(firstTip, false);
	check(
		"the move lands on the first branch",
		textsOf(session).join(",") === "config branch question one,config branch question two",
		textsOf(session).join(","),
	);
	check("its tool set is restored", session.snapshot.activeTools.includes("bash") === false, JSON.stringify(session.snapshot.activeTools));
	check("and its approval is too", session.snapshot.approvals.bash === true, JSON.stringify(session.snapshot.approvals));
	check("which is the map the gate reads", session.getApprovals().bash === true, JSON.stringify(session.getApprovals()));
	check("leaving the settings file alone", session.settingsManager.getApprovals().bash === false, JSON.stringify(session.settingsManager.getApprovals()));
	const moved = events.slice(before).find((event) => event.type === "config_changed");
	check(
		"and every other window is told what the branch chose",
		moved?.type === "config_changed" && moved.approvals?.bash === true && moved.tools?.includes("bash") === false,
		JSON.stringify(moved),
	);

	await within("the third turn", 15_000, session.prompt("config branch question three"));
	const asked = sent[2];
	check(
		"the next request is narrowed with it",
		(asked?.tools ?? []).includes("bash") === false && (asked?.tools ?? []).length > 0,
		JSON.stringify(asked?.tools),
	);
	check(
		// The prompt carries the approval clause when the map gates something, and the tools line is
		// the part the active set decides —so "off the list but named as gated" is the promised pair.
		"and the prompt promises the approval the gate will ask for",
		availableTools(asked?.prompt ?? "").includes("bash") === false &&
			(asked?.prompt ?? "").includes("ask the user for approval before running: bash"),
		asked?.prompt,
	);

	// --- Moving back restores the other branch's choices ----------------------------------------
	session.branchTo(secondTip, false);
	check("the second branch's set comes back", session.snapshot.activeTools.includes("bash") === true, JSON.stringify(session.snapshot.activeTools));
	check("with its approval", session.snapshot.approvals.bash === false, JSON.stringify(session.snapshot.approvals));

	await session.close();

	// --- A branch that recorded nothing falls back to the settings defaults ---------------------
	// Not the same session: rewinding needs a branch that ends *before* the first `tool_config`. Only
	// the approval map is restored there, because the settings files own it and a branch that never
	// chose has no other answer. The registry keeps the set it already had —the settings files say
	// nothing about which tools are active, so a branch with no `tool_config` cannot put one back.
	const fallback = await openSession();
	recordRequests([], [fakeAssistantMessage("fallback answer"), fakeAssistantMessage("fallback answer two")]);
	await within("the turn before the choice", 15_000, fallback.prompt("config fallback question"));
	const earlyId = entryIdsFor(fallback, "config fallback question")[0] ?? "";
	fallback.setActiveTools([...fallback.snapshot.activeTools.filter((name) => name !== "bash")]);
	fallback.applyConfig({ approval: { bash: true } });
	await within("the turn after the choice", 15_000, fallback.prompt("config fallback question two"));
	check("the choice is in force", fallback.snapshot.approvals.bash === true, JSON.stringify(fallback.snapshot.approvals));

	fallback.branchTo(earlyId, false);
	check(
		"a branch with no record falls back to the settings defaults",
		fallback.snapshot.approvals.bash === false,
		JSON.stringify(fallback.snapshot.approvals),
	);
	check(
		"since the settings files are what a session that never chose runs on",
		fallback.settingsManager.getApprovals().bash === false,
		JSON.stringify(fallback.settingsManager.getApprovals()),
	);
	await fallback.close();
}

/**
 * A branch move outlives the session that made it.
 *
 * A move that actually changes the position writes one `leaf` entry, and `buildIndex` replays it on
 * load, so close → reopen restores where the conversation went rather than the file's last entry.
 * Also checked on the way: a move to the position already held writes nothing, the record reaches no
 * message, and `resetLeaf`'s "before the first entry" survives a reopen too. A file with no such
 * record — every file written before this build, or written by hand — reads exactly as it always
 * did, which is what keeps "no migration" true.
 */
async function exerciseLeafDurability(): Promise<void> {
	process.stdout.write("leaf durability\n");
	const session = await openSession();
	const sent: SentRequest[] = [];
	recordRequests(sent, [fakeAssistantMessage("answer one"), fakeAssistantMessage("answer two")]);

	await within("the first turn", 15_000, session.prompt("durable question one"));
	await within("the second turn", 15_000, session.prompt("durable question two"));
	const firstId = entryIdsFor(session, "durable question one")[0] ?? "";

	// --- A real move writes one record; a no-op move writes none ---------------------------------
	const entriesBefore = entriesOf(session).length;
	session.branchTo(firstId, false);
	check("a real move writes exactly one entry", entriesOf(session).length === entriesBefore + 1, String(entriesOf(session).length - entriesBefore));
	check("and that entry is a leaf record", entriesOf(session).at(-1)?.type === "leaf", String(entriesOf(session).at(-1)?.type));
	session.branchTo(firstId, false);
	check("moving to the position already held writes nothing", entriesOf(session).length === entriesBefore + 1, String(entriesOf(session).length - entriesBefore));

	const file = session.sessionManager.getAbsSessionFile() ?? "";
	await session.close();

	// --- The move is where the file says it is, not where the file ends --------------------------
	const reopened = SessionManager.open(file);
	check("the move survived close", reopened.getLeafId() === firstId, `${reopened.getLeafId()} vs ${firstId}`);
	check(
		"and the reopened context is the branch through it, the record reaching no message",
		JSON.stringify(reopened.buildSessionContext().messages.map(textOf)) === JSON.stringify(["durable question one"]),
		JSON.stringify(reopened.buildSessionContext().messages.map(textOf)),
	);

	// The next append is a child of the recorded position, which is what turns it into a branch point.
	reopened.appendMessage({ role: "user", content: [{ type: "text", text: "carried on" }] } as Message);
	const points = reopened.getBranchPoints();
	check(
		"the next append continued from the moved leaf",
		points.length === 1 && points[0]?.entryId === firstId && points[0]?.options.length === 2,
		JSON.stringify(points),
	);

	// --- "Before the first entry" is a position like any other ----------------------------------
	reopened.resetLeaf();
	check("resetLeaf moved the leaf before the first entry", reopened.getLeafId() === null, String(reopened.getLeafId()));
	const rereopened = SessionManager.open(file);
	check("and that position survived the reopen too", rereopened.getLeafId() === null, String(rereopened.getLeafId()));

	// --- A file with no leaf record reads as it always did: the last entry is the position -------
	// Handwritten, because no build that writes this format would ever produce one — the format never
	// rewrites a line, so old files keep the shape their writer gave them.
	const fixture = join(root, "fixture-no-leaf.jsonl");
	const lines = [
		{ type: "SessionHeader", version: 4, id: "fixture-no-leaf", timestamp: new Date().toISOString(), cwd: root },
		{ type: "message", id: "fx-u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "fixture one" }] } },
		{ type: "message", id: "fx-a1", parentId: "fx-u1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "fixture answer" }] } },
		{ type: "message", id: "fx-u2", parentId: "fx-u1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "fixture two" }] } },
	];
	await writeFile(fixture, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
	const legacy = SessionManager.open(fixture);
	check("a file without a leaf record reads its last entry", legacy.getLeafId() === "fx-u2", String(legacy.getLeafId()));
	check(
		"and its tree is read whole, the second child a branch option",
		legacy.getBranchPoints().length === 1 && legacy.getBranchPoints()[0]?.options.length === 2,
		JSON.stringify(legacy.getBranchPoints()),
	);
}

	await exerciseSubagent();
	await exerciseApprovalDenial();
	await exerciseUnknownTool();
	await exerciseEmptyToolSet();
	await exerciseRetry();
	await exerciseNonRetryableError();
	await exerciseRetryExhaustion();
	await exerciseRetryAbort();
	await exerciseRetryDisabled();
	await exerciseContextOverflow();
} finally {
	clearTimeout(watchdog);
	// Both the workspace and the agent home's directory for it, or every run leaves one behind.
	await rm(root, { recursive: true, force: true });
	await rm(workspaceDir(root), { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nsession ok\n" : `\n${failures} session checks failed\n`);
process.exit(failures === 0 ? 0 : 1);
