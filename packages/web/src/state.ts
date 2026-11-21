import {
	addUsage,
	EMPTY_USAGE,
	type AgentSessionEvent,
	type BranchOption,
	type BranchPoint,
	compactionSummaryOf,
	type FileDiff,
	type Message,
	type MessageDelta,
	type ModelOption,
	type PendingApproval,
	type QueuedPrompt,
	type ServerMessage,
	type SessionSnapshot,
	type GlobalSettingsSnapshot,
	type UsageTotals,
} from "@my-agent/case/protocol";
import type { AppearanceSettings } from "./ui-settings.ts";

export interface ToolCard {
	toolCallId: string;
	toolName: string;
	args: unknown;
	output: string;
	isError: boolean;
	running: boolean;
	/**
	 * 该调用挂在台账里等待审批答复（ADR-0005 §5）。
	 *
	 * 在 end-restart 语义下，被门控的调用等待期间既不运行也不产出结果：运行在门处结束，答案经
	 * REST 到达，恢复的运行来关闭它 —— 允许则重跑它（其 `tool_execution_start` 会清掉这个状态），
	 * 拒绝则合成其理由所指的结果。既不运行也未结束，卡片自己说明这一点，而不是在一个没有执行的
	 * 工具上转圈，或在一个尚未落地的结果上定论。
	 */
	waiting?: boolean;
	/**
	 * 该调用在磁盘上改了什么，工具上报时才有。
	 *
	 * 上报是工具结果的一部分，所以它随循环的 `tool_execution_end` 事件到达，并连同结果一起记入
	 * transcript。卡片画它而不是工具的文本 —— 文本是为模型写的同一份变更 —— 没带报告的结果则
	 * 回退到文本：失败的调用、无操作的写入，或什么都没改的工具。
	 */
	diff?: FileDiff;
}

/**
 * 模型对某条消息的推理，与它引出的答案分开保存。
 *
 * 推理块和其后的文本在同一条消息上到达，但读取方式不同 —— 答案是要点，推理在它后面 —— 所以
 * transcript 把它们画成两行，且只有推理那行可折叠。`text` 是 provider 原样的 Markdown
 * （`packages/domain/src/agent/llm/api/anthropic-messages.ts` 逐字拼接 delta），同一条消息里的多个推理块
 * 以空行连接，那正是段落断行的位置。
 */
export interface MessageThinking {
	/** 推理内容，Markdown，保留 provider 自己的换行。 */
	text: string;
	/** 这条消息的推理包含一个 redacted 块；其文本已经用文字说明了这一点。 */
	redacted?: boolean;
	/**
	 * 推理是否仍在到达。
	 *
	 * 文本本身不是 `running` 该管的事：它说的是这一行是否该保留动画，这与内容无关。thinking delta
	 * 置位它，text delta 清除它 —— 到那时推理已停，只有答案还在写 —— 消息结束也会清除它。基线的
	 * `partial` 可能带着推理而没有答案，那是窗口唯一必须猜测的情形：有思考没文本就仍在运行。
	 */
	running: boolean;
}

/**
 * 一次 assistant 请求上报的 token 用量，只保留底部信息条展示的字段。
 *
 * 它随 provider 返回它的那条消息到达，所以 chip 读的是那一轮自己的开销，而不是状态行携带的会话
 * 总计。
 */
export interface MessageUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export type Item =
	| {
			kind: "message";
			id: string;
			role: string;
			text: string;
			/** 消息被打上的时间戳，epoch 毫秒 —— 回合时钟的来源。 */
			timestamp?: number;
			/** 该请求上报的用量，当它是 assistant 消息且携带了用量时。 */
			usage?: MessageUsage;
			/** 这条消息文本之前的推理，provider 返回了才有。 */
			thinking?: MessageThinking;
			notice: boolean;
			streaming: boolean;
			/** 这条消息背后的存储条目，消息可从它派生分支时才有。 */
			forkEntryId?: string | null;
			/**
			 * 消息流式传输期间，最后一个 delta 落在的内容块。
			 *
			 * 完整消息以空行连接推理块、以空串连接文本块，所以打开*第二个* thinking 块的 delta 必须
			 * 自己携带那个空行 —— 这正是它与已打开块的又一个 delta 的区别。消息结束时丢弃它，因为
			 * 从那以后完整消息就是权威。
			 */
			streamBlock?: { kind: "text" | "thinking"; index: number };
	  }
	| { kind: "tools"; id: string; cards: ToolCard[] };

/**
 * 分支页的一种画法：正在读的线上的一条用户消息，或离开这条线的一条路。
 *
 * 这个页面围绕**线**而不是分支点构建。从未派生过的对话也有一条线 —— 它的用户消息，从旧到新 ——
 * 而这正是读者问"我能回到哪里"时想看的：他们问过的每个问题，按顺序，最新的一个在叶子所在处。
 * 一次派生是挂在其中一条下面的卡片。
 *
 * `entryId` 是存储条目，所以卡片的短 id 就是会话被移动到的那个 id，而不是装饰。`next` 是同一条
 * 线上的下一条用户消息，`branches` 是离开它的那些路。它们是两个字段而不是一个子列表，因为按下
 * 时两者含义不同：见 {@link BranchWay.landing}。
 */
export interface BranchWay {
	/** 这条路从哪个条目开始：切换时如何指名它，短 id 也是从它裁出来的。 */
	entryId: string;
	/** 指名这条路的一行 —— 用户消息自己的文本，或备选项的首行。 */
	label: string;
	/** 这条路的消息所在的回合；用户消息开启一个回合。 */
	turn: number;
	/**
	 * 线上紧随这条用户消息的 assistant 回答，直到下一条用户消息 —— 从分支页选中这张卡片时叶子
	 * 落到的条目。
	 *
	 * 落在回答而不是问题上，正是让回退可读的原因：对话回来时同时显示问题*和*它产出的内容，下一个
	 * 提示在回答之后派生新分支，那正是新问题该在的地方。这条路还没有回答时缺席 —— 最新的问题，或
	 * 一次没跑完的运行 —— 叶子于是落在消息本身上。
	 */
	replyId?: string;
	/** 同一条线上的下一条用户消息；线尾缺席。 */
	next?: BranchWay;
	/** 在这里离开这条线的那些路 —— 一个分支点的备选项。 */
	branches: BranchWay[];
	/**
	 * 按下这张卡片会发生什么。
	 *
	 * `here` 把叶子回退到这条路的问题产出的回答 —— 路还没有回答时是消息本身 —— 所以下一个提示
	 * 从那里开启第二条路：整个页面为之存在的手势。`tip` 沿这条路走到它自己的工作停下的地方，
	 * 这正是一张离开线的卡片的含义："带我去那里"。
	 */
	landing: "tip" | "here";
}

