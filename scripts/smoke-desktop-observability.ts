// 桌面外壳的失败面：哪些信号接了线、它们说什么、一份报告到达哪个表面。
//
//   node scripts/smoke-desktop-observability.ts
//
// 为什么这能做成 smoke：`packages/desktop/observability.cjs` 把一切 Electron 形状的东西都当
// 参数收下——应用、窗口工厂、boot 函数、dialog——所以真实的 handler 可以在这里用记录自己被
// 要求做什么的 fake 驱动。在本文件里重写一份 handler 副本什么也证明不了，这正是它们住在模块里
// 的原因。那个模块是 CommonJS——Electron 加载的就是它——所以经 `createRequire` 拉进来；
// 本脚本其余部分就是一个普通的 TypeScript smoke。
//
// 被钉住的是 ticket 四个洞的形状：死掉的子进程说出自己；死掉的 renderer 说出自己*并且*到达一个
// 仍能绘制的表面；无人捕获的异常被报告而不是被吞下；永远起不来的服务器被报告，而不是既没有
// 窗口也没有一行。报告*长什么样*不断言——断言的是开了一个窗口、它被交予一张带着原因的
// `data:` 页面、原生 dialog 只是兜底。
//
// 墙钟那一半：boot 预算以毫秒驱动而不是等完，脚本自己收尾——任何东西都不得把事件循环挂住，
// 否则底部那个 unref 的 watchdog 会触发并判这次运行失败。显式 `process.exit` 恰好会掩盖这一点。
import { createRequire } from "node:module";
import { until } from "./wire/client.ts";

interface FakeWindow {
	/** 这个窗口被指向过的每个 URL，按序。 */
	urls: string[];
	loadURL(url: string): Promise<void>;
	isDestroyed(): boolean;
	/** 窗口被要求显示自己多少次；见报告窗口的检查。 */
	shown: number;
	show(): void;
	webContents: { once(event: string, listener: () => void): void };
	/** 触发"页面到达"回调——报告路径在显示窗口之前等的就是它。 */
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
	/** 只被命名一次，让外壳里两个 load 失败点不会漂移开。 */
	LOAD_FAILED_HEADLINE: string;
};

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/** 一个假的 Electron 应用：监听器被记录，可以手工触发。 */
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
 * 一个假窗口。
 *
 * 就 `observability.cjs` 而言，报告窗口与任何窗口无异，所以它触碰的三样东西集于一身：加载、
 * destroyed 检查，以及"`data:` 页面无法从 `ready-to-show` 得到的'页面到达了，显示我'回调"
 * ——这正是它住在这里、而不是留给每个用例自己记着的原因。
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

/** 一次运行打开的每个窗口，报告窗口因此可以与普通窗口区分开。 */
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

/** 原生 dialog 的内容落地的地方，带计数。 */
function dialogRecorder(): { calls: string[]; dialog: { showErrorBox(title: string, content: string): void } } {
	const calls: string[] = [];
	return {
		calls,
		dialog: {
			showErrorBox: (title, content) => void calls.push(`${title}: ${content}`),
		},
	};
}

/** 一个永不落定的 promise：会挂起的 boot 正是预算存在的理由。 */
const never = (): Promise<never> => new Promise<never>(() => {});

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------------------------------------------------
// 1. 一个消失的子进程说出它是哪个、为什么、带着什么退出码。
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a child process that goes away\n");
	const app = fakeApp();
	const factory = windows();
	const logs: string[] = [];
	const observed = createObservability({ app, createWindow: factory.create, boot: async () => ({ url: "x" }), log: (line) => logs.push(line) });
	observed.watch();

	// `0xC0000005` 作为 Windows 退出码以负十进制到达，那正是崩溃转储打印的样子；这一行必须
	// 让读者不用在脑子里做十六进制换算就能读懂。
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

	// 一个故意离开的子进程仍然值得一 行，因为"什么都没发生"正是 ticket 所关乎的——但它不得
	// 读起来像崩溃。
	app.emit("child-process-gone", {}, { type: "Utility", reason: "clean-exit", exitCode: 0, name: "Network Service" });
	check("a clean exit is a line too", logs.length === 2, logs.join(" | "));
	check(
		"and it does not claim to have gone away",
		(logs[1] ?? "").includes("Network Service") && (logs[1] ?? "").includes("exited cleanly"),
		logs[1] ?? "",
	);

	// 一个根本没有名字的子进程仍必须产出一个句子，而不是 `undefined process`。
	app.emit("child-process-gone", {}, { type: "Unknown", reason: "killed", exitCode: 1 });
	check("an unnamed child still reads", (logs[2] ?? "").includes("unnamed child"), logs[2] ?? "");
}

