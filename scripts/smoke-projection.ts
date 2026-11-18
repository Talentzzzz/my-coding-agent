// Projection smoke test：证明侧栏行存储无需任何人在看就能回答"每个 session 正在做什么"，
// 一行只有在关于它的东西变化时才移动，停在门口的 session 的冷行从快照标记上点亮（没有袋、
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
 * 门面按 id 以纯数据作答——state 对象不是它的可给之物——所以本 smoke 对会话进行的
 * 唯一一处测试专用手术（leaf 重置）要与其他 smoke 的身份断言一样，经由 orchestrator 持有的
 * 那张表到达 bag。
 */
function heldBagOf(agent: Agent, id: string): Session {
	// 会话是文件，不是字段（ADR-0013）：下面的手术需要一个 bag，于是它打开自己的 replay，
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
	process.stdout.write("birth is what puts the session in the store\n");
	// ADR-0021：会话随第一条消息出生，所以「先创建、后开口」的两段式没有了——birth 落地的瞬间
	// 文件就在，行的冷读立刻答得出它，组也随之而来。store 与本机其他每次运行共享，所以本 smoke
	// 从不假设自己是唯一存在的 session——它只问自己创建的那些。
	const first = await hub.birth({ text: "the conversation starts here" });
	const projection = createSessionProjection(hub);

	// 从此以后每一处行变化，按监听器看到的样子——行的唯一出口是 hub 的全局通道。
	const seen: SessionRow[] = [];
	const stopListening = hub.subscribeGlobal({ rows: (row) => seen.push(row) });

	const spokenRow = await projection.row(first);
	check("a born session has a row", spokenRow !== undefined, String(spokenRow));
	check("with the working directory as its workDirAbsPath", spokenRow?.workDirAbsPath === root, spokenRow?.workDirAbsPath);
	check("a row carries modified, not only createdAt", typeof spokenRow?.modified === "number" && spokenRow.modified > 0, String(spokenRow?.modified));
	check("and the title is the message the branch starts with", spokenRow?.title === "the conversation starts here", spokenRow?.title);
	const groupsAtBirth = await projection.groups();
	check(
		"and a group names its directory at once",
		groupsAtBirth.some((group) => group.workDirAbsPath === root),
		JSON.stringify(groupsAtBirth.map((group) => group.workDirAbsPath)),
	);

	process.stdout.write("one scan, however many callers\n");
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

	process.stdout.write("a birth reaches the store through the creation signal\n");
	// birth 是第一条消息（ADR-0021）。生产中 controller 的 listener 把出生告诉 projection；本 smoke
	// 没有接 controller，所以由它自己扮演那一拍：refresh 探测文件、发布行、开始跟随。
	const second = await hub.birth({ text: "now the row has something to say" });
	await projection.refresh(second);
	check("a birth reaches a row through the creation signal", await until(() => seen.some((row) => row.id === second)), JSON.stringify(seen.map((row) => row.id)));

	process.stdout.write("a run moves the row even though nothing is watching it\n");
	// store 的全部意义：一个 session 运行，它的行在没有任何订阅者的地方说着这件事。之前只有
	// *内容*流会携带这件事，而这里没有订阅者。行已在出生时进了 store（ADR-0021），所以这次
	// run 移动的是一行已存在的东西——在途时 `running`，落定时以 idle 重新发布。
	fake.setResponses([fakeAssistantMessage("answered")]);
	const run = hub.agent.prompt(second, "the row is watching itself now");
	check("the row said running while the run was in flight", await until(() => seen.some((row) => row.id === second && row.running === true)));
	await run;
	const landed = await projection.row(second);
	check("and the run ended idle", landed?.running === false && landed.pending === 0, JSON.stringify(landed));
	check("the title is read from the branch, not the file", landed?.title === "now the row has something to say", landed?.title);

	// 再来一次，这次盯住发布计数：一次 run 至少移动两次行。
	const beforeSecondRun = seen.length;
	fake.setResponses([fakeAssistantMessage("answered again")]);
	const secondRun = hub.agent.prompt(second, "the row is watching itself again");
	check("the row said running again while the run was in flight", await until(() => seen.some((row) => row.id === second && row.running === true)));
	await secondRun;
	check("and the second run ended", (await projection.row(second))?.running === false, JSON.stringify(await projection.row(second)));
	check("the row moved more than once for one run", seen.length > beforeSecondRun + 1, `${seen.length - beforeSecondRun} updates`);

	const moved = seen.filter((row) => row.id === second).at(-1);
	check(
		"a message landing pushed modified forward",
		(moved?.modified ?? 0) > (landed?.modified ?? 0),
		`${moved?.modified} vs ${landed?.modified}`,
	);
	// 标题指名分支的第一条用户消息（ADR-0008），所以第二个回合移动行的活跃度而不重命名对话。
	check("a later message does not rename the row", moved?.title === "now the row has something to say", moved?.title);

	const settled = seen.length;
	await settle();
	check("an idle session publishes nothing on its own", seen.length === settled, `${seen.length - settled} extra`);

	process.stdout.write("the row outlives the run\n");
	const reaped = await projection.row(second);
	check("its row is still there", reaped !== undefined && reaped.id === second, String(reaped?.id));
	check("and says idle rather than claiming to run", reaped?.running === false, JSON.stringify(reaped));
	check("with the title it had while running", reaped?.title === moved?.title, `${reaped?.title} vs ${moved?.title}`);

	process.stdout.write("a row's title follows the branch, not the file\n");
	// placeholder 规则现在住在 session 层——无人开口的 session 根本没有行，开头那节检查过。
	// 这里行必须做的是携带分支给它的标题，直到分支移动。
	const beforeBranch = await projection.row(first);
	check("the row kept the title its branch gave it", beforeBranch?.title === "the conversation starts here", beforeBranch?.title);
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
	check("the row is still there after the runs", (await projection.row(first)) !== undefined);

	process.stdout.write("a fork knows its parent without a listing beside it\n");
	// 出生消息就是 fork 挂点（ADR-0021）：birth 落地时账本里已有第一条 user entry，
	// 从它的 leaf fork 即可，无需再说什么。
	const source = await hub.birth({ text: "the conversation being forked" });
	await settle();
	const forked = await hub.fork(source, agent.snapshot(source).leafId);
	await projection.refresh(forked);
	await until(() => seen.some((row) => row.id === forked));
	const forkRow = await projection.row(forked);
	check("the fork reaches the store on its own", forkRow !== undefined, forked);
	check(
		"and names the session it came from",
		forkRow?.parentId === source,
		`${forkRow?.parentId} vs ${source}`,
	);
	check("while the session it came from names nobody", (await projection.row(source))?.parentId === undefined, (await projection.row(source))?.parentId);

	process.stdout.write("watching a session is not the same as running it\n");
	const afterStop = await hub.birth({ text: "an unobserved birth" });
	await projection.refresh(afterStop);
	let events = 0;
	// 在 session 运行之前订阅：订阅元素在注册的同一拍就在表里，之后随运行自流入，无需任何重绑。
	// 装配走 hub 的公开订阅原语 subscribe——这个 smoke 不关心 baseline，所以不声明它；它观看的
	// 只是事件流与「观看不拼装任何东西」本身。
	const stopWatching = hub.subscribe(afterStop, {
		event: () => {
			events += 1;
		},
	});
	check("watching it did not assemble anything", !hub.isLive(afterStop), String(hub.isLive(afterStop)));
	fake.setResponses([fakeAssistantMessage("seen")]);
	await hub.agent.prompt(afterStop, "does the watcher hear this");
	check("the watcher heard the run's events without any rebinding", events > 0, `${events} events`);
	check("nothing stays live after the run", !hub.isLive(afterStop), String(hub.isLive(afterStop)));
	// 行的诞生发布与 idle 重新发布都是异步读；等 idle 那次，而不是猜测运行结束时哪次已落地。
	check("and the row says idle", await until(() => seen.some((row) => row.id === afterStop && row.running === false)), JSON.stringify(seen.filter((row) => row.id === afterStop)));
	stopWatching();
	// 退订的可观察面在 scripts/smoke-subscribe.ts 的帧断言里：这里不再问观看表是否清空。

	process.stdout.write("a parked session's cold row lights up from the snapshot marker\n");
	// 两个被驱动到门口然后停下的 session：袋停驻审批时就住在编排层的表里，问题悬在原地——这正是
	// end-restart 语义下会话留在门口的样子。门是每个 session 自己的选择，机器的设置与此无关。
	const park = async (promptText: string): Promise<string> => {
		const id = await hub.birth({ text: promptText });
		hub.agent.applyConfig(id, { approval: { read: true } });
		fake.setResponses([
			fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
			fakeAssistantMessage("done"),
		]);
		await hub.agent.prompt(id, promptText);
		if (hub.agent.snapshot(id).pendingApprovals.length === 0) throw new Error("the session did not park, so the marker checks cannot run");
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

	// 一个全新的 hub + projection：编排层的表随 hub 而空——这正是重启的样子——停在门口的行的
	// pending 只能来自快照的标记。
	const coldHub = new SessionHub({ workDirAbsPath: root, api: fake.api, modelsHome: join(root, "agent-home") });
	const cold = createSessionProjection(coldHub);
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
	const item: ServerMessage = { type: "status", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, contextWindow: 100 }, running: true, queued: [], isRetrying: false, retryAttempt: 0 };
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
	cold.close();
	await coldHub.close();
	await hub.close();
	check("nothing is left running", [first, second, parkedId, strippedId].every((id) => !agent.isRunning(id)));
} finally {
	// session 住在 agent home 之下、按工作目录路径作键，所以只删临时目录不够：没有这一步，
	// 每次运行都会留下一个孤儿目录。
	await rm(storeRoot, { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nprojection ok\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);