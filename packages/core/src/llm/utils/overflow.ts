// 从 pi-ai（0.99.2）vendor 而来。@ts-nocheck 让仓库根目录更严格的配置放过本文件，而进入
// packages/core 的每次 import 仍然被完整检查。
// @ts-nocheck
import type { AssistantMessage } from "../types.ts";

/**
 * 检测各 provider context 溢出错误的正则模式。
 *
 * 这些模式匹配输入超出模型 context window 时返回的错误消息。
 *
 * 各 provider 的专属模式（附示例错误消息）：
 *
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * - Anthropic: "413 {\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum size\"}}"
 * - Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
 * - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - Groq: "Please reduce the length of the messages or completion"
 * - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - OpenRouter/Poolside: "Input length X exceeds the maximum allowed input length of Y tokens."
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "the request exceeds the available context size, try increasing it"
 * - LM Studio: "tokens to keep from the initial prompt is greater than the context length"
 * - GitHub Copilot: "prompt token count of X exceeds the limit of Y"
 * - MiniMax: "invalid params, context window exceeds limit"
 * - Kimi For Coding: "Your request exceeded model token limit: X (requested: Y)"
 * - DS4: "Prompt has X tokens, but the configured context size is Y tokens"
 * - Cerebras: "400/413 status code (no body)"
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - z.ai: `{"code":"1261","message":"Prompt too long"}`、`{"code":"1261","message":"Prompt exceeds max length"}`（CN 端点），或经 usage.input > contextWindow 的静默溢出
 * - Xiaomi MiMo: 把输入截到正好填满 contextWindow，然后返回 finish_reason "length" 且 output=0
 *   （没有空间生成）。经 stopReason "length" + 零输出 + 输入填满 context window 检测。
 * - DashScope/Qwen: "Range of input length should be [1, X]"（HTTP 400 invalid_parameter_error）
 * - Ollama: 一些部署静默截断，另一些返回 "prompt too long; exceeded max context length by X tokens"
 *   之类的错误
 */
const OVERFLOW_PATTERNS = [
	/prompt (?:is )?too long/i, // Anthropic and z.ai token overflow
	/prompt exceeds max length/i, // z.ai CN endpoint token overflow
	/request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
	/input is too long for requested model/i, // Amazon Bedrock
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter (most backends)
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp server
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/too large for model with \d+ maximum context length/i, // Mistral
	/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
	/model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
	/prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
	/range of input length should be/i, // DashScope / Qwen Token Plan
	/context[_ ]length[_ ]exceeded/i, // Generic fallback
	/too many tokens/i, // Generic fallback
	/token limit exceeded/i, // Generic fallback
];

/** 完全没有 body 的 400/413：端点在能解释原因之前就拒绝了请求。 */
const BODYLESS_REJECTION_OVERFLOW_PATTERN = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i;

/**
 * 表示非溢出错误的模式（例如限流、服务器错误）。
 * 匹配其中任何一条的错误消息会被排除在溢出检测之外，即使它同时匹配某条 OVERFLOW_PATTERN。
 *
 * 例如：Bedrock 把限流错误格式化为 "ThrottlingException: Too many tokens,
 * please wait before trying again."，没有这个排除的话它会匹配 /too many tokens/i 的溢出模式。
 */
const NON_OVERFLOW_PATTERNS = [
	/^(Throttling error|Service unavailable):/i, // AWS Bedrock non-overflow errors (human-readable prefixes from formatBedrockError)
	/rate limit/i, // Generic rate limiting
	/too many requests/i, // Generic HTTP 429 style
];

