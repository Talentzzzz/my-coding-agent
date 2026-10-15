// Sidebar smoke: drives the production `Sidebar` against a minimal DOM, and checks the two properties
// that are invisible in a screenshot — that a row is patched rather than rebuilt, and that a row that
// changes moves without being destroyed. A screenshot can show a list that looks right while every
// render replaces every button, which loses a click landing between pointer-down and pointer-up.
// Nothing reaches the network, so no server and no provider key are needed.
// Run with: node scripts/smoke-sidebar.ts
import { Sidebar, type SidebarState } from "../packages/web/src/render/sidebar.ts";
import type { SessionRow } from "@my-agent/core/protocol";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

// ------------------------------------------------------------------ a tiny DOM

/**
 * The smallest DOM the sidebar actually touches.
 *
 * Not a general implementation: only the members the sidebar calls, and each one records what was done
 * to it. The counters are the point — "was this node replaced" is the thing this smoke is about, and a
 * real browser would answer it only by inspecting the heap after the fact.
 */
class FakeNode {
	readonly children: FakeNode[] = [];
	parent: FakeNode | undefined;
	textContent: string | undefined;
	className: string;
	readonly tag: string;
	readonly id: string;
	readonly attributes = new Map<string, string>();
	/**
	 * `dataset`, as a live view of the attributes rather than a separate bag.
	 *
	 * A real `dataset` *is* the attribute map with a different key spelling, and keeping them apart
	 * would let the sidebar set `data-depth` in one and read it from the other without failing here.
	 */
	readonly dataset: Record<string, string> = new Proxy({} as Record<string, string>, {
		get: (_target, key: string) => this.attributes.get(`data-${camelToDash(key)}`),
		set: (_target, key: string, value: string) => {
			this.attributes.set(`data-${camelToDash(key)}`, String(value));
			return true;
		},
		has: (_target, key: string) => this.attributes.has(`data-${camelToDash(key)}`),
		deleteProperty: (_target, key: string) => {
			this.attributes.delete(`data-${camelToDash(key)}`);
			return true;
		},
		ownKeys: () => [...this.attributes.keys()].filter((k) => k.startsWith("data-")).map((k) => k.slice(5)),
		getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
	});
	/** Inline style, as a property bag — the sidebar sets `--depth` on it. */
	readonly style = {
		properties: new Map<string, string>(),
		setProperty(key: string, value: string): void {
			this.properties.set(key, value);
		},
		removeProperty(key: string): void {
			this.properties.delete(key);
		},
	};
	/** The element's tooltip. */
	title = "";
	/** The element's value, which only an input has but any node may carry. */
	value = "";
	/** How many times this exact node was created. Anything above 1 means it was rebuilt. */
	created: number;
	/** Set when a node is pulled out of its parent, so "moved" and "replaced" can be told apart. */
	detached = false;
	/** The viewport box, as a context menu's positioning code measures it. Zeros are fine. */
	getBoundingClientRect(): { left: number; right: number; top: number; bottom: number; width: number; height: number } {
		return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
	}
	/** The input gesture a rename starts with. */
	select(): void {}

	constructor(tag: string, className?: string, text?: string) {
		this.tag = tag;
		this.className = className ?? "";
		this.textContent = text;
		this.id = `n${++FakeNode.counter}`;
		this.created = 1;
	}
	static counter = 0;

	get classList(): { contains(name: string): boolean; add(name: string): void; remove(name: string): void } {
		const names = new Set(this.className.split(/\s+/).filter(Boolean));
		return {
			contains: (name) => names.has(name),
			add: (name) => names.add(name),
			remove: (name) => names.delete(name),
		};
	}

	get firstChild(): FakeNode | undefined { return this.children[0]; }
	get nextSibling(): FakeNode | undefined {
		if (this.parent === undefined) return undefined;
		const at = this.parent.children.indexOf(this);
		return this.parent.children[at + 1];
	}
	get firstElementChild(): FakeNode | undefined { return this.children[0]; }

