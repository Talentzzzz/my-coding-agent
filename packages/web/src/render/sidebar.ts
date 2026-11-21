import { element, icon, iconButton } from "../dom.ts";
import type { ChannelState } from "../client.ts";
import { openMenuAt } from "./menu.ts";
import { askForText } from "./text-dialog.ts";
import type { SessionRow, DirectoryGroup } from "@my-agent/core/protocol";
import type { DirectoryPaging } from "../ui-settings.ts";

export interface SidebarHandlers {
	/**
	 * 开始一段对话。
	 *
	 * `workDirAbsPath` 是请求发出*自*的目录，正是它让目录标题自己的「新建会话」落在右键所在处：
	 * 顶行的按钮要选择器的目录（无参数），标题指名自己的。一扇门而不是两扇，因为新会话无论在
	 * 哪里被要求都是同一件事。
	 */
	onNewSession(workDirAbsPath?: string): void;
	onSelectSession(sessionId: string): void;
	onToggleCollapsed(): void;
	onOpenSettings(): void;
	/** 系统文件夹选择器，是新目录进入列表的唯一道路。 */
	onAddDirectory(): void;
	/** 把这一行指名的会话整个复制，并打开副本。 */
	onForkSession(sessionId: string): void;
	/** 删除这一行指名的会话，会话记录和一切。 */
	onDeleteSession(sessionId: string): void;
	/**
	 * 给这一行指名的会话一个存储在服务端的名字。
	 *
	 * 行不在这里变：名字是服务端的真实存储，行等到连接的 `session_row` 帧送达新名时才变 ——
	 * 所有其他行事实走的同一条路，刻意不是本地修改、之后还要这一列去协调。
	 */
	onRenameSession(sessionId: string, title: string): void;
	/** 目录标题被点击：折叠到标题，或以保存的页重新打开。 */
	onToggleDirectory(workDirAbsPath: string): void;
	/** 目录的「展开其余」被点击：再显示一页它的对话。 */
	onPageDirectory(workDirAbsPath: string): void;
	/** 目录的「收起」被点击：展开退回一页。 */
	onCollapseDirectory(workDirAbsPath: string): void;
	/**
	 * 给这一标题指名的目录一个新标签（票 06）。
	 *
	 * `workDirAbsPath` 是卡片打开其上的组，`name` 是用户输入的。两者都不指名磁盘上的任何东西：
	 * 标签是设置记住的一个视图，所以窗口唯一的职责是存它、并重画戴着它的标题。
	 */
	onRenameDirectory(workDirAbsPath: string, name: string): void;
	/**
	 * 把这一标题指名的目录从列表移除，磁盘上什么都不碰。
	 *
	 * 菜单里叫 `delete`，因为那正是用户从他所坐的位置在做的事；handler 的职责 —— 和端点的名字
	 * —— 是更窄的「hide」。
	 */
	onDeleteDirectory(workDirAbsPath: string): void;
}

export interface SidebarState {
	/** 每个有存储会话的目录，最近使用在前。 */
	directories: readonly DirectoryGroup[];
	activeSessionId?: string;
	/**
	 * 本窗口的草稿会话，按本地 id；缺失表示没有草稿。
	 *
	 * 草稿是只存在于这个窗口里、还没发过第一条消息的会话：它的行由调用方直接混进 `directories`，
	 * 这里携带的是"哪些 id 是草稿"—— 行的样式（未发送的灰显）与菜单（只有丢弃，没有派生/重命名）
	 * 由它分岔。服务端对草稿一无所知，所以行事实的另一条路（`session_row` 帧）永远轮不到它。
	 */
	drafts?: ReadonlySet<string>;
	collapsed: boolean;
	/**
	 * 按目录路径分页的状态，本窗口 UI 设置持有的样子（ADR-0029）。
	 *
	 * 这里只读：侧栏从它绘制、上报点击，而拥有设置写入的窗口以新映射作答。它骑在 UI 设置上——
	 * 客户端自己的存储（外壳桥或 localStorage），而不是桌面外壳换端口就会搁浅的 origin 作用域
	 * `localStorage` 的裸读。
	 */
	paging: Record<string, DirectoryPaging>;
	/**
	 * 用户给目录起的名字，按路径，本窗口 UI 设置持有的样子。
	 *
	 * 有 `directoryNames[workDirAbsPath]` 时标题戴着它，否则戴文件夹自己的名字。条目是一个
	 * *视图*：磁盘上的文件夹从不改名，所以这就是一次改名改变的全部 —— 也是它骑客户端自己的
	 * 设置而不是服务端列出的组的原因。
	 */
	directoryNames?: Record<string, string>;
	/**
	 * 常驻通道是否可用。
	 *
	 * 一个画在这里而不是状态行上的窗口级事实，因为它属于窗口而不属于任何一段对话。住在
	 * `SidebarState` 而不是 `ViewState` 的理由与行相同：连接不是会话，所以不该是会话的基线能
	 * 覆盖的东西。
	 */
	channel: ChannelState;
}

/**
 * 行的席位在说什么，即 tooltip 点亮时多出来的那行。
 *
 * 其中只有两个是关于会话的事实，且共享同一颗琥珀色圆点：等用户的会话不比工作中的更紧急 ——
 * 同一个事实的两侧，给它们两种颜色是让眼睛去学文字已经作出的区分。文字留在 tooltip 里，想知道
 * 圆点为什么亮的人可以在那里读。
 *
 * "已打开"不需要席位：它就是 `aria-current` 的背景本身，行已经在说自己就是屏幕上的那个。
 */
