// Replay smoke：证明一个从快照重开的 session 仍然显示完整的工具过程——调用（名称、参数）与
// 它的结果（文本、错误标志、diff）——而不只是围绕它们的消息。重开路径就是 reducer 的
// `baseline` 帧，所以本脚本驱动的是它；喂进去的形状是真实 session 文件持有的形状（带
// `toolCall` 块的 assistant 消息，随后按 id 配对的 `toolResult` 消息），如 03 的研究
// （`replay-tools.md`）在磁盘上核实过的那样。不接触任何模型，无需 provider key。
// 运行：node scripts/smoke-replay.ts
import { initialState, reduce, type Item, type ViewState } from "../packages/web/src/state.ts";
import type { ServerMessage, SessionSnapshot, UsageTotals } from "@my-agent/core/protocol";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

const USAGE: UsageTotals = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	contextWindow: 128_000,
};

/** 只携带这些消息的快照，形状与 `buildSessionContext` 产出的相同。 */
function snapshotWith(
	messages: unknown[],
	overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
	return {
		id: "smoke-replay",
		workDirAbsPath: "/tmp/smoke-replay",
		createdAt: 1,
		title: "重放",
		model: "faux",
		thinkingLevel: "off",
		messages: messages as SessionSnapshot["messages"],
		messageEntryIds: messages.map((_, index) => `entry-${index}`),
		branchPoints: [],
		leafId: `entry-${messages.length - 1}`,
		running: false,
		queued: [],
		isRetrying: false,
		retryAttempt: 0,
		usage: USAGE,
		pendingApprovals: [],
		...overrides,
	};
}

/** 一次重开：折叠一份 baseline，交回它重建的条目。 */
function reopen(messages: unknown[], overrides: Partial<SessionSnapshot> = {}): Item[] {
	return reduce(initialState(), { type: "baseline", session: snapshotWith(messages, overrides) }).items;
}

function toolGroups(items: Item[]): Extract<Item, { kind: "tools" }>[] {
	return items.filter((item): item is Extract<Item, { kind: "tools" }> => item.kind === "tools");
}

// ------------------------------------------------------------------ 一次被监视的回合，重放

process.stdout.write("a reopened session keeps the whole tool turn\n");
// 03 在磁盘上核实过的那一回合：用户发问，模型调用 `read`，调用失败，模型作答。
const failed = reopen([
	{ role: "user", content: [{ type: "text", text: "看看 notes.txt" }], timestamp: 1_000 },
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "tool:1", name: "read", arguments: { path: "notes.txt" } }],
		timestamp: 2_000,
	},
	{
		role: "toolResult",
		toolCallId: "tool:1",
		toolName: "read",
		content: [{ type: "text", text: "File not found: notes.txt" }],
		details: {},
		isError: true,
		timestamp: 3_000,
	},
	{ role: "assistant", content: [{ type: "text", text: "notes.txt 不存在。" }], timestamp: 4_000 },
]);
const failedGroups = toolGroups(failed);
check("the tool call survived the reopen", failedGroups.length === 1, JSON.stringify(failedGroups.length));
const failedCard = failedGroups[0]?.cards[0];
check("the card names the call", failedCard?.toolCallId === "tool:1" && failedCard?.toolName === "read", JSON.stringify(failedCard));
check("with the arguments it was made with", JSON.stringify(failedCard?.args) === JSON.stringify({ path: "notes.txt" }), JSON.stringify(failedCard?.args));
check("the result survived the reopen", failedCard?.output === "File not found: notes.txt", JSON.stringify(failedCard?.output));
check("and its error flag", failedCard?.isError === true, String(failedCard?.isError));
check("a settled snapshot settles its card", failedCard?.running === false, String(failedCard?.running));
// 调用消息本身没有正文——07 把 `[调用 name]` 从散文路径里拿掉了，而一条只有调用的消息无话可
// 说——所以组的下一位邻居就是那个提问。
const userIndex = failed.findIndex((item) => item.kind === "message" && item.role === "user");
const answerIndex = failed.findIndex((item) => item.kind === "message" && item.role === "assistant" && item.id === "assistant:4000");
const groupIndex = failed.indexOf(failedGroups[0]!);
check(
	"the group sits between the question and the answer",
	userIndex !== -1 && answerIndex !== -1 && userIndex < groupIndex && groupIndex < answerIndex,
	`user=${userIndex} group=${groupIndex} answer=${answerIndex}`,
);
check(
	"the call-only message left no body behind",
	!failed.some((item) => item.kind === "message" && item.id === "assistant:2000"),
	JSON.stringify(failed.map((item) => (item.kind === "message" ? item.id : item.kind))),
);

