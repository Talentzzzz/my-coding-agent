// session 面上的恢复机器（ADR-0005 §5，ticket 15）：审批门让 run 以调用悬在 ledger 里的状态
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
	ModelManager,
	openAgent,
	recoverPendingToolCalls,
	createSession,
	type Agent,
	type AgentEvent,
	type Tool,
	type Session,
	type ModelConfig,
	type ModelSelection,
	type ToolRunContext,
	type ToolUpdateCallback,
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

/** 会话记录里的每一个工具结果，从旧到新。 */
function toolResultTexts(agent: Agent): string[] {
	return agent.snapshot(sidOf(agent)).messages.filter((message) => message.role === "toolResult").map((message) => textOf(message));
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
function gatedApi(holds: number[]): { chatTransport: ChatTransport; release(index: number): void; held(index: number): boolean } {
	const inner = fake.chatTransport.stream.bind(fake.chatTransport);
	let calls = 0;
	const pending = new Map<number, () => void>();
	const released = new Set<number>();
	const chatTransport: ChatTransport = {
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
		chatTransport,
		release: (index) => {
			released.add(index);
			pending.get(index)?.();
			pending.delete(index);
		},
		held: (index) => pending.has(index) && !released.has(index),
	};
}

/**
 * 每个打开的 session 运行时所用的 id，保存在各检查持有的 agent 旁边。
 *
 * agent 的方法现在按 id 指名它——orchestrator 不持有任何 session 状态——所以打开助手在这里
 * 记录它创建的东西，每个检查经由 {@link sidOf} 读回。
 */
const opened = new WeakMap<Agent, { id: string; session: Session }>();

function bagOf(agent: Agent): Session {
	return opened.get(agent)!.session;
}

function sidOf(agent: Agent): string {
	return opened.get(agent)!.id;
}

/** ADR-0021：出生消息。openSession 先落它，之后的 prompt / snapshot 才有文件可开。 */
const BIRTH_TEXT = "the smoke's birth message";

/** 每个 openSession 递自己的临时 home：各持有者的文件都落在这里，随 root 一起清理。 */
let homeSeq = 0;

async function openSession(overrides: { approval?: Record<string, boolean>; chatTransport?: ChatTransport } = {}): Promise<Agent> {
	const session = createSession(root);
	// 设置归属重构（spec §8）后内存后端退场：审批映射与模型行先种进临时 home 的真实文件，homes
	// 透传给 openAgent——与生产同一条构造路，只是文件指到了无人问津的目录。
	const home = join(root, `agent-home-${homeSeq++}`);
	const toolManager = createToolManager({ home });
	if (overrides.approval !== undefined) toolManager.applyToolDefaults({ approval: overrides.approval });
	const modelManager = new ModelManager({ home: home });
	modelManager.replaceRows(rows);
	const agent = await openAgent({
		session,
		chatTransport: overrides.chatTransport ?? fake.chatTransport,
		settingsHome: home,
		modelsHome: home,
	});
	// 会话随第一条消息出生（ADR-0021），而编排层按 id 现开文件：这里直接对袋追加一条 user
	// 消息让文件落地——不跑引擎、不耗剧本。模型选择随每条 prompt 的 selection 抵达，与生产一致。
	agent.sessionManager.appendMessage(session, {
		role: "user",
		content: [{ type: "text", text: BIRTH_TEXT }],
		timestamp: 1,
	});
	opened.set(agent, { id: session.sessionId, session });
	return agent;
}

// ---------------------------------------------------------------------------------------------------
// 1 + 2. 两种应答，各自启动收掉它所指名调用的那次 run。
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\na grant resumes the run and re-runs the call; a denial closes it with its reason\n");

{
	const agent = await openSession({ approval: { read: true } });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("after the grant")]);
	await agent.prompt(sidOf(agent), "read the notes", { selection });
	await agent.settle(sidOf(agent));
	check("the gate ended the run with the call dangling", agent.snapshot(sidOf(agent)).pendingApprovals.length > 0, JSON.stringify(agent.snapshot(sidOf(agent)).pendingApprovals));
	const callId = agent.snapshot(sidOf(agent)).pendingApprovals[0]?.toolCallId ?? "";
	check("the dangling call has no result yet", toolResultTexts(agent).length === 0, JSON.stringify(toolResultTexts(agent)));

	await agent.respondApproval(sidOf(agent), callId, true);
	await agent.settle(sidOf(agent));
	const grantResults = toolResultTexts(agent);
	check("the recovery pass re-ran the call through the tool", grantResults.some((text) => text.includes("notes.txt")), JSON.stringify(grantResults));
	check("the granted call is no longer waiting", !agent.hasPendingApproval(sidOf(agent), callId));
	check("a grant records the session's own approval choice", agent.getApprovals(sidOf(agent)).read === false);
	check(
		"and the model carried on in the same run",
		agent.snapshot(sidOf(agent)).messages.some((message) => message.role === "assistant" && textOf(message) === "after the grant"),
	);
	await agent.close(sidOf(agent));
}

