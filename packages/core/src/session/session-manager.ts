import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmdirSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "../llm/index.ts";
import { type Usage, uuidv7 } from "../llm/index.ts";
import { APP_NAME } from "../config.ts";
import { trimToolCallArgs } from "../context/trim-tool-call-args.ts";
import { clearToolResult } from "../context/clear-tool-results.ts";
import type { SessionRef, SessionRow } from "../protocol.ts";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX, compactionSummaryOf } from "./messages.ts";
import { normalizePath, resolvePath, sessionJsonlPath, sessionMetaPath, sessionPath, sessionsDir } from "./paths.ts";
import { UnknownSessionError } from "./unknown-session.ts";

/**
 * 本构建写入的盘上格式版本。
 *
 * session 是两个文件，5 是第一个这样声明的版本：4 把所有东西放在一个 JSONL 里、header 是第一行，
 * 5 把它拆开——`<id>.json` 装 session *是什么*（header 字段加上 title、model、thinking level、
 * tool config 的当前值，每次变更整体重写），`<id>.jsonl` 装*说过什么*（不可变的条目流，仅此而已）。
 * 这里只产出 5，本构建认识的条目种类即 {@link SessionEntry} 里的那些。
 *
 * 刻意不做迁移。文件读不出 v5 配对的 session 会被*删除*，而不是拒绝后留在原地：格式归本构建所有，
 * v≤4 的文件在没有本代码已不再具备的 header 重放的情况下无法收养，留着它会让每次列表都为一个永远
 * 无法再打开的 session 付代价。删除点在列表扫描和 {@link fillSession}——见 {@link settleSessionFiles}。
 */
export const CURRENT_SESSION_VERSION = 5;

/**
 * session 的 `.json` 那一半：session *是什么*，作为一个原子重写的快照。
 *
 * 前五个字段是 v4 header 携带的身份——session 是谁、何时创建、在哪儿打开、从哪个文件 fork 而来。
 * 其余是 session 自己的当前选择，即 v≤4 用 last-wins 条目（`rename`、`model_change`、
 * `thinking_level_change`、`tool_config`）记录的那些：只保留生效值，那些条目承载的历史刻意消失
 * ——从没人读过它。字段缺席意味着「从未选择」，这让读者能区分选了 `off` 的 session 和从未选的。
 * 唯一不是选择的字段是 `suspended`：一个可重建的展示缓存，缺席即 false。
 *
 * 每次变更都整体重写文件（temp + rename），因为它是快照不是日志——旁边的 JSONL 才是日志，两者按
 * stem 配对：两个文件都在，session 才存在。
 *
 * 这是**磁盘**形状。内存中 session 把选择字段重组为 {@link SessionSetting}——thinking level 折进
 * `model`——两者之间的翻译只存在于两处：fill 路径在进入时合并，{@link metaOf} 在输出时拆开。盘上
 * 再无其他变化：版本号不动，旧 session 照旧读取。
 */
export interface SessionMeta {
	version: number;
	id: string;
	/** session 创建时的 ISO 时间戳；文件名以同一时刻开头。 */
	timestamp: string;
	/** session 打开时所在的工作目录，绝对路径。 */
	workDir: string;
	/**
	 * 本 session 从之 fork 或被其委托的 session 文件。
	 *
	 * 源的 `.jsonl` 的绝对路径，不是 id，因为 fork 要能追溯到它复制的文件，而文件才是读者手里
	 * 有的东西。用绝对路径是因为列表要比较路径：相对路径会按进程碰巧所在的目录解析。被复制的
	 * 条目另外保留原始 id。
	 */
	parentSession?: string;
	/** 会话自己的名字，由人起的；缺席即「去派生」。 */
	title?: string;
	/** session 最后一次运行的模型行，以其标识名记录。 */
	model?: { name: string; modelId: string };
	/** session 最后一次请求的 thinking level；缺席即「从未选择」。 */
	thinkingLevel?: string;
	/** 最近一次变更时的完整激活工具集，按注册顺序。 */
	activeTools?: string[];
	/** 最近一次变更时的完整审批表，key 与设置文件的 `approval` 一致。 */
	approval?: Record<string, boolean>;
	/**
	 * session 是否停在审批闸门处；只在 true 时写入，缺席即 false。
	 *
	 * 列表冷启动用的展示缓存：扫描只读快照，把 tool call 与 result 配对要对每个账本做完整重放。
	 * 账本始终是权威——这个字段随时可从账本重建，且没有任何控制流读它。没有该字段的旧快照按
	 * false 读，所以版本号不动，也没有迁移。
	 */
	suspended?: true;
}

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
 * result 留在文件里——这个格式从不重写一行——所以记录只指名它们，由 {@link buildContextEntries}
 * 应用。形状与压缩相同：一条改变更早条目含义而不改变其本身的条目，这让文件保持完整记录、transcript
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
 * 截短的消息条目，由 {@link buildContextEntries} 应用。`write` 或 `edit` 携带的重正文活在它们改的
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
 * 对话移动位置的记录：{@link SessionManager.branch} 或 {@link SessionManager.resetLeaf} 把叶子留在
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
 * 条目只带 `parentId`，所以沿树的每次上溯——{@link buildSessionPath}、分支预览、调用方指名的
 * id——都是按 id 查找。这个 map 就是那次查找，也是 `generateId` 无冲突的原因。迭代顺序即文件
 * 顺序：按序重放 JSONL 填充，再按同样顺序追加，所以「最后一行胜出」不需要排序。
 */
export type SessionEntryMapById = Map<string, SessionEntry>;

export interface SessionContext {
	messages: Message[];
	thinkingLevel: string;
	model: { name: string; modelId: string } | null;
}

export interface SessionInfo {
	/** session 文件，绝对路径。 */
	absPath: string;
	id: string;
	/** session 启动时的工作目录，绝对路径。header 里没有的文件为空。 */
	workDirAbsPath: string;
	/** 本 session 从之 fork 的文件的绝对路径，若 header 有指名。 */
	absParentSessionPath?: string;
	/**
	 * 本 session 从之 fork 的 session 的 id，仅当它在同一目录。
	 *
	 * 不从文件读：header 记的是父的路径，其 id 只在 fork 两端同时被列出时才可知。见
	 * {@link linkForkParents}。
	 */
	parentId?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	/**
	 * 会话的名字，与活 session 派生的方式完全一致。
	 *
	 * 一行的标题只有一种派生，无论本进程是否在跑它：活跃分支上第一条带文本的 user 消息，截到
	 * 72 字符。它不是文件的第一条 user 消息——那是 `firstMessage`，叶子移动后两者会不同，所以
	 * 读一个会随 host 被回收而变化的标题是无缘由的可见闪烁。
	 */
	title: string;
	firstMessage: string;
	allMessagesText: string;
	/** 快照的停闸标记，缺席即 false——展示缓存，不是账本读取。 */
	suspended: boolean;
}

/**
 * 一个分支点的一种备选延续。
 *
 * `entryId` 是这里唯一稳定的东西：它是分支点的孩子，一次写入。选择通向的 tip 刻意缺席——分支在
 * tip 处生长，记住的 tip 在那条分支被续写的那一刻就成了过期指针，持有它的窗口会回退到对话早已
 * 离开的地方。做出选择时 server 从 `entryId` 向下走。
 */
export interface BranchOption {
	/** 这个备选从哪开始：分支点的一个孩子。 */
	entryId: string;
	/** 其下第一条消息的一行文字，供切换器的标签。 */
	label: string;
	/** 活跃链经过的那个备选为 true。 */
	active: boolean;
}

/**
 * 以不止一种方式延续下去的消息。
 *
 * 条目树一直有它们——一条条目可以有任意多个孩子——这是一个窗口能画出来的那一种的形状：挂切换器
 * 的条目，以及按写入顺序排列、供选择的延续。日志里每个点都报告，不只是活跃链经过的：没人读的路径
 * 下的 fork 依然是 fork，而叶子移动后树形改变、却只报活跃链的页面，回答「能回到哪」时说的将是另
 * 一段对话。
 */
export interface BranchPoint {
	/** 备选挂靠的条目。 */
	entryId: string;
	/**
	 * 备选卡片挂在其下的条目，按窗口绘制的方式。
	 *
	 * 页面按条目放置卡片：线上的一条 user 消息，或更早的点已画过的某个备选。这是该点及其上方最近
	 * 的那个这样的条目——对链上的点，就是它回答的 user 消息；对没人读的路径下的点，就是那条路径
	 * 自己的卡片，于是下降保持在路径所在的列。始终是该点自己的 id 或祖先的 id，绝不是旁边的条目。
	 */
	anchor: string;
	/**
	 * 该点及其上方 user 消息的一行文字：该点消息所回答的问题，或点本身就是 user 消息时它自己的
	 * 文字。
	 *
	 * 从 assistant 回答上分出的分支没有自己的 user 文字可命名，而回答不是卡片该说的——用回答命名
	 * 的卡片读起来像树里并不存在的散文——所以问题是自身没有文字的选项回落的行。仅当对话以 assistant
	 * 开场时为空。
	 */
	prompt: string;
	options: BranchOption[];
}

/**
 * session 里的一条 user 消息，按分支页绘制的方式。
 *
 * 页面是一列**问题**，不是 fork 的清单：人认得出的「可以回到的地方」是他问过的东西。所以它从整个
 * 条目树折叠，而不是活跃链——一条路径被抛下的问题仍是问题，恰好就是回退把线上其余部分移出
 * transcript 后读者要找的那张卡片。
 *
 * `parentId` 是它**上方**最近的 user 消息，不是条目自己的 parent：两个问题之间的条目是一轮的工作，
 * 卡片挂在上一个打开该轮的问题上。
 */
export interface UserWay {
	/** user 消息条目：卡片的身份，也是移动所指的 id。 */
	entryId: string;
	/** 这条在自己路径上跟随的 user 消息；一列问题里的第一个为 null。 */
	parentId: string | null;
	/** 所问内容的一行文字。 */
	label: string;
	/**
	 * 按下卡片落在哪里：这个问题打开的那轮的最后一条消息。
	 *
	 * 仅当那条消息是 assistant 的，因为落在那的意义是下一个 prompt 输入在回答**之后**而不是顶替
	 * 回答。停在 tool 中途的一轮没有可保留的回答，它的卡片落在问题本身上。
	 */
	landingId: string;
	/** 这条消息位于叶子所在链上时为 true。 */
	active: boolean;
}

/** 侧栏分组下的一个目录，及其存储的 session。 */
export interface DirectorySessions {
	workDirAbsPath: string;
	sessions: SessionRow[];
}

function createSessionId(): string {
	return uuidv7();
}

/** map 中未被任何条目占用的短 id。 */
function generateId(sessionEntryMapById: { has(id: string): boolean }): string {
	for (let attempt = 0; attempt < 100; attempt++) {
		const id = randomUUID().slice(0, 8);
		if (!sessionEntryMapById.has(id)) return id;
	}
	return randomUUID();
}

