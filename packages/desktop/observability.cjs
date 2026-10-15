/**
 * The shell's failure surface: what a user sees when something on the way up, or underneath, dies.
 *
 * It lives on its own, rather than inline in `main.cjs`, for the same reason `shutdown.cjs` does: a
 * smoke that rewrote these handlers would be asserting its own copy, and what is being pinned here is
 * *which signals are wired and what they say*. Everything Electron-shaped arrives as an argument —
 * `app`, the window factory, the dialog, the window lookup — so a smoke can drive the real handlers
 * with fakes, and this file is importable by plain Node.
 *
 * It is CommonJS because the shell is: Electron loads `main.cjs` before any toolchain runs.
 *
 * **Language.** The two halves of a failure are written in the two languages the repository uses for
 * them. The diagnostic line is English, which is what this shell's diagnostics already are
 * (`shutdown.cjs`, and `main.cjs`'s own server and capture lines all read `desktop: …`) — AGENTS.md
 * routes diagnostics to Chinese, and the shell is a standing exception to that, so a new module
 * matching its neighbours is the smaller surprise than a mixed log. The page and the dialog are
 * Chinese, because those are user-facing strings and this is a one-locale window.
 *
 * **What this is not.** A policy. There is one budget below, and it is there because a boot that
 * hangs is otherwise indistinguishable from a launch that did nothing; it is not a decision about how
 * long is reasonable, and this module does not retry, hop ports, or choose what happens next. It
 * exists so that a failure is *visible* — a line with the reason, and a window that says it too.
 *
 * **Why a report survives the renderer dying**, which is the thing worth knowing here: the report is
 * a `data:` page, so the shell draws it without asking the server it just failed to start. A renderer
 * that has gone is replaced by a fresh one, and that one draws the page — measured on this machine
 * with `webContents.forcefullyCrashRenderer()` (`.scratch/window-repair/research/electron-probe/`):
 * `render-process-gone` arrived as `{reason: "crashed", exitCode: 2}`, `loadURL(data:…)` then settled,
 * and the new renderer answered with the report page's own heading, in a window that was visible.
 * The native dialog is the backstop for a window that cannot draw the page at all: it is drawn by the
 * OS, in the browser process, so it needs no renderer — at the price of blocking until somebody
 * clicks it, which is why it is never the first choice.
 */

/**
 * How long the shell waits for the server to come up before reporting that it never did.
 *
 * A watchdog and not a deadline: the import of the server's own TypeScript graph measures around
 * 415 ms here and Vite's first transform is the slowest case this ever sees, so a boot inside this
 * budget is the ordinary path. What it buys is that a `bootServer()` which *hangs* rather than
 * rejects stops being indistinguishable from a shell that did nothing at all. `shutdown.cjs` has the
 * same shape of budget for the same reason, at the other end of the lifetime.
 */
const BOOT_BUDGET_MS = 20_000;

/** What a load failure is called, wherever the shell reports one — the main window is not the only one. */
const LOAD_FAILED_HEADLINE = "窗口没能加载 agent 服务";

/**
 * Own the shell's failure surface.
 *
 * @param {object} options
 * @param {{ on(event: string, listener: (...args: unknown[]) => void): void }} options.app The
 *   Electron application object: only `on` is used on it.
 * @param {() => object} options.createWindow Builds the window a report is drawn in. The shell's own
 *   factory is what decides frame, theme and preload; a report must not be a second kind of window.
 * @param {(cwd: string) => Promise<{ url: string }>} options.boot Starts the server, rejecting if it
 *   cannot be started.
 * @param {number} [options.bootBudgetMs] Override for {@link BOOT_BUDGET_MS}, so a smoke can drive a
 *   hanging boot in milliseconds instead of waiting the real budget out.
 * @param {(line: string) => void} [options.log] Where the diagnostic lines go. Defaults to
 *   `console.error`; a smoke collects them instead.
 * @param {object} [options.dialog] The Electron `dialog` module. A smoke passes a recorder; the shell
 *   passes the real one, which is the only surface left when no renderer can draw.
 * @param {(webContents: object) => object | null} [options.windowFor] Resolves the window a
 *   `webContents` belongs to, for `render-process-gone` — the event the renderer's own window is the
 *   whole point of. Defaults to Electron's `BrowserWindow.fromWebContents`.
 */
