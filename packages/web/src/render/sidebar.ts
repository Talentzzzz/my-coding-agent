import { element, icon, iconButton } from "../dom.ts";
import type { ChannelState } from "../client.ts";
import type { SessionRow, WorkspaceGroup } from "@my-agent/core/protocol";

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
	/**
	 * Whether the resident channel is up.
	 *
	 * A window-level fact drawn here rather than on the status line, because it belongs to the window
	 * and not to any one conversation. It lives in `SidebarState` rather than `ViewState` for the same
	 * reason the rows do: the connection is not a session, so it has no business being something a
	 * session's baseline can overwrite.
	 */
	channel: ChannelState;
}

/**
 * What one row says under its title.
 *
 * Only two of these are facts about the session, and only one of those is worth a colour: an idle
 * session takes none, so a workspace with four stopped conversations is four ordinary rows rather
 * than four rows insisting on something.
 *
 * "运行中" and "待审批" are both amber, and deliberately not different colours. A session waiting on
 * the user is not more urgent than one working — it is the same fact seen from a different side, and
 * giving them two colours would ask the eye to learn a distinction the words already make.
 */
type RowStatus = { text: string; tone: "warn" | "idle" } | undefined;

/**
 * The navigation column.
 *
 * It owns everything about *which* conversation is on screen — the workspace groups, the tree under
 * each, the new-session control, and the way into the settings — and nothing about the conversation
 * itself. That split is what keeps the right-hand column replaceable: the sidebar never reads a
 * transcript.
 *
 * The rows update in place. Rows now change while nothing is being clicked — a session finishing a
 * turn moves its own row, and a background session starting one flips an indicator — so rebuilding
 * the list would swap out the button between a pointer going down and coming up, and the click would
 * land on an element that no longer exists. Each row is therefore built once and then patched, and
 * reordering moves nodes rather than recreating them.
 */
export class Sidebar {
	readonly element: HTMLElement;
	private readonly handlers: SidebarHandlers;
	private readonly list: HTMLElement;
	private readonly toggle: HTMLButtonElement;
	/** The channel's three states, as the indicator beside the brand. */
	private readonly indicator: HTMLElement;
	private readonly indicatorText: HTMLElement;
	/** Workspaces whose list has been opened past {@link COLLAPSED_COUNT}. */
	private readonly expanded = new Set<string>();
	/**
	 * The rows on screen, by session id.
	 *
	 * The map is what makes in-place patching possible: a row is looked up rather than built, so a
	 * re-render with three changed fields and no changed order touches three text nodes and nothing
	 * else. Rows that fell out of the listing are removed, and only then.
	 */
	private readonly drawn = new Map<string, DrawnNode>();
	/** The `id` of the row the window is on, so `scrollIntoView` happens when it changes and not otherwise. */
	private scrolledTo: string | undefined;
	/**
	 * The last state handed to {@link render}, so a control drawn inside the list can ask for a
	 * redraw without the caller having threaded it back in. Only the "more" button needs this.
	 */
	private lastState: SidebarState | undefined;

	constructor(handlers: SidebarHandlers) {
		this.handlers = handlers;
		this.element = element("aside", "sidebar");

		const top = element("div", "sidebar-top");
		const brand = element("div", "brand");
		brand.append(element("span", "brand-mark", "M"), element("span", "brand-name", "my-agent"));
		this.toggle = iconButton("panel", "切换侧边栏", () => this.handlers.onToggleCollapsed());
		this.indicator = element("span", "channel-indicator");
		this.indicatorText = element("span", "channel-indicator-text");
		this.indicator.append(element("span", "channel-dot"), this.indicatorText);
		top.append(brand, this.indicator, this.toggle);

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
		this.lastState = state;
		this.renderRows(state);

		const root = document.getElementById("app");
		if (root) root.dataset.sidebar = state.collapsed ? "rail" : "full";
		this.toggle.title = state.collapsed ? "展开侧边栏" : "收起侧边栏";
		this.renderIndicator(state.channel);
	}

