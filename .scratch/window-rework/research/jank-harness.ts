/**
 * jank-harness —— 前端卡顿热点测量装置。
 *
 * 目的：在一个最小 DOM 宿主里驱动**生产的** `TranscriptView` / `Sidebar` / `StatusBar` /
 * `SettingsPanel` / `Composer` 以及 `state.ts` 的 `reduce`，复刻 `main.ts` 的 `apply()` / `render()`
 * 折叠顺序，然后逐帧量出各阶段耗时，并在**短历史**与**长历史**两种规模下把数字并排放。
 *
 * 它不做任何断言、不依赖服务器、不需要供应商密钥。跑法：
 *   node .scratch/window-rework/research/jank-harness.ts
 *   FRAMES=200 node .scratch/window-rework/research/jank-harness.ts   # 冒烟用的小规模
 *   DOM_SHIM_LAX=1 node .scratch/window-rework/research/jank-harness.ts  # 缺件只警告不抛
 *
 * DOM 来自 `dom-shim.ts`（两份手搓 shim 漂移过一次，见那份文件的说明），缺成员**默认当场抛**：
 * 量具跑得完就等于今天产品代码要的 DOM 面齐了。
 *
 * 归因核对：`markdown-attribution-probe.ts` 用同一把尺子把"其中md"那一列单独量了一遍。
 *
 * 关于这套数字的诚实说明（照抄老票，两轮下来都还成立）：
 *
 * 1. DOM 是 `dom-shim.ts` 那套手工 shim，不是浏览器。因此**绝对毫秒不是真实帧时间**——它度量的是
 *    算法代价（节点访问、元素构造、字符串解析、数组拷贝）。可靠的信号是**同一把尺子下短 vs 长的
 *    比值**，它暴露的是"每帧成本是否随规模增长"。
 * 2. Node 版本变了，老数字不能直接比。老数字出自 22.22.2，本机 24.15.0。要么同版本重跑，要么只比
 *    比值。运行时把版本打进表头，省得下次再猜。
 *
 * 两个被测的路：
 *
 * - **流式一帧**（`streamScenario` / `toolsScenario` / `markdownScenario` / `sidebarScenario` /
 *   `settingsScenario`）：`main.ts` 的 `apply()` 逐段门控之后，一次 `message_update` 该花多少。
 * - **切换会话**（`switchScenario`）：`openSession()` 端到端——两次 HTTP 往返、快照重放
 *   （`itemsFromSnapshot` + 每条消息的 `renderMarkdown`）、首次绘制。05 号要照这条测量动手。
 */
import { writeFileSync } from "node:fs";
import { installDom, asElement, resetWork, work, type FakeNode } from "../../../scripts/dom-shim.ts";
import { TranscriptView } from "../../../packages/web/src/render/transcript.ts";
import { Sidebar } from "../../../packages/web/src/render/sidebar.ts";
import { StatusBar } from "../../../packages/web/src/render/statusbar.ts";
import { SettingsPanel } from "../../../packages/web/src/render/settings.ts";
import { Composer } from "../../../packages/web/src/composer.ts";
import { SessionRows } from "../../../packages/web/src/rows.ts";
import * as markdown from "../../../packages/web/src/render/markdown.ts";
import { initialState, reduce, type ViewState } from "../../../packages/web/src/state.ts";
import { longAnswer, messageBody, snapshotWith, textOfMessage, MODEL, USAGE } from "./fixtures.ts";
import type { ServerMessage, SessionSnapshot, WorkspaceGroup } from "../../../packages/core/protocol.ts";

// 造数据的三件助手搬去了 `fixtures.ts`：量具在 import 时就把整张表跑一遍，另一个探针要造同一批数据
// 却不想顺带跑完量具。这里再导出一次，是为了不让旧的 import 路径断掉。
export { longAnswer, messageBody, snapshotWith, textOfMessage };


// ------------------------------------------------------------------ DOM

const shim = installDom();

// ------------------------------------------------------------------ 计时

const hrtime = (): bigint => process.hrtime.bigint();
const msBetween = (a: bigint, b: bigint): number => Number(b - a) / 1e6;

/**
 * 一条消息在**首次绘制**时 `renderMarkdown` 要付的账。
 *
 * `transcript.ts` 里没有给 Markdown 单设计时器（它调的就是模块导出，ESM 的导出绑定是只读的，
 * 量具没法从外面换掉它）。所以这一笔按**同一批文本重画一遍**来量：新建一个容器、`MarkdownState`
 * 从零开始（这正是首次绘制的状态——每条消息只画一次，无从复用增量），逐条计时加总。它量的是
 * `renderMarkdown` 自己，重复地量、量得准，代价是与真实绘制不在同一瞬间。
 */
function markdownCostOf(snapshot: SessionSnapshot): { totalMs: number; calls: number; chars: number; perCall: number[] } {
	const container = asElement(shim.document.createElement("div"));
	const perCall: number[] = [];
	let totalMs = 0;
	let chars = 0;
	for (const message of snapshot.messages) {
		const text = textOfMessage(message);
		if (text.length === 0) continue;
		const a = hrtime();
		markdown.renderMarkdown(container, text);
		perCall.push(msBetween(a, hrtime()));
		totalMs += perCall[perCall.length - 1]!;
		chars += text.length;
	}
	return { totalMs, calls: perCall.length, chars, perCall };
}

// 造数据的助手（`textOfMessage` / `MODEL` / `USAGE` / `messageBody` / `snapshotWith` / `longAnswer`）
// 搬去了同目录的 `fixtures.ts`，理由写在那里：这份量具在 import 时就把整张表跑一遍，而 05 号的
// `switch-paint-probe.ts` 要造同一批快照、不想顺带跑完量具。上面 import 进来，第 48 行再导出一次，
// 旧的 import 路径因此不断。

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