process.stdout.write("a write's diff survives the reopen\n");
const written = reopen([
	{ role: "user", content: [{ type: "text", text: "写 hello" }], timestamp: 10_000 },
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "tool:2", name: "write", arguments: { path: "hello.txt", content: "hi" } }],
		timestamp: 11_000,
	},
	{
		role: "toolResult",
		toolCallId: "tool:2",
		toolName: "write",
		content: [{ type: "text", text: "Wrote hello.txt" }],
		details: {
			diff: { path: "hello.txt", added: 1, removed: 0, created: true, omitted: 0, lines: [{ kind: "add", text: "hi" }] },
		},
		isError: false,
		timestamp: 12_000,
	},
	{ role: "assistant", content: [{ type: "text", text: "写好了。" }], timestamp: 13_000 },
]);
const writtenCard = toolGroups(written)[0]?.cards[0];
check("the card carries the diff the result reported", writtenCard?.diff?.relPath === "hello.txt" && writtenCard?.diff?.added === 1, JSON.stringify(writtenCard?.diff));

process.stdout.write("calls of one turn share the group they were replayed into\n");
const parallel = reopen([
	{ role: "user", content: [{ type: "text", text: "读两个文件" }], timestamp: 20_000 },
	{
		role: "assistant",
		content: [
			{ type: "toolCall", id: "tool:3", name: "read", arguments: { path: "a.txt" } },
			{ type: "toolCall", id: "tool:4", name: "read", arguments: { path: "b.txt" } },
		],
		timestamp: 21_000,
	},
	{
		role: "toolResult",
		toolCallId: "tool:3",
		toolName: "read",
		content: [{ type: "text", text: "A" }],
		details: {},
		isError: false,
		timestamp: 22_000,
	},
	{
		role: "toolResult",
		toolCallId: "tool:4",
		toolName: "read",
		content: [{ type: "text", text: "B" }],
		details: {},
		isError: false,
		timestamp: 23_000,
	},
	{ role: "assistant", content: [{ type: "text", text: "两份都读到了。" }], timestamp: 24_000 },
]);
const parallelGroups = toolGroups(parallel);
check("one turn, one group", parallelGroups.length === 1, JSON.stringify(parallelGroups.length));
check(
	"both cards landed in it, results matched by id",
	parallelGroups[0]?.cards.length === 2 &&
		parallelGroups[0]?.cards[0]?.output === "A" &&
		parallelGroups[0]?.cards[1]?.output === "B",
	JSON.stringify(parallelGroups[0]?.cards.map((card) => card.output)),
);

process.stdout.write("a snapshot that is still running leaves its live card alone\n");
const live = reopen(
	[
		{ role: "user", content: [{ type: "text", text: "跑一下" }], timestamp: 30_000 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "tool:5", name: "bash", arguments: { command: "ls" } }],
			timestamp: 31_000,
		},
	],
	{ running: true },
);
const liveCard = toolGroups(live)[0]?.cards[0];
check("a call without a result yet stays running", liveCard?.running === true, String(liveCard?.running));

process.stdout.write("a finished snapshot does not spin on a record cut short\n");
const cutShort = reopen([
	{ role: "user", content: [{ type: "text", text: "跑一下" }], timestamp: 40_000 },
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "tool:6", name: "bash", arguments: { command: "ls" } }],
		timestamp: 41_000,
	},
]);
const cutCard = toolGroups(cutShort)[0]?.cards[0];
check("an unanswered call is settled, not spinning", cutCard?.running === false, String(cutCard?.running));

