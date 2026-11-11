// Projection smoke test：证明侧栏行存储无需任何人在看就能回答"每个 session 正在做什么"，
// 一行只有在关于它的东西变化时才移动，停在门口的 session 的冷行从快照标记上点亮（没有 host、
// 没有 replay），以及新的信封类型描述了一条复用连接携带的帧。
// 这里不接触任何模型，无需 provider key。
// 运行：node scripts/smoke-projection.ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionManager,
	sessionMetaPath,
	setSessionsDir,
	type Agent,
	type ClientFrame,
	type ConnectionItem,
	type ServerFrame,
	type ServerMessage,
	type SessionRow,
	type Session,
	type SessionMeta,
	type ModelConfig,
} from "@my-agent/core";
import { SessionHub } from "../packages/server/src/hub.ts";
import { createSessionProjection } from "../packages/server/src/projection.ts";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall } from "./fake-transport.ts";

const root = await mkdtemp(join(tmpdir(), "my-agent-projection-"));
const storeRoot = await mkdtemp(join(tmpdir(), "my-agent-projection--store-"));
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

/**
 * session 被持有的 bag，从 orchestrator 自己的私有表里探出来。
 *
 * 门面按 id 以纯数据作答——state 对象不是它的可给之物——所以本 smoke 对 transcript 进行的
 * 唯一一处测试专用手术（leaf 重置）要与其他 smoke 的身份断言一样，经由 orchestrator 持有的
 * 那张表到达 bag。
 */
function heldBagOf(agent: Agent, id: string): Session {
	// transcript 是文件，不是字段（ADR-0019）：下面的手术需要一个 bag，于是它打开自己的 replay，
	// 它做的写入也像任何其他写入一样是一次对 log 的写。
	return agent.sessionManager.open(id);
}

/** 排空微任务队列加一个宏任务，已 resolve 的探针因此落定。 */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * 本 smoke 里每个 session 都运行的那一行模型。
 *
 * hub 从用户键入的 store 读行，所以一行就够——而且剧本化 transport 会应答它，这正是无需
 * provider key 就能驱动一个活 session 的行的原因。
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
const hub = new SessionHub({ workDirAbsPath: root, api: fake.api, modelsHome: join(root, "agent-home") });
/** 进程唯一的 orchestrator：本 smoke 驱动的每个 session 都按 id 经由它。 */
const agent = hub.agent;
hub.setModelConfigs([ROW]);

