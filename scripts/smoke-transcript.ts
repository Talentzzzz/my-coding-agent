// Transcript smoke: drives the production `TranscriptView` against the shared DOM shim, and checks the
// properties the transcript's two draw paths live or die by — that spreading a snapshot over frames
// draws the same thing as drawing it whole, that nothing is rebuilt per frame while it does, that a
// frame arriving mid-draw supersedes it instead of being overwritten by it later, that a streaming
// delta touches only the tail (its own item, and not the round bookkeeping above it), and that the
// rows whose truth depends on a round or a run — the footers — are re-read on the frames that move
// them even when no item changed.
//
// Why this file exists: until it did, **nothing in `scripts/` drove `TranscriptView` at all**, so the
// deferred path shipped with no regression cover — and the bug it was written against (a streaming frame
// pruning against a half-drawn set, so every turn was rebuilt every frame, 2000 frames, 4 GB heap) is
// invisible to `npm run check` by construction. `transcript.render` is read as "the immediate path" by
// everything downstream; this is the only place both paths are run side by side.
//
// The streaming checks were added by the jank ticket (03): the old path walked every item per token and
// wrote a footer and a meta row for each one, an O(conversation) tax that this smoke now prices by
// counting the attribute writes and node moves the shim sees.
//
// Nothing reaches the network, so no server and no provider key are needed.
// Run with: node scripts/smoke-transcript.ts
import { TranscriptView } from "../packages/web/src/render/transcript.ts";
import { renderMarkdown } from "../packages/web/src/render/markdown.ts";
import type { Item } from "../packages/web/src/state.ts";
import { installDom, resetWork, work, type FakeNode } from "./dom-shim.ts";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

// ------------------------------------------------------------------ the DOM and the view

/**
 * The shim is the one copy shared with `smoke-sidebar.ts` and the jank harness under
 * `.scratch/window-rework/research/`; it is also what implements animation frames here.
 *
 * `shim.frames()` is what makes this file possible at all: production code schedules with
 * `requestAnimationFrame`, the shim queues those callbacks instead of running them, and `frames()` runs
 * the queued batch. Without it the deferred draw would never advance and the assertions below would pass
 * against a transcript that was never drawn.
 */
const shim = installDom();

/** A transcript host shaped like the one `main.ts` builds, plus its view. */
function makeTranscript(onBranch: (entryId: string) => void = () => {}): { host: FakeNode; view: TranscriptView } {
	const host = shim.document.createElement("main") as unknown as FakeNode;
	host.className = "transcript";
	const view = new TranscriptView(host as unknown as HTMLElement, { onUserContext: () => {}, onBranch });
	view.trackScroll();
	return { host, view };
}

/**
 * Every node of a class under the host, in document order.
 *
 * The view's DOM is not under test here; what is under test is *which* nodes are on screen and whether
 * they were built once. Reading that off a walk keeps this file independent of `querySelector`'s
 * attribute syntax in the shim.
 */
function nodesOfClass(root: FakeNode, className: string): FakeNode[] {
	const found: FakeNode[] = [];
	const walk = (node: FakeNode): void => {
		if (node.className.split(/\s+/).includes(className)) found.push(node);
		for (const child of node.children) walk(child);
	};
	walk(root);
	return found;
}

/** The turn sections on screen, in order. */
function turnsOf(host: FakeNode): FakeNode[] {
	return nodesOfClass(host, "turn");
}

/** The footer inside one turn, when that turn has one. */
function footOf(turn: FakeNode): FakeNode | undefined {
	return nodesOfClass(turn, "turn-foot")[0];
}

/** The transcript's text, read the way a screenshot would: everything on screen, depth first. */
function textOf(host: FakeNode): string {
	let text = "";
	const walk = (node: FakeNode): void => {
		if (node.children.length === 0) text += node.textContent;
		for (const child of node.children) walk(child);
	};
	walk(host);
	return text;
}

