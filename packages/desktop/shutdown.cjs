/**
 * Putting the server down before the process goes.
 *
 * It lives on its own, rather than inline in `main.cjs`, for the same reason `muxUpgrade()` and
 * `sessionListeners()` live in `boot.ts`: a smoke that rewrote these lines would be asserting its
 * own copy, and the ordering is the whole point of them. This file touches no Electron API — `app`
 * arrives as an argument — so a smoke can drive the real sequence with a fake.
 *
 * It is CommonJS because the shell is: Electron loads `main.cjs` before any toolchain runs.
 */

/**
 * How long the shell waits for the server to go down before leaving without it.
 *
 * The boot smoke (`scripts/smoke-boot.ts`) asserts that `close()` returns inside this budget with
 * the worst case in residence — a window's resident connection watching a run parked on an approval
 * nobody will ever answer — so a server still closing after it is not slow, it is stuck. An
 * application that cannot be closed is a worse outcome than one that skips its last write, and that
 * is the only reason the shell stops waiting.
 */
const SHUTDOWN_BUDGET_MS = 5_000;

/**
 * Own the server's lifetime at quit time.
 *
 * @param {object} options
 * @param {{ quit(): void, exit(code: number): void }} options.app The Electron application object:
 *   only these two calls are made on it, which is what keeps this file drivable outside Electron.
 * @param {number} [options.shutdownBudgetMs] Override for {@link SHUTDOWN_BUDGET_MS}, so a smoke can
 *   drive the give-up path in milliseconds instead of waiting it out.
 * @param {(line: string) => void} [options.log] Where the two failure lines go. Defaults to the
 *   console; a smoke collects them instead.
 */
function createShutdown(options) {
	const { app } = options;
	const budgetMs = options.shutdownBudgetMs ?? SHUTDOWN_BUDGET_MS;
	const log = options.log ?? ((line) => console.error(line));

	/** The server this shell is serving, or `null` once it is on its way down. */
	let server = null;
	/** Whether a shutdown is under way. */
	let shuttingDown = false;
	/**
	 * Whether the quit standing in the handler right now is the one this module asked for.
	 *
	 * It is the only quit that may pass once a shutdown has begun — see {@link beforeQuit}.
	 */
	let ownQuit = false;

	/** Attach the server the shell just booted. */
	function serve(booted) {
		server = booted;
	}

	/**
	 * The shell's `before-quit` handler: hold the first quit back, put the server down, ask again.
	 *
	 * Electron's quit does not wait for a promise, so the order here is not a formality. Without the
	 * `preventDefault` the process is torn down in the middle of `close()`, and under a resident
	 * connection that is the ordinary case rather than a rare one: the window holds a socket for as
	 * long as it is open, so there is always something to release and always a claim to settle.
	 *
	 * What the shell waits for is `close()`, never a response. The mux layer's own order is
	 * connections first — a window's subscriptions are released while the sessions they were watching
	 * are still there — then the sessions, then the listener; and the upgraded sockets go with the
	 * listener, because neither `server.close()`'s accounting nor `closeAllConnections()` covers a
	 * socket that stopped being a response when it switched protocols. So this waits on a promise
	 * that returns rather than on a response that never ends.
	 */
	function beforeQuit(event) {
		if (shuttingDown) {
			// A shutdown is already under way, and every quit arriving now is somebody else's: the
			// operating system asking a second time, or the user insisting before the server is down.
			// It is held back for the same reason the first one was — letting it through is what tears
			// the process down in the middle of `close()` — and "insisting" is already answered: the
			// budget below bounds how long the wait can be. The one quit that must pass is this
			// module's own, and it is the only one marked as such.
			if (!ownQuit) event.preventDefault();
			return;
		}
		if (server === null) return;
		event.preventDefault();
		shuttingDown = true;

		const closing = server;
		// Dropped before the await, and not just for the guard above: macOS reopens a window against
		// `server.url` on `activate`, and a server on its way down must not be the one a new window is
		// pointed at.
		server = null;

		/** Whether the shell has given up waiting, which is also "there is nothing left to ask for". */
		let gaveUp = false;
		const budget = setTimeout(() => {
			gaveUp = true;
			log(`desktop: the server did not finish closing within ${budgetMs} ms; leaving anyway`);
			// `exit` rather than `quit`: the quit sequence is what is stuck, so asking for it again
			// would wait on the same thing. This one does not consult `before-quit`.
			app.exit(0);
		}, budgetMs);

		void closing
			.close()
			.catch((error) => {
				log(`desktop: the server failed to close — ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				clearTimeout(budget);
				// A server that finished closing on its way out of a shell that has already left: the
				// budget sent the process away, and a quit asked for now would only talk to a corpse.
				if (gaveUp) return;
				ownQuit = true;
				// The quit that counts: `beforeQuit` lets this one through, so Electron closes the
				// windows and terminates as it normally would.
				app.quit();
			});
	}

	return {
		serve,
		beforeQuit,
		/** The server still being served, or `null` once a shutdown is under way. */
		get current() {
			return server;
		},
	};
}

module.exports = { createShutdown, SHUTDOWN_BUDGET_MS };
