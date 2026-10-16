/**
 * switch-paint-probe —— 把「切换会话」的第一笔绘制拆成两半量。
 *
 * 04 号的量具（`../../../window-rework/research/jank-harness.ts`）量出切换会话 84% 的同步时间在
 * `renderMarkdown` 上，而那是**一帧画完**的价：`paint` 那一列在 500×4000 时是 161 ms，主线程在那
 * 161 ms 里不重绘、不响应，用户看到的就是「点了没反应」。
 *
 * 05 号把这一笔改成 `TranscriptView.renderDeferred()`：第一批（`BATCH_ITEMS` 条）落在点击这一帧，
 * 剩下的每帧一批。这个探针量四样东西，都是同一把尺子、同一批数据：
 *
 *   sync            旧的整块画法：`render()` 一次画完，主线程被占住的时长
 *   first           新的第一批：点击到「看得见新会话」之间那段同步时间
 *   peak            新的最坏一批：任何一帧最多占住主线程多久
 *   total           新的全部分批画完（**一段连续测量**，与 `sync` 的账要能对上）
 *
 * `total` 的记法是这里唯一一处**刻意不用逐帧计时**的地方，理由写在第 104 行附近：逐帧那一套会
 * 把一个"步"里跑的多个批次只算一个批次的时间，于是 `total` 系统性地偏小（实测 0.4～0.6x 于
 * `sync`），而同一件事只要连续测就是 1.0x。**一帧一步不是这里的语义**——`Drain.step()` 的预算是
 * 4 ms、闸门在步与步之间看，所以一步跑几批是实现细节。
 *
 * 跑法：
 *   node .scratch/window-repair/research/switch-paint-probe.ts
 *   SWITCH_RUNS=3 node .scratch/window-repair/research/switch-paint-probe.ts   # 冒烟
 *
 * 两个诚实限度，与量具那套同源：
 *
 * 1. **绝对毫秒不是真实帧时间**（shim 不是浏览器，没有布局与绘制）。可靠的是**同一把尺子下的比值**，
 *    尤其是 `first/sync` 与 `peak/sync`。
 * 2. **一帧在这里是 `shim.frames()` 跑一批**，不是浏览器的 vsync。所以 `peak` 说的是「一步的算法
 *    代价」，不是一个真实帧的墙钟时间；真实帧还要加上解析后的样式、布局与绘制。
 */
import { writeFileSync } from "node:fs";
import { installDom, asElement, resetWork, work, type FakeNode } from "../../../scripts/dom-shim.ts";
import { TranscriptView } from "../../../packages/web/src/render/transcript.ts";
import { initialState, reduce } from "../../../packages/web/src/state.ts";
import { snapshotWith } from "../../window-rework/research/fixtures.ts";
import type { ServerMessage, SessionSnapshot } from "../../../packages/core/protocol.ts";

const shim = installDom();
const hrtime = (): bigint => process.hrtime.bigint();
const msBetween = (a: bigint, b: bigint): number => Number(b - a) / 1e6;

/** 一个新的空 transcript 宿主，与量具建的是同一种。 */
function makeTranscript(): { host: FakeNode; view: TranscriptView } {
	const host = asElement(shim.document.createElement("main"));
	host.className = "transcript";
	const view = new TranscriptView(host, { onUserContext: () => {} });
	view.trackScroll();
	return { host: host as unknown as FakeNode, view };
}

function baselineOf(snapshot: SessionSnapshot): ServerMessage {
	return { type: "baseline", session: snapshot } as unknown as ServerMessage;
}

/** 快照 → 生产 reducer 给出的 items，两条路量的必须是同一批 item。 */
function itemsOf(snapshot: SessionSnapshot) {
	return reduce(initialState(), baselineOf(snapshot)).items;
}

