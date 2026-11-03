// The desktop shell's failure surface: which signals are wired, what they say, and which surface a
// report reaches.
//
//   node scripts/smoke-desktop-observability.ts
//
// Why this can be a smoke at all: `packages/desktop/observability.cjs` takes everything
// Electron-shaped as an argument — the application, the window factory, the boot function, the
// dialog — so the real handlers can be driven here with fakes that record what they were asked to
// do. A copy of the handlers rewritten in this file would prove nothing, which is why they live in a
// module. That module is CommonJS — it is what Electron loads — so it is pulled in through
// `createRequire`; everything else about this script is an ordinary TypeScript smoke.
//
// What is pinned is the shape of the ticket's four holes: a child process that dies says so; a
// renderer that dies says so *and* reaches a surface that still draws; an exception nobody caught is
// reported rather than swallowed; and a server that never comes up is reported instead of leaving no
// window and no line. What a report *looks* like is not asserted here — that a window was made, that
// it was handed a `data:` page carrying the reason, and that the native dialog is only the fallback
// is.
//
// The wall-clock half: the boot budget is driven in milliseconds rather than waited out, and the
// script ends by itself — nothing may be left holding the loop open, or the unref'd watchdog at the
// bottom fires and fails the run. An explicit `process.exit` would mask exactly that.
import { createRequire } from "node:module";
import { until } from "./wire/client.ts";

interface FakeWindow {
	/** Every URL this window was pointed at, in order. */
	urls: string[];
	loadURL(url: string): Promise<void>;
	isDestroyed(): boolean;
	/** How many times the window was asked to show itself; see the report-window checks. */
	shown: number;
	show(): void;
	webContents: { once(event: string, listener: () => void): void };
	/** Fires the "the page arrived" callback the report path waits on before showing the window. */
	finishLoad(): void;
	destroyed?: boolean;
}

interface FakeApp {
	on(event: string, listener: (...args: unknown[]) => void): void;
	emit(event: string, ...args: unknown[]): void;
}

const nodeRequire = createRequire(import.meta.url);
const { createObservability, BOOT_BUDGET_MS, LOAD_FAILED_HEADLINE } = nodeRequire("../packages/desktop/observability.cjs") as {
	createObservability(options: {
		app: FakeApp;
		createWindow: () => FakeWindow;
		boot: (workDirAbsPath: string) => Promise<{ url: string }>;
		bootBudgetMs?: number;
		log?: (line: string) => void;
		dialog?: { showErrorBox(title: string, content: string): void };
		windowFor?: (webContents: object) => FakeWindow | null;
	}): {
		watch(): void;
		report(headline: string, cause: unknown): FakeWindow | null;
		bootWithinBudget(workDirAbsPath: string): Promise<{ url: string } | null>;
	};
	BOOT_BUDGET_MS: number;
	/** Named once so the two load-failure sites in the shell cannot drift apart. */
	LOAD_FAILED_HEADLINE: string;
};

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/** A fake Electron application: listeners are recorded and can be fired by hand. */
function fakeApp(): FakeApp {
	const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
	return {
		on(event, listener) {
			listeners.set(event, [...(listeners.get(event) ?? []), listener]);
		},
		emit(event, ...args) {
			for (const listener of listeners.get(event) ?? []) listener(...args);
		},
	};
}

/**
 * One fake window.
 *
 * The report window is a window like any other as far as `observability.cjs` is concerned, so this
 * carries the three things it touches on one: the load, the destroyed check, and the "the page
 * arrived, show me" callback that a `data:` page cannot get from `ready-to-show` — which is why it is
 * here rather than left to each case to remember.
 */
function fakeWindow(): FakeWindow {
	let finishLoad: (() => void) | null = null;
	const window: FakeWindow = {
		urls: [],
		shown: 0,
		destroyed: false,
		isDestroyed: () => window.destroyed === true,
		show: () => void (window.shown += 1),
		webContents: {
			once: (event, listener) => {
				if (event === "did-finish-load") finishLoad = listener;
			},
		},
		finishLoad: () => finishLoad?.(),
		loadURL(url) {
			window.urls.push(url);
			return Promise.resolve();
		},
	};
	return window;
}