	/**
	 * Draw the rows, moving what moved and patching what changed.
	 *
	 * There is no signature gate in front of this any more, and that is the point: the fields that
	 * used to make a row change were not in the old signature at all, so a session that finished a
	 * turn elsewhere in the machine could not change its own text no matter how often the list was
	 * refreshed. The cheap comparison has been replaced by an accurate one — every row is patched,
	 * and patching a row that did not change writes the same value.
	 */
	private renderRows(state: SidebarState): void {
		const wanted = new Set<string>();
		const groups = state.workspaces;

		if (groups.length === 0) {
			this.drawn.clear();
			this.list.replaceChildren(
				element("div", "session-list-heading", "工作区"),
				element("div", "session-list-empty", "暂无会话"),
			);
			this.scrolledTo = undefined;
			return;
		}
		this.ensureHeading();

		for (const group of groups) {
			const wrapper = this.groupFor(group.cwd, state.currentWorkspace);
			const rows = rowsOf(group);
			const shown = this.expanded.has(group.cwd) ? rows : collapsedRows(rows, state.activeSessionId);

			// The heading is the wrapper's first child, so the sequence of movable rows starts *after*
			// it. Seeding `previous` with the heading is what keeps the first row below its title: with
			// `undefined` the anchor would be the wrapper's first child, which is the heading itself,
			// and the first row would be inserted above it.
			let previous: HTMLElement | undefined = wrapper.firstElementChild as HTMLElement | null ?? undefined;
			// Appended in order and only moved when the place differs, so the browser does the minimum
			// work per render and no node is ever destroyed and rebuilt while a pointer is on it.
			for (const row of shown) {
				wanted.add(row.session.id);
				const button = this.rowFor(row, state);
				this.place(wrapper, button, previous);
				previous = button;
			}

			const hidden = rows.length - shown.length;
			const more = this.moreFor(group.cwd, hidden);
			if (more !== undefined) {
				wanted.add(`more:${group.cwd}`);
				this.place(wrapper, more, previous);
				previous = more;
			} else {
				this.stale(`more:${group.cwd}`);
			}
			wanted.add(`head:${group.cwd}`);
		}

		for (const [key, node] of [...this.drawn]) {
			if (!wanted.has(key)) {
				node.button.remove();
				this.drawn.delete(key);
			}
		}

		// Only when the window moved to a different conversation. Doing it on every render would drag
		// the list around under a background row's update, which is the one thing this design is for.
		if (state.activeSessionId !== this.scrolledTo) {
			this.scrolledTo = state.activeSessionId;
			if (state.activeSessionId !== undefined) {
				this.list.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
			}
		}
	}

	/** Put a node after `previous`, doing nothing when it is already there. */
	private place(parent: HTMLElement, node: HTMLElement, previous: HTMLElement | undefined): void {
		const wanted = previous === undefined ? parent.firstChild : previous.nextSibling;
		if (node === wanted) return;
		parent.insertBefore(node, wanted);
	}

	private ensureHeading(): void {
		const first = this.list.firstElementChild;
		if (first?.classList.contains("session-list-heading")) return;
		this.list.prepend(element("div", "session-list-heading", "工作区"));
	}

	/** The heading for one workspace, built once and then only labelled. */
	private groupFor(cwd: string, currentWorkspace: string): HTMLElement {
		const key = `head:${cwd}`;
		const existing = this.drawn.get(key);
		if (existing !== undefined) {
			const mark = existing.button.querySelector<HTMLElement>(".workspace-current");
			const shouldMark = cwd === currentWorkspace;
			if (shouldMark && mark === null) existing.button.append(element("span", "workspace-current", "当前"));
			if (!shouldMark && mark !== null) mark.remove();
			return existing.button;
		}

		const head = element("div", "workspace-head", undefined, { title: cwd });
		const name = element("span", "workspace-name", workspaceName(cwd));
		head.append(icon("folder"), name);
		if (cwd === currentWorkspace) {
			// Which group the new-session button will write into, said once rather than left to be
			// discovered by creating a session and finding it in the wrong place.
			head.append(element("span", "workspace-current", "当前"));
		}

		const wrapper = element("div", "workspace");
		wrapper.append(head);
		this.list.append(wrapper);
		this.drawn.set(key, { button: wrapper });
		return wrapper;
	}

