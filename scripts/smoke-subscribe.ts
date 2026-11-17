// hub 级订阅 smoke：把 no-gap 的守约检查直接架在 SessionHub 的公开面上——不接 WebSocket、
// 不接 mux，只构造 hub 加一剧本化 transport。它证明的是机制本身：注册与快照原子、baseline
// 恰好一次、冷半的异步与调用方扣帧、失败恰一次、删除与收摊的告别、重发不注册。
// 这里不接触任何模型，无需 provider key。
// 运行：node scripts/smoke-subscribe.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	setSessionsDir,
	UnknownSessionError,
	type ModelConfig,
	type SessionSnapshot,
} from "@my-agent/core";
import { SessionHub, type SessionFeeds } from "../packages/server/src/hub.ts";
import { createFakeTransport, fakeAssistantMessage } from "./fake-transport.ts";

const root = await mkdtemp(join(tmpdir(), "my-agent-subscribe-"));
const storeRoot = await mkdtemp(join(tmpdir(), "my-agent-subscribe--store-"));
setSessionsDir(storeRoot);
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

/**
 * 本 smoke 的每个会话都运行在这一行上。
 *
 * hub 从用户键入的 store 读行，剧本化 transport 应答它——这正是无需 provider key 就能驱动一个
 * 活会话的原因。
 */
const ROW: ModelConfig = {
	name: "faux",
	baseUrl: "http://127.0.0.1:1/v1",
	apiKey: "unused-by-the-scripted-transport",
	id: "faux-1",
	contextWindow: 128_000,
	maxTokens: 16_384,
};

const fake = createFakeTransport();
/** 本 smoke 开过的每个 hub，收尾时一并收摊。 */
const hubs: SessionHub[] = [];
function newHub(): SessionHub {
	const hub = new SessionHub({ workDirAbsPath: root, api: fake.api, modelsHome: join(root, "agent-home") });
	hub.setModelConfigs([ROW]);
	hubs.push(hub);
	return hub;
}
/** 每个在飞运行的放行口：收尾时先放行再收摊，否则 closeAll 等一个永不落地的 transport。 */
const releases: (() => void)[] = [];

const hub = newHub();
/** 第二个 hub：它的编排层表里空无一物，所以对它而言每个会话都是冷的——冷半的家。 */
const coldHub = newHub();

/** 让会话出生并等它的第一轮落地——落地之后活半散场，会话在任何 hub 里都是冷的。 */
async function born(target: SessionHub, text: string): Promise<string> {
	fake.setResponses([fakeAssistantMessage(`answered: ${text}`)]);
	const id = await target.birth({ text });
	if (!(await until(() => !target.isLive(id)))) throw new Error(`the birth run of ${id} never settled`);
	return id;
}

/** 让会话有一个停在 transport 门口的活半：剧本的下一步等着被放行，所以 running 一直为真。 */
async function inFlight(target: SessionHub): Promise<{ id: string; release: () => void; run: Promise<void> }> {
	const id = await born(target, "born before the in-flight turn");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	fake.setResponses([
		async () => {
			await gate;
			return fakeAssistantMessage("the answer lands after the subscription");
		},
	]);
	const run = target.agent.prompt(id, "the in-flight turn");
	if (!(await until(() => target.isLive(id) && target.agent.snapshot(id).running))) {
		throw new Error("the run never reached the transport");
	}
	releases.push(release);
	return { id, release, run };
}

