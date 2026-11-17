import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type Agent,
	type AgentSessionEvent,
	type ChatTransport,
	createSessionAgent,
	type ModelConfig,
	type ModelSelection,
	resolvePath,
	type SessionEventListener,
	type SessionListener,
	type SessionSnapshot,
	UnknownSessionError,
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
 * 一个会话自己的两条 feed，按订阅者的需要交出。
 *
 * 给的是原始物而不是成品帧：审批差异是按订阅者划分的状态，每个订阅者从这些 feed 自建帧。每次订阅返回停止的方式，这让订阅者能在会话消失时放下这一对。
 *
 * 这两条 feed 背后的分发表是 hub 自己的 feedMap：core 的编排层不再在每只袋上养订阅者集合，它把
 * 事件交给构造时注入的 sink，而 sink 就住在本 hub 里、按 sessionId 查这张表。会话的删除不拆表——
 * 订阅者放下 feed 时各自的退订函数清理自己的条目。
 */
export interface SessionFeeds {
	/** 会话发布的每个事件，按序。 */
	onEvent(listener: (event: AgentSessionEvent) => void): () => void;
	/** 会话的状态，每当有东西发布了它的新快照。 */
	onChange(listener: (snapshot: SessionSnapshot) => void): () => void;
}

/**
 * 按 id 观看某个会话的东西。
 *
 * 注册的同一拍就以 feed 调用——恒有 feed，因为分发按 id 进行，对从未运行过的冷会话同样成立；之后
 * 的事件随运行自流入。`undefined` 只在一个时刻到达：会话被删除（或进程收摊），观看随之结束。绑定
 * 到 id 而不是任何活对象，正是让它能存活的东西：观看从不拼装、从不持有任何东西。
 */
export type SessionWatcher = (feeds: SessionFeeds | undefined) => void;

/**
 * subscribe 交付 baseline 的两口：拿到状态，或者拿到失败。
 *
 * 刻意只有两个成员：订阅方对「baseline 从哪来」没有发言权——活半还是冷半是 hub 内部的决策，
 * sink 只收结果。错误归因的措辞（用户可读的帧文案）不归 hub，hub 交的是原始 error 对象；
 * 措辞是帧层的本域。
 */
export interface SubscriptionSink {
	/** baseline，恰好一次：活半同步到达，冷半在盘上重放完成后异步到达。 */
	onBaseline(snapshot: SessionSnapshot): void;
	/** 冷读取失败（含未知会话），恰好一次；活半不存在失败。此后不再有任何交付。 */
	onError(error: unknown): void;
}

