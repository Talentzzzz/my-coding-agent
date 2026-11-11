/**
 * 桌面外壳。
 *
 * 这里是字面意义上的壳：它启动与 CLI 相同的 HTTP 服务器，然后把一个窗口指向它。API、会话模型、client 都不因为运行在窗口而不是 tab 里而改变——正是这一点让产品只有一份实现而不是两份。
 *
 * 用普通 CommonJS，因为这是任何工具链运行之前 Electron 加载的格式：下面的 server 是本仓库的 TypeScript，由 Node 自己的类型剥离执行。
 */
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require("electron");
const { existsSync } = require("node:fs");
const { writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createObservability, LOAD_FAILED_HEADLINE } = require("./observability.cjs");
const { createShutdown } = require("./shutdown.cjs");

// 这台机器跑不了 Chromium 的加速/沙箱子进程：无论显示模式如何（混合或仅独显），GPU 进程都在驱动的调用路径上死于 0xC0000005；而 Chromium 的沙箱遇到启动环境的 job object 时，渲染进程死于 0x80000003。两个开关都在 `app` ready 之前设置；将来哪台机器驱动健康了，删掉这两行就能拿回硬件加速。完整诊断见 问题/启动.md。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");

/** 外壳绘制的 Windows 标题栏高度，与 client 的 --desktop-titlebar 对应。 */
const TITLEBAR_HEIGHT = 40;

/**
 * DSH 调色板中侧栏的填充色，让原生标题栏在页面绘制之前就与之一致。
 *
 * 标题栏与页面顶部是一条连续的表面（`.titleband` 取 `--dsw-bg-sidebar`，深色表中是 `neutral-bluish-900`，rgb(27,27,28)，浅色表中是 `neutral-bluish-60`，rgb(245,246,247)）。本文件读不到 CSS 自定义属性，所以这两个十六进制值手工复述那些 token——如果 `--dsw-bg-sidebar` 哪天变了，这两处必须跟着变，否则首次绘制会闪出一条自相矛盾的色带。
 */
const CHROME_LIGHT = "#f5f6f7";
const CHROME_DARK = "#1b1b1c";

let mainWindow = null;

/**
 * 服务器的生命周期，退出路径拥有它——为什么它单独成文件见 `shutdown.cjs`。
 *
 * 这也是窗口指向的东西，所以永远不会有一个窗口开向一个正在下行的服务器。
 */
const lifecycle = createShutdown({ app });

/** 仓库根目录：本文件位于 packages/desktop。 */
const packageRoot = resolve(__dirname, "..", "..");

/** 用户 `--workDir` 的选择在两次启动之间被记住的地方。 */
function statePath() {
	return join(app.getPath("userData"), "workdir.txt");
}

/**
 * agent 可以触碰的目录。
 *
 * `--workDir <dir>` 优先，其次是 `MY_AGENT_WORKDIR`（第二个启动器固定目录的方式），再次是应用自身 checkout 的父目录，最后是用户主目录。应用不是从一个带有效 workDirAbsPath 的 shell 启动的——快捷方式没有——所以显式的答案是唯一可靠的一个。
 */
function defaultWorkDir() {
	const flag = process.argv.indexOf("--workDir");
	if (flag !== -1 && process.argv[flag + 1]) return resolve(process.argv[flag + 1]);
	if (process.env.MY_AGENT_WORKDIR) return resolve(process.env.MY_AGENT_WORKDIR);
	return packageRoot;
}

/**
 * 经 Node 的类型剥离加载服务器的 TypeScript 入口。
 *
 * 子进程需要自己的一套崩溃和 shutdown 监管；在进程内 import 意味着只有一个生命周期要管理，而且 `close()` 与 CLI 的信号处理调用的是同一个。
 */
async function bootServer(workDirAbsPath) {
	const entry = join(packageRoot, "packages", "server", "src", "boot.ts");
	if (!existsSync(entry)) {
		throw new Error(`The server entry is missing at ${entry}. This shell must run from the repository.`);
	}
	const module = await import(pathToFileURL(entry).href);
	return module.bootServer({
		// 选项名是 `workDirAbsPath`（BootOptions）：新会话起步的目录，绝对路径。
		workDirAbsPath,
		host: "127.0.0.1",
		// 端口 0：由操作系统挑一个空闲的，第二次启动永远不会撞上第一次，也不用预先保留一个固定数字。
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
		// 标题栏由页面绘制，应用才能把自己的调色板带进去。Windows 和 macOS 用原生控件叠加；Linux 保留自己的边框，而不是丢掉它没有办法重绘的窗口控件。
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

	// transcript 里的链接在系统浏览器打开，用户的会话和书签都在那里；应用窗口留给对话本身。
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("http:") || url.startsWith("https:")) void shell.openExternal(url);
		return { action: "deny" };
	});

	window.once("ready-to-show", () => window.show());
	return window;
}

/**
 * 失败面，在它包裹的两样东西存在之后接线：窗口怎么建、服务器怎么启。它住在 `observability.cjs` 的理由与退出路径住在 `shutdown.cjs` 相同——smoke 可以在那里用假件驱动真实的 handler，而埋在本文件里的代码行做不到。
 */
const observability = createObservability({
	app,
	createWindow,
	boot: bootServer,
});

