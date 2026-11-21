// 订阅的帧面 smoke：把「一个窗口连上来之后收到了什么帧」当成唯一判据——帧的类型、顺序、次数。
// 它不读 hub 的任何内部表（没有按会话的订阅表、没有全局通道），所以这套断言在订阅
// 实现被拆成 wire 与 session stream 前后应当一字不改地通过。
//
// 断言与装配分离：造 hub / mux、造假 FrameSink、把上行帧喂进连接，全部收在
// openRig() 里；openRig 返回的 View 只提供「开、关、取消、看帧」这几个驱动动作，断言区不出现
// 任何构造调用。后续拆分只允许改 openRig。
//
// 这里不接触任何模型，无需 provider key：会话跑在剧本化 transport 上。
// 运行：node scripts/smoke-subscribe.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSessionsDir, type ModelConfig } from "@my-agent/domain";
import type { ServerFrame } from "@my-agent/case/protocol";
import { SessionHub } from "../packages/server/src/hub.ts";
import { createMuxServer, type MuxConnection } from "../packages/server/src/mux.ts";
import { SessionController } from "../packages/server/src/controllers/sessions.ts";
import { sessionListeners } from "../packages/server/src/boot.ts";
import type { FrameSink } from "../packages/server/src/wire.ts";
import { SessionRows } from "../packages/web/src/rows.ts";
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
	/** 这条连接收到的全部帧，按到达顺序、不分流——删除顺序要读两条流之间的先后。 */
	sequence(): ServerFrame[];
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
	sessionHub: SessionHub;
	/** 剧本化 transport：给下一轮排回答。 */
	transport: FakeTransport;
	/** 生一个会话，并做生产里 controller 那一拍：让 hub 重读它的行。 */
	birth(input: { text: string; workDirAbsPath?: string }): Promise<string>;
	/** 建一条新连接并等它收到开场帧。 */
	connect(): Promise<View>;
	/**
	 * 删除一个会话，走生产链：`hub.remove` 让订阅者告别（流 end），controller 的 `onRemoved`
	 * 随后让 hub 丢掉这一行（`session_gone`）。
	 */
	deleteSession(sessionId: string): Promise<void>;
	/** 作答一个审批：记下答案（供 settled 帧）并恢复运行。 */
	approve(sessionId: string, toolCallId: string, approved: boolean): void;
	close(): Promise<void>;
}

/**
 * 本 smoke 的唯一装配处。
 *
 * 后续四张票会替换这里的内部件（wire、session stream、hub 的合表、行的推法），而外面
 * 每一行断言都必须原样通过——所以任何「怎么做」都锁在这个函数里。
 */