/** 按 id 索引条目列表。只有不拥有 `SessionManager` 的读者才需要它。 */
function buildEntryIndex(entries: SessionEntry[]): SessionEntryMapById {
	const index: SessionEntryMapById = new Map();
	for (const entry of entries) index.set(entry.id, entry);
	return index;
}

/**
 * 文件顺序中的最后一条条目。
 *
 * map 按重放文件的顺序填充，也按同样的顺序追加，所以 map 的最后一个值就是最后一行。这就是为什么
 * 回落可以是遍历 map 而不是复制条目列表——不分配任何东西，代价只在调用方没有指名位置时才付。
 */
function lastEntryOf(sessionEntryMapById: SessionEntryMapById): SessionEntry | undefined {
	let last: SessionEntry | undefined;
	for (const entry of sessionEntryMapById.values()) last = entry;
	return last;
}

/**
 * 从根到 `leafId` 的链，沿 parent 链接上溯，含两端。
 *
 * `leafId` 默认取最后一条条目，`null` 表示「第一条之前」并得到空链。没有条目持有的 id 与缺失的 id
 * 落到同一个回落值，这让调用方可以不指名条目就遍历整份日志。
 */
function buildSessionPath(sessionEntryMapById: SessionEntryMapById, leafId?: string | null): SessionEntry[] {
	if (leafId === null) return [];
	let leaf: SessionEntry | undefined;
	if (leafId) leaf = sessionEntryMapById.get(leafId);
	leaf ??= lastEntryOf(sessionEntryMapById);
	if (!leaf) return [];

	const chain: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		chain.push(current);
		current = current.parentId ? sessionEntryMapById.get(current.parentId) : undefined;
	}
	chain.reverse();
	return chain;
}

/**
 * 这个 session 当前所在的模型和 thinking level：`.json` 快照的当前值，模型以 transcript 的最后一条
 * assistant 消息作弱回落。
 *
 * 快照是第一句话——它是 session 自己的选择存放的地方——消息回落只对模型保留，因为即使从未记录过
 * 任何选择，消息也带着回答它的 wire id。它报告的名字是 wire id，也就是用户从不指名时该行会被称呼
 * 的方式。这次遍历按构造就是分支相对的，但只有回落是：快照的值是 session 级的，移动叶子不再切换
 * 它们。
 */
function getSessionContextSettings(
	setting: SessionSetting,
	chain: SessionEntry[],
): Pick<SessionContext, "thinkingLevel" | "model"> {
	const merged = setting.model;
	let model =
		merged?.name !== undefined && merged?.modelId !== undefined
			? { name: merged.name, modelId: merged.modelId }
			: null;
	if (model === null) {
		for (const entry of chain) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				model = { name: entry.message.model, modelId: entry.message.model };
			}
		}
	}
	return { thinkingLevel: merged?.thinkingLevel ?? "off", model };
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

/** 作用于一条路径的三个视图决定，顺序为压缩、截短、清空。 */
function contextEntriesFromPath(chain: SessionEntry[]): SessionEntry[] {
	return applyClears(applyTrims(contextEntriesFrom(chain), trimmedEntryIds(chain)), clearedEntryIds(chain));
}

/** 应用了最新检查点的分支：检查点本身，然后是它保留的一切。 */
function contextEntriesFrom(chain: SessionEntry[]): SessionEntry[] {
	let compaction: CompactionEntry | null = null;
	for (const entry of chain) {
		if (entry.type === "compaction") compaction = entry;
	}
	if (!compaction) return chain;

	const compactionIndex = chain.findIndex((entry) => entry.id === compaction.id);
	if (compactionIndex < 0) return chain;

	const contextEntries: SessionEntry[] = [compaction];
	let foundFirstKept = false;
	for (let index = 0; index < compactionIndex; index++) {
		const entry = chain[index]!;
		if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
		if (foundFirstKept) {
			contextEntries.push(entry);
		}
	}
	contextEntries.push(...chain.slice(compactionIndex + 1));
	return contextEntries;
}

/** 本分支上每条 `clear_tool_result` 记录清空的条目 id。从分支读，不从视图读。 */
function clearedEntryIds(chain: SessionEntry[]): Set<string> {
	const cleared = new Set<string>();
	for (const entry of chain) {
		if (entry.type !== "clear_tool_result") continue;
		for (const id of entry.clearedEntryIds) cleared.add(id);
	}
	return cleared;
}

/** 视图，clear 记录指名的 result 在原位被掏空。 */
function applyClears(entries: SessionEntry[], cleared: ReadonlySet<string>): SessionEntry[] {
	if (cleared.size === 0) return entries;
	return entries.map((entry) => (cleared.has(entry.id) ? clearToolResult(entry) : entry));
}

/** 本分支上每条 `trim_tool_call_arg` 记录指名的条目 id。从分支读，不从视图读。 */
function trimmedEntryIds(chain: SessionEntry[]): Set<string> {
	const trimmed = new Set<string>();
	for (const entry of chain) {
		if (entry.type !== "trim_tool_call_arg") continue;
		for (const id of entry.trimmedEntryIds) trimmed.add(id);
	}
	return trimmed;
}

/** 视图，trim 记录指名的记录参数在原位被截短。 */
function applyTrims(entries: SessionEntry[], trimmed: ReadonlySet<string>): SessionEntry[] {
	if (trimmed.size === 0) return entries;
	return entries.map((entry) => (trimmed.has(entry.id) ? trimToolCallArgs(entry) : entry));
}

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;

/** 解析一行 JSONL，失败返回 null：一行读不了不能让 session 其余部分也读不了。 */
function parseJsonlLine(line: string): SessionEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as SessionEntry;
	} catch {
		return null;
	}
}

/** 整体读取一个 session 的条目流。`absFilePath` 已由调用方解析。 */
function loadJsonlEntries(absFilePath: string): SessionEntry[] {
	if (!existsSync(absFilePath)) return [];

	const entries: SessionEntry[] = [];
	let pending = "";
	const fd = openSync(absFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);

		for (;;) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const entry = parseJsonlLine(pending.slice(lineStart, newlineIndex));
				if (entry) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		const finalEntry = parseJsonlLine(pending);
		if (finalEntry) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}

	// 没有结尾换行的最后一行会被下一次追加接上去。
	if (pending) appendFileSync(absFilePath, "\n");
	return entries;
}

/**
 * 读取 session 的 `.json` 快照，读不了就拒绝。
 *
 * 读不了的文件、缺身份字段的文件、版本不是本构建的文件，答案都一样：不是本构建的 session。拒绝
 * 意味着什么由调用方决定——{@link fillSession} 把它变成删掉再抛，发现环节变成跳过。
 */
function readMetaFile(absJsonPath: string): SessionMeta {
	const raw = JSON.parse(readFileSync(absJsonPath, "utf8")) as SessionMeta;
	if (
		typeof raw?.id !== "string" ||
		typeof raw?.timestamp !== "string" ||
		typeof raw?.workDir !== "string" ||
		raw.workDir === ""
	) {
		throw new Error(`Session file is not a valid ${APP_NAME} session: ${absJsonPath}`);
	}
	if (raw.version !== CURRENT_SESSION_VERSION) {
		throw new Error(`Session version ${String(raw.version)} is not this build's ${CURRENT_SESSION_VERSION}: ${absJsonPath}`);
	}
	return raw;
}

/**
 * 为发现环节读取 session 的 `.json` 快照：尽力而为，出错返回 null。
 *
 * `absPath` 可以指两半中的任何一个——手里拿着 `.jsonl` 的调用方由它推导快照路径，而不是重新扫
 * 目录。发现是尽力而为：一个读不了或版本不对的文件不能把其他 session 藏起来。
 */
function readMetaForDiscovery(absPath: string): SessionMeta | null {
	try {
		return readMetaFile(absPath.endsWith(".json") ? absPath : sessionMetaPath(absPath));
	} catch {
		return null;
	}
}

function sessionWorkDirMatches(metaWorkDir: string | undefined, workDirAbsPath: string): boolean {
	return metaWorkDir !== undefined && metaWorkDir !== "" && resolvePath(metaWorkDir) === workDirAbsPath;
}

/**
 * 删除本构建无法打开的 session 的两半文件。
 *
 * v5 不保留迁移也不隔离：被本构建拒绝的配对是一个永远无法再打开的 session，留着它会让每次列表都
 * 为一个幽灵付代价。触发点是 store 扫描（{@link settleSessionFiles}）和 {@link fillSession}——每个
 * 证明配对打不开的读者都移除它，store 保持是一个 session 清单，而不是同时还是一片坟场。
 */
function pruneSessionFiles(absJsonPath: string, absJsonlPath: string): void {
	try {
		rmSync(absJsonPath, { force: true });
	} catch {
		// 删除失败不能掩盖配对失败的原因；下一次扫描会再试。
	}
	try {
		rmSync(absJsonlPath, { force: true });
	} catch {
		// 同理：反正配对已死，下一次扫描清理这一轮没清掉的。
	}
}

/** 一个 stem 的两个文件，按 store 扫描所见。 */
interface SessionFilePair {
	absJson?: string;
	absJsonl?: string;
}

/**
 * 按 stem 配对一个 store 的文件，并移除本构建打不开的一切。
 *
 * session 是共享一个 stem 的 `.json` + `.jsonl` 配对，`.json` 是提交标记：诞生时它最后写入，所以
 * 未配对的半边是半途夭折的诞生，版本不是本构建的文件是上一代写下的文件。两者都在这里删除——扫描
 * 是唯一走遍每个文件的地方，所以也是唯一一处能不跑第二遍就淘汰打不开的配对的地方。返回的是可读的
 * 剩余部分，meta 已在手。
 *
 * 清除抓不到进行中的诞生：整个函数是一个同步块，诞生（`persistEntry`）也是一个同步块，一个进程
 * 从不同时跑两者——并发写入的情形不在格式的章程之内。
 */
function settleSessionFiles(absDir: string): { absJson: string; absJsonl: string; meta: SessionMeta }[] {
	const pairs = new Map<string, SessionFilePair>();
	for (const file of readdirSync(absDir)) {
		const dot = file.lastIndexOf(".");
		if (dot <= 0) continue;
		const ext = file.slice(dot);
		if (ext !== ".json" && ext !== ".jsonl") continue;
		const pair = pairs.get(file.slice(0, dot)) ?? {};
		if (ext === ".json") pair.absJson = join(absDir, file);
		else pair.absJsonl = join(absDir, file);
		pairs.set(file.slice(0, dot), pair);
	}

	const settled: { absJson: string; absJsonl: string; meta: SessionMeta }[] = [];
	for (const pair of pairs.values()) {
		if (pair.absJson === undefined || pair.absJsonl === undefined) {
			pruneSessionFiles(pair.absJson ?? "", pair.absJsonl ?? "");
			continue;
		}
		try {
			const meta = readMetaFile(pair.absJson);
			// 快照存在时流在法律上不可能是空的——诞生先写完整条日志再写快照——所以空流是半途夭折
			// 的配对。
			if (statSync(pair.absJsonl).size === 0) {
				pruneSessionFiles(pair.absJson, pair.absJsonl);
				continue;
			}
			settled.push({ absJson: pair.absJson, absJsonl: pair.absJsonl, meta });
		} catch {
			pruneSessionFiles(pair.absJson, pair.absJsonl);
		}
	}
	return settled;
}