function createObservability(options) {
	const { app, createWindow, boot } = options;
	const budgetMs = options.bootBudgetMs ?? BOOT_BUDGET_MS;
	const log = options.log ?? ((line) => console.error(line));
	// Resolved on demand rather than at construction: `require("electron")` from a plain Node process
	// returns a path, and a module that can only be loaded inside Electron could not be driven by the
	// smoke this file exists for.
	const electron = () => require("electron");
	const dialog = options.dialog ?? electron().dialog;
	const windowFor =
		options.windowFor ??
		((webContents) => {
			try {
				return electron().BrowserWindow.fromWebContents(webContents) ?? null;
			} catch {
				return null;
			}
		});

	/** The windows that have already been told their renderer died, so one death says one thing. */
	const reported = new WeakSet();

	/** `exitCode` as the hex the crash dumps use, because a negative decimal is unreadable. */
	function hex(exitCode) {
		return typeof exitCode === "number" && exitCode < 0
			? `0x${(exitCode >>> 0).toString(16).toUpperCase()}`
			: String(exitCode);
	}

	/** One line for a child process that went away: which one, why, and its exit code. */
	function describeChild(details) {
		const name = details.name ?? details.serviceName ?? "unnamed child";
		const why =
			details.reason === "clean-exit"
				? "exited cleanly"
				: `went away (${details.reason}, exit code ${hex(details.exitCode)})`;
		return `${details.type} process ${name} ${why}`;
	}

	/** One line for a renderer that went away. */
	function describeRenderer(details) {
		return `the renderer went away (${details.reason}, exit code ${hex(details.exitCode)})`;
	}

	/**
	 * The three parts of a failure, each where it can be read.
	 *
	 * @param {string} headline One line naming what failed, in the window's own words.
	 * @param {Error | string} cause The reason. An `Error` carries its stack onto the page, which is
	 *   the difference between a report somebody can act on and one that only says "it broke".
	 */
	function failureParts(headline, cause) {
		return {
			headline,
			message: cause instanceof Error ? cause.message : String(cause),
			detail: cause instanceof Error && cause.stack ? `\n\n${cause.stack}` : "",
		};
	}

	/**
	 * The blocking surface, for the window whose page cannot be drawn either.
	 *
	 * It blocks until somebody clicks it, which is tolerable exactly here: the alternative is a
	 * failure the user never gets told about. A dialog that throws as well is logged and swallowed —
	 * throwing would be taking the process down over the last resort for saying so.
	 */
	function showNativeDialog(parts) {
		try {
			dialog.showErrorBox(parts.headline, `${parts.message}${parts.detail.slice(0, 2000)}`);
		} catch (error) {
			log(`desktop: even the native dialog refused to open — ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Draw a failure in a window of its own, and hand that window back.
	 *
	 * The `data:` page is the surface a user can read, scroll and copy, and the shell draws it itself,
	 * so it needs neither the server that just failed nor a healthy renderer. Shown when the page
	 * arrives rather than on `ready-to-show`, which is what the shell's own window waits for: that
	 * event does not fire for a `data:` URL, so a report waiting on it would be a failure page drawn
	 * into a window nobody ever sees — which is the shape of the problem this module exists to fix.
	 * The listener is attached before `loadURL` so a load that finishes synchronously still finds one.
	 *
	 * @returns {object | null} The window the page is going into, or `null` when there is no window at
	 *   all — the caller then has only the line that was already logged.
	 */
	function showInWindow(headline, cause) {
		const parts = failureParts(headline, cause);
		const escape = (text) => text.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"));
		const page =
			"data:text/html;charset=utf-8," +
			encodeURIComponent(
				`<!doctype html><meta charset="utf-8"><title>my-coding-agent</title>` +
					`<body style="font:14px/1.6 system-ui;background:#151517;color:#e9ecf2;padding:2rem">` +
					`<h1 style="font-size:16px">${escape(parts.headline)}</h1>` +
					// Sliced before it is escaped, never after: cutting into an `&amp;` would leave half an
					// entity in the page, and the stack is the one part of this allowed to be truncated.
					`<pre style="white-space:pre-wrap;color:#f25a5a">${escape(parts.message)}${escape(parts.detail.slice(0, 4000))}</pre>`,
			);
		try {
			const window = createWindow();
			if (window.webContents && typeof window.webContents.once === "function") {
				window.webContents.once("did-finish-load", () => {
					if (!window.isDestroyed()) window.show();
				});
			}
			void window.loadURL(page).catch((error) => {
				log(`desktop: the failure page did not draw — ${error instanceof Error ? error.message : String(error)}`);
				showNativeDialog(parts);
			});
			return window;
		} catch (error) {
			log(
				`desktop: no window could be opened for the report — ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
			);
			showNativeDialog(parts);
			return null;
		}
	}

	/**
	 * Report a failure: one diagnostic line with the reason, then a window that says the same thing.
	 *
	 * @param {string} headline One line naming what failed.
	 * @param {Error | string} cause The reason, with the stack when there is one.
	 * @returns {object | null} The window the report is drawing in, or `null` when not even that worked.
	 */
	function report(headline, cause) {
		log(`desktop: ${headline} — ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`);
		return showInWindow(headline, cause);
	}

	/**
	 * What a killed renderer leaves on screen, said in the two places it has to be said.
	 *
	 * The window is unusable — whatever the page had built went with the process — so this is the one
	 * failure that cannot wait for the user to notice it. The line goes to the diagnostics first, so
	 * the reason is on disk even if nobody is looking at the screen, and then the report window: the
	 * replacement renderer draws the `data:` page even though the old one just died, so the user gets
	 * the reason somewhere they can read it instead of a window that will not repaint.
	 */
	function reportRendererGone(webContents, details) {
		const message = describeRenderer(details);
		log(`desktop: ${message}`);
		const source = windowFor(webContents);
		// A window nobody is looking at anymore — closed, or never made — has nothing on screen to
		// explain, and a second report for the same death is noise.
		if (source === null || source.isDestroyed() || reported.has(source)) return;
		reported.add(source);
		showInWindow(
			"窗口的渲染进程没了",
			new Error(`${message}\n\n画着这个窗口的进程已经没了，所以它不会再画任何东西；关掉它，重新启动一次外壳。`),
		);
	}

	/**
	 * Start the server with a budget, and turn either kind of failure into a report.
	 *
	 * Two things go wrong here and they used to look identical: a `bootServer()` that rejects and one
	 * that never settles, neither of which opened a window or wrote a line. Both are reported now, and
	 * a boot that arrives after the budget is logged when it lands, so a slow machine is
	 * distinguished from a stuck one instead of being guessed at.
	 *
	 * @param {string} cwd The workspace the server is starting against.
	 * @returns {Promise<{ url: string } | null>} The server, or `null` once the failure was reported.
	 */
	async function bootWithinBudget(cwd) {
		const booting = boot(cwd);
		let timer;
		const deadline = new Promise((_settle, fail) => {
			timer = setTimeout(() => fail(new Error(`the server did not come up within ${budgetMs} ms`)), budgetMs);
		});
		try {
			return await Promise.race([booting, deadline]);
		} catch (error) {
			// A boot that missed its deadline is not abandoned in silence: it is still trying, and a
			// server arriving later is exactly the thing worth a line — through the same sink as every
			// other diagnostic, so a smoke collects it and a user's terminal shows it in order.
			void booting.then(
				(booted) => log(`desktop: the server did come up, after the ${budgetMs} ms budget — ${booted.url}`),
				() => {},
			);
			report("agent 服务没有启动起来", error);
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Wire the failures that happen on their own, once the application is ready.
	 *
	 * Four signals, and they are not the same kind of news. A child process going away is a line and
	 * nothing else: a GPU or network child is a process the user never asked for, so a dialog in
	 * front of the window they are using would be noise. A line is what makes the next death
	 * diagnosable rather than mysterious — and such lines are how the switches this shell used to
	 * carry were found, measured, and then dropped (ADR-0004). A renderer going away costs them that
	 * window, so it gets a report window of its own. An exception in the main process is neither:
	 * the shell's work here is starting a server and drawing a window, and the
	 * window and the server are both someone else's children — so it is reported and the process is
	 * left standing, rather than making a stray exception the end of a conversation the user is in the
	 * middle of. A rejected promise nobody handled is the same news as a thrown error but arrives
	 * without the process's own alarm, so it is reported the same way.
	 */
	function watch() {
		app.on("child-process-gone", (_event, details) => {
			log(`desktop: ${describeChild(details)}`);
		});

		app.on("render-process-gone", (_event, webContents, details) => {
			reportRendererGone(webContents, details);
		});

		process.on("uncaughtException", (error) => {
			report("外壳遇到了一个没人处理的异常", error);
		});

		process.on("unhandledRejection", (reason) => {
			report("外壳有一个没人处理的 promise 拒绝", reason instanceof Error ? reason : String(reason));
		});
	}

	return { watch, report, bootWithinBudget };
}

module.exports = { createObservability, BOOT_BUDGET_MS, LOAD_FAILED_HEADLINE };
