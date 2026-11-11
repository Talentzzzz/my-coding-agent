// 单个 session 发布的事件，以及单个 delta 的形状。
//
// fanout 独立成模块（`fanout.ts`）时它们搬到了这里：引擎和命令面都会发布，谁都不独占这个 union。
// `agent.ts` re-export 对外的四个，所以没有任何调用方的 import 需要变——而引擎住在 `loop-manager.ts`
// （ADR-0022），sink 的实现仍回到编排层，文件边界依然成立。
import type { AgentEvent } from "../types.ts";
import type { Message } from "../llm/index.ts";
import type { QueuedPrompt, SessionSnapshot } from "../protocol.ts";
import type { SessionEntry } from "./session-manager.ts";

/** 读者能看见的任何东西发生变动时，带着 session 状态被调用。 */
export type SessionListener = (snapshot: SessionSnapshot) => void;

/**
 * session 发布的一条 `message_update`：刚到达的字符，而不是整条消息。
 *
 * 引擎自己的事件同时带着完整的 partial 消息和 provider 的 delta，session 曾经两个都转发——于是
 * 长答案末尾的一个 token 要付一帧整个答案大小的代价，在这里序列化一遍、在窗口里解析一遍，窗口还要
 * 重读全文才能找出变化。两帧之间真正移动的只是一个 delta，所以发的就是 delta。完整消息仍在
 * `message_start` 和 `message_end` 上传递，run 中途接上的窗口还会在 baseline 的 `partial` 里再
 * 拿到一次。
 *
 * 消息用 `timestamp` 而不是条目 id 标识：消息结束之前条目还不存在，而时间戳本来就是 transcript
 * 给条目建 key 的字段。
 */
export interface MessageDelta {
	timestamp: number;
	/** 两段在跑的文本里动的是哪一段；tool call 有自己的事件，不算 delta。 */
	kind: "text" | "thinking";
	/** block 在消息里的位置，第二个 block 才能像完整消息那样接上。 */
	contentIndex: number;
	/** 到达的字符。 */
	text: string;
}

