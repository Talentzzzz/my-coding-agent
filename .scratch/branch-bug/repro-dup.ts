// Repro: switch branch, then send — the optimistic echo duplicates the message.
// Frame order on the wire: branch_changed baseline (chain already holds the new prompt),
// entry, then the loop's echo of the same user message (message_start -> message_end).
import type { AgentMessage } from "@my-agent/agent";
import { reduce, type ViewState } from "../../packages/web/src/state.ts";

function user(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}
function assistant(text: string, timestamp: number): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

function snapshotOf(messages: AgentMessage[], ids: (string | null)[], submitting: boolean) {
	return {
		id: "s1",
		cwd: "C:/tmp",
		createdAt: 0,
		title: "t",
		model: "m",
		thinkingLevel: "off" as const,
		thinkingLevels: ["off"],
		approvals: {},
		allTools: [],
		activeTools: [],
		toolsFollowGlobal: true,
		approvalsFollowGlobal: true,
		messages,
		messageEntryIds: ids,
		branchPoints: [],
		leafId: ids.at(-1) ?? null,
		submitting,
		queued: 0,
		isRetrying: false,
		retryAttempt: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, contextWindow: 0 },
		pendingApprovals: [],
	};
}

let state: ViewState = { items: [], pendingEntries: [], pendingApprovals: [] } as unknown as ViewState;

// 1. The window is on the rewound chain: just user1.
const T1 = 1000, T2 = 2000, T3 = 3000;
state = reduce(state, { type: "baseline", session: snapshotOf([user("第一条", T1)], ["e1"], false) });

// 2. Send. The branch_changed baseline lands first — the chain already holds user2 (T2).
state = reduce(state, { type: "baseline", session: snapshotOf([user("第一条", T1), user("第二条", T2)], ["e1", "e2"], false) });
state = reduce(state, { type: "entry", entryId: "e2", messageTimestamp: T2 });

// 3. The loop echoes the same message: message_start, then message_end.
state = reduce(state, { type: "event", event: { type: "message_start", message: user("第二条", T2) } } as never);
state = reduce(state, { type: "event", event: { type: "message_end", message: user("第二条", T2) } } as never);
state = reduce(state, { type: "event", event: { type: "message_end", message: assistant("回复", T3) } } as never);

const users = state.items.filter((item: any) => item.kind === "message" && item.role === "user");
console.log(`user items: ${users.length}`);
for (const item of users as any[]) console.log(`  [${item.id}] ${item.text} entry=${item.forkEntryId ?? "-"}`);
const line = state.branchTree?.line;
console.log(`branch line size: ${line ? line.size : "-"}`);
const texts = (users as any[]).map((item) => item.text);
const pass =
	users.length === 2 &&
	new Set(texts).size === 2 &&
	(line?.size ?? 0) === 2 &&
	state.branchTree?.currentId === "e2";
console.log(pass ? "PASS" : "FAIL");
