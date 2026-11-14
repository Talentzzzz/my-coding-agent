import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type Agent,
	type AgentSessionEvent,
	type ChatTransport,
	createSessionAgent,
	type ModelConfig,
	resolvePath,
	type SessionSnapshot,
} from "@my-agent/core";

export interface HubOptions {
	/** 进程启动时所在的目录；新会话以它为工作目录。 */
	workDirAbsPath: string;
	/** 连接未指名时落到的会话。 */
	sessionId?: string;
	/**
	 * 读取和写入全局设置所用的 agent home。默认是真实的那一个。
	 *
	 * `BootOptions` 的透传，理由相同：演练*写*设置命令的 smoke 不得写机器自己的文件。生产中没有任何东西设置它；把设置存放在别处的宿主会提供存储后端而不是这个路径。
	 */
	settingsHome?: string;
	/**
	 * 读取和写入导入模型行所用的 agent home。默认是真实的那一个。
	 *
	 * 与 {@link settingsHome} 相同的透传，对应另一个文件：把模型行交给 hub 的 smoke——脚本化 transport 应答它们，无需 provider key——不得把它们留在机器的 `models.json` 里，也不得依赖运行它的人恰好在那里配置了什么。
	 */
	modelsHome?: string;
	/**
	 * 本 hub 打开的每个会话所对话的 transport。
	 *
	 * 真实进程里省略，意味着 Anthropic Messages。smoke 传入脚本化 transport，让活会话的行在没有 provider key 的情况下也能被驱动——没有它，会话能发布的唯一事件就是那些根本不需要模型的事件。
	 */
	api?: ChatTransport;
}

/**
 * 一个会话自己的两条 feed，按运行中的会话持有的原样交出。
 *
 * 给的是原始物而不是成品帧：审批差异是按订阅者划分的状态，每个订阅者从这些 feed 自建帧。每次订阅返回停止的方式，这让订阅者能在宿主消失时放下这一对。
 */
export interface SessionFeeds {
	/** 会话发布的每个事件，按序。 */
	onEvent(listener: (event: AgentSessionEvent) => void): () => void;
	/** 会话的状态，每当有东西发布了它的新快照。 */
	onChange(listener: (snapshot: SessionSnapshot) => void): () => void;
}

/**
 * 按 id 观看某个会话的东西，被告知何时有活会话可看、何时没有。
 *
 * 本进程运行该会话时以 feed 调用，停止时以 `undefined` 调用——包括只在被观看的会话，它会在什么都没挂上的情况下收到第二次调用。只被告知自己已打开的会话的订阅者，恰恰会对最重要的情况失明：看着一个空闲会话、然后在消息到来时它开始运行。绑定到 id 而不是 `Agent`，正是让它能存活的东西。
 */
export type SessionObserver = (feeds: SessionFeeds | undefined) => void;

/**
 * 本进程保持打开的一个会话，加上它身上有多少个 hold。
 *
 * 计数是 hold 得以工作的原因：一个离开的请求不能停掉另一个请求正在观看的一轮，而最后一个离开的也不能让会话永远运行下去。
 *
 * 上面没有别的东西。会话本身是进程唯一的 orchestrator（ADR-0012）——一个方法指名 id、取回它需要的一切——它的活的一半是该 orchestrator 表中为该 id 持有的状态（ADR-0013）。剩下的就是这两者都答不了的那一个问题：此刻是谁把这个会话 hold 着。那是一个 transport 层的问题（ADR-0001），所以它的计数住在 transport 层，而不是住在一个它永远不会去读的 core 状态上。
 *
 * host 还是"会话被 hold 吗"与"会话在运行吗"这两个问题之间的差距：orchestrator 的表从 id 存在的那一刻起就能回答第一个，而 host 只在 hold 打开了会话期间存在——所以 `hosts` 永远是表的子集，表只在它所属的 host 消失后才会被清。
 */
export class HostedSession {
	readonly id: string;
	/**
	 * hub 正在决定一个无人 hold 的会话能否关闭时置位。
	 *
	 * hold 计数本身是 orchestrator 的（ADR-0013：表中的驻留，不是某个连接的兴趣）——这个对象只携带 hub 为之路由 feed 的 id。
	 */
	reaping = false;

	constructor(sessionId: string) {
		this.id = sessionId;
	}
}

/**
 * 本进程获得或失去一个会话时被告知：创建、fork、打开、关闭。
 *
 * 与 {@link SessionHub.observe} 是不同的问题，两者刻意分开。这个回答"本进程知道哪些"，所以它触发时完全可以没有任何连接；`observe` 回答"此刻谁在看这个会话"，是淘汰边读取的那面镜子。想要前者却订阅了后者的读者，会发现自己在无人观看的会话上永远不会被调用——而这恰恰是它存在要去注意的情况。
 */
