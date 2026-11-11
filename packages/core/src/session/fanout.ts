import type { Message } from "../llm/index.ts";
import { spillOversizedToolResult } from "../context/spill.ts";
import { boundToolContent } from "../hooks.ts";
import { modelFor } from "../models.ts";
import type { SessionSnapshot } from "../protocol.ts";
import type { SettingManager } from "../setting-manager.ts";
import type { ToolManager } from "../tools/index.ts";
import type { AgentState } from "./agent-state.ts";
import { danglingApprovalsOf } from "./dangling.ts";
import type { AgentSessionEvent } from "./events.ts";
import { modelChoiceOf } from "./model-choice.ts";
import type { Session, SessionManager } from "./session-manager.ts";
import { sessionSnapshot } from "./snapshot.ts";
import { followsGlobalOf, toolStateOf } from "./tool-config.ts";

/**
 * fanout 调用要读取的三个服务，在调用点传入。
 *
 * 下面每个函数都是无状态的——只作用于递给它的状态和服务——所以谁都不是任何东西的成员。orchestrator
 * 的命令面和它的 run 都通过它们发布、追加、投影，这正是引擎不必自带 fanout 的原因：ADR-0008 的
 * 规则——有状态的部分成为成员，无状态的成为文件级函数——应用到了两者共享的那一半上。
 */
export interface SessionServices {
	sessionManager: SessionManager;
	settings: SettingManager;
	tools: ToolManager;
}

/**
 * 当前生效的审批表：目录的设置，加上这个 session 自己的选择叠在其上。
 *
 * 闸门、快照、prompt 三者共同的唯一读取点——三者回答同一个问题，所以谁都不许绕开它单独去读设置。
 * session 自己的那一半是记录在案的选择，从工具集旁边的 `.json` 快照读出。
 */
export function approvalsOf(services: SessionServices, session: Session): Record<string, boolean> {
	return {
		...services.settings.getApprovals(session.sessionSetting.workDirAbsPath),
		...toolStateOf(services.sessionManager, session, services.settings, services.tools.names()).approvalOverride,
	};
}

/**
 * 这个 session 没有任何其他消息会与之重复的时间戳。
 *
 * `Date.now()` 不够：同一毫秒内排队的两条消息会无法区分，其中一条的 echo 会被误认成另一条。从
 * 账本推导而不是持有计数器，所以重启——会忘掉所有计数器——也仍然发不出已有消息占用的戳：文件里
 * 最新的时间戳就是下限。
 */
export function nextStamp(sessions: SessionManager, session: Session): number {
	let newest = 0;
	for (const entry of sessions.getEntries(session)) {
		if (entry.type !== "message") continue;
		const stamp = entry.message.timestamp;
		if (typeof stamp === "number" && stamp > newest) newest = stamp;
	}
	return Math.max(Date.now(), newest + 1);
}

/**
 * 一个 session 的状态，从调用方打开的 transcript 和它的 run 正在做的事读出。
 *
 * `sessionSnapshot` 被填满的那一半：冷读者必须被告知的一切，这里从活的那一半读——run 的模型、
 * partial 消息、两个队列、重试状态——其余都从递进来的 transcript 推导。orchestrator 的 `snapshot`
 * 和 fanout 的发布都从这里回答，所以窗口 frame 和 REST 读取不可能互相矛盾。
 *
 * 袋是参数而不是状态的字段（ADR-0019）：run 带着它在开头打开的那个，命令带着它为调用长度打开的
 * 那个，两者都不在调用之间留存。
 */
export function snapshotOf(state: AgentState, session: Session, services: SessionServices): SessionSnapshot {
	const live = state.live;
	return sessionSnapshot({
		sessions: services.sessionManager,
		session,
		workDirAbsPath: session.sessionSetting.workDirAbsPath,
		// run 自己的模型就是请求发出时用的那个，计量测的是答案真正针对的窗口。空闲的 session 没有
		// run 可问，所以在这里从袋和设置推导——和所有其他读者用的推导相同（`modelChoiceOf`，
		// ADR-0019），这也是没有一份会过期的种子副本的原因。
		model: live.model ?? modelFor(modelChoiceOf(services.sessionManager, session, services.settings, live.openedOn), services.settings.modelCatalog()),
		approvals: approvalsOf(services, session),
		allTools: services.tools.names(),
		activeTools: toolStateOf(services.sessionManager, session, services.settings, services.tools.names()).activeToolNames,
		// 按这个目录自己的设置来判断，和冷读判断的方式相同，这样面板的「沿用全局」标签在两条路径
		// 上就不会自相矛盾。
		...followsGlobalOf(services.sessionManager, session, services.settings, services.tools.names()),
		...(live.partial === undefined ? {} : { partial: live.partial }),
		submitting: live.activeRun !== undefined,
		queued: live.followUpQueue.previews(),
		isRetrying: live.retrying,
		retryAttempt: live.retryAttempt,
		pendingApprovals: live.activeRun === undefined ? danglingApprovalsOf(services.sessionManager.buildContextEntries(session)) : [],
	});
}

