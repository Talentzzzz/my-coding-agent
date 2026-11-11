/**
 * 有上界的 frame 队列：工作分摊到多个动画帧上，而不是一次性付清。
 *
 * 切换会话会把整段对话一次性交给 transcript，重建的成本正比于整份记录而不是增量：每条消息都是
 * 新的，每条都要解析和绘制。在快照落地的那个 frame 里做这件事，会让窗口冻结与对话长度相等的时间
 * —— 也就是"点了却没反应"—— 所以绘制工作被移交到这里：它先做一部分，把 frame 还回去，下一帧
 * 继续。
 *
 * 接缝是 `produce` 这个生成器：一批就是生产者的一轮，预算是唯一决定一个 frame 拿到多少轮的东西。
 * 无论预算是多少，每帧至少一轮是下限：一帧什么都没产出的队列永远做不完。
 */
export class Drain {
	#current: Iterator<undefined> | undefined;
	#frame: number | undefined;

	readonly #budget: number;

	/**
	 * @param budget 每批可花费的毫秒数。
	 */
	constructor(budget: number) {
		this.#budget = budget;
	}

	/** 是否还有未完成的绘制。 */
	get pending(): boolean {
		return this.#current !== undefined;
	}

	/**
	 * 交出所有待绘制的工作，并开始执行。
	 *
	 * 已在执行的生产者会被丢弃而不是做完：调用者手里有了更新的答案，先把旧对话画上屏幕只会展示
	 * 一份已被取代的记录。
	 */
	start(produce: () => Generator<undefined>): void {
		this.#stop();
		this.#current = produce();
		this.#schedule();
	}

	/**
	 * 放弃未完成的工作。
	 *
	 * 由即将亲自绘制同样内容的调用者调用 —— 流式 frame 等不了队列追赶 —— 所以队列之后绝不能再
	 * 回来绘制一份调用者已经替换掉的记录。
	 */
	cancel(): void {
		this.#stop();
	}

	/** 取消 frame 并忘记生产者，让调用者自己的绘制保留下来。 */
	#stop(): void {
		this.#current = undefined;
		if (this.#frame === undefined) return;
		cancelAnimationFrame(this.#frame);
		this.#frame = undefined;
	}

	/**
	 * 运行一批，并回答是否还有剩余。
	 *
	 * 设为 public 是因为 frame 不是：上面的调度是浏览器做的事，而没有动画帧可等的调用者 —— 测试
	 * 桩（harness）、另一个回调里的重绘 —— 通过反复调用它直到返回 false 来驱动同一个队列。
	 *
	 * 预算只在非首批的那一轮之前检查，所以一批总会前进：一批什么都没跑就是一个毫无进展的 frame，
	 * 而永不前进的生产者就是一个挂死的窗口。因此一轮很长的时间会自行超出预算 —— 它是预算所对的
	 * 地板，也是单条消息能被完整绘制的原因。
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