/**
 * 旧构建写入的遗留布局，跑过它的机器上仍然能找到：
 * `<sessionsDir>/--<dashed workDir>--/<ISO stamp>_<id>.jsonl`。扁平 store 读不了它——id 埋在文件名
 * 里、藏在时间戳后面——所以第一次触碰 store 时，把每个配对移进扁平根目录并忘掉那些文件夹。
 *
 * 什么都不删：本构建读不了的配对，或目标 id 已被已诞生 session 占用的配对，原地不动；文件夹只在
 * 什么都不剩时才移除。移动每个进程发生一次、惰性触发，在第一个否则会错过遗留配对的查找或列表时
 * 进行——之后，`findSessionFilePathById` 就是一次 stat。
 */
let storeMigrated = false;

function ensureStoreMigrated(): void {
	if (storeMigrated) return;
	storeMigrated = true;
	migrateLegacyStore();
}

function migrateLegacyStore(): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(sessionsDir(), { withFileTypes: true });
	} catch {
		return; // 没有 sessions 目录就是正常的首次运行。
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const absDir = join(sessionsDir(), entry.name);
		if (!migrateLegacyDirectory(absDir)) continue;
		try {
			rmdirSync(absDir);
		} catch {
			// 拿不走的空文件夹无害，不值得为它让启动失败。
		}
	}
}

/** 把 `absDir` 里的每个完整配对移进扁平 store；该目录里配对的东西都不剩时返回 true。 */
function migrateLegacyDirectory(absDir: string): boolean {
	let names: string[];
	try {
		names = readdirSync(absDir);
	} catch {
		return false;
	}
	let empty = true;
	for (const name of names) {
		if (!name.endsWith(".json")) continue; // 每个配对按其快照（身份那一半）找到
		const absJson = join(absDir, name);
		const absJsonl = sessionJsonlPath(absJson);
		if (!existsSync(absJsonl)) continue;
		let id: string;
		try {
			id = readMetaFile(absJson).id;
		} catch {
			empty = false; // 读不了：store 扫描会清理它，这次移动不碰它
			continue;
		}
		const target = sessionPath(id);
		if (existsSync(sessionMetaPath(target))) {
			empty = false; // 已诞生的 session 占用了这个 id：旧配对原地不动
			continue;
		}
		try {
			// 先移流，后移快照：两次 rename 之间目标处放着一个未配对的流，所有读者把它读成
			// 「没有这个 session」——绝不会读成半个诞生的 session。被早前中断的一轮遗落在那的流
			// 本来就是这个 id 自己的日志，所以 rename 之前清掉它不会让另一个 session 付出任何代价。
			rmSync(target, { force: true });
			renameSync(absJsonl, target);
			renameSync(absJson, sessionMetaPath(target));
		} catch {
			empty = false;
		}
	}
	return empty;
}

function isMessageWithContent(message: Message): boolean {
	return typeof (message as { role?: unknown }).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => {
			return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
		})
		.map((block) => block.text)
		.join(" ");
}

function getMessageActivityTime(entry: MessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const messageTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof messageTimestamp === "number") return messageTimestamp;

	const parsed = new Date(entry.timestamp).getTime();
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * 一个 session 的摘要，供选择器用：它是谁、何时动过，以及足以搜索它的文本。
 *
 * 扫描按格式的两半拆开：身份字段——id、workDir、parent、created、记录的标题、suspended 标记——来自
 * `.json` 快照，消息统计来自对 `.jsonl` 逐行扫一遍，只有那一半需要逐条解析。扫描的调用方
 * （{@link settleSessionFiles}）已配好文件并清除了打不开的，所以这里拿到 meta 就意味着这是本构建
 * 能打开的 session。
 *
 * `modified` 优先取最后一条消息自己的时间戳而不是 meta 的，因为正在被追加的 session，其 birthtime
 * 对它的年龄什么也说不出来。
 */
async function buildSessionInfo(
	absJsonPath: string,
	absJsonlPath: string,
	meta: SessionMeta,
	signal?: AbortSignal,
): Promise<SessionInfo | null> {
	try {
		const stats = await stat(absJsonlPath);
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let lastActivityTime: number | undefined;
		/**
		 * 分支，以两张表的形式，在本来就在读每条条目的循环里顺带读出。
		 *
		 * 记录的标题已随 `rename` 条目消失——快照现在持有它——所以标题还需要扫描给的只剩*派生的*
		 * 回落：叶子所在分支上的第一条 user 消息。这需要读者沿用的同一套 parent 链接，在一条本就
		 * 在逐行解析的流程里收集它们只多付一个 `Map`。
		 */
		const parentOf = new Map<string, string | null>();
		const userTextOf = new Map<string, string>();
		/** 任何种类的最后一条条目，也就是从文件读分支时的起点。 */
		let leafId: string | undefined;

		const lines = createInterface({
			input: createReadStream(absJsonlPath, { encoding: "utf8", signal }),
			crlfDelay: Number.POSITIVE_INFINITY,
		});

		for await (const line of lines) {
			const entry = parseJsonlLine(line);
			if (!entry) continue;
			leafId = entry.id;
			parentOf.set(entry.id, entry.parentId);
			if (entry.type !== "message") continue;
			messageCount++;

			const activityTime = getMessageActivityTime(entry);
			if (typeof activityTime === "number") lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);

			const message = entry.message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const text = extractTextContent(message);
			if (!text) continue;
			allMessages.push(text);
			if (!firstMessage && message.role === "user") firstMessage = text;
			if (message.role === "user" && !userTextOf.has(entry.id)) userTextOf.set(entry.id, text);
		}

		const metaTime = new Date(meta.timestamp).getTime();
		const modified =
			typeof lastActivityTime === "number" && lastActivityTime > 0
				? new Date(lastActivityTime)
				: !Number.isNaN(metaTime)
					? new Date(metaTime)
					: stats.mtime;

		return {
			absPath: absJsonlPath,
			id: meta.id,
			workDirAbsPath: meta.workDir,
			...(meta.parentSession === undefined ? {} : { absParentSessionPath: meta.parentSession }),
			created: new Date(meta.timestamp),
			modified,
			messageCount,
			title: meta.title ?? titleOfBranch(parentOf, userTextOf, leafId),
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
			suspended: meta.suspended === true,
		};
	} catch {
		signal?.throwIfAborted();
		return null;
	}
}

/**
 * 以 `leafId` 结尾的分支上的第一条 user 消息，截短——或占位符。
 *
 * 从叶子走回根再反转，与 {@link SessionManager.getBranch} 给活 session 报告的是同一条路径，所以扫描
 * 出的一行和运行中的一行命名的是同一段对话。没有记录 parent 的条目终止遍历，表里没有的条目也一样
 * ——另一个构建写的文件可以指名这次扫描从未见过的 parent，一个较短的标题好过没有。
 */