export type HostListener = (sessionId: string, host: HostedSession | undefined) => void;

/**
 * 本进程拥有的会话，按会话 id 键控。
 *
 * 每个会话 id 一个 agent loop，无论多少浏览器在看它。这就是全部要点：按流决定曾意味着同一会话的两个 tab 在同一份 JSONL 文件上建了两个 loop、各自独立追加。文件仍然是持久副本；这张表记录的是谁把会话 hold 着。
 *
 * loop 本身不是按会话的：一个 orchestrator 服务所有 id（ADR-0012）。按会话的是 hold——一个关于"此刻谁在使用它"的 transport 层事实，由 orchestrator 计数，因为它正是让该会话状态留在表里的东西——以及 orchestrator 表中持有活的那一半的状态。这里其余的一切都是单例。
 */
export class SessionHub {
	/**
	 * 本进程启动时所在的目录。
	 *
	 * 它是一个默认值，不是会话工作的目录：新会话以它为 workDirAbsPath，设置面板也以它为范围。会话自己的目录来自它的 header，可能指名机器上的任何目录——orchestrator 的表持有它，hub 永远不需要它：fork 的源路径解析住在 facade 内（ADR-0012）。
	 *
	 * 构造之后没有任何东西移动它，这就是用户在本进程背后重命名的文件夹不被跟随的原因：一个猜测新名字的默认值，会把下一个新会话放到没人要求的地方。
	 */
	private absRoot: string;

	/** 当前默认目录。 */
	get workDirAbsPath(): string {
		return this.absRoot;
	}
	private readonly options: HubOptions;
	private readonly hostedSessionMap = new Map<string, HostedSession>();
	/**
	 * 本进程运行的每个会话都要经过的唯一 orchestrator，也是进程各 manager 的唯一消费者（ADR-0012）：设置之门、模型行、工具表、会话存储都住在它的 facade 后面，所以这里拼装的一个会话、一次模型行的编辑、一次设置的写入，到达的都是它读取的同一批对象。只构建一次，因为它不持有会话：一个方法指名 id、从自己表中的状态解析所需——持久的一半、设置、活的一半（ADR-0013）。会话状态在其 id 存在的那一刻进入那张表——创建时拼装并收养，磁盘上的一个在其首次打开时被收养——并通过 orchestrator 自己的 `evict` / `drop` 离开，因为表只有一个删除者。
	 *
	 * 它通过 facade 而不是副本读模型行，这正是设置面板里改对的 key，就是已打开会话下一条消息发送的 key 的原因。
	 */
	readonly agent: Agent;
	/** 进行中的打开，让两个调用者无法在同一个 id 上建两个会话。 */
	private readonly opening = new Map<string, Promise<HostedSession>>();
	/** 进行中的关闭，让新调用者无法打开一个还在被写的文件。 */
	private readonly closing = new Map<string, Promise<void>>();
	/**
	 * 谁在观看每个会话，按 id——订阅的来去都要穿过的那面镜子。
	 *
	 * 永远不是计数，也永远不是让会话保持存活的理由：观看一个会话不让它运行，运行它也不意味着有人在看。只有两件事读这张表，没有别的——路由，以及一个会话的最后一个观看者离开时触发的淘汰边（issue 04 §3）。
	 */
	private readonly observers = new Map<string, Set<SessionObserver>>();
	/**
	 * 谁仍在等每个会话上一次运行的结果，按 id——send 引用的服务器侧信号（issue 13），由 mux 的 `wait` / `unwait` frame 上报。
	 *
	 * 形状上是订阅的孪生，含义上是它的反面：观看是开放的（窗格在窗口看着期间一直在），等待是有界的（一个 send 的寿命恰好等于它发起的那次运行，客户端在运行的最后一句话到达时释放它）。与 `observers` 一样，它永远不是计数、也永远不是让会话保持*运行*的理由——它不占 hold，一个失去全部 hold 的 host 会在 waits 还挂着的情况下照常 reap。它唯一的读者是淘汰判断：标准拒绝一个仍有人在等的会话，因为运行结束与客户端释放之间的淘汰，恰恰是 send 引用存在要防的那种无声撕裂。客户端那份"运行已结束"的认知落后服务器一帧——这张表就是为这个差异买单的地方，而不是把它辩解掉的地方。
	 */
	private readonly waiting = new Map<string, Set<() => void>>();
	/** 进程级监听者，被告知本进程获得或失去的每个会话。 */
	private readonly hostListeners = new Set<HostListener>();
	/**
	 * 未指名落点的应答依据（{@link currentSessionId}）：最后一个被显式创建的会话，或还没有——`undefined` 是欢迎态在服务器侧的那一半。这里没有任何东西创建会话；唯一的写入者是显式创建（`newSession`、fork），历史是侧栏的事：恢复它是点某一行，不是服务器去猜。
	 */
	private current?: Promise<string>;