/**
 * 一个会话的完整分支形状，从快照折叠而来，随 transcript 生长。
 *
 * transcript 是热路径，`branchPoints` 过去搭在单条消息 item 上，那只回答"*这条*消息上挂着什么"。
 * 画页面需要一次拿到所有点，所以折叠在这里运行，视图读这个字段而不走 `items`。折叠在基线时运行
 * —— 唯一能改变这些点的帧 —— 并在每条消息结束时再跑一次，因为普通追加会延长线却不携带基线；见
 * {@link branchTreeFromItems}。
 */
export interface BranchTree {
	/** 正在读的线的第一条用户消息；线的其余部分挂在它的 `next` 上。 */
	trunk: BranchWay;
	/**
	 * 叶子所在的那条路：线上最新的用户消息。
	 *
	 * 仅对一条连用户消息都没有的对话为 undefined，那也是页面无物可画的唯一形状。
	 */
	currentId: string | undefined;
	/** 树里有多少个分支点；每个至少携带两条路。 */
	points: number;
	/** 树总共持有多少条路：线本身加上每个备选项。 */
	options: number;
	/** 线上的条目 id，绘制时把它们标为实线。 */
	line: ReadonlySet<string>;
}

/**
 * 把快照折叠成分支页要画的线。
 *
 * 线是活跃链上的**用户消息**，按链序：`snapshot.messages` 已经就是链（存储以叶子的祖先作答），
 * 而用户消息是人认得出"我做过的决定"的东西。assistant 回合不是节点 —— 它们是某条路*产出*的
 * 东西，卡片保存它们落地的那次按压，从不保存它们的文本。
 *
 * 离开线的路来自 `branchPoints`，它描述的是整份日志而不只是链：回退到第一个问题时，它下面的树
 * 仍然立着。
 *
 * 返回 `undefined` 表示无物可画：还没有用户消息的会话。
 */
export function buildBranchTree(snapshot: SessionSnapshot): BranchTree | undefined {
	return foldBranchLine(snapshot.messages, snapshot.messageEntryIds, snapshot.branchPoints);
}

/**
 * 同一次折叠，在基线之间由 live transcript 喂入。
 *
 * 基线是唯一能改变*点*的帧，但不是唯一改变*线*的东西：追加到末端的消息会延长它，而那次追加不携带
 * 基线。每条消息结束时从 transcript items 重建整棵树让页面保持最新 —— 点来自客户端最后收到的
 * 快照，普通追加不会让它失效，而线正是 items 已经是的东西：原地延长的链。
 *
 * 还没有条目 id 的 item 被跳过，方式与快照的 null 相同，所以跑赢了它的 `entry` 配对的帧的代价是
 * 一张卡片等到下一次基线，而不是一张错误的卡片。
 */
export function branchTreeFromItems(items: Item[], points: BranchPoint[]): BranchTree | undefined {
	const messages: { role: string; content: unknown }[] = [];
	const ids: (string | null)[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (item.kind !== "message") continue;
		if (item.role !== "user" && item.role !== "assistant") continue;
		// 同一个存储条目出现两次是一条路，不是两条 —— 修复中的 transcript 可以短暂同时持有两份
		// 副本，而折叠用条目 id 说话，第二份就是噪声。
		if (item.forkEntryId !== undefined && item.forkEntryId !== null) {
			if (seen.has(item.forkEntryId)) continue;
			seen.add(item.forkEntryId);
		}
		messages.push({ role: item.role, content: [{ type: "text", text: item.text }] });
		ids.push(item.forkEntryId ?? null);
	}
	return foldBranchLine(messages, ids, points);
}

/** 折叠本身：线上的用户消息、它们的回答、以及挂着备选项的分支点。 */
function foldBranchLine(
	messages: readonly { role?: string; content?: unknown }[],
	ids: readonly (string | null)[],
	points: readonly BranchPoint[],
): BranchTree | undefined {
	const line: { index: number; entryId: string; label: string; turn: number }[] = [];
	let round = 0;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index]!;
		if (message.role === "user") round += 1;
		if (message.role !== "user") continue;
		const entryId = ids[index];
		if (typeof entryId !== "string") continue;
		const text = contentToText(message.content);
		line.push({ index, entryId, label: firstLine(text), turn: round });
	}
	if (line.length === 0) return undefined;

	// 这条线，倒着建，让每张卡片的 `next` 是它后面的那一条。
	const ways: BranchWay[] = [];
	for (let at = line.length - 1; at >= 0; at -= 1) {
		const entry = line[at]!;
		const next = ways[0];
		ways.unshift({
			entryId: entry.entryId,
			label: entry.label.length > 0 ? entry.label : `轮 ${entry.turn}`,
			turn: entry.turn,
			...(next === undefined ? {} : { next }),
			branches: [],
			landing: "here",
		});
	}

	// 回退落在哪里：线上一个问题和下一个问题之间的最后一条 assistant 消息。是最后一条，不是
	// 第一条 —— 一个回合较早的 assistant 消息携带的是工具流量，人想在屏幕上找回的是回合结束时
	// 的那条回答。
	const byIndex = new Map(line.map((entry, at) => [entry.index, at]));
	let tail: { entryId: string } | undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!;
		if (message.role === "user") {
			const at = byIndex.get(index);
			const host = at === undefined ? undefined : ways[at];
			if (host !== undefined && tail !== undefined) host.replyId = tail.entryId;
			tail = undefined;
			continue;
		}
		if (message.role !== "assistant") continue;
		const entryId = ids[index];
		if (typeof entryId !== "string") continue;
		// 倒着扫描时，第一个命中的就是回合的最后一条，而一条只由工具调用组成的条目即使没有文本，
		// 也仍然指名一个可落地的位置。
		if (tail === undefined) tail = { entryId };
	}

	// 每个分支点把它的备选项挂在 `anchor` 指名的卡片下面：对线上的点，是它或其上方最后的问题；
	// 对没人读的某条路下面的点，是那条路自己的卡片。卡片随绘制被收集，所以一个点可以挂在更早的
	// 点造出的卡片上 —— 服务端先交祖先的点。
	const cards = new Map<string, BranchWay>(ways.map((way) => [way.entryId, way]));
	let options = 1;
	for (const point of points) {
		const host = cards.get(point.anchor);
		// transcript 无法安放（条目上方没有用户消息，或窗口从未画过）的卡片丢弃它的点，而不是把它
		// 挂在不属于它的地方。
		if (host === undefined) continue;
		// 一条路以一个问题开启，所以挂在宿主上的每张卡都比宿主卡片指名的问题晚一轮被问出。
		const turn = host.turn + 1;
		for (const option of point.options) {
			// 活跃选项就是这条线本身：它的消息已经在上面，更靠右。
			if (option.active) continue;
			const branch: BranchWay = {
				entryId: option.entryId,
				// 开场消息没有自己文本的路，以上面的问题指名：卡片只有一行，没有名字的卡片是树上
				// 的一个洞。
				label: option.label.length > 0 ? option.label : point.prompt,
				turn,
				branches: [],
				landing: "tip",
			};
			host.branches.push(branch);
			cards.set(branch.entryId, branch);
			options += 1;
		}
	}

	return {
		trunk: ways[0]!,
		currentId: ways.at(-1)?.entryId,
		points: points.length,
		options,
		line: new Set(ways.map((way) => way.entryId)),
	};
}

