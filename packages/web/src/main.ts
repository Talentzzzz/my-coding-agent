import {
	applyAppearance,
	initialState,
	reduce,
	reduceEnd,
	findWay,
	type ViewState,
} from "./state.ts";
import { SessionApi, ApiError } from "./api.ts";
import { browserSocket, MuxClient, muxUrl, type ChannelState } from "./client.ts";
import { OncePerFrame } from "./frame.ts";
import { SessionRows } from "./rows.ts";
import { Composer, type ComposerSelection } from "./composer.ts";
import { TranscriptView } from "./render/transcript.ts";
import { BranchView, shortId } from "./render/branch-view.ts";
import { Sidebar, pagingOf, directoryName } from "./render/sidebar.ts";
import { SettingsPanel, modeSummaryOf } from "./render/settings.ts";
import { openMenu, openMenuAt, type MenuItem } from "./render/menu.ts";
import { StatusBar } from "./render/statusbar.ts";
import { element, icon } from "./dom.ts";
import { DEFAULT_THINKING_LEVEL, seedDefaultModel } from "./default-model.ts";
import {
	applyUiPatch,
	DEFAULT_APPEARANCE,
	loadUiSettings,
	sameDirectory,
	saveUiSettings,
	type AppearanceSettings,
	type DirectoryPaging,
	type UiSettings,
	type UiSettingsPatch,
} from "./ui-settings.ts";
import type {
	ConnectionItem,
	DirectoryGroup,
	ModelOption,
	ServerMessage,
	SessionSnapshot,
	SessionRow,
} from "@my-agent/case/protocol";

/**
 * 桌面外壳给页面增加的东西：操作系统自己的文件夹选择器，与 UI 设置的持久化桥。
 *
 * 应用本身不浏览文件系统 —— "添加目录"把浏览交给系统对话框 —— 所以没有外壳的浏览器没有选择器，
 * 菜单如实说明。UI 设置的桥同理：外壳每次启动都换端口，`localStorage` 按 origin 隔离留不住
 * 偏好（ADR-0029），外壳把这份设置写进它自己的 userData 文件；两个成员都可选，浏览器里窗口
 * 回落 localStorage。
 */
declare global {
	interface Window {
		desktop?: {
			pickFolder?: () => Promise<string | undefined>;
			readUiSettings?: () => Promise<unknown>;
			writeUiSettings?: (value: unknown) => Promise<void>;
		};
	}
}

/**
 * 内置默认模式的名字，在这里复述而不是导入：它的家（`@my-agent/domain` 的 `types.ts`）跑在 Node 上，
 * 客户端绝不能把它拉进 bundle —— 设置面板出于同样的理由应用同一条复述规则。
 */
const DEFAULT_MODE_NAME = "默认";

/**
 * 客户端草稿会话：新建了但还没说第一句话的会话。
 *
 * 一个只存在于本窗口内存里的意图 —— id 是本地造的，服务端对它一无所知。目录可以缺席：顶部
 * 「新建会话」产出的草稿没有目录，输入框禁用、侧栏没有它的组，直到目录芯片选定 —— 选定即写入，
 * 草稿行随之归组；侧栏每组标题的「新建会话」与「添加目录」仍带目录出生，直接可用。攒下的会话级
 * 选择（模式）也住在这里：它们随第一条消息一起在出生请求里落地，模型与档位同样随出生 body 出发。
 *
 * 草稿的一生以出生请求结束：发第一条消息让服务端把会话与消息原子生出，本地行由真实行取代。刷新
 * 页面丢掉一切 —— 「只在客户端存在」的含义正包括它不比窗口活得久。
 */
interface DraftSession {
	id: string;
	/** 会话将落地的目录；undefined 表示还没选 —— 输入框在选定之前禁用。 */
	workDirAbsPath?: string;
	/** 草稿上选的模式指针；缺省就是内置「默认」，与快照的 `mode` 字段同一语义。 */
	mode?: string | null;
	/** 草稿创建的本地时刻，供侧栏行的时间字段。 */
	createdAt: number;
}

/** 一次失败的请求该说什么。状态码是它的一部分：404 和 409 意味着不同的事。 */
function describe(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	return error instanceof Error ? error.message : String(error);
}

/**
 * 这个帧是否是某次 send 正在等待的运行的最后一句话。
 *
 * 两个成员携带这个事实，且各自把它藏在不同的地方，这就是为什么这是一个 helper 而不是调用点上的
 * 两个条件：运行的最后一句话是二者中恰好到达的那个上的 `running: false`，而 send 引用的释放
 * 绝不能取决于到达的是哪一个。
 *
 * 其余成员一律 `false`，因为它们大多对运行什么都没说 —— 而"什么都没说"绝不能读成"已结算"，
 * 否则运行还在进行时引用就被丢了。
 *
 * `running: true` 也不是答案，但它是*问题*：它标记这个会话是本窗口看过其运行开始的，只有被
 * 这样标记的会话才能被报告为结束。这个标记就是答案不能直接从帧上读出的原因 —— 见 `main` 里的
 * `runSeen`，集合住在那里，理由也在那里。
 */
function runEnded(runSeen: Set<string>, sessionId: string, message: ServerMessage): boolean {
	const running =
		message.type === "status" ? message.running : message.type === "baseline" ? message.session.running : undefined;
	if (running === undefined) return false;
	if (running) {
		runSeen.add(sessionId);
		return false;
	}
	// `delete` 回答"这个会话被标记过没有"，这恰恰是问题：从未被看到运行过的会话什么都没结束过，
	// 在它上面丢引用会让一次 send 在其运行开始之前就结束。
	return runSeen.delete(sessionId);
}

