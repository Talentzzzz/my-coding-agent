/**
 * jank-harness —— 前端卡顿热点测量装置。
 *
 * 目的：在一个最小 DOM 宿主里驱动**生产的** `TranscriptView` / `Sidebar` / `StatusBar` /
 * `SettingsPanel` / `Composer` 以及 `state.ts` 的 `reduce`，复刻 `main.ts` 的 `apply()` 折叠顺序，
 * 然后逐帧量出各阶段耗时，并在**短历史**与**长历史**两种规模下把数字并排放。
 *
 * 它不做任何断言、不依赖服务器、不需要供应商密钥。跑法：
 *   node .scratch/window-rework/research/jank-harness.ts
 *   FRAMES=200 node .scratch/window-rework/research/jank-harness.ts   # 冒烟用的小规模
 *
 * 关于这套数字的诚实说明：DOM 是 smoke-sidebar.ts 那套 `FakeNode` 的手工 shim 扩展而来，不是浏览器。
 * 因此**绝对毫秒数不是真实帧时间**——它度量的是算法代价（节点访问、元素构造、字符串解析、数组拷贝）。
 * 真正可靠的信号是**同 shim 下 短 vs 长 的比值**，它暴露的是"每帧成本是否随规模增长"。
 */
import { TranscriptView } from "../../../packages/web/src/render/transcript.ts";
import { Sidebar } from "../../../packages/web/src/render/sidebar.ts";
import { StatusBar } from "../../../packages/web/src/render/statusbar.ts";
import { SettingsPanel } from "../../../packages/web/src/render/settings.ts";
import { Composer } from "../../../packages/web/src/composer.ts";
import { parseBlocks, renderMarkdown, type MarkdownState } from "../../../packages/web/src/render/markdown.ts";
import { initialState, reduce, type ViewState } from "../../../packages/web/src/state.ts";
import type { ServerMessage } from "@my-agent/core/protocol";

// ------------------------------------------------------------------ 计时

const hrtime = (): bigint => process.hrtime.bigint();
const msBetween = (a: bigint, b: bigint): number => Number(b - a) / 1e6;

// ------------------------------------------------------------------ 记账

/** 与时间无关的"工作量"计数：即使 shim 比浏览器快，它也能证明每帧确实做了 O(n) 的活。 */
const work = { nodes: 0, appends: 0, qs: 0, qsNodes: 0 };
const resetWork = (): void => { work.nodes = 0; work.appends = 0; work.qs = 0; work.qsNodes = 0; };

// ------------------------------------------------------------------ 最小 DOM