	append(...nodes: FakeNode[]): void {
		for (const node of nodes) {
			node.parent?.removeChild(node);
			node.parent = this;
			node.detached = false;
			this.children.push(node);
		}
	}
	prepend(...nodes: FakeNode[]): void { this.append(...nodes); }
	replaceChildren(...nodes: FakeNode[]): void {
		for (const child of this.children) { child.detached = true; child.parent = undefined; }
		this.children.length = 0;
		this.append(...nodes);
	}
	removeChild(node: FakeNode): void {
		const at = this.children.indexOf(node);
		if (at >= 0) { this.children.splice(at, 1); node.detached = true; node.parent = undefined; }
	}
	remove(): void { this.parent?.removeChild(this); }
	/** Swap this node out for others in place, which is what the rename editor does to a title. */
	replaceWith(...nodes: FakeNode[]): void {
		const parent = this.parent;
		if (parent === undefined) return;
		const at = parent.children.indexOf(this);
		parent.removeChild(this);
		parent.children.splice(at, 0, ...nodes);
		for (const node of nodes) {
			node.parent?.removeChild(node);
			node.parent = parent;
			node.detached = false;
		}
	}
	/**
	 * Move a node, the way the DOM does it.
	 *
	 * Unlinking from the old parent is bookkeeping, not detachment: a real `insertBefore` on a node that
	 * is already in the tree moves it and leaves it attached throughout, which is the whole property
	 * the sidebar's reordering depends on. Marking it detached here would make a correct move look like
	 * a remove-and-reinsert and the assertion below would be measuring this shim rather than the code.
	 */
	insertBefore(node: FakeNode, reference: FakeNode | null): void {
		const from = node.parent;
		if (from !== undefined) {
			const at = from.children.indexOf(node);
			if (at >= 0) from.children.splice(at, 1);
		}
		node.parent = this;
		const at = reference === null ? this.children.length : this.children.indexOf(reference);
		this.children.splice(at < 0 ? this.children.length : at, 0, node);
	}
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }
	getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
	/**
	 * Listeners are recorded rather than dropped, so the smoke can drive the controls the way a click
	 * would: the search row is opened by its button, and filtered by its input's own event.
	 */
	private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();
	addEventListener(type: string, handler: (event?: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(handler);
		this.listeners.set(type, list);
	}
	/**
	 * Fire one recorded handler, which is what a real click or input event would do.
	 *
	 * `event` travels to the handler, which is how a `contextmenu` carries the pointer a menu opens
	 * at and a `keydown` carries the key that settles a rename.
	 */
	dispatch(type: string, event?: unknown): void {
		for (const handler of this.listeners.get(type) ?? []) handler(event);
	}
	/** Whether this node is the given one or holds it, the containment check `ensureHeading` makes. */
	contains(node: FakeNode): boolean {
		if (node === this) return true;
		return this.children.some((child) => child.contains(node));
	}
	get lastElementChild(): FakeNode | undefined { return this.children.at(-1); }
	focus(): void {}
	set innerHTML(_value: string) {
		this.children.length = 0;
		// One child, so `firstElementChild` has something to hand back. Real markup would nest
		// arbitrarily deep; nothing in this smoke looks inside an icon, so depth would buy nothing.
		const parsed = new FakeNode("svg");
		parsed.parent = this;
		this.children.push(parsed);
	}
	/**
	 * Depth-first search by class name, the one query the sidebar makes.
	 *
	 * Implemented because the sidebar's own `querySelector("[aria-current=\"true\"]")` is a real
	 * behaviour — it decides whether the active row scrolls into view — and a shim that answered
	 * nothing would quietly stop exercising it.
	 */
	querySelector(selector: string): FakeNode | undefined {
		const wanted = selector.startsWith(".") ? selector.slice(1) : undefined;
		const wantedAttribute = selector.match(/^\[([a-z-]+)="([^"]*)"\]$/);
		let found: FakeNode | undefined;
		const walk = (node: FakeNode): void => {
			if (found !== undefined) return;
			if (wanted !== undefined ? node.classList.contains(wanted) : node.getAttribute(wantedAttribute?.[1] ?? "") === wantedAttribute?.[2]) {
				found = node;
				return;
			}
			for (const child of node.children) walk(child);
		};
		walk(this);
		return found;
	}
	scrollIntoView(): void {}
}

/**
 * The sidebar's own element, seen as what this shim built.
 *
 * The one cast in the file, and it is here rather than sprinkled at each call site: the sidebar is
 * typed against the real DOM because that is what it runs on, and the shim implements the members it
 * uses. Every assertion below is about the sidebar's behaviour, so the gap between the two types is
 * not what is under test.
 */
function root(sidebar: Sidebar): FakeNode {
	return sidebar.element as unknown as FakeNode;
}

