// Ad-hoc transport check：从 mux 上读一份 session 快照，经 HTTP 收下一次 prompt，把 run 喂回来，
// 用一次 abort 请求停掉它，再开一个替代 session——然后证明一次分支移动在完全没有任何东西挂着的
// 情况下活过 reap。
//
//   node scripts/smoke-api.ts
//
// 先启动一台服务器（npm run start -- --workDir .），或用 MY_AGENT_URL 指向一台。无需 provider
// key：预期 run 以一次 provider 错误落定，那仍是一次落定了的 run。那个失败是*可重试*的——拒绝
// 连接——所以默认重试策略会花三次 backoff、约十四秒 run 才落定；下面的 watchdog 是按整个脚本
// （两次 run 加树检查）计的，不是按一次 run，所以它抓的是挂起而不是 backoff。在 settings 里关掉
// `retry` 运行服务器可让它立刻落定。
//
// 有一个检查会写模型列表并放回去，所以若介意一次穿过 `models.json` 的往返，请让服务器以
// MY_AGENT_HOME 指向临时目录运行：
//   $env:MY_AGENT_HOME = "$env:TEMP\my-agent-smoke"; npm run start
const target = new URL(process.env.MY_AGENT_URL ?? "http://127.0.0.1:8080");
const base = target.origin;

/** 当前打开的流正监视的 session。 */
let sessionId = "";
/** 第一条流要求服务器打开的替代 session，供本脚本后半使用。 */
let replacementId: string | undefined;
let failed = false;

const timer = setTimeout(() => {
	fail("timed out waiting for the run to settle");
	process.exit(1);
}, 300_000);

function fail(message: string): void {
	failed = true;
	process.stdout.write(`\nFAIL: ${message}\n`);
}

