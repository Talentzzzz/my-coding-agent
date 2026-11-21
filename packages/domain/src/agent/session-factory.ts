import { anthropicMessages, type ChatTransport } from "./llm/index.ts";
import { Agent, type AssembleAgentStateOptions, type OpenAgentOptions, type SessionSink } from "./agent.ts";
import type { AgentsMdRepository } from "@my-agent/prompt";
import type { ToolResultsRepository } from "./session/tool-results-repository.ts";
import { createHooks, type Hooks } from "./hooks.ts";
import type { ModelRepository } from "./llm/model-repository.ts";
import { ModelManager } from "./llm/model-manager.ts";
import type { SessionDefaultsRepository } from "./session/session-defaults-repository.ts";
import type { SessionRepository } from "./session/session-repository.ts";
import { SessionManager } from "./session/session-manager.ts";
import { type ToolManager, createToolManager } from "./tool/index.ts";
import type { ToolDefaultsRepository } from "./tool/tool-defaults-repository.ts";

/**
 * 调用方为构建一个进程唯一的编排层所提供的东西。
 *
 * 这里的一切都是进程级的：六个存储端口（会话文件对、会话簇设置、模型行、工具簇设置、tool-results
 * 归档、项目指示收集）全部**必填**——domain 与 prompt 包都造不出 infra，「缺省真实 home」不再是
 * domain 的知识（分层重构 spec §5.2）；把 home 路径翻译成这些实现是组合根（`@my-agent/app`）的
 * 差事。几只 Manager 本身不在
 * 清单上——工厂自己造它们，正是这一点让「表里的每个状态都是在该编排层自己的服务之上装配的」成为
 * 构造的事实，而不是调用方必须遵守的约定。两个接缝只为测试存在：工具表接缝让 smoke 在自己的表上
 * 注册自己的工具，让它注册的东西到不了测试之外的会话；sink 让宿主接住分发。生产代码两样都不设。
 */
export interface CreateSessionAgentOptions {
	/** 会话文件对（`.json` 快照 + `.jsonl` 账本）的读写端口。 */
	sessionRepository: SessionRepository;
	/** 会话簇设置文件（`sessions.json`，迁移源 `settings.json`）的读写端口。 */
	sessionDefaultsRepository: SessionDefaultsRepository;
	/** 模型行（`models.json` 及其迁移源）的读写端口。 */
	modelRepository: ModelRepository;
	/** 工具簇设置文件（`tools.json`，迁移源 `settings.json`）的读写端口。 */
	toolDefaultsRepository: ToolDefaultsRepository;
	/** tool-results 归档的只写端口：写边界的兜底归档永远有处可去。 */
	toolResultsRepository: ToolResultsRepository;
	/** 项目指示收集的端口（@my-agent/prompt 声明，ADR-0031）：system prompt 按请求经它收 AGENTS.md。 */
	agentsMdRepository: AgentsMdRepository;
	/** 该编排层发出的每个请求走的传输层。默认 Anthropic Messages。 */
	chatTransport?: ChatTransport;
	/** 仅测试的接缝：调用方自己的工具表，取代六个内置工具。 */
	toolManager?: ToolManager;
	/**
	 * 事件与快照离开编排层的出口。缺省是 no-op。
	 *
	 * 生产宿主（hub）递入自己的实现并以此实现订阅；没有订阅者的调用方——`openAgent` 的 smoke——
	 * 省略它，no-op 精确保持「没人听就什么也不发生」的语义。
	 */
	sink?: SessionSink;
}

/** 没有订阅者的编排层的分发：什么都不做，让「没人听」不需要任何表存在。 */
const noOpSink: SessionSink = {
	onEvent(): void {},
	onState(): void {},
};

/**
 * 构建编排层：一个对象配它自己的几只 Manager 与设置簇持有者，装好它分发所经的接缝。
 *
 * 跑一个进程所有会话的宿主调用它一次；想要一个不与任何人共享的会话的调用方——smoke、测试——
 * 每个会话调用一次，并把该会话打开到它上面。无论哪条路，会话设置的两半都是同样的两半，所以宿主
 * 跑的与 smoke 驱动的不可能漂移开。
 *
 * 默认处理器安装在调用方拿回来的那个面上，而不是硬编码进类里，宿主得以在它们之后加处理器、在
 * 它们的决定上精修。见 {@link installDefaultHooks}。
 */
