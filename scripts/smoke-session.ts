// Session-level smoke test: drives a real Agent against the scripted transport, so streaming,
// queueing, and steering are testable without a provider key.
// Run with: node scripts/smoke-session.ts
import { mkdtemp, rm, access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall, type FakeResponseStep } from "./fake-transport.ts";
import {
	CURRENT_SESSION_VERSION,
	createSession,
	createToolManager,
	fillSession,
	MAX_TOOL_RESULT_BYTES,
	ModelManager,
	openAgent,
	SessionManager,
	narrowToKnown,
	settingsPath,
	type Agent,
	type AgentSessionEvent,
	type SessionEventListener,
	type SessionSink,
	type Tool,
	type FileDiff,
	type Message,
	type MessageEntry,
	type GlobalSettings,
	type SessionEntry,
	type Session,
	type ToolManager,
	type ModelConfig,
	setSessionsDir,
	type AssistantMessage,
	type ChatTransport,
	type Context,
	type SimpleStreamOptions,
} from "@my-agent/core";

/** The ledger's operations are the service's methods, so a script holds one to call them on. */
const sessionManager = new SessionManager();

// `@my-agent/core` is a workspace package, linked into the repository root's
// node_modules so scripts resolve it the same way `packages/core` does.

const root = await mkdtemp(join(tmpdir(), "my-agent-session-"));
const storeRoot = await mkdtemp(join(tmpdir(), "my-agent-session--store-"));
setSessionsDir(storeRoot);
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
};

/** The rows the sessions read. Shared, so every check counts responses from one queue. */
const rows: ModelConfig[] = [ROW];
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
 * The scripted transport answers as soon as the engine asks, which leaves no window in which to send a
 * message mid-run. Delaying the first call is what makes "while streaming" observable at all. The
 * gate is applied before the session is built, because `Agent` captures the transport when it is
 * constructed.
 */