/**
 * 一个 session 发布的全部事件：引擎的事件原样到达，加上引擎没有词表达的事实——队列深度、一次压缩、
 * 一条条目落进 store、一次设置变更。
 *
 * union 是扁平的而不是嵌套的，这样消费方只需要一个对事件类型的 `switch`。之所以安全，是因为没有
 * 任何 `AgentEvent` 的类型名和这里新增的名字冲突：所以新的 session 事件绝不能复用引擎的名字。
 * `message_update` 是唯一一个刻意*替换*而非并列新增的成员：session 把引擎的完整消息形状留给自己
 * （run 中途的 baseline 需要它），只转发 delta。
 */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "message_update" }>
	| { type: "message_update"; delta: MessageDelta }
	| { type: "queue_update"; queued: QueuedPrompt[] }
	| {
			type: "compaction";
			/** 现在代表 `firstKeptEntryId` 之前全部内容的摘要。 */
			summary: string;
			firstKeptEntryId: string;
			/** 折进摘要里的消息数。 */
			summarized: number;
			/** 压缩执行前的预估 prompt 大小。 */
			tokensBefore: number;
			/** 下一个请求将携带的预估 prompt 大小。 */
			contextTokens: number;
	  }
	/**
	 * 一次尝试了压缩但没能产出摘要的压缩；transcript 未变。
	 */
	| { type: "compaction_failed"; message: string }
	| {
			type: "tool_results_cleared";
			/**
			 * tool result 被清出了 transcript，并记录为一条 `clear_tool_result` 条目。
			 *
			 * 单独报告是因为它别处不可见：条目指名的消息在文件里原位不动，只对比消息的读者会看到
			 * 通知凭空出现、没有任何解释。
			 */
			/** 被清空的 tool result 数。 */
			cleared: number;
			/** 清空前的预估 prompt 大小。 */
			tokensBefore: number;
			/** 下一个请求将携带的预估 prompt 大小。 */
			contextTokens: number;
	  }
	| {
			type: "tool_call_args_trimmed";
			/**
			 * 记录在案的 tool call 参数被缩短了，并记录为一条 `trim_tool_call_arg` 条目。
			 *
			 * 报告的理由和 `tool_results_cleared` 相同：文件里保留完整参数，视图里截掉了正文，只
			 * 对比消息的读者会看到被截断而没有任何解释。
			 */
			/** 被缩短了记录参数的条目数。 */
			trimmed: number;
			/** 截短前的预估 prompt 大小。 */
			tokensBefore: number;
			/** 下一个请求将携带的预估 prompt 大小。 */
			contextTokens: number;
	  }
	| {
			type: "entry_appended";
			entryId: string;
			kind: SessionEntry["type"];
			/**
			 * 消息写入的时间，按 transcript 排序的次序：消息自己的时间戳，回退用条目的时间戳。
			 *
			 * 放在事件上而不是让读者回头读，是因为它的读者——按活跃度排序的侧栏行、把条目和
			 * 时间配对的 frame——每追加一条消息都要跑一次，向 transcript 问一次时间戳就要重放
			 * 一次（ADR-0019）。不带消息的条目没有这个字段。
			 */
			at?: number;
			/** 消息的 role，供只对某一种 role 重新推导什么的读者用。 */
			role?: Message["role"];
			/**
			 * 这次追加之后生效的标题，且仅当追加的是 user 消息时才有：派生标题只从 user 消息读，
			 * 所以也只有它可能重命名会话。
			 */
			title?: string;
	  }
	| {
			type: "branch_changed";
			/**
			 * 分支结构变了：叶子移动了，或者消息追加到了已有后继的消息后面——从另一侧看是同一件事。
			 *
			 * 用事件发出而不是只在发起请求的那次应答里回答，是因为这不只是请求方一个客户端的事。
			 * 这个 session 上的每个窗口都持有来自快照的分支点，可能正在展示一条已不再是活跃分支的
			 * 链，所以每个流收到这个事件都会重读快照，而不是相信自己先前画的。
			 */
			leafId: string;
	  }
	| {
			type: "config_changed";
			model?: string;
			thinkingLevel?: string;
			approvals?: Record<string, boolean>;
			/** `setActiveTools` 移动了激活工具时的工具名列表。 */
			tools?: string[];
	  }
	/**
	 * 一次被归类为可重试的 provider 瞬时失败，处于退避睡眠之前。
	 */
	| { type: "retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	/**
	 * 退避结束，重试的 provider 调用开始。
	 */
	| { type: "retry_start"; attempt: number; maxAttempts: number }
	/**
	 * 重试循环结束，无论以哪种方式结束。每次排定的重试发一次。
	 */
	| { type: "retry_end"; success: boolean; attempt: number; finalError?: string };

/** session 发布的每个事件都按发生顺序交给它。 */
export type SessionEventListener = (event: AgentSessionEvent) => void;

/**
 * 引擎一条 `message_update` 值得的 delta，对不带字符的帧返回 `undefined`。
 *
 * start/end 帧和 tool call 的 delta 都被丢弃：block 边界不需要自己的帧——一个 block 的第一个
 * delta 就是它在窗口里打开的时刻——而 tool call 的卡片由 tool 事件构建，那些事件带的是参数和
 * result，不是正在拼装的 JSON。空 delta 同理被丢：它没有任何帧能携带的内容。
 */
export function messageDeltaOf(event: Extract<AgentEvent, { type: "message_update" }>): MessageDelta | undefined {
	const inner = event.assistantMessageEvent;
	if (inner.type !== "text_delta" && inner.type !== "thinking_delta") return undefined;
	if (inner.delta.length === 0) return undefined;
	const stamp = (event.message as { timestamp?: unknown }).timestamp;
	if (typeof stamp !== "number") return undefined;
	return {
		timestamp: stamp,
		kind: inner.type === "text_delta" ? "text" : "thinking",
		contentIndex: inner.contentIndex,
		text: inner.delta,
	};
}
