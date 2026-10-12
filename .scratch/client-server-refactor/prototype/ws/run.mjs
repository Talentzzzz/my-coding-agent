// 票 17 的 Electron 装置驱动：起探针服务器、起 Electron、收日志。
//
//   node run.mjs <scenario> [--conns N] [--ping-ms N] [--say-ms N] [--duration-ms N] [--visible-ms N]
//                [--throttling true|false] [--show true|false] [--timeout-ms N]
//
// 结论写在 <out>/renderer.log（渲染器侧）与 <out>/server.log（服务端侧）。
// 本文件不 import 本仓库任何代码。
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const ELECTRON = join(REPO, "packages/desktop/node_modules/electron/dist/electron.exe");

const argv = process.argv.slice(2);
const scenario = argv[0];
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? fallback : argv[i + 1];
};

const OUT = resolve(flag("out", join(HERE, "out", scenario)));
mkdirSync(OUT, { recursive: true });
const SERVER_LOG = join(OUT, "server.log");
const RENDERER_LOG = join(OUT, "renderer.log");
writeFileSync(SERVER_LOG, "");
writeFileSync(RENDERER_LOG, "");

// 自己挑一个空闲端口（服务器与 Electron 都要知道它）。
const pickPort = () =>
	new Promise((resolvePort) => {
		const probe = createServer();
		probe.listen(0, "127.0.0.1", () => {
			const port = probe.address().port;
			probe.close(() => resolvePort(port));
		});
	});
const freePort = await pickPort();
const freePort2 = await pickPort();
const TWO_SERVERS = (flag("two-servers", "false")) === "true";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const serverArgs = (port, logFile) =>
	flag("server", "raw") === "ws"
		? [
				join(HERE, "ws-server.mjs"),
				"--port",
				String(port),
				"--log",
				logFile,
				"--ws-path",
				flag("ws-path", join(REPO, "node_modules/ws")),
			]
		: [
				join(HERE, "server.mjs"),
				"--port",
				String(port),
				"--log",
				logFile,
				"--ping-ms",
				flag("ping-ms", "0"),
				"--say-ms",
				flag("say-ms", "0"),
			];

const server = spawn(process.execPath, serverArgs(freePort, SERVER_LOG), { stdio: "ignore", env });
const SERVER2_LOG = join(OUT, "server2.log");
const server2 = TWO_SERVERS ? spawn(process.execPath, serverArgs(freePort2, SERVER2_LOG), { stdio: "ignore", env }) : undefined;

const waitFor = async (predicate, ms) => {
	const deadline = Date.now() + ms;
	for (;;) {
		if (predicate()) return true;
		if (Date.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, 100));
	}
};

const listening = await waitFor(() => existsSync(SERVER_LOG) && readFileSync(SERVER_LOG, "utf8").includes('"listening"'), 5000);
if (!listening) {
	console.error("server did not start");
	server.kill();
	process.exit(2);
}
console.log(`[run] scenario=${scenario} port=${freePort} out=${OUT}`);

const electron = spawn(
	ELECTRON,
	[join(HERE, "electron-main.cjs")],
	{
		stdio: "ignore",
		env: {
			...env,
			WS_PORT: String(freePort),
			WS_PORT2: String(freePort2),
			SCENARIO: scenario,
			OUT_DIR: OUT,
			CONNS: flag("conns", "0"),
			DURATION_MS: flag("duration-ms", "6000"),
			VISIBLE_MS: flag("visible-ms", "3000"),
			THROTTLING: flag("throttling", "true"),
			SHOW: flag("show", "true"),
		},
	},
);

const timeoutMs = Number(flag("timeout-ms", "120000"));
const exited = await new Promise((resolveExit) => {
	const timer = setTimeout(() => resolveExit("timeout"), timeoutMs);
	electron.on("exit", (code) => {
		clearTimeout(timer);
		resolveExit(code);
	});
});
if (exited === "timeout") {
	console.error("[run] electron timeout, killing");
	electron.kill();
}
server.kill();
server2?.kill();
await new Promise((r) => setTimeout(r, 300));

const tail = (file, n) => {
	const text = readFileSync(file, "utf8").trim().split("\n");
	return n === 0 ? text : text.slice(-n);
};
console.log(`\n===== renderer.log (${RENDERER_LOG}) =====`);
for (const line of tail(RENDERER_LOG, Number(flag("tail", "0")) || Infinity)) console.log(line);
console.log(`\n===== server.log summary (${SERVER_LOG}) =====`);
const serverLines = tail(SERVER_LOG, 0);
const counts = {};
for (const line of serverLines) {
	try {
		const event = JSON.parse(line).event;
		counts[event] = (counts[event] ?? 0) + 1;
	} catch {}
}
console.log(JSON.stringify(counts, null, 2));