function gatedTransport(hold = 1): { chatTransport: ChatTransport; gate: Gate } {
	const call = fake.chatTransport.stream.bind(fake.chatTransport);
	let held = 0;
	let calls = 0;
	const releases: (() => void)[] = [];

	// The gate holds the call before the fake stream is built, so the wrapper must wait — an async
	// body behind the sync-returning `stream` shape. Call sites await the result, which a thenable
	// survives, so both shapes behave the same at runtime; the cast is the declared shape only.
	type StreamArgs = Parameters<ChatTransport["stream"]>;
	const stream = (async (model: StreamArgs[0], context: StreamArgs[1], options: StreamArgs[2]) => {
		calls += 1;
		if (held < hold) {
			held += 1;
			await new Promise<void>((resolve) => releases.push(resolve));
		}
		return call(model, context, options);
	}) as unknown as ChatTransport["stream"];

	return {
		chatTransport: { stream },
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
function windowedRows(contextWindow: number): ModelConfig[] {
	return rows.map((row) => ({ ...row, contextWindow }));
}

/**
 * Wait until a run has actually reached the provider, or record a failure.
 *
 * Waiting for `running` alone is not enough: the snapshot reports it before `prepareRequest` runs, so
 * a test that released the gate on that signal could release it before the call arrived, and the call
 * would then wait for a release that already happened.
 */
async function whenStreaming(agent: Agent, gate: Gate, ms = 5_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < ms) {
		if (agent.snapshot(sidOf(agent)).running && gate.held >= 1) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	check("a run reached the provider", false, `streaming=${agent.snapshot(sidOf(agent)).running} held=${gate.held} after ${ms} ms`);
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
function retryPolicy(overrides: Partial<GlobalSettings["retry"]> = {}): GlobalSettings["retry"] {
	return { enabled: true, maxRetries: 3, baseDelayMs: 10, maxAgentDelayMs: 60_000, ...overrides };
}

function settings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
	// The cast is the spread talking, not the data: every key here is present, and spreading a
	// Partial over it only makes the checker doubt the optionals it could not see.
	return {
		approval: { read: false, write: false, edit: false, glob: false, grep: false, bash: false },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		retry: retryPolicy(),
		...overrides,
	} as GlobalSettings;
}

/**
 * The approval map the mode fixtures carry: nothing gated.
 *
 * A mode's map is normalized over the settings defaults (`modesOr`), so an empty literal would
 * inherit the factory gates (write/edit/bash) — these presets narrow tools, and the exercises that
 * check the approval clause need the map to say exactly what they mean.
 */
const NO_GATES: Record<string, boolean> = { read: false, write: false, edit: false, glob: false, grep: false, bash: false };

/** What one run is driven through: which rows a session reads, and which transport it sends over. */
interface RunOptions {
	models?: readonly ModelConfig[];
	chatTransport?: ChatTransport;
}

/**
 * ADR-0021：会话随第一条消息出生，而编排层的每个动词（prompt、applyConfig、snapshot……）都按 id
 * 现开文件——文件不存在的 id 一律拒绝。所以 `openSession` 在装配之前先落一条出生消息，让每个
 * 练习拿到的是一个已经出生的会话；这条消息不跑引擎、不耗剧本，读取 helper
 * （{@link entriesOf} / {@link textsOf}）把它滤掉，各练习的消息断言因此保持原义。
 */
const BIRTH_TEXT = "the smoke's birth message";

function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/**
 * The bag and id each opened session runs on, kept beside the agent the checks hold.
 *
 * The agent's methods name it by id now — the orchestrator holds no session state — so the
 * opening helpers record what they created here and every check reads the pair back through
 * {@link sidOf} and {@link bagOf}.
 */
const opened = new WeakMap<Agent, { id: string; session: Session; home: string; birthEntryId: string }>();

function sidOf(agent: Agent): string {
	return opened.get(agent)!.id;
}

function bagOf(agent: Agent): Session {
	// A session is a file, not a field (ADR-0013 and ADR-0021): every session this smoke opens was
	// born in `openSession`, so the orchestrator replays it per operation and a check that wants to
	// look at what it wrote replays too — there is no unborn bag to fall back on.
	return agent.sessionManager.open(opened.get(agent)!.id);
}

/** The temp home each opened session's holders read, keyed by that agent. */
function homeOf(agent: Agent): string {
	return opened.get(agent)!.home;
}

/**
 * A capture sink with the subscribe/unsubscribe semantics the session used to expose itself.
 *
 * The orchestrator no longer keeps subscriber sets on its bags (ADR-0013's sink clause): dispatch
 * leaves core through the single sink handed in at construction. The smoke is its own subscriber, so
 * the sink records every published event and re-dispatches to whoever subscribed through
 * {@link onSessionEvent} — the shim the exercises below use instead of the removed `Agent.onEvent`.
 */
function captureSink(): {
	sink: SessionSink;
	onEvent(sessionId: string, listener: SessionEventListener): () => void;
} {
	const listeners = new Map<string, Set<SessionEventListener>>();
	const recorded: AgentSessionEvent[] = [];
	return {
		sink: {
			onEvent(sessionId, event) {
				recorded.push(event);
				for (const listener of listeners.get(sessionId) ?? []) listener(event);
			},
			onState() {},
		},
		onEvent(sessionId, listener) {
			const set = listeners.get(sessionId) ?? new Set<SessionEventListener>();
			listeners.set(sessionId, set);
			set.add(listener);
			return () => set.delete(listener);
		},
	};
}

/** The capture sink each opened session's agent was built with, keyed by that agent. */
const taps = new WeakMap<Agent, ReturnType<typeof captureSink>>();

/** Subscribe to the session's events through the capture sink its agent was built with. */
function onSessionEvent(agent: Agent, listener: SessionEventListener): () => void {
	return taps.get(agent)!.onEvent(sidOf(agent), listener);
}

/**
 * One session over its own session record, with settings that live in a throwaway home.
 *
 * `inMemorySettingManager` 的内存后端已随设置归属重构退场（spec §8）：各持有者先在临时 home 里
 * 预种自己的文件——工具簇（审批/模式）经 ToolManager，队列模式经 SessionManager，重试与模型行经
 * ModelManager——homes 透传给 `openAgent`，走与生产同一条构造路。
 * 机器自己的文件永远不被碰。
 */
let homeSeq = 0;

async function openSession(
	overrides: Partial<GlobalSettings> = {},
	run: RunOptions = {},
	customToolManager?: ToolManager,
): Promise<Agent> {
	const session = createSession(root);
	// 出生（ADR-0021）：一条 user 消息落盘，文件与快照同时诞生。经本脚本自己的 store 追加——
	// 文件是共享状态，编排层随后按 id 重放的就是它。不跑引擎、不耗剧本回答。
	const birthEntryId = sessionManager.appendMessage(session, userMessage(BIRTH_TEXT));
	const desired = settings(overrides);
	const home = join(root, `agent-home-${homeSeq++}`);
	await mkdir(home, { recursive: true });
	// 调用方递入自己的表时，工具簇就种进那张表自己的文件；否则本脚本造一张，home 即各持有者同居
	// 的默认。
	const toolManager = customToolManager ?? createToolManager({ home });
	toolManager.applyToolDefaults({
		approval: desired.approval,
		...(desired.tools === undefined ? {} : { tools: desired.tools }),
		...(desired.modes === undefined ? {} : { modes: desired.modes }),
		...(desired.bash === undefined ? {} : { bash: desired.bash }),
	});
	new SessionManager({ home: home }).applySessionDefaults({ steeringMode: desired.steeringMode, followUpMode: desired.followUpMode });
	const modelManager = new ModelManager({ home: home });
	modelManager.applyRetry(desired.retry);
	modelManager.replaceRows(run.models ?? rows);
	if (desired.model !== undefined || desired.defaultModelSeeded !== undefined) {
		modelManager.applyModelSettings({
			...(desired.model === undefined ? {} : { model: desired.model }),
			...(desired.defaultModelSeeded === undefined ? {} : { defaultModelSeeded: desired.defaultModelSeeded }),
		});
	}
	const tap = captureSink();
	const agent = await openAgent({
		session,
		chatTransport: run.chatTransport ?? fake.chatTransport,
		settingsHome: home,
		modelsHome: home,
		toolManager,
		sink: tap.sink,
	});
	opened.set(agent, { id: session.sessionId, session, home, birthEntryId });
	taps.set(agent, tap);
	return agent;
}

function textsOf(agent: Agent): string[] {
	return agent.snapshot(sidOf(agent)).messages
		.filter((message) => message.role === "user" && textOf(message) !== BIRTH_TEXT)
		.map((message) => textOf(message));
}

/** Every entry in the log, header aside, including branches the session is no longer on. */
function entriesOf(agent: Agent): SessionEntry[] {
	// The birth message is filtered out: the exercises below speak of the messages *they* sent, and
	// the one `openSession` wrote to make the session exist is not theirs.
	const birth = opened.get(agent)!.birthEntryId;
	return agent.sessionManager.getEntries(bagOf(agent)).filter((entry) => entry.id !== birth);
}

/**
 * Every message ever written, not just the ones still in context.
 *
 * A compaction removes messages from the model's view, never from the file, so "the store kept it" is
 * always a question about this list rather than about the session record.
 */
function allMessages(agent: Agent): Message[] {
	return entriesOf(agent).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

/** Each stored message as "role:text", in store order — the shape most ordering assertions compare. */
function orderOf(agent: Agent): string[] {
	return allMessages(agent).map((message) => `${message.role}:${textOf(message)}`);
}

/** Ids of the message entries whose text matches, in log order. */
function entryIdsFor(agent: Agent, text: string): string[] {
	return entriesOf(agent)
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
	/**
	 * The tool entries the request carried, as the wire carries them: declarations, one list per
	 * request. `toToolDeclaration` rebuilds each entry from the instance, so a request's list is the
	 * one thing about identity it cannot show — the elements are measured where they run.
	 */
	instances: readonly Tool<any>[];
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
 * The response factory is handed the conversation the provider was sent, and that is the only place the
 * prompt the model received can be read back: `snapshot` reports the conversation, not the prompt. The
 * same is true of a tool result a hook rewrote: only the request says what the model was shown.
 */
function recordRequests(seen: SentRequest[], responses: AssistantMessage[]): void {
	fake.setResponses(
		responses.map((response) => (
			context: Context,
			options?: SimpleStreamOptions,
		) => {
			seen.push({
				prompt: context.messages
					.filter((message) => (message as { role?: string }).role === "system")
					.map((message) => textOf(message as Message))
					.join("\n\n"),
				tools: declaredTools(context),
				instances: context.tools,
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

/** The text of the session record's tool results, oldest first. */
function toolResultTexts(agent: Agent): string[] {
	return allMessages(agent)
		.filter((message) => message.role === "toolResult")
		.map((message) => textOf(message));
}

/**
 * A follow-up sent mid-run is accepted, queued, and drained when the turn ends.
 *
 * The session must hold both user messages exactly once, and in the order the loop took them: the
 * queued message is written when the loop drains it — behind the answer it interrupted — rather than
 * when it was accepted.
 */
async function exerciseFollowUp(): Promise<void> {
	process.stdout.write("followUp\n");
	fake.setResponses([fakeAssistantMessage("first answer"), fakeAssistantMessage("second answer")]);
	const { chatTransport: chatTransport, gate } = gatedTransport();
	const agent = await openSession({}, { chatTransport: chatTransport });
	// Counted from here rather than asserted absolutely: the queue is shared by every exercise, so
	// what this check is about is the calls this run made.
	const base = fake.fakeState.callCount;

	const echoed: string[] = [];
	onSessionEvent(agent, (event) => {
		if (event.type === "message_end" && event.message.role === "user") echoed.push(textOf(event.message));
	});

	const running = agent.prompt(sidOf(agent), "first question");
	await whenStreaming(agent, gate);
	check("the first run is streaming", agent.snapshot(sidOf(agent)).running === true);
	check("the provider call is held open", gate.held === 1, String(gate.held));
	check("nothing is queued yet", agent.snapshot(sidOf(agent)).queued.length === 0, String(agent.snapshot(sidOf(agent)).queued.length));

	const queued = await within("followUp prompt", 5_000, agent.prompt(sidOf(agent), "second question", { behavior: "followUp" }));
	check("followUp resolves mid-run instead of throwing", queued.ok);
	check("snapshot.queued is 1 before the turn ends", agent.snapshot(sidOf(agent)).queued.length === 1, String(agent.snapshot(sidOf(agent)).queued.length));

	gate.release();
	await within("the run", 10_000, running);
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	const users = textsOf(agent);
	check("the session holds both user messages", users.length === 2, JSON.stringify(users));
	check("the first exactly once", users.filter((text) => text === "first question").length === 1, JSON.stringify(users));
	check("the second exactly once", users.filter((text) => text === "second question").length === 1, JSON.stringify(users));
	// The drain wrote the queued message the moment it took it — nothing wrote it at acceptance — so
	// "once" here means the drain's write landed, not that a duplicate was deduplicated away.
	check("the drain point injected the queued message", echoed.includes("second question"), JSON.stringify(echoed));
	check("two provider calls were made", fake.fakeState.callCount - base === 2, String(fake.fakeState.callCount - base));
	check("nothing is queued after settling", agent.snapshot(sidOf(agent)).queued.length === 0, String(agent.snapshot(sidOf(agent)).queued.length));

	await agent.close(sidOf(agent));
}

/**
 * `steer` is taken without waiting for the turn; `followUp` waits for it to end.
 *
 * One held provider call gives the injection a window, and what the two queues do in it is what
 * separates them: a steered message goes into the running turn, so the depth a composer shows stays
 * zero, while a follow-up is still waiting and counted. Neither is written yet — the write waits for
 * the drain — so the entry lands behind the answer it interrupted, and once.
 */
async function exerciseSteerVersusFollowUp(): Promise<void> {
	process.stdout.write("steer versus followUp\n");
	const scenarios = [
		{ behavior: "steer" as const, counted: false },
		{ behavior: "followUp" as const, counted: true },
	];

	for (const scenario of scenarios) {
		fake.setResponses([fakeAssistantMessage("first answer"), fakeAssistantMessage("second answer")]);
		const { chatTransport: chatTransport, gate } = gatedTransport();
		const agent = await openSession({}, { chatTransport: chatTransport });

		const running = agent.prompt(sidOf(agent), "question one");
		await whenStreaming(agent, gate);
		await agent.prompt(sidOf(agent), "queued now", { behavior: scenario.behavior });

		const duringStreaming = entryIdsFor(agent, "queued now");
		check(
			`${scenario.behavior} is not written while the run is streaming`,
			duringStreaming.length === 0,
			JSON.stringify(duringStreaming),
		);
		check(
			scenario.counted ? "and the queue counts it" : "and the queue does not count it",
			agent.snapshot(sidOf(agent)).queued.length === (scenario.counted ? 1 : 0),
			String(agent.snapshot(sidOf(agent)).queued.length),
		);

		gate.release();
		await within("the run", 10_000, running);
		await within("settle()", 10_000, agent.settle(sidOf(agent)));

		const after = entryIdsFor(agent, "queued now");
		check(`${scenario.behavior} is in the store exactly once`, after.length === 1, JSON.stringify(after));
		// The order is the reason the write waits for the drain: the store's order is the order the loop
		// replayed, which is what the next request is built from and what a baseline replays.
		const order = orderOf(agent);
		check(
			`${scenario.behavior} is filed behind the answer it interrupted`,
			JSON.stringify(order) ===
				JSON.stringify(["user:question one", "assistant:first answer", "user:queued now", "assistant:second answer"]),
			JSON.stringify(order),
		);
		await agent.close(sidOf(agent));
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
	const { chatTransport: chatTransport, gate } = gatedTransport();
	const agent = await openSession({}, { chatTransport: chatTransport });

	const running = agent.prompt(sidOf(agent), "question one");
	await whenStreaming(agent, gate);
	await agent.prompt(sidOf(agent), "asked while it was answering", { behavior: "followUp" });
	check(
		"nothing is written at acceptance",
		entryIdsFor(agent, "asked while it was answering").length === 0,
		JSON.stringify(entryIdsFor(agent, "asked while it was answering")),
	);

	gate.release();
	await within("the run", 10_000, running);
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	const order = orderOf(agent);
	check(
		"the store reads the way the loop replayed it",
		JSON.stringify(order) ===
			JSON.stringify(["user:question one", "assistant:first answer", "user:asked while it was answering", "assistant:second answer"]),
		JSON.stringify(order),
	);
	check(
		"the first request carried the question alone",
		JSON.stringify(sent[0]?.texts.slice(2)) === JSON.stringify(["question one"]),
		JSON.stringify(sent[0]?.texts),
	);
	check(
		"the request the follow-up opened carried it behind that answer",
		JSON.stringify(sent[1]?.roles.slice(2)) === JSON.stringify(["user", "assistant", "user"]),
		JSON.stringify(sent[1]?.roles),
	);
	check(
		"with the texts in the same order",
		JSON.stringify(sent[1]?.texts.slice(2)) ===
			JSON.stringify(["question one", "first answer", "asked while it was answering"]),
		JSON.stringify(sent[1]?.texts),
	);

	await agent.close(sidOf(agent));
}

/**
 * A message accepted mid-run that the run never reaches is dropped with the run.
 *
 * An abort is the ordinary way this happens: the loop stops before its next drain point, so nothing
 * will ever take the message off the queue. The send contract is fire-and-forget — a message that
 * was never drained is never stored — and the queues are emptied so the depth falls to zero, which
 * is what `settle()` waits on.
 */
async function exerciseAbortDropsUnconsumed(): Promise<void> {
	process.stdout.write("abort drops the unconsumed queue\n");
	fake.setResponses([fakeAssistantMessage("an answer that never lands")]);
	const { chatTransport: chatTransport, gate } = gatedTransport();
	const agent = await openSession({}, { chatTransport: chatTransport });

	const running = agent.prompt(sidOf(agent), "question before the abort");
	await whenStreaming(agent, gate);
	await agent.prompt(sidOf(agent), "typed while it was answering", { behavior: "followUp" });
	check("the run is streaming with one message queued", agent.snapshot(sidOf(agent)).running && agent.snapshot(sidOf(agent)).queued.length === 1, String(agent.snapshot(sidOf(agent)).queued.length));

	const aborting = agent.abort(sidOf(agent));
	// The held call has to answer before the aborted run can end; the abort's own signal is what turns
	// that answer into the end.
	gate.release();
	await within("the run", 10_000, running);
	await within("abort()", 10_000, aborting);
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	const order = orderOf(agent);
	check("the message the run never drained is not in the store", !order.includes("user:typed while it was answering"), JSON.stringify(order));
	check("and the queue is empty, which is what settle() waits on", agent.snapshot(sidOf(agent)).queued.length === 0, String(agent.snapshot(sidOf(agent)).queued.length));

	await agent.close(sidOf(agent));
}

/** `followUpMode: "one-at-a-time"` drains one queued message per turn, not the whole queue. */
async function exerciseQueueMode(): Promise<void> {
	process.stdout.write("one-at-a-time\n");
	const base = fake.fakeState.callCount;
	fake.setResponses([fakeAssistantMessage("answer one"), fakeAssistantMessage("answer two"), fakeAssistantMessage("answer three")]);
	const { chatTransport: chatTransport, gate } = gatedTransport(2);
	const agent = await openSession({ followUpMode: "one-at-a-time" }, { chatTransport: chatTransport });

	const running = agent.prompt(sidOf(agent), "turn one");
	await whenStreaming(agent, gate);
	await agent.prompt(sidOf(agent), "turn two", { behavior: "followUp" });
	await agent.prompt(sidOf(agent), "turn three", { behavior: "followUp" });
	check("two messages are queued", agent.snapshot(sidOf(agent)).queued.length === 2, String(agent.snapshot(sidOf(agent)).queued.length));

	// Release the first turn. The loop then starts exactly one queued turn and stops inside that
	// request, which is the hold that makes the drain count observable.
	gate.release();
	await gateHeld(gate);
	check("exactly one queued message was drained", agent.snapshot(sidOf(agent)).queued.length === 1, String(agent.snapshot(sidOf(agent)).queued.length));
	check("and the loop has started its second request", gate.calls === 2, String(gate.calls));
	// The drained message is in the session, the waiting one is still only on a queue — the depth is
	// what reports it, and since the write waits for the drain the session shows it too.
	const soFar = orderOf(agent);
	check(
		"the session holds the drained message and not the waiting one",
		JSON.stringify(soFar) === JSON.stringify(["user:turn one", "assistant:answer one", "user:turn two"]),
		JSON.stringify(soFar),
	);

	gate.release();
	await within("the run", 10_000, running);
	await within("settle()", 10_000, agent.settle(sidOf(agent)));
	check("the rest drained once the run ended", agent.snapshot(sidOf(agent)).queued.length === 0, String(agent.snapshot(sidOf(agent)).queued.length));
	check("all three user messages are present", textsOf(agent).length === 3, JSON.stringify(textsOf(agent)));
	check("three provider calls were made", fake.fakeState.callCount - base === 3, `${fake.fakeState.callCount - base}`);

	await agent.close(sidOf(agent));
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
	const { chatTransport: chatTransport, gate } = gatedTransport();
	const agent = await openSession({}, { chatTransport: chatTransport });

	const queuedSeen: number[] = [];
	const streamingSeen: boolean[] = [];
	onSessionEvent(agent, () => {
		queuedSeen.push(agent.snapshot(sidOf(agent)).queued.length);
		streamingSeen.push(agent.snapshot(sidOf(agent)).running);
	});

	const running = agent.prompt(sidOf(agent), "live question");
	await whenStreaming(agent, gate);
	await agent.prompt(sidOf(agent), "live follow-up", { behavior: "followUp" });
	check("the snapshot reports the queue while the run is live", agent.snapshot(sidOf(agent)).queued.length === 1, String(agent.snapshot(sidOf(agent)).queued.length));

	gate.release();
	await within("the run", 10_000, running);
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	check("a listener saw the streaming window", streamingSeen.includes(true), JSON.stringify(streamingSeen));
	check("and the queued count went from 0 to 1 to 0", queuedSeen.includes(0) && queuedSeen.includes(1), JSON.stringify(queuedSeen));
	check("the session kept both messages", textsOf(agent).length === 2, JSON.stringify(textsOf(agent)));

	await agent.close(sidOf(agent));
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
 * acceptance, the entry lands at the drain — ahead of the loop's own echo of it — and the echo
 * follows.
 */
async function exerciseEventStream(): Promise<void> {
	process.stdout.write("session events\n");
	fake.setResponses([fakeAssistantMessage("first answer"), fakeAssistantMessage("second answer")]);
	const { chatTransport: chatTransport, gate } = gatedTransport();
	const agent = await openSession({}, { chatTransport: chatTransport });

	const seen: AgentSessionEvent[] = [];
	onSessionEvent(agent, (event) => seen.push(event));

	const running = agent.prompt(sidOf(agent), "event question one");
	await whenStreaming(agent, gate);
	await agent.prompt(sidOf(agent), "event question two", { behavior: "followUp" });

	gate.release();
	await within("the run", 10_000, running);
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	const persisted = entriesOf(agent).filter((entry) => entry.type === "message").map((entry) => entry.id);
	// Only the message entries: the meta values the request wrote go to the `.json` snapshot, not to
	// the entry stream, so there is nothing else to announce.
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

	const queuedEntry = entryIdsFor(agent, "event question two")[0];
	const written = seen.findIndex((event) => event.type === "entry_appended" && event.entryId === queuedEntry);
	const queuedUpdate = seen.findIndex((event) => event.type === "queue_update" && event.queued.length === 1);
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
		"the write is the drain itself, ahead of the echo it precedes",
		written < drainedStart && drainedEnd === drainedStart + 1,
		`start=${drainedStart} write=${written} end=${drainedEnd}`,
	);
	check("and the queue returns to empty once drained", seen.some((event) => event.type === "queue_update" && event.queued.length === 0), trace);

	await agent.close(sidOf(agent));
}

/**
 * Compaction replaces history with a summary the model wrote, and announces both.
 *
 * The summary is one extra provider call, so the scripted responses carry it in the order the requests
 * happen: answer, answer, summary, then the answer to the prompt whose request triggered the
 * compaction. What the assertions are really about is the session record: the summarized messages leave the
 * model's view, the summary takes their place, and the file keeps everything.
 */
async function exerciseCompactionEvent(): Promise<void> {
	process.stdout.write("compaction event\n");
	const base = fake.fakeState.callCount;
	const summary = "SUMMARY: the user asked two questions and both were answered.";
	const sent: SentRequest[] = [];
	recordRequests(sent, [
		fakeAssistantMessage("answer one"),
		fakeAssistantMessage("answer two"),
		fakeAssistantMessage(summary),
		fakeAssistantMessage("answer three"),
	]);
	// A 33,035-token window is the smallest one whose reserve is still the full 33k, which puts the
	// trigger at 35 estimated tokens: between the conversation the second question produces (~27) and the
	// one the third produces (~41), so exactly one compaction happens, on the third request. Nothing is
	// kept verbatim, so the cut lands on the newest turn start —the question just asked —and the two
	// completed exchanges are what it folds in.
	const agent = await openSession({}, { models: windowedRows(33_035) });

	const announced: Extract<AgentSessionEvent, { type: "compaction" }>[] = [];
	onSessionEvent(agent, (event) => {
		if (event.type === "compaction") announced.push(event);
	});

	const questions = [
		"question one with enough words to estimate tokens",
		"question two with enough words to estimate tokens",
		"question three with enough words to estimate tokens",
	];
	for (const text of questions) {
		const run = await within("a run", 10_000, agent.prompt(sidOf(agent), text));
		check(`"${text.slice(0, 12)}..." completes`, run.ok);
	}
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	check("exactly one compaction was announced", announced.length === 1, JSON.stringify(announced.length));
	const event = announced[0];
	check("carrying the summary the model produced", event?.summary === summary, JSON.stringify(event?.summary));
	// The third prompt is already written when its request is prepared, so the cut lands on that turn
	// start and the two completed exchanges are what the summary stands for — plus the birth message
	// `openSession` gave the session (ADR-0021), which is part of the history being folded.
	check("with the messages it stands for", event?.summarized === 5, JSON.stringify(event?.summarized));
	check("and a live estimate of what is still in context", (event?.contextTokens ?? 0) > 0, JSON.stringify(event?.contextTokens));
	check("four provider calls were made: three answers and one summary", fake.fakeState.callCount - base === 4, String(fake.fakeState.callCount - base));
	// The summary is a request like any other, so it authenticates like one: the key rides on the model
	// the summary is made with, which is what makes compaction work on a session whose row has a key and
	// whose key the loop is not there to copy in — this call never travels through the loop.
	check("and the summary carried the row's key", sent[2]?.apiKey === ROW.apiKey, String(sent[2]?.apiKey));

	// The conversation the provider was sent for the third question is where compaction shows: the two
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
	const entryTypes = entriesOf(agent).map((entry) => entry.type);
	check("the session still holds every message", allMessages(agent).length === 6, JSON.stringify(allMessages(agent).length));
	check("and one compaction entry", entryTypes.filter((type) => type === "compaction").length === 1, JSON.stringify(entryTypes));
	const kept = entriesOf(agent).find((entry) => entry.type === "message" && textOf(entry.message) === questions[2]);
	check("whose first kept entry is the surviving turn", event?.firstKeptEntryId === kept?.id, `${event?.firstKeptEntryId} vs ${kept?.id}`);

	await agent.close(sidOf(agent));
}

/** `applyConfig` says what moved and nothing else: unchanged fields stay out of the event. */
async function exerciseConfigChanged(): Promise<void> {
	process.stdout.write("config changed\n");
	// A second row gives the source a second model, so a model change is observable at all. Both are
	// answered by the same scripted transport: nothing here sends a request.
	const twoRows: ModelConfig[] = [ROW, { ...ROW, name: "faux2" }];
	// The in-force model is the fallback answer (the first row), so moving to the second row is a
	// change the composer's event can name.
	const agent = await openSession({ modes: [{ name: "reader", tools: ["read"], approval: { bash: true } }] }, { models: twoRows });

	const seen: Extract<AgentSessionEvent, { type: "config_changed" }>[] = [];
	onSessionEvent(agent, (event) => {
		if (event.type === "config_changed") seen.push(event);
	});

	agent.applyConfig(sidOf(agent), { mode: "reader" });
	check("one config_changed for the mode", seen.length === 1, JSON.stringify(seen));
	check(
		"carrying the new seat alone",
		JSON.stringify(seen[0]) === JSON.stringify({ type: "config_changed", mode: "reader" }),
		JSON.stringify(seen[0]),
	);

	agent.applyConfig(sidOf(agent), { mode: "reader" });
	check("re-applying the same mode says nothing", seen.length === 1, JSON.stringify(seen));
	agent.applyConfig(sidOf(agent), {});
	check("an empty patch says nothing", seen.length === 1, JSON.stringify(seen));

	// The approval delta is a session-side write and carries no event: the effective map is re-derived
	// at every read from the pointer and the delta together, so no client patches it incrementally.
	agent.applyConfig(sidOf(agent), { approval: { bash: false, read: true } });
	check("an approval delta says nothing", seen.length === 1, JSON.stringify(seen));

	agent.applyConfig(sidOf(agent), { mode: null });
	check(
		"returning to the default carries the explicit null",
		seen.length === 2 && JSON.stringify(seen[1]) === JSON.stringify({ type: "config_changed", mode: null }),
		JSON.stringify(seen[1]),
	);

	// The composer's choice, which is not a config patch: it moves the session and nothing else.
	agent.applyModelSelection(sidOf(agent), { model: "faux2" });
	check(
		"a model change carries the model alone",
		seen.length === 3 && JSON.stringify(seen[2]) === JSON.stringify({ type: "config_changed", model: "faux2" }),
		JSON.stringify(seen[2]),
	);
	agent.applyModelSelection(sidOf(agent), { model: "faux2" });
	check("re-selecting the current model says nothing", seen.length === 3, JSON.stringify(seen));

	agent.applyModelSelection(sidOf(agent), { thinkingLevel: "off" });
	check("so re-applying it says nothing", seen.length === 3, JSON.stringify(seen));

	await agent.close(sidOf(agent));
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
	const agent = await openSession();

	agent.hooks.on("before_tool", (event) => {
		seen.push({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
		return { block: { reason: "the smoke test refused this call" } };
	});

	await within("the run", 10_000, agent.prompt(sidOf(agent), "read never-read.txt"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	check("the handler saw the scripted call", seen.length === 1 && seen[0]?.toolName === "read", JSON.stringify(seen));
	check("with the call's own id", (seen[0]?.toolCallId ?? "").length > 0, JSON.stringify(seen));
	check("and its validated arguments", JSON.stringify(seen[0]?.args).includes("never-read.txt"), JSON.stringify(seen[0]?.args));

	const errored = allMessages(agent).find(
		(message) => message.role === "toolResult" && textOf(message).includes("the smoke test refused this call"),
	);
	check(
		"the block is an errored tool result",
		errored !== undefined && (errored as { isError?: boolean }).isError === true,
		JSON.stringify(allMessages(agent).map((message) => [message.role, textOf(message).slice(0, 30)])),
	);
	check(
		"which the next request carries, so the model can see it",
		(sent[1]?.texts ?? []).some((text) => text.includes("the smoke test refused this call")),
		JSON.stringify(sent[1]?.texts),
	);
	check("and the tool never ran", (sent[1]?.texts ?? []).every((text) => !text.includes("File not found")), JSON.stringify(sent[1]?.texts));
	check(
		"the run carried on to an answer",
		agent.snapshot(sidOf(agent)).messages.some((message) => message.role === "assistant" && textOf(message) === "understood"),
	);

	await agent.close(sidOf(agent));
}

/**
 * A test `after_tool` handler rewrites what the model is shown — and that rewrite is final: the
 * session keeps exactly what the hook returned, because the ledger no longer stores a second
 * version. The write is the decision.
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
	const agent = await openSession();

	agent.hooks.on("after_tool", (event) =>
		event.toolName === "read" ? { content: [{ type: "text", text: "REPLACED BY THE TEST HOOK" }] } : undefined,
	);

	await within("the first run", 10_000, agent.prompt(sidOf(agent), "read hook.txt"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));
	await within("the second run", 10_000, agent.prompt(sidOf(agent), "and what did it say"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	const first = sent[1]?.texts ?? [];
	check("the request after the call carries what the hook put there", first.some((text) => text.includes("REPLACED BY THE TEST HOOK")), JSON.stringify(first));
	check("and not what the tool returned", first.every((text) => !text.includes("the tool's own words")), JSON.stringify(first));
	check("a later request still carries it", (sent[2]?.texts ?? []).some((text) => text.includes("REPLACED BY THE TEST HOOK")), JSON.stringify(sent[2]?.texts));
	check(
		"and the session keeps the rewrite, not the tool's output",
		toolResultTexts(agent).some((text) => text.includes("REPLACED BY THE TEST HOOK")) &&
			toolResultTexts(agent).every((text) => !text.includes("the tool's own words")),
		JSON.stringify(toolResultTexts(agent)),
	);

	const sessionFile = agent.fileAbsPathOf(sidOf(agent));
	await agent.close(sidOf(agent));

	process.stdout.write("after_tool hook — the rewrite survives the file\n");
	const reopenedFile = fillSession(sessionFile!);
	const fileEntries = sessionManager.getEntries(reopenedFile);
	const rewrittenEntry = fileEntries.find(
		(entry): entry is MessageEntry =>
			entry.type === "message" && entry.message.role === "toolResult" && textOf(entry.message).includes("REPLACED BY THE TEST HOOK"),
	);
	check("the rewritten content is in the file itself", rewrittenEntry !== undefined);
	// Six kinds, and nothing else: the legacy `tool_result_view` kind is gone with the v5 format.
	const kinds = new Set<string>(fileEntries.map((entry) => entry.type));
	check(
		"the file holds only the six v5 kinds",
		JSON.stringify([...kinds].sort()) ===
			JSON.stringify(["clear_tool_result", "compaction", "leaf", "message", "trim_tool_call_arg", "usage"].filter((kind) => kinds.has(kind))),
		JSON.stringify([...kinds]),
	);
	const sessionTexts = JSON.stringify(sessionManager.buildSessionContext(reopenedFile).messages);
	check(
		"the session a window reads is the rewrite",
		sessionTexts.includes("REPLACED BY THE TEST HOOK") && !sessionTexts.includes("the tool's own words"),
		sessionTexts.slice(0, 200),
	);

	const sentReplay: SentRequest[] = [];
	recordRequests(sentReplay, [fakeAssistantMessage("replayed")]);
	// 重放会话与 openSession 同一套接缝：临时 home + 各持有者预种（spec §8）。
	const replayHome = join(root, `agent-home-${homeSeq++}`);
	await mkdir(replayHome, { recursive: true });
	const replayToolManager = createToolManager({ home: replayHome });
	replayToolManager.applyToolDefaults({ approval: settings().approval });
	new ModelManager({ home: replayHome }).applyRetry(settings().retry);
	new ModelManager({ home: replayHome }).replaceRows(rows);
	const replayed = await openAgent({
		session: reopenedFile,
		chatTransport: fake.chatTransport,
		settingsHome: replayHome,
		modelsHome: replayHome,
	});
	// 这个会话的文件由上面的练习亲手写就，没有经 `openSession` 的出生消息——没有可滤的出生条目，
	// 空串让它原样通过。
	opened.set(replayed, { id: reopenedFile.sessionId, session: reopenedFile, home: replayHome, birthEntryId: "" });
	try {
		await within("the reopened run", 10_000, replayed.prompt(sidOf(replayed), "one more time"));
		await within("settle()", 10_000, replayed.settle(sidOf(replayed)));
		check(
			"a request after reopen still carries the rewrite",
			(sentReplay[0]?.texts ?? []).some((text) => text.includes("REPLACED BY THE TEST HOOK")),
			JSON.stringify(sentReplay[0]?.texts),
		);
		check(
			"and still not what the tool returned",
			(sentReplay[0]?.texts ?? []).every((text) => !text.includes("the tool's own words")),
			JSON.stringify(sentReplay[0]?.texts),
		);
	} finally {
		await replayed.close(sidOf(replayed));
	}
}

/**
 * The write boundary's backstop bounds a result nothing else bounded: it is archived whole under the
 * working directory and the ledger keeps the head-and-tail view that names the file.
 *
 * The tool is registered by this test because every built-in bounds its own output; a tool that forgets
 * is exactly what the backstop at the write is for.
 */
async function exerciseOutputBackstop(): Promise<void> {
	process.stdout.write("output backstop\n");
	const huge = `HEAD-${"A".repeat(MAX_TOOL_RESULT_BYTES)}-TAIL-MARKER`;
	// home 递临时目录：openSession 经这张表预种工具簇，不得落在机器的 tools.json 上。
	const toolManager = createToolManager({ home: join(root, "agent-home-unbounded") });
	toolManager.register({
		name: "unbounded",
		label: "unbounded",
		description: "Returns more than the session's budget; registered by the smoke test.",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: huge }], details: undefined }),
	});

	const sent: SentRequest[] = [];
	recordRequests(sent, [
		fakeAssistantMessage(fakeToolCall("unbounded", {})),
		fakeAssistantMessage("clipped"),
		fakeAssistantMessage("again"),
	]);
	const agent = await openSession({}, {}, toolManager);

	await within("the run", 10_000, agent.prompt(sidOf(agent), "run the unbounded tool"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	const shown = (sent[1]?.texts ?? []).find((text) => text.includes("HEAD-")) ?? "";
	check("so the request the model received is inside the budget", Buffer.byteLength(shown) <= MAX_TOOL_RESULT_BYTES, `${Buffer.byteLength(shown)} bytes`);
	check("with a notice that it was clipped", shown.includes("characters omitted"), shown.slice(0, 80));
	check("and it is shorter than what the tool returned", shown.length < huge.length, `${shown.length} of ${huge.length}`);
	check(
		"the ledger keeps the bounded version, not the tool's whole output",
		toolResultTexts(agent).some((text) => text.includes("characters omitted")) &&
			toolResultTexts(agent).every((text) => text.length < huge.length),
		JSON.stringify(toolResultTexts(agent).map((text) => text.length)),
	);
	check(
		"the stored result is not an error",
		allMessages(agent).every((message) => (message as { isError?: boolean }).isError !== true),
		JSON.stringify(allMessages(agent).map((message) => message.role)),
	);

	// The archive is the full text, under the working directory the session ran in.
	const archiveDir = join(root, ".my-agent", "tool-results", sidOf(agent));
	const archived = (await readdir(archiveDir)).find((name) => name.endsWith(".txt"));
	check("the full output was archived", archived !== undefined, archiveDir);
	const archivedText = archived === undefined ? "" : await readFile(join(archiveDir, archived), "utf8");
	check(
		"and the archive holds the tool's whole output",
		archivedText.length === huge.length && archivedText.includes("-TAIL-MARKER"),
		`${archivedText.length} of ${huge.length}`,
	);

	await agent.close(sidOf(agent));
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
	const agent = await openSession();

	await within("the first run", 10_000, agent.prompt(sidOf(agent), "what needs approval"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));
	check("no tool asks for approval yet", approvalTools(sent[0]?.prompt ?? "") === "", JSON.stringify(approvalTools(sent[0]?.prompt ?? "")));

	agent.applyConfig(sidOf(agent), { approval: { bash: true } });
	await within("the second run", 10_000, agent.prompt(sidOf(agent), "and now"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	check(
		"the next request's leading system message names bash",
		approvalTools(sent[1]?.prompt ?? "") === "bash",
		JSON.stringify(approvalTools(sent[1]?.prompt ?? "")),
	);
	check("and that message still leads the request", sent[1]?.roles[0] === "system", JSON.stringify(sent[1]?.roles));
	check(
		"carrying the tool declarations as well",
		JSON.stringify(sent[1]?.tools) === JSON.stringify(["read", "write", "edit", "glob", "grep", "bash"]),
		JSON.stringify(sent[1]?.tools),
	);
	check(
		"the approval is the session's own delta on the snapshot",
		JSON.stringify(agent.sessionManager.getRecordedToolConfig(bagOf(agent)).approval) === JSON.stringify({ bash: true }),
		JSON.stringify(agent.sessionManager.getRecordedToolConfig(bagOf(agent)).approval),
	);

	await agent.close(sidOf(agent));
}

/**
 * The approval gate suspends the run, and the answer starts the run that closes the call.
 *
 * Under the end-restart semantics (ADR-0005 §5) the gate does not park the run in memory and does
	 * not write a result: the run ends with the call dangling in the session — that dangling call is
 * what the banner is derived from — and the answer arrives over REST to start the recovery run,
 * whose first act is to pair the answer with the call and continue. A denial closes the call with
 * the sentence a pressed deny writes; a grant re-runs the call through the gate and the tool itself.
 * The abandonment half — a call nobody answered — is exercised on a call that dangles the way a
 * crash leaves one, which `denyAllApprovals` closes with its own reason.
 */
async function exerciseApprovalDenial(): Promise<void> {
	process.stdout.write("approval denial reason\n");

	// The gate suspends the run instead of parking it: no memory wait, and the call dangles with no
	// result at all — that absence is the question the window answers.
	const gated = await openSession({ approval: { read: true } });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("done")]);
	const ended = await within("the run to the gate", 10_000, gated.prompt(sidOf(gated), "read the notes"));
	check("the run ended at the gate rather than parking", ended.ok);
	check("and the waiting call is derived from the ledger", gated.snapshot(sidOf(gated)).pendingApprovals.length > 0);
	check("the snapshot names exactly the call the gate stopped on", gated.snapshot(sidOf(gated)).pendingApprovals.length === 1, JSON.stringify(gated.snapshot(sidOf(gated)).pendingApprovals));
	await within("settle()", 10_000, gated.settle(sidOf(gated)));

	const gatedResults = toolResultTexts(gated);
	check(
		"the suspended call has no result in the session",
		gatedResults.every((text) => !text.includes("needs approval") && !text.includes("denied permission")),
		JSON.stringify(gatedResults),
	);
	// The suspend ends the run without another request: the model is not shown the gate and cannot
	// re-issue the call into it.
	check("the run never reached the scripted answer", !gated.snapshot(sidOf(gated)).messages.some((message) => message.role === "assistant" && textOf(message) === "done"));

	// Denied: the answer starts the recovery run, the pass pairs it with the dangling call, and the
	// model is shown the denial and carries on.
	const callId = gated.snapshot(sidOf(gated)).pendingApprovals[0]?.toolCallId ?? "";
	check("the suspended call is the one the predicate answers", gated.hasPendingApproval(sidOf(gated), callId), callId);
	await within("the deny's recovery run", 10_000, gated.respondApproval(sidOf(gated), callId, false));
	await within("settle() after the deny", 10_000, gated.settle(sidOf(gated)));

	const deniedResults = toolResultTexts(gated);
	check(
		"the recovery pass closed the call with the deny's own sentence",
		deniedResults.some((text) => text.includes("The user denied permission to run read.")),
		JSON.stringify(deniedResults),
	);
	check("the answered call is no longer waiting", !gated.hasPendingApproval(sidOf(gated), callId));
	check("and the model answered the denial", gated.snapshot(sidOf(gated)).messages.some((message) => message.role === "assistant" && textOf(message) === "done"));

	await gated.close(sidOf(gated));

	// Granted: the recovery run re-runs the call through the gate and the tool itself — the gate
	// lets it through because the grant recorded the session's own approval choice.
	const granted = await openSession({ approval: { read: true } });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("done")]);
	await within("the grant's run to the gate", 10_000, granted.prompt(sidOf(granted), "read the notes"));
	check("the grant starts from a tool the map gates", granted.getApprovals(sidOf(granted)).read === true);
	const grantedId = granted.snapshot(sidOf(granted)).pendingApprovals[0]?.toolCallId ?? "";
	await within("the grant's recovery run", 10_000, granted.respondApproval(sidOf(granted), grantedId, true));
	await within("settle() after the grant", 10_000, granted.settle(sidOf(granted)));

	check("a grant is recorded as the session's own approval choice", granted.getApprovals(sidOf(granted)).read === false);
	check("the granted call ran and its result is in the session", toolResultTexts(granted).some((text) => text.includes("notes.txt")), JSON.stringify(toolResultTexts(granted)));
	check("the answered call is no longer waiting", !granted.hasPendingApproval(sidOf(granted), grantedId));
	check("and the model carried on after the granted call", granted.snapshot(sidOf(granted)).messages.some((message) => message.role === "assistant" && textOf(message) === "done"));

	await granted.close(sidOf(granted));

	// A call that dangles the way a crash leaves one: the tool_use is in the session, the result is
	// not, and the ledger is where the waiting shows. An abandonment keeps its own reason.
	const abandoned = await openSession();
	abandoned.sessionManager.appendMessage(bagOf(abandoned), fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })));
	check("the dangling call is derived from the ledger", abandoned.snapshot(sidOf(abandoned)).pendingApprovals.length > 0);
	const waiting = abandoned.snapshot(sidOf(abandoned)).pendingApprovals[0]?.toolCallId ?? "";
	check("the predicate names the waiting call", abandoned.hasPendingApproval(sidOf(abandoned), waiting), waiting);
	check("an id nothing waits on is not pending", !abandoned.hasPendingApproval(sidOf(abandoned), "no-such-call"));

	abandoned.denyAllApprovals(sidOf(abandoned), "No window answered this approval.");
	check("the predicate cleared once the answer arrived", !abandoned.hasPendingApproval(sidOf(abandoned), waiting));

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

	await abandoned.close(sidOf(abandoned));
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
	const narrowed = ["read", "edit", "glob", "grep", "bash"];
	const agent = await openSession({ modes: [{ name: "narrow", tools: narrowed, approval: NO_GATES }] });

	await within("the first run", 10_000, agent.prompt(sidOf(agent), "which tools do you have"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	const dropped = "bash";
	agent.applyConfig(sidOf(agent), { mode: "narrow" });
	await within("the second run", 10_000, agent.prompt(sidOf(agent), "and now"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

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
		agent.snapshot(sidOf(agent)).messages.every((message) => message.role !== "system"),
		JSON.stringify(agent.snapshot(sidOf(agent)).messages.map((message) => message.role)),
	);

	await agent.close(sidOf(agent));
}

/**
 * The table on its own: one `Map` of instances, and the rule that keeps its contents from the choice —
 * which arrives as data with every read, derived from the ledger by the session, never held here.
 *
 * `executionMode` is checked here because it is the reason the table holds no such choice: it is a
 * field on each instance, so narrowing the active set cannot change how a tool runs. What the table
 * does hold is the instances themselves, so `get(name)` answers the same object every time — and the
 * request declares that same object, which is the identity half of ADR-0011. The array is still
 * rebuilt per request; only the elements are invariant.
 */
async function exerciseToolManager(): Promise<void> {
	process.stdout.write("tool manager\n");
	// home 递临时目录：这张表也会被递给 openSession 预种工具簇，不得落在机器的 tools.json 上。
	const toolManager = createToolManager({ home: join(root, "agent-home-table") });
	const builtIns = ["read", "write", "edit", "glob", "grep", "bash"];

	check("names() holds the six built-ins in registration order", JSON.stringify(toolManager.names()) === JSON.stringify(builtIns), JSON.stringify(toolManager.names()));
	check("get() returns the named tool", toolManager.get("bash")?.name === "bash");
	check("get() returns undefined for a name nobody knows", toolManager.get("nope") === undefined);
	check("executionMode is a field on the instance", toolManager.get("bash")?.executionMode === "sequential", String(toolManager.get("bash")?.executionMode));
	check("get() answers the same instance every time", toolManager.get("bash") === toolManager.get("bash"));
	check("while names() keeps every tool", toolManager.names().length === 6, String(toolManager.names().length));
	check("and a name this build does not know is dropped by the read, not thrown at", JSON.stringify(narrowToKnown(["read", "nope"], toolManager.names())) === JSON.stringify(["read"]), JSON.stringify(narrowToKnown(["read", "nope"], toolManager.names())));

	const noop: Tool<any> = {
		name: "noop",
		label: "noop",
		description: "Does nothing; registered by the smoke test.",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "noop" }], details: undefined }),
	};
	toolManager.register(noop);
	check("register() adds the tool to the table", toolManager.get("noop") === noop && toolManager.names().includes("noop"), JSON.stringify(toolManager.names()));
	let duplicate = "";
	try {
		toolManager.register(noop);
	} catch (error) {
		duplicate = error instanceof Error ? error.message : String(error);
	}
	check("and a second registration of one name is refused", duplicate === "Tool already registered: noop", duplicate);
	let collision = "";
	try {
		toolManager.register({ ...noop, name: "read" });
	} catch (error) {
		collision = error instanceof Error ? error.message : String(error);
	}
	check("and so is one that would overwrite a built-in", collision === "Tool already registered: read", collision);

	// The identity ADR-0011 promises is measured per request, and the wire alone cannot show it: a
	// request carries declarations (`toToolDeclaration` replaces each tool with its four declared
	// fields, and ADR-0010 §2.5 keeps that), so the transport sees names and schemas, never the
	// instance. What it can show is that the request built a new list. The instance itself is read
	// where this request's `Context.tools` element is dereferenced — a probe registered on the same
	// table records `this` from inside its own `execute`.
	const ran: Tool<any>[] = [];
	const probe: Tool<any> = {
		name: "probe",
		label: "probe",
		description: "Records the instance the engine ran; registered by the smoke test.",
		parameters: { type: "object", properties: {} },
		async execute() {
			ran.push(this);
			return { content: [{ type: "text", text: "probed" }], details: undefined };
		},
	};
	toolManager.register(probe);

	const sent: SentRequest[] = [];
	recordRequests(sent, [
		fakeAssistantMessage(fakeToolCall("probe", {})),
		fakeAssistantMessage("first done"),
		fakeAssistantMessage(fakeToolCall("probe", {})),
		fakeAssistantMessage("second done"),
	]);
	const agent = await openSession({ modes: [{ name: "probe-only", tools: ["read", "probe"], approval: NO_GATES }] }, {}, toolManager);
	await within("the run", 10_000, agent.prompt(sidOf(agent), "probe once"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));
	// A narrowing between the two requests: `read` and `probe` stay, `noop` and the rest go.
	agent.applyConfig(sidOf(agent), { mode: "probe-only" });
	await within("the run", 10_000, agent.prompt(sidOf(agent), "probe once more"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	check("the request ran the table's own instance", ran[0] === toolManager.get("probe"));
	check("and the next request ran that same one", ran[0] === ran[1]);
	check("while the request's tool list itself is new per request", sent[0]?.instances !== sent[1]?.instances);
	check(
		"the choice, not the table, decides what a request declares",
		JSON.stringify(sent[2]?.tools) === JSON.stringify(["read", "probe"]) && sent[2]?.tools.includes("noop") === false,
		JSON.stringify(sent[2]?.tools),
	);

	const other: SentRequest[] = [];
	recordRequests(other, [fakeAssistantMessage(fakeToolCall("probe", {})), fakeAssistantMessage("third done")]);
	const secondSession = await openSession({}, {}, toolManager);
	await within("the run", 10_000, secondSession.prompt(sidOf(secondSession), "probe from elsewhere"));
	await within("settle()", 10_000, secondSession.settle(sidOf(secondSession)));
	check("another session ran that same instance too", ran[2] === toolManager.get("probe"));

	await agent.close(sidOf(agent));
	await secondSession.close(sidOf(secondSession));
}

/**
 * A mode without a tool leaves it out of the resolved active set, the prompt, and the declarations
 * the model gets.
 *
 * The prompt is read back from the provider request rather than from the registry: a prompt that still
 * named `write` would advertise a tool the loop then refuses to run.
 */
async function exerciseActiveTools(): Promise<void> {
	process.stdout.write("active tools\n");
	const sent: SentRequest[] = [];
	recordRequests(sent, [fakeAssistantMessage("first answer"), fakeAssistantMessage("second answer")]);
	const narrowed = ["read", "edit", "glob", "grep", "bash"];
	const agent = await openSession({ modes: [{ name: "narrow", tools: narrowed, approval: NO_GATES }] });

	const seats: (string | null)[] = [];
	onSessionEvent(agent, (event) => {
		if (event.type === "config_changed" && event.mode !== undefined) seats.push(event.mode);
	});

	await within("the run", 10_000, agent.prompt(sidOf(agent), "what can you do"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));
	check("the registry reports the built-ins", JSON.stringify(agent.toolNames()) === JSON.stringify(["read", "write", "edit", "glob", "grep", "bash"]), JSON.stringify(agent.toolNames()));
	check("and the model was offered write", availableTools(sent[0]?.prompt ?? "").includes("write"), JSON.stringify(availableTools(sent[0]?.prompt ?? "")));
	check("which the request also declared", sent[0]?.tools.includes("write") === true, JSON.stringify(sent[0]?.tools));

	agent.applyConfig(sidOf(agent), { mode: "narrow" });
	check("snapshot.mode names the applied mode", agent.snapshot(sidOf(agent)).mode === "narrow", agent.snapshot(sidOf(agent)).mode);
	check("toolNames still reports every registered tool", agent.toolNames().length === 6, JSON.stringify(agent.toolNames()));
	check("the change is announced, so a client needs no new snapshot", JSON.stringify(seats) === JSON.stringify(["narrow"]), JSON.stringify(seats));

	await within("the run", 10_000, agent.prompt(sidOf(agent), "and now"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));
	check("the next prompt no longer offers write", availableTools(sent[1]?.prompt ?? "").includes("write") === false, JSON.stringify(availableTools(sent[1]?.prompt ?? "")));
	check("while keeping the other tools", availableTools(sent[1]?.prompt ?? "").includes("read") && availableTools(sent[1]?.prompt ?? "").includes("bash"), JSON.stringify(availableTools(sent[1]?.prompt ?? "")));
	check("and the request declares the narrower set", JSON.stringify(sent[1]?.tools) === JSON.stringify(narrowed), JSON.stringify(sent[1]?.tools));
	check("both asks are in the session", textsOf(agent).length === 2, JSON.stringify(textsOf(agent)));

	await agent.close(sidOf(agent));
}

/**
 * A scripted call to a tool that is not active is a tool error, and the tool never runs.
 *
 * Deactivating a tool takes it out of the snapshot, the prompt, and the declarations the model gets
 * — that half is asserted by `exerciseActiveTools`, and the narrowing below is the other half of it:
 * a model that asks anyway names a tool this request no longer offers. The table still holds it
 * (ADR-0011), so "the name exists" and "this run may call it" are two answers, and the run's own
 * list is the one that refuses: the same name runs again, unchanged, once it is switched back on.
 */
async function exerciseDeactivatedToolCall(): Promise<void> {
	process.stdout.write("deactivated tool call\n");
	const agent = await openSession({ modes: [{ name: "no-write", tools: ["read", "edit", "glob", "grep", "bash"], approval: NO_GATES }] });
	agent.applyConfig(sidOf(agent), { mode: "no-write" });

	const ends: { toolName: string; isError: boolean; text: string }[] = [];
	onSessionEvent(agent, (event) => {
		if (event.type === "tool_execution_end") {
			ends.push({ toolName: event.toolName, isError: event.isError, text: textOf({ content: event.result?.content } as Message) });
		}
	});

	recordRequests([], [fakeAssistantMessage(fakeToolCall("write", { path: "blocked.txt", content: "nope" })), fakeAssistantMessage("done")]);
	await within("the run", 10_000, agent.prompt(sidOf(agent), "write blocked.txt"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	check("the deactivated call ran and failed", ends.length === 1 && ends[0]?.toolName === "write" && ends[0]?.isError === true, JSON.stringify(ends));
	check("with a not-found error rather than a result", ends[0]?.text.includes("not found") === true, JSON.stringify(ends[0]?.text));
	check("the tool did not touch the directory", (await access(join(root, "blocked.txt")).then(() => true, () => false)) === false);
	check(
		"the session records it as an errored tool result",
		allMessages(agent).some((message) => (message as { role?: string; isError?: boolean }).role === "toolResult" && (message as { isError?: boolean }).isError === true),
		JSON.stringify(allMessages(agent).map((message) => message.role)),
	);
	check("the run carried on to an answer", agent.snapshot(sidOf(agent)).messages.some((message) => message.role === "assistant" && textOf(message) === "done"));

	// The refusal is the list's, not the table's: the same call, the same table, the tool switched
	// back on — and it writes. A refusal that came from `get` finding nothing could not be undone
	// without a restart.
	agent.applyConfig(sidOf(agent), { mode: null });
	recordRequests([], [fakeAssistantMessage(fakeToolCall("write", { path: "allowed.txt", content: "yes" })), fakeAssistantMessage("written")]);
	await within("the run", 10_000, agent.prompt(sidOf(agent), "write allowed.txt"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));
	check("switched back on, the same call runs", ends[1]?.toolName === "write" && ends[1]?.isError === false, JSON.stringify(ends[1]));
	check("and reaches the directory", (await access(join(root, "allowed.txt")).then(() => true, () => false)) === true);

	await agent.close(sidOf(agent));
}

/**
 * A deactivated sequential tool does not make the batch it appears in sequential.
 *
 * The mode is a property of the instance, and the table answers for every instance — so a batch
 * that mentions a tool this run may not call must be judged over the calls that will actually run.
 * Read as the table answers, a switched-off `bash` would flip a read batch to sequential, which is a
 * scheduling decision taken on behalf of a call that is answered with an error before it starts.
 *
 * What a mode does is observable in the event order: a parallel batch announces every call it will
 * run before the first result lands, a sequential one announces each call as it reaches it. Both
 * calls are scripted into one answer, `bash` first-class and refused.
 */
	async function exerciseDeactivatedToolBatch(): Promise<void> {
	process.stdout.write("deactivated tool in a batch\n");
	await writeFile(join(root, "batch.txt"), "batch\n");
	const agent = await openSession({ modes: [{ name: "no-bash", tools: ["read", "glob", "grep", "edit"], approval: NO_GATES }] });
	agent.applyConfig(sidOf(agent), { mode: "no-bash" });

	const log: string[] = [];
	/** What the `bash` call ended with, so "refused" is read off its result and not off its name. */
	const bashEnd: { isError: boolean; text: string }[] = [];
	onSessionEvent(agent, (event) => {
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			log.push(`${event.type === "tool_execution_start" ? "start" : "end"}:${event.toolName}`);
		}
		if (event.type === "tool_execution_end" && event.toolName === "bash") {
			bashEnd.push({ isError: event.isError, text: textOf({ content: event.result?.content } as Message) });
		}
	});

	recordRequests([], [
		fakeAssistantMessage([fakeToolCall("read", { path: "batch.txt" }), fakeToolCall("bash", { command: "echo hi" })]),
		fakeAssistantMessage("done"),
	]);
	await within("the run", 10_000, agent.prompt(sidOf(agent), "read the file and run echo"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	check(
		"both calls were announced before either result landed",
		JSON.stringify(log) === JSON.stringify(["start:read", "start:bash", "end:bash", "end:read"]),
		JSON.stringify(log),
	);
	check(
		"and the deactivated bash ended as a not-found error, not a run",
		bashEnd.length === 1 && bashEnd[0]?.isError === true && bashEnd[0]?.text.includes("not found") === true,
		JSON.stringify(bashEnd),
	);

	await agent.close(sidOf(agent));
}

/** An unknown mode name is refused before anything moves, so the session keeps the pointer it had. */
async function exerciseUnknownTool(): Promise<void> {
	process.stdout.write("unknown tool\n");
	const agent = await openSession({ modes: [{ name: "reader", tools: ["read"], approval: NO_GATES }] });
	const before = JSON.stringify(agent.sessionManager.getRecordedToolConfig(bagOf(agent)));

	const seen: AgentSessionEvent[] = [];
	onSessionEvent(agent, (event) => seen.push(event));

	let threw = false;
	try {
		agent.applyConfig(sidOf(agent), { mode: "no-such-mode" });
	} catch {
		threw = true;
	}
	check("applyConfig throws on an unknown mode name", threw);
	check("the session keeps its previous pointer", JSON.stringify(agent.sessionManager.getRecordedToolConfig(bagOf(agent))) === before, `${before} -> ${JSON.stringify(agent.sessionManager.getRecordedToolConfig(bagOf(agent)))}`);
	check("and no change was announced", seen.every((event) => event.type !== "config_changed"), JSON.stringify(seen.map(labelOf)));

	fake.setResponses([fakeAssistantMessage("still here")]);
	const run = await within("the run", 10_000, agent.prompt(sidOf(agent), "still working?"));
	check("the session still runs after the refusal", run.ok);
	await within("settle()", 10_000, agent.settle(sidOf(agent)));
	check("and answers", agent.snapshot(sidOf(agent)).messages.some((message) => message.role === "assistant" && textOf(message) === "still here"));

	await agent.close(sidOf(agent));
}

/** A mode whose list is empty is a conversation without tools, not a broken session. */
async function exerciseEmptyToolSet(): Promise<void> {
	process.stdout.write("empty tool set\n");
	const sent: SentRequest[] = [];
	recordRequests(sent, [fakeAssistantMessage("a conversation it is")]);
	const agent = await openSession({ modes: [{ name: "silent", tools: [], approval: NO_GATES }] });

	agent.applyConfig(sidOf(agent), { mode: "silent" });
	check("an empty active set is allowed", agent.snapshot(sidOf(agent)).mode === "silent", agent.snapshot(sidOf(agent)).mode);
	check("with nothing active and everything still registered", agent.toolNames().length === 6, JSON.stringify(agent.toolNames()));

	const run = await within("the run", 10_000, agent.prompt(sidOf(agent), "hello without tools"));
	check("a session with no tools still holds a conversation", run.ok);
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	check("the model was told there are none", availableTools(sent[0]?.prompt ?? "") === "none.", JSON.stringify(availableTools(sent[0]?.prompt ?? "")));
	check("and was offered no declarations at all", JSON.stringify(sent[0]?.tools) === "[]", JSON.stringify(sent[0]?.tools));
	check("the question is in the session", textsOf(agent).includes("hello without tools"), JSON.stringify(textsOf(agent)));
	check("and so is the answer", agent.snapshot(sidOf(agent)).messages.some((message) => message.role === "assistant" && textOf(message) === "a conversation it is"));

	await agent.close(sidOf(agent));
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
 * The failed attempts must be invisible everywhere the conversation is read: the session record, the
 * context the model is sent next, and the user's own text, which `prompt` persisted before the
 * first attempt and which no retry may write again.
 */
async function exerciseRetry(): Promise<void> {
	process.stdout.write("retry\n");
	const base = fake.fakeState.callCount;
	const sent: SentRequest[] = [];
	recordRequests(sent, [
		failedAttempt("503 service unavailable"),
		failedAttempt("overloaded"),
		fakeAssistantMessage("recovered"),
		fakeAssistantMessage("second answer"),
	]);
	const agent = await openSession();

	const trace: RetryTrace[] = [];
	const live: { retrying: boolean; attempt: number }[] = [];
	onSessionEvent(agent, (event) => {
		if (event.type === "retry_scheduled") {
			trace.push({
				type: event.type,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			});
			live.push({ retrying: agent.snapshot(sidOf(agent)).isRetrying, attempt: agent.snapshot(sidOf(agent)).retryAttempt });
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

	await within("the run", 10_000, agent.prompt(sidOf(agent), "retry question"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

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

	check("three provider calls answered one question", fake.fakeState.callCount - base === 3, String(fake.fakeState.callCount - base));
	check(
		"the session holds one user turn",
		JSON.stringify(textsOf(agent)) === JSON.stringify(["retry question"]),
		JSON.stringify(textsOf(agent)),
	);
	const assistants = agent.snapshot(sidOf(agent)).messages.filter((message) => message.role === "assistant");
	check(
		"and one assistant message, the answer that came back",
		assistants.length === 1 && textOf(assistants[0]!) === "recovered",
		JSON.stringify(assistants.map(textOf)),
	);
	check(
		"no failed attempt reached the session",
		allMessages(agent).every(
			(message) => !textOf(message).includes("503") && !textOf(message).includes("overloaded"),
		),
		JSON.stringify(allMessages(agent).map((message) => [message.role, textOf(message)])),
	);
	check(
		"and nothing is retrying once it answered",
		agent.snapshot(sidOf(agent)).isRetrying === false && agent.snapshot(sidOf(agent)).retryAttempt === 0 && agent.snapshot(sidOf(agent)).isRetrying === false,
		`retrying=${agent.snapshot(sidOf(agent)).isRetrying} attempt=${agent.snapshot(sidOf(agent)).retryAttempt}`,
	);

	await within("the second run", 10_000, agent.prompt(sidOf(agent), "second question"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

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

	await agent.close(sidOf(agent));
}

/**
 * A failure the classifier calls deterministic is not retried, and the run ends as it always did.
 *
 * A quota or billing error is the case that matters: retrying it costs the user more failures and the
 * same message, and only delays the error they have to act on.
 */
async function exerciseNonRetryableError(): Promise<void> {
	process.stdout.write("non-retryable error\n");
	const base = fake.fakeState.callCount;
	fake.setResponses([failedAttempt("insufficient_quota: billing hard limit reached")]);
	const agent = await openSession();

	const trace: string[] = [];
	onSessionEvent(agent, (event) => {
		if (event.type.startsWith("retry_")) trace.push(event.type);
	});

	await within("the run", 10_000, agent.prompt(sidOf(agent), "quota question"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	check("the provider was asked once", fake.fakeState.callCount - base === 1, String(fake.fakeState.callCount - base));
	check("nothing was retried", trace.length === 0, JSON.stringify(trace));
	check(
		"the error is what the run ends on",
		agent.snapshot(sidOf(agent)).messages.some(
			(message) =>
				message.role === "assistant" &&
				`${(message as { errorMessage?: string }).errorMessage ?? ""}`.includes("insufficient_quota"),
		),
		JSON.stringify(agent.snapshot(sidOf(agent)).messages.map((message) => [message.role, textOf(message)])),
	);
	check(
		"and nothing claims to be retrying",
		agent.snapshot(sidOf(agent)).isRetrying === false && agent.snapshot(sidOf(agent)).retryAttempt === 0,
		`retrying=${agent.snapshot(sidOf(agent)).isRetrying} attempt=${agent.snapshot(sidOf(agent)).retryAttempt}`,
	);

	await agent.close(sidOf(agent));
}

/** The budget runs out: the last error is the session record's, and the session stops retrying. */
async function exerciseRetryExhaustion(): Promise<void> {
	process.stdout.write("retry exhausted\n");
	const base = fake.fakeState.callCount;
	fake.setResponses([
		failedAttempt("503 first"),
		failedAttempt("503 second"),
		failedAttempt("503 third"),
		fakeAssistantMessage("never reached"),
	]);
	const agent = await openSession({ retry: retryPolicy({ maxRetries: 2 }) });

	const trace: RetryTrace[] = [];
	onSessionEvent(agent, (event) => {
		if (event.type === "retry_scheduled") {
			trace.push({ type: event.type, attempt: event.attempt, maxAttempts: event.maxAttempts });
		}
		if (event.type === "retry_end") {
			trace.push({ type: event.type, attempt: event.attempt, success: event.success, finalError: event.finalError });
		}
	});

	await within("the run", 10_000, agent.prompt(sidOf(agent), "doomed question"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	check("the budget is the first call plus maxRetries", fake.fakeState.callCount - base === 3, String(fake.fakeState.callCount - base));
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
		"the last error is the one the session shows",
		agent.snapshot(sidOf(agent)).messages.some(
			(message) => message.role === "assistant" && (message as { errorMessage?: string }).errorMessage === "503 third",
		),
		JSON.stringify(agent.snapshot(sidOf(agent)).messages.map((message) => [message.role, textOf(message)])),
	);
	check(
		"and the session stopped retrying",
		agent.snapshot(sidOf(agent)).isRetrying === false &&
			agent.snapshot(sidOf(agent)).retryAttempt === 0 &&
			agent.snapshot(sidOf(agent)).isRetrying === false &&
			agent.snapshot(sidOf(agent)).retryAttempt === 0,
		`retrying=${agent.snapshot(sidOf(agent)).isRetrying} attempt=${agent.snapshot(sidOf(agent)).retryAttempt}`,
	);

	await agent.close(sidOf(agent));
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
	const base = fake.fakeState.callCount;
	fake.setResponses([failedAttempt("503 while aborted"), fakeAssistantMessage("never reached")]);
	// A backoff long enough to be cancelled inside it, and short enough to fail fast if it is not.
	const agent = await openSession({ retry: retryPolicy({ baseDelayMs: 1_000 }) });

	const scheduled = new Promise<void>((resolve) => {
		onSessionEvent(agent, (event) => {
			if (event.type === "retry_scheduled") resolve();
		});
	});

	const running = agent.prompt(sidOf(agent), "abort question");
	await within("the backoff", 5_000, scheduled);
	check(
		"the retry is pending, not the provider",
		agent.snapshot(sidOf(agent)).isRetrying === true && agent.snapshot(sidOf(agent)).retryAttempt === 1,
		String(agent.snapshot(sidOf(agent)).retryAttempt),
	);

	const aborted = await within("abort()", 5_000, agent.abort(sidOf(agent)));
	check("abort() returns", aborted.ok);
	const settled = await within("settle()", 2_000, agent.settle(sidOf(agent)));
	check("settle() resolves instead of waiting out the backoff", settled.ok);
	check("the retry is over", agent.snapshot(sidOf(agent)).isRetrying === false && agent.snapshot(sidOf(agent)).retryAttempt === 0, `retrying=${agent.snapshot(sidOf(agent)).isRetrying}`);
	check("the provider was asked once", fake.fakeState.callCount - base === 1, String(fake.fakeState.callCount - base));
	check(
		"the partial turn is on disk",
		entryIdsFor(agent, "abort question").length === 1,
		JSON.stringify(entriesOf(agent).map((entry) => entry.type)),
	);

	await within("the run", 5_000, running);
	await agent.close(sidOf(agent));
}

/** `retry.enabled: false` is the behaviour before retries existed, failure for failure. */
async function exerciseRetryDisabled(): Promise<void> {
	process.stdout.write("retry disabled\n");
	const base = fake.fakeState.callCount;
	fake.setResponses([failedAttempt("503 no retries for me"), fakeAssistantMessage("plain answer")]);
	const agent = await openSession({ retry: retryPolicy({ enabled: false }) });

	const trace: string[] = [];
	onSessionEvent(agent, (event) => {
		if (event.type.startsWith("retry_")) trace.push(event.type);
	});

	await within("the failed run", 10_000, agent.prompt(sidOf(agent), "no retry question"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	check("one call, as before", fake.fakeState.callCount - base === 1, String(fake.fakeState.callCount - base));
	check("no retry was announced", trace.length === 0, JSON.stringify(trace));
	check(
		"the error ends the run, as before",
		agent.snapshot(sidOf(agent)).messages.some(
			(message) =>
				message.role === "assistant" &&
				(message as { errorMessage?: string }).errorMessage === "503 no retries for me",
		),
		JSON.stringify(agent.snapshot(sidOf(agent)).messages.map((message) => [message.role, textOf(message)])),
	);

	fake.setResponses([fakeAssistantMessage("plain answer")]);
	await within("the healthy run", 10_000, agent.prompt(sidOf(agent), "and now normally"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	check(
		"a healthy call still streams through untouched",
		agent.snapshot(sidOf(agent)).messages.some((message) => message.role === "assistant" && textOf(message) === "plain answer"),
		JSON.stringify(agent.snapshot(sidOf(agent)).messages.map((message) => [message.role, textOf(message)])),
	);
	check(
		"and the snapshot never claims to be retrying",
		agent.snapshot(sidOf(agent)).isRetrying === false && agent.snapshot(sidOf(agent)).retryAttempt === 0,
		`retrying=${agent.snapshot(sidOf(agent)).isRetrying}`,
	);

	await agent.close(sidOf(agent));
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
	const base = fake.fakeState.callCount;
	fake.setResponses([
		failedAttempt("503 prompt is too long: 250000 tokens > 200000 maximum"),
		fakeAssistantMessage("never reached"),
	]);
	const agent = await openSession();

	const trace: string[] = [];
	onSessionEvent(agent, (event) => {
		if (event.type.startsWith("retry_")) trace.push(event.type);
	});

	await within("the run", 10_000, agent.prompt(sidOf(agent), "overflow question"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	check("an overflow is asked once", fake.fakeState.callCount - base === 1, String(fake.fakeState.callCount - base));
	check("no retry was scheduled for it", trace.length === 0, JSON.stringify(trace));
	check(
		"and the overflow is what the run ends on",
		agent.snapshot(sidOf(agent)).messages.some(
			(message) =>
				message.role === "assistant" &&
				`${(message as { errorMessage?: string }).errorMessage ?? ""}`.includes("prompt is too long"),
		),
		JSON.stringify(agent.snapshot(sidOf(agent)).messages.map((message) => [message.role, textOf(message)])),
	);
	check(
		"with nothing left retrying",
		agent.snapshot(sidOf(agent)).isRetrying === false && agent.snapshot(sidOf(agent)).retryAttempt === 0,
		`retrying=${agent.snapshot(sidOf(agent)).isRetrying}`,
	);

	await agent.close(sidOf(agent));
}

/**
 * A summarization that fails leaves the session exactly as it was and says so.
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
	const agent = await openSession({}, { models: windowedRows(33_035) });

	const announced: string[] = [];
	onSessionEvent(agent, (event) => {
		if (event.type === "compaction" || event.type === "compaction_failed") announced.push(event.type);
	});

	const questions = [
		"question one with enough words to estimate tokens",
		"question two with enough words to estimate tokens",
		"question three with enough words to estimate tokens",
	];
	for (const text of questions) {
		const run = await within("a run", 10_000, agent.prompt(sidOf(agent), text));
		check(`"${text.slice(0, 12)}..." completes`, run.ok);
	}
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

	check("the failure is announced and no compaction is", JSON.stringify(announced) === JSON.stringify(["compaction_failed"]), JSON.stringify(announced));
	check(
		"nothing was written as a checkpoint",
		entriesOf(agent).every((entry) => entry.type !== "compaction"),
		JSON.stringify(entriesOf(agent).map((entry) => entry.type)),
	);
	check(
		"so the next request still carries what it would have replaced",
		(sent[3]?.texts ?? []).some((text) => text.includes("question one")) &&
			(sent[3]?.texts ?? []).some((text) => text.includes("answer one")),
		JSON.stringify(sent[3]?.texts),
	);
	check("and the run carried on to an answer", agent.snapshot(sidOf(agent)).messages.some((message) => message.role === "assistant" && textOf(message) === "answer three"));

	await agent.close(sidOf(agent));
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
	const chatTransport: ChatTransport = {
		stream: (model, context, options) => {
			sent.push({
				key: model.apiKey,
				baseUrl: model.baseUrl,
				id: model.id,
				alsoInOptions: options?.apiKey,
			});
			return fake.chatTransport.stream(model, context, options);
		},
	};

	const keyedRows: ModelConfig[] = [{ ...ROW, name: "keyed", apiKey: "first-key", baseUrl: "http://127.0.0.1:1/v1" }];
	fake.setResponses([fakeAssistantMessage("answered")]);
	const agent = await openSession({}, { models: keyedRows, chatTransport: chatTransport });
	await within("the run", 10_000, agent.prompt(sidOf(agent), "hello"));
	check("the model carries the row's key", sent[0]?.key === "first-key", String(sent[0]?.key));
	check(
		"and the transport is handed the same key",
		sent[0]?.alsoInOptions === "first-key",
		String(sent[0]?.alsoInOptions),
	);
	check("the model names the row it came from", agent.snapshot(sidOf(agent)).model === "keyed", agent.snapshot(sidOf(agent)).model);

	// No catalog is rebuilt and no session reopened: the row is read again before the next request, so
	// every field of it is as fresh as the file was — not just the key.
	const recordedOf = (): string => JSON.stringify(agent.sessionManager.getRecordedSettings(bagOf(agent)).model);
	const recordedBefore = recordedOf();
	keyedRows[0]!.apiKey = "corrected-key";
	keyedRows[0]!.baseUrl = "http://127.0.0.1:2/v1";
	// 行编辑落盘（设置归属重构 §5）：目录是 ModelManager 每次现读的文件，内存数组的改动不再被隔着
	// 持有者看见——把改好的行整表写回，下一请求才读得到。
	new ModelManager({ home: homeOf(agent) }).replaceRows(keyedRows);
	fake.setResponses([fakeAssistantMessage("answered again")]);
	await within("the second run", 10_000, agent.prompt(sidOf(agent), "again"));
	check("a corrected key is used by the next message", sent[1]?.key === "corrected-key", String(sent[1]?.key));
	check("and so is a moved endpoint", sent[1]?.baseUrl === "http://127.0.0.1:2/v1", String(sent[1]?.baseUrl));
	// Neither of those is part of what the session claims about the model, so neither may rewrite the
	// snapshot: a session that had its key corrected is not a session that changed model.
	check("and neither rewrites the recorded model", recordedOf() === recordedBefore, `${recordedOf()} vs ${recordedBefore}`);

	// A wire id that moves is a different model answering, and the session says so.
	keyedRows[0]!.id = "faux-2";
	new ModelManager({ home: homeOf(agent) }).replaceRows(keyedRows);
	fake.setResponses([fakeAssistantMessage("answered a third time")]);
	await within("the third run", 10_000, agent.prompt(sidOf(agent), "and again"));
	check("a renamed wire id reaches the request", sent[2]?.id === "faux-2", String(sent[2]?.id));
	check("and the session stays on the row it came from", agent.snapshot(sidOf(agent)).model === "keyed", agent.snapshot(sidOf(agent)).model);
	check("and records the id it now answers to", recordedOf() === JSON.stringify({ name: "keyed", modelId: "faux-2" }), recordedOf());
	fake.setResponses([fakeAssistantMessage("answered a fourth time")]);
	await within("the fourth run", 10_000, agent.prompt(sidOf(agent), "once more"));
	check("while a request on the same id records nothing new", recordedOf() === JSON.stringify({ name: "keyed", modelId: "faux-2" }), recordedOf());

	await agent.close(sidOf(agent));
}

/**
 * The composer's model and level travel with the message, and are recorded when the gesture lands.
 *
 * Both halves are one selection, and neither is a config change of its own: the session's account of
 * what answered a turn is built from what a request actually carried, and the session's own record
 * holds the choice from the moment it is made (ADR-0021: every session this smoke opens is born, so
 * the write has a snapshot to land on).
 */
async function exerciseModelSelection(): Promise<void> {
	process.stdout.write("the composer's choice travels with the message\n");

	// A row no longer carries a default level or a claim about whether it reasons: the strength is the
	// composer's, so a session nobody has spoken to opens at "off" — the request that asks for nothing.
	const thinkerRows: ModelConfig[] = [{ ...ROW, name: "thinker", id: "claude-sonnet-4-5" }];
	const scripted = createFakeTransport();
	scripted.setResponses([fakeAssistantMessage("first")]);
	const agent = await openSession({}, { models: thinkerRows, chatTransport: scripted.chatTransport });

	check("a session opens at off, because nothing has been asked for", agent.snapshot(sidOf(agent)).thinkingLevel === "off", agent.snapshot(sidOf(agent)).thinkingLevel);

	const levelsOf = (): string | undefined => agent.sessionManager.getRecordedSettings(bagOf(agent)).thinkingLevel;
	agent.applyModelSelection(sidOf(agent), { thinkingLevel: "high" });
	check("choosing a level moves the session", agent.snapshot(sidOf(agent)).thinkingLevel === "high", agent.snapshot(sidOf(agent)).thinkingLevel);

	await within("the run", 10_000, agent.prompt(sidOf(agent), "hello", { selection: { thinkingLevel: "high" } }));
	check("the request is asked at that level", scripted.fakeState.thinkingLevels.at(-1) === "high", String(scripted.fakeState.thinkingLevels.at(-1)));
	check("and the session records it once", levelsOf() === "high", String(levelsOf()));

	scripted.setResponses([fakeAssistantMessage("second")]);
	await within("the second run", 10_000, agent.prompt(sidOf(agent), "again"));
	check("a later turn on the same level records nothing new", levelsOf() === "high", String(levelsOf()));
	check("while still being asked at it", scripted.fakeState.thinkingLevels.at(-1) === "high", String(scripted.fakeState.thinkingLevels.at(-1)));

	// Every row takes the same four, so there is nothing left for the session to refuse: `max` is a
	// level like the rest, and the only string that is not one is a name the app has never had.
	agent.applyModelSelection(sidOf(agent), { thinkingLevel: "max" });
	check("a level the row used to lack is accepted now", agent.snapshot(sidOf(agent)).thinkingLevel === "max", agent.snapshot(sidOf(agent)).thinkingLevel);

	agent.applyModelSelection(sidOf(agent), { thinkingLevel: "turbo" });
	check("a level nobody has lands on off", agent.snapshot(sidOf(agent)).thinkingLevel === "off", agent.snapshot(sidOf(agent)).thinkingLevel);

	await agent.close(sidOf(agent));
}

try {
	await exerciseModelFromRow();
	await exerciseModelSelection();
	await exerciseFollowUp();
	await exerciseSteerVersusFollowUp();
	await exerciseAcceptedOrder();
	await exerciseAbortDropsUnconsumed();
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
	await exerciseToolManager();
	await exerciseActiveTools();
	await exerciseDeactivatedToolCall();
	await exerciseDeactivatedToolBatch();
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
	const agent = await openSession();

	const reports: { toolName: string; diff?: FileDiff }[] = [];
	onSessionEvent(agent, (event) => {
		if (event.type !== "tool_execution_end") return;
		reports.push({ toolName: event.toolName, diff: (event.result?.details as { diff?: FileDiff } | undefined)?.diff });
	});

	await within("the run", 10_000, agent.prompt(sidOf(agent), "write report.txt and then edit it"));
	await within("settle()", 10_000, agent.settle(sidOf(agent)));

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
		"while the session keeps the tool's text beside the report",
		toolResultTexts(agent).some((text) => text.includes("Created report.txt")) &&
			JSON.stringify(allMessages(agent)).includes('"created":true'),
		JSON.stringify(toolResultTexts(agent)),
	);

	await agent.close(sidOf(agent));
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
	const agent = await openSession();
	const sent: SentRequest[] = [];
	recordRequests(sent, [
		fakeAssistantMessage("answer one"),
		fakeAssistantMessage("second answer"),
		fakeAssistantMessage("third answer"),
		fakeAssistantMessage("fourth answer"),
	]);

	await within("the first turn", 15_000, agent.prompt(sidOf(agent), "question one"));
	const firstId = entryIdsFor(agent, "question one")[0] ?? "";
	await within("the second turn", 15_000, agent.prompt(sidOf(agent), "question two"));
	check(
		"a message the conversation carried on from one way is not a branch point",
		agent.snapshot(sidOf(agent)).branchPoints.length === 0,
		JSON.stringify(agent.snapshot(sidOf(agent)).branchPoints),
	);

	const events: AgentSessionEvent[] = [];
	onSessionEvent(agent, (event) => events.push(event));

	// --- Rewinding to a message and asking again is what makes a second alternative ---------------
	const landed = agent.branchTo(sidOf(agent), firstId, false);
	check("rewinding lands on the entry itself", landed === firstId, `${landed} vs ${firstId}`);
	check("and the session is the chain through it", textsOf(agent).join(",") === "question one", textsOf(agent).join(","));
	check("while the abandoned turn stays in the store", allMessages(agent).some((message) => textOf(message) === "question two"));
	check(
		"the move is announced with the leaf it landed on",
		events.some((event) => event.type === "branch_changed" && event.leafId === firstId),
		JSON.stringify(events.map((event) => event.type)),
	);

	await within("the third turn", 15_000, agent.prompt(sidOf(agent), "question three"));
	const asked = (sent[2]?.texts ?? []).join("|");
	check("the next request carries the rewound branch", asked.includes("question three") && asked.includes("question one"), JSON.stringify(sent[2]?.texts));
	check("and none of the tail that was left behind", asked.includes("question two") === false && asked.includes("second answer") === false, JSON.stringify(sent[2]?.texts));
	check(
		"the append behind a message that was carried on from is announced as a change to the tree",
		events.filter((event) => event.type === "branch_changed").length === 2,
		JSON.stringify(events.filter((event) => event.type === "branch_changed")),
	);

	const points = agent.snapshot(sidOf(agent)).branchPoints;
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
	agent.branchTo(sidOf(agent), alternative, true);
	check(
		"choosing an alternative restores its own tip",
		textsOf(agent).join(",") === "question one,question two",
		textsOf(agent).join(","),
	);
	await within("the fourth turn", 15_000, agent.prompt(sidOf(agent), "question four"));
	const resumed = (sent[3]?.texts ?? []).join("|");
	check("and the request continues on that branch", resumed.includes("question four") && resumed.includes("second answer"), JSON.stringify(sent[3]?.texts));
	check("without the alternative that was left", resumed.includes("question three") === false && resumed.includes("third answer") === false, JSON.stringify(sent[3]?.texts));
	check(
		"both alternatives are still one branch point",
		agent.snapshot(sidOf(agent)).branchPoints.length === 1 && agent.snapshot(sidOf(agent)).branchPoints[0]?.options.length === 2,
		JSON.stringify(agent.snapshot(sidOf(agent)).branchPoints),
	);
	check(
		"nothing was deleted on the way",
		["question three", "third answer", "question four", "fourth answer"].every((text) =>
			allMessages(agent).some((message) => textOf(message) === text),
		),
		JSON.stringify(allMessages(agent).map(textOf)),
	);

	await agent.close(sidOf(agent));

	// --- A move while a run is in flight would file the turn under the wrong branch ---------------
	const { chatTransport: chatTransport, gate } = gatedTransport(1);
	const busy = await openSession({}, { chatTransport: chatTransport });
	recordRequests([], [fakeAssistantMessage("slow answer")]);
	const running = busy.prompt(sidOf(busy), "hold the turn");
	await whenStreaming(busy, gate);
	const heldId = entryIdsFor(busy, "hold the turn")[0] ?? "";
	const refused = ((): unknown => {
		try {
			busy.branchTo(sidOf(busy), heldId, true);
			return undefined;
		} catch (error) {
			return error;
		}
	})();
	check("moving the branch mid-run is refused", refused instanceof Error, String(refused));
	check("and says the run is what refuses it", refused instanceof Error && refused.message.includes("in flight"), String(refused));
	gate.release();
	await within("the held turn", 15_000, running);
	await within("settle()", 10_000, busy.settle(sidOf(busy)));
	check("the refused move left the leaf where the turn put it", busy.snapshot(sidOf(busy)).branchPoints.length === 0, JSON.stringify(busy.snapshot(sidOf(busy)).branchPoints));
	await busy.close(sidOf(busy));
}

/**
 * The tool choices belong to the session, not to a branch.
 *
 * The two-file split made the recorded choices session-level current values — the `.json` snapshot's
 * — so moving the leaf no longer switches them: the session keeps exactly what it last chose,
 * whichever way its leaf points. This drives a move across a choice and reads the live maps, the
 * snapshot, and the events every other window sees; then reopens the files to check the snapshot
 * carried the choice out.
 */
async function exerciseBranchToolConfig(): Promise<void> {
	process.stdout.write("tool config is the session's, not a branch's\n");
	const agent = await openSession({ modes: [{ name: "narrow", tools: ["read", "edit", "glob", "grep"], approval: NO_GATES }] });
	const sent: SentRequest[] = [];
	recordRequests(sent, [
		fakeAssistantMessage("first answer"),
		fakeAssistantMessage("second answer"),
		fakeAssistantMessage("third answer"),
	]);

	await within("the first turn", 15_000, agent.prompt(sidOf(agent), "config branch question one"));
	const firstId = entryIdsFor(agent, "config branch question one")[0] ?? "";
	await within("the second turn", 15_000, agent.prompt(sidOf(agent), "config branch question two"));

	const events: AgentSessionEvent[] = [];
	onSessionEvent(agent, (event) => events.push(event));

	// --- The session narrows and gates `bash` ---------------------------------------------------
	agent.applyConfig(sidOf(agent), { mode: "narrow" });
	agent.applyConfig(sidOf(agent), { approval: { bash: true } });
	check("the narrow mode is in force", agent.snapshot(sidOf(agent)).mode === "narrow", agent.snapshot(sidOf(agent)).mode);
	check("with the approval the session chose", agent.getApprovals(sidOf(agent)).bash === true, JSON.stringify(agent.getApprovals(sidOf(agent))));
	check("which is the map the gate reads", agent.getApprovals(sidOf(agent)).bash === true, JSON.stringify(agent.getApprovals(sidOf(agent))));
	check(
		"leaving the settings file alone",
		createToolManager({ home: homeOf(agent) }).toolDefaults().approval.bash === false,
		JSON.stringify(createToolManager({ home: homeOf(agent) }).toolDefaults().approval),
	);

	// --- Moving the leaf changes the branch, not the choices ------------------------------------
	const before = events.length;
	agent.branchTo(sidOf(agent), firstId, false);
	check("the move lands before both turns", textsOf(agent).join(",") === "config branch question one", textsOf(agent).join(","));
	check("and the choices stay what the session chose", agent.snapshot(sidOf(agent)).mode === "narrow" && agent.getApprovals(sidOf(agent)).bash === true, agent.snapshot(sidOf(agent)).mode ?? "");
	check("the gate reads the same map on the new branch", agent.getApprovals(sidOf(agent)).bash === true, JSON.stringify(agent.getApprovals(sidOf(agent))));
	check(
		"and no config_changed rides the move",
		events.slice(before).every((event) => event.type !== "config_changed"),
		JSON.stringify(events.slice(before).map((event) => event.type)),
	);

	// The request on the rewound branch is narrowed with the same session-level choice.
	await within("the third turn", 15_000, agent.prompt(sidOf(agent), "config branch question three"));
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

	await agent.close(sidOf(agent));

	// --- The choice is on the snapshot, so the reopen answers with it ----------------------------
	const reopened = fillSession(bagOf(agent).sessionFileAbsPath ?? "");
	check("the reopen restores the session's mode pointer", sessionManager.getRecordedToolConfig(reopened).mode === "narrow", sessionManager.getRecordedToolConfig(reopened).mode);
	check("and its approval delta with it", sessionManager.getRecordedToolConfig(reopened).approval?.bash === true, JSON.stringify(sessionManager.getRecordedToolConfig(reopened).approval));
}

/**
 * A branch move outlives the session that made it.
 *
 * A move that actually changes the position writes one `leaf` entry, and `buildIndex` replays it on
 * load, so close → reopen restores where the conversation went rather than the file's last entry.
 * Also checked on the way: a move to the position already held writes nothing, the record reaches no
 * message, and `resetLeaf`'s "before the first entry" survives a reopen too. A session with no such
 * record — one no move was ever taken in — reads exactly as it always did.
 */
async function exerciseLeafDurability(): Promise<void> {
	process.stdout.write("leaf durability\n");
	const agent = await openSession();
	const sent: SentRequest[] = [];
	recordRequests(sent, [fakeAssistantMessage("answer one"), fakeAssistantMessage("answer two")]);

	await within("the first turn", 15_000, agent.prompt(sidOf(agent), "durable question one"));
	await within("the second turn", 15_000, agent.prompt(sidOf(agent), "durable question two"));
	const firstId = entryIdsFor(agent, "durable question one")[0] ?? "";

	// --- A real move writes one record; a no-op move writes none ---------------------------------
	const entriesBefore = entriesOf(agent).length;
	agent.branchTo(sidOf(agent), firstId, false);
	check("a real move writes exactly one entry", entriesOf(agent).length === entriesBefore + 1, String(entriesOf(agent).length - entriesBefore));
	check("and that entry is a leaf record", entriesOf(agent).at(-1)?.type === "leaf", String(entriesOf(agent).at(-1)?.type));
	agent.branchTo(sidOf(agent), firstId, false);
	check("moving to the position already held writes nothing", entriesOf(agent).length === entriesBefore + 1, String(entriesOf(agent).length - entriesBefore));

	const file = bagOf(agent).sessionFileAbsPath ?? "";
	await agent.close(sidOf(agent));

	// --- The move is where the file says it is, not where the file ends --------------------------
	const reopened = fillSession(file);
	check("the move survived close", reopened.leafId === firstId, `${reopened.leafId} vs ${firstId}`);
	check(
		"and the reopened context is the branch through it, the record reaching no message",
		JSON.stringify(sessionManager.buildSessionContext(reopened).messages.map(textOf).filter((text) => text !== BIRTH_TEXT)) ===
			JSON.stringify(["durable question one"]),
		JSON.stringify(sessionManager.buildSessionContext(reopened).messages.map(textOf)),
	);

	// The next append is a child of the recorded position, which is what turns it into a branch point.
	sessionManager.appendMessage(reopened, { role: "user", content: [{ type: "text", text: "carried on" }] } as Message);
	const points = sessionManager.getBranchPoints(reopened);
	check(
		"the next append continued from the moved leaf",
		points.length === 1 && points[0]?.entryId === firstId && points[0]?.options.length === 2,
		JSON.stringify(points),
	);

	// --- "Before the first entry" is a position like any other ----------------------------------
	sessionManager.resetLeaf(reopened);
	check("resetLeaf moved the leaf before the first entry", reopened.leafId === null, String(reopened.leafId));
	const rereopened = fillSession(file);
	check("and that position survived the reopen too", rereopened.leafId === null, String(rereopened.leafId));

	// --- A session with no leaf record reads as it always did: the last entry is the position -------
	// Handwritten as a bare pair, because no branch was ever taken in it — the leaf record is what a
	// move writes, and a session that never moved has none.
	const fixtureStem = join(root, "fixture-no-leaf");
	const fixtureStamp = new Date().toISOString();
	const fixtureMeta = { version: CURRENT_SESSION_VERSION, id: "fixture-no-leaf", timestamp: fixtureStamp, workDir: root };
	const fixtureLines = [
		{ type: "message", id: "fx-u1", parentId: null, timestamp: fixtureStamp, message: { role: "user", content: [{ type: "text", text: "fixture one" }] } },
		{ type: "message", id: "fx-a1", parentId: "fx-u1", timestamp: fixtureStamp, message: { role: "assistant", content: [{ type: "text", text: "fixture answer" }] } },
		{ type: "message", id: "fx-u2", parentId: "fx-u1", timestamp: fixtureStamp, message: { role: "user", content: [{ type: "text", text: "fixture two" }] } },
	];
	await writeFile(`${fixtureStem}.json`, `${JSON.stringify(fixtureMeta, null, "\t")}\n`);
	await writeFile(`${fixtureStem}.jsonl`, fixtureLines.map((line) => `${JSON.stringify(line)}\n`).join(""));
	const legacy = fillSession(`${fixtureStem}.jsonl`);
	check("a file without a leaf record reads its last entry", legacy.leafId === "fx-u2", String(legacy.leafId));
	check(
		"and its tree is read whole, the second child a branch option",
		sessionManager.getBranchPoints(legacy).length === 1 && sessionManager.getBranchPoints(legacy)[0]?.options.length === 2,
		JSON.stringify(sessionManager.getBranchPoints(legacy)),
	);
}

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
	// Both the working directory and the agent home's directory for it, or every run leaves one behind.
	await rm(root, { recursive: true, force: true });
	await rm(storeRoot, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nsession ok\n" : `\n${failures} session checks failed\n`);
process.exit(failures === 0 ? 0 : 1);