/** Every window a run opened, so the report ones can be told from the ordinary ones. */
function windows(): { made: FakeWindow[]; create: () => FakeWindow } {
	const made: FakeWindow[] = [];
	return {
		made,
		create: () => {
			const window = fakeWindow();
			made.push(window);
			return window;
		},
	};
}

/** Where the native dialog's contents land, counted. */
function dialogRecorder(): { calls: string[]; dialog: { showErrorBox(title: string, content: string): void } } {
	const calls: string[] = [];
	return {
		calls,
		dialog: {
			showErrorBox: (title, content) => void calls.push(`${title}: ${content}`),
		},
	};
}

/** A promise that never settles: a boot that hangs is the whole reason the budget exists. */
const never = (): Promise<never> => new Promise<never>(() => {});

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------------------------------------------------
// 1. A child process that goes away says which one, why, and with what exit code.
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a child process that goes away\n");
	const app = fakeApp();
	const factory = windows();
	const logs: string[] = [];
	const observed = createObservability({ app, createWindow: factory.create, boot: async () => ({ url: "x" }), log: (line) => logs.push(line) });
	observed.watch();

	// `0xC0000005` as a Windows exit code arrives as a negative decimal, which is what the crash
	// dumps print; the line has to be readable without a hex conversion in the reader's head.
	app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: -1073741819, name: "GPU Process" });
	check("the GPU process going away is a line", logs.length === 1, logs.join(" | "));
	check(
		"it names the process, the reason and the exit code in hex",
		(logs[0] ?? "").includes("GPU") &&
			(logs[0] ?? "").includes("crashed") &&
			(logs[0] ?? "").includes("0xC0000005"),
		logs[0] ?? "",
	);
	check("a child that dies does not open a window", factory.made.length === 0, String(factory.made.length));

	// A child that leaves on purpose is still worth a line, because "nothing happened" is what the
	// ticket is about — but it must not read like a crash.
	app.emit("child-process-gone", {}, { type: "Utility", reason: "clean-exit", exitCode: 0, name: "Network Service" });
	check("a clean exit is a line too", logs.length === 2, logs.join(" | "));
	check(
		"and it does not claim to have gone away",
		(logs[1] ?? "").includes("Network Service") && (logs[1] ?? "").includes("exited cleanly"),
		logs[1] ?? "",
	);

	// A child with no name at all must still produce a sentence rather than `undefined process`.
	app.emit("child-process-gone", {}, { type: "Unknown", reason: "killed", exitCode: 1 });
	check("an unnamed child still reads", (logs[2] ?? "").includes("unnamed child"), logs[2] ?? "");
}

