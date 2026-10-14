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
	/** How many times this exact node was created. Anything above 1 means it was rebuilt. */
	created: number;
	/** Set when a node is pulled out of its parent, so "moved" and "replaced" can be told apart. */
	detached = false;

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
	prepend(node: FakeNode): void { this.append(node); }
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
	addEventListener(): void {}
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
 */
function installDom(): void {
	const g = globalThis as unknown as Record<string, unknown>;
	g.document = {
		createElement: (tag: string) => new FakeNode(tag),
		getElementById: () => null,
		documentElement: { dataset: {}, style: { setProperty: () => {} } },
	};
	g.window = { matchMedia: () => ({ matches: false }) };
}

installDom();

/** One row as the channel would send it. */
function row(id: string, modified: number, extra: Partial<SessionRow> = {}): SessionRow {
	return { id, cwd: "/w", createdAt: 1, title: `会话 ${id}`, modified, running: false, pending: 0, ...extra };
}

function state(rows: SessionRow[], over: Partial<SidebarState> = {}): SidebarState {
	return { workspaces: [{ cwd: "/w", sessions: rows }], currentWorkspace: "/w", collapsed: false, channel: "live", ...over };
}

/** The row buttons currently in the list, by their title text. */
function titlesOf(sidebar: Sidebar): { title: string; created: number }[] {
	const found: { title: string; created: number }[] = [];
	const walk = (node: FakeNode): void => {
		if (node.className === "session-item") {
			// A row is the button, its fork mark and its body; the body holds the two lines, and the
			// title is on the first of them. So: button -> body -> line -> title.
			const title = node.querySelector(".session-item-title");
			found.push({ title: title?.textContent ?? "?", created: title?.created ?? 0 });
		}
		for (const child of node.children) walk(child);
	};
	walk(root(sidebar));
	return found;
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
	});

	const rows = [row("a", 300), row("b", 200), row("c", 100)];
	sidebar.render(state(rows, { activeSessionId: "b" }));

	const before = titlesOf(sidebar);
	check("三行都在", before.length === 3, JSON.stringify(before.map((t) => t.title)));
	check("按 modified 降序", before.map((t) => t.title).join(",") === "会话 a,会话 b,会话 c", JSON.stringify(before.map((t) => t.title)));

	// The property that matters: a re-render with a changed field must not rebuild the row. A rebuilt
	// row is a new node, and a click that started on the old one never reaches the new one.
	sidebar.render(state([row("a", 300, { running: true }), row("b", 200), row("c", 100)], { activeSessionId: "b" }));
	const after = titlesOf(sidebar);
	check("改字段不重建行", after.every((t) => t.created === 1), JSON.stringify(after));
	check("重建后还是同一批节点", after.map((t) => t.title).join(",") === before.map((t) => t.title).join(","));

	const statuses = all(sidebar, "session-item-status").map((entry) => entry.node.textContent ?? "");
	check("运行中的行有第二行状态", statuses.includes("● 运行中"), JSON.stringify(statuses));
}

// ------------------------------------------------------- 2. reordering in place

process.stdout.write("\nsidebar：重排是移动节点\n");

{
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
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

// --------------------------------------------------------- 3. status precedence

process.stdout.write("\nsidebar：第二行状态\n");

{
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
	});

	// Each row's own status, looked up by session rather than by position: rows are ordered by
	// `modified`, so a positional assertion here would be testing the sort instead of the precedence.
	const rows = [
		row("busy", 400, { running: true }),
		row("waiting", 300, { running: true, pending: 2 }),
		row("quiet", 200),
		row("open", 100),
	];
	sidebar.render(state(rows, { activeSessionId: "open" }));

	const statusBySession = new Map<string, string>();
	const walk = (node: FakeNode): void => {
		if (node.className === "session-item") {
			const title = node.querySelector(".session-item-title")?.textContent ?? "?";
			statusBySession.set(title, node.querySelector(".session-item-status")?.textContent ?? "");
		}
		for (const child of node.children) walk(child);
	};
	walk(root(sidebar));

	// A session waiting on the user says so, and does not also claim to be "running": it *is*
	// running, but the thing the reader has to act on is the other half, and only one line fits.
	check("待审批盖过运行中", statusBySession.get("会话 waiting") === "● 待审批 2", JSON.stringify([...statusBySession]));
	check("运行中只说运行中", statusBySession.get("会话 busy") === "● 运行中", JSON.stringify([...statusBySession]));
	check("打开但空闲的那一行有标记", statusBySession.get("会话 open") === "▍ 已打开 · 空闲", JSON.stringify([...statusBySession]));
	check("完全没关系的行不留第二行", statusBySession.get("会话 quiet") === "", JSON.stringify([...statusBySession]));
}

// ------------------------------------------------------ 4. connection indicator

process.stdout.write("\nsidebar：连接指示器\n");

{
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
	});

	sidebar.render(state([row("a", 1)], { channel: "connecting" }));
	const indicator = root(sidebar).children[0]!.children[1]!;
	check("连接中：点在那一行上", indicator.dataset.state === "connecting", JSON.stringify(indicator.dataset.state));
	check("连接中有文案", (indicator.children[1]?.textContent ?? "") === "连接中…", JSON.stringify(indicator.children[1]?.textContent));

	sidebar.render(state([row("a", 1)], { channel: "live" }));
	check("live：同一个点", indicator.dataset.state === "live", JSON.stringify(indicator.dataset.state));
	check("live 时没有文案", (indicator.children[1]?.textContent ?? "") === "", JSON.stringify(indicator.children[1]?.textContent));

	sidebar.render(state([row("a", 1)], { channel: "down" }));
	check("down 说它在重试", (indicator.children[1]?.textContent ?? "").includes("重连"), JSON.stringify(indicator.children[1]?.textContent));
}

// ------------------------------------------- 5. a heading sits above its rows

process.stdout.write("\nsidebar：分组标题在会话行之上\n");

{
	const sidebar = new Sidebar({
		onNewSession: () => {},
		onSelectSession: () => {},
		onToggleCollapsed: () => {},
		onOpenSettings: () => {},
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
	});

	sidebar.render(state([row("a", 300), row("b", 200), row("c", 100)]));
	check("三行", titlesOf(sidebar).length === 3);

	sidebar.render(state([row("a", 300), row("c", 100)]));
	check("删掉的行从 DOM 移除", titlesOf(sidebar).map((t) => t.title).join(",") === "会话 a,会话 c", JSON.stringify(titlesOf(sidebar).map((t) => t.title)));

	sidebar.render(state([]));
	check("空列表不留残骸", titlesOf(sidebar).length === 0, JSON.stringify(titlesOf(sidebar)));
}

process.stdout.write(failures === 0 ? "\nsidebar ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;