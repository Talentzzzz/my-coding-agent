import { element, icon, iconButton } from "../dom.ts";
import type { ChannelState } from "../client.ts";
import { openMenuAt } from "./menu.ts";
import { askForText } from "./text-dialog.ts";
import type { SessionRow, DirectoryGroup, DirectoryPaging } from "@my-agent/core/protocol";

export interface SidebarHandlers {
	/**
	 * Start a conversation.
	 *
	 * `workDirAbsPath` is the directory the request was made *from*, and it is what makes the directory heading's
	 * own 「新建会话」 land where the right click was: the top row's button asks for the picker's
	 * directory (no argument), and the heading names its own. One door rather than two, because a
	 * new session is the same act wherever it is asked for.
	 */
	onNewSession(workDirAbsPath?: string): void;
	onSelectSession(sessionId: string): void;
	onToggleCollapsed(): void;
	onOpenSettings(): void;
	/** The system folder picker, which is the only road a new directory enters the list by. */
	onAddDirectory(): void;
	/** Copy the session this row names whole, and open the copy. */
	onForkSession(sessionId: string): void;
	/** Delete the session this row names, transcript and all. */
	onDeleteSession(sessionId: string): void;
	/**
	 * Give the session this row names a stored name of its own.
	 *
	 * The row does not change here: the name is real storage on the server, and the row takes the new
	 * one when the connection's `session_row` frame delivers it — the same road every other row fact
	 * takes, and deliberately not a local edit this column would have to reconcile afterwards.
	 */
	onRenameSession(sessionId: string, title: string): void;
	/** The directory head was clicked: collapse it to its heading, or reopen it on its saved page. */
	onToggleDirectory(workDirAbsPath: string): void;
	/** The directory's 「展开其余」 was clicked: show one more page of its conversations. */
	onPageDirectory(workDirAbsPath: string): void;
	/** The directory's 「收起」 was clicked: step the expansion back one page. */
	onCollapseDirectory(workDirAbsPath: string): void;
	/**
	 * Give the directory this heading names a new label (票 06).
	 *
	 * `workDirAbsPath` is the group the card was opened on and `name` is what the user typed. Nothing on disk is
	 * named by either: the label is a view the settings remember, so the window's only job is to store
	 * it and repaint the heading that wears it.
	 */
	onRenameDirectory(workDirAbsPath: string, name: string): void;
	/**
	 * Remove the directory this heading names from the list, touching nothing on disk.
	 *
	 * Named `delete` in the menu because that is what the user is doing from where they sit; the
	 * handler's job — and the endpoint's name — is the narrower 「hide」.
	 */
	onDeleteDirectory(workDirAbsPath: string): void;
}

export interface SidebarState {
	/** Every directory with stored sessions, most recently used first. */
	directories: readonly DirectoryGroup[];
	activeSessionId?: string;
	collapsed: boolean;
	/**
	 * Per-directory paging state, keyed by the directory's path, as the appearance settings hold it.
	 *
	 * Read-only here: the sidebar draws from it and reports the clicks, and the window — which owns
	 * the settings write — answers with a new map. Holding it in the state rather than in the view
	 * is what makes it survive a window: it rides appearance, and appearance rides the server's
	 * settings files, not an origin-scoped `localStorage` the desktop shell's fresh port strands.
	 */
	paging: Record<string, DirectoryPaging>;
	/**
	 * The names the user gave directories, by path, as the settings hold them.
	 *
	 * A heading wears `directoryNames[workDirAbsPath]` when there is one and the folder's own name otherwise. The
	 * entry is a *view*: the folder on disk is never renamed, so this is the whole of what a rename
	 * changes — which is also why it rides the settings and not the group the server lists.
	 */
	directoryNames?: Record<string, string>;
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
 * What the row's slot says, as the line the tooltip gains while it is lit.
 *
 * Only two of these are facts about the session, and both share the one amber dot: a session waiting
 * on the user is not more urgent than one working — it is the same fact seen from a different side,
 * and giving them two colours would ask the eye to learn a distinction the words already make. The
 * words survive in the tooltip, where a person who wants to know why the dot is lit can read them.
 *
 * "已打开" needs no slot at all: it is the `aria-current` background itself, which is the row already
 * saying it is the one on screen.
 */
function busyOf(row: SessionRow): string | undefined {
	if (row.pending > 0) return row.pending > 1 ? `待审批 ${row.pending}` : "待审批";
	if (row.running) return "运行中";
	return undefined;
}

/**
 * The navigation column.
 *
 * It owns everything about *which* conversation is on screen — the directory groups, the tree under
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
	/** The channel's three states, as the dot beside the settings entry. */
	private readonly indicator: HTMLElement;
	private readonly indicatorText: HTMLElement;
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
	 * redraw without the caller having threaded it back in. Only the paging row needs this.
	 */
	private lastState: SidebarState | undefined;
	/** Whether the search row is on screen, and the text it is filtering by. */
	private searchOpen = false;
	private filterText = "";
	private readonly headRow: HTMLElement;
	private readonly searchRow: HTMLElement;
	private readonly searchInput: HTMLInputElement;
	private readonly noMatch: HTMLElement;
	/**
	 * The rows of the last render, by session id.
	 *
	 * The tree row is where a row's display title was computed, and the rename editor needs exactly
	 * that: the clean name it edits is the label with the suffix left out, which only the tree knows.
	 * Rebuilt on every render, so a rename always seeds from what is actually on screen.
	 */
	private readonly rowsById = new Map<string, TreeRow>();
	/** The rename editor in flight, if any. One at a time, like every other popup here. */
	private editing: Editing | undefined;