/** 消息的第一行，一张卡片只有这么多空间。 */
function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0) return trimmed.replace(/^#{1,6}\s+/, "");
	}
	return "";
}

/** 一个 id 所指名的路，无论它挂在树的哪里。 */
export function findWay(tree: BranchTree, id: string): BranchWay | undefined {
	const walk = (way: BranchWay | undefined): BranchWay | undefined => {
		if (way === undefined) return undefined;
		if (way.entryId === id) return way;
		for (const branch of way.branches) {
			const hit = walk(branch);
			if (hit !== undefined) return hit;
		}
		return walk(way.next);
	};
	return walk(tree.trunk);
}

/** 会话正在等待的一次退避，从 `retry_scheduled` 到 `retry_end`。 */
export interface RetryState {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
}

/** transcript 还没有可以挂上去的 item 之前，服务端先指名的条目。 */
export interface PendingEntry {
	entryId: string;
	messageTimestamp?: number;
}

export interface ViewState {
	/**
	 * 服务端是否应答请求。
	 *
	 * 这是过去的 `connected`，换了个说出它度量什么的名字：一次成功的 `fetch` 置位它，一次根本没
	 * 到达服务器的 `fetch` 清除它。刻意*不*是 mux 通道可用的同一事实 —— 两者异步地给出不同答案，
	 * 从一个推导另一个是用已知事实换猜测。通道断开而它为真是正常状态：窗口仍然能发送，请求自己
	 * 会作答。
	 *
	 * 不被 {@link reduce} 触碰，因为它是关于连接的事实而不是关于某个会话的，而基线是关于一个
	 * 会话的。
	 */
	reachable: boolean;
	snapshot?: SessionSnapshot;
	items: Item[];
	/** 其消息还没有出现在 `items` 里的条目 id。 */
	pendingEntries: PendingEntry[];
	/** 会话的分支形状，每个快照折叠一次，供头部的条目和分支页使用。 */
	branchTree?: BranchTree;
	streaming: boolean;
	usage: UsageTotals;
	approvals: PendingApproval[];
	/** 循环尚未排干的已接受消息，按服务端最后一次发布的版本。 */
	queued: QueuedPrompt[];
	/** 进行中的一次重试，供头部的重试行使用。 */
	retry?: RetryState;
	/** 用户导入的模型，供设置面板和会话的模型选择器使用。 */
	models: ModelOption[];
	/** 主题、字号和审批集。服务端应答过一次之前缺席。 */
	settings?: GlobalSettingsSnapshot;
	/** 本构建注册的工具名清单（ADR-0020），启动时从 `GET /api/tools` 取一次。拉取应答之前缺席。 */
	toolNames?: string[];
	error?: string;
}

export function initialState(): ViewState {
	return {
		reachable: false,
		items: [],
		pendingEntries: [],
		streaming: false,
		usage: { ...EMPTY_USAGE },
		approvals: [],
		queued: [],
		models: [],
	};
}

/**
 * 应用本窗口的外观设置。
 *
 * 每次外观变更都调用，而不只在启动时，因为面板在实时编辑这些值：字号是字阶的基 —— 滑块的值直接
 * 落在 `--dsw-fs-base` 上，每个层级从它推导（tokens.css），所以整个窗口随之缩放，无需逐层布线。
 * 主题是一个属性，两者都不需要重载才生效，任何一个需要重载，面板就会让人觉得坏了。
 *
 * 侧栏的宽度走同一条路，只有一处不对称：存储的是*偏好*，读取时已经按拖动范围截断，所以落到
 * 这里的总是可绘制的。设置从未携带过宽度时是移除变量，而不是制造一个默认值 —— 样式表自己的值
 * 就是默认，"从未拖过"必须与"拖到了默认值"保持可区分。
 */
export function applyAppearance(appearance: AppearanceSettings): void {
	const root = document.documentElement;
	const theme = appearance.theme;
	root.dataset.theme =
		theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
	root.style.setProperty("--dsw-fs-base", `${appearance.fontSize}px`);
	const sidebarWidth = appearance.sidebarWidth;
	if (sidebarWidth === undefined) root.style.removeProperty("--dsw-sidebar-width");
	else root.style.setProperty("--dsw-sidebar-width", `${sidebarWidth}px`);
}

/**
 * 把一条协议消息折叠进视图状态。
 *
 * item 以消息时间戳为键，agent 为每条消息赋一次并在每个 `message_update` 里重复，所以流式更新
 * 落在它们所属的 item 上。
 */
