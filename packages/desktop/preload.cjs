/**
 * The preload seam.
 *
 * The renderer is the ordinary web client: it talks to the server over HTTP and needs no privileged
 * access. Three things a page cannot learn for itself — the shell's native theme, how to draw window
 * controls when the caption belongs to the page, and the OS's own folder picker (the workspace picker's
 * "添加工作区…" hands the browsing to the system dialog, because the app itself does not browse the
 * filesystem) — are exposed here, and nothing else. No filesystem reads, no shell, no IPC passthrough.
 */
const { contextBridge, ipcRenderer } = require("electron");

/** Whether the shell is in its dark theme, read once so the first paint is already correct. */
const dark = ipcRenderer.sendSync("desktop:theme:sync") === true;

contextBridge.exposeInMainWorld("desktop", {
	/** Which caption the shell drew, so the page can reserve the right amount of room. */
	platform: process.platform,
	/** The shell's native theme. The page does not consult the OS when this is present. */
	theme: dark,
	window: {
		minimize: () => ipcRenderer.send("desktop:window", "minimize"),
		toggleMaximize: () => ipcRenderer.send("desktop:window", "toggle-maximize"),
		close: () => ipcRenderer.send("desktop:window", "close"),
		isMaximized: () => ipcRenderer.invoke("desktop:window:is-maximized"),
	},
	/**
	 * The system folder picker. Resolves the chosen absolute path, or undefined for a cancelled
	 * dialog. The page never reads the filesystem; the dialog is the whole of the access.
	 */
	pickFolder: () => ipcRenderer.invoke("desktop:pick-folder"),
});
