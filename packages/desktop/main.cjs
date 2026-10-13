/**
 * The desktop shell.
 *
 * This is a shell in the literal sense: it starts the same HTTP server the CLI starts, then points a
 * window at it. Nothing about the API, the session model, or the client changes because it is
 * running in a window instead of a tab — which is what keeps one implementation of the product
 * rather than two.
 *
 * It is plain CommonJS because that is what Electron loads before any toolchain runs: the server
 * below is the workspace's TypeScript, executed by Node's own type stripping.
 */
const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require("electron");
const { existsSync } = require("node:fs");
const { writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createShutdown } = require("./shutdown.cjs");

/** Height of the Windows caption the shell draws, matched by --desktop-titlebar in the client. */
const TITLEBAR_HEIGHT = 40;

/** The DSH palette's sidebar fill, so the native caption matches the page before it paints. */
const CHROME_LIGHT = "#f9fafb";
const CHROME_DARK = "#1b1b1c";

let mainWindow = null;

/**
 * The server's lifetime, which the quit path owns — see `shutdown.cjs` for why it is its own file.
 *
 * This is also what the window is pointed at, so a window is never opened against a server that is
 * on its way down.
 */
const lifecycle = createShutdown({ app });

/** The repository root: this file lives in packages/desktop. */
const packageRoot = resolve(__dirname, "..", "..");

/** Where a user's `--workspace` choice is remembered between launches. */
function statePath() {
	return join(app.getPath("userData"), "workspace.txt");
}

/**
 * Which directory the agent may touch.
 *
 * `--workspace <dir>` wins, then `MY_AGENT_WORKSPACE` (how a second launcher pins one), then the
 * parent of the app's own checkout, then the home directory. The app is not started from a shell
 * with a meaningful cwd — a shortcut has none — so an explicit answer is the only reliable one.
 */
function workspaceDirectory() {
	const flag = process.argv.indexOf("--workspace");
	if (flag !== -1 && process.argv[flag + 1]) return resolve(process.argv[flag + 1]);
	if (process.env.MY_AGENT_WORKSPACE) return resolve(process.env.MY_AGENT_WORKSPACE);
	return packageRoot;
}

/**
 * Load the server's TypeScript entry through Node's type stripping.
 *
 * A subprocess would need its own supervisor for crashes and shutdown; importing it in-process means
 * one lifetime to manage, and `close()` is the same call the CLI's signal handler makes.
 */
async function bootServer(cwd) {
	const entry = join(packageRoot, "packages", "server", "src", "boot.ts");
	if (!existsSync(entry)) {
		throw new Error(`The server entry is missing at ${entry}. This shell must run from the repository.`);
	}
	const module = await import(pathToFileURL(entry).href);
	return module.bootServer({
		cwd,
		host: "127.0.0.1",
		// Port 0: the operating system picks a free one, so a second launch never collides with the
		// first and a fixed number never has to be reserved.
		port: 0,
		vite: process.argv.includes("--dev"),
	});
}

function createWindow() {
	const window = new BrowserWindow({
		width: 1280,
		height: 820,
		minWidth: 720,
		minHeight: 520,
		show: false,
		backgroundColor: nativeTheme.shouldUseDarkColors ? CHROME_DARK : CHROME_LIGHT,
		// The caption is drawn by the page, so the app can carry its own palette into it. Windows and
		// macOS get their native controls overlaid; Linux keeps its own frame rather than losing
		// window controls it has no way to redraw.
		...(process.platform === "win32"
			? {
					titleBarStyle: "hidden",
					titleBarOverlay: {
						height: TITLEBAR_HEIGHT,
						color: nativeTheme.shouldUseDarkColors ? CHROME_DARK : CHROME_LIGHT,
						symbolColor: nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0f1115",
					},
				}
			: {}),
		...(process.platform === "darwin"
			? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 14 } }
			: {}),
		webPreferences: {
			preload: join(__dirname, "preload.cjs"),
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			webSecurity: true,
		},
	});

	// A link in a transcript opens in the system browser, which is where the user's session and
	// bookmarks are; the application window is for the conversation.
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("http:") || url.startsWith("https:")) void shell.openExternal(url);
		return { action: "deny" };
	});

	window.once("ready-to-show", () => window.show());
	return window;
}

/** Keep the native caption's colors on the palette the page is actually using. */
function syncChrome(window) {
	if (process.platform !== "win32") return;
	window.setTitleBarOverlay({
		height: TITLEBAR_HEIGHT,
		color: nativeTheme.shouldUseDarkColors ? CHROME_DARK : CHROME_LIGHT,
		symbolColor: nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0f1115",
	});
}

