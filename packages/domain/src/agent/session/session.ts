// 会话纯数据状态的值类型之家，主角就是 `Session`（快照的设置半直接内联在 `settings` 字段里）。
// 原名 `ledger.ts`，2026-11-21 随「文件名 = 主角类型」的包内惯例改名。`Session` / `SessionEntry`
// 曾与 `SessionManager` 同模块（session-manager.ts），引擎并回编排（ADR-0016）之后留在此处——
// Manager 与文件机件仍住在 session-manager.ts（它从这里 import 并转出口，旧消费者零改动）；
// 本文件不 import 任何 Manager 模块。
//
// 条目族本身（`SessionEntryBase` + 六种 kind + `SessionEntry` / `SessionEntryMapById`）自分层重构
// 步 4 起住 agent 根 types.ts（共享内核 §2.3——context 的压缩算法要摸 entry 而不得 import
// session）；这里转发出去，让经本模块取条目类型的既有 import 路径不变。
import type { Message, SessionEntry, SessionEntryMapById } from "../types.ts";

export type {
	ClearToolResultEntry,
	CompactionEntry,
	LeafEntry,
	MessageEntry,
	SessionEntry,
	SessionEntryBase,
	SessionEntryMapById,
	TrimToolCallArgEntry,
	UsageEntry,
} from "../types.ts";

/**
 * 一个 session 账本的纯数据状态：session 操作读写的东西，仅此而已。
 *
 * 每个 session 操作都是一个以 `Session` 为第一参数的文件级函数——没有任何方法在调用之间持有这个
 * 状态（session-manager.ts 底部的 `SessionManager` 类是这些函数之上的无状态服务：它只加了打开时
 * 填充的缓存）。状态刻意是纯数据：哪个函数碰哪个字段在签名里一目了然，测试可以直接构造一个裸状态
 * 并对它调用任何操作。
 *
 * 这些字段是两个文件重放进去的内容。身份是袋自己的——id、创建时间戳、两个文件路径——
 * `settings` 字段持有 `.json` 快照的当前选择，在内存里重新组合：盘上文件保持扁平，fill 路径
 * 和 `metaOf`（session-manager.ts）是仅有的翻译点。`jsonlEntries` 是 `.jsonl` 条目流：每条条目带自己的 id 和
 * parent 的 id，所以这条流读起来是一棵树，`leafId` 就是对话此刻所在的位置。追加产生叶子的孩子；
 * `branch`（session-manager.ts）把叶子移到更早的条目——并把移动记录为一条 {@link LeafEntry}，新读者由此恢复——
 * 于是一段新的工作从那里继续，不碰已写入的东西。条目流一旦有了条目就从不重写，这让本构建不理解的
 * 条目种类或字段原样穿过；只有快照会被整体重写，且只在它持有的值发生变化时。
 *
 * 用 `buildSessionContext`（session-manager.ts）获取应发给 provider 的消息：它沿分支从根走到叶，并折入最新的压缩。
 */
