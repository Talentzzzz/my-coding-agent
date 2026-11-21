// 会话文件对的端口声明（分层重构 spec §4.1）：domain 对存储只认自己声明的端口，infra 逐存储域
// 实现（session-store.ts）、组合根注入。唯一消费者是编排层自己的会话服务（SessionManager）。
//
// 端口面 = 触盘动词；袋子上的树操作不进端口。方法面 11 个，名字与今天的实现一一对应（spec §4.1
// 的核对表）；同步/异步划分保今天：袋式写路径同步（引擎轮次中同步追加），发现半与 remove 异步。
//
// **hold 契约三条**（ADR-0023 的簿记自 SessionManager 迁 infra 后，进闸出闸变成端口方法的原子性
// 承诺；domain 连闸的存在都不知道，只见拒绝与错误种类）：
//
// 1. **原子性**：每个触碰文件对的方法对该文件对原子；闸、closing、复活守卫是实现内部细节；跨方法
//    无事务（与文件系统时代的语义一致）。
// 2. **错误语义**：`UnknownSessionError` 类型声明归本包（消费方词汇），infra 抛出。撞闸、复活守卫
//    失败、fill 打不开、remove 未知 id——全部读作「没有这个会话」。
// 3. **fill 的副作用**：fill 是一次可能删除文件的读取——打不开的配对先 prune 再抛；编排层接受这个
//    事实但不依赖其细节。
//
// 文件对布局契约：store 是**扁平**目录，id 就是地址——`<storeDir>/<id>.jsonl` 装*说过什么*，
// `<storeDir>/<id>.json` 装*是什么*（诞生的提交标记，最后写）。诞生命名（`createSession` /
// `forkFrom` 的目标半）由此在本包内以 `join(storeDir, `${id}.jsonl`)` 拼出，infra 的
// `sessionPath` 实现同一规则——两侧同源，改布局先改这份契约。
import type { SessionEntry } from "./session.ts";
import type { SessionMeta } from "./session-manager.ts";

/**
 * 「这个 id 不指名任何 session」这一失败，以类型而不是句子的形式——错误语义（契约 #2）的那半
 * 词汇：infra 抛出，传输层认领。
 *
 * 它存在的意义是让传输层不必先*问*再行动。要先检查存在性的调用方，是可能把答案搞错两次的调用方
 * ——问的时候错一次，问题和命令之间答案变化时再错一次——而且这个检查必须在每个端点的同一处拼写。
 * 在这里由命令本身拒绝，传输层把一个类型映射到一个状态码，这就是每条 unknown-id 路径的形状：读取、
 * 删除、hold、prompt 都一样。
 *
 * 消息保持稳定，因为它同时也是客户端展示的 404 body：`Unknown session: <id>`。
 */
export class UnknownSessionError extends Error {
	/** 没指名任何东西的 id，给需要区分多个 id 的调用方。 */
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Unknown session: ${sessionId}`);
		this.name = "UnknownSessionError";
		this.sessionId = sessionId;
	}
}

/** 会话账本流式扫描时，泵行一方随行给出的文件事实（派生半——modified 的落盘时间回落——留在 domain）。 */
export interface SessionLedgerFile {
	/** `.jsonl` 的修改时间，毫秒。 */
	readonly mtimeMs: number;
}

/**
 * 会话文件对的读写端口：一个端口读写不分（读的一半也是写的同伴——配对、提交标记、prune 都属于
 * 同一份格式知识）。实现见 `@my-agent/infra` 的 session-store；hold 闸住实现内部。
 */
export interface SessionRepository {
	/**
	 * 存放会话文件对的扁平目录，绝对路径。
	 *
	 * 布局契约的声明半：诞生命名与 fork 的写目标由此拼出（`join(storeDir, `${id}.jsonl`)`），实现
	 * 侧以同一规则定位既有会话（`locate`）。目录按需创建——第一次诞生写入时由实现负责，构造时不建。
	 */
	readonly storeDir: string;

	/** 一个 session id 指名的那条 `.jsonl` 流路径——一次存在性检查，不是一次搜索；没有配对的名字回答 `undefined`。 */
	locate(id: string): string | undefined;

	/** 这个会话的删除是否正跨着闸（ADR-0023 的 `closing` 在场那一拍）：读作「没有这个会话」。 */
	isDeleting(id: string): boolean;

	/**
	 * 把一个会话的两个文件重放成纯数据状态：配对检查、版本拒绝、打不开的配对先 prune。
	 *
	 * 路径可指两半中的任何一个——手里拿着 `.json` 的调用方传它，流在同一 stem 上找到。打不开的
	 * 配对（缺半、版本不对、空流）以 {@link UnknownSessionError} 拒绝（契约 #2/#3）。
	 */
	fill(absPath: string): { meta: SessionMeta; entries: SessionEntry[] };

	/** `.json` 快照读半（不 prune、不进闸——读不拿锁）：身份与当前选择。打不开以普通错误拒绝，调用方决定怎么读它。 */
	readSnapshot(absPath: string): SessionMeta;

	/** `.jsonl` 账本整读半：逐条解析，没有结尾换行的最后一行会被下一次追加接上去（与今天一致）。 */
	loadEntries(absPath: string): SessionEntry[];

	/**
	 * 诞生写入：两文件 `wx`、快照最后写（提交标记）——`createSession` 的首条消息与 `forkFrom` 的写
	 * 目标半共用。目录不存在时创建；流写失败不留半对。
	 */
	createPair(absJsonl: string, entries: readonly SessionEntry[], meta: SessionMeta): void;

	/** 单行追加到 `.jsonl` 流上。复活守卫在场：提交标记不在的追加读作「没有这个会话」。 */
	appendEntry(absJsonl: string, entry: SessionEntry): void;

	/** 整体重写 `.json` 快照（同目录 temp + rename——读者要么看到旧要么看到新，绝不看到撕裂的）。 */
	writeSnapshot(absJsonl: string, meta: SessionMeta): void;

	/** 删除一个 id 指名的会话：闸罩全程，先删提交标记、后删流；未知 id 以 {@link UnknownSessionError} 拒绝。 */
	remove(id: string): Promise<void>;

	/**
	 * store 的发现冷半：readdir + 按 stem 配对 + 清除打不开的一切（未配对半边、版本不对、空流）。
	 * 缺失或读不了的目录回答空表。
	 */
	scanPairs(): Promise<{ absJsonl: string; meta: SessionMeta }[]>;

	/**
	 * 发现半的流式行泵：实现泵行并逐行解析，解析不出的行跳过（一行读不了不能让 session 其余部分
	 * 也读不了）；派生（messageCount / 文本 / parentOf / leafId）留 domain 回调，内存特征与今天
	 * 一致（流式，不整读）。读不了整份流时 promise 以原错误拒绝。
	 */
	scanLedger(
		absJsonl: string,
		visit: (entry: SessionEntry, file: SessionLedgerFile) => void,
		signal?: AbortSignal,
	): Promise<void>;
}
