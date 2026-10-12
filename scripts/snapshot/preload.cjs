/**
 * 截图执行者的预加载脚本。
 *
 * 它是 CommonJS，而仓库其余部分是纯 ESM：Electron 的 preload 先于任何工具链加载，在那里
 * `contextBridge` 只能由 `require("electron")` 拿到。同目录的 `package.json` 记录了这条例外。
 *
 * 它只做一件事：把一个"读页面状态"的入口交给截图执行者。诊断因此由被截的那一页自己回答，而不是
 * 从命令行把一段 JavaScript 交给渲染进程——那条路上的引号与 `=>` 要被 shell、PowerShell 和环境
 * 变量各吃一遍，实测传过去的代码已经不是原来那段了。
 */
const { contextBridge } = require("electron");

const round = (value) => Math.round(value * 10) / 10;

/** 一个元素的名字、显示方式与盒子，用来解释"它为什么不在画面上"。 */
function box(element) {
	const rect = element.getBoundingClientRect();
	const style = getComputedStyle(element);
	return (
		`${element.className || element.tagName}` +
		` rect=${round(rect.left)},${round(rect.top)} ${round(rect.width)}x${round(rect.height)}` +
		` display=${style.display} overflow=${style.overflowX}`
	);
}

/** 页面状态的文字报告：形态、网格、每个窗格与标签的可见性。 */
function report() {
	const parts = [];
	const shell = document.getElementById("shell");
	const stage = document.getElementById("stage");
	parts.push(`shell=${shell ? shell.getAttribute("data-view") : "missing"}`);
	if (stage) {
		const style = getComputedStyle(stage);
		parts.push(`stage rows=${style.gridTemplateRows} cols=${style.gridTemplateColumns}`);
	}
	parts.push(
		"panes=" +
			[...document.querySelectorAll("[data-pane]")]
				.map((pane) => {
					const style = getComputedStyle(pane);
					return `${pane.dataset.pane}${pane.hasAttribute("hidden") ? "H" : "-"}/${style.display}`;
				})
				.join(","),
	);
	parts.push(
		"tabs=" +
			[...document.querySelectorAll("[data-tab]")]
				.map((tab) => `${tab.dataset.tab}${tab.hasAttribute("hidden") ? "H" : "-"}`)
				.join(","),
	);
	parts.push(`sheets=${document.styleSheets.length}`);

	// 右半列与窗格区自己的盒子：网格的行高从这两个盒子上读，而不是从 `grid-template-rows` 的
	// 字符串上猜（那个字符串在 `1fr` 上不告诉你实际分到了多少）。
	if (stage) {
		parts.push(`stageBox ${box(stage)}`);
		for (const child of stage.children) parts.push(`child ${box(child)}`);
		const tabs = document.getElementById("tabs");
		if (tabs) parts.push(`tabsBox ${box(tabs)}`);
	}

	// 每个窗格标题与它右边的状态：这一条解释"状态为什么被裁掉了"。
	for (const pane of document.querySelectorAll("[data-pane]:not([hidden])")) {
		const head = pane.querySelector(".proto-pane-head");
		const title = pane.querySelector(".proto-pane-title");
		const state = pane.querySelector(".proto-pane-state");
		parts.push(`\n  pane ${pane.dataset.pane}: ${box(head)} | ${box(title)} | ${state ? box(state) : "no state"}`);
	}

	// 输入框那一行：目标标签与模型座位在窄栏里放不放得下。
	for (const pane of document.querySelectorAll("[data-pane]:not([hidden])")) {
		const bar = pane.querySelector(".composer-bar");
		const target = pane.querySelector(".proto-target");
		const select = pane.querySelector(".composer-select");
		if (bar) parts.push(`\n  composer ${pane.dataset.pane}: ${box(bar)} | ${target ? box(target) : "no target"} | ${select ? box(select) : "no select"}`);
	}
	return parts.join(" | ");
}

contextBridge.exposeInMainWorld("__snapshotReport", report);
