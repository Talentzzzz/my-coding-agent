import { anthropicMessages, type ChatTransport } from "./llm/index.ts";
import { Agent, type SessionSink } from "./agent.ts";
import type { AssembleAgentStateOptions, OpenAgentOptions } from "./assembly.ts";
import { buildSystemPrompt } from "./context/system-prompt.ts";
import { createHooks, type Hooks } from "./hooks.ts";
import { SessionManager } from "./session/session-manager.ts";
import { approvalToolsOf } from "./settings.ts";
import { SettingManager } from "./setting-manager.ts";
import { type ToolManager, createToolManager } from "./tools/index.ts";

/**
 * 调用方为构建一个进程唯一的编排层所提供的东西。
 *
 * 这里的一切都是进程级的：配置住在哪，以及每个请求从哪条传输层离开。三只 Manager 本身不在清单上
 * ——工厂自己造它们，正是这一点让「表里的每个状态都是在该编排层自己的服务之上装配的」成为构造
 * 的事实，而不是调用方必须遵守的约定。两个接受成品 Manager 的接缝只为测试存在：smoke 递一只内存
 * {@link SettingManager} 进来，让机器自己的文件靠边站，再在自己的工具表上注册自己的工具，让它
 * 注册的东西到不了测试之外的会话。生产代码两样都不设。
 */
export interface CreateSessionAgentOptions {
	/**
	 * 全局设置读取与写入所在的 agent home。默认用真实的那一个。
	 *
	 * 测试「会*写*设置」的命令的 smoke 不得写机器自己的 `settings.json`；桌面外壳与服务器透传它们
	 * 启动时所带的。
	 */
	settingsHome?: string;
	/**
	 * 导入的模型行读取与写入所在的 agent home。默认用
	 * {@link CreateSessionAgentOptions.settingsHome}。
	 *
	 * 另一个文件的同居 home：递入自己模型行的 smoke 不得把它们留在机器的 `models.json` 里，也不得
	 * 依赖运行它的人配置了什么。
	 */
	modelsHome?: string;
	/** 该编排层发出的每个请求走的传输层。默认 Anthropic Messages。 */
	api?: ChatTransport;
	/** 仅测试的接缝：调用方自己的设置门，取代各 home 背后的文件。 */
	settings?: SettingManager;
	/** 仅测试的接缝：调用方自己的工具表，取代六个内置工具。 */
	tools?: ToolManager;
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
 * 构建编排层：一个对象配它自己的几只 Manager，装好它分发所经的接缝。
 *
 * 跑一个进程所有会话的宿主调用它一次；想要一个不与任何人共享的会话的调用方——smoke、测试——
 * 每个会话调用一次，并把该会话打开到它上面。无论哪条路，会话设置的两半都是同样的两半，所以宿主
 * 跑的与 smoke 驱动的不可能漂移开。
 *
 * 默认处理器安装在调用方拿回来的那个面上，而不是硬编码进类里，宿主得以在它们之后加处理器、在
 * 它们的决定上精修。见 {@link installDefaultHooks}。
 */
export function createSessionAgent(options: CreateSessionAgentOptions = {}): Agent {
	const hooks = createHooks();
	// 只解析一次并交给编排层，它是读取一次运行可执行集合的唯一表，也是命令收窄的唯一表：在这里做
	// 第二次解析，会让调用方自己的工具到达其中一者而到不了另一者。
	const tools = options.tools ?? createToolManager();
	const agent = new Agent({
		sessionManager: new SessionManager(),
		settings: options.settings ?? new SettingManager({ home: options.settingsHome, modelsHome: options.modelsHome }),
		tools,
		hooks,
		// 进程唯一的装配处：传输层在这里解析而不是在编排层内部给默认值，让一次运行能离开进程的每条
		// 路都由一个文件决定。
		api: options.api ?? anthropicMessages,
		// 分发的唯一出口：宿主的实现在它的分发表上应答，no-op 缺省就是空表遍历零次的语义——没人
		// 听就什么也不发生。
		sink: options.sink ?? noOpSink,
		// 活跃集或审批集一变就重建，让 prompt 无法许诺会话已不再拥有的工具或审批。工作目录与项目指示
		// 按请求递交、出于与不被捕获同样的理由：一个 builder 服务该编排层跑的所有会话，这两个事实属于
		// 会话，不属于 builder。
		systemPrompt: (workDirAbsPath, agentsMd, toolNames, approvals) =>
			buildSystemPrompt({
				workDirAbsPath,
				toolNames,
				// 映射闸住的每个工具，不只是活跃的那些：映射是会话完整的决定，被收窄掉的工具，prompt
				// 仍该说它被闸着，而不是悄悄略去。
				approvalTools: approvalToolsOf(approvals),
				agentsMd,
			}),
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
 * 在那里接住没人约束过的结果而不必花一个 hook；想自己约束结果的 hook 用 `archiveToolResult` 归档
 * 全文并把路径放进返回的 content。
 */
function installDefaultHooks(hooks: Hooks, session: Agent): void {
	hooks.on("before_tool", async ({ sessionId, toolCallId, toolName, args }) => {
		const needsApproval = await session.authorize(sessionId, toolName, toolCallId, args);
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
 * options 有意是一组测试接缝：settings 与 tools 接缝直通工厂，会话记录与模型 options 交给
 * `assembleAgentStateBySession`，这里不构建任何编排层不留住的 Manager。
 */
export async function openAgent(options: OpenAgentOptions): Promise<Agent> {
	const agent = createSessionAgent({
		...(options.settings === undefined ? {} : { settings: options.settings }),
		...(options.tools === undefined ? {} : { tools: options.tools }),
		...(options.api === undefined ? {} : { api: options.api }),
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
