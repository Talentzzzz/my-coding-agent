import type { Message, ToolResult } from "./llm/index.ts";
import { truncate } from "./tool/truncate.ts";
import { spillPathFor, spillText, spillView, writeSpillFile, SPILL_KEEP_CHARS } from "./context/spill.ts";

/** 工具结果如何携带内容：按顺序排列的文本与图片块。 */
export type ToolResultContent = ToolResult<unknown>["content"];

/** 处理器的答案，或它的 promise：审批闸门在用户作答之前无法作答。 */
type MaybePromise<T> = T | Promise<T>;

/**
 * 每次运行都经过的接缝。
 *
 * 处理器只返回它决定的部分，没有处理器的 hook 什么也不改变。{@link Hooks.apply} 按注册顺序运行
 * 处理器，后注册的在前者的答案上精修，而不是整体推翻决定。每有一个消费者就往这张映射里加一条；
 * 在有东西调用 hook 之前，加一条是空操作。
 *
 * 每个事件都点出其运行所属的会话。这个面本身是进程级配置（ADR-0006 §6）：一个 `Hooks` 服务本进程
 * 跑的所有会话，所以需要靠闭包才知道自己会话的处理器，就成了这条接缝本来要消灭的 per-session
 * 对象。处理器拿这个 id 现取其余一切——工作目录、会话记录、审批映射。
 */
export interface HookMap {
	/** 改写给供应商的内容。默认：全新的 system 消息 + 账本的消息。 */
	context: (event: { sessionId: string; messages: Message[]; systemPrompt: string }) => MaybePromise<
		{ messages?: Message[]; systemPrompt?: string } | undefined
	>;
	/** 在工具调用之前运行。默认：审批闸门。 */
	before_tool: (event: { sessionId: string; toolCallId: string; toolName: string; args: unknown }) => MaybePromise<
		{ block?: { reason: string }; args?: unknown; terminate?: boolean; suspend?: boolean } | undefined
	>;
	/**
	 * 在结果上运行。默认：无——改写即定稿，`agent.ts` 里的写边界是没人约束过的结果的兜底。
	 */
	after_tool: (event: {
		sessionId: string;
		toolCallId: string;
		toolName: string;
		content: ToolResultContent;
		isError: boolean;
	}) => MaybePromise<{ content?: ToolResultContent } | undefined>;
}

export type HookName = keyof HookMap;

/** hook 收到的东西：它的事件，已带上先前处理器设置的字段。 */
export type HookEvent<TName extends HookName> = Parameters<HookMap[TName]>[0];

/** hook 的答案：其处理器设置的字段，无人设置时为 undefined。 */
export type HookResult<TName extends HookName> = Awaited<ReturnType<HookMap[TName]>>;

export interface Hooks {
	/** 注册一个处理器。它排在已注册的处理器之后；返回的函数用于移除它。 */
	on<TName extends HookName>(name: TName, handler: HookMap[TName]): () => void;
	/** 按顺序运行一个 hook 的处理器，以它们共同决定的结果作答。 */
	apply<TName extends HookName>(name: TName, event: HookEvent<TName>): Promise<HookResult<TName>>;
}

/** 已注册的处理器，擦除成所有 hook 共享的唯一形状。 */
type AnyHandler = (event: never) => MaybePromise<unknown>;

/**
 * 构建进程分发所经的 hook 面。
 *
 * 注册顺序是唯一的顺序：先安装的默认处理器先运行，后注册的宿主看到它们的答案并可在其上精修。
 * 状态按每次调用持有、别无他处，所以运行中途注册的处理器自然会被下一次调用看到。
 */
export function createHooks(): Hooks {
	// 按名字为键而不是每个 hook 一个字段：按名字查找无法把名字自带的类型穿过 `Map`，所以知道名字的
	// 两个边缘——`on` 和 `apply`——做类型断言，中间的任何东西都不用。
	const handlers = new Map<HookName, AnyHandler[]>();

	const registry: Hooks = {
		on<TName extends HookName>(name: TName, handler: HookMap[TName]): () => void {
			const entry = handler as AnyHandler;
			const registered = handlers.get(name) ?? [];
			registered.push(entry);
			handlers.set(name, registered);
			// 用 splice 而不是重建：留下的处理器保持它们加入时的顺序。
			return () => {
				const index = registered.indexOf(entry);
				if (index !== -1) registered.splice(index, 1);
			};
		},
		async apply<TName extends HookName>(name: TName, event: HookEvent<TName>): Promise<HookResult<TName>> {
			let current: Record<string, unknown> = { ...event };
			let decided: Record<string, unknown> | undefined;
			for (const handler of handlers.get(name) ?? []) {
				const answer = await handler(current as never);
				if (answer === undefined) continue;
				const fields = defined(answer as Record<string, unknown>);
				// 后来的处理器逐字段胜出，并能看到先前处理器设置的字段——这正是让一个 hook 能精修另一个的
				// 答案而不是单纯取代它的原因。
				decided = { ...decided, ...fields };
				current = { ...current, ...fields };
			}
			return decided as HookResult<TName>;
		},
	};

	return registry;
}

