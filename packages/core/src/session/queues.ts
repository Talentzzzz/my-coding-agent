import type { QueueMode } from "../types.ts";
import type { Message } from "@my-agent/llm";

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