function busyOf(sessionRow: SessionRow): string | undefined {
	if (sessionRow.pending > 0) return sessionRow.pending > 1 ? `待审批 ${sessionRow.pending}` : "待审批";
	if (sessionRow.running) return "运行中";
	return undefined;
}

/**
 * 导航列。
 *
 * 它拥有关于*哪个*对话在屏幕上的一切 —— 目录分组、每组下面的树、新建会话控件、进入设置的路
 * —— 而对对话本身一无所知。正是这个拆分让右列可替换：侧栏从不读会话记录。
 *
 * 行原地更新。行现在在没人点击时也会变 —— 一个会话结束回合会动自己的行，后台会话开始回合会
 * 翻指示器 —— 所以重建列表会在指针按下与抬起之间把按钮换掉，点击会落在一个已不存在的元素上。
 * 因此每行构建一次然后补丁，重排移动节点而不是重建。
 */
export class Sidebar {
	readonly element: HTMLElement;
	private readonly handlers: SidebarHandlers;
	private readonly list: HTMLElement;
	private readonly toggle: HTMLButtonElement;
	/** 通道的三种状态，作为设置条目旁边的圆点。 */
	private readonly indicator: HTMLElement;
	private readonly indicatorText: HTMLElement;
	/**
	 * 屏幕上的行，按会话 id。
	 *
	 * 正是这张映射让原地补丁成为可能：行被查找而不是构建，所以一次三个字段变化、顺序没变的
	 * 重渲染只触碰三个文本节点。掉出列表的行被移除，且只在那里。
	 */
	private readonly drawnNodeMap = new Map<string, DrawnNode>();
	/** 窗口所在行的 `id`，所以 `scrollIntoView` 只在它变化时发生。 */
	private scrolledTo: string | undefined;
	/**
	 * 交给 {@link render} 的最后一个状态，让列表内画的控件能请求重画而无需调用者把它传回来。
	 * 只有分页行需要这个。
	 */
	private lastSidebarState: SidebarState | undefined;
	/** 搜索行是否在屏幕上，以及它过滤的文本。 */
	private searchOpen = false;
	private filterText = "";
	private readonly headRow: HTMLElement;
	private readonly searchRow: HTMLElement;
	private readonly searchInput: HTMLInputElement;
	private readonly noMatch: HTMLElement;
	/**
	 * 上一次渲染的行，按会话 id。
	 *
	 * 树行是行的显示标题被算出来的地方，重命名编辑器正需要它：它编辑的干净名字是去掉后缀的标签，
	 * 只有树知道。每次渲染重建，所以重命名永远从屏幕上实际有的东西播种。
	 */
	private readonly treeRowMapById = new Map<string, TreeRow>();
	/** 进行中的重命名编辑器，若有。一次一个，与这里每个弹窗一样。 */
	private editing: Editing | undefined;

	constructor(handlers: SidebarHandlers) {
		this.handlers = handlers;
		this.element = element("aside", "sidebar");

		// 顶行是拖动条、也仅仅是拖动条：窗口从这里移动，所以这一行只放列开场用的两个控件、没有
		// 品牌 —— 这一列是列表，不是产品，logo 只是又一件和对话抢注意力的 chrome。
		const top = element("div", "sidebar-top");
		const newSession = element("button", "new-session", undefined, { type: "button" });
		newSession.append(icon("plus"), element("span", undefined, "新会话"));
		newSession.addEventListener("click", () => this.handlers.onNewSession());
		this.toggle = iconButton("panel", "切换侧边栏", () => this.handlers.onToggleCollapsed());
		top.append(newSession, this.toggle);

		this.list = element("nav", "session-list", undefined, { "aria-label": "会话列表" });

		// 标题行和它的三个控件，按参考布局：一个真正过滤列表的搜索、一个暂时只有外观的视图选项，
		// 以及这台机器从未有过会话的目录的入口。
		this.headRow = element("div", "list-head");
		this.headRow.append(element("div", "session-list-heading", "目录"));
		const headActions = element("div", "list-head-actions");
		headActions.append(
			iconButton("search", "搜索会话", () => this.toggleSearch()),
			// 刻意只看不改：排序保持 `modified` 降序，控件放在这里是让这一行读起来像参考布局，
			// 而不是让它可用。点击说明这一点。
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
			if (this.lastSidebarState !== undefined) this.renderRows(this.lastSidebarState);
		});
		this.searchInput.addEventListener("keydown", (event) => {
			if (event.key === "Escape") this.toggleSearch();
		});
		this.searchRow.append(this.searchInput);
		this.searchRow.hidden = true;

		this.noMatch = element("div", "session-list-empty", "没有匹配的会话");
		this.noMatch.hidden = true;

		// 眼睛不断回到的角落里的唯一控件：一切设定一次的东西 —— 主题、字号、模型 —— 都住在它
		// 后面，而不是会话记录周围的 chrome 里。通道指示器共享底部而不是过去与品牌共享的顶行：
		// 它是关于窗口的事实，而底部正是窗口级事物住的地方。
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