	constructor(options: HubOptions) {
		this.options = options;
		this.absRoot = options.workDirAbsPath;
		// 一行构造，各 manager 是 orchestrator 自己的（ADR-0012）：这个 hub 贡献的只有这些 home——smoke 的内存闸门或模型行在此运行之前就被播种到它们背后的文件里，对象图的其他一切都不归这个 hub 决定。
		this.agent = createSessionAgent({
			...(options.settingsHome === undefined ? {} : { settingsHome: options.settingsHome }),
			...(options.modelsHome === undefined ? {} : { modelsHome: options.modelsHome }),
			...(options.api === undefined ? {} : { api: options.api }),
		});
	}

	/** 用户录入的模型，按它们在设置面板中出现的顺序。 */
	get userModels(): readonly ModelConfig[] {
		return this.agent.modelCatalog();
	}

	/**
	 * 替换存储的模型。
	 *
	 * 事后不需要任何对齐：会话在每次请求时通过 {@link settings} 读 catalog 并从所指的行重新推导模型，所以下一条消息用的已经是新的行——面板里改对的 key 就是那条消息发送的 key，endpoint、窗口、wire id 同理，包括来自一直开着的窗口的消息。
	 */
	setModelConfigs(models: readonly ModelConfig[]): void {
		this.agent.replaceModels(models);
	}

	/**
	 * 本进程的列表是否仍指名这个目录：用户放到一边的目录被排除在外。
	 *
	 * 一个规则一个家，因为窗口了解机器目录的路有两条——REST 列表和通道的 overview——两个过滤器意味着任何一侧变化时第一次就会出现两个答案。列表本身是一个 settings 事实，通过与写它的命令相同的全新读取获得，所以一次 hide 在下一次查看时对两条路都可见。
	 *
	 * 没有 root 的 hub 回答"全部都在列"。这不是生产状态——`HubOptions` 要求 `workDirAbsPath`，`bootServer` 总是传它——但 `scripts/smoke-approval.ts` 刻意构建了一个没有它的（`docs/notes.md` §一 固定了这个构造，该节自挂会话、且不向目录问任何东西）。过滤器的全部职责是把组排除在外，而这里没有被排除的任何东西。
	 */
	listsDirectory(workDirAbsPath: string): boolean {
		if (typeof this.absRoot !== "string") return true;
		return !this.agent.hiddenDirectories(this.absRoot).some((path) => samePath(path, workDirAbsPath));
	}

	/** 本进程此刻正在运行的会话 id。 */
	get live(): readonly string[] {
		return [...this.hostedSessionMap.keys()];
	}

	/**
	 * 会话的当前状态，从它的文件读取，外加本 hub 的一次淘汰巡查。
	 *
	 * 读取不拼装任何东西（ADR-0013）：orchestrator 的 `snapshotOf` 打开一只袋、从中应答、然后丢弃，表与读取前完全相同。读取仍然值得做的，是给了我们一个看表的机会：这是有人正在关注这个 id 的时刻之一，所以淘汰的询问搭在这里而不是 orchestrator 里——"有没有人在读"是本 hub 自己的表（`observers` / `waiting`），orchestrator 要回答它就得被告知订阅的存在。它知道的是运行是否在途、审批是否停靠、袋是否尚未落盘，而 `evict` 会自己复查那些。
	 *
	 * host 站着是另一回事，不予处理：reap 才是结束一个被托管会话的路，而 reap 在等它身后的运行——一次读取不得成为替某人的一轮做决定的东西。
	 */
	async snapshotOf(id: string): Promise<SessionSnapshot> {
		const snapshot = await this.agent.snapshotOf(id);
		// host 站着时不动（那是 reap 的路，而 reap 在等运行），open 进行到一半时也不动：它的 hold 在 `open` 里、host 落表前一拍就被拿走，这一次巡查若在间隙里跑就会把它底下的状态抽走。
		if (!this.hostedSessionMap.has(id) && !this.opening.has(id) && !this.closing.has(id)) this.tryEvict(id);
		return snapshot;
	}

