// 从 pi-ai（0.99.2）vendor 而来。@ts-nocheck 让仓库根目录更严格的配置放过本文件，而进入
// packages/core 的每次 import 仍然被完整检查。
// @ts-nocheck
/**
 * 从字符串中移除未配对的 Unicode 代理字符。
 *
 * 未配对的代理（高位代理 0xD800-0xDBFF 没有配对的低位代理 0xDC00-0xDFFF，或反之）会让很多
 * API provider 在 JSON 序列化时报错。
 *
 * 合法的 emoji 和其他基本多文种平面之外的字符使用正确配对的代理，不会被本函数影响。
 *
 * @param text - 待清理的文本
 * @returns 移除了未配对代理的文本
 *
 * @example
 * // 合法 emoji（正确配对的代理）被保留
 * sanitizeSurrogates("Hello 🙈 World") // => "Hello 🙈 World"
 *
 * // 未配对的高位代理被移除
 * const unpaired = String.fromCharCode(0xD83D); // 没有低位伴随的高位代理
 * sanitizeSurrogates(`Text ${unpaired} here`) // => "Text  here"
 */
export function sanitizeSurrogates(text: string): string {
	// 替换未配对的高位代理（0xD800-0xDBFF 后面不是低位代理）
	// 替换未配对的低位代理（0xDC00-0xDFFF 前面不是高位代理）
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
