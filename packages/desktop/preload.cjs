/**
 * preload 接缝。
 *
 * 渲染进程就是普通的 web client：它通过 HTTP 与服务器对话，不需要任何特权访问。页面自己无法得知
 * 的四件事——外壳的原生主题、标题栏归页面所有时如何绘制窗口控件、OS 自己的文件夹选择器（目录
 * 选择器的"添加目录…"把浏览交给系统对话框）、以及 UI 设置的持久化——在这里暴露，且仅此四件。
 * 没有文件系统读取、没有 shell、没有 IPC 透传。
 *
 * UI 设置走外壳而不是页面的 `localStorage`，因为外壳每次启动都换端口：`localStorage` 按 origin
 * 隔离，存在那里的偏好会在窗口换个端口重开的那一刻被忘掉。主进程把它们写进 Electron userData
 * 下的自己的文件（`ui-settings.json`），读写各一个 handler，页面只见一个普通对象。
 */
const { contextBridge, ipcRenderer } = require("electron");

/** 外壳是否处于深色主题，只读一次，让首次绘制就是正确的。 */
const dark = ipcRenderer.sendSync("desktop:theme:sync") === true;

contextBridge.exposeInMainWorld("desktop", {
	/** 外壳绘制的是哪种标题栏，页面据此预留正确的空间。 */
	platform: process.platform,
	/** 外壳的原生主题。它在场时页面不再询问 OS。 */
	theme: dark,
	window: {
		minimize: () => ipcRenderer.send("desktop:window", "minimize"),
		toggleMaximize: () => ipcRenderer.send("desktop:window", "toggle-maximize"),
		close: () => ipcRenderer.send("desktop:window", "close"),
		isMaximized: () => ipcRenderer.invoke("desktop:window:is-maximized"),
	},
	/**
	 * 系统文件夹选择器。resolve 为选中的绝对路径，取消对话框时为 undefined。
	 * 页面从不读文件系统；对话框就是全部的访问。
	 */
	pickFolder: () => ipcRenderer.invoke("desktop:pick-folder"),
	/** 页面的 UI 设置，主进程从 userData 的文件里读。文件缺失时为 null。 */
	readUiSettings: () => ipcRenderer.invoke("desktop:ui-settings:read"),
	/** 整份写回页面的 UI 设置；主进程原子落盘。 */
	writeUiSettings: (value) => ipcRenderer.invoke("desktop:ui-settings:write", value),
});
