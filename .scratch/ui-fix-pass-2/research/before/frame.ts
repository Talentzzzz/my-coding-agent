/**
 * Work that happens at most once per animation frame.
 *
 * A stream delivers many deltas between two display refreshes, and every one of them used to be
 * painted: the intermediate states are never seen, so all but the last are waste. The owner hands the
 * work over once, in its constructor, and asks for it on every delta; the first ask arms a frame and
 * every ask after it lands in the same one. The callback therefore runs against whatever the latest
 * state is, which is the only state the next paint could have shown anyway.
 *
 * `requestAnimationFrame` rather than a timer, because the point is to land with the refresh the
 * reader is about to see: a timeout fires off the paint and can still fit two draws inside one frame.
 */
export class OncePerFrame {
	#frame: number | undefined;
	readonly #run: () => void;

	constructor(run: () => void) {
		this.#run = run;
	}

	/** Whether a frame is armed — the callback has been asked for and has not run yet. */
	get pending(): boolean {
		return this.#frame !== undefined;
	}

	/** Ask for the callback on the next frame; asking again before then is asking for the same frame. */
	schedule(): void {
		if (this.#frame !== undefined) return;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = undefined;
			this.#run();
		});
	}

	/**
	 * Give up the armed frame.
	 *
	 * For a caller that is about to do the same work itself: leaving the frame armed would paint the
	 * state twice, once now and once a refresh later.
	 */
	cancel(): void {
		if (this.#frame === undefined) return;
		cancelAnimationFrame(this.#frame);
		this.#frame = undefined;
	}
}
