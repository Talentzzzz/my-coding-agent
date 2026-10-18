// Sidebar smoke: drives the production `Sidebar` against a minimal DOM, and checks the two properties
// that are invisible in a screenshot — that a row is patched rather than rebuilt, and that a row that
// changes moves without being destroyed. A screenshot can show a list that looks right while every
// render replaces every button, which loses a click landing between pointer-down and pointer-up.
// Nothing reaches the network, so no server and no provider key are needed.
// Run with: node scripts/smoke-sidebar.ts
import { Sidebar, pagingOf, type SidebarHandlers, type SidebarState } from "../packages/web/src/render/sidebar.ts";
import { askForText } from "../packages/web/src/render/text-dialog.ts";
import { SessionRows } from "../packages/web/src/rows.ts";
import { installDom, type FakeNode } from "./dom-shim.ts";
import type { SessionRow, WorkspacePaging } from "@my-agent/core/protocol";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/**
 * The no-op handler set most sections drive with, overridable per section.
 *
 * One builder rather than a literal per section, so a new handler door lands here once instead of
 * being added thirteen times — and so a section that forgets to override a door gets a loud no-op
 * rather than a TypeError at construction.
 */
function handlers(over: Partial<SidebarHandlers> = {}): SidebarHandlers {
	return {
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
		...over,
	};
}

/**
 * The paging contract, as a driver: the sidebar reports clicks, this folds the same state
 * `main.ts`'s three handlers fold, and the next render reads it out of `SidebarState`.
 *
 * The three rules are deliberately the ones `main.ts` implements — expand lands on the saved page,
 * collapse saves the page it was on, 「收起」 steps the expansion back one page — copied here
 * because the sidebar's own behaviour is only half the contract: the other half is that some window
 * turns its reports back into state. If `main.ts` drifts from this, the smoke's red is the drift.
 */
function pagingDriver(over: Partial<SidebarHandlers> = {}): { handlers: SidebarHandlers; paging: Record<string, WorkspacePaging> } {
	const paging: Record<string, WorkspacePaging> = {};
	const driver = handlers({
		onToggleWorkspace: (cwd) => {
			const entry = pagingOf(paging, cwd);
			paging[cwd] = entry.collapsed
				? { collapsed: false, page: entry.savedPage, savedPage: entry.savedPage }
				: { collapsed: true, page: entry.page, savedPage: entry.page };
		},
		onPageWorkspace: (cwd) => {
			const entry = pagingOf(paging, cwd);
			paging[cwd] = { collapsed: false, page: entry.page + 1, savedPage: entry.page + 1 };
		},
		onCollapseWorkspace: (cwd) => {
			const entry = pagingOf(paging, cwd);
			const page = Math.max(1, entry.page - 1);
			paging[cwd] = { collapsed: false, page, savedPage: page };
		},
		...over,
	});
	return { handlers: driver, paging };
}

// ------------------------------------------------------------------ a tiny DOM

/**
 * The DOM comes from `scripts/dom-shim.ts`, which is the **one** copy: this smoke and the jank
 * harness under `.scratch/window-rework/research/` both drive production views against it.
 *
 * They used to hold a copy each, and the copies drifted: the harness's was missing `Node.contains`,
 * which `sidebar.ensureHeading` started using in `482673a` — so this smoke stayed green while the
 * harness silently stopped running at all, and every performance conclusion after that commit was
 * read out of the source instead of measured. One copy is the fix, not a tidier layout.
 *
 * The counters this file leans on are the shim's: `created` (a node constructed more than once was
 * rebuilt) and `detached` (a node pulled out of the tree).
 */
const shim = installDom();

/**
 * The open menu's row list, in order.
 *
 * A menu hangs on the shim's `document.body`, and the menu is a shim node — so the one place this file
 * reaches into node internals is here, named, instead of a `body().children` written out five times.
 */
function bodyChildren(): FakeNode[] {
	return (shim.body as unknown as FakeNode).children;
}

/**
 * The sidebar's own element, seen as what the shim built.
 *
 * The one cast in the file, and it is here rather than sprinkled at each call site: the sidebar is
 * typed against the real DOM because that is what it runs on, and the shim implements the members it
 * uses. Every assertion below is about the sidebar's behaviour, so the gap between the two types is
 * not what is under test.
 */
function root(sidebar: Sidebar): FakeNode {
	return sidebar.element as unknown as FakeNode;
}

/** One row as the channel would send it. */
function row(id: string, modified: number, extra: Partial<SessionRow> = {}): SessionRow {
	return { id, cwd: "/w", createdAt: 1, title: `会话 ${id}`, modified, running: false, pending: 0, ...extra };
}

function state(rows: SessionRow[], over: Partial<SidebarState> = {}): SidebarState {
	return { workspaces: [{ cwd: "/w", sessions: rows }], collapsed: false, paging: {}, channel: "live", ...over };
}

/**
 * Let a synchronously dispatched event's promises run.
 *
 * The rename card answers with a promise, and the heading's handler is suspended on it — so a check
 * written right after `dispatch("keydown")` reads the state from *before* the answer, and reports a
 * working feature as broken. Two turns cover the chain the card actually has: the promise resolving,
 * and the `await` in the handler continuing.
 */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * One drawn row's whole surface, in list order: the title it wears, when its node was created, the
 * state its slot carries, and the tooltip it shows.
 *
 * The one walk every assertion reads through, so the row's shape — the button, the slot, the title,
 * the time — is described exactly once. Rows are looked up by their title because they are ordered
 * by `modified`, so a positional assertion would be testing the sort instead of the row.
 */
