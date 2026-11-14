import { element, icon, type IconName } from "../dom.ts";
import { Drain } from "../drain.ts";
import { usageTotal, type Item, type ToolCard } from "../state.ts";
import { diffStat, renderFileDiff } from "./diff.ts";
import { renderMarkdown, type MarkdownState } from "./markdown.ts";

export interface TranscriptOptions {
	/**
	 * 一条用户消息被右键：它所代表的存储条目 —— 如果已经为它指名 —— 以及指针位置，菜单应在此
	 * 打开。菜单本身属于调用者；会话记录只知道指针下是哪条消息。
	 */
	onUserContext(entryId: string | undefined, x: number, y: number): void;
	/**
	 * 一条已结束的 assistant 回答下的派生按钮被按下。
	 *
	 * 条目在按下时读取，而不是构建时：消息的条目 id 可以比回合晚一帧到达，而底部是构建一次的。
	 * 一次按压*做什么* —— 回退会话让下一个提示从这条回答开启另一条路 —— 是调用者的事；
	 * 会话记录只知道指针下是哪条回答。
	 */
	onBranch(entryId: string): void;
}

/**
 * 延迟绘制的一片携带多少个 item。
 *
 * 是计数而不是时间预算，以 harness 度量：一片的代价是它里面的 Markdown 解析，24 个 item 在窗口
 * 实际遇到的规模上是几毫秒，同时远低于整段对话过去造成的阻塞。一条超长的消息自成一片，因为一片
 * 从不拆开 —— 消息文本是 Markdown，半条消息不是可解析的东西。
 */
const BATCH_ITEMS = 24;

/**
 * 一帧的延迟绘制批次允许花费多久。
 *
 * drain 转动生成器，这是它停下的时候：跑到切片边界的批次已经有界，这里限制的是切片便宜到能连
 * 跑几片的那种情形。
 */
const FRAME_BUDGET_MS = 4;

/**
 * 距底部多近算"跟随中"，像素。
 *
 * 是余量而不是精确的终点：一次渲染可能在滚动事件与读取之间落下一帧的量，原本在底部的读者不能
 * 因此停止跟随。
 */
const FOLLOW_DISTANCE_PX = 80;

/**
 * 一个回合的推理行。
 *
 * 这一行与工具卡片共享容器和头部 —— 一个 `<details class="tool">`，同样的 chevron、同样安静的
 * 一行（01 ④）—— 名字席位上是「思考」。行以关闭状态创建，读者自行展开，视图无需记住任何东西。
 * 渲染时只补丁头部和运行状态；正文的 Markdown 只在行打开时解析，所以折叠着的长思考流式传输时
 * 零成本。
 */
interface ReasoningView {
	details: HTMLDetailsElement;
	/** 静态头部文本，思考停止到达后显示。 */
	preview: HTMLElement;
	/** 思考仍在到达时头部携带的 live 尾部。 */
	tail: HTMLElement;
	body: HTMLElement;
	markdown?: MarkdownState;
	text: string;
	/** 头部上次携带的尾部，让一次重绘能跳过已经做过的工作。 */
	tailText: string;
	/** 静态预览上次裁自的思考内容，折叠行只在变化时才裁。 */
	previewText: string;
	running: boolean;
}

/** agent 底部的一个 chip：小图标和它下面的数字。 */
interface FootChip {
	root: HTMLElement;
	text: HTMLElement;
	/** chip 上次携带的文本，没变的补丁什么都不写。 */
	shown?: string;
}

/** 用户回合的 meta 行：消息的时间和它的复制控件，气泡右缘之下。 */
interface MetaView {
	/** 时间文本，消息带时间戳之前隐藏。 */
	time: HTMLElement;
	/** 时间上次是否画为可见，与之一致的行什么都不写。 */
	shown: boolean;
}

/** agent 回合的底部：复制，然后用量 / 时间 / 用时 —— 回答之下安静的一行。 */
interface FootView {
	root: HTMLElement;
	/** 复制旁边的派生控件：从这条回答进入另一条分支的路。 */
	fork: HTMLButtonElement;
	usage: FootChip;
	time: FootChip;
	elapsed: FootChip;
	/** 这一行上次是否画为可见，与之一致的帧什么都不写。 */
	shown?: boolean;
	/** 派生按钮上次是否画过，以及上次是否被拒绝。 */
	forkShown?: boolean;
	forkRefused?: boolean;
}

/** 开启一个 item 所在回合的用户消息 —— 用时计时的起点席位。 */
interface RoundStart {
	id: string;
	at?: number;
}

/**
 * 一条消息需要的、但不是关于它自身的事实。
 *
 * 哪条 assistant 收尾自己的回合、哪个用户消息开启了那个回合，都要靠一次遍历来回答。遍历便宜但
 * 不是逐 token 都便宜：一个 delta 只改最后一条消息的文本，对上面的形状什么都不改，所以这些只在
 * item 列表的*形状*移动时重建（见 {@link TranscriptView.draw}），其间的每个 delta 复用。
 */
interface RoundIndex {
	/** 收尾各自回合的消息 id —— 画出底部的那几条。 */
	last: ReadonlySet<string>;
	/** 它们各自的回合由哪个用户消息开启。 */
	users: ReadonlyMap<string, RoundStart>;
	/** 整个对话最后一条用户消息，正是运行计时器跳动的起点。 */
	user?: Extract<Item, { kind: "message" }>;
	/**
	 * 整个对话的最后一条 assistant 消息。
	 *
	 * 它是唯一不提供派生按钮的回答：叶子就是对话所在之处，在它上面"从这里分支"只是继续。一旦有
	 * 东西跟在它后面，它就变得可派生 —— 恰好是用户要的那一对（图 2：最底部那条不给，
	 * 倒数第二条开始给）。
	 */
	lastAssistant?: string;
}

/** 一条已渲染的对话条目，加上原地修补它所需的那点状态。 */
interface Turn {
	section: HTMLElement;
	body: HTMLElement;
	/** 正文的 Markdown 解析状态，让流式消息只重新解析尾部。 */
	markdown?: MarkdownState;
	text: string;
	/** 上次绘制时本消息是否收尾其回合 —— 底部的可见性，变化时补丁。 */
	roundLast: boolean;
	/** 上次绘制时 section 是否戴着流式光标，类写入只发生在翻转时。 */
	streaming: boolean;
	/** 推理行，本回合的消息有推理之后。 */
	reasoning?: ReasoningView;
	/** 用户回合的 meta 行，回合是用户的之后。 */
	meta?: MetaView;
	/** agent 回合的底部，回合是非注释 assistant 的之后。 */
	foot?: FootView;
	/**
	 * 本回合当前绘制所依据的 item。
	 *
	 * 保存在回合上而不是闭包里：快照可以替换所有 item，所以右键菜单作用的条目是最后一次渲染
	 * 说的那个。
	 */
	item: Extract<Item, { kind: "message" }>;
}

