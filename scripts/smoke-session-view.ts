// Session view smoke：对着共享 DOM shim 驱动生产用的 `SessionView`，检查会话视图的两条
// 绘制路径赖以存活的性质——把快照摊到多帧上画出与整块画出相同的东西、画的过程中每帧不重建任何
// 东西、绘制中途到来的帧以新为准而不是被旧的覆盖、流式 delta 只碰尾部（它自己的条目，而不碰
// 它上面的轮次记账）、以及真相取决于轮或 run 的行——脚注——在移动它们的帧上被重读，即使没有任何
// 条目变化。
//
// 这个文件存在的原因：在它出现之前，**`scripts/` 里没有任何东西驱动过 `SessionView`**，deferred
// 路径上线时没有回归覆盖——而它所针对的 bug（流式帧对着一份半画好的集合做剪枝，于是每个回合
// 每帧都被重建：2000 帧、4 GB 堆）从构造上就对 `npm run check` 不可见。下游的一切都把
// `session-view.render` 读作"立即路径"；这里是唯一把两条路径并排运行的地方。
//
// 流式检查由卡顿 ticket（03）加入：旧路径每个 token 走遍每一条目、为每一个写一条脚注和一条
// meta 行，一项 O(对话长度) 的税，本 smoke 现在通过数 shim 看到的属性写入与节点移动给它定价。
//
// 不触网，无需服务器和 provider key。
// 运行：node scripts/smoke-session-view.ts
import { SessionView } from "../packages/web/src/render/session-view.ts";
import { renderMarkdown } from "../packages/web/src/render/markdown.ts";
import type { Item } from "../packages/web/src/state.ts";
import { installDom, resetWork, work, type FakeNode } from "./dom-shim.ts";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

// ------------------------------------------------------------------ DOM 与视图

/**
 * shim 是与 `smoke-sidebar.ts` 及 `.scratch/window-rework/research/` 下卡顿装置共享的那一份；
 * 它也是这里实现 animation frame 的地方。
 *
 * `shim.frames()` 是让本文件成为可能的全部原因：生产代码用 `requestAnimationFrame` 排程，
 * shim 把那些回调排队而不运行，`frames()` 跑掉排好的那一批。没有它，deferred 绘制永远不会
// 前进，下面的断言就会对着一份从未画出的会话视图通过。
 */
const shim = installDom();

/** 形状与 `main.ts` 建的那个一样的会话视图宿主，外加它的视图。 */
function makeSessionView(onBranch: (entryId: string) => void = () => {}): { host: FakeNode; view: SessionView } {
	const host = shim.document.createElement("main") as unknown as FakeNode;
	host.className = "session-view";
	const view = new SessionView(host as unknown as HTMLElement, { onUserContext: () => {}, onBranch });
	view.trackScroll();
	return { host, view };
}

/**
 * 宿主之下某个类的每一个节点，按文档序。
 *
 * 视图的 DOM 不是这里的被测对象；被测的是*哪些*节点在屏幕上、它们是否只建过一次。用一次遍历
// 读它让本文件不依赖 shim 里 `querySelector` 的属性语法。
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

/** 屏幕上的轮次区块，按序。 */
function turnsOf(host: FakeNode): FakeNode[] {
	return nodesOfClass(host, "turn");
}

/** 一个轮次内的脚注，如果那个轮次有的话。 */
function footOf(turn: FakeNode): FakeNode | undefined {
	return nodesOfClass(turn, "turn-foot")[0];
}

/** 会话视图的文本，按截图会读的方式：屏幕上的一切，深度优先。 */
function textOf(host: FakeNode): string {
	let text = "";
	const walk = (node: FakeNode): void => {
		if (node.children.length === 0) text += node.textContent;
		for (const child of node.children) walk(child);
	};
	walk(host);
	return text;
}

/** 宿主当前持有多少节点，整棵树，OOM 回归需要看到的样子。 */
function countNodes(host: FakeNode): number {
	let count = 1;
	for (const child of host.children) count += countNodes(child);
	return count;
}

// ------------------------------------------------------------------ 会话

/** 一条消息条目，形状与 `state.ts` 交给视图的一致。 */
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
 * 长到需要不止一帧的会话。
 *
 * 重要的是数量而不是内容：`BATCH_ITEMS` 是 24，所以 200 条是九片，而一个能装进一片的会话会把
 // 立即路径测两遍、deferred 路径一遍都测不到。正文长到给 `renderMarkdown` 真活干，那才是绘制
 // 真正花掉的东西。
 */
