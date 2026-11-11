/**
 * 在进程离开之前把服务器放下来。
 *
 * 它单独存在，而不是内联在 `main.cjs` 里，理由与 `muxUpgrade()` 和 `sessionListeners()` 住在 `boot.ts` 相同：重写这些代码行的 smoke 是在断言自己的拷贝，而这里的顺序就是它们的全部意义。本文件不触碰任何 Electron API——`app` 以参数到达——所以 smoke 可以用假件驱动真实序列。
 *
 * 用 CommonJS 是因为外壳就是：Electron 在任何工具链运行之前加载 `main.cjs`。
 */

/**
 * 外壳在丢下服务器自行离开之前等待多久。
 *
 * boot smoke（`scripts/smoke-boot.ts`）断言 `close()` 在最坏情况在场时——一个窗口的常驻连接正看着停在无人会回答的审批上的运行——于该预算内返回，所以超时后还在关闭的服务器不是慢，是卡死。一个关不掉的应用比一个跳过最后一次写入的应用更糟，这就是外壳停止等待的唯一理由。
 */
const SHUTDOWN_BUDGET_MS = 5_000;

/**
 * 在退出时刻接管服务器的生命周期。
 *
 * @param {object} options
 * @param {{ quit(): void, exit(code: number): void }} options.app Electron 应用对象：
 *   只对它做这两个调用，这正是本文件能在 Electron 之外被驱动的原因。
 * @param {number} [options.shutdownBudgetMs] 覆盖 {@link SHUTDOWN_BUDGET_MS}，让 smoke 用毫秒驱动
 *   放弃路径，而不是等完真实预算。
 * @param {(line: string) => void} [options.log] 两行失败日志的去处。默认 console；smoke 改为收集。
 */
function createShutdown(options) {
	const { app } = options;
	const budgetMs = options.shutdownBudgetMs ?? SHUTDOWN_BUDGET_MS;
	const log = options.log ?? ((line) => console.error(line));

	/** 本外壳正在服务的服务器，它开始下行后为 `null`。 */
	let server = null;
	/** 关闭是否正在进行。 */
	let shuttingDown = false;
	/**
	 * 此刻停在 handler 里的 quit 是否是本模块自己请求的那一个。
	 *
	 * 关闭开始之后，只有它被放行——见 {@link beforeQuit}。
	 */
	let ownQuit = false;

	/** 挂上外壳刚启动好的服务器。 */
	function serve(booted) {
		server = booted;
	}

	/**
	 * 外壳的 `before-quit` handler：拦住第一次 quit，放下服务器，再请求一次。
	 *
	 * Electron 的 quit 不等 promise，所以这里的顺序不是走过场。没有 `preventDefault`，进程会在 `close()` 中途被拆掉，而在常驻连接之下这是常态而不是罕见情形：窗口开着多久就 hold 多久的 socket，永远有要释放的东西、永远有要落定的主张。
	 *
	 * 外壳等的是 `close()` 返回，而不是应答。mux 层自己的顺序是连接先行——窗口的订阅在它们正在观看的会话还在时释放——然后会话，然后监听器；升级的 socket 随监听器而去，因为 `server.close()` 的账目和 `closeAllConnections()` 都不覆盖一个在切换协议后就不再是响应的 socket。所以这里等的是一个会返回的 promise，而不是一个永不结束的应答。
	 */
	function beforeQuit(event) {
		if (shuttingDown) {
			// 关闭已在进行，此刻到达的每个 quit 都是别人的：操作系统再问一遍，或用户在服务器放下之前坚持退出。拦住它的理由与拦住第一个相同——放行正是把进程在 `close()` 中途拆掉的原因——而"坚持"已经有了答案：下面的预算框住了等待能有多长。必须放行的唯一 quit 是本模块自己的，也只有它被这样标记。
			if (!ownQuit) event.preventDefault();
			return;
		}
		if (server === null) return;
		event.preventDefault();
		shuttingDown = true;

		const closing = server;
		// 在 await 之前放下，不只是为了上面那个守卫：macOS 会在 `activate` 时对着 `server.url` 重开窗口，正在下行的服务器不得成为新窗口指向的东西。
		server = null;

		/** 外壳是否已放弃等待，这也意味着"再没有东西可要了"。 */
		let gaveUp = false;
		const budget = setTimeout(() => {
			gaveUp = true;
			log(`desktop: the server did not finish closing within ${budgetMs} ms; leaving anyway`);
			// 用 `exit` 而不是 `quit`：卡住的正是 quit 序列本身，再请求一遍只会等在同一件事上。这一个不会咨询 `before-quit`。
			app.exit(0);
		}, budgetMs);

		void closing
			.close()
			.catch((error) => {
				log(`desktop: the server failed to close — ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				clearTimeout(budget);
				// 服务器在一个已经离场的外壳的退路上关闭完成：预算已把进程送走，此刻请求 quit 只是在和尸体说话。
				if (gaveUp) return;
				ownQuit = true;
				// 算数的那次 quit：`beforeQuit` 放行这一个，Electron 于是照常关闭窗口并终止。
				app.quit();
			});
	}

	return {
		serve,
		beforeQuit,
		/** 仍在被服务的服务器，关闭开始后为 `null`。 */
		get current() {
			return server;
		},
	};
}

module.exports = { createShutdown, SHUTDOWN_BUDGET_MS };