/**
 * 对话列。
 *
 * 渲染是对 `items` 的协调而不是重建，因为会话记录是热路径：一条 `message_update` 每秒到达
 * 多次，成本必须正比于 delta 而不是目前为止的对话。item 不可变，reducer 只重建帧改变的那些，
 * 所以每次绘制走一遍列表、每个 item 一次引用比较、只渲染新的那些。其余 —— 摆放、回合遍历、
 * 修剪 —— 都以 item 列表的*形状*为键，落在最后一条消息里的 token 动不了它。
 *
 * 视图拥有自己的滚动策略：读者已在底部时跟随底部，一滚开就停，所以读历史绝不会被一个 token
 * 拽回底部。跟随是写而不是测量，什么都没变的帧什么都不请求（见 {@link pin}）。
 */
export class TranscriptView {
	private readonly container: HTMLElement;
	private readonly options: TranscriptOptions;
	private readonly turnMap = new Map<string, Turn>();
	private readonly tools = new Map<string, { section: HTMLElement; source: readonly ToolCard[]; cards: Map<string, { node: HTMLElement; shape: string }> }>();
	/**
	 * 整个快照的绘制，摊到多个帧上。
	 *
	 * `render` 保持即时路径，这是另一条：快照带来的会话记录按片绘制，而携带 delta 的帧必须
	 * 整体落地 —— delta 正是读者正在看着被写出来的东西。
	 */
	private readonly drain = new Drain(FRAME_BUDGET_MS);
	/**
	 * 屏幕上一次绘制所依据的 item，按下标。
	 *
	 * 这就是 delta：与上次相同的对象是已在屏幕上的回合，因为 item 不可变、只有帧改变的才会重建。
	 * 延迟绘制一片一片填它，这也是立即帧在绘制中途到达时知道还缺什么的方式。
	 */
	private drawnItems: readonly (Item | undefined)[] = [];
	/** The round facts of the last shape, reused while the shape holds (see {@link RoundIndex}). */
	private rounds: RoundIndex = { last: new Set(), users: new Map() };
	/** 上一次完整绘制是否在流式 —— 容器类和运行的结束都靠它。 */
	private drawnStreaming = false;
	private welcome?: HTMLElement;
	private sticky = true;
	/** 滚动读取推迟到的那个帧，让一串事件只花一次读取。 */
	private scrollRead?: number;
	/** 循环流式时那一行跳动的时间，和移动它的 interval。 */
	private runtime?: HTMLElement;
	private runtimeText?: HTMLElement;
	/** 跳动行上次携带的文本，同一秒内的帧什么都不写。 */
	private runtimeShown = "";
	private runtimeTimer?: number;
	/**
	 * 计时器跳动的回合：流式时看到的最后一条用户消息，带着计时器需要的时间戳 ——
	 * {@link RoundStart} 指名的同一席位，收窄到有它的那种情形。
	 */
	private runtimeFrom?: { id: string; at: number };
	/** 上一次绘制是否在流式 —— 翻回去就是运行的结束。 */
	private wasStreaming = false;
	/** 被观看运行花的时长，以回合的用户消息为键。 */
	private readonly observed = new Map<string, { lastId: string; ms: number }>();

	constructor(container: HTMLElement, options: TranscriptOptions) {
		this.container = container;
		this.options = options;
		// 消息菜单是调用者的；这一侧只决定指针下*是*哪条消息，把那条消息代表的条目交给调用者。
		container.addEventListener("contextmenu", (event) => {
			if (!(event.target instanceof Element)) return;
			const turn = event.target.closest(".turn[data-role=\"user\"]");
			if (!(turn instanceof HTMLElement)) return;
			event.preventDefault();
			this.options.onUserContext(turn.dataset.entry || undefined, event.clientX, event.clientY);
		});
	}

	/** 除非读者已从底部滚开，否则跟随底部。 */
	trackScroll(): void {
		this.setSticky(this.sticky);
		this.container.addEventListener("scroll", () => this.followFromScroll());
	}

	/**
	 * 下一帧读滚动位置，并决定是否继续跟随。
	 *
	 * 读取是一次布局读 —— `scrollHeight` 会强制刚才长出答案的那个帧留下的脏布局 —— 而 {@link pin}
	 * 是一次布局写。在事件循环的同一轮里做两件事，就是读者看到的强制重排卡顿，所以读取移到帧上，
	 * 顺便合并落下的所有滚动事件（滚动不是帧）。反正只有最后一次读取能决定什么。
	 */
	private followFromScroll(): void {
		if (this.scrollRead !== undefined) return;
		this.scrollRead = requestAnimationFrame(() => {
			this.scrollRead = undefined;
			const distance = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight;
			this.setSticky(distance < FOLLOW_DISTANCE_PX);
		});
	}

	/**
	 * 设置视图是否跟随底部，并戴上让跟随便宜的类。
	 *
	 * 钉住时 `overflow-anchor: none` 是浏览器帮忙：锚定会在视口上方的内容变化时保住读者的位置，
	 * 而钉住的视图每帧都在下方追加 —— 两种策略打架，读者看到跳动。滚开之后锚定恰好是它设计出来
	 * 帮的忙，所以类随 `sticky` 摘下。
	 */
	private setSticky(sticky: boolean): void {
		this.sticky = sticky;
		if (this.container.classList.contains("pinned") !== sticky) this.container.classList.toggle("pinned", sticky);
	}

	/**
	 * 本帧完整画出 `items`。
	 *
	 * 窗口对即时发生的事做出反应所走的路径：一条 `message_update`、一个工具事件、小到一次画完的
	 * 快照。整段对话这样画正是过去冻结窗口的原因，所以 {@link renderDeferred} 为它而生 —— 而本
	 * 方法是延迟的终点：未完成的绘制被取消，下面的趟完成它。
	 */
	render(items: readonly Item[], streaming: boolean): void {
		this.drain.cancel();
		this.draw(items, streaming);
	}