function titleOfBranch(
	parentOf: ReadonlyMap<string, string | null>,
	userTextOf: ReadonlyMap<string, string>,
	leafId: string | undefined,
): string {
	const walked: string[] = [];
	let current = leafId;
	while (current !== undefined && parentOf.has(current)) {
		walked.push(current);
		current = parentOf.get(current) ?? undefined;
	}
	walked.reverse();
	for (const id of walked) {
		const text = userTextOf.get(id);
		if (text === undefined) continue;
		const title = shortenTitle(text);
		if (title.length > 0) return title;
	}
	return "新会话";
}

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	map: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (nextIndex < items.length) {
			signal?.throwIfAborted();
			const index = nextIndex++;
			results[index] = await map(items[index]!, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return results;
}

function sortSessionInfos(sessions: SessionInfo[]): SessionInfo[] {
	return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/**
 * 给每个 fork 补上它来源 session 的 id，当两者都在本次列表中。
 *
 * header 记录的是源的*文件路径*，因为那是拿着一个文件的读者手里有的东西。列表是第一个 fork 两端
 * 同时可知的地方，所以路径在这里解析成客户端打开 session 用的 id——是 id 不是路径，因为侧栏其他
 * 每一行都以 id 命名。本目录之外的 parent 保持未解析、fork 显示为根，这是诚实的读法：这里的东西
 * 同样打不开它。
 */
function linkForkParents(sessions: SessionInfo[]): void {
	const byAbsPath = new Map<string, string>();
	for (const session of sessions) byAbsPath.set(absPathKey(session.absPath), session.id);

	for (const session of sessions) {
		if (session.absParentSessionPath === undefined) continue;
		const parentId = byAbsPath.get(absPathKey(session.absParentSessionPath));
		if (parentId === undefined || parentId === session.id) continue;
		session.parentId = parentId;
	}
}

/** 一次查找可以建 key 的路径：已解析，并在文件系统不区分大小写的地方同样折叠。 */
function absPathKey(absPath: string): string {
	const absResolved = resolvePath(absPath);
	return process.platform === "win32" ? absResolved.toLowerCase() : absResolved;
}

async function listSessionsFromDir(absDir: string, signal?: AbortSignal): Promise<SessionInfo[]> {
	signal?.throwIfAborted();
	if (!existsSync(absDir)) return [];

	try {
		// 扫描配好文件并清除打不开的（settleSessionFiles），所以留在这里的恰好是本构建能打开的
		// session。
		const pairs = settleSessionFiles(absDir);
		const results = await mapWithConcurrency(
			pairs,
			MAX_CONCURRENT_SESSION_INFO_LOADS,
			async (pair) => buildSessionInfo(pair.absJson, pair.absJsonl, pair.meta, signal),
			signal,
		);
		// 一条消息都没有的文件是一次没人说过话的创建，不是一段对话：侧栏是对话清单，所以在这里
		// 略掉它而不是画成「新会话」。v5 下盘上没有东西会是空的——两个文件随第一条消息诞生——
		// 所以这是对损坏配对的防御，不是写入方需要的过滤器。
		const sessions = results.filter((info): info is SessionInfo => info !== null && info.messageCount > 0);
		linkForkParents(sessions);
		return sessions;
	} catch {
		signal?.throwIfAborted();
		return [];
	}
}

/** 一条条目之下的子树的总和，供 {@link SessionManager.getBranchPoints} 用。 */
interface SubtreeDescription {
	/** 条目下方最新的 tip，没有后续时就是条目本身。 */
	tip: string;
	/** 可达一条消息条目时为 true，这是孩子算作真实备选的条件。 */
	message: boolean;
	/** 其下最早一条消息的一行预览，没有则为空。 */
	label: string;
}

/**
 * 分支标签携带消息第一句话的多少。
 *
 * 卡片只显示一行省略号截断的文字，别的什么都没有——没有悬停展开——所以界限按一句真实的话来定，
 * 而不是按一行定，需要更长的句子由样式表直接截断：分支选项随每个快照传递，这些整体随行，这正是
 * 标签只是预览而不是消息本身的原因。不在活跃链上的备选在快照里没有消息可读，没有更长的回落可言。
 * 见 ticket `.scratch/ui-pass` 02。
 */
export const BRANCH_LABEL_MAX = 200;

/** 一行简短文字，说明一条消息说了什么，供分支切换器的标签。 */
function previewOfMessage(message: Message): string {
	const text = extractTextContent(message).replace(/\s+/g, " ").trim();
	if (text.length === 0) return "";
	return text.length > BRANCH_LABEL_MAX ? `${text.slice(0, BRANCH_LABEL_MAX - 3)}...` : text;
}

/**
 * 一个 session 自己的选择，从盘上快照的扁平字段重新组合。
 *
 * 这只是内存中的组合——盘上的 `.json` 保持扁平形状（{@link SessionMeta}），fill 路径和 {@link metaOf}
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
 * 状态（本文件底部的 `SessionManager` 类是这些函数之上的无状态服务：它只加了打开时填充的缓存）。
 * 状态刻意是纯数据：哪个函数碰哪个字段在签名里一目了然，测试可以直接构造一个裸状态并对它调用
 * 任何操作。
 *
 * 这些字段是两个文件重放进去的内容。身份是袋自己的——id、创建时间戳、两个文件路径——
 * {@link SessionSetting} 持有 `.json` 快照的当前选择，在内存里重新组合：盘上文件保持扁平，fill 路径
 * 和 {@link metaOf} 是仅有的翻译点。`jsonlEntries` 是 `.jsonl` 条目流：每条条目带自己的 id 和
 * parent 的 id，所以这条流读起来是一棵树，`leafId` 就是对话此刻所在的位置。追加产生叶子的孩子；
 * {@link branch} 把叶子移到更早的条目——并把移动记录为一条 {@link LeafEntry}，新读者由此恢复——
 * 于是一段新的工作从那里继续，不碰已写入的东西。条目流一旦有了条目就从不重写，这让本构建不理解的
 * 条目种类或字段原样穿过；只有快照会被整体重写，且只在它持有的值发生变化时。
 *
 * 用 {@link buildSessionContext} 获取应发给 provider 的消息：它沿分支从根走到叶，并折入最新的压缩。
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
	 * 两个文件——条目流和 meta 快照；true 表示条目追加、meta 变更重写快照。见 {@link persistEntry}。
	 */
	fileCreated: boolean;
	/** session 自己的选择，即盘上快照扁平字段在内存中的重组。 */
	sessionSetting: SessionSetting;
	jsonlEntries: SessionEntry[];
	sessionEntryMapById: SessionEntryMapById;
	leafId: string | null;
}

/**
 * 把盘上快照的扁平选择字段合并成内存的重组 setting。
 *
 * 盘↔内存翻译中读文件的那个方向：thinking level 折进 `model`，其余按新名字原样移过去。缺席就是
 * 缺席——从未选择的 session 不在对象上放任何字段，于是「从未选择」和「选了默认」保持可区分。
 * `suspended` 缓存是唯一始终存在的字段：盘上缺席按 false 读。
 */
function sessionSettingOf(meta: SessionMeta): SessionSetting {
	return {
		workDirAbsPath: meta.workDir,
		...(meta.parentSession === undefined ? {} : { parentSessionId: meta.parentSession }),
		...(meta.title === undefined ? {} : { title: meta.title }),
		...(meta.model === undefined && meta.thinkingLevel === undefined
			? {}
			: { model: { ...meta.model, ...(meta.thinkingLevel === undefined ? {} : { thinkingLevel: meta.thinkingLevel }) } }),
		...(meta.activeTools === undefined ? {} : { activeTools: meta.activeTools }),
		...(meta.approval === undefined ? {} : { approval: meta.approval }),
		suspended: meta.suspended === true,
	};
}

/**
 * 把合并的模型选择拆回盘上快照的两个扁平字段。
 *
 * 只有两处名字都在时才写行——只带 thinking level 的 model 对象是一个没记行的 level，盘上把它单作
 * `thinkingLevel` 持有。本构建写出的 session 行上总是两个名字都有，所以对盘上合法持有的一切，这次
 * 拆分是无损的。
 */
function recordedModelOf(
	model: SessionSetting["model"],
): Pick<SessionMeta, "model" | "thinkingLevel"> {
	if (model === undefined) return {};
	const { name, modelId, thinkingLevel } = model;
	return {
		...(name === undefined || modelId === undefined ? {} : { model: { name, modelId } }),
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
	};
}

/**
 * 一个 session 的内存状态写出的盘上快照：从重组的 {@link SessionSetting} 重建扁平的
 * {@link SessionMeta}。
 *
 * 盘↔内存翻译中写文件的那个方向——{@link writeMetaFile} 序列化它，`getMeta` 把同样的形状交给
 * 读者。身份字段来自袋自己：版本号始终是本构建的（读取侧拒绝其他一切），创建时间戳在袋上传递，
 * 因为文件名无法把它无损地还回来。
 */
function metaOf(s: Session): SessionMeta {
	const setting = s.sessionSetting;
	return {
		version: CURRENT_SESSION_VERSION,
		id: s.sessionId,
		timestamp: s.timestamp,
		workDir: setting.workDirAbsPath,
		...(setting.parentSessionId === undefined ? {} : { parentSession: setting.parentSessionId }),
		...(setting.title === undefined ? {} : { title: setting.title }),
		...recordedModelOf(setting.model),
		...(setting.activeTools === undefined ? {} : { activeTools: setting.activeTools }),
		...(setting.approval === undefined ? {} : { approval: setting.approval }),
		...(setting.suspended ? { suspended: true } : {}),
	};
}

/**
 * 一个新 session 的状态，等待第一次追加。
 *
 * store 目录可以在这里创建，但不会创建任何文件：文件随第一条值得保留的条目出现——
 * {@link persistEntry} 里的闸门（`hasConversation`）——所以没人说过的 session 不在盘上留下
 * transcript，也不在侧栏留下一行。这就是构建状态而不写快照的全部意义：store 是对话的记录，没有
 * 消息的对话还不是对话。
 *
 * 代价是在那条首条消息之前 id 无法按址找到：{@link findSessionFilePathById} 向 store 要一个配对，
 * 还没有配对的 id 在那里找不到。因此把 id 递出去、之后还要为它负责的调用方，会在那个窗口内持有
 * 状态（或包着它的 `SessionManager` 外壳）——`SessionHub` 就持有那么久。
 */
export function createSession(
	workDirInput: string,
	storeDirInput?: string,
	parentSessionFileInput?: string,
): Session {
	const absDir = storeDirInput ? normalizePath(storeDirInput) : sessionsDir();
	if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });
	const s: Session = {
		sessionId: "",
		timestamp: "",
		sessionDirAbsPath: absDir,
		persist: true,
		fileCreated: false,
		sessionSetting: { workDirAbsPath: resolvePath(workDirInput), suspended: false },
		jsonlEntries: [],
		sessionEntryMapById: new Map(),
		leafId: null,
	};
	newSession(s, parentSessionFileInput);
	return s;
}

/** 从不落盘的 session 的状态。 */
export function inMemorySession(workDirInput: string = process.cwd(), parentSessionFileInput?: string): Session {
	const s: Session = {
		sessionId: "",
		timestamp: "",
		sessionDirAbsPath: null,
		persist: false,
		fileCreated: false,
		sessionSetting: { workDirAbsPath: resolvePath(workDirInput), suspended: false },
		jsonlEntries: [],
		sessionEntryMapById: new Map(),
		leafId: null,
	};
	newSession(s, parentSessionFileInput);
	return s;
}

/**
 * 把一个 session 的两个文件重放成新的 {@link Session}：把盘上路径变成 session 操作所作用状态的唯一
 * 入口。
 *
 * `.json` 快照给出身份和当前选择；`.jsonl` 重放条目树；叶子从流上落位。本构建打不开的配对被
 * *删除*，而不是拒绝后留在原地——v≤4 文件、未配对的半边、错误的版本，都是永远无法再打开的
 * session，留着它们会让每次扫描都撞见幽灵——然后打开动作抛出异常。路径可以指两半中的任何一个：
 * 手里拿着 `.jsonl` 的调用方传它，快照在同一 stem 上找到。
 */
export function fillSession(absFilePath: string): Session {
	const absPath = resolvePath(absFilePath);
	const absJsonl = absPath.endsWith(".json") ? sessionJsonlPath(absPath) : absPath;
	const absJson = sessionMetaPath(absJsonl);
	if (!existsSync(absJsonl)) {
		// 无论如何都是未配对：清掉存在的半边，拒绝打开。
		if (existsSync(absJson)) pruneSessionFiles(absJson, absJsonl);
		throw new Error(`Session file does not exist: ${absJsonl}`);
	}
	let meta: SessionMeta;
	try {
		meta = readMetaFile(absJson);
	} catch (error) {
		pruneSessionFiles(absJson, absJsonl);
		throw error;
	}
	const entries = loadJsonlEntries(absJsonl);
	if (entries.length === 0) {
		// 快照存在时条目流在法律上不能是空的：诞生是两边一起写的，空流就是半途夭折的配对。和其他
		// 情况一样清掉。
		pruneSessionFiles(absJson, absJsonl);
		throw new Error(`Session file is not a valid ${APP_NAME} session: ${absJsonl}`);
	}
	const s: Session = {
		sessionId: meta.id,
		timestamp: meta.timestamp,
		sessionFileAbsPath: absJsonl,
		sessionDirAbsPath: dirname(absJsonl),
		persist: true,
		fileCreated: true,
		sessionSetting: sessionSettingOf(meta),
		jsonlEntries: entries,
		sessionEntryMapById: new Map(),
		leafId: null,
	};
	buildIndex(s);
	return s;
}

/**
 * 在 `s` 里开始一个全新的 session，丢弃它原来持有的一切。返回文件路径。
 *
 * `parentSessionFile` 是本 session 从之而来的 session 的绝对路径——fork 的源——它作为
 * `parentSession` 落到快照上。undefined 表示根 session。相对路径在这里按进程的 cwd 解析，这也是
 * 列表把父子配对时用的同一个基准；按原样记录会让两侧在进程换了个地方运行的那一刻开始不一致。
 *
 * 上面两个构造函数是它仅有的调用方：袋在这里诞生，之后的每次写入都走服务的 append 和 record 方法。
 */
export function newSession(s: Session, parentSessionFile?: string): string | undefined {
	s.sessionId = createSessionId();
	s.timestamp = new Date().toISOString();
	s.sessionSetting = {
		workDirAbsPath: s.sessionSetting.workDirAbsPath,
		...(parentSessionFile === undefined ? {} : { parentSessionId: resolvePath(parentSessionFile) }),
		suspended: false,
	};
	s.jsonlEntries = [];
	s.sessionEntryMapById.clear();
	s.leafId = null;
	s.fileCreated = false;

	const dir = s.sessionDirAbsPath;
	if (s.persist && dir !== null) s.sessionFileAbsPath = sessionPath(s.sessionId, dir);
	return s.sessionFileAbsPath;
}