function camelToDash(name: string): string {
	return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

class FakeNode {
	readonly children: FakeNode[] = [];
	parent: FakeNode | undefined;
	className: string;
	readonly tag: string;
	readonly attributes = new Map<string, string>();
	readonly dataset: Record<string, string> = new Proxy({} as Record<string, string>, {
		get: (_t, key: string) => this.attributes.get(`data-${camelToDash(key)}`),
		set: (_t, key: string, value: string) => { this.attributes.set(`data-${camelToDash(key)}`, String(value)); return true; },
		has: (_t, key: string) => this.attributes.has(`data-${camelToDash(key)}`),
		deleteProperty: (_t, key: string) => { this.attributes.delete(`data-${camelToDash(key)}`); return true; },
		ownKeys: () => [...this.attributes.keys()].filter((k) => k.startsWith("data-")).map((k) => k.slice(5)),
		getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
	});
	readonly style: Record<string, unknown> = {
		setProperty: (key: string, value: string) => { this.style[`--${key}`] = value; },
		removeProperty: (key: string) => { delete this.style[`--${key}`]; },
	};
	title = "";
	scrollTop = 0;
	scrollHeight = 0;
	clientHeight = 0;
	detached = false;
	private _text: string | undefined;
	private _value: string | undefined;

	constructor(tag: string, className?: string, text?: string) {
		this.tag = tag;
		this.className = className ?? "";
		this._text = text;
		work.nodes += 1;
	}

	get id(): string { return this.attributes.get("id") ?? ""; }
	get hidden(): boolean { return this.attributes.has("hidden"); }
	set hidden(value: boolean) { if (value) this.attributes.set("hidden", ""); else this.attributes.delete("hidden"); }
	get value(): string { return this._value ?? this.attributes.get("value") ?? ""; }
	set value(value: string) { this._value = String(value); }
	checked = false;
	disabled = false;

	get classList(): { contains(name: string): boolean; add(name: string): void; remove(name: string): void; toggle(name: string, force?: boolean): boolean } {
		const names = new Set(this.className.split(/\s+/).filter(Boolean));
		return {
			contains: (name) => names.has(name),
			add: (name) => void names.add(name),
			remove: (name) => void names.delete(name),
			toggle: (name, force) => {
				const want = force ?? !names.has(name);
				if (want) names.add(name); else names.delete(name);
				this.className = [...names].join(" ");
				return want;
			},
		};
	}

	get textContent(): string {
		if (this.children.length > 0) return this.children.map((child) => child.textContent).join("");
		return this._text ?? "";
	}
	set textContent(value: string) {
		for (const child of this.children) { child.parent = undefined; child.detached = true; }
		this.children.length = 0;
		this._text = value;
	}

	get firstChild(): FakeNode | undefined { return this.children[0]; }
	get lastElementChild(): FakeNode | undefined { return this.children[this.children.length - 1]; }
	get firstElementChild(): FakeNode | undefined { return this.children[0]; }
	get nextSibling(): FakeNode | undefined {
		if (this.parent === undefined) return undefined;
		const at = this.parent.children.indexOf(this);
		return this.parent.children[at + 1];
	}
	get options(): FakeNode[] { return this.children.filter((child) => child.tag === "option"); }

	append(...nodes: FakeNode[]): void {
		for (const node of nodes) {
			node.parent?.removeChild(node);
			node.parent = this;
			node.detached = false;
			this._text = undefined;
			this.children.push(node);
		}
		work.appends += nodes.length;
	}
	prepend(node: FakeNode): void {
		node.parent?.removeChild(node);
		node.parent = this;
		this._text = undefined;
		this.children.unshift(node);
		work.appends += 1;
	}
	replaceChildren(...nodes: FakeNode[]): void {
		for (const child of this.children) { child.detached = true; child.parent = undefined; }
		this.children.length = 0;
		this._text = undefined;
		this.append(...nodes);
	}
	removeChild(node: FakeNode): void {
		const at = this.children.indexOf(node);
		if (at >= 0) { this.children.splice(at, 1); node.detached = true; node.parent = undefined; }
	}
	remove(): void { this.parent?.removeChild(this); }
	insertBefore(node: FakeNode, reference: FakeNode | null | undefined): void {
		const from = node.parent;
		if (from !== undefined) {
			const at = from.children.indexOf(node);
			if (at >= 0) from.children.splice(at, 1);
		}
		node.parent = this;
		node.detached = false;
		const at = reference === null || reference === undefined ? this.children.length : this.children.indexOf(reference);
		this.children.splice(at < 0 ? this.children.length : at, 0, node);
		work.appends += 1;
	}
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }
	getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
	addEventListener(): void {}
	set innerHTML(_value: string) {
		this.children.length = 0;
		const parsed = new FakeNode("svg");
		parsed.parent = this;
		this.children.push(parsed);
		work.nodes += 1;
	}
	querySelector(selector: string): FakeNode | null {
		work.qs += 1;
		const wanted = selector.startsWith(".") ? selector.slice(1) : undefined;
		const wantedAttribute = selector.match(/^\[([a-z-]+)="([^"]*)"\]$/);
		let found: FakeNode | undefined;
		const walk = (node: FakeNode): void => {
			work.qsNodes += 1;
			if (found !== undefined) return;
			if (wanted !== undefined ? node.classList.contains(wanted) : node.getAttribute(wantedAttribute?.[1] ?? "") === wantedAttribute?.[2]) {
				found = node;
				return;
			}
			for (const child of node.children) walk(child);
		};
		walk(this);
		// 真 DOM 的 querySelector 找不到时返回 null，不是 undefined——sidebar 明确用 `!== null` 判断。
		return found ?? null;
	}
	scrollIntoView(): void {}
}

