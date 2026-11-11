import type { AnthropicMessagesCompat } from "./llm/index.ts";

/**
 * 模型必须被告知的事，从它的 wire id 推导出来。
 *
 * pi-ai 把这些事实作为生成的元数据放在一份目录里，本应用有意不用它（`models.ts` 说明了为什么）。
 * 手填的一行只有 wire id 可作键，这对 Claude 已经够用：API 接受什么随代次变动——4.7 及以后拒绝
 * temperature——而 id 就标明代次。
 *
 * 思考档位有意不在此列。每一行都以同样的方式询问（adaptive + effort），本应用的四档就是 wire 接受
 * 的四个名字，所以档位原样发出。这也正是删掉本文件曾维护的按模型档位表的原因：应用不再自称知道
 * 哪些模型能思考、哪些有原生 `max`，它只管问，让不同意的端点自己作答。
 *
 * 这里的一个错误值不是小事：模型拒绝的 temperature 会让整个请求失败。所以 Claude 条目是从 pi 自己
 * 的 `isAnthropicTemperatureUnsupportedModel` 移植来的，而不是猜测。
 */

/** 无论取值如何都直接拒绝 `temperature` 字段的家族。 */
const REJECTS_TEMPERATURE = ["opus-4-7", "opus-4.7", "opus-4-8", "opus-4.8", "opus-5", "opus.5", "sonnet-5-5", "sonnet-5.5"];

/** 该模型需要的兼容性覆盖项；不需要时为 undefined。 */
export function anthropicCompatFor(modelId: string): AnthropicMessagesCompat | undefined {
	const id = normalize(modelId);
	const compat: AnthropicMessagesCompat = {};
	if (includesAny(id, REJECTS_TEMPERATURE)) compat.supportsTemperature = false;
	return Object.keys(compat).length > 0 ? compat : undefined;
}

/** 网关 id 会在厂商路径前加前缀（`anthropic/claude-opus-5`）；背后的模型是同一个。 */
function normalize(modelId: string): string {
	return modelId.toLowerCase().replace(/^~?anthropic\//, "");
}

function includesAny(id: string, needles: readonly string[]): boolean {
	return needles.some((needle) => id.includes(needle));
}
