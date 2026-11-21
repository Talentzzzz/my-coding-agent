// context 包的公开脸（分层重构 §3 / §1.2）：六个实现文件是里子，ContextManager 是面。
//
// **编排留引擎，算法归 ContextManager。** 触发计算、候选选择、token 估算、摘要产出、prompt 装配与
// 结果归档住这里；触发序列、记账（`appendTrimToolCallArgs` / `appendClearToolResults` /
// `appendCompaction`）与发事件仍是 `Agent` 的私有方法（ADR-0016 的判据对引擎不变，变的只是算法
// 有了属主）。
//
// 无属性服务的新例（ADR-0006 修订，2026-11-21）：构造零依赖——空集，无状态，一个实例服务所有
// 会话；方法收显式参数（entries / contextWindow / workDirAbsPath / signal / `Summarize` 回调 /
// `project` 投影函数）。不要 ChatTransport（模型由调用方构造好传入）、不要 settings（阈值从
// `model.contextWindow` 现算）、不要 SessionManager（记账不归它）。
import { loadAgentsMd } from "./agents-md.ts";
import { compact as compactEntries, compactionThresholdFor, estimateTokens, shouldCompact } from "./compaction.ts";
import { spillOversizedToolResult } from "./spill.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import type { CompactionResult, Summarize } from "./types.ts";
import type { Api, Message, Model, SessionEntry, ToolResultContent } from "../types.ts";

export class ContextManager {
	/**
	 * 一次组合出请求的 system prompt：先 `loadAgentsMd` 再 `buildSystemPrompt`。
	 *
	 * 项目指示在这里、按请求读取，而不是从状态上取：磁盘文件的一次编辑应当抵达下一个请求。审批
	 * 工具的映射（`approvalToolsOf`）由 Agent 在调用前做——settings 知识归 agent 根；工具集同样由
	 * 调用方递进来，一条被捕获的 prompt 不会向模型许诺会话已不再拥有的工具或审批。
	 */
	async buildRequestPrompt(workDirAbsPath: string, toolNames: readonly string[], approvalTools: readonly string[]): Promise<string> {
		const agentsMd = await loadAgentsMd(workDirAbsPath);
		return buildSystemPrompt({ workDirAbsPath, toolNames, approvalTools, agentsMd });
	}

	/** 这个模型上的 session 在下一次请求之前触发压缩的 prompt 大小（算法半，§3）。 */
	compactionThresholdFor(contextWindow: number): number {
		return compactionThresholdFor(contextWindow);
	}

	/** 会话记录大到下一次请求有溢出窗口的风险时为 true（算法半，§3）。 */
	shouldCompact(messages: readonly Message[], threshold: number): boolean {
		return shouldCompact(messages, threshold);
	}

	/** 粗略 token 估算（算法半，§3）：约四个字符一个 token。 */
	estimateTokens(messages: readonly Message[]): number {
		return estimateTokens(messages);
	}

	/**
	 * 压缩会话记录：摘要一切已结束的内容，报告要保留的 turn。
	 *
	 * 条目投影由调用方注入（`project`——`sessionEntryToContextMessages`，session 包），摘要回调
	 * （`summarize`）仍由 Agent 提供：模型对象由调用方构造好传入，本包不认 ChatTransport，也不认
	 * session。这里什么都不写：调用方把结果交给 `appendCompaction` 记账。
	 */
	compact(
		entries: readonly SessionEntry[],
		project: (entry: SessionEntry) => Message[],
		model: Model<Api>,
		summarize: Summarize,
		signal?: AbortSignal,
	): Promise<CompactionResult | undefined> {
		return compactEntries(entries, project, model, summarize, signal);
	}

	/**
	 * 归档一条过大的 tool result，返回模型应看到的视图，否则返回 `undefined`（写边界调，§3）。
	 *
	 * `undefined` 意味着「不过大」或文件写不出来——调用方回落到 `boundToolContent` 的硬截断。
	 */
	spillOversizedToolResult(
		workDirAbsPath: string,
		sessionId: string,
		toolName: string,
		toolCallId: string,
		content: ToolResultContent,
	): ToolResultContent | undefined {
		return spillOversizedToolResult(workDirAbsPath, sessionId, toolName, toolCallId, content);
	}
}