function installDom(): void {
	const g = globalThis as unknown as Record<string, unknown>;
	g.document = {
		createElement: (tag: string) => new FakeNode(tag),
		createTextNode: (text: string) => new FakeNode("#text", "", text),
		getElementById: () => null,
		documentElement: { dataset: {}, style: { setProperty: () => {} } },
	};
	g.window = { matchMedia: () => ({ matches: false }), setTimeout: () => 0 };
	// Node 22 自带只读的 `navigator`，只能用 defineProperty 覆盖。
	Object.defineProperty(g, "navigator", { value: { clipboard: { writeText: () => Promise.resolve() } }, configurable: true, writable: true });
}

installDom();

// ------------------------------------------------------------------ 造数据

const MODEL = {
	name: "faux",
	modelId: "faux-1",
	baseUrl: "http://127.0.0.1:1/v1",
	contextWindow: 200_000,
	maxTokens: 8_192,
	reasoning: false,
	thinkingLevels: ["off", "low", "medium", "high"],
	defaultThinkingLevel: "off",
	hasApiKey: true,
};

const USAGE = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 150, contextWindow: 200_000 };

/** 一段被长历史撑起来的会话：`count` 条 user/assistant 交替的既有消息。 */
function snapshotWith(count: number) {
	const messages = Array.from({ length: count }, (_unused, index) => ({
		role: index % 2 === 0 ? "user" : "assistant",
		content: [{ type: "text", text: `第 ${index} 条既有消息：${"内容 ".repeat(20)}` }],
		timestamp: 1_000 + index,
	}));
	return {
		id: "s1",
		cwd: "/workspace",
		createdAt: 1,
		title: "卡顿测量",
		model: `${MODEL.name}/${MODEL.modelId}`,
		thinkingLevel: "off",
		thinkingLevels: ["off", "low"],
		approvals: {},
		allTools: ["read", "write", "edit", "bash"],
		activeTools: ["read", "write"],
		messages,
		messageEntryIds: messages.map((_m, index) => `entry-${index}`),
		branchPoints: [],
		leafId: `entry-${count - 1}`,
		submitting: true,
		queued: 0,
		isRetrying: false,
		retryAttempt: 0,
		usage: USAGE,
		pendingApprovals: [],
	};
}

/** 一条会被逐帧"流式"吐出的长 markdown 回答。 */
function longAnswer(targetLength: number): string {
	let text = "# 测量回答\n\n";
	let section = 0;
	while (text.length < targetLength) {
		section += 1;
		text += `## 第 ${section} 节\n\n`;
		text += "这是正文段落，用来把这条消息撑长。每一帧 renderMarkdown 都会把整条消息重新 parseBlocks 一次，"
			+ "因此单帧成本与消息当前长度成正比。\n\n";
		text += "- 列表项一\n- 列表项二\n- 列表项三\n\n";
		text += "```ts\nconst value = 1;\nconsole.log(value);\n```\n\n";
	}
	return text.slice(0, targetLength);
}

/** 固定时间戳，让每一帧 message_update 都落在同一个 item 上。 */
const STREAM_TS = 999_999;

function streamFrame(text: string): ServerMessage {
	return {
		type: "event",
		// `assistantMessageEvent` 按生产形状带上：`message_update` 的每个成员都携带在飞的增量类型，
		// reducer 用它维护思考的 running 态。这里是纯文本流，所以是 `text_delta`。
		event: {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text.slice(-4), partial: undefined },
			message: { role: "assistant", content: [{ type: "text", text }], timestamp: STREAM_TS },
		},
	} as unknown as ServerMessage;
}

// ------------------------------------------------------------------ 统计

interface Series { samples: number[] }
function stats(samples: number[]): { n: number; mean: number; p50: number; p95: number; max: number; sum: number } {
	if (samples.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0, max: 0, sum: 0 };
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
	const sum = samples.reduce((a, b) => a + b, 0);
	return { n: samples.length, mean: sum / samples.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]!, sum };
}
const f4 = (n: number): string => n.toFixed(4);