	private rowFor(row: TreeRow, state: SidebarState): HTMLElement {
		const existing = this.drawn.get(row.session.id);
		if (existing !== undefined && existing.parts !== undefined) {
			this.patchRow(existing.parts, existing.button, row, state);
			return existing.button;
		}

		const button = element("button", "session-item", undefined, { type: "button" });
		const forkMark = element("span", "session-fork-mark");
		const body = element("span", "session-item-body");
		const head = element("span", "session-item-line");
		const title = element("span", "session-item-title");
		const time = element("span", "session-item-time");
		const status = element("span", "session-item-status");
		head.append(title, time);
		body.append(head, status);
		button.append(forkMark, body);
		button.addEventListener("click", () => this.handlers.onSelectSession(row.session.id));

		const parts: RowParts = { title, time, status, forkMark };
		this.drawn.set(row.session.id, { button, parts });
		this.patchRow(parts, button, row, state);
		return button;
	}

	/**
 * Put one row's current values into the row that is already on screen.
	 *
	 * Every branch writes only what differs, because this runs on every frame and the whole point of
	 * patching in place is that a re-render costs nothing when nothing changed. Even writing a value
	 * that is already there is skipped: assigning `textContent` unconditionally would replace the
	 * text node on every heartbeat, which is exactly the churn this design exists to avoid.
	 */
	private patchRow(parts: RowParts, button: HTMLElement, row: TreeRow, state: SidebarState): void {
		const { session, parent } = row;
		const isActive = session.id === state.activeSessionId;

		if (parts.depth !== row.depth) {
			parts.depth = row.depth;
			drawDepth(button, row.depth);
		}

		// Compared by the parent's *title* rather than by the parent object, because the listing
		// rebuilds every row object on every frame and object identity would report a change every time.
		if (parts.parentTitle !== parent?.title) drawMark(parts, parent);

		button.title =
			parent === undefined
				? `${session.title}\n${session.cwd}\n创建于 ${formatDate(session.createdAt)}`
				: `${session.title}\n${session.cwd}\n派生自 ${parent.title}\n创建于 ${formatDate(session.createdAt)}`;

		if (parts.title.textContent !== session.title) parts.title.textContent = session.title;
		this.paintTime(parts, session.modified);
		this.paintStatus(parts, rowStatus(row.session, isActive));

		if (isActive) button.setAttribute("aria-current", "true");
		else button.removeAttribute("aria-current");
	}

	/**
	 * Repaint the relative times of every drawn row.
	 *
	 * Called on every frame, heartbeat included, so a row does not sit on "刚刚" for an hour after the
	 * conversation it names went quiet. It reuses the heartbeat rather than adding a clock of its own:
	 * one timer is one thing that can be wrong, and when the channel is down this stops too — which is
	 * the honest behaviour, since "how long ago" stops being knowable the moment frames do.
	 */
	tick(): void {
		for (const drawn of this.drawn.values()) {
			const parts = drawn.parts;
			if (parts?.modified === undefined) continue;
			this.paintTime(parts, parts.modified);
		}
	}

	/**
	 * Write the row's relative time, remembering the stamp it came from.
	 *
	 * The stamp is kept so {@link tick} can recompute the text without being handed the rows again —
	 * the heartbeat carries no session ids, and re-deriving a stamp from the text would mean parsing
	 * "3小时" back into a date.
	 */
	private paintTime(parts: RowParts, modified: number): void {
		const text = relativeTime(modified);
		if (parts.time.textContent !== text) parts.time.textContent = text;
		parts.modified = modified;
	}

	/**
	 * Write a status line, or clear it.
	 *
	 * Cleared rather than emptied, because an empty span with a line-height still occupies the line:
	 * a workspace of finished sessions would be as tall as a workspace of busy ones, and a row's height
	 * is what the collapsed-count limit is really about. The element itself stays — it is the row's, and
	 * rebuilding it per change is the churn this whole design exists to avoid.
	 */
	private paintStatus(parts: RowParts, status: RowStatus): void {
		const node = parts.status;
		if (status === undefined) {
			if (parts.statusText !== undefined) {
				parts.statusText = undefined;
				node.replaceChildren();
				node.removeAttribute("data-tone");
			}
			return;
		}
		if (parts.statusText !== status.text) {
			parts.statusText = status.text;
			node.textContent = status.text;
		}
		node.dataset.tone = status.tone;
	}