	/**
	 * 按有界分片画整个快照，第一片在本轮就落。
	 *
	 * 分批正是要点：对一份长历史的会话调用 `render`，是一整块 Markdown 解析和节点构建，期间浏览器
	 * 不重绘 —— 会话记录没到、说它要来的提示也没有。这里第一片随点击落地，帧被还回去让浏览器
	 * 绘制它，其余每帧一批跟进。
	 *
	 * 第一片刻意是固定数量而不是"到折叠处为止"：跑完整段短对话的片与即时路径毫无区别，而本方法
	 * 存在的理由恰恰是长对话，固定数量是唯一有意义的界。它的成本因此是首帧的价格，也是 harness
	 * 报告的那个数字。
	 */
	renderDeferred(items: readonly Item[], streaming: boolean): void {
		this.drain.cancel();
		this.setSticky(true);
		// 快照是一整段对话同时到达，所以 delta 表从空开始：落在两片之间的流式帧必须把未画的半截
		// 看作未画并自己完成那次绘制，这是两条路径之间的成文关系。
		this.drawnItems = [];
		const rounds = roundIndex(items);
		// 在这里发布而不是留给收尾绘制的那趟：到那时每个 item 都已上屏、形状读起来没有变化，那一趟
		// 会跳过回合遍历 —— 而之后到达的 delta 信任这个索引。空索引会让答案丢掉它的回合：运行结算
		// 时没有底部，跳动行没有起点席位。
		this.rounds = rounds;
		const wanted = idsOf(items);
		// 遍历从这里开始而不是从一个 `yield`：把第一片排到下一帧的生成器，会让窗格在点击后整整一帧
		// 显示上一个会话的会话记录，这正是要修的东西。
		this.batch(items, streaming, rounds, wanted, 0, Math.min(items.length, BATCH_ITEMS));
		this.drain.start(() => this.producer(items, streaming, rounds, wanted));
	}

	/** 延迟绘制的剩余分片，每个 `yield` 一帧。 */
	private *producer(
		items: readonly Item[],
		streaming: boolean,
		rounds: RoundIndex,
		wanted: ReadonlySet<string>,
	): Generator<undefined> {
		yield;
		for (let index = BATCH_ITEMS; index < items.length; index += BATCH_ITEMS) {
			this.batch(items, streaming, rounds, wanted, index, Math.min(items.length, index + BATCH_ITEMS));
			yield;
		}
		// 一切都已上屏，最后一句交给即时路径运行的同一个完整趟 —— 它也是退掉新快照丢弃的东西的
		// 地方。
		this.draw(items, streaming);
	}

	/**
	 * 延迟绘制的一片：`items` 中连续的一段，按 `items` 顺序。
	 *
	 * 一片从不只和自己协调：`from` 之前的 item 还在屏幕上，`wanted` 是整段对话，所以新快照不再
	 * 携带的回合由第一片丢弃，而不是拖到最后一片。摆放同样只走到 `to`，理由相同 —— 一片只会在
	 * 已有序的内容之后追加，绘制结束时那趟完整绘制才处理唯一的例外：属于头部的摘要。
	 */
	private batch(
		items: readonly Item[],
		streaming: boolean,
		rounds: RoundIndex,
		wanted: ReadonlySet<string>,
		from: number,
		to: number,
	): void {
		const drawn = this.drawnItems.slice();
		for (let index = from; index < to; index += 1) {
			const item = items[index]!;
			drawn[index] = item;
			this.renderItem(item, rounds);
		}
		this.drawnItems = drawn;
		this.reconcile(wanted);
		this.setWelcome(items.length === 0 && !streaming);
		this.setRuntime(streaming, rounds, items);
		this.setSticky(true);
		this.placeAll(items, to);
		this.pin();
	}

	/**
	 * 画出本帧知道的一切，让屏幕保持干净。
	 *
	 * 即时路径与结束延迟绘制的那趟是同一份代码，因为它们只在已有多少工作在屏幕上的差别。delta
	 * 循环就是全部的成本模型：item 不可变、reducer 只重建帧改变的那些，所以下标处与上次相同的
	 * 对象是已在屏幕上的回合，循环以一次 `===` 跳过。落在流式消息里的 token 因此只花那一条消息的
	 * 绘制加每个 item 一次引用比较 —— 尾部之上什么都不碰。
	 *
	 * 一切正比于列表的东西都以它的*形状*为键 —— 长度和最后一个 item 的身份。追加消息、折入注释、
	 * 重试的注释替换被放弃的回答、压缩摘要落在头部：这些移动形状，也只有这些为回合遍历、修剪和
	 * 摆放趟付费。重新基线化同一对话的重连保持形状 —— 每个 item 都是新对象，delta 循环全部重画，
	 * 但它们的顺序和上面的回合事实都没动。
	 */
	private draw(items: readonly Item[], streaming: boolean): void {
		const previous = this.drawnItems;
		const structural = !sameShape(previous, items);
		const wasStreaming = this.drawnStreaming;
		this.drawnStreaming = streaming;
		this.drawnItems = items;
		if (structural) this.rounds = roundIndex(items);

		// 修剪对整段对话进行，而不是对已画的分片：中途放弃的延迟绘制绝不能把上一个会话的回合留给
		// 分片来收拾。
		if (structural) this.reconcile(idsOf(items));

		this.setWelcome(items.length === 0 && !streaming);
		// 在 delta 循环之前，因为循环的底部补丁是运行结束时记录的观察的读者之一。
		this.setRuntime(streaming, this.rounds, items);
		if (streaming !== wasStreaming) this.container.classList.toggle("streaming", streaming);

		let touched = structural;
		for (let index = 0; index < items.length; index += 1) {
			const item = items[index]!;
			if (previous[index] === item) continue;
			this.renderItem(item, this.rounds);
			touched = true;
		}

		// 可见性不是自身 item 的事实的行，在能移动它们的帧上重读：新的 assistant 消息会从前一条
		// 手里拿走底部，结算的时长只在运行结束时落地。绝不逐 token。
		if (structural || streaming !== wasStreaming) this.patchFeet();

		// 新的 item 并不总在末尾到达：压缩摘要画在对话头部，重新基线化的重连按自己的顺序重放每个
		// item。所以屏幕上的一切画完之后，节点按 `items` 顺序摆放 —— 与侧栏相同的"按序追加、只动
		// 动过的"趟。没有它，应该坐在顶部的摘要被追加在最后，读起来像最新说的一句话。
		if (structural) this.placeAll(items, items.length);
		if (this.sticky && touched) this.pin();
	}