// ------------------------------------------------------------------ 场景骨架

/** main.ts `apply()` 里显式出现过的节点：文案改写的 header、错误条、通知区。 */
function makeFrameDeps() {
	const transcriptHost = new FakeNode("main", "transcript");
	const transcript = new TranscriptView(transcriptHost as unknown as HTMLElement, { onFork: () => {}, onBranch: () => {} });
	transcript.trackScroll();

	const sidebar = new Sidebar({ onNewSession: () => {}, onSelectSession: () => {}, onToggleCollapsed: () => {}, onOpenSettings: () => {} });
	const statusBar = new StatusBar();
	const composer = new Composer({ onSubmit: () => {}, onAbort: () => {}, onSelectModel: () => {}, onSelectLevel: () => {} });
	const settings = new SettingsPanel({ onClose: () => {}, onTheme: () => {}, onFontSize: () => {}, onSaveModels: async () => {}, onDefaultModel: () => {}, onActiveTools: () => {}, onApproval: () => {}, onBashTimeouts: () => {} });

	const heading = new FakeNode("h1");
	const subtitle = new FakeNode("div");
	const errorBar = new FakeNode("div");
	const banners = new FakeNode("div");
	return { transcriptHost, transcript, sidebar, statusBar, composer, settings, heading, subtitle, errorBar, banners };
}

type Deps = ReturnType<typeof makeFrameDeps>;

/**
 * 侧边栏的输入：`workspaceCount` 个工作区、每个工作区一行。
 *
 * 不是一个工作区里塞 N 行——折叠列表每个工作区只画前 4 行，那样 200 行和 4 行画出来的行数其实一样。
 * 用 N 个工作区才能让屏幕上真的出现 N 行，从而量出"随行数增长"。
 */
function sidebarState(workspaceCount: number) {
	const workspaces = Array.from({ length: workspaceCount }, (_unused, index) => ({
		cwd: `/w${index}`,
		sessions: [{ id: `sess-${index}`, cwd: `/w${index}`, createdAt: 1, title: `会话 ${index}`, modified: index + 1, running: false, pending: 0 }],
	}));
	// `version` 复刻 `SessionRows.version`：流式期间行表不变，门控因此把 sidebar.render 关掉。
	return { workspaces, activeSessionId: "sess-0", currentWorkspace: "/w0", collapsed: false, channel: "live", version: 0 };
}

/**
 * `main.ts` 里那些"上次画的是什么"的门控状态，每个场景一份。
 *
 * 09 之后的 `apply()`/`render()` 逐段对比自己的输入：sidebar 看（行表 version、followed、collapsed、
 * channel、currentWorkspace），statusbar 看 usage 的引用，notices 看 models/approvals 的引用，header 看
 * 标题字符串。流式帧一个都不动，所以这些阶段每帧成本归零——这正是 H7 的修法本身。
 */
function makeGates() {
	return {
		sidebar: undefined as string | undefined,
		usage: undefined as unknown,
		heading: undefined as string | undefined,
		models: undefined as unknown,
		approvals: undefined as unknown,
	};
}

type Gates = ReturnType<typeof makeGates>;

/**
 * 复刻 `main.ts` 的 `apply()`（09 之后的门控版）：reducer → transcript → 门控的 chrome。
 *
 * 各阶段单独计时；被门控关掉的阶段（流式帧下的 sidebar/statusbar/notices）因此只剩一次字符串/引用
 * 比较，耗时≈0——与生产一致。
 */