export function createSessionAgent(options: CreateSessionAgentOptions): Agent {
	const hooks = createHooks();
	// 只解析一次并交给编排层，它是读取一次运行可执行集合的唯一表，也是命令收窄的唯一表：在这里做
	// 第二次解析，会让调用方自己的工具到达其中一者而到不了另一者。
	const toolManager = options.toolManager ?? createToolManager({ toolDefaultsRepository: options.toolDefaultsRepository });
	const agent = new Agent({
		// 账本服务与各设置簇持有者（spec §8）：各持自己的端口，注入的组合根负责翻译——模型簇可经
		// 另一份实现分居。它们什么都不持有，每次读取都是对端口背后存储的一次新读。
		sessionManager: new SessionManager({
			sessionRepository: options.sessionRepository,
			sessionDefaultsRepository: options.sessionDefaultsRepository,
		}),
		modelManager: new ModelManager({ modelRepository: options.modelRepository }),
		toolManager,
		hooks,
		// 进程唯一的装配处：传输层在这里解析而不是在编排层内部给默认值，让一次运行能离开进程的每条
		// 路都由一个文件决定。
		chatTransport: options.chatTransport ?? anthropicMessages,
		// 压缩与填充的算法半是 session 包内的模块级函数（ADR-0031）：编排层直调，没有持有者要构造。
		// prompt 装配走 @my-agent/prompt 的 buildRequestPrompt；审批映射仍由编排层在调用前做
		// （settings 知识归 agent 根）。归档与项目指示两个端口归编排层持有（§4.3、ADR-0031），分别
		// 经写边界与 prompt 门面递入。
		toolResultsRepository: options.toolResultsRepository,
		agentsMdRepository: options.agentsMdRepository,
		// 分发的唯一出口：宿主的实现在它的分发表上应答，no-op 缺省就是空表遍历零次的语义——没人
		// 听就什么也不发生。
		sink: options.sink ?? noOpSink,
	});
	// 闸门安装在调用方拿回来的面上、在构造之后，因为它经它所属的编排层分发（`session.authorize`）
	// ——内建在类里的处理器只能够到它所需的一半。
	installDefaultHooks(hooks, agent);
	return agent;
}

/**
 * 每个编排层分发所经的默认处理器。
 *
 * `before_tool` 就是审批闸门。会话记录还在等什么、以及回答它的 UI，这些簿记归会话所有；这个
 * hook 只把一个未获回答的审批翻译成结束运行的 suspend（ADR-0005 §5）：调用在账本里悬空、没有
 * 结果——横幅正是从它派生的——答案经 REST 抵达，启动把它配对并续跑的恢复运行。
 *
 * 没有默认的 `after_tool`：那里的改写是定稿——账本保存的正是 hooks 返回的内容——所以这条接缝
 * 属于有理由改写的人。曾经住在这里的输出兜底搬去了写边界（`agent.ts` 的 `finalizeToolResult`），
 * 在那里接住没人约束过的结果而不必花一个 hook；想自己约束结果的 hook 用 `archiveToolResult`（session
 * 包，ADR-0031 自 context 包并入）归档全文并把路径放进返回的 content。
 */
function installDefaultHooks(hooks: Hooks, agent: Agent): void {
	hooks.on("before_tool", async ({ sessionId, toolCallId, toolName, args }) => {
		const needsApproval = await agent.authorize(sessionId, toolName, toolCallId, args);
		return needsApproval ? { suspend: true } : undefined;
	});
}

/**
 * 打开一个会话，交回一个属于它自己的编排层。
 *
 * 调用方不与其他任何东西共享编排层时想要的组合方式：驱动脚本化传输层的 smoke，或手工打开一个
 * 目录的测试。跑很多会话的进程改为只构建一次编排层，并把每份会话记录打开到它上面——见 hub
 * ——保持诚实正是这个东西存在的理由：打开会话与恢复会话是同一个动作，无论走两条路中的哪一条。
 *
 * options 有意是一组必填端口加测试接缝：ports 直通工厂，会话记录与模型 options 交给
 * `assembleAgentStateBySession`，这里不构建任何编排层不留住的 Manager。
 */
export async function openAgent(options: OpenAgentOptions): Promise<Agent> {
	const agent = createSessionAgent({
		sessionRepository: options.sessionRepository,
		sessionDefaultsRepository: options.sessionDefaultsRepository,
		modelRepository: options.modelRepository,
		toolDefaultsRepository: options.toolDefaultsRepository,
		toolResultsRepository: options.toolResultsRepository,
		agentsMdRepository: options.agentsMdRepository,
		...(options.toolManager === undefined ? {} : { toolManager: options.toolManager }),
		...(options.chatTransport === undefined ? {} : { chatTransport: options.chatTransport }),
		...(options.sink === undefined ? {} : { sink: options.sink }),
	});
	// 状态在这里进入编排层的表，走的是 hub 用的同一扇门——它如今是类私有的
	// （`assembleAgentStateBySession`）：调用方拼得出的动词是 `createAndPrompt` 与删除动词
	// （hold / release 已随计数上移 hub，不再是 core 的动词），而 TypeScript 没法说「core 内部」，所以这条唯一获批的组合之路像 smoke 够
	// 其他私有半一样够到这扇门。这个断言就是接缝，本文件是它在生产侧唯一的读者。
	const door = agent as unknown as { assembleAgentStateBySession(options: AssembleAgentStateOptions): Promise<unknown> };
	await door.assembleAgentStateBySession(options);
	return agent;
}