	private moreFor(cwd: string, hidden: number): HTMLElement | undefined {
		const key = `more:${cwd}`;
		if (hidden <= 0) {
			return undefined;
		}
		const label = `展开其余 ${hidden} 个会话`;
		const existing = this.drawn.get(key);
		if (existing !== undefined) {
			if (existing.button.textContent !== label) existing.button.textContent = label;
			return existing.button;
		}

		const more = element("button", "session-more", label, { type: "button" });
		more.addEventListener("click", () => {
			this.expanded.add(cwd);
			// Redrawn from the state the caller last gave, not from a fresh guess: the rows and the
			// active session are facts about the window, and a control inside the list cannot see them.
			if (this.lastState !== undefined) this.renderRows(this.lastState);
		});
		this.drawn.set(key, { button: more });
		return more;
	}

	/** Drop one drawn node by key, wherever it happens to be. */
	private stale(key: string): void {
		const entry = this.drawn.get(key);
		if (entry === undefined) return;
		entry.button.remove();
		this.drawn.delete(key);
	}

	/**
	 * The channel's state, as one dot and at most a few words.
	 *
	 * No words when live. The indicator's job is to be the thing you notice is wrong, and text that
	 * only appears when something is wrong is what makes it that — a label permanently reading
	 * "已连接" would be one more piece of chrome competing with the conversation.
	 */
	private renderIndicator(channel: ChannelState): void {
		this.indicator.dataset.state = channel;
		const text = channel === "live" ? "" : channel === "connecting" ? "连接中…" : "已断开，重连中…";
		this.indicator.title =
			channel === "live" ? "连接正常" : channel === "connecting" ? "正在连接服务端" : "连接已断开，正在重试";
		if (this.indicatorText.textContent !== text) this.indicatorText.textContent = text;
	}
}

/**
 * One drawn node, plus what is remembered about it between renders.
 *
 * Two kinds of thing live in this map and only one of them is a session row — a workspace heading and a
 * "more" button are drawn the same way, kept for the same reason, and never patched. `parts` is what
 * separates them: it is present exactly for the rows, which is why the patching code can reach through
 * it without asking whether this entry happens to be a row.
 */
interface DrawnNode {
	/** The button for a row, or the container for a group heading. */
	button: HTMLElement;
	/** The row's own parts, and the values last written to them. Absent for the two non-row entries. */
	parts?: RowParts;
}

/**
 * The parts of one row that get written, and the values they currently hold.
 *
 * A separate type from {@link DrawnNode} rather than more optional fields on it, because "which nodes
 * exist" and "what is written into a row" are separate facts: the first is about the list's shape and
 * the second about one session. Merged, every write had to ask whether the node it was handed was a
 * row at all.
 */
interface RowParts {
	title: HTMLElement;
	time: HTMLElement;
	status: HTMLElement;
	forkMark: HTMLElement;
	/** Last activity written into the time, kept so a tick can recompute the text without the rows. */
	modified?: number;
	/** The status text on screen, so an unchanged one is not rewritten. */
	statusText?: string;
	/** The parent title the mark shows, so a rename repaints and anything else does not. */
	parentTitle?: string;
	depth?: number;
}

/**
 * Write a row's indent.
 *
 * Depth travels as a number on a custom property rather than as nested elements, so the list stays one
 * flat level of buttons and the keyboard walks the rows in the order they read. The attribute beside
 * it is for anything reading rows, and the default on the attribute is what lets the stylesheet say
 * "zero unless told otherwise" in one place.
 */
function drawDepth(button: HTMLElement, depth: number): void {
	if (depth > 0) {
		button.dataset.depth = String(depth);
		button.style.setProperty("--depth", String(depth));
		return;
	}
	delete button.dataset.depth;
	button.style.removeProperty("--depth");
}

/**
 * Give a row its fork mark, or take it away.
 *
 * Removal rather than emptying: the mark is `display: inline-flex`, so an emptied one still occupies
 * its width and every root row would carry an invisible indent.
 */
function drawMark(parts: RowParts, parent: SessionRow | undefined): void {
	const mark = parts.forkMark;
	if (parent === undefined) {
		mark.replaceChildren();
		mark.removeAttribute("title");
		parts.parentTitle = undefined;
		return;
	}
	if (parts.parentTitle === undefined) mark.append(icon("fork"));
	mark.title = `派生自 ${parent.title}`;
	parts.parentTitle = parent.title;
}

