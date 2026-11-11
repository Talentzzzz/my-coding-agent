// 桌面外壳的退出路径：服务器先被放下，进程才被允许离开。
//
//   node scripts/smoke-desktop-close.ts
//
// 为什么这能做成 smoke：`packages/desktop/shutdown.cjs` 把 Electron 应用当参数收下，只在它上面
// 调两样东西（`quit` 与 `exit`），所以真实序列可以在这里用一个记录它被要求做什么的 fake 驱动。
// 在本文件里重写一份序列副本什么也证明不了，这正是序列住在模块里的原因。该模块是 CommonJS
// ——Electron 加载的就是它——所以经 `createRequire` 拉进来；本脚本其余部分就是一个普通的
// TypeScript smoke。
//
// 被钉住的是常驻连接赋予意义的那份顺序：Electron 的 quit 不等 promise，所以外壳扣下第一次
// quit，等 `close()`，然后再问一次。进程绝不能在 `close()` 落定之前离开——第一次 quit 不行，
// 服务器还在下落时别人再要的第二次也不行——绝不能因为 `close()` 行为不端而离不开，也绝不能
// 启动第二次 shutdown。
//
// 墙钟那一半：放弃路径用一个毫秒预算驱动（默认就是 boot smoke 自己的 5 s，`smoke-boot.ts`
// 断言 `close()` 在其内返回的正是它），脚本最后自己收尾——任何东西都不得把事件循环挂住，否则
// 文件底部那个 unref 的 watchdog 会触发并判这次运行失败。显式 `process.exit` 恰好会掩盖这一点。
import { createRequire } from "node:module";
import { until } from "./wire/client.ts";

interface BootedServer {
	url: string;
	close(): Promise<void>;
}

interface FakeApp {
	quit(): void;
	exit(code: number): void;
}

const nodeRequire = createRequire(import.meta.url);
const { createShutdown, SHUTDOWN_BUDGET_MS } = nodeRequire("../packages/desktop/shutdown.cjs") as {
	createShutdown(options: {
		app: FakeApp;
		shutdownBudgetMs?: number;
		log?: (line: string) => void;
	}): {
		serve(booted: BootedServer): void;
		beforeQuit(event: { preventDefault(): void }): void;
		readonly current: BootedServer | null;
	};
	SHUTDOWN_BUDGET_MS: number;
};

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/** 一个假的 Electron 应用，按序记录它被要求做的事。 */
function fakeApp(events: string[]): FakeApp {
	return {
		quit: () => events.push("quit"),
		exit: (code) => events.push(`exit:${code}`),
	};
}

/** `preventDefault` 的落点，带计数。 */
function counter(): { count: number; event: { preventDefault(): void } } {
	const state = { count: 0, event: { preventDefault: () => void (state.count += 1) } };
	return state;
}

// ------------------------------------------------------------------------------------------------
// 1. 顺序：先 close()，quit 在后——凡不是本模块自己发的 quit 一律扣下。
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a quit with a server that closes\n");
	const events: string[] = [];
	const logs: string[] = [];
	let settle: () => void = () => {};
	const closed = new Promise<void>((done) => {
		settle = done;
	});
	const lifecycle = createShutdown({ app: fakeApp(events), log: (line) => logs.push(line) });
	lifecycle.serve({
		url: "http://127.0.0.1:1",
		close: () => {
			events.push("close");
			return closed.then(() => {
				events.push("close-settled");
			});
		},
	});

	const held = counter();
	lifecycle.beforeQuit(held.event);
	check("the first quit is held back", held.count === 1);
	check("close() was called", events.includes("close"));
	check("nothing has quit while close() is still running", !events.includes("quit"), events.join(","));
	check("the server is dropped before the await, so no window is opened against it", lifecycle.current === null);

	// 有人趁服务器还在下落时再问一次——操作系统，或是坚持要走的用户。那一次同样被扣下：它不是
	// 本模块自己的 quit，放它过去正是这套序列要防止的"拆到一半"。
	lifecycle.beforeQuit(held.event);
	check("a second quit during close() is held back as well", held.count === 2);
	check("and it did not start a second shutdown", events.filter((e) => e === "close").length === 1);
	check("nor let anything through", !events.includes("quit"), events.join(","));

	settle();
	check("the quit is asked for again once close() settles", await until(() => events.includes("quit")));
	check("exactly once", events.filter((e) => e === "quit").length === 1, events.join(","));
	check("and never before it settled", events.indexOf("quit") > events.indexOf("close-settled"), events.join(","));
	check("no failure was logged", logs.length === 0, logs.join(" | "));

	// 那次 quit 是本模块自己的，所以 Electron 重发的 `before-quit` 必须放行——否则应用程序
	// 永远真正离不开。
	lifecycle.beforeQuit(held.event);
	check("the module's own quit is not held back", held.count === 2, String(held.count));
	check("close() was called exactly once", events.filter((e) => e === "close").length === 1);
	check("quit was asked for exactly once", events.filter((e) => e === "quit").length === 1);
	check("and the budget never fired", !events.some((e) => e.startsWith("exit:")), events.join(","));
	check("the default budget is the one the boot smoke asserts against", SHUTDOWN_BUDGET_MS === 5_000, String(SHUTDOWN_BUDGET_MS));
}