interface Row {
	tag: string;
	items: number;
	chars: number;
	syncMs: number;
	firstMs: number;
	peakMs: number;
	totalMs: number;
	frames: number;
	/** 两条路各建/摘了多少个节点。活没少干的话这两个数应当接近。 */
	syncNodes: number;
	drawnNodes: number;
	turns: number;
}

/**
 * 一条对照：同一批 items 先用旧路整块画一遍，再用新路画一遍。
 *
 * 两遍都换**新的视图**，因为两条路都要付「第一次见这棵树」的价；共用一棵树的话第二遍量到的是增
 * 量更新，那正是 05 号要修的 O(n²) 的另一半，混进来会让对照失去意义。
 */
function compare(tag: string, snapshot: SessionSnapshot): Row {
	const items = itemsOf(snapshot);
	const chars = items.reduce(
		(total, item) => total + (item.kind === "message" && !item.notice ? item.text.length : 0),
		0,
	);

	const oneShot = makeTranscript();
	resetWork();
	const a = hrtime();
	oneShot.view.render(items, false);
	const syncMs = msBetween(a, hrtime());
	const syncNodes = work.nodes;

	const deferred = makeTranscript();
	resetWork();
	const b = hrtime();
	deferred.view.renderDeferred(items, false);
	const firstMs = msBetween(b, hrtime());

	// 一帧的算法代价：把队列跑空，每一步各计一次——`peak` 要的是"任何一步最多占住多久"。
	let peakMs = 0;
	let frames = 0;
	while (frames < 1000 && shim.frames() > 0) {
		frames += 1;
		const stepStart = hrtime();
		deferred.view.stepPending();
		const spent = msBetween(stepStart, hrtime());
		if (spent > peakMs) peakMs = spent;
	}
	// `total` 是**一整段连续测量**：第一片的起点到这个循环的终点。逐帧相加会偏小，理由在文件头：
	// 一步里可能跑好几批（预算 4 ms、闸门在步之间看），而每步只记了一次边界。
	const totalMs = msBetween(b, hrtime());
	const drawnNodes = work.nodes;

	const sections = countOf(oneShot.host, (node) => node.tag === "section" && node.classList.contains("turn"));
	const drawn = countOf(deferred.host, (node) => node.tag === "section" && node.classList.contains("turn"));

	return {
		tag,
		items: items.length,
		chars,
		syncMs,
		firstMs,
		peakMs,
		totalMs,
		frames,
		syncNodes: syncNodes,
		// 两条路的节点数是**累加**的：`resetWork()` 之后两条路各自跑完各自的全部工作。
		// （05 号一度在这里数出"新路少了 260 条"，是插桩时把计数器逐步清零造成的假象。）
		drawnNodes,
		turns: sections,
		// 两条路必须画出同样多的 turn：少一条就是有东西被丢了，多一条就是被画了两次。
		...(sections === drawn ? {} : { tag: `${tag}（!! turn 数不一致 ${sections} vs ${drawn}）` }),
	};
}

function countOf(node: FakeNode, predicate: (node: FakeNode) => boolean): number {
	let count = predicate(node) ? 1 : 0;
	for (const child of node.children) count += countOf(child, predicate);
	return count;
}

const RUNS = Number(process.env.SWITCH_RUNS ?? "6");
const CASES: [string, number, number][] = [
	["短历史(50)×短消息(400字)", 50, 400],
	["长历史(500)×短消息(400字)", 500, 400],
	["短历史(50)×长消息(4000字)", 50, 4000],
	["长历史(500)×长消息(4000字)", 500, 4000],
];

const sink: string[] = [];
const emit = (line = ""): void => {
	sink.push(line);
	process.stdout.write(`${line}\n`);
};

emit("== switch-paint-probe：切换会话的第一笔绘制，整块 vs 分批 ==");
emit(`node=${process.version} runs=${RUNS}`);
emit("诚实限度：绝对毫秒不是真实帧时间（shim 没有布局与绘制）；可靠的是同一把尺子下的比值。");
emit("一帧在这里是 shim.frames() 跑一批，不是浏览器的 vsync。");
emit();