	/** 打开或关闭搜索行。关闭时清空过滤，因为关着的过滤器什么也不过滤。 */
	private toggleSearch(): void {
		this.searchOpen = !this.searchOpen;
		this.searchRow.hidden = !this.searchOpen;
		this.searchInput.value = "";
		this.filterText = "";
		if (this.lastSidebarState !== undefined) this.renderRows(this.lastSidebarState);
		if (this.searchOpen) this.searchInput.focus();
	}

	render(sidebarState: SidebarState): void {
		this.lastSidebarState = sidebarState;
		this.renderRows(sidebarState);

		const root = document.getElementById("app");
		if (root) root.dataset.sidebar = sidebarState.collapsed ? "rail" : "full";
		this.toggle.title = sidebarState.collapsed ? "展开侧边栏" : "收起侧边栏";
		this.renderIndicator(sidebarState.channel);
	}

	/**
	 * 画行，移动动过的、补丁变过的。
	 *
	 * 这前面不再有签名门，而这正是要点：过去让行变化的字段根本不在旧签名里，所以别的机器上一个
	 * 结束了回合的会话，无论列表刷新多少次都变不了自己的文本。廉价的比较被换成准确的 —— 每行
	 * 都补丁，补丁一行没变的行写的还是同一个值。
	 */
	private renderRows(sidebarState: SidebarState): void {
		const wanted = new Set<string>();
		const groups = sidebarState.directories;
		const filter = this.filterText.trim().toLowerCase();
		this.treeRowMapById.clear();

		if (groups.length === 0) {
			this.drawnNodeMap.clear();
			this.list.replaceChildren(this.headRow, this.searchRow, element("div", "session-list-empty", "暂无会话"));
			this.searchRow.hidden = !this.searchOpen;
			this.scrolledTo = undefined;
			return;
		}
		this.ensureHeading();

		// 过滤显示每组里的每个匹配：分页上限限制的是一次扫描能装下多少，正在收窄的列表不是扫描。
		let matches = 0;
		for (const group of groups) {
			const entry = pagingOf(sidebarState.paging, group.workDirAbsPath);
			// 空键是草稿的假组（「未选择目录」）：它不是磁盘路径，没有文件夹名可取，标签自己说出来。
			const label =
				sidebarState.directoryNames?.[group.workDirAbsPath] ??
				(group.workDirAbsPath.length === 0 ? "未选择目录" : directoryName(group.workDirAbsPath));
			const wrapper = this.groupFor(group.workDirAbsPath, entry, label);
			const rows = rowsOf(group);
			for (const row of rows) this.treeRowMapById.set(row.session.id, row);
			// 按行*戴着*的标签匹配，而不是它存储的标题：派生的后缀是人读到的东西的一部分，所以
			// "（1）"收窄到那个派生，而不是它的每个兄弟。
			const kept =
				filter === ""
					? rows
					: rows.filter(
							(row) => row.label.toLowerCase().includes(filter) || group.workDirAbsPath.toLowerCase().includes(filter),
						);
			matches += kept.length;
			const open = filter !== "" || !entry.collapsed;
			const shown = open
				? pagedRows(kept, sidebarState.activeSessionId, filter !== "" ? Infinity : entry.page)
				: [];
			// 隐藏而不是移除：没有匹配的组保住自己在 DOM 里的位置，清掉过滤时每组回到原位，而不是按
			// 创建顺序重新追加。
			wrapper.hidden = filter !== "" && kept.length === 0;

			// 标题是包裹的第一个子节点，所以可移动的行序列从它*之后*开始。用标题播种 `previous`
			// 正是让第一行落在标题下面的机制：传 `undefined` 的话锚点是包裹的第一个子节点、也就是
			// 标题本身，第一行会被插到它上面。
			let previous: HTMLElement | undefined = wrapper.firstElementChild as HTMLElement | null ?? undefined;
			// 按序追加、只在位置不同时移动，所以浏览器每次渲染做最少的活，没有节点会在指针停在它
			// 上面时被销毁重建。
			for (const row of shown) {
				wanted.add(row.session.id);
				const button = this.rowFor(row, sidebarState);
				this.place(wrapper, button, previous);
				previous = button;
			}

			// 列表下面的分页行，一行两个按钮：「展开其余」在有行被扣住时；旁边 —— 加了一页之后
			// —— 是把展开退回一页的「收起」。分页从来不是回事的地方两者都不出现，即对话不多于一页
			// 的目录；过滤中的列表显示它匹配的一切，所以两样都不戴；折叠的目录也不戴 —— 决定是
			// 全部收起、只留表头，标题下面的分页行会与它所在的折叠矛盾。
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

		// 这一列画过、且不再需要的全部退场，标题包括，而这里正是*过期*条目成为关键的地方：被改名
		// 目录的标题不再被任何键指名，唯一还握着它的包裹的就是这张映射。没有东西从列表往回走，
		// 所以没有行的组 —— 被改名那个，它的行已经在新路径下面 —— 从 DOM 上根本够不到。
		for (const [key, node] of [...this.drawnNodeMap]) {
			if (wanted.has(key)) continue;
			node.button.remove();
			this.drawnNodeMap.delete(key);
		}

		// 只有窗口移到了另一段对话时。每次渲染都做会把列表在后台行的更新下拖来拖去，而这正是这个
		// 设计要防的那件事。
		if (sidebarState.activeSessionId !== this.scrolledTo) {
			this.scrolledTo = sidebarState.activeSessionId;
			if (sidebarState.activeSessionId !== undefined) {
				this.list.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
			}
		}
	}

	/** 把节点放到 `previous` 之后，已在那个位置时什么都不做。 */
	private place(parent: HTMLElement, node: HTMLElement, previous: HTMLElement | undefined): void {
		const wanted = previous === undefined ? parent.firstChild : previous.nextSibling;
		if (node === wanted) return;
		parent.insertBefore(node, wanted);
	}

	private ensureHeading(): void {
		// 标题行和搜索行是列表的固定前缀；丢了它们的列表 —— 比如空阶段的 `replaceChildren` ——
		// 以相同顺序取回。无匹配的提示是列表的后缀，只在不在末尾时移动。
		if (!this.list.contains(this.headRow)) this.list.prepend(this.headRow, this.searchRow);
		this.searchRow.hidden = !this.searchOpen;
		// 空阶段在第一组到达后留下它的提示：`replaceChildren` 把它放了进去，之后没有东西认领，
		// 从空开始的列表会戴着「暂无会话」直到窗口关闭。`noMatch` 共享这个类、是列表的永久后缀，
		// 所以它是这里绝不能移除的那个提示。
		for (const note of [...this.list.children]) {
			if (note !== this.noMatch && note.classList.contains("session-list-empty")) note.remove();
		}
		if (this.list.lastElementChild !== this.noMatch) this.list.append(this.noMatch);
	}

	/**
	 * 一个目录的标题，构建一次之后只更新标签。
	 *
	 * 分页决定之后标题成了真正的按钮：点击它是目录折叠到标题、再次打开的方式，所以 Enter 和
	 * Space 像其他控件一样够得到它，`[aria-expanded]` 是屏幕阅读器 —— 和样式表的 chevron —— 读的
	 * 状态。状态像画过的其他节点一样补丁：动了才写。
	 *
	 * `label` 是用户给这个目录起的名字，调用者已经从设置解析好：改名改变的只是这个字符串，所以
	 * 节点以 `workDirAbsPath` 为键 —— 改名不再移动它 —— 只有文本被补丁。
	 */
	private groupFor(workDirAbsPath: string, entry: DirectoryPaging, label: string): HTMLElement {
		const key = `head:${workDirAbsPath}`;
		const existing = this.drawnNodeMap.get(key);
		if (existing !== undefined) {
			// 两个事实都经这个条目构建时用的标题引用写入，谁都不需要搜索。
			if (existing.head !== undefined) {
				this.paintExpanded(existing.head, entry.collapsed);
			}
			// 标签被补丁的理由与行的标题相同：没有任何东西会重建标题，戴着旧名的节点必须能摘下它。
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
		// 两个图标都在每个标题上，由悬停 —— 而不是 DOM —— 决定显示哪个：文件夹是内容，chevron 是
		// 交互提示，交换让一个位置承载两个含义。
		const folder = element("span", "directory-icon-folder");
		folder.append(icon("folder"));
		const chev = element("span", "directory-icon-chev");
		chev.append(icon("chevron"));
		const name = element("span", "directory-name", label);
		head.append(folder, chev, name);
		head.addEventListener("click", () => this.handlers.onToggleDirectory(workDirAbsPath));
		// 标题的全部菜单住在这里而不是任何常驻控件上：右键指名目录，打开的菜单是"在此新建会话、
		// 重命名、删除"被提供的唯一地方 —— 会话行菜单走的同一条路。
		head.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.openDirectoryMenu(workDirAbsPath, label, event.clientX, event.clientY);
		});

		const wrapper = element("div", "directory");
		wrapper.append(head);
		this.list.append(wrapper);
		this.drawnNodeMap.set(key, { button: wrapper, head, name });
		return wrapper;
	}