/** 按 id 索引 `s` 的条目并落位叶子，按文件顺序。 */
function buildIndex(s: Session): void {
	s.sessionEntryMapById.clear();
	s.leafId = null;
	for (const entry of s.jsonlEntries) {
		s.sessionEntryMapById.set(entry.id, entry);
		if (entry.type === "leaf") {
			// 记录指名对话去了哪；其他每个种类靠被追加这件事*就是*对话去了哪。文件顺序是最后一句话，
			// 所以任何种类的更晚条目推翻更早记录所说的话。记录的 null 是一个自己的位置——「第一条
			// 之前」——只有文件不持有的目标（只有手改文件能做到这一点）才回落到记录自己的树位置，
			// 与 `buildSessionPath` 给未知 id 的回答是同一族。
			s.leafId = entry.leafId === null || s.sessionEntryMapById.has(entry.leafId) ? entry.leafId : (entry.parentId ?? null);
		} else {
			s.leafId = entry.id;
		}
	}
}

/** session 一旦持有一条 user 或 assistant 消息即为 true，这就是它值得保留的条件。 */
function hasConversation(s: Session): boolean {
	return s.jsonlEntries.some(
		(entry) => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
	);
}

/**
 * 整体重写 `.json` 快照：写一个同目录的 temp 文件，再 rename 盖到快照上。
 *
 * 快照要的是一次写入，不是追加——而且扫描 store 的读者绝不能撞见写到一半的它，这就是 rename 买到
 * 的东西：temp 被写入、关闭、一步移入位置，所以每个读者要么看到旧快照要么看到新快照，绝不会看到
 * 撕裂的。rename 发生在同一目录内，所以在本代码运行的文件系统上是原子的。
 */
function writeMetaFile(s: Session): void {
	const absJsonl = s.sessionFileAbsPath;
	if (absJsonl === undefined) return;
	const absJson = sessionMetaPath(absJsonl);
	const absTemp = `${absJson}.${process.pid}.tmp`;
	const fd = openSync(absTemp, "wx");
	try {
		writeFileSync(fd, `${JSON.stringify(metaOf(s), null, "\t")}\n`);
	} finally {
		closeSync(fd);
	}
	renameSync(absTemp, absJson);
}

/**
 * 把一条条目写到盘上，文件还不存在时先扣住它。
 *
 * 闸门是刻意的：session 的第一条消息才换来它的文件（`hasConversation`），所以没人说过的 session
 * 永不落盘。通过闸门后的第一次写入一次性创建两个文件——完整的条目流，然后是作为提交标记的 meta
 * 快照——因为此前盘上没有任何东西接收它们；快照**最后**写，半途夭折的诞生就会留下未配对的半边，
 * 由 store 扫描清除而不是保留。从那以后（`fileCreated`）每条条目自行追加，每次 meta 变更重写快照。
 */
export function persistEntry(s: Session, entry: SessionEntry): void {
	if (!s.persist || !s.sessionFileAbsPath) return;

	if (!s.fileCreated) {
		if (!hasConversation(s)) return;
		const fd = openSync(s.sessionFileAbsPath, "wx");
		try {
			for (const existing of s.jsonlEntries) writeFileSync(fd, `${JSON.stringify(existing)}\n`);
		} catch (error) {
			// 没能落盘的流什么也不留下；下一次有闸门的写入从同一份内存日志重试诞生。
			closeSync(fd);
			rmSync(s.sessionFileAbsPath, { force: true });
			throw error;
		}
		closeSync(fd);
		writeMetaFile(s);
		s.fileCreated = true;
		return;
	}

	appendFileSync(s.sessionFileAbsPath, `${JSON.stringify(entry)}\n`);
}

/** 把 `entry` 加进日志成为新叶子，内存和盘上同时进行。 */
function appendEntry(s: Session, entry: SessionEntry): void {
	s.jsonlEntries.push(entry);
	s.sessionEntryMapById.set(entry.id, entry);
	s.leafId = entry.id;
	persistEntry(s, entry);
}

/**
 * 对快照应用一次变更，真的变了才重写文件。
 *
 * 变更先落在内存的 setting 上——那是每个读者回答的来源袋——盘上的副本只在 session 有文件可重写时
 * 才跟着写。文件还没诞生的 session 把变更单独留在内存里：{@link persistEntry} 在诞生时写快照，所以
 * 首条消息之前做出的选择得以存活，又不破坏「没有对话就没有文件」的规则。`change` 对 no-op 返回
 * false，这让一串相同的写入不必每次都付一次重写。
 */
function recordMeta(s: Session, change: (setting: SessionSetting) => boolean): void {
	if (!change(s.sessionSetting)) return;
	if (s.persist && s.fileCreated) writeMetaFile(s);
}

/** 两个工具名列表的集合相等：记录的集合是一个选择，不是一个顺序。 */
function sameToolSet(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name) => right.includes(name));
}

/** 两个审批表的字段相等，遍及任一侧指名的所有 key。 */
function metasApprovalEqual(left: Record<string, boolean>, right: Record<string, boolean>): boolean {
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) {
		if (left[key] !== right[key]) return false;
	}
	return true;
}

// =========================================================================
// 树遍历
// =========================================================================

/** 每条条目的孩子，按文件顺序，一遍扫完日志建好。 */
function childrenIndex(s: Session): Map<string, SessionEntry[]> {
	const index = new Map<string, SessionEntry[]>();
	for (const entry of s.sessionEntryMapById.values()) {
		if (entry.parentId === null) continue;
		const siblings = index.get(entry.parentId);
		if (siblings === undefined) index.set(entry.parentId, [entry]);
		else siblings.push(entry);
	}
	return index;
}

/**
 * 一个备选的总和：`entryId` 之下的子树在哪里结束，以及如何标注。
 *
 * 按条目记忆化，无论多少分支点询问，一次调用只描述整份日志一遍。
 */
function subtreeDescription(
	s: Session,
	entryId: string,
	children: Map<string, SessionEntry[]>,
	memo: Map<string, SubtreeDescription>,
): SubtreeDescription {
	const cached = memo.get(entryId);
	if (cached !== undefined) return cached;
	// 下降前先放入种子：这是被手改成环的文件绕回来时找到的东西，于是遍历在此结束而不是空转。
	memo.set(entryId, { tip: entryId, message: false, label: "" });

	const entry = s.sessionEntryMapById.get(entryId);
	const descents = (children.get(entryId) ?? []).map((child) =>
		subtreeDescription(s, child.id, children, memo),
	);
	const own = entry?.type === "message" ? previewOfMessage(entry.message) : undefined;
	let label = own ?? "";
	let message = own !== undefined;
	if (!message) {
		const below = descents.find((descent) => descent.message);
		if (below !== undefined) {
			message = true;
			label = below.label;
		}
	}
	const described: SubtreeDescription = {
		// 最新的孩子是最后写入的，而文件按写入顺序排列。
		tip: descents.length === 0 ? entryId : descents[descents.length - 1]!.tip,
		message,
		label,
	};
	memo.set(entryId, described);
	return described;
}

/**
 * 把一条叶子记录写成它所离开的叶子的孩子，不移动叶子。
 *
 * 调用方随后自己设置 {@link Session.leafId}：一次追加会推进叶子，而这次不能——记录在树里的位置和
 * 它报告的位置是两个事实，各有各的字段。
 */
function appendLeafRecord(s: Session, leafId: string | null): void {
	const entry: LeafEntry = {
		type: "leaf",
		id: generateId(s.sessionEntryMapById),
		parentId: s.leafId,
		timestamp: new Date().toISOString(),
		leafId,
	};
	s.jsonlEntries.push(entry);
	s.sessionEntryMapById.set(entry.id, entry);
	persistEntry(s, entry);
}

/**
 * session 服务：账本的操作，以及操作之下的文件 I/O。
 *
 * 每个 per-session 方法都以 {@link Session} 为第一参数、在这里完成工作——没有第二层同名文件级函数
 * 供转发，所以读这个文件的调用方读到的就是实现。这个类不持有任何 per-session 状态（ADR-0007 §2）
 * 也没有缓存：袋归填充或构建它的人所有，orchestrator 的表（`Agent`）是唯一在调用之间持有运行中
 * session 的袋的地方。
 *
 * 这个类拥有的是 store 的格式知识：id 如何变成文件路径
 * （{@link SessionManager.findSessionFilePathById}），文件如何变成袋（{@link fillSession}，连同它的
 * 清除和版本拒绝），写入如何到达盘上（`persistEntry`、`writeMetaFile`）。
 */