function collectRows(sidebar: Sidebar): { title: string; created: number; state: string | null; tooltip: string }[] {
	const found: { title: string; created: number; state: string | null; tooltip: string }[] = [];
	const walk = (node: FakeNode): void => {
		// The same membership rule `all()` reads, so the two walks in this file cannot drift into
		// disagreeing about what counts as a row.
		if (node.classList.contains("session-item")) {
			const titleNode = node.querySelector(".session-item-title");
			found.push({
				title: titleNode?.textContent ?? "?",
				created: titleNode?.created ?? 0,
				state: node.querySelector(".session-item-slot")?.getAttribute("data-state") ?? null,
				tooltip: node.title,
			});
		}
		for (const child of node.children) walk(child);
	};
	walk(root(sidebar));
	return found;
}

/** The row buttons currently in the list, by their title text. */
function titlesOf(sidebar: Sidebar): { title: string; created: number }[] {
	return collectRows(sidebar).map(({ title, created }) => ({ title, created }));
}

/**
 * One row's slot state and tooltip, by the title the row wears.
 *
 * The slot is the row's only status now — the second line it replaced is gone — so "what does this
 * row say about itself" is answered by whether the slot is lit and what the tooltip names the reason
 * with.
 */
function rowsByName(sidebar: Sidebar): Map<string, { state: string | null; tooltip: string }> {
	return new Map(collectRows(sidebar).map(({ title, state, tooltip }) => [title, { state, tooltip }]));
}

/**
 * Every node of a class, anywhere under the sidebar, with whether it was ever detached.
 *
 * The pairing is the point. A row that was *rebuilt* and one that was merely *moved* both come back
 * with the right title, and only the second is the behaviour this file exists to check — a real
 * re-render replaces the button, and a click that started on the old one never reaches the new one.
 * `created` counts constructions, so a rebuilt row shows up as 2.
 *
 * Membership rather than equality, the way `classList.contains` reads a class: a heading wears
 * `workspace-head` and, when it is the current workspace, one more class beside it.
 */
function all(sidebar: Sidebar, className: string): { node: FakeNode; detached: boolean; created: number }[] {
	const found: { node: FakeNode; detached: boolean; created: number }[] = [];
	const walk = (node: FakeNode): void => {
		if (node.classList.contains(className)) found.push({ node, detached: node.detached, created: node.created });
		for (const child of node.children) walk(child);
	};
	walk(root(sidebar));
	return found;
}

// ------------------------------------------------------------- 1. rows in place

process.stdout.write("\nsidebar：行是原地改的\n");

{
	const selected: string[] = [];
	const sidebar = new Sidebar(handlers({ onSelectSession: (id) => selected.push(id) }));

	const rows = [row("a", 300), row("b", 200), row("c", 100)];
	sidebar.render(state(rows, { activeSessionId: "b" }));

	// The brand the column used to open with is gone whole — no logo, no mark, no name — and with it
	// the empty seat its row left behind. The top row holds controls now, or nothing at all.
	check("顶部没有 brand", all(sidebar, "brand").length === 0);
	check("没有任何行带着第二行状态的残骸", all(sidebar, "session-item-status").length === 0);

	const before = titlesOf(sidebar);
	check("三行都在", before.length === 3, JSON.stringify(before.map((t) => t.title)));
	check("按 modified 降序", before.map((t) => t.title).join(",") === "会话 a,会话 b,会话 c", JSON.stringify(before.map((t) => t.title)));

	// The property that matters: a re-render with a changed field must not rebuild the row. A rebuilt
	// row is a new node, and a click that started on the old one never reaches the new one.
	sidebar.render(state([row("a", 300, { running: true }), row("b", 200), row("c", 100)], { activeSessionId: "b" }));
	const after = titlesOf(sidebar);
	check("改字段不重建行", after.every((t) => t.created === 1), JSON.stringify(after));
	check("重建后还是同一批节点", after.map((t) => t.title).join(",") === before.map((t) => t.title).join(","));

	const busyStates = [...rowsByName(sidebar).values()].map((entry) => entry.state);
	check("运行中的行点亮了槽里的点", busyStates.includes("warn"), JSON.stringify(busyStates));
}

// ------------------------------------------------------- 2. reordering in place

process.stdout.write("\nsidebar：重排是移动节点\n");

{
	const sidebar = new Sidebar(handlers());

	const a = row("a", 100);
	const b = row("b", 300);
	sidebar.render(state([a, b]));
	check("初始按 modified 排", titlesOf(sidebar)[0]?.title === "会话 b", JSON.stringify(titlesOf(sidebar).map((t) => t.title)));

	// A background session finishing a turn pushes its row to the top. Nothing may be destroyed and
	// nothing may leave the tree: the same two nodes have to be sitting in a different order.
	sidebar.render(state([row("a", 900), b]));
	const after = titlesOf(sidebar);
	check("重排后顺序按新的 modified", after.map((t) => t.title).join(",") === "会话 a,会话 b", JSON.stringify(after.map((t) => t.title)));

	// The two properties that together mean "moved, not rebuilt". A row that was recreated would show
	// `created === 2`, and one that was removed and put back would show `detached === true` — which is
	// what `replaceChildren()` does to a button between pointer-down and pointer-up.
	const rowsAfter = all(sidebar, "session-item");
	check("重排没有重建任何行", rowsAfter.every((r) => r.created === 1), JSON.stringify(rowsAfter.map((r) => r.created)));
	check("重排没有把任何行脱离过文档树", rowsAfter.every((r) => !r.detached), JSON.stringify(rowsAfter.map((r) => r.detached)));
	check("两行都还在", rowsAfter.length === 2, JSON.stringify(rowsAfter.length));
}

// --------------------------------------------------------- 3. the status slot

process.stdout.write("\nsidebar：状态收进左边的槽\n");