export function reduce(viewState: ViewState, message: ServerMessage): ViewState {
	switch (message.type) {
		case "baseline":
			return {
				...viewState,
				snapshot: message.session,
				items: itemsFromSnapshot(message.session),
				// 分支形状随同一个帧走：快照是唯一能改变点的东西，所以折叠在这里跑，也在每条消息结束
				// 线生长时跑。
				branchTree: buildBranchTree(message.session),
				// 快照携带它所显示的一切的 id，所以没有东西留在外面。
				pendingEntries: [],
				streaming: message.session.running,
				usage: message.session.usage,
				approvals: message.session.pendingApprovals,
				queued: message.session.queued,
				// 清除而不是保留，也不从快照重建：倒计时只可能来自调度退避的那个帧，快照知道有一次
				// 重试在进行，却不知道还剩多久。把旧值带过重连，会显示一个这条流从未看过开始的退避
				// 的倒计时。头部行仍然显示"重试中"，依据快照自己的标志。
				retry: undefined,
				// `error` 跨基线存活。它是一次失败操作的记录，唯一应该抹掉它的是下一次操作成功 ——
				// 一次成功的重连不是用户的操作之一。在这里清除它，意味着一个在通道断开期间失败的
				// 会话，在通道恢复的那一刻悄悄原谅了自己，这恰恰是这个通知要让它可见的失败。
				error: viewState.error,
			};
		case "entry": {
			const drained = drainEntries(viewState.items, [{ entryId: message.entryId, messageTimestamp: message.messageTimestamp }]);
			return {
				...viewState,
				items: drained.items,
				pendingEntries: [...viewState.pendingEntries, ...drained.pending].slice(-PENDING_ENTRIES),
			};
		}
		case "status":
			return {
				...viewState,
				usage: message.usage,
				streaming: message.running,
				queued: message.queued,
				snapshot: viewState.snapshot
					? {
							...viewState.snapshot,
							running: message.running,
							queued: message.queued,
							isRetrying: message.isRetrying,
							retryAttempt: message.retryAttempt,
						}
					: undefined,
			};
		case "error":
			return { ...viewState, error: message.message };
		case "approval_request": {
			// 等待中的调用在这里拿到自己的卡片，而不是来自 `tool_execution_start`：循环从不宣告一个
			// 挂起的调用，所以这个帧是窗口对它的首次知晓 —— 在 end-restart 语义下（ADR-0005 §5），
			// 这也是会话记录唯一的线索，说明运行结束*在*这个调用处而不是它周围。
			return {
				...viewState,
				approvals: [
					...viewState.approvals.filter((approval) => approval.toolCallId !== message.request.toolCallId),
					message.request,
				],
				items: upsertTool(viewState.items, message.request.toolCallId, {
					toolCallId: message.request.toolCallId,
					toolName: message.request.toolName,
					args: message.request.args,
					output: "",
					isError: false,
					running: false,
					waiting: true,
				}),
			};
		}
		case "approval_settled": {
			// 审批离开台账，横幅随之摘除。这帧只说"定案了"，不说定成了什么——卡片的命运由结果
			// 自己讲：允许由恢复运行的 `tool_execution_start` 翻回运行中；拒绝由那次关闭自己的
			// `tool_execution_end` 定论（恢复遍的合成结果，或批量拒绝写下的结束事件——两者都
			// 以事件说出自己的文本）。settled 帧本身只是"不再有答案可等"的通告。
			return { ...viewState, approvals: viewState.approvals.filter((approval) => approval.toolCallId !== message.toolCallId) };
		}
		case "event":
			return applySessionEvent(viewState, message.event);
		default:
			return viewState;
	}
}

/**
 * 折叠一条逻辑流的结束。
 *
 * 不是 {@link reduce} 的分支，因为它不是 `ServerMessage`：`end` 是关闭流的帧，所以它位于消息之旁
 * 而非其中，给它自己的 `type` 会把一个流控制事实塞进载荷词汇表。
 *
 * 两样东西变化，一样刻意不变。
 *
 * `approvals` 被清空。基线播种它，逐审批的帧维护它，而 `end` 之后这条流不会再有基线来重新播种
 * —— 留下的横幅是一张它的答案永远无法经这条流上报回去的卡片。在 end-restart 语义下
 * （ADR-0005 §5）等待中的答案住在台账而不是这个状态里，所以清空没有丢掉任何真实的东西：每条
 * 终结被观看流的路径都已经送达了它的结算帧（被收割的会话在关闭前拒绝；被删除的会话不可能还
 * 持有审批），而回来的页面会重新订阅并从它的基线读出仍未回答的问题。这是唯一清空列表的地方，
 * 它在这里而不是基线分支，因为基线分支对仍然打开的流已经是正确的答案。
 *
 * `streaming` 停止，因为一次运行不可能活得比上报它的流更久。旧代码在自己的流结束 handler 里
 * 设置它，重写时会丢掉；把它折叠在这里，状态就有一个知道 end 意味着什么的地方。
 *
 * `items` 保留。会话记录属于会话，不属于承载它的流 —— 清空它会因为连接消失而丢掉窗口画过的
 * 一切。
 */
export function reduceEnd(viewState: ViewState): ViewState {
	return { ...viewState, approvals: [], streaming: false };
}

/**
 * 折叠一条会话事件。
 *
 * union 是扁平的，所以循环的事件保持它们一直以来的处理，会话自己的成员是并列的分支。
 * `entry_appended` 被刻意吞掉：transcript 从消息构建，浏览器还无法渲染的存储条目绝不能作为一条
 * 消息出现。
 */