// ------------------------------------------------------------------------------------------------
// 2. A renderer that goes away reaches a surface that can still draw, and says so only once.
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a renderer that goes away\n");
	const app = fakeApp();
	const factory = windows();
	const logs: string[] = [];
	const native = dialogRecorder();
	// The window whose renderer is about to die, built by a factory of its own: it is not a report
	// window, and counting reports means not counting it.
	const dead = windows().create();
	const observed = createObservability({
		app,
		createWindow: factory.create,
		boot: async () => ({ url: "x" }),
		log: (line) => logs.push(line),
		dialog: native.dialog,
		windowFor: () => dead,
	});
	observed.watch();

	app.emit("render-process-gone", {}, { id: 1 }, { reason: "crashed", exitCode: 2 });
	check("the death is a line", logs.length === 1, logs.join(" | "));
	check("the line carries the reason and the exit code", (logs[0] ?? "").includes("crashed") && (logs[0] ?? "").includes("2"), logs[0] ?? "");
	check("a report window was opened", factory.made.length === 1, String(factory.made.length));
	const report = factory.made[0];
	check("it was pointed at a data: page", (report?.urls[0] ?? "").startsWith("data:text/html"), (report?.urls[0] ?? "").slice(0, 40));
	check(
		"the page carries the reason",
		(report?.urls[0] ?? "").includes(encodeURIComponent("the renderer went away")),
		(report?.urls[0] ?? "").slice(0, 160),
	);
	check("the native dialog was not needed, because the page drew", native.calls.length === 0, native.calls.join(" | "));

	// A `data:` page never fires `ready-to-show`, which is what the shell's own window is shown on —
	// so a report has to be shown on "the page arrived" instead, or the failure is drawn into a window
	// nobody ever sees. That is the bug this pins, and it is why the fake carries a `finishLoad`.
	check("the report window was not shown before its page arrived", (report?.shown ?? -1) === 0, String(report?.shown));
	report?.finishLoad();
	check("it is shown once the page arrives", (report?.shown ?? 0) === 1, String(report?.shown));

	// A report whose window was closed between the crash and the page arriving must not be shown:
	// asking a destroyed window to show itself is how a report becomes a throw.
	const late = windows();
	const lateObserved = createObservability({
		app: fakeApp(),
		createWindow: late.create,
		boot: async () => ({ url: "x" }),
		log: () => {},
		dialog: dialogRecorder().dialog,
	});
	lateObserved.report("一个迟到的失败", new Error("too late"));
	late.made[0]!.destroyed = true;
	late.made[0]!.finishLoad();
	check("a window closed before its page arrived is not shown", late.made[0]?.shown === 0, String(late.made[0]?.shown));

	// A second crash of the same window is the same death: it is logged again — the log is where a
	// count lives — but it must not open a second window in front of the user.
	app.emit("render-process-gone", {}, { id: 1 }, { reason: "crashed", exitCode: 2 });
	check("a second death is logged again", logs.length === 2, logs.join(" | "));
	check("but it does not open a second report window", factory.made.length === 1, String(factory.made.length));

	// A window that is already closed has nothing on screen to explain, and a report for it would be
	// a window in front of a user for something that is gone.
	const closed = fakeApp();
	const closedFactory = windows();
	const closedLogs: string[] = [];
	const closedWindow = closedFactory.create();
	closedWindow.destroyed = true;
	const closedObserved = createObservability({
		app: closed,
		createWindow: closedFactory.create,
		boot: async () => ({ url: "x" }),
		log: (line) => closedLogs.push(line),
		dialog: dialogRecorder().dialog,
		windowFor: () => closedWindow,
	});
	closedObserved.watch();
	closed.emit("render-process-gone", {}, { id: 2 }, { reason: "crashed", exitCode: 2 });
	check("a closed window's renderer is a line and nothing more", closedLogs.length === 1 && closedFactory.made.length === 1, `${closedLogs.length} logs, ${closedFactory.made.length} windows`);
}