// ------------------------------------------------------------------------------------------------
// 2. 消失的 renderer 到达一个仍能绘制的表面，且只说一次。
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a renderer that goes away\n");
	const app = fakeApp();
	const factory = windows();
	const logs: string[] = [];
	const native = dialogRecorder();
	// renderer 即将死去的那个窗口，由它自己的工厂构建：它不是报告窗口，数报告就不能数它。
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

	// `data:` 页面从不触发 `ready-to-show`，而外壳自己的窗口正是在它上面显示的——所以报告必须
	// 改在"页面到达"上显示，否则失败被画进一个谁也见不到的窗口。这正是本脚本钉住的 bug，也是
	// fake 带着一份 `finishLoad` 的原因。
	check("the report window was not shown before its page arrived", (report?.shown ?? -1) === 0, String(report?.shown));
	report?.finishLoad();
	check("it is shown once the page arrives", (report?.shown ?? 0) === 1, String(report?.shown));

	// 在崩溃与页面到达之间被关掉的窗口不得被显示：让一个已销毁的窗口显示自己，正是报告变成
	// throw 的方式。
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

	// 同一窗口的第二次崩溃是同一次死亡：它再次被记入日志——日志是计数住的地方——但不得在
	// 用户面前开第二个窗口。
	app.emit("render-process-gone", {}, { id: 1 }, { reason: "crashed", exitCode: 2 });
	check("a second death is logged again", logs.length === 2, logs.join(" | "));
	check("but it does not open a second report window", factory.made.length === 1, String(factory.made.length));

	// 已经关上的窗口没有屏幕上的东西可解释，为它出的报告将是一个挡在用户面前的、为已不存在
	// 之物准备的窗口。
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
// 3. 报告页面自己画不出来时，原生 dialog 是兜底——而当它也不可用时，那一行仍然在外面，
//    且什么都不抛。
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a report that cannot be drawn\n");
	const app = fakeApp();
	const logs: string[] = [];
	const native = dialogRecorder();
	// 与 §2 相同：这是 renderer 死去的那个窗口，不是被数的报告之一。
	const dead = windows().create();
	// 报告试图在其中绘制的每个窗口都拒绝页面，这就是一个起不来的 renderer 从这里看起来的样子。
	// `createWindow` 只交进来一次，所以工厂必须从一开始就是拒绝的那个，而不是事后换进去的。
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

	// 连 dialog 也抛的 dialog——一台什么都画不出来的机器——不得把进程一起带走：报告已经在
	// 日志里，在这里 throw 正是失败变成沉默的方式。
	const throwing = fakeApp();
	const throwingFactory = windows();
	const throwingLogs: string[] = [];
	const throwingWindow = throwingFactory.create();
	const throwingObserved = createObservability({
		app: throwing,
		createWindow: () => {
			const window = throwingFactory.create();
			// 页面也画不出来，所以抛错的 dialog 是最后被尝试的东西：问题只是它连自己也抛时是否
			// 会把进程带走。
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

	// 兜底的兜底：外壳连一个窗口都造不出来。剩下的只有操作系统，原因仍然必须到达它，而且
	// stack 必须在那一行里——一份只说"坏了"的报告正是本模块要替换掉的沉默。
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
// 4. 无人捕获的异常被报告，而不是终结一场正在进行的对话。
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

	// 监听器注册在进程上，而且正是本模块注册的那个真的：smoke 经它自己调用的同一个 `on` 到达
	// 它。手工触发而不是真的抛，因为这个进程就是会随它一起倒下的那个。
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

	// 无人处理的被拒 promise 与抛出的错误是同一条新闻，但它到达时不带进程自己的警报——所以
	// 必须订阅它，否则一整类失败保持沉默。只数不触发：*本*进程里的 unhandled rejection 是这个
	// smoke 自己的问题。
	check(
		"it subscribed to unhandled rejections too",
		process.listeners("unhandledRejection").length >= 1,
		String(process.listeners("unhandledRejection").length),
	);
}

// ------------------------------------------------------------------------------------------------
// 5. 一个拒绝的服务器与一个永不作答的服务器都被报告——第二个正是 ticket 指名的洞，因为它
//    曾经是一个既没有窗口也没有一行的外壳。
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
// 6. 挂起的 boot 有界、被报告，并且在它后来到达时不被沉默地放弃。
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

	// 预算之后才落地的 boot 是"慢"与"卡"分开的那一个用例，所以它到达时被大声说出来：那时
	// 一份报告已经画出去了。
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

// 预算之内成功的 boot 是寻常路径：没有行、没有窗口、服务器回来。
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

// 自然退出 watchdog，文件里最后一件事：上面每个用例都已拆除，事件循环应当排空、本进程应当
// 离开——赶在这个不占用循环的 unref 定时器触发之前。它若触发，说明某个预算还挂着，或者别的
// 什么东西还握着句柄；两者都是失败。
setTimeout(() => {
	process.stdout.write("\nFAIL the process did not exit on its own — a handle was left behind\n");
	process.exit(1);
}, 3_000).unref();

process.stdout.write(failures === 0 ? "\ndesktop observability ok\n" : `\n${failures} failure(s)\n`);
process.exitCode = failures === 0 ? 0 : 1;