function applySessionEvent(viewState: ViewState, event: AgentSessionEvent): ViewState {
	switch (event.type) {
		case "agent_start":
			return { ...viewState, streaming: true, error: undefined };
		case "agent_end":
			return { ...viewState, streaming: false };
		case "message_start":
		case "message_end": {
			const items = upsertMessage(viewState.items, event.message, event.type === "message_end");
			// 用户条目在循环回显它之前先被指名，所以它的 id 在这里等待 item。
			const drained = drainEntries(items, viewState.pendingEntries);
			const next: ViewState = { ...viewState, items: drained.items, pendingEntries: drained.pending };
			// 分支线随 transcript 生长：一条结束的消息要么开启新的路（用户消息），要么回答最后一条
			// （assistant 消息），而普通追加不携带基线。点不可能移动过 —— 只有基线或叶子移动会改变
			// 它们 —— 所以快照自己的点在这里仍是真相。没有这次重建，页面和头部的条目会冻结在上一次
			// 基线携带的形状上。
			if (event.type === "message_end" && viewState.snapshot !== undefined) {
				next.branchTree = branchTreeFromItems(drained.items, viewState.snapshot.branchPoints);
			}
			return next;
		}
		case "message_update":
			// 是 delta，不是消息：它指名的 item 按到达的字符增长，这里任何东西都不会重读答案去找
			// 移动了什么。
			return { ...viewState, items: appendDelta(viewState.items, event.delta) };
		case "tool_execution_start":
			// `waiting: false` 是恢复的运行自己的提示（ADR-0006 §5）：允许重新发出当初被回答的那个
			// 调用，一直在等待的卡片回到执行中。
			return { ...viewState, items: upsertTool(viewState.items, event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				output: "",
				isError: false,
				running: true,
				waiting: false,
			}) };
		case "tool_execution_update":
			return { ...viewState, items: upsertTool(viewState.items, event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				output: contentToText(event.partialResult),
				isError: false,
				running: true,
				waiting: false,
			}) };
		case "tool_execution_end":
			// 循环的结束事件指名调用及其结果，但没有发起调用时的参数，所以参数留在开始事件放置它们
			// 的地方：卡片继续指名它运行了什么。
			return { ...viewState, items: upsertTool(viewState.items, event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				output: contentToText(event.result),
				isError: event.isError,
				running: false,
				waiting: false,
				diff: fileDiffOf(event.result),
			}) };
		case "turn_end": {
			const usage = assistantUsage(event.message);
			return usage ? { ...viewState, usage: addUsage(viewState.usage, usage, viewState.usage.contextWindow) } : viewState;
		}
		case "queue_update":
			return {
				...viewState,
				queued: event.queued,
				snapshot: viewState.snapshot ? { ...viewState.snapshot, queued: event.queued } : undefined,
			};
		case "compaction":
			// 摘要是 transcript 对被折叠内容的记录，所以这条注释携带摘要而不是计数：读者能看到
			// agent 还知道什么。
			return {
				...viewState,
				items: appendNote(
					viewState.items,
					`[上下文已压缩：${event.summarized} 条消息被总结，压缩前约 ${event.tokensBefore} tokens，当前上下文约 ${event.contextTokens} tokens。]\n\n${event.summary}`,
				),
			};
		case "compaction_failed":
			return { ...viewState, items: appendNote(viewState.items, `[压缩失败：${event.message}]`) };
		case "tool_results_cleared":
			// 被清理的结果在 transcript 里自带通知，所以这一行只需要说清去了多少、价值几何 ——
			// 消息本身已经显示了变化。
			return {
				...viewState,
				items: appendNote(
					viewState.items,
					`[已清理 ${event.cleared} 条过期工具结果：清理前约 ${event.tokensBefore} tokens，当前上下文约 ${event.contextTokens} tokens。]`,
				),
			};
		case "tool_call_args_trimmed":
			// 被缩短的调用在 transcript 里自带 "... [truncated] ..." 标记，所以这一行只需要说清去了
			// 多少、价值几何。
			return {
				...viewState,
				items: appendNote(
					viewState.items,
					`[已缩短 ${event.trimmed} 次工具调用的记录参数：缩短前约 ${event.tokensBefore} tokens，当前上下文约 ${event.contextTokens} tokens。]`,
				),
			};
		case "retry_scheduled":
			return {
				...viewState,
				// 被放弃尝试的部分 item 随它而去：重试会在服务端原位替换那条消息，一个答案两条 item
				// 是折叠绝不能做的事。
				items: appendNote(
					dropStreamingAssistant(viewState.items),
					retryingLine(event.attempt, event.maxAttempts, event.delayMs, event.errorMessage),
				),
				retry: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs },
				snapshot: viewState.snapshot
					? { ...viewState.snapshot, isRetrying: true, retryAttempt: event.attempt }
					: undefined,
			};
		case "retry_start":
			// 退避已结束，重试的调用正在进行，所以这一行失去倒计时但保留到循环结束。
			return {
				...viewState,
				retry: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: 0 },
			};
		case "retry_end":
			return {
				...viewState,
				retry: undefined,
				snapshot: viewState.snapshot ? { ...viewState.snapshot, isRetrying: false, retryAttempt: 0 } : undefined,
			};
		case "config_changed": {
			// 配置变更不会随发新的快照，所以头部的副本就地修补。
			if (!viewState.snapshot) return viewState;
			const snapshot = { ...viewState.snapshot };
			if (event.model !== undefined) snapshot.model = event.model;
			if (event.thinkingLevel !== undefined) snapshot.thinkingLevel = event.thinkingLevel;
			// 模式座位的变更显式携带：`null` 是「回到默认」，键缺席才是「没动」。
			if ("mode" in event) snapshot.mode = event.mode ?? undefined;
			return { ...viewState, snapshot };
		}
		case "entry_appended":
			return viewState;
		default:
			return viewState;
	}
}

/** 追加一条 transcript 注释 —— 会话做的一件事，渲染在消息所在的位置。 */
function appendNote(items: Item[], text: string): Item[] {
	const ordinal = items.filter((item) => item.kind === "message" && item.role === "system").length;
	return [...items, { kind: "message", id: `note:${ordinal}`, role: "system", text, notice: true, streaming: false }];
}

/** 重试行：transcript 的注释携带错误，头部的文案不携带。 */
export function retryingLine(attempt: number, maxAttempts: number, delayMs: number, errorMessage?: string): string {
	const line = `${delayMs > 0 ? `将在 ${retrySeconds(delayMs)} 秒后重试` : "正在重试"}（第 ${attempt}/${maxAttempts} 次）`;
	return errorMessage === undefined ? line : `${line}：${errorMessage}`;
}

function retrySeconds(delayMs: number): number {
	return delayMs >= 1000 ? Math.round(delayMs / 1000) : Number((delayMs / 1000).toFixed(1));
}

/** 丢弃流式中的 assistant item，一次重试已经放弃了它。 */
function dropStreamingAssistant(items: Item[]): Item[] {
	const last = items.at(-1);
	return last?.kind === "message" && last.role === "assistant" && last.streaming ? items.slice(0, -1) : items;
}

function itemsFromSnapshot(snapshot: SessionSnapshot): Item[] {
	let items: Item[] = [];
	snapshot.messages.forEach((message, index) => {
		items = replayMessage(items, message, snapshot.messageEntryIds?.[index] ?? undefined);
	});
	// 进行中的会话会以它此刻正在写的消息作答，存储还没有它；冷读取从不携带。画出它是让一个在运行
	// 中途接入的窗口，能显示后续 delta 将要续写的那句话的开头。
	if (snapshot.partial !== undefined) {
		const reasoning = thinkingOf((snapshot.partial as { content?: unknown }).content);
		// 有推理还没有答案时，这一行按定义仍在运行；第一个文本 delta 清除它。
		const phase = reasoning !== undefined ? "thinking_delta" : undefined;
		items = upsertMessage(items, snapshot.partial, false, undefined, phase);
	}
	// 不在提交中的快照不可能有调用正在执行，所以它留下的未答卡片是一份被截断的记录 —— 结果写入
	// 之前就分出的分支 —— 而不是一条活的。定论它们让重新打开的会话记录不在历史上空转；提交中
	// 的快照跳过这一步，因为它 live 的 `tool_execution_end` 还会到来并自行修补卡片。
	//
	// 快照指名为等待审批的调用（ADR-0005 §5）是例外：end-restart 语义下悬空的调用不是被截断的
	// 记录，而是一个仍然站着的问题 —— 运行在门处结束，答案尚未到达。这些卡片在扫尾之后被标记为
	// 等待，所以重新打开的会话记录显示的是暂停，而不是一张没有输出的已完成卡片。
	if (!snapshot.running) items = settleCards(items);
	for (const approval of snapshot.pendingApprovals) {
		items = patchCard(items, approval.toolCallId, { running: false, waiting: true });
	}
	return items;
}

/**
 * 按其 live 到达时的方式折叠一条持久化的消息。
 *
 * 消息本身照旧经过 {@link upsertMessage}。它内部的工具块经过 {@link upsertTool} —— 与循环的
 * `tool_execution_*` 事件喂的同一个卡片构造器 —— 所以重新打开的 transcript 由被观看运行画过的
 * 同一批卡片重建：调用的名字与参数来自 assistant 消息的 `toolCall` 块，结果来自按 id 应答它的
 * `toolResult` 消息。那个配对就是全部的修复：只重建消息的重放会在重开时丢掉整个工具过程，而不
 * 只是结果。
 */
