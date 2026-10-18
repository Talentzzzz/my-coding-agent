// Replay smoke: proves a session reopened from its snapshot still shows the whole tool process —
// the call (name, arguments) and its result (text, error flag, diff) — not just the messages around
// it. The reopen path is the reducer's `baseline` frame, so that is what this drives; the shapes fed
// in are the ones a real session file holds (assistant message with a `toolCall` block, then a
// `toolResult` message paired by id), as verified on disk by 03's research (`replay-tools.md`).
// Nothing reaches a model, so no provider key is needed.
// Run with: node scripts/smoke-replay.ts
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

/** A snapshot carrying just these messages, in the shape `buildSessionContext` produces. */
function snapshotWith(
	messages: unknown[],
	overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
	return {
		id: "smoke-replay",
		cwd: "/tmp/smoke-replay",
		createdAt: 1,
		title: "重放",
		model: "faux",
		thinkingLevel: "off",
		thinkingLevels: ["off"],
		approvals: { read: false, write: false, edit: false, glob: false, grep: false, bash: false },
		allTools: ["read", "write", "edit", "glob", "grep", "bash"],
		activeTools: ["read", "write", "edit", "glob", "grep", "bash"],
		toolsFollowGlobal: true,
		approvalsFollowGlobal: true,
		messages: messages as SessionSnapshot["messages"],
		messageEntryIds: messages.map((_, index) => `entry-${index}`),
		branchPoints: [],
		leafId: `entry-${messages.length - 1}`,
		submitting: false,
		queued: 0,
		isRetrying: false,
		retryAttempt: 0,
		usage: USAGE,
		pendingApprovals: [],
		...overrides,
	};
}

/** One reopen: fold a baseline and hand back the items it rebuilt. */
function reopen(messages: unknown[], overrides: Partial<SessionSnapshot> = {}): Item[] {
	return reduce(initialState(), { type: "baseline", session: snapshotWith(messages, overrides) }).items;
}

function toolGroups(items: Item[]): Extract<Item, { kind: "tools" }>[] {
	return items.filter((item): item is Extract<Item, { kind: "tools" }> => item.kind === "tools");
}

// ------------------------------------------------------------------ one watched turn, replayed

process.stdout.write("a reopened session keeps the whole tool turn\n");
// The turn 03 verified on disk: user asks, the model calls `read`, the call fails, the model answers.
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
// The calling message itself has no body — 07 took `[调用 name]` out of the prose path, and a
// message that is only calls has nothing to say — so the group's lower neighbour is the question.
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
check("the card carries the diff the result reported", writtenCard?.diff?.path === "hello.txt" && writtenCard?.diff?.added === 1, JSON.stringify(writtenCard?.diff));

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
	{ submitting: true },
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

// ------------------------------------------------------------------ one watched turn, folded live
//
// The shape 16 pinned: the echo of a queued message lands in the gap after the previous turn
// finished streaming (the real wire order — the loop only replays it at a drain point, always
// after the previous assistant's message_end), and two assistant messages stamped in the same
// millisecond (the collision 07 hit) must not push the first answer to the other side of the
// user bubble.

/** Fold one session event the way the wire delivers it. */
function fold(state: ViewState, event: unknown): ViewState {
	return reduce(state, { type: "event", event } as ServerMessage);
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
	// A delta, not a message: the wire carries the characters that arrived and the client appends
	// them to the item the stamp names.
	return { type: "message_update", delta: { timestamp, kind: "text", contentIndex: 0, text: delta } };
}
function assistantEnd(timestamp: number, text: string) {
	return { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], timestamp } };
}

/** The message items, as `id=text`, in fold order. */
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
// The queued message is written to the store before the loop replays it: this entry arrives
// ahead of the echo and waits there for its item.
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

// A second assistant stamped like the first: it must not overwrite the first answer's body,
// and must not draw the answer on the far side of the user bubble.
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
	// The ordinary run: reasoning, then the answer, one delta at a time. No frame carries the message,
	// so every character on screen got there by being appended to the item its stamp names.
	let state = reduce(initialState(), { type: "baseline", session: snapshotWith([], { submitting: true }) });
	state = fold(state, assistantStart(20_000));
	state = fold(state, { type: "message_update", delta: { timestamp: 20_000, kind: "thinking", contentIndex: 0, text: "先想" } });
	state = fold(state, { type: "message_update", delta: { timestamp: 20_000, kind: "thinking", contentIndex: 0, text: "一下" } });
	const thinking = state.items.at(-1);
	check("thinking deltas append into one block", thinking?.kind === "message" && thinking.thinking?.text === "先想一下", JSON.stringify(thinking));
	check("and the row still says it is thinking", thinking?.kind === "message" && thinking.thinking?.running === true);
	check("the item was opened by the first delta", state.items.length === 1 && state.items[0]?.kind === "message");

	state = fold(state, { type: "message_update", delta: { timestamp: 20_000, kind: "text", contentIndex: 1, text: "第一" } });
	state = fold(state, { type: "message_update", delta: { timestamp: 20_000, kind: "text", contentIndex: 1, text: "答" } });
	const answer = state.items.at(-1);
	check("text deltas append into one answer", answer?.kind === "message" && answer.text === "第一答", JSON.stringify(answer));
	check("the first answer character stops the thinking row", answer?.kind === "message" && answer.thinking?.running === false);

	state = fold(state, assistantEnd(20_000, "第一答"));
	const settled = state.items.at(-1);
	check("the end still replaces the item with the whole message", settled?.kind === "message" && settled.text === "第一答" && settled.streaming === false);
}
{
	// Attaching mid-run: the store has no message yet, so the baseline's `partial` is the only way the
	// window sees the beginning of the sentence the deltas after it continue.
	const partial = {
		role: "assistant",
		content: [{ type: "text", text: "已经写了一半" }],
		timestamp: 30_000,
	} as unknown as SessionSnapshot["partial"];
	const state = reduce(initialState(), { type: "baseline", session: snapshotWith([], { submitting: true, partial }) });
	const item = state.items.at(-1);
	check("the mid-run baseline draws the text already sent", item?.kind === "message" && item.text === "已经写了一半", JSON.stringify(item));
	check("and draws it as still streaming", item?.kind === "message" && item.streaming === true);
	const continued = fold(state, { type: "message_update", delta: { timestamp: 30_000, kind: "text", contentIndex: 0, text: "，后半句" } });
	const grown = continued.items.at(-1);
	check("the deltas after it continue the same item", grown?.kind === "message" && grown.text === "已经写了一半，后半句");
}

process.stdout.write(failures === 0 ? "\nreplay ok\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