/** `depth` to `data-depth`: the spelling a real `dataset` uses between a JS name and an attribute. */
function camelToDash(name: string): string {
	return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * Install the shim.
 *
 * `innerHTML` produces exactly one child, because that is all `dom.ts` ever assigns and because
 * `icon()` reads `firstElementChild` straight back out of it. Anything more would be a markup parser.
 *
 * `document.body` is real because the context menu opens there, and the document-level listener
 * stubs exist because a menu registers its dismissal on the document rather than on itself.
 */
const shim = { body: new FakeNode("body") };

function installDom(): void {
	const g = globalThis as unknown as Record<string, unknown>;
	g.document = {
		createElement: (tag: string) => new FakeNode(tag),
		getElementById: () => null,
		documentElement: { dataset: {}, style: { setProperty: () => {} } },
		body: shim.body,
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	g.window = { matchMedia: () => ({ matches: false }), innerWidth: 1280, innerHeight: 800 };
}

/** The shim's `document.body`, which is where an open menu lives. */
function body(): FakeNode {
	return shim.body;
}

installDom();

/** One row as the channel would send it. */
function row(id: string, modified: number, extra: Partial<SessionRow> = {}): SessionRow {
	return { id, cwd: "/w", createdAt: 1, title: `会话 ${id}`, modified, running: false, pending: 0, ...extra };
}

function state(rows: SessionRow[], over: Partial<SidebarState> = {}): SidebarState {
	return { workspaces: [{ cwd: "/w", sessions: rows }], currentWorkspace: "/w", collapsed: false, channel: "live", ...over };
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
		if (node.className === "session-item") {
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
 */
function all(sidebar: Sidebar, className: string): { node: FakeNode; detached: boolean; created: number }[] {
	const found: { node: FakeNode; detached: boolean; created: number }[] = [];
	const walk = (node: FakeNode): void => {
		if (node.className === className) found.push({ node, detached: node.detached, created: node.created });
		for (const child of node.children) walk(child);
	};
	walk(root(sidebar));
	return found;
}

// ------------------------------------------------------------- 1. rows in place

process.stdout.write("\nsidebar：行是原地改的\n");

{
	const selected: string[] = [];
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: (id) => selected.push(id),
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
		onAddWorkspace: () => {},
		onForkSession: () => {},
		onDeleteSession: () => {},
		onRenameSession: () => {},
	});

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
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
		onAddWorkspace: () => {},
		onForkSession: () => {},
		onDeleteSession: () => {},
		onRenameSession: () => {},
	});

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
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
		onAddWorkspace: () => {},
		onForkSession: () => {},
		onDeleteSession: () => {},
		onRenameSession: () => {},
	});

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
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
		onAddWorkspace: () => {},
		onForkSession: () => {},
		onDeleteSession: () => {},
		onRenameSession: () => {},
	});

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
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
		onAddWorkspace: () => {},
		onForkSession: () => {},
		onDeleteSession: () => {},
		onRenameSession: () => {},
	});

	// Two workspaces, so this is about each group rather than about the one group a single-workspace
	// list happens to have. The reported symptom — the rows first, then "📁项目名" — showed up in
	// every group and only got more obvious with more of them.
	sidebar.render({
		workspaces: [
			{ cwd: "/one", sessions: [row("a", 300), row("b", 200)] },
			{ cwd: "/two", sessions: [row("c", 100)] },
		],
		currentWorkspace: "/one",
		collapsed: false,
		channel: "live",
	});

	// The rows are ordered by `modified`, so a positional assertion on the flattened list would be
	// testing the sort. What this looks at instead is the group's own child sequence: the heading is
	// its first child, and no row is allowed above it. Before the fix the first row was inserted
	// before the heading, so the list read "会话 a, 会话 b, 📁one".
	const groups = all(sidebar, "workspace").map((entry) => entry.node.children.map((child) => child.className));
	check("两个分组都在", groups.length === 2, JSON.stringify(groups));
	for (const order of groups) {
		check(
			`标题在它那些行之上：${order.join(" > ")}`,
			order[0] === "workspace-head" && !order.slice(1).includes("workspace-head"),
			JSON.stringify(order),
		);
	}
}

// ----------------------------------------------------------- 6. removals

process.stdout.write("\nsidebar：行会消失\n");

{
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
		onAddWorkspace: () => {},
		onForkSession: () => {},
		onDeleteSession: () => {},
		onRenameSession: () => {},
	});

	sidebar.render(state([row("a", 300), row("b", 200), row("c", 100)]));
	check("三行", titlesOf(sidebar).length === 3);

	sidebar.render(state([row("a", 300), row("c", 100)]));
	check("删掉的行从 DOM 移除", titlesOf(sidebar).map((t) => t.title).join(",") === "会话 a,会话 c", JSON.stringify(titlesOf(sidebar).map((t) => t.title)));

	sidebar.render(state([]));
	check("空列表不留残骸", titlesOf(sidebar).length === 0, JSON.stringify(titlesOf(sidebar)));
}

