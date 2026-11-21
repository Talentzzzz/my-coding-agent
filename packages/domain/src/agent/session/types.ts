// 压缩算法的公开类型（2026-11-21 自 context 包并入 session 包，ADR-0031）：压缩算法收显式参数时
// 经过的形状。`Context` 不在这里——它是传输机械，住 llm（§2.3）；消息与条目词汇住根 types.ts
// 共享内核，本包从那里取。
import type { AssistantMessage, Message, Usage } from "../types.ts";

/** 一次压缩的产物，随时可用 `appendCompaction` 写入。 */
export interface CompactionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** 摘要现在代表多少条消息。 */
	summarized: number;
	usage?: Usage;
}

export interface CompactionPreparation {
	firstKeptEntryId: string;
	/** 被摘要替换的消息，按顺序。 */
	messagesToSummarize: Message[];
	tokensBefore: number;
	/** 上一次压缩写的摘要，当本次是在其上精修而不是从头再来。 */
	previousSummary?: string;
}

/** session 知道怎么完成的一次补全；压缩提供 prompt，不管管道。 */
export interface SummarizeRequest {
	systemPrompt: string;
	prompt: string;
	maxTokens: number;
	signal?: AbortSignal;
}

/** 压缩的摘要回调：`Summarize` 仍由 Agent 提供（编排半），算法半只递出 prompt。 */
export type Summarize = (request: SummarizeRequest) => Promise<AssistantMessage>;
