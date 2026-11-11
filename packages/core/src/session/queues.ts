import type { QueueMode } from "../types.ts";
import type { QueuedPrompt } from "../protocol.ts";
import type { Message } from "../llm/index.ts";

/**
 * 带有取走宽度的待处理消息队列。
 *
 * 队列属于接收消息的 session；引擎在自己的取走点直接读它，因为两者在同一个进程里，中间不需要缝。
 */
export class PendingMessageQueue {
	private messages: Message[] = [];
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	/** 有多少消息在等。composer 展示的深度就是 follow-up 队列的。 */
	get size(): number {
		return this.messages.length;
	}

	/**
	 * 等待中的消息按 wire 携带的形式：text 和时间戳，没有别的。
	 *
	 * 这是队列变更发布的读取面——`queue_update`、`status` 帧和快照都带它——这样窗口看到的是队列
	 * 本身，而不是它的一个计数。
	 */
	previews(): QueuedPrompt[] {
		return this.messages.map((message) => ({ text: promptText(message), timestamp: message.timestamp }));
	}

	enqueue(message: Message): void {
		this.messages.push(message);
	}

	/** 取走当前取走宽度选中的消息，其余留下。 */
	drain(): Message[] {
		const drained =
			this.mode === "all" ? this.messages.slice() : this.messages.slice(0, 1);
		this.messages = this.messages.slice(drained.length);
		return drained;
	}

	clear(): void {
		this.messages = [];
	}
}

/** 排队 prompt 的文本，由 content blocks 拼接而来。 */
function promptText(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
			text += String((block as { text?: unknown }).text ?? "");
		}
	}
	return text;
}