function baselineOf(snapshot: SessionSnapshot): ServerMessage {
	return { type: "baseline", session: snapshot } as unknown as ServerMessage;
}

// ------------------------------------------------------------------ 统计

function stats(samples: number[]): { n: number; mean: number; p50: number; p95: number; max: number; sum: number } {
	if (samples.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0, max: 0, sum: 0 };
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
	const sum = samples.reduce((a, b) => a + b, 0);
	return { n: samples.length, mean: sum / samples.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]!, sum };
}
const f4 = (n: number): string => n.toFixed(4);
const pad = (text: string, width: number): string => text.padEnd(width);

// ------------------------------------------------------------------ 场景骨架

/** `main.ts` 里显式出现过、且不随会话变的窗口级节点。 */
function makeFrameDeps() {
	const transcriptHost = asElement(shim.document.createElement("main"));
	transcriptHost.className = "transcript";
	const transcript = new TranscriptView(transcriptHost, { onUserContext: () => {} });
	transcript.trackScroll();

	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
		onAddWorkspace: () => {},
		onForkSession: () => {},
		onDeleteSession: () => {},
		onRenameSession: () => {},
		onToggleWorkspace: () => {},
		onPageWorkspace: () => {},
		onCollapseWorkspace: () => {},
		onRenameWorkspace: () => {},
		onDeleteWorkspace: () => {},
	});
	const statusBar = new StatusBar();
	const composer = new Composer({
		onSubmit: () => {},
		onAbort: () => {},
		onSelectModel: () => {},
		onSelectLevel: () => {},
		onModes: () => {},
		onSelectMode: () => {},
	});
	const settings = new SettingsPanel({
		onClose: () => {},
		onTheme: () => {},
		onFontSize: () => {},
		onSaveModels: async () => {},
		onSaveModes: async () => {},
		onDefaultModel: () => {},
		onGlobalTools: async () => {},
		onGlobalApproval: async () => {},
		onBashTimeouts: () => {},
	});

	const heading = asElement(shim.document.createElement("h1"));
	const subtitle = asElement(shim.document.createElement("div"));
	const chipLabel = asElement(shim.document.createElement("span"));
	const errorBar = asElement(shim.document.createElement("div"));
	const banners = asElement(shim.document.createElement("div"));
	const approvalSeat = asElement(shim.document.createElement("div"));
	return {
		transcriptHost,
		transcript,
		sidebar,
		statusBar,
		composer,
		settings,
		heading,
		subtitle,
		chipLabel,
		errorBar,
		banners,
		approvalSeat,
	};
}

type Deps = ReturnType<typeof makeFrameDeps>;

function sidebarRows(workspaceCount: number): SessionRows {
	const rows = new SessionRows();
	const all: WorkspaceGroup["sessions"] = [];
	for (let index = 0; index < workspaceCount; index += 1) {
		all.push({
			id: `sess-${index}`,
			cwd: `/w${index}`,
			createdAt: 1,
			title: `会话 ${index}`,
			modified: index + 1,
			running: false,
			pending: 0,
		});
	}
	rows.loadFrom([{ cwd: "/w0", sessions: all }], false);
	return rows;
}

/**
 * `main.ts` 里那些"上次画的是什么"的门控状态，每个场景一份。
 *
 * `apply()` / `render()` 逐段对比自己的输入：sidebar 看（行表 version、followed、目录、collapsed、
 * channel），statusbar 看 usage 的引用，notices 看 models 的引用，header 看标题字符串。流式帧一个都
 * 不动，所以这些阶段每帧成本归零——这正是 H7 的修法本身。
 */
function makeGates() {
	return {
		sidebar: undefined as string | undefined,
		usage: undefined as unknown,
		heading: undefined as string | undefined,
		models: undefined as unknown,
		approvals: undefined as unknown,
		directory: undefined as string | undefined,
		/**
		 * 工作目录选择器的选择，`main.ts` 里那个 `pickedWorkspace`。
		 *
		 * `openSession()` 每次都把它清空（"选择是关于那个**即将**开始的新会话的"），所以它进签名——签名
		 * 里有一个会变的字段，切换会话时左栏那一栏就真的会重画，而不是被门挡掉。
		 */
		pickedWorkspace: "",
	};
}

type Gates = ReturnType<typeof makeGates>;

/**
 * `main.ts` 的 `renderSidebar()` 的那个签名。
 *
 * 逐字照抄 `main.ts:708`，因为它是"这一帧左栏要不要重画"的唯一判据——流式帧一个字段都不动（于是整段
 * 跳过），而切换会话动的是 `followed` 与目录（于是整段重画）。**六个字段全在这里、全由调用方给**：
 * 抄成一个冻死的字面量，下一次 `main.ts` 改公式时这里就会静默地对不上，那正是这一票诊断出的那种漂移。
 */
function sidebarKey(rows: SessionRows, followed: string | undefined, directory: string, pickedWorkspace: string, collapsed: boolean): string {
	return `${rows.version}|${followed ?? ""}|${directory}|${pickedWorkspace}|${collapsed ? 1 : 0}|live`;
}

/**
 * 复刻 `main.ts` 的 `render()`（门控版）：门控的 chrome + transcript。
 *
 * 各阶段单独计时；被门控关掉的阶段（流式帧下的 sidebar/statusbar/notices）因此只剩一次字符串/引用
 * 比较，耗时≈0——与生产一致。切换会话那一帧一个门都不命中，所以同一个函数也能量出"整帧重建"的价。
 *
 * **量具的边界（写在这里，不留在读者的猜里）**：`render()` 里还有三笔没搬进来——`branchView.render()`、
 * 工作目录芯片那两行、以及两个面板（只在 `open` 时跑）。三者都由 baseline 的稀有字段驱动、与消息
 * **条数**无关，所以流式那张表不受影响；切换会话那张表因此少了它们那一点。05 号若怀疑分支视图，
 * 去 `branch-view.ts` 单独量。
 */
