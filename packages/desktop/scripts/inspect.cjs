// Inspect the running shell's DOM from the terminal.
//
// A screenshot shows what the window looks like; this shows what the client actually built and what
// the API actually answered, which is the difference that matters when a layout is right but the
// data behind it is not.
//
//   node scripts/inspect-app --theme dark|light --dev   (via the Electron binary)
const { app, BrowserWindow, ipcMain, nativeTheme } = require("electron");
const { existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const repositoryRoot = resolve(__dirname, "..", "..", "..");
const theme = process.env.INSPECT_THEME === "light" ? "light" : "dark";
let server = null;

/** Read a compact description of what the page has rendered. */
const DOM_REPORT = `(() => ({
	theme: document.documentElement.dataset.theme,
	caption: document.documentElement.dataset.desktopCaption,
	sidebarMode: document.getElementById("app")?.dataset.sidebar,
	heading: document.querySelector(".header-title h1")?.textContent,
	subtitle: document.querySelector(".header-subtitle")?.textContent,
	turnCount: document.querySelectorAll(".turn").length,
	toolGroups: document.querySelectorAll(".tool-group").length,
	turns: [...document.querySelectorAll(".turn")].map((t) => t.className + ": " + (t.querySelector(".turn-body")?.textContent ?? "").slice(0, 60)),
	activeIndex: [...document.querySelectorAll(".session-item")].findIndex((n) => n.getAttribute("aria-current") === "true"),
	itemCount: document.querySelectorAll(".session-item").length,
	directoryCount: document.querySelectorAll(".directory").length,
	directoryNames: [...document.querySelectorAll(".directory-name")].map((n) => n.textContent),
	status: document.querySelector(".status-bar")?.textContent,
	settingsEntry: document.querySelector(".settings-entry")?.textContent,
	modelNotice: document.querySelector(".notice-card .notice-text strong")?.textContent,
	sendColor: getComputedStyle(document.querySelector(".button.primary")).color,
	sendFill: getComputedStyle(document.querySelector(".button.primary")).backgroundColor,
	bodyBg: getComputedStyle(document.body).backgroundColor,
}))()`;

async function inspect() {
	ipcMain.on("desktop:theme:sync", (event) => {
		event.returnValue = theme === "dark";
	});
	nativeTheme.themeSource = theme;

	const entry = join(repositoryRoot, "packages", "server", "src", "boot.ts");
	if (!existsSync(entry)) throw new Error(`server entry missing at ${entry}`);
	const module = await import(pathToFileURL(entry).href);
	server = await module.bootServer({
		workDirAbsPath: repositoryRoot,
		host: "127.0.0.1",
		port: 0,
		vite: process.env.INSPECT_DEV === "1",
	});
	console.log(`server ${server.url}  pinned ${process.env.MY_AGENT_SESSION ?? "(unset)"}`);

	const window = new BrowserWindow({
		width: 1280,
		height: 820,
		show: false,
		webPreferences: {
			preload: join(repositoryRoot, "packages", "desktop", "preload.cjs"),
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});

	await window.loadURL(server.url);
	await new Promise((done) => setTimeout(done, 3000));

	console.log("dom: " + JSON.stringify(await window.webContents.executeJavaScript(DOM_REPORT), null, 2));

	// Switching sessions is the sidebar's whole job, so exercise it and confirm the conversation and
	// the highlight both move together.
	const switched = await window.webContents.executeJavaScript(`(async () => {
		const items = [...document.querySelectorAll(".session-item")];
		const target = items.find((n) => n.getAttribute("aria-current") !== "true");
		if (!target) return "only one session";
		const title = target.getAttribute("title").split("\\n")[0];
		target.click();
		await new Promise((done) => setTimeout(done, 2000));
		const active = document.querySelector('.session-item[aria-current="true"]');
		return {
			clicked: title,
			heading: document.querySelector(".header-title h1")?.textContent,
			activeTitle: active?.getAttribute("title")?.split("\\n")[0],
			turns: document.querySelectorAll(".turn").length,
		};
	})()`);
	console.log("switch: " + JSON.stringify(switched, null, 2));
}

app.whenReady()
	.then(inspect)
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await server?.close();
		app.quit();
	});