	/**
	 * 会话的当前状态，同步读取，供已经持有一个活 host 的调用者。
	 *
	 * {@link snapshotOf} 的同步孪生，它存在的原因是 mux 的一条保证：订阅的 baseline 必须在挂上 feed 的同一个同步代码块里写出，否则两者之间发布的变更会先于它所描述的状态到达客户端。那个窗口里的一个 `await` 不只是慢——它是整个恢复故事赖以立足的那条保证上的一个洞。
	 *
	 * 所以这里拒绝而不是猜测：走到这里意味着调用者相信会话是活的，如果它不是，那个相信就是值得听一耳朵的 bug，而不是值得编造一个快照的情况。
	 */
	snapshotNow(id: string): SessionSnapshot {
		const host = this.hostedSessionMap.get(id);
		if (host === undefined) throw new Error(`Session is not running: ${id}`);
		return this.agent.snapshot(host.id);
	}

	/**
	 * 连接未指名时落到的 id，`null` 表示"没有可落的"。
	 *
	 * 客户端问它而不是自作主张，因为策略属于服务器：`--session` 固定一个，否则答案是本进程最后创建的或被指示指向的——或 `null`，窗口停留在欢迎态、什么都不选。这里没有任何东西创建会话：启动什么都不选，而自选"最新文件"的客户端会悄悄无视固定值，显示一个与服务器正在服务的不同的会话。
	 */
	currentSessionId(): Promise<string | null> {
		if (this.options.sessionId !== undefined) return Promise.resolve(this.options.sessionId);
		if (this.current === undefined) return Promise.resolve(null);
		return this.current;
	}

	/**
	 * 为一条连接 hold 一个会话，本进程尚未运行它时先打开。
	 *
	 * 每条出口路径要么返回已在 map 中的会话，要么等待同一个 id 上正在打开或关闭的那个，所以两个 loop 永远不会落进同一份会话记录。
	 */
	async hold(sessionId: string): Promise<HostedSession> {
		const id = sessionId;

		const existing = this.hostedSessionMap.get(id);
		if (existing) return this.count(existing);

		const closing = this.closing.get(id);
		if (closing) await closing;

		const reopened = this.hostedSessionMap.get(id);
		if (reopened) return this.count(reopened);

		const opening = this.opening.get(id);
		if (opening) return this.count(await opening);

		const started = this.open(id);
		this.opening.set(id, started);
		try {
			// 打开者自己的 hold 在 `open` 里、feed 接线之前就拿走了；这里再计一次会让第一个调用者变成两个持有者。
			return await started;
		} finally {
			this.opening.delete(id);
		}
	}

	/**
	 * 放弃一条连接的 hold。
	 *
	 * 刻意既不 abort 也不 close：在途的一轮继续跑、继续持久化，所以刷新、关 tab、切换会话都不能截断会话记录。最后一个 hold 放开后，会话在其运行落定之后关闭；orchestrator 的状态在 reap 的尾部按它自己的标准走——停靠的审批、未出生的文件、仍在等运行结果的调用者（issue 13）让它留下，空闲的会话让它离开。JSONL 文件保留，下一个来问这个 id 的连接得到一个等价的会话。
	 */
	release(host: HostedSession): void {
		this.agent.release(host.id);
		if (this.agent.holdsOf(host.id) > 0 || host.reaping) return;
		void this.reap(host);
	}

	/**
	 * 观看一个会话的事件和状态，无论本进程是否已在运行它。
	 *
	 * 返回停止观看的方式。观察按 id 键控，该 id 的 host 一出现就重绑，所以"看着一个空闲会话，然后给它发条消息"一直有效：消息拼装出 host 的那一刻，同一个观察者就被挂上去。
	 *
	 * 挂上不是把它 hold 开，它也不拼装任何东西（ADR-0013）：一个观看欠下的 baseline 就是一次文件重放。这个 entry 买到的仍是淘汰判断——因*别的原因*而存在的状态（一次运行、一个队列、一只尚未落盘的袋）不会在有人的视线里被拆除，而这个集合就是 hub 在这个问题上自己的一半。它也是让还没有文件的会话存活的东西，因为在那里状态就是会话。
	 */
	observe(sessionId: string, observer: SessionObserver): () => void {
		const watching = this.observers.get(sessionId) ?? new Set<SessionObserver>();
		if (!this.observers.has(sessionId)) this.observers.set(sessionId, watching);
		watching.add(observer);

		const host = this.hostedSessionMap.get(sessionId);
		observer(host === undefined ? undefined : this.feedsOf(host));

		return () => {
			watching.delete(observer);
			if (watching.size === 0) {
				this.observers.delete(sessionId);
				// 最后一个观看者离开是淘汰的一条边（issue 04 §3）：一个障碍刚倒下，所以标准获得它们的一次尝试——经由 `tryEvict` 漏斗，它复查整个集合而不是只看触发的那条边。
				this.tryEvict(sessionId);
			}
		};
	}

