// Stream lifecycle smoke test，常驻 transport 给它的形状：观看决定一个 session 的哪些帧流到窗口，
// hold 记下谁在改变它，运行自己决定 state 存活多久。一条看着 idle session 的车道不取 hold、也不
// 结束任何东西，打开它的读也不登记任何东西——表持有的是正在运行的东西，所以一个被看着但 idle
// 的 session 是一份文件加一条车道，仅此而已（ADR-0013）。一次 run 结束不结束车道：什么都不结束
// 它——观看不是持有，失败与结束都只影响编排层的表。失败那一节钉住一个在 watcher 之下失败的
// run——和一个无人看着失败的 run——分别在哪些地方被听到。
//
//   node scripts/smoke-stream.ts
//
// 无需 provider key：模型就是剧本化 transport。测试台在需要会话被"使用着"的地方经真正的
// hub 取自己的 hold——那是测试台的 hold，不是订阅的，这正是被测的区分。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxUpgrade, sessionListeners } from "@my-agent/trigger";
import { createMuxServer } from "@my-agent/trigger";
import { SessionHub } from "@my-agent/case";
import { SessionController, SystemController } from "@my-agent/trigger";
import { createRoutes } from "@my-agent/trigger";
import { Router } from "@my-agent/trigger";
import { createServer } from "@my-agent/trigger";
import { createFakeTransport, fakeAssistantMessage, type FakeTransport } from "./fake-transport.ts";
import { connect, until, type WireClient } from "./wire/client.ts";
import type { ModelConfig } from "@my-agent/domain";
import { HomeJsonStore, SessionFileStore, ToolResultsArchive } from "@my-agent/infra";

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

