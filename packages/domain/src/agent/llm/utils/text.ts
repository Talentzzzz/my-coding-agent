// 从 pi-ai（0.99.2）vendor 而来。@ts-nocheck 让仓库根目录更严格的配置放过本文件，而进入
// packages/core 的每次 import 仍然被完整检查。
// @ts-nocheck
// `contentText` 已随共享内核收编进 agent 根 types.ts（分层重构 §2.3，context 也消费它）；这里从
// 内核取来给 getSystemMessageText 用。
import { contentText, type SystemMessage } from "../../types.ts";

/** 把 system message 渲染成它携带的 prompt 文本。 */
export function getSystemMessageText(message: SystemMessage): string {
	return contentText(message.content);
}