// ------------------------------------------------- 7. the search really filters

process.stdout.write("\nsidebar：搜索真的过滤\n");

{
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
		onAddWorkspace: () => {},
		onForkSession: () => {},
		onDeleteSession: () => {},
		onRenameSession: () => {},
	});

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
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
		onAddWorkspace: () => {},
		onForkSession: () => {},
		onDeleteSession: () => {},
		onRenameSession: () => {},
	});

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
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
		onAddWorkspace: () => {},
		onForkSession: () => {},
		onDeleteSession: () => {},
		onRenameSession: () => {},
	});

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
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
		onAddWorkspace: () => {},
		onForkSession: () => {},
		onDeleteSession: () => {},
		onRenameSession: () => {},
	});

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
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
		onAddWorkspace: () => {},
		onForkSession: (sessionId) => forked.push(sessionId),
		onDeleteSession: (sessionId) => deleted.push(sessionId),
		onRenameSession: () => {},
	});

	sidebar.render(state([row("a", 300), row("b", 200)]));
	const target = all(sidebar, "session-item")[0]?.node;
	check("行在列表里", target !== undefined);
	target?.dispatch("contextmenu", { clientX: 40, clientY: 60, preventDefault() {} });

	const menu = body().children.find((child) => child.className === "menu");
	check("菜单打开了", menu !== undefined);
	const labels = (menu?.children ?? [])
		.filter((child) => child.className === "menu-item")
		.map((child) => child.querySelector(".menu-label")?.textContent ?? "");
	check("三项都在：派生新会话、重命名、删除", labels.join("|") === "派生新会话|重命名|删除", JSON.stringify(labels));

	const forkItem = (menu?.children ?? []).find((child) => child.className === "menu-item" && child.querySelector(".menu-label")?.textContent === "派生新会话");
	forkItem?.dispatch("click");
	check("派生拿到的是这一行的会话 id", forked.join(",") === "a", JSON.stringify(forked));
	check("选完菜单收起了", body().children.every((child) => child.className !== "menu"));

	target?.dispatch("contextmenu", { clientX: 40, clientY: 60, preventDefault() {} });
	const reopened = body().children.find((child) => child.className === "menu");
	const deleteItem = (reopened?.children ?? []).find((child) => child.className === "menu-item" && child.querySelector(".menu-label")?.textContent === "删除");
	deleteItem?.dispatch("click");
	check("删除拿到的是同一行的会话 id", deleted.join(",") === "a", JSON.stringify(deleted));
}

// ------------------------------------------------- 12. rename, in place

process.stdout.write("\nsidebar：就地改名\n");

{
	const renamed: { sessionId: string; title: string }[] = [];
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
		onAddWorkspace: () => {},
		onForkSession: () => {},
		onDeleteSession: () => {},
		onRenameSession: (sessionId, title) => renamed.push({ sessionId, title }),
	});

	// A root and a fork of it, so the rename shows both halves of the rule: the editor holds the
	// clean name — the fork's own suffix is a fact about its birth, not something to retype — and
	// committing changes nothing on this row, because the name is real storage on the server and the
	// row wears the new one only when its row frame arrives.
	const source = row("s", 300, { createdAt: 100 });
	const forked = row("f", 200, { createdAt: 200, parentId: "s", title: "会话 s" });
	sidebar.render(state([source, forked]));

	const forkRow = all(sidebar, "session-item")[1]?.node;
	forkRow?.dispatch("contextmenu", { clientX: 10, clientY: 10, preventDefault() {} });
	const menu = body().children.find((child) => child.className === "menu");
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
	const again = body().children.find((child) => child.className === "menu");
	const renameAgain = (again?.children ?? []).find((child) => child.className === "menu-item" && child.querySelector(".menu-label")?.textContent === "重命名");
	renameAgain?.dispatch("click");
	const editor = all(sidebar, "rename-input")[0]?.node;
	if (editor !== undefined) {
		editor.value = "没有这一笔";
		editor.dispatch("keydown", { key: "Escape", preventDefault() {} });
	}
	check("Escape 取消，什么都没提交", renamed.length === 1 && titlesOf(sidebar).map((t) => t.title).join(",") === "会话 s,新名字（1）", `${JSON.stringify(renamed)} / ${JSON.stringify(titlesOf(sidebar).map((t) => t.title))}`);
}

process.stdout.write(failures === 0 ? "\nsidebar ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;