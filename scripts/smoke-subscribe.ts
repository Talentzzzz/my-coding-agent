// 订阅的帧面 smoke：把「一个窗口连上来之后收到了什么帧」当成唯一判据——帧的类型、顺序、次数。
// 它不读 hub 的任何内部表（没有 isWatched、没有 watchers、没有 feedMap），所以这套断言在订阅
// 实现被拆成 wire 与 session stream 前后应当一字不改地通过。
//
// 断言与装配分离：造 hub / projection / mux、造假 FrameSink、把上行帧喂进连接，全部收在
// openRig() 里；openRig 返回的 View 只提供「开、关、取消、看帧」这几个驱动动作，断言区不出现
// 任何构造调用。后续拆分只允许改 openRig。
//
// 这里不接触任何模型，无需 provider key：会话跑在剧本化 transport 上。
// 运行：node scripts/smoke-subscribe.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSessionsDir, type ModelConfig, type ServerFrame } from "@my-agent/core";
import { SessionHub } from "../packages/server/src/hub.ts";
import { createMuxServer, type FrameSink, type MuxConnection } from "../packages/server/src/mux.ts";
import { createSessionProjection } from "../packages/server/src/projection.ts";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall, type FakeTransport } from "./fake-transport.ts";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/** 轮询直到 `ready` 成立，任何检查都不猜测异步读取的时机。 */
async function until(ready: () => boolean, ms = 5_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (ready()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return ready();
}

/** 排空微任务队列加一个宏任务，已 resolve 的探针因此落定。 */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}

/** 本 smoke 的每个会话都运行在这一行上——剧本化 transport 应答它，所以活得起来。 */
const ROW: ModelConfig = {
	name: "faux",
	baseUrl: "http://127.0.0.1:1/v1",
	apiKey: "unused-by-the-scripted-transport",
	id: "faux-1",
	contextWindow: 128_000,
	maxTokens: 16_384,
};

/** 一条连接的驱动面：只有上行动作与「收到了哪些帧」。 */
interface View {
	/** 这条连接上某条流（`null` 是连接级座位）收到的帧，按到达顺序。 */
	frames(streamId: string | null): ServerFrame[];
	/** 上行 `{type:"open"}`。 */
	open(sessionId: string): void;
	/** 上行 `{type:"cancel"}`。 */
	cancel(sessionId: string): void;
	/** 断线：这条连接不再被服务器持有。 */
	closeConnection(): void;
	/** 假 sink 上累计收到的帧数，事后比较用。 */
	frameCount(): number;
}

/** 装置给出的驱动面——断言区只碰这些，不碰任何构造。 */
interface Rig {
	/** 造会话、跑一轮、读快照用；不用来断言。 */
	hub: SessionHub;
	/** 剧本化 transport：给下一轮排回答。 */
	transport: FakeTransport;
	/** 生一个会话，并做生产里 controller 那一拍：让 projection 重读它的行。 */
	birth(input: { text: string; workDirAbsPath?: string }): Promise<string>;
	/** 建一条新连接并等它收到开场帧。 */
	connect(): Promise<View>;
	/** 目录被放到一边：设置 patch，再走列表变更的广播路径。 */
	hideDirectory(path: string): Promise<void>;
	/** 目录被领回列表：与隐藏同一条路径。 */
	showDirectory(): Promise<void>;
	/** 作答一个审批：记下答案（供 settled 帧）并恢复运行。 */
	approve(sessionId: string, toolCallId: string, approved: boolean): void;
	close(): Promise<void>;
}

/**
 * 本 smoke 的唯一装配处。
 *
 * 后续四张票会替换这里的内部件（wire、session stream、hub 的合表、projection 的推法），而外面
 * 每一行断言都必须原样通过——所以任何「怎么做」都锁在这个函数里。
 */