function renderFrame(next: ViewState, previous: ViewState, deps: Deps, rows: SessionRows, gates: Gates) {
	const t0 = hrtime();
	if (next.items !== previous.items || next.streaming !== previous.streaming) deps.transcript.render(next.items, next.streaming);
	const t1 = hrtime();

	if (next.reachable !== previous.reachable) deps.composer.setDisabled(!next.reachable);
	if (next.streaming !== previous.streaming || next.queued !== previous.queued) {
		deps.composer.setStreaming(next.streaming);
		deps.composer.setQueued(next.queued);
	}
	if (next.error !== previous.error) {
		deps.errorBar.hidden = next.error === undefined;
		deps.errorBar.textContent = next.error ?? "";
	}
	// `renderStatusBar()`：usage 的引用没动就整段跳过。
	if (next.usage !== gates.usage) {
		gates.usage = next.usage;
		deps.statusBar.render({ usage: next.usage });
	}
	const t2 = hrtime();

	// `render()` 的第一段：`renderSidebar()`。
	const directory = next.snapshot?.cwd ?? "";
	const key = sidebarKey(rows, next.snapshot?.id, directory, gates.pickedWorkspace, false);
	if (key !== gates.sidebar) {
		gates.sidebar = key;
		gates.directory = directory;
		deps.sidebar.render({
			workspaces: rows.groups(),
			...(next.snapshot === undefined ? {} : { activeSessionId: next.snapshot.id }),
			currentWorkspace: directory,
			collapsed: false,
			paging: {},
			channel: "live",
		});
	}
	const t3 = hrtime();

	const headingText = next.snapshot?.title ?? "新会话";
	if (headingText !== gates.heading) {
		gates.heading = headingText;
		deps.heading.textContent = headingText;
	}
	deps.composer.setSelection({
		models: next.models,
		model: next.snapshot?.model ?? "",
		levels: next.snapshot?.thinkingLevels ?? [],
		level: next.snapshot?.thinkingLevel ?? "off",
	});
	const t4 = hrtime();

	if (next.models !== gates.models || next.approvals !== gates.approvals) {
		gates.models = next.models;
		gates.approvals = next.approvals;
		deps.banners.replaceChildren();
		deps.approvalSeat.replaceChildren();
	}
	const t5 = hrtime();

	return {
		durations: {
			transcript: msBetween(t0, t1),
			chrome: msBetween(t1, t2),      // 输入框、错误条、状态行
			sidebar: msBetween(t2, t3),
			header: msBetween(t3, t4),      // 标题 + 模型位
			notices: msBetween(t4, t5),
			full: msBetween(t0, t5),
		},
	};
}

/** 一帧的账：`reduce` 加 {@link renderFrame}，顺序与 `main.ts` 的 `apply()` 一致。 */
function frame(state: ViewState, message: ServerMessage, deps: Deps, rows: SessionRows, gates: Gates) {
	const t0 = hrtime();
	const next = reduce(state, message);
	const t1 = hrtime();
	const painted = renderFrame(next, state, deps, rows, gates);
	return {
		next,
		durations: { reduce: msBetween(t0, t1), ...painted.durations },
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
	let state = reduce(initialState(), baselineOf(snapshot));
	state = { ...state, models: [MODEL] };
	const rows = sidebarRows(8);

	// 生产里 `openSession` 会对 baseline 走一次 `apply()`，于是历史 turn 在流开始前就已经建好。
	// 不预演一次的话，测得的第 1 帧会一次性建完所有历史 turn，污染均值与最坏值。
	// 预演同时把 chrome 门控种子进去：门控状态从此与生产一致（首轮绘制之后，流式帧全部跳过）。
	const gates = makeGates();
	deps.transcript.render(state.items, state.streaming);
	deps.sidebar.render({
		workspaces: rows.groups(),
		activeSessionId: snapshot.id,
		currentWorkspace: snapshot.cwd,
		collapsed: false,
		paging: {},
		channel: "live",
	});
	gates.sidebar = sidebarKey(rows, snapshot.id, snapshot.cwd, gates.pickedWorkspace, false);
	gates.directory = snapshot.cwd;
	gates.usage = state.usage;
	gates.models = state.models;
	gates.approvals = state.approvals;
	gates.heading = snapshot.title;

	const stageSamples: Record<string, number[]> = { reduce: [], transcript: [], chrome: [], sidebar: [], header: [], notices: [], full: [] };
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
	const container = asElement(shim.document.createElement("div"));
	let rendered: markdown.MarkdownState | undefined;
	const parseSamples: number[] = [];
	const renderSamples: number[] = [];
	resetWork();

	for (let index = 1; index <= frames; index += 1) {
		const text = answer.slice(0, index * chunk);
		const a = hrtime();
		markdown.parseBlocks(text);
		const b = hrtime();
		rendered = markdown.renderMarkdown(container, text, rendered);
		const c = hrtime();
		parseSamples.push(msBetween(a, b));
		renderSamples.push(msBetween(b, c));
	}

	const quarter = Math.max(1, Math.floor(frames / 4));
	const firstMean = (samples: number[]) => samples.slice(0, quarter).reduce((a, b) => a + b, 0) / quarter;
	const lastMean = (samples: number[]) => samples.slice(-quarter).reduce((a, b) => a + b, 0) / quarter;
	return {
		frames,
		answerLength: answer.length,
		parse: { ...stats(parseSamples), firstQuarterMean: firstMean(parseSamples), lastQuarterMean: lastMean(parseSamples) },
		render: { ...stats(renderSamples), firstQuarterMean: firstMean(renderSamples), lastQuarterMean: lastMean(renderSamples) },
	};
}

/** sidebar.render 单独测：证明成本随**屏幕上画出的会话行数**增长（与对话长度无关）。 */
function sidebarScenario(workspaceCount: number, iterations: number) {
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
		onAddWorkspace: () => {},
		onForkSession: () => {},
		onDeleteSession: () => {},
		onRenameSession: () => {},
		onToggleWorkspace: () => {},
		onPageWorkspace: () => {},
		onCollapseWorkspace: () => {},
		onRenameWorkspace: () => {},
		onDeleteWorkspace: () => {},
	});
	const state = { workspaces: sidebarRows(workspaceCount).groups(), currentWorkspace: "/w0", collapsed: false, paging: {}, channel: "live" as const };
	sidebar.render(state); // warmup + 建行
	const samples: number[] = [];
	resetWork();
	for (let index = 0; index < iterations; index += 1) {
		const a = hrtime();
		sidebar.render(state);
		const b = hrtime();
		samples.push(msBetween(a, b));
	}
	return { workspaceCount, ...stats(samples), qsPerCall: work.qs / iterations, nodesPerCall: work.nodes / iterations };
}