{
	const sidebar = new Sidebar(handlers());

	// Each row's own state, looked up by session rather than by position: rows are ordered by
	// `modified`, so a positional assertion here would be testing the sort instead of the state.
	const rows = [
		row("busy", 400, { running: true }),
		row("waiting", 300, { running: true, pending: 2 }),
		row("quiet", 200),
		row("open", 100),
	];
	sidebar.render(state(rows, { activeSessionId: "open" }));

	const byName = rowsByName(sidebar);

	// Both busy states share the one amber dot — they are the same fact seen from two sides, and the
	// slot has no second colour to hand out. The words move to the tooltip, where the reason a dot
	// is lit can be read rather than guessed.
	check("待审批的行亮着点", byName.get("会话 waiting")?.state === "warn", JSON.stringify([...byName]));
	check("运行中的行亮着点", byName.get("会话 busy")?.state === "warn", JSON.stringify([...byName]));
	check("待审批的名字进了提示", byName.get("会话 waiting")?.tooltip.includes("待审批 2") === true, byName.get("会话 waiting")?.tooltip ?? "");
	check("运行中的名字进了提示", byName.get("会话 busy")?.tooltip.includes("运行中") === true, byName.get("会话 busy")?.tooltip ?? "");

	// The two facts that stopped being lines: an open row is already the `aria-current` background,
	// and a row with nothing to say keeps an empty slot rather than a quiet sentence.
	check("打开但空闲的那一行不亮点（底色本身在说话）", byName.get("会话 open")?.state === null, JSON.stringify([...byName]));
	check("完全没关系的行不亮点", byName.get("会话 quiet")?.state === null, JSON.stringify([...byName]));
	check("空闲的提示里没有状态行", !byName.get("会话 open")!.tooltip.includes("空闲"), byName.get("会话 open")?.tooltip ?? "");
}

// ------------------------------------------------------ 4. connection indicator

process.stdout.write("\nsidebar：连接指示器\n");

{
	const sidebar = new Sidebar(handlers());

	sidebar.render(state([row("a", 1)], { channel: "connecting" }));
	// The indicator lives in the foot now, beside the settings entry — the row it used to share with
	// the brand is gone, and the foot is where window-level things live.
	const indicator = all(sidebar, "channel-indicator")[0]?.node;
	check("连接中：点在那一行上", indicator !== undefined && indicator.dataset.state === "connecting", JSON.stringify(indicator?.dataset.state));
	check("连接中有文案", (indicator?.children[1]?.textContent ?? "") === "连接中…", JSON.stringify(indicator?.children[1]?.textContent));

	sidebar.render(state([row("a", 1)], { channel: "live" }));
	check("live：同一个点", indicator !== undefined && indicator.dataset.state === "live", JSON.stringify(indicator?.dataset.state));
	check("live 时没有文案", (indicator?.children[1]?.textContent ?? "") === "", JSON.stringify(indicator?.children[1]?.textContent));

	sidebar.render(state([row("a", 1)], { channel: "down" }));
	check("down 说它在重试", (indicator?.children[1]?.textContent ?? "").includes("重连"), JSON.stringify(indicator?.children[1]?.textContent));
}

// ------------------------------------------- 5. a heading sits above its rows

process.stdout.write("\nsidebar：分组标题在会话行之上\n");

{
	const sidebar = new Sidebar(handlers());

	// Two workspaces, so this is about each group rather than about the one group a single-workspace
	// list happens to have. The reported symptom — the rows first, then "📁项目名" — showed up in
	// every group and only got more obvious with more of them.
	sidebar.render({
		workspaces: [
			{ cwd: "/one", sessions: [row("a", 300), row("b", 200)] },
			{ cwd: "/two", sessions: [row("c", 100)] },
		],
		collapsed: false,
		paging: {},
		channel: "live",
	});

	// The rows are ordered by `modified`, so a positional assertion on the flattened list would be
	// testing the sort. What this looks at instead is the group's own child sequence: the heading is
	// its first child, and no row is allowed above it. Before the fix the first row was inserted
	// before the heading, so the list read "会话 a, 会话 b, 📁one".
	const groups = all(sidebar, "workspace").map((entry) => entry.node.children.map((child) => child.className));
	check("两个分组都在", groups.length === 2, JSON.stringify(groups));
	for (const order of groups) {
		// The heading may carry the current-workspace class beside its own, so the check is that the
		// first child *is* the heading — `all`'s membership rule, one group at a time.
		check(
			`标题在它那些行之上：${order.join(" > ")}`,
			order[0]?.startsWith("workspace-head") === true && !order.slice(1).some((name) => name.startsWith("workspace-head")),
			JSON.stringify(order),
		);
	}
}

// ----------------------------------------------------------- 6. removals

process.stdout.write("\nsidebar：行会消失\n");

{
	const sidebar = new Sidebar(handlers());

	sidebar.render(state([row("a", 300), row("b", 200), row("c", 100)]));
	check("三行", titlesOf(sidebar).length === 3);

	sidebar.render(state([row("a", 300), row("c", 100)]));
	check("删掉的行从 DOM 移除", titlesOf(sidebar).map((t) => t.title).join(",") === "会话 a,会话 c", JSON.stringify(titlesOf(sidebar).map((t) => t.title)));

	sidebar.render(state([]));
	check("空列表不留残骸", titlesOf(sidebar).length === 0, JSON.stringify(titlesOf(sidebar)));

	// The first paint lands before the list is fetched, so the 「暂无会话」 note is a phase rather than
	// a row. It has to go when the first workspace arrives — otherwise every session of every group is
	// drawn under a sentence saying there are none, which is what the window used to show.
	sidebar.render(state([], { workspaces: [] }));
	const phase = all(sidebar, "session-list-empty").map((entry) => entry.node.textContent);
	check("还没有工作区时说暂无会话", phase.includes("暂无会话"), JSON.stringify(phase));
	sidebar.render(state([row("a", 300)]));
	const leftOver = all(sidebar, "session-list-empty")
		.filter((entry) => !entry.detached)
		.map((entry) => entry.node.textContent);
	check("工作区一到，「暂无会话」就撤掉", !leftOver.includes("暂无会话"), JSON.stringify(leftOver));
	check("撤掉之后行还在", titlesOf(sidebar).length === 1, JSON.stringify(titlesOf(sidebar).map((t) => t.title)));
}