function replayMessage(items: Item[], message: unknown, entryId: string | null | undefined): Item[] {
	items = upsertMessage(items, message, true, entryId);
	const record = message as { role?: unknown; content?: unknown };
	if (record.role === "toolResult") return replayResult(items, message);
	if (!Array.isArray(record.content)) return items;
	for (const block of record.content) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
		if (typed.type !== "toolCall" || typeof typed.id !== "string") continue;
		// 按开始事件创建它的方式创建：运行中，无输出。结果消息会定论它。
		items = upsertTool(items, typed.id, {
			toolCallId: typed.id,
			toolName: typeof typed.name === "string" ? typed.name : "tool",
			args: typed.arguments,
			output: "",
			isError: false,
			running: true,
		});
	}
	return items;
}

/** 与 `tool_execution_end` 携带的同一份补丁，从文件保存的结果消息里读出。 */
function replayResult(items: Item[], message: unknown): Item[] {
	const record = message as { toolCallId?: unknown; toolName?: unknown; isError?: unknown };
	if (typeof record.toolCallId !== "string") return items;
	return upsertTool(items, record.toolCallId, {
		toolCallId: record.toolCallId,
		toolName: typeof record.toolName === "string" ? record.toolName : "tool",
		// 两者都按结束事件的方式读整个结果：文本来自它的 content，diff 来自它的 `details`。
		output: contentToText(message),
		isError: record.isError === true,
		running: false,
		waiting: false,
		diff: fileDiffOf(message),
	});
}

/** 定论快照留下的每张无结果卡片，让一份已结束的 transcript 不显示任何运行中的卡片。 */
function settleCards(items: Item[]): Item[] {
	return items.map((item) => {
		if (item.kind !== "tools" || !item.cards.some((card) => card.running)) return item;
		return { ...item, cards: item.cards.map((card) => (card.running ? { ...card, running: false } : card)) };
	});
}

function upsertMessage(
	items: Item[],
	message: unknown,
	final: boolean,
	forkEntryId: string | null | undefined = undefined,
	phase?: string,
): Item[] {
	const record = message as {
		role?: string;
		content?: unknown;
		timestamp?: number;
		usage?: unknown;
		errorMessage?: string;
	};
	const role = record.role ?? "unknown";
	if (role === "toolResult") return items;

	// 推理在这里拆出，而不是在 `contentToText` 里 —— 工具输出也共用那个函数：工具路径必须把
	// thinking 块继续折叠进文本，而消息要把两者分开。工具调用被丢弃的理由与工具输出路径保留它们的
	// 理由相同：调用不是模型的文字，它有自己的 item —— 重放和循环都会构建的 tools 组 —— 所以把
	// 它折叠进正文成为 `[调用 name]` 是剩下的唯一把正文弄丑的东西（07）。内容只有调用的消息因此
	// 没有正文，在下面被丢弃。
	const thinking = thinkingOf(record.content);

	// 压缩检查点以包在压缩标签里的用户消息跨快照传递：剥掉标签后的文本是摘要，是 transcript 里
	// 唯一代表模型不再逐字拥有的历史的东西。
	const summary =
		role === "user"
			? compactionSummaryOf({ role: "user", content: record.content, timestamp: 0 } as Message)
			: undefined;
	// 检查点保留它一直以来的显示角色：它不是用户说的话，所以用户气泡的复制席位和右键菜单绝不能
	// 够到它。
	const displayRole = summary !== undefined ? "compactionSummary" : role;
	let text = summary ?? contentToText(withoutToolCalls(withoutThinking(record.content)));
	if (text.length === 0 && role === "assistant" && final && typeof record.errorMessage === "string") {
		text = `错误：${record.errorMessage}`;
	}

	const id = `${displayRole}:${String(record.timestamp ?? "unknown")}`;
	let list = items;
	let index = indexOfMessage(list, id);
	// 一个尚未被循环展示过的消息的开始或推进帧，没有资格指向一个*已完成*的 item：循环对每条消息
	// 宣告一次，并在结束前流式它的更新，所以匹配到一个已完成 id 的，指的是另一条消息 —— 同一毫秒
	// 打上两次时间戳（07）。原地替换会把新来者的正文画在旧答案的位置上，把 transcript 在一个用户
	// 气泡周围劈开（16），所以完成的 item 被改名让开，新来者占据自己的更新将要到达的普通 id。
	//
	// 这在下面的"无物可画"返回之前运行：`message_start` 携带空消息，但它仍然是认领身份的帧。
	// 不在这里把它挪开，随后的第一个 delta 就会落在这条消息取代的那个答案上。
	if (index !== -1 && !final && !(list[index] as Extract<Item, { kind: "message" }>).streaming) {
		// 同一条消息出现两次，不是这次改名要对付的碰撞。一条落在乐观提示写入与循环自己的回显之间
		// 的基线 —— 切过去的分支在提示被追加的那一刻发出的 `branch_changed` 帧 —— 会把存储的副本
		// 重放成已完成 item，随后到来的回显就是那条消息，不是新来者。把它改名让开会把提示画两次，
		// 而且回显的 item 也因此不带条目 id，分支线就丢了它的派生席位。同一毫秒打上时间戳的两种
		// 不同消息绝不共享文本，所以文本就是区分它们的东西。
		const finished = list[index] as Extract<Item, { kind: "message" }>;
		const sameMessage = finished.role === displayRole && finished.text === text && text.length > 0;
		if (!sameMessage) {
			list = renameMessage(list, index, freeMessageId(list, id));
			index = -1;
		}
	}

	// 有文本的消息被保留；只有推理的也保留，因为那正是折叠行的全部意义 —— 它在答案还是空的时就
	// 出现。其余的是不携带任何可画东西的帧。
	if (text.length === 0 && (thinking === undefined || thinking.text.length === 0)) return list;

	const notice = summary !== undefined || text.startsWith("[上下文已压缩：") || text.startsWith("错误：");
	const existing = index === -1 ? undefined : (list[index] as Extract<Item, { kind: "message" }>);
	const carried = forkEntryId ?? existing?.forkEntryId;
	const item: Extract<Item, { kind: "message" }> = { kind: "message", id, role: displayRole, text, notice, streaming: !final };
	// 时间戳和用量骑在消息本身上，所以重新打开的 transcript 画出与被观看运行相同的 meta 行。
	// 两者都以普通 JSON 跨进程边界，因此有守卫。
	if (typeof record.timestamp === "number") item.timestamp = record.timestamp;
	if (role === "assistant") item.usage = messageUsageOf(record.usage);
	if (thinking !== undefined) {
		const running = !final && (phase === "thinking_start" || phase === "thinking_delta");
		item.thinking = thinking.redacted ? { text: thinking.text, redacted: true, running } : { text: thinking.text, running };
	}
	// 流式更新不携带条目 id，所以已经挂在这个 item 上的 id 被保留。
	if (carried !== undefined && carried !== null) item.forkEntryId = carried;

	if (index === -1) {
		// 新消息结束当前的工具组，所以随后的卡片属于它。
		return [...list, item];
	}
	const next = [...list];
	next[index] = item;
	return next;
}