	/**
	 * 记录本调用者在等一个会话上某次运行的结果，直到它喊停。
	 *
	 * send 引用的服务器侧一半（issue 13）。它不占 hold——hold 说有人在*改变*会话，而 wait 只说答案还有地方可落——它也不让任何东西继续运行：hold 尽失的 host 在 waits 还挂着时照常 reap，因为等待者应得的结果在运行结束时已经发布到流上了。wait 买到的是那次发布与客户端自己释放之间的窗口：那里拒绝淘汰，所以窗口内回来的窗格发现会话仍被 hold 着，而不是在自己的手势中途被磁盘悄悄重建。
	 *
	 * 键控和形状与 {@link observe} 有意相同——每个等待的调用者一个 entry，返回值是停止的方式——mux 因此可以对应答的每个 `wait` frame 持有一个，让连接拆除时释放它们的方式与释放订阅一致。按调用者幂等：重连的 replay 重新上报 wait，报两次也是一个 entry。
	 */
	awaitResult(sessionId: string): () => void {
		const waiting = this.waiting.get(sessionId) ?? new Set<() => void>();
		if (!this.waiting.has(sessionId)) this.waiting.set(sessionId, waiting);
		const stop = (): void => {
			waiting.delete(stop);
			if (waiting.size === 0) {
				this.waiting.delete(sessionId);
				// 最后一个等待者被应答是淘汰的一条边（issue 04 §3，wait 由 13 加入）：又一个障碍倒下，服务观看者离开的同一个漏斗也服务这一条。
				this.tryEvict(sessionId);
			}
		};
		waiting.add(stop);
		return stop;
	}

	/**
	 * 一次淘汰尝试：每条边都经过的漏斗，hub 侧标准被完整复查的唯一地方。
	 *
	 * 边是一个障碍倒下——最后一个观看者离开、最后一个等待者被应答——而规则（issue 04 §3）是：倒下触发一次尝试，其中*每一个*条件都被重新读取，而不只是动了的那个：状态变化与删除点是异步的，期间可能又有障碍立起。`observers` 和 `waiting` 在这里读取，因为它们是判断中 hub 自己的那一半；orchestrator 在 `evict` 里复查它的三个（运行在途、审批停靠、文件尚未出生）并拒绝有损的那部分。host 仍站着意味着有人仍在 hold 会话——删除不能被直接请求（表只在 host 消失后才清），所以走 host 自己的出路，即 reap：它落定、关闭，最后走到同一个判断上，此刻 waits 已在其中。
	 */
	private tryEvict(sessionId: string): void {
		if (this.observers.has(sessionId)) return;
		if (this.waiting.has(sessionId)) return;
		const hostedSession = this.hostedSessionMap.get(sessionId);
		if (hostedSession === undefined) this.agent.evict(sessionId);
		else if (!hostedSession.reaping) void this.reap(hostedSession);
	}

	/**
	 * 此刻是否有任何人在观看一个会话。
	 *
	 * 这是一个"空不空"的问题，而不是计数，并且刻意不是计数：唯一的读者是想知道会话何时不再被观看的淘汰边，给它一个数字会诱使它推理"有多少"——那正是把集合变成本 hub 不该有的第二个计数器的替换。
	 */
	isWatched(sessionId: string): boolean {
		return (this.observers.get(sessionId)?.size ?? 0) > 0;
	}

	/**
	 * 被告知本进程获得或失去的每个会话。
	 *
	 * 对创建或 fork 的会话触发（没有 host，因为还没有在运行）、对其 host 打开的会话触发、对其 host 关闭的会话触发。返回停止监听的方式。
	 *
	 * 之所以是与 {@link observe} 分开的接缝：想要"我知道的每个会话"的调用者不得同时成为订阅者，否则一个无人观看的会话根本不会被上报。
	 */
	onHostChange(listener: HostListener): () => void {
		this.hostListeners.add(listener);
		return () => {
			this.hostListeners.delete(listener);
		};
	}

	/**
	 * 开始一个会话，并让它成为下一个未指名连接的落点。
	 *
	 * 返回 id 而不是被 hold 的会话，让 hold 恰好发生在一个地方：调用者通过 {@link hold} 挂上，那是唯一拿 hold 的东西。
	 *
	 * `workDirAbsPath` 决定会话落在哪。未定义就是服务器自己的 root；路径只要存在且是目录就接受，没有更多条件——在一个没人工作过的目录里创建第一个会话，正是新目录进入已知列表的唯一正道，而 header 的 workDir 是工具的默认值而不是进程的，所以这里不属于做已知目录检查的地方。
	 */
	async newSession(workDirAbsPath?: string): Promise<string> {
		const absRoot = await workDirAbsPathForCreate(this.agent, workDirAbsPath ?? this.workDirAbsPath);
		const id = await this.agent.create(absRoot);
		this.current = Promise.resolve(id);
		this.announceHost(id, undefined);
		return id;
	}