export class SessionManager {
	/**
	 * 追加一条消息作为叶子的孩子并推进叶子。返回新条目的 id。
	 *
	 * 这里刻意不接受压缩摘要：它必须是顶层条目，{@link SessionManager.buildContextEntries} 才能找到
	 * 它，这正是 {@link appendCompaction} 存在的原因。
	 */
	appendMessage(s: Session, message: Message): string {
		const entry: MessageEntry = {
			type: "message",
			id: generateId(s.sessionEntryMapById),
			parentId: s.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		appendEntry(s, entry);
		return entry.id;
	}

	/**
	 * 记录这个 session 最后一次请求的 thinking level，作为快照的当前值。
	 *
	 * 不是条目：level 是*当前值*，所以 `.json` 快照持有它，它之前是什么的历史刻意消失——从没人读过。
	 * 文件还没诞生的 session 把变更留在内存里；{@link persistEntry} 在诞生时写快照，所以选择得以
	 * 存活，又不破坏「没有对话就没有文件」的规则。
	 */
	setThinkingLevel(s: Session, thinkingLevel: string): void {
		recordMeta(s, (setting) => {
			if (setting.model?.thinkingLevel === thinkingLevel) return false;
			setting.model = { ...(setting.model ?? {}), thinkingLevel };
			return true;
		});
	}

	/**
	 * 记录这个 session 最后一次运行的模型行，作为快照的当前值。
	 *
	 * `name` 是行的身份——见 `ModelConfig`——所以后来把「这个 session 在哪个模型上」变回一行靠的就是它。
	 * 不是条目：选择是*当前值*，快照只持有生效的东西。重命名刻意不归这里管：重命名是同一个模型换了
	 * 个名字，由旧名构建的 ref 已经有了着落。
	 */
	setModel(s: Session, name: string, modelId: string): void {
		recordMeta(s, (setting) => {
			if (setting.model?.name === name && setting.model.modelId === modelId) return false;
			setting.model = { ...(setting.model ?? {}), name, modelId };
			return true;
		});
	}

	/**
	 * 从袋重写快照，无论变更检测器怎么想。
	 *
	 * setter 的闸门拿袋作比较——袋是每个读者回答的来源——所以已在袋里、还没到盘上的变更会无声地
	 * 通过闸门：盘上持有的是 session 最后一次落盘的选择，袋里生效的可以与它不同。这是逃生口：整个
	 * 袋在一次原子重写里进快照。文件还没诞生的 session 保持袋原样；诞生写入会整体带上它。
	 */
	flushMeta(s: Session): void {
		if (s.persist && s.fileCreated) writeMetaFile(s);
	}

	/**
	 * 记录 session 的工具选择：激活集和审批表，都整体记录。
	 *
	 * 是快照不是增量，因为读者拿走的是生效值——与模型和 level 遵循的契约相同。两张表总是同时存在，
	 * 所以为工具变更做的一次调用会把审批集一起带上，反过来也一样。
	 */
	setToolConfig(s: Session, activeTools: string[], approval: Record<string, boolean>): void {
		recordMeta(s, (setting) => {
			if (
				setting.activeTools !== undefined &&
				sameToolSet(setting.activeTools, activeTools) &&
				setting.approval !== undefined &&
				metasApprovalEqual(setting.approval, approval)
			) {
				return false;
			}
			setting.activeTools = [...activeTools];
			setting.approval = { ...approval };
			return true;
		});
	}

	/**
	 * 记录 session 是否停在审批闸门处，作为快照的展示缓存。
	 *
	 * 不是选择也不是条目：账本的悬空 call 才是权威，这个字段只是给列表的冷扫描省一次完整重放。
	 * run 的结束清扫和放弃清扫写它——回答从不写，因为 call 在恢复 run 收尾它之前一直悬空。只有翻转
	 * 才付一次重写，且只有 true 才会到盘上（{@link metaOf}）。
	 */
	setSuspended(s: Session, suspended: boolean): void {
		recordMeta(s, (setting) => {
			if (setting.suspended === suspended) return false;
			setting.suspended = suspended;
			return true;
		});
	}

	/**
	 * 记录会话自己的名字，盖过派生的那个。
	 *
	 * 标题预期已被截短——接收用户输入的端点在到达这里之前先过 {@link shortenTitle}，所以落进快照的
	 * 就是一行会显示的。不是条目：名字是关于 session 的事实，不是关于某一条路径的事实（ADR-0002
	 * 从文件顺序论证出的读法），快照直接陈述它。
	 */
	setTitle(s: Session, title: string): void {
		recordMeta(s, (setting) => {
			if (setting.title === title) return false;
			setting.title = title;
			return true;
		});
	}

	/**
	 * 记录不拥有消息条目的模型开销，归因于 `model` 上的 `operation`。
	 *
	 * 整笔开销装在一条条目里、由写入方求和——一次委托在自己的 transcript 上跑很多请求，这个文件要
	 * 的是总数，不是收据清单。零 usage 的记录由调用方自行跳过：一条条目值一行，什么都没花的开销
	 * 不值得占一行。
	 */
	appendUsage(s: Session, operation: string, model: string, usage: Usage): string {
		const entry: UsageEntry = {
			type: "usage",
			id: generateId(s.sessionEntryMapById),
			parentId: s.leafId,
			timestamp: new Date().toISOString(),
			operation,
			model,
			usage,
		};
		appendEntry(s, entry);
		return entry.id;
	}

	/**
	 * 记录一个压缩检查点：`firstKeptEntryId` 之前的一切被 `summary` 替换。
	 *
	 * `firstKeptEntryId` 为 null 表示这次压缩不保留任何更早的条目，于是检查点就是剩下的全部历史，
	 * 条目指向自己。
	 */
	appendCompaction(
		s: Session,
		summary: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		usage?: Usage,
	): string {
		const timestamp = new Date().toISOString();
		const id = generateId(s.sessionEntryMapById);
		const entry: CompactionEntry = {
			type: "compaction",
			id,
			parentId: s.leafId,
			timestamp,
			summary,
			firstKeptEntryId: firstKeptEntryId ?? id,
			tokensBefore,
			...(usage === undefined ? {} : { usage }),
		};
		appendEntry(s, entry);
		return entry.id;
	}

	/**
	 * 记录 tool result 被清空：指名的条目保住文件里的位置，在视图里失去正文。
	 *
	 * 与压缩不同，这里没有要扣下的东西——result 之所以被清空，正是因为 run 能重新产出它们——所以
	 * 记录只有 id 和这次清空值多少。
	 */
	appendClearToolResults(s: Session, clearedEntryIds: readonly string[], tokensBefore: number): string {
		const entry: ClearToolResultEntry = {
			type: "clear_tool_result",
			id: generateId(s.sessionEntryMapById),
			parentId: s.leafId,
			timestamp: new Date().toISOString(),
			clearedEntryIds: [...clearedEntryIds],
			tokensBefore,
		};
		appendEntry(s, entry);
		return entry.id;
	}

	/**
	 * 记录 tool call 参数被截短：指名的条目保住文件里的位置，在视图里失去参数的重正文。
	 *
	 * 与清空一样，没有要扣下的东西——指名的参数属于 result 已在分支上的 call——所以记录只有 id 和
	 * 这次截短值多少。
	 */
	appendTrimToolCallArgs(s: Session, trimmedEntryIds: readonly string[], tokensBefore: number): string {
		const entry: TrimToolCallArgEntry = {
			type: "trim_tool_call_arg",
			id: generateId(s.sessionEntryMapById),
			parentId: s.leafId,
			timestamp: new Date().toISOString(),
			trimmedEntryIds: [...trimmedEntryIds],
			tokensBefore,
		};
		appendEntry(s, entry);
		return entry.id;
	}

	/** `parentId` 之后的每条条目，按文件顺序。 */
	getChildren(s: Session, parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of s.sessionEntryMapById.values()) {
			if (entry.parentId === parentId) children.push(entry);
		}
		return children;
	}

	/**
	 * 日志的分支点，按文件顺序。
	 *
	 * 一个孩子只有当消息经它可达时才算备选：这个格式也携带状态条目——tool result 清空、压缩、leaf
	 * 记录——而对话不能在其中一个上恢复，把它们算进来就是提供一个空备选。消息前面的状态条目出于
	 * 同一理由被穿越下去：回退、收缩视图、再问一次是一个备选，不是两个。
	 *
	 * 遍历覆盖**每一条**条目而不只是活跃链的，这让树成为对话的属性而不是叶子当前位置的属性：回退到
	 * 第一个问题，更下面的 fork 仍然在那里可以画出来，而按链报告的实现会在叶子移动的那一刻悄悄丢掉
	 * 它们——一页在叶子一动就忘掉半棵树的页面。`options[].active` 是保持分支相对的，也是唯一应该
	 * 分支相对的东西。
	 *
	 * 文件顺序也是客户端折叠各点的顺序：一个点的 `anchor` 是它自己的某个祖先，条目从不在其 parent
	 * 之前写入，所以一个点挂靠的卡片在点到达时总是已经放好了。
	 */
	getBranchPoints(s: Session): BranchPoint[] {
		const chain = this.getBranch(s);
		const onChain = new Set(chain.map((entry) => entry.id));
		const children = childrenIndex(s);
		const memo = new Map<string, SubtreeDescription>();

		// 第一遍：哪些条目被以不止一种方式延续，以及每种延续的总和。还什么都不放——anchor 要等所有
		// 点都已知才可知，因为卡片要么是线上的一条 user 消息，要么是更早点的选项。
		const forks: { entry: SessionEntry; options: BranchOption[] }[] = [];
		for (const entry of s.sessionEntryMapById.values()) {
			const options: BranchOption[] = [];
			for (const child of children.get(entry.id) ?? []) {
				const described = subtreeDescription(s, child.id, children, memo);
				if (!described.message) continue;
				options.push({
					entryId: child.id,
					label: described.label,
					active: onChain.has(child.id),
				});
			}
			if (options.length > 1) forks.push({ entry, options });
		}
		const forkIds = new Set(forks.map((fork) => fork.entry.id));

		/** 窗口会为它画卡片的条目为 true：线上的一问，或一条被走过的路径。 */
		const isCard = (entry: SessionEntry): boolean => {
			if (onChain.has(entry.id)) return entry.type === "message" && entry.message.role === "user";
			// 线外，只有 fork 自己的延续变成卡片。链上的条目在上面排除而不是在这里：链自己的延续被
			// 画成线上的下一张卡片，在它那里停下下降会指名一张不存在的卡片。
			return entry.parentId !== null && forkIds.has(entry.parentId);
		};

		/** `entryId` 及其上方最近的卡片，没有任何东西能承载它时为 undefined。 */
		const anchorOf = (entryId: string): string | undefined => {
			let current: SessionEntry | undefined = s.sessionEntryMapById.get(entryId);
			while (current !== undefined) {
				if (isCard(current)) return current.id;
				current = current.parentId === null ? undefined : s.sessionEntryMapById.get(current.parentId);
			}
			return undefined;
		};

		const prompts = new Map<string, string>();
		/** `entryId` 及其上方最近的一问，沿条目自己的 parent 链接上溯。 */
		const nearestPrompt = (entryId: string): string => {
			const cached = prompts.get(entryId);
			if (cached !== undefined) return cached;
			// 出于与 `subtreeDescription` 播种 memo 相同的理由在下降前播种：被手改成环的文件必须结束
			// 遍历而不是空转。
			prompts.set(entryId, "");
			const entry = s.sessionEntryMapById.get(entryId);
			let prompt = "";
			if (entry !== undefined) {
				const own = entry.type === "message" ? previewOfMessage(entry.message) : "";
				if (entry.type === "message" && entry.message.role === "user" && own.length > 0) {
					prompt = own;
				} else if (entry.parentId !== null) {
					prompt = nearestPrompt(entry.parentId);
				}
			}
			prompts.set(entryId, prompt);
			return prompt;
		};

		// 第二遍：各点及其备选挂靠的卡片。没有卡片能承载的点保留自己的 id，客户端没有它的卡片——
		// 在那里丢掉它，而不是画在不属于它的地方。
		return forks.map((fork) => ({
			entryId: fork.entry.id,
			anchor: anchorOf(fork.entry.id) ?? fork.entry.id,
			prompt: nearestPrompt(fork.entry.id),
			options: fork.options,
		}));
	}

	/**
	 * `entryId` 所根的子树的最深 tip：那条工作线会从哪里恢复。
	 *
	 * 下降每一步跟随最后写入的孩子，遍及所有条目种类，因为一条最后条目是压缩或模型变更的分支也在
	 * 那里停了。
	 */
	getBranchTip(s: Session, entryId: string): string {
		if (!s.sessionEntryMapById.has(entryId)) throw new Error(`Entry ${entryId} not found`);
		return subtreeDescription(s, entryId, childrenIndex(s), new Map()).tip;
	}

