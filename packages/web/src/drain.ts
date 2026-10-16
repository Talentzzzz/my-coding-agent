/**
 * A bounded-frame queue: work is spread over animation frames instead of paid in one block.
 *
 * Switching sessions hands the transcript a whole conversation at once, and rebuilding it is
 * proportional to the transcript rather than to the delta: every message is new, so every message
 * is parsed and drawn. Doing that in the frame the snapshot lands in freezes the window for as long
 * as the conversation is big — which is what "clicked and nothing happened" is — so the draw is
 * handed here instead: it runs some of the work, gives the frame back, and continues on the next.
 *
 * The seam is `produce`, a generator, so a batch is one turn of the producer and the budget is the
 * only thing deciding how many turns a frame gets. One turn per frame is the floor whatever the
 * budget says: a frame that yielded nothing would never finish.
 */
export class Drain {
	#current: Iterator<undefined> | undefined;
	#frame: number | undefined;

	readonly #budget: number;

	/**
	 * @param budget Milliseconds each batch may spend.
	 */
	constructor(budget: number) {
		this.#budget = budget;
	}

	/** Whether a draw is still outstanding. */
	get pending(): boolean {
		return this.#current !== undefined;
	}

	/**
	 * Hand over everything left to draw, and start.
	 *
	 * A producer already in flight is dropped rather than finished: the caller has a newer answer,
	 * and drawing the old one first would put a superseded conversation on screen.
	 */
	start(produce: () => Generator<undefined>): void {
		this.#stop();
		this.#current = produce();
		this.#schedule();
	}

	/**
	 * Give up the outstanding work.
	 *
	 * Called by whoever is about to draw the same items itself — a streaming frame cannot wait for a
	 * queue to catch up — so the queue must not come back later and draw a transcript the caller has
	 * already replaced.
	 */
	cancel(): void {
		this.#stop();
	}

	/** Cancel the frame and forget the producer, leaving the caller's own draw to stand. */
	#stop(): void {
		this.#current = undefined;
		if (this.#frame === undefined) return;
		cancelAnimationFrame(this.#frame);
		this.#frame = undefined;
	}

	/**
	 * Run one batch, and say whether anything is still outstanding.
	 *
	 * Public because the frame is not: the scheduling above is what a browser does with this, and a
	 * caller with no animation frame to wait for — a harness, a redraw inside another callback —
	 * drives the same queue by calling this until it answers false.
	 *
	 * The budget is only consulted before a turn that is not the batch's first, so a batch always
	 * advances: a batch that ran nothing would be a frame of no progress, and a producer that never
	 * advances is a hung window. One long turn therefore overruns the budget on its own — it is the
	 * floor the budget is spent against, and the reason a single message is drawn whole.
	 */
	step(): boolean {
		const current = this.#current;
		if (current === undefined) return false;
		const started = performance.now();
		for (;;) {
			const turn = current.next();
			if (turn.done === true) {
				this.#current = undefined;
				return false;
			}
			if (performance.now() - started >= this.#budget) return true;
		}
	}

	#schedule(): void {
		this.#frame = requestAnimationFrame(() => {
			this.#frame = undefined;
			if (!this.pending) return;
			if (this.step()) this.#schedule();
		});
	}
}