/** How many nodes the host currently holds, the whole tree, as the OOM regression needs to see it. */
function countNodes(host: FakeNode): number {
	let count = 1;
	for (const child of host.children) count += countNodes(child);
	return count;
}

// ------------------------------------------------------------------ conversations

/** One message item, shaped the way `state.ts` hands them to the view. */
function message(index: number, text = `第 ${index} 条消息`): Item {
	return {
		kind: "message",
		id: `m${index}`,
		role: index % 2 === 0 ? "user" : "assistant",
		text,
		notice: false,
		streaming: false,
	};
}

/**
 * A conversation long enough to need more than one frame.
 *
 * The count is the point rather than the content: `BATCH_ITEMS` is 24, so 200 items is nine slices, and a
 * conversation that fitted in one slice would test the immediate path twice and the deferred path never.
 * The bodies are long enough to give `renderMarkdown` real work, which is what the draw actually costs.
 */
function conversation(count: number): Item[] {
	return Array.from({ length: count }, (_unused, index) =>
		message(index, `第 ${index} 条消息：段落正文，用来给 renderMarkdown 一点活干。\n\n- 一\n- 二\n`));
}

// ---------------------------------------------------------- 1. both paths draw the same thing

process.stdout.write("\ntranscript：分批画与整块画结果是同一个\n");

{
	const items = conversation(200);

	const immediate = makeTranscript();
	resetWork();
	immediate.view.render(items, false);
	const immediateNodes = work.nodes;

	const deferred = makeTranscript();
	resetWork();
	deferred.view.renderDeferred(items, false);

	// The first slice has to be on screen before the frame ends — that is the whole point of not
	// starting the walk at a `yield`: a click that showed the previous conversation for one more frame
	// is the symptom this work exists to remove.
	check("第一片落在点击这一帧", turnsOf(deferred.host).length > 0, `${turnsOf(deferred.host).length}`);
	check("第一片不是全部", turnsOf(deferred.host).length < items.length, `${turnsOf(deferred.host).length} / ${items.length}`);

	let frames = 0;
	while (frames < 1000 && shim.frames() > 0) frames += 1;

	check("跑完后条数与整块画一致", turnsOf(deferred.host).length === turnsOf(immediate.host).length, `${turnsOf(deferred.host).length} vs ${turnsOf(immediate.host).length}`);
	check("跑完后正文与整块画一致", textOf(deferred.host) === textOf(immediate.host));
	// The one measurement that is not the clock: the same conversation must have cost the same nodes.
	// A deferred draw that re-parsed or rebuilt anything would show up here as extra constructions.
	check("跑完后构造的节点数与整块画一致", work.nodes === immediateNodes, `${work.nodes} vs ${immediateNodes}`);
	// And the tree itself, node for node: a deferred draw that left a slice's DOM behind would not cost
	// an extra construction (it was built once) but would still be on screen twice over.
	check("跑完后屏幕上的节点数与整块画一致", countNodes(deferred.host) === countNodes(immediate.host), `${countNodes(deferred.host)} vs ${countNodes(immediate.host)}`);
	check("每一条只被建过一次", turnsOf(deferred.host).every((turn) => turn.created === 1), JSON.stringify(turnsOf(deferred.host).filter((turn) => turn.created !== 1).length));

	// An immediate draw must be able to finish a deferred one — that is the documented relationship
	// between the two, and the reason `render` cancels the queue.
	deferred.view.render(items, false);
	check("整块画把队列清空", deferred.view.stepPending() === false);
	check("整块画之后条数不变", turnsOf(deferred.host).length === items.length, `${turnsOf(deferred.host).length}`);
}

// -------------------------------------------------- 2. a draw does not grow the tree per frame

process.stdout.write("\ntranscript：连跑多帧，宿主的孩子数不增长\n");