async function openRig(): Promise<Rig> {
	const root = await mkdtemp(join(tmpdir(), "my-agent-subscribe-"));
	const storeRoot = await mkdtemp(join(tmpdir(), "my-agent-subscribe--store-"));
	setSessionsDir(storeRoot);

	const transport = createFakeTransport();
	const hub = new SessionHub({ workDirAbsPath: root, api: transport.api, modelsHome: join(root, "agent-home") });
	hub.setModelConfigs([ROW]);
	const projection = createSessionProjection(hub);
	const mux = createMuxServer(hub, projection, {});

	return {
		hub,
		transport,
		async birth(input): Promise<string> {
			const id = await hub.birth(input);
			// 生产中这由 controller 的 onCreated 触发；没有它，出生之后的会话永远进不了行表。
			await projection.refresh(id);
			return id;
		},
		async connect(): Promise<View> {
			const frames: ServerFrame[] = [];
			let closed = false;
			const sink: FrameSink = {
				send(frame) {
					frames.push(frame);
					// 恒为 true：本 smoke 不演练写侧背压，帧总是被收下。
					return true;
				},
				ping() {},
				close() {
					closed = true;
				},
				terminate() {
					closed = true;
				},
				get isClosed() {
					return closed;
				},
			};
			const connection: MuxConnection = await mux.accept(sink);
			return {
				frames: (streamId) => frames.filter((frame) => frame.streamId === streamId),
				open: (sessionId) => mux.handle(connection, JSON.stringify({ type: "open", sessionId })),
				cancel: (sessionId) => mux.handle(connection, JSON.stringify({ type: "cancel", sessionId })),
				closeConnection: () => mux.forget(connection),
				frameCount: () => frames.length,
			};
		},
		async hideDirectory(path: string): Promise<void> {
			hub.agent.applySettings({ hiddenDirectories: [path] });
			await mux.broadcastSessions();
		},
		async showDirectory(): Promise<void> {
			hub.agent.applySettings({ hiddenDirectories: [] });
			await mux.broadcastSessions();
		},
		approve(sessionId, toolCallId, approved) {
			// 与审批端点同一顺序：先记答案（settled 帧读它），再恢复运行（它会让待审批集合变空）。
			mux.rememberApproval(sessionId, toolCallId, approved);
			void hub.agent.respondApproval(sessionId, toolCallId, approved);
		},
		async close(): Promise<void> {
			mux.close();
			projection.close();
			await hub.close();
			await rm(storeRoot, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		},
	};
}

const rig = await openRig();
/** 收尾时先放行每个可能还在门口等着的运行，再做各自的清场。 */
const releases: (() => void | Promise<void>)[] = [];

/** 让会话出生并等它的第一轮落地——落地之后活半散场，会话在任何连接眼里都是冷的。 */
async function born(text: string, workDirAbsPath?: string): Promise<string> {
	rig.transport.setResponses([fakeAssistantMessage(`answered: ${text}`)]);
	const id = await rig.birth({ text, ...(workDirAbsPath === undefined ? {} : { workDirAbsPath }) });
	await until(() => !rig.hub.isLive(id));
	return id;
}

try {
	process.stdout.write("开场：先心跳，再 overview\n");
	// 客户端把先到的心跳当作「这条连接活着」，所以顺序是契约而不是巧合。
	const view = await rig.connect();
	const opening = view.frames(null).map((frame) => ("item" in frame ? frame.item.type : "?"));
	check("开场第一帧是应用心跳，第二帧是 overview", opening[0] === "heartbeat" && opening[1] === "sessions", opening.join("|"));

	process.stdout.write("活半：open 之后第一帧就是 baseline，且是在飞状态\n");
	// 一个停在 transport 门口的会话：剧本的下一步等放行，所以 running 一直为真。
	const inFlightId = await born("一个停在门口的会话");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	rig.transport.setResponses([
		async () => {
			await gate;
			return fakeAssistantMessage("放行之后的回答");
		},
	]);
	const run = rig.hub.agent.prompt(inFlightId, "门口的下一轮");
	void run;
	releases.push(release);
	await until(() => rig.hub.isLive(inFlightId) && rig.hub.agent.snapshot(inFlightId).running);
	view.open(inFlightId);
	// 活半的订阅与快照在同一个同步块里，open 返回时帧已经在 sink 上。
	const liveFirst = view.frames(inFlightId)[0];
	check(
		"第一个流帧是 baseline，且带着袋里的在飞状态",
		liveFirst !== undefined && "item" in liveFirst && liveFirst.item.type === "baseline" && liveFirst.item.session.running === true,
		JSON.stringify(liveFirst),
	);

	process.stdout.write("冷半：baseline 异步到达、恰好一次，期间的事件排在它之后\n");
	// 冷会话只存在于盘上：baseline 要读盘，读的这段时间里发布的事件不得抢到它前面。
	const coldId = await born("一个只活在盘上的会话");
	view.open(coldId);
	check("冷会话的 open 返回时还没有 baseline（读盘是异步的）", view.frames(coldId).length === 0, `${view.frames(coldId).length} frames`);
	rig.transport.setResponses([fakeAssistantMessage("读盘期间落地的回答")]);
	await rig.hub.agent.prompt(coldId, "读盘期间发出的消息");
	check("冷半的 baseline 恰好一份", await until(() => view.frames(coldId).filter((frame) => "item" in frame && frame.item.type === "baseline").length === 1), JSON.stringify(view.frames(coldId)));
	const coldFrames = view.frames(coldId);
	const coldFirst = coldFrames[0];
	const coldEvents = coldFrames.filter((frame) => "item" in frame && frame.item.type === "event");
	check(
		"第一帧是 baseline，期间发布的事件全部排在它之后",
		coldFirst !== undefined && "item" in coldFirst && coldFirst.item.type === "baseline" && coldEvents.length > 0 && coldFrames.indexOf(coldEvents[0] as ServerFrame) > 0,
		coldFrames.map((frame) => ("item" in frame ? frame.item.type : "?")).join("|"),
	);
	await settle();
	check("等够时间也没有第二份 baseline", view.frames(coldId).filter((frame) => "item" in frame && frame.item.type === "baseline").length === 1, JSON.stringify(view.frames(coldId)));

	process.stdout.write("重复 open：再送一份 baseline，不报错、不结束，原流继续可用\n");
	const baselinesBeforeDuplicate = view.frames(coldId).filter((frame) => "item" in frame && frame.item.type === "baseline").length;
	const eventsBeforeDuplicate = view.frames(coldId).filter((frame) => "item" in frame && frame.item.type === "event").length;
	view.open(coldId);
	check(
		"第二次 open 在同一流上再给一份 baseline",
		await until(() => view.frames(coldId).filter((frame) => "item" in frame && frame.item.type === "baseline").length === baselinesBeforeDuplicate + 1),
		JSON.stringify(view.frames(coldId)),
	);
	const duplicateFrames = view.frames(coldId);
	check(
		"没有 error、没有 end",
		duplicateFrames.every((frame) => !("error" in frame) && !("end" in frame)),
		JSON.stringify(duplicateFrames),
	);
	rig.transport.setResponses([fakeAssistantMessage("重复 open 之后仍然照常到达")]);
	await rig.hub.agent.prompt(coldId, "重复 open 之后再发一条");
	check(
		"原有的流继续可用：其后的事件照常到达",
		await until(() => view.frames(coldId).filter((frame) => "item" in frame && frame.item.type === "event").length > eventsBeforeDuplicate),
		JSON.stringify(view.frames(coldId)),
	);

	process.stdout.write("未知会话：先 error 再 end，连接本身不受影响\n");
	const unknownId = "no-such-session-0000";
	view.open(unknownId);
	check("未知会话等到 error 与 end", await until(() => {
		const frames = view.frames(unknownId);
		return frames.some((frame) => "error" in frame) && frames.some((frame) => "end" in frame);
	}), JSON.stringify(view.frames(unknownId)));
	const unknownFrames = view.frames(unknownId);
	const errorAt = unknownFrames.findIndex((frame) => "error" in frame);
	const endAt = unknownFrames.findIndex((frame) => "end" in frame);
	const unknownError = unknownFrames[errorAt];
	check(
		"error 带 message，且排在 end 之前",
		errorAt >= 0 && endAt > errorAt && unknownError !== undefined && "error" in unknownError && (unknownError.error?.message ?? "").length > 0,
		JSON.stringify(unknownFrames),
	);
	// 连接还活着：紧接着在同一连接上开另一个会话，它照常作答。
	const afterUnknownId = await born("未知会话之后仍然能开的会话");
	view.open(afterUnknownId);
	check(
		"随后还能正常 open 另一个会话",
		await until(() => view.frames(afterUnknownId).some((frame) => "item" in frame && frame.item.type === "baseline")),
		JSON.stringify(view.frames(afterUnknownId)),
	);

	process.stdout.write("删除：观看中的流先 end，之后该流再无帧\n");
	const removedId = await born("一个即将被删除的会话");
	view.open(removedId);
	await until(() => view.frames(removedId).some((frame) => "item" in frame && frame.item.type === "baseline"));
	rig.hub.remove(removedId);
	check("删除让该流收到 end", await until(() => view.frames(removedId).some((frame) => "end" in frame)), JSON.stringify(view.frames(removedId)));
	const removedFrames = view.frames(removedId);
	const removedEnd = removedFrames.findIndex((frame) => "end" in frame);
	check("end 是这条流上的最后一帧", removedEnd === removedFrames.length - 1, removedFrames.map((frame) => ("item" in frame ? frame.item.type : "?")).join("|"));
	await settle();
	check("此后不再有任何该 streamId 的帧", view.frames(removedId).length === removedEnd + 1, `${view.frames(removedId).length} vs ${removedEnd + 1}`);

	process.stdout.write("分支移动：同一流上再送一份指向新叶子的 baseline\n");
	const branchId = await born("一条会被挪分支的会话");
	view.open(branchId);
	await until(() => view.frames(branchId).some((frame) => "item" in frame && frame.item.type === "baseline"));
	const branchSnapshot = await rig.hub.snapshotOf(branchId);
	const branchEntryId = branchSnapshot.messageEntryIds.find((id): id is string => typeof id === "string");
	check("前置：会话里有一个 entry 可以挪到", branchEntryId !== undefined, JSON.stringify(branchSnapshot.messageEntryIds));
	const branchBaselinesBefore = view.frames(branchId).filter((frame) => "item" in frame && frame.item.type === "baseline").length;
	const newLeaf = rig.hub.agent.branchTo(branchId, branchEntryId as string, false);
	check(
		"branch 之后该流再收到一份 baseline，内容是新叶子所指向的状态",
		await until(() => {
			const baselines = view.frames(branchId).filter((frame) => "item" in frame && frame.item.type === "baseline");
			const last = baselines.at(-1);
			return baselines.length === branchBaselinesBefore + 1 && last !== undefined && "item" in last && last.item.type === "baseline" && last.item.session.leafId === newLeaf;
		}),
		JSON.stringify(view.frames(branchId)),
	);

	process.stdout.write("审批横幅：两个窗口都收到 request 与同一份 settled，别的会话收不到\n");
	// 先订阅、再让会话停在审批上——横幅是「订阅自己看到的差量」，所以读者必须在它出现之前就在。
	const approvalId = await born("一个会停在审批上的会话");
	const viewA = await rig.connect();
	const viewB = await rig.connect();
	viewA.open(approvalId);
	viewB.open(approvalId);
	await until(() => viewA.frames(approvalId).some((frame) => "item" in frame && frame.item.type === "baseline"));
	await until(() => viewB.frames(approvalId).some((frame) => "item" in frame && frame.item.type === "baseline"));
	const otherId = await born("另一个无关的会话");
	const viewC = await rig.connect();
	viewC.open(otherId);
	await until(() => viewC.frames(otherId).some((frame) => "item" in frame && frame.item.type === "baseline"));

	rig.hub.agent.applyConfig(approvalId, { approval: { read: true } });
	rig.transport.setResponses([
		fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
		fakeAssistantMessage("审批之后完成"),
	]);
	await rig.hub.agent.prompt(approvalId, "读一下 notes.txt");

	const approvalFrames = (target: View): ServerFrame[] =>
		target.frames(approvalId).filter((frame) => "item" in frame && (frame.item.type === "approval_request" || frame.item.type === "approval_settled"));
	check("两个窗口都收到 approval_request", await until(() => approvalFrames(viewA).some((frame) => "item" in frame && frame.item.type === "approval_request") && approvalFrames(viewB).some((frame) => "item" in frame && frame.item.type === "approval_request")), JSON.stringify({ a: approvalFrames(viewA), b: approvalFrames(viewB) }));
	const requestFrame = approvalFrames(viewA).find((frame) => "item" in frame && frame.item.type === "approval_request");
	const toolCallId = requestFrame !== undefined && "item" in requestFrame && requestFrame.item.type === "approval_request" ? requestFrame.item.request.toolCallId : "";
	rig.approve(approvalId, toolCallId, true);
	check(
		"作答之后两边都收到 approval_settled 且 approved: true",
		await until(() => {
			const settled = (target: View): boolean =>
				approvalFrames(target).some(
					(frame) => "item" in frame && frame.item.type === "approval_settled" && frame.item.toolCallId === toolCallId && frame.item.approved === true,
				);
			return settled(viewA) && settled(viewB);
		}),
		JSON.stringify({ a: approvalFrames(viewA), b: approvalFrames(viewB) }),
	);
	check(
		"另一个会话的窗口收不到任何审批帧",
		viewC.frames(otherId).every((frame) => !("item" in frame) || (frame.item.type !== "approval_request" && frame.item.type !== "approval_settled")),
		JSON.stringify(viewC.frames(otherId)),
	);
	// 恢复的那一轮跑完后会话离开活半，收尾时不会留下一个还在写文件的袋。
	await until(() => !rig.hub.isLive(approvalId));

	process.stdout.write("断线：此后跑一轮、再删除，假 sink 上不再出现新帧\n");
	const goneId = await born("一条断线之后还在跑的会话");
	const viewD = await rig.connect();
	viewD.open(goneId);
	await until(() => viewD.frames(goneId).some((frame) => "item" in frame && frame.item.type === "baseline"));
	const framesAtDisconnect = viewD.frameCount();
	viewD.closeConnection();
	rig.transport.setResponses([fakeAssistantMessage("断线之后仍然跑完的一轮")]);
	await rig.hub.agent.prompt(goneId, "断线之后再发一条");
	await rig.hub.remove(goneId);
	await settle();
	check("断线之后不再造帧", viewD.frameCount() === framesAtDisconnect, `${framesAtDisconnect} -> ${viewD.frameCount()}`);

	process.stdout.write("隐藏目录：新连接的 overview 不含它，会话变了也收不到它的行\n");
	// 一个独立的工作目录：放它到一边，规则由 hub 的设置回答，过滤发生在连接这一侧。
	const hiddenDir = await mkdtemp(join(tmpdir(), "my-agent-subscribe--hidden-"));
	releases.push(() => rm(hiddenDir, { recursive: true, force: true }));
	const hiddenId = await born("一个住在被放到一边的目录里的会话", hiddenDir);
	await rig.hideDirectory(hiddenDir);
	const viewE = await rig.connect();
	const overviewRows = (): ServerFrame[] => viewE.frames(null).filter((frame) => "item" in frame && frame.item.type === "sessions");
	const latestOverview = overviewRows().at(-1);
	check(
		"新连接的 overview 不含被隐藏目录的行",
		latestOverview !== undefined && "item" in latestOverview && latestOverview.item.type === "sessions" && latestOverview.item.sessions.every((row) => row.id !== hiddenId),
		JSON.stringify(latestOverview),
	);
	// 同时推动一个可见会话与隐藏会话：可见的那行到达，证明行的管道本身在跑；隐藏的那行不得到达。
	const visibleId = await born("一个住在可见目录里的会话");
	viewE.open(visibleId);
	rig.transport.setResponses([fakeAssistantMessage("可见会话的一轮")]);
	const visibleRun = rig.hub.agent.prompt(visibleId, "让可见会话跑一轮");
	rig.transport.appendResponses([fakeAssistantMessage("隐藏会话的一轮")]);
	const hiddenRun = rig.hub.agent.prompt(hiddenId, "让隐藏会话也跑一轮");
	await Promise.all([visibleRun, hiddenRun]);
	const rowsOf = (id: string): ServerFrame[] => viewE.frames(null).filter((frame) => "item" in frame && frame.item.type === "session_row" && frame.item.session.id === id);
	check("可见会话的行照常到达", await until(() => rowsOf(visibleId).length > 0), JSON.stringify(viewE.frames(null)));
	await settle();
	check("被隐藏目录里的会话变更收不到它的 session_row", rowsOf(hiddenId).length === 0, JSON.stringify(rowsOf(hiddenId)));

	process.stdout.write("整表重发：目录进出列表时，每条连接收到一整份新的 sessions 帧\n");
	const viewF = await rig.connect();
	const sessionsCount = (target: View): number => target.frames(null).filter((frame) => "item" in frame && frame.item.type === "sessions").length;
	const sessionsBefore = { e: sessionsCount(viewE), f: sessionsCount(viewF) };
	await rig.showDirectory();
	check(
		"两条连接都各收到一整份新的 sessions 帧",
		await until(() => sessionsCount(viewE) === sessionsBefore.e + 1 && sessionsCount(viewF) === sessionsBefore.f + 1),
		JSON.stringify({ e: sessionsCount(viewE), f: sessionsCount(viewF) }),
	);
	const restored = viewE.frames(null).filter((frame) => "item" in frame && frame.item.type === "sessions").at(-1);
	check(
		"它是既有的 sessions 形状，且重新含上被领回的目录的行",
		restored !== undefined && "item" in restored && restored.item.type === "sessions" && restored.item.sessions.some((row) => row.id === hiddenId),
		JSON.stringify(restored),
	);
} finally {
	for (const release of releases) await release();
	await rig.close();
}

process.stdout.write(failures === 0 ? "\nsubscribe ok\n" : `\n${failures} failure(s)\n`);
process.exitCode = failures === 0 ? 0 : 1;
