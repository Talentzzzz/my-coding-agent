/**
 * 每个动画帧最多执行一次的工作 —— 且间隔不会小于最小间隔。
 *
 * 两次刷新之间流会送来许多 delta，过去每一个都会被绘制：中间状态根本没人看到，除最后一个外全是
 * 浪费。拥有者在构造函数里把工作移交一次，之后每个 delta 都来请求；第一次请求会装填一个 frame，
 * 后续所有请求都落进同一个。回调因此针对最新状态运行 —— 而下一次绘制本来也只能显示最新状态。
 *
 * 用 `requestAnimationFrame` 而不是定时器，因为目的就是与读者即将看到的刷新同步：timeout 会在
 * 绘制之外触发，一个 frame 里仍可能塞进两次绘制。
 *
 * 仅靠 rAF 合并还不够：120 Hz 显示器分发 frame 的频率是读者能分辨的两倍，而尾部工作（解析、
 * 打补丁、布局）是真实的开销。所以落在上一次绘制之后最小间隔内的绘制会被推迟到下一个 frame。
 * 请求不会丢失：被推迟的 frame 仍然携带它，并在间隔满足时绘制当时的最新状态。
 */
export class OncePerFrame {
	#frame: number | undefined;
	/** 上一次运行所在的 frame 时间戳；首次运行前为 `undefined`。 */
	#last: number | undefined;
	readonly #run: () => void;

	constructor(run: () => void) {
		this.#run = run;
	}

	/** 是否已装填 frame —— 回调已被请求且尚未运行。 */
	get pending(): boolean {
		return this.#frame !== undefined;
	}

	/** 请求在下一个 frame 运行回调；在此之前再次请求仍是同一个 frame。 */
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
	 * 放弃已装填的 frame。
	 *
	 * 供即将亲自完成同样工作的调用者使用：留着 frame 会把状态绘制两次，一次现在、一次刷新之后。
	 * 被门限推迟的 frame 同样处于装填状态，所以立即绘制也会抢占它。
	 */
	cancel(): void {
		if (this.#frame === undefined) return;
		cancelAnimationFrame(this.#frame);
		this.#frame = undefined;
	}
}

/** 两次绘制之间允许的最短间隔，毫秒 —— 即一次 60 Hz 刷新。 */
const MIN_DRAW_INTERVAL_MS = 16;
