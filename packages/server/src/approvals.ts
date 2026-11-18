/**
 * 审批的答案表：屏幕上的每个审批被如何应答，以及谁在展示它。
 *
 * 整张表一起住在业务侧，而不是拆成「记忆进 hub、计数留在流」：`remember` 的前提是"有订阅正在
 * 展示它"——没人展示就不记——记忆与可见性是同一件事的两面，所以它们不拆两半（spec `### 审批答案表`）。
 * 它由 boot 创建一份、注入每条流，跨连接共享；mux 对这个对象一无所知。
 */

/** 一个正被展示的审批：要上报的答案，以及有多少读者在展示它。 */
interface ShownApproval {
	/** 它被如何应答；无人另有表示时视为拒绝。 */
	approved: boolean;
	/** 此刻正在展示它的订阅数。 */
	showing: number;
}

/**
 * 屏幕上的审批如何被应答，以及谁在展示。
 *
 * 每个有订阅在屏幕上展示的审批一个 entry，因为那就是一个事实：上报答案的帧是那个订阅自己的差量，所以展示审批的订阅是它的答案唯一会有的读者，答案值得持有的时间恰好等于计数大于零的时间。
 *
 * entry 按会话一张表，这个键控是本层自己拍板的决定而不是继承来的。两个会话碰巧共用的 `toolCallId` 是两个审批——若干 Anthropic 兼容端点对 tool call 用同样的编号方式——一个被批准绝不能到达另一个的窗口。
 */
export interface ApprovalAnswers {
	/** 记下一个答案，给将要上报它的那些订阅——且仅在其中有订阅能上报时。 */
	remember(sessionId: string, toolCallId: string, approved: boolean): void;
	/** 这个审批被如何应答。没有记录时，拒绝就是答案。 */
	wasApproved(sessionId: string, toolCallId: string): boolean;
	/** 又一个订阅开始展示这个审批。 */
	show(sessionId: string, toolCallId: string): void;
	/** 一个订阅不再展示；最后一个读者离开时随之丢弃。 */
	hide(sessionId: string, toolCallId: string): void;
}

export function createApprovalAnswers(): ApprovalAnswers {
	/** 按会话，其订阅正在屏幕上展示的审批。 */
	const shown = new Map<string, Map<string, ShownApproval>>();

	return {
		remember(sessionId, toolCallId, approved) {
			const approval = shown.get(sessionId)?.get(toolCallId);
			// 无可记录：没有订阅在展示它，永远不会有什么帧去上报它。硬存一个只会让没有答案的问题活得比被告知的进程还久。
			if (approval === undefined) return;
			approval.approved = approved;
		},
		wasApproved(sessionId, toolCallId) {
			return shown.get(sessionId)?.get(toolCallId)?.approved ?? false;
		},
		show(sessionId, toolCallId) {
			const perSession = shown.get(sessionId) ?? new Map<string, ShownApproval>();
			if (!shown.has(sessionId)) shown.set(sessionId, perSession);
			const approval = perSession.get(toolCallId);
			if (approval === undefined) perSession.set(toolCallId, { approved: false, showing: 1 });
			else approval.showing += 1;
		},
		hide(sessionId, toolCallId) {
			const perSession = shown.get(sessionId);
			const approval = perSession?.get(toolCallId);
			if (perSession === undefined || approval === undefined) return;
			approval.showing -= 1;
			if (approval.showing <= 0) perSession.delete(toolCallId);
			// 与按会话的 entry 同样的卫生：空表没有理由活得比最后一个本会从中上报的读者更久。
			if (perSession.size === 0) shown.delete(sessionId);
		},
	};
}