function registerWindowControls() {
	// The preload reads this synchronously so the first paint already has the right theme; the handler
	// does one in-memory read and never touches disk or the network.
	ipcMain.on("desktop:theme:sync", (event) => {
		event.returnValue = nativeTheme.shouldUseDarkColors;
	});

	ipcMain.on("desktop:window", (event, command) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window) return;
		if (command === "minimize") window.minimize();
		else if (command === "toggle-maximize") {
			if (window.isMaximized()) window.unmaximize();
			else window.maximize();
		} else if (command === "close") window.close();
	});

	ipcMain.handle("desktop:window:is-maximized", (event) => {
		return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
	});
}

/** Turn a failure on the way up into something a user can act on, rather than a blank window. */
function reportStartupFailure(error) {
	const message = error instanceof Error ? error.message : String(error);
	const detail = error instanceof Error && error.stack ? `\n\n${error.stack}` : "";
	console.error("desktop: startup failed", error);
	const window = createWindow();
	window.once("ready-to-show", () => window.show());
	void window.loadURL(
		"data:text/html;charset=utf-8," +
			encodeURIComponent(
				`<!doctype html><meta charset="utf-8"><title>my-coding-agent</title>` +
					`<body style="font:14px/1.6 system-ui;background:#151517;color:#e9ecf2;padding:2rem">` +
					`<h1 style="font-size:16px">agent 服务没有启动起来</h1>` +
					`<pre style="white-space:pre-wrap;color:#f25a5a">${message.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}${detail
						.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))
						.slice(0, 4000)}</pre>`,
			),
	);
}

/** Where `--screenshot <file>` writes, or undefined for an ordinary launch. */
function screenshotPath() {
	const flag = process.argv.indexOf("--screenshot");
	if (flag === -1) return undefined;
	return resolve(process.argv[flag + 1] ?? "ui.png");
}

/** The value after a `--name <value>` flag, or undefined when the flag is absent. */
function flagValue(name) {
	const flag = process.argv.indexOf(name);
	if (flag === -1) return undefined;
	return process.argv[flag + 1];
}

/**
 * Apply `--theme dark|light` to the shell's native theme.
 *
 * The page follows `nativeTheme`, so this is also what decides the renderer's palette: one theme
 * source rather than a page-level override that the captions would then disagree with.
 */
function applyThemeOverride() {
	const flag = process.argv.indexOf("--theme");
	const value = flag === -1 ? undefined : process.argv[flag + 1];
	if (value === "dark") nativeTheme.themeSource = "dark";
	else if (value === "light") nativeTheme.themeSource = "light";
}

app.whenReady().then(async () => {
	applyThemeOverride();
	registerWindowControls();

	const cwd = workspaceDirectory();
	let booted;
	try {
		booted = await bootServer(cwd);
		console.log(`desktop: server on ${booted.url}  workspace ${cwd}`);
	} catch (error) {
		reportStartupFailure(error);
		return;
	}
	lifecycle.serve(booted);

	mainWindow = createWindow();
	syncChrome(mainWindow);
	nativeTheme.on("updated", () => {
		if (mainWindow && !mainWindow.isDestroyed()) syncChrome(mainWindow);
	});

	await mainWindow.loadURL(booted.url);

	// A capture run renders the real window and exits, so a layout change can be inspected from a
	// terminal instead of from a description of it.
	const shot = screenshotPath();
	if (shot) {
		await new Promise((done) => setTimeout(done, 2500));
		// `--click <selector>[,<selector>...]` opens whatever is behind a control before the capture.
		// Without it a panel, a menu, or a dialog is the one part of the window a capture can never
		// show; with several selectors a capture can reach something nested, in order.
		const click = flagValue("--click");
		if (click) {
			for (const selector of click.split(",")) {
				await mainWindow.webContents.executeJavaScript(
					`document.querySelector(${JSON.stringify(selector.trim())})?.click()`,
				);
				await new Promise((done) => setTimeout(done, 300));
			}
			await new Promise((done) => setTimeout(done, 500));
		}
		const image = await mainWindow.webContents.capturePage();
		await writeFile(shot, image.toPNG());
		console.log(`desktop: wrote ${shot} (${image.getSize().width}x${image.getSize().height})`);
		app.quit();
		return;
	}

	app.on("activate", () => {
		// macOS keeps the application alive with no windows; the Dock icon is how it comes back.
		const live = lifecycle.current;
		if (BrowserWindow.getAllWindows().length === 0 && live !== null) {
			mainWindow = createWindow();
			void mainWindow.loadURL(live.url);
		}
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

// Putting the server down is an ordering question rather than a formality, and the resident
// connection is why; `shutdown.cjs` is where that lives, comment and all.
app.on("before-quit", (event) => lifecycle.beforeQuit(event));