// ------------------------------------------------- 7. the search really filters

process.stdout.write("\nsidebar：搜索真的过滤\n");

{
	const sidebar = new Sidebar(handlers());

	sidebar.render(state([row("alpha", 300), row("beta", 200)]));

	// Opened by its own button, the way a click opens it; the shim records handlers, so dispatching
	// one is dispatching the click.
	const searchButton = all(sidebar, "icon-button").find((entry) => entry.node.getAttribute("title") === "搜索会话");
	check("搜索按钮在标题行上", searchButton !== undefined);
	searchButton?.node.dispatch("click");

	const input = all(sidebar, "search-input")[0]?.node;
	check("搜索行打开了输入框", input !== undefined);
	if (input !== undefined) {
		input.value = "alpha";
		input.dispatch("input");
		const titles = titlesOf(sidebar).map((t) => t.title);
		check("过滤后只剩匹配的行", titles.join(",") === "会话 alpha", JSON.stringify(titles));

		input.value = "没有这一条";
		input.dispatch("input");
		const note = all(sidebar, "session-list-empty")[0]?.node;
		check("没有匹配时说没有匹配", note !== undefined && note.textContent === "没有匹配的会话", JSON.stringify(note?.textContent));

		input.value = "";
		input.dispatch("input");
		const restored = titlesOf(sidebar).map((t) => t.title);
		check("清空搜索把行都放回来", restored.join(",") === "会话 alpha,会话 beta", JSON.stringify(restored));
		const workspaces = all(sidebar, "workspace");
		check("分组不是被删掉的", workspaces.every((entry) => entry.created === 1), JSON.stringify(workspaces.map((entry) => entry.created)));
	}
}

// ------------------------------------------------- 8. a fork row looks like any row

process.stdout.write("\nsidebar：fork 的行跟普通行一模一样\n");

{
	const sidebar = new Sidebar(handlers());

	// One root, one fork of it. The fork keeps its tree place — right beneath the session it came
	// from — but draws no indent, no mark, and no depth of any kind: the name, suffix included, is
	// the whole difference.
	const source = row("s", 300, { createdAt: 100 });
	const forked = row("f", 200, { createdAt: 200, parentId: "s", title: "会话 s" });
	sidebar.render(state([source, forked]));

	const order = titlesOf(sidebar).map((t) => t.title);
	check("fork 的行紧跟源行，名字带着（1）", order.join(",") === "会话 s,会话 s（1）", JSON.stringify(order));
	check("没有任何行带着缩进深度", all(sidebar, "session-item").every((entry) => entry.node.getAttribute("data-depth") === null));
	check("没有任何 fork 标记", all(sidebar, "session-fork-mark").length === 0, JSON.stringify(all(sidebar, "session-fork-mark").length));
}

// ------------------------------------------------- 9. the suffix is drawn, not stored

process.stdout.write("\nsidebar：（1）由渲染拼出来\n");

{
	const sidebar = new Sidebar(handlers());

	// Three forks of one source, born out of order; the number is the sibling's own place under the
	// same parent by creation time, and nothing anywhere stores it. A fork of a fork hangs its suffix
	// on the parent's *display* title, so the numbers stack: 标题（2）（1）, not 标题（1）again.
	const source = row("s", 500, { createdAt: 100 });
	const one = row("f1", 400, { createdAt: 300, parentId: "s", title: "会话 s" });
	const two = row("f2", 300, { createdAt: 200, parentId: "s", title: "会话 s" });
	const three = row("f3", 200, { createdAt: 400, parentId: "s", title: "会话 s" });
	const grand = row("g", 100, { createdAt: 500, parentId: "f1", title: "会话 s" });
	sidebar.render(state([source, one, two, three, grand]));

	const titles = titlesOf(sidebar).map((t) => t.title);
	check("三个兄弟按创建时间拿到 1、2、3", titles.includes("会话 s（1）") && titles.includes("会话 s（2）") && titles.includes("会话 s（3）"), JSON.stringify(titles));
	check("派生的再派生叠在父行的显示标题上", titles.includes("会话 s（2）（1）"), JSON.stringify(titles));
	check("源行自己不带后缀", titles.includes("会话 s"), JSON.stringify(titles));
}

// --------------------------------- 10. a forked session arrives through its row frame

process.stdout.write("\nsidebar：新会话出现在列表里\n");

{
	const sidebar = new Sidebar(handlers());

	// The listing the window had before the fork, then the same listing with the fork's row in it —
	// which is exactly what the connection's `session_row` frame delivers. The row has to appear
	// beneath its source with its suffix on, and nothing already on screen may be rebuilt to make
	// room: the client never inserts a row of its own.
	const source = row("s", 300, { createdAt: 100 });
	sidebar.render(state([source]));
	const sourceNode = all(sidebar, "session-item")[0]?.node;

	sidebar.render(state([source, row("f", 200, { createdAt: 200, parentId: "s", title: "会话 s" })]));
	const after = titlesOf(sidebar);
	check("fork 出现了", after.length === 2, JSON.stringify(after.map((t) => t.title)));
	check("带着（1），紧跟源行", after.map((t) => t.title).join(",") === "会话 s,会话 s（1）", JSON.stringify(after.map((t) => t.title)));
	check(
		"原来的行没有为它重建",
		all(sidebar, "session-item").some((entry) => entry.node === sourceNode && entry.created === 1 && !entry.detached),
	);
}

// ------------------------------------------------- 11. the row's own context menu

process.stdout.write("\nsidebar：右键菜单\n");