/** 工具组：一组 K 张卡，持续更新其中一张的输出——看 renderTools 的重建代价。 */
function toolsScenario(cardsInGroup: number, frames: number) {
	const deps = makeFrameDeps();
	let state = reduce(initialState(), baselineOf(snapshotWith(0)));
	state = { ...state, models: [MODEL] };
	const rows = sidebarRows(8);

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
	const settings = new SettingsPanel({
		onClose: () => {},
		onTheme: () => {},
		onFontSize: () => {},
		onSaveModels: async () => {},
		onSaveModes: async () => {},
		onDefaultModel: () => {},
		onGlobalTools: async () => {},
		onGlobalApproval: async () => {},
		onBashTimeouts: () => {},
	});
	settings.show();
	const models = Array.from({ length: modelCount }, (_unused, index) => ({ ...MODEL, name: `m${index}`, modelId: `m${index}-1` }));
	const stateObject = { models };
	// 切到模型页会让 signature 不复用，才会真的重建 body。
	(settings as unknown as { tab: string }).tab = "models";
	settings.render(stateObject);
	const samples: number[] = [];
	resetWork();
	for (let index = 0; index < iterations; index += 1) {
		(settings as unknown as { signature: string }).signature = ""; // 强制重建，模拟"内容变了"
		const a = hrtime();
		settings.render(stateObject);
		const b = hrtime();
		samples.push(msBetween(a, b));
	}
	return { models: modelCount, ...stats(samples), nodesPerCall: work.nodes / iterations };
}

// ------------------------------------------------------------------ 切换会话

/**
 * 假传输层：真 `fetch` + 真的 JSON 文本。
 *
 * `api.read()` 只做三件事——一次 `fetch`、`response.text()`、`JSON.parse`——所以这里不返回对象而是返回
 * **字符串**：把快照 `JSON.stringify` 出来，让生产的 `SessionApi` 自己 `JSON.parse` 回来。直接给对象
 * 的话，"把 n 条消息的 JSON 解析成对象"这笔账就凭空消失了。
 *
 * **一端在这一侧、一端不在**：`stringify` 在真系统里是**服务端**干的（客户端只收字节），所以它被单独
 * 计时、单独报（`wire` 那一列），不计进 `read`——`read` 只算客户端真正付的那一笔（`JSON.parse`）。
 * 服务器的响应时间与网络在 shim 里根本量不到，输出里明说。
 */
class FakeApi {
	readonly sessions = new Map<string, SessionSnapshot>();
	rows: WorkspaceGroup[] = [];
	listBytes = 0;
	/** 上次读快照时那份 JSON 的字节数。 */
	lastReadBytes = 0;
	/** 假服务端把一条快照序列化成 JSON 花了多久——不是客户端付的钱，单独报。 */
	wireMs = 0;

	read(sessionId: string): { ok: true; text: string } {
		const snapshot = this.sessions.get(sessionId);
		if (snapshot === undefined) throw new Error(`FakeApi：没有 ${sessionId} 这个会话`);
		const started = hrtime();
		const text = JSON.stringify({ session: snapshot });
		this.wireMs = msBetween(started, hrtime());
		this.lastReadBytes = text.length;
		return { ok: true, text };
	}

	/** 会话列表：`GET /api/workspaces` 与 `/api/sessions*` 那几笔都用它。 */
	workspaces(): { ok: true; text: string } {
		const text = JSON.stringify({ workspaces: this.rows });
		this.listBytes = text.length;
		return { ok: true, text };
	}

	/** `/api/sessions/current`（以及创建/派生那几笔）答的是"哪一条"，外加一份列表。 */
	sessionId(id: string): { ok: true; text: string } {
		const text = JSON.stringify({ sessionId: id, sessions: this.rows });
		this.listBytes = text.length;
		return { ok: true, text };
	}

	models(): { ok: true; text: string } {
		return { ok: true, text: JSON.stringify({ models: [MODEL] }) };
	}