/**
 * 把一个 delta 折叠进它指名的消息。
 *
 * item 由第一个 delta 创建，而不是由 `message_start`：start 宣告的是一条内容仍为空的消息，一个
 * 空回合会为一帧而存在然后再填上。transcript 画的是第一个字符，而不是包裹它的信封。
 *
 * 没有 item 可落的 delta 被丢弃。那是一条在本窗口到达之前就结束了的消息，`message_end` 帧会完整
 * 携带它 —— 代价只是字符没有早一刻被画出；而凭空发明一个 item，会在答案从未有过的地方画出一段
 * 碎片。
 */
function appendDelta(items: Item[], delta: MessageDelta): Item[] {
	const id = `assistant:${delta.timestamp}`;
	const index = indexOfMessage(items, id);
	if (index === -1) {
		const item: Extract<Item, { kind: "message" }> = {
			kind: "message",
			id,
			role: "assistant",
			text: "",
			timestamp: delta.timestamp,
			notice: false,
			streaming: true,
		};
		return [...items, withDelta(item, delta)];
	}
	const next = [...items];
	next[index] = withDelta(items[index] as Extract<Item, { kind: "message" }>, delta);
	return next;
}

/**
 * 折叠了一个 delta 的消息 item —— 同一个 item，字符追加。
 *
 * 拼接规则与完整消息一致：推理块之间以空行分隔，文本块之间不分隔，所以打开*新*块的 delta 带着那个
 * 分隔符来，其他 delta 都是普通追加。文本从不重读，这正是要点：一个帧的成本就是它携带的字符。
 */
function withDelta(item: Extract<Item, { kind: "message" }>, delta: MessageDelta): Item {
	const open = item.streamBlock;
	const joining = open !== undefined && open.kind === delta.kind && open.index === delta.contentIndex;
	if (delta.kind === "thinking") {
		const previous = item.thinking?.text ?? "";
		const separator = previous.length > 0 && !joining ? "\n\n" : "";
		const thinking: MessageThinking = { text: previous + separator + delta.text, running: true };
		if (item.thinking?.redacted === true) thinking.redacted = true;
		return { ...item, thinking, streamBlock: { kind: "thinking", index: delta.contentIndex } };
	}
	const text = item.text + delta.text;
	const next: Extract<Item, { kind: "message" }> = {
		...item,
		text,
		notice: item.notice || text.startsWith("错误："),
		streamBlock: { kind: "text", index: delta.contentIndex },
	};
	if (item.thinking !== undefined) next.thinking = { ...item.thinking, running: false };
	return next;
}

/** `id` 的第一个未用变体，给两条被打上相同时间戳的消息。 */
function freeMessageId(items: Item[], id: string): string {
	for (let n = 1; ; n += 1) {
		const candidate = `${id}#${n}`;
		if (!items.some((existing) => existing.kind === "message" && existing.id === candidate)) return candidate;
	}
}

/** 原位替换一个消息 item 的 id，位置与内容都不动。 */
function renameMessage(items: Item[], index: number, id: string): Item[] {
	const next = [...items];
	next[index] = { ...(next[index] as Extract<Item, { kind: "message" }>), id };
	return next;
}

/**
 * 按 id 查消息 item 的下标，找不到为 -1。
 *
 * 流式消息 —— 每个 `message_update` 指名的那个 —— 是最后一个 item，所以先查尾部，线性扫描只是
 * 兜底。这让常见帧不用走完整份 transcript 才找到它要替换的东西。（下面的数组拷贝才是 O(items)
 * 的部分：状态不可变，item 变了就意味着新数组，而索引会是对 {@link ViewState} 形状的变更，为的
 * 是一个本来就很小的成本。）
 */
function indexOfMessage(items: Item[], id: string): number {
	const tail = items.at(-1);
	if (tail !== undefined && tail.kind === "message" && tail.id === id) return items.length - 1;
	return items.findIndex((item) => item.kind === "message" && item.id === id);
}

/**
 * 消息内容里的推理块，从它们所在的数组里取出。
 *
 * 只有数组能装块；纯字符串或嵌套的 `{ content }` 兜底都是文本，没有可找的推理。块保持顺序并以
 * 空行连接，段落断行因此存活到推理行渲染的 Markdown 里。redacted 块是同一形状加上
 * `redacted: true`，其文本已经写着 "[Reasoning redacted]"，所以不需要第二个字段。
 */
function thinkingOf(content: unknown): { text: string; redacted: boolean } | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	let redacted = false;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as { type?: unknown; thinking?: unknown; redacted?: unknown };
		if (typed.type !== "thinking") continue;
		parts.push(String(typed.thinking ?? ""));
		if (typed.redacted === true) redacted = true;
	}
	if (parts.length === 0) return undefined;
	return { text: parts.join("\n\n"), redacted };
}

/** 同一份内容丢掉某一种块，给按不同方式读取它的路径。 */
function withoutBlocks(content: unknown, type: string): unknown {
	if (!Array.isArray(content)) return content;
	return content.filter(
		(block) => !(typeof block === "object" && block !== null && (block as { type?: unknown }).type === type),
	);
}

/** 同一份内容丢掉推理块，给文本路径。 */
function withoutThinking(content: unknown): unknown {
	return withoutBlocks(content, "thinking");
}

/**
 * 同一份内容丢掉工具调用块，给消息文本路径。
 *
 * 只有消息正文会经过这个过滤器，也只有正文不能把调用读成文字：调用的 item 是 tools 组，循环的
 * 事件和重放都会构建它。工具输出路径保持 {@link contentToText} 完整 —— 结果不携带调用，那里
 * 没有东西可供过滤器发现。
 */
function withoutToolCalls(content: unknown): unknown {
	return withoutBlocks(content, "toolCall");
}

/**
 * 把条目 id 挂到它们所属消息的 item 上。
 *
 * item 以 `role:timestamp` 为键，而存储条目持有的正是循环回显的那条消息，所以时间戳就是配对它们
 * 的东西。item 还没出现的条目保持挂起。
 */