	/** 画一个 item：消息的回合，或工具组的卡片。 */
	private renderItem(item: Item, rounds: RoundIndex): void {
		if (item.kind === "message") this.renderMessage(item, rounds);
		else this.renderTools(item);
	}

	/**
	 * 把前 `to` 个 item 的节点按 `items` 顺序摆放。
	 *
	 * 完整趟时 `to` 是整段对话，延迟绘制的一片时是片的末尾 —— 一片只会在已有序的内容之后追加，
	// 所以走到自己的末尾就够，完整趟才是把顺序一锤定音的地方。
	 */
	private placeAll(items: readonly Item[], to: number): void {
		let previous: HTMLElement | undefined;
		for (let index = 0; index < to; index += 1) {
			const item = items[index]!;
			const node = item.kind === "message" ? this.turnMap.get(item.id)?.section : this.tools.get(item.id)?.section;
			if (node === undefined) continue;
			this.place(this.container, node, previous);
			previous = node;
		}
	}

	/** 丢掉对话不再携带的东西，从两张表和 DOM 两处。 */
	private reconcile(wanted: ReadonlySet<string>): void {
		for (const [id, turn] of [...this.turnMap]) {
			if (wanted.has(id)) continue;
			this.turnMap.delete(id);
			turn.section.remove();
		}
		for (const [id, group] of [...this.tools]) {
			if (wanted.has(id)) continue;
			this.tools.delete(id);
			group.section.remove();
		}
	}

	/**
	 * 把视图放到底部。
	 *
	 * 是写不是测量：超过末尾的 `scrollTop` 会被浏览器夹到它有的范围内，所以跟随不花 `scrollHeight`
	 * 的读、不在刚写了 DOM 的帧里强制布局。在这里读 `scrollHeight` 曾是每个 token 一次同步重排，
	 * 恰是读者看作卡顿的那种帧。
	 *
	 * 这里任何东西都不决定*是否*跟随 —— 那是 `sticky`，由滚动监听和回合到达设置，只有真正改变了
	 * 内容的帧才调用它。
	 */
	private pin(): void {
		this.container.scrollTop = Number.MAX_SAFE_INTEGER;
	}

	/**
	 * 跑一批未完成的延迟绘制，并回答是否还有剩余。
	 *
	 * 帧由 drain 调度，这是给没有帧的调用者的接缝：harness 和冒烟测试逐批驱动队列，为首帧和最差
	 * 分片定价。生产环境从不调用 —— 窗口的帧由浏览器分发。
	 */
	stepPending(): boolean {
		return this.drain.step();
	}

	/** 把节点放到 `previous` 之后，已在那个位置时什么都不做。 */
	private place(parent: HTMLElement, node: HTMLElement, previous: HTMLElement | undefined): void {
		const wanted = previous === undefined ? parent.firstChild : previous.nextSibling;
		if (node === wanted) return;
		parent.insertBefore(node, wanted);
	}

	scrollToBottom(): void {
		this.setSticky(true);
		this.pin();
	}

	/** 读者是否在底部，它决定重画是否追下去。 */
	following(): boolean {
		return this.sticky;
	}

	/**
	 * 画或补丁一条消息。
	 *
	 * 回合在本视图自己的表里查，那正是"这个 id 在屏幕上吗"的问题：离开表的回合是要构建的回合，
	 * 无论因为对话对这个视图是新的，还是延迟绘制还没走到它。表和修剪对这个问题给出相同答案，
	 * 因为它们是同一张表。
	 *
	 * 只有帧真正改变过的 item 才被交到这里 —— {@link draw} 的 delta 循环过滤了它们 —— 所以这一侧
	 * 可以把写入花在动了的东西上：流式光标、条目 id、meta 行、底部。
	 */
	private renderMessage(item: Extract<Item, { kind: "message" }>, rounds: RoundIndex): void {
		const known = this.turnMap.get(item.id);
		const turn = known ?? this.createTurn(item);
		if (known === undefined) {
			this.turnMap.set(item.id, turn);
			this.container.append(turn.section);
			this.setSticky(true);
		} else if (known.item === item) {
			// 延迟绘制的重复片可能交来屏幕上已有的同一个 item；对未变快照的完整趟同样如此。
			// 没话可说，什么都不写。
			return;
		}
		turn.item = item;
		turn.roundLast = rounds.last.has(item.id);
		// *本*消息是否仍在到达，这正是样式表流式光标的键：光标属于正在写的那条消息，不属于运行
		// 进行中碰巧排最后的任何回合（16）—— 一条回答的结束与下一条的首个 delta 之间，最后的回合
		// 往往是用户自己的气泡。
		if (turn.streaming !== item.streaming) {
			turn.streaming = item.streaming;
			turn.section.classList.toggle("streaming", item.streaming);
		}
		this.applyEntry(turn);
		this.patchMeta(turn);
		this.patchFoot(turn, turn.roundLast, rounds.users.get(item.id), rounds.lastAssistant === item.id);

		// 注释是纯文本且从不流式，所以写一次就不管了。
		if (item.notice) {
			this.clearReasoning(turn);
			if (turn.text !== item.text) {
				turn.body.replaceChildren(element("p", undefined, item.text));
				turn.text = item.text;
			}
			return;
		}

		// 在正文之前、也在下面的提前返回之前画：只有思考还没有文本的消息没有东西可改，但它的行
		// 仍然要出现并跟上流式。
		this.renderReasoning(turn, item);

		if (item.text === turn.text) return;
		turn.markdown = renderMarkdown(turn.body, item.text, turn.markdown);
		turn.text = item.text;
	}

	/**
	 * 画或补丁消息文本之前的推理行。
	 *
	 * 没有推理的消息没有行；渲染之间获得或失去推理的消息在这里加行或删行。折叠时头部携带思考
	 * —— 到达中是它的结尾，停止后冻结在第一行 —— 运行状态就是两者互换的类。
	 */
	private renderReasoning(turn: Turn, item: Extract<Item, { kind: "message" }>): void {
		const thinking = item.thinking;
		if (thinking === undefined) {
			this.clearReasoning(turn);
			return;
		}

		let view = turn.reasoning;
		if (view === undefined) {
			view = this.createReasoning(turn);
			turn.reasoning = view;
		}

		if (view.running !== thinking.running) {
			view.running = thinking.running;
			view.details.classList.toggle("running", thinking.running);
		}
		if (thinking.running) patchTail(view, thinking.text);
		else if (view.previewText !== thinking.text) {
			// 预览是整段思考的第一行，裁它要走文本。只在思考移动时才裁，对已结算的行就是永远不再。
			view.previewText = thinking.text;
			const preview = firstLineOf(thinking.text);
			if (view.preview.textContent !== preview) view.preview.textContent = preview;
		}
		// 折叠的行只显示头部，所以它的 Markdown 留到打开时才解析。
		if (view.details.open) this.paintReasoning(turn);
	}