function frame(state: ViewState, message: ServerMessage, deps: Deps, rows: ReturnType<typeof sidebarState>, gates: Gates) {
	const t0 = hrtime();
	const next = reduce(state, message);
	const t1 = hrtime();

	if (next.items !== state.items || next.streaming !== state.streaming) deps.transcript.render(next.items, next.streaming);
	const t2 = hrtime();

	if (next.reachable !== state.reachable) deps.composer.setDisabled(!next.reachable);
	if (next.streaming !== state.streaming || next.queued !== state.queued) { deps.composer.setStreaming(next.streaming); deps.composer.setQueued(next.queued); }
	if (next.usage !== state.usage && next.usage !== gates.usage) { gates.usage = next.usage; deps.statusBar.render({ usage: next.usage }); }
	if (next.error !== state.error) { deps.errorBar.hidden = next.error === undefined; deps.errorBar.textContent = next.error ?? ""; }

	// render()，逐段门控
	const sidebarKey = `${rows.version}|${rows.activeSessionId}|${rows.currentWorkspace}|${rows.collapsed ? 1 : 0}|${rows.channel}`;
	if (sidebarKey !== gates.sidebar) {
		gates.sidebar = sidebarKey;
		deps.sidebar.render({
			workspaces: rows.workspaces as never,
			activeSessionId: rows.activeSessionId,
			currentWorkspace: rows.currentWorkspace,
			collapsed: rows.collapsed,
			channel: rows.channel as never,
		});
	}
	const t3 = hrtime();
	const title = next.snapshot?.title ?? "";
	if (title !== gates.heading) { gates.heading = title; deps.heading.textContent = title; }
	deps.composer.setSelection({
		models: next.models,
		model: next.snapshot?.model ?? "",
		levels: next.snapshot?.thinkingLevels ?? [],
		level: next.snapshot?.thinkingLevel ?? "off",
	});
	const t4 = hrtime();
	if (next.usage !== gates.usage) { gates.usage = next.usage; deps.statusBar.render({ usage: next.usage }); }
	const t5 = hrtime();
	if (next.models !== gates.models || next.approvals !== gates.approvals) {
		gates.models = next.models;
		gates.approvals = next.approvals;
		deps.banners.replaceChildren();
	}
	const t6 = hrtime();

	return {
		next,
		durations: {
			reduce: msBetween(t0, t1),
			transcript: msBetween(t1, t2),
			sidebar: msBetween(t2, t3),
			header: msBetween(t3, t4),        // heading + composer.setSelection
			statusbar: msBetween(t4, t5),
			notices: msBetween(t5, t6),
			full: msBetween(t0, t6),
		},
	};
}

interface ScenarioResult {
	tag: string;
	history: number;
	frames: number;
	answerLength: number;
	stages: Record<string, ReturnType<typeof stats>>;
	workPerFrame: Record<string, number>;
	sanity: { turnSections: number; items: number };
}

function countTurns(host: FakeNode): number {
	let count = 0;
	const walk = (node: FakeNode): void => {
		if (node.tag === "section" && node.classList.contains("turn")) count += 1;
		for (const child of node.children) walk(child);
	};
	walk(host);
	return count;
}

/** 短/长历史对照：只让既有消息条数不同，流的长度与内容完全一致。 */
function streamScenario(historyCount: number, answer: string, chunk: number, framesWanted: number, warm: boolean): ScenarioResult {
	const deps = makeFrameDeps();
	const snapshot = snapshotWith(historyCount);
	let state = reduce(initialState(), { type: "baseline", session: snapshot } as unknown as ServerMessage);
	state = { ...state, models: [MODEL] as never };
	const rows = sidebarState(8);

	// 生产里 `openSession` 会对 baseline 走一次 `apply()`，于是历史 turn 在流开始前就已经建好。
	// 不预演一次的话，测得的第 1 帧会一次性建完所有历史 turn，污染均值与最坏值。
	// 预演同时把 chrome 门控种子进去：门控状态从此与生产一致（首轮绘制之后，流式帧全部跳过）。
	const gates = makeGates();
	deps.transcript.render(state.items, state.streaming);
	{
		const key = `${rows.version}|${rows.activeSessionId}|${rows.currentWorkspace}|${rows.collapsed ? 1 : 0}|${rows.channel}`;
		deps.sidebar.render(rows as never);
		gates.sidebar = key;
		gates.usage = state.usage;
		gates.models = state.models;
		gates.approvals = state.approvals;
		gates.heading = state.snapshot?.title ?? "";
	}

	const stageSamples: Record<string, number[]> = { reduce: [], transcript: [], sidebar: [], header: [], statusbar: [], notices: [], full: [] };
	resetWork();
	const frames = Math.min(framesWanted, Math.floor(answer.length / chunk));

	for (let index = 1; index <= frames; index += 1) {
		const text = answer.slice(0, index * chunk);
		const result = frame(state, streamFrame(text), deps, rows, gates);
		state = result.next;
		if (warm) continue;
		for (const [key, value] of Object.entries(result.durations)) stageSamples[key]!.push(value);
	}

	const stages: Record<string, ReturnType<typeof stats>> = {};
	for (const [key, value] of Object.entries(stageSamples)) stages[key] = stats(value);

	return {
		tag: warm ? "warmup" : `history=${historyCount}`,
		history: historyCount,
		frames: warm ? 0 : frames,
		answerLength: answer.length,
		stages,
		workPerFrame: warm ? {} : { nodes: work.nodes / frames, appends: work.appends / frames, qs: work.qs / frames, qsNodes: work.qsNodes / frames },
		sanity: { turnSections: countTurns(deps.transcriptHost), items: state.items.length },
	};
}

