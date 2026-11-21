/**
 * 「这个 id 不指名任何 session」这一失败，以类型而不是句子的形式。
 *
 * 它存在的意义是让传输层不必先*问*再行动。要先检查存在性的调用方，是可能把答案搞错两次的调用方
 * ——问的时候错一次，问题和命令之间答案变化时再错一次——而且这个检查必须在每个端点的同一处拼写。
 * 在这里由命令本身拒绝，传输层把一个类型映射到一个状态码，这就是每条 unknown-id 路径的形状：读取、
 * 删除、hold、prompt 都一样。
 *
 * 消息保持稳定，因为它同时也是客户端展示的 404 body：`Unknown session: <id>`。
 */
export class UnknownSessionError extends Error {
	/** 没指名任何东西的 id，给需要区分多个 id 的调用方。 */
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Unknown session: ${sessionId}`);
		this.name = "UnknownSessionError";
		this.sessionId = sessionId;
	}
}
