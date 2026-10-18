/**
 * Work that happens at most once per animation frame — and never sooner than the minimum interval.
 *
 * A stream delivers many deltas between two display refreshes, and every one of them used to be
 * painted: the intermediate states are never seen, so all but the last are waste. The owner hands the
 * work over once, in its constructor, and asks for it on every delta; the first ask arms a frame and
 * every ask after it lands in the same one. The callback therefore runs against whatever the latest
 * state is, which is the only state the next paint could have shown anyway.
 *
 * `requestAnimationFrame` rather than a timer, because the point is to land with the refresh the
 * reader is about to see: a timeout fires off the paint and can still fit two draws inside one frame.
 *
 * The rAF coalescing alone is not the whole story: a 120 Hz display hands out frames twice as often
 * as a reader can tell apart, and the tail work is real work — parsing, patching, layout. So a draw
 * that would land inside the minimum interval after the previous one is pushed to the next frame
 * instead. The ask is not lost: the deferred frame still carries it, and it paints whatever the
 * latest state is by the time the interval is met.
 */
export class OncePerFrame {
	#frame: number | undefined;
	/** The frame stamp the last run went out on; `undefined` until the first one. */
	#last: number | undefined;
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
		this.#frame = requestAnimationFrame((time) => this.#arrive(time));
	}

	#arrive(time: number): void {
		if (this.#last !== undefined && time - this.#last < MIN_DRAW_INTERVAL_MS) {
			this.#frame = requestAnimationFrame((next) => this.#arrive(next));
			return;
		}
		this.#frame = undefined;
		this.#last = time;
		this.#run();
	}

	/**
	 * Give up the armed frame.
	 *
	 * For a caller that is about to do the same work itself: leaving the frame armed would paint the
	 * state twice, once now and once a refresh later. A frame the gate has deferred is armed all the
	 * same, so an immediate draw preempts it too.
	 */
	cancel(): void {
		if (this.#frame === undefined) return;
		cancelAnimationFrame(this.#frame);
		this.#frame = undefined;
	}
}

/** The shortest gap two draws may have, in milliseconds — one 60 Hz refresh. */
const MIN_DRAW_INTERVAL_MS = 16;