	/**
	 * 一个目录标题拥有的唯一菜单：在此新建会话、重命名、删除。
	 *
	 * 新建会话指名它被按下的 workDirAbsPath，这正是这项的全部意义 —— 顶行的按钮在选择器指向的
	 * 任何地方开始会话，这一个在*这里*开始。
	 *
	 * 删除带着说明它不做什么的 tooltip。菜单用词是用户正在找的那个；它背后的端点和它下面的句子
	 * 都更窄，从侧栏删除一个项目的人有权知道文件夹哪儿也不会去。
	 */
	private openDirectoryMenu(workDirAbsPath: string, label: string, x: number, y: number): void {
		// 空键是草稿的假组（「未选择目录」）：它不是磁盘路径，没有「在这里新建」「重命名」「删除」
		// 可言 —— 它唯一的出口是把打开的草稿在目录芯片上安个目录。菜单因此只留草稿自己的话。
		if (workDirAbsPath.length === 0) {
			openMenuAt(x, y, [
				{ label: "先在输入条上方的目录芯片里选一个目录", title: "无目录草稿在目录选定之前不能开始对话" },
			]);
			return;
		}
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
	 * 问这个标题该戴什么名字，并在被问的组旁边上报。
	 *
	 * 收集的是一个*标签*，所以它不可能错到付出代价的地步：目录保留自己的名字，没有任何会话记录
	 * 被改写。读起来像路径的名字仍然被丢弃 —— 标题坐落在一个真实目录名的列表里，一个看起来像
	 * 目录移动的名字只会被误读。空盒子是共享对话框表达"没被要求"的方式，所以收回自定义名是设置
	 * 那条路的职责（`directoryNames[workDirAbsPath] = ""`），不是这张卡片的。标题已经戴着的标签
	 * 被丢弃的理由更简单：那不是变更。
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

	private rowFor(treeRow: TreeRow, sidebarState: SidebarState): HTMLElement {
		const existing = this.drawnNodeMap.get(treeRow.session.id);
		if (existing !== undefined && existing.parts !== undefined) {
			this.patchRow(existing.parts, existing.button, treeRow, sidebarState);
			return existing.button;
		}

		const button = element("button", "session-item", undefined, { type: "button" });
		// 一行，按参考的行规格：状态席位、标题、时间。席位是行唯一的放状态的空间 —— 标题下的
		// 第二行让每行都变高，去承载 16px 沟槽里一颗圆点已经说清楚的事。
		const slot = element("span", "session-item-slot");
		const title = element("span", "session-item-title");
		const time = element("span", "session-item-time");
		button.append(slot, title, time);
		button.addEventListener("click", () => this.handlers.onSelectSession(treeRow.session.id));
		// 行的全部菜单住这里而不是任何常驻控件上：右键指名行，打开的菜单是派生、重命名、删除被
		// 提供的唯一地方。
		button.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.openSessionMenu(treeRow.session.id, event.clientX, event.clientY);
		});

