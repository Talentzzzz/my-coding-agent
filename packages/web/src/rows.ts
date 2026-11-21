import type { SessionRow, SessionRowPatch, DirectoryGroup } from "@my-agent/case/protocol";

/**
 * 侧栏的行，保存在连接层。
 *
 * 刻意不属于 `ViewState`，也不是 {@link reduce} 能看到的东西。行回答"这台机器上每个会话都在做
 * 什么"，这是关于连接的问题，而不是关于某个窗格恰好展示的对话 —— 判定标准是：在没有任何订阅者
 * 时，这个字段是否仍然为真。`running` 和 `pending` 是；token 计数不是，所以 `usage` 永远不来到
 * 这里。
 *
 * 服务端不为行养存储（ADR-0027）：行在这里落地，服务端随事件推增量。有两个写入者，且它们从不
 * 重叠。通道为 `live` 时，行只来自通道，完全不查 REST；通道断开时，REST 列表是唯一的信息来源。
 * 同一时刻只有一个写入者，正是消除竞态的关键：否则，一个在 `running: true` 到达之前发起的列表
 * 可能在之后落地，把行拉回 `false`，窗口就会把一个正在工作的会话显示成空闲。
 */
export class SessionRows {
	private readonly sessionRowMap = new Map<string, SessionRow>();

	/**
	 * 每次变更都会递增，由窗口的渲染门读取。
	 *
	 * 侧栏的行按自己的节奏变化，而一个流式 frame 不会改变它们中的任何一个；重绘决策需要在不 diff
	 * 整表的情况下区分这两者。计数器是最便宜且诚实的答案：没改任何行的 frame 读到和上次绘制相同
	 * 的数字，改了的则不是。
	 */
	version = 0;

	/**
	 * 整表替换，这正是连接的打开帧所做的事。
	 *
	 * 用替换而不是合并，这样已被删除会话的行会自行消失 —— 不需要携带墓碑，也不需要定义删除帧。
	 */
	replaceAll(rows: readonly SessionRow[]): void {
		this.sessionRowMap.clear();
		for (const sessionRow of rows) this.sessionRowMap.set(sessionRow.id, sessionRow);
		this.version += 1;
	}

	/**
	 * 一行变了：通常是增量，逐字段合并；完整行（出生、fork、存储型改名）覆盖成全新的一行。
	 *
	 * 服务端推的是事件自带的那几个字段（ADR-0027），缺席的字段读作"没动"，所以同一行到达两次
	 * 或乱序到达，得到的都是同一张表——幂等性与整行版本相同，只是字的数量更少。
	 *
	 * 对表中从未持有的 id，只有完整的行可以自我介绍：增量是关于"那一行现在怎样"的话，从没听过
	 * 这一行就无从合并——丢弃它，行的第一次到达永远走 overview 或一份完整的探测行。这也正是
	 * 隐藏目录的过滤在客户端的延续：被摘走的行的增量，在这里安静落地为零。
	 */
	put(sessionRow: SessionRowPatch): void {
		const current = this.sessionRowMap.get(sessionRow.id);
		if (current === undefined) {
			if (!isCompleteRow(sessionRow)) return;
			this.sessionRowMap.set(sessionRow.id, sessionRow as SessionRow);
			this.version += 1;
			return;
		}
		let changed = false;
		const next: SessionRow = { ...current };
		const target = next as unknown as Record<string, unknown>;
		// modified 是唯一不直接覆盖的字段：它是"最近活动"，只前进。一次迟到的时间戳（剧本化的
		// 应答、乱序的到达）不得把行拉回过去——这正是旧的存储端守卫（`at <= modified` 不发布）
		// 在客户端的化身。
		if (sessionRow.modified !== undefined && sessionRow.modified > next.modified) {
			next.modified = sessionRow.modified;
			changed = true;
		}
		for (const key of Object.keys(sessionRow) as (keyof SessionRowPatch)[]) {
			if (key === "modified" || key === "id") continue;
			const value = sessionRow[key];
			if (value === undefined || target[key] === value) continue;
			target[key] = value;
			changed = true;
		}
		if (!changed) return;
		this.sessionRowMap.set(sessionRow.id, next);
		this.version += 1;
	}

	/**
	 * 一行消失了：它背后的会话被删除。
	 *
	 * 对表中从未持有的 id 是无操作，因为"没了"只对曾持有它的窗口是新闻 —— 但对持有过的那个，版本
	 * 仍然要动，因为行消失是渲染门必须看到的变化。
	 */
	remove(sessionId: string): void {
		if (!this.sessionRowMap.delete(sessionId)) return;
		this.version += 1;
	}

	/**
	 * 接收一份 REST 列表，作为通道未启用时的回退。
	 *
	 * 通道为 `live` 时被拒绝，这正是这条规则的意义所在：此时通道是这些行的权威，从文件算出的列表
	 * 会把一个正在运行的会话的行覆盖成空闲。返回是否被采纳，让调用者能区分"刷新了"和"通道现在
	 * 拥有这些行"。
	 */
	loadFrom(groups: readonly DirectoryGroup[], channelIsLive: boolean): boolean {
		if (channelIsLive) return false;
		this.sessionRowMap.clear();
		for (const group of groups) {
			for (const sessionRow of group.sessions) this.sessionRowMap.set(sessionRow.id, sessionRow);
		}
		this.version += 1;
		return true;
	}

	/** 一行；对没有任何窗口被告知过的会话返回 `undefined`。 */
	get(sessionId: string): SessionRow | undefined {
		return this.sessionRowMap.get(sessionId);
	}

	/** 所有行，最新活动在前 —— 侧栏绘制的顺序。 */
	list(): SessionRow[] {
		return [...this.sessionRowMap.values()].sort((a, b) => b.modified - a.modified);
	}

	/**
	 * 以侧栏分组的形式返回行，每组按自己的最新行排序。
	 *
	 * 与服务端投影的应答形状相同、排序也相同 —— 组按最新活动排，最近的在前，所以刚收到消息的目录
	 * 是侧栏显示的第一组。REST 回退与 live 通道产生完全相同的列表：各自排序的存储与读者，第一次
	 * 行移动时就会分歧。
	 */
	groups(): DirectoryGroup[] {
		const sessionRowMapByWorkDir = new Map<string, SessionRow[]>();
		for (const sessionRow of this.list()) {
			const group = sessionRowMapByWorkDir.get(sessionRow.workDirAbsPath);
			if (group === undefined) sessionRowMapByWorkDir.set(sessionRow.workDirAbsPath, [sessionRow]);
			else group.push(sessionRow);
		}
		return [...sessionRowMapByWorkDir.entries()]
			.map(([workDirAbsPath, sessions]) => ({ workDirAbsPath, sessions }))
			.sort((a, b) => newest(b.sessions) - newest(a.sessions));
	}
}

/** 一组最近的活动，正是组与组之间排序的依据。 */
function newest(rows: readonly SessionRow[]): number {
	return rows.reduce((latest, sessionRow) => Math.max(latest, sessionRow.modified), 0);
}

/**
 * 一份增量是否携带了完整行：未知 id 的行只有以此自表身份才被收进表里。
 *
 * 完整的行来自服务端的探测（出生、fork、改名）与 overview——它们永远带着全部字段。判定按
 * 必填字段逐个点名，`parentId` 缺席合法（根会话没有它）。
 */
function isCompleteRow(patch: SessionRowPatch): boolean {
	return (
		patch.workDirAbsPath !== undefined &&
		patch.createdAt !== undefined &&
		patch.title !== undefined &&
		patch.modified !== undefined &&
		patch.running !== undefined &&
		patch.pending !== undefined
	);
}