/** renderMarkdown / parseBlocks 单独测：证明单帧成本随**消息长度**增长。 */
function markdownScenario(answer: string, chunk: number, frames: number) {
	const container = new FakeNode("div");
	let rendered: MarkdownState | undefined;
	const parseSamples: number[] = [];
	const renderSamples: number[] = [];
	resetWork();

	for (let index = 1; index <= frames; index += 1) {
		const text = answer.slice(0, index * chunk);
		const a = hrtime();
		parseBlocks(text);
		const b = hrtime();
		rendered = renderMarkdown(container as unknown as HTMLElement, text, rendered);
		const c = hrtime();
		parseSamples.push(msBetween(a, b));
		renderSamples.push(msBetween(b, c));
	}

	const quarter = Math.max(1, Math.floor(frames / 4));
	const firstMean = (s: number[]) => s.slice(0, quarter).reduce((x, y) => x + y, 0) / quarter;
	const lastMean = (s: number[]) => s.slice(-quarter).reduce((x, y) => x + y, 0) / quarter;
	return {
		frames,
		answerLength: answer.length,
		parse: { ...stats(parseSamples), firstQuarterMean: firstMean(parseSamples), lastQuarterMean: lastMean(parseSamples) },
		render: { ...stats(renderSamples), firstQuarterMean: firstMean(renderSamples), lastQuarterMean: lastMean(renderSamples) },
	};
}

/** sidebar.render 单独测：证明成本随**屏幕上画出的会话行数**增长（与对话长度无关）。 */
function sidebarScenario(workspaceCount: number, iterations: number) {
	const sidebar = new Sidebar({ onNewSession: () => {}, onSelectSession: () => {}, onToggleCollapsed: () => {}, onOpenSettings: () => {} });
	const rows = sidebarState(workspaceCount);
	sidebar.render(rows as never); // warmup + 建行
	const samples: number[] = [];
	resetWork();
	for (let index = 0; index < iterations; index += 1) {
		const a = hrtime();
		sidebar.render(rows as never);
		const b = hrtime();
		samples.push(msBetween(a, b));
	}
	return { workspaceCount, ...stats(samples), qsPerCall: work.qs / iterations, nodesPerCall: work.nodes / iterations };
}

/** 工具组：一组 K 张卡，持续更新其中一张的输出——看 renderTools 的重建代价。 */
function toolsScenario(cardsInGroup: number, frames: number) {
	const deps = makeFrameDeps();
	let state = reduce(initialState(), { type: "baseline", session: snapshotWith(0) } as unknown as ServerMessage);
	state = { ...state, models: [MODEL] as never };
	const rows = sidebarState(8);

	// 先建一组 K 张 running 卡（连续 start 会合并进同一组）。
	for (let index = 0; index < cardsInGroup; index += 1) {
		state = reduce(state, {
			type: "event",
			event: { type: "tool_execution_start", toolCallId: `call-${index}`, toolName: "bash", args: { command: `echo ${index}` } },
		} as unknown as ServerMessage);
	}

	const stageSamples: number[] = [];
	resetWork();
	for (let index = 1; index <= frames; index += 1) {
		// 只让第 0 张卡的输出增长；shape 变化会触发整组的 replaceChildren。
		state = reduce(state, {
			type: "event",
			event: { type: "tool_execution_update", toolCallId: "call-0", toolName: "bash", args: { command: "echo 0" }, partialResult: { content: [{ type: "text", text: "x".repeat(index) }] } },
		} as unknown as ServerMessage);
		const a = hrtime();
		deps.transcript.render(state.items, state.streaming);
		const b = hrtime();
		stageSamples.push(msBetween(a, b));
	}
	return { cardsInGroup, ...stats(stageSamples), nodesPerFrame: work.nodes / frames, qsPerFrame: work.qs / frames };
}