function main(): void {
	const root = document.querySelector<HTMLElement>("#app");
	if (!root) throw new Error("#app is missing from index.html");

	let viewState: ViewState = initialState();
	/** 本窗口正在流式观看的会话。命令显式指名它，所以永远不靠推断。 */
	let followed: string | undefined;
	/**
	 * 已被看到运行的那些会话。
	 *
		 * send 的引用活得与它开启的那轮运行一样长，这个集合就是让那轮运行的结束可被识别的东西。
		 * `retain` 现在每次调用都要求（ADR-0010），所以取 send 引用会重新基线化会话 —— 而那个基线在
		 * 提示被接受*之前*取得，于是它对一个运行尚未开始的会话说 `running: false`。把它读成运行的
		 * 结束，就会在引用刚取到的一瞬间丢掉它，随后点了另一行的读者会取消那条本该承载运行自身失败
		 * 报告的流。第一个 `running: true` 让后来的 `false` 成为答案；通道断开期间结束的运行仍然
		 * 能拿到一个，因为标记比连接长寿。
	 */
	const runSeen = new Set<string>();
	/**
	 * 模型席位自己的选择，在任何消息携带它之前。
	 *
	 * 两半在 send 把它们交给服务端之前都是窗口的，这就是它们住在这里而不是直接从快照读的原因：
	 * 没有随任何请求发出的选择不是会话所处的状态，服务端上没有任何东西会报告它。快照一同意，
	 * 字段就被丢掉，这就是席位从覆盖变回跟随会话的方式。
	 */
	let chosen: { model?: string; thinkingLevel?: string } = {};
	/** 本服务端运行其上的目录；新会话不再回落到它（ADR-0021），仅作记录保留。 */
	let absCurrentDirectory = "";
	/**
	 * 目录选择器自己的选择，由窗口持有，服务端从不持有。
	 *
	 * 三个控件读它，别无其他：显示它的 composer chip、向它新建的按钮、指名它的侧栏阴影标题。
	 * 空表示"没有显式选择"，答案是活跃会话的目录 —— 于是那个标题永远不会与屏幕上的对话矛盾 ——
	 * 没有会话时答案就是「未选择」，不再回落到服务端的根。打开会话会清除它，这让选择保持为
	 * "下一次"的答案，而不是一个悄悄超越其被做出那一刻的状态。它不跨重启存活、不落入任何文件，
	 * 这是决定：一个在被需要时重新选择的一次性偏好，不值得一个存储。
	 */
	let absPickedDirectory = "";
	/**
	 * 本窗口的全部草稿与屏幕上打开的那个。
	 *
	 * `draftRowMap` 是侧栏画草稿行的来源（连接层的 `SessionRows` 只知道服务端上报的行，草稿是
	 * 窗口自己的事实，不进那张表）；`draft` 是当前打开的，与 `followed` 互斥 —— 一个指向真实会话
	 * 的流，一个指向还不存在的会话。
	 */
	const draftRowMap = new Map<string, DraftSession>();
	let draft: DraftSession | undefined;
	let collapsed = false;
	/**
	 * 本窗口的 UI 设置：外观、侧栏按目录的翻页、目录改名与隐藏目录（ADR-0029）。
	 *
	 * 它住在客户端自己的存储——外壳桥或 localStorage——服务端对它一无所知。启动时从存储播种，
	 * 每次变更经 {@link saveUi} 合并进去并写回；`viewState.settings`（服务端的设置快照）从今以后
	 * 只回答模型、工具、模式与审批。
	 */
	let uiSettings: UiSettings = { appearance: { ...DEFAULT_APPEARANCE } };
	/**
	 * 侧栏按目录的分页状态，以目录路径为键。
	 *
	 * UI 设置播种时从它带出，每次点击写回 —— 状态是 `uiSettings.appearance.directories` 的本地
	 * 镜像，先动本地映射再重画，不必等一次写回落地。用户从未碰过的目录不保留条目，所以在一次
	 * 折叠或翻页发生之前映射一直为空。
	 */
	let paging: Record<string, DirectoryPaging> = {};
	/**
	 * 常驻通道是否可用。
	 *
	 * 是局部变量而不是 `ViewState` 的字段，因为它是关于连接的事实而不是关于任何会话的 —— 与侧栏
	 * 行被挡在状态之外是同一个理由。reducer 永远看不到它，基线无法覆盖它，而窗口能否发送仍然只
	 * 取决于 `viewState.reachable`。
	 */
	let channel: ChannelState = "connecting";
	/**
	 * 通道第一次报告自己 live 时 resolve，之后再也不变。
	 *
	 * 页面加载是唯一没有东西可先点的导航，所以它是唯一必须等连接的地方：现在一个会话由 `open` 帧
	 * 打开（ADR-0010），而在尚未证明自己的通道上没有帧可发。之后的每次导航都是一次手势，而手势
	 * 在未就绪的通道上会得到一个带理由的拒绝，而不是被停在这个 promise 后面 —— 这就是它只 resolve
	 * 一次、永不替换的原因。
	 */
	let channelProved: () => void = () => {};
	const channelLive = new Promise<void>((resolve) => {
		channelProved = resolve;
	});
	/** 侧栏的行：通道可用时由它写，不可用时由 REST 写。 */
	const sessionRows = new SessionRows();

	/**
	 * 窗口当前在一个会话的哪次导航上，每次点击递增。
	 *
	 * 打开会话现在每次点击一个 `open` 帧，旧的双来源竞态连同曾是另一半的 REST 读取一起消失了
	 * （ADR-0010）—— 但竞态的形状不变：两次点击、两条基线、一个窗格。计数仍然是决定保留哪个答案
	 * 的东西：不再是最新的一条基线被整体丢弃，因为绘制它会把用户已经离开的对话画上屏幕。流本身
	 * 没有被取消；取代它的那次点击已经放开了那个引用。
	 */
	let openSeries = 0;
	/**
	 * 仍在等待基线的导航，按各自的 series，让加载提示随最后一个一起离开。
	 *
	 * 是集合而不是计数，差别可见：被取代的导航在取代它的那个开始*之后*才落定，而计数器会让那次
	 * 迟到的落定毫无贡献却把还在等待的窗格的提示摘掉。移除一个不在集合里的导航应该是无操作 ——
	 * 最新的一句永远能代表它所在的集合。
	 */
	const openWaits = new Set<number>();
	/**
	 * 窗口最后一次要求打开的会话。
	 *
	 * 有自己的 id 而不是读 {@link followed}，因为它存在的那种情形是一次从未落地的导航：
	 * `followed` 仍然指名屏幕上的对话，而那次没能打开别的东西的点击仍然握着一个窗格引用。下一次
	 * 导航才是放开那个引用的时机（见 `openSession`）—— 这是唯一记得它是什么的变量，至多一个，
	 * 因为每次新手势都会咨询它。
	 */
	let opening: string | undefined;

	/** 为一次导航挂上加载提示，或在没有东西正被打开时摘下它。 */
	function showLoading(series: number, on: boolean): void {
		if (on) openWaits.add(series);
		else openWaits.delete(series);
		sessionLoading.hidden = openWaits.size === 0;
	}

	/**
	 * 每块 chrome 上一次绘制所依据的东西。
	 *
	 * transcript 每个 token 都重渲染，而它周围的一切过去也跟着重画 —— 侧栏走它的行，状态行重写
	 * 它的数字，横幅区重建它的卡片 —— 全部逐帧进行，全部针对的是帧没有碰过的输入。下面的每个门
	 * 与上次绘制比较：一次廉价的引用或字符串比较，跳过输入没有动的遍历。改变了其中之一的帧仍然
	 * 会绘制它，而首次绘制会发生，因为每个门的初始值都是未设。
	 */
	let sidebarDrawn: string | undefined;
	let usageDrawn: ViewState["usage"] | undefined;
	let headingDrawn: string | undefined;
	let headingTipDrawn: string | undefined;
	let subtitleDrawn: string | undefined;
	/** chip 的标签上一次绘制所依据的目录，没变的就不重写。 */
	let chipDrawn: string | undefined;
	/** 分支条目上一次绘制所依据的签名；基线才是能移动它的东西。 */
	let branchChipDrawn: string | undefined;
	/** 接管席位上一次绘制所依据的审批；新数组意味着有东西要回答。 */
	let approvalsDrawn: ViewState["approvals"] | undefined;
	let noticesDrawn: ViewState["models"] | undefined;

	// ---------------------------------------------------------------- 窗口带

	/**
	 * 顶部带：一条页面不在其中布局任何东西的窗口级条。
	 *
	 * 外壳的标题按钮覆盖在它的右端，而这就是它的全部内容 —— 这正是让它们无害的原因。下面的每个
	 * 控件都从第 2 行开始，所以用户能按的东西永远不会位于按钮之下。填充与拖动区域是样式表的
	 * （`.titleband`）；在外壳标题之外该行收缩为 0px，这个元素就什么都不是。
	 */
	const titleband = element("div", "titleband");

	// ---------------------------------------------------------------- 列

	const conversation = element("section", "conversation");

	/**
	 * 固定头部：第一行左侧是会话标题、右侧是分支条目，且 —— 仅在分支页 —— 有工具行。它横跨
	 * 整个对话列，从不跟随阅读列内收，所以调整文字宽度从不移动它。
	 */
	const header = element("header", "header");
	const headerRow = element("div", "header-row");

	const title = element("div", "header-title");
	const heading = element("h1", undefined, "新会话");
	const subtitle = element("div", "header-subtitle", "");
	title.append(heading, subtitle);
	// 这里只住标题。跟随*会话*的控件 —— 模型及其思考档位 —— 在一行之下的 composer 上，因为
	// 它们随对话移动而不是随应用移动。跨会话存在的一切都是设置，设置住在侧栏那一个按钮后面的
	// 面板里。

	/**
	 * 分支条目，进入分支页的唯一门。
	 *
	 * 它指名正在读的那条路 —— `当前分支`、从那条路的条目裁出的短 id、以及它下面说的第一句话。
	 * 路少于两条时没有可指名的，所以 id 和句子空着，chip 只显示标记和文字：单路对话恰恰是最需要
	 * 这扇门的，而它打开的页面会给出使用说明。
	 */
	const branchChip = element("button", "branch-chip", undefined, { type: "button", title: "打开分支视图" });
	const branchChipId = element("span", "branch-chip-id");
	const branchChipLabel = element("span", "branch-chip-label");
	branchChip.append(icon("fork"), element("span", undefined, "当前分支"), branchChipId, branchChipLabel);
	branchChip.addEventListener("click", () => setPane("branch"));

	headerRow.append(title, branchChip);
	header.append(headerRow);

	/**
	 * 对话列显示哪一页。
 *
 * 两个，按工单的计数：对话，以及整体替换它的分支树 —— 不是覆盖层也不是侧面板。记录在 body 上，
 * 让一条 CSS 规则能同时撤下 composer、状态行和横幅，因为分支页没有它们中的任何一个。
 */
	let pane: "chat" | "branch" = "chat";
	function setPane(next: "chat" | "branch"): void {
		if (pane === next) return;
		pane = next;
		document.body.dataset.pane = next;
		if (next === "branch") branchView.enter();
		else branchView.leave();
	}

	/**
	 * 分支页，以及固定头部的第二行。
	 *
	 * 切换是原型定下的两拍：点击节点只是选中，工具行里的按钮才移动叶子并回到对话 —— 所以
	 * `onSwitch` 先翻页面再移动会话：人按的是"回去"，他们选中的答案跟着一起。视图已经解析了叶子
	 * 落地的条目：线上的卡片指名其问题产出的回答，于是对话回来时显示问题和它说的话，下一个提示在
	 * 回答之后派生新分支。
	 */
	const branchView = new BranchView({
		onSwitch: (entryId, landing) => {
			setPane("chat");
			void branch(entryId, landing === "tip");
		},
		onBack: () => setPane("chat"),
	});
	header.append(branchView.toolsBar);

	const transcriptHost = element("main", "transcript");
	const transcriptView = new TranscriptView(transcriptHost, {
		onUserContext: (entryId, x, y) => openUserMenu(entryId, x, y),
		onBranch: (entryId) => void branch(entryId, false),
	});
	transcriptView.trackScroll();

	/**
	 * 阅读列左缘的拖动把手。
	 *
	 * 一个把手，控制文字的最大宽度 —— 04 号的决定，本窗口从未带过。列是居中的，所以把手向右推
	 * 会两侧同时收窄文字：原型在用户说第一版方向反了之后定下的方向。它移动的宽度是
	 * `--dsw-content-width`，是计算出来的而不是查出来的，因为它的默认值是针对对话列自身宽度的
	 * 公式：列减去两侧各一个留白，上限是列减去最紧留白，下限和绝对上限是样式表声明的 token
	 * （`--dsw-content-min/cap`）。公式住在这里，引用那些 token —— 与侧栏把手的拆分相同，理由
	 * 相同。
	 *
	 * 持久化遵循侧栏把手的两条规则，与参考实现一致：保存的偏好是拖动产生的那一个，从未移动的按压
	 * 什么都不提交 —— 一次空点击绝不能用当前布局截断出的显示值覆盖更宽的偏好 —— 且存储的数字在
	 * 每次读取时按当前布局截断，让更小的窗口压低显示而不销毁选择。服务端把存储的偏好截到绝对范围
	 * （`@my-agent/domain` 的 `types.ts`）；布局相关的两端是窗口独有的，因为
	 * 只有它知道列的宽度。
	 */
	const contentResizer = element("div", "content-resizer", undefined, {
		role: "separator",
		"aria-orientation": "vertical",
		"aria-label": "调整正文宽度",
		tabindex: "0",
	});
	/** 方向键按步进转宽度；把手本身以一半的速率移动，指针 1px 对应文字 2px。 */
	const CONTENT_RESIZE_STEP = 16;
	/**
	 * 公式的常量，从样式表声明的同一批 token 读回。
	 *
	 * 不从 config 模块导入 —— 它跑在 Node 上，客户端绝不能把它拉进 bundle —— 所以 token 被读回，
	 * 这里的字面量只是样式表加载失败时的兜底。
	 */
	function contentTokens(): { min: number; cap: number; gutter: number; gutterTight: number } {
		const styles = getComputedStyle(document.documentElement);
		const read = (name: string, fallback: number): number => {
			const value = Number.parseFloat(styles.getPropertyValue(name));
			return Number.isFinite(value) ? value : fallback;
		};
		return {
			min: read("--dsw-content-min", 600),
			cap: read("--dsw-content-cap", 1280),
			gutter: read("--dsw-content-gutter", 35),
			gutterTight: read("--dsw-content-gutter-tight", 20),
		};
	}
	/**
	 * 一个偏好在本布局下对应的绘制宽度。
	 *
	 * `undefined` 表示用户从未拖过：默认是列减去两侧静止时的留白，为它制造一个存储值会把"从未
	 * 选择"变成"选了默认" —— 与侧栏宽度同一条规则。无论如何结果都被截断：下限是绝对的，上限是
	 * cap 与列减最紧留白中更紧的那个，而装不下下限的窄列让上限获胜，因为窄窗口上文字必须填满
	 * 剩余空间，而不是留下下限要求的空隙。
	 */
	function contentWidthFor(preference: number | undefined): number {
		const { min, cap, gutter, gutterTight } = contentTokens();
		const column = conversation.clientWidth;
		const max = Math.min(cap, column - gutterTight * 2);
		const wanted = preference ?? column - gutter * 2;
		return Math.min(max, Math.max(min, Math.round(wanted)));
	}
	/** 上一次写入变量的宽度，所以算出同一个数的重算被跳过。 */
	let contentApplied: number | undefined;
	function applyContentWidth(preference: number | undefined): void {
		const width = contentWidthFor(preference);
		if (width === contentApplied) return;
		contentApplied = width;
		document.documentElement.style.setProperty("--dsw-content-width", `${width}px`);
	}
	/** 此刻屏幕上的宽度：上次写入的，或者将要写入的。 */
	function contentWidthNow(): number {
		return contentApplied ?? contentWidthFor(contentPref);
	}
	/**
	 * 设置持有的偏好，用户从未拖过时为 undefined。
	 *
	 * 设置快照到达时写入，下面的观察者在每次布局变化时读取，拖动本身只把它当起点。
	 */
	let contentPref: number | undefined;
	// 默认值是针对列宽的公式，所以任何改变那个宽度的东西 —— 窗口的、或侧栏的 —— 都会重新问这个
	// 问题。观察者是唯一调度这次重算的地方：列 resize 就是 resize，无论哪个把手造成。
	new ResizeObserver(() => applyContentWidth(contentPref)).observe(conversation);
	let contentDrag: { x: number; width: number } | undefined;
	contentResizer.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		contentDrag = { x: event.clientX, width: contentWidthNow() };
		contentResizer.setPointerCapture(event.pointerId);
		contentResizer.classList.add("dragging");
	});
	contentResizer.addEventListener("pointermove", (event) => {
		if (contentDrag === undefined) return;
		// 列是居中的，所以把手一像素移动文字两像素 —— 原型定下的系数，也让拖动时把手保持在指针
		// 之下。
		applyContentWidth(contentDrag.width - (event.clientX - contentDrag.x) * 2);
	});
	const endContentDrag = (): void => {
		contentDrag = undefined;
		contentResizer.classList.remove("dragging");
	};
	contentResizer.addEventListener("pointerup", (event) => {
		// 以拖动开始处为基准测量，所以从未移动的点击什么都不保存 —— 与侧栏把手放在空按压与存储
		// 偏好之间的同一道防线。
		const moved = contentDrag !== undefined && event.clientX !== contentDrag.x;
		endContentDrag();
		if (moved) {
			contentPref = contentWidthNow();
			saveUi({ appearance: { contentWidth: contentPref } });
		}
	});
	contentResizer.addEventListener("pointercancel", () => endContentDrag());
	contentResizer.addEventListener("keydown", (event) => {
		// 右收窄，左放宽 —— 与拖动相同的方向。
		const step = event.key === "ArrowRight" ? -CONTENT_RESIZE_STEP : event.key === "ArrowLeft" ? CONTENT_RESIZE_STEP : 0;
		if (step === 0) return;
		event.preventDefault();
		// 存储的是绘制截断到的值，与拖动提交的同一件事：对本布局已经执行的截断按键，绝不能存进一个
		// 只有窗口变大后才生效的更宽偏好。
		applyContentWidth(contentWidthNow() + step);
		contentPref = contentApplied;
		saveUi({ appearance: { contentWidth: contentPref } });
	});

	/**
	 * transcript 的包裹层：会伸展的 grid 行，也是把手的定位上下文。
	 *
	 * 两者刻意相隔一层 —— 绝对定位的把手若放在滚动容器内部，会随内容一起滚走，而把手属于文字被
	 * 阅读所经的布局，不属于其中的任何东西。
	 */
	const transcriptBody = element("div", "transcript-body");
	/**
	 * 会话正在被打开的提示，是窗口对"我的点击做了什么"的唯一回答。
	 *
	 * 打开会话是一次 `open` 加一条基线，在基线落地之前上一份 transcript 仍在屏幕上 —— 这是窗格
	 * 替换而不是清空的刻意行为，但在服务端尚未应答时它与"点击被忽略"无法区分。所以等待有了一张
	 * 脸：导航开始的一瞬它盖在窗格上，快照的第一片画完时离开。
	 *
	 * 它坐在包裹层而不是 transcript 里，因为 transcript 会滚动：滚动容器里的提示会随它正在替换的
	 * 对话一起滚走。与阅读列把手相同的一层之隔。
	 */
	const sessionLoading = element("div", "session-loading", undefined, { role: "status", "aria-live": "polite" });
	const loadingRing = element("div", "loading-ring");
	const loadingLabel = element("div", "loading-label", "正在载入会话…");
	sessionLoading.append(loadingRing, loadingLabel);
	sessionLoading.hidden = true;
	transcriptBody.append(transcriptHost, contentResizer, sessionLoading);

	const banners = element("div", "banners");

	const composerWrap = element("div", "composer-wrap");
	const errorBar = element("div", "error-bar");
	errorBar.hidden = true;
	/**
	 * 审批卡片的席位，也就是 composer 自己的席位。
	 *
	 * 一个待审批会替换输入框而不是悬在它上方：这个问题是窗口在它站着期间唯一能行动的东西，而
	 * 占据席位的卡片是参考实现给出的形状 —— 警告边框、命令、两个答案 —— 挂在仍在接收输入的输入
	 * 框上方的横幅，读起来像给一个根本没在听的东西贴的装饰。
	 */
	const approvalSeat = element("div", "approval-seat");
	approvalSeat.hidden = true;
	/** composer 头部：输入卡片上方那行的目录 chip，最左。 */
	const composerHead = element("div", "composer-head");
	const composer = new Composer({
		onSubmit: (text, behavior) => void prompt(text, behavior),
		onAbort: () => void abort(),
		onSelectModel: (name) => {
			// 只移动模型。档位是 composer 的，每个模型用同样的四档，用户选好的力度不该被切换应答
			// 端点悄悄重置。
			chosen = { ...chosen, model: name };
			render();
		},
		onSelectLevel: (level) => {
			chosen = { ...chosen, thinkingLevel: level };
			render();
		},
		// 模式菜单的行在这里构建，因为预设和会话的 live 状态都在这里：内置默认在前，然后是存储的
		// 模式，然后是进入编辑的唯一入口。它向上打开：模式席位在窗口底边的输入条上，挂在下面的菜单
		// 将无处安放。
		onModes: (anchor) => {
			const settings = viewState.settings;
			// 名字清单是启动时取一次的本构建事实（ADR-0020），不随会话走；缺席只在拉取应答前的一瞬。
			const allTools = viewState.toolNames ?? [];
			const defaultTools = settings?.tools === undefined ? allTools : settings.tools.filter((name) => allTools.includes(name));
			const current = currentModeName();
			openMenu(
				anchor,
				[
					{
						label: DEFAULT_MODE_NAME,
						detail: modeSummaryOf(defaultTools, settings?.approval ?? {}),
						active: current === DEFAULT_MODE_NAME,
						onSelect: () => applyMode(DEFAULT_MODE_NAME),
					},
					...(settings?.modes ?? []).map((mode) => ({
						label: mode.name,
						detail: modeSummaryOf(mode.tools, mode.approval),
						active: current === mode.name,
						onSelect: () => applyMode(mode.name),
					})),
					{ kind: "separator" as const },
					{ label: "去设置 › 模式", onSelect: () => openSettings("modes") },
				],
				{ placement: "above" },
			);
		},
		onSelectMode: (name) => applyMode(name),
	});
	composerWrap.append(errorBar, approvalSeat, composerHead, composer.element);

	/**
	 * 目录 chip，以及它打开的菜单。
	 *
	 * chip 是选择器的脸：它显示*下一个*新会话将落在哪里，住在输入卡片上方那行的最左 —— composer
	 * 是一段会话开始的地方，所以"下一个从哪开始"就属于这里（01 ⑦）。这个选择从不改写屏幕上的
	 * 会话，chip 的位置由它覆盖的输入决定而不是由 transcript 说什么决定，所以它不需要随阶段来去。
	 * 它的菜单列出本机已经认识的目录，加上一个不认识的目录的唯一入口；列表来自侧栏自己的行，所以
	 * 靠拥有会话赢得席位的目录，与这里的是同一份。
	 */
	const directoryChip = element("button", "directory-chip", undefined, { type: "button", "aria-haspopup": "menu" });
	const chipLabel = element("span", "directory-chip-label");
	directoryChip.append(icon("folder"), chipLabel, icon("chevron"));
	directoryChip.addEventListener("click", () => {
		const groups = visibleGroups();
		// 还什么都不知道：一个只有"添加目录"一行的单行菜单，是在假装存在过选择，所以点击直接去
		// 选择器，与参考实现一致。
		if (groups.length === 0) {
			void addDirectory();
			return;
		}
		const absChosenDir = directoryForNewSession();
		// 与输入条的三个席位一样向上打开：chip 也贴着窗口底部，落到下面的菜单会砸在它覆盖的输入
		// 卡片上。
		openMenu(
			directoryChip,
			[
				...groups.map((group) => ({
					icon: "folder" as const,
					label: uiSettings.directoryNames?.[group.workDirAbsPath] ?? directoryName(group.workDirAbsPath),
					title: group.workDirAbsPath,
					active: group.workDirAbsPath === absChosenDir,
					onSelect: () => {
						absPickedDirectory = group.workDirAbsPath;
						// 打开的草稿随选择落地：写入即归组，输入框随之解禁 —— 这是无目录草稿唯一的
						// 解禁之路。
						if (followed === undefined && draft !== undefined) draft.workDirAbsPath = group.workDirAbsPath;
						render();
					},
				})),
				{ kind: "separator" as const },
				{
					label: "添加目录…",
					onSelect: () => void addDirectory(),
				},
			],
			{ placement: "above" },
		);
	});
	composerHead.append(directoryChip);

	const statusBar = new StatusBar();

	// 分支页坐在 transcript 坐的地方：同一行会伸展的 grid，两者轮流占。隐藏是 CSS 的工作
	// （`body[data-pane]`），于是两个页面交换位置时周围的所有 chrome 都不重排。
	conversation.append(header, transcriptBody, branchView.element, banners, composerWrap, statusBar.element);

	// ------------------------------------------------------------------ 侧栏

	const sidebar = new Sidebar({
		// 标题自己的「新建会话」指名它被按下的目录；顶行的按钮什么都不指名、跟随选择器。选择在
		// create 发出*之前*就折进 `absPickedDirectory`，因为 `openSession` 会清除它 —— 会话一旦
		// 存在，选择器就完成了使命。
		onNewSession: (workDirAbsPath) => {
			if (workDirAbsPath !== undefined) absPickedDirectory = workDirAbsPath;
			void newSession(workDirAbsPath);
		},
		onSelectSession: (sessionId) => void (draftRowMap.has(sessionId) ? openDraft(sessionId) : openSession(sessionId)),
		onToggleCollapsed: () => {
			collapsed = !collapsed;
			render();
		},
		onOpenSettings: () => openSettings(),
		onAddDirectory: () => void addDirectory(),
		// 行菜单的派生复制整个会话 —— 它作用于会话而不是消息，所以这是 `entryId: null` 的 fork，
		// 不是任何消息过去提供的那种。
		onForkSession: (sessionId) => void forkSession(sessionId),
		onDeleteSession: (sessionId) => void deleteSession(sessionId),
		onRenameSession: (sessionId, title) => void renameSession(sessionId, title),
		onToggleDirectory: (workDirAbsPath) => {
			const entry = pagingOf(paging, workDirAbsPath);
			// 展开落在目录被折叠时读到的那一页；折叠保存它当时所在的页。两个翻页按钮也写保存页 ——
			// 阅读发生在那里 —— 所以保存的页永远是屏幕上的页。
			setPaging(
				workDirAbsPath,
				entry.collapsed
					? { collapsed: false, page: entry.savedPage, savedPage: entry.savedPage }
					: { collapsed: true, page: entry.page, savedPage: entry.page },
			);
		},
		onPageDirectory: (workDirAbsPath) => {
			const entry = pagingOf(paging, workDirAbsPath);
			setPaging(workDirAbsPath, { collapsed: false, page: entry.page + 1, savedPage: entry.page + 1 });
		},
		onCollapseDirectory: (workDirAbsPath) => {
			// 退回上一次「展开其余」添加的那一页 —— 不是重置到第一页，保存页也跟着退：收回展开就是
			// 收回阅读，所以再次展开标题折叠时落在用户实际读到的页。
			const entry = pagingOf(paging, workDirAbsPath);
			const page = Math.max(1, entry.page - 1);
			setPaging(workDirAbsPath, { collapsed: false, page, savedPage: page });
		},
		onRenameDirectory: (workDirAbsPath, name) => void renameDirectory(workDirAbsPath, name),
		onDeleteDirectory: (workDirAbsPath) => void deleteDirectory(workDirAbsPath),
	});

	/**
	 * 折入一个目录的分页状态，重画，并经本窗口的 UI 设置持久化。
	 *
	 * 本地映射先动，重画就不必等一次写回；映射随后随整个设置写回客户端自己的存储（ADR-0029）。
	 * {@link saveUi} 是那条路，屏幕是用户做的、文件是幸存的拆分在这里同样成立。
	 */
	function setPaging(workDirAbsPath: string, next: DirectoryPaging): void {
		paging = { ...paging, [workDirAbsPath]: next };
		uiSettings = applyUiPatch(uiSettings, { appearance: { directories: paging } });
		renderSidebar();
		void saveUiSettings(uiSettings).catch(report);
	}

	/**
	 * 侧栏右缘的拖动把手。
	 *
	 * 一个分隔符，不是按钮：指针抓住侧栏的边缘拖动 —— 向右变宽，原型定下的方向 —— 键盘经方向键
	 * 到达同一个截断，这正是这个元素可聚焦的原因。它移动的宽度是 `--dsw-sidebar-width`，grid 第一
	 * 列所依据的唯一变量。
	 *
	 * 持久化遵循阅读把手的两条规则：保存的偏好是拖动产生的那一个，截到服务端也执行的范围；从未
	 * 移动的按压什么都不提交 —— 一次空点击绝不能用当前布局截出的值覆盖存储的宽度。
	 */
	const sidebarResizer = element("div", "side-resizer", undefined, {
		role: "separator",
		"aria-orientation": "vertical",
		"aria-label": "调整侧栏宽度",
		tabindex: "0",
	});
	/** 方向键按步进转宽度，比拖动精细，需要一个命名的数字。 */
	const SIDEBAR_RESIZE_STEP = 8;
	/**
	 * 拖动范围，从样式表声明的同一批 token 读回（`--dsw-sidebar-min/max`）。
	 *
	 * 这些数字的家在 `tokens.css`，由 `@my-agent/domain` 的 `types.ts` 镜像，
	 * 服务端在那里截断存储的偏好。它们不被导入客户端 —— config 模块跑在 Node 上，客户端绝不能
	 * 把它拉进 bundle —— 所以 token 被读回，这里的字面量只是样式表加载失败时的兜底。
	 */
	function sidebarRange(): { min: number; max: number } {
		const styles = getComputedStyle(document.documentElement);
		const read = (name: string, fallback: number): number => {
			const value = Number.parseFloat(styles.getPropertyValue(name));
			return Number.isFinite(value) ? value : fallback;
		};
		return { min: read("--dsw-sidebar-min", 208), max: read("--dsw-sidebar-max", 360) };
	}
	/** 变量当前携带的宽度，任何东西设置它之前是 token 的默认值。 */
	function sidebarWidthNow(): number {
		const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dsw-sidebar-width"));
		return Number.isFinite(value) ? value : 232;
	}
	function setSidebarWidth(width: number): void {
		const { min, max } = sidebarRange();
		document.documentElement.style.setProperty("--dsw-sidebar-width", `${Math.min(max, Math.max(min, Math.round(width)))}px`);
	}
	let sidebarDrag: { x: number; width: number } | undefined;
	sidebarResizer.addEventListener("pointerdown", (event) => {
		if (collapsed) return;
		event.preventDefault();
		sidebarDrag = { x: event.clientX, width: sidebarWidthNow() };
		sidebarResizer.setPointerCapture(event.pointerId);
		sidebarResizer.classList.add("dragging");
	});
	sidebarResizer.addEventListener("pointermove", (event) => {
		if (sidebarDrag === undefined) return;
		setSidebarWidth(sidebarDrag.width + event.clientX - sidebarDrag.x);
	});
	const endSidebarDrag = (): void => {
		sidebarDrag = undefined;
		sidebarResizer.classList.remove("dragging");
	};
	sidebarResizer.addEventListener("pointerup", (event) => {
		// 在这里结束的拖动以开始处为基准测量，所以从未移动的点击什么都不保存：存储的偏好保持用户
		// 选定的值，而不是当前布局的截断会悄悄压上去的那个。
		const moved = sidebarDrag !== undefined && event.clientX !== sidebarDrag.x;
		endSidebarDrag();
		if (moved) saveUi({ appearance: { sidebarWidth: sidebarWidthNow() } });
	});
	sidebarResizer.addEventListener("pointercancel", () => endSidebarDrag());
	sidebarResizer.addEventListener("keydown", (event) => {
		const step = event.key === "ArrowLeft" ? -SIDEBAR_RESIZE_STEP : event.key === "ArrowRight" ? SIDEBAR_RESIZE_STEP : 0;
		if (step === 0 || collapsed) return;
		event.preventDefault();
		setSidebarWidth(sidebarWidthNow() + step);
		saveUi({ appearance: { sidebarWidth: sidebarWidthNow() } });
	});

	// ----------------------------------------------------------------- 设置

	const settingsPanel = new SettingsPanel({
		onClose: () => settingsPanel.hide(),
		onTheme: (theme) => saveUi({ appearance: { theme } }),
		onFontSize: (fontSize) => saveUi({ appearance: { fontSize } }),
		onBashTimeouts: (bash) => void saveSettings({ bash }),
		// 全局默认审批表：从未选择过的会话以它开启。在这里写入就是写设置文件，而一个有自己的记录
		// 选择的会话会保留它们。
		onGlobalApproval: (tool, value) => saveSettings({ approval: { [tool]: value } }),
		onSaveModels: async (rows) => {
			const { models } = await sessionApi.updateModels(rows);
			apply({ ...viewState, models });
		},
		// 模式列表，整体 —— 端点是替换式的，所以这里改名、那里删除会一起落地。返回的快照重新播种
		// 每个模式读取者。
		onSaveModes: (modes) => saveSettings({ modes }),
		// *新*会话开启时的默认，所以它写设置文件。live 会话用的模型是 composer 的，绝不经过这里。
		onDefaultModel: (name) => void saveSettings({ model: name }),
		onGlobalTools: (names) => saveSettings({ tools: names }),
	});

	// 把手坐在两列之间 —— 它就是侧栏的右缘，这正是全部要点 —— 而 rail 的 CSS 把它藏起来，因为
	// 52px 的 rail 不是任何人会选择去拖的宽度。带排第一：作为 #app 的第一个 grid item，它占据
	// 窗口的顶行，也就是标题按钮覆盖的那一条，它按设计保持空 —— 页面拥有的每个可触摸的东西都从
	// 第 2 行开始，按钮因此盖不住任何东西。
	root.append(titleband, sidebar.element, sidebarResizer, conversation, settingsPanel.element);

	// ------------------------------------------------------------------- 接线

	const sessionApi = new SessionApi();

	/**
	 * 唯一的常驻通道，以及窗口对服务端存活状况的全部认知。
	 *
	 * 帧在这里只按 `streamId` 路由，这就是全部契约：`null` 指连接，其他一切都指一个会话。下面
	 * 任何东西都不再检查载荷形状，所以任一 union 的新成员都是协议的一次添加，而不是对每个读它的
	 * 客户端的修改。
	 */
	const muxClient = new MuxClient(
		{
			onChannel: (next) => {
				channel = next;
				// 页面加载的门：通道证明自己之前没有 `open` 可发，所以唯一没有点击在先的导航等在这里。
				if (next === "live") channelProved();
				// 通道恢复会带来新的行表，这里什么也不触发 fetch：从那一刻起通道自己的基线就是权威。
				//
				// 掉线是另一半。画出的行是本窗口最后被告知的东西，清空它们会在停止更新的那一刻藏起
				// 机器的状态 —— 所以行保留，改为请求一次 REST 列表。没有这个，侧栏会在故障持续的整段
				// 时间里冻结，而这正是行表要防止的行为。
				if (next === "down") void refreshLists().catch(report);
				render();
			},
			onConnectionItem: (item) => onConnectionItem(item),
			onStreamMessage: (sessionId, message) => {
				// send 的引用活得与它开启的那轮运行一样长，它的结束是流说 `running: false` ——
				// 不是请求被接受，也不是运行开始。`runEnded` 负责区分这三者，因为 `retain` 现在每次
				// 都要求基线（ADR-0010），而随提示取的那条基线描述的是运行*之前*的会话。在
				// end-restart 语义下（ADR-0006 §5），等待审批的运行*已经*结束 —— 运行在门处结束、
				// 答案经 REST 到达 —— 所以问题仍然站着时这里就释放引用；窗口留在对话上时窗格自己的
				// 引用继续观看，答案的恢复运行在它上面上报。
				//
				// 在下面的窗格检查**之前**检查，这个顺序是承重的。运行中途导航离开会释放窗格引用但
				// 不释放 send 的 —— 这正是引用存在的意义 —— 于是这个会话的帧在无人观看时继续到达，
				// 而运行的最后一个 `running: false` 恰恰是必须被读到的帧。先按窗格退出就会丢掉它，
				// 那条流会被持有到窗口生命结束，且每次重连都重开，为一次早已结束的运行。
				if (runEnded(runSeen, sessionId, message)) releaseSend(sessionId);

				// 属于本窗口已离开的会话的帧。不是错误，也不值得重画：窗格引用已被释放，服务端没有
				// 理由再发，如果发来了，也是释放到达之前的帧。
				if (followed !== sessionId) return;
				// 合并：一次运行的 delta 到达速度远快于显示刷新，逐个绘制是没有任何帧会展示的工作。
				// 折叠仍在这里逐事件进行；绘制只被请求一次，对着帧到达的最后一个状态运行。
				apply(reduce(viewState, message), { coalesce: true });
			},
			onStreamEnd: (sessionId) => {
				// send 的引用除了已结算的状态和被拒绝的运行，还有第三种出口：服务端结束流。在下面的
				// 窗格检查之前释放，与 `onStreamError` 在绘制任何东西之前释放的理由相同 —— 引用属于
				// 运行，不属于窗格，所以运行中途离开的窗口仍然持有它。无条件释放是安全的：这条连接
				// 不持有的 id 是无操作。
				releaseSend(sessionId);
				if (followed !== sessionId) return;
				apply(reduceEnd(viewState));
			},
			onStreamError: (sessionId, message) => {
				// 通知去本窗口的错误行，而不是去窗口碰巧在显示的那个对话：必须对它行动的人看的是
				// 窗口，不是会话 id。
				report(new Error(message));
				// 无法启动的运行在这里上报且永远不会自报结束，所以这是 send 引用的出口之一。没有它，
				// 一次失败的 send 会把它的流持有到窗口生命结束 —— 没人会注意到，因为那通常是窗格
				// 本来就想要的流。
				//
				// 仅对会话自己的流。空 id 是信封级失败，关于连接、不指名任何会话，这里没有东西可释放。
				if (sessionId !== "") releaseSend(sessionId);
			},
		},
		{ url: muxUrl(window.location), socket: browserSocket(muxUrl(window.location)), network: window },
	);

	/**
	 * 放开一个会话的 send 引用，以及让它的运行可被识别的那个标记。
	 *
	 * 两者是一个动作：标记的存在只为了回答一个仍然被持有的引用，留下它的释放会让*下一个* send 的
	 * 基线看起来像一次它从未看过的运行的结束 —— 立刻丢掉那个引用，正是标记要防的 bug。四个出口
	 * 到达这里，四个都意味着"我们的运行不在进行中"：运行自己的最后一句话、被拒绝的运行、结束的流，
	 * 以及服务端没有接受的提示。
	 */
	function releaseSend(sessionId: string): void {
		runSeen.delete(sessionId);
		muxClient.release(sessionId, "send");
	}

	/**
	 * 一个连接级载荷：行表、一行变更，或心跳。
	 *
	 * 心跳是唯一没有自己工作的 —— `MuxClient` 已经消费它来武装看门狗 —— 它在这里被当作让侧栏
	 * 相对时间保持诚实的节拍。骑在已有的帧上而不是开第二个定时器，意味着窗口里只有一只钟，且通道
	 * 停止时它也停止，这正是"多久之前"停止更新的正确时机。
	 */
	function onConnectionItem(item: ConnectionItem): void {
		if (item.type === "sessions") {
			sessionRows.replaceAll(item.sessions);
			renderSidebar();
			return;
		}
		if (item.type === "session_row") {
			sessionRows.put(item.session);
			renderSidebar();
			return;
		}
		if (item.type === "session_gone") {
			// 在行移除之前折叠，侧栏就能带着两个事实各画一次：窗格已在别处、行已消失。折叠本身是
			// 共享的那一个 —— 被别的窗口删除的会话，对本窗口的折叠与本地删除完全一样，因为无论谁说
			// 的，没了就是没了。
			foldFromDeleted(item.sessionId);
			sessionRows.remove(item.sessionId);
			renderSidebar();
			return;
		}
		sidebar.tick();
	}

	/** 只重画侧栏。行按自己的节奏变化，不按状态的。 */
	function renderSidebar(): void {
		// 这里的门就是这一列的逐帧故事：流式帧不改变侧栏读取的任何输入 —— 行表的版本、被跟随的
		// 会话、窗口自己的三个事实 —— 所以它在这里被跳过，而不是在里面走一遍再打补丁。逐 token
		// 渲染侧栏是性能剖析的 H7，一笔随目录数增长的固定逐帧税；行真的变化时会递增 `rows.version`。
		// 分页状态在签名里，因为它现在是侧栏的输入之一：折叠或翻页不改变行表的任何东西，没有它的
		// 签名意味着这次点击什么都不画。序列化是确定的 —— 条目以固定的字段顺序构建 —— 所以相同
		// 映射的字符串稳定。
		// 名字在签名里的理由与分页映射相同：改名不动行表的任何东西，忽略标签的签名意味着这次点击
		// 什么都不重画。
		const names = uiSettings.directoryNames;
		const drawn = `${sessionRows.version}|${followed ?? ""}|${draft?.id ?? ""}|${draft?.workDirAbsPath ?? ""}|${draftRowMap.size}|${absPickedDirectory}|${collapsed ? 1 : 0}|${channel}|${JSON.stringify(paging)}|${JSON.stringify(names ?? {})}`;
		if (drawn === sidebarDrawn) return;
		sidebarDrawn = drawn;
		const activeSessionId = followed ?? draft?.id;
		sidebar.render({
			directories: directoriesWithDrafts(),
			...(activeSessionId === undefined ? {} : { activeSessionId }),
			collapsed,
			paging,
			...(names === undefined ? {} : { directoryNames: names }),
			...(draftRowMap.size === 0 ? {} : { drafts: new Set(draftRowMap.keys()) }),
			channel,
		});
	}

	/**
	 * 行表里的可见分组：被用户藏起的目录不进侧栏。
	 *
	 * 过滤在这里而不是服务端——隐藏列表是本窗口的 UI 设置（ADR-0029），服务端不再知道它。
	 * 两个读取者（侧栏与目录芯片）共用这一份，让同一个决定只有一个答案。
	 */
	function visibleGroups(): DirectoryGroup[] {
		const groups = [...sessionRows.groups()];
		const hidden = uiSettings.hiddenDirectories ?? [];
		if (hidden.length === 0) return groups;
		return groups.filter((group) => !hidden.some((path) => sameDirectory(path, group.workDirAbsPath)));
	}

	/**
	 * 侧栏的分组：服务端的行，叠上草稿行。
	 *
	 * 草稿是窗口自己的事实，不进连接层的行表 —— 它插进自己目录的组（目录在草稿创建时就解析好了，
	 * 所以组一定指得出），目录还没有组时草稿为它开一个。组的排序沿用最新活动在前的规则，所以一个
	 * 刚写下的草稿排在本目录的最前、它的目录排到列表的最上。被藏起的目录不进列表（ADR-0029）。
	 */
	function directoriesWithDrafts(): DirectoryGroup[] {
		const groups = visibleGroups();
		for (const draftSession of draftRowMap.values()) {
			const row: SessionRow = {
				id: draftSession.id,
				workDirAbsPath: draftSession.workDirAbsPath ?? "",
				createdAt: draftSession.createdAt,
				title: "新会话",
				modified: draftSession.createdAt,
				running: false,
				pending: 0,
			};
			// 没有目录的草稿没有组可进：它落进一个空键的假组（「未选择目录」），目录芯片一选定就
			// 随新键归组。真实目录组永远以服务端的路径为键，空键只会由这里产生。
			const groupKey = draftSession.workDirAbsPath ?? "";
			const group = groups.find((candidate) => candidate.workDirAbsPath === groupKey);
			if (group === undefined) groups.push({ workDirAbsPath: groupKey, sessions: [row] });
			else group.sessions.push(row);
		}
		if (draftRowMap.size === 0) return groups;
		return groups.sort((a, b) => newestGroupActivity(b) - newestGroupActivity(a));
	}

	/** 一组里最新的活动，组的排序依据，与行表自己的规则一致。 */
	function newestGroupActivity(group: DirectoryGroup): number {
		return group.sessions.reduce((latest, row) => Math.max(latest, row.modified), 0);
	}

	/**
	 * 下一个新会话落在哪里，这是选择器为之存在的那个问题的唯一答案。
	 *
	 * 显式选择优先，然后是屏幕上会话的目录 —— 阴影标题的承诺所需的顺序，因为那个标题指名的就是
	 * 这个答案，绝不能与正在阅读的对话矛盾。根目录回落刻意删去（ADR-0021）：没有答案时答案是
	 * 「未选择」，由 chip 的标签、副标题与空态说出来，而不是悄悄把会话种在服务器根。
	 */
	function directoryForNewSession(): string | undefined {
		// 草稿打开时，chip 描写的是草稿自己的落点：无目录草稿没有答案。
		if (followed === undefined && draft !== undefined) return draft.workDirAbsPath;
		return absPickedDirectory || viewState.snapshot?.workDirAbsPath || undefined;
	}

	/**
	 * 操作系统文件夹选择器，是新目录进入列表的唯一道路。
	 *
	 * 应用从不自己浏览文件系统：系统对话框负责浏览，它回答的路径一瞬间成为选择器的选择和一个会话
	 * —— 目录靠拥有会话赢得列表里的位置，所以添加一个*就是*开启一个。
	 */
	async function addDirectory(): Promise<void> {
		if (window.desktop?.pickFolder === undefined) {
			report(new Error("选择文件夹需要桌面外壳；浏览器里可以直接用命令行把会话开在目标目录。"));
			return;
		}
		let absPath: string | undefined;
		try {
			absPath = await window.desktop.pickFolder();
		} catch (error) {
			report(error);
			return;
		}
		if (absPath === undefined) return;
		absPickedDirectory = absPath;
		await newSession(absPath);
	}

	/** 重画状态行，且只在有新的用量可画时。 */
	function renderStatusBar(): void {
		if (viewState.usage === usageDrawn) return;
		usageDrawn = viewState.usage;
		statusBar.render({ usage: viewState.usage });
	}

	/** 一次折叠如何到达屏幕：整体立即、有界分片、或至多每帧一次。 */
	interface ApplyOptions {
		/** 把整个快照按有界分片绘制 —— 那是切换会话的成本，不是 delta 的。 */
		deferred?: boolean;
		/** 把这次绘制落到下一个动画帧而不是本帧 —— 一条流 delta。 */
		coalesce?: boolean;
	}

	/**
	 * 屏幕上一次绘制所依据的状态。
	 *
	 * 下面的门把状态与这个比较，而不是与上一次折叠产出的状态比较：两次绘制之间可以落下多次折叠
	 * —— 这正是合并它们的意义 —— 而"这个变了吗"是关于屏幕上的东西的问题，不是关于上一个事件
	 * 的问题。
	 */
	let drawnState: ViewState = viewState;

	/**
	 * 合并后的 delta 绘制：多条流帧，一次绘制。
	 *
	 * provider 在两次显示刷新之间送来几十个 delta，逐个重画 transcript 是读者永远看不到的工作
	 * —— 中间状态没有在任何一帧里出现过。折叠本身仍逐事件运行（它是廉价的不可变更新），状态的
	 * 任何东西都没被跳过；只有绘制被留给那一帧，绘制的是运行到达的最后一个状态。
	 */
	const oncePerFrame = new OncePerFrame(() => {
		const previous = drawnState;
		drawnState = viewState;
		drawState(viewState, previous);
	});

	/**
	 * 折入一个新状态，并绘制它改变的部分。
	 *
	 * 各列独立重画，因为它们以极不同的速率变化：transcript 每个 token，侧栏每次行变更，状态栏
	 * 每个结算的回合。在这里检测变化，正是让流式回答不重渲染会话列表的东西。
	 *
	 * `reachable` 是唯一一个变更对 composer 有意义而不是对某一列有意义的字段，所以它被单独看：
	 * 窗口能否发送是关于服务端的事实，从 `streaming` 的变化里读它 —— 旧代码就是这么做的 ——
	 * 意味着两次发送之间的一次失败会让输入框保持可用而背后一无所有。
	 */
	function apply(next: ViewState, options: ApplyOptions = {}): void {
		viewState = next;
		if (options.coalesce === true) {
			oncePerFrame.schedule();
			return;
		}
		// 一次立即绘制取代已排队的那个：它马上就要绘制这个状态，而已装填的帧会在一次刷新之后再
		// 画它一遍。
		oncePerFrame.cancel();
		const previous = drawnState;
		drawnState = next;
		drawState(next, previous, options);
	}

	/** 绘制 `next` 中与上一次绘制不同的部分 —— 调用者已经把它变成了 `viewState`。 */
	function drawState(next: ViewState, previous: ViewState, options: ApplyOptions = {}): void {
		// 阅读宽度与分页是本窗口 UI 设置（ADR-0029）的事实，不再骑服务端的设置快照——这里没有
		// 东西要从中重读；它们的播种在启动装载与每次 saveUi 里。
		if (next.items !== previous.items || next.streaming !== previous.streaming) {
			// `deferred` 由唯一一个一次交出整段对话的调用者设置 —— 会话切换 —— 那里的绘制是切换的
			// 成本，绝不能占住帧。其他每个帧携带的都是读者正在看着到达的 delta，整体落地。
			if (options.deferred) transcriptView.renderDeferred(next.items, next.streaming);
			else transcriptView.render(next.items, next.streaming);
		}
		if (next.reachable !== previous.reachable) composer.setDisabled(composerDisabled());
		if (next.streaming !== previous.streaming) composer.setStreaming(next.streaming);
		if (next.queued !== previous.queued) composer.setQueue(next.queued);
		if (next.usage !== previous.usage) renderStatusBar();
		if (next.error !== previous.error) {
			errorBar.hidden = next.error === undefined;
			errorBar.textContent = next.error ?? "";
		}
		// 审批不在这里画：`render()` 末尾的门控 `renderNotices()` 是横幅区的唯一写入者，它在的帧
		// 恰好是这一行过去触发的帧。
		render();
	}

	/**
	 * 输入框此刻可否输入：连接活着，且打开的草稿已选定目录（ADR-0021）。
	 *
	 * 无目录草稿没有可出发的落点 —— 它的输入框禁用，目录芯片选定即解禁。真实会话与带目录的草稿
	 * 只看连接。
	 */
	function composerDisabled(): boolean {
		return !viewState.reachable || (followed === undefined && draft !== undefined && draft.workDirAbsPath === undefined);
	}

	/**
	 * 模型席位，既是控件视角也是下一条消息的视角。
	 *
	 * 窗口自己的选择优先于会话的，因为会话的是*上一次*请求用的，而选择是*下一次*要用的。档位列表
	 * 来自正在显示的行 —— 档位是模型的，服务端给每行发各自的 —— 名字指名的行不在目录里时没有
	 * 列表可读，空列表让档位按钮隐藏，直到清单送达或行被找到。
	 */
	function selectionForSend(): ComposerSelection {
		const snapshot = viewState.snapshot;
		// 草稿没有快照可跟随，兜底是设置里的默认模型 —— 与服务端对会话的解析链同一条：
		// 记录的选择 > 设置的默认 > 内置默认行，草稿只差最后一跳的落地时机。
		const model = chosen.model ?? snapshot?.model ?? viewState.settings?.model ?? "";
		const modelOption = rowOf(model);
		const levels = modelOption?.thinkingLevels ?? [];
		const level = chosen.thinkingLevel ?? snapshot?.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
		return { models: viewState.models, model, levels, level };
	}

	/** 一个名字背后的已导入行；已删除或从未存在的返回 undefined。 */
	function rowOf(name: string | undefined): ModelOption | undefined {
		return name === undefined ? undefined : viewState.models.find((model) => model.name === name);
	}

	/**
	 * 丢掉席位中被会话追上的部分。
	 *
	 * 一个字段只有在与服务端不一致时才是覆盖。一致的那一刻就清除，正是让一次 send 把控制权交回来
	 * 的机制：使用那个选择的请求记录了它，快照证实了它，席位重新跟随会话，而不是永远遮蔽它。
	 */
	function syncChosen(): void {
		const snapshot = viewState.snapshot;
		if (snapshot === undefined) return;
		if (chosen.model !== undefined && chosen.model === snapshot.model) delete chosen.model;
		if (chosen.thinkingLevel !== undefined && chosen.thinkingLevel === snapshot.thinkingLevel) {
			delete chosen.thinkingLevel;
		}
	}

	/** 打开应用级设置面板，可选直接落到某个标签页。 */
	function openSettings(tab?: "modes"): void {
		settingsPanel.show(tab);
		settingsPanel.render({
			models: viewState.models,
			toolNames: viewState.toolNames ?? [],
			appearance: uiSettings.appearance,
			...(viewState.settings ? { settings: viewState.settings } : {}),
			...(viewState.snapshot ? { snapshot: viewState.snapshot } : {}),
		});
	}

	/**
	 * 屏幕上的会话在哪个模式上。
	 *
	 * 会话记录的是模式指针（ADR-0018），快照的 `mode` 字段就是座位 —— 名字在而解析成功时是那个
	 * 名字，指针缺席或悬空时 undefined，画成内置「默认」。屏幕上没有会话时回答默认，因为那是下一个
	 * 开启的。
	 */
	function currentModeName(): string | undefined {
		// 草稿的座位在草稿身上：攒下的指针就是屏幕上的答案，缺席画成内置「默认」。
		if (followed === undefined && draft !== undefined) {
			return draft.mode === undefined || draft.mode === null ? DEFAULT_MODE_NAME : draft.mode;
		}
		const snapshot = viewState.snapshot;
		if (snapshot === undefined) return DEFAULT_MODE_NAME;
		return snapshot.mode ?? DEFAULT_MODE_NAME;
	}

	/**
	 * 把本窗口所在的会话放到一个模式上。
	 *
	 * 一条命令（ADR-0018）：补丁带 `mode` 名字，会话从此活态跟随那个预设 —— 模式改了内容，会话跟
	 * 着变。「默认」写 `null`，指针缺席就是它的落盘形态；指名一个刚被删除的模式会被服务器拒绝并
	 * 在这里报出来。
	 */
	function applyMode(name: string): void {
		const settings = viewState.settings;
		if (name !== DEFAULT_MODE_NAME && settings?.modes?.some((mode) => mode.name === name) !== true) {
			report(new Error(`没有叫「${name}」的模式，可能刚被删除。`));
			return;
		}
		// 草稿的模式落在草稿上，随第一条消息一起落地 —— 服务端对它还一无所知，没有命令可发。
		if (followed === undefined && draft !== undefined) {
			draft.mode = name === DEFAULT_MODE_NAME ? null : name;
			render();
			return;
		}
		if (followed === undefined) {
			report(new Error("还没有挂上任何会话。"));
			return;
		}
		void sessionApi.setConfig(followed, { mode: name === DEFAULT_MODE_NAME ? null : name }).catch(report);
	}

	function render(): void {
		syncChosen();
		const snapshot = viewState.snapshot;

		// 下面每一块只在自己的某个输入动了时才画。流式帧不改变它们中的任何一个，所以它的成本止于
		// transcript —— 正是上面那些门的意义。
		renderSidebar();

		const headingText = snapshot?.title ?? "新会话";
		if (headingText !== headingDrawn) {
			headingDrawn = headingText;
			heading.textContent = headingText;
		}
		const headingTip = snapshot?.title ?? "";
		if (headingTip !== headingTipDrawn) {
			headingTipDrawn = headingTip;
			heading.title = headingTip;
		}
		const subtitleText =
			snapshot?.workDirAbsPath ??
			(draft !== undefined
				? draft.workDirAbsPath ?? "未选择目录"
				: followed !== undefined
					? followed
					: viewState.reachable
						? "未选择会话"
						: "连接中…");
		if (subtitleText !== subtitleDrawn) {
			subtitleDrawn = subtitleText;
			subtitle.textContent = subtitleText;
		}

		// 欢迎状态没有可输入的会话：composer、它的头部行和状态行是会话绑定的控件，所以在跟随会话
		// 之前退下。错误条保留 —— 连接问题不是会话的事实。草稿是一段还没出生的对话：状态行退下
		// —— token 计数只对运行有意义，而草稿不可能在运行；输入框可否用由 composerDisabled 裁决
		// —— 无目录草稿在目录芯片选定之前禁用（ADR-0021）。
		const welcome = followed === undefined && draft === undefined;
		composerHead.hidden = welcome;
		composer.element.hidden = welcome;
		statusBar.element.hidden = welcome || draft !== undefined;
		composer.setDisabled(composerDisabled());

		// 空态的问题跟着草稿的状态走：无目录草稿不能开始对话，问题换成先选目录的指引。
		transcriptView.setWelcomeText(
			followed === undefined && draft !== undefined && draft.workDirAbsPath === undefined
				? "先在下方选一个目录，再开始对话。"
				: undefined,
		);

		// 分支条目跟随会话的分支形状，基线或一条结束的消息都可能改变它，所以签名是树的同一性加上
		// 裁出标签的三个数字。"none" 是单路形状 —— chip 站着但无物可指名 —— 树与"none"之间的任何
		// 移动都会改变签名，所以它携带的标签总是随之重画。
		const tree = viewState.branchTree;
		const branchSig =
			tree === undefined ? "none" : `${tree.currentId ?? "-"}|${tree.points}|${tree.options}|${snapshot?.title ?? ""}`;
		if (branchSig !== branchChipDrawn) {
			branchChipDrawn = branchSig;
			// 永远可见：只有一条路的对话恰恰是最需要这扇门的，而它打开的页面给出使用说明。id 和
			// 标签是另一回事：没有派生的会话只有一条分支，"我在哪一条上"自问自答，数字只说"最新的
			// 用户消息" —— 噪声。派生存在时它们才出现，那时问题才有值得读的答案。
			if (tree !== undefined && tree.currentId !== undefined && tree.points > 0) {
				branchChipId.textContent = shortId(tree.currentId);
				branchChipLabel.textContent = findWay(tree, tree.currentId)?.label ?? "";
			} else {
				branchChipId.textContent = "";
				branchChipLabel.textContent = "";
			}
		}

		// 分支页从同一棵树画自己，并在同样的稀有性上门控：除非基线改变了树或运行改变了锁，它的
		// render 只花一次比较。
		branchView.render(tree, viewState.streaming);

		// chip 是 composer 头部唯一的常驻者且永远在那里：输入上方的那行就是"下一个会话落在哪里"
		// 属于的地方，无论上面的 transcript 在做什么。无目录草稿让这个问题没有答案 —— 标签把话说
		// 出来，而不是显示一个空名字。
		const directory = directoryForNewSession();
		const chipSig = directory ?? "";
		if (chipDrawn !== chipSig) {
			chipDrawn = chipSig;
			chipLabel.textContent = directory === undefined ? "选择目录" : directoryName(directory);
			directoryChip.title = directory ?? "未选择目录 —— 先在这里选一个，才能开始对话";
		}

		// 一次 send 会携带什么，席位就显示什么，所以席位从 `prompt` 读取的同一批值绘制，而不是只
		// 从快照。里面的两个选择器在自己的签名上门控，所以每帧仍然便宜。
		composer.setSelection(selectionForSend());
		// 模式席位是同一种读取：会话的值等于哪个预设，或没有。
		composer.setModes(currentModeName());

		renderStatusBar();
		renderApprovals();

		if (settingsPanel.open) {
			settingsPanel.render({
				models: viewState.models,
				toolNames: viewState.toolNames ?? [],
				...(viewState.settings ? { settings: viewState.settings } : {}),
				...(snapshot ? { snapshot } : {}),
			});
		}

		renderNotices();
	}

	/**
	 * 唯一值得打断空窗口的东西。
	 *
	 * 没有导入任何模型时这个应用什么都做不了，否则那个失败会在用户已经输入了问题并等待之后，
	 * 以错误消息的形式到达。
	 *
	 * 门是它所绘制数组的同一性。在不曾改变它的帧上重建横幅区，是 `render()` 里最后一个无条件的
	 * 逐帧写入 —— 每帧便宜，但重建不是零成本，而且不管屏幕上有没有它都在跑。
	 */
	function renderNotices(): void {
		if (viewState.models === noticesDrawn) return;
		noticesDrawn = viewState.models;

		if (viewState.models.length > 0) {
			banners.replaceChildren();
			return;
		}

		const card = element("div", "notice-card");
		const mark = element("div", "notice-mark");
		mark.append(icon("gear"));
		const text = element("div", "notice-text");
		text.append(
			element("strong", undefined, "还没有配置模型"),
			element("span", undefined, "在「设置」里添加服务地址和密钥，再在输入框下面为本会话选一个模型。"),
		);
		const open = element("button", "button primary", undefined, { type: "button" });
		open.textContent = "打开设置";
		open.addEventListener("click", () => openSettings());
		card.append(mark, text, open);

		banners.replaceChildren(card);
	}

	/**
	 * 接管席位：会话正在等待的每个审批一张卡片，坐在 composer 的位置上。
	 *
	 * 一个待审批是窗口在它站着期间唯一能行动的东西 —— 在 end-restart 语义下（ADR-0006 §5）运行
	 * 已在门处结束，此刻输入的提示会开启一次运行，其恢复趟会把仍然悬空的调用扫到一边。替换
	 * composer 是对这件事诚实的呈现，卡片携带协议实际接受的两个答案；回答其中一个就开始恢复对话
	 * 的那次运行。
	 */
	function renderApprovals(): void {
		if (viewState.approvals === approvalsDrawn) return;
		approvalsDrawn = viewState.approvals;
		const pending = viewState.approvals;
		approvalSeat.replaceChildren(...pending.map(approvalCard));
		approvalSeat.hidden = pending.length === 0;
		// composer 隐藏而不是禁用：审批卡片下面一个可见但变灰的输入框，会招致排队在问题后面的
		// 输入。隐藏了，卡片*就是*输入。
		composer.element.hidden = pending.length > 0;
	}

	function approvalCard(approval: ViewState["approvals"][number]): HTMLElement {
		const card = element("div", "approval-card");

		const strip = element("div", "approval-strip");
		strip.append(element("span", "approval-dot"), element("span", undefined, "等待审批"));
		card.append(strip);

		const body = element("div", "approval-body-wrap");
		const cardTitle = element("div", "approval-headline");
		cardTitle.append(icon("shield"), element("span", undefined, `允许运行 ${approval.toolName}？`));
		body.append(cardTitle, element("pre", "approval-command", approval.summary));
		card.append(body);

		const deny = element("button", "button", undefined, { type: "button" });
		deny.textContent = "拒绝";
		const allow = element("button", "button primary", undefined, { type: "button" });
		allow.textContent = "允许一次";
		// 每个答案一次请求，发给提示所来自的那个会话。
		deny.addEventListener("click", () => {
			if (followed !== undefined) void sessionApi.approve(followed, approval.toolCallId, false).catch(report);
		});
		allow.addEventListener("click", () => {
			if (followed !== undefined) void sessionApi.approve(followed, approval.toolCallId, true).catch(report);
		});

		const actions = element("div", "approval-actions");
		actions.append(deny, allow);
		card.append(actions);
		return card;
	}

	// ---------------------------------------------------------------- 命令

	/**
	 * 记下服务端应答了 —— 一个请求，或导航等待的一条基线。
	 *
	 * 这是过去的 `connected`，换了个说出它度量什么的名字，含义未变：服务端的答案证明服务端在那，
	 * 无论它经由 API 的哪个面孔到达。新的是它不再兼任"通道可用" —— 那是 {@link channel} 自己的
	 * 状态机，两者例行公事地不一致，双向都是，且谁都没有错。通道断开而它为真是正常的：窗口仍然
	 * 能发送，请求自己会作答。
	 */
	function reachable(): void {
		if (!viewState.reachable) apply({ ...viewState, reachable: true });
	}

	/** 一次失败的请求，仅当它对能否到达服务器说了些什么。 */
	function unreachable(error: unknown): void {
		if (!(error instanceof TypeError)) {
			report(error);
			return;
		}
		apply({ ...viewState, reachable: false, error: "无法连接到服务端。" });
	}

	/**
	 * 把窗口指向一个会话，并开始观看它。
	 *
	 * 所有会话变更都经过的唯一路径 —— 侧栏的一次点击、一次新建、一次派生，以及落在
	 * `GET /api/sessions/current` 所指会话上的页面加载。打开它是一个动作：`retain` 发送 `open`，
	 * 服务端应答的基线既是第一件被画的东西，也是之后每个帧追加的锚（ADR-0010）。它旁边没有读取，
	 * 因此没有第二份同一对话稍后到达并替换第一份。
	 *
	 * 代价是*完成*。一个请求过去自己回答"到达了 / 失败了 / 没有这个会话"，帧不会；导航的失败语义
	 * 改为流之上的本地时钟。`retain` 返回的 promise 恰恰为此 —— 基线 resolve 它，`error` 或 `end`
	 * 帧拒绝它，本地超时也是 —— 所以窗口保留了读取曾给出的东西：失败报告在错误行上，旧对话仍在
	 * 屏幕上；而未就绪的通道是一次拒绝，不是一场把慢归咎于没人问过的服务器的等待。
	 *
	 * 顺序中有四件事是承重的，每一个都是窗口过去停滞或丢失位置的一种方式：
	 *
	 * - 窗格在等待之前翻到对话，而不是之后。等待慢得足以在期间操作，点了行又去分支页的读者，
	 *   绝不能在基线终于落地时被从正在看的树上拽走。打开对话是为了阅读，这是关于点击的决定而不是
	 *   关于答案的 —— 所以失败的导航让旧对话留在屏幕上，而不是一块空白窗格。
	 * - 等待在开始之前就被宣告。它是窗口最慢、最不可预测的一步 —— 一整段对话，按需从会话构建，
	 *   还要过 `JSON.parse` —— 且旧 transcript 全程保留，这对窗格是对的，对点击是沉默的。
	 * - 快照延迟绘制。它是一帧之内的整段对话，其中每条消息都是新的，所以绘制正比于会话：整体画
	 *   就是冻结，分片画是首帧加几帧。
	 * - 列表刷新最后来且不被 await。从基线上屏的那一刻起窗口对这个会话就是*活的* —— 引用在等待
	 *   之前就取了，绘制与监听之间没有间隙 —— 侧栏的行在通道可用时反正会从通道到达；不可用时，
	 *   列表是对已经画好的列的修复，不是窗格的活性可以排在后面等的东西。
	 */
	async function openSession(sessionId: string): Promise<void> {
		// 上一次导航的目标，如果它从未成为窗格：`followed` 仍然指名屏幕上的对话，而这次点击的引用
		// 不属于任何人。失败的导航在失败那一刻保留它的引用 —— 基线可能仍在服务端的写队列里，此刻
		// 发出的 `cancel` 会排在它后面、什么也释放不了（ADR-0010）—— 所以释放发生在这里，晚一次
		// 手势，当窗口选择了看别的东西。同一会话的重试跳过它，这正是让重试复用流而不是再要一次的
		// 机制。
		if (opening !== undefined && opening !== followed && opening !== sessionId) muxClient.release(opening, "pane");
		const series = (openSeries += 1);
		opening = sessionId;
		setPane("chat");
		showLoading(series, true);

		let snapshot: SessionSnapshot;
		try {
			snapshot = await muxClient.retain(sessionId, "pane", series);
		} catch (error) {
			showLoading(series, false);
			// 被取代导航的失败不是窗格的新闻：用户正在看一个打开成功的会话，关于他们离开的那个
			// —— 常常是同一台服务器，常常是被更新的点击抢走的流 —— 的横幅，指名的是一个不在屏幕
			// 上的问题。拥有窗格的导航同样拥有这份报告。
			if (series !== openSeries) return;
			unreachable(error);
			return;
		}
		showLoading(series, false);
		// 这条基线在路上时，更新的点击移动了窗口。它指名窗格已经离开的会话，所以被整体丢弃：
		// 不改状态、不绘制、不上报。取代它的导航拥有全部三样，而这一次取的引用已被那次点击放开。
		if (series !== openSeries) return;

		reachable();
		// 上一个窗格的引用现在放开，新的已落地，这条连接就为一个窗格观看一个会话。绝不为了正在
		// 打开的会话：同一行第二次点击时引用是同一个，释放它会把流从即将绘制的窗格下面抽走。
		if (followed !== undefined && followed !== snapshot.id) muxClient.release(followed, "pane");
		// 离开的那个若是草稿，它的席位一并交出：屏幕上即将出现的会话是真实的，`draft` 的互斥半
		// 从这里开始成立。
		if (draft?.id !== snapshot.id) draft = undefined;
		followed = snapshot.id;
		// 不同的对话是不同的席位：为前一个选择的，对这一个什么都说不出来，它以自己的分支记录的
		// 东西开启。
		chosen = {};
		// 选择器的显式选择属于*即将*开始的那个会话，那个会话已经开始 —— 现在屏幕上的这个决定
		// 下一个会话落在哪个目录，直到 chip 再次被使用。
		absPickedDirectory = "";
		// 与分支命令相同的渲染：快照就是快照，无论它是作为导航的答案到达，还是作为流中途的重新
		// 基线化。
		apply(reduce(viewState, { type: "baseline", session: snapshot }), { deferred: true });

		// 列表不被 await。它只重画侧栏，通道 live 时被直接拒绝（那时通道是行的权威），而它本会
		// 拖住的帧正是读者正在等的帧。获取失败上报给窗口而不是窗格，所以它也撤销不了切换。
		void refreshLists().catch(report);
	}

	/** 经 REST 重读侧栏的行，但只在通道不是权威时。 */
	async function refreshLists(): Promise<void> {
		const { directories } = await sessionApi.listDirectories();
		reachable();
		// 通道 live 时被拒绝。一张表两个写入者正是要避免的竞态：从文件算出的列表会落在一次
		// `running: true` 之后，把行拉回空闲，窗口就会把正在工作的会话显示成没在工作。
		if (!sessionRows.loadFrom(directories, channel === "live")) return;
		renderSidebar();
	}

	/**
	 * 设置写入的尾部，让一个文件的补丁一次落一个。
	 *
	 * 一次保存同时移动工具集和随之的审批是几个补丁，每个答案携带整个设置对象：两个同时进行，可能
	 * 让较旧的答案最后应用，用早已被取代的快照重画窗口。把请求串起来，答案 —— 以及它们绘制的状态
	 * —— 就按用户做出的顺序保持。设置是一个文件，一次一个写入者正是文件已经假设的契约。
	 */
	let settingsWrites: Promise<void> = Promise.resolve();

	function saveSettings(patch: Parameters<SessionApi["updateSettings"]>[0]): Promise<void> {
		// catch 放在链的末端而不是 `writeSettings` 里：一个被拒的补丁上报一次，链仍然 resolve，
		// 下一个关于不同字段的补丁照常发出，而不是被前一个的 rejection 取消。
		const write = settingsWrites.then(() => writeSettings(patch)).catch((error: unknown) => {
			report(error);
		});
		settingsWrites = write;
		return write;
	}

	async function writeSettings(patch: Parameters<SessionApi["updateSettings"]>[0]): Promise<void> {
		const { settings: saved } = await sessionApi.updateSettings(patch);
		apply({ ...viewState, settings: saved });
	}

	/**
	 * UI 设置的一次变更：合并进本窗口的设置、立即应用、并写回客户端自己的存储（ADR-0029）。
	 *
	 * 先动内存再落盘——主题与字号的价值就在看到它们变化，写入失败时错误条是报告、视图保留这次
	 * 点击，与服务端补丁的拆分相同：屏幕是用户做的，文件是幸存的。外观每一拍都整体重应用，分支
	 * 页的卡片以字阶度量，所以它随每次变更重新度量。
	 */
	function saveUi(patch: UiSettingsPatch): void {
		uiSettings = applyUiPatch(uiSettings, patch);
		applyAppearance(uiSettings.appearance);
		branchView.remeasure();
		paging = uiSettings.appearance.directories ?? {};
		renderSidebar();
		void saveUiSettings(uiSettings).catch(report);
	}

	/**
	 * 向本窗口所在的会话发送一条消息。
	 *
	 * 订阅在请求发出**之前**取得，这个顺序正是旧的那套"先挂载、再 post、挂载失败就不 post"的舞步
	 * 能被删掉的全部理由。启动失败由 `announce` 报告，它不被缓冲、只到达已在观看的连接 —— 所以
	 * 在窗口尚未监听时发出的消息会丢失自己的错误，屏幕上什么都没有。先 retain 让目的地不可能
	 * 被错过。
	 *
	 * send 引用与窗格的分开，活得与它开启的那轮运行一样长，这正是让窗口能离开一段仍在回答的对话
	 * 的机制：恰在有运行需要上报时，流活得比窗格久。
	 */
	async function prompt(text: string, behavior?: "steer" | "followUp"): Promise<void> {
		// 草稿的诞生：第一条消息就是出生证明（ADR-0021）。create→PATCH mode→open→POST message 四步
		// 折叠为一步 —— POST /api/sessions 带 text、目录、草稿攒下的模式与席位选择，会话、两个文件、
		// 模式指针与模型选择在同一个请求里原子出生；之后它就是一个普通会话。诞生失败时草稿原样保留：
		// 服务端上什么都没有，重试就是从头再来。
		if (followed === undefined && draft !== undefined) {
			const source = draft;
			if (source.workDirAbsPath === undefined) {
				report(new Error("先在下方选一个目录，再开始对话。"));
				return;
			}
			const selection = selectionForSend();
			let createdId: string;
			try {
				const created = await sessionApi.createSession({
					text,
					workDirAbsPath: source.workDirAbsPath,
					...(behavior === undefined ? {} : { behavior }),
					...(source.mode !== undefined && source.mode !== null ? { mode: source.mode } : {}),
					model: selection.model,
					thinkingLevel: selection.level,
				});
				reachable();
				// 新会话把被藏起的目录领回侧栏——旧世界里这是出生请求服务端的那一拍，如今隐藏
				// 列表归客户端（ADR-0029），领回也在这里。
				unhideDirectory(source.workDirAbsPath);
				createdId = created.sessionId;
			} catch (error) {
				unreachable(error);
				composer.setDraft(text);
				return;
			}
			// 草稿就此完成使命：行让位给服务端推送的真实行。`chosen` 穿过 openSession 的重置活下去
			// —— 它是用户为这段对话做的选择，诞生不改变它。
			draftRowMap.delete(source.id);
			draft = undefined;
			const savedChosen = chosen;
			await openSession(createdId);
			if (followed !== createdId) {
				// 打开被一次更新的导航取代：这条消息失去了目的地，文字回到输入框。
				composer.setDraft(text);
				return;
			}
			chosen = savedChosen;
		}
		// 持有而不是读两次：取引用会把控制权交回通道，那次等待期间点一下侧栏，就会把这条消息发到
		// 窗口移动*过去*的会话，而不是写下这段文字的会话。
		const target = followed;
		if (target === undefined) {
			report(new Error("还没有挂上任何会话。"));
			return;
		}

		muxClient.retain(target, "send");
		// 席位的选择随消息走、且只随消息走：服务端在接受提示的同时应用选择，所以选择绝不是一条可以
		// 单独施加的命令。
		const selection = selectionForSend();
		try {
			await sessionApi.prompt(target, text, behavior, {
				model: selection.model,
				thinkingLevel: selection.level,
			});
			reachable();
		} catch (error) {
			// 没有东西在运行，引用没有可为之活的运行。在这里丢掉它，而不是等一个永远不会到来的
			// 结算，是旧代码没有的那次释放。
			releaseSend(target);
			composer.setDraft(text);
			unreachable(error);
		}
	}

	async function abort(): Promise<void> {
		if (followed === undefined) return;
		try {
			await sessionApi.abort(followed);
			reachable();
		} catch (error) {
			unreachable(error);
		}
	}

	/**
	 * 在选择器的目录里开始一段对话，并把窗口指过去。
	 *
	 * 开的是草稿：目录在此刻解析（显式指名 > 屏幕会话的目录），没有答案时草稿无目录出生 —— 输入框
	 * 禁用，直到目录芯片选定（ADR-0021）。会话随第一条消息才诞生（发消息时的出生请求显式带这个目
	 * 录）。全新目录里的第一个会话就是这样为它的目录组赢得侧栏一席之地的 —— 草稿行先住进那个组，
	 * 诞生后由真实行接替。
	 */
	function newSession(workDirAbsPath?: string): void {
		// 草稿不触碰服务端：id 是本地的，目录此刻解析好 —— 显式指名的优先，然后是选择器的答案，
		// 再没有别的回落。服务端根不再兜底：没有答案的草稿就是没有目录。
		const draftSession: DraftSession = {
			id: crypto.randomUUID(),
			workDirAbsPath: workDirAbsPath ?? directoryForNewSession(),
			createdAt: Date.now(),
		};
		draftRowMap.set(draftSession.id, draftSession);
		openDraft(draftSession.id);
	}

	/**
	 * 打开一个草稿：不订阅、不等待基线 —— 服务端对它一无所知，屏幕上是一段空对话和可用的输入框。
	 *
	 * 簿记与 {@link openSession} 对齐（导航序号、上一个未落地目标的引用），mux 的部分被整个拿掉：
	 * 没有流可取引用。从真实会话切过来的时刻窗格引用被放开 —— 草稿观看的不是任何会话。
	 */
	function openDraft(sessionId: string): void {
		const target = draftRowMap.get(sessionId);
		if (target === undefined) return;
		if (opening !== undefined && opening !== followed && opening !== sessionId) muxClient.release(opening, "pane");
		const series = (openSeries += 1);
		opening = sessionId;
		setPane("chat");
		// 上一次导航可能还亮着加载提示 —— 草稿的打开是即时的，它的等待到这一刻就结束了。
		showLoading(series, false);
		if (followed !== undefined) {
			muxClient.release(followed, "pane");
			followed = undefined;
		}
		draft = target;
		chosen = {};
		absPickedDirectory = "";
		// 视图折回空态：上一个会话的快照、分支树与用量都是别的对话的事实，草稿一段也没有。保留
		// 窗口自己的三样 —— 可达性、模型清单、设置 —— 与删除后的折叠共享同一条规则。
		apply({
			...initialState(),
			reachable: viewState.reachable,
			models: viewState.models,
			...(viewState.settings === undefined ? {} : { settings: viewState.settings }),
		});
	}

	/**
	 * 给目录一个侧栏显示的名字，磁盘不动（ADR-0029）。
	 *
	 * `name` 是标签，不是路径：标签是本窗口 UI 设置记住的一个视图，写回客户端自己的存储并重画。
	 * 行不动 —— 目录由它的 transcript 记录的目录标识 —— 所以本窗口欠这次变更的只是一次重画，
	 * 清掉的 `sidebarDrawn` 强制它越过下面的门。
	 *
	 * 空名字收回自定义名，标题落回文件夹自己的名字。
	 */
	function renameDirectory(workDirAbsPath: string, name: string): void {
		saveUi({ directoryNames: { [workDirAbsPath]: name } });
		// 签名里没有随标签动的东西：行还是那些行，否则戴着新标签的标题会保留旧文字。
		sidebarDrawn = undefined;
		renderSidebar();
	}

	/**
	 * 把一个目录从侧栏拿掉，磁盘上什么都不碰（ADR-0029）。
	 *
	 * 隐藏列表是本窗口 UI 设置的事实：写进 `hiddenDirectories` 并存回客户端自己的存储，分组从
	 * 侧栏消失，会话记录与其命名的目录原地不动——会话仍可按 id 打开，在同一个目录里创建新会话
	 * 就是把它领回来。
	 */
	function deleteDirectory(workDirAbsPath: string): void {
		const hidden = uiSettings.hiddenDirectories ?? [];
		if (hidden.some((path) => sameDirectory(path, workDirAbsPath))) return;
		saveUi({ hiddenDirectories: [...hidden, workDirAbsPath] });
		// 门读取的签名里没有随隐藏动的东西：没有这个组任何行的窗口，否则会画出一条和之前一模一样
		// 的字符串。
		sidebarDrawn = undefined;
		renderSidebar();
	}

	/**
	 * 在一个目录里出生的新会话把它领回侧栏：被藏起的目录以一个新会话回到列表。
	 *
	 * 与 `deleteDirectory` 成对，是对「删除」这个单向门的回答——回到它那里正是用户想要它重新
	 * 出现在列表上的表示。隐藏列表是客户端自己的，所以这一步也只在客户端做（ADR-0029）。
	 */
	function unhideDirectory(workDirAbsPath: string | undefined): void {
		if (workDirAbsPath === undefined) return;
		const hidden = uiSettings.hiddenDirectories ?? [];
		const kept = hidden.filter((path) => !sameDirectory(path, workDirAbsPath));
		if (kept.length === hidden.length) return;
		saveUi({ hiddenDirectories: kept });
	}

	/**
	 * 把一个会话整个复制进一个新文件，并打开副本。
	 *
	 * `entryId: null` 是整份日志的派生：每个条目、每片叶子都跟着走，副本从源停下的地方继续。行
	 * 菜单作用于会话而不是它的某条消息，这就是调用里没有条目的原因。
	 */
	async function forkSession(sessionId: string): Promise<void> {
		try {
			const created = await sessionApi.forkSession(sessionId, null);
			reachable();
			await openSession(created.sessionId);
		} catch (error) {
			unreachable(error);
		}
	}

	/**
	 * 给会话一个自己的名字，存储在服务端。
	 *
	 * 侧栏的行不在这里变 —— 名字随 `session_row` 帧回来，那是所有其他行事实的同一条路。本窗口在
	 * 请求之外做的，是被改名的会话正是屏幕上那个时让头部保持诚实：头部读快照的 title，而快照不在
	 * 行帧上刷新，所以确认的名字在服务端说它生效的那一刻被折入一次。
	 */
	async function renameSession(sessionId: string, title: string): Promise<void> {
		try {
			const { title: stored } = await sessionApi.renameSession(sessionId, title);
			reachable();
			if (followed === sessionId && viewState.snapshot !== undefined) {
				apply({ ...viewState, snapshot: { ...viewState.snapshot, title: stored } });
			}
		} catch (error) {
			unreachable(error);
		}
	}

	/**
	 * 整个删除一个会话，如果本窗口正在读它就离开。
	 *
	 * 行随连接的 `session_gone` 帧离开，绝不靠本地修改 —— 每个事实一条路，与派生遵循的规则相同。
	 * 折叠本身是 {@link foldFromDeleted}，与那个帧共享：两者谁先落地谁做事，另一个发现窗格已在
	 * 别处。
	 */
	async function deleteSession(sessionId: string): Promise<void> {
		// 草稿的删除是本地的：服务端对它一无所知，没有请求可发，也没有帧会来。屏幕上开着它时折回
		// 欢迎态 —— 与真实会话被删时的折叠同一个形状，只是没有引用要释放。
		if (draftRowMap.has(sessionId)) {
			draftRowMap.delete(sessionId);
			if (draft?.id === sessionId) {
				draft = undefined;
				apply({
					...initialState(),
					reachable: viewState.reachable,
					models: viewState.models,
					...(viewState.settings === undefined ? {} : { settings: viewState.settings }),
				});
			}
			render();
			return;
		}
		try {
			await sessionApi.deleteSession(sessionId);
			reachable();
		} catch (error) {
			// 繁忙的会话 —— 运行进行中、审批等待中 —— 是服务端带着它的理由拒绝；错误条正是那些
			// 理由已经显示的地方。
			unreachable(error);
			return;
		}
		foldFromDeleted(sessionId);
	}

	/**
	 * 把窗格从一个不再存在的会话上折走。
	 *
	 * 两扇门带着同一个判决到达这里：本窗口自己的删除，以及别的窗口删除了会话时连接的
	 * `session_gone` 帧。屏幕上的 transcript 无论哪种都是对已经不存在的东西的视图，所以折叠是
	 * 同一个 —— 模型、设置和可达性保留，因为那些是窗口自己的事实，不是被删会话的。在帧上、而不
	 * 只在本地删除时释放窗格引用，正是让一个被服务端遗忘的会话上持有的引用，不把下一次重连变成
	 * 一次被拒绝的 `open` —— 并把那次拒绝变成一场没人选择的竞态的横幅。
	 */
	function foldFromDeleted(sessionId: string): void {
		if (followed !== sessionId) return;
		muxClient.release(followed, "pane");
		followed = undefined;
		apply({
			...initialState(),
			reachable: viewState.reachable,
			models: viewState.models,
			...(viewState.settings === undefined ? {} : { settings: viewState.settings }),
		});
	}

	/**
	 * 把这个会话移到它自己树上的另一个分支。
	 *
	 * `descend` 选择落点：true 沿一个备选项走到它停下的地方，false 回退到消息本身，下一个提示
	 * 从那里开启新的路。答案在这里应用*并且*经通道到达：服务端把同一个快照发给这个会话上的每个
	 * 窗口，把响应也应用，正是让点击的窗口不用等一个往返就看到自己的移动。两者是同一个会话状态，
	 * 后到的那个什么都不会改变。
	 */
	async function branch(entryId: string, descend: boolean): Promise<void> {
		if (followed === undefined) return;
		try {
			const { session } = await sessionApi.branchSession(followed, entryId, descend);
			apply(reduce(viewState, { type: "baseline", session }));
			// 一次回退 —— fork 按钮的情形 —— 只是半个手势：只有下一个提示输入后分支才是真的，
			// 所以 composer 接过这次按压瞄准的焦点。
			if (!descend) composer.focus();
		} catch (error) {
			report(error);
		}
	}

	/**
	 * 用户消息的右键菜单。
	 *
	 * `从此分支` 回退到这条消息，让下一个提示从它开启另一条路，这正是它留在对话页的原因：分支页
	 * 没有可以输入那个提示的 composer。进入分支页本身的门只有头部的 chip —— 一个入口、一个地方
	 * —— 所以正在移动分支即将生长的那棵树的流式运行，干脆不打开菜单，而不是提供一个 chip 已经
	 * 提供的看一眼。
	 */
	function openUserMenu(entryId: string | undefined, x: number, y: number): void {
		const items: MenuItem[] = [];
		if (entryId !== undefined && !viewState.streaming) {
			items.push({
				label: "从此分支",
				icon: "fork",
				title: "在本会话里从这条消息继续：其后内容保留为另一条分支",
				onSelect: () => void branch(entryId, false),
			});
		}
		if (items.length === 0) return;
		openMenuAt(x, y, items);
	}

	function report(error: unknown): void {
		apply({ ...viewState, error: describe(error) });
	}

	// ---------------------------------------------------------------- 监听

	/**
	 * 焦点是否在某处按键另有含义的地方。
	 *
	 * 接管的 Enter 和 Escape 是给正在读卡片的人的，不是给表单的：已经聚焦的按钮用自己的键回答，
	 * 一个可见的输入框 —— 面板的、搜索的 —— 绝不能被把输入变成一次回答。
	 */
	function typingTarget(): boolean {
		const target = document.activeElement;
		return (
			target instanceof HTMLElement &&
			["INPUT", "TEXTAREA", "BUTTON", "SELECT", "SUMMARY"].includes(target.tagName)
		);
	}

	window.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			// 菜单在自己的捕获监听里关闭自己，事件到达这里之前就被拦下；面板按最可能的打开顺序关。
			if (settingsPanel.open) {
				settingsPanel.hide();
				return;
			}
			if (viewState.approvals.length > 0 && followed !== undefined && !typingTarget()) {
				void sessionApi.approve(followed, viewState.approvals[0]!.toolCallId, false).catch(report);
				return;
			}
		}
		if (event.key === "Enter" && viewState.approvals.length > 0 && followed !== undefined && !typingTarget()) {
			// Enter 允许，Escape 拒绝 —— 接管卡片提供的两个答案，用的正是它为输入框让出的那副
			// 键盘。
			void sessionApi.approve(followed, viewState.approvals[0]!.toolCallId, true).catch(report);
			return;
		}
		if (event.key === "n" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void newSession();
		}
		if (event.key === "b" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			collapsed = !collapsed;
			render();
		}
	});

	// 桌面标志（`data-theme`、`data-platform`、`data-desktop-caption`）由 index.html 的内联启动
	// 脚本在首次绘制之前设置。这里不重复：标题栏必须在样式表渲染之前预留空间，而不是在模块加载
	// 之后。

	/**
	 * 已导入的行，在什么都没导入时种下窗口的内置默认。
	 *
	 * 这是窗口唯一一次未经用户请求就写入消息的地方：没有模型的机器什么都做不了，一个解释这件事
	 * 的提示，不如让这件事变成不真的那一行。行是 `DEFAULT_MODEL` —— 无密钥，所以它是起点而不是
	 * 凭据 —— 且走普通的模型端点，完全像用户亲手输入的一样。落地之后，设置标记记录本窗口做过
	 * 这次提议，这正是让已删除的行在下次启动时保持已删除的机制；见 `default-model.ts`。
	 *
	 * 失败的种下会被上报，而读取自己的答案 —— 可能为空 —— 仍然落地：窗口打开、说明哪里出错、
	 * 设置面板仍然是修法。
	 */
	async function importedModels(): Promise<ModelOption[]> {
		const { models } = await sessionApi.listModels();
		try {
			const planted = await seedDefaultModel({
				models,
				seeded: viewState.settings?.defaultModelSeeded === true,
				save: async (rows) => (await sessionApi.updateModels(rows)).models,
				markSeeded: () => saveSettings({ defaultModelSeeded: true }),
			});
			return planted ?? models;
		} catch (error) {
			report(error);
			return models;
		}
	}

	// 从 API 独立于通道填面板和列表：通道永远上不来的窗口仍然能显示服务端有什么，也能说出缺什么。
	// 所以第一次连接在这里发生而不是模块加载时 —— 无论如何面板都值得有，且下面的读取没有一个在
	// 等连接。
	void (async () => {
		// 通道先起，这与它过去启动的顺序相反。落地现在是一次导航（ADR-0010）：页面打开的会话由
		// 帧打开，所以读取之后才开始的连接，会让落地等一场根本没人开始的握手。在这里开始让那次
		// 握手在读取之下运行，而不是在它们之后。
		muxClient.start();
		try {
			const health = await sessionApi.health();
			absCurrentDirectory = health.workDirAbsPath;
			reachable();
		} catch (error) {
			unreachable(error);
		}
		// UI 设置先于服务端设置装载：外观是窗口第一眼就要戴上的东西，它住在客户端自己的存储
		// （ADR-0029），读它不经过网络。播种之后立即应用一次外观与阅读列宽——启动前样式表的
		// 默认值一直撑着，装载的答案一到就替换它。
		try {
			uiSettings = await loadUiSettings();
			applyAppearance(uiSettings.appearance);
			paging = uiSettings.appearance.directories ?? {};
			contentPref = uiSettings.appearance.contentWidth;
			applyContentWidth(contentPref);
			renderSidebar();
		} catch (error) {
			report(error);
		}
		try {
			const { settings: stored } = await sessionApi.getSettings();
			reachable();
			apply({ ...viewState, settings: stored });
		} catch (error) {
			report(error);
		}
		try {
			const { tools } = await sessionApi.toolNames();
			reachable();
			apply({ ...viewState, toolNames: tools });
		} catch (error) {
			report(error);
		}
		try {
			const models = await importedModels();
			reachable();
			apply({ ...viewState, models });
		} catch (error) {
			report(error);
		}
		try {
			await refreshLists();
		} catch (error) {
			report(error);
		}
		// 落在哪个会话是服务端的决定 —— `--session` 钉住一个，否则永远是 `null`
		// 表示"没有，停在欢迎状态" —— 所以页面发问而不是从列表里挑。这个问题仍然走 REST：它问的是
		// 服务端唯一会给出的那个答案，而通道是一条没有命令面的推送通道。
		//
		// 随后的打开等待通道证明自己，因为打开会话是 `open` 帧而没有读取可兜底。那次等待是
		// ADR-0010 为页面加载记下的唯一一拍，对服务端永远上不来的窗口它也是诚实的答案：横幅这么说，
		// 而不是一段永远不会更新的对话。
		try {
			const { sessionId } = await sessionApi.currentSession();
			reachable();
			await channelLive;
			// 除非一次点击先到了。落地是默认 —— 服务端记得的那个会话，给还没被碰过的窗口 —— 而已经
			// 点过一行的人已经说了比默认更新的东西。没有这个，答案会晚一拍到达，取代已经在屏幕上的
			// 那次点击，把窗格拽回读者刚刚离开的对话。`openSeries` 只有在什么都还没打开过时才是零，
			// 那正是这里要问的问题。
			if (sessionId !== null && openSeries === 0) await openSession(sessionId);
		} catch (error) {
			unreachable(error);
		}
	})();

	composer.focus();
}

main();