export interface Session {
	sessionId: string;
	/** session 创建时的 ISO 时间戳；快照携带它，文件名不带。 */
	timestamp: string;
	/** `.jsonl` 条目流的路径，绝对；`.json` 快照在同一个 stem 上。 */
	sessionFileAbsPath?: string;
	/**
	 * 本 session 写入的 store，绝对路径——`<id>.jsonl` 和 `<id>.json` 所在的目录。从不落盘的
	 * session 为 null。
	 */
	sessionDirAbsPath: string | null;
	persist: boolean;
	/**
	 * 本 session 的文件已存在且持有最后一次写入时的日志后为 true。
	 *
	 * 它决定下一次写入如何发生：false 表示还没写过任何东西，所以第一条值得保留的条目一次性创建
	 * 两个文件——条目流和 meta 快照；true 表示条目追加、meta 变更重写快照。见 `persistEntry`（session-manager.ts）。
	 */
	fileCreated: boolean;
	/**
	 * session 自己的选择——`.json` 快照的设置半，从盘上快照的扁平字段（`SessionMeta`，
	 * session-manager.ts）在内存里重新组合；fill 路径和 `metaOf` 是盘↔内存仅有的两个翻译点。
	 * thinking level 住在 `model` 里面而不是旁边：session 的 level 和它的行是输入框一起发送的
	 * 一个选择，所以内存把它们作为一个对象持有。每个选择字段在选定之前缺席，与盘上字段一致；
	 * `suspended` 是唯一的例外——是推导出的事实而不是选择，始终存在。
	 * （原是独立的 `SessionSettings` 接口，2026-11-21 内联——它本质上只在说 `Session`。）
	 */
	settings: {
		/** session 打开时所在的工作目录，绝对路径。 */
		workDirAbsPath: string;
		/**
		 * 本 session 从之 fork 或被其委托的 session 文件，按盘上 `parentSession` 的命名方式：源的
		 * `.jsonl`，绝对路径——是路径不是 id，因为 fork 要能追溯到它复制的文件，而文件才是读者手里
		 * 有的东西。字段名跟随状态的形状；值就是盘上带的，所以旧 session 照旧读取。
		 */
		parentSessionId?: string;
		/** 会话自己的名字，由人起的；缺席即「去派生」。 */
		title?: string;
		/**
		 * 生效的模型选择，连同请求它的 level：`name` / `modelId` 指名行，`thinkingLevel` 是 session 最后
		 * 一次选择的级别。每部分选定之前缺席——记下了 level 但没记行，就是一个只有 `thinkingLevel` 的
		 * model，输出到盘上时再拆回两个字段。
		 */
		model?: { name?: string; modelId?: string; thinkingLevel?: string };
		/**
		 * 会话所在的模式：settings `modes` 表里的一个名字，工具与审批随它活态解析；缺席即跟随全局默认
		 * （ADR-0018）。
		 */
		mode?: string;
		/**
		 * 会话自己的审批增量，叠在模式解析出的审批表之上——只有会话明确动过的键（grant、审批补丁）
		 * 才落这里。
		 */
		approval?: Record<string, boolean>;
		/**
		 * session 是否停在审批闸门处——可重建的展示缓存，不是用户选择：账本的悬空 call 才是权威，这个
		 * 字段只是给列表的冷扫描省一次完整重放。它住在这里是因为盘↔内存的翻译恰好只有两个点，一个
		 * 推导字段不值得开第三个。内存中始终存在（未停闸即 false）；只有 true 才会写到盘上。没有
		 * 任何控制流读它。
		 */
		suspended: boolean;
	};
	jsonlEntries: SessionEntry[];
	sessionEntryMapById: SessionEntryMapById;
	leafId: string | null;
}

/**
 * 压缩检查点的标签。压缩是顶层 session 条目而不是消息条目——`buildContextEntries` 在分支上找
 * 最新的一个才找得到；但 provider 只认识 user / assistant 消息，所以发给模型时把摘要投影成它所
 * 代表的 user turn，包上这对标签。写侧（下面的投影）与读侧（`compactionSummaryOf`）共用这一份
 * 定义，不会漂移。
 */
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

/**
 * user 消息所代表的摘要，普通消息时为 undefined。
 *
 * 压缩检查点在投影后就是一条 user 消息，所以必须区别对待它的调用方——标题派生、分支预览、
 * 窗口的通知渲染——靠标签而不是靠独立的 role 来识别它。
 */
export function compactionSummaryOf(
	message: Message,
): string | undefined {
	if (message.role !== "user") return undefined;
	const first = Array.isArray(message.content) ? message.content[0] : undefined;
	if (first?.type !== "text") return undefined;
	const text = first.text;
	if (!text.startsWith(COMPACTION_SUMMARY_PREFIX) || !text.endsWith(COMPACTION_SUMMARY_SUFFIX)) return undefined;
	return text.slice(COMPACTION_SUMMARY_PREFIX.length, text.length - COMPACTION_SUMMARY_SUFFIX.length);
}

/**
 * 把一条被选中的条目投影成模型看到的消息。
 *
 * 压缩条目代表它替换掉的一切：只有摘要，投影成它所代表的 user turn，并包上 `compactionSummaryOf`
 * 认得的标签——发给 provider 的是 user 消息，所以会话记录用这个形状携带摘要。其他条目种类都是
 * 状态而非对话，不贡献任何东西。system prompt 不在其中：它每次请求都从设置和活的工具集重建，所以
 * 没有条目需要携带它。
 */
export function sessionEntryToContextMessages(entry: SessionEntry): Message[] {
	if (entry.type === "message") {
		const message = entry.message;
		// session 文件解析时不做校验，所以手改过的或更旧的文件可能装着 content 为 null 或缺失的
		// 消息。在这里修复它，而不是把 provider 读不了的形状递出去。
		if (message.role === "system" && message.content == null) return [{ ...message, content: "" }];
		if (
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
			message.content == null
		) {
			return [{ ...message, content: [] }];
		}
		return [message];
	}
	if (entry.type === "compaction") {
		const summary: Message = {
			role: "user",
			content: [
				{
					type: "text",
					text: `${COMPACTION_SUMMARY_PREFIX}${entry.summary}${COMPACTION_SUMMARY_SUFFIX}`,
				},
			],
			timestamp: new Date(entry.timestamp).getTime(),
		};
		return [summary];
	}
	return [];
}