function pass(message: string): void {
	process.stdout.write(`${message}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function request(method: string, path: string, body?: unknown): Promise<{ status: number; payload: unknown }> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (body !== undefined) headers["content-type"] = "application/json";
	const response = await fetch(`${base}${path}`, {
		method,
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	return { status: response.status, payload: text.length === 0 ? undefined : (JSON.parse(text) as unknown) };
}

// --- The mux ------------------------------------------------------------------------------------

/**
 * 一份来自 mux 的信封：一条逻辑流的帧，或 `streamId: null` 的连接级载荷。
 *
 * 连接级帧——心跳、session 行——不属于本脚本读取的任何 session，所以下面的顺序读取器跳过它们
 * 而不对它们的次序作任何断言：心跳可能在第一份 baseline 之前到达，一行可能在任何时刻到达。
 */
interface Envelope {
	streamId: string | null;
	item?: { type: string; [key: string]: unknown };
	end?: true;
	error?: { message: string };
}

const frames: Envelope[] = [];
const ws = new WebSocket(`${base.replace(/^http/, "ws")}/mux`);
const channelOpen = new Promise<void>((resolve, reject) => {
	ws.addEventListener("open", () => resolve());
	ws.addEventListener("error", () => reject(new Error("the mux connection failed")));
});
ws.addEventListener("message", (event) => {
	frames.push(JSON.parse(String(event.data)) as Envelope);
});

/** 发一个上行帧。命令留在 REST 上；这里仅有的两个动作是 subscribe 与 cancel。 */
function send(frame: { type: string; [key: string]: unknown }): void {
	ws.send(JSON.stringify(frame));
}

/** 已被下面顺序读取器消费的帧。 */
let cursor = 0;

/**
 * 一条 session 流上的下一帧，按到达顺序。
 *
 * 一个游标而非每个 watcher 一个，因为本脚本一次只监视一个 session：一次 watch 消费到返回为止，
// 下一次 watch 从它停下的地方接着来。
 */
async function nextEnvelope(id: string, deadline: number): Promise<Envelope | undefined> {
	for (;;) {
		while (cursor < frames.length) {
			const frame = frames[cursor++]!;
			if (frame.streamId === id) return frame;
		}
		if (Date.now() > deadline) return undefined;
		await sleep(25);
	}
}

/**
 * 等 session 的 run 落定。
 *
 * run 在途时分支不能动——循环向 leaf 追加——所以下面的树检查必须先看到 provider 失败结束。
 * 这也是让下面的 409 成为真实回答、而不是与未落定 prompt 的赛跑的原因。
 */
async function settleRun(id: string, ms = 30_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	for (;;) {
		const read = await request("GET", `/api/sessions/${encodeURIComponent(id)}`);
		const session = (read.payload as { session?: { running?: boolean } }).session;
		if (session?.running === false) return true;
		if (Date.now() > deadline) return false;
		await sleep(100);
	}
}

/** 这些检查会读的快照部分。 */
interface TreeSession {
	leafId: string | null;
	running: boolean;
	messageEntryIds: (string | null)[];
	branchPoints: { entryId: string; anchor: string; options: { entryId: string; label: string; role: string; active: boolean }[] }[];
}

/** 处理被监视 session 流上的一份载荷。watch 应当结束时返回 true。 */
async function handleItem(id: string, item: { type: string; [key: string]: unknown }): Promise<boolean> {
	if (item.type === "baseline") {
		const session = item.session as {
			id: string;
			workDirAbsPath: string;
			model: string;
			thinkingLevel: string;
			approvals: Record<string, boolean>;
			messages: unknown[];
		};
		pass(
			`\nbaseline ${session.id}\n  workDirAbsPath=${session.workDirAbsPath}\n  model=${session.model}\n  thinking=${session.thinkingLevel}\n  approvals=${JSON.stringify(session.approvals)}\n  messages=${session.messages.length}`,
		);

		// 第二条流正是要点：服务器指名了一个 session，本脚本像标签页那样经 mux 挂到它上面。
		// 没有什么可等的了。
		if (replacementId !== undefined && session.id === replacementId) return true;

		// prompt 被收下、从不被 await：这正是 transport 是 HTTP 加一条常驻通道、而不是一个长
		// 请求的全部理由。
		const accepted = await request("POST", `/api/sessions/${encodeURIComponent(session.id)}/messages`, {
			text: "Reply with exactly: transport ok",
		});
		if (accepted.status !== 202) fail(`prompt answered ${accepted.status}, expected 202`);
		else pass("prompt accepted (202)");

		// composer 的模型与等级骑在这个请求体上，而不是各自做一次配置变更，所以一个畸形的
		// 选择必须在这里——消息持久化之前——被拒绝。一个多出一条从未运行过的消息的 session
		// 会是一份"没有发生过的事情"的会话记录。
		const refused = await request("POST", `/api/sessions/${encodeURIComponent(session.id)}/messages`, {
			text: "this must not be stored",
			thinkingLevel: 5,
		});
		if (refused.status !== 400) fail(`a malformed selection answered ${refused.status}, expected 400`);
		else pass("a malformed selection is refused (400)");
		return false;
	}

	if (item.type === "approval_request") {
		const approval = item.request as { toolName: string; toolCallId: string };
		pass(`approval requested for ${approval.toolName}`);
		await request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approval.toolCallId)}`, {
			approved: false,
		});
		return false;
	}

	if (item.type === "event") {
		const event = item.event as {
			type: string;
			delta?: { kind?: string; text?: string };
			message?: { role?: string; errorMessage?: string; stopReason?: string };
		};
		if (process.env.MY_AGENT_TRACE === "1") pass(`  event ${event.type}`);
		// 流式更新现在是 delta：到达的字符，而不是目前为止的消息。
		if (event.type === "message_update" && event.delta?.kind === "text") {
			process.stdout.write(event.delta.text ?? "");
			return false;
		}
		if (event.type === "message_end" && event.message?.stopReason !== undefined) {
			pass(
				`\n[${event.message.role} stop=${event.message.stopReason}${event.message.errorMessage ? ` error=${event.message.errorMessage}` : ""}]`,
			);
			return false;
		}
		if (event.type !== "agent_end") return false;

		// 停止路径，同一 session，一次属于自己的请求。它必须在不触碰流的情况下被应答，这正是
		// 与把命令发给通道的全部差别。
		const stopped = await request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/abort`);
		if (stopped.status !== 200) fail(`abort answered ${stopped.status}, expected 200`);
		else pass("abort accepted (200)");

		// 现在像标签页那样换 session：要一个替代，然后读它的流。birth 即第一条消息（ADR-0021），
		// 请求体带着它——这次 birth 自己的那轮 run 在 201 应答之前就已落定。
		pass("requesting a replacement session");
		const replacement = await request("POST", "/api/sessions", { text: "the replacement conversation" });
		if (replacement.status !== 201) {
			fail(`new session answered ${replacement.status}, expected 201`);
			return true;
		}
		replacementId = (replacement.payload as { sessionId: string }).sessionId;
		return true;
	}

	if (item.type === "error") {
		fail(`server error: ${String(item.message)}`);
		return true;
	}
	return false;
}

/** 为一个 session 打开一条逻辑流，读到它的回合结束为止。 */
async function watch(watching: string): Promise<void> {
	sessionId = watching;
	send({ type: "open", sessionId: watching });
	const deadline = Date.now() + 120_000;
	for (;;) {
		const frame = await nextEnvelope(watching, deadline);
		if (frame === undefined) {
			fail(`the stream for ${watching} went quiet`);
			return;
		}
		if (frame.error !== undefined) {
			fail(`the stream for ${watching} failed: ${frame.error.message}`);
			return;
		}
		if (frame.end === true) {
			pass(`stream ${watching} ended`);
			return;
		}
		if (frame.item !== undefined && (await handleItem(watching, frame.item))) return;
	}
}

async function main(): Promise<void> {
	pass(`target ${base}`);
	try {
		await channelOpen;
		pass("mux channel open");
	} catch (error) {
		fail(String(error));
		process.exit(1);
	}

	const health = await request("GET", "/api/health");
	pass(`health ${health.status} ${JSON.stringify(health.payload)}`);

	const models = await request("GET", "/api/models");
	pass(`models ${models.status} (${(models.payload as { models?: unknown[] }).models?.length ?? 0})`);

	// 本构建注册的工具名，进程级事实（ADR-0020）：端点作答注册表的顺序，六个内置全在。
	const tools = await request("GET", "/api/tools");
	const toolNames = (tools.payload as { tools?: unknown[] }).tools ?? [];
	if (tools.status !== 200) fail(`tool names answered ${tools.status}, expected 200`);
	else if (JSON.stringify(toolNames) !== JSON.stringify(["read", "write", "edit", "glob", "grep", "bash"]))
		fail(`tool names are ${JSON.stringify(toolNames)}, expected the six built-ins`);
	else pass("tools reports the built-in registry in registration order");

	// 一行的名字就是它的身份，所以列表端点是唯一能在撞名抵达磁盘之前抓住它的地方：两行同名会让
		// 每一份指名该名字的会话变得含混。这个名字被刻意取得不会与运行本脚本的人导入的任何
	// 东西相撞。结尾的检查把它找到的放回去，因为这是这里唯一会持久化的请求。
	const existing = (models.payload as { models?: unknown[] }).models ?? [];
	const probe = `smoke-api-${Date.now()}`;
	const row = { name: probe, baseUrl: "http://127.0.0.1:1/v1", id: "smoke-api-model" };
	const saved = await request("PUT", "/api/models", { models: [...existing, row] });
	if (saved.status !== 200) fail(`importing a row answered ${saved.status}, expected 200`);
	else pass("a row with a name of its own is imported");
	const collision = await request("PUT", "/api/models", { models: [...existing, row, { ...row, id: "other" }] });
	if (collision.status !== 400) fail(`a duplicate name answered ${collision.status}, expected 400`);
	else pass("a duplicate name is refused with 400");
	const restored = await request("PUT", "/api/models", { models: existing });
	if (restored.status !== 200) fail(`restoring the model list answered ${restored.status}, expected 200`);
	else pass("and the list it was given is put back");

	// 新 session 打开时的默认值是唯一指名一行的 settings 字段，所以也是唯一能指名一行不存在
	// 的字段。拼错的默认值被拒绝而不被存储：`selectModel` 会回退到第一行，所以一个存下了但错了
	// 的默认值会像一个悄悄什么都没做的偏好。只检查拒绝——收下一个会写 settings 文件，而本脚本
	// 把机器留在它原来的样子。
	const unknownDefault = await request("PATCH", "/api/settings", {
		patch: { model: `${probe}-gone/smoke-api-model` },
	});
	if (unknownDefault.status !== 409) fail(`an unknown default model answered ${unknownDefault.status}, expected 409`);
	else pass("a default model that names no row is refused (409)");

	// birth 即第一条消息（ADR-0021）：body 必带 `text`，缺失即 400——空 body 与缺 text 各一条。
	const bodyless = await request("POST", "/api/sessions");
	if (bodyless.status !== 400) fail(`a bodyless birth answered ${bodyless.status}, expected 400`);
	else pass("a bodyless birth is refused (400)");
	const textless = await request("POST", "/api/sessions", { workDirAbsPath: base });
	if (textless.status !== 400) fail(`a birth with no text answered ${textless.status}, expected 400`);
	else pass("a birth with no text is refused (400)");

	const first = await request("POST", "/api/sessions", { text: "the first conversation" });
	if (first.status !== 201) throw new Error(`could not create a session: ${first.status}`);
	pass(`created ${(first.payload as { sessionId: string }).sessionId}`);

	// 不存在的 session 必须在读取 URL 上是一个 404，而不是一份什么都没有的快照。
	const missing = await request("GET", "/api/sessions/does-not-exist");
	if (missing.status !== 404) fail(`an unknown session answered ${missing.status}, expected 404`);

	// HTTP 上的树，任何时刻都没有东西挂在上头。移动在发生的那一刻就被 store 记录，所以它活过
	// run 之后的 reap——不需要任何流握着 session 的手，而下面的 run 顺带充当了"发送不依赖先
	// 挂上"这条验收边：它的帧无处可去，却照样被记录。birth 的 body 带着自己的第一条消息
	// （ADR-0021），这次 birth run 也照样落定。
	const tree = await request("POST", "/api/sessions", { text: "the conversation to branch" });
	const treeId = (tree.payload as { sessionId: string }).sessionId;

	// prompt 在它的 run 失败之前就被持久化，而失败也确实记录了一条 assistant 消息，所以这里要
	// 分支的消息已经在链上、身后带着一个续接。
	const asked = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/messages`, { text: "branch at this message" });
	if (asked.status !== 202) fail(`a prompt on the session to branch answered ${asked.status}, expected 202`);
	if (!(await settleRun(treeId))) fail("the run never settled, so the branch could not be checked");

	const read = await request("GET", `/api/sessions/${encodeURIComponent(treeId)}`);
	const before = (read.payload as { session: TreeSession }).session;
	const entry = before.messageEntryIds.find((id): id is string => typeof id === "string");
	if (entry === undefined) {
		fail("the session to branch at has no message entry");
	} else {
		const moved = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/branch`, { entryId: entry, descend: false });
		const after = (moved.payload as { session?: TreeSession }).session;
		if (moved.status !== 200) fail(`a branch move answered ${moved.status}, expected 200`);
		else if (after?.leafId !== entry) fail(`the branch landed on ${String(after?.leafId)}, expected ${entry}`);
		else pass("branch move accepted (200), and the leaf is the entry it named");

		if (!Array.isArray(after?.branchPoints)) fail("the snapshot carried no branch points");
		else if (after.branchPoints.length > 0) fail(`one chain reported ${after.branchPoints.length} branch point(s)`);
		else pass("a snapshot reports the branch points it has, none for one chain");

		// 没有任何东西挂着，所以没有任何东西持有这个 session：移动自己的请求是最后一个 hold，
		// host 一落定就关闭——毫秒级，那里不再有宽限期（SSE 流服务过的那个随它们一起走了）。
		// 这个等待是让下面的冷读诚实的原因：仍被 host 的 session 会以同样的活快照作答，证明不了
		// 任何东西。
		await sleep(2_000);

		// 冷读从文件作答，它报告的 leafId 就是移动后的 entry——"因为 leaf 被持久化了"由此变成
		// 可观察的：移动活在文件里，不在某个常驻 Agent 里。若 leaf 只在内存里，被 reap 的 session
		// 会以它文件的最后一条 entry 作答——leaf 记录本身，而不是它指名的 entry。
		const cold = await request("GET", `/api/sessions/${encodeURIComponent(treeId)}`);
		const coldLeaf = (cold.payload as { session: TreeSession }).session.leafId;
		if (coldLeaf !== entry) fail(`the cold read reports leafId ${String(coldLeaf)}, expected the moved ${entry}`);
		else pass("the move survived the reap: a cold read reports the leaf the file recorded");

		// 下一次 prompt 由一个全新的 host 从文件组装，它从记录的位置继续：它写的消息是移动后
		// entry 的孩子，这正是让那个 entry 变成分支点的动作。
		const again = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/messages`, { text: "and another way" });
		if (again.status !== 202) fail(`the second prompt answered ${again.status}, expected 202`);
		if (!(await settleRun(treeId))) fail("the second run never settled");

		const reread = await request("GET", `/api/sessions/${encodeURIComponent(treeId)}`);
		const points = (reread.payload as { session: TreeSession }).session.branchPoints;
		const point = points.find((candidate) => candidate.entryId === entry);
		if (points.length !== 1 || point === undefined) fail(`the entry became ${points.length} branch point(s), not one`);
		else if (point.options.length !== 2) fail(`the branch point has ${point.options.length} options, expected 2`);
		else if (point.options.filter((option) => option.active).length !== 1) fail("no single option is marked active");
		else pass(`the next prompt continued from the moved leaf: ${point.options.map((option) => `${option.role}:${option.label}`).join(" | ")}`);

		// 树属于对话，不属于 leaf 碰巧坐在哪里。倒回到 fork 挂着的那条 entry——第一个问题，页面
		// 的"回到开头"——fork 仍然被报告。链相对的报告在这里会丢掉它，这正是 branch 页面在一次
		// 倒回后只显示半棵树的原因。
		const rewound = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/branch`, { entryId: entry, descend: false });
		const rewoundPoints = (rewound.payload as { session?: TreeSession }).session?.branchPoints ?? [];
		const kept = rewoundPoints.find((candidate) => candidate.entryId === entry);
		if (kept === undefined || kept.options.length !== 2) {
			fail(`after a rewind the fork at ${entry} is ${kept === undefined ? "gone" : `down to ${kept.options.length} options`}`);
		} else if (kept.anchor !== entry) {
			fail(`the fork's card is ${kept.anchor}, expected the entry it hangs off`);
		} else {
			pass("a rewind keeps the forks below it: the tree does not move with the leaf");
		}

		const noEntry = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/branch`, {});
		if (noEntry.status !== 400) fail(`a branch with no entryId answered ${noEntry.status}, expected 400`);
		const unknownEntry = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/branch`, { entryId: "no-such-entry" });
		if (unknownEntry.status !== 409) fail(`a branch at an unknown entry answered ${unknownEntry.status}, expected 409`);
		const unknownSession = await request("POST", "/api/sessions/does-not-exist/branch", { entryId: "x" });
		if (unknownSession.status !== 404) fail(`a branch on an unknown session answered ${unknownSession.status}, expected 404`);

		// 一次没有任何东西在等的审批应答是冲突，不是一次沉默的 no-op：请求被理解并被拒绝。这个
		// session 是 idle 的，所以这里每个 id 都不可应答——且被拒的尝试必须哪儿也没到，run 保持
		// 已落定这一点仅在 REST 面上就确认了它。
		const unknownApproval = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/approvals/no-such-call`, { approved: true });
		if (unknownApproval.status !== 409) fail(`an approval for an unanswerable id answered ${unknownApproval.status}, expected 409`);
		else if (!JSON.stringify(unknownApproval.payload).includes("not a pending approval")) fail(`the 409 body does not say what was refused: ${JSON.stringify(unknownApproval.payload)}`);
		else pass("an approval for an id nothing waits on is refused (409)");

		const fork = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/forks`, { entryId: entry });
		const forkedId = (fork.payload as { sessionId?: string }).sessionId;
		if (fork.status !== 201 || forkedId === undefined) {
			fail(`forking the session to branch answered ${fork.status}`);
		} else {
			const sessions = await request("GET", "/api/sessions");
			const listed = (sessions.payload as { sessions: { id: string; parentId?: string }[] }).sessions.find(
				(session) => session.id === forkedId,
			);
			if (listed?.parentId !== treeId) fail(`the fork lists parentId=${String(listed?.parentId)}, expected ${treeId}`);
			else pass("the listing gives a fork its parent by id, which is what the tree is drawn from");

			// 改名与删除，走行菜单用的同一张面。改名创建一个条目——201——并以它存储的名字作答；
			// 空名在文件听说之前就被拒绝。删除答 200，此后 session 永远是 404。
			const named = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/title`, { title: "改过的名字" });
			if (named.status !== 201) fail(`a rename answered ${named.status}, expected 201`);
			else if ((named.payload as { title?: string }).title !== "改过的名字") fail(`a rename answered ${JSON.stringify(named.payload)}`);
			else pass("a rename is accepted (201) and carries the stored name");
			const blank = await request("POST", `/api/sessions/${encodeURIComponent(treeId)}/title`, { title: "   " });
			if (blank.status !== 400) fail(`a blank rename answered ${blank.status}, expected 400`);
			else pass("a blank name is refused (400)");

			const removed = await request("DELETE", `/api/sessions/${encodeURIComponent(forkedId)}`);
			if (removed.status !== 200) fail(`a delete answered ${removed.status}, expected 200`);
			else pass("a delete is accepted (200)");
			const goneRead = await request("GET", `/api/sessions/${encodeURIComponent(forkedId)}`);
			if (goneRead.status !== 404) fail(`the deleted session answered ${goneRead.status}, expected 404`);
			else pass("and the deleted session is a 404 ever after");
			const again = await request("DELETE", `/api/sessions/${encodeURIComponent(forkedId)}`);
			if (again.status !== 404) fail(`a second delete answered ${again.status}, expected 404`);
			else pass("a second delete is a 404, not a silent no-op");
		}
	}

	await watch((first.payload as { sessionId: string }).sessionId);

	// 走到这里意味着第一条流为了它要求的替代 session 而被放弃。
	if (replacementId === undefined) {
		fail("the first stream ended without a replacement session");
	} else {
		pass(`replacement ${replacementId}`);
		await watch(replacementId);
	}

	ws.close();
	clearTimeout(timer);
	pass(`\n${failed ? "FAILED" : "api ok"}`);
	process.exit(failed ? 1 : 0);
}

await main();