{
	const items = conversation(200);
	const { host, view } = makeTranscript();
	view.renderDeferred(items, false);

	// The OOM was here: a streaming frame pruned the view's tables against the deferred path's
	// half-drawn set, so every turn looked like one that had left the conversation and was rebuilt —
	// and the old ones were left in the DOM. Frames are what expose it; one frame does not.
	const sizes: number[] = [];
	for (let frame = 0; frame < 40; frame += 1) {
		shim.frames();
		sizes.push(countNodes(host));
	}

	// Two properties, because either alone can be satisfied by a broken view: the tree stops growing,
	// and the turns on screen are the ones the conversation has — not more, not fewer.
	check("最后一帧之后树不再变大", sizes[sizes.length - 1] === sizes[sizes.length - 2], `${sizes[sizes.length - 2]} -> ${sizes[sizes.length - 1]}`);
	check("条数就是会话的条数", turnsOf(host).length === items.length, `${turnsOf(host).length} vs ${items.length}`);
	check("多帧之后没有一条被重建", turnsOf(host).every((turn) => turn.created === 1), `${turnsOf(host).filter((turn) => turn.created !== 1).length} 条被重建`);

	// And the same thing while the conversation is *moving*: deltas arrive between frames, which is the
	// shape that crashed — a streaming frame landing on a half-drawn deferred one, cancelling the draw
	// and re-entering it 40 times over. The tree must not grow with the number of those frames.
	const streaming = makeTranscript();
	const growth: number[] = [];
	for (let frame = 0; frame < 40; frame += 1) {
		streaming.view.renderDeferred(items, false);
		shim.frames();
		streaming.view.render(items, true);
		growth.push(countNodes(streaming.host));
	}
	check("流式帧夹在分批之间也不长树", growth[growth.length - 1] === growth[growth.length - 2], `${growth[growth.length - 2]} -> ${growth[growth.length - 1]}`);
	check("流式帧之后条数仍然对", turnsOf(streaming.host).length === items.length, `${turnsOf(streaming.host).length} vs ${items.length}`);
	check("流式帧之后没有一条被重建", turnsOf(streaming.host).every((turn) => turn.created === 1), `${turnsOf(streaming.host).filter((turn) => turn.created !== 1).length} 条被重建`);
}

// -------------------------------------- 3. a frame arriving mid-draw supersedes the deferred one

process.stdout.write("\ntranscript：画到一半来了新的帧，以新的为准\n");

{
	const items = conversation(200);
	const { host, view } = makeTranscript();
	view.renderDeferred(items, false);
	// Deliberately no frame is run first. How many slices a frame gets is the budget's call, not this
	// file's: at these sizes a quick machine can finish the whole conversation inside the first frame, so
	// an assertion of the form "one frame in, the draw is still half done" would pass here and fail on a
	// slower one. What is not machine-dependent is that the first slice is one slice — checked above.
	check("这时确实还没画完", turnsOf(host).length < items.length, `${turnsOf(host).length} / ${items.length}`);

	// A snapshot that dropped everything but the first 30 items — a branch switch, a compaction, a
	// `session_gone`. The half-drawn slices must not come back afterwards: the deferred producer is
	// still holding the *old* array, and if it resumed it would redraw the conversation the window left.
	const shorter = items.slice(0, 30);
	view.render(shorter, false);
	check("新的帧画完了", turnsOf(host).length === 30, `${turnsOf(host).length}`);

	let frames = 0;
	while (frames < 100 && shim.frames() > 0) frames += 1;
	check("旧的批次没有回来", turnsOf(host).length === 30, `${turnsOf(host).length}`);
	check("屏幕上那 30 条各建了一次", turnsOf(host).every((turn) => turn.created === 1), `${turnsOf(host).filter((turn) => turn.created !== 1).length} 条被重建`);
}

// ----------------------------------------------- 4. a streaming frame touches only the tail

process.stdout.write("\ntranscript：流式一帧只碰尾部\n");