/** settings.render：面板关闭时不跑；这里打开 models 页，看它随模型行数的成本。 */
function settingsScenario(modelCount: number, iterations: number) {
	const settings = new SettingsPanel({ onClose: () => {}, onTheme: () => {}, onFontSize: () => {}, onSaveModels: async () => {}, onDefaultModel: () => {}, onActiveTools: () => {}, onApproval: () => {}, onBashTimeouts: () => {} });
	settings.show();
	const models = Array.from({ length: modelCount }, (_unused, index) => ({ ...MODEL, name: `m${index}`, modelId: `m${index}-1` }));
	const stateObj = { models, settings: undefined, snapshot: undefined };
	// 切到模型页会让 signature 不复用，才会真的重建 body。
	(settings as unknown as { tab: string }).tab = "models";
	settings.render(stateObj as never);
	const samples: number[] = [];
	resetWork();
	for (let index = 0; index < iterations; index += 1) {
		(settings as unknown as { signature: string }).signature = ""; // 强制重建，模拟"内容变了"
		const a = hrtime();
		settings.render(stateObj as never);
		const b = hrtime();
		samples.push(msBetween(a, b));
	}
	return { models: modelCount, ...stats(samples), nodesPerCall: work.nodes / iterations };
}

// ------------------------------------------------------------------ 跑

const FRAMES = Number(process.env.FRAMES ?? "2000");
const CHUNK = 4;
const ANSWER_LENGTH = 8000;
const answer = longAnswer(ANSWER_LENGTH);

const out: Record<string, unknown> = {};
const log = (line = ""): void => process.stdout.write(`${line}\n`);

log("== jank-harness：窄 DOM 宿主中的前端逐帧成本 ==");
log(`frames=${FRAMES} chunk=${CHUNK} answerLength=${answer.length}`);
log();

// warmup（丢弃），让 V8 把这些路径 JIT 编译热。
streamScenario(50, answer, CHUNK, FRAMES, true);
log("warmup 完成");
log();

const short = streamScenario(50, answer, CHUNK, FRAMES, false);
const long = streamScenario(500, answer, CHUNK, FRAMES, false);

const stageNames = ["reduce", "transcript", "sidebar", "header", "statusbar", "notices", "full"];
log("阶段                 | 短历史(50) mean/p95/max ms      | 长历史(500) mean/p95/max ms     | 长/短 mean 比");
log("---------------------+---------------------------------+---------------------------------+-------------");
for (const name of stageNames) {
	const s = short.stages[name]!;
	const l = long.stages[name]!;
	const ratio = s.mean > 0 ? l.mean / s.mean : 0;
	log(
		`${name.padEnd(20)} | ${f4(s.mean)} / ${f4(s.p95)} / ${f4(s.max)}`.padEnd(56)
		+ `| ${f4(l.mean)} / ${f4(l.p95)} / ${f4(l.max)}`.padEnd(34)
		+ `| ${ratio.toFixed(2)}x`,
	);
}
log();
log(`每帧工作量（短历史）：nodes=${short.workPerFrame.nodes?.toFixed(1)} appends=${short.workPerFrame.appends?.toFixed(1)} querySelector=${short.workPerFrame.qs?.toFixed(1)} qsNodes=${short.workPerFrame.qsNodes?.toFixed(1)}`);
log(`每帧工作量（长历史）：nodes=${long.workPerFrame.nodes?.toFixed(1)} appends=${long.workPerFrame.appends?.toFixed(1)} querySelector=${long.workPerFrame.qs?.toFixed(1)} qsNodes=${long.workPerFrame.qsNodes?.toFixed(1)}`);
log(`sanity：短 turnSections=${short.sanity.turnSections} items=${short.sanity.items}；长 turnSections=${long.sanity.turnSections} items=${long.sanity.items}`);
log();

