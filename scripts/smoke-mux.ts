// Wire-surface smoke test：关于 mux 协议本身的断言的唯一家——信封、帧骑的车道、连接级载荷、
// 上行容错，以及一条复用连接存在的两条验收边界。REST 命令是 smoke-api.ts 的主题；这里不重复。
// 无需 provider key——模型就是剧本化 transport。
//
//   node scripts/smoke-mux.ts
//
// 装置有意做成多 session（其他 wire 侧脚本都是单 session）：一条连接同时持有两个对话正是这套
// transport 为之重开的产品形状，而这里是唯一能不用浏览器就断言它的地方。
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

/** 收下一次 prompt，run 还没做什么它就被应答了。 */
async function prompt(base: string, sessionId: string, text: string): Promise<number> {
	return (await request(base, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/messages`, { text })).status;
}

/** 这些检查会读的快照部分。 */
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

/** 等 run 落定，轮询读取路径——在途的 run 底下分支不能动。 */
async function settleRun(base: string, sessionId: string, ms = 15_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	for (;;) {
		const session = await readSession(base, sessionId);
		if (session?.submitting === false) return true;
		if (Date.now() > deadline) return false;
		await sleep(50);
	}
}

/** 这些检查从连接级流上读的那一行。 */
function rowOf(envelope: unknown): SessionRow | undefined {
	const item = (envelope as { item?: { type?: string; session?: SessionRow } }).item;
	return item?.type === "session_row" ? item.session : undefined;
}

/** 一条车道带过多少份 baseline：一条流可以携带不止它打开时的那一份。 */
function baselinesOn(wire: WireClient, sessionId: string): number {
	return wire.items(sessionId).filter((message) => message.type === "baseline").length;
}

/** 一条车道上最新的 baseline——客户端被最后指到的那个状态。 */
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

/** 慢到 run 可观察地在途；快到 smoke 保持在一分钟内。 */
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
	// 两者都到达；谁先谁后被有意不断言（ticket 07：baseline 可能先于 heartbeat），且两种帧都
	// 不得骑在 session 的 streamId 上。
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

	// 第二次 `open` 要求的是与第一次相同的东西——这个 session 现在的状态，及其后的一切——所以
	// 它的应答是已存在流上再多一份 baseline，底下的订阅原样不动（ADR-0010 决定 1）。这正是窗格
	// 在别的东西仍持有 session 时离开再回来需要的那帧：没有发过 `cancel`，所以重发的 baseline
	// 是回程唯一可能得到的应答。
	//
	// 轮询而非固定 sleep 后采样：baseline 从 session 的文件上读，被等待的是帧，不是一段时长。
	const beforeDuplicate = baselinesOn(wire, laneId);
	wire.send({ type: "open", sessionId: laneId });
	check("the duplicate open was answered with another baseline", await until(() => baselinesOn(wire, laneId) > beforeDuplicate, 5_000), JSON.stringify(wire.endOf(laneId)));
	// 它已有的流原样未动：没有 error、没有 end、订阅还是同一个——下面的检查通过再次使用这条
	// 车道来证明这一点。
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
	// 连接本身未被触碰：一条车道上的失误不得殃及其他。下一个检查通过再次使用通道来证明它活着。

	// ---------------------------------------------------------------------------------------------
	// 4. Uplink tolerance: nonsense frames are dropped, not fatal.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("nonsense uplink is dropped and logged, not fatal\n");

	wire.send({ type: "teleport", sessionId: laneId });
	wire.send({ note: "not even a frame" });
	wire.sendRaw("this is not JSON at all");
	// 活着的证据来自唯一一种只有正常工作的连接才会自己产生的载荷：心跳保持它的间隔，三次心跳
	// 意味着定时器的三轮往返熬过了那些胡话。
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

	// 同一边界的重新接上一半，也是重复 `open` 存在的理由：别的东西（这里是 run）仍持有这个
	// session，窗格离开又回来，于是第二次 `open` 落在一个仍活着的订阅上。它应答的 baseline 是
	// session *现在*的状态——`partial` 包括在内——所以窗口画出到目前为止那句话，而不是等一个
	// delta 开始画。等第一个 delta 正是 `partial` 存在的原因：它是那条运行中的消息，在回答开始
	// 之前重接上的话它诚实地一行都没有。
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
	// 帧序，整件事赖以成立的性质：baseline 到达*流内部*，delta 继续向它追加——不是第二条流，
	// 不是 end，没有东西被重放两次。
	check("the deltas kept coming after it", await until(() => laneEvents() > eventsBeforeReattach, 10_000), `${eventsBeforeReattach} events before`);

	// run 流式期间，空闲的车道必须保持安静、心跳继续到来。
	await sleep(300);
	const heartbeatsDuring = wire.connection().filter((envelope) => envelope.item?.type === "heartbeat").length;
	check("heartbeats kept arriving during the run", heartbeatsDuring > 0, String(heartbeatsDuring));
	const idleLaneFrames = wire.items(otherId).filter((message) => message.type === "event");
	check("the idle lane received no event of the other session's run", idleLaneFrames.length === 0, String(idleLaneFrames.length));

	// run 产出的每一帧事件都坐在运行中 session 自己的车道上——且不在其他任何一条上。
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
	// 变化发生在没有任何东西看着这条车道的时候：来自另一个窗口的 prompt，发在这个连接刚刚
	// 停止监听的 session 上。
	rig.transport.setResponses([fakeAssistantMessage("second answer")]);
	check("the prompt was accepted", (await prompt(rig.url, laneId, "another run, unseen")) === 202);
	check("that run settled", await settleRun(rig.url, laneId));
	// run 自己的 hold 是最后一个，所以它一落定 host 就关闭。等 reap 完成让下面的 re-open 成为
	// 一次诚实的冷开：与 reap 赛跑的订阅可能绑到一个马上要被从脚底下抽走的 host 上，断言就会
	// 变成关于那个时机的，而不是关于收敛的。
	check("the session was reaped once nothing held it", await until(() => !rig.hub.live.includes(laneId), 10_000), rig.hub.live.join(","));

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

	// 两次 run 给第一条用户消息一个续接，这正是让它成为分支点的动作。测试台的 hold 在两次 run
	// 与移动期间保住 host：holds 归零的那一刻 host 就被 reap、车道会在它下面被结束（"被监视的
	// session 走了"），那是生命周期按设计工作——hold 决定 session 活多久，这里的持有者正是
	// 测试台。
	const bench = await rig.hub.hold(laneId);
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

		// 等计数增长，然后读最新的那份：`waitFor` 从头匹配，而这条车道已经带着上面各节的
		// baseline。
		const grew = await until(() => baselinesOn(wire, laneId) > baselinesAt, 5_000);
		const changed = lastBaselineOn(wire, laneId);
		check(
			"the subscription was told — by a whole new baseline, not a difference",
			grew && baselinesOn(wire, laneId) === baselinesAt + 1,
			`${baselinesAt} -> ${baselinesOn(wire, laneId)}`,
		);
		check("and the move is inside it", changed?.session.leafId === branchEntry, JSON.stringify(changed?.session.leafId));
	}

	// 测试台的 hold 归还：随后的 reap 结束车道，这是预期的事件次序，不是车道的失败。
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
	// 什么都没说过的 session 没有文件，因此也没有行：第一条消息是把两者放下的动作。所以这里
	// 没有"之前"的时间戳可比较——run 正是创建这一行的动作，下面两个检查说的正是这件事。
	const modifiedBefore = rowsForSession()[0]?.modified;

	rig.transport.setResponses([fakeAssistantMessage("unwatched run ".repeat(20))]);
	check("the prompt was accepted", (await prompt(rig.url, unwatchedId, "run without a viewer")) === 202);
	// running:true 的行是锚点：下面的"结束"指的是在它*之后*到达的行，不是随便哪行说 false 的
	// ——run 前的那行也说 false，而且这个装置的剧本化回答带着比 prompt 更老的时间戳，它的条目
	// 永远不推进 `modified`，两行共享同一个戳。到达顺序是这里唯一诚实的"之后"。
	check("the run announced itself on its row", await until(() => rowsForSession().some((row) => row.running === true), 5_000), JSON.stringify(rowsForSession()));
	const runningIndex = rowsForSession().findIndex((row) => row.running === true);
	check("it settled", await settleRun(rig.url, unwatchedId));
	// 循环里 `submitting` 先变 false，session 才发布这个事实，所以说着 `running: false` 的行可能
	// 比读路径已经开始作答晚一拍落地。
	await until(() => rowsForSession().some((row, index) => index > runningIndex && row.running === false), 5_000);

	// 行升上去又降回来，文件的最后一条消息把它向前推——全程都在连接级座位上观察，那个 session
	// 没有打开任何逻辑流。
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
	// 9. The wait: a send reference's signal holds the state against eviction until it is answered
	//    (issue 13).
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a wait holds the state against eviction until it is answered\n");

	// send 引用守护的那个形状：一次 hold 在收下时就被释放的 run、一份已经发布到流上的结果，
	// 以及一个还没说完自己读完了的客户端。reap 的尾部到达它的驱逐时必须发现 wait 还站着
	// ——state 留下，wait 的释放才是收尾的那条边。
	const waited = await request(rig.url, "POST", "/api/sessions");
	const waitedId = (waited.payload as { sessionId: string }).sessionId;
	// 有意报告两次：重连的重放可能重复报告一个它仍持有的 wait，一个条目必须覆盖两份报告
	// ——否则下面唯一一次 `unwait` 会留下一处泄漏。
	wire.send({ type: "wait", sessionId: waitedId });
	wire.send({ type: "wait", sessionId: waitedId });
	rig.transport.setResponses([fakeAssistantMessage("waited run ".repeat(20))]);
	check("the prompt was accepted", (await prompt(rig.url, waitedId, "run under a wait")) === 202);
	check("it settled", await settleRun(rig.url, waitedId));
	check("the host was reaped", await until(() => !rig.hub.live.includes(waitedId), 10_000), rig.hub.live.join(","));
	// 时间点读取，在 reap 完成之后：尾部的驱逐尝试在 wait 门控下运行了，而 wait 站着，所以
	// state 还在这里。门面上没有人读这张表——那是 orchestrator 自己的事——所以 smoke 自己读
	// 这个 map，与其他 smoke 到 `assembleAgentStateBySession` 走的是同一条路。
	const table = rig.hub.agent as unknown as { sessions: Map<string, unknown> };
	check("but the wait kept the state in the table", table.sessions.has(waitedId), String(table.sessions.has(waitedId)));

	wire.send({ type: "unwait", sessionId: waitedId });
	wire.send({ type: "unwait", sessionId: waitedId });
	check("releasing the wait evicted it", await until(() => !table.sessions.has(waitedId), 5_000), String(table.sessions.has(waitedId)));

	// 一条随后死去的连接报告的 wait 随连接一起被放弃——一个永远不会被应答的 waiter 不得永远
	// 占着一个 state。这个 wait 完全不骑任何订阅，这也是 wait 独立于订阅表的证明：它在旁边任何
	// `open` 之前被报告，且活过流的 end。
	const dying = await connect(`${rig.url.replace("http", "ws")}/mux`);
	const mortal = await request(rig.url, "POST", "/api/sessions");
	const mortalId = (mortal.payload as { sessionId: string }).sessionId;
	dying.send({ type: "wait", sessionId: mortalId });
	rig.transport.setResponses([fakeAssistantMessage("mortal run ".repeat(20))]);
	check("the prompt was accepted", (await prompt(rig.url, mortalId, "run under a dying connection's wait")) === 202);
	check("it settled", await settleRun(rig.url, mortalId));
	check("the host was reaped under the dying connection's wait", await until(() => !rig.hub.live.includes(mortalId), 10_000), rig.hub.live.join(","));
	check("and that wait held the state too", table.sessions.has(mortalId), String(table.sessions.has(mortalId)));
	await dying.close().catch(() => {});
	check("the connection's death released its wait", await until(() => !table.sessions.has(mortalId), 5_000), String(table.sessions.has(mortalId)));

	// 容忍，与第 3、4 节给其他帧的同一种：对这个服务器不认识的 session 的 wait 被记录（代价是
	// 一行表和一次 `unwait`），而不是被拒绝——连接继续活着。帧按到达顺序处理，所以它们之后
	// 到达的一次心跳就是"两者都在缺席检查之前被处理"的确定性标记。
	wire.send({ type: "wait", sessionId: "does-not-exist-yet" });
	wire.send({ type: "unwait", sessionId: "does-not-exist-yet" });
	const heartbeatsBeforeTolerance = wire.connection().filter((envelope) => envelope.item?.type === "heartbeat").length;
	check("the tolerance wait was followed by more traffic", await until(() => wire.connection().filter((envelope) => envelope.item?.type === "heartbeat").length > heartbeatsBeforeTolerance, 5_000));
	check(
		"waits for unknown sessions are tolerated",
		wire.endOf("does-not-exist-yet").errors.length === 0 && !wire.endOf("does-not-exist-yet").ended,
		JSON.stringify(wire.endOf("does-not-exist-yet")),
	);

	// ---------------------------------------------------------------------------------------------
	// 10. Shutdown: the server lets go of its connections, and the rig closes.
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
		// 装置可能已被上面的 shutdown 检查关掉。
	}
} finally {
	process.stdout.write(failures === 0 ? "\nmux ok\n" : `\n${failures} failure(s)\n`);
	process.exitCode = failures === 0 ? 0 : 1;
}
