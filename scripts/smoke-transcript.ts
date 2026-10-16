// Transcript smoke: drives the production `TranscriptView` against the shared DOM shim, and checks the
// three properties the deferred draw lives or dies by — that spreading a snapshot over frames draws the
// same thing as drawing it whole, that nothing is rebuilt per frame while it does, and that a frame
// arriving mid-draw supersedes it instead of being overwritten by it later.
//
// Why this file exists: until it did, **nothing in `scripts/` drove `TranscriptView` at all**, so the
// deferred path shipped with no regression cover — and the bug it was written against (a streaming frame
// pruning against a half-drawn set, so every turn was rebuilt every frame, 2000 frames, 4 GB heap) is
// invisible to `npm run check` by construction. `transcript.render` is read as "the immediate path" by
// everything downstream; this is the only place both paths are run side by side.
//
// Nothing reaches the network, so no server and no provider key are needed.
// Run with: node scripts/smoke-transcript.ts
import { TranscriptView } from "../packages/web/src/render/transcript.ts";
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
function makeTranscript(): { host: FakeNode; view: TranscriptView } {
	const host = shim.document.createElement("main") as unknown as FakeNode;
	host.className = "transcript";
	const view = new TranscriptView(host as unknown as HTMLElement, { onUserContext: () => {} });
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

process.stdout.write(failures === 0 ? "\ntranscript ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