/**
 * 检查一条 assistant 消息是否表示 context 溢出错误。
 *
 * 处理三种情况：
 * 1. 基于错误的溢出：大多数 provider 返回 stopReason "error" 加一个特定的错误消息模式。
 * 2. 静默溢出：一些 provider 接受溢出请求并正常返回。对这些，检查 usage.input 是否超过
 *    context window。
 * 3. length-stop 溢出：Xiaomi MiMo 在输入填满 context window 时可能返回 "length" 且零输出。
 *
 * ## 各 provider 的检测可靠性
 *
 * **检测可靠（返回带可识别消息的 error）：**
 * - Anthropic: "prompt is too long: X tokens > Y maximum" 或 "request_too_large"
 * - Google Gemini: "input token count exceeds the maximum"
 * - xAI (Grok): "maximum prompt length is X but request contains Y"
 * - Groq: "reduce the length of the messages"
 * - Cerebras: 400/413 status code (no body)
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - OpenRouter（多数后端）: "maximum context length is X tokens"
 * - OpenRouter/Poolside: "Input length X exceeds the maximum allowed input length of Y tokens."
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "exceeds the available context size"
 * - LM Studio: "greater than the context length"
 * - Kimi For Coding: "exceeded model token limit: X (requested: Y)"
 * - DS4: "Prompt has X tokens, but the configured context size is Y tokens"
 * - DashScope/Qwen: "Range of input length should be [1, X]"
 * - z.ai: "Prompt too long"
 *
 * **检测不可靠：**
 * - z.ai: 有时静默接受溢出（经 usage.input > contextWindow 可检测），有时返回限流错误。传入
 *   contextWindow 参数以检测静默溢出。
 * - Xiaomi MiMo: 把输入截到适配 contextWindow 然后返回 stopReason "length" 且 output=0。传入
 *   contextWindow 参数，经「填满 context + 零输出」的信号检测。
 * - Ollama: 某些配置可能静默截断输入，但也可能返回与上述模式匹配的显式溢出错误。静默截断在
 *   这里仍然无法检测，因为我们不知道预期的 token 数。
 *
 * ## 自定义 provider
 *
 * 如果通过 settings.json 添加了自定义模型，本函数可能检测不到那些 provider 的溢出错误。要添加
 * 支持：
 *
 * 1. 发送一个超出模型 context window 的请求
 * 2. 查看响应里的 errorMessage
 * 3. 写一个匹配该错误的正则模式
 * 4. 把模式加进本文件的 OVERFLOW_PATTERNS，或在本函数调用之前自己检查 errorMessage
 *
 * @param message - 待检查的 assistant 消息
 * @param contextWindow - 可选的 context window 大小，用于检测静默溢出（z.ai）
 * @returns 消息表示 context 溢出时为 true
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	// 情况 1：检查错误消息模式
	if (message.stopReason === "error" && message.errorMessage) {
		// 跳过匹配已知非溢出模式的消息（例如限流）。
		const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!));
		if (!isNonOverflow) {
			// 无 body 的 400/413 无论端点是谁都读作溢出。上游可以按消息的 provider 来把关，因为它的
			// 每个 vendor 格式都不同；这里的消息不带行身份，而本传输发出的请求带着拒绝状态码和无
			// body 回来，不是超限就是畸形——对畸形请求永远重试，比为不需要压缩的对话压缩一次更糟。
			if (BODYLESS_REJECTION_OVERFLOW_PATTERN.test(message.errorMessage!)) {
				return true;
			}
			if (OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) {
				return true;
			}
		}
	}

	// 情况 2：静默溢出（z.ai 风格）——成功返回但 usage 超出 context。
	if (contextWindow && message.stopReason === "stop") {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens > contextWindow) {
			return true;
		}
	}

	// 情况 3：length-stop 溢出（Xiaomi MiMo 风格）——服务器把超大的输入截短以适配 context
	// window，不留任何输出空间。返回 stopReason "length"、output=0，且 input+cacheRead 填满
	// context window。
	if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens >= contextWindow * 0.99) {
			return true;
		}
	}

	return false;
}

/**
 * 检查一次 length stop 是否在调用方或模型预期的输出上限之下结束。这样的响应可能由 context 压力或
 * provider 侧截断造成，所以调用方可以做一次有界的压缩再重试。`desiredMaxOutput` 必须是任何基于
 * context 的钳制之前的原始上限。
 */
export function isRecoverableLength(message: AssistantMessage, desiredMaxOutput: number): boolean {
	return message.stopReason === "length" && desiredMaxOutput > 0 && message.usage.output < desiredMaxOutput;
}

/** 供测试使用的溢出模式。 */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}
