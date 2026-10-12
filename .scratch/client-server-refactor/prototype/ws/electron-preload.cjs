// 渲染器 ↔ 主进程的最小桥：只报结果，不做别的。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("probe", {
	report: (payload) => ipcRenderer.send("report", payload),
	done: (payload) => ipcRenderer.send("done", payload),
	onSummarize: (fn) => ipcRenderer.on("summarize", () => fn()),
});