const markdown = markdownScenario(answer, CHUNK, Math.floor(answer.length / CHUNK));
log("renderMarkdown / parseBlocks（单条消息随长度增长）");
log(`  frames=${markdown.frames} 首帧文本~${CHUNK * 1}字 末帧文本~${answer.length}字`);
log(`  parseBlocks   mean=${f4(markdown.parse.mean)}ms 首四分之一均值=${f4(markdown.parse.firstQuarterMean)}ms 末四分之一均值=${f4(markdown.parse.lastQuarterMean)}ms 末/首=${(markdown.parse.lastQuarterMean / markdown.parse.firstQuarterMean).toFixed(1)}x max=${f4(markdown.parse.max)}ms`);
log(`  renderMarkdown mean=${f4(markdown.render.mean)}ms 首四分之一均值=${f4(markdown.render.firstQuarterMean)}ms 末四分之一均值=${f4(markdown.render.lastQuarterMean)}ms 末/首=${(markdown.render.lastQuarterMean / markdown.render.firstQuarterMean).toFixed(1)}x max=${f4(markdown.render.max)}ms`);
log(`  单条消息的 renderMarkdown 总耗时=${f4(markdown.render.sum)}ms（${markdown.frames} 帧）`);
log();

const sidebarSmall = sidebarScenario(4, 500);
const sidebarBig = sidebarScenario(200, 500);
log("sidebar.render（随会话行数增长）");
log(`  4 行  ：mean=${f4(sidebarSmall.mean)}ms p95=${f4(sidebarSmall.p95)}ms max=${f4(sidebarSmall.max)}ms qs/次=${sidebarSmall.qsPerCall.toFixed(1)} nodes/次=${sidebarSmall.nodesPerCall.toFixed(1)}`);
log(`  200 行：mean=${f4(sidebarBig.mean)}ms p95=${f4(sidebarBig.p95)}ms max=${f4(sidebarBig.max)}ms qs/次=${sidebarBig.qsPerCall.toFixed(1)} nodes/次=${sidebarBig.nodesPerCall.toFixed(1)}`);
log(`  200/4 mean 比 = ${(sidebarBig.mean / sidebarSmall.mean).toFixed(1)}x`);
log();

const toolsSmall = toolsScenario(4, 300);
const toolsBig = toolsScenario(40, 300);
log("工具组更新（renderTools 的 shape + 整组重建）");
log(`  组内 4 卡 ：transcript.render mean=${f4(toolsSmall.mean)}ms max=${f4(toolsSmall.max)}ms nodes/帧=${toolsSmall.nodesPerFrame.toFixed(1)}`);
log(`  组内 40 卡：transcript.render mean=${f4(toolsBig.mean)}ms max=${f4(toolsBig.max)}ms nodes/帧=${toolsBig.nodesPerFrame.toFixed(1)}`);
log(`  40/4 mean 比 = ${(toolsBig.mean / toolsSmall.mean).toFixed(1)}x`);
log();

const settingsSmall = settingsScenario(1, 100);
const settingsBig = settingsScenario(50, 100);
log("settings.render（仅面板打开、切到模型页时跑）");
log(`  1 个模型 ：mean=${f4(settingsSmall.mean)}ms max=${f4(settingsSmall.max)}ms nodes/次=${settingsSmall.nodesPerCall.toFixed(1)}`);
log(`  50 个模型：mean=${f4(settingsBig.mean)}ms max=${f4(settingsBig.max)}ms nodes/次=${settingsBig.nodesPerCall.toFixed(1)}`);
log();

Object.assign(out, { short, long, markdown, sidebarSmall, sidebarBig, toolsSmall, toolsBig, settingsSmall, settingsBig });
log("=== JSON ===");
log(JSON.stringify(out));
