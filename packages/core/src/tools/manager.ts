// 本构建的工具侧：一张它认识的每个工具的表，以及一个 session 可以调用其中哪些的纯数据选择
// （ADR-0016）。
//
// 表是常驻的，选择不是。表里放的是纯行为——六个与目录无关的实例，加上测试注册的任何东西——所以
// 持有它们的代价是进程生命周期的常量，而不是一个 session 的状态。调用所需、且会随请求变化的一切
// （工作目录、`bash` 超时）随 `execute` 的 `run` 到达，这正是让一个实例服务所有 session 的原因。

import type { Tool, ToolResult, ToolRunContext, ToolUpdateCallback } from "../llm/index.ts";
import { DEFAULT_MODE_NAME, type ModeSettings } from "../config.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

/**
 * 工具行动所用的 per-request 值，从 wire 类型 re-export。
 *
 * 它是 `execute` 的第三个参数，所以它的家在 `Tool` 旁边（ADR-0015 §2）：这个 re-export 让所有既有
 * 的 import 路径——`tools/index.ts`、`agent.ts`、smoke 测试——继续指向同一个名字。
 */
export type { ToolRunContext };

// ---------------------------------------------------------------------------- 状态

/**
 * 一个 session 所处的工具选择，纯数据：session 的 `.json` 快照记录的内容。
 *
 * `activeToolNames` 是模型可以调用的；`approvalOverride` 是 session 自己的审批表叠在全局默认之上，
 * session 从未选择、跟随全局时为 undefined。名字可以包含本构建已不认识的工具——记录的集合在 fill
 * 和装配时收窄，从不把收窄后的存回去，所以降级再升级仍能保住选择。
 */
export interface ToolState {
	activeToolNames: string[];
	approvalOverride?: Record<string, boolean>;
}

/** 内置默认模式的名字，由设置配置持有（ADR-0005）。 */
export { DEFAULT_MODE_NAME };

/**
 * 一次 fill 所依据的 context：种子要对照的设置。
 *
 * `globalTools` 是全局默认的工具集，按设置文件的拼写，未指名时是全集；`known` 是本构建实际能构建
 * 的，不在其内的名字被丢弃而不是被抛错——手改的设置文件不欠 catalog 任何顺序和任何成员资格。
 * 默认视图的审批一半不需要输入：它是「跟随全局审批」，读者通过合并活设置来实现。
 */
export interface ToolFillContext {
	modes: readonly ModeSettings[];
	globalTools: readonly string[];
	known: readonly string[];
}

/** 丢掉本构建不认识的名字，保留种子指名的顺序。 */
export function narrowToKnown(names: readonly string[], known: readonly string[]): string[] {
	return names.filter((name) => known.includes(name));
}

/**
 * 把一个模式种子填成完整的 {@link ToolState}。
 *
 * 产物是真相，种子只是指针：未知的模式名抛异常，因为被要求在一个没人定义过的模式里运行的 session
 * 没有任何配置可回落，必须说出来，而不是按调用方没打算要的配置跑起来。缺失或「默认」的种子就是
 * 内置默认模式——全局默认的活视图，全套工具加全局审批——不读任何存储的模式条目，因为这个模式
 * 从不落盘：它回答的就是设置文件本身，设置一改就是这个模式变了。
 *
 * 默认视图让 `approvalOverride` 保持 undefined 而不是把全局表拷进来：拷贝会把审批冻结在 fill 时刻，
 * 而 undefined 意味着「session 从未选择」，每个读者都对照活设置合并。与之相反，具名模式的审批表
 * *就是*一个选择，整体携带。
 */
export function fillTools(modeName: string | undefined, context: ToolFillContext): ToolState {
	if (modeName === undefined || modeName === DEFAULT_MODE_NAME) {
		return { activeToolNames: narrowToKnown(context.globalTools, context.known) };
	}

	const mode = context.modes.find((candidate) => candidate.name === modeName);
	if (mode === undefined) throw new Error(`Unknown mode: ${modeName}`);
	return {
		activeToolNames: narrowToKnown(mode.tools, context.known),
		approvalOverride: { ...mode.approval },
	};
}

// ---------------------------------------------------------------------------- 表

/**
 * 六个内置工具，按提供给模型的顺序。零参工厂：一个工具不闭包任何东西，所以表可以把产物持有到
 * 进程结束。
 */