		const parts: RowParts = { slot, title, time };
		this.drawnNodeMap.set(treeRow.session.id, { button, parts });
		this.patchRow(parts, button, treeRow, sidebarState);
		return button;
	}

	/**
	 * 一个会话行拥有的唯一菜单：派生、重命名、删除。
	 *
	 * 在指针处打开，`contextmenu` 要求的方式。派生的 tooltip 写的是这次调用真正做的 —— 整份日志
	 * 被复制、对话从那里继续 —— 因为"从最后一条继续"承诺得比派生多：分支会话最后*记录*的位置
	 * 不是"最后一个回合"，而复制的是一切。
	 *
	 * 草稿行是另一张菜单：服务端对它一无所知，所以派生与重命名（两个都走服务端）没有可指的对象，
	 * 只有"丢弃"—— 一个本地的、不可撤销的移除。
	 */
	private openSessionMenu(sessionId: string, x: number, y: number): void {
		if (this.lastSidebarState?.drafts?.has(sessionId) === true) {
			openMenuAt(x, y, [
				{
					icon: "trash",
					label: "丢弃草稿",
					danger: true,
					title: "从侧栏移除这条还没发过消息的草稿",
					onSelect: () => this.handlers.onDeleteSession(sessionId),
				},
			]);
			return;
		}
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
	 * 把一行的标题原地变成编辑器。
	 *
	 * 编辑器持有*干净*的名字 —— 派生行戴的 `（1）` 是它出身的事实，人不该被迫重新输入 —— 所以
	 * 种子来自树行的 base。Enter 提交，Escape 保持行原样，点别处也提交，因为失去了听众的编辑器
	 * 没有理由扔掉输入。
	 *
	 * 提交不在这一行上改变任何东西。名字是服务端的真实存储，行在连接的 `session_row` 帧到达时
	 * 戴上新的 —— 所有其他行事实的同一条路，刻意不是本地修改、之后还要这一列去协调。
	 */
	private startRename(sessionId: string): void {
		if (this.editing !== undefined) return;
		const drawn = this.drawnNodeMap.get(sessionId);
		const treeRow = this.treeRowMapById.get(sessionId);
		if (drawn?.parts === undefined || treeRow === undefined) return;

		const input = element("input", "rename-input", undefined, { type: "text", "aria-label": "会话名称" });
		const original = treeRow.base;
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
			// 只在是变更时发送：重新记录行已经戴着的名字，是一次把服务端已持有的东西再存一遍的
			// 请求。
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
 * 把一行当前值放进已在屏幕上的那行。
	 *
	 * 每个分支只写不同的东西，因为它每帧都跑，而原地补丁的全部意义就是没变时重渲染零成本。连
	 * 写入已经存在的值都被跳过：无条件赋 `textContent` 会在每次心跳时替换文本节点，恰是这个设计
	 * 要避免的抖动。
	 */
	private patchRow(parts: RowParts, button: HTMLElement, treeRow: TreeRow, sidebarState: SidebarState): void {
		const isActive = treeRow.session.id === sidebarState.activeSessionId;
		const isDraft = sidebarState.drafts?.has(treeRow.session.id) === true;

		// tooltip 只由可能变化的东西构成，创建日期 —— 唯一要花一次真 `toLocaleString` 的部分 ——
		// 每个时间戳格式化一次并保存。每帧重组字符串是廉价的；为从不变的日期每帧调 `Intl` 不是，
		// 而且它按行、按帧、对屏幕上每行都在跑。
		let created = parts.created;
		if (created === undefined || created.at !== treeRow.session.createdAt) {
			created = { at: treeRow.session.createdAt, text: formatDate(treeRow.session.createdAt) };
			parts.created = created;
		}
		// 草稿的 tooltip 是它自己的话：还没有任何记录可谈，目录与"未发送"就是全部。busy 对它
		// 永远缺席 —— 没说过的会话不可能在运行。
		// 父级按它*戴着*的名字指名，而不是它存的：派生的派生把后缀挂在父级自己的上面，所以
		// tooltip 指名的是人真正在上面的行看到的行。busy 行骑在末尾：圆点是扫一眼，文字是细看。
		const busy = busyOf(treeRow.session);
		const draftDirectory = treeRow.session.workDirAbsPath.length === 0 ? "未选择目录" : treeRow.session.workDirAbsPath;
		const tooltip = isDraft
			? `${treeRow.label}\n${draftDirectory}\n未发送 —— 发出第一条消息时才创建`
			: (treeRow.parentLabel === undefined
					? `${treeRow.label}\n${treeRow.session.workDirAbsPath}\n创建于 ${created.text}`
					: `${treeRow.label}\n${treeRow.session.workDirAbsPath}\n派生自 ${treeRow.parentLabel}\n创建于 ${created.text}`) +
				(busy === undefined ? "" : `\n${busy}`);
		if (parts.tooltip !== tooltip) {
			parts.tooltip = tooltip;
			button.title = tooltip;
		}

		if (parts.title.textContent !== treeRow.label) parts.title.textContent = treeRow.label;
		this.paintTime(parts, treeRow.session.modified);
		this.paintSlot(parts, busy);

		// 草稿的灰显是属性开关，与其他一切一样原地补丁：行从草稿转正（create 完成、真实行到达）
		// 时摘下标记，CSS 规则接手其余。
		if (isDraft) button.dataset.draft = "true";
		else delete button.dataset.draft;

		if (isActive) button.setAttribute("aria-current", "true");
		else button.removeAttribute("aria-current");
	}

	/**
	 * 重画每一行画过的相对时间。
	 *
	 * 每帧调用，心跳也是，所以一行不会在它指名的对话安静一小时后还停在"刚刚"。它复用心跳而不
	 * 加自己的时钟：一只钟就是一件可能出错的东西，通道断开时它也停 —— 这是诚实的行为，因为
	 * "多久之前"在帧停止的那一刻就不再可知。
	 */
	tick(): void {
		for (const drawn of this.drawnNodeMap.values()) {
			const parts = drawn.parts;
			if (parts?.modified === undefined) continue;
			this.paintTime(parts, parts.modified);
		}
	}

	/**
	 * 写行的相对时间，记住它来自的时间戳。
	 *
	 * 时间戳被保存，让 {@link tick} 能在不再拿到行的情况下重新计算文本 —— 心跳不携带会话 id，
	 * 从文本重新推导时间戳意味着把"3小时"解析回日期。
	 */
	private paintTime(parts: RowParts, modified: number): void {
		const text = relativeTime(modified);
		if (parts.time.textContent !== text) parts.time.textContent = text;
		parts.modified = modified;
	}

	/**
	 * 点亮席位的圆点，或清掉它。
	 *
	 * 清除而不是留下旧状态，因为列表滚开时停止运行的行，回来时会还声称自己在运行。属性 —— 而不是
	 * 类 —— 是开关，圆点离两种状态都只差一条 CSS 规则，元素本身保留：它是行的，逐变更重建它正是
	 * 这个全部设计要避免的抖动。
	 */
	private paintSlot(parts: RowParts, busy: string | undefined): void {
		if (parts.busy === busy) return;
		parts.busy = busy;
		if (busy === undefined) parts.slot.removeAttribute("data-state");
		else parts.slot.dataset.state = "warn";
	}

	/**
	 * 一个目录对话下面的分页行：「展开其余」在前，以及 —— 并排、不在下面 —— 「收起」。
	 *
	 * 一个画过的节点握着两个按钮，而不是两个画过的节点一前一后摆放，因为列表列把子节点竖排：
	 * 并排是它们自己的一行。像每个画过的节点一样原地补丁 —— 落在 pointer-down 与 up 之间的按压
	 * 绝不能落在被重建过的按钮上 —— 两者哪个在屏幕上是补丁的一部分而不是重建：展开在有行被扣住
	 * 时在，收起在加了一页后在，任意单独一个都是行的普通状态。
	 */
	private pagingRowFor(workDirAbsPath: string): PagingRow {
		const key = `paging:${workDirAbsPath}`;
		const existing = this.drawnNodeMap.get(key);
		if (existing?.paging !== undefined) return existing.paging;

		const more = element("button", "session-more", undefined, { type: "button" });
		more.addEventListener("click", () => this.handlers.onPageDirectory(workDirAbsPath));
		const collapse = element("button", "session-more session-collapse", "收起", { type: "button" });
		collapse.addEventListener("click", () => this.handlers.onCollapseDirectory(workDirAbsPath));
		const row = element("div", "session-paging");
		row.append(more, collapse);
		const paging: PagingRow = { row, more, collapse };
		this.drawnNodeMap.set(key, { button: row, paging });
		return paging;
	}

	/** 写一条分页行的当前状态，且只写动了的。 */
	private paintPagingRow(paging: PagingRow, more: boolean, back: boolean, hidden: number): void {
		paging.more.hidden = !more;
		if (more) {
			const label = `展开其余 ${hidden} 个会话`;
			if (paging.more.textContent !== label) paging.more.textContent = label;
		}
		paging.collapse.hidden = !back;
	}

	/** 按键丢掉一个画过的节点，无论它在哪。 */
	private stale(key: string): void {
		const entry = this.drawnNodeMap.get(key);
		if (entry === undefined) return;
		entry.button.remove();
		this.drawnNodeMap.delete(key);
	}

	/**
	 * 通道的状态，一颗圆点和至多几个字。
	 *
	 * live 时没有字。指示器的职责是那个让人注意到"出问题了"的东西，只在出问题时才出现的文字
	 * 正是让它成为那个的东西 —— 永久写着"已连接"的标签只是又一件和对话抢注意力的 chrome。
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
 * 一个画过的节点，加上渲染之间记住的关于它的东西。
 *
 * 三种东西住在这张映射里，其中只有一种是会话行 —— 目录标题和分页行以同样的方式画出、为同样的
 * 理由保存、且从不重建。`parts` 和 `paging` 是区分它们的东西：`parts` 恰好在行上，`paging` 恰好
 * 在分页行上，所以补丁代码可以直达任何一个而不必问拿到的条目碰巧是不是另一种。
 */
interface DrawnNode {
	/** 行的按钮，或组标题、分页行的容器。 */
	button: HTMLElement;
	/** 行自己的部件，和最后写入它们的值。非行条目缺席。 */
	parts?: RowParts;
	/** `button` 内部的标题元素，给组条目。 */
	head?: HTMLElement;
	/** 标题的标签节点，让换键的组无需重建标题就能改名。 */
	name?: HTMLElement;
	/** 分页行的两个按钮，给分页条目。 */
	paging?: PagingRow;
}

/**
 * 分页行握着的两个按钮，和把它们并排的那一行。
 *
 * 与 {@link DrawnNode} 分开成独立类型的理由与 {@link RowParts} 相同：哪些节点存在、什么被写进
 * 去是两个事实，分页行写的是两个按钮的存在，会话行写的是五个字段的文本。
 */
interface PagingRow {
	/** 两个按钮所在的 flex 行；画过的节点本身。 */
	row: HTMLElement;
	/** 「展开其余 N 个会话」，有行被扣住时在。 */
	more: HTMLButtonElement;
	/** 「收起」，加了一页后在；把展开退回一页。 */
	collapse: HTMLButtonElement;
}

/** 一次进行中的重命名：哪一行在被编辑，以及它是否已被结算。 */
interface Editing {
	sessionId: string;
	/** Enter、Escape 或 blur 第一次结算编辑时置位，于是另外两个成为无操作。 */
	settled: boolean;
}

/**
 * 一行的哪些部件被写、以及它们当前持有的值。
 *
 * 与 {@link DrawnNode} 分开而不是给它加更多可选字段，因为"哪些节点存在"和"往一行里写什么"是
 * 两个事实：前者关于列表的形状，后者关于一个会话。合并的话，每次写入都得先问拿到的到底是不是
 * 一行。
 */
interface RowParts {
	slot: HTMLElement;
	title: HTMLElement;
	time: HTMLElement;
	/** 写入时间里的最后活动，让 tick 在不拿到行的情况下重算文本。 */
	modified?: number;
	/** tooltip 当前指名的 busy 行，没变的既不重组也不重写。 */
	busy?: string;
	/** 屏幕上的 tooltip 字符串，没变的既不重组也不重写。 */
	tooltip?: string;
	/** tooltip 日期格式化自的创建时间戳，`toLocaleString` 每行只跑一次。 */
	created?: { at: number; text: string };
}

/**
 * 一个目录的分页状态，或未触碰的默认：一页、展开、没存过。
 *
 * 缺失的条目是常见情形 —— 用户从未翻页或折叠的目录不保留记录 —— 所以绘制和窗口的三个 handler
 * 都经由这里读，而不是在每个调用点索引加默认。
 */
export function pagingOf(paging: Record<string, DirectoryPaging>, workDirAbsPath: string): DirectoryPaging {
	return paging[workDirAbsPath] ?? { collapsed: false, page: 1, savedPage: 1 };
}

/**
 * 一个目录 `pageCount` 页对话之后的行：前 `pageCount * PAGE_SIZE` 个对话，各带来自它的派生，
 * 且永远包含窗口所在的那一个。
 *
 * 最后一部分正是不是 `slice` 的原因：被派生过的会话往往比第一页最新的更旧，列表仍然要说屏幕上
 * 的对话从哪来。派生算作它分出的对话的一部分而不是自己的一行，这让重度派生的目录不挤占其他
 * 目录 —— 也是分页在这里按对话数（上限真正约束的单位）而不是按行数计的原因，后者是形状原型
 * demo 的做法。
 *
 * `Infinity` 是过滤绘制传入的页数：正在收窄的列表显示每组的每个匹配，什么都不扣。
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
 * 目录列表的一行：一个会话，和它画出来的名字。
 *
 * 刻意与协议的 `SessionRow` 区分开，因为两者不是同一个东西，差别容易漏。协议行是会话加三个只有
 * 运行中的进程才知道的事实（`running`、`pending`、`modified`）；这个是协议行加它在派生树里的
 * 位置、以及那个位置挣来的显示标题。
 *
 * `label` 是行戴的，`base` 是重命名编辑的：两者恰好相差行自己的 `（N）`，那个数字在这里画而
 * 不是存在任何地方 —— 它是行在同一父级下的兄弟中按创建时序排的位次。base 在行的存储标题成为
 * 它自己的事实那一刻（一次改名让它成为）是行自己的存储标题，在它仍是父级携带的同一字符串时是
 * 父级的 label，这正是堆叠后缀的机制：派生的派生读作 标题（1）（1），于是同一家族没有两行戴
 * 同一个名字。
 */
interface TreeRow {
	session: SessionRow;
	/** 自己一个会话为 0，一个的派生为 1，每代再加一。顺序仍然骑在它上面。 */
	depth: number;
	/** 行的干净名字：重命名编辑的，标签由它构建。 */
	base: string;
	/** 完整显示标题，后缀含在内。 */
	label: string;
	/** 本会话派生自的那个会话的标签，给行自己的 tooltip。 */
	parentLabel?: string;
}

/**
 * 把一个目录的会话摆成它们本来的树，并为每行指名。
 *
 * 派生以文件路径记录父级，列表把路径解析成 id，这里就是 id 变成行的地方：根按最近活跃排序，
 * 每个派生直接坐在它来自的会话下面，让派生的派生留在它下面而不是旁边，兄弟按创建顺序 ——
 * 正是后缀的数字所数的。
 *
 * 排序在这里做而不是信任列表，这就是要点。行的位置现在是一个在无人点击时也会移动的字段的
 * 函数，所以顺序必须每次渲染从行重新计算 —— 继承它意味着两个来源分歧的那一刻，列表悄悄违背
 * 规则，而这恰是人正在读顺序的时候。它只花一次对目录根的排序。
 *
 * 父级不在这个列表里的派生，对其他一切目的早已是根，在这里也保持 —— 父级已被删除的派生同样
 * 如此：没有父级、没有后缀、名字独立成立。被手工编辑成环的文件绝不能让行丢给一个永不返回的
 * 遍历，所以下降没够到的任何东西都被放到顶层，而不是丢弃。
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

	// 后缀按创建时间数兄弟的位次，所以摆行的遍历读的是与计数相同的顺序：派生行按出生顺序出现在
	// 父级下面。
	for (const siblings of children.values()) siblings.sort((a, b) => a.createdAt - b.createdAt);
	roots.sort((a, b) => b.modified - a.modified);

	const rows: TreeRow[] = [];
	const placed = new Set<string>();
	const place = (session: SessionRow, depth: number, parent: TreeRow | undefined, index: number): void => {
		if (placed.has(session.id)) return;
		placed.add(session.id);
		const suffix = parent === undefined ? "" : `（${index}）`;
		// base 在行的名字成为它自己的事实那一刻 —— 一次改名写过一个 —— 是行自己的，在它仍是
		// 父级携带的同一字符串时继承父级的 label。两半都重要：继承是后缀沿未改名家族堆叠下来的
		// 机制，在第一个不同的名字处停止继承，才让改过名的行戴上它的服务端行实际携带的名字。
		const inherited = parent !== undefined && session.title === parent.session.title;
		const base = inherited ? parent.label : session.title;
		const treeRow: TreeRow = { session, depth, base, label: base + suffix };
		if (parent !== undefined) treeRow.parentLabel = parent.label;
		rows.push(treeRow);
		for (const [position, child] of (children.get(session.id) ?? []).entries()) {
			place(child, depth + 1, treeRow, position + 1);
		}
	};

	for (const root of roots) place(root, 0, undefined, 0);
	for (const session of group.sessions) place(session, 0, undefined, 0);
	return rows;
}

/**
 * 一个目录一页装多少对话。
 *
 * 是页，不是折叠上限：目录先显示这么多对话，「展开其余」再提供一页，不多于此的目录根本不戴
 * 分页控件。按对话数而不是行数计，派生绝不花掉另一个会话的位置。第二条状态线让每行变高，那是
 * 密度问题不是正确性问题 —— 上限关于一次扫描能装下多少，这一点没变。
 */
const PAGE_SIZE = 5;

/** 路径的最后一段，正是人们称呼项目的方式。 */
export function directoryName(workDirAbsPath: string): string {
	const parts = workDirAbsPath.split(/[/\\]/).filter((part) => part.length > 0);
	return parts.at(-1) ?? workDirAbsPath;
}

/**
 * 列表行的紧凑时间。
 *
 * 刻意粗略：列表是被扫描的，不是被读的，"3天"就是扫一眼能区分条目的东西。更精确的在行的
 * tooltip 里。
 *
 * 从 `modified` 读而不是 `createdAt`。按对话最后活跃排序、却用创建时间标注，行会排在第二位却
 * 读着"3天前" —— 关于同一会话的两个事实在光天化日下打架。
 *
 * 最老的分支按时间戳缓存。超过一周后标签是月和日 —— 只关于时间戳本身的事实，里面没有"现在"
 * —— 但产出它要花 `Intl`，而这里按行、按帧跑；一段长列表曾让这成为侧栏在 tooltip 自己的
 * `toLocaleString` 被拿走之后剩余的逐帧成本。缓存只按旧行各留一条，别无其他。
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

/** 行的创建时间，供 tooltip。永远只是日期：行本身携带精确的时间。 */
function formatDate(timestamp: number): string {
	return new Date(timestamp).toLocaleString("zh-CN", {
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}