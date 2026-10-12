/**
 * Electron 侧的截图执行者：由 `scripts/snapshot.mjs` 用真二进制拉起。
 *
 * 它是 CommonJS，而仓库其余部分是纯 ESM——这是 Electron 逼出来的：入口脚本与 preload 在
 * `require("electron")` 可用的那一刻就要被加载，早于任何工具链。同目录的 `package.json` 是这条
 * 例外的书面记录。
 *
 * 它不启动服务器、也不加载项目的任何代码，只加载给它的那个 URL——所以它可以对着一个静态原型跑，
 * 也可以对着一个已经跑着的窗口跑。
 *
 * 参数走环境变量，不走命令行：给定一个"长得像 URL"的参数时，Electron 会把它当成一次深链接启动
 * 而不是一次普通运行，进程在加载本文件之前就退出（表现为没有输出、退出码非零）。值放在环境里
 * 就没有这个歧义。
 */
const { app, BrowserWindow } = require("electron");
const { writeFile } = require("node:fs/promises");
const { join } = require("node:path");

const url = process.env.SNAPSHOT_URL;
const out = process.env.SNAPSHOT_OUT;
const width = Number(process.env.SNAPSHOT_WIDTH ?? "1440");
const height = Number(process.env.SNAPSHOT_HEIGHT ?? "900");

if (!url || !out) {
	console.error("snapshot: SNAPSHOT_URL 与 SNAPSHOT_OUT 都是必需的");
	process.exit(2);
}

process.on("unhandledRejection", (error) => {
	console.error("snapshot: 未处理的失败", error);
	app.exit(1);
});

app.whenReady().then(async () => {
	const window = new BrowserWindow({
		width,
		height,
		show: false,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			webSecurity: true,
			preload: join(__dirname, "preload.cjs"),
		},
	});

	// 样式表没加载上时页面会是一片白，而那正是"看起来像成功了"的失败；把它说出来。
	window.webContents.on("did-fail-load", (_event, code, description) => {
		console.error(`snapshot: 页面加载失败 ${code} ${description}`);
	});
	// `SNAPSHOT_ERRORS=1` 把页面自己的报错带到终端：截图看得见"不对"，看不见"为什么"。
	if (process.env.SNAPSHOT_ERRORS === "1") {
		window.webContents.on("console-message", (event) => {
			console.error(`page[${event.level}]: ${event.message}`);
		});
	}

	// 用内容尺寸而不是窗口尺寸：窗口要减掉标题栏，两张不同平台的截图会因为边距不同而不可比。
	window.setContentSize(width, height);
	await window.loadURL(url);
	// 字体与布局落定，再抓一张。
	await new Promise((done) => setTimeout(done, 1200));

	// `SNAPSHOT_PROBE=1` 让页面报告自己的状态：截图看得见"不对"，看不见"为什么"。
	if (process.env.SNAPSHOT_PROBE === "1") {
		console.log(`probe: ${await window.webContents.executeJavaScript("window.__snapshotReport()")}`);
	}

	const image = await window.webContents.capturePage();
	await writeFile(out, image.toPNG());
	console.log(`snapshot: 已写入 ${out} (${image.getSize().width}x${image.getSize().height})`);
	app.quit();
});

app.on("window-all-closed", () => app.quit());
