// Replay smoke: proves a session reopened from its snapshot still shows the whole tool process —
// the call (name, arguments) and its result (text, error flag, diff) — not just the messages around
// it. The reopen path is the reducer's `baseline` frame, so that is what this drives; the shapes fed
// in are the ones a real session file holds (assistant message with a `toolCall` block, then a
// `toolResult` message paired by id), as verified on disk by 03's research (`replay-tools.md`).
// Nothing reaches a model, so no provider key is needed.
// Run with: node scripts/smoke-replay.ts
import { initialState, reduce, type Item } from "../packages/web/src/state.ts";
import type { SessionSnapshot, UsageTotals } from "@my-agent/core/protocol";

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
const callIndex = failed.findIndex((item) => item.kind === "message" && item.role === "assistant" && item.id === "assistant:2000");
const answerIndex = failed.findIndex((item) => item.kind === "message" && item.role === "assistant" && item.id === "assistant:4000");
const groupIndex = failed.indexOf(failedGroups[0]!);
check(
	"the group sits between the call and the answer",
	callIndex !== -1 && answerIndex !== -1 && callIndex < groupIndex && groupIndex < answerIndex,
	`call=${callIndex} group=${groupIndex} answer=${answerIndex}`,
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

process.stdout.write(failures === 0 ? "\nreplay ok\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
