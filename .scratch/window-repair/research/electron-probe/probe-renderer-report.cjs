// Throwaway probe for ticket 01's question: when a renderer has died, which report surface can
// still draw — the inline `data:` page, or only the native dialog?
//
// Electron loads a *directory* whose `package.json` names a `main`, so this probe needs a shim: copy
// `package-renderer-report.json` to `probe-renderer-report/package.json` with
// `"main": "../probe-renderer-report.cjs"`, then run
//
//   <electron.exe> .scratch/window-repair/research/electron-probe/probe-renderer-report
//
// Not a checked-in smoke: it needs Electron, a window, and the ability to kill a renderer, and its
// answer is a fact recorded in the ticket rather than a regression to guard.
const { app, BrowserWindow, dialog } = require("electron");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("in-process-gpu");
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

const say = (line) => process.stdout.write(`probe: ${line}\n`);

function dataPage(text) {
	return (
		"data:text/html;charset=utf-8," +
		encodeURIComponent(
			`<!doctype html><meta charset="utf-8"><title>probe</title><body style="font:14px/1.6 system-ui;background:#151517;color:#e9ecf2;padding:2rem"><h1 style="font-size:16px">${text}</h1></body>`,
		)
	);
}

app.whenReady().then(async () => {
	const window = new BrowserWindow({ width: 900, height: 600, show: true });
	const wc = window.webContents;
	const gone = [];
	wc.on("render-process-gone", (_event, details) => {
		gone.push(details);
		say(`render-process-gone ${JSON.stringify(details)}`);
	});

	await window.loadURL(dataPage("first renderer"));
	say("the first data page drew");

	say("crashing the renderer");
	wc.forcefullyCrashRenderer();

	// Give the crash a moment to land and Electron its moment to decide what to do about it.
	await new Promise((done) => setTimeout(done, 1500));
	say(`main process is alive; webContents destroyed=${wc.isDestroyed()} crashing=${wc.isCrashed()}`);

	say("step 1: can the inline data: page draw in the renderer that replaced the dead one?");
	try {
		await Promise.race([
			window.loadURL(dataPage("report after a renderer crash")),
			new Promise((_done, fail) => setTimeout(() => fail(new Error("loadURL did not settle within 5 s")), 5_000)),
		]);
		const title = await Promise.race([
			wc.executeJavaScript("document.querySelector('h1')?.textContent ?? '(no heading)'"),
			new Promise((done) => setTimeout(() => done("(executeJavaScript never answered)"), 5_000)),
		]);
		say(`step 1 result: loadURL settled, the page says: ${title}`);
	} catch (error) {
		say(`step 1 result: ${error instanceof Error ? error.message : String(error)}`);
	}

	say("step 2: what does executeJavaScript say about the current document?");
	try {
		const report = await wc.executeJavaScript(
			"({ url: location.href.slice(0, 40), text: document.body?.innerText?.slice(0, 60) ?? '(no body)' })",
		);
		say(`step 2 result: ${JSON.stringify(report)}`);
	} catch (error) {
		say(`step 2 result: ${error instanceof Error ? error.message : String(error)}`);
	}

	say("step 3: is a native dialog available with a window whose renderer is dead?");
	try {
		// Non-blocking on purpose: `showErrorBox` would hold the process until somebody clicks it, and
		// nobody is here to click. The question is only whether the native path works at all now.
		await Promise.race([
			dialog.showMessageBox(window, { type: "error", title: "probe", message: "native dialog after a renderer crash" }),
			new Promise((_done, fail) => setTimeout(() => fail(new Error("showMessageBox did not settle within 5 s")), 5_000)),
		]);
		say("step 3 result: the native dialog opened and answered");
	} catch (error) {
		say(`step 3 result: ${error instanceof Error ? error.message : String(error)}`);
	}

	say(`gone events: ${JSON.stringify(gone)}`);
	app.exit(0);
});
