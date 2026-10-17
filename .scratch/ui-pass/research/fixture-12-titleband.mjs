// 12 号票的目视夹具：把**真的** packages/web/src/tokens.css 与 style.css 内联进去，再照
// main.ts / sidebar.ts / composer.ts / branch-view.ts 当前的造节点形状手写一份标记。
// 出图走 `launch.mjs --load <fixture>?pane=<chat|branch> --screenshot <png> [--theme light]`。
//
// 用法：
//   node .scratch/ui-pass/research/fixture-12-titleband.mjs   # 写出夹具，打印路径
//
// 夹具里唯一不属于应用样式表的 CSS 是文件末尾那段 `fixture-only`（按钮保留区的描边，
// 照 07 号原型的 .win-zone 画的），用来当面量"被按钮压住的总面积 = 0"。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const outDir = join(tmpdir(), "dsh-ticket12");
await mkdir(outDir, { recursive: true });

const tokens = await readFile(join(repo, "packages/web/src/tokens.css"), "utf8");
const style = await readFile(join(repo, "packages/web/src/style.css"), "utf8");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>12 · titleband fixture</title>
<script>
(() => {
	const desktop = window.desktop;
	const query = window.matchMedia("(prefers-color-scheme: dark)");
	const dark = typeof desktop?.theme === "boolean" ? desktop.theme : query.matches;
	document.documentElement.dataset.theme = dark ? "dark" : "light";
	document.documentElement.dataset.desktop = "true";
	document.documentElement.dataset.platform = "win32";
	document.documentElement.dataset.desktopCaption = "win";
})();
</script>
<style>${tokens}</style>
<style>${style}</style>
<style>
/* ===== fixture-only ===== */
.win-zone {
	position: fixed;
	top: 0;
	right: 0;
	z-index: 60;
	width: 138px;
	height: 40px;
	border-left: 1px dashed rgba(242, 90, 90, 0.75);
	background: rgba(242, 90, 90, 0.08);
	pointer-events: none;
}
</style>
</head>
<body>
<div id="app">
	<div class="titleband"></div>

	<aside class="sidebar">
		<div class="sidebar-top">
			<button type="button" class="new-session">
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="15" height="15"><path d="M8 3v10M3 8h10"/></svg>
				<span>新建会话</span>
			</button>
			<button type="button" class="icon-button" title="收起侧边栏">
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6 3v10"/></svg>
			</button>
		</div>
		<nav class="session-list" aria-label="会话列表">
			<div class="list-head">
				<div class="session-list-heading">工作区</div>
				<div class="list-head-actions">
					<button type="button" class="icon-button" title="搜索会话"></button>
					<button type="button" class="icon-button" title="添加工作区"></button>
				</div>
			</div>
			<div class="workspace">
				<button type="button" class="workspace-head workspace-head-current" title="C:\\Users\\a1368\\Desktop\\my-coding-agent">
					<span class="workspace-icon-folder"></span>
					<span class="workspace-name">my-coding-agent</span>
					<span class="workspace-icon-chev"></span>
				</button>
				<button type="button" class="session-item">
					<span class="session-item-slot"></span>
					<span class="session-item-title">标题栏：立一条真正的顶带</span>
					<span class="session-item-time">26分钟</span>
				</button>
				<button type="button" class="session-item" aria-current="true">
					<span class="session-item-slot"></span>
					<span class="session-item-title">wire 压测收尾</span>
					<span class="session-item-time">3小时</span>
				</button>
				<button type="button" class="session-item">
					<span class="session-item-slot" data-state="warn"></span>
					<span class="session-item-title">token 审计</span>
					<span class="session-item-time">1天</span>
				</button>
			</div>
		</nav>
		<div class="sidebar-foot">
			<button type="button" class="settings-entry" title="设置"><span>设置</span></button>
			<span class="channel-indicator"><span class="channel-dot"></span><span class="channel-indicator-text">已连接</span></span>
		</div>
	</aside>

	<div class="side-resizer"></div>

	<section class="conversation">
		<header class="header">
			<div class="header-row">
				<div class="header-title">
					<h1>你好</h1>
					<div class="header-subtitle">C:\\Users\\a1368\\Desktop\\my-coding-agent</div>
				</div>
				<button type="button" class="branch-chip" title="打开分支视图">
					<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="4.5" cy="3.5" r="1.8"/><circle cx="4.5" cy="12.5" r="1.8"/><circle cx="11.5" cy="8" r="1.8"/><path d="M4.5 5.3v5.4M6.3 8h3.4"/></svg>
					<span>当前分支</span>
					<span class="branch-chip-id">509d794</span>
					<span class="branch-chip-label">你好！我看到工作区在 my-coding-agent。需要我做什么？</span>
				</button>
			</div>
			<div class="branch-tools" hidden>
				<span class="branch-sel-info">这份记录有 <b>1</b> 个分支点、<b>2</b> 条走法。<em>左键选中 · 拖动画布 · Ctrl+滚轮缩放</em></span>
				<span class="header-spacer"></span>
				<div class="zoom-group">
					<button type="button" class="zoom-button" title="缩小">−</button>
					<span class="zoom-value">100%</span>
					<button type="button" class="zoom-button" title="放大">＋</button>
					<button type="button" class="zoom-button" title="缩放到刚好装下">适应</button>
				</div>
				<button type="button" class="back-button">回到对话</button>
			</div>
		</header>

		<div class="transcript-body">
			<main class="transcript">
				<div class="turn" data-role="user"><div class="turn-body"><p>标题栏立一条真正的顶带。</p></div></div>
				<div class="turn" data-role="assistant"><div class="turn-body"><p>照参考窗口量出来的结构：y 0–40 是整条顶带，铺满窗口宽度，页面不在里面画任何东西，三个窗口按钮住在它的右端；y ≥ 40 才是两栏。</p></div></div>
			</main>
			<div class="content-resizer"></div>
		</div>

		<div class="branch-view">
			<div class="branch-sum">
				<span>这份记录有 <b>1</b> 个分支点、<b>2</b> 条走法。</span>
				<span class="branch-hint">左键点一个节点选中它 · 悬停看整句话 · 按住左键拖动画布 · Ctrl+滚轮放大</span>
			</div>
			<div class="graph-viewport"><div class="graph-sizer"><div class="graph-zoom">
				<button type="button" class="gnode" style="left: 24px; top: 20px; width: 220px;">
					<span class="lbl">起点</span>
					<span class="meta">2f0a17c · 轮 0</span>
				</button>
				<button type="button" class="gnode" style="left: 300px; top: 20px; width: 380px;">
					<span class="lbl">你好！我看到工作区在 my-coding-agent。需要我做什么？</span>
					<span class="meta">509d794 · 轮 1 <span class="tag">当前</span></span>
				</button>
				<button type="button" class="gnode" style="left: 300px; top: 98px; width: 380px;">
					<span class="lbl">先看看这个目录里有什么</span>
					<span class="meta">aa37d9c · 轮 2</span>
				</button>
			</div></div></div>
		</div>

		<div class="composer-wrap">
			<div class="composer-head">
				<button type="button" class="workspace-chip" aria-haspopup="menu">
					<span class="workspace-chip-label">my-coding-agent</span>
				</button>
			</div>
			<form class="composer">
				<textarea rows="1" spellcheck="false" aria-label="消息" placeholder="Ask for a change, a fix, or an explanation…"></textarea>
				<div class="composer-bar">
					<button type="button" class="icon-button composer-gear" title="会话设置"></button>
					<div class="composer-seat">
						<select class="composer-select" aria-label="模型"><option>Claude Sonnet 4.5 (latest)</option></select>
						<select class="composer-select" aria-label="思考档位"><option>thinking: low</option></select>
					</div>
					<button type="submit" class="button primary"><span>发送</span></button>
				</div>
			</form>
		</div>

		<div class="status-bar">
			<span class="status-stat">total <b>9.6k</b></span>
			<span class="status-stat">cache <b>72%</b></span>
			<span class="status-stat">context <b>2%</b></span>
		</div>
	</section>
</div>

<div class="win-zone" aria-hidden="true"></div>

<script>
	const pane = new URLSearchParams(window.location.search).get("pane");
	if (pane === "branch") {
		document.body.dataset.pane = "branch";
		document.querySelector(".branch-tools").hidden = false;
	}
</script>
</body>
</html>
`;

const out = join(outDir, "fixture-titleband.html");
await writeFile(out, html, "utf8");
console.log(out);
