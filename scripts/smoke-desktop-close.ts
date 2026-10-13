// The desktop shell's quit path: the server is put down before the process is allowed to go.
//
//   node scripts/smoke-desktop-close.ts
//
// Why this can be a smoke at all: `packages/desktop/shutdown.cjs` takes the Electron application as
// an argument and calls exactly two things on it (`quit` and `exit`), so the real sequence can be
// driven here with a fake that records what it was asked to do. A copy of the sequence rewritten in
// this file would prove nothing, which is why the sequence lives in a module. The module is CommonJS
// — that is what Electron loads — so it is pulled in through `createRequire`; everything else about
// this script is an ordinary TypeScript smoke.
//
// What is being pinned is the order the resident connection makes matter: Electron's quit does not
// wait for a promise, so the shell holds the first quit back, waits for `close()`, and asks again.
// The process must never go before `close()` settles — not for the first quit, and not for a second
// one somebody asks for while the server is still going down — must never be unable to go because a
// `close()` misbehaved, and must never start a second shutdown.
//
// The wall-clock half: the give-up path is driven with a millisecond budget (the default is the boot
// smoke's own 5 s, which is what `smoke-boot.ts` asserts `close()` returns inside), and the script
// ends by itself — nothing may be left holding the loop open, or the unref'd watchdog at the bottom
// fires and fails the run. An explicit `process.exit` would mask exactly that.
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

/** A fake Electron application, recording what it was asked for in order. */
function fakeApp(events: string[]): FakeApp {
	return {
		quit: () => events.push("quit"),
		exit: (code) => events.push(`exit:${code}`),
	};
}

/** Somewhere for `preventDefault` to land, counted. */
function counter(): { count: number; event: { preventDefault(): void } } {
	const state = { count: 0, event: { preventDefault: () => void (state.count += 1) } };
	return state;
}

// ------------------------------------------------------------------------------------------------
// 1. The order: close() first, quit after — and every quit that is not this module's own is held.
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

	// Somebody asks again while the server is still going down — the operating system, or the user
	// insisting. That one is held back too: it is not this module's own quit, and letting it through
	// is precisely the teardown-in-the-middle this sequence exists to prevent.
	lifecycle.beforeQuit(held.event);
	check("a second quit during close() is held back as well", held.count === 2);
	check("and it did not start a second shutdown", events.filter((e) => e === "close").length === 1);
	check("nor let anything through", !events.includes("quit"), events.join(","));

	settle();
	check("the quit is asked for again once close() settles", await until(() => events.includes("quit")));
	check("exactly once", events.filter((e) => e === "quit").length === 1, events.join(","));
	check("and never before it settled", events.indexOf("quit") > events.indexOf("close-settled"), events.join(","));
	check("no failure was logged", logs.length === 0, logs.join(" | "));

	// That quit is this module's own, so Electron's re-emission of `before-quit` has to go through —
	// otherwise the application could never actually leave.
	lifecycle.beforeQuit(held.event);
	check("the module's own quit is not held back", held.count === 2, String(held.count));
	check("close() was called exactly once", events.filter((e) => e === "close").length === 1);
	check("quit was asked for exactly once", events.filter((e) => e === "quit").length === 1);
	check("and the budget never fired", !events.some((e) => e.startsWith("exit:")), events.join(","));
	check("the default budget is the one the boot smoke asserts against", SHUTDOWN_BUDGET_MS === 5_000, String(SHUTDOWN_BUDGET_MS));
}

// ------------------------------------------------------------------------------------------------
// 2. A close() that rejects still lets the process go, and says why.
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
// 3. A close() that never settles is abandoned after the budget: an application that cannot be
//    closed is a worse outcome than one that skips its last write.
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
	// The budget it was handed — 20 ms — is the one it used: the default would not have fired inside
	// the wait above, and waiting the default out is not something a smoke does.
	check("it waited the budget it was given, not the default", waited >= 20 && waited < 1_000, `${waited} ms`);

	// The server finishing on its way out of a shell that has already left must not ask for a quit:
	// the process the question would go to is the one this module just sent away.
	settle();
	await new Promise((tick) => setImmediate(tick));
	check("a late close() does not ask for a quit", !events.includes("quit"), events.join(","));
}

// ------------------------------------------------------------------------------------------------
// 4. No server served yet: a quit is nobody's business, so it is not even held back.
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

// The natural-exit watchdog, last thing in the file: every case above has been torn down, so the
// loop should drain and this process should leave — before this unref'd timer, which does not hold
// the loop open, ever fires. If it fires, a shutdown budget was left armed, or something else is
// still holding a handle; both are failures.
setTimeout(() => {
	process.stdout.write("\nFAIL the process did not exit on its own — a handle was left behind\n");
	process.exit(1);
}, 1_500).unref();

process.stdout.write(failures === 0 ? "\ndesktop close ok\n" : `\n${failures} failure(s)\n`);
process.exitCode = failures === 0 ? 0 : 1;