	constructor(handlers: SidebarHandlers) {
		this.handlers = handlers;
		this.element = element("aside", "sidebar");

		// The top row is the drag strip and nothing else: the window is moved from here, so the row
		// holds the two controls the column opens with and no brand — the column is the list, not a
		// product, and a logo on it was one more piece of chrome competing with the conversations.
		const top = element("div", "sidebar-top");
		const newSession = element("button", "new-session", undefined, { type: "button" });
		newSession.append(icon("plus"), element("span", undefined, "新会话"));
		newSession.addEventListener("click", () => this.handlers.onNewSession());
		this.toggle = iconButton("panel", "切换侧边栏", () => this.handlers.onToggleCollapsed());
		top.append(newSession, this.toggle);

		this.list = element("nav", "session-list", undefined, { "aria-label": "会话列表" });

		// The heading row and its three controls, per the reference layout: a search that really
		// filters the list, a view-options control that is look-only for now, and the road in for a
		// directory this machine has never had a session in.
		this.headRow = element("div", "list-head");
		this.headRow.append(element("div", "session-list-heading", "目录"));
		const headActions = element("div", "list-head-actions");
		headActions.append(
			iconButton("search", "搜索会话", () => this.toggleSearch()),
			// Look-only by decision: sorting stays `modified` descending, and the control is here so
			// the row reads like the reference rather than so it can be used. Clicking says so.
			iconButton("sliders", "视图选项（暂未启用）", () => {}),
			iconButton("folder-add", "添加目录", () => this.handlers.onAddDirectory()),
		);
		this.headRow.append(headActions);

		this.searchRow = element("div", "search-row");
		this.searchInput = element("input", "search-input", undefined, {
			type: "search",
			placeholder: "搜索会话…",
			"aria-label": "搜索会话",
		});
		this.searchInput.addEventListener("input", () => {
			this.filterText = this.searchInput.value;
			if (this.lastState !== undefined) this.renderRows(this.lastState);
		});
		this.searchInput.addEventListener("keydown", (event) => {
			if (event.key === "Escape") this.toggleSearch();
		});
		this.searchRow.append(this.searchInput);
		this.searchRow.hidden = true;

		this.noMatch = element("div", "session-list-empty", "没有匹配的会话");
		this.noMatch.hidden = true;

		// The one control in the corner the eye returns to: everything that is set once — the theme,
		// the font size, the models — lives behind it rather than in the chrome around the transcript.
		// The channel indicator shares the foot rather than the top row it used to share with the
		// brand: it is a fact about the window, and the foot is where window-level things live.
		const foot = element("div", "sidebar-foot");
		const settings = element("button", "settings-entry", undefined, { type: "button", title: "设置" });
		settings.append(icon("gear"), element("span", undefined, "设置"));
		settings.addEventListener("click", () => this.handlers.onOpenSettings());
		this.indicator = element("span", "channel-indicator");
		this.indicatorText = element("span", "channel-indicator-text");
		this.indicator.append(element("span", "channel-dot"), this.indicatorText);
		foot.append(settings, this.indicator);

		this.element.append(top, this.list, foot);
	}