{
	const items = conversation(200);
	const { host, view } = makeTranscript();
	view.render(items, true);

	const runtime = nodesOfClass(host, "runtime");
	check("运行中只有一条计时行", runtime.length === 1, `${runtime.length}`);

	/**
	 * The answer's tail growing, one frame at a time: the shape that used to cost every turn a
	 * footer patch and the scroll container a forced layout.
	 */
	let current = items;
	resetWork();
	const FRAMES = 100;
	for (let frame = 1; frame <= FRAMES; frame += 1) {
		const last = current[current.length - 1] as Extract<Item, { kind: "message" }>;
		current = [...current.slice(0, -1), { ...last, streaming: true, text: `${last.text}新的一帧。` }];
		view.render(current, true);
	}

	// The old path wrote one hidden attribute per assistant turn and one per user turn — every
	// frame, for every row whose item had not changed at all (20,000 writes over these 100 frames on
	// 200 items, measured). A burst of deltas therefore cost O(conversation) attribute writes; the
	// tail-only path costs a couple per frame.
	process.stdout.write(
		`     增长 ${FRAMES} 帧：属性写入 ${work.attrs}，新建节点 ${work.nodes}，DOM 移动 ${work.appends}（200 条会话）\n`,
	);
	check(
		"增长帧只改最后一条",
		work.attrs < FRAMES * 8,
		`${work.attrs} 次属性写入 / ${FRAMES} 帧（旧路径 ${FRAMES * items.length} 次）`,
	);
	check("增长帧不为整段会话建节点", work.nodes < FRAMES * 4, `${work.nodes}`);
	check("条数没变", turnsOf(host).length === items.length, `${turnsOf(host).length} vs ${items.length}`);
	check(
		"计时行自始至终是同一个节点",
		nodesOfClass(host, "runtime")[0] === runtime[0] && runtime[0]!.created === 1,
	);

	// A frame with nothing new must touch nothing at all: the streaming timer's node was moved to
	// the end on every delta before this pass, even when it was already there.
	resetWork();
	view.render(current, true);
	check("同一份 items 再画一次不碰 DOM", work.appends === 0 && work.attrs === 0 && work.nodes === 0, JSON.stringify(work));
}

// ------------------------------------------- 5. footers are re-read when a run, not a token, moves

process.stdout.write("\ntranscript：脚注跟着轮与运行走，不跟着 token 走\n");

{
	/** One message item with the two fields a footer reads. */
	function said(
		id: string,
		role: string,
		timestamp: number,
		text: string,
		streaming: boolean,
	): Extract<Item, { kind: "message" }> {
		return { kind: "message", id, role, timestamp, text, notice: false, streaming };
	}

	const at = Date.now() - 100;
	const question = said("u1", "user", at, "问题", false);
	const first = said("a1", "assistant", at + 500, "第一段回答", false);
	// A stamp far past the watched run, so the two durations cannot be confused: the observed one is
	// "now minus the user message", about 0.1s, while the stamps would read five seconds.
	const second = said("a2", "assistant", at + 5_000, "第二段回答", true);
	const settledSecond = { ...second, streaming: false };

	const { host, view } = makeTranscript();
	view.render([question, first], false);
	const firstTurn = turnsOf(host)[1]!;
	check("一轮的答案带着脚注", footOf(firstTurn)?.hidden === false);

	// A second answer opening in the same round takes the footer's seat from the first.
	view.render([question, first, second], true);
	check("同轮的更晚答案接管脚注", footOf(firstTurn)?.hidden === true);
	const secondTurn = turnsOf(host)[2]!;
	check("还在流的答案不显示脚注", footOf(secondTurn)?.hidden === true);

	// `message_end` settles the item while the loop is still flagged streaming, and `agent_end` later
	// flips only that flag — no item changes on that frame at all. The settled footer has to be drawn
	// from the observation recorded on it, not from the persisted stamps.
	const finished = [question, first, settledSecond];
	view.render(finished, true);
	view.render(finished, false);
	const settled = footOf(secondTurn)!;
	check("运行结束后脚注出现", settled.hidden === false);
	check("脚注带用时", textOf(settled).includes("用时"), textOf(settled));
	check("计时行随运行结束退场", nodesOfClass(host, "runtime").length === 0);

	// The observed run happened just now, so the chip reads a fraction of a second rather than the
	// five seconds the persisted stamps would claim.
	check("用时读的是观察值", /用时 \d\.\ds/.test(textOf(settled)), textOf(settled));

	// A snapshot that arrives mid-run — a reconnect, or a window opened onto a session that is
	// already streaming — is drawn by the deferred path. Its round facts have to outlive that draw:
	// the deltas that follow are delta frames, and a delta frame trusts the index the last draw left
	// behind, not a fresh walk. A deferred draw that forgot to publish it left the answer without a
	// round, so the footer never appeared and the ticking line had no start seat.
	{
		const { host: resumedHost, view: resumed } = makeTranscript();
		resumed.renderDeferred([question, second], true);
		const grown = { ...second, text: `${second.text}，还在写` };
		resumed.render([question, grown], true);
		resumed.render([question, { ...grown, streaming: false }], false);
		const resumedAnswer = turnsOf(resumedHost)[1]!;
		check("中途接上的快照，结束后脚注照样出现", footOf(resumedAnswer)?.hidden === false, textOf(resumedAnswer));
		check("中途接上的快照，用时也读的是观察值", /用时 \d\.\ds/.test(textOf(footOf(resumedAnswer)!)), textOf(resumedAnswer));
	}
}