const rows: Row[] = [];
for (const [tag, history, chars] of CASES) {
	// 每条会话各不相同的时间戳与 id，与量具的切换场景同一个理由：item id 撞上就会量到复用。
	const samples: Row[] = [];
	for (let run = 0; run < RUNS; run += 1) {
		const snapshot = snapshotWith(history, chars, { id: `p-${run}`, stamp: 1_000 + run * (history + 10) });
		// 热身：JIT 与首次分配不该算进中位数。
		if (run === 0) continue;
		samples.push(compare(tag, snapshot));
	}
	const median = (pick: (row: Row) => number): number => {
		const sorted = samples.map(pick).sort((x, y) => x - y);
		return sorted[Math.floor(sorted.length / 2)] ?? 0;
	};
	rows.push({
		tag,
		items: samples[0]!.items,
		chars: samples[0]!.chars,
		syncMs: median((row) => row.syncMs),
		firstMs: median((row) => row.firstMs),
		peakMs: median((row) => row.peakMs),
		totalMs: median((row) => row.totalMs),
		frames: median((row) => row.frames),
		syncNodes: median((row) => row.syncNodes),
		drawnNodes: median((row) => row.drawnNodes),
		turns: samples[0]!.turns,
	});
}

const pad = (text: string, width: number): string => text.padEnd(width);
const num = (value: number, digits = 2): string => value.toFixed(digits).padStart(9);

emit(pad("场景", 34) + "     字符" + "        sync" + "       first" + "        peak" + "       total" + "  帧数");
emit("-".repeat(110));
for (const row of rows) {
	emit(
		pad(row.tag, 34)
		+ String(row.chars).padStart(9)
		+ num(row.syncMs)
		+ num(row.firstMs)
		+ num(row.peakMs)
		+ num(row.totalMs)
		+ String(row.frames).padStart(6),
	);
}
emit();
emit("sync  = 旧路：render() 一次画完整棵 transcript（一次切换里主线程被占住的时长）");
emit("first = 新路：renderDeferred() 的第一批，与点击同一帧");
emit("peak  = 新路：最坏的一步（任何一帧最多占住主线程多久）");
emit("total = 新路：同一段工作**一整段连续测量**（第一片的起点到队列跑空）。这个数应当与 sync 同量级");
emit("        ——「活没少干、只是摊开」。逐帧相加是另一种记法，会偏小 0.4～0.6x（见文件头），不在这里列。");
emit();
emit("比值（同一把尺子下才有意义）：");
for (const row of rows) {
	emit(
		`  ${pad(row.tag, 34)} first/sync ${(row.firstMs / row.syncMs).toFixed(3)}x`
		+ `   peak/sync ${(row.peakMs / row.syncMs).toFixed(3)}x`
		+ `   total/sync ${(row.totalMs / row.syncMs).toFixed(2)}x`,
	);
}
emit();
emit("两条路的活是不是一样多（shim 记的节点构造/摘除次数，与毫秒无关的那把尺子）：");
for (const row of rows) {
	emit(
		`  ${pad(row.tag, 34)} 旧路 nodes=${String(row.syncNodes).padStart(8)}`
		+ `  新路 nodes=${String(row.drawnNodes).padStart(8)}`
		+ `  比值 ${(row.drawnNodes / row.syncNodes).toFixed(2)}x`,
	);
}
emit();
emit("每次切换的规模：items 条 / 正文字符 / 画出的 turn");
for (const row of rows) emit(`  ${pad(row.tag, 34)} items=${String(row.items).padStart(4)}  chars=${row.chars}  turns=${row.turns}`);
emit();

const OUT = process.env.HARNESS_OUT;
if (OUT !== undefined) writeFileSync(OUT, `${sink.join("\n")}\n`, "utf8");
