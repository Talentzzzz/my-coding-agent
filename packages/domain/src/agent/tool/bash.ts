import { spawn } from "node:child_process";
import type { Tool, ToolResult, ToolUpdateCallback } from "../llm/index.ts";
import { Type, type Static } from "typebox";
import { DEFAULT_BASH_SETTINGS, type BashSettings } from "../types.ts";
import { defaultLauncher } from "./shell.ts";
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
 * `bash` 在工作目录里运行一条命令并流式输出。
 *
 * 从那里启动（而不是 server 进程自己的工作目录）让 `git status`、`npm test` 之类始终指向用户正在
 * 谈论的项目。没有任何东西限制命令：用 `cd` 走出目录的命令是用户要求的命令，工具对此没有第二
 * 意见。
 *
 * 目录和超时随每次调用（`run`）而来，不随实例：一个 `bash` 服务所有 session 和所有目录，所以
 * 设置面板里的改动无需任何手工重建就能到达下一次 run 的调用。不带超时的调用——直接驱动工具的
 * 测试——按默认值运行。
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
 * 工具传入一个接受 partial `ToolResult` 的回调。`Tool`——定义在传输层旁边的 `llm/types.ts`——把
 * `onUpdate` 类型化为 `ToolUpdateCallback<TDetails>`，所以 `tools/index.ts` 里的包装把它收窄成
 * 这个形状。
 */
export interface BashHooks {
	signal?: AbortSignal;
	onUpdate?: (partial: ToolResult<unknown>) => void;
	/** 在其下运行的超时；调用方未指名时用默认值。 */
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
			// 上限在 result 里说明而不是静默生效，所以要了一小时却只拿到十分钟的模型可以改要一个
			// 更短的方案，而不是被吓一跳。
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