/**
 * The second line under a row's title.
 *
 * Ordered by what a person has to act on. "待审批" comes before "运行中" because a session waiting on
 * the user is the one case where looking at the row tells you something is *yours* to do, and it
 * would be buried if the running badge claimed the line first.
 *
 * "已打开 · 空闲" is a fact about this window rather than about the session, and needs no field: it
 * is the row the window is currently showing.
 *
 * Each state keeps the glyph it was designed with, because the glyph is what separates the two busy
 * states from each other and from the idle one when the text is skimmed rather than read: a filled dot
 * is something happening, a bar is something merely open, and colour alone would leave the idle row
 * looking like a fourth kind of busy. The glyphs are characters rather than shapes drawn in CSS
 * because they carry no meaning of their own — the words beside them are the sentence, and the marks
 * are the part of it that survives being scanned.
 */
function rowStatus(row: SessionRow, isActive: boolean): RowStatus {
	if (row.pending > 0) return { text: `● 待审批${row.pending > 1 ? ` ${row.pending}` : ""}`, tone: "warn" };
	if (row.running) return { text: "● 运行中", tone: "warn" };
	if (isActive) return { text: "▍ 已打开 · 空闲", tone: "idle" };
	return undefined;
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
function collapsedRows(rows: readonly TreeRow[], activeSessionId?: string): TreeRow[] {
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

/**
 * One row of a workspace's list: a session, and how deep in its fork tree it sits.
 *
 * Named apart from the protocol's `SessionRow` on purpose, because the two are not the same thing and
 * the difference is easy to miss. A protocol row is a session plus three facts only a running process
 * knows (`running`, `pending`, `modified`); this one is a protocol row plus its place in the fork tree.
 * Calling them both `SessionRow` would invite exactly the mistake this rename exists to prevent — a
 * tree row being asked for a `running` it does not have, or a live field being read off a placeholder.
 */
interface TreeRow {
	session: SessionRow;
	/** 0 for a session of its own, 1 for a fork of one, and one more per generation. */
	depth: number;
	/** The session it was forked from, for the row's own tooltip. */
	parent?: SessionRow;
}

/**
 * Lay a workspace's sessions out as the tree they are.
 *
 * A fork records its parent as a file path, the listing resolves that to an id, and this is where the
 * id becomes a row: roots sorted by when they were last active, each fork directly beneath the session
 * it came from so a fork's own forks stay under it rather than beside it.
 *
 * The sort is done here rather than trusted from the listing, and that is the point. A row's position
 * is now a function of a field that moves while nobody is clicking, so the order has to be recomputed
 * from the rows on every render — inheriting it would mean the list silently disagrees with the rule
 * the moment the two sources diverged, which is precisely when the order is what a person is reading.
 * It costs one sort over a workspace's roots.
 *
 * A fork whose parent is not in this list was already a root for every other purpose, and stays one
 * here. A file hand-edited into a cycle must not lose rows to a walk that never returns, so anything
 * the descent did not reach is placed at the top level rather than dropped.
 */
function rowsOf(group: WorkspaceGroup): TreeRow[] {
	const byId = new Map(group.sessions.map((session) => [session.id, session]));
	const children = new Map<string, SessionRow[]>();
	const roots: SessionRow[] = [];

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

	roots.sort((a, b) => b.modified - a.modified);

	const rows: TreeRow[] = [];
	const placed = new Set<string>();
	const place = (session: SessionRow, depth: number, parent?: SessionRow): void => {
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
 * Counted in conversations rather than rows, so a fork never costs another session its place. The
 * second status line makes each row taller, which is a density question rather than a correctness
 * one — the cap is about how much a scan can hold, and that has not changed.
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
 * glance. Anything more precise is in the row's tooltip.
 *
 * Read from `modified` rather than `createdAt`. Sorting by when a conversation was last active and
 * labelling it with when it was created is how a row ends up second in the list and reading "3天前" —
 * two facts about the same session disagreeing in plain sight.
 */
function relativeTime(timestamp: number): string {
	const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
	if (seconds < 60) return "刚刚";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}小时`;
	if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}天`;
	return new Date(timestamp).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** The row's creation, for the tooltip. Only ever a date: the row itself carries the precise age. */
function formatDate(timestamp: number): string {
	return new Date(timestamp).toLocaleString("zh-CN", {
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}