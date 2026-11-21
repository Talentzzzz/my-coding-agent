// 浏览器 dev 的薄脚本（仓库工具，不是产品 CLI；分层重构步 3，spec §5.5）。
//
// `main.ts` 的 CLI 随 server 包退役而死亡：app 的入口是程序化的 `start(options)`，本脚本只负责
// 把三个 flag 翻译成一次调用、装上信号 handler、打印 URL——镜像 desktop 自己养 launch.mjs 的
// 先例。SIGINT/SIGTERM 原属垂死的 `main.ts`，由这里承接：`close()` 落定之后进程才离开。
//
//   node scripts/serve.ts [--vite] [--port <n>] [--workDir <dir>]
//
// 只收这三个 flag：`--host` / `--session` / `--help` 随 CLI 一起死。`--port 0` 依旧拒绝——
// 它向 smoke 说明过「子进程需要一个真端口」的理由，那条理由不随搬家消失。
import { resolve } from "node:path";

interface Args {
	workDirAbsPath: string;
	port: number;
	vite: boolean;
}

function parseArgs(argv: readonly string[]): Args {
	const args: Args = {
		workDirAbsPath: process.cwd(),
		port: 8080,
		vite: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const value = (): string => {
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
			index += 1;
			return next;
		};

		switch (arg) {
			case "--workDir":
				args.workDirAbsPath = resolve(value());
				break;
			case "--port":
				args.port = Number.parseInt(value(), 10);
				break;
			case "--vite":
				args.vite = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65_535) {
		throw new Error(`Invalid port: ${args.port}`);
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));

// 动态 import，与 smoke-boot 进程内半同一隔离法：`AGENT_HOME` 在 import 时从 `MY_AGENT_HOME`
// 一次性解析，所以环境先备好（spawn 的 env）、模块后行。
const { start } = await import("@my-agent/app");

const server = await start({
	workDirAbsPath: args.workDirAbsPath,
	port: args.port,
	vite: args.vite,
});

process.stdout.write(
	[
		`my-agent listening on ${server.url}`,
		`  workDir:   ${args.workDirAbsPath}`,
		`  client:    ${args.vite ? "vite (hot reload)" : "packages/web/dist"}`,
		`  api:       ${server.url}/api/health`,
		"",
	].join("\n"),
);

const shutdown = async (): Promise<void> => {
	await server.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
