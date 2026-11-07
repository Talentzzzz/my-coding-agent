// How long does the expensive half of a baseline actually take? The baseline is a whole
// SessionSnapshot through JSON.stringify on the server and JSON.parse on the client, so the
// timeout's floor is that cost at whatever a large transcript looks like.
function message(i) {
  return {
    role: i % 3 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `第 ${i} 条消息：${"这是一段用来撑大快照的正文。".repeat(12)}` }],
    timestamp: 1700000000000 + i,
    usage: i % 3 === 0 ? undefined : { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
  };
}
for (const n of [200, 1000, 3000]) {
  const snap = {
    id: "s", workDirAbsPath: "/w", createdAt: 1, title: "t", model: "m", thinkingLevel: "high",
    thinkingLevels: ["off", "low", "high", "max"],
    approvals: { read: false, write: false, edit: false, glob: false, grep: false, bash: false },
    allTools: [], activeTools: [], toolsFollowGlobal: true, approvalsFollowGlobal: true,
    messages: Array.from({ length: n }, (_, i) => message(i)),
    messageEntryIds: Array.from({ length: n }, (_, i) => "e" + i),
    branchPoints: [], leafId: "e1", submitting: false, queued: [], isRetrying: false, retryAttempt: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, contextWindow: 200000 },
    pendingApprovals: [],
  };
  const text = JSON.stringify({ streamId: "s", item: { type: "baseline", session: snap } });
  const start = performance.now();
  let parsed;
  for (let i = 0; i < 5; i++) parsed = JSON.parse(text);
  const parse = (performance.now() - start) / 5;
  const wire = Buffer.byteLength(text);
  // The client also folds it into a view state; the reducer walk is the other per-message cost.
  process.stdout.write(`${n} 条消息: ${(wire / 1024 / 1024).toFixed(2)} MiB, JSON.parse 均值 ${parse.toFixed(1)} ms\n`);
}