{
	const forked: string[] = [];
	const deleted: string[] = [];
	const sidebar = new Sidebar(
		handlers({
			onForkSession: (sessionId) => forked.push(sessionId),
			onDeleteSession: (sessionId) => deleted.push(sessionId),
		}),
	);

	sidebar.render(state([row("a", 300), row("b", 200)]));
	const target = all(sidebar, "session-item")[0]?.node;
	check("行在列表里", target !== undefined);
	target?.dispatch("contextmenu", { clientX: 40, clientY: 60, preventDefault() {} });

	const menu = bodyChildren().find((child) => child.className === "menu");
	check("菜单打开了", menu !== undefined);
	const labels = (menu?.children ?? [])
		.filter((child) => child.className === "menu-item")
		.map((child) => child.querySelector(".menu-label")?.textContent ?? "");
	check("三项都在：派生新会话、重命名、删除", labels.join("|") === "派生新会话|重命名|删除", JSON.stringify(labels));

	const forkItem = (menu?.children ?? []).find((child) => child.className === "menu-item" && child.querySelector(".menu-label")?.textContent === "派生新会话");
	forkItem?.dispatch("click");
	check("派生拿到的是这一行的会话 id", forked.join(",") === "a", JSON.stringify(forked));
	check("选完菜单收起了", bodyChildren().every((child) => child.className !== "menu"));

	target?.dispatch("contextmenu", { clientX: 40, clientY: 60, preventDefault() {} });
	const reopened = bodyChildren().find((child) => child.className === "menu");
	const deleteItem = (reopened?.children ?? []).find((child) => child.className === "menu-item" && child.querySelector(".menu-label")?.textContent === "删除");
	deleteItem?.dispatch("click");
	check("删除拿到的是同一行的会话 id", deleted.join(",") === "a", JSON.stringify(deleted));
}

// ------------------------------------------------- 12. rename, in place

process.stdout.write("\nsidebar：就地改名\n");

{
	const renamed: { sessionId: string; title: string }[] = [];
	const sidebar = new Sidebar(handlers({ onRenameSession: (sessionId, title) => renamed.push({ sessionId, title }) }));

	// A root and a fork of it, so the rename shows both halves of the rule: the editor holds the
	// clean name — the fork's own suffix is a fact about its birth, not something to retype — and
	// committing changes nothing on this row, because the name is real storage on the server and the
	// row wears the new one only when its row frame arrives.
	const source = row("s", 300, { createdAt: 100 });
	const forked = row("f", 200, { createdAt: 200, parentId: "s", title: "会话 s" });
	sidebar.render(state([source, forked]));

	const forkRow = all(sidebar, "session-item")[1]?.node;
	forkRow?.dispatch("contextmenu", { clientX: 10, clientY: 10, preventDefault() {} });
	const menu = bodyChildren().find((child) => child.className === "menu");
	const renameItem = (menu?.children ?? []).find((child) => child.className === "menu-item" && child.querySelector(".menu-label")?.textContent === "重命名");
	renameItem?.dispatch("click");

	const input = all(sidebar, "rename-input")[0]?.node;
	check("编辑框出现在行里", input !== undefined);
	check("编辑的是去掉后缀的名字", input?.value === "会话 s", String(input?.value));

	check("提交前没有提交过任何名字", renamed.length === 0);
	if (input !== undefined) {
		input.value = "新名字";
		input.dispatch("keydown", { key: "Enter", preventDefault() {} });
		check("提交的是净名和这一行的会话 id", renamed.length === 1 && renamed[0]!.sessionId === "f" && renamed[0]!.title === "新名字", JSON.stringify(renamed));
		check("本行没有自己改名字", titlesOf(sidebar).map((t) => t.title).join(",") === "会话 s,会话 s（1）", JSON.stringify(titlesOf(sidebar).map((t) => t.title)));
		check("编辑框换回了标题", all(sidebar, "rename-input").length === 0);
	}

	// The server stored it; the row frame is how the list finds out. The suffix comes back on its
	// own — it was never part of what the user typed, and the tree still knows the row's place.
	sidebar.render(state([source, row("f", 200, { createdAt: 200, parentId: "s", title: "新名字" })]));
	check("行帧到了，名字换上、后缀自己拼回", titlesOf(sidebar).map((t) => t.title).join(",") === "会话 s,新名字（1）", JSON.stringify(titlesOf(sidebar).map((t) => t.title)));

	// Escape sends nothing at all — the typed text included.
	const rootRow = all(sidebar, "session-item")[0]?.node;
	rootRow?.dispatch("contextmenu", { clientX: 10, clientY: 10, preventDefault() {} });
	const again = bodyChildren().find((child) => child.className === "menu");
	const renameAgain = (again?.children ?? []).find((child) => child.className === "menu-item" && child.querySelector(".menu-label")?.textContent === "重命名");
	renameAgain?.dispatch("click");
	const editor = all(sidebar, "rename-input")[0]?.node;
	if (editor !== undefined) {
		editor.value = "没有这一笔";
		editor.dispatch("keydown", { key: "Escape", preventDefault() {} });
	}
	check("Escape 取消，什么都没提交", renamed.length === 1 && titlesOf(sidebar).map((t) => t.title).join(",") === "会话 s,新名字（1）", `${JSON.stringify(renamed)} / ${JSON.stringify(titlesOf(sidebar).map((t) => t.title))}`);
}

// ------------------------------------------------- 7. workspace group ordering

process.stdout.write("\nsidebar：工作区按最近活跃在前\n");

{
	// The server's own listing sorts groups by their newest activity, most recent first, and the
	// window's live path must agree with it — a message landing in a workspace moves that workspace
	// to the top of the sidebar. The store, not the view, owns this sort, so the check drives
	// `SessionRows` directly: two groups whose newest rows disagree in both directions.
	const store = new SessionRows();
	store.put(row("a", 100, { cwd: "/old" }));
	store.put(row("c", 300, { cwd: "/new" }));
	check("初始：最近活跃的在前", store.groups().map((group) => group.cwd).join(",") === "/new,/old", JSON.stringify(store.groups().map((group) => group.cwd)));

	// A message lands in the older workspace: its row's `modified` moves forward and the group order
	// follows — the one frame the projection sends for every appended message.
	store.put(row("a", 400, { cwd: "/old" }));
	check("活跃后：老的反超到第一", store.groups().map((group) => group.cwd).join(",") === "/old,/new", JSON.stringify(store.groups().map((group) => group.cwd)));
}