	/** Open or close the search row. Closing it clears the filter, because a closed filter filters nothing. */
	private toggleSearch(): void {
		this.searchOpen = !this.searchOpen;
		this.searchRow.hidden = !this.searchOpen;
		this.searchInput.value = "";
		this.filterText = "";
		if (this.lastState !== undefined) this.renderRows(this.lastState);
		if (this.searchOpen) this.searchInput.focus();
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
		const groups = state.directories;
		const filter = this.filterText.trim().toLowerCase();
		this.rowsById.clear();

		if (groups.length === 0) {
			this.drawn.clear();
			this.list.replaceChildren(this.headRow, this.searchRow, element("div", "session-list-empty", "暂无会话"));
			this.searchRow.hidden = !this.searchOpen;
			this.scrolledTo = undefined;
			return;
		}
		this.ensureHeading();

		// A filter shows every match, in every group: the paging limit is about how much a scan can
		// hold, and a list the user is actively narrowing is not a scan.
		let matches = 0;
		for (const group of groups) {
			const entry = pagingOf(state.paging, group.workDirAbsPath);
			const label = state.directoryNames?.[group.workDirAbsPath] ?? directoryName(group.workDirAbsPath);
			const wrapper = this.groupFor(group.workDirAbsPath, entry, label);
			const rows = rowsOf(group);
			for (const row of rows) this.rowsById.set(row.session.id, row);
			// Matched on the label a row *wears* rather than the title it stores: the fork's suffix is
			// part of what a person reads, so "（1）" narrows to the fork and not to every sibling.
			const kept =
				filter === ""
					? rows
					: rows.filter(
							(row) => row.label.toLowerCase().includes(filter) || group.workDirAbsPath.toLowerCase().includes(filter),
						);
			matches += kept.length;
			const open = filter !== "" || !entry.collapsed;
			const shown = open
				? pagedRows(kept, state.activeSessionId, filter !== "" ? Infinity : entry.page)
				: [];
			// Hidden rather than removed: a group with no matches keeps its place in the DOM, so a
			// filter clearing puts every group back exactly where it was instead of re-appending them
			// in creation order.
			wrapper.hidden = filter !== "" && kept.length === 0;

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

			// The paging row under the list, two buttons on one line: 「展开其余」 while rows are
			// held back, and — beside it, once a page has been added — the 「收起」 that steps the
			// expansion back one page. Neither appears where paging was never a thing, which is a
			// directory with no more conversations than a page holds; a filtering list shows
			// everything it matched, so it wears neither; and a collapsed directory wears neither
			// either — the decision is 全部收起、只留表头, and a paging row under a heading would
			// contradict the collapse it sits inside.
			const paged = open && filter === "";
			const hidden = paged ? rows.length - shown.length : 0;
			const conversations = rows.filter((row) => row.depth === 0).length;
			const more = paged && hidden > 0;
			const back = paged && entry.page > 1 && conversations > PAGE_SIZE;
			if (more || back) {
				wanted.add(`paging:${group.workDirAbsPath}`);
				const pagingRow = this.pagingRowFor(group.workDirAbsPath);
				this.paintPagingRow(pagingRow, more, back, hidden);
				this.place(wrapper, pagingRow.row, previous);
				previous = pagingRow.row;
			} else {
				this.stale(`paging:${group.workDirAbsPath}`);
			}
			wanted.add(`head:${group.workDirAbsPath}`);
		}

		this.noMatch.hidden = !(filter !== "" && matches === 0);

		// Everything this column drew and no longer wants goes, headings included, and this is where a
		// *stale* entry is the one that matters: a heading whose directory was renamed is no longer
		// named by any key, and the only thing still holding its wrapper is this map. Nothing is walked
		// backwards from the list, so a group without rows — the renamed one, whose rows are already
		// under the new path — is not reachable from the DOM at all.
		for (const [key, node] of [...this.drawn]) {
			if (wanted.has(key)) continue;
			node.button.remove();
			this.drawn.delete(key);
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
		// The heading row and the search row are the list's fixed prefix; a list that lost them — a
		// `replaceChildren` during the empty phase, say — gets them back in the same order. The
		// no-match note is the list's suffix, and only moves when it is not already last.
		if (!this.list.contains(this.headRow)) this.list.prepend(this.headRow, this.searchRow);
		this.searchRow.hidden = !this.searchOpen;
		// The empty phase leaves its note behind once the first group arrives: `replaceChildren` put
		// it there, nothing claims it afterwards, and a list that started empty would wear 「暂无会话」
		// above its sessions for as long as the window is open. `noMatch` shares the class and is the
		// list's permanent suffix, so it is the one note this must not remove.
		for (const note of [...this.list.children]) {
			if (note !== this.noMatch && note.classList.contains("session-list-empty")) note.remove();
		}
		if (this.list.lastElementChild !== this.noMatch) this.list.append(this.noMatch);
	}

	/**
	 * The heading for one directory, built once and then only labelled.
	 *
	 * The heading is a real button since the paging decision: clicking it is how a directory
	 * collapses to its heading and opens again, so Enter and Space reach it like any other control,
	 * and `[aria-expanded]` is the state a screen reader — and the stylesheet's chevron — read.
	 * The state is patched like everything else on a drawn node: written only when it moved.
	 *
	 * `label` is what the user called this directory, already resolved from the settings by the
	 * caller: a rename changes that string and nothing else, so the node is keyed by `workDirAbsPath` — which a
	 * rename no longer moves — and only its text is patched.
	 */
	private groupFor(workDirAbsPath: string, entry: DirectoryPaging, label: string): HTMLElement {
		const key = `head:${workDirAbsPath}`;
		const existing = this.drawn.get(key);
		if (existing !== undefined) {
			// Both facts are written through the heading reference this entry was built with, so
			// neither one needs a search.
			if (existing.head !== undefined) {
				this.paintExpanded(existing.head, entry.collapsed);
			}
			// The label is patched for the same reason a row's title is: nothing rebuilds a heading,
			// so the node that wore the old name has to be able to stop wearing it.
			if (existing.head !== undefined && existing.head.title !== workDirAbsPath) existing.head.title = workDirAbsPath;
			if (existing.name !== undefined && existing.name.textContent !== label) {
				existing.name.textContent = label;
			}
			return existing.button;
		}

		const head = element("button", "directory-head", undefined, {
			type: "button",
			title: workDirAbsPath,
			"aria-expanded": entry.collapsed ? "false" : "true",
		});
		// Both icons ride every head, and the hover — not the DOM — decides which shows: the folder is
		// the content, the chevron the affordance, and the swap keeps one position for both meanings.
		const folder = element("span", "directory-icon-folder");
		folder.append(icon("folder"));
		const chev = element("span", "directory-icon-chev");
		chev.append(icon("chevron"));
		const name = element("span", "directory-name", label);
		head.append(folder, chev, name);
		head.addEventListener("click", () => this.handlers.onToggleDirectory(workDirAbsPath));
		// The heading's whole menu lives here rather than on any resident control: a right click names
		// the directory, and the menu it opens is the only place new-session-here, rename, and delete
		// are offered from — the same road a session row's menu takes.
		head.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.openDirectoryMenu(workDirAbsPath, label, event.clientX, event.clientY);
		});