	/** 构建一条推理行，关闭状态，放在角色行与消息正文之间。 */
	private createReasoning(turn: Turn): ReasoningView {
		const details = element("details", "tool reasoning");
		const summary = element("summary");
		const chevron = element("span", "tool-chevron");
		chevron.append(icon("chevron"));
		const preview = element("span", "tool-path reasoning-preview");
		const marquee = element("div", "reasoning-marquee");
		const tail = element("span", "reasoning-tail");
		marquee.append(tail);
		const body = element("div", "reasoning-body");
		summary.append(chevron, element("span", "tool-name", "思考"), preview, marquee);
		details.append(summary, body);
		// 正文在打开的路上解析，那是它值得渲染的第一时刻。
		details.addEventListener("toggle", () => {
			if (details.open) this.paintReasoning(turn);
		});
		turn.section.insertBefore(details, turn.body);
		return {
			details,
			preview,
			tail,
			body,
			text: "",
			tailText: "",
			previewText: "",
			running: false,
		};
	}

	/** 从回合当前的 item 渲染推理正文的 Markdown。 */
	private paintReasoning(turn: Turn): void {
		const view = turn.reasoning;
		const thinking = turn.item.thinking;
		if (view === undefined || thinking === undefined) return;
		if (view.text === thinking.text) return;
		view.markdown = renderMarkdown(view.body, thinking.text, view.markdown);
		view.text = thinking.text;
	}

	private clearReasoning(turn: Turn): void {
		if (turn.reasoning === undefined) return;
		turn.reasoning.details.remove();
		turn.reasoning = undefined;
	}

	/**
	 * 一个回合。
	 *
	 * 没有角色行、没有逐回合的标记 —— 谁在说话由形式本身携带：用户消息是贴着右边距的气泡、下面
	 * 带 meta 行（时间 + 复制，06 ⑤），agent 的工作占满列宽，agent 的回答以自己的底部收尾回合
	 * （06 ⑥）。
	 *
	 * 行在这里构建一次、逐帧补丁，因为协调给每个 item 摆放一个节点；回合内部的任何东西都可以
		 * 自由出现消失，会话记录的摆放不需要知道。
	 */
	private createTurn(item: Extract<Item, { kind: "message" }>): Turn {
		const section = element("section", `turn ${item.role}${item.notice ? " notice" : ""}`);
		const body = element("div", "turn-body");
		const turn: Turn = { section, body, text: "", roundLast: false, streaming: false, item };

		// 用户消息可以右键：菜单的项是调用者的，它作用的条目由 {@link applyEntry} 逐帧补上。
		if (item.role === "user") {
			section.dataset.role = "user";
			const time = element("span", "turn-time");
			time.hidden = true;
			const meta = element("div", "turn-meta");
			// 文本在点击时读取：行构建时气泡可能仍在流式。
			meta.append(time, copyButton(() => turn.item.text));
			section.append(body, meta);
			turn.meta = { time, shown: false };
		} else if (item.role === "assistant" && !item.notice) {
			const usage = footChip("database");
			const time = footChip("clock");
			const elapsed = footChip("timer");
			const fork = element("button", "turn-copy", undefined, {
				type: "button",
				title: "从这条回答开始分支",
				"aria-label": "从这条回答开始分支",
			});
			fork.append(icon("fork"));
			// 条目在按下时读取：assistant 消息的 id 比回合的构建晚一帧落地，底部是唯一跨过这些帧
			// 存活的节点。
			fork.addEventListener("click", () => {
				const entryId = turn.item.forkEntryId ?? undefined;
				if (entryId !== undefined) this.options.onBranch(entryId);
			});
			const foot = element("div", "turn-foot");
			foot.hidden = true;
			foot.append(copyButton(() => turn.item.text), fork, usage.root, time.root, elapsed.root);
			section.append(body, foot);
			turn.foot = { root: foot, fork, usage, time, elapsed, shown: false };
		} else {
			section.append(body);
		}
		return turn;
	}

	/**
	 * 让用户回合 section 上的条目 id 保持最新。
	 *
	 * 这里的每一样都可能晚于 section 的构建到达：用户消息在循环回显它之前就写进存储，所以它的
	 * 条目 id 晚一帧落地。id 挂在 section 的 dataset 上，因为右键菜单在右键时刻读它，而不是构建
	 * 时刻。
	 */
	private applyEntry(turn: Turn): void {
		if (turn.section.dataset.role !== "user") return;
		const entryId = turn.item.forkEntryId ?? undefined;
		const shown = turn.section.dataset.entry;
		if (entryId === undefined) {
			if (shown !== undefined) delete turn.section.dataset.entry;
		} else if (shown !== entryId) {
			turn.section.dataset.entry = entryId;
		}
	}

	/** 画用户 meta 行的时间；没有时间戳的消息不显示。 */
	private patchMeta(turn: Turn): void {
		const meta = turn.meta;
		if (meta === undefined) return;
		const stamp = turn.item.timestamp;
		const shown = stamp !== undefined;
		if (meta.shown !== shown) {
			meta.shown = shown;
			meta.time.hidden = !shown;
		}
		if (stamp === undefined) return;
		const text = formatClockTime(stamp);
		if (meta.time.textContent !== text) meta.time.textContent = text;
	}

