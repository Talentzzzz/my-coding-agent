// 从 pi-ai（0.99.2）裁剪到本应用驱动的范围：一次请求所依赖的模型事实。上游这个文件还是 provider
// 注册表——`Provider`、`Models`、`createProvider`、auth 解析和随之而来的按类型分发——这些在这里
// 都没有活下来。本应用只有一个传输、每个模型一把 key，所以一目录的 provider 只是一行条目的注册表，
// 其全部内容还是一个已经持有的字符串。@ts-nocheck 让仓库根目录更严格的配置放过本文件，而进入
// packages/core 的每次 import 仍然被完整检查。
// @ts-nocheck
import type { ThinkingLevel } from "./types.ts";

export { ModelsError, type ModelsErrorCode } from "./utils/models-error.ts";

/**
 * 本构建能驱动的每个模型被请求的 level，从低到高。
 *
 * 这个列表是常量，因为答案已不再依赖模型：effort 是这条 wire 携带的唯一强度，每个 Anthropic-Messages
 * 端点都接受这三档，不能思考的模型就停在 `off`。它就是 `ThinkingLevel` 指名的那个列表，也是
 * composer 渲染的那个。
 */
const SUPPORTED_THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "high", "max"];

/** session 可以处于的所有 thinking level，从低到高。 */
export function getSupportedThinkingLevels(): ThinkingLevel[] {
	return [...SUPPORTED_THINKING_LEVELS];
}
