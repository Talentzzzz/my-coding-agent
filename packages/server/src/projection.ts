import {
	type AgentSessionEvent,
	groupSessionsByDirectory,
	type SessionRow,
	type DirectoryGroup,
} from "@my-agent/core";
import type { SessionHub } from "./hub.ts";

/**
 * 本进程对这台机器上每个会话所知的信息，以行的形式。
 *
 * 读取面与刷新面；行的变化不走这里——那条路是 hub 的扇出（{@link SessionHub.publishRows}）。
 */
export interface SessionProjection {
	/**
	 * 每一行，按目录分组、按侧栏绘制的顺序排列。
	 *
	 * 首次调用时播种，之后由内存供数：本进程是这些值的唯一写入者，重新扫描只会重读每份会话记录而一无所获。
	 */
	groups(): Promise<DirectoryGroup[]>;
	/** 每一行，无序，供自己分组的调用者。 */
	rows(): Promise<SessionRow[]>;
	/** 按 id 取一行，本进程从未听说过的会话返回 `undefined`。 */
	row(sessionId: string): Promise<SessionRow | undefined>;
	/**
	 * 从磁盘重读一行并重新发布。
	 *
	 * 这是存储型改名抵达侧栏的路：行的 title 住在文件里，活 feed 不携带自己的 title，所以行被读一次、整行发布。运行中的会话保留其活字段——扫描像所有冷读一样说 `running: false`，叠加它们正是让改名不至于把一行工作着的会话显示成空闲的东西。
	 */
	refresh(sessionId: string): Promise<void>;
	/** 丢掉一行并停止跟随其会话：背后的会话已被删除。 */
	forget(sessionId: string): void;
	/** 放开本 projection 挂到 hub 上的所有东西。 */
	close(): void;
}

/**
 * 本进程对这台机器上每个会话所知的信息，以行的形式。
 *
 * 这是侧栏读取的存储，也是一行能说"运行中"的原因。今天这个事实只存在于流内，所以一个在窗口看着别的会话时跑了一轮的会话，会留下一行永不移动的侧栏——不是慢，是永不，连手动刷新都救不了。一个回答"每个会话在做什么"却不问有没有人在看的 projection，正是让这行诚实的东西。
 *
	 * 两条规则塑造了这里的一切。**本进程是唯一的写入者**——会话由 hub 指挥的唯一 orchestrator 创建和追加（ADR-0012）——所以目录扫描的全部职责就是注意到从外部到来的文件，这就是播种只发生一次、重扫永远不发生的原因。还有**一行被整行替换**，于是下游没有东西合并两个来源、或追踪哪个更新。
 *
 * 它跟随自己创建的每一行而不是订阅镜像，刻意的：跟随挂在行的生命周期上——行出现即绑、行删除即解——而行的发现走两条路，播种与 controller 的 listener（出生、fork、删除），没有一个需要向 hub 报告任何关于"谁在看"的事实。
 *
 * 行变化的唯一出口是 hub（{@link SessionHub.publishRows} / {@link SessionHub.publishGone}）：它不再认识 mux，也不知道有几个窗口。依赖方向因此是 `projection → hub`。
 */
