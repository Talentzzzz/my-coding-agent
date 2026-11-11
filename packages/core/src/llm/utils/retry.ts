// 从 pi-ai（0.99.2）vendor 而来。@ts-nocheck 让仓库根目录更严格的配置放过本文件，而进入
// packages/core 的每次 import 仍然被完整检查。
// @ts-nocheck
import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/免费额度限制，由 OpenCode 的 Zen API 以 429 JSON 错误类型返回。
	// 这些是订阅/账户限制，不是瞬时限流。
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go 的订阅限制文案，在达到滚动/周/月限额后要求用户改用可用余额计费。
	"Monthly usage limit reached",
	"available balance",

	// 通用的配额/预算/计费耗尽；这些字符串覆盖常见网关的措辞。
	"out of budget",
	"quota exceeded",
	"billing",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// 通用的 provider 负载、HTTP 状态码、服务器侧瞬时故障。
	"overloaded",
	"currently experiencing high demand",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"520",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// 包装层/provider 对上游瞬时故障的文案，包括 OpenRouter 的
	// "Provider returned error" 响应（#2264）。
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",

	// 网络、代理、fetch 传输失败，包括 OpenRouter 的连接掉线（#3317）。
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket 传输可能报告 close/error 文案而不是 HTTP/fetch 文案。
	"websocket.?closed",
	"websocket.?error",

	// SDK 和传输的流过早结束。Anthropic 可能抛 "stream ended without ..." 和
	// "Anthropic stream ended before message_stop"（#4433）；Bedrock/Smithy 可能抛
	// HTTP/2 无响应错误（#3594）。
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",

	// provider 要求的重试延迟超上限的失败应流经外层重试策略，让调用方能够展示或 abort 退避（#1123）。
	"retry delay",

	// Bedrock 流异常在流中途发出的显式重试指引（#6019）。
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// 基于 gRPC 的 provider（如 NVIDIA NIM）。
	"ResourceExhausted",
]);

/**
 * 重试策略：有界次数的指数退避（`baseDelayMs * 2^(attempt-1)`）。
 * `maxAgentDelayMs` 为每次计算出的延迟封顶，默认 60 秒。
 * 与 coding-agent 的 `settings.retry`（`enabled`、`maxRetries`、`baseDelayMs`、`maxAgentDelayMs`）
 * 对应；放在这里是为了让分类器和按策略驱动的重试循环住在一起，并保持可被 SDK 和其他调用方复用。
 */
export interface RetryPolicy {
	enabled: boolean;
	/** 最大重试次数（0 = 不重试）。首次调用不计入重试。 */
	maxRetries: number;
	/** 基础延迟（毫秒）。加抖动前每次尝试的延迟为 `baseDelayMs * 2^(attempt-1)`。 */
	baseDelayMs: number;
	/** agent 级重试延迟的可选上限（毫秒）。默认 60 秒。 */
	maxAgentDelayMs?: number;
}

export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;

export function retryDelayMs(policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs">, attempt: number): number {
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	return Math.min(safeDelay, policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
}

/** {@link retryAssistantCall} 在每次重试前后发出的可选回调。 */
export interface RetryCallbacks {
	/** 在每次重试尝试的退避睡眠之前发出（从 1 计数）。 */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** 在退避睡眠之后、重试的调用开始之前立即发出。 */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** 循环结束时发出一次：后面的调用正常完成即为成功。 */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * 运行一次产出 assistant 的调用，对瞬时错误做有界重试。
 *
 * 行为：
 * - 成功的响应立即返回。abort 是终态、永不重试，但如果 abort 发生在已排定重试之后，报告为不
 *   成功。退避睡眠期间的 abort 同样被归一化成 aborted 的 `AssistantMessage`，调用方无需关心取消
 *   发生的时刻。
 * - 不可重试的错误（按 {@link isRetryableAssistantError}，包括配额/计费耗尽）立即返回，让确定性
 *   错误快速失败。
 * - 否则以指数退避重试至多 `maxRetries` 次：每次睡眠前发 `onRetryScheduled`，每次睡眠后、重试的
 *   调用开始前发 `onRetryAttemptStart`，循环结束时（无论以成功、重试耗尽还是退避被 abort 收尾）
 *   发一次 `onRetryFinished`。
 *
 * `policy` 为 undefined 或禁用时，第一个响应原样返回（等价于直接调用 `produce()`）。
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// abort：终态但不算成功。绝不重试 aborted 的消息。
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// 成功：非 error、非 abort 的响应原样返回。
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// 不可重试，或预算耗尽：返回最终错误消息。
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		const delayMs = retryDelayMs(policy!, attempt);
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// 把重试退避期间的 abort 归一化成与 provider 流 abort 相同的 AssistantMessage 形状，调用方
		// 无需关心取消发生的时刻。
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				const { errorMessage: _errorMessage, ...rest } = response;
				return { ...rest, stopReason: "aborted" };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * 判断一条失败的 assistant 消息是否像一次瞬时的 provider 或传输错误，让调用方决定最后一条
 * assistant turn 是否应该重启。
 *
 * 这里不实现重试策略。调用方应先单独处理 context 溢出，再在重启 assistant turn 之前应用自己的
 * 重试预算、退避和上报。
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