// ------------------------------------------------------------------ 一次被监视的回合，实时折叠
//
// 16 钉住的形状：一条入队消息的回声落在上一回合流式结束后的空隙里（真实的 wire 顺序——循环
// 只在 drain 点重放它，总在上一条 assistant 的 message_end 之后），而两条盖着同一毫秒时间戳的
// assistant 消息（07 撞上的那次冲突）不得把第一条回答推到 user 气泡的另一侧。

/** 按 wire 送达的方式折叠一个 session 事件。 */
function fold(viewState: ViewState, event: unknown): ViewState {
	return reduce(viewState, { type: "event", event } as ServerMessage);
}

function userEcho(timestamp: number, text: string) {
	return { type: "message_start", message: { role: "user", content: [{ type: "text", text }], timestamp } };
}
function userEnd(timestamp: number, text: string) {
	return { type: "message_end", message: { role: "user", content: [{ type: "text", text }], timestamp } };
}
function assistantStart(timestamp: number, text = "") {
	return { type: "message_start", message: { role: "assistant", content: text.length === 0 ? [] : [{ type: "text", text }], timestamp } };
}
function assistantUpdate(timestamp: number, delta: string) {
	// 一个 delta 而不是整条消息：wire 只携带已到达的字符，客户端把它们追加到时间戳指名的
	// 条目上。
	return { type: "message_update", delta: { timestamp, kind: "text", contentIndex: 0, text: delta } };
}
function assistantEnd(timestamp: number, text: string) {
	return { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], timestamp } };
}

/** 消息条目，形如 `id=text`，按折叠顺序。 */
function shapeOf(items: Item[]): string {
	return items
		.map((item) => (item.kind === "message" ? `${item.id}=${item.text.slice(0, 12)}` : item.id))
		.join(" ");
}

process.stdout.write("a user echo landing mid-stream keeps the answer whole\n");
let liveState = reduce(initialState(), { type: "baseline", session: snapshotWith([]) });
liveState = fold(liveState, userEcho(1_000, "第一问"));
liveState = fold(liveState, userEnd(1_000, "第一问"));
liveState = fold(liveState, assistantStart(2_000));
liveState = fold(liveState, assistantUpdate(2_000, "第一答"));
// 入队的消息在循环重放它之前就写进了 store：这个 entry 赶在回声之前到达，在那里等它的条目。
liveState = reduce(liveState, { type: "entry", entryId: "entry-u2", messageTimestamp: 3_000 });
liveState = fold(liveState, assistantEnd(2_000, "第一答"));
liveState = fold(liveState, userEcho(3_000, "你有哪些工具"));
liveState = fold(liveState, userEnd(3_000, "你有哪些工具"));
check(
	"the echo lands after the finished answer, before the next one",
	shapeOf(liveState.items) === "user:1000=第一问 assistant:2000=第一答 user:3000=你有哪些工具",
	shapeOf(liveState.items),
);
const echoItem = liveState.items.find((item): item is Extract<Item, { kind: "message" }> => item.kind === "message" && item.id === "user:3000");
check("the pending entry found its echo", echoItem?.forkEntryId === "entry-u2", JSON.stringify(echoItem?.forkEntryId));

// 一条与第一条盖同样时间戳的 assistant：不得覆盖第一条回答的正文，也不得把回答画到 user
// 气泡的远侧。
liveState = fold(liveState, assistantStart(2_000));
liveState = fold(liveState, assistantUpdate(2_000, "第二答"));
liveState = fold(liveState, assistantEnd(2_000, "第二答"));
check(
	"a same-stamp successor takes the tail, the first answer keeps its place",
	shapeOf(liveState.items) === "user:1000=第一问 assistant:2000#1=第一答 user:3000=你有哪些工具 assistant:2000=第二答",
	shapeOf(liveState.items),
);

