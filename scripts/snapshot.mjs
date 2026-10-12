/**
 * 截图台（票 03 的弃件）。
 *
 * 它只做一件事：把一个 URL 渲染出来、写成一张 PNG、退出。存在的理由有两个——原型的三种形态要
 * 有实物给人看，而且"它长什么样"这件事最好是机器说的，不是描述出来的。
 *
 *   node scripts/snapshot.mjs -- --url <url> --out <file> [--width 1440] [--height 900]
 *
 * 它用桌面外壳那份 Electron，因此不需要浏览器自动化工具，也不往仓库里加依赖。
 * 页面自己的 `&still=1` 会把动效关掉，截图因此是确定的。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** 与 `packages/desktop/scripts/launch.mjs` 同样的两跳：包入口 -> `path.txt` -> 真二进制。 */
function electronBinary() {
	const require = createRequire(join(root, "packages", "desktop", "package.json"));
	const recorded = join(dirname(require.resolve("electron")), "path.txt");
	if (!existsSync(recorded)) {
		throw new Error(
			`Electron 的二进制不在（${recorded}）。先跑 node packages/desktop/node_modules/electron/install.js`,
		);
	}
	return join(dirname(recorded), "dist", readFileSync(recorded, "utf8").trim());
}

/**
 * 取一个旗标后面的值。
 *
 * `--` 会被跳过：node 把分隔符之后的一切留给脚本，而 `node scripts/snapshot.mjs -- --url ...`
 * 是唯一能保证旗标不被 node 自己当成选项读掉的形式。
 */
function flag(name, fallback) {
	const at = process.argv.indexOf(name);
	const value = at === -1 ? undefined : process.argv[at + 1];
	return value === undefined || value === "--" ? fallback : value;
}

const url = flag("--url");
const out = flag("--out");
if (!url || !out) {
	throw new Error("用法：node scripts/snapshot.mjs -- --url <url> --out <file.png> [--width n] [--height n]");
}

const environment = { ...process.env };
// 与桌面外壳同一个理由：一个无关的 `ELECTRON_RUN_AS_NODE` 会把 Electron 变成普通 Node，于是
// `require("electron")` 返回一个路径而不是 API，截图台死于 `app` 是 undefined。
delete environment.ELECTRON_RUN_AS_NODE;
// URL 与输出路径走环境变量：命令行上一个"长得像 URL"的参数会让 Electron 当深链接处理，进程在
// 加载截图执行者之前就退出。
environment.SNAPSHOT_URL = url;
environment.SNAPSHOT_OUT = resolve(root, out);
environment.SNAPSHOT_WIDTH = String(flag("--width", "1440"));
environment.SNAPSHOT_HEIGHT = String(flag("--height", "900"));
const probe = flag("--probe");
if (probe !== undefined) environment.SNAPSHOT_PROBE = probe;
const errors = flag("--errors");
if (errors !== undefined) environment.SNAPSHOT_ERRORS = errors;

const child = spawn(electronBinary(), [join(here, "snapshot", "capture.cjs")], { stdio: "inherit", env: environment });

child.on("error", (error) => {
	process.stderr.write(`启动 Electron 失败：${error.message}\n`);
	process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
