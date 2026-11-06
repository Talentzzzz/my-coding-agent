import { spawn } from "node:child_process";
import type { Tool, ToolResult, ToolUpdateCallback } from "../llm/index.ts";
import { Type, type Static } from "typebox";
import { DEFAULT_BASH_SETTINGS, type BashSettings } from "../config.ts";
import { defaultLauncher } from "../shell.ts";
import { truncate } from "./truncate.ts";
import { textResult, throwIfAborted } from "./types.ts";

const MAX_CAPTURE_BYTES = 256 * 1024;
const UPDATE_INTERVAL_MS = 150;

const parameters = Type.Object({
	command: Type.String({ description: "Shell command to run, starting in the working directory" }),
	description: Type.Optional(
		Type.String({ description: "Short description of what the command does, shown to the user" }),
	),
	timeout_ms: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Kill the command after this long. The default (2 min) and the ceiling (60 min) come from the bash timeout settings.",
		}),
	),
});

export type BashParams = Static<typeof parameters>;

/**
 * `bash` runs one command in the working directory and streams its output.
 *
 * Starting there (rather than in the server process's own working directory) keeps `git status`, `npm test` and friends
 * pointed at the project the user is talking about. Nothing confines the command: one that walks out
 * of the directory with `cd` is a command the user asked for, and the tool has no second opinion
 * about it.
 *
 * The directory and the timeouts arrive with each call (`run`), not with the instance: one `bash`
 * serves every session and every directory, so a change made in the settings panel reaches the next
 * run's calls without anything being rebuilt by hand. A call that carries no timeouts — a test
 * driving the tool directly — runs on the defaults.
 */
export function createBashTool(): Tool<typeof parameters> {
	return {
		name: "bash",
		label: "Bash",
		description:
			"Run a shell command from the working directory and return its combined output. Use for tests, builds, git, and package managers.",
		parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, run, signal, onUpdate) {
			return runBash(run.workDirAbsPath, params, { signal, onUpdate, timeouts: run.bash });
		},
	};
}

/**
 * Tools pass a callback that accepts a partial `ToolResult`. `Tool` — defined beside the transport
 * in `llm/types.ts` — types `onUpdate` as `ToolUpdateCallback<TDetails>`, so the wrapper in
 * `tools/index.ts` narrows it to this shape.
 */
export interface BashHooks {
	signal?: AbortSignal;
	onUpdate?: (partial: ToolResult<unknown>) => void;
	/** The timeouts to run under; the defaults when the caller named none. */
	timeouts?: BashSettings;
}

export async function runBash(
	workDirAbsPath: string,
	params: BashParams,
	hooks: BashHooks = {},
): Promise<ToolResult<unknown>> {
	throwIfAborted(hooks.signal);
	const timeouts = hooks.timeouts ?? DEFAULT_BASH_SETTINGS;
	const capped = params.timeout_ms !== undefined && params.timeout_ms > timeouts.maxTimeoutMs;
	const timeoutMs = Math.min(params.timeout_ms ?? timeouts.defaultTimeoutMs, timeouts.maxTimeoutMs);
	const launcher = defaultLauncher();

	return new Promise<ToolResult<unknown>>((resolvePromise, rejectPromise) => {
		const child = spawn(launcher.file, [...launcher.args, params.command], {
			cwd: workDirAbsPath,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let output = "";
		let captured = 0;
		let lastUpdate = 0;
		let settled = false;
		let timedOut = false;

		const publish = (): void => {
			hooks.onUpdate?.(textResult(output.length > 0 ? output : "(no output yet)"));
		};
		const collect = (chunk: Buffer): void => {
			if (captured >= MAX_CAPTURE_BYTES) return;
			const text = chunk.toString("utf8");
			captured += text.length;
			output += text;
			const now = Date.now();
			if (now - lastUpdate >= UPDATE_INTERVAL_MS) {
				lastUpdate = now;
				publish();
			}
		};

		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);

		const onAbort = (): void => {
			child.kill();
		};
		hooks.signal?.addEventListener("abort", onAbort, { once: true });

		const finish = (): void => {
			clearTimeout(timer);
			hooks.signal?.removeEventListener("abort", onAbort);
		};

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			finish();
			rejectPromise(new Error(`Failed to run command: ${error.message}`));
		});

		child.on("close", (code, signalName) => {
			if (settled) return;
			settled = true;
			finish();

			const { text } = truncate(output);
			// The cap is named in the result rather than applied silently, so a model that asked for an
			// hour and was given ten minutes can ask for a shorter plan instead of being surprised.
			const status = `${timedOut
				? `Command timed out after ${timeoutMs} ms and was killed.`
				: hooks.signal?.aborted
					? "Command was aborted."
					: code === 0
						? "Command exited with code 0."
						: signalName
							? `Command was killed by ${signalName}.`
							: `Command exited with code ${code}.`}${capped ? ` (requested ${params.timeout_ms} ms, capped at ${timeouts.maxTimeoutMs} ms)` : ""}`;

			const body = text.trimEnd();
			resolvePromise(
				textResult(body.length > 0 ? `${body}\n\n[${status}]` : `[no output]\n\n[${status}]`, {
					exitCode: code ?? -1,
					timedOut,
				}),
			);
		});

		publish();
	});
}