	/**
	 * 在一个 entry 处分支一个会话，返回新会话的 id。
	 *
	 * 与 {@link newSession} 相同，返回 id 而不是被 hold 的会话：调用者通过 {@link hold} 挂上，注册与 hold 计数因此留在一个地方。fork 属于这里而不属于 `Connection`，因为新会话必须活得比请求它的连接更久——与其他每个会话的理由相同。
	 *
	 * 源会话只被读。它的文件不被触碰，它自己的 `leafId` 不动，本进程正在运行的会话从它正在写的文件 fork，所以任何 hold 都不被打扰，在途的一轮继续写它正在写的。
	 *
	 * 注册表在这里也没有收获：无人 hold 的 fork 没有要养活的活的一半——没有队列排空过、没有运行在途——所以它的第一次触碰就是它的第一个 hold，那正是通过 {@link open} 拼装其状态的东西。orchestrator 的表也没有收获：facade 的 `forkFrom` 写两个文件、不收养任何东西（ADR-0012）。状态离开那张表只有 orchestrator 自己的 close 和 evict 两条路，从不经由本 hub 的手。
	 */
	async fork(sessionId: string, entryId: string | null): Promise<string> {
		// 源会话只被定位和读取——被 hold 的袋自己的文件，或 facade 的磁盘扫描——两条路都是一次 facade 调用。fork 的两侧就是一次源路径读取和一对写入，而文件是每个 entry 都已落上去的权威。
		const id = this.agent.forkFrom(sessionId, entryId);
		this.current = Promise.resolve(id);
		this.announceHost(id, undefined);
		return id;
	}

	/**
	 * 给会话一个自己的名字，存为其 `.json` 快照上的 title。
	 *
	 * 被 hold 的路和冷的路是一次 facade 调用，安全性论证随它一起：被 hold 的会话通过自己的袋写，冷的写入是一个同步代码块，两者都不占 hold——title 是关于会话的事实而不是关于某条路径的事实，引擎从不读 title，运行中途重写快照落地时不会打扰那一轮。什么都不指名的 id 在 facade 内拒绝，那始终就是那个 404。
	 *
	 * title 到达时已经缩短；写进文件的就是一行会显示的东西。
	 */
	async rename(sessionId: string, title: string): Promise<void> {
		this.agent.setTitle(sessionId, title);
	}

	/**
	 * 本进程自己的 root 换了目录：被重命名的文件夹。这是一个默认值，不是某个会话工作的目录——见 {@link workDirAbsPath}——所以只有已经从它派生的路径被放下，正在运行的任何东西都不受影响。
	 */
	setRoot(workDirAbsPath: string): void {
		this.absRoot = workDirAbsPath;
		this.current = undefined;
	}

	/**
	 * 删除一个会话：会话记录、文件，以及本进程中关于它的每一丝痕迹。
	 *
	 * 有工作在途的会话拒绝而不是在其底下删除——正在写文件的运行、等人回答的审批、还 hold 着的请求、进行到一半的 open——controller 把这个拒绝变成 409。空闲会话按被 reap 的方式关闭（通知 observers、宣布 listeners、`settle` 先于 `close`），`closing` 槽位横跨整个移除持有，删除中途到来的 hold 会等待、然后发现没有文件，而不是打开一个即将消失的文件。
	 *
	 * 未指名的落点被重置：它指名的东西没了，下一次询问针对剩下的重新解析，而不是用一个已不存在的会话作答。
	 */
	async remove(sessionId: string): Promise<void> {
		// 数据的一半是 orchestrator 的：文件是否存在、表中的状态，是一次调用（`Agent.remove`），本方法从不问自己在删除两者中的哪一个。留在这里的是 hub 自己的簿记——hosts、observers 和 `closing` 槽位；hold 是 orchestrator 的，问它是否还有站着的即可。
		const hosted = this.hostedSessionMap.get(sessionId);
		if (hosted !== undefined) {
			if (this.agent.holdsOf(sessionId) > 0 || this.opening.has(sessionId) || this.agent.isSubmitting(sessionId) || this.agent.hasPendingApprovals(sessionId)) {
				throw new Error("这个会话还有运行中的轮次或没答完的审批，等它停下来再删。");
			}
			const closing = (async () => {
				await this.agent.settle(sessionId);
				if (this.hostedSessionMap.get(sessionId) === hosted) this.hostedSessionMap.delete(sessionId);
				// 与 reap 相同的顺序：observers 先失去 feed，listeners 后听到失去的消息，订阅者永远不会伸手去够一个已经不在的会话。
				for (const observer of this.observers.get(sessionId) ?? []) observer(undefined);
				this.announceHost(sessionId, undefined);
				// 刚被通知的 observers 可能当场拆掉自己的订阅，最后一个退出的触发淘汰边——它找不到 host、先把状态丢掉。表已不持有的 id 上，close 立即应答。
				await this.agent.close(sessionId);
				// 文件与被 hold 的状态一起消失，在同一个槽位内：等过 `closing` 的 hold 只在文件消失之后才恢复，于是发现没有文件，而不是在删除中途重开一个。从未开口的会话没有文件，那是 orchestrator 裁决的情况，不是本方法的。
				await this.agent.remove(sessionId);
			})();
			this.closing.set(sessionId, closing);
			try {
				await closing;
			} finally {
				this.closing.delete(sessionId);
			}
		} else {
			// 没有 host：本进程没有任何东西在运行它，orchestrator 的一次删除就是全部移除。什么都不指名的 id 在那里拒绝，那个拒绝就是 404。
			await this.agent.remove(sessionId);
		}
		this.current = undefined;
	}