/** 收下一次 prompt，run 还没做什么它就被应答了。 */
async function prompt(base: string, sessionId: string, text: string): Promise<number> {
	return (await request(base, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/messages`, { text })).status;
}

/** 在一条车道上等循环自己的 end 事件。 */
async function waitAgentEnd(wire: WireClient, sessionId: string, ms = 15_000): Promise<boolean> {
	return until(
		() =>
			wire.items(sessionId).some(
				(message) => message.type === "event" && (message as { event?: { type?: string } }).event?.type === "agent_end",
			),
		ms,
	);
}

/** 等说 run 结束了的那个 status 帧，无论它走了哪条路到达那里。 */
async function waitSettled(wire: WireClient, sessionId: string, ms = 15_000): Promise<boolean> {
	return until(
		() => wire.items(sessionId).some((message) => message.type === "status" && (message as { running?: boolean }).running === false),
		ms,
	);
}

/** 长到任何本要结束 idle 车道的东西都该已经动手；短到保持快速。 */
const QUIET_MS = 700;

/** 慢到 run 可观察地在途；快到整个 smoke 保持在一分钟内。 */
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
	sessionHub: SessionHub;
	transport: FakeTransport;
	close(): Promise<void>;
}

async function openRig(): Promise<Rig> {
	const root = await mkdtemp(join(tmpdir(), "my-agent-stream-"));
	const transport = createFakeTransport({ tokensPerSecond: TOKENS_PER_SECOND });
	// 自造 infra 实现指临时目录（分层重构 §7 步 5）：hub 只认端口，home → 实现的翻译在这里。
	const agentHome = join(root, "agent-home");
	const homeJson = new HomeJsonStore({ home: agentHome });
	const sessionHub = new SessionHub({
		workDirAbsPath: root,
		chatTransport: transport.chatTransport,
		sessionRepository: new SessionFileStore({ storeDir: join(root, "sessions") }),
		sessionDefaultsRepository: homeJson,
		modelRepository: homeJson,
		toolDefaultsRepository: homeJson,
		toolResultsRepository: new ToolResultsArchive(),
	});
	sessionHub.setModelConfigs(rows);

	const muxServer = createMuxServer({ sessionHub }, { heartbeatIntervalMs: 150 });
	const router = new Router(
		createRoutes({
			systemController: new SystemController(sessionHub),
		sessionController: new SessionController(sessionHub, sessionListeners({ sessionHub })),
		}),
	);
	const httpServerHandle = await createServer({ router, clientDir: "packages/web/dist", onUpgrade: muxUpgrade(muxServer) });
	await new Promise<void>((listen) => httpServerHandle.server.listen(0, "127.0.0.1", listen));
	const url = `http://127.0.0.1:${(httpServerHandle.server.address() as { port: number }).port}`;

	return {
		url,
		sessionHub,
		transport,
		close: async () => {
			await sessionHub.close();
			await httpServerHandle.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

/**
 * 让每次 assistant 消息的持久化都失败，补丁装着多久就失败多久。
 *
	 * 这是 ticket 08 为机械失败形状指名的接缝：坏掉的是会话记录本身，所以关于失败的任何东西
 * 都写不进失败通常去的地方。用户消息仍然落地——`prompt` 在循环开始之前写它——所以补丁放它
 * 通过。
 *
 * 补丁落在 hub 的唯一 orchestrator 经由读取的那个 session 服务上，所以它不得活得比安装它的
 * 那一节久：返回的函数把真方法放回去，每个调用方在自己那趟失败的 run 结束后运行它。
 */
function sabotagePersistence(sessionHub: SessionHub): () => void {
	const manager = sessionHub.agent.sessionManager as unknown as {
		appendMessage: (state: unknown, message: { role?: string }) => string;
	};
	const original = manager.appendMessage.bind(manager);
	manager.appendMessage = (state, message) => {
		if (message.role !== "user") throw new Error("smoke-stream: 磁盘写不进去了");
		return original(state, message);
	};
	return () => {
		manager.appendMessage = original;
	};
}

const rig = await openRig();
const wire = await connect(`${rig.url.replace("http", "ws")}/mux`);

/**
 * orchestrator 的表此刻是否持有这个 session。
 *
 * 不是同步快照：那个读文件，所以无论是否有东西在运行它都对每个诞生过的 session 作答，而一次
 * 读根本不登记 state（ADR-0013）。表是唯一的仪表，所以直接读它——穿过私有 map，与其他 smoke
 * 到达门面不外发的半区的方式相同。
 */
const inTable = (id: string): boolean =>
	(rig.sessionHub.agent as unknown as { agentStateMap: Map<string, unknown> }).agentStateMap.has(id);

try {
	// ---------------------------------------------------------------------------------------------
	// 1. 一条 idle session 上的车道：没有 host、没有 end。
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a lane on an idle session holds nothing and ends nothing\n");

	const created = await request(rig.url, "POST", "/api/sessions", { text: "the idle conversation" });
	const idleId = (created.payload as { sessionId: string }).sessionId;
	const idle = await wire.open(idleId);
	check("the lane opened with the snapshot", idle.id === idleId);
	check("and an idle session says so", idle.running === false, String(idle.running));

	await sleep(QUIET_MS);
	check("the lane is still there — nothing ended it", !wire.endOf(idleId).ended, JSON.stringify(wire.endOf(idleId)));
	check("and nothing keeps a live half for the session", !rig.sessionHub.isLive(idleId), String(rig.sessionHub.isLive(idleId)));

	// 读也不是一次运行——窗口的冷路径。不存在的 session 是 404，它的读什么都不装配。
	const cold = await request(rig.url, "GET", `/api/sessions/${encodeURIComponent(idleId)}`);
	check("a cold read answers", cold.status === 200, String(cold.status));
	const missing = await request(rig.url, "GET", "/api/sessions/does-not-exist");
	check("an unknown session is a 404", missing.status === 404, String(missing.status));

	// 读不登记任何东西（ADR-0013）：出生运行自己的结束路径已经把 live 半带出表——跑完即散，冷读
	// 现装一只用完即弃的袋来作答。丢掉它不是删除：文件已在（ADR-0021）。
	check("the run's own end swept the state; the cold read leaves it swept", !inTable(idleId));

	// ---------------------------------------------------------------------------------------------
	// 2. run 结束不结束车道；观看长存，与运行无关。
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a run ends, the lane stays, watching outlives everything\n");

	// 观看不占任何簿记（票 03 起连 hold 表也不存在了）：车道在会话有没有被谁「使用着」的情况下
	// 表现完全一致，这正是本节要断言的。
	rig.transport.setResponses([fakeAssistantMessage("a".repeat(500))]);
	check("the prompt was accepted", (await prompt(rig.url, idleId, "say something long")) === 202);
	check("the run's own end reached the lane", await waitAgentEnd(wire, idleId));
	check("and the status frame said so too", await waitSettled(wire, idleId));

	await sleep(QUIET_MS);
	check("no end arrived after the run — nothing about the run ends a lane", !wire.endOf(idleId).ended, JSON.stringify(wire.endOf(idleId)));

	// 车道仍然可用：同一个订阅承载下一次 run。
	rig.transport.setResponses([fakeAssistantMessage("b".repeat(500))]);
	check("the second prompt was accepted", (await prompt(rig.url, idleId, "and again")) === 202);
	check("and its frames reached the same lane", await waitAgentEnd(wire, idleId));

	// 车道不为运行的来去所动——观看从来不是持有，会话的活一半由运行自己带进带出。
	check("and the lane went nowhere: watching is not holding", !wire.endOf(idleId).ended, JSON.stringify(wire.endOf(idleId)));
	// run 是把 state 放进表的动作，运行的结束是把它拿出来的动作；留下的是文件，那是"这个 session"的全部。
	// 散袋发生在运行的 finally 里，agent_end 的监听者可能抢在它前面——轮询，不猜时机。
	check("and the state went with the run's own end", await until(() => !inTable(idleId), 5_000));

	// ---------------------------------------------------------------------------------------------
	// 3. 挂到已经在途的 run 上：baseline 说着这件事，车道活过它。
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a lane that opens on a run already in flight\n");

	rig.transport.setResponses([fakeAssistantMessage("c".repeat(600))]);
	check("the prompt was accepted", (await prompt(rig.url, idleId, "one more long answer")) === 202);
	check("the run started", await until(() => rig.sessionHub.isLive(idleId), 5_000), String(rig.sessionHub.isLive(idleId)));

	const midflight = await wire.open(idleId);
	check("the mid-run baseline reports the run", midflight.running === true, String(midflight.running));
	// wire 客户端上的 `ended` 是"曾经终过"，而 idleId 的车道在上面那节已经终过一次，所以这里的
	// 断言数的是这次 open 之后的 end 次数，而不是读那个布尔。
	const endsAtOpen = wire.endOf(idleId).ends;
	await sleep(QUIET_MS);
	check("and nothing ends the lane while the run goes on", wire.endOf(idleId).ends === endsAtOpen, JSON.stringify(wire.endOf(idleId)));
	check("the run ended on the lane", await waitAgentEnd(wire, idleId));
	check("and the lane outlived it", wire.endOf(idleId).ends === endsAtOpen, JSON.stringify(wire.endOf(idleId)));
	check("and the lane went nowhere afterwards", await until(() => wire.endOf(idleId).ends === endsAtOpen, 5_000), JSON.stringify(wire.endOf(idleId)));

	// ---------------------------------------------------------------------------------------------
	// 4. 一个在 watcher 之下失败的 run：error 帧、settled 帧、日志。
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a run that fails under a watcher is heard in three places\n");

	const watched = await request(rig.url, "POST", "/api/sessions", { text: "the watched conversation" });
	const watchedId = (watched.payload as { sessionId: string }).sessionId;
	const restoreWatched = sabotagePersistence(rig.sessionHub);
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
	// birth 的往来（ADR-0021：user + 出错即答的 assistant）早已落盘，这次失败只丢它自己的
	// assistant 消息——留下的是出生的两条加上这次 prompt 的 user 消息。
	check("the session is exactly what the failure let survive", ((await request(rig.url, "GET", `/api/sessions/${encodeURIComponent(watchedId)}`)).payload as { session: { messages: unknown[] } }).session.messages.length === 3);
	// 补丁在下一节运行之前摘掉：它落在的是 hub 自己的服务上。
	restoreWatched();

	// 失败的运行自己散袋：没有停驻的审批，就没有留下活半的理由。
	check("nothing stays live after the failed run", !rig.sessionHub.isLive(watchedId), String(rig.sessionHub.isLive(watchedId)));

	// ---------------------------------------------------------------------------------------------
	// 5. 同样的失败、无人看着：日志是它唯一仍可听见的地方。
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a run that fails with nobody watching is heard only in the log\n");

	const unwatched = await request(rig.url, "POST", "/api/sessions", { text: "the unwatched conversation" });
	const unwatchedId = (unwatched.payload as { sessionId: string }).sessionId;
	const restoreUnwatched = sabotagePersistence(rig.sessionHub);

	const loggedAlone: string[] = [];
	console.error = (...parts: unknown[]) => {
		loggedAlone.push(parts.map(String).join(" "));
	};
	rig.transport.setResponses([fakeAssistantMessage("also never lands")]);
	check("the prompt was accepted", (await prompt(rig.url, unwatchedId, "this run fails alone")) === 202);
	// 验收边界 3 的服务端那一半：任何地方都没有 lane 开在这个 session 上，所以让它活着的是 run
	// 而不是别的——簿记不掺和，运行自己散袋，session 无需任何收摊。
	check(
		"a run nobody watches still keeps its own live half",
		rig.sessionHub.isLive(unwatchedId),
		String(rig.sessionHub.isLive(unwatchedId)),
	);
	// run 的结束不需要任何 lane 就可观察：循环结束后读路径答 `running: false`。只有那时才
	// 关闭日志捕获——更早恢复会让失败跑出它要监视的窗口。（手写的轮询，因为 `until` 收的是
	// 同步谓词，async 谓词会被读成永远为真。）
	const settleDeadline = Date.now() + 10_000;
	for (;;) {
		const read = await request(rig.url, "GET", `/api/sessions/${encodeURIComponent(unwatchedId)}`);
		if (((read.payload as { session?: { running?: boolean } }).session?.running ?? true) === false) break;
		if (Date.now() > settleDeadline) break;
		await sleep(50);
	}
	console.error = realError;
	restoreUnwatched();

	check("no lane existed to announce on, and the log line went out anyway", loggedAlone.length > 0, JSON.stringify(loggedAlone));
	check("and nothing leaked: the failed run's own end swept the state", await until(() => !rig.sessionHub.isLive(unwatchedId), 10_000), String(rig.sessionHub.isLive(unwatchedId)));

	// ---------------------------------------------------------------------------------------------
	// 6. 流式回答以 delta 过 wire，run 中打开的车道被交予剩余部分。
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a streamed answer crosses the wire as deltas\n");

	/** assistant 消息的文本，按 wire 在 start/end/baseline 上发送它的样子。 */
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
	const deltaSession = await request(rig.url, "POST", "/api/sessions", { text: "the delta conversation" });
	const deltaId = (deltaSession.payload as { sessionId: string }).sessionId;
	const deltaLane = await wire.open(deltaId);
	check("the lane opened on the new session", deltaLane.id === deltaId);

	rig.transport.setResponses([fakeAssistantMessage(deltaAnswer)]);
	check("the prompt was accepted", (await prompt(rig.url, deltaId, "say something very long")) === 202);
	check("the run started producing", await until(() => updatesOf(wire, deltaId).length > 0, 5_000));

	// 第二条车道，在回答仍在到达时打开。它的 baseline 是唯一能携带这个窗口错过内容的帧——它
	// 之后的 delta 是回答的其余部分。
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
	// 信封加上一个 provider chunk，无论答案长到多大。整条消息仍然完整过 wire 一次——在
	// `message_end` 上，在那里它正是被记录的东西。
	check("no update frame is a copy of the answer", Math.max(...sizes) < 300, `largest ${Math.max(...sizes)} bytes of ${deltaAnswer.length}`);
	const endSizes = wire.frames
		.filter((frame) => frame.streamId === deltaId && "item" in frame && frame.item.type === "event" && frame.item.event.type === "message_end")
		.map((frame) => JSON.stringify(frame).length);
	check("the answer itself travels once, whole, at the end", endSizes.some((size) => size > deltaAnswer.length), `${endSizes.join("/")} bytes`);

	const lateText = partialText + updatesOf(late, deltaId).map((event) => event.delta.text).join("");
	check("baseline plus the rest is the whole answer", lateText === deltaAnswer, `${lateText.length}/${deltaAnswer.length}`);

	await late.close();
	check("the delta session's state was swept by its own end", await until(() => !rig.sessionHub.isLive(deltaId), 10_000), String(rig.sessionHub.isLive(deltaId)));

	// ---------------------------------------------------------------------------------------------
	// 7. shutdown 什么都不等。
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("shutdown waits for nothing\n");

	rig.transport.setResponses([fakeAssistantMessage("d".repeat(600))]);
	check("the prompt was accepted", (await prompt(rig.url, idleId, "a run for shutdown to stop")) === 202);
	check("the run started", await until(() => rig.sessionHub.isLive(idleId), 5_000), String(rig.sessionHub.isLive(idleId)));

	const started = Date.now();
	await rig.close();
	check("closing with a run in flight and a lane attached returns", Date.now() - started < 5_000, `${Date.now() - started} ms`);
	check("and no session is left running", !rig.sessionHub.isLive(idleId), String(rig.sessionHub.isLive(idleId)));
} catch (error) {
	failures += 1;
	process.stdout.write(`\nFAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	try {
		await rig.close();
	} catch {
		// 装置可能已被上面的 shutdown 检查关掉。
	}
} finally {
	process.stdout.write(failures === 0 ? "\nstream ok\n" : `\n${failures} failure(s)\n`);
	process.exitCode = failures === 0 ? 0 : 1;
}
