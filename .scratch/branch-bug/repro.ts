// Repro: branch page after a rewind + a second turn.
// Simulates: user1 -> assistant1, rewind to user1, user2 -> assistant2.
// Prints what buildBranchTree would draw for the live session and for a cold reopen.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import type { AgentMessage } from "@my-agent/agent";
import { SessionManager } from "@my-agent/core";
import { branchTreeFromItems, buildBranchTree } from "../../packages/web/src/state.ts";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}
function assistant(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() + 1 };
}

const dir = await mkdtemp(join(tmpdir(), "branch-repro-"));

// Phase 1: a session with one full turn.
const live = SessionManager.create(join(dir, "ws"));
const u1 = live.appendMessage(user("第一条 user"));
live.appendMessage(assistant("第一条回复"));

// Phase 2: rewind to the first user message, then a second full turn.
live.branch(u1);
const u2 = live.appendMessage(user("第二条 user"));
live.appendMessage(assistant("第二条回复"));

function describe(label: string, sm: SessionManager): void {
	const messages = sm.buildSessionContext().messages;
	const ids = sm.getContextMessageEntryIds();
	const points = sm.getBranchPoints();
	const tree = buildBranchTree({
		messages,
		messageEntryIds: ids,
		branchPoints: points,
	} as never);
	const walk = (way: any, depth = 0): string[] => {
		if (way === undefined) return [];
		const lines = [`${"  ".repeat(depth)}[${way.role}] turn=${way.turn} ${way.label} (entry ${way.entryId}) reply=${way.replyId ?? "-"} branches=${way.branches.length}`];
		for (const branch of way.branches) lines.push(...walk(branch, depth + 1));
		lines.push(...walk(way.next, depth));
		return lines;
	};
	console.log(`--- ${label}`);
	console.log(`chain roles: ${messages.map((m) => m.role).join(",")}`);
	console.log(`entry ids:   ${ids.map((id) => (id === null ? "null" : id.slice(0, 6))).join(",")}`);
	console.log(`branch points: ${points.length}`);
	console.log(tree === undefined ? "tree: undefined" : [`tree: currentId=${tree.currentId} points=${tree.points} options=${tree.options}`, ...walk(tree.trunk)].join("\n"));
}

console.log(`--- live (after rewind + second turn) done`);

// Phase 3: what the client holds after a baseline taken at [user1], then the second turn arrives
// as live events — this is the path the bug lived on (no baseline rides a plain append).
{
	const points = live.getBranchPoints(); // what a branch_changed baseline would have refreshed
	const items: { kind: "message"; id: string; role: string; text: string; notice: boolean; streaming: boolean; forkEntryId?: string }[] = [];
	const add = (role: string, text: string, entryId: string) =>
		items.push({ kind: "message", id: `${role}:${items.length}`, role, text, notice: false, streaming: false, forkEntryId: entryId });
	add("user", "第一条 user", u1);
	add("assistant", "第一条回复", live.getBranchPoints()[0]!.options.find((o) => !o.active)!.entryId);
	add("user", "第二条 user", u2);
	add("assistant", "第二条回复", "assistant2");
	const grown = buildBranchTree({
		messages: [{ role: "user", content: [{ type: "text", text: "第一条 user" }] }],
		messageEntryIds: [u1],
		branchPoints: [],
	} as never);
	console.log(`--- client before regrow (stale baseline): points=${grown?.points ?? "-"} line=${grown ? [...grown.line].length : "-"}`);
	const tree = branchTreeFromItems(items as never, points);
	const walk = (way: any, depth = 0): string[] => {
		if (way === undefined) return [];
		const lines = [`${"  ".repeat(depth)}[${way.role}] turn=${way.turn} ${way.label} (entry ${way.entryId}) reply=${way.replyId ?? "-"} branches=${way.branches.length}`];
		for (const branch of way.branches) lines.push(...walk(branch, depth + 1));
		lines.push(...walk(way.next, depth));
		return lines;
	};
	console.log(tree === undefined ? "tree: undefined" : [`tree: currentId=${tree.currentId} points=${tree.points} options=${tree.options}`, ...walk(tree.trunk)].join("\n"));
}


