// session 面上的恢复机器（ADR-0006 §5，ticket 15）：审批门让 run 以调用悬在 ledger 里的状态
// 结束，那个调用之后会遇到什么，正是本文件钉住的契约——
//
//   1. grant 即恢复：应答启动一次 run，其恢复趟把调用重新穿过门与工具本身，run 在同一个回合
//      循环里继续；
//   2. denial 即关闭：悬着的调用得到应答理由指名的结果，模型对它作答；
//   3. 孤儿关闭：没有应答指名的悬调用——崩溃留下的形状——在下一次 run 的入口（prompt 或
//      resume）以合成的错误结果关闭，所以第一个请求是 provider 合法的；关闭这条清扫的开关把
//      它们留给 host；
//   4. 恢复期间的 abort：run 像任何 run 一样停下，被恢复的调用保留自己的结果，没有任何 denial
//      骑在 abort 上——abort 的拒绝不走审批链；
//   5. 信箱也是恢复 run 的：被 steer 进恢复 run 的消息在取用点被排干并应答，与从 prompt 开始的
//      run 完全一致。
//
//   node scripts/smoke-approval-recovery.ts
//
// 无需 provider key：剧本化 transport 发出工具调用，持门包装器把"恢复 run 流式中"变成可观察的。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type ChatTransport, type Message } from "@my-agent/core";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall } from "./fake-transport.ts";
import {
	createToolManager,
	danglingToolCallsOf,
	openAgent,
	recoverPendingToolCalls,
	createSession,
	inMemorySettingManager,
	type Agent,
	type AgentEvent,
	type Tool,
	type Session,
	type ModelConfig,
	type ModelSelection,
	setSessionsDir,
} from "@my-agent/core";