	/** 装上全局 `fetch`，把生产的 `SessionApi` 接到这条假线上。 */
	install(): void {
		const g = globalThis as unknown as { fetch: (path: string, init?: { method?: string }) => Promise<unknown> };
		// 只有读取路径答得上话：这一票量的是切换会话，写入那几笔（发消息、改名、审批）走后端就是另一张
		// 票的事了。走到这里说明量具越界了，当场说，别静默答一个形状不对的 body。
		g.fetch = async (path: string, init?: { method?: string }) => {
			const method = init?.method ?? "GET";
			const body =
				path === "/api/health" ? JSON.stringify({ ok: true, cwd: "/workspace", live: [] })
				: path === "/api/models" ? this.models().text
				: path === "/api/workspaces" ? this.workspaces().text
				: path === "/api/sessions/current" ? this.sessionId(this.rows[0]?.sessions[0]?.id ?? "s0").text
				: path.startsWith("/api/sessions/") && method === "GET" ? this.read(decodeURIComponent(path.slice("/api/sessions/".length))).text
				: undefined;
			if (body === undefined) throw new Error(`FakeApi：没为 ${method} ${path} 准备应答`);
			return { ok: true, status: 200, text: async () => body };
		};
		g.Response = class {
			readonly ok = true;
			readonly status = 200;
			readonly body: string;
			constructor(body: string) {
				this.body = body;
			}
			async text(): Promise<string> {
				return this.body;
			}
		};
	}
}

/** 一次切换会话的账，按 `openSession()` 的步骤分。 */
interface SwitchBreakdown {
	/**
	 * 读快照那一笔里**客户端**付的：`response.text()` + `JSON.parse`。
	 *
	 * `stringify` 不在里面——真系统里那是服务端干的，量具把它单独放在 {@link wireMs}。
	 */
	readMs: number;
	/** 那一笔快照在假服务端被序列化花了多久。**不是客户端的账**，列出来只是为了看清它有多大。 */
	wireMs: number;
	/** 第二笔往返：`GET /api/workspaces` 的解析 + 左栏重画。 */
	refreshMs: number;
	/** 快照重放：`reduce(baseline)`——`itemsFromSnapshot` + `buildBranchTree`。 */
	reduceMs: number;
	/** 首次绘制：transcript 建整棵树 + 门控的 chrome。 */
	paintMs: number;
	/** 那一帧里 Markdown 自己占多少：同一批文本重画一遍量的（不重复计入 `paintMs`）。 */
	markdownMs: number;
	/** 同步总时长：账面上"点了这一行之后主线程被占住多久"。`wireMs` 不在里面。 */
	syncMs: number;
	readBytes: number;
	renderedMessages: number;
	markdownCalls: number;
	markdownChars: number;
}

/**
 * 端到端驱动 `openSession()` 里那一串**同步**的活。
 *
 * 真实 `openSession`（`main.ts:1047`）读起来是：`await api.read()` → 放掉旧订阅 → 改名、清选择、
 * 设 pane → `apply(reduce(baseline))` → `await refreshLists()` → `mux.retain()`。两段 `await` 之间的
 * 东西全在主线程上同步跑完，用户能感觉到的"顿一下"就是它；两次往返本身是等待（真窗口里是网络，
 * 这里在同一进程内测不出真实延迟，所以量的是**这两笔请求在客户端这一侧要付的解析与重画代价**，
 * 这一点在输出里写明）。
 *
 * 这里逐段计时，量的就是"切换一次会话，同步工作花在哪"。
 */
async function driveOpenSession(api: FakeApi, sessionId: string, deps: Deps, state: ViewState, rows: SessionRows, gates: Gates): Promise<{ state: ViewState; breakdown: SwitchBreakdown }> {
	const { SessionApi } = await import("../../../packages/web/src/api.ts");
	const client = new SessionApi();
	const breakdown: SwitchBreakdown = {
		readMs: 0,
		wireMs: 0,
		refreshMs: 0,
		reduceMs: 0,
		paintMs: 0,
		markdownMs: 0,
		syncMs: 0,
		readBytes: 0,
		renderedMessages: 0,
		markdownCalls: 0,
		markdownChars: 0,
	};
	const syncStart = hrtime();

	// 1. 读快照：`await api.read(sessionId)`。计时的这一段里只有客户端付的钱：`response.text()` 与
	//    `JSON.parse`。假服务端那次 `stringify` 被单独记在 `wireMs`，**不进 `syncMs`**。
	const readStart = hrtime();
	const snapshot = await client.read(sessionId);
	breakdown.readMs = msBetween(readStart, hrtime());
	breakdown.wireMs = api.wireMs;
	breakdown.readBytes = api.lastReadBytes;

	// 2. 重放：`apply(reduce(state, { type: "baseline", session: snapshot }))`，两段都量。
	const reduceStart = hrtime();
	const next = reduce(state, baselineOf(snapshot));
	breakdown.reduceMs = msBetween(reduceStart, hrtime());
	breakdown.paintMs = renderFrame(next, state, deps, rows, gates).durations.full;
	breakdown.renderedMessages = next.items.filter((item) => item.kind === "message").length;

	// 3. 列表：`await refreshLists()`——一笔往返加一次 sidebar 重画（channel 不是 live）。
	const refreshStart = hrtime();
	await client.listWorkspaces();
	rows.loadFrom(api.rows, false);
	deps.sidebar.render({
		workspaces: rows.groups(),
		activeSessionId: snapshot.id,
		currentWorkspace: snapshot.cwd,
		collapsed: false,
		paging: {},
		channel: "live",
	});
	breakdown.refreshMs = msBetween(refreshStart, hrtime());

	breakdown.syncMs = msBetween(syncStart, hrtime());

	// 4. 那一帧里 Markdown 自己占多少：同一批文本重画一遍。**在 sync 计时之外**——它是把已经发生的
	//    事再量一遍，算进"这一下占了主线程多久"就成了重复计数。
	const markdownCost = markdownCostOf(snapshot);
	breakdown.markdownMs = markdownCost.totalMs;
	breakdown.markdownCalls = markdownCost.calls;
	breakdown.markdownChars = markdownCost.chars;

	return { state: next, breakdown };
}