function conversation(count: number): Item[] {
	return Array.from({ length: count }, (_unused, index) =>
		message(index, `第 ${index} 条消息：段落正文，用来给 renderMarkdown 一点活干。\n\n- 一\n- 二\n`));
}

// ---------------------------------------------------------- 1. 两条路径画出同一个东西

process.stdout.write("\nsession-view：分批画与整块画结果是同一个\n");

{
	const items = conversation(200);

	const immediate = makeSessionView();
	resetWork();
	immediate.view.render(items, false);
	const immediateNodes = work.nodes;

	const deferred = makeSessionView();
	resetWork();
	deferred.view.renderDeferred(items, false);

	// 第一片必须在帧结束之前就在屏幕上——这正是"不在 yield 处起走"的全部意义：一次点击让上一份
	// 会话多显示一帧，正是这项工作要消除的症状。
	check("第一片落在点击这一帧", turnsOf(deferred.host).length > 0, `${turnsOf(deferred.host).length}`);
	check("第一片不是全部", turnsOf(deferred.host).length < items.length, `${turnsOf(deferred.host).length} / ${items.length}`);

	let frames = 0;
	while (frames < 1000 && shim.frames() > 0) frames += 1;

	check("跑完后条数与整块画一致", turnsOf(deferred.host).length === turnsOf(immediate.host).length, `${turnsOf(deferred.host).length} vs ${turnsOf(immediate.host).length}`);
	check("跑完后正文与整块画一致", textOf(deferred.host) === textOf(immediate.host));
	// 唯一一个不测时钟的度量：同一份会话必须花同样多的节点。一个重新解析或重建了任何东西的
	// deferred 绘制会在这里以多余构造的形式现形。
	check("跑完后构造的节点数与整块画一致", work.nodes === immediateNodes, `${work.nodes} vs ${immediateNodes}`);
	// 以及树本身，逐节点：留下某片 DOM 的 deferred 绘制不会多花一次构造（它只建过一次），但仍会
	// 在屏幕上出现两份。
	check("跑完后屏幕上的节点数与整块画一致", countNodes(deferred.host) === countNodes(immediate.host), `${countNodes(deferred.host)} vs ${countNodes(immediate.host)}`);
	check("每一条只被建过一次", turnsOf(deferred.host).every((turn) => turn.created === 1), JSON.stringify(turnsOf(deferred.host).filter((turn) => turn.created !== 1).length));

	// 一次立即绘制必须能收完一次 deferred 绘制——这是两者之间被写明的关系，也是 `render` 取消
	// 队列的原因。
	deferred.view.render(items, false);
	check("整块画把队列清空", deferred.view.stepPending() === false);
	check("整块画之后条数不变", turnsOf(deferred.host).length === items.length, `${turnsOf(deferred.host).length}`);
}

// -------------------------------------------------- 2. 绘制不随帧让树增长

process.stdout.write("\nsession-view：连跑多帧，宿主的孩子数不增长\n");

