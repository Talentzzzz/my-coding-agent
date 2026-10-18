import {
	listModelOptions,
	modelsPath,
	openAgent,
	SessionManager,
	SettingsManager,
	UserModelStore,
	type AgentSessionEvent,
	type ModelSource,
} from "@my-agent/core";
import { resolve } from "node:path";

interface Args {
	cwd: string;
	model?: string;
	thinking?: string;
	listModels: boolean;
	prompt?: string;
	shouldContinue: boolean;
	verbose: boolean;
}

function parseArgs(argv: readonly string[]): Args {
	const args: Args = { cwd: process.cwd(), listModels: false, shouldContinue: false, verbose: false };
	const rest: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const value = (): string => {
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
			index += 1;
			return next;
		};

		switch (arg) {
			case "--cwd":
				args.cwd = resolve(value());
				break;
			case "--model":
				args.model = value();
				break;
			case "--thinking":
				args.thinking = value();
				break;
			case "--list-models":
				args.listModels = true;
				break;
			case "--continue":
			case "-c":
				args.shouldContinue = true;
				break;
			case "--verbose":
				args.verbose = true;
				break;
			default:
				if (arg !== undefined) rest.push(arg);
		}
	}

	if (rest.length > 0) args.prompt = rest.join(" ");
	return args;
}

/** Terminal renderer for the session event stream, for checking the loop without a browser. */
function renderEvent(event: AgentSessionEvent, verbose: boolean): void {
	switch (event.type) {
		case "message_start":
			if (event.message.role === "user") process.stdout.write("\n\x1b[36muser>\x1b[0m ");
			else if (event.message.role === "assistant") process.stdout.write("\n\x1b[32massistant>\x1b[0m ");
			break;
		case "message_update":
			// The wire carries the delta alone, so this is the characters and nothing to unpack.
			if (event.delta.kind === "text") process.stdout.write(event.delta.text);
			else if (verbose) process.stdout.write(`\x1b[90m${event.delta.text}\x1b[0m`);
			break;
		case "message_end": {
			// A failed attempt used to be printed from the streaming event that carried the error;
			// that event is not on the wire any more (it carries no characters), so the message's own
			// end is where the terminal learns how the attempt went.
			const message = event.message as { stopReason?: string; errorMessage?: string };
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				process.stdout.write(`\n\x1b[31m${message.stopReason}: ${message.errorMessage ?? "unknown"}\x1b[0m`);
			}
			break;
		}
		case "tool_execution_start":
			process.stdout.write(`\n\x1b[35m[tool ${event.toolName}] ${JSON.stringify(event.args).slice(0, 160)}\x1b[0m`);
			break;
		case "tool_execution_end":
			process.stdout.write(`\n\x1b[35m[tool ${event.toolName} ${event.isError ? "failed" : "done"}]\x1b[0m`);
			if (verbose) process.stdout.write(`\n${firstLines(event.result, 8)}`);
			break;
		case "queue_update":
			if (verbose && event.queued > 0) process.stdout.write(`\n\x1b[90m[queued ${event.queued}]\x1b[0m`);
			break;
		case "compaction":
			process.stdout.write(
				`\n\x1b[33m[compacted ${event.summarized} messages into a summary, ~${event.tokensBefore} tokens before, ~${event.contextTokens} in context now]\x1b[0m`,
			);
			break;
		case "compaction_failed":
			process.stdout.write(`\n\x1b[31m[compaction failed: ${event.message}]\x1b[0m`);
			break;
		case "pruned":
			process.stdout.write(
				`\n\x1b[33m[cleared ${event.cleared} stale tool results, ~${event.tokensBefore} tokens before, ~${event.contextTokens} in context now]\x1b[0m`,
			);
			break;
		case "arg_trimmed":
			process.stdout.write(
				`\n\x1b[33m[shortened the recorded arguments of ${event.trimmed} tool calls, ~${event.tokensBefore} tokens before, ~${event.contextTokens} in context now]\x1b[0m`,
			);
			break;
		case "config_changed":
			if (verbose) process.stdout.write(`\n\x1b[90m[config ${JSON.stringify(event)}]\x1b[0m`);
			break;
		default:
			break;
	}
}

function firstLines(result: unknown, count: number): string {
	const text = JSON.stringify(result);
	return text.length > 800 ? `${text.slice(0, 800)}...` : text.slice(0, count * 100);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const store = UserModelStore.create();
	const rows = store.list();
	const models: ModelSource = { list: () => store.list() };

	if (args.listModels) {
		if (rows.length === 0) {
			process.stdout.write(`No models imported yet. Add them in the app's settings, or write ${modelsPath()}\n`);
			return;
		}
		for (const model of listModelOptions(rows)) {
			process.stdout.write(
				`${model.name}/${model.modelId}\t${model.api}\t${model.baseUrl}\t${model.contextWindow} tokens\n`,
			);
		}
		return;
	}

	const sessionManager = args.shouldContinue
		? SessionManager.continueRecent(args.cwd)
		: SessionManager.create(args.cwd);

	const session = await openAgent({
		workspaceRoot: args.cwd,
		sessionManager,
		models,
		settingsManager: SettingsManager.create(args.cwd),
		...(args.model === undefined ? {} : { model: args.model }),
		...(args.thinking === undefined ? {} : { thinkingLevel: args.thinking }),
	});

	process.stdout.write(`session ${session.id}  workspace ${args.cwd}  model ${session.modelRef}\n`);
	session.onEvent((event) => renderEvent(event, args.verbose));

	if (args.prompt === undefined) {
		process.stdout.write("no prompt given; pass one as an argument, for example: cli.ts \"list the files here\"\n");
		return;
	}

	await session.prompt(args.prompt);
	const usage = session.usage;
	process.stdout.write(
		`\n\n[in ${usage.input} out ${usage.output} cache ${usage.cacheRead}/${usage.cacheWrite} cost $${usage.cost.toFixed(4)} context ${usage.contextTokens}/${usage.contextWindow}]\n`,
	);
	await session.close();
}

await main();