interface SwitchRow {
	tag: string;
	history: number;
	chars: number;
	/** `fresh`：每次切换都换一副新的窗口 chrome（相当于页面刚打开）。`reuse`：窗口不变，只有 pane 变。 */
	mode: "fresh" | "reuse";
	/** 采样几次，以及被当成热身丢掉了前几次。 */
	runs: number;
	warmup: number;
	readMs: number;
	readP50: number;
	/** 假服务端序列化那条快照花的时间——**不是客户端付的钱**，与 `readMs` 分开列。 */
	wireMs: number;
	refreshMs: number;
	reduceMs: number;
	reduceP50: number;
	paintMs: number;
	paintP50: number;
	markdownMs: number;
	markdownP50: number;
	syncMs: number;
	syncP50: number;
	readBytes: number;
	renderedMessages: number;
	markdownCalls: number;
	markdownChars: number;
	turnSections: number;
}

/**
 * 一条"切换会话"的量具行。
 *
 * `history` 条消息、每条 `chars` 字，切换 `runs` 次，每次都换一条会话。这样每次切换的 transcript
 * 都是**冷**的——`openSession` 换的是整个 pane，上一个会话画好的 DOM 一个都用不上，这正是要量的价。
 *
 * 两种 `mode` 把窗口期的东西分开：`reuse` 是真实点击那条路（侧栏、输入框、状态行都是活的），
 * `fresh` 每次换一副新的 chrome，量的是"从零建一个窗口"的价，两者之差就是复用的功劳。
 */
async function switchScenario(tag: string, history: number, chars: number, runs: number, mode: "fresh" | "reuse"): Promise<SwitchRow> {
	const api = new FakeApi();
	api.install();
	// 每条会话各有各的 id、时间戳与目录：切换会话必须真的换掉整棵 transcript，否则量到的是复用。
	for (let index = 0; index < runs; index += 1) {
		const snapshot = snapshotWith(history, chars, {
			id: `s${index}`,
			// 两条会话的时间戳错开得比一条会话的历史还长，任何两条都不会撞上。
			stamp: 1_000 + index * (history + 10),
			cwd: `/w${index % 8}`,
		});
		api.sessions.set(snapshot.id, snapshot);
	}
	// 工作区行表：8 个分组，每组 `history` 条会话——切换会话时左栏要重画的就是它。
	api.rows = Array.from({ length: 8 }, (_unused, group) => ({
		cwd: `/w${group}`,
		sessions: Array.from({ length: 12 }, (_row, index) => ({
			id: `s${group}-${index}`,
			cwd: `/w${group}`,
			createdAt: 1,
			title: `会话 ${group}-${index}`,
			modified: 1_000 - index,
			running: false,
			pending: 0,
		})),
	}));

	/** 前几次切换当热身丢掉：JIT 编译与首次分配不该算进均值。 */
	const WARMUP = Math.min(3, Math.max(0, runs - 1));
	const samples: SwitchBreakdown[] = [];
	let last = { state: initialState(), deps: makeFrameDeps(), rows: sidebarRows(8), gates: makeGates() };

	for (let index = 0; index <= runs; index += 1) {
		const sessionId = `s${index % runs}`;
		if (mode === "fresh") last = { state: last.state, deps: makeFrameDeps(), rows: last.rows, gates: makeGates() };
		const result = await driveOpenSession(api, sessionId, last.deps, last.state, last.rows, last.gates);
		last = { ...last, state: result.state };
		if (index < WARMUP) continue;
		samples.push(result.breakdown);
	}

	const mean = (pick: (row: SwitchBreakdown) => number): number => samples.reduce((total, row) => total + pick(row), 0) / samples.length;
	const median = (pick: (row: SwitchBreakdown) => number): number => {
		const sorted = samples.map(pick).sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)] ?? 0;
	};
	const rendered = last.deps.transcriptHost;
	return {
		tag,
		history,
		chars,
		mode,
		runs: samples.length,
		warmup: WARMUP,
		readMs: mean((row) => row.readMs),
		readP50: median((row) => row.readMs),
		wireMs: mean((row) => row.wireMs),
		refreshMs: mean((row) => row.refreshMs),
		reduceMs: mean((row) => row.reduceMs),
		reduceP50: median((row) => row.reduceMs),
		paintMs: mean((row) => row.paintMs),
		paintP50: median((row) => row.paintMs),
		markdownMs: mean((row) => row.markdownMs),
		markdownP50: median((row) => row.markdownMs),
		syncMs: mean((row) => row.syncMs),
		syncP50: median((row) => row.syncMs),
		readBytes: samples[0]?.readBytes ?? 0,
		renderedMessages: samples[0]?.renderedMessages ?? 0,
		markdownCalls: samples[0]?.markdownCalls ?? 0,
		markdownChars: samples[0]?.markdownChars ?? 0,
		turnSections: countTurns(rendered),
	};
}

// ------------------------------------------------------------------ 跑

const FRAMES = Number(process.env.FRAMES ?? "2000");
const CHUNK = 4;
const ANSWER_LENGTH = 8000;
const answer = longAnswer(ANSWER_LENGTH);

const out: Record<string, unknown> = {};
const log = (line = ""): void => process.stdout.write(`${line}\n`);

/**
 * 这份输出的一个去处：`HARNESS_OUT=<路径>` 时同时写一份 UTF-8 无 BOM 的副本。
 *
 * 为什么要这个开关而不是 `> file`：本仓库的 shell 是 Windows PowerShell 5.1，`>` 重定向写的是
 * **UTF-16LE**——中文变成乱码、NUL 满地、git 把产物当二进制。证据文件要留得住，就得让写它的进程
 * 自己按 UTF-8 写。
 */
const HARNESS_OUT = process.env.HARNESS_OUT;
const sink: string[] = [];
const emit = (line = ""): void => {
	if (HARNESS_OUT !== undefined) sink.push(line);
	log(line);
};