{
	const agent = await openSession({ approval: { read: true } });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("after the denial")]);
	await agent.prompt(sidOf(agent), "read the notes", { selection });
	await agent.settle(sidOf(agent));
	const callId = agent.snapshot(sidOf(agent)).pendingApprovals[0]?.toolCallId ?? "";

	await agent.respondApproval(sidOf(agent), callId, false);
	await agent.settle(sidOf(agent));
	const denialResults = toolResultTexts(agent);
	check("the recovery pass closed the call with the deny's sentence", denialResults.some((text) => text.includes("The user denied permission to run read.")), JSON.stringify(denialResults));
	check("the denied call is no longer waiting", !agent.hasPendingApproval(sidOf(agent), callId));
	check(
		"and the model answered the denial",
		agent.snapshot(sidOf(agent)).messages.some((message) => message.role === "assistant" && textOf(message) === "after the denial"),
	);
	await agent.close(sidOf(agent));
}

// ---------------------------------------------------------------------------------------------------
// 3. 孤儿：崩溃留下的东西在下一次 run 的入口（prompt 或 resume）被关闭。
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\ndangling calls no answer names are closed before the first request\n");

{
	const agent = await openSession();
	// 崩溃形状：会话记录里两条调用，身后都没有结果——按一个死于批次中途的进程留下它们的
	// 方式追加。
	agent.sessionManager.appendMessage(bagOf(agent), fakeAssistantMessage(fakeToolCall("read", { path: "a.txt" }, { id: "call_a" })));
	agent.sessionManager.appendMessage(bagOf(agent), fakeAssistantMessage(fakeToolCall("read", { path: "b.txt" }, { id: "call_b" })));
	check("both dangling calls are derived from the ledger", agent.snapshot(sidOf(agent)).pendingApprovals.length === 2, JSON.stringify(agent.snapshot(sidOf(agent)).pendingApprovals));

	const prompts: { roles: string[] }[] = [];
	fake.setResponses([
		(context) => {
			prompts.push({ roles: requestRoles(context) });
			return fakeAssistantMessage("carried on");
		},
	]);
	await agent.prompt(sidOf(agent), "continue", { selection });
	await agent.settle(sidOf(agent));

	const orphanResults = toolResultTexts(agent);
	check(
		"both orphans were closed with the sentence that says what happened",
		orphanResults.filter((text) => text.includes("was left unanswered")).length === 2,
		JSON.stringify(orphanResults),
	);
	check("the sweep cleared the waiting", agent.snapshot(sidOf(agent)).pendingApprovals.length === 0);
	check(
		"and the first request was provider-legal: each result beside its own call, the prompt after them",
		// 出生消息（ADR-0021）是上下文里的第一条 user 消息，排在 system 之后。
		JSON.stringify(prompts[0]?.roles) === JSON.stringify(["system", "user", "assistant", "toolResult", "assistant", "toolResult", "user"]),
		JSON.stringify(prompts[0]?.roles),
	);
	await agent.close(sidOf(agent));
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
	const toolManager = createToolManager();
	toolManager.register(readTool);
	// 一次 run 会声明的工具面：这里只有那个 fixture，它也正是整张表——链条问的两个问题（"这次
	// run 可以调它吗"、"这个名字存在吗"）如今是同一个问题：解析对着本请求声明过的数组按名查
	// （ADR-0016），调用只能落到声明过的名字上。所以每个用例供给自己的声明面，而不是一张表加
	// 一份名单。
	const declared = [readTool];

	/** 一次趟发出了什么，让"沉默"是一条断言而不是一个未观察的主张。 */
	const events: AgentEvent[] = [];
	const emitted = (event: AgentEvent): void => {
		events.push(event);
	};

	/** 执行经本练习自建的表转发：`Tool.execute` 的生产唯一入口仍是表自己（ADR-0011）。 */
	const executeTool = (
		name: string,
		toolCallId: string,
		params: unknown,
		run: ToolRunContext,
		signal: AbortSignal | undefined,
		onUpdate: ToolUpdateCallback<any> | undefined,
	) => toolManager.execute(name, toolCallId, params, run, signal, onUpdate);

	/** 放行一切的门：与旧的"递入空 hooks 对象"同一语义。 */
	const passGates = {
		decideBeforeTool: async () => ({}),
		decideAfterTool: async () => ({}),
	};

	/** 调用抵达门的次数，让"在门之前被拒"可观察。 */
	let gatesAsked = 0;
	/** 应答"挂起"、并统计自己被问过几次的门。 */
	const suspendingGate = {
		decideBeforeTool: async () => {
			gatesAsked += 1;
			return { suspend: true };
		},
		decideAfterTool: async () => ({}),
	};

	const off = await recoverPendingToolCalls(
		danglingToolCallsOf([dangling]),
		{ enablePendingToolRecovery: false },
		{ sessionId: "recovery-smoke", declared, executeTool, ...passGates },
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
		danglingToolCallsOf([dangling]),
		undefined,
		{ sessionId: "recovery-smoke", declared, executeTool, ...passGates },
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
	// 不写任何结果，run 在自己的请求之前结束，与活批次被挂起时一模一样。门能被问到的唯一前提
	// 是调用先解析到了实例：fixture 在声明面上，所以拦截它的是门，而不是"未知工具"——那条
	// 错误在任何门运行之前就应答了。
	const resuspended = await recoverPendingToolCalls(
		danglingToolCallsOf([dangling]),
		{ answers: { call_x: { approved: true } } },
		{ sessionId: "recovery-smoke", declared, executeTool, ...suspendingGate },
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

	// 一个这次 run 未曾声明的名字的 grant：同一次工具链，只有声明面不同——调用被以未知名字得到的
	// 那句话关闭，fixture 自己的代码从未被进入。这正是声明面回答的那一半：门（与表）持有工具，
	// 而拒绝 run 的是本请求声明过什么。
	const outside = await recoverPendingToolCalls(
		danglingToolCallsOf([dangling]),
		{ answers: { call_x: { approved: true } } },
		{ sessionId: "recovery-smoke", declared: [], executeTool, ...suspendingGate },
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
	const agent = await openSession({ approval: { read: true }, chatTransport: gate.chatTransport });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("after the grant")]);
	await agent.prompt(sidOf(agent), "read the notes", { selection });
	await agent.settle(sidOf(agent));
	const callId = agent.snapshot(sidOf(agent)).pendingApprovals[0]?.toolCallId ?? "";
	check("the run parked at the gate", callId.length > 0);

	// grant 启动恢复 run；被持住的 provider 调用正是 abort 落下的地方。
	void agent.respondApproval(sidOf(agent), callId, true);
	const started = Date.now();
	while (!gate.held(2) && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 10));
	check("the recovery run reached its request", gate.held(2));

	await agent.abort(sidOf(agent));
	await agent.settle(sidOf(agent));
	check("the abort settled the recovery run", !agent.snapshot(sidOf(agent)).running);
	const results = toolResultTexts(agent);
	check("the recovered call kept its own result", results.some((text) => text.includes("notes.txt")), JSON.stringify(results));
	check(
		"and no denial rode the abort: the gate's sentences are nowhere",
		results.every((text) => !text.includes("denied permission") && !text.includes("The run was aborted")),
		JSON.stringify(results),
	);
	check("the aborted session has nothing waiting", agent.snapshot(sidOf(agent)).pendingApprovals.length === 0);
	await agent.close(sidOf(agent));
}