// ------------------------------------------------------------------------------------------------
// 3. When the report page itself cannot be drawn, the native dialog is the fallback — and when that
//    is unavailable too, the line is still out and nothing throws.
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a report that cannot be drawn\n");
	const app = fakeApp();
	const logs: string[] = [];
	const native = dialogRecorder();
	// As in §2: this is the window whose renderer dies, not one of the reports being counted.
	const dead = windows().create();
	// Every window the report tries to draw in refuses the page, which is what a renderer that cannot
	// come up looks like from here. `createWindow` is handed in once, so the factory has to be the
	// refusing one from the start rather than swapped in after the fact.
	const refusals = windows();
	const observed = createObservability({
		app,
		createWindow: () => {
			const window = refusals.create();
			window.loadURL = (url) => {
				window.urls.push(url);
				return Promise.reject(new Error(`ERR_FAILED (-2) loading '${url.slice(0, 16)}'`));
			};
			return window;
		},
		boot: async () => ({ url: "x" }),
		log: (line) => logs.push(line),
		dialog: native.dialog,
		windowFor: () => dead,
	});
	observed.watch();

	app.emit("render-process-gone", {}, { id: 3 }, { reason: "crashed", exitCode: 2 });
	await until(() => native.calls.length > 0, 2_000);
	check("the fallback dialog fired", native.calls.length === 1, native.calls.join(" | "));
	check("it carries the reason", (native.calls[0] ?? "").includes("crashed"), native.calls[0] ?? "");
	check(
		"and the page failure was logged with its own reason",
		logs.some((line) => line.includes("ERR_FAILED")),
		logs.join(" | "),
	);

	// The dialog that throws as well — a machine where nothing draws — must not take the process with
	// it: the report is already in the log, and throwing here would be how a failure becomes silence.
	const throwing = fakeApp();
	const throwingFactory = windows();
	const throwingLogs: string[] = [];
	const throwingWindow = throwingFactory.create();
	const throwingObserved = createObservability({
		app: throwing,
		createWindow: () => {
			const window = throwingFactory.create();
			// The page cannot be drawn either, so the throwing dialog is the last thing tried: the
			// question is only whether it takes the process down with it when it throws as well.
			window.loadURL = (url) => {
				window.urls.push(url);
				return Promise.reject(new Error("ERR_FAILED (-2)"));
			};
			return window;
		},
		boot: async () => ({ url: "x" }),
		log: (line) => throwingLogs.push(line),
		dialog: {
			showErrorBox: () => {
				throw new Error("no display");
			},
		},
		windowFor: () => throwingWindow,
	});
	throwingObserved.watch();
	throwing.emit("render-process-gone", {}, { id: 4 }, { reason: "crashed", exitCode: 2 });
	check(
		"a dialog that throws is reported, not thrown",
		await until(() => throwingLogs.some((line) => line.includes("no display")), 1_000),
		throwingLogs.join(" | "),
	);

	// The last resort for the last resort: the shell cannot even make a window. There is nothing left
	// but the OS, the reason still has to reach it, and the stack has to be in the line — a report that
	// says only "it broke" is the silence this module exists to replace.
	const noWindow = fakeApp();
	const noWindowLogs: string[] = [];
	const noWindowNative = dialogRecorder();
	const noWindowObserved = createObservability({
		app: noWindow,
		createWindow: () => {
			throw new Error("no display server");
		},
		boot: async () => ({ url: "x" }),
		log: (line) => noWindowLogs.push(line),
		dialog: noWindowNative.dialog,
	});
	const returned = noWindowObserved.report(LOAD_FAILED_HEADLINE, new Error("ERR_FAILED (-2)"));
	check("a report with no window to draw in comes back as nothing", returned === null, String(returned));
	check("the native dialog is what is left", noWindowNative.calls.length === 1, noWindowNative.calls.join(" | "));
	check(
		"and it carries the reason",
		(noWindowNative.calls[0] ?? "").includes("ERR_FAILED (-2)"),
		noWindowNative.calls[0] ?? "",
	);
	check(
		"the line carries the stack, not just the message",
		noWindowLogs.some((line) => line.includes("no display server") && line.includes("at ")),
		noWindowLogs.join(" | "),
	);
	check(
		"the headline the shell shares is the one in the page and the dialog",
		noWindowNative.calls.every((call) => call.startsWith(`${LOAD_FAILED_HEADLINE}:`)),
		noWindowNative.calls.join(" | "),
	);
}

// ------------------------------------------------------------------------------------------------
// 4. An exception nobody caught is reported instead of ending a conversation in progress.
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("an exception nobody caught\n");
	const app = fakeApp();
	const factory = windows();
	const logs: string[] = [];
	const native = dialogRecorder();
	const observed = createObservability({
		app,
		createWindow: factory.create,
		boot: async () => ({ url: "x" }),
		log: (line) => logs.push(line),
		dialog: native.dialog,
	});
	observed.watch();

	// The listener is registered on the process, and it is the real one this module registered: the
	// smoke reaches it through the same `on` it called. Fired by hand rather than by throwing,
	// because this process is the one that would go down with it.
	const listeners = process.listeners("uncaughtException");
	check("it subscribed to the process's own exceptions", listeners.length >= 1, String(listeners.length));
	const own = listeners[listeners.length - 1] as (error: unknown) => void;
	own(new Error("the picker exploded"));

	check("the exception is a line with its stack", logs.some((line) => line.includes("the picker exploded")), logs.join(" | "));
	check("and it is drawn in a window of its own", factory.made.length === 1, String(factory.made.length));
	check(
		"the window is a report page rather than the shell's own",
		(factory.made[0]?.urls[0] ?? "").startsWith("data:text/html"),
		(factory.made[0]?.urls[0] ?? "").slice(0, 40),
	);
	process.removeListener("uncaughtException", own);

	// A rejected promise nobody handled is the same news as a thrown error, but it arrives without the
	// process's own alarm — so it has to be subscribed to, or an entire class of failure stays silent.
	// Counted rather than fired: an unhandled rejection in *this* process is this smoke's own problem.
	check(
		"it subscribed to unhandled rejections too",
		process.listeners("unhandledRejection").length >= 1,
		String(process.listeners("unhandledRejection").length),
	);
}