/** 处理器真正设置的字段：省略一个字段不是抹掉先前设置的指令。 */
function defined(patch: Record<string, unknown>): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(patch)) if (value !== undefined) fields[field] = value;
	return fields;
}

/**
 * 单个工具结果的会话级上限，以 UTF-8 字节计。
 *
 * 工具约束自己的输出（`tools/truncate.ts`，60,000 字符），所以守规矩的工具永远到不了这里。它是
 * spill（`context/spill.ts`）之下的底线——spill 会把超过 80,000 字符的结果归档进会话的工作目录而
 * 不是截断：当那份归档写不出来时，靠这个上限仍能保住上下文不被一个结果撑爆。有意远高于单工具
 * 预算，所以工具已经约束过的结果不会被二次截断。
 */
export const MAX_TOOL_RESULT_BYTES = 200_000;

/** 为 `truncate` 写出的提示留出的空间，让截断落在预算之内而不是刚好超出。 */
const NOTICE_RESERVE_BYTES = 64;

/**
 * 把一个工具结果约束到 {@link MAX_TOOL_RESULT_BYTES} 之内，已经放得下时返回 `undefined`。
 *
 * 文本用与工具相同的 `truncate` 截断，所以被告知输出被剪的模型无论在哪里被剪，读到的都是同一句话。
 * 图片块原样通过：这份预算只关于文本，图片里没有可剪的东西。
 */
export function boundToolContent(content: ToolResultContent): ToolResultContent | undefined {
	if (contentBytes(content) <= MAX_TOOL_RESULT_BYTES) return undefined;

	let remaining = MAX_TOOL_RESULT_BYTES;
	return content.map((block) => {
		if (block.type !== "text") return block;
		const budget = Math.max(0, remaining - NOTICE_RESERVE_BYTES);
		const { text } = truncate(block.text, charsForBytes(block.text, budget));
		remaining = Math.max(0, remaining - Buffer.byteLength(text));
		return { ...block, text };
	});
}

function contentBytes(content: ToolResultContent): number {
	let bytes = 0;
	for (const block of content) if (block.type === "text") bytes += Buffer.byteLength(block.text);
	return bytes;
}

/** 按 `text` 自身的密度，UTF-8 形式能放进 `maxBytes` 的最长切片。 */
function charsForBytes(text: string, maxBytes: number): number {
	const bytes = Buffer.byteLength(text);
	if (bytes <= maxBytes) return text.length;
	return Math.floor((text.length * maxBytes) / bytes);
}

/**
 * 把一个工具结果整体归档，并以 `after_tool` 处理器返回的内容作答。
 *
 * 这条接缝现在承载的写侧规则是：**改写即定稿**——账本保存的正是处理器返回的内容，所以要约束一个
 * 结果，全文必须先去别处。这里就是那个别处，一次调用完成：它把结果的文本整体写在工作目录之下
 * （`.my-agent/tool-results/`，与写边界自身兜底相同的路径推导），并以点名该文件的头尾视图作答，
 * 需要其余部分的模型自己去读回来。文件写不下的结果原样返回，而不是「截断+一个不存在的路径」
 * ——写边界仍会约束它。
 *
 * `workDirAbsPath` 由处理器自己提供：hook 事件只点名会话，归档到哪个目录是处理器闭包里的事。
 *
 * ```ts
 * hooks.on("after_tool", (event) => archiveToolResult(event, workDirAbsPath));
 * ```
 */
export function archiveToolResult(
	event: { sessionId: string; toolCallId: string; toolName: string; content: ToolResultContent },
	workDirAbsPath: string,
): { content: ToolResultContent } {
	const text = spillText(event.content);
	const { absPath, relPath } = spillPathFor(workDirAbsPath, event.sessionId, event.toolName, event.toolCallId);
	if (!writeSpillFile(absPath, text)) return { content: event.content };
	return { content: spillView(event.content, text, relPath, SPILL_KEEP_CHARS) };
}
