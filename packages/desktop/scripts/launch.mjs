// 启动桌面外壳。
//
// 它存在只有一个原因：环境里一个不相干的 `ELECTRON_RUN_AS_NODE` 会把 Electron 变成普通 Node，应用随即死于 `require("electron")` 返回路径而不是 API。为子进程删掉该变量不是 package script 能可移植做到的事，而这恰恰是不该决定应用能否打开的那类环境差异。
//
//   node scripts/launch.mjs [--dev] [--workDir <dir>]
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");

/** Electron 自己的启动器所在，那是一个 spawn 真正二进制的垫片。 */
function electronEntry() {
	const require = createRequire(join(desktopRoot, "package.json"));
	try {
		return require.resolve("electron");
	} catch {
		throw new Error(
			"Electron is not installed. Run `node scripts/install-deps.ts packages/desktop`, then\n" +
				"`node packages/desktop/node_modules/electron/install.js` to fetch the binary.",
		);
	}
}

/**
 * 真正的可执行文件。
 *
 * Electron 的 package entry 在安装时把二进制路径记入 `path.txt` 后导出它；包根的包装脚本也能用，但直取二进制让本启动器与应用之间只隔一个进程。
 */
function electronBinary() {
	const packageDir = dirname(electronEntry());
	const recorded = join(packageDir, "path.txt");
	if (!existsSync(recorded)) {
		throw new Error(
			`Electron's binary is missing (${recorded}). Run:\n` +
				"  node packages/desktop/node_modules/electron/install.js",
		);
	}
	return join(packageDir, "dist", readFileSync(recorded, "utf8").trim());
}

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary(), [desktopRoot, ...process.argv.slice(2)], {
	stdio: "inherit",
	env: environment,
});

child.on("exit", (code, signal) => {
	process.exit(signal ? 1 : (code ?? 0));
});
child.on("error", (error) => {
	process.stderr.write(`Could not start Electron: ${error.message}\n`);
	process.exit(1);
});