// -------- 13. paging: one more page per press, one back per collapse, side by side

process.stdout.write("\nsidebar：分页 ——「展开其余」一次加一页，「收起」在它右边退一页\n");

{
	const { handlers: driver, paging } = pagingDriver();
	const sidebar = new Sidebar(driver);
	// Twelve root conversations, newest first. The active session sits on the first root, so the
	// always-visible rule never fires and the numbers below are pure paging.
	const rows = Array.from({ length: 12 }, (_unused, index) => row(`s${index}`, 1200 - index * 100));
	const render = (): void => sidebar.render(state(rows, { activeSessionId: "s0", paging }));

	const more = (): FakeNode => all(sidebar, "session-more")[0]!.node;
	const collapse = (): FakeNode => all(sidebar, "session-collapse")[0]!.node;
	const pagingRow = (): FakeNode => all(sidebar, "session-paging")[0]!.node;
	// The buttons are patched, not rebuilt: 「收起」 stays in the row and its *presence* is the
	// `hidden` attribute, so "is it on screen" is a visibility question, not a count of nodes.
	const collapseShown = (): boolean => all(sidebar, "session-collapse").some((entry) => !entry.node.hidden);

	render();
	check("默认一页：只有 5 个会话", titlesOf(sidebar).length === 5, String(titlesOf(sidebar).length));
	check("底部写着「展开其余 7 个会话」", more().textContent === "展开其余 7 个会话", more().textContent);
	check("第一页没有「收起」：没有可收的", !collapseShown(), String(collapseShown()));

	more().dispatch("click");
	render();
	check("点一次多 5 条", titlesOf(sidebar).length === 10, String(titlesOf(sidebar).length));
	check("按钮数到剩下的 2 个", more().textContent === "展开其余 2 个会话", more().textContent);
	check("展开之后「收起」出现了", collapseShown(), String(collapseShown()));
	check("两个按钮在同一行里", pagingRow().children.length === 2, JSON.stringify(pagingRow().children.map((child) => child.className)));
	check("「收起」在「展开其余」的右边", pagingRow().children[0]?.classList.contains("session-collapse") === false && pagingRow().children[1]?.classList.contains("session-collapse") === true, JSON.stringify(pagingRow().children.map((child) => child.className)));

	more().dispatch("click");
	render();
	check("再点一次：12 条全在", titlesOf(sidebar).length === 12, String(titlesOf(sidebar).length));
	check("全部展开后只剩「收起」", more().hidden && !collapse().hidden, `more.hidden=${String(more().hidden)}`);
	collapse().dispatch("click");
	render();
	check("「收起」退一页：10 条", titlesOf(sidebar).length === 10, String(titlesOf(sidebar).length));
	check("「展开其余」跟着回来了", more().textContent === "展开其余 2 个会话", more().textContent);
	check("退了一页后「收起」还在", collapseShown(), String(collapseShown()));
	collapse().dispatch("click");
	render();
	check("再退一次：回到一页 5 条", titlesOf(sidebar).length === 5, String(titlesOf(sidebar).length));
	check("退回第一页后「收起」又没了", !collapseShown(), String(collapseShown()));
	check("「展开其余」还写着 7 个", more().textContent === "展开其余 7 个会话", more().textContent);

	// A workspace with no more than a page never wears any paging control: there was nothing held
	// back, so there is nothing to expand and nothing to collapse.
	const small = new Sidebar(handlers());
	small.render(state([row("a", 300), row("b", 200), row("c", 100)]));
	check("一页装得下的工作区没有分页按钮", all(small, "session-paging").length === 0, String(all(small, "session-paging").length));
}

// ------------------------- 14. the head collapses to itself and reopens on the saved page

process.stdout.write("\nsidebar：表头收起只剩表头，重开回到上次那一页\n");

{
	const { handlers: driver, paging } = pagingDriver();
	const sidebar = new Sidebar(driver);
	const rows = Array.from({ length: 12 }, (_unused, index) => row(`s${index}`, 1200 - index * 100));
	const render = (): void => sidebar.render(state(rows, { activeSessionId: "s0", paging }));
	render();

	// Read down to the second page, then fold the whole workspace away with its head.
	all(sidebar, "session-more")[0]!.node.dispatch("click");
	render();
	check("第二页在屏上", titlesOf(sidebar).length === 10, String(titlesOf(sidebar).length));
	const head = (): FakeNode => all(sidebar, "workspace-head")[0]!.node;
	check("表头是个真按钮", head().tagName === "BUTTON", head().tagName);
	check("展开时 aria-expanded=true", head().getAttribute("aria-expanded") === "true", String(head().getAttribute("aria-expanded")));
	head().dispatch("click");
	render();
	check("收起后这个分组没有会话行", titlesOf(sidebar).length === 0, JSON.stringify(titlesOf(sidebar).map((t) => t.title)));
	check("收起后只剩表头：没有分页按钮", all(sidebar, "session-more").length === 0, String(all(sidebar, "session-more").length));
	check("表头还在", all(sidebar, "workspace-head").length === 1);
	check("收起时 aria-expanded=false", head().getAttribute("aria-expanded") === "false", String(head().getAttribute("aria-expanded")));

	head().dispatch("click");
	render();
	check("重开回到上次那一页：10 条", titlesOf(sidebar).length === 10, String(titlesOf(sidebar).length));
	check("重开时 aria-expanded=true", head().getAttribute("aria-expanded") === "true", String(head().getAttribute("aria-expanded")));
}