process.stdout.write("the fold's live order never splits an answer around a bubble\n");
let plainState = reduce(initialState(), { type: "baseline", session: snapshotWith([]) });
plainState = fold(plainState, userEcho(10_000, "第一问"));
plainState = fold(plainState, userEnd(10_000, "第一问"));
plainState = fold(plainState, assistantStart(11_000));
plainState = fold(plainState, assistantUpdate(11_000, "第一答"));
plainState = fold(plainState, assistantEnd(11_000, "第一答"));
plainState = fold(plainState, userEcho(12_000, "接着问"));
plainState = fold(plainState, userEnd(12_000, "接着问"));
plainState = fold(plainState, assistantStart(13_000));
plainState = fold(plainState, assistantUpdate(13_000, "第二答"));
plainState = fold(plainState, { type: "tool_execution_start", toolCallId: "tool:9", toolName: "read", args: { path: "a.txt" } });
plainState = fold(plainState, assistantEnd(13_000, "第二答"));
check(
	"echo, next answer, and its tool group each follow the item they belong to",
	shapeOf(plainState.items) === "user:10000=第一问 assistant:11000=第一答 user:12000=接着问 assistant:13000=第二答 tools:tool:9",
	shapeOf(plainState.items),
);

process.stdout.write("a delta stream appends to one item, and a mid-run baseline seeds it\n");
{
	// 普通的一次 run：先 reasoning 再回答，一次一个 delta。没有任何帧携带整条消息，屏幕上的
	// 每个字符都是被追加到其时间戳指名的条目上才到达那里的。
	let viewState = reduce(initialState(), { type: "baseline", session: snapshotWith([], { running: true }) });
	viewState = fold(viewState, assistantStart(20_000));
	viewState = fold(viewState, { type: "message_update", delta: { timestamp: 20_000, kind: "thinking", contentIndex: 0, text: "先想" } });
	viewState = fold(viewState, { type: "message_update", delta: { timestamp: 20_000, kind: "thinking", contentIndex: 0, text: "一下" } });
	const thinking = viewState.items.at(-1);
	check("thinking deltas append into one block", thinking?.kind === "message" && thinking.thinking?.text === "先想一下", JSON.stringify(thinking));
	check("and the row still says it is thinking", thinking?.kind === "message" && thinking.thinking?.running === true);
	check("the item was opened by the first delta", viewState.items.length === 1 && viewState.items[0]?.kind === "message");

	viewState = fold(viewState, { type: "message_update", delta: { timestamp: 20_000, kind: "text", contentIndex: 1, text: "第一" } });
	viewState = fold(viewState, { type: "message_update", delta: { timestamp: 20_000, kind: "text", contentIndex: 1, text: "答" } });
	const answer = viewState.items.at(-1);
	check("text deltas append into one answer", answer?.kind === "message" && answer.text === "第一答", JSON.stringify(answer));
	check("the first answer character stops the thinking row", answer?.kind === "message" && answer.thinking?.running === false);

	viewState = fold(viewState, assistantEnd(20_000, "第一答"));
	const settled = viewState.items.at(-1);
	check("the end still replaces the item with the whole message", settled?.kind === "message" && settled.text === "第一答" && settled.streaming === false);
}
{
	// 运行中途接入：store 里还没有消息，所以 baseline 的 `partial` 是窗口看到这些 delta 之后的
	// 后半句所属的那个开头句子的唯一途径。
	const partial = {
		role: "assistant",
		content: [{ type: "text", text: "已经写了一半" }],
		timestamp: 30_000,
	} as unknown as SessionSnapshot["partial"];
	const viewState = reduce(initialState(), { type: "baseline", session: snapshotWith([], { running: true, partial }) });
	const item = viewState.items.at(-1);
	check("the mid-run baseline draws the text already sent", item?.kind === "message" && item.text === "已经写了一半", JSON.stringify(item));
	check("and draws it as still streaming", item?.kind === "message" && item.streaming === true);
	const continued = fold(viewState, { type: "message_update", delta: { timestamp: 30_000, kind: "text", contentIndex: 0, text: "，后半句" } });
	const grown = continued.items.at(-1);
	check("the deltas after it continue the same item", grown?.kind === "message" && grown.text === "已经写了一半，后半句");
}

process.stdout.write(failures === 0 ? "\nreplay ok\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
