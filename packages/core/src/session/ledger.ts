// 账本条目类型与会话纯数据状态的值类型之家（ADR-0023 尚未决定 1 由票 005 定口径）：守卫对
// loop-manager.ts 按模块说明符禁 Manager（ADR-0023 决定 7），而 `Session` / `SessionEntry` 曾与
// `SessionManager` 同模块（session-manager.ts）——按模块禁会误伤值类型的 import 面，所以值类型
// 先安新家到这里。Manager 与文件机件仍住在 session-manager.ts（它从这里 import 并转出口，旧
// 消费者零改动）；本文件不 import 任何 Manager 模块。
import type { Message, Usage } from "../llm/index.ts";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "./messages.ts";

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
	type: "message";
	message: Message;
}

export interface CompactionEntry extends SessionEntryBase {
	type: "compaction";
	summary: string;
	/** 模型仍然看得见的第一条条目；它之前的一切都折进了 `summary`。 */
	firstKeptEntryId: string;
	tokensBefore: number;
	/** 生成摘要那次调用的 usage，若可知。 */
	usage?: Usage;
}

/**
 * 本构建从视图中清出的 tool result 的记录。
 *
 * result 留在文件里——这个格式从不重写一行——所以记录只指名它们，由 `buildContextEntries`
 * （session-manager.ts）应用。形状与压缩相同：一条改变更早条目含义而不改变其本身的条目，这让文件保持完整记录、transcript
 * 保持它的一个视图。
 */
export interface ClearToolResultEntry extends SessionEntryBase {
	type: "clear_tool_result";
	/** 本记录清空其 result 的条目：仍在文件里，不再在视图里。 */
	clearedEntryIds: string[];
	/** 清空前的预估 prompt 大小，让记录说明自己值多少。 */
	tokensBefore: number;
}

/**
 * 本构建在视图中截短 tool call 参数的记录。
 *
 * 与 clear 相同的决策形状：参数在文件里保持完整——这个格式从不重写一行——记录指名其记录参数被
 * 截短的消息条目，由 `buildContextEntries`（session-manager.ts）应用。`write` 或 `edit` 携带的重正文活在它们改的
 * 文件里；视图只保留足以说明写了什么、写到哪的部分。
 */
export interface TrimToolCallArgEntry extends SessionEntryBase {
	type: "trim_tool_call_arg";
	/** 本记录截短其记录参数的消息条目。 */
	trimmedEntryIds: string[];
	/** 截短前的预估 prompt 大小，让记录说明自己值多少。 */
	tokensBefore: number;
}

/**
 * 对话移动位置的记录：`SessionManager.branch` 或 `SessionManager.resetLeaf`（都在 session-manager.ts）
 * 把叶子留在
 * 哪里，位置真的移动时才写入。
 *
 * 追加本身就推进叶子、不需要记录——文件最后一条就是位置——所以这个条目是唯一的例外，它让一次
 * 移动活得比创建它的进程更久。和每条状态条目一样，它不是 transcript：它不产生任何消息，新读者
 * 重放它来把叶子放回对话去过的位置。
 */
export interface LeafEntry extends SessionEntryBase {
	type: "leaf";
	/** 对话移动到的位置：一个条目 id，null 表示「第一条之前」。 */
	leafId: string | null;
}

/**
 * 不拥有消息条目的模型开销记录：本 transcript 里引擎从未挂到 assistant 消息上的 usage。
 *
 * 这个种类存在的意义，是让没有自己消息的开销有地方落脚——transcript 属于另一个文件的 run、为压缩
 * 写的摘要——`operation` 按读者会问的方式指名这笔开销。usage 条目是钱，不是对话：它不产生任何消息，
 * 并且按文件顺序跨所有分支计数，因为在被放弃的树路径上烧掉的 token 同样烧掉了。未知的 `operation`
 * 按普通 usage 读取而不是拒绝——与文件对未知种类的前向兼容规则相同。
 */
export interface UsageEntry extends SessionEntryBase {
	type: "usage";
	/** 开销归因于什么，按写入方命名。 */
	operation: string;
	/** 开销运行的模型行，按其名字。 */
	model: string;
	usage: Usage;
}