emit("== jank-harness：窄 DOM 宿主中的前端逐帧成本 ==");
emit(`node=${process.version} frames=${FRAMES} chunk=${CHUNK} answerLength=${answer.length}`);
emit("诚实限度：绝对毫秒不是真实帧时间（shim 不是浏览器）；可靠的信号是同一把尺子下的短/长比值。");
emit();

// warmup（丢弃），让 V8 把这些路径 JIT 编译热。
streamScenario(50, answer, CHUNK, FRAMES, true);
emit("warmup 完成");
emit();

{
	const short = streamScenario(50, answer, CHUNK, FRAMES, false);
	const long = streamScenario(500, answer, CHUNK, FRAMES, false);

	const stageNames = ["reduce", "transcript", "chrome", "sidebar", "header", "notices", "full"];
	emit("流式一帧：apply()/render() 逐段门控之后的每帧成本");
	emit("阶段                 | 短历史(50) mean/p95/max ms      | 长历史(500) mean/p95/max ms     | 长/短 mean 比");
	emit("---------------------+---------------------------------+---------------------------------+-------------");
	for (const name of stageNames) {
		const s = short.stages[name]!;
		const l = long.stages[name]!;
		const ratio = s.mean > 0 ? l.mean / s.mean : 0;
		emit(
			`${name.padEnd(20)} | ${f4(s.mean)} / ${f4(s.p95)} / ${f4(s.max)}`.padEnd(56)
			+ `| ${f4(l.mean)} / ${f4(l.p95)} / ${f4(l.max)}`.padEnd(34)
			+ `| ${ratio.toFixed(2)}x`,
		);
	}
	emit();
	emit(`每帧工作量（短历史）：nodes=${short.workPerFrame.nodes?.toFixed(1)} appends=${short.workPerFrame.appends?.toFixed(1)} querySelector=${short.workPerFrame.qs?.toFixed(1)} qsNodes=${short.workPerFrame.qsNodes?.toFixed(1)}`);
	emit(`每帧工作量（长历史）：nodes=${long.workPerFrame.nodes?.toFixed(1)} appends=${long.workPerFrame.appends?.toFixed(1)} querySelector=${long.workPerFrame.qs?.toFixed(1)} qsNodes=${long.workPerFrame.qsNodes?.toFixed(1)}`);
	emit(`sanity：短 turnSections=${short.sanity.turnSections} items=${short.sanity.items}；长 turnSections=${long.sanity.turnSections} items=${long.sanity.items}`);
	emit();
	Object.assign(out, { short, long });
}

{
	const markdownResult = markdownScenario(answer, CHUNK, Math.floor(answer.length / CHUNK));
	emit("renderMarkdown / parseBlocks（单条消息随长度增长）");
	emit(`  frames=${markdownResult.frames} 首帧文本~${CHUNK}字 末帧文本~${answer.length}字`);
	emit(`  parseBlocks   mean=${f4(markdownResult.parse.mean)}ms 首四分之一均值=${f4(markdownResult.parse.firstQuarterMean)}ms 末四分之一均值=${f4(markdownResult.parse.lastQuarterMean)}ms 末/首=${(markdownResult.parse.lastQuarterMean / markdownResult.parse.firstQuarterMean).toFixed(1)}x max=${f4(markdownResult.parse.max)}ms`);
	emit(`  renderMarkdown mean=${f4(markdownResult.render.mean)}ms 首四分之一均值=${f4(markdownResult.render.firstQuarterMean)}ms 末四分之一均值=${f4(markdownResult.render.lastQuarterMean)}ms 末/首=${(markdownResult.render.lastQuarterMean / markdownResult.render.firstQuarterMean).toFixed(1)}x max=${f4(markdownResult.render.max)}ms`);
	emit(`  单条消息的 renderMarkdown 总耗时=${f4(markdownResult.render.sum)}ms（${markdownResult.frames} 帧）`);
	emit();
	out.markdown = markdownResult;
}

{
	const sidebarSmall = sidebarScenario(4, 500);
	const sidebarBig = sidebarScenario(200, 500);
	emit("sidebar.render（随会话行数增长）");
	emit(`  4 行  ：mean=${f4(sidebarSmall.mean)}ms p95=${f4(sidebarSmall.p95)}ms max=${f4(sidebarSmall.max)}ms qs/次=${sidebarSmall.qsPerCall.toFixed(1)} nodes/次=${sidebarSmall.nodesPerCall.toFixed(1)}`);
	emit(`  200 行：mean=${f4(sidebarBig.mean)}ms p95=${f4(sidebarBig.p95)}ms max=${f4(sidebarBig.max)}ms qs/次=${sidebarBig.qsPerCall.toFixed(1)} nodes/次=${sidebarBig.nodesPerCall.toFixed(1)}`);
	emit(`  200/4 mean 比 = ${(sidebarBig.mean / sidebarSmall.mean).toFixed(1)}x`);
	emit();
	out.sidebarSmall = sidebarSmall;
	out.sidebarBig = sidebarBig;
}

{
	const toolsSmall = toolsScenario(4, 300);
	const toolsBig = toolsScenario(40, 300);
	emit("工具组更新（renderTools 的 shape + 整组重建）");
	emit(`  组内 4 卡 ：transcript.render mean=${f4(toolsSmall.mean)}ms max=${f4(toolsSmall.max)}ms nodes/帧=${toolsSmall.nodesPerFrame.toFixed(1)}`);
	emit(`  组内 40 卡：transcript.render mean=${f4(toolsBig.mean)}ms max=${f4(toolsBig.max)}ms nodes/帧=${toolsBig.nodesPerFrame.toFixed(1)}`);
	emit(`  40/4 mean 比 = ${(toolsBig.mean / toolsSmall.mean).toFixed(1)}x`);
	emit();
	out.toolsSmall = toolsSmall;
	out.toolsBig = toolsBig;
}