		const wrapper = element("div", "directory");
		wrapper.append(head);
		this.list.append(wrapper);
		this.drawn.set(key, { button: wrapper, head, name });
		return wrapper;
	}

	/**
	 * The one menu a directory heading has: new session here, rename, delete.
	 *
	 * 新建会话 names the workDirAbsPath it was asked on, which is the whole point of the item — the top row's
	 * button starts a session wherever the picker points, and this one starts it *here*.
	 *
	 * 删除 carries the tooltip that says what it does not do. The menu word is the one the user is
	 * looking for; the endpoint behind it and the sentence under it are both narrower, and a person
	 * deleting a project from a sidebar deserves to know the folder is not going anywhere.
	 */
	private openDirectoryMenu(workDirAbsPath: string, label: string, x: number, y: number): void {
		openMenuAt(x, y, [
			{
				icon: "plus",
				label: "新建会话",
				title: `在这个目录里新建：${workDirAbsPath}`,
				onSelect: () => this.handlers.onNewSession(workDirAbsPath),
			},
			{ kind: "separator" },
			{ label: "重命名…", title: "改它在这个列表里显示的名字，磁盘上的文件夹不动", onSelect: () => void this.renameDirectory(workDirAbsPath, label) },
			{
				icon: "trash",
				label: "删除",
				danger: true,
				title: "只从列表里移除，不碰磁盘：会话文件与文件夹都留在原地",
				onSelect: () => this.handlers.onDeleteDirectory(workDirAbsPath),
			},
		]);
	}
	/**
	 * Ask for the name this heading should wear, and report it beside the group it was asked on.
	 *
	 * What is collected is a *label*, so nothing about it can be wrong in a way that costs anything:
	 * the directory keeps its own name and no transcript is rewritten. A name that reads like a path
	 * is still dropped — the heading sits in a list of real directory names, and one that looks like a
	 * directory move can only misread. An empty box is the shared dialog's way of saying nothing was
	 * asked, so taking a custom name back is the settings road's own answer
	 * (`directoryNames[workDirAbsPath] = ""`), not this card's. A label the heading already wears is dropped
	 * for the simpler reason: it is not a change.
	 */
	private async renameDirectory(workDirAbsPath: string, label: string): Promise<void> {
		const typed = await askForText({
			title: "重命名目录",
			label: "显示名称",
			value: label,
			hint: "只改这个列表里显示的名字，磁盘上的文件夹和会话记录都不动。",
			confirm: "重命名",
		});
		if (typed === undefined) return;
		const name = typed.trim();
		if (name === label) return;
		if (name.includes("/") || name.includes("\\") || name === "." || name === "..") return;
		this.handlers.onRenameDirectory(workDirAbsPath, name);
	}

	private paintExpanded(head: HTMLElement, collapsed: boolean): void {
		const wanted = collapsed ? "false" : "true";
		if (head.getAttribute("aria-expanded") !== wanted) head.setAttribute("aria-expanded", wanted);
	}

	private rowFor(row: TreeRow, state: SidebarState): HTMLElement {
		const existing = this.drawn.get(row.session.id);
		if (existing !== undefined && existing.parts !== undefined) {
			this.patchRow(existing.parts, existing.button, row, state);
			return existing.button;
		}

		const button = element("button", "session-item", undefined, { type: "button" });
		// One line, per the reference's row spec: the status slot, the title, and the age. The slot is
		// the row's only room for a state — a second line under the title made every row taller to
		// carry what a dot in a 16px gutter already says.
		const slot = element("span", "session-item-slot");
		const title = element("span", "session-item-title");
		const time = element("span", "session-item-time");
		button.append(slot, title, time);
		button.addEventListener("click", () => this.handlers.onSelectSession(row.session.id));
		// The row's whole menu lives here rather than in any resident control: a right click names the
		// row, and the menu it opens is the only place fork, rename, and delete are offered from.
		button.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.openSessionMenu(row.session.id, event.clientX, event.clientY);
		});

		const parts: RowParts = { slot, title, time };
		this.drawn.set(row.session.id, { button, parts });
		this.patchRow(parts, button, row, state);
		return button;
	}

	/**
	 * The one menu a session row has: fork, rename, delete.
	 *
	 * Opened at the pointer, the way a `contextmenu` asks. The fork's tooltip is written to say what
	 * the call actually does — the whole log is copied and the conversation continues from there —
	 * because "从最后一条继续" would promise more than a fork does: a branched session's last
	 * *recorded* position is not a "last turn", and the copy is of everything.
	 */
	private openSessionMenu(sessionId: string, x: number, y: number): void {
		openMenuAt(x, y, [
			{
				icon: "fork",
				label: "派生新会话",
				title: "复制整份记录，从这条会话接着往下走",
				onSelect: () => this.handlers.onForkSession(sessionId),
			},
			{ kind: "separator" },
			{ label: "重命名", onSelect: () => this.startRename(sessionId) },
			{
				icon: "trash",
				label: "删除",
				danger: true,
				title: "永久删除这条会话",
				onSelect: () => this.handlers.onDeleteSession(sessionId),
			},
		]);
	}

	/**
	 * Turn a row's title into an editor, in place.
	 *
	 * The editor holds the *clean* name — the `（1）` a fork row wears is a fact about its birth, and
	 * a person should not have to retype it — so the seed comes from the tree row's base. Enter
	 * commits, Escape leaves the row as it was, and clicking anywhere else commits, because an
	 * in-place editor that lost its audience has no argument for throwing the typing away.
	 *
	 * Committing changes nothing on this row. The name is real storage on the server, and the row
	 * wears the new one when the connection's `session_row` frame arrives — the same road every other
	 * row fact takes, and deliberately not a local edit this column would have to reconcile.
	 */
	private startRename(sessionId: string): void {
		if (this.editing !== undefined) return;
		const drawn = this.drawn.get(sessionId);
		const row = this.rowsById.get(sessionId);
		if (drawn?.parts === undefined || row === undefined) return;

		const input = element("input", "rename-input", undefined, { type: "text", "aria-label": "会话名称" });
		const original = row.base;
		input.value = original;
		const title = drawn.parts.title;
		title.replaceWith(input);
		input.focus();
		input.select();

		const editing: Editing = { sessionId, settled: false };
		this.editing = editing;
		const finish = (save: boolean): void => {
			if (editing.settled) return;
			editing.settled = true;
			this.editing = undefined;
			const typed = input.value.trim();
			// Sent only when it is a change: re-recording the name the row already wears is a request
			// that stores what the server already holds.
			if (save && typed.length > 0 && typed !== original) this.handlers.onRenameSession(sessionId, typed);
			input.replaceWith(title);
		};
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				finish(true);
			} else if (event.key === "Escape") {
				event.preventDefault();
				finish(false);
			}
		});
		input.addEventListener("blur", () => finish(true));
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
		const isActive = row.session.id === state.activeSessionId;

		// The tooltip is composed only from what can change, and the creation date — the one piece
		// that costs a real `toLocaleString` — is formatted once per stamp and kept. Recomposing the
		// string every frame was cheap; calling `Intl` every frame for a date that never moves was
		// not, and it ran per row, per frame, for every row on screen.
		let created = parts.created;
		if (created === undefined || created.at !== row.session.createdAt) {
			created = { at: row.session.createdAt, text: formatDate(row.session.createdAt) };
			parts.created = created;
		}
		// The parent is named by what it *wears* rather than by what it stores: a fork of a fork hangs
		// its suffix on the parent's own, so the tooltip names the row a person actually sees above.
		// The busy line rides the end of it: the dot is the glance, the words are for the look.
		const busy = busyOf(row.session);
		const tooltip =
			(row.parentLabel === undefined
				? `${row.label}\n${row.session.workDirAbsPath}\n创建于 ${created.text}`
				: `${row.label}\n${row.session.workDirAbsPath}\n派生自 ${row.parentLabel}\n创建于 ${created.text}`) +
			(busy === undefined ? "" : `\n${busy}`);
		if (parts.tooltip !== tooltip) {
			parts.tooltip = tooltip;
			button.title = tooltip;
		}

		if (parts.title.textContent !== row.label) parts.title.textContent = row.label;
		this.paintTime(parts, row.session.modified);
		this.paintSlot(parts, busy);

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
	 * Light the slot's dot, or clear it.
	 *
	 * Cleared rather than left stale, because a row that stopped running while the list was scrolled
	 * away would otherwise come back still claiming a run. The attribute — not a class — is the
	 * switch, so the dot is one CSS rule away from both states and the element itself stays: it is
	 * the row's, and rebuilding it per change is the churn this whole design exists to avoid.
	 */
	private paintSlot(parts: RowParts, busy: string | undefined): void {
		if (parts.busy === busy) return;
		parts.busy = busy;
		if (busy === undefined) parts.slot.removeAttribute("data-state");
		else parts.slot.dataset.state = "warn";
	}

	/**
	 * The paging row under a directory's conversations: 「展开其余」 first, and — beside it, not
	 * beneath it — 「收起」.
	 *
	 * One drawn node holding both buttons rather than two drawn nodes placed one after another,
	 * because the list column lays its children out vertically: side by side is a row of their own.
	 * Patched in place like every drawn node — a press that lands between pointer-down and up must
	 * not fall on a button that was rebuilt under it — and which of the two is on screen is part of
	 * the patch, not a rebuild: 展开 is on while rows are held back, 收起 is on once a page has
	 * been added, and either one alone is an ordinary state of the row.
	 */
	private pagingRowFor(workDirAbsPath: string): PagingRow {
		const key = `paging:${workDirAbsPath}`;
		const existing = this.drawn.get(key);
		if (existing?.paging !== undefined) return existing.paging;

		const more = element("button", "session-more", undefined, { type: "button" });
		more.addEventListener("click", () => this.handlers.onPageDirectory(workDirAbsPath));
		const collapse = element("button", "session-more session-collapse", "收起", { type: "button" });
		collapse.addEventListener("click", () => this.handlers.onCollapseDirectory(workDirAbsPath));
		const row = element("div", "session-paging");
		row.append(more, collapse);
		const paging: PagingRow = { row, more, collapse };
		this.drawn.set(key, { button: row, paging });
		return paging;
	}

	/** Write one paging row's current state, and only what moved. */
	private paintPagingRow(paging: PagingRow, more: boolean, back: boolean, hidden: number): void {
		paging.more.hidden = !more;
		if (more) {
			const label = `展开其余 ${hidden} 个会话`;
			if (paging.more.textContent !== label) paging.more.textContent = label;
		}
		paging.collapse.hidden = !back;
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
 * Three kinds of thing live in this map and only one of them is a session row — a directory heading
 * and the paging row are drawn the same way, kept for the same reason, and never rebuilt. `parts` and
 * `paging` are what separate them: `parts` is present exactly for the rows, `paging` exactly for the
 * paging row, which is why the patching code can reach through either without asking whether the
 * entry it was handed happens to be the other kind.
 */
interface DrawnNode {
	/** The button for a row, or the container for a group heading or the paging row. */
	button: HTMLElement;
	/** The row's own parts, and the values last written to them. Absent for the non-row entries. */
	parts?: RowParts;
	/** The heading element inside `button`, for group entries. */
	head?: HTMLElement;
	/** The heading's label node, so a re-keyed group can be renamed without rebuilding the heading. */
	name?: HTMLElement;
	/** The paging row's two buttons, for paging entries. */
	paging?: PagingRow;
}

/**
 * The two buttons a paging row holds, and the row that lays them side by side.
 *
 * A separate type from {@link DrawnNode} for the same reason {@link RowParts} is: which nodes exist
 * and what gets written into them are separate facts, and the paging row writes two buttons' presence
 * where a session row writes five fields' text.
 */
interface PagingRow {
	/** The flex row the two buttons sit in; the drawn node itself. */
	row: HTMLElement;
	/** 「展开其余 N 个会话」, on while rows are held back. */
	more: HTMLButtonElement;
	/** 「收起」, on once a page has been added; steps the expansion back one page. */
	collapse: HTMLButtonElement;
}

/** One rename in flight: which row is being edited, and whether it has been settled already. */
interface Editing {
	sessionId: string;
	/** Set the first time Enter, Escape, or blur settles the edit, so the other two are no-ops. */
	settled: boolean;
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
	slot: HTMLElement;
	title: HTMLElement;
	time: HTMLElement;
	/** Last activity written into the time, kept so a tick can recompute the text without the rows. */
	modified?: number;
	/** The busy line the tooltip currently names, so an unchanged one is neither recomposed nor rewritten. */
	busy?: string;
	/** The tooltip string on screen, so an unchanged one is neither recomposed nor rewritten. */
	tooltip?: string;
	/** The creation stamp the tooltip's date was formatted from, so `toLocaleString` runs once per row. */
	created?: { at: number; text: string };
}

/**
 * One directory's paging state, or the untouched default: one page, open, nothing saved.
 *
 * The missing entry is the common case — a directory the user never paged or collapsed keeps no
 * record of it — so both the draw and the window's three handlers read through this rather than
 * indexing and defaulting at each site.
 */
export function pagingOf(paging: Record<string, DirectoryPaging>, workDirAbsPath: string): DirectoryPaging {
	return paging[workDirAbsPath] ?? { collapsed: false, page: 1, savedPage: 1 };
}

/**
 * The rows a directory shows after `pageCount` pages of its conversations: the first
 * `pageCount * PAGE_SIZE` conversations, each with the forks that came from it, and always the one
 * the window is on.
 *
 * The last part is why this is not a `slice`: a session that has been forked from is often older
 * than the first page's most recent, and the list still has to say where the conversation on screen
 * came from. A fork counts as part of the conversation it branched off rather than as a row of its
 * own, which is what keeps a heavily forked directory from crowding out the others — and which is
 * also why paging is counted in conversations here, the unit the limit actually caps, rather than
 * in rows the way the shape prototype demoed it.
 *
 * `Infinity` is the page count a filtering draw passes: a list the user is actively narrowing shows
 * every match, in every group, and holds nothing back.
 */
function pagedRows(rows: readonly TreeRow[], activeSessionId: string | undefined, pageCount: number): TreeRow[] {
	const limit = pageCount * PAGE_SIZE;
	const roots: number[] = [];
	const rootOf = rows.map((row, index) => {
		if (row.depth === 0) roots.push(index);
		return roots[roots.length - 1] ?? 0;
	});

	const visible = new Set(roots.slice(0, limit));
	const active = activeSessionId === undefined ? -1 : rows.findIndex((row) => row.session.id === activeSessionId);
	if (active >= 0) visible.add(rootOf[active]!);

	return rows.filter((_row, index) => visible.has(rootOf[index]!));
}

/**
 * One row of a directory's list: a session, and the name it is drawn under.
 *
 * Named apart from the protocol's `SessionRow` on purpose, because the two are not the same thing and
 * the difference is easy to miss. A protocol row is a session plus three facts only a running process
 * knows (`running`, `pending`, `modified`); this one is a protocol row plus its place in the fork tree
 * and the display title that place earns it.
 *
 * `label` is what the row wears and `base` is what a rename edits: they differ by exactly the row's
 * own `（N）`, which is drawn here rather than stored anywhere — the number is the row's own place
 * among its siblings under the same parent, by creation time. The base is the row's *own* stored
 * title the moment that title is a fact of its own — a rename makes it one — and the parent's label
 * while it is still the same string the parent carries, which is what stacks the suffixes: a fork of
 * a fork reads 标题（1）（1）, so no two rows of a family ever wear the same name.
 */
interface TreeRow {
	session: SessionRow;
	/** 0 for a session of its own, 1 for a fork of one, and one more per generation. Order still rides on it. */
	depth: number;
	/** The row's clean name: what a rename edits, and what the label is built from. */
	base: string;
	/** The full display title, suffix included. */
	label: string;
	/** The label of the session this one was forked from, for the row's own tooltip. */
	parentLabel?: string;
}

/**
 * Lay a directory's sessions out as the tree they are, and name each row.
 *
 * A fork records its parent as a file path, the listing resolves that to an id, and this is where the
 * id becomes a row: roots sorted by when they were last active, each fork directly beneath the session
 * it came from so a fork's own forks stay under it rather than beside it, and siblings in creation
 * order — which is what the suffix's number counts.
 *
 * The sort is done here rather than trusted from the listing, and that is the point. A row's position
 * is now a function of a field that moves while nobody is clicking, so the order has to be recomputed
 * from the rows on every render — inheriting it would mean the list silently disagrees with the rule
 * the moment the two sources diverged, which is precisely when the order is what a person is reading.
 * It costs one sort over a directory's roots.
 *
 * A fork whose parent is not in this list was already a root for every other purpose, and stays one
 * here — which is also what happens to a fork whose parent has been deleted: no parent, no suffix,
 * the name stands on its own. A file hand-edited into a cycle must not lose rows to a walk that never
 * returns, so anything the descent did not reach is placed at the top level rather than dropped.
 */
function rowsOf(group: DirectoryGroup): TreeRow[] {
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

	// The suffix counts a sibling's place by creation time, so the walk that lays the rows out reads
	// the same order the count does: a fork row appears under its parent in the order it was born.
	for (const siblings of children.values()) siblings.sort((a, b) => a.createdAt - b.createdAt);
	roots.sort((a, b) => b.modified - a.modified);

	const rows: TreeRow[] = [];
	const placed = new Set<string>();
	const place = (session: SessionRow, depth: number, parent: TreeRow | undefined, index: number): void => {
		if (placed.has(session.id)) return;
		placed.add(session.id);
		const suffix = parent === undefined ? "" : `（${index}）`;
		// The base is the row's own name the moment it becomes a fact of its own — a rename wrote one,
		// so the stored title differs from its parent's — and the parent's label while it is still the
		// same string the parent carries. Both halves matter: inheriting is what stacks the suffixes
		// down an unrenamed family, and stopping the inheritance at the first different name is what
		// lets a renamed row wear the name its server row actually carries.
		const inherited = parent !== undefined && session.title === parent.session.title;
		const base = inherited ? parent.label : session.title;
		const row: TreeRow = { session, depth, base, label: base + suffix };
		if (parent !== undefined) row.parentLabel = parent.label;
		rows.push(row);
		for (const [position, child] of (children.get(session.id) ?? []).entries()) {
			place(child, depth + 1, row, position + 1);
		}
	};

	for (const root of roots) place(root, 0, undefined, 0);
	for (const session of group.sessions) place(session, 0, undefined, 0);
	return rows;
}

/**
 * How many conversations one page of a directory holds.
 *
 * The page, not a collapsed cap: a directory shows this many conversations before 「展开其余」
 * offers one more page, and a directory with no more than this never wears a paging control at all.
 * Counted in conversations rather than rows, so a fork never costs another session its place. The
 * second status line makes each row taller, which is a density question rather than a correctness
 * one — the cap is about how much a scan can hold, and that has not changed.
 */
const PAGE_SIZE = 5;

/** The last segment of a path, which is what a person calls the project. */
export function directoryName(workDirAbsPath: string): string {
	const parts = workDirAbsPath.split(/[/\\]/).filter((part) => part.length > 0);
	return parts.at(-1) ?? workDirAbsPath;
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
 *
 * The oldest branch is cached per stamp. Past a week the label is a month and a day — a fact about
 * the timestamp alone, with no "now" in it — but producing it costs `Intl`, and this runs per row,
 * per frame; a long list made that the sidebar's remaining per-frame cost after the tooltip's own
 * `toLocaleString` was taken off it. The cache holds one entry per old row and nothing else.
 */
const dateLabels = new Map<number, string>();

function relativeTime(timestamp: number): string {
	const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
	if (seconds < 60) return "刚刚";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}小时`;
	if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}天`;
	let label = dateLabels.get(timestamp);
	if (label === undefined) {
		label = new Date(timestamp).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
		dateLabels.set(timestamp, label);
	}
	return label;
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