export function createSessionProjection(hub: SessionHub): SessionProjection {
	/** 各行，按会话 id。 */
	const rows = new Map<string, SessionRow>();
	/** 正在被跟随的会话，以及让它们能被放开的退订器。 */
	const following = new Map<string, { off: () => void }>();
	/**
	 * 正在首次读取其行的 id。
	 *
	 * 创建后从未开口的会话没有文件，所以没有行、也没有任何扫描为它记账。它的第一条消息才是把它写上盘的东西，而那条消息以一组 entry 突发的形式到达——这里把突发收敛为一次读取，而不是每个 entry 一次。
	 */
	const probing = new Set<string>();
	/**
	 * 扫描，一次。
	 *
	 * 用 promise 而不是标志，让同时到达的两个调用者共享一次扫描而不是启动两次，也让失败的扫描不会被记成空存储。
	 */
	let seeded: Promise<void> | undefined;

	/**
	 * 存一行并让 hub 扇出，前提是有东西真的动了。
	 *
	 * 比较就是设计，不是优化：会话出于与行毫无关系的原因发布变更——一个 token 到达、一次重试被排程——为每次都重发一行一模一样的数据，会把一轮变成每个监听者眼前的一串空操作。
	 */
	const publish = (next: SessionRow): void => {
		const current = rows.get(next.id);
		if (current !== undefined && sameRow(current, next)) return;
		rows.set(next.id, next);
		hub.publishRows(next);
		// 行的首次出现是跟随的开始：从这一拍起，这个会话的每次状态变更都落进行里。
		if (current === undefined) follow(next.id);
	};

	/**
	 * 运行中会话的行：存储所知的一切，加上只有 loop 才说得出的两个字段。
	 *
	 * 调用它之前存储那一半必须已存在——没人有行可查的会话还没有存储的一半，那正是 {@link probe} 的用途。
	 */
	const liveRow = (sessionId: string, live: LiveFields): SessionRow | undefined => {
		const stored = rows.get(sessionId);
		if (stored === undefined) return undefined;
		return { ...stored, ...live };
	};

/** 从一个会话读出那两个字段；活半不在的会话没有可叠的——返回 `undefined`，存储行自己就是答案。 */
const liveOf = (sessionId: string): LiveFields | undefined => {
	if (!hub.isLive(sessionId)) return undefined;
	const snapshot = hub.snapshotNow(sessionId);
	return { running: snapshot.running, pending: snapshot.pendingApprovals.length };
};

/**
 * 跟随一个会话的订阅元素，行存在多久跟多久。
 *
 * 在行首次存入的同一拍绑定，让变更不可能落进"没有任何人在听"的窗口。订阅走 hub 自己的订阅面：
 * 一张按会话的表，编排层的事件与快照从那个 sink 流出。
 *
 * 刻意不声明 `baseline`：投影的行来自磁盘扫描，不需要 hub 为每一行读一次盘（spec User Story 16）。
 * 初始状态在订阅之后由下面的 `liveOf` 自己叠加。
 */
const follow = (sessionId: string): void => {
	if (following.has(sessionId)) return;

	const stop = hub.subscribe(sessionId, {
		event: (event) => onEvent(sessionId, event),
		state: (snapshot) => {
			const next = liveRow(sessionId, {
				running: snapshot.running,
				pending: snapshot.pendingApprovals.length,
			});
			if (next !== undefined) publish(next);
		},
	});
	following.set(sessionId, { off: stop });

	const live = liveOf(sessionId);
	if (live !== undefined) {
		const next = liveRow(sessionId, live);
		if (next !== undefined) publish(next);
	}
};

	/**
	 * 推进单个事件能移动的两个字段。
	 *
	 * 一条消息落地会把 `modified` 向前推，分支移动可能改变 title 从哪条消息读。事件携带的其他任何东西都没有属于自己的行字段，而按事件重新推导 title 等于为回复的每个 token 走一遍整份会话记录。
	 */
	const onEvent = (sessionId: string, event: AgentSessionEvent): void => {
		const current = rows.get(sessionId);
		if (current === undefined) {
			// 没有行意味着这个会话刚被创建、才刚被写入：创建本身不在盘上留下任何东西。所以第一个 entry 才是行可以被读出的时刻，在这里读正是让会话在启动时就出现在侧栏、而不是等到某个更晚的 host 变更碰巧重新探测的原因。在此之前它刻意缺席——一个空的「新会话」行不是一段对话。
			if (event.type !== "entry_appended" || probing.has(sessionId)) return;
			probing.add(sessionId);
			void refresh(sessionId).finally(() => probing.delete(sessionId));
			return;
		}
		// 下面两个事实都随事件而来而不是回读：这里对每条追加的消息只跑一次，而在这里读会话记录要解析整份日志只为一个时间戳（ADR-0013）。分支移动是仍要问的那一个情况——它是手势不是帧，且可能改变派生 title 从哪条消息读。

		if (event.type === "branch_changed") {
			publish({ ...current, title: hub.agent.titleOf(sessionId) });
			return;
		}
		if (event.type !== "entry_appended" || event.kind !== "message") return;

		const at = event.at;
		if (at === undefined || at <= current.modified) return;
		// title 只在*用户*消息落到分支上时移动，因为那是唯一读 title 的消息——assistant 的回复不能给对话改名。
		const titled = event.role === "user" ? (event.title ?? current.title) : current.title;
		publish({ ...current, modified: at, title: titled });
	};

	/**
	 * 从磁盘读出一个会话的行。
	 *
	 * 只用于没有任何扫描为之记账的会话：本进程创建或 fork 的，或手工放到盘上的。id 必须先被定位，这会读每个文件的 header，但只有匹配的文件被解析——替代方案，一次列表，会解析每份会话记录只为得知刚出现的那一个会话。
	 *
	 * 没人在运行的会话可能根本还没有文件，以应答 `undefined` 说明；行在会话首次写入时出现，那也正是 host 打开的时刻。
	 */
	const probe = (sessionId: string): Promise<SessionRow | undefined> => hub.agent.findSessionRowById(sessionId);

	/**
	 * 重读一行并发布，活字段包括在内。
	 *
	 * 叠加与 {@link follow} 施加给扫描行的相同，理由也相同：文件自己的行说空闲，而一轮进行到一半的会话绝非如此。扫描读不出的会话——在改名与重读之间被删除——让存储的行保持原样，而不是用空替换它。
	 */
const refresh = async (sessionId: string): Promise<void> => {
	const scanned = await probe(sessionId);
	if (scanned === undefined) return;
	const live = liveOf(sessionId);
	publish(live === undefined ? scanned : { ...scanned, ...live });
};

	/**
	 * 丢掉一行并停止跟随其会话。
	 *
	 * 在丢弃之前解绑正是让两个事实保持先后顺序的东西：feed 在监听者听到行消失之前就已经没了，于是没人会因为一次移除而向一个已不存在的会话发布。本存储从未画出的会话没有要告知的监听者——"消失"只对曾经拥有它的人是消息。
	 */
	const forget = (sessionId: string): void => {
		const entry = following.get(sessionId);
		entry?.off();
		following.delete(sessionId);
		if (!rows.delete(sessionId)) return;
		hub.publishGone(sessionId);
	};

	/**
	 * 从盘上的文件把存储填满，一次。
	 *
	 * 之后，本进程正在运行的每个会话从其活 loop 重读，让扫描永远不可能把运行中会话的行写成空闲。
	 */
	const seed = async (): Promise<void> => {
		for (const group of await hub.agent.listDirectories()) {
			// 经 `publish` 而不是 `rows.set`：一行可能已经因某次探测在这里了，而列表知道单份文件不知道的事——最重要的是 fork 的父会话。绕过比较会让那个修正默默躺在存储里无人知晓。
			for (const sessionRow of group.sessions) publish(sessionRow);
		}
		for (const sessionId of following.keys()) {
			const live = liveOf(sessionId);
			if (live === undefined) continue;
			const next = liveRow(sessionId, live);
			if (next !== undefined) publish(next);
		}
	};

	const ensureSeeded = async (): Promise<void> => {
		seeded ??= seed().catch((error: unknown) => {
			// 刻意不缓存：失败的扫描应该被下一个调用者重试，而不是被记成空存储。
			seeded = undefined;
			throw error;
		});
		await seeded;
	};

	return {
		async groups(): Promise<DirectoryGroup[]> {
			await ensureSeeded();
			// 按 facade 扫描遵循的同一核心规则分组，而不是复制一份：侧栏画一种顺序，以不同顺序排序的读者会与列表来源相矛盾。
			return groupSessionsByDirectory([...rows.values()]);
		},
		async rows(): Promise<SessionRow[]> {
			await ensureSeeded();
			return [...rows.values()];
		},
		async row(sessionId: string): Promise<SessionRow | undefined> {
			await ensureSeeded();
			return rows.get(sessionId);
		},
		refresh(sessionId: string): Promise<void> {
			return refresh(sessionId);
		},
		forget(sessionId: string): void {
			forget(sessionId);
		},
		close(): void {
			for (const entry of following.values()) entry.off();
			following.clear();
		},
	};
}