async function openRig(): Promise<Rig> {
	const root = await mkdtemp(join(tmpdir(), "my-agent-subscribe-"));
	const storeRoot = await mkdtemp(join(tmpdir(), "my-agent-subscribe--store-"));
	setSessionsDir(storeRoot);

	const transport = createFakeTransport();
	const sessionHub = new SessionHub({ workDirAbsPath: root, chatTransport: transport.chatTransport, modelsHome: join(root, "agent-home") });
	sessionHub.setModelConfigs([ROW]);
	const muxServer = createMuxServer({ sessionHub }, {});
	// 与 boot.ts 同一套接线：controller 的删除经 sessionListeners 落到 hub 的行存储上。
	const sessionController = new SessionController(sessionHub, sessionListeners({ sessionHub }));

	return {
		sessionHub,
		transport,
		async birth(input): Promise<string> {
			const id = await sessionHub.birth(input);
			// 生产中这由 controller 的 onCreated 触发；没有它，出生之后的会话永远进不了行表。
			await sessionHub.refreshRow(id);
			return id;
		},
		async connect(): Promise<View> {
			const frames: ServerFrame[] = [];
			let closed = false;
			const frameSink: FrameSink = {
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
			const muxConnection: MuxConnection = await muxServer.accept(frameSink);
			return {
				frames: (streamId) => frames.filter((frame) => frame.streamId === streamId),
				sequence: () => [...frames],
				open: (sessionId) => muxServer.handle(muxConnection, JSON.stringify({ type: "open", sessionId })),
				cancel: (sessionId) => muxServer.handle(muxConnection, JSON.stringify({ type: "cancel", sessionId })),
				closeConnection: () => muxServer.forget(muxConnection),
				frameCount: () => frames.length,
			};
		},
		async deleteSession(sessionId: string): Promise<void> {
			await sessionController.remove(sessionId);
		},
		approve(sessionId, toolCallId, approved) {
			// 与审批端点同一顺序：恢复运行（它会让待审批集合变空，settled 帧与结果事件随之而来）。
			void sessionHub.agent.respondApproval(sessionId, toolCallId, approved);
		},
		async close(): Promise<void> {
			muxServer.close();
			await sessionHub.close();
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
	await until(() => !rig.sessionHub.isLive(id));
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
	const run = rig.sessionHub.agent.prompt(inFlightId, "门口的下一轮");
	void run;
	releases.push(release);
	await until(() => rig.sessionHub.isLive(inFlightId) && rig.sessionHub.agent.snapshot(inFlightId).running);
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
	await rig.sessionHub.agent.prompt(coldId, "读盘期间发出的消息");
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
	await rig.sessionHub.agent.prompt(coldId, "重复 open 之后再发一条");
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
	await rig.deleteSession(removedId);
	check("删除让该流收到 end", await until(() => view.frames(removedId).some((frame) => "end" in frame)), JSON.stringify(view.frames(removedId)));
	const removedFrames = view.frames(removedId);
	const removedEnd = removedFrames.findIndex((frame) => "end" in frame);
	check("end 是这条流上的最后一帧", removedEnd === removedFrames.length - 1, removedFrames.map((frame) => ("item" in frame ? frame.item.type : "?")).join("|"));
	await settle();
	check("此后不再有任何该 streamId 的帧", view.frames(removedId).length === removedEnd + 1, `${view.frames(removedId).length} vs ${removedEnd + 1}`);

	process.stdout.write("删除顺序：流先 end、行后 session_gone\n");
	// 生产链在同一次调用里走完两拍：hub.remove 同步让订阅者告别（流 end），controller 的 onRemoved
	// 随后才让行消失。先后因此从帧的到达顺序读：end 必须先于 session_gone——反过来就是窗口先丢掉行、
	// 再收到一条来自已不存在会话的帧。
	const orderedId = await born("一条用来验证删除顺序的会话");
	const viewG = await rig.connect();
	viewG.open(orderedId);
	await until(() => viewG.frames(orderedId).some((frame) => "item" in frame && frame.item.type === "baseline"));
	const goneFramesOf = (target: View): ServerFrame[] =>
		target.frames(null).filter((frame) => "item" in frame && frame.item.type === "session_gone" && frame.item.sessionId === orderedId);
	await rig.deleteSession(orderedId);
	const orderedFrames = viewG.sequence();
	const orderEndAt = orderedFrames.findIndex((frame) => frame.streamId === orderedId && "end" in frame);
	const orderGoneAt = orderedFrames.findIndex((frame) => "item" in frame && frame.item.type === "session_gone" && frame.item.sessionId === orderedId);
	check("该流先 end，随后的 session_gone 才到", orderEndAt >= 0 && orderGoneAt > orderEndAt, JSON.stringify({ endAt: orderEndAt, goneAt: orderGoneAt }));
	check("行随后以 session_gone 消失", await until(() => goneFramesOf(viewG).length === 1), JSON.stringify(viewG.frames(null)));

	process.stdout.write("分支移动：同一流上再送一份指向新叶子的 baseline\n");
	const branchId = await born("一条会被挪分支的会话");
	view.open(branchId);
	await until(() => view.frames(branchId).some((frame) => "item" in frame && frame.item.type === "baseline"));
	const branchSnapshot = await rig.sessionHub.snapshotOf(branchId);
	const branchEntryId = branchSnapshot.messageEntryIds.find((id): id is string => typeof id === "string");
	check("前置：会话里有一个 entry 可以挪到", branchEntryId !== undefined, JSON.stringify(branchSnapshot.messageEntryIds));
	const branchBaselinesBefore = view.frames(branchId).filter((frame) => "item" in frame && frame.item.type === "baseline").length;
	const newLeaf = rig.sessionHub.agent.branchTo(branchId, branchEntryId as string, false);
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

	rig.sessionHub.agent.applyConfig(approvalId, { approval: { read: true } });
	rig.transport.setResponses([
		fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
		fakeAssistantMessage("审批之后完成"),
	]);
	await rig.sessionHub.agent.prompt(approvalId, "读一下 notes.txt");

	const approvalFrames = (target: View): ServerFrame[] =>
		target.frames(approvalId).filter((frame) => "item" in frame && (frame.item.type === "approval_request" || frame.item.type === "approval_settled"));
	check("两个窗口都收到 approval_request", await until(() => approvalFrames(viewA).some((frame) => "item" in frame && frame.item.type === "approval_request") && approvalFrames(viewB).some((frame) => "item" in frame && frame.item.type === "approval_request")), JSON.stringify({ a: approvalFrames(viewA), b: approvalFrames(viewB) }));
	const requestFrame = approvalFrames(viewA).find((frame) => "item" in frame && frame.item.type === "approval_request");
	const toolCallId = requestFrame !== undefined && "item" in requestFrame && requestFrame.item.type === "approval_request" ? requestFrame.item.request.toolCallId : "";
	rig.approve(approvalId, toolCallId, true);
	check(
		"作答之后两边都收到 approval_settled，且各自都看到恢复运行关闭这个调用的执行结束事件",
		await until(() => {
			const settled = (target: View): boolean =>
				approvalFrames(target).some(
					(frame) => "item" in frame && frame.item.type === "approval_settled" && frame.item.toolCallId === toolCallId,
				);
			// verdict 不在 settled 帧上：结果由那次关闭自己的执行事件说——grant 是恢复运行重发
			// 调用的执行，它的 tool_execution_end 就是两边共同听到的那句"批准了、跑完了"。
			const ran = (target: View): boolean =>
				target.frames(approvalId).some(
					(frame) =>
						"item" in frame &&
						frame.item.type === "event" &&
						frame.item.event.type === "tool_execution_end" &&
						frame.item.event.toolCallId === toolCallId,
				);
			return settled(viewA) && settled(viewB) && ran(viewA) && ran(viewB);
		}),
		JSON.stringify({ a: approvalFrames(viewA), b: approvalFrames(viewB) }),
	);
	check(
		"另一个会话的窗口收不到任何审批帧",
		viewC.frames(otherId).every((frame) => !("item" in frame) || (frame.item.type !== "approval_request" && frame.item.type !== "approval_settled")),
		JSON.stringify(viewC.frames(otherId)),
	);
	// 恢复的那一轮跑完后会话离开活半，收尾时不会留下一个还在写文件的袋。
	await until(() => !rig.sessionHub.isLive(approvalId));

	process.stdout.write("断线：此后跑一轮、再删除，假 sink 上不再出现新帧\n");
	const goneId = await born("一条断线之后还在跑的会话");
	const viewD = await rig.connect();
	viewD.open(goneId);
	await until(() => viewD.frames(goneId).some((frame) => "item" in frame && frame.item.type === "baseline"));
	const framesAtDisconnect = viewD.frameCount();
	viewD.closeConnection();
	rig.transport.setResponses([fakeAssistantMessage("断线之后仍然跑完的一轮")]);
	await rig.sessionHub.agent.prompt(goneId, "断线之后再发一条");
	await rig.deleteSession(goneId);
	await settle();
	check("断线之后不再造帧", viewD.frameCount() === framesAtDisconnect, `${framesAtDisconnect} -> ${viewD.frameCount()}`);

	// 目录的隐藏/领回随 UI 簇迁往客户端存储（ADR-0029）：服务端不再按设置过滤 overview，也不再
	// 广播整表重发——两个场景随之退场。这里保留的最后一句话记录那条契约的归宿。
	process.stdout.write("目录视图已归客户端：overview 不再按服务端设置过滤\n");
} finally {
	for (const release of releases) await release();
	await rig.close();
}

process.stdout.write(failures === 0 ? "\nsubscribe ok\n" : `\n${failures} failure(s)\n`);
process.exitCode = failures === 0 ? 0 : 1;
