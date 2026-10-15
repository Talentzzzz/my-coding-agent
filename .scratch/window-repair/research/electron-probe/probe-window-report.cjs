// Real-window check of the shell's failure surface, driven through the real module.
//
// Electron loads a *directory* whose `package.json` names a `main`, so this probe needs a shim: copy
// `package-window-report.json` to `probe-window-report/package.json` with
// `"main": "../probe-window-report.cjs"`, then run
//
//   <electron.exe> .scratch/window-repair/research/electron-probe/probe-window-report
//
// The smoke drives `observability.cjs` with fakes, which cannot answer two things this probe can:
// that the real window really draws the report page, and that a genuinely killed child process or
// renderer arrives at the handlers with the fields the lines are built from. Throwaway: not part of
// the checked-in build, and read through a log file rather than through a terminal.
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { app, BrowserWindow } = require("electron");
const { createObservability } = require("../../../../packages/desktop/observability.cjs");

const LOG = join(__dirname, "probe-window-report.log");
const say = (line) => {
	appendFileSync(LOG, `probe: ${line}\n`);
	process.stdout.write(`probe: ${line}\n`);
};

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("in-process-gpu");
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

const logs = [];
let window = null;

const observability = createObservability({
	app,
	createWindow,
	boot: async () => ({ url: "http://127.0.0.1:1" }),
	log: (line) => {
		logs.push(line);
		say(`LOG ${line}`);
	},
	dialog: {
		showErrorBox: (title, content) => say(`DIALOG ${title} :: ${content.split("\n")[0]}`),
	},
});

function createWindow() {
	// `show: false`, exactly like the shell's own factory: the report path is the thing that has to
	// show the window itself, and a probe that starts with `show: true` would hide that.
	window = new BrowserWindow({
		width: 900,
		height: 600,
		show: false,
		webPreferences: { nodeIntegration: false, contextIsolation: true },
	});
	return window;
}

/** What the page in the given window currently says, read from the main process. */
async function pageReport(target) {
	if (target.isDestroyed()) return { heading: "(the window is gone)" };
	try {
		return await Promise.race([
			target.webContents.executeJavaScript(
				"({heading: document.querySelector('h1')?.textContent ?? '(no h1)', body: document.body?.innerText?.slice(0, 200) ?? '(no body)'})",
			),
			new Promise((done) => setTimeout(() => done({ heading: "(executeJavaScript never answered)" }), 5_000)),
		]);
	} catch (error) {
		return { heading: `(executeJavaScript threw: ${error instanceof Error ? error.message : String(error)})` };
	}
}

app.whenReady().then(async () => {
	observability.watch();

	// ---- 1. A boot that fails, reported through the real `report`, drawn in a real window. ----
	say("1: reporting a startup failure");
	const reportWindow = observability.report("agent 服务没有启动起来", new Error("the server entry is missing at C:\\nope\\boot.ts"));
	await new Promise((done) => setTimeout(done, 1_200));
	say(`1 result: visible=${reportWindow?.isVisible() ?? "n/a"} ${JSON.stringify(await pageReport(reportWindow ?? window))}`);

	// ---- 2. A renderer killed for real, through the real `render-process-gone` handler. ----
	say("2: crashing the renderer of the shell's own window");
	const own = BrowserWindow.getAllWindows().find((candidate) => candidate !== reportWindow) ?? window;
	own.webContents.forcefullyCrashRenderer();
	await new Promise((done) => setTimeout(done, 1_500));

	const afterCrash = BrowserWindow.getAllWindows().filter((candidate) => candidate !== own);
	if (afterCrash.length === 0) {
		say("2 result: no report window was opened");
	} else {
		await new Promise((done) => setTimeout(done, 1_200));
		const crashReport = afterCrash[afterCrash.length - 1];
		say(`2 result: a report window opened; visible=${crashReport.isVisible()} ${JSON.stringify(await pageReport(crashReport))}`);
	}
	say(`2 result: dialog calls so far: ${logs.filter((line) => line.includes("渲染进程")).length} line(s), the probe's dialog recorder saw: see DIALOG lines`);

	// ---- 3. A real child process killed, to see what the event actually carries. ----
	// Not the network service: killing that one takes the application with it, which would end the
	// probe before it could say what arrived. A utility process of the probe's own is a real child of
	// this application and nothing else depends on it.
	const { utilityProcess } = require("electron");
	const child = utilityProcess.fork(join(__dirname, "probe-child.cjs"));
	await new Promise((done) => child.once("spawn", done));
	say(`3: forked a child utility process, pid ${child.pid}`);
	child.kill();
	await new Promise((done) => setTimeout(done, 2_500));
	const killLines = logs.filter((line) => !line.includes("renderer"));
	say(`3 result: ${killLines.length} child line(s); last: ${killLines[killLines.length - 1] ?? "(none)"}`);
	say(`3 result: what the application reports about its own children: ${JSON.stringify(app.getAppMetrics().map((metric) => metric.type))}`);

	say(`all lines: ${JSON.stringify(logs, null, 1)}`);
	app.exit(0);
});