// ---------------------------------------------------------------------------------------------------
// 5. 信箱也是恢复 run 的：被 steer 的消息在取用点被排干并应答，与从 prompt 开始的 run 完全
// 一致（0002 未变）。
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\na message steered into a recovery run is taken at the take point\n");

{
	// 持住恢复 run 的请求——第二次调用，在被提示的 run 自己那次之后。
	const gate = gatedApi([2]);
	const agent = await openSession({ approval: { read: true }, chatTransport: gate.chatTransport });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("answered both")]);
	await agent.prompt(sidOf(agent), "read the notes", { selection });
	await agent.settle(sidOf(agent));
	const callId = agent.snapshot(sidOf(agent)).pendingApprovals[0]?.toolCallId ?? "";

	void agent.respondApproval(sidOf(agent), callId, true);
	const started = Date.now();
	while (!gate.held(2) && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 10));
	// steer 在恢复中途被收下——run 正在流式，所以它入队而不是自己开 prompt。
	await agent.steer(sidOf(agent), "and also this", { selection });

	gate.release(2);
	await agent.settle(sidOf(agent));
	check(
		"the recovery run drained the mailbox and answered it",
		agent.snapshot(sidOf(agent)).messages.some((message) => message.role === "assistant" && textOf(message) === "answered both"),
	);
	check("and the steered message is in the session once", agent.snapshot(sidOf(agent)).messages.filter((message) => message.role === "user" && textOf(message) === "and also this").length === 1);
	await agent.close(sidOf(agent));
}

process.stdout.write(failures === 0 ? "\napproval recovery ok\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;

clearTimeout(watchdog);
await rm(root, { recursive: true, force: true });
await rm(storeRoot, { recursive: true, force: true }).catch(() => {});