/** 把一个事件 fanout 出去。session 发布事件的唯一地点。 */
export function emitEvent(state: AgentState, event: AgentSessionEvent): void {
	for (const listener of state.eventListeners) listener(event);
}

/**
 * 发布队列当前的内容。
 *
 * 只在队列本身变化的地方调用——一条消息被接上、一个取走点取走一条、run 丢掉它没到达的消息——所以
 * 不保留 baseline：调用这个事实就是变化。队列从活的那一半读。
 */
export function emitQueueUpdate(state: AgentState): void {
	emitEvent(state, { type: "queue_update", queued: state.live.followUpQueue.previews() });
}

/**
 * 追加一条消息条目并宣布它。
 *
 * 消息条目的两个写入方都经过这里——prompt 的乐观 user 写入，以及 run 自己的事件 sink 接引擎交回
 * 的一切——所以跟随 `entry_appended` 的 listener 看到的是完整的 transcript，而不只是引擎那一半。
 * 它也是写入边界：账本保留的 tool result 版本在这里一次性决定。
 */
export function appendMessageEntry(state: AgentState, session: Session, sessions: SessionManager, message: Message): void {
	// 在已有后继的消息处追加是一条*新的*备选分支，而不是它末尾的延续——回退再问一次就是这样。树
	// 在那里多了一个分支点，所以要告诉窗口叶子在哪，和移动分支的做法一样：它们的分支点来自快照，
	// 而这次追加改变了它们。
	// 计数是原始子节点数，所以 `leaf` 条目——记录分支移动的条目——也算在内。代价是多发一帧没有
	// 额外分支点的完整快照，无害。
	const parent = session.leafId;
	const continued = parent !== null && sessions.getChildren(session, parent).length > 0;

	const entryId = sessions.appendMessage(session, finalizeToolResult(session, message));
	// 文件从这里开始存在，袋不再是 session 唯一的副本：活的那一半丢掉它，之后的每次读取都是重放
	// （ADR-0019）。
	if (session.fileCreated) state.live.unwritten = undefined;
	if (continued) emitEvent(state, { type: "branch_changed", leafId: entryId });
	emitEvent(state, {
		type: "entry_appended",
		entryId,
		kind: "message",
		// 读者过去要向 transcript 问的三个事实，改由事件携带：侧栏行不用每追加一条消息就重放一次。
		at: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
		role: message.role,
		// 只有 user 消息能命名会话，所以只有它携带行里要显示的标题——`getTitle` 背后的遍历不值得
		// 每次回复都付一遍。
		...(message.role === "user" ? { title: sessions.getTitle(session) } : {}),
	});
}

/**
 * 清空 run 留下的队列。
 *
 * run 结束时还在排队的消息是 run 没有到达的——abort、失败、恰好在引擎停止查看的时刻到达的 prompt。
 * 没有东西会取走它们，而发送契约是 fire-and-forget：消息随 run 一起丢，不会未经要求就存起来，队列
 * 清空后深度归零——这正是 `settle()` 等待的东西——后面的 run 也不会继承这条 run 没拿走的。
 *
 * 返回是否真的丢了东西，这样调用方只在有变化时才发布队列变更。
 *
 * 唯一不来这里的收尾是闸门的：suspended 的 run 为回答要启动的恢复 run 保留队列，由它在取走点取走
 * （`live.suspended`）。放弃清扫是这个例外的例外——`Agent.denyAllApprovals` 调用这里，因为不会有
 * 恢复 run 来取它们。
 */
export function dropQueued(state: AgentState): boolean {
	const dropped = state.live.steeringQueue.size > 0 || state.live.followUpQueue.size > 0;
	state.live.steeringQueue.clear();
	state.live.followUpQueue.clear();
	return dropped;
}

/** 告诉所有 listener 现在这个 session 长什么样，从调用方持有的 transcript 读出。 */
export function publishState(state: AgentState, session: Session, services: SessionServices): void {
	const snapshot = snapshotOf(state, session, services);
	for (const listener of state.listeners) listener(snapshot);
}

/**
 * 账本保留的 tool result 版本，在写入边界一次性决定。
 *
 * 这是入口处没有任何东西限流的 result 的兜底——每个内置工具都给自己输出限流，`after_tool` 改写到
 * 这里时已是最终版，剩下的只有忘记限流的工具。对 context 来说过大的 result 会在工作目录下整体
 * 归档（`context/spill.ts`），存储为头尾加归档路径，丢不掉任何读不回来的东西；归档写不出来时，
 * `boundToolContent` 的硬截断就是底线。其余情况原样通过：对限流良好的 result，整个检查只是一次
 * 长度求和。
 *
 * 在这扇每次写入都经过的门上运行它，请求才能按账本原样读取：盘上的内容就是喂给模型的内容，本进程
 * 和后续每个进程都一样。
 */
function finalizeToolResult(session: Session, message: Message): Message {
	if (message.role !== "toolResult") return message;
	const spilled = spillOversizedToolResult(
		session.sessionSetting.workDirAbsPath,
		session.sessionId,
		message.toolName,
		message.toolCallId,
		message.content,
	);
	const content = spilled ?? boundToolContent(message.content);
	return content === undefined ? message : { ...message, content };
}