	/**
	 * 进程退出前停止每次运行并落定每个会话。
	 *
	 * `close()` 停掉运行本身，这就是本方法的边界——一个长工具不能拖住 shutdown。等待中的调用原样保留：会话记录是唯一的状态，所以重启继承的仍是一个可回答的问题，而不是一个没人做过的拒绝。
	 */
	async close(): Promise<void> {
		const hosts = [...this.hostedSessionMap.values()];
		await Promise.all(hosts.map((host) => this.agent.close(host.id)));
		// hosts 在 observers 被通知之前离开 map。以此为终的订阅触发淘汰边，而边必须找不到 host——否则它会对一个已在关闭中的 hub 发起自己的 reap。
		for (const host of hosts) if (this.hostedSessionMap.get(host.id) === host) this.hostedSessionMap.delete(host.id);
		for (const host of hosts) {
			for (const observer of this.observers.get(host.id) ?? []) observer(undefined);
			this.announceHost(host.id, undefined);
		}
		this.hostedSessionMap.clear();
		// orchestrator 的状态表不在这里清扫：它住在 orchestrator 身上，关闭 hub 的进程把 orchestrator 一起带走。对活着的 hub 清表，等于第二个写者越过拥有那些状态的 orchestrator 伸手。
	}

	/** 把一个持有者计进来，与 `release` 把它计出去的方式对应。 */
	private async count(host: HostedSession): Promise<HostedSession> {
		await this.agent.hold(host.id);
		return host;
	}

	/**
	 * 打开一个本进程尚未运行的会话文件。
	 *
	 * 工作目录来自会话记录自己的 header 而不是服务器的 root，因为侧栏提供机器上的每个目录：从另一个组打开的会话，其工具必须解析到它被写下之处，其审批来自那个目录的设置。
	 *
	 * 这里拿的 hold 是第一个：它把会话状态带进 orchestrator 的表，下面的 feed 正是针对它接线的。hub 从不问状态是否已在——{@link Agent.hold} 对两条路一并作答（ADR-0013）。
	 */
	private async open(id: string): Promise<HostedSession> {
		await this.agent.hold(id);
		const host = new HostedSession(id);
		this.hostedSessionMap.set(id, host);
		// 先 observers，后 listeners：被告知"host 开了"并伸手去够会话的订阅者，必须发现它已经交出。
		const feeds = this.feedsOf(host);
		for (const observer of this.observers.get(id) ?? []) observer(feeds);
		this.announceHost(id, host);
		return host;
	}

	/**
	 * 一个活 host 自己的两条 feed，包装成订阅者可以握住的一对。
	 *
	 * orchestrator 是发布事件的唯一者，所以 hub 的触达到此为止——订阅者从这两条 feed 构建什么，是它自己的事。绑定由订阅者自己撤销，因为两条 feed 各自交回自己的退路。
	 */
	private feedsOf(host: HostedSession): SessionFeeds {
		return {
			onEvent: (listener) => this.agent.onEvent(host.id, listener),
			onChange: (listener) => this.agent.onChange(host.id, listener),
		};
	}

	/** 告诉进程级监听者：一个会话出现了、开始了或消失了。 */
	private announceHost(sessionId: string, host: HostedSession | undefined): void {
		for (const listener of this.hostListeners) listener(sessionId, host);
	}