{
	const items = conversation(200);
	const { host, view } = makeSessionView();
	view.renderDeferred(items, false);

	// OOM 就出在这里：一个流式帧对着 deferred 路径的半画好集合剪枝视图的表，于是每个轮次都像
	// 一个已离开会话的东西那样被重建——而旧的留在了 DOM 里。多帧才暴露它；单帧不暴露。
	const sizes: number[] = [];
	for (let frame = 0; frame < 40; frame += 1) {
		shim.frames();
		sizes.push(countNodes(host));
	}

	// 两条性质，因为任何一条单独都能被一个坏视图满足：树停止增长，且屏幕上的轮次正是会话有的
	// 那些——不多，不少。
	check("最后一帧之后树不再变大", sizes[sizes.length - 1] === sizes[sizes.length - 2], `${sizes[sizes.length - 2]} -> ${sizes[sizes.length - 1]}`);
	check("条数就是会话的条数", turnsOf(host).length === items.length, `${turnsOf(host).length} vs ${items.length}`);
	check("多帧之后没有一条被重建", turnsOf(host).every((turn) => turn.created === 1), `${turnsOf(host).filter((turn) => turn.created !== 1).length} 条被重建`);

	// 以及会话*在移动*时的同一件事：delta 在帧与帧之间到达，这正是崩溃的形状——一个流式帧落在
	// 半画好的 deferred 帧上，取消绘制再重新进入 40 次。树不得随这些帧的数目增长。
	const streaming = makeSessionView();
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

// -------------------------------------- 3. 绘制中途到来的帧以新为准

process.stdout.write("\nsession-view：画到一半来了新的帧，以新的为准\n");

{
	const items = conversation(200);
	const { host, view } = makeSessionView();
	view.renderDeferred(items, false);
	// 有意先不跑帧。一帧能画几片是预算的事，不是本文件的：在这些尺寸下，一台快的机器能在第一帧
	// 里画完整份会话，所以"画了一帧后还剩一半"这类断言会在这里通过、在慢机器上失败。不依赖机器
	// 的是第一片恰好一片——上面已检查。
	check("这时确实还没画完", turnsOf(host).length < items.length, `${turnsOf(host).length} / ${items.length}`);

	// 一份只留前 30 条的快照——一次分支切换、一次 compaction、一个 `session_gone`。半画好的那些
	// 片之后不得回来：deferred 生产者仍持有*旧的*数组，若它恢复就会重画窗口已经离开的那份会话。
	const shorter = items.slice(0, 30);
	view.render(shorter, false);
	check("新的帧画完了", turnsOf(host).length === 30, `${turnsOf(host).length}`);

	let frames = 0;
	while (frames < 100 && shim.frames() > 0) frames += 1;
	check("旧的批次没有回来", turnsOf(host).length === 30, `${turnsOf(host).length}`);
	check("屏幕上那 30 条各建了一次", turnsOf(host).every((turn) => turn.created === 1), `${turnsOf(host).filter((turn) => turn.created !== 1).length} 条被重建`);
}

// ----------------------------------------------- 4. 流式一帧只碰尾部

process.stdout.write("\nsession-view：流式一帧只碰尾部\n");

{
	const items = conversation(200);
	const { host, view } = makeSessionView();
	view.render(items, true);

	const runtime = nodesOfClass(host, "runtime");
	check("运行中只有一条计时行", runtime.length === 1, `${runtime.length}`);

	/**
	 * 回答的尾部一帧一帧长出来：那正是曾经让每个轮次付一次脚注补丁、让滚动容器付一次强制布局
	 * 的形状。
	 */
	let current = items;
	resetWork();
	const FRAMES = 100;
	for (let frame = 1; frame <= FRAMES; frame += 1) {
		const last = current[current.length - 1] as Extract<Item, { kind: "message" }>;
		current = [...current.slice(0, -1), { ...last, streaming: true, text: `${last.text}新的一帧。` }];
		view.render(current, true);
	}

	// 旧路径给每个 assistant 轮写一个隐藏属性、每个 user 轮写一个——每帧、每一行、哪怕那一行
	// 的条目毫无变化（实测 200 条会话上这 100 帧共 20,000 次写）。一阵 delta 因此要付 O(对话
	// 长度) 的属性写入；只碰尾部的路径每帧付几次。
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

	// 没有新东西的一帧必须什么都不碰：本趟之前，流式计时器的节点在每次 delta 上都被挪到末尾，
	// 哪怕它已经在那里。
	resetWork();
	view.render(current, true);
	check("同一份 items 再画一次不碰 DOM", work.appends === 0 && work.attrs === 0 && work.nodes === 0, JSON.stringify(work));
}

// ------------------------------------------- 5. 脚注跟着轮与运行走，不跟着 token 走

process.stdout.write("\nsession-view：脚注跟着轮与运行走，不跟着 token 走\n");

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

	const { host, view } = makeSessionView();
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
		const { host: resumedHost, view: resumed } = makeSessionView();
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

process.stdout.write("\nsession-view：分支按钮在最后一条回答之外都出现\n");

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
	const { host, view } = makeSessionView((entryId) => {
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

process.stdout.write("\nsession-view：流式尾块只补不删\n");

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

process.stdout.write("\nsession-view：滚动读数分帧、贴底是一个类\n");

{
	const { host, view } = makeSessionView();
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

process.stdout.write(failures === 0 ? "\nsession-view ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;