// ------------------------------------------------------------------------------------------------
// 5. A server that rejects, and one that never answers, are both reported — the second one is the
//    hole the ticket names, because it used to be a shell with no window and no line.
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a server that will not start\n");
	const factory = windows();
	const logs: string[] = [];
	const native = dialogRecorder();
	const observed = createObservability({
		app: fakeApp(),
		createWindow: factory.create,
		boot: async () => {
			throw new Error("the port was taken");
		},
		log: (line) => logs.push(line),
		dialog: native.dialog,
	});

	const booted = await observed.bootWithinBudget("C:\\projects\\demo");
	check("a rejecting boot returns null", booted === null, JSON.stringify(booted));
	check("the reason is a line", logs.some((line) => line.includes("the port was taken")), logs.join(" | "));
	check("and it reaches a window", factory.made.length === 1, String(factory.made.length));
	check("with the headline in it", (factory.made[0]?.urls[0] ?? "").includes(encodeURIComponent("agent 服务没有启动起来")), (factory.made[0]?.urls[0] ?? "").slice(0, 80));
}

// ------------------------------------------------------------------------------------------------
// 6. A boot that hangs is bounded, reported, and not abandoned in silence when it later arrives.
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a server that never answers\n");
	const factory = windows();
	const logs: string[] = [];
	const observed = createObservability({
		app: fakeApp(),
		createWindow: factory.create,
		boot: never,
		bootBudgetMs: 25,
		log: (line) => logs.push(line),
		dialog: dialogRecorder().dialog,
	});

	const askedAt = Date.now();
	const booted = await observed.bootWithinBudget("C:\\projects\\demo");
	const waited = Date.now() - askedAt;
	check("a hanging boot returns null instead of waiting forever", booted === null, JSON.stringify(booted));
	check("it waited the budget it was given, not the default", waited >= 25 && waited < 1_000, `${waited} ms`);
	check("the budget is named in the line", logs.some((line) => line.includes("25 ms")), logs.join(" | "));
	check("and the failure reached a window", factory.made.length === 1, String(factory.made.length));
	check("the default budget is a watchdog, not a deadline", BOOT_BUDGET_MS === 20_000, String(BOOT_BUDGET_MS));

	// A boot that lands after the budget is the one case where "slow" and "stuck" differ, so it is
	// said out loud when it arrives: a report has already been drawn by then.
	const lateLogs: string[] = [];
	let settle: (booted: { url: string }) => void = () => {};
	const late = new Promise<{ url: string }>((done) => {
		settle = done;
	});
	const lateObserved = createObservability({
		app: fakeApp(),
		createWindow: windows().create,
		boot: () => late,
		bootBudgetMs: 20,
		log: (line) => lateLogs.push(line),
		dialog: dialogRecorder().dialog,
	});
	check("a late boot still reports its deadline", (await lateObserved.bootWithinBudget("C:\\projects\\demo")) === null);
	settle({ url: "http://127.0.0.1:9" });
	check("and says so when it finally arrives", await until(() => lateLogs.some((line) => line.includes("http://127.0.0.1:9")), 1_000), lateLogs.join(" | "));
}

// A boot that succeeds inside the budget is the ordinary path: no line, no window, the server back.
{
	process.stdout.write("a server that starts\n");
	const factory = windows();
	const logs: string[] = [];
	const observed = createObservability({
		app: fakeApp(),
		createWindow: factory.create,
		boot: async () => ({ url: "http://127.0.0.1:1234" }),
		log: (line) => logs.push(line),
		dialog: dialogRecorder().dialog,
	});
	const booted = await observed.bootWithinBudget("C:\\projects\\demo");
	check("a boot inside the budget comes back as the server", booted?.url === "http://127.0.0.1:1234", JSON.stringify(booted));
	check("nothing was logged", logs.length === 0, logs.join(" | "));
	check("and no report window was opened", factory.made.length === 0, String(factory.made.length));
}

// The natural-exit watchdog, last thing in the file: every case above has been torn down, so the
// loop should drain and this process should leave — before this unref'd timer, which does not hold
// the loop open, ever fires. If it fires, a budget was left armed, or something else is still
// holding a handle; both are failures.
setTimeout(() => {
	process.stdout.write("\nFAIL the process did not exit on its own — a handle was left behind\n");
	process.exit(1);
}, 3_000).unref();

process.stdout.write(failures === 0 ? "\ndesktop observability ok\n" : `\n${failures} failure(s)\n`);
process.exitCode = failures === 0 ? 0 : 1;