	private async reap(host: HostedSession): Promise<void> {
		host.reaping = true;
		try {
			// 中途被释放的运行继续跑、继续持久化，所以这里的 settle 就是让一轮在任何东西被拆掉之前完成的东西。在 end-restart 语义下（ADR-0005 §5），停在审批闸门的一轮已经结束——settle 在那里等的不是运行——而它留下的问题不归这次 reap 回答：host 关闭、orchestrator 的状态留下（停靠的审批拒绝淘汰，随之留下恢复运行必须排空的队列），答案经 REST 到达任何一个重新打开会话的 hold。没有窗口应答它，也没有进程 reap 它：问题悬着，直到下一次运行的恢复机制关闭它，或进程退出。
			await this.agent.settle(host.id);
			if (this.agent.holdsOf(host.id) > 0) return;

			if (this.hostedSessionMap.get(host.id) === host) this.hostedSessionMap.delete(host.id);
			// 先告知 observers 再告知 listeners：放下自己半成品工作的订阅者需要 feed 先消失，而对失去做出反应的 listener 是两者中更晚的那个。
			for (const observer of this.observers.get(host.id) ?? []) observer(undefined);
			this.announceHost(host.id, undefined);
			// 刚被通知的 observers 可能当场拆掉自己的订阅，最后一个退出的触发淘汰边——它此刻找不到 host 挡路、可能已经把状态丢掉。表已不持有的 id 上，close 立即应答，所以尾部跑的无论边做了什么：先到的那条边做了本该由这里做的同一件事，只是更早。
			{
				const closing = this.agent.close(host.id);
				this.closing.set(host.id, closing);
				try {
					await closing;
				} finally {
					this.closing.delete(host.id);
				}
				// host 没了，它的活的一半随之而去：排队或运行中的任何东西随会话而死，这与一次进程重启会做的相同，只是一次一个 host。这个删除点把判断中 hub 自己的几半完整读一遍，而不是争论它的前置条件（issue 04 §3）：持有者在上面的 settle 闸门处已被应答，观看者在这里读取，即便上面的通知已经清空了他们——读这个动作本身就是让规则成立的东西——wait 是 hub 的第四个标准（issue 13）：仍在等运行结果的调用者让状态留在表里，最后一个等待者被应答时，其释放正是淘汰它的那条边。对边已经丢掉的状态，evict 应答 `false`，所以删除不需要自己的成员判断分支。
				if (!this.observers.has(host.id) && !this.waiting.has(host.id)) this.agent.evict(host.id);
			}
		} finally {
			host.reaping = false;
		}
	}

}

/**
 * 新会话落点的 root，在写入任何东西之前解析并检查。
 *
 * 检查刻意只有"存在且是目录"。更窄的任何东西——已知目录列表之类——都会封死在进程从未工作过的目录里创建第一个会话的唯一正道，而那恰恰是新目录挣得自己在侧栏中的位置的方式。
 *
 * 导出是因为拒绝应得的 status 由 controller 决定，不是 hub 的：controller 自己跑这个检查，坏路径可以被答成 400；`newSession` 再跑一遍，让任何内部调用者都无法绕过检查写入会话。
 */
export async function workDirAbsPathOrThrow(workDirInput: string): Promise<string> {
	const absRoot = resolve(workDirInput);
	let stats;
	try {
		stats = await stat(absRoot);
	} catch {
		throw new Error(`No such directory: ${absRoot}`);
	}
	if (!stats.isDirectory()) throw new Error(`Not a directory: ${absRoot}`);
	return absRoot;
}

/**
 * 新会话将要在其中运行的目录，本机已有其会话时重建。
 *
 * 用户可以在本进程背后重命名或删除项目文件夹。它的会话记录留在存储里，组仍在列表上、选择器仍能指向它——此时诚实的做法是把目录放回来、空的，因为用户的东西从来没有一样是归我们保管的。本机没有会话的路径仍然拒绝：选择器里的一个拼写错误不得变成一个没人要求的文件夹。
 */
export async function workDirAbsPathForCreate(agent: Agent, workDirInput: string): Promise<string> {
	const absRoot = resolve(workDirInput);
	try {
		return await workDirAbsPathOrThrow(absRoot);
	} catch (error) {
		if (!agent.hasSessionsFor(absRoot)) throw error;
		await mkdir(absRoot, { recursive: true });
		return absRoot;
	}
}

/**
 * 两个路径是否指名同一目录，以查找可以键控的写法比较。
 *
 * 与每个存储路径一样的方式 resolve，并在 Windows 上做大小写折叠，因为比较的两端来自不同的地方——请求 body、会话 header、设置文件——而在那里 `C:\Work` 与 `c:\work` 是同一个目录。symlink 刻意不被跟随：比较关心的是存储以哪个字符串键控，而不是它通向哪里。
 */
export function samePath(a: string, b: string): boolean {
	const left = resolvePath(a);
	const right = resolvePath(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