// --------------------------------- 15. paging counts conversations, not rows

process.stdout.write("\nsidebar：分页按会话数走 —— 根加它的派生算一个\n");

{
	const sidebar = new Sidebar(handlers());
	// One family of four rows (a root and three forks) plus five more roots: six conversations in
	// nine rows. The first page holds the first *five conversations* — the family takes three extra
	// rows with it and still costs one slot — so the sixth conversation is what the button counts.
	const family = row("root", 900, { createdAt: 100 });
	const forks = [1, 2, 3].map((index) =>
		row(`fork${index}`, 800 - index * 10, { createdAt: 100 + index, parentId: "root", title: "会话 root" }),
	);
	const rest = Array.from({ length: 5 }, (_unused, index) => row(`r${index}`, 700 - index * 100));
	sidebar.render(state([family, ...forks, ...rest], { activeSessionId: "root" }));

	const titles = titlesOf(sidebar).map((t) => t.title);
	check("第一页是五个会话：九行里进来八行", titles.length === 8, JSON.stringify(titles));
	check("第五个会话在", titles.includes("会话 r3"), JSON.stringify(titles));
	check("第六个会话不在", !titles.includes("会话 r4"), JSON.stringify(titles));
	const more = all(sidebar, "session-more")[0]?.node;
	check("按钮数的是被挡住的行", more?.textContent === "展开其余 1 个会话", more?.textContent ?? "");
}

// ------------------------------- 16. a filter shows every match, paging or not

process.stdout.write("\nsidebar：搜索翻出全部匹配，收起与分页都不拦\n");

{
	const sidebar = new Sidebar(handlers());
	const rows = Array.from({ length: 12 }, (_unused, index) => row(`s${index}`, 1200 - index * 100));
	// Drawn collapsed straight from the state, without any click: the draw must honour whatever the
	// appearance settings hold, including a workspace that was folded away in another window.
	sidebar.render(state(rows, { activeSessionId: "s0", paging: { "/w": { collapsed: true, page: 1, savedPage: 1 } } }));
	check("收起的工作区不出行", titlesOf(sidebar).length === 0, String(titlesOf(sidebar).length));

	all(sidebar, "icon-button")
		.find((entry) => entry.node.getAttribute("title") === "搜索会话")
		?.node.dispatch("click");
	const input = all(sidebar, "search-input")[0]!.node;
	input.value = "s1";
	input.dispatch("input");
	const titles = titlesOf(sidebar).map((t) => t.title);
	// s1, s10, s11 — every match, in a group whose own list was folded away.
	check("收着的工作区照样给出全部匹配", titles.length === 3, JSON.stringify(titles));
}

// ----------------------------------- 18. the workspace head's own context menu

process.stdout.write("\nsidebar：工作区表头的右键菜单\n");

await (async (): Promise<void> => {
	const started: (string | undefined)[] = [];
	const deleted: string[] = [];
	const renamed: { cwd: string; name: string }[] = [];
	const sidebar = new Sidebar(
		handlers({
			onNewSession: (cwd) => started.push(cwd),
			onDeleteWorkspace: (cwd) => deleted.push(cwd),
			onRenameWorkspace: (cwd, name) => renamed.push({ cwd, name }),
		}),
	);

	sidebar.render({
		workspaces: [
			{ cwd: "/one", sessions: [row("a", 300)] },
			{ cwd: "/two", sessions: [row("b", 200)] },
		],
		collapsed: false,
		paging: {},
		channel: "live",
	});

	// Right-clicked on the *second* group's heading, so an answer that ignored which heading was under
	// the pointer would name the wrong workspace and be caught here.
	const heads = all(sidebar, "workspace-head");
	check("两个表头都画出来了", heads.length === 2, String(heads.length));
	heads[1]?.node.dispatch("contextmenu", { clientX: 30, clientY: 40, preventDefault() {} });

	const menu = (): FakeNode | undefined => bodyChildren().find((child) => child.className === "menu");
	check("菜单打开了", menu() !== undefined);
	const labels = (menu()?.children ?? [])
		.filter((child) => child.className === "menu-item")
		.map((child) => child.querySelector(".menu-label")?.textContent ?? "");
	check("三项都在：新建会话、重命名…、删除", labels.join("|") === "新建会话|重命名…|删除", JSON.stringify(labels));

	// 新建会话 carries the cwd it was asked on, which is the acceptance criterion of 票 06 in one line:
	// the new session lands in the workspace that was right-clicked, not in whatever is current.
	const item = (label: string): FakeNode | undefined =>
		(menu()?.children ?? []).find(
			(child) => child.className === "menu-item" && child.querySelector(".menu-label")?.textContent === label,
		);
	item("新建会话")?.dispatch("click");
	check("新建会话拿到的是右键那个工作区的路径", started.join(",") === "/two", JSON.stringify(started));
	check("选完菜单收起了", menu() === undefined);

	heads[1]?.node.dispatch("contextmenu", { clientX: 30, clientY: 40, preventDefault() {} });
	item("删除")?.dispatch("click");
	check("删除拿到的是同一个工作区", deleted.join(",") === "/two", JSON.stringify(deleted));

	// 重命名 opens the card rather than reporting straight away: the name the user types is a segment,
	// and the heading passes it on with the group it was asked on. Committing here is the card's own
	// contract, driven through the DOM the way the menu's items are — and every commit is awaited,
	// because the heading's handler runs on the promise the card resolves.
	heads[1]?.node.dispatch("contextmenu", { clientX: 30, clientY: 40, preventDefault() {} });
	item("重命名…")?.dispatch("click");
	const card = bodyChildren().find((child) => child.className === "text-dialog-overlay");
	check("卡片打开了", card !== undefined);
	const input = card?.querySelector(".text-dialog-input");
	check("输入框里是当前的文件夹名", input?.value === "two", String(input?.value));
	check("提交前没有报过任何重命名", renamed.length === 0);

	if (input != null) {
		input.value = "renamed";
		input.dispatch("keydown", { key: "Enter", preventDefault() {} });
	}
	await settle();
	check("提交的是原路径加新名字", renamed.length === 1 && renamed[0]!.cwd === "/two" && renamed[0]!.name === "renamed", JSON.stringify(renamed));
	check("卡片关上了", bodyChildren().every((child) => child.className !== "text-dialog-overlay"));

	// Typing the name the folder already wears is not a change, and a separator is not a name: both are
	// dropped rather than sent, because the header rewrite assumes only the last segment moved.
	const reopenAndType = async (value: string): Promise<void> => {
		heads[1]?.node.dispatch("contextmenu", { clientX: 30, clientY: 40, preventDefault() {} });
		item("重命名…")?.dispatch("click");
		const field = bodyChildren().find((child) => child.className === "text-dialog-overlay")?.querySelector(".text-dialog-input");
		if (field != null) {
			field.value = value;
			field.dispatch("keydown", { key: "Enter", preventDefault() {} });
		}
		await settle();
	};
	await reopenAndType("two");
	check("名字没变就不发请求", renamed.length === 1, JSON.stringify(renamed));
	await reopenAndType("a/b");
	check("带路径分隔符的名字被丢掉", renamed.length === 1, JSON.stringify(renamed));
	await reopenAndType("..");
	check("`..` 也被丢掉", renamed.length === 1, JSON.stringify(renamed));
})();

