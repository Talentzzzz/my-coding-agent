import type { QueueMode } from "@my-agent/loop";
import type { Message } from "@my-agent/llm";

/**
 * A pending-message queue with a drain width.
 *
 * Moved out of the vendored loop: the queue belongs to the session that accepts
 * messages, and the loop only pulls at its take points through the
 * `getSteeringMessages` / `getFollowUpMessages` config hooks.
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