	/**
	 * 画 agent 底部，或藏起它。
	 *
	 * 底部属于收尾回合的回答 —— 下一条用户提示之前的最后一条 assistant 消息 —— 且只在它停止到达
	 * 之后：流式期间，会话记录下面运行自己的那一行才是用时读数的席位。注释不是回答，没有文本
	 * 的消息没有东西可复制，所以两者都不画底部。
	 *
	 * 派生按钮在除对话最后一条回答之外的每个底部都坐在复制旁边：叶子就是对话继续的地方，从它
	 * 分支就是普通的下一条提示。运行进行中它被拒绝，理由与用户菜单藏起自己的分支项相同：移动
	 * 正在被运行写入的叶子，是分支唯一要等过去的事。
	 */
	private patchFoot(turn: Turn, roundLast: boolean, roundUser: RoundStart | undefined, isLastAnswer: boolean): void {
		const foot = turn.foot;
		if (foot === undefined) return;
		const item = turn.item;
		const visible = !item.notice && !item.streaming && roundLast && item.text.length > 0;
		if (foot.shown !== visible) {
			foot.shown = visible;
			foot.root.hidden = !visible;
		}
		const forkShown = visible && !isLastAnswer;
		if (foot.forkShown !== forkShown) {
			foot.forkShown = forkShown;
			foot.fork.hidden = !forkShown;
		}
		const refused = this.drawnStreaming;
		if (foot.forkRefused !== refused) {
			foot.forkRefused = refused;
			foot.fork.disabled = refused;
			foot.fork.title = refused ? "这一轮还在写，等它结束再分支" : "从这条回答开始分支";
		}
		if (!visible) return;

		const usage = usageTotal(item.usage);
		setChip(foot.usage, usage === undefined ? "" : `用量 ${shortTokens(usage)} tok`);
		setChip(foot.time, item.timestamp === undefined ? "" : formatClockTime(item.timestamp));

		// 回合的用时。本窗口看过结束的运行是权威 —— 回答自己的时间戳是它请求的起点，只有持久化的
		// 时间戳就只能读到最后一次请求为止，而观察到的结束正是让计时器跳出来的数字与底部冻结的
		// 数字一致的东西。没有观察时，时间戳是兜底。
		let elapsedMs: number | undefined;
		if (roundUser?.at !== undefined && item.timestamp !== undefined) {
			const observed = this.observed.get(roundUser.id);
			elapsedMs =
				observed !== undefined && observed.lastId === item.id
					? observed.ms
					: item.timestamp - roundUser.at;
			if (elapsedMs < 0) elapsedMs = undefined;
		}
		setChip(foot.elapsed, elapsedMs === undefined ? "" : `用时 ${formatElapsed(elapsedMs)}`);
	}

	/**
	 * 在回合事实可能移动的帧上重读底部。
	 *
	 * 底部的可见性不是关于自己 item 的事实：同一回合里更晚打开的 assistant 消息会从之前的回答手里
	 * 拿走那个席位，所以它自己的 item 未动的更早回合也必须被告知。结算的时长同理，它只在运行结束
	 * 时记录 —— 回答自己的时间戳单独只能读到它的最后一次请求。
	 *
	 * 在形状变化或流式翻转时调用，绝不逐 token；其内，丢了回合收尾席位、别的什么都没得的回合，
	 * 花一次 Set 查找加一次比较。
	 */
	private patchFeet(): void {
		for (const turn of this.turnMap.values()) {
			if (turn.foot === undefined) continue;
			const last = this.rounds.last.has(turn.item.id);
			const moved = turn.roundLast !== last;
			turn.roundLast = last;
			// 仍然收尾回合的回合也被重读：结算的时长落在一个什么都不改的帧上，这是唯一能交付它的
			// 趟。
			if (moved || last) {
				this.patchFoot(turn, last, this.rounds.users.get(turn.item.id), this.rounds.lastAssistant === turn.item.id);
			}
		}
	}

	/**
	 * 运行的跳动行，以及一次被观看运行的结束时刻。
	 *
	 * 循环流式时，最后一个 item 下面的一条朴素行显示 `用时 mm:ss`，从回合的用户消息起跳 —— 与
	 * 结算底部读的是同一个席位，于是计时器和它冻结成的数字是同一只钟（06）。跳动是一个写一个
	 * 文本节点的本地 interval：不存在"过了一秒"的事件，发明一个就是把显示关心放上 wire。
	 *
	 * 节点每次运行构建一次，只在它不是列里最后一个东西时移动：每帧都追加它会在每个 token 上重新
	 * 挂载这一行，是读者从没见过的 DOM 写。文本只在它指名的秒变了时写，理由相同。
	 *
	 * 流式翻回去时，用时被记到回合上 —— 这是底部无法从会话记录推导的唯一观察，因为回答自己的
	 * 时间戳是它请求的起点。记录同时以回合的用户消息和回答的 id 为键，所以同一回合上一次运行的
	 * 过期观察 —— 分支被再次走过 —— 读作缺席，时间戳作答。
	 */
	private setRuntime(streaming: boolean, rounds: RoundIndex, items: readonly Item[]): void {
		if (!streaming) {
			if (this.wasStreaming) {
				this.wasStreaming = false;
				const from = this.runtimeFrom;
				const ended = items.at(-1);
				if (from !== undefined && ended !== undefined && ended.kind === "message" && ended.role === "assistant") {
					this.observed.set(from.id, { lastId: ended.id, ms: Math.max(0, Date.now() - from.at) });
				}
			}
			this.runtimeFrom = undefined;
			if (this.runtimeTimer !== undefined) {
				window.clearInterval(this.runtimeTimer);
				this.runtimeTimer = undefined;
			}
			this.runtime?.remove();
			this.runtime = undefined;
			return;
		}

		this.wasStreaming = true;
		const user = rounds.user;
		this.runtimeFrom = user === undefined ? undefined : { id: user.id, at: user.timestamp ?? Date.now() };
		if (this.runtime === undefined) {
			const text = element("span", "runtime-time", "00:00");
			const line = element("div", "runtime");
			line.append("用时 ", text);
			this.runtime = line;
			this.runtimeText = text;
			this.runtimeShown = "";
			this.runtimeTimer = window.setInterval(() => this.tickRuntime(), 1000);
		}
		// 这一行坐在对话当前结束的东西之下，摆放趟把新画的 item 放到它上面；只有不在那个位置的
		// 行才被移动。
		if (this.container.lastChild !== this.runtime) this.container.append(this.runtime);
		this.tickRuntime();
	}

	/** 从回合的起点席位写跳动行，且只在它指名的秒变了时。 */
	private tickRuntime(): void {
		const from = this.runtimeFrom;
		if (this.runtimeText === undefined || from === undefined) return;
		const text = formatTick(Date.now() - from.at);
		if (text === this.runtimeShown) return;
		this.runtimeShown = text;
		this.runtimeText.textContent = text;
	}

