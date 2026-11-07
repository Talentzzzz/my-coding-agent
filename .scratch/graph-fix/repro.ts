// Repro for the reported shape: 你好 forks into two questions, one of those forks again, and the leaf
// then moves back to 你好. Prints the tree the branch page folds from both positions — they have to
// name the same cards, because the tree is the conversation's, not the leaf's.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@my-agent/agent";
import { SessionManager } from "@my-agent/core";
import { buildBranchTree } from "../../packages/web/src/state.ts";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}
function assistant(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() + 1 };
}

const dir = await mkdtemp(join(tmpdir(), "graph-fix-"));
const sm = SessionManager.create(join(dir, "ws"));

const hello = sm.appendMessage(user("你好"));
const reply1 = sm.appendMessage(assistant("你好，有什么可以帮你的"));
const sleep = sm.appendMessage(user("今天晚上几点睡"));
const replySleep = sm.appendMessage(assistant("十一点"));
const noon = sm.appendMessage(user("明天中午吃什么"));
const replyNoon = sm.appendMessage(assistant("牛肉面"));

// A second question under the same answer, then a second question under 你好.
sm.branch(replySleep);
sm.appendMessage(user("明天吃什么呢"));
sm.appendMessage(assistant("饺子"));
sm.branch(reply1);
sm.appendMessage(user("明天晚上想吃什么"));
sm.appendMessage(assistant("随便"));

function report(label: string, leaf: string): string[] {
	sm.branch(leaf);
	const tree = buildBranchTree({
		messages: sm.buildSessionContext().messages,
		messageEntryIds: sm.getContextMessageEntryIds(),
		branchPoints: sm.getBranchPoints(),
	} as never);
	const cards: string[] = [];
	const walk = (way: any, depth: number, lane: number): void => {
		cards.push(`${"  ".repeat(depth)}d${depth}/l${lane} ${way.label} [${way.entryId}]${way.landing === "tip" ? " (走法)" : ""}`);
		way.branches.forEach((branch: any, at: number) => walk(branch, depth + 1, lane + 1 + at));
		if (way.next !== undefined) walk(way.next, depth + 1, lane);
	};
	console.log(`\n=== ${label}（leaf ${leaf}）`);
	if (tree === undefined) {
		console.log("  空");
		return cards;
	}
	console.log(`points=${tree.points} options=${tree.options} line=${[...tree.line].join(",")}`);
	walk(tree.trunk, 0, 0);
	console.log(cards.join("\n"));
	return cards;
}

const atNoon = report("停在「明天中午吃什么」", replyNoon);
const atHello = report("回到第一条「你好」", hello);

const ids = (cards: string[]) => cards.map((card) => /\[(\w+)\]/.exec(card)![1]).sort();
const same = JSON.stringify(ids(atNoon)) === JSON.stringify(ids(atHello));
console.log(`\n两个位置画出的卡片${same ? "一致" : "不一致"}：${ids(atNoon).join(",")} vs ${ids(atHello).join(",")}`);
process.exitCode = same ? 0 : 1;