/** 只有运行中的 loop 才是来源的那两个行字段。 */
interface LiveFields {
	running: boolean;
	pending: number;
}

/**
 * 一行拥有的每个字段，按声明的顺序。
 *
 * 从类型读取而不是手写两遍，因为悄悄漏掉一个字段的比较，会停止注意到只在该字段上不同的两行——症状是一行永不更新，而这恰恰是这个存储存在要消灭的 bug。`satisfies` 那一行让给 `SessionRow` 加字段在这里成为编译错误，而不是无声的遗漏。
 */
const ROW_FIELDS = [
	"id",
	"workDirAbsPath",
	"createdAt",
	"title",
	"parentId",
	"modified",
	"running",
	"pending",
] as const satisfies readonly (keyof SessionRow)[];

type RowField = (typeof ROW_FIELDS)[number];

/** 编译期证明：上面的列表恰好覆盖 `SessionRow`。 */
type _EveryRowFieldIsListed = Exclude<keyof SessionRow, RowField> extends never ? true : never;
const _everyRowFieldIsListed: _EveryRowFieldIsListed = true;
void _everyRowFieldIsListed;

/**
 * 两行画出来是否相同，相同的不必重发。
 *
 * 逐字段比较而不是序列化：wire 形态是字符串，造一个只为扔掉既更慢、也是对本检查所做的事的谎言。
 */
function sameRow(a: SessionRow, b: SessionRow): boolean {
	return ROW_FIELDS.every((field) => a[field] === b[field]);
}