// ------------------------- 19. a renamed group is re-keyed, not left beside the old one

process.stdout.write("\nsidebar：重命名后表头跟着新路径走\n");

{
	const sidebar = new Sidebar(handlers());
	const two = (cwd: string): SidebarState => ({
		workspaces: [{ cwd, sessions: [row("a", 300, { cwd })] }],
		collapsed: false,
		paging: {},
		channel: "live",
	});

	sidebar.render(two("/work/old"));
	const head = all(sidebar, "workspace-head")[0]!.node;
	// The *wrapper* is what the sweep drops, and `remove()` only detaches the node it was called on — so
	// the node whose survival is being checked has to be the wrapper, not the heading inside it.
	const wrapper = head.parent!;
	check("表头写着旧名字", head.querySelector(".workspace-name")?.textContent === "old", String(head.querySelector(".workspace-name")?.textContent));

	// The group comes back under its new path, which is what the channel's row frames produce after the
	// rename. The node that wore the old path must lose it rather than be joined by a second heading:
	// a stale heading is a folder the user can right-click that no longer exists.
	sidebar.render(two("/work/new"));
	const heads = all(sidebar, "workspace-head");
	check("只剩一个表头", heads.length === 1, String(heads.length));
	check("名字换成了新文件夹名", heads[0]?.node.querySelector(".workspace-name")?.textContent === "new", String(heads[0]?.node.querySelector(".workspace-name")?.textContent));
	check("tooltip 也换成了新路径", heads[0]?.node.getAttribute("title") === "/work/new", String(heads[0]?.node.getAttribute("title")));
	check("旧分组连同它的表头一起从文档里摘掉了", wrapper.detached && head.parent === wrapper, `detached=${wrapper.detached} headParentKept=${head.parent === wrapper}`);
}

// ------------------------- 20. the two roads that answer "nothing was asked"

process.stdout.write("\nsidebar：取消与被顶掉都要给出答案\n");

{
	// The card answers with a promise, so there are three ways out and one of them used to leak: Escape
	// took the card away without settling anything, and the caller waited for the rest of the window's
	// life. None of that is visible on screen, which is why it is asserted here on the promise itself
	// rather than through the sidebar's handler.
	const dialog = { title: "重命名工作区", label: "新的文件夹名", value: "two", confirm: "重命名" };
	const settled = (): FakeNode | undefined => bodyChildren().find((child) => child.className === "text-dialog-overlay");
	const keydownsBefore = shim.document.listenerCount("keydown");
	/**
	 * The card's answer, encoded — and a leak has to read as a failure rather than as a hung smoke: a
	 * promise that never settles is exactly the bug, so waiting for it forever would hide it.
	 */
	const answerOf = async (answer: Promise<string | undefined>): Promise<string> => {
		const timedOut = Symbol("no answer");
		const raced = await Promise.race([answer, new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), 50))]);
		return raced === timedOut ? "（没有回答，promise 悬着）" : JSON.stringify(raced ?? null);
	};

	const escaped = askForText(dialog);
	check("卡片打开了", settled() !== undefined);
	check("卡片挂上了 document 的键盘监听", shim.document.listenerCount("keydown") === keydownsBefore + 1);
	shim.document.dispatch("keydown", { key: "Escape", stopPropagation() {} });
	check("Escape 之后卡片关上了", settled() === undefined);
	check("Escape 把监听也摘了", shim.document.listenerCount("keydown") === keydownsBefore);
	check("Escape 让调用方拿到「什么都没问」", (await answerOf(escaped)) === "null");

	// One card at a time, and the card that is replaced is settled rather than merely removed: it is the
	// same leak by another road, and the second question is the one whose answer is still wanted.
	const superseded = askForText(dialog);
	const current = askForText(dialog);
	check("屏幕上只剩一张卡片", bodyChildren().filter((child) => child.className === "text-dialog-overlay").length === 1);
	check("被顶掉的那张以「什么都没问」收场", (await answerOf(superseded)) === "null");
	shim.document.dispatch("keydown", { key: "Escape", stopPropagation() {} });
	check("留在屏幕上的那张也能收场", (await answerOf(current)) === "null");
	check("没有卡片留在页面上", settled() === undefined);
}

process.stdout.write(failures === 0 ? "\nsidebar ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