/**
 * 本进程的会话枢纽。
 *
 * 会话本身是磁盘上的两个文件（ADR-0008），进程里没有副本：编排层（ADR-0012）按 id 服务所有会话，
 * 袋由运行自己装配、空闲自散（ADR-0013）。本 hub 记的只有传输层自己的簿记——谁在观看
 * （`watchers`）、事件按 id 从哪张表流出（`feedMap`）。改变会话
 * 的并发保护住在 SessionManager 自己的文件闸里，传输层一概不感知（ADR-0023）。
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
	/**
	 * 本进程运行的每个会话都要经过的唯一 orchestrator，也是进程各 manager 的唯一消费者（ADR-0012）：设置之门、模型行、工具表、会话存储都住在它的 facade 后面，所以这里拼装的一个会话、一次模型行的编辑、一次设置的写入，到达的都是它读取的同一批对象。它不持有会话：一个方法指名 id、从自己表中的状态解析所需——持久的一半、设置、活的一半（ADR-0013）。
	 *
	 * 它通过 facade 而不是副本读模型行，这正是设置面板里改对的 key，就是已打开会话下一条消息发送的 key 的原因。
	 */
	readonly agent: Agent;
	/**
	 * 谁在观看每个会话，按 id——订阅的来去都要穿过的那面镜子。
	 *
	 * 永远不是计数，也永远不是让会话保持存活的理由：观看一个会话不让它运行，运行它也不意味着有人在看。
	 */
	private readonly watchers = new Map<string, Set<SessionWatcher>>();
	/**
	 * 每个会话的分发表，按 id——编排层不再在袋上养订阅者集合后的那两张表的新家。
	 *
	 * core 的编排层把事件与快照交给构造时注入的 sink（ADR-0013），sink 在这里按 sessionId 查表、
	 * 同步遍历分发：emit 点直调，命令与运行的事件从这一张表按序流出，no-gap 契约与原来骑在袋上时
	 * 相同。条目在第一次订阅时出生、在最后一个退订函数清理时消失。
	 */
	private readonly feedMap = new Map<string, { eventListeners: Set<SessionEventListener>; listeners: Set<SessionListener> }>();

	constructor(options: HubOptions) {
		this.options = options;
		this.absRoot = options.workDirAbsPath;
		// 一行构造，各 manager 是 orchestrator 自己的（ADR-0012）：这个 hub 贡献的只有这些 home——smoke 的内存闸门或模型行在此运行之前就被播种到它们背后的文件里，对象图的其他一切都不归这个 hub 决定。
		this.agent = createSessionAgent({
			...(options.settingsHome === undefined ? {} : { settingsHome: options.settingsHome }),
			...(options.modelsHome === undefined ? {} : { modelsHome: options.modelsHome }),
			...(options.api === undefined ? {} : { api: options.api }),
			// 本 hub 就是编排层的订阅宿主：事件与快照交给这个 sink，它按 sessionId 查 feedMap 分发
			// ——骑在袋上的两张表搬到了这里，编排层只认这一个出口。
			sink: {
				onEvent: (sessionId, event) => {
					for (const listener of this.feedMap.get(sessionId)?.eventListeners ?? []) listener(event);
				},
				onState: (sessionId, snapshot) => {
					for (const listener of this.feedMap.get(sessionId)?.listeners ?? []) listener(snapshot);
				},
			},
		});
	}

	/** 用户录入的模型，按它们在设置面板中出现的顺序。 */
	get userModels(): readonly ModelConfig[] {
		return this.agent.modelCatalog();
	}

	/**
	 * 替换存储的模型。
	 *
	 * 事后不需要任何对齐：会话在每次请求时读 catalog 并从所指的行重新推导模型，所以下一条消息用的已经是新的行——面板里改对的 key 就是那条消息发送的 key，endpoint、窗口、wire id 同理，包括来自一直开着的窗口的消息。
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
		return !this.agent.hiddenDirectories().some((path) => samePath(path, workDirAbsPath));
	}

	/**
	 * 会话此刻有活半吗：编排层的表中为它持有的那一半——在飞的运行、排队的后续、停在审批上的袋。
	 *
	 * 判活的答案归编排层（ADR-0012），hub 不养一份自己的副本。刻意不是 `isRunning || hasPendingApprovals`：
	 * 后者是账本事实，冷会话的账本里悬着调用它也为真——而基线来源与行叠加要问的都是"进程持有
	 * 的什么"，不是"盘上可重放的什么"。基线的两个来源站在它两侧：活半在的会话以同步读取作答
	 * （袋里的在飞状态，包括正在写出的 partial），不在的从磁盘重放。
	 */
	isLive(sessionId: string): boolean {
		return this.agent.hasLiveHalf(sessionId);
	}

	/**
	 * 会话的当前状态，从它的文件读取。
	 *
	 * 读取不拼装任何东西（ADR-0013）：orchestrator 的 `snapshotOf` 打开一只袋、从中应答、然后丢弃。它在活半在的会话上读袋、在冷会话上重放，两条路经过同一个函数，所以不可能漂移。
	 */
	async snapshotOf(id: string): Promise<SessionSnapshot> {
		return this.agent.snapshotOf(id);
	}

	/**
	 * 会话的当前状态，同步读取，供活半在场的调用者。
	 *
	 * {@link snapshotOf} 的同步孪生，它存在的原因是 {@link subscribe} 活半的内部依据：baseline 的
	 * 活半来源必须是袋里的在飞状态（包括正在写出的 partial），而快照的活半来源只有同步读取——
	 * 在注册与交付之间的同步块里问一次，no-gap 由构造成立。projection 的读法也站在这里：它只在
	 * 活半在场时读袋，两条路（活半同步、冷半重放）都归 {@link snapshotOf} 与本方法，所以不可能
	 * 漂移。
	 *
	 * 所以这里拒绝而不是猜测：走到这里意味着调用者相信活半在场，如果它不在，那个相信就是值得听
	 * 一耳朵的 bug，而不是值得编造一个快照的情况。
	 */
	snapshotNow(id: string): SessionSnapshot {
		if (!this.isLive(id)) throw new Error(`Session is not live: ${id}`);
		return this.agent.snapshot(id);
	}

	/**
	 * 连接未指名时落到的 id，`null` 表示"没有可落的"。
	 *
	 * 规则只有一条：`--session` 显式钉住一个，否则永远是 `null`——窗口停在欢迎态、什么都不选。
	 * 服务器不去记"最后创建的会话"来填这个答案：恢复历史是用户在侧栏点某一行的行为，不是服务器
	 * 去猜；而自选"最新会话"的答案会悄悄无视钉住值的意义，把一个没人要求的对话拽到新窗口面前。
	 */
	currentSessionId(): Promise<string | null> {
		return Promise.resolve(this.options.sessionId ?? null);
	}

	/**
	 * 订阅一个会话：注册观看、判定活冷、交付 baseline，一体在 hub 内完成。
	 *
	 * 这是 no-gap 契约的机制半的家。返回前 sink 已经拿到 baseline（活半）或知道它在路上（冷半），
	 * 调用方没有任何分岔要自己做——「活半还是冷半、baseline 从哪读」是会话状态的决策，它住在这里
	 * 而不住在任何帧层调用方手里；想违反 no-gap 都没有违反的写法。
	 *
	 * 契约逐条：
	 *
	 * - **活半**：`watcher(feeds)` 在注册的同一拍同步回调（恒交，冷会话同样成立——分发按 id 进行），
	 *   然后在**本方法返回之前的同一同步块内** `snapshotNow` 并同步回调 `sink.onBaseline`。注册与
	 *   快照之间没有任何 `await`、没有任何事件循环拍，所以注册后、快照前不可能有事件落入缝隙。
	 * - **冷半**：`await this.agent.snapshotOf(sessionId)` 读盘重放，完成后**异步**回调
	 *   `onBaseline` **恰好一次**。读盘归 hub：baseline 的读法是会话状态的决策，调用方只收结果。
	 * - **失败**：冷读盘失败（含未知会话的 `UnknownSessionError`）→ `sink.onError(error)` **恰好
	 *   一次**，此后 `watcher` 之外不再有任何交付。hub 交的是原始 error 对象——错误归因的措辞
	 *   （用户可读的帧文案）不归这里。活半不存在失败：快照与判定在同一同步块内，`snapshotNow`
	 *   的前提由构造成立。
	 * - **恰好一次**：由 {@link deliverBaseline} 的 `delivered` 与退订的 `cancelled` 两个标志保证——两条回调互斥、各至多一次；
	 *   冷读盘返回时若订阅已退订，交付随之终结（终结即交付不再发生；退订函数宽容、幂等，与
	 *   退订 feed 的语义相同，最后一个退订清理该会话的条目）。
	 * - **`watcher(undefined)`**：只在会话删除（`remove`）或进程收摊（`close`）时到达，与观看的
	 *   告别语义一字不差——两者的遍历覆盖这里注册的 watcher。
	 *
	 * **两半保证的 hub 半**：no-gap 契约一分为二。hub 保证「注册与快照原子」——上面的同步块是
	 * 机制；顺序论证的依据是 JS 单线程加上这个块里没有 `await`：subscribe 返回时活半的 baseline
	 * 已经交付完毕，此后任何 emit（编排层 sink 的直调）只能发生在下一个事件循环拍，所以订阅方
	 * 先看到状态、再看到其后的每个变更，按发生顺序。另一半（调用方保证 baseline 先于它自己缓存
	 * 的任何帧写出）归订阅方的帧序注释——两半之间的缝就是本方法的返回拍。
	 *
	 * 重发路径不重新订阅，用 {@link rebaseline}：同一个分岔的另一个交付时机，交付契约与这里
	 * 相同，两半保证的论证共用上面这一份，那边引用而不复述。
	 */
	subscribe(sessionId: string, watcher: SessionWatcher, sink: SubscriptionSink): () => void {
		const watching = this.watchers.get(sessionId) ?? new Set<SessionWatcher>();
		if (!this.watchers.has(sessionId)) this.watchers.set(sessionId, watching);
		watching.add(watcher);
		watcher(this.feeds(sessionId));

		// 恰好一次的守门住在 deliverBaseline 内；这里的 `cancelled` 只是退订给冷半的闸——
		// 活半的交付在同一同步块内完成，退订只可能发生在本方法返回之后，拦不到它。
		let cancelled = false;
		this.deliverBaseline(sessionId, sink, () => cancelled);

		return () => {
			cancelled = true;
			watching.delete(watcher);
			if (watching.size === 0) this.watchers.delete(sessionId);
		};
	}

	/**
	 * 给已经持有的订阅重发一份 baseline：回答「这个会话此刻是什么状态」，不回答「之后的变化归谁」。
	 *
	 * 重发路径（对已订阅流的第二个 open、`branch_changed` 触发）需要一份当前状态，但它不能走
	 * {@link subscribe}——那会重复注册 watcher、多挂一条 feed；它也不能自己读盘——读法归 hub。
	 * 所以这是同一个活冷分岔的第二个交付时机，分岔仍只发生在 {@link deliverBaseline} 一处。
	 *
	 * 交付契约与 {@link subscribe} 的 baseline 半逐条相同，两半保证的论证见那里的「hub 半」——
	 * 这里只列形状：
	 *
	 * - **活半**：`snapshotNow` 在**本方法返回之前的同一同步块内**同步回调 `sink.onBaseline`，
	 *   交回的是袋里的在飞状态（包括正在写出的 partial），不是盘上上一次落定的状态。
	 * - **冷半**：`await this.agent.snapshotOf(sessionId)` 读盘，完成后**异步**回调 `onBaseline`
	 *   **恰好一次**。
	 * - **失败**：`sink.onError(error)` **恰好一次**，交的是原始 error 对象；措辞（用户可读的帧
	 *   文案）留帧层。同一 sink 上不会既 onBaseline 又 onError。
	 * - **无注册、无退订**：本方法不碰 `watchers` / `feeds`，因此不返回退订函数。调用方对「这份
	 *   baseline 还有人要吗」的守卫（订阅身份、连接已关、backlog 状态）是它自己的帧序本域，不搬。
	 */
	rebaseline(sessionId: string, sink: SubscriptionSink): void {
		this.deliverBaseline(sessionId, sink);
	}

	/**
	 * 两个订阅动词共用的那一处活冷分岔：活半同步交付、冷半读盘后异步交付、失败 onError。
	 *
	 * {@link subscribe} 与 {@link rebaseline} 交出的是同一个分岔（活冷判定只有这一处），所以
	 * 判定、读取与交付的守门也只写这一份：活半与快照之间没有 await，`snapshotNow` 的前提在同一
	 * 拍内由构造成立；冷半与失败共享 `delivered`，任何 sink 都收不到两次交付、也收不到一条
	 * baseline 加一条 error。
	 *
	 * `cancelled` 是退订的闸：subscribe 的退订函数把它置真，让冷读盘在飞的那段窗口终结交付；
	 * rebaseline 不注册也不退订，没有闸可拉。活半的交付在本方法返回之前已经完成，退订只可能
	 * 发生在后一拍，所以闸实际拦到的只有冷半。
	 */
	private deliverBaseline(sessionId: string, sink: SubscriptionSink, cancelled: () => boolean = () => false): void {
		let delivered = false;

		if (this.isLive(sessionId)) {
			// 活半：判定与快照之间没有 await，`snapshotNow` 的前提在同一拍内由构造成立。
			delivered = true;
			sink.onBaseline(this.snapshotNow(sessionId));
			return;
		}

		// 冷半：读盘归 hub。失败与成功共享同一组守门标志，恰好一次由构造成立。
		void this.agent.snapshotOf(sessionId).then(
			(snapshot) => {
				if (delivered || cancelled()) return;
				delivered = true;
				sink.onBaseline(snapshot);
			},
			(error) => {
				if (delivered || cancelled()) return;
				delivered = true;
				sink.onError(error);
			},
		);
	}

	/**
	 * 过渡面：裸注册的观看，唯一遗留调用方是 mux（票 03 把它迁到 {@link subscribe} 后删除）。
	 *
	 * 它不再是一份独立的注册逻辑，只是 subscribe 的退化壳——sink 收下 baseline 与错误然后丢弃，
	 * 分岔（活冷判定、快照读取）已归 hub 内部完成。mux 自己还做的 `isLive` 分岔与冷读是它的帧序
	 * 本域（backlog 布防与冲刷），票 03 迁移时一并拆掉；在那之前，mux 的代码原样、本仓库的公开
	 * 订阅面只有 subscribe 一条正道。
	 */
	watch(sessionId: string, watcher: SessionWatcher): () => void {
		return this.subscribe(sessionId, watcher, {
			onBaseline: () => {},
			onError: () => {},
		});
	}

	/** 此刻是否有任何人在观看一个会话——"空不空"的问题，刻意不是计数。 */
	isWatched(sessionId: string): boolean {
		return (this.watchers.get(sessionId)?.size ?? 0) > 0;
	}

	/**
	 * 让一个会话与它的第一条消息原子出生（ADR-0021）。
	 *
	 * 返回 id 而不是任何会话对象：会话是两个文件，进程里没有副本（ADR-0013），出生的运行自己装配
	 * 自己的袋；行事实（侧栏）经由 controller 的 listener 到达 projection。
	 *
	 * `workDirAbsPath` 决定会话落在哪。未定义就是服务器自己的 root；路径只要存在且是目录就接受，没有更多条件——在一个没人工作过的目录里创建第一个会话，正是新目录进入已知列表的唯一正道，而 header 的 workDir 是工具的默认值而不是进程的，所以这里不属于做已知目录检查的地方。
	 *
	 * 其余字段都随第一条消息一起落到会话记录上：模式指针与模型选择由编排层的 `createAndPrompt` 在
	 * 出生写入之前写进快照，`behavior` 是随消息的排队语义——出生时不可能有在飞的运行，它只是协议
	 * 上的随行者。
	 */
	async birth(input: {
		text: string;
		workDirAbsPath?: string;
		behavior?: "steer" | "followUp";
		mode?: string;
		model?: string;
		thinkingLevel?: string;
	}): Promise<string> {
		const absRoot = await workDirAbsPathForCreate(this.agent, input.workDirAbsPath ?? this.workDirAbsPath);
		const selection: ModelSelection | undefined =
			input.model === undefined && input.thinkingLevel === undefined
				? undefined
				: {
						...(input.model === undefined ? {} : { model: input.model }),
						...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
					};
		const id = await this.agent.createAndPrompt(absRoot, input.text, {
			...(input.behavior === undefined ? {} : { behavior: input.behavior }),
			...(input.mode === undefined ? {} : { mode: input.mode }),
			...(selection === undefined ? {} : { selection }),
		});
		return id;
	}

	/**
	 * 在一个 entry 处分支一个会话，返回新会话的 id。
	 *
	 * 源会话只被读。它的文件不被触碰，它自己的 `leafId` 不动，正在运行的会话从它正在写的文件 fork，
	 * 所以在途的一轮继续写它正在写的。
	 *
	 * 注册表在这里也没有收获：fork 没有要养活的活一半——没有队列排空过、没有运行在途——它的第一次
	 * 触碰就是它的第一次装配。orchestrator 的表也没有收获：facade 的 `forkFrom` 写两个文件、不收养
	 * 任何东西（ADR-0012）。状态离开那张表只有运行自己的结束路径和 orchestrator 自己的删除动词，
	 * 从不经由本 hub 的手。
	 */
	async fork(sessionId: string, entryId: string | null): Promise<string> {
		// 源会话只被定位和读取——facade 的磁盘扫描。fork 的两侧就是一次源路径读取和一对写入，而文件是每个 entry 都已落上去的权威。
		const id = this.agent.forkFrom(sessionId, entryId);
		return id;
	}

	/**
	 * 给会话一个自己的名字，存为其 `.json` 快照上的 title。
	 *
	 * 冷的写入是一次 facade 调用：title 是关于会话的事实而不是关于某条路径的事实，引擎从不读
	 * title，运行中途重写快照落地时不会打扰那一轮。什么都不指名的 id 在 facade 内拒绝，那始终就
	 * 是那个 404。
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
	}

	/**
	 * 删除一个会话：会话记录、文件，以及本进程中关于它的每一丝痕迹。
	 *
	 * 删除是否决式（ADR-0023），不再以「有人在用」为由失败——core 的
	 * {@link Agent.deleteSessionBySessionId} 自己安顿一切：中止在飞的运行、等引擎收尾、文件闸内
	 * rm、出表。这里同步做的只有存在性校验：`fileAbsPathOf` 无所指的 id 以
	 * {@link UnknownSessionError} 拒绝（→ 404，与「第二次删除是 404」一致——删除进行中或完成后
	 * 文件已消失），这是删除端点同步做的唯一检查。
	 *
	 * 校验之后向观看者告别（`undefined` 让 mux 对观看中的流发 end），然后
	 * **不 await** 删除：否决序分离在后台跑完，202 应答先到（spec Testing Decisions：运行中删除
	 * → 应答先于收尾）。分离的 promise 上挂错误日志——删除的失败只剩真正的病态（文件已损、id
	 * 非法），沿用仓库的中文诊断日志约定。
	 */
	remove(sessionId: string): void {
		if (this.agent.fileAbsPathOf(sessionId) === undefined) throw new UnknownSessionError(sessionId);
		for (const watcher of this.watchers.get(sessionId) ?? []) watcher(undefined);
		void this.agent.deleteSessionBySessionId(sessionId).catch((error: unknown) => {
			console.error(`会话 ${sessionId} 的删除失败：${error instanceof Error ? error.message : String(error)}`);
		});
	}

	/**
	 * 进程退出前停止每次运行并落定每个会话。
	 *
	 * 谁在跑只有编排层的表知道（运行比发起它的请求活得久，202 应答早已返回），所以停止是
	 * orchestrator 自己的复数动词（`closeAll`）；观看者在此刻收到告别，分发表随之清空。
	 */
	async close(): Promise<void> {
		await this.agent.closeAll();
		for (const watchers of this.watchers.values()) for (const watcher of watchers) watcher(undefined);
		this.watchers.clear();
		this.feedMap.clear();
	}

	/**
	 * 一个会话的两条 feed：把订阅者挂进本 hub 的分发表，交回成对的退订。
	 *
	 * 分发表曾骑在编排层的袋上（`Agent.onEvent` / `Agent.onChange`），如今订阅是这个 hub 自己的事
	 * ——sink 把编排层的事件带到 feedMap，这个方法把订阅者放进 feedMap。形状与原来的公开面一致，
	 * 所以 mux 与 projection 的订阅代码一个字不改。退订函数在最后一个订阅者离开时清掉自己的条目，
	 * 让表里只留真正有人在听的会话。
	 */
	feeds(sessionId: string): SessionFeeds {
		const feed = this.feedMap.get(sessionId) ?? { eventListeners: new Set<SessionEventListener>(), listeners: new Set<SessionListener>() };
		if (!this.feedMap.has(sessionId)) this.feedMap.set(sessionId, feed);
		return {
			onEvent: (listener) => {
				feed.eventListeners.add(listener);
				return () => {
					feed.eventListeners.delete(listener);
					if (feed.eventListeners.size === 0 && feed.listeners.size === 0) this.feedMap.delete(sessionId);
				};
			},
			onChange: (listener) => {
				feed.listeners.add(listener);
				return () => {
					feed.listeners.delete(listener);
					if (feed.eventListeners.size === 0 && feed.listeners.size === 0) this.feedMap.delete(sessionId);
				};
			},
		};
	}
}

/**
 * 新会话落点的 root，在写入任何东西之前解析并检查。
 *
 * 检查刻意只有"存在且是目录"。更窄的任何东西——已知目录列表之类——都会封死在进程从未工作过的目录里创建第一个会话的唯一正道，而那恰恰是新目录挣得自己在侧栏中的位置的方式。
 *
 * 导出是因为拒绝应得的 status 由 controller 决定，不是 hub 的：controller 自己跑这个检查，坏路径可以被答成 400；`birth` 再跑一遍，让任何内部调用者都无法绕过检查写入会话。
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