const builtIns: readonly (() => Tool<any>)[] = [
	() => createReadTool(),
	() => createWriteTool(),
	() => createEditTool(),
	() => createGlobTool(),
	() => createGrepTool(),
	() => createBashTool(),
];

/**
 * 一个进程认识的工具：持有每个实例的 `Map<name, Tool>`，加上注册进来的。
 *
 * 只有结构——什么存在于此，不是什么被选择。选择是从账本每次读取时推导的 {@link ToolState}
 * （`session/tool-config.ts` 的 `toolStateOf`），所以这张表从不回答「这个 session 可以调用它吗」：
 * 引擎对照它推导的名字回答这个问题。一个注册工具是否被提供是同一个问题，在同一个地方回答。
 *
 * 这个类还拥有的是调用本身：{@link ToolManager.execute} 解析一个名字并转发给它指名的实例，所以
 * 手里有一个名字加上本次调用的 `run` 值的调用方，运行一个工具不需要别的。行为留在实例上，校验、
 * 闸门、事件和结果写回留在引擎里。
 */
export class ToolManager {
	/** 本进程认识的每个工具，按提供给模型的顺序。从不替换。 */
	private readonly all = new Map<string, Tool<any>>();

	/**
	 * 这张表持有的每个工具的名字：六个内置，然后是注册的。
	 *
	 * 是读出来的，不是记住的——key 就是表自己的，所以之后注册的名字在下一次读取就会出现，不需要
	 * 失效任何东西。
	 */
	names(): string[] {
		this.ensureFilled();
		return [...this.all.keys()];
	}

	/**
	 * 按名字取一个工具，本构建没有它时为 undefined。
	 *
	 * 每次都是同一个对象：表填充一次、条目从不替换，所以在 `prepareRequest` 持有实例的 run 和
	 * 在批次中途查找它的 run 看到的是同一个工具。
	 */
	get(name: string): Tool<any> | undefined {
		this.ensureFilled();
		return this.all.get(name);
	}

	/**
	 * 运行一次工具调用：查工具并转发，带上本次调用自己的 run 值。
	 *
	 * 它不决定这次调用是否被允许，也不做校验：这里出现未知名字是上游的 bug——引擎在请求调用之前
	 * 就解析并闸门过名字——所以它抛异常，而不是合成一个模型能看到的第二个 result。
	 */
	async execute(
		name: string,
		toolCallId: string,
		params: unknown,
		run: ToolRunContext,
		signal?: AbortSignal,
		onUpdate?: ToolUpdateCallback<any>,
	): Promise<ToolResult<any>> {
		const tool = this.get(name);
		if (tool === undefined) throw new Error(`Tool not found: ${name}`);
		return tool.execute(toolCallId, params as never, run, signal, onUpdate);
	}

	/**
	 * 把一个工具放进表。它加入；是否被提供是选择的事，不是这里的事。
	 *
	 * fill 先发生，所以与内置工具撞名的名字被拒绝注册的同一规则拒绝——而且之后的 fill 永远无法
	 * 盖过刚注册的东西。只接受新名字：没有 unregister、没有 replace、没有第二张表。
	 */
	register(tool: Tool<any>): void {
		this.ensureFilled();
		if (this.all.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
		this.all.set(tool.name, tool);
	}

	/**
	 * 把六个内置工具填进表，一次。
	 *
	 * 在第一次触碰时而不是构造函数里，因为一个装配了 session 但从不运行工具的进程不应该为六个
	 * 实例付代价——而且 fill 必须发生在任何回答「什么存在」的读取之前，也就是这里的每个公开方法。
	 * 六个一次填齐而不是按名逐个填，是这张表成为「什么存在」的唯一答案的原因：按名逐个填需要在
	 * 旁边再放一份静态名字清单，两份清单会不一致。
	 *
	 * 非空的表就是已填充的表：`register` 写之前先 fill，所以没有六个先就位、就不可能有东西进来。
	 */
	private ensureFilled(): void {
		if (this.all.size > 0) return;
		for (const create of builtIns) {
			const tool = create();
			this.all.set(tool.name, tool);
		}
	}
}

/** 一个进程认识的表。零参构建：内置工具就是本构建的常量。 */
export function createToolManager(): ToolManager {
	return new ToolManager();
}
