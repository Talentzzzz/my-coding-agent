// The desktop shell's quit path: the server is put down before the process is allowed to go.
//
//   node scripts/smoke-desktop-close.mjs
//
// Why this can be a smoke at all: `packages/desktop/shutdown.cjs` takes the Electron application as
// an argument and calls exactly two things on it (`quit` and `exit`), so the real sequence can be
// driven here with a fake that records what it was asked to do. A copy of the sequence rewritten in
// this file would prove nothing, which is why the module exists as a module.
//
// What is being pinned is the order the resident connection makes matter: Electron's quit does not
// wait for a promise, so the shell holds the first quit back, waits for `close()`, and asks again —
// and the process must never be allowed to go before `close()` settles, must never be unable to go
// because a `close()` misbehaved, and must never start a second shutdown.
//
// The wall-clock half: the give-up path is driven with a millisecond budget (the default is the
// boot smoke's own 5 s, which is what `smoke-boot.ts` asserts `close()` returns inside), and the
// script ends by itself — nothing may be left holding the loop open, or the unref'd watchdog at the
// bottom fires and fails the run. An explicit `process.exit` would mask exactly that.
import { createShutdown, SHUTDOWN_BUDGET_MS } from "../packages/desktop/shutdown.cjs";

let failures = 0;

function check(label, condition, detail = "") {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/** Wait for a condition without sleeping a fixed amount; the timeout is the failure signal. */
async function until(condition, ms = 1_000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((done) => setTimeout(done, 5));
	}
	return condition();
}

/** A fake Electron application, recording what it was asked for in order. */
function fakeApp(events) {
	return {
		quit: () => events.push("quit"),
		exit: (code) => events.push(`exit:${code}`),
	};
}

const started = Date.now();

// ------------------------------------------------------------------------------------------------
// 1. The order: close() first, quit after — and the second quit passes through.
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a quit with a server that closes\n");
	const events = [];
	const logs = [];
	let settle;
	const closed = new Promise((done) => {
		settle = done;
	});
	const lifecycle = createShutdown({ app: fakeApp(events), log: (line) => logs.push(line) });
	lifecycle.serve({
		url: "http://127.0.0.1:1",
		close: () => {
			events.push("close");
			return closed.then(() => events.push("close-settled"));
		},
	});

	let prevented = 0;
	lifecycle.beforeQuit({ preventDefault: () => (prevented += 1) });
	check("the first quit is held back", prevented === 1);
	check("close() was called", events.includes("close"));
	check("nothing has quit while close() is still running", !events.includes("quit"), events.join(","));
	check("the server is dropped before the await, so no window is opened against it", lifecycle.current === null);
	check("and the shutdown reads as in flight", lifecycle.inFlight === true);

	settle();
	await until(() => events.includes("quit"));
	check("the quit is asked for again once close() settles", events.filter((e) => e === "quit").length === 1);
	check(
		"and never before it settled",
		events.indexOf("quit") > events.indexOf("close-settled"),
		events.join(","),
	);
	check("no failure was logged", logs.length === 0, logs.join(" | "));

	// The re-entry: `app.quit()` above is what Electron turns back into a `before-quit`, and that
	// one has to go straight through — otherwise the application could never actually leave.
	let again = 0;
	lifecycle.beforeQuit({ preventDefault: () => (again += 1) });
	check("the re-entrant quit is not held back", again === 0);
	check("close() was called exactly once", events.filter((e) => e === "close").length === 1);
	check("quit was asked for exactly once", events.filter((e) => e === "quit").length === 1);
	check("and the budget never fired", !events.some((e) => e.startsWith("exit:")), events.join(","));

	// A millisecond budget would have been visible by now; the default one must have been cleared,
	// or the watchdog at the bottom of this file will say so.
	check("the default budget is the one the boot smoke asserts against", SHUTDOWN_BUDGET_MS === 5_000, String(SHUTDOWN_BUDGET_MS));
}

// ------------------------------------------------------------------------------------------------
// 2. A close() that rejects still lets the process go, and says why.
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a quit with a server that fails to close\n");
	const events = [];
	const logs = [];
	const lifecycle = createShutdown({ app: fakeApp(events), log: (line) => logs.push(line) });
	lifecycle.serve({
		url: "http://127.0.0.1:2",
		close: () => Promise.reject(new Error("the listener refused")),
	});

	let prevented = 0;
	lifecycle.beforeQuit({ preventDefault: () => (prevented += 1) });
	check("the first quit is held back", prevented === 1);
	check("the quit still arrives", await until(() => events.includes("quit")), events.join(","));
	check("it is not the give-up path", !events.some((e) => e.startsWith("exit:")), events.join(","));
	check(
		"the failure is logged with its reason",
		logs.length === 1 && logs[0].includes("the listener refused"),
		logs.join(" | "),
	);

	let again = 0;
	lifecycle.beforeQuit({ preventDefault: () => (again += 1) });
	check("the re-entrant quit is not held back", again === 0);
}

// ------------------------------------------------------------------------------------------------
// 3. A close() that never settles is abandoned after the budget: an application that cannot be
//    closed is a worse outcome than one that skips its last write.
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a quit with a server that never finishes closing\n");
	const events = [];
	const logs = [];
	const lifecycle = createShutdown({ app: fakeApp(events), shutdownBudgetMs: 20, log: (line) => logs.push(line) });
	lifecycle.serve({ url: "http://127.0.0.1:3", close: () => new Promise(() => {}) });

	let prevented = 0;
	const askedAt = Date.now();
	lifecycle.beforeQuit({ preventDefault: () => (prevented += 1) });
	check("the first quit is held back", prevented === 1);
	check("the shell gives up once the budget is spent", await until(() => events.includes("exit:0")), events.join(","));
	const waited = Date.now() - askedAt;
	check("and does not quit through a sequence that is stuck", !events.includes("quit"), events.join(","));
	check(
		"the give-up is logged as such",
		logs.length === 1 && logs[0].includes("did not finish closing"),
		logs.join(" | "),
	);
	// The budget it was handed — 20 ms — is the one it used: the default would not have fired inside
	// the second `until` above allowed, and waiting the default out is not something a smoke does.
	check("it waited the budget it was given, not the default", waited >= 20 && waited < 1_000, `${waited} ms`);
}

// ------------------------------------------------------------------------------------------------
// 4. No server served yet: a quit is nobody's business, so it is not even held back.
// ------------------------------------------------------------------------------------------------
{
	process.stdout.write("a quit before the server exists\n");
	const events = [];
	const lifecycle = createShutdown({ app: fakeApp(events), log: () => {} });
	let prevented = 0;
	lifecycle.beforeQuit({ preventDefault: () => (prevented += 1) });
	check("the quit is not held back", prevented === 0);
	check("nothing was quit or closed on its account", events.length === 0, events.join(","));
	check("and no shutdown was started", lifecycle.inFlight === false);
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
