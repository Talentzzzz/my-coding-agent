// Launch the desktop shell.
//
// This exists for one reason: an unrelated `ELECTRON_RUN_AS_NODE` in the environment turns Electron
// into plain Node, and the app then dies on `require("electron")` returning a path instead of the
// API. Deleting that variable for the child is not something a package script can do portably, and
// it is exactly the kind of environment difference that should not decide whether the app opens.
//
//   node scripts/launch.mjs [--dev] [--workspace <dir>]
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");

/** Where Electron's own launcher lives, which is a shim that spawns the real binary. */
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
 * The real executable.
 *
 * Electron's package entry exports the path to its binary after installation recorded it in
 * `path.txt`; the wrapper script in the package root would also work, but going straight to the
 * binary keeps one process between this launcher and the app.
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