/**
 * 一行条目可能的六种类型。
 *
 * session 曾记录的其余一切——名字、模型和 thinking level、工具选择——都是*当前值*，放在这条流
 * 旁边的 `.json` 快照里；遗留的 `tool_result_view` 种类整体废除，因为本构建不再写它，v≤4 文件被
 * 删除而不是重放。剩下的恰好是 transcript 无法原地重写的种类：对话本身、两条视图收缩记录、
 * 检查点、叶子位置、无归属的开销。
 */
export type SessionEntry =
	| MessageEntry
	| CompactionEntry
	| ClearToolResultEntry
	| TrimToolCallArgEntry
	| LeafEntry
	| UsageEntry;

/**
 * 一份 transcript 的全部条目，按各自的 id 建键。
 *
 * 条目只带 `parentId`，所以沿树的每次上溯——`buildSessionPath`（session-manager.ts）、分支预览、调用方指名的
 * id——都是按 id 查找。这个 map 就是那次查找，也是 `generateId` 无冲突的原因。迭代顺序即文件
 * 顺序：按序重放 JSONL 填充，再按同样顺序追加，所以「最后一行胜出」不需要排序。
 */
export type SessionEntryMapById = Map<string, SessionEntry>;

/**
 * 一个 session 自己的选择，从盘上快照的扁平字段重新组合。
 *
 * 这只是内存中的组合——盘上的 `.json` 保持扁平形状（`SessionMeta`，session-manager.ts），fill 路径和 `metaOf`
 * 是两者之间仅有的两个翻译点。thinking level 住在 `model` 里面而不是旁边：session 的 level 和它的行
 * 是输入框一起发送的一个选择，所以内存把它们作为一个对象持有。每个选择字段在选定之前缺席，与盘上
 * 字段一致；`suspended` 是唯一的例外——是推导出的事实而不是选择，始终存在。
 */
export interface SessionSetting {
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
	/** 最近一次变更时的完整激活工具集，按注册顺序。 */
	activeTools?: string[];
	/** 最近一次变更时的完整审批表，key 与设置文件的 `approval` 一致。 */
	approval?: Record<string, boolean>;
	/**
	 * session 是否停在审批闸门处——可重建的展示缓存，不是用户选择：账本的悬空 call 才是权威，这个
	 * 字段只是给列表的冷扫描省一次完整重放。它住在这里是因为盘↔内存的翻译恰好只有两个点，一个
	 * 推导字段不值得开第三个。内存中始终存在（未停闸即 false）；只有 true 才会写到盘上。没有
	 * 任何控制流读它。
	 */
	suspended: boolean;
}

/**
 * 一个 session 账本的纯数据状态：session 操作读写的东西，仅此而已。
 *
 * 每个 session 操作都是一个以 `Session` 为第一参数的文件级函数——没有任何方法在调用之间持有这个
 * 状态（session-manager.ts 底部的 `SessionManager` 类是这些函数之上的无状态服务：它只加了打开时
 * 填充的缓存）。状态刻意是纯数据：哪个函数碰哪个字段在签名里一目了然，测试可以直接构造一个裸状态
 * 并对它调用任何操作。
 *
 * 这些字段是两个文件重放进去的内容。身份是袋自己的——id、创建时间戳、两个文件路径——
 * {@link SessionSetting} 持有 `.json` 快照的当前选择，在内存里重新组合：盘上文件保持扁平，fill 路径
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
	/** session 自己的选择，即盘上快照扁平字段在内存中的重组。 */
	sessionSetting: SessionSetting;
	jsonlEntries: SessionEntry[];
	sessionEntryMapById: SessionEntryMapById;
	leafId: string | null;
}

/**
 * 把一条被选中的条目投影成模型看到的消息。
 *
 * 压缩条目代表它替换掉的一切：只有摘要，投影成它所代表的 user turn，并包上 `compactionSummaryOf`
 * 认得的标签——发给 provider 的是 user 消息，所以 transcript 用这个形状携带摘要。其他条目种类都是
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
