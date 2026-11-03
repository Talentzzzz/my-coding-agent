import { bootServer } from "./boot.ts";
import { resolve } from "node:path";

interface Args {
	workDirAbsPath: string;
	host: string;
	port: number;
	model?: string;
	thinkingLevel?: string;
	session?: string;
	vite: boolean;
}

function parseArgs(argv: readonly string[]): Args {
	const args: Args = {
		workDirAbsPath: process.cwd(),
		host: "127.0.0.1",
		// The port a familiar backend listens on, and overridable for anything that wants 5180 back.
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
			case "--host":
				args.host = value();
				break;
			case "--port":
				args.port = Number.parseInt(value(), 10);
				break;
			case "--model":
				args.model = value();
				break;
			case "--thinking":
				args.thinkingLevel = value();
				break;
			case "--session":
				args.session = value();
				break;
			case "--vite":
				args.vite = true;
				break;
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
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

function printHelp(): void {
	process.stdout.write(
		[
			"my-agent server",
			"",
			"Usage: node src/main.ts [options]",
			"",
			"  --workDir <dir>        working directory for new sessions (default: current directory)",
			"  --host <host>      bind address (default: 127.0.0.1)",
			"  --port <port>      port (default: 8080)",
			"  --model <ref>      <row id>/<model id> from the imported models, or the row id alone",
			"  --thinking <level> off | low | medium | high | max",
			"  --session <id>     open a stored session",
			"  --vite             serve the client through Vite (hot reload, no build step)",
			"  --help, -h         show this text",
			"",
			"Open the printed URL in a browser, or run the desktop shell (npm run start:desktop),",
			"which starts this same server in-process. --vite serves the client from packages/web/src;",
			"without it the server serves packages/web/dist, so run npm run build:web first.",
			"",
			"There is no built-in model catalog: models are imported in the app's settings panel, or by",
			"writing <agent home>/models.json. The settings panel lists what is stored.",
			"",
			"API (all JSON). Session events are NOT here: they arrive as frames on one resident",
			"WebSocket at /mux, whose uplink carries only `open` and `cancel`. Commands stay REST.",
			"  GET    /api/health",
			"  GET    /api/models                          PUT    /api/models      { models }",
			"  GET    /api/settings                        PATCH  /api/settings    { patch }",
			"  GET    /api/directories",
			"  GET    /api/sessions                        POST   /api/sessions",
			"  GET    /api/sessions/current",
			"  GET    /api/sessions/{id}                   PATCH  /api/sessions/{id}",
			"  POST   /api/sessions/{id}/messages          { text, behavior? }",
			"  POST   /api/sessions/{id}/abort",
			"  PUT    /api/sessions/{id}/tools             { names }",
			"  POST   /api/sessions/{id}/approvals/{toolCallId}   { approved }",
			"  POST   /api/sessions/{id}/forks             { entryId }",
			"  POST   /api/sessions/{id}/branch            { entryId, descend? }",
			"",
		].join("\n"),
	);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const server = await bootServer({
		workDirAbsPath: args.workDirAbsPath,
		host: args.host,
		port: args.port,
		vite: args.vite,
		...(args.model === undefined ? {} : { model: args.model }),
		...(args.thinkingLevel === undefined ? {} : { thinkingLevel: args.thinkingLevel }),
		...(args.session === undefined ? {} : { sessionId: args.session }),
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
}

await main();