// ------------------------------------------------------------------------------------------------
// 2. 一个会 reject 的 close() 仍然放进程走，并说出原因。
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a quit with a server that fails to close\n");
	const events: string[] = [];
	const logs: string[] = [];
	const lifecycle = createShutdown({ app: fakeApp(events), log: (line) => logs.push(line) });
	lifecycle.serve({
		url: "http://127.0.0.1:2",
		close: () => Promise.reject(new Error("the listener refused")),
	});

	const held = counter();
	lifecycle.beforeQuit(held.event);
	check("the first quit is held back", held.count === 1);
	check("the quit still arrives", await until(() => events.includes("quit")), events.join(","));
	check("it is not the give-up path", !events.some((e) => e.startsWith("exit:")), events.join(","));
	check(
		"the failure is logged with its reason",
		logs.length === 1 && (logs[0] ?? "").includes("the listener refused"),
		logs.join(" | "),
	);

	lifecycle.beforeQuit(held.event);
	check("the module's own quit is not held back", held.count === 1, String(held.count));
}

// ------------------------------------------------------------------------------------------------
// 3. 一个永不落定的 close() 在预算用尽后被放弃：一个关不上的应用程序，比一个跳过最后一次
//    写入的更糟。
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a quit with a server that never finishes closing\n");
	const events: string[] = [];
	const logs: string[] = [];
	let settle: () => void = () => {};
	const late = new Promise<void>((done) => {
		settle = done;
	});
	const lifecycle = createShutdown({ app: fakeApp(events), shutdownBudgetMs: 20, log: (line) => logs.push(line) });
	lifecycle.serve({ url: "http://127.0.0.1:3", close: () => late });

	const held = counter();
	const askedAt = Date.now();
	lifecycle.beforeQuit(held.event);
	check("the first quit is held back", held.count === 1);
	check("the shell gives up once the budget is spent", await until(() => events.includes("exit:0")), events.join(","));
	const waited = Date.now() - askedAt;
	check("and does not quit through a sequence that is stuck", !events.includes("quit"), events.join(","));
	check(
		"the give-up is logged as such",
		logs.length === 1 && (logs[0] ?? "").includes("did not finish closing"),
		logs.join(" | "),
	);
	// 交给它的预算——20 ms——就是它用的那个：默认预算不会在上面的等待窗口内触发，而把默认值
	// 等完不是 smoke 会做的事。
	check("it waited the budget it was given, not the default", waited >= 20 && waited < 1_000, `${waited} ms`);

	// 服务器在一个已经离开的外壳临走之际收尾，不得再请求 quit：这个问题要去的进程正是本模块
	// 刚刚送走的那个。
	settle();
	await new Promise((tick) => setImmediate(tick));
	check("a late close() does not ask for a quit", !events.includes("quit"), events.join(","));
}

// ------------------------------------------------------------------------------------------------
// 4. 还没有服务器服务过：quit 不关任何人的事，甚至不被扣下。
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a quit before the server exists\n");
	const events: string[] = [];
	const lifecycle = createShutdown({ app: fakeApp(events), log: () => {} });
	const held = counter();
	lifecycle.beforeQuit(held.event);
	check("the quit is not held back", held.count === 0);
	check("nothing was quit or closed on its account", events.length === 0, events.join(","));
}

// 自然退出 watchdog，文件里最后一件事：上面每个用例都已拆除，事件循环应当排空、本进程应当
// 离开——赶在这个不占用循环的 unref 定时器触发之前。它若触发，说明某个 shutdown 预算还挂着，
// 或者别的什么东西还握着句柄；两者都是失败。
setTimeout(() => {
	process.stdout.write("\nFAIL the process did not exit on its own — a handle was left behind\n");
	process.exit(1);
}, 1_500).unref();

process.stdout.write(failures === 0 ? "\ndesktop close ok\n" : `\n${failures} failure(s)\n`);
process.exitCode = failures === 0 ? 0 : 1;