// ---------------------------------------------- 6. the fork sits beside copy, everywhere but the leaf

process.stdout.write("\ntranscript：分支按钮在最后一条回答之外都出现\n");

{
	/** One message item with the fields a footer and the fork read. */
	function said(
		id: string,
		role: string,
		timestamp: number,
		text: string,
		streaming: boolean,
		forkEntryId?: string,
	): Extract<Item, { kind: "message" }> {
		const item: Extract<Item, { kind: "message" }> = {
			kind: "message",
			id,
			role,
			timestamp,
			text,
			notice: false,
			streaming,
		};
		if (forkEntryId !== undefined) item.forkEntryId = forkEntryId;
		return item;
	}

	const at = Date.now() - 100;
	const question = said("u1", "user", at, "问题", false);
	const first = said("a1", "assistant", at + 500, "第一段回答", false, "e1");
	const next = said("u2", "user", at + 1_000, "接着问", false);
	const second = said("a2", "assistant", at + 1_500, "第二段回答", false, "e2");
	// The same answer, caught mid-arrival: the footer is not drawn at all, but the fork on the
	// answer *above* it must still refuse a press while the loop is writing to the tree.
	const secondLive = { ...second, streaming: true };

	let picked = "";
	const { host, view } = makeTranscript((entryId) => {
		picked = entryId;
	});

	view.render([question, first], false);
	const firstFoot = footOf(turnsOf(host)[1]!)!;
	const actions = nodesOfClass(firstFoot, "turn-copy");
	check("脚注里是复制 + 分支两个图标", actions.length === 2, `${actions.length}`);
	check("最底部的回答没有分支按钮", actions[1]!.hidden === true);

	// A later answer takes the leaf away from the first one, which is what makes it forkable.
	view.render([question, first, next, second], false);
	const firstActions = nodesOfClass(footOf(turnsOf(host)[1]!)!, "turn-copy");
	check("后面有回答之后，上一条的分支按钮出现", firstActions[1]!.hidden === false);
	const secondActions = nodesOfClass(footOf(turnsOf(host)[3]!)!, "turn-copy");
	check("新的最后一条回答仍然没有", secondActions[1]!.hidden === true);
	firstActions[1]!.click();
	check("按下去带着这条回答的 entry", picked === "e1", picked);

	// A run in flight moves the leaf; the fork is refused rather than looking pressable.
	view.render([question, first, next, secondLive], true);
	const blocked = nodesOfClass(footOf(turnsOf(host)[1]!)!, "turn-copy")[1]!;
	check("运行中分支按钮被禁用", blocked.disabled === true);
	check("运行中说明原因", blocked.title.includes("等它结束"), blocked.title);

	view.render([question, first, next, second], false);
	const unblocked = nodesOfClass(footOf(turnsOf(host)[1]!)!, "turn-copy")[1]!;
	check("运行结束后重新可用", unblocked.disabled === false);
}

