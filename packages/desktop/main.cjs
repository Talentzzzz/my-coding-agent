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
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require("electron");
const { existsSync } = require("node:fs");
const { writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createObservability, LOAD_FAILED_HEADLINE } = require("./observability.cjs");
const { createShutdown } = require("./shutdown.cjs");

// This machine cannot run Chromium's accelerated/sandboxed child processes: the GPU process dies
// with 0xC0000005 in the driver path no matter the display mode (hybrid or discrete-only), and the
// renderer dies with 0x80000003 when Chromium's sandbox meets the launch environment's job object.
// Both switches are set before `app` is ready; a future machine with a healthy driver can delete
// these two lines to get hardware acceleration back. See 问题/启动.md for the full diagnosis.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");

/** Height of the Windows caption the shell draws, matched by --desktop-titlebar in the client. */
const TITLEBAR_HEIGHT = 40;

/**
 * The DSH palette's sidebar fill, so the native caption matches the page before it paints.
 *
 * The caption and the page's top band are one surface (`.titleband` takes `--dsw-bg-sidebar`, which
 * in the dark sheet is `neutral-bluish-900`, rgb(27,27,28), and in the light sheet
 * `neutral-bluish-60`, rgb(245,246,247)). This file cannot read a CSS custom property, so these two
 * hexes restate those tokens by hand — if `--dsw-bg-sidebar` ever moves, these move with it, or the
 * first paint flashes a band that disagrees with itself.
 */
const CHROME_LIGHT = "#f5f6f7";
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
		// The option is `absCwd` (BootOptions): the workspace the agent may touch, absolute.
		absCwd: cwd,
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

/**
 * The failure surface, wired once the two things it wraps exist: how a window is built, and how the
 * server is started. It lives in `observability.cjs` for the same reason the quit path lives in
 * `shutdown.cjs` — a smoke can drive the real handlers there with fakes, which it cannot do with
 * lines buried in this file.
 */
const observability = createObservability({
	app,
	createWindow,
	boot: bootServer,
});

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

	// The system folder picker, for the workspace picker's "添加工作区…". The browsing belongs to the
	// OS dialog and nothing else: the page learns the chosen path and reads no filesystem.
	ipcMain.handle("desktop:pick-folder", async (event) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		const answer = await dialog.showOpenDialog(window, {
			properties: ["openDirectory"],
		});
		return answer.canceled || answer.filePaths.length === 0 ? undefined : answer.filePaths[0];
	});
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
 * A page to load instead of the booted client, from `--load <url>`.
 *
 * The capture flags exist so a layout can be looked at from a terminal, and the pages worth looking
 * at are not only the app's own: a standalone HTML prototype is judged in a real window, at a real
 * size, under the real caption overlay. With this the server is not started at all, which is also
 * what keeps a capture of a prototype from touching an agent home.
 */
function loadTarget() {
	const url = flagValue("--load");
	if (url === undefined) return undefined;
	if (url.startsWith("http:") || url.startsWith("https:")) return url;
	// A query string is the prototype switcher's (`?variant=B`), so it is split off before the rest
	// is read as a path — `resolve()` would otherwise fold `?...` into the filename.
	const query = url.search(/[?#]/);
	const path = query === -1 ? url : url.slice(0, query);
	return pathToFileURL(resolve(path)).href + (query === -1 ? "" : url.slice(query));
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

/**
 * Render a window against `page` and exit, for `--screenshot <file>`.
 *
 * With `--load` and no `--screenshot` there is nothing to wait for: the window stays up on the page,
 * which is how a prototype is opened in the real shell.
 *
 * `--click <selector>[,<selector>...]` opens whatever is behind a control before the capture.
 * Without it a panel, a menu, or a dialog is the one part of the window a capture can never show;
 * with several selectors a capture can reach something nested, in order.
 */
async function capture(page, file) {
	mainWindow = createWindow();
	syncChrome(mainWindow);
	await mainWindow.loadURL(page);
	if (file === undefined) return;
	await new Promise((done) => setTimeout(done, 2500));
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
	await writeFile(file, image.toPNG());
	console.log(`desktop: wrote ${file} (${image.getSize().width}x${image.getSize().height})`);
	app.quit();
}

app.whenReady().then(async () => {
	applyThemeOverride();
	registerWindowControls();
	// The signals a shell cannot prevent but must not swallow: a child process going away (the GPU
	// one first, on the machine this exists for), a renderer going away, and an exception nobody
	// caught. Wired as soon as the application is ready, before the server is asked for anything, so
	// a failure during boot is already being watched for.
	observability.watch();

	// A page pointed at by hand, and a capture of one, are both the booted client's opposite: they
	// want a window and nothing else, so neither starts the server. A failure here has no server
	// behind it to report through, so it is reported the plain way — and the app still exits, or a
	// capture run would sit on a window nobody asked for.
	const loaded = loadTarget();
	const shot = screenshotPath();
	if (loaded !== undefined || shot !== undefined) {
		try {
			await capture(loaded ?? `about:blank`, shot);
		} catch (error) {
			process.stderr.write(`desktop: capture failed: ${error?.message ?? error}\n`);
			app.exit(1);
		}
		return;
	}

	const cwd = workspaceDirectory();
	const booted = await observability.bootWithinBudget(cwd);
	if (booted === null) return;
	console.log(`desktop: server on ${booted.url}  workspace ${cwd}`);
	lifecycle.serve(booted);

	mainWindow = createWindow();
	syncChrome(mainWindow);
	nativeTheme.on("updated", () => {
		if (mainWindow && !mainWindow.isDestroyed()) syncChrome(mainWindow);
	});

	// The load that the machine this exists for used to fail: the GPU process dies, the browser
	// process goes with it, and the navigation comes back as `ERR_FAILED` — with the window already
	// created and no window ever shown. Caught, it is a report instead of a launch that did nothing.
	try {
		await mainWindow.loadURL(booted.url);
	} catch (error) {
		observability.report(LOAD_FAILED_HEADLINE, error);
		return;
	}

	app.on("activate", () => {
		// macOS keeps the application alive with no windows; the Dock icon is how it comes back.
		const live = lifecycle.current;
		if (BrowserWindow.getAllWindows().length === 0 && live !== null) {
			mainWindow = createWindow();
			void mainWindow.loadURL(live.url).catch((error) => {
				observability.report(LOAD_FAILED_HEADLINE, error);
			});
		}
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

// Putting the server down is an ordering question rather than a formality, and the resident
// connection is why; `shutdown.cjs` is where that lives, comment and all.
app.on("before-quit", (event) => lifecycle.beforeQuit(event));