function drainEntries(items: Item[], pending: PendingEntry[]): { items: Item[]; pending: PendingEntry[] } {
	if (pending.length === 0) return { items, pending };

	const rest: PendingEntry[] = [];
	let next = items;
	for (const entry of pending) {
		const index = next.findIndex(
			(item) => item.kind === "message" && !item.forkEntryId && item.id.endsWith(`:${String(entry.messageTimestamp)}`),
		);
		if (index === -1) {
			rest.push(entry);
			continue;
		}
		const copy = [...next];
		copy[index] = { ...(next[index] as Extract<Item, { kind: "message" }>), forkEntryId: entry.entryId };
		next = copy;
	}
	return { items: next, pending: rest };
}

/** 最多持有多少个已指名但未匹配的条目；一个回合的量远少于这个。 */
const PENDING_ENTRIES = 20;

/**
 * 只修补调用已有的卡片，绝不新建。
 *
 * {@link upsertTool} 是构造器的路 —— 关于窗口还没画过的调用的帧会画出它。这个 helper 服务的帧
 * 相反：是对一张卡片可能已经消失的调用的判决（transcript 已经前进后到达的拒绝），此时为窗口从未
 * 展示过的调用凭空发明一张卡片，会在 transcript 里放一个幽灵。
 */
function patchCard(items: Item[], toolCallId: string, patch: Partial<ToolCard>): Item[] {
	let changed = false;
	const next = items.map((item) => {
		if (item.kind !== "tools" || !item.cards.some((candidate) => candidate.toolCallId === toolCallId)) return item;
		changed = true;
		return {
			...item,
			cards: item.cards.map((candidate) => (candidate.toolCallId === toolCallId ? { ...candidate, ...patch } : candidate)),
		};
	});
	return changed ? next : items;
}

/**
 * 把一个工具事件折叠进它所属的卡片。
 *
 * 事件携带它知道的东西，不是整张卡片：开始事件有参数没结果，结束事件有结果没参数。所以卡片逐字段
 * 修补，事件沉默的一切保持原样，这让一张已完成的卡片能说出被调用的是什么。
 */
function upsertTool(items: Item[], toolCallId: string, patch: Partial<ToolCard> & { toolName: string }): Item[] {
	// 先走修补的路：这个调用的卡片在原地被修补，无论它坐在哪里。只有当遍历没找到可修补的东西时
	// —— `patchCard` 以收到的原数组作答 —— 才在下面变成一次构造。
	const patched = patchCard(items, toolCallId, patch);
	if (patched !== items) return patched;

	const card: ToolCard = {
		toolCallId,
		args: undefined,
		output: "",
		isError: false,
		running: true,
		...patch,
	};

	// 同一回合的卡片共享紧跟那个回合 assistant 消息之后的组。
	const last = items.at(-1);
	if (last?.kind === "tools" && last.cards.every((candidate) => candidate.running)) {
		const updated = [...items];
		updated[updated.length - 1] = { ...last, cards: [...last.cards, card] };
		return updated;
	}
	return [...items, { kind: "tools", id: `tools:${toolCallId}`, cards: [card] }];
}

/** 一份报告可能携带的行种类；其他任何东西都不是这个客户端理解的报告。 */
const DIFF_KINDS: ReadonlySet<string> = new Set(["add", "remove", "context", "skip"]);

/**
 * 工具结果里的 diff，当它带有一个时。
 *
 * 结果跨进程边界、以普通 JSON 到达，所以它的形状不能从发出时描述它的类型推定：只有载荷真的
 * 是 diff 时卡片才显示 diff，否则回退到工具的文本。
 */
function fileDiffOf(result: unknown): FileDiff | undefined {
	const details = (result as { details?: unknown } | null | undefined)?.details;
	const candidate = (details as { diff?: unknown } | null | undefined)?.diff;
	if (typeof candidate !== "object" || candidate === null) return undefined;

	// 更早的 transcript 以 `path` 记录这个形状；字段是会话文件里的只读数据，所以旧的拼法被读取
	// 并归一化，而不是被拒绝。
	const record = candidate as Partial<FileDiff> & { path?: unknown };
	const relPath = typeof record.relPath === "string" ? record.relPath : typeof record.path === "string" ? record.path : undefined;
	if (relPath === undefined) return undefined;
	if (typeof record.added !== "number" || typeof record.removed !== "number") return undefined;
	if (typeof record.created !== "boolean" || typeof record.omitted !== "number") return undefined;
	if (!Array.isArray(record.lines) || !record.lines.every(isDiffLine)) return undefined;
	return { ...record, relPath } as FileDiff;
}

function isDiffLine(line: unknown): boolean {
	if (typeof line !== "object" || line === null) return false;
	const record = line as { kind?: unknown; text?: unknown };
	return typeof record.text === "string" && typeof record.kind === "string" && DIFF_KINDS.has(record.kind);
}

export function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (content === undefined || content === null) return "";
	if (!Array.isArray(content)) {
		const nested = (content as { content?: unknown }).content;
		return nested === undefined ? "" : contentToText(nested);
	}

	const blocks: unknown[] = content;
	return blocks
		.map((block) => {
			if (typeof block !== "object" || block === null) return "";
			const typed = block as { type?: unknown; text?: unknown; thinking?: unknown; content?: unknown; name?: unknown };
			if (typed.type === "text") return String(typed.text ?? "");
			if (typed.type === "thinking") return `[思考] ${String(typed.thinking ?? "")}`;
			if (typed.type === "toolCall") return `[调用 ${String(typed.name ?? "tool")}]`;
			if (typed.type === "image") return "[图片]";
			return typed.content === undefined ? "" : contentToText(typed.content);
		})
		.join("");
}

function assistantUsage(message: unknown): Parameters<typeof addUsage>[1] | undefined {
	const record = message as { role?: string; usage?: unknown };
	if (record.role !== "assistant" || record.usage === undefined) return undefined;
	return record.usage as Parameters<typeof addUsage>[1];
}

/**
 * 一条消息上报的开销，四个 token 字段求和。
 *
 * 底部信息条显示的唯一数字；用量求和为零的消息 —— 失败路径在它的消息上盖 `EMPTY_USAGE` ——
 * 不是一笔要上报的开销，所以读作缺席，而不是一个零的 chip。
 */
export function usageTotal(usage: MessageUsage | undefined): number | undefined {
	if (usage === undefined) return undefined;
	const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return total > 0 ? total : undefined;
}

/**
 * 底部信息条那份一条消息的用量，无东西可显示时为空。
 */
function messageUsageOf(usage: unknown): MessageUsage | undefined {
	if (typeof usage !== "object" || usage === null) return undefined;
	const record = usage as Record<string, unknown>;
	const field = (key: string): number => (typeof record[key] === "number" ? record[key] : 0);
	const read: MessageUsage = {
		input: field("input"),
		output: field("output"),
		cacheRead: field("cacheRead"),
		cacheWrite: field("cacheWrite"),
	};
	return usageTotal(read) === undefined ? undefined : read;
}