	/**
	 * 一个工具组，只重建变化了的卡片。
	 *
	 * 组内的卡片随工具运行而更新 —— 输出增长、然后结算 —— 一组可以有很多张。卡片的 reshape 键是
	 * 它的运行状态、输出长度、是否带回了 diff；键不变时卡片的节点就不动，这让一个正在增长的输出
	 * 不会重建整个组（以及读者打开的那个 `<details>`）。
	 */
	private renderTools(item: Extract<Item, { kind: "tools" }>): void {
		const { id, cards } = item;
		let group = this.tools.get(id);
		if (group !== undefined) {
			// 与消息路径同样的捷径：reducer 只在某张卡片变化时才重建组的 item，所以拿回同一个数组
			// 就意味着这里什么都没动。一次有很多已完成组的长运行，每组每帧只花一次 `===`。
			if (group.source === cards) return;
		} else {
			const section = element("section", "tool-group");
			group = { section, cards: new Map(), source: cards };
			this.tools.set(id, group);
			this.container.append(section);
			this.setSticky(true);
		}
		group.source = cards;

		for (const card of cards) {
			const shape = shapeOf(card);
			const drawn = group.cards.get(card.toolCallId);
			if (drawn === undefined) {
				group.cards.set(card.toolCallId, { node: renderTool(card), shape });
			} else if (drawn.shape !== shape) {
				// 卡片自己的内容变了；它的节点重做，且只重做它的节点。
				drawn.node.remove();
				drawn.node = renderTool(card);
				drawn.shape = shape;
			}
		}

		const present = new Set(cards.map((card) => card.toolCallId));
		for (const [toolCallId, drawn] of [...group.cards]) {
			if (present.has(toolCallId)) continue;
			drawn.node.remove();
			group.cards.delete(toolCallId);
		}

		let previous: HTMLElement | undefined;
		for (const card of cards) {
			const drawn = group.cards.get(card.toolCallId);
			if (drawn === undefined) continue;
			this.place(group.section, drawn.node, previous);
			previous = drawn.node;
		}
	}

	/** 首次运行的状态：空的对话显示一个问题，别无其他。 */
	private setWelcome(visible: boolean): void {
		if (!visible) {
			this.welcome?.remove();
			this.welcome = undefined;
			return;
		}
		if (this.welcome) return;

		const welcome = element("div", "welcome");
		welcome.append(element("h2", undefined, "想做点什么?"));
		this.welcome = welcome;
		this.container.append(welcome);
	}
}

/**
 * 工具卡片的 reshape 键：运行状态、错误状态、输出长度、是否带了 diff。
 *
 * 不同的键意味着卡片自己的绘制会不同，节点重做；相同的键意味着屏幕上的节点说的还是对的，不碰。
 * id 是映射键，不在这里。
 */
function shapeOf(card: ToolCard): string {
	return `${card.waiting ? "w" : card.running ? "r" : "d"}:${card.isError ? "e" : "o"}:${card.output.length}:${card.diff ? "D" : "-"}`;
}

/**
 * 对话的回合事实，一次前向遍历。
 *
 * 一个回合从一条用户消息到下一条，底部属于收尾它的回答 —— 下一条提示之前的最后一条 assistant
 * 消息。注释不参与：一次折叠或一次失败的运行是被携带在回合之间的，而不是在某个回合里说出来，
 * 席位留给最后一条真实的回答。遍历还为每个收尾回答记住开启其回合的用户消息 —— 用时的起点席位
 * —— 以及整个对话最后一条用户消息，那是运行计时器的。
 *
 * 一趟，在 item 列表的形状移动时调用（见 {@link TranscriptView.draw}）；最后一条消息里的 delta
 * 改不了这些事实中的任何一个。
 */
function roundIndex(items: readonly Item[]): RoundIndex {
	const last = new Set<string>();
	const users = new Map<string, RoundStart>();
	let user: Extract<Item, { kind: "message" }> | undefined;
	let start: RoundStart | undefined;
	let closing: string | undefined;
	let closingStart: RoundStart | undefined;
	let lastAssistant: string | undefined;

	// 回合在下一条用户消息开启时结算，最后再结一次：回合里最后看到的 assistant 是收尾它的那条。
	const close = (): void => {
		if (closing === undefined) return;
		last.add(closing);
		if (closingStart !== undefined) users.set(closing, closingStart);
		closing = undefined;
		closingStart = undefined;
	};

	for (const item of items) {
		if (item.kind !== "message") continue;
		if (item.role === "user") {
			close();
			user = item;
			start = { id: item.id, at: item.timestamp };
			continue;
		}
		if (item.notice) continue;
		if (item.role !== "assistant") continue;
		closing = item.id;
		closingStart = start;
		lastAssistant = item.id;
	}
	close();
	return {
		last,
		users,
		...(user === undefined ? {} : { user }),
		...(lastAssistant === undefined ? {} : { lastAssistant }),
	};
}

/** `items` 携带的 id，供按成员资格而不是位置发问的修剪。 */
function idsOf(items: readonly Item[]): Set<string> {
	const ids = new Set<string>();
	for (const item of items) ids.add(item.id);
	return ids;
}

/**
 * 两个 item 列表是否形状相同，非 delta 的工作以它为键。
 *
 * item 不可变，所以"形状相同"不能是"引用相同" —— 流式消息的 item 每个 token 都是新对象。它指
 * 列表的长度和最后一个 item 的身份：追加、丢弃、重试的注释替换被放弃的回答、整段新对话都会动
 * 其中之一，而落在已经在末尾的消息里的 token 两个都不动。
 */
function sameShape(previous: readonly (Item | undefined)[], next: readonly Item[]): boolean {
	if (previous.length !== next.length) return false;
	return shapeKey(previous.at(-1)) === shapeKey(next.at(-1));
}

/** 形状比较读取的身份：item 的 id，加上回合遍历所依赖的两个标志。 */
function shapeKey(item: Item | undefined): string {
	if (item === undefined) return "";
	if (item.kind !== "message") return item.id;
	return `${item.id}|${item.role}|${item.notice ? "n" : "-"}`;
}

/**
 * 两个 meta 行共用的唯一复制控件：一个图标，回答时换成一拍的对勾。
 *
 * 文本在点击时经 getter 读取，因为它复制的那条消息在行构建时可能仍在流式。同一时刻只有一个挂起
 * 的恢复 —— 快速的第二击替换那一拍，而不是在它下面堆叠计时器。
 */
