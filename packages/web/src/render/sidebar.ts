import { element, icon, iconButton } from "../dom.ts";
import type { SessionRef, WorkspaceGroup } from "@my-agent/core/protocol";

export interface SidebarHandlers {
	onNewSession(): void;
	onSelectSession(sessionId: string): void;
	onToggleCollapsed(): void;
	onOpenSettings(): void;
}

export interface SidebarState {
	/** Every workspace with stored sessions, most recently used first. */
	workspaces: readonly WorkspaceGroup[];
	activeSessionId?: string;
	/** The directory this server is running over, marked in the list so "new session" is predictable. */
	currentWorkspace: string;
	collapsed: boolean;
}

/**
 * The navigation column.
 *
 * It owns everything about *which* conversation is on screen — the workspace groups, the tree under
 * each, the new-session control, and the way into the settings — and nothing about the conversation
 * itself. That split is what keeps the right-hand column replaceable: the sidebar never reads a
 * transcript.
 *
 * The groups come from the store rather than from this server's own root, because one process is
 * bound to one workspace while the machine has sessions for many. The list only rebuilds when the
 * rows or the active id actually change, so clicking through history does not churn the DOM under the
 * pointer.
 */
export class Sidebar {
	readonly element: HTMLElement;
	private readonly handlers: SidebarHandlers;
	private readonly list: HTMLElement;
	private readonly toggle: HTMLButtonElement;
	/** Workspaces whose list has been opened past {@link COLLAPSED_COUNT}. */
	private readonly expanded = new Set<string>();
	private signature = "";

	constructor(handlers: SidebarHandlers) {
		this.handlers = handlers;
		this.element = element("aside", "sidebar");

		const top = element("div", "sidebar-top");
		const brand = element("div", "brand");
		brand.append(element("span", "brand-mark", "M"), element("span", "brand-name", "my-agent"));
		this.toggle = iconButton("panel", "切换侧边栏", () => this.handlers.onToggleCollapsed());
		top.append(brand, this.toggle);

		const newSession = element("button", "new-session", undefined, { type: "button" });
		newSession.append(icon("plus"), element("span", undefined, "新建会话"));
		newSession.addEventListener("click", () => this.handlers.onNewSession());

		this.list = element("nav", "session-list", undefined, { "aria-label": "会话列表" });

		// The one control in the corner the eye returns to: everything that is set once — the theme,
		// the font size, the models — lives behind it rather than in the chrome around the transcript.
		const foot = element("div", "sidebar-foot");
		const settings = element("button", "settings-entry", undefined, { type: "button", title: "设置" });
		settings.append(icon("gear"), element("span", undefined, "设置"));
		settings.addEventListener("click", () => this.handlers.onOpenSettings());
		foot.append(settings);

		this.element.append(top, newSession, this.list, foot);
	}

	render(state: SidebarState): void {
		const signature = [
			state.currentWorkspace,
			state.activeSessionId ?? "",
			[...this.expanded].join(","),
			...state.workspaces.map(
				(group) =>
					`${group.cwd}:${group.sessions
						.map((session) => `${session.id}/${session.parentId ?? ""}/${session.title}`)
						.join(",")}`,
			),
		].join("|");

		if (signature !== this.signature) {
			this.signature = signature;
			this.renderList(state);
		}

		const root = document.getElementById("app");
		if (root) root.dataset.sidebar = state.collapsed ? "rail" : "full";
		this.toggle.title = state.collapsed ? "展开侧边栏" : "收起侧边栏";
	}

	private renderList(state: SidebarState): void {
		const groups = state.workspaces.map((group) => this.renderGroup(group, state));
		this.list.replaceChildren(
			element("div", "session-list-heading", "工作区"),
			...(groups.length > 0 ? groups : [element("div", "session-list-empty", "暂无会话")]),
		);

		// A workspace accumulates sessions faster than the panel can show them, so the one being read
		// is brought into view. `block: "nearest"` leaves a list that already shows it alone.
		this.list.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
	}

	private renderGroup(group: WorkspaceGroup, state: SidebarState): HTMLElement {
		const wrapper = element("div", "workspace");
		const head = element("div", "workspace-head", undefined, { title: group.cwd });
		const name = element("span", "workspace-name", workspaceName(group.cwd));
		head.append(icon("folder"), name);
		if (group.cwd === state.currentWorkspace) {
			// Which group the new-session button will write into, said once rather than left to be
			// discovered by creating a session and finding it in the wrong place.
			head.append(element("span", "workspace-current", "当前"));
		}
		wrapper.append(head);

		// A workspace with a long history would otherwise push every other workspace off the panel, and
		// the point of grouping is to be able to see that the others are there.
		const rows = rowsOf(group);
		const shown = this.expanded.has(group.cwd) ? rows : this.collapsedRows(rows, state.activeSessionId);
		for (const row of shown) wrapper.append(this.renderSession(row, state));

		const hidden = rows.length - shown.length;
		if (hidden > 0) {
			const more = element("button", "session-more", `展开其余 ${hidden} 个会话`, { type: "button" });
			more.addEventListener("click", () => {
				this.expanded.add(group.cwd);
				this.renderList(state);
			});
			wrapper.append(more);
		}
		return wrapper;
	}

