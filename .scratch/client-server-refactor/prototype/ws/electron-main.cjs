// 票 17 的 Electron 装置（主进程）。不 require 本仓库任何代码。
// 环境变量：WS_PORT / SCENARIO / OUT_DIR / DURATION_MS / VISIBLE_MS / CONNS / THROTTLING / SHOW
const { app, BrowserWindow, ipcMain } = require("electron");
const { appendFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const OUT = process.env.OUT_DIR ?? __dirname;
const SCENARIO = process.env.SCENARIO ?? "close-codes";
const DURATION_MS = Number(process.env.DURATION_MS ?? "6000");
const VISIBLE_MS = Number(process.env.VISIBLE_MS ?? "3000");
const THROTTLING = (process.env.THROTTLING ?? "true") === "true";
const SHOW = (process.env.SHOW ?? "true") === "true";
const RENDERER_LOG = join(OUT, "renderer.log");

writeFileSync(RENDERER_LOG, "");
const write = (obj) => {
	const line = JSON.stringify({ t: Date.now() % 1000000, ...obj });
	appendFileSync(RENDERER_LOG, `${line}\n`);
	process.stdout.write(`${line}\n`);
};

write({ event: "main-start", electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node });

ipcMain.on("report", (_event, payload) => write({ from: "renderer", ...payload }));
ipcMain.on("done", (_event, payload) => {
	write({ from: "renderer", ...payload, event: "done" });
	app.quit();
});

app.whenReady().then(async () => {
	const win = new BrowserWindow({
		width: 900,
		height: 700,
		show: SHOW,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			backgroundThrottling: THROTTLING,
			preload: join(__dirname, "electron-preload.cjs"),
		},
	});
	win.webContents.on("console-message", (_e, _level, message) =>
		write({ event: "console", message: String(message).slice(0, 500) }),
	);
	win.webContents.on("render-process-gone", (_e, details) => write({ event: "render-gone", details }));
	await win.loadFile(join(__dirname, "renderer.html"), {
		query: {
			scenario: SCENARIO,
			port: process.env.WS_PORT ?? "0",
			port2: process.env.WS_PORT2 ?? "0",
			conns: process.env.CONNS ?? "0",
		},
	});
	if (!SHOW) write({ event: "window-hidden-at-start" });

	// 窗口状态的证据：visibilityState 到底是不是 hidden，以及为什么。
	const probeWindow = (tag) =>
		write({
			event: "window-state",
			tag,
			isVisible: win.isVisible(),
			isMinimized: win.isMinimized(),
			isFocused: win.isFocused(),
			isAlwaysOnTop: win.isAlwaysOnTop(),
			backgroundThrottling: THROTTLING,
			displays: require("electron").screen.getAllDisplays().length,
		});
	probeWindow("after-load");
	win.show();
	win.focus();
	win.moveTop();
	setTimeout(() => probeWindow("after-show-focus"), 500);

	if (SCENARIO === "throttle") {
		// 三段：可见 → 隐藏 → 最小化 → 恢复可见
		setTimeout(() => {
			win.hide();
			write({ event: "window.hide" });
		}, VISIBLE_MS);
		setTimeout(() => {
			win.show();
			win.minimize();
			write({ event: "window.minimize" });
		}, VISIBLE_MS + Math.round(DURATION_MS / 2));
		setTimeout(() => {
			win.restore();
			win.show();
			write({ event: "window.restore" });
		}, VISIBLE_MS + DURATION_MS - 2000);
		setTimeout(() => {
			win.webContents.send("summarize");
		}, VISIBLE_MS + DURATION_MS);
	}

	const watchdog = setTimeout(() => {
		write({ event: "watchdog-timeout" });
		app.exit(3);
	}, VISIBLE_MS + DURATION_MS + 20000);
	watchdog.unref?.();
	ipcMain.once("done", () => clearTimeout(watchdog));
});