try {
	process.stdout.write("a session that exists before anything asks stays out of the store until it speaks\n");
	const first = await hub.newSession();
	hub.release(await hub.hold(first));
	const projection = createSessionProjection(hub);

	// 从此以后每一处行变化，按监听器看到的样子。
	const seen: SessionRow[] = [];
	const stopListening = projection.onRow((row) => seen.push(row));

	// store 与本机其他每次运行共享，所以本 smoke 从不假设自己是唯一存在的 session——它只问
	// 自己创建的那些。在 seed→fill 生命周期下，无人开口的 session 没有文件（ADR-0006 §3），
	// 没有文件就没有行：侧栏列出的是对话，不是意图。
	/** 断言一个 session 没有行，detail 是找到的那一行（总是 undefined）。 */
	const checkAbsent = async (label: string, id: string): Promise<void> => {
		const row = await projection.row(id);
		check(label, row === undefined, String(row));
	};
	const seeded = await projection.row(first);
	check("an unspoken session has no row", seeded === undefined, String(seeded));
	const groupsBefore = await projection.groups();
	check(
		"and no group names its directory yet",
		groupsBefore.every((group) => group.workDirAbsPath !== root),
		JSON.stringify(groupsBefore.map((group) => group.workDirAbsPath)),
	);

	process.stdout.write("the first message is what puts the session in the store\n");
	const spokenHost = await hub.hold(first);
	fake.setResponses([fakeAssistantMessage("a first answer")]);
	await hub.agent.prompt(first, "the conversation starts here");
	check("the row arrived with the run", await until(() => seen.some((row) => row.id === first)));
	hub.release(spokenHost);
	const spokenRow = await projection.row(first);
	check("a spoken session has a row", spokenRow !== undefined, String(spokenRow));
	check("with the working directory as its workDirAbsPath", spokenRow?.workDirAbsPath === root, spokenRow?.workDirAbsPath);
	check("a row carries modified, not only createdAt", typeof spokenRow?.modified === "number" && spokenRow.modified > 0, String(spokenRow?.modified));
	check("and the title is the message the branch starts with", spokenRow?.title === "the conversation starts here", spokenRow?.title);

	process.stdout.write("one scan, however many callers\n");
	// 在计数发布之前让上面 hold 的 reap 落地：它会报告它失去的 session，那会构建这个 projection
	// 还没见过的行，那是一次真实的行出现而不是一次行的移动。
	await settle();
	const quiet = seen.length;
	await settle();
	check("a row that did not move is not published", seen.length === quiet, `${seen.length - quiet} extra`);
	const [rows, groups] = await Promise.all([projection.rows(), projection.groups()]);
	const again = await projection.rows();
	check("both callers see the same rows", JSON.stringify(rows) === JSON.stringify(again));
	check("the rows are the ones the seed found", rows.some((row) => row.id === first));
	const mine = groups.find((group) => group.workDirAbsPath === root);
	check("this directory's group holds this session's row", mine?.sessions.some((row) => row.id === first) === true, JSON.stringify(mine?.workDirAbsPath));
	check(
		"a group is ordered by activity, newest first",
		(mine?.sessions ?? []).every((row, index, all) => index === 0 || (all[index - 1]?.modified ?? 0) >= row.modified),
		JSON.stringify(mine?.sessions.map((row) => row.modified)),
	);
	check(
		"and every row appears in exactly one group",
		groups.reduce((total, group) => total + group.sessions.length, 0) === rows.length,
		`${groups.reduce((total, group) => total + group.sessions.length, 0)} vs ${rows.length}`,
	);

	process.stdout.write("a session created with nobody watching stays out of the store\n");
	const second = await hub.newSession();
	await settle();
	await checkAbsent("a created session reaches no row without a host", second);

	process.stdout.write("an idle host on an unspoken session builds no row either\n");
	const host = await hub.hold(second);
	await settle();
	await checkAbsent("an idle host leaves the store alone", second);
	check("and published nothing", !seen.some((row) => row.id === second), JSON.stringify(seen.map((row) => row.id)));

	process.stdout.write("a run moves the row even though nothing is watching it\n");
	// store 的全部意义：一个 session 运行，它的行在没有任何订阅者的地方说着这件事。之前只有
	// *内容*流会携带这件事，而这里没有订阅者。第一条消息写文件，所以这次 run 也是这一行的
	// 诞生——行随 run 进入 store，而这次之后的 run 移动的才是一行已存在的东西。
	const beforeRun = seen.length;
	fake.setResponses([fakeAssistantMessage("answered")]);
	const run = hub.agent.prompt(host.id, "now the row has something to say");
	check("the row arrived during the run", await until(() => seen.some((row) => row.id === second)));
	await run;
	const landed = await projection.row(second);
	check("and the run ended idle", landed?.running === false && landed.pending === 0, JSON.stringify(landed));
	check("the title is read from the branch, not the file", landed?.title === "now the row has something to say", landed?.title);

	// 行已在 store 里，下一次 run 就是 store 的重头戏：在途时 `running`，落定时以 idle 重新发布，
	// 全程没有任何订阅者。
	const beforeSecondRun = seen.length;
	fake.setResponses([fakeAssistantMessage("answered again")]);
	const secondRun = hub.agent.prompt(host.id, "the row is watching itself now");
	check("the row said running while the run was in flight", await until(() => seen.some((row) => row.id === second && row.running === true)));
	await secondRun;
	check("and the second run ended", (await projection.row(second))?.running === false, JSON.stringify(await projection.row(second)));
	check("the row moved more than once for one run", seen.length > beforeSecondRun + 1, `${seen.length - beforeSecondRun} updates`);

	const moved = seen.filter((row) => row.id === second).at(-1);
	check(
		"a message landing pushed modified forward",
		(moved?.modified ?? 0) > (landed?.modified ?? 0),
		`${moved?.modified} vs ${landed?.modified}`,
	);
	// 标题指名分支的第一条用户消息（ADR-0002），所以第二个回合移动行的活跃度而不重命名对话。
	check("a later message does not rename the row", moved?.title === "now the row has something to say", moved?.title);

	const settled = seen.length;
	await settle();
	check("an idle session publishes nothing on its own", seen.length === settled, `${seen.length - settled} extra`);

	process.stdout.write("the row survives its host being reaped\n");
	hub.release(host);
	check("the host went away", await until(() => !hub.live.includes(second)));
	const reaped = await projection.row(second);
	check("its row is still there", reaped !== undefined && reaped.id === second, String(reaped?.id));
	check("and says idle rather than claiming to run", reaped?.running === false, JSON.stringify(reaped));
	check("with the title it had while running", reaped?.title === moved?.title, `${reaped?.title} vs ${moved?.title}`);

	process.stdout.write("a row's title follows the branch, not the file\n");
	// placeholder 规则现在住在 session 层——无人开口的 session 根本没有行，开头那节检查过。
	// 这里行必须做的是携带分支给它的标题，直到分支移动。
	const beforeBranch = await projection.row(first);
	check("the row kept the title its branch gave it", beforeBranch?.title === "the conversation starts here", beforeBranch?.title);
	const branchHost = await hub.hold(first);
	fake.setResponses([fakeAssistantMessage("one"), fakeAssistantMessage("two")]);
	await hub.agent.prompt(first, "first turn");
	await settle();
	// 同一分支上的第二个回合不能重命名 session：回退标题是分支的第一条用户消息，而那条消息
	// 没有移动。
	check("a message landing does not rename the row", (await projection.row(first))?.title === "the conversation starts here", (await projection.row(first))?.title);
	check(
		"and a cold probe agrees with the live row",
		(await SessionManager.findSessionRowById(first))?.title === "the conversation starts here",
		(await SessionManager.findSessionRowById(first))?.title,
	);

	// leaf 在内存里，得知分支移动了的唯一办法是听 session 自己说——而标题要移动的唯一办法是
	// 丢掉给了它名字的那些消息，因为分支总是跑回根部。重置 leaf 再发问会开一个新根，文件把它
	// 替换的对话与新对话并排保留。这个重置是门面没有理由拼写的测试专用手术，所以 bag 从下面的
	// 私有表探针来。
	agent.sessionManager.resetLeaf(heldBagOf(agent, first));
	await hub.agent.prompt(first, "a different opening");
	await settle();
	const reopened = await projection.row(first);
	check("a new root is named from the message it started with", reopened?.title === "a different opening", reopened?.title);
	check(
		"and the cold probe agrees with the live row, which is the whole point of one derivation",
		(await SessionManager.findSessionRowById(first))?.title === reopened?.title,
		`${(await SessionManager.findSessionRowById(first))?.title} vs ${reopened?.title}`,
	);
	hub.release(branchHost);
	await until(() => !hub.live.includes(first));
	check("the row is still there after its host", (await projection.row(first)) !== undefined);

	process.stdout.write("a fork knows its parent without a listing beside it\n");
	const source = await hub.newSession();
	const sourceHost = await hub.hold(source);
	fake.setResponses([fakeAssistantMessage("to fork from")]);
	await hub.agent.prompt(source, "the conversation being forked");
	await settle();
	const forked = await hub.fork(source, agent.snapshot(source).leafId);
	await until(() => seen.some((row) => row.id === forked));
	const forkRow = await projection.row(forked);
	check("the fork reaches the store on its own", forkRow !== undefined, forked);
	check(
		"and names the session it came from",
		forkRow?.parentId === source,
		`${forkRow?.parentId} vs ${source}`,
	);
	check("while the session it came from names nobody", (await projection.row(source))?.parentId === undefined, (await projection.row(source))?.parentId);
	hub.release(sourceHost);
	await until(() => !hub.live.includes(source));

	process.stdout.write("the hub tells a process-level listener about sessions nobody watches\n");
	const heard: string[] = [];
	const stopHosting = hub.onHostChange((sessionId, hostSeen) => heard.push(`${sessionId}:${hostSeen === undefined ? "none" : "host"}`));
	const third = await hub.newSession();
	check("a created session is reported with no host", heard.includes(`${third}:none`), heard.join(" "));
	const thirdHost = await hub.hold(third);
	check("and again with one", heard.includes(`${third}:host`), heard.join(" "));
	hub.release(thirdHost);
	await until(() => heard.filter((entry) => entry === `${third}:none`).length === 2);
	check("and once more when it is reaped", heard.filter((entry) => entry === `${third}:none`).length === 2, heard.join(" "));
	stopHosting();
	const afterStop = await hub.newSession();
	await settle();
	check("a listener that stopped hearing stops hearing", !heard.includes(`${afterStop}:none`), heard.join(" "));

	process.stdout.write("observing a session is not the same as holding it\n");
	let events = 0;
	// 在 session 运行之前被告知它，所以一个 host 打开的瞬间 observer 就已挂上。
	const stopObserving = hub.observe(afterStop, (feeds) => {
		if (feeds === undefined) return;
		feeds.onEvent(() => {
			events += 1;
		});
	});
	check("watching it did not assemble anything", !hub.live.includes(afterStop), hub.live.join(","));
	const observedHost = await hub.hold(afterStop);
	check("and it was attached when the host opened", hub.agent.holdsOf(afterStop) === 1, `holds=${hub.agent.holdsOf(afterStop)}`);
	fake.setResponses([fakeAssistantMessage("seen")]);
	await hub.agent.prompt(afterStop, "does the observer hear this");
	check("the observer saw the run's events", events > 0, `${events} events`);
	hub.release(observedHost);
	await until(() => !hub.live.includes(afterStop));
	check("the host was reaped while observed", !hub.live.includes(afterStop));
	// 行的诞生发布与 idle 重新发布都是异步读；等 idle 那次，而不是猜测 reap 返回时哪次已落地。
	check("and the row says idle", await until(() => seen.some((row) => row.id === afterStop && row.running === false)), JSON.stringify(seen.filter((row) => row.id === afterStop)));
	stopObserving();
	check("and the observer let go", !hub.isWatched(afterStop));

	process.stdout.write("a parked session's cold row lights up from the snapshot marker\n");
	// 两个被驱动到门口然后放开的 session：store 在任何地方都没有 host 的情况下持有停在门口的
	// 问题，这正是重启时 seed 的来源。门是每个 session 自己的选择，机器的设置与此无关。
	const park = async (promptText: string): Promise<string> => {
		const id = await hub.newSession();
		const host = await hub.hold(id);
		hub.agent.applyConfig(id, { approval: { read: true } });
		fake.setResponses([
			fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
			fakeAssistantMessage("done"),
		]);
		await hub.agent.prompt(id, promptText);
		const parked = hub.agent.hasPendingApprovals(id);
		hub.release(host);
		await until(() => !hub.live.includes(id));
		if (!parked) throw new Error("the session did not park, so the marker checks cannot run");
		return id;
	};
	const parkedId = await park("read the notes");
	const strippedId = await park("read the notes too");
	const metaPathOf = (id: string): string => {
		const jsonl = SessionManager.findSessionFilePathById(id);
		if (jsonl === undefined) throw new Error(`no session file for ${id}`);
		return sessionMetaPath(jsonl);
	};
	// 兼容情形：没有该字段的快照——一个旧文件，或被手工剥掉的标记——读作 pending 0，即使
	// ledger 仍持有那个悬着的调用。
	const strippedMeta = JSON.parse(await readFile(metaPathOf(strippedId), "utf8")) as SessionMeta;
	check("precondition: the second parked snapshot carries the marker", strippedMeta.suspended === true, JSON.stringify(strippedMeta));
	delete strippedMeta.suspended;
	await writeFile(metaPathOf(strippedId), `${JSON.stringify(strippedMeta, null, "\t")}\n`, "utf8");

	// 建在同一个 hub 上的全新 projection：它的 seed 就是重启时付出的那次冷读，而且到处都没有
	// host——停在门口的行的 pending 只能来自快照的标记。
	const cold = createSessionProjection(hub);
	const coldRows = await cold.rows();
	const coldParked = coldRows.find((row) => row.id === parkedId);
	check("the parked session's cold row is pending 1", coldParked?.pending === 1, JSON.stringify(coldParked));
	check("and not running: no host survived to claim it", coldParked?.running === false, JSON.stringify(coldParked));
	const coldStripped = coldRows.find((row) => row.id === strippedId);
	check("a snapshot without the field reads as pending 0", coldStripped?.pending === 0, JSON.stringify(coldStripped));

	// 重命名闭包：一个没有 host、停在门口的 session 被改名，刷新重新发布探针行——标记必须在
	// 重读中存活，否则小圆点会在一次改名时熄灭。
	await hub.rename(parkedId, "parked and renamed");
	await cold.refresh(parkedId);
	const renamed = await cold.row(parkedId);
	check("the rename reached the cold row", renamed?.title === "parked and renamed", JSON.stringify(renamed));
	check("and the dot stayed lit", renamed?.pending === 1, JSON.stringify(renamed));
	cold.close();

	process.stdout.write("the envelope types describe a multiplexed connection\n");
	const item: ServerMessage = { type: "status", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, contextWindow: 100 }, submitting: true, queued: [], isRetrying: false, retryAttempt: 0 };
	const onAStream: ServerFrame = { streamId: "session-a", item };
	const heartbeat: ConnectionItem = { type: "heartbeat", everyMs: 5_000 };
	const onTheConnection: ServerFrame = { streamId: null, item: heartbeat };
	const rowsBaseline: ServerFrame = { streamId: null, item: { type: "sessions", sessions: [] satisfies SessionRow[] } };
	const oneRow: ServerFrame = { streamId: null, item: { type: "session_row", session: spokenRow as SessionRow } };
	const ended: ServerFrame = { streamId: "session-a", end: true };
	const failed: ServerFrame = { streamId: "session-a", error: { message: "that run could not start" } };

	check("content rides the session's own stream", onAStream.streamId === "session-a" && "item" in onAStream);
	check("a heartbeat rides the connection seat", onTheConnection.streamId === null);
	check("so does the whole table", rowsBaseline.streamId === null && "item" in rowsBaseline);
	check("and one row at a time", oneRow.streamId === null);
	check("a stream ends without saying why", "end" in ended && ended.end === true);
	check("a failure is not a terminal frame", "error" in failed && !("end" in failed));
	check("the three shapes are told apart by field name", ["item", "end", "error"].every((key) => key in onAStream || key in ended || key in failed));

	const open: ClientFrame = { type: "open", sessionId: "session-a" };
	const cancel: ClientFrame = { type: "cancel", sessionId: "session-a" };
	check("a client opens a stream by session id", open.type === "open" && open.sessionId === "session-a");
	check("and cancels one the same way", cancel.type === "cancel" && cancel.sessionId === "session-a");
	check("no frame carries a request id", !("requestId" in open) && !("subscriptionId" in open));

	stopListening();
	projection.close();
	await hub.close();
	check("nothing is left running", hub.live.length === 0, hub.live.join(","));
} finally {
	// session 住在 agent home 之下、按工作目录路径作键，所以只删临时目录不够：没有这一步，
	// 每次运行都会留下一个孤儿目录。
	await rm(storeRoot, { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nprojection ok\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);