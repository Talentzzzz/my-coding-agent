// 从 pi-ai（0.99.2）vendor 而来。@ts-nocheck 让仓库根目录更严格的配置放过本文件，而进入
// packages/domain 的每次 import 仍然被完整检查。
// @ts-nocheck
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

interface ProviderRetryOptions {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	signal?: AbortSignal;
}

interface ProviderError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
}

function isProviderError(error: unknown): error is ProviderError {
	if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return false;
	return (
		(error.status === undefined || typeof error.status === "number") &&
		(error.headers === undefined || error.headers instanceof Headers)
	);
}

/** 镜像被钉住的 Anthropic SDK 重试策略；升级 SDK 时复核。 */
function isRetryableProviderError(error: ProviderError): boolean {
	const shouldRetry = error.headers?.get("x-should-retry");
	if (shouldRetry === "true") return true;
	if (shouldRetry === "false") return false;

	if (error.status === undefined) return true;
	return (
		error.status === 408 ||
		error.status === 409 ||
		error.status === 429 ||
		(typeof error.status === "number" && error.status >= 500)
	);
}

function validateServerRetryDelayMs(
	delayMs: number,
	maxRetryDelayMs: number | undefined,
	providerErrorMessage: string,
): number {
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxDelayMs > 0 && delayMs > maxDelayMs) {
		throw new Error(
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${providerErrorMessage}`,
		);
	}
	return delayMs;
}

function getRetryDelayMs(error: ProviderError, retryIndex: number, maxRetryDelayMs: number | undefined): number {
	const retryAfterMs = error.headers?.get("retry-after-ms");
	if (retryAfterMs) {
		const value = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(value)) return validateServerRetryDelayMs(value, maxRetryDelayMs, error.message);
	}

	const retryAfter = error.headers?.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
		if (Number.isFinite(delayMs)) return validateServerRetryDelayMs(delayMs, maxRetryDelayMs, error.message);
	}

	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
	return exponentialDelay * (1 - Math.random() * 0.25);
}

function createAbortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(createAbortError());
		};
		const timeout = setTimeout(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, ms),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 复现 Anthropic SDK 的重试行为，同时让它的退避睡眠可中断。SDK 内置的重试计时器忽略请求的
 * AbortSignal，所以调用方必须以 `maxRetries: 0` 调用 SDK、并用这个助手包装请求。provider 要求的
 * 延迟超过 `maxRetryDelayMs` 时立即失败（默认 60 秒）；设为 0 表示关闭上限。
 */
export async function retryProviderRequest<T>(
	request: () => Promise<T>,
	options: ProviderRetryOptions = {},
): Promise<T> {
	const maxRetries = options.maxRetries ?? 0;
	let retriesRemaining = maxRetries;

	for (;;) {
		try {
			// 每次重试都是一次全新的 SDK 请求，X-Stainless-Retry-Count 保持为零。
			return await request();
		} catch (error) {
			if (options.signal?.aborted) throw createAbortError();
			if (retriesRemaining <= 0 || !isProviderError(error) || !isRetryableProviderError(error)) throw error;

			const retryIndex = maxRetries - retriesRemaining;
			retriesRemaining--;
			await abortableSleep(getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs), options.signal);
		}
	}
}
