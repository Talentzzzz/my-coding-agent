import type { ClientFrame } from "@my-agent/core/protocol";

/**
 * 读一个上行 frame，不是 frame 的东西一律返回 `undefined`。
 *
 * 这是服务器唯一的信任边界：它之上的一切都在 `ClientFrame` 值上工作并信任它们，所以形状在这里确立、且仅在这里。它刻意*不是*一个校验框架——两个动作没法被滥用成别的什么，为此引入一个 schema 库的代价比它要保护的东西还高。
 *
 * 两个拒绝背后都有明确的策略。不是 JSON 的、或不属于两个已知动作的 frame，由调用者丢弃并记日志，而不是断开连接：否则手写 smoke 脚本里的一个小错就会让窗口再也打不开，而"刷新一下就好"值得一行日志。
 *
 * 对不存在的会话发 `open`、或对已订阅的会话发 `open`，*不*在这里丢弃——那些是要应答的，连接层才是持有状态、能够应答的一方。
 */
export function parseClientFrame(text: string): ClientFrame | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

	const record = value as Record<string, unknown>;
	// 服务器不认识的字段被忽略而不是拒绝：`window` 在协议里有定义但暂无意义（没有任何东西产生它），发送它的客户端不该因此受罚。
	if (record.type === "open") {
		if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return undefined;
		return {
			type: "open",
			sessionId: record.sessionId,
			...(record.window === undefined ? {} : { window: record.window }),
		};
	}
	if (record.type === "cancel") {
		if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return undefined;
		return { type: record.type, sessionId: record.sessionId };
	}
	return undefined;
}