	/**
	 * 从 `fromId` 走到根，按路径顺序，包含所有条目种类。
	 *
	 * 这是原始分支；{@link SessionManager.buildContextEntries} 是应用了压缩的同一条遍历，provider
	 * 请求由它构建。
	 */
	getBranch(s: Session, fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const startId = fromId ?? s.leafId;
		let current = startId ? s.sessionEntryMapById.get(startId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? s.sessionEntryMapById.get(current.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	/**
	 * 构成当前 context 的条目，沿分支从根走到叶。
	 *
	 * 以条目形式记录的三个决定在这里应用，它们也是本方法区别于原始分支的全部：压缩条目是检查点——
	 * 分支上最新的一个被保留，它指名的条目之前的被丢弃，从 `firstKeptEntryId` 起的被保留——
	 * `clear_tool_result` 条目指名正文被清空的 tool result，`trim_tool_call_arg` 条目指名记录参数被
	 * 截短的 assistant 消息。恰好落在保留范围内的更早压缩也一并保留；贡献摘要的是最新的那个。
	 *
	 * 三个决定都只在这里应用，请求、快照和恢复的进程才共享同一份 transcript：文件保留每一行，每个
	 * 读者从它推导出同一个视图。
	 */
	buildContextEntries(s: Session): SessionEntry[] {
		return contextEntriesFromPath(buildSessionPath(s.sessionEntryMapById, s.leafId));
	}

	/**
	 * 从条目的一个分支构建发给模型的消息流。
	 *
	 * 这是把存储变成请求的唯一方法，也是恢复的 session 与活的 session 不会漂移的原因：两者都经过
	 * 这里。路径只走一遍，由设置读取和视图共享，所以两个都要只付一次遍历而不是两次。
	 */
	buildSessionContext(s: Session): SessionContext {
		const chain = buildSessionPath(s.sessionEntryMapById, s.leafId);
		const { thinkingLevel, model } = getSessionContextSettings(s.sessionSetting, chain);
		const messages = contextEntriesFromPath(chain).flatMap(sessionEntryToContextMessages);
		return { messages, thinkingLevel, model };
	}

	/**
	 * session 在盘上的快照记录的模型和 thinking level，从未选择时各自为 undefined。
	 *
	 * 对要提交一个选择的调用方，写入基线是盘上的副本而不是袋：袋已经带着生效的选择，拿它比较等于
	 * 自己比自己，永远看不出差异。每次调用现读而不是缓存，所以基线就是文件自己的。文件还没诞生的
	 * session 没有快照可读，以空记录回答——诞生写入会整体带上袋。
	 */
	recordedOnDisk(s: Session): { model?: { name: string; modelId: string }; thinkingLevel?: string } {
		if (!s.fileCreated || s.sessionFileAbsPath === undefined) return {};
		return recordedModelOf(sessionSettingOf(readMetaFile(sessionMetaPath(s.sessionFileAbsPath))).model);
	}

	/**
	 * 这个 session 当前所在的模型和 thinking level，从未选择时各自为 undefined。
	 *
	 * {@link SessionManager.buildSessionContext} 用这些值连同运行所需的默认值回答。这个方法服务于
	 * 必须区分「session 选了 off」和「session 从未选择」的调用方——装配环节，它决定存储值能否盖过
	 * 设置文件。快照是第一句话，transcript 是回落：模型回落到分支的最后一条 assistant 消息，它只可能
	 * 指名用户没给过名字的行。
	 */
	getRecordedSettings(s: Session): { model?: { name: string; modelId: string }; thinkingLevel?: string } {
		const recorded: { model?: { name: string; modelId: string }; thinkingLevel?: string } =
			recordedModelOf(s.sessionSetting.model);
		if (recorded.model === undefined) {
			// 只是回落，而且是弱回落：消息记录的是回答它的 wire id，不是行的身份，所以这只可能指名
			// 用户没给过名字的行。见 {@link getSessionContextSettings}。
			for (const entry of this.getBranch(s)) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					recorded.model = { name: entry.message.model, modelId: entry.message.model };
				}
			}
		}
		return recorded;
	}

	/**
	 * 本 session 最后记录的工具选择，从未选择时各自为 undefined。
	 *
	 * undefined 是有意义的，而且正是这个方法要保住的东西：从未选择的 session 以默认值打开，选过的
	 * session 完全按用户留下的样子重开。快照是完整的答案，所以这里读的是 session 而不是分支——这也
	 * 是两文件拆分改变的地方：移动叶子不再切换这些值，因为它们是 session 的，不是分支的。
	 */
	getRecordedToolConfig(s: Session): { activeTools?: string[]; approval?: Record<string, boolean> } {
		return { activeTools: s.sessionSetting.activeTools, approval: s.sessionSetting.approval };
	}

	/**
	 * {@link SessionManager.buildSessionContext} 的消息列表里每条消息背后的条目 id，顺序一致。
	 *
	 * 压缩检查点产出的消息不属于任何消息条目，那些读作 null。这就是 transcript 能对一条它从未看着
	 * 写下的消息提供「从这里 fork」的方式。
	 */
	getContextMessageEntryIds(s: Session): (string | null)[] {
		const ids: (string | null)[] = [];
		for (const entry of this.buildContextEntries(s)) {
			const produced = sessionEntryToContextMessages(entry).length;
			for (let index = 0; index < produced; index++) ids.push(entry.type === "message" ? entry.id : null);
		}
		return ids;
	}

	/**
	 * `.json` 快照的扁平形状，从 session 的重组 setting 重建：身份和当前选择。构建出的 session 上
	 * 始终存在。
	 */
	getMeta(s: Session): SessionMeta {
		return metaOf(s);
	}

	/** 文件顺序中的每一条条目。要加更多用 `append*` 方法。 */
	getEntries(s: Session): SessionEntry[] {
		return s.jsonlEntries;
	}

	/**
	 * 会话自己的名字：有记录的标题就用它，否则用分支的第一条 user 消息，否则占位符。
	 *
	 * 记录的标题来自快照，那个安放是刻意的：左列每个 session 画一行，不按路径画，所以人给会话起的
	 * 名字不会因为叶子移动就不再是他的——这正是 ADR-0002 论证的读法，现在由格式直接陈述，而不是从
	 * 文件顺序重建。下面的分支遍历保持原样——它是回落，把最旧的一个 turn 压缩掉也仍然不能重命名
	 * 会话。
	 */
	getTitle(s: Session): string {
		if (s.sessionSetting.title !== undefined) return s.sessionSetting.title;
		return deriveTitle(this.getBranch(s).flatMap(sessionEntryToContextMessages));
	}

	/**
	 * 把叶子移到更早的条目，让下一次追加从那里开一条新分支。
	 *
	 * 什么都不修改、什么都不删除：旧叶子之后的条目仍在文件里，仍可按 id 到达，只是不再位于活跃
	 * 分支上。
	 *
	 * 真正改变位置的移动记录为一条 {@link LeafEntry}，这让重开文件的进程能把叶子放回对话去过的位置。
	 * 记录追加为它所离开的叶子的孩子，不推进叶子——树位置说的是追加发生在哪，`leafId` 字段说的是
	 * 对话去了哪。移动到已持有的位置什么都不写，与 meta setter 对自己的写入施加的守卫相同：一串
	 * no-op 移动不花任何文件。
	 */
	branch(s: Session, branchFromId: string): void {
		if (!s.sessionEntryMapById.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		if (s.leafId === branchFromId) return;
		appendLeafRecord(s, branchFromId);
		s.leafId = branchFromId;
	}

	/** 把叶子移到第一条之前，下一次追加就成为新的根。 */
	resetLeaf(s: Session): void {
		if (s.leafId === null) return;
		appendLeafRecord(s, null);
		s.leafId = null;
	}

	/**
	 * 把 id 指名的 session 重放成本次调用拥有的袋：不注册、不缓存，用完由调用方丢弃。
	 *
	 * 这是冷路径，也是唯一的一条：本进程正在跑的 session 经其 orchestrator 持有的袋写入（`Agent`
	 * 的表），绝不通过重放它的文件——快照是整体重写的，一个过期的袋会把那个 session 的 turn 刚记下
	 * 的东西回滚掉。它回答的是一次已经完成的诞生：`.json` 快照是诞生的提交标记，所以与它匹配的 id
	 * 意味着旁边有一条 `.jsonl`，两个文件都不认的 id 会被本 store 的每个读者共用的那句话拒绝。存在
	 * 却打不开的配对由 {@link fillSession} 自己清除，所以这是一次可能会删除文件的读取。
	 *
	 * 冷写入是两步不是三步——先这里拿袋，再一个 setter，setter 自己写文件（`setTitle` 记录 meta，
	 * 记录即持久化）。没有第三个要记住的 persist 动词，也没有要冲刷的脏状态。这里的安全性不是 hold
	 * 的工作：session 被 hold 时，它唯一的写入方是 orchestrator 持有的袋；不被 hold 时，一次冷写入
	 * 是一个其他写入方进不来的同步块——两个窗口从不重叠，因为冷路径只服务没有任何东西 hold 的
	 * session。
	 */
	open(id: string): Session {
		const absPath = SessionManager.findSessionFilePathById(id);
		if (absPath === undefined) throw new UnknownSessionError(id);
		return fillSession(absPath);
	}

	// =========================================================================
	// 构建与发现
	// =========================================================================

	/**
	 * 把一个 session 的一个分支复制成它源旁边的一个新 session，并指名写了什么。
	 *
	 * `entryId` 是分支结束的条目，null 表示整份日志。新快照以 `parentSession` 指向源的条目流，被复制
	 * 的条目保留源写入的 id 和 parent 链接，这让 fork 能追溯回它来的地方。快照的当前值整体随行——
	 * title、model、level、tool config 和 suspended 标记，因为停在闸门处的 session 的 fork 也复制
	 * 悬空 call——因为那些现在是 session 自己的值，不是分支重放能恢复的条目。工作目录取源 header
	 * 自己的：fork 写在它的源住的地方，也不要求调用方重放文件去了解那里是哪。
	 *
	 * 源只被读取：fork 是新的一对文件，它来源的 session 从不被重写。fork 不填充任何东西也不注册
	 * 任何东西——文件就是它返回的全部，新 session 的第一个袋来自它的第一次 {@link open}，后者读取
	 * 刚写下的配对。两个文件都在返回前同步写完，快照最后写（`wx`，诞生的提交标记），所以这里递出去
	 * 的 id 在调用方拿到时已经可以打开。
	 */
	forkFrom(
		sourcePathInput: string,
		entryId: string | null,
		storeDirInput?: string,
	): { sessionId: string; sessionFileAbsPath: string } {
		const absSourcePath = resolvePath(sourcePathInput);
		const absSourceJsonl = absSourcePath.endsWith(".json") ? sessionJsonlPath(absSourcePath) : absSourcePath;
		const sourceMeta = readMetaFile(sessionMetaPath(absSourceJsonl));
		const sourceEntries = loadJsonlEntries(absSourceJsonl);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${absSourceJsonl}`);
		}

		const branch = entryId === null ? sourceEntries : buildSessionPath(buildEntryIndex(sourceEntries), entryId);
		if (entryId !== null && branch.length === 0) {
			throw new Error(`Session ${sourceMeta.id} has no entry ${entryId}`);
		}

		// header 是 workDir 的唯一权威：它为源的各工具指名了工作框架，fork 活在同一段对话里，所以
		// 保留同一个框架。
		const absTargetWorkDir = resolvePath(sourceMeta.workDir);
		// store 是扁平的，所以 fork 落在所有其他 session 旁边；它属于哪个项目随它复制的快照走，
		// 不随它所在的目录走。
		const absDir = storeDirInput ? normalizePath(storeDirInput) : sessionsDir();
		if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const absNewSessionFile = sessionPath(newSessionId, absDir);
		const meta: SessionMeta = {
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			workDir: absTargetWorkDir,
			parentSession: absSourceJsonl,
			...(sourceMeta.title === undefined ? {} : { title: sourceMeta.title }),
			...(sourceMeta.model === undefined ? {} : { model: sourceMeta.model }),
			...(sourceMeta.thinkingLevel === undefined ? {} : { thinkingLevel: sourceMeta.thinkingLevel }),
			...(sourceMeta.activeTools === undefined ? {} : { activeTools: sourceMeta.activeTools }),
			...(sourceMeta.approval === undefined ? {} : { approval: sourceMeta.approval }),
			...(sourceMeta.suspended === undefined ? {} : { suspended: sourceMeta.suspended }),
		};
		writeFileSync(absNewSessionFile, branch.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { flag: "wx" });
		writeFileSync(sessionMetaPath(absNewSessionFile), `${JSON.stringify(meta, null, "\t")}\n`, { flag: "wx" });

		return { sessionId: newSessionId, sessionFileAbsPath: absNewSessionFile };
	}

	/**
	 * 为 `workDir` 存储的每个 session，最近活动优先。
	 *
	 * store 持有所有项目的 session，所以目录是一个过滤器而不是一个位置：每个候选自己的快照说它属于
	 * 哪个目录，比较的就是那个值——不是它碰巧坐落的文件夹，后者已不再指名一个项目。
	 */
	static async list(workDirInput: string, storeDirInput?: string, signal?: AbortSignal): Promise<SessionInfo[]> {
		ensureStoreMigrated();
		const absDir = storeDirInput ? normalizePath(storeDirInput) : sessionsDir();
		const workDirAbsPath = resolvePath(workDirInput);
		const sessions = (await listSessionsFromDir(absDir, signal)).filter((session) =>
			sessionWorkDirMatches(session.workDirAbsPath, workDirAbsPath),
		);
		return sortSessionInfos(sessions);
	}

	/**
	 * 本机器为之存储过 session 的每个目录，各带自己的清单。
	 *
	 * 侧栏按目录分组，而 store 不再摆出这个分组——一个扁平目录装下所有项目的 session——所以分组在
	 * 这里从每个 session 自己的快照推导：session 启动时的 `workDir` 就是其分组的 key，同一项目的
	 * 两个 session 无须相邻存放也能落进同一组。
	 *
	 * 组按最近活动优先返回，header 没指名目录的 session 被丢弃，而不是显示成一个无头的组。
	 */
	static async listDirectories(signal?: AbortSignal): Promise<DirectorySessions[]> {
		ensureStoreMigrated();
		const sessions = (await listSessionsFromDir(sessionsDir(), signal)).filter(
			(session) => session.workDirAbsPath !== "",
		);

		const byWorkDir = new Map<string, SessionInfo[]>();
		for (const session of sessions) {
			const workDirAbsPath = resolvePath(session.workDirAbsPath);
			const group = byWorkDir.get(workDirAbsPath) ?? [];
			group.push(session);
			byWorkDir.set(workDirAbsPath, group);
		}

		const groups: DirectorySessions[] = [];
		for (const [workDirAbsPath, group] of byWorkDir) {
			const rows = sortSessionInfos(group).map(toSessionRow);
			if (rows.length === 0) continue;
			groups.push({ workDirAbsPath, sessions: rows });
		}

		return groups.sort((a, b) => newestAt(b) - newestAt(a));
	}

	/**
	 * 是否有任何存储的 session 把 `workDirAbsPath` 当作自己的——「这个项目有 session」。
	 *
	 * 创建路径在复活一个文件系统已丢失的工作目录之前先问这里：store 认识的项目被恢复为空目录，
	 * 打错的路径被拒绝。一次扫描，并且从快照回答而不是从任何文件夹名回答，因为 store 已经不再
	 * 保存后者。
	 */
	static hasSessionsFor(workDirAbsPath: string): boolean {
		ensureStoreMigrated();
		const absWorkDir = resolvePath(workDirAbsPath);
		try {
			return settleSessionFiles(sessionsDir()).some((pair) => sessionWorkDirMatches(pair.meta.workDir, absWorkDir));
		} catch {
			return false;
		}
	}

	/**
	 * 一个 session id 指名的那一行，来自持有它的任何目录，没有文件指名时为 `undefined`。
	 *
	 * 列表为所有 session 一次性回答同一个问题，在恰好只有一个 session 变化时是错误的代价——刚创建
	 * 的、刚 fork 的、或 store 手工捡回来的一个。所以这里定位那一个 session 并只解析它：一个 session
	 * 出现的代价是一次解析，而不是对整台机器的一次扫描。定位那一半是快照读取，不是 transcript 读取；
	 * 只有匹配到的 session 才解析 `.jsonl`。
	 */
	static async findSessionRowById(id: string, signal?: AbortSignal): Promise<SessionRow | undefined> {
		const absPath = SessionManager.findSessionFilePathById(id);
		if (absPath === undefined) return undefined;
		const meta = readMetaForDiscovery(absPath);
		if (meta === null) return undefined;
		const info = await buildSessionInfo(sessionMetaPath(absPath), absPath, meta, signal);
		if (info === null) return undefined;
		// fork 的 parent 在快照里按*路径*指名，所以一旦该路径解析成 id，单凭一个 session 就可知
		// ——这很重要，因为 fork 一次一行地到达 store，本可以链接它的列表不在场。
		if (info.parentId === undefined && info.absParentSessionPath !== undefined) {
			const parent = readMetaForDiscovery(info.absParentSessionPath);
			const parentId = parent?.id;
			if (parentId !== undefined && parentId !== info.id) info.parentId = parentId;
		}
		return toSessionRow(info);
	}

	/**
	 * 一个 session id 指名的条目流路径——一次 stat，不是一次搜索。
	 *
	 * store 是扁平的、id 就是地址（`<id>.jsonl`），所以这是一次存在性检查：流旁边的 `.json` 快照是
	 * 诞生的提交标记，它的存在才是「配对存在」的那一半。快照没了的名字回答 `undefined`，每个调用方
	 * 读作「没有这个 session」；流没了的快照是一次半途夭折的诞生，{@link fillSession} 被要求打开它
	 * 时会清除。
	 */
	static findSessionFilePathById(id: string): string | undefined {
		ensureStoreMigrated();
		const absJsonl = sessionPath(id);
		return existsSync(sessionMetaPath(absJsonl)) ? absJsonl : undefined;
	}

	/**
	 * 删除一个 id 指名的 session，来自持有它的任何目录。
	 *
	 * 一个 session，不是一个目录：一个目录的 session 共享一个 store，比一个 session 的两个文件更宽的
	 * 任何东西都是另一段对话的 transcript。对未知 id 抛异常而不是回答「早已不在」，把两种失败分开
	 * ——调用方决定第二次删除意味着什么，hub 把它变成客户端能展示的状态码。
	 *
	 * 纯文件 I/O：为这个 id 持有活袋的表是谁的就是谁的，决定 session 已消失的调用方自己忘掉那一半
	 * （`Agent.remove`）。
	 */
	async remove(id: string): Promise<void> {
		const absPath = SessionManager.findSessionFilePathById(id);
		if (absPath === undefined) throw new UnknownSessionError(id);
		await rm(absPath);
		await rm(sessionMetaPath(absPath));
	}

}

/** 一个组里最近的活动，供侧栏目录排序。 */
function newestAt(group: DirectorySessions): number {
	return group.sessions.reduce((newest, session) => Math.max(newest, session.modified), 0);
}

/**
 * 按目录分组行，并按侧栏绘制的方式排序。
 *
 * 组内最近活动优先，组按各自最新的行排序。导出是因为 server 的投影持有同样的行、必须以同样的方式
 * 排序——各自排序的 store 和读者会在一行移动的那一刻开始不一致。
 */
export function groupSessionsByDirectory(rows: readonly SessionRow[]): DirectorySessions[] {
	const groups = new Map<string, SessionRow[]>();
	for (const row of rows) {
		const group = groups.get(row.workDirAbsPath);
		if (group === undefined) groups.set(row.workDirAbsPath, [row]);
		else group.push(row);
	}
	return [...groups.entries()]
		.map(([workDirAbsPath, sessions]) => ({ workDirAbsPath, sessions }))
		.sort((a, b) => newestAt(b) - newestAt(a));
}

/** 最近活动优先，在副本上排，两个调用方不会互相重排对方的视图。 */
function byModified(rows: readonly SessionRow[]): SessionRow[] {
	return [...rows].sort((a, b) => b.modified - a.modified);
}

/**
 * 选择器眼中的一个 session：客户端打开它用的 id，以及给它贴标签的文本。
 *
 * `SessionInfo` 携带的比 wire 需要的多——路径、搜索 blob、消息数——所以收窄发生在一处，而不是
 * 每个列出 session 的 server 路由里。
 */
export function toSessionRef(info: SessionInfo): SessionRef {
	return {
		id: info.id,
		workDirAbsPath: info.workDirAbsPath,
		createdAt: info.created.getTime(),
		title: info.title,
		...(info.parentId === undefined ? {} : { parentId: info.parentId }),
	};
}

/**
 * 侧栏的一行，对应一个没有东西在跑的 session。
 *
 * `running` 在结构上就是 false：本进程是否在跑一个 session 从未被写下来。`pending` 是账本事实的
 * 缓存——快照的 `suspended` 标记，run 停在审批闸门处时置位——因为在 end-restart（ADR-0006 §5）下
 * 这个问题活得比 host 长，而扫描只读快照。标记不带计数，所以被标记的行报 1；确切数字在 session
 * 打开后从账本推导，持有 host 的调用方从进程内快照覆盖活值，而不是从盘上读。
 */
function toSessionRow(info: SessionInfo): SessionRow {
	return {
		...toSessionRef(info),
		modified: info.modified.getTime(),
		running: false,
		pending: info.suspended ? 1 : 0,
	};
}

/**
 * 会话的名字：第一条带文本的 user 消息，为选择器截短。
 *
 * 从 transcript 派生而不是存储，所以它跟随仍在被写入的 session，且首条消息变化时不需要迁移。
 */
export function deriveTitle(messages: readonly Message[]): string {
	for (const message of messages) {
		if (message.role !== "user") continue;
		// 压缩检查点按形状是 user turn，按说话者不是；context 从一个检查点开始的恢复 session，不能被
		// 它保留的摘要命名。
		if (compactionSummaryOf(message) !== undefined) continue;
		const text = shortenTitle(textOf((message as { content?: unknown }).content));
		if (text.length > 0) return text;
	}
	return "新会话";
}

/**
 * 截短标题的唯一规则：先折叠空白，再在 72 字符处切断。
 *
 * 共享而不是写两遍，因为调用方对*哪一*字符串被截短回答着不同的问题——活 session 走分支，扫描走
 * 文件，重命名端点截用户的输入——标题在这些世界之间跳来跳去的行，正是这个共享要阻止的闪烁。导出
 * 是因为存储重命名的端点是 controller 的，规则必须是 store 的，不是调用方的副本。
 */
export function shortenTitle(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > 72 ? `${collapsed.slice(0, 69)}...` : collapsed;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
				return String((block as { text?: unknown }).text ?? "");
			}
			return "";
		})
		.join(" ");
}