try {
	process.stdout.write("live half: registration and snapshot are one atomic block\n");
	// 活半的会话有一个停在 transport 门口的运行。subscribe 必须在返回的同一拍交出 feeds，并在
	// 返回之前同步交出袋里的在飞快照——中间没有 await，所以没有事件落得进缝隙。
	const live = await inFlight(hub);
	const liveOrder: string[] = [];
	let liveFeeds: SessionFeeds | undefined;
	let liveFeedsCalls = 0;
	let liveBaselines = 0;
	let liveSnapshot: SessionSnapshot | undefined;
	const stopLive = hub.subscribe(
		live.id,
		(feeds) => {
			liveFeedsCalls += 1;
			liveFeeds = feeds;
			if (feeds === undefined) return;
			feeds.onEvent((event) => liveOrder.push(`event:${event.type}`));
		},
		{
			onBaseline: (snapshot) => {
				liveBaselines += 1;
				liveSnapshot = snapshot;
				liveOrder.push("baseline");
			},
			onError: () => liveOrder.push("error"),
		},
	);
	check("the watcher was already called with feeds when subscribe returned", liveFeedsCalls === 1 && liveFeeds !== undefined, `${liveFeedsCalls} calls`);
	check("onBaseline arrived before subscribe returned", liveBaselines === 1, `${liveBaselines} baselines`);
	check(
		"and the baseline is the run in flight, not the last landed state",
		liveSnapshot?.id === live.id && liveSnapshot.running === true,
		JSON.stringify({ id: liveSnapshot?.id, running: liveSnapshot?.running }),
	);
	check("registration is what isWatched reports", hub.isWatched(live.id));

	// 注册后立刻同步发布一个事件：subscribe 已返回，baseline 已在手，所以它只能排在 baseline 之后。
	void hub.agent.prompt(live.id, "queued in the same beat as the subscription returned");
	check(
		"an event published right after the return reaches the feed behind the baseline",
		liveOrder.join("|") === "baseline|event:queue_update",
		liveOrder.join("|"),
	);

	process.stdout.write("rebaseline live: the same block at a second delivery time\n");
	// 重发不重新订阅：同一个 sink 契约，但 watcher 集合一个不多一个不少，而且交回的仍是袋里的
	// 在飞状态——盘上那次落定说不了 running 为真。
	const watchedBefore = hub.isWatched(live.id);
	let resendBaselines = 0;
	let resendSnapshot: SessionSnapshot | undefined;
	let resendErrors = 0;
	hub.rebaseline(live.id, {
		onBaseline: (snapshot) => {
			resendBaselines += 1;
			resendSnapshot = snapshot;
		},
		onError: () => {
			resendErrors += 1;
		},
	});
	check("rebaseline hands a live baseline before it returns", resendBaselines === 1, `${resendBaselines} baselines`);
	check(
		"and it is the bag's in-flight state",
		resendSnapshot?.id === live.id && resendSnapshot.running === true && resendErrors === 0,
		JSON.stringify({ id: resendSnapshot?.id, running: resendSnapshot?.running, errors: resendErrors }),
	);
	const diskView = await coldHub.snapshotOf(live.id);
	check(
		"while a disk read of the same session says no run is in flight",
		diskView.running === false && diskView.partial === undefined,
		JSON.stringify({ running: diskView.running, partial: diskView.partial }),
	);
	check("rebaseline registers nothing: the watcher set is unchanged", hub.isWatched(live.id) === watchedBefore);

	// 放行在飞的那一轮，以及注册后排队的那一条；两者都落地后会话回到冷态。
	fake.appendResponses([fakeAssistantMessage("the queued turn landed")]);
	live.release();
	await live.run;
	check("the in-flight run lands", await until(() => !hub.isLive(live.id)));
	stopLive();
	check("and letting go is visible to isWatched", !hub.isWatched(live.id));

	process.stdout.write("cold half: one asynchronous baseline, and the caller holds the gap\n");
	// 冷会话只存在于盘上：本 hub 跑过它，于是对第二个 hub 的编排层表而言它是冷的。它的事件流在
	// 注册的同一拍就通了，而 baseline 要读盘——读取期间发布的事件经调用方扣帧，读完了才按序冲刷。
	const coldId = await born(hub, "a conversation only the store has seen");
	const coldOrder: string[] = [];
	const heldDuringRead: string[] = [];
	let coldDelivered = false;
	let coldBaselines = 0;
	let coldErrors = 0;
	let coldFeedsCalls = 0;
	let coldEventsSeen = 0;
	let coldSnapshot: SessionSnapshot | undefined;
	const stopCold = coldHub.subscribe(
		coldId,
		(feeds) => {
			coldFeedsCalls += 1;
			if (feeds === undefined) return;
			feeds.onEvent((event) => {
				coldEventsSeen += 1;
				const label = `event:${event.type}`;
				// 调用方的职责：baseline 之前到的帧先扣在手里，baseline 到了再按序冲刷。
				if (coldDelivered) coldOrder.push(label);
				else heldDuringRead.push(label);
			});
		},
		{
			onBaseline: (snapshot) => {
				coldBaselines += 1;
				coldSnapshot = snapshot;
				coldDelivered = true;
				coldOrder.push("baseline");
				for (const label of heldDuringRead) coldOrder.push(label);
			},
			onError: () => {
				coldErrors += 1;
			},
		},
	);
	check("the watcher is called with feeds for a cold session too", coldFeedsCalls === 1, `${coldFeedsCalls} calls`);
	check("and nothing is delivered yet when subscribe returns: the read is asynchronous", coldBaselines === 0, `${coldBaselines} baselines`);
	// 读盘在飞的那一拍发布一条消息：它的 entry_appended 是同步发出去的，必然早于冷读返回。
	fake.setResponses([fakeAssistantMessage("published while the read was in flight")]);
	const coldRun = coldHub.agent.prompt(coldId, "published while the read was in flight");
	check("an event really landed while the read was in flight", await until(() => heldDuringRead.length > 0), `${heldDuringRead.length} held`);
	await coldRun;
	check("onBaseline arrives exactly once", await until(() => coldBaselines === 1), `${coldBaselines} baselines`);
	await settle();
	check("and never a second time", coldBaselines === 1, `${coldBaselines} baselines`);
	check("the caller's backlog is flushed behind the baseline", coldOrder[0] === "baseline", coldOrder.join("|"));
	check(
		"with the held events in arrival order after it",
		coldOrder.slice(1, 1 + heldDuringRead.length).join("|") === heldDuringRead.join("|"),
		`${coldOrder.join("|")} vs ${heldDuringRead.join("|")}`,
	);
	check(
		"and nothing was dropped or written twice by the flush",
		coldOrder.length === 1 + coldEventsSeen,
		`${coldOrder.length} written vs ${coldEventsSeen} seen`,
	);
	// baseline 读的是发布之前的状态：那条消息只经事件到达，正是「先状态、后变更」的样子。
	check(
		"the baseline predates the message published while it was being read",
		coldSnapshot !== undefined && !JSON.stringify(coldSnapshot.messages).includes("published while the read was in flight"),
		JSON.stringify(coldSnapshot?.messages.at(-1)),
	);
	check("and no error rode along", coldErrors === 0, `${coldErrors} errors`);
	stopCold();
	check("letting go of a cold subscription is visible to isWatched", !coldHub.isWatched(coldId));
	check("the run that raced the read lands", await until(() => !coldHub.isLive(coldId)));

	process.stdout.write("rebaseline cold: exactly once, and no watcher is left behind\n");
	const watchedBeforeResend = coldHub.isWatched(coldId);
	let coldResendBaselines = 0;
	let coldResendErrors = 0;
	coldHub.rebaseline(coldId, {
		onBaseline: () => {
			coldResendBaselines += 1;
		},
		onError: () => {
			coldResendErrors += 1;
		},
	});
	check("a cold rebaseline is asynchronous", coldResendBaselines === 0, `${coldResendBaselines} baselines`);
	check(
		"and leaves the watcher set exactly as it was",
		coldHub.isWatched(coldId) === watchedBeforeResend && watchedBeforeResend === false,
		String(coldHub.isWatched(coldId)),
	);
	check("it delivers exactly once", await until(() => coldResendBaselines === 1), `${coldResendBaselines} baselines`);
	await settle();
	check("and never twice, with no error", coldResendBaselines === 1 && coldResendErrors === 0, `${coldResendBaselines} baselines, ${coldResendErrors} errors`);
	check("still no watcher afterwards: a resend does not register", !coldHub.isWatched(coldId));

	process.stdout.write("failure: exactly one onError, and no baseline on any sink\n");
	// 不存在的 id：冷读取以 UnknownSessionError 拒绝，sink 收到恰好一次 onError 与零次 baseline。
	const unknownId = "no-such-session-0000";
	let unknownFeedsCalls = 0;
	let unknownBaselines = 0;
	const unknownErrors: unknown[] = [];
	coldHub.subscribe(
		unknownId,
		() => {
			unknownFeedsCalls += 1;
		},
		{
			onBaseline: () => {
				unknownBaselines += 1;
			},
			onError: (error) => {
				unknownErrors.push(error);
			},
		},
	);
	check("the watcher is still handed feeds for an id nothing names", unknownFeedsCalls === 1, `${unknownFeedsCalls} calls`);
	check("an unknown id answers onError exactly once", await until(() => unknownErrors.length === 1), `${unknownErrors.length} errors`);
	await settle();
	check("onError names the id as unknown", unknownErrors[0] instanceof UnknownSessionError, String(unknownErrors[0]));
	check("and onBaseline is never called", unknownBaselines === 0, `${unknownBaselines} baselines`);
	check("the watcher hears nothing after the failure", unknownFeedsCalls === 1, `${unknownFeedsCalls} calls`);

	// 一个读得进却读不完的配对：手写残缺快照，与 smoke-sessions 里 v4 遗物的构造同一风格。
	const brokenId = "2026-01-01T00-00-00-000Z_broken";
	await writeFile(
		join(storeRoot, `${brokenId}.jsonl`),
		`${JSON.stringify({ type: "message", id: "br-u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "a conversation with a broken snapshot" }] } })}\n`,
		"utf8",
	);
	await writeFile(join(storeRoot, `${brokenId}.json`), "{ this is not a snapshot\n", "utf8");
	let brokenFeedsCalls = 0;
	let brokenBaselines = 0;
	const brokenErrors: unknown[] = [];
	coldHub.subscribe(
		brokenId,
		() => {
			brokenFeedsCalls += 1;
		},
		{
			onBaseline: () => {
				brokenBaselines += 1;
			},
			onError: (error) => {
				brokenErrors.push(error);
			},
		},
	);
	check("a pair that cannot be read answers onError exactly once", await until(() => brokenErrors.length === 1), `${brokenErrors.length} errors`);
	await settle();
	check("the read failure is not a missing id", (brokenErrors[0] instanceof UnknownSessionError) === false, String(brokenErrors[0]));
	check("and never a baseline", brokenBaselines === 0, `${brokenBaselines} baselines`);
	check("the watcher hears nothing after the read failure", brokenFeedsCalls === 1, `${brokenFeedsCalls} calls`);

	process.stdout.write("remove and close: the goodbye, and letting go is terminal\n");
	// 退订幂等：第二次调用不抛，也不动同一个 id 上的另一个观看者。
	const quiet = await inFlight(hub);
	let quietEvents = 0;
	const stopFirst = hub.subscribe(quiet.id, () => {}, { onBaseline: () => {}, onError: () => {} });
	const stopSecond = hub.subscribe(
		quiet.id,
		(feeds) => {
			if (feeds !== undefined) feeds.onEvent(() => (quietEvents += 1));
		},
		{ onBaseline: () => {}, onError: () => {} },
	);
	stopFirst();
	stopFirst();
	check("unsubscribing twice neither throws nor disturbs the other watcher", hub.isWatched(quiet.id), String(hub.isWatched(quiet.id)));
	void hub.agent.prompt(quiet.id, "still heard by the second watcher");
	check("and the other watcher still hears the feed", await until(() => quietEvents > 0), `${quietEvents} events`);
	stopSecond();
	check("the last let-go clears the id", !hub.isWatched(quiet.id));
	fake.appendResponses([fakeAssistantMessage("the second watcher's turn landed")]);
	quiet.release();
	await quiet.run;
	await until(() => !hub.isLive(quiet.id));

	// 删除：观看者收到 `undefined` 作为告别，这是 mux 发 endStream 的那一拍。
	const removedId = await born(hub, "a conversation about to be removed");
	let removedGoodbye = 0;
	let removedBaselines = 0;
	const stopRemoved = hub.subscribe(
		removedId,
		(feeds) => {
			if (feeds === undefined) removedGoodbye += 1;
		},
		{ onBaseline: () => (removedBaselines += 1), onError: () => {} },
	);
	check("the removal test starts from a delivered cold baseline", await until(() => removedBaselines === 1), `${removedBaselines} baselines`);
	hub.remove(removedId);
	check("removing a watched session says goodbye with undefined", removedGoodbye === 1, `${removedGoodbye} goodbyes`);
	stopRemoved();

	// 冷读盘进行中退订：读完之后没有任何交付（成功与失败两条都拦得住）。
	const cancelledId = await born(hub, "a conversation whose read is cancelled");
	let cancelledBaselines = 0;
	let cancelledErrors = 0;
	const stopCancelled = coldHub.subscribe(cancelledId, () => {}, {
		onBaseline: () => (cancelledBaselines += 1),
		onError: () => (cancelledErrors += 1),
	});
	stopCancelled();
	await settle();
	check("unsubscribing during a cold read ends the delivery", cancelledBaselines === 0 && cancelledErrors === 0, `${cancelledBaselines} baselines, ${cancelledErrors} errors`);

	const brokenTwiceId = "2026-01-01T00-00-01-000Z_broken-again";
	await writeFile(join(storeRoot, `${brokenTwiceId}.jsonl`), `${JSON.stringify({ type: "message", id: "b2-u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "another broken pair" }] } })}\n`, "utf8");
	await writeFile(join(storeRoot, `${brokenTwiceId}.json`), "[]\n", "utf8");
	let brokenTwiceErrors = 0;
	let brokenTwiceBaselines = 0;
	const stopBrokenTwice = coldHub.subscribe(brokenTwiceId, () => {}, {
		onBaseline: () => (brokenTwiceBaselines += 1),
		onError: () => (brokenTwiceErrors += 1),
	});
	stopBrokenTwice();
	await settle();
	check("and so does the failure of a read cancelled in flight", brokenTwiceErrors === 0 && brokenTwiceBaselines === 0, `${brokenTwiceErrors} errors, ${brokenTwiceBaselines} baselines`);

	// 收摊：进程退出前的告别与删除同形，并且观看表随之清空。
	const closedId = await born(hub, "a conversation that outlives nothing");
	let closedGoodbye = 0;
	let closedBaselines = 0;
	hub.subscribe(
		closedId,
		(feeds) => {
			if (feeds === undefined) closedGoodbye += 1;
		},
		{ onBaseline: () => (closedBaselines += 1), onError: () => {} },
	);
	check("the closing test starts from a delivered cold baseline", await until(() => closedBaselines === 1), `${closedBaselines} baselines`);
	await hub.close();
	check("closing the hub says goodbye to every watcher", closedGoodbye === 1, `${closedGoodbye} goodbyes`);
	check("and the watcher table is empty afterwards", !hub.isWatched(closedId));
} finally {
	// 放行每个可能还在门口等着的运行，再收摊：否则 closeAll 会等一个永不落地的 transport。
	for (const release of releases) release();
	for (const open of hubs) {
		try {
			await open.close();
		} catch {
			// 收尾不掩盖正文里的失败。
		}
	}
	// session 住在 agent home 之下、按工作目录路径作键，所以只删临时目录不够：没有这一步，
	// 每次运行都会留下一个孤儿目录。
	await rm(storeRoot, { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nsubscribe ok\n" : `\n${failures} failure(s)\n`);
process.exitCode = failures === 0 ? 0 : 1;
