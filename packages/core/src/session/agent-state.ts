import type { Message, Model } from "../llm/index.ts";
import type { QueueMode } from "../protocol.ts";
import { PendingMessageQueue } from "./queues.ts";

/**
 * 一次进行中的 run：调用方用来停止它的句柄，以及 run 留下的 run 本地句柄。
 *
 * abort controller 是各层 abort 的落脚点——session 的、hub 的、进程关停的。promise/resolve 对是
 * 这条 run 的 context 句柄："等待这条 run 落定"由 promise 兑现，而触发 resolve 的正是结束这条 run
 * 的引擎，所以这一对跟着 run 走，不寄存在任何更长寿的地方。
 */
export interface ActiveRun {
	abortController: AbortController;
	/** run 本身以及所有 await 它的 listener 都落定后兑现。 */
	promise: Promise<void>;
	/** 内部用：完成 {@link ActiveRun.promise}，引擎自己留着收尾。 */
	resolve: () => void;
}

/**
 * 本进程已知的一个 session，装在一个袋里：活的那一半。
 *
 * 持久的那一半刻意不在这里（ADR-0013）：session 的会话记录是一对文件，每个需要它的操作都
 * 现开现放——run 在开头开一个并持有到结束，命令开一个只持有一个调用的长度。剩下的正是文件回答
 * 不了的——排了什么队、在跑什么、还没落盘的是什么。订阅者也不在这里：分发经构造注入的
 * {@link SessionSink} 离开编排层，per-session 的分发表归宿主（hub）所有。进程重启刻意丢弃全部
 * 状态：会话记录从文件重放，活的那一半本来就是盘上没有的部分。
 */
export interface AgentState {
	/** 这个状态属于哪个 session；即它的 key，随身携带免得调用方重复传。 */
	readonly sessionId: string;
	/** session 活的那一半：进行中的、盘上没有的。 */
	readonly live: Live;
}

/**
 * 一个 session 进行中的、盘上没有的东西。
 *
 * 两个队列装的是 run 中途接收、还没被 run 取走的消息——取走的消息在取走点落盘，所以没消费的只存在
 * 这里。`activeRun` 是在飞的 run；`partial` 是它正在写的 assistant 消息，run 中途接上的窗口需要
 * 这些字符；`model` 是 run 的流式来源，run 中途的快照要从 run 回答而不是重新查一遍——run 在飞时
 * 用 Live，空闲时用袋。`retrying` / `retryAttempt` 是重试策略对外的一面；`suspended` 标记 run
 * 停在审批闸门处。
 *
 * 进程重启刻意丢弃全部：排队的消息丢了，订阅者重新挂，session 文件不会丢——这正是丢弃可承受的原因。
 */
export interface Live {
	/** 引到正在跑的 turn 里的消息，每个 turn 结束时取走。 */
	steeringQueue: PendingMessageQueue;
	/** 等 run 结束的消息，在 run 本该停下的地方取走。 */
	followUpQueue: PendingMessageQueue;
	/** 在飞的 run，session 空闲时没有。 */
	activeRun?: ActiveRun;
	/** run 正在写的 assistant 消息，空闲时没有。 */
	partial: Message | undefined;
	/** 在飞的 run 的流式来源模型，空闲时没有。 */
	model?: Model;
	/** 在飞的 run 的两次尝试之间正在退避时为 true。 */
	retrying: boolean;
	/** 在飞的 run 是第几次尝试，第一次重试之后才有意义。 */
	retryAttempt: number;
	/** 在飞的 run 停在审批闸门处时为 true。 */
	suspended: boolean;
}

/**
 * 构建一个空的 session 活的那一半。
 *
 * 队列模式由参数传入——是创建时设置的答案，由调用方通过自己的 {@link SettingManager} 读取；之后
 * 改动任一模式的配置补丁会就地写到队列上，所以这里没有东西被永久捕获。
 */
export function createLive(steeringMode: QueueMode, followUpMode: QueueMode): Live {
	return {
		steeringQueue: new PendingMessageQueue(steeringMode),
		followUpQueue: new PendingMessageQueue(followUpMode),
		partial: undefined,
		retrying: false,
		retryAttempt: 0,
		suspended: false,
	};
}

/**
 * 从活的那一半拼装一个 session 的状态。
 *
 * 状态就是活的那一半，仅此而已：会话记录是调用方按需打开的文件（ADR-0013），没有第三样东西要
 * 在这里收集。分发不经过这张袋——编排层把事件交给构造注入的 sink，订阅者挂在宿主的分发表上。
 * 活的那一半是造好才传进来的，因为它的队列模式是设置的答案，这里只接收链条产出的结果。
 */
export function createAgentState(sessionId: string, live: Live): AgentState {
	return {
		sessionId,
		live,
	};
}