// ------------------------------------------- 7. the streaming tail is patched, not rebuilt

process.stdout.write("\ntranscript：流式尾块只补不删\n");

{
	const hostOf = (): { root: FakeNode; body: HTMLElement } => {
		const root = shim.document.createElement("div") as unknown as FakeNode;
		return { root, body: root as unknown as HTMLElement };
	};

	// The shape the ticket measured: one paragraph that grows to thousands of characters. Every
	// frame after the first must cost no node at all, and the paragraph on screen must be the very
	// element the first frame built.
	{
		const { root, body } = hostOf();
		const opening = "这是一整段会一直变长的回答。";
		let state = renderMarkdown(body, opening);
		const paragraph = root.lastElementChild!;
		resetWork();
		let text = opening;
		for (let frame = 0; frame < 100; frame += 1) {
			text += "又长了一点。";
			state = renderMarkdown(body, text, state);
		}
		check("长段落：段落节点自始至终是同一个", root.lastElementChild === paragraph);
		check("长段落：100 个增长帧不建任何节点", work.nodes === 0, `${work.nodes}`);
		check("长段落：文字拼回原文", root.lastElementChild!.textContent === text);
		check("长段落：仍然只有一个块", root.children.length === 1, `${root.children.length}`);

		// A replacement is not growth: the block may keep its kind and count and still say something
		// else, so the element is rebuilt rather than patched against text that no longer prefixes.
		state = renderMarkdown(body, "换了一段完全不同的文字。", state);
		check("改写：旧文本不残留", root.lastElementChild!.textContent === "换了一段完全不同的文字。", root.lastElementChild!.textContent);
	}

	// A growing fenced block, including its copy control: the button must read the element at click
	// time, because the element it was built with keeps growing in place. The fence stays open until
	// the end, which is the shape a stream really has — inserting a line before the closer would be a
	// rewrite, and a rewrite is the path that re-makes the block.
	{
		const { root, body } = hostOf();
		let state = renderMarkdown(body, "```ts\nconst a = 1;");
		const block = root.lastElementChild!;
		const code = block.lastElementChild!.firstElementChild!;
		resetWork();
		state = renderMarkdown(body, "```ts\nconst a = 1;\nconst b = 2;", state);
		check("代码块：外框没有换", root.lastElementChild === block);
		check("代码块：新增一行不重建块", work.nodes === 0, `${work.nodes}`);
		check("代码块：文字是新的两行", code.textContent === "const a = 1;\nconst b = 2;", JSON.stringify(code.textContent));
		state = renderMarkdown(body, "```ts\nconst a = 1;\nconst b = 2;\n```", state);
		check("代码块：闭合之后外框仍然没换", root.lastElementChild === block);
		check("代码块：闭合之后文字不变", code.textContent === "const a = 1;\nconst b = 2;", JSON.stringify(code.textContent));

		let copied = "";
		const clipboard = navigator.clipboard;
		const write = clipboard.writeText;
		clipboard.writeText = async (value: string): Promise<void> => {
			copied = value;
		};
		nodesOfClass(block, "code-copy")[0]!.click();
		await new Promise((done) => setTimeout(done, 0));
		check("复制按钮读的是当下的代码", copied === "const a = 1;\nconst b = 2;", JSON.stringify(copied));
		clipboard.writeText = write;
	}

	// A patch-style code block: growth adds spans, and the line that was last stops being last.
	{
		const { root, body } = hostOf();
		let state = renderMarkdown(body, "```diff\n@@ -1 +1 @@\n-old\n+new");
		const code = root.lastElementChild!.lastElementChild!.firstElementChild!;
		check("diff：先画出三行", code.children.length === 3, `${code.children.length}`);
		resetWork();
		state = renderMarkdown(body, "```diff\n@@ -1 +1 @@\n-old\n+new\n+extra", state);
		check("diff：只追加了新的那一行", work.nodes === 1, `${work.nodes}`);
		check("diff：现在是四行", code.children.length === 4, `${code.children.length}`);
		check("diff：拼回原文", code.textContent === "@@ -1 +1 @@\n-old\n+new\n+extra", JSON.stringify(code.textContent));
	}

	// A list grows item by item; the existing items are not rebuilt.
	{
		const { root, body } = hostOf();
		let state = renderMarkdown(body, "- 一\n- 二");
		const list = root.lastElementChild!;
		resetWork();
		state = renderMarkdown(body, "- 一\n- 二\n- 三", state);
		check("列表：列表节点没有换", root.lastElementChild === list);
		check("列表：现在是三项", list.children.length === 3, `${list.children.length}`);
		check("列表：新项的文字", list.children[2]!.textContent === "三", list.children[2]!.textContent);
		check("列表：旧项没有被重建", list.children[0]!.created === 1 && list.children[1]!.created === 1);
	}

	// An inline marker that closes changes how the paragraph splits: the fast append path must stay
	// off it, and the rebuilt children must be the formatted text rather than the literal markers.
	{
		const { root, body } = hostOf();
		let state = renderMarkdown(body, "**粗");
		const paragraph = root.lastElementChild!;
		resetWork();
		state = renderMarkdown(body, "**粗体", state);
		check("未收口的标记：段落没有重建", root.lastElementChild === paragraph);
		check("未收口的标记：增长不建节点", work.nodes === 0, `${work.nodes}`);
		state = renderMarkdown(body, "**粗体**", state);
		check("收口的行内标记：文字正确", root.lastElementChild!.textContent === "粗体", root.lastElementChild!.textContent);
		check("收口的行内标记：星号没有留下", !root.lastElementChild!.textContent.includes("*"), root.lastElementChild!.textContent);
	}
}

