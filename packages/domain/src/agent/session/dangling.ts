import type { PendingApproval } from "./snapshot.ts";
import { describeToolCall } from "../tool/index.ts";
import type { SessionEntry } from "./session-manager.ts";

/**
 * 会话记录还在等待的 tool call，从账本读出而不是在内存里持有（ADR-0005 §5）：视图的 assistant
 * 消息里带着、而同一视图里没有 tool result 回答的 call。
 *
 * 这是审批流程所依赖的派生态。在 end-restart 语义下，一条等待中的审批*就是*悬空的 call——run 已经
 * 结束、tool result 还没落盘、回答经由 REST 到达来收尾——所以横幅、端点的 409 检查、deny 清扫读的
 * 都是这个推导，而不是再养一份要和文件保持同步的内存驻留清单。被清空的 result 不算悬空 call：清空
 * 只是把模型看到的内容掏空，result 消息本身留在视图里回答它的 call。
 *
 * 这些条目是分支的 context 视图——和构建请求用的是同一份选择——所以模型会不带 result 重发的 call，
 * 正好就是这里报告的 call。
 */
export function danglingApprovalsOf(entries: readonly SessionEntry[]): PendingApproval[] {
	const calls: PendingApproval[] = [];
	const answered = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			answered.add(message.toolCallId);
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			calls.push({
				toolCallId: block.id,
				toolName: block.name,
				args: block.arguments,
				summary: describeToolCall(block.name, block.arguments),
			});
		}
	}
	return calls.filter((call) => !answered.has(call.toolCallId));
}