function copyButton(getText: () => string): HTMLButtonElement {
	const button = element("button", "turn-copy", undefined, { type: "button", title: "复制", "aria-label": "复制" });
	button.append(icon("copy"));
	let restore = 0;
	button.addEventListener("click", () => {
		void navigator.clipboard.writeText(getText()).then(
			() => {
				button.replaceChildren(icon("check"));
				window.clearTimeout(restore);
				restore = window.setTimeout(() => {
					restore = 0;
					button.replaceChildren(icon("copy"));
				}, 1200);
			},
			() => {
				button.title = "复制失败";
				window.clearTimeout(restore);
				restore = window.setTimeout(() => {
					restore = 0;
					button.title = "复制";
				}, 1200);
			},
		);
	});
	return button;
}

/** 一个底部 chip：小图标和它下面的数字，有东西可说之前隐藏。 */
function footChip(name: IconName): FootChip {
	const root = element("span", "foot-chip");
	root.hidden = true;
	const text = element("span");
	root.append(icon(name), text);
	return { root, text };
}

/** 写一个 chip 的文本，空文本时藏起；没变的 chip 不动。 */
function setChip(chip: FootChip, text: string): void {
	if (chip.shown === text) return;
	chip.shown = text;
	chip.root.hidden = text === "";
	chip.text.textContent = text;
}

/** 消息时间戳的钟面：小时和分钟，meta 行读取的方式。 */
function formatClockTime(timestamp: number): string {
	const at = new Date(timestamp);
	const part = (value: number): string => String(value).padStart(2, "0");
	return `${part(at.getHours())}:${part(at.getMinutes())}`;
}

/** chip 的 token 数：一千以下整数，以上一位小数。 */
function shortTokens(total: number): string {
	return total < 1000 ? String(total) : `${(total / 1000).toFixed(1)}K`;
}

/** 底部读取的结算时长：十秒以下带一位小数，以上用钟面。 */
function formatElapsed(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	return formatTick(ms);
}

/** 跳动行的钟面：分和秒，补零。 */
function formatTick(ms: number): string {
	const total = Math.floor(ms / 1000);
	const part = (value: number): string => String(value).padStart(2, "0");
	return `${part(Math.floor(total / 60))}:${part(total % 60)}`;
}

/** 推理块的第一行非空行，折叠行摘要的来源。 */
function firstLineOf(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0) return trimmed.replace(/^#{1,6}\s+/, "");
	}
	return "";
}

/**
 * 折叠行头部携带流式思考的多少，字符数。
 *
 * 头部是一行被截断的文本，所以思考里唯一有话可说的部分是它的结尾。上限让写入有界：思考可以长到
 * 几万字符，头部每帧只重读它的尾部，而不是整个。
 */
const TAIL_CHARS = 240;

/**
 * 把流式思考的结尾写进折叠行的头部。
 *
 * 这曾经是一个 marquee —— 轨道携带全文两次，用 `translateX(-50%)` 动画循环。文本仍在到达时它
 * 无法保持平滑：百分比平移按轨道**当前**宽度的一半移动，所以每追加一个字符，可见文本就被移动
 * 它追加量的一半。分桶写入让情况更糟而不是更好 —— 头部变成每两秒跳一次，正是读者报告的
 * "思考一卡一卡"。所以头部显示尾部：行在右缘生长，起点被遮罩裁掉，这就是没有被滚动的 ticker
 * 该有的样子。
 */
function patchTail(view: ReasoningView, text: string): void {
	if (view.tailText === text) return;
	view.tailText = text;
	const tail = text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text;
	// 无论思考做过什么都是一行：头部是一行，`nowrap` 条里的换行就是一个丢失的字符。
	const line = tail.replace(/\s+/g, " ").trimStart();
	if (view.tail.textContent !== line) view.tail.textContent = line;
}

/**
 * 一张工具卡片，读作一行：名字，然后一条短路径，再无其他。
 *
 * 调用读作 `Read  README.md` —— 名字在前，后面一个认得出的参数 —— 整行在悬停前安静地着色，
 * 所以一串工具步骤读作安静的一块（01 ④）。卡片没有自己的盒子；展开才揭示内容，行下一个缩进的
 * 块。改了文件的调用显示变更本身而不是它的文本：diff 携带路径和计数，那正是工具自己的文本在那
 * 里要说的事。
 *
 * 参数里没有任何认得出的东西的卡片只显示名字 —— 不会为调用没带的东西发明占位符。
 */
function renderTool(card: ToolCard): HTMLElement {
	const details = element(
		"details",
		`tool${card.isError ? " error" : ""}${card.running ? " running" : ""}${card.waiting ? " waiting" : ""}`,
	);
	// 等待中的卡片像运行中的一样打开：它要说的话就是运行停下的理由，读者不该为了找到答案去哪了
	// 而展开这一行。
	if (card.isError || card.running || card.waiting) details.open = true;

	const summary = element("summary");
	const chevron = element("span", "tool-chevron");
	chevron.append(icon("chevron"));
	summary.append(
		chevron,
		element("span", "tool-name", card.toolName),
		element("span", "tool-path", previewOf(card.args) || (card.diff?.relPath ?? "")),
	);
	if (card.diff) summary.append(diffStat(card.diff));
	// 行右端的标记就是阶段：调用执行时脉冲，等待让它运行的答案时静止。两个标记都不与 diffstat
	// 共享一行，理由相同。
	if (card.running) summary.append(element("span", "tool-spin"));
	if (card.waiting) summary.append(element("span", "tool-wait"));

	details.append(summary, card.diff ? renderFileDiff(card.diff) : outputOf(card));
	return details;
}

function outputOf(card: ToolCard): HTMLElement {
	const output = element("pre", "tool-output");
	output.textContent = card.output.length > 0
		? card.output
		: card.running
			? "运行中…"
			: card.waiting
				? "等待审批——本轮运行在此调用前暂停，答案到达后继续。"
				: "无输出";
	return output;
}

/**
 * 工具卡片折叠时显示的唯一参数。
 *
 * 这些是仅凭一个值就能认出调用的工具，按最好读的顺序：shell 命令，然后路径，然后模式。其他的
 * 什么都不显示，而不是显示一段 JSON —— 那只是展开后的卡片已经展示的内容的更差版本。
 */
function previewOf(args: unknown): string {
	if (args === undefined || args === null) return "";
	const record = args as Record<string, unknown>;
	for (const key of ["command", "path", "pattern", "include"]) {
		const value = record[key];
		if (typeof value === "string") {
			const single = value.replace(/\s+/g, " ").trim();
			return single.length > 90 ? `${single.slice(0, 87)}…` : single;
		}
	}
	return "";
}