const root = await mkdtemp(join(tmpdir(), "my-agent-approval-recovery-"));
const storeRoot = await mkdtemp(join(tmpdir(), "my-agent-approval-recovery--store-"));
setSessionsDir(storeRoot);
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
	process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` ${detail}`}\n`);
	if (!ok) failures += 1;
}

const watchdog = setTimeout(() => {
	process.stdout.write("\nFAIL the recovery checks did not settle within 60 s\n");
	process.exit(1);
}, 60_000);

const rows: ModelConfig[] = [
	{
		name: "anthropic",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "unused-by-the-scripted-transport",
		id: "claude-sonnet-4-5",
		contextWindow: 200_000,
		maxTokens: 8_192,
	},
];
const modelName = "anthropic";
const selection: ModelSelection = { model: modelName };

const fake = createFakeTransport();

function textOf(message: Message): string {
	if (!Array.isArray(message.content)) return "";
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** session transcript 里的每一个工具结果，从旧到新。 */
function toolResultTexts(session: Agent): string[] {
	return session.snapshot(sidOf(session)).messages.filter((message) => message.role === "toolResult").map((message) => textOf(message));
}

/** 一次请求的 prompt 侧视图：被发给 provider 的角色，按序。 */
function requestRoles(context: { messages: readonly Message[] }): string[] {
	return context.messages.map((message) => message.role);
}

/**
 * 调用会停在请求内部、直到被放行的 transport，每次调用一个 hold。
 *
 * 剧本化 transport 在循环一问就答，run 不留任何可被 steer 或 abort 的窗口。持住第 N 次调用才
 * 让"run 中"可观察；`holds` 说出哪些次序的调用（从 1 起，跨 transport 生命周期）要停下。abort
 * 会结束 hold：signal 正是真 transport 尊重的东西，让剧本回答随它放行正是让 run 以被中止消息
 * 落定、如同经由真网络一样的办法。
 */
function gatedApi(holds: number[]): { api: ChatTransport; release(index: number): void; held(index: number): boolean } {
	const inner = fake.api.stream.bind(fake.api);
	let calls = 0;
	const pending = new Map<number, () => void>();
	const released = new Set<number>();
	const api: ChatTransport = {
		stream: (model, context, options) => {
			calls += 1;
			const nth = calls;
			if (holds.includes(nth) && !released.has(nth)) {
				const outer = createAssistantMessageEventStream();
				void (async () => {
					await new Promise<void>((resolve) => {
						pending.set(nth, resolve);
						options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					pending.delete(nth);
					const answer = inner(model, context, options);
					for await (const event of answer) outer.push(event);
					outer.end(await answer.result());
				})();
				return outer;
			}
			return inner(model, context, options);
		},
	};
	return {
		api,
		release: (index) => {
			released.add(index);
			pending.get(index)?.();
			pending.delete(index);
		},
		held: (index) => pending.has(index) && !released.has(index),
	};
}

/**
 * 每个打开的 session 运行时所用的 id，保存在各检查持有的 session 对象旁边。
 *
 * session 的方法现在按 id 指名它——orchestrator 不持有任何 session 状态——所以打开助手在这里
 * 记录它创建的东西，每个检查经由 {@link sidOf} 读回。
 */
const opened = new WeakMap<Agent, { id: string; state: Session }>();

function bagOf(session: Agent): Session {
	return opened.get(session)!.state;
}

function sidOf(session: Agent): string {
	return opened.get(session)!.id;
}

async function openSession(overrides: { approval?: Record<string, boolean>; api?: ChatTransport } = {}): Promise<Agent> {
	const state = createSession(root);
	const session = await openAgent({
		session: state,
		api: overrides.api ?? fake.api,
		model: modelName,
		settings: inMemorySettingManager({ approval: overrides.approval ?? {} }, rows),
	});
	opened.set(session, { id: state.sessionId, state });
	return session;
}

// ---------------------------------------------------------------------------------------------------
// 1 + 2. 两种应答，各自启动收掉它所指名调用的那次 run。
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\na grant resumes the run and re-runs the call; a denial closes it with its reason\n");

{
	const session = await openSession({ approval: { read: true } });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("after the grant")]);
	await session.prompt(sidOf(session), "read the notes", { selection });
	await session.settle(sidOf(session));
	check("the gate ended the run with the call dangling", session.hasPendingApprovals(sidOf(session)), JSON.stringify(session.snapshot(sidOf(session)).pendingApprovals));
	const callId = session.snapshot(sidOf(session)).pendingApprovals[0]?.toolCallId ?? "";
	check("the dangling call has no result yet", toolResultTexts(session).length === 0, JSON.stringify(toolResultTexts(session)));

	await session.respondApproval(sidOf(session), callId, true);
	await session.settle(sidOf(session));
	const grantResults = toolResultTexts(session);
	check("the recovery pass re-ran the call through the tool", grantResults.some((text) => text.includes("notes.txt")), JSON.stringify(grantResults));
	check("the granted call is no longer waiting", !session.hasPendingApproval(sidOf(session), callId));
	check("a grant records the session's own approval choice", session.getApprovals(sidOf(session)).read === false);
	check(
		"and the model carried on in the same run",
		session.snapshot(sidOf(session)).messages.some((message) => message.role === "assistant" && textOf(message) === "after the grant"),
	);
	await session.close(sidOf(session));
}

{
	const session = await openSession({ approval: { read: true } });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("after the denial")]);
	await session.prompt(sidOf(session), "read the notes", { selection });
	await session.settle(sidOf(session));
	const callId = session.snapshot(sidOf(session)).pendingApprovals[0]?.toolCallId ?? "";

	await session.respondApproval(sidOf(session), callId, false);
	await session.settle(sidOf(session));
	const denialResults = toolResultTexts(session);
	check("the recovery pass closed the call with the deny's sentence", denialResults.some((text) => text.includes("The user denied permission to run read.")), JSON.stringify(denialResults));
	check("the denied call is no longer waiting", !session.hasPendingApproval(sidOf(session), callId));
	check(
		"and the model answered the denial",
		session.snapshot(sidOf(session)).messages.some((message) => message.role === "assistant" && textOf(message) === "after the denial"),
	);
	await session.close(sidOf(session));
}

// ---------------------------------------------------------------------------------------------------
// 3. 孤儿：崩溃留下的东西在下一次 run 的入口（prompt 或 resume）被关闭。
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\ndangling calls no answer names are closed before the first request\n");

{
	const session = await openSession();
	// 崩溃形状：transcript 里两条调用，身后都没有结果——按一个死于批次中途的进程留下它们的
	// 方式追加。
	session.sessionManager.appendMessage(bagOf(session), fakeAssistantMessage(fakeToolCall("read", { path: "a.txt" }, { id: "call_a" })));
	session.sessionManager.appendMessage(bagOf(session), fakeAssistantMessage(fakeToolCall("read", { path: "b.txt" }, { id: "call_b" })));
	check("both dangling calls are derived from the ledger", session.snapshot(sidOf(session)).pendingApprovals.length === 2, JSON.stringify(session.snapshot(sidOf(session)).pendingApprovals));

	const prompts: { roles: string[] }[] = [];
	fake.setResponses([
		(context) => {
			prompts.push({ roles: requestRoles(context) });
			return fakeAssistantMessage("carried on");
		},
	]);
	await session.prompt(sidOf(session), "continue", { selection });
	await session.settle(sidOf(session));

	const orphanResults = toolResultTexts(session);
	check(
		"both orphans were closed with the sentence that says what happened",
		orphanResults.filter((text) => text.includes("was left unanswered")).length === 2,
		JSON.stringify(orphanResults),
	);
	check("the sweep cleared the waiting", !session.hasPendingApprovals(sidOf(session)));
	check(
		"and the first request was provider-legal: each result beside its own call, the prompt after them",
		JSON.stringify(prompts[0]?.roles) === JSON.stringify(["system", "assistant", "toolResult", "assistant", "toolResult", "user"]),
		JSON.stringify(prompts[0]?.roles),
	);
	await session.close(sidOf(session));
}

// 开关：把清扫关掉的 host 自己拥有那些未获应答的调用。在恢复机器自己的面上驱动——每个 run
// 第一次请求之前都会调用的那个函数——因为这个 host 从不关它：这个选项是引擎的契约，不是设置。
process.stdout.write("\nthe recovery toggle leaves the orphans to the host\n");

{
	const dangling = fakeAssistantMessage(fakeToolCall("read_fixture", { path: "a.txt" }, { id: "call_x" }));
	// 一个恢复趟能解析的工具，所以拦住它的是一次重新挂起的门——而不是一个缺失的工具，那种
	// 机器在任何 hook 运行之前就应答了。恢复机器对着一张表解析，不对着 context，所以工具按每个
	// 工具的方式到来：注册在本练习自建的表上——本文件没有 orchestrator 也没有 hub。它以 fixture
	// 而不是 `read` 命名，因为六个内置工具已经应答的名字会被表本身拒绝。
	/** fixture 自己的代码被进入了多少次——"被拒"读作"没有运行"。 */
	let ranFixture = 0;
	const readTool: Tool = {
		name: "read_fixture",
		label: "read_fixture",
		description: "reads a file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as never,
		execute: async () => {
			ranFixture += 1;
			return { content: [{ type: "text", text: "ran" }], details: {} };
		},
	};
	const manager = createToolManager();
	manager.register(readTool);
	// 一次 run 会激活的名字：这里只有那个 fixture，它也正是整张表——链条问的两个问题（"这次
	// run 可以调它吗"、"这个名字存在吗"）被有意分开应答，所以本练习供给自己的答案而不是推导
	// 一个。
	const activeNames = new Set(["read_fixture"]);

	/** 一次趟发出了什么，让"沉默"是一条断言而不是一个未观察的主张。 */
	const events: AgentEvent[] = [];
	const emitted = (event: AgentEvent): void => {
		events.push(event);
	};

	/** 调用抵达门的次数，让"在门之前被拒"可观察。 */
	let gatesAsked = 0;
	/** 应答"挂起"、并统计自己被问过几次的门。 */
	const suspendingGate = {
		beforeToolCall: async () => {
			gatesAsked += 1;
			return { suspend: true };
		},
	};

	const off = await recoverPendingToolCalls(
		{ messages: [dangling], tools: [] },
		danglingToolCallsOf([dangling]),
		{ enablePendingToolRecovery: false },
		{},
		manager,
		activeNames,
		{ workDirAbsPath: process.cwd() },
		undefined,
		emitted,
	);
	check(
		"toggle off: nothing was synthesized for the call",
		off.messages.length === 0,
		JSON.stringify(off.messages.map((message) => message.role)),
	);
	check(
		"toggle off: the call went to the provider unanswered, as the host asked",
		off.suspended !== true && events.length === 0,
		JSON.stringify(events.map((event) => event.type)),
	);

	const on = await recoverPendingToolCalls(
		{ messages: [dangling], tools: [] },
		danglingToolCallsOf([dangling]),
		undefined,
		{},
		manager,
		activeNames,
		{ workDirAbsPath: process.cwd() },
		undefined,
		emitted,
	);
	check(
		"default: the orphan was closed with the sweep's sentence",
		on.messages.some((message) => message.role === "toolResult" && textOf(message).includes("was left unanswered")),
		JSON.stringify(on.messages.map((message) => `${message.role}:${textOf(message)}`)),
	);

	// 一个门没有真正放行的 grant：恢复趟把调用重新穿过门，而再次挂起的门让恢复就地停下——
	// 不写任何结果，run 在自己的请求之前结束，与活批次被挂起时一模一样。工具必须存在于表里，
	// 门才可能被问到；context 什么都不声明，这正是要点——声明是 transport 读的东西，不是调用
	// 解析所对着的东西。
	const resuspended = await recoverPendingToolCalls(
		{ messages: [dangling], tools: [] },
		danglingToolCallsOf([dangling]),
		{ answers: { call_x: { approved: true } } },
		suspendingGate,
		manager,
		activeNames,
		{ workDirAbsPath: process.cwd() },
		undefined,
		emitted,
	);
	check(
		"re-suspended: the granted call stayed a question and nothing was written",
		resuspended.suspended === true && resuspended.messages.length === 0,
		JSON.stringify({
			suspended: resuspended.suspended,
			messages: resuspended.messages.map((message) => message.role),
		}),
	);
	/** 这个用例留下的计数：下面那趟以它为基准测差值。 */
	const gatesAfterResuspend = gatesAsked;

	// 一个这次 run 无权使用的名字的 grant：同一张表、同一份 transcript，只有列表不同——调用被
	// 以未知名字得到的那句话关闭，fixture 自己的代码从未被进入。这正是表回答不了的那一半：
	// 它持有工具（上面的用例抵达了它的门），而拒绝 run 的是 run 的列表。
	const outside = await recoverPendingToolCalls(
		{ messages: [dangling], tools: [] },
		danglingToolCallsOf([dangling]),
		{ answers: { call_x: { approved: true } } },
		suspendingGate,
		manager,
		new Set<string>(),
		{ workDirAbsPath: process.cwd() },
		undefined,
		emitted,
	);
	const closedOutside = outside.messages[0];
	check(
		"a granted call outside the run's list is refused, not run",
		outside.messages.length === 1 && closedOutside?.isError === true && textOf(closedOutside).includes("Tool read_fixture not found"),
		JSON.stringify(outside.messages.map((message) => textOf(message))),
	);
	// 门被上面重新挂起的那趟问过——列表里有工具的那个用例——而这趟不得给它加数：在门之前
	// 发生的拒绝让计数停在原处。
	check("and the gate was not asked about it", gatesAsked === gatesAfterResuspend, `${gatesAfterResuspend} -> ${gatesAsked}`);
	check("with the fixture's own code never entered", ranFixture === 0, String(ranFixture));
}

// ---------------------------------------------------------------------------------------------------
// 4. 恢复期间的 abort：run 像任何 run 一样停下，没有任何 denial 骑在 abort 上。
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\naborting a recovery run leaves the recovered call with its own result\n");

{
	// 持住恢复 run 的请求——第二次调用，在被提示的 run 自己那次之后。
	const gate = gatedApi([2]);
	const session = await openSession({ approval: { read: true }, api: gate.api });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("after the grant")]);
	await session.prompt(sidOf(session), "read the notes", { selection });
	await session.settle(sidOf(session));
	const callId = session.snapshot(sidOf(session)).pendingApprovals[0]?.toolCallId ?? "";
	check("the run parked at the gate", callId.length > 0);

	// grant 启动恢复 run；被持住的 provider 调用正是 abort 落下的地方。
	void session.respondApproval(sidOf(session), callId, true);
	const started = Date.now();
	while (!gate.held(2) && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 10));
	check("the recovery run reached its request", gate.held(2));

	await session.abort(sidOf(session));
	await session.settle(sidOf(session));
	check("the abort settled the recovery run", !session.snapshot(sidOf(session)).submitting);
	const results = toolResultTexts(session);
	check("the recovered call kept its own result", results.some((text) => text.includes("notes.txt")), JSON.stringify(results));
	check(
		"and no denial rode the abort: the gate's sentences are nowhere",
		results.every((text) => !text.includes("denied permission") && !text.includes("The run was aborted")),
		JSON.stringify(results),
	);
	check("the aborted session has nothing waiting", !session.hasPendingApprovals(sidOf(session)));
	await session.close(sidOf(session));
}

// ---------------------------------------------------------------------------------------------------
// 5. 信箱也是恢复 run 的：被 steer 的消息在取用点被排干并应答，与从 prompt 开始的 run 完全
// 一致（0003 未变）。
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\na message steered into a recovery run is taken at the take point\n");

{
	// 持住恢复 run 的请求——第二次调用，在被提示的 run 自己那次之后。
	const gate = gatedApi([2]);
	const session = await openSession({ approval: { read: true }, api: gate.api });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("answered both")]);
	await session.prompt(sidOf(session), "read the notes", { selection });
	await session.settle(sidOf(session));
	const callId = session.snapshot(sidOf(session)).pendingApprovals[0]?.toolCallId ?? "";

	void session.respondApproval(sidOf(session), callId, true);
	const started = Date.now();
	while (!gate.held(2) && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 10));
	// steer 在恢复中途被收下——run 正在流式，所以它入队而不是自己开 prompt。
	await session.steer(sidOf(session), "and also this", { selection });

	gate.release(2);
	await session.settle(sidOf(session));
	check(
		"the recovery run drained the mailbox and answered it",
		session.snapshot(sidOf(session)).messages.some((message) => message.role === "assistant" && textOf(message) === "answered both"),
	);
	check("and the steered message is in the transcript once", session.snapshot(sidOf(session)).messages.filter((message) => message.role === "user" && textOf(message) === "and also this").length === 1);
	await session.close(sidOf(session));
}

process.stdout.write(failures === 0 ? "\napproval recovery ok\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;

clearTimeout(watchdog);
await rm(root, { recursive: true, force: true });
await rm(storeRoot, { recursive: true, force: true }).catch(() => {});