/** 让原生标题栏的颜色跟上页面实际使用的调色板。 */
function syncChrome(window) {
	if (process.platform !== "win32") return;
	window.setTitleBarOverlay({
		height: TITLEBAR_HEIGHT,
		color: nativeTheme.shouldUseDarkColors ? CHROME_DARK : CHROME_LIGHT,
		symbolColor: nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0f1115",
	});
}

function registerWindowControls() {
	// preload 同步读这个，让首次绘制就带上正确的主题；这个 handler 只做一次内存读取，不碰磁盘也不碰网络。
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

	// 系统的文件夹选择器，供目录选择器的"添加目录…"使用。浏览行为属于 OS 对话框、且仅属于它：页面只拿到选中的路径，不读任何文件系统。
	ipcMain.handle("desktop:pick-folder", async (event) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		const answer = await dialog.showOpenDialog(window, {
			properties: ["openDirectory"],
		});
		return answer.canceled || answer.filePaths.length === 0 ? undefined : answer.filePaths[0];
	});
}

/** `--screenshot <file>` 的写入目标，普通启动时为 undefined。 */
function screenshotPath() {
	const flag = process.argv.indexOf("--screenshot");
	if (flag === -1) return undefined;
	return resolve(process.argv[flag + 1] ?? "ui.png");
}

/** `--name <value>` 标志后面的值，标志缺席时为 undefined。 */
function flagValue(name) {
	const flag = process.argv.indexOf(name);
	if (flag === -1) return undefined;
	return process.argv[flag + 1];
}

/**
 * 用 `--load <url>` 加载一个页面，替代启动好的 client。
 *
 * 这些采集标志存在，是为了能从终端审视一个布局，而值得审视的页面不只是应用自己的：一个独立的 HTML 原型也应在真实窗口、真实尺寸、真实的标题栏叠加之下接受评判。带上这个标志服务器完全不启动，这也让对原型的采集不会碰到任何 agent home。
 */
function loadTarget() {
	const url = flagValue("--load");
	if (url === undefined) return undefined;
	if (url.startsWith("http:") || url.startsWith("https:")) return url;
	// query string 是原型切换器的（`?variant=B`），所以先把它切掉再把其余部分当作路径读取——否则 `resolve()` 会把 `?...` 折进文件名。
	const query = url.search(/[?#]/);
	const path = query === -1 ? url : url.slice(0, query);
	return pathToFileURL(resolve(path)).href + (query === -1 ? "" : url.slice(query));
}

/**
 * 把 `--theme dark|light` 应用到外壳的原生主题。
 *
 * 页面跟随 `nativeTheme`，所以这也决定了渲染进程的调色板：一个主题来源，而不是一个让标题栏与之相左的页面级覆盖。
 */
function applyThemeOverride() {
	const flag = process.argv.indexOf("--theme");
	const value = flag === -1 ? undefined : process.argv[flag + 1];
	if (value === "dark") nativeTheme.themeSource = "dark";
	else if (value === "light") nativeTheme.themeSource = "light";
}

/**
 * 针对 `page` 渲染一个窗口然后退出，供 `--screenshot <file>` 使用。
 *
 * 带 `--load` 而无 `--screenshot` 时没有什么可等的：窗口停在页面上，原型就是这样在外壳里被打开的。
 *
 * `--click <selector>[,<selector>...]` 在采集之前打开控件背后的东西。没有它，面板、菜单或对话框就是采集永远拍不到的那部分；多个选择器让采集能按顺序够到嵌套的东西。
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
	// 外壳无法阻止、但绝不能吞掉的信号：子进程消失（在本文件为之存在的那台机器上，GPU 进程先走）、渲染进程消失、以及没人捕获的异常。应用一 ready 就接线，在向服务器提任何要求之前，所以 boot 期间的失败已经处于监视之下。
	observability.watch();

	// 手工指向的页面、以及对它的采集，都是已启动 client 的反面：它们只要一个窗口、别的什么都不要，所以都不启动服务器。这里的失败没有服务器可供上报，所以按朴素的方式上报——而且应用仍然退出，否则一次采集运行会停在一个没人要的窗口上。
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

	const workDirAbsPath = defaultWorkDir();
	const booted = await observability.bootWithinBudget(workDirAbsPath);
	if (booted === null) return;
	console.log(`desktop: server on ${booted.url}  workDir ${workDirAbsPath}`);
	lifecycle.serve(booted);

	mainWindow = createWindow();
	syncChrome(mainWindow);
	nativeTheme.on("updated", () => {
		if (mainWindow && !mainWindow.isDestroyed()) syncChrome(mainWindow);
	});

	// 这台机器曾注定失败的那次加载：GPU 进程死掉、浏览器进程随之而去、导航以 `ERR_FAILED` 返回——窗口已经创建、却永远没有显示。被捕获后，它变成一份报告，而不是一次什么都没发生的启动。
	try {
		await mainWindow.loadURL(booted.url);
	} catch (error) {
		observability.report(LOAD_FAILED_HEADLINE, error);
		return;
	}

	app.on("activate", () => {
		// macOS 在没有任何窗口时保持应用存活；Dock 图标是它回来的方式。
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

// 把服务器放下来是一个顺序问题而不是走过场，常驻连接就是原因；`shutdown.cjs` 是这件事连同注释一起住的地方。
app.on("before-quit", (event) => lifecycle.beforeQuit(event));