{
	const settingsSmall = settingsScenario(1, 100);
	const settingsBig = settingsScenario(50, 100);
	emit("settings.render（仅面板打开、切到模型页时跑）");
	emit(`  1 个模型 ：mean=${f4(settingsSmall.mean)}ms max=${f4(settingsSmall.max)}ms nodes/次=${settingsSmall.nodesPerCall.toFixed(1)}`);
	emit(`  50 个模型：mean=${f4(settingsBig.mean)}ms max=${f4(settingsBig.max)}ms nodes/次=${settingsBig.nodesPerCall.toFixed(1)}`);
	emit();
	out.settingsSmall = settingsSmall;
	out.settingsBig = settingsBig;
}

{
	const SWITCH_RUNS = Number(process.env.SWITCH_RUNS ?? "12");
	emit("切换会话：openSession() 端到端");
	emit("诚实限度：两次 HTTP 往返跑在同一进程里，量到的是**客户端这一侧**的解析与重画代价，不是网络延迟；");
	emit("          真窗口里那两笔还要再加上服务器响应时间，shim 里量不到。");
	emit();
	const rows: SwitchRow[] = [];
	// 两条轴分开量：一条让历史变多，一条让每条消息变长（renderMarkdown 的活随它涨）。
	// `reuse` 是真实点击那条路（窗口的 chrome 是活的），`fresh` 每次换一副新 chrome 作为对照。
	const cases: [string, number, number, "fresh" | "reuse"][] = [
		["短历史(50)×短消息(400字)", 50, 400, "reuse"],
		["长历史(500)×短消息(400字)", 500, 400, "reuse"],
		["短历史(50)×长消息(4000字)", 50, 4000, "reuse"],
		["长历史(500)×长消息(4000字)", 500, 4000, "reuse"],
		["长历史(500)×短消息(400字)·新窗口", 500, 400, "fresh"],
	];
	for (const [tag, history, chars, mode] of cases) rows.push(await switchScenario(tag, history, chars, SWITCH_RUNS, mode));

	const cell = (mean: number, p50: number): string => pad(`${mean.toFixed(2)}/${p50.toFixed(2)}`, 15);
	emit(pad("场景", 34) + pad("read", 15) + pad("wire", 9) + pad("refresh", 9) + pad("reduce", 15) + pad("paint", 15) + pad("其中md", 15) + pad("sync", 15));
	emit("-".repeat(127));
	for (const row of rows) {
		emit(
			pad(row.tag, 34)
			+ cell(row.readMs, row.readP50)
			+ pad(`${row.wireMs.toFixed(2)}ms`, 9)
			+ pad(`${row.refreshMs.toFixed(2)}ms`, 9)
			+ cell(row.reduceMs, row.reduceP50)
			+ cell(row.paintMs, row.paintP50)
			+ cell(row.markdownMs, row.markdownP50)
			+ cell(row.syncMs, row.syncP50),
		);
	}
	emit();
	emit("每个数据格是「均值/中位数」（单位 ms）——切换会话的单次样本有长尾，中位数比均值更能代表「平常那一下」。");
	emit("read = 读快照时**客户端**付的（response.text + JSON.parse）；refresh = 第二笔往返的解析 + 左栏重画；");
	emit("wire = 假**服务端**把那条快照 stringify 出来的时间——真系统里不归客户端，列在这里只是为了看见它有多大；");
	emit("reduce = 快照重放（itemsFromSnapshot + buildBranchTree）；paint = 首次绘制整棵 transcript + chrome；");
	emit("其中md = 那一帧里 Markdown 自己占的（同一批文本重画一遍量的，不重复计入 sync；归因由 markdown-attribution-probe.ts 单独核对）；sync = 整段同步总时长。");
	emit(`每次场景采样 ${rows[0]?.runs ?? 0} 次（另外前 ${rows[0]?.warmup ?? 0} 次当热身丢掉）。`);
	emit("网络延迟与服务器响应时间在 shim 里量不到：这里量的是「切换一次会话，客户端要同步做多少活」。");
	emit();
	const base = rows[0]!;
	for (const row of rows.slice(1)) {
		emit(
			`比值 ${row.tag} / ${base.tag}：sync ${(row.syncMs / base.syncMs).toFixed(2)}x`
			+ `（read ${(row.readMs / base.readMs).toFixed(2)}x、reduce ${(row.reduceMs / base.reduceMs).toFixed(2)}x、`
			+ `paint ${(row.paintMs / base.paintMs).toFixed(2)}x、md ${(row.markdownMs / base.markdownMs).toFixed(2)}x）`,
		);
	}
	emit();
	emit("同步时间里 Markdown 占多少（同一个场景，md ÷ sync；两条量法各有一点偏差，100% 附近读作「基本全是它」）");
	for (const row of rows) {
		emit(`  ${pad(row.tag, 34)} ${((row.markdownMs / row.syncMs) * 100).toFixed(0)}%（${row.markdownMs.toFixed(1)}ms / ${row.syncMs.toFixed(1)}ms）`);
	}
	emit();
	emit("每次切换的规模：快照 JSON 字节 / 画出的 turn / Markdown 调用次数与总字数");
	for (const row of rows) {
		emit(
			`  ${pad(row.tag, 36)} ${String(row.readBytes).padStart(8)} B  turns=${String(row.turnSections).padStart(4)}`
			+ `  md×${String(row.markdownCalls).padStart(4)}  ${String(row.markdownChars).padStart(7)} 字`,
		);
	}
	emit();
	out.switch = rows;
}

emit("=== JSON ===");
emit(JSON.stringify(out));

if (HARNESS_OUT !== undefined) {
	writeFileSync(HARNESS_OUT, `${sink.join("\n")}\n`, "utf8");
}
