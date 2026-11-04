import type { QueueMode } from "../types.ts";
import type { QueuedPrompt } from "../protocol.ts";
import type { Message } from "../llm/index.ts";

/**
 * A pending-message queue with a drain width.
 *
 * The queue belongs to the session that accepts the messages; the engine reads it at its own
 * take points, directly, because both live in this process and no seam is needed between them.
 */
export class PendingMessageQueue {
	private messages: Message[] = [];
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	/** How many messages are waiting. The depth a composer shows is the follow-up queue's. */
	get size(): number {
		return this.messages.length;
	}

	/**
	 * The waiting messages as the wire carries them: text and stamp, nothing else.
	 *
	 * This is the read surface a queue change publishes — `queue_update`, the `status` frame, and
	 * the snapshot all carry it — so a window sees the queue itself rather than a count of it.
	 */
	previews(): QueuedPrompt[] {
		return this.messages.map((message) => ({ text: promptText(message), timestamp: message.timestamp }));
	}

	enqueue(message: Message): void {
		this.messages.push(message);
	}

	/** Take the messages the current drain width selects, and leave the rest. */
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

/** The text of a queued prompt, joined from its content blocks. */
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