	/**
	 * The rows a collapsed workspace shows: its first {@link COLLAPSED_COUNT} conversations, each with
	 * the forks that came from it, and always the one the window is on.
	 *
	 * The last part is why this is not a `slice`: a session that has been forked from is often older
	 * than the four most recent, and the list still has to say where the conversation on screen came
	 * from. A fork counts as part of the conversation it branched off rather than as a row of its own,
	 * which is what keeps a heavily forked workspace from crowding out the others.
	 */
	private collapsedRows(rows: readonly SessionRow[], activeSessionId?: string): SessionRow[] {
		const roots: number[] = [];
		const rootOf = rows.map((row, index) => {
			if (row.depth === 0) roots.push(index);
			return roots[roots.length - 1] ?? 0;
		});

		const visible = new Set(roots.slice(0, COLLAPSED_COUNT));
		const active = activeSessionId === undefined ? -1 : rows.findIndex((row) => row.session.id === activeSessionId);
		if (active >= 0) visible.add(rootOf[active]!);

		return rows.filter((_row, index) => visible.has(rootOf[index]!));
	}

	private renderSession(row: SessionRow, state: SidebarState): HTMLElement {
		const { session, parent } = row;
		const button = element("button", "session-item", undefined, {
			type: "button",
			title:
				parent === undefined
					? `${session.title}\n${session.cwd}`
					: `${session.title}\n${session.cwd}\n派生自 ${parent.title}`,
		});
		// Depth is carried as a number rather than as nested elements: the list stays one flat level of
		// buttons, so the keyboard walks the rows in the order they read and indentation is a style. The
		// custom property is what the indent is computed from; the attribute is for anything reading rows.
		if (row.depth > 0) {
			button.dataset.depth = String(row.depth);
			button.style.setProperty("--depth", String(row.depth));
		}
		if (session.id === state.activeSessionId) button.setAttribute("aria-current", "true");

		if (parent !== undefined) {
			const mark = element("span", "session-fork-mark", undefined, { title: `派生自 ${parent.title}` });
			mark.append(icon("fork"));
			button.append(mark);
		}
		button.append(
			element("span", "session-item-title", session.title),
			element("span", "session-item-time", relativeTime(session.createdAt)),
		);
		button.addEventListener("click", () => this.handlers.onSelectSession(session.id));
		return button;
	}
}

/** One row of a workspace's list: a session, and how deep in its fork tree it sits. */
interface SessionRow {
	session: SessionRef;
	/** 0 for a session of its own, 1 for a fork of one, and one more per generation. */
	depth: number;
	/** The session it was forked from, for the row's own tooltip. */
	parent?: SessionRef;
}

/**
 * Lay a workspace's sessions out as the tree they are.
 *
 * A fork records its parent as a file path, the listing resolves that to an id, and this is where the
 * id becomes a row: roots in the order the store listed them — most recently active first, which is
 * what makes the panel scannable — and each fork directly beneath the session it came from, so a
 * fork's own forks stay under it rather than beside it.
 *
 * A fork whose parent is not in this list was already a root for every other purpose, and stays one
 * here. A file hand-edited into a cycle must not lose rows to a walk that never returns, so anything
 * the descent did not reach is placed at the top level rather than dropped.
 */
function rowsOf(group: WorkspaceGroup): SessionRow[] {
	const byId = new Map(group.sessions.map((session) => [session.id, session]));
	const children = new Map<string, SessionRef[]>();
	const roots: SessionRef[] = [];

	for (const session of group.sessions) {
		const parent = session.parentId === undefined ? undefined : byId.get(session.parentId);
		if (parent === undefined) {
			roots.push(session);
			continue;
		}
		const siblings = children.get(parent.id);
		if (siblings === undefined) children.set(parent.id, [session]);
		else siblings.push(session);
	}

	const rows: SessionRow[] = [];
	const placed = new Set<string>();
	const place = (session: SessionRef, depth: number, parent?: SessionRef): void => {
		if (placed.has(session.id)) return;
		placed.add(session.id);
		rows.push({ session, depth, ...(parent === undefined ? {} : { parent }) });
		for (const child of children.get(session.id) ?? []) place(child, depth + 1, session);
	};

	for (const root of roots) place(root, 0);
	for (const session of group.sessions) place(session, 0);
	return rows;
}

/**
 * How many of a workspace's conversations are shown before it has to be opened.
 *
 * Counted in conversations rather than rows, so a fork never costs another session its place.
 */
const COLLAPSED_COUNT = 4;

/** The last segment of a path, which is what a person calls the project. */
export function workspaceName(cwd: string): string {
	const parts = cwd.split(/[/\\]/).filter((part) => part.length > 0);
	return parts.at(-1) ?? cwd;
}

/**
 * A compact age for a list row.
 *
 * Deliberately coarse: the list is scanned, not read, and "3天" is what distinguishes entries at a
 * glance. Anything more precise is available in the row's tooltip.
 */
function relativeTime(timestamp: number): string {
	const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
	if (seconds < 60) return "刚刚";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}小时`;
	if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}天`;
	return new Date(timestamp).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