// ------------------------------------ 8. scroll readings are deferred, pinned is a class

process.stdout.write("\ntranscript：滚动读数分帧、贴底是一个类\n");

{
	const { host, view } = makeTranscript();
	host.scrollHeight = 1_000;
	host.clientHeight = 100;
	host.scrollTop = 900;
	view.scrollToBottom();
	check("贴底时 wears pinned", host.className.split(/\s+/).includes("pinned"), host.className);

	// A scroll away is a write to this side and a read of layout to the other; the read waits for
	// the frame, so nothing has changed until one runs.
	host.scrollTop = 0;
	host.dispatch("scroll");
	check("滚动事件本身还没读数", view.following() && host.className.split(/\s+/).includes("pinned"));
	shim.frames();
	check("下一帧读出已经离开底部", !view.following(), host.className);
	check("不再跟随就摘掉 pinned", !host.className.split(/\s+/).includes("pinned"), host.className);

	host.scrollTop = 920;
	host.dispatch("scroll");
	shim.frames();
	check("回到附近就读作跟随", view.following(), host.className);
	check("跟随重新戴上 pinned", host.className.split(/\s+/).includes("pinned"), host.className);

	// Many events, one reading: only the position the last event left can decide anything, and the
	// reading that runs after the burst is the one that sees it.
	host.scrollTop = 0;
	host.dispatch("scroll");
	host.dispatch("scroll");
	host.scrollTop = 900;
	host.dispatch("scroll");
	shim.frames();
	check("一串滚动事件按最后一个位置读", view.following(), host.className);
}

process.stdout.write(failures === 0 ? "\ntranscript ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;