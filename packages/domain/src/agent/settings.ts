// 组合的设置：会话侧（`SessionSettings`，即会话 `.json` 快照的设置半）与各持有者的一次现读在
// 每次读取时组合成的那一份「后续函数要用的」视图（ADR-0019）。
//
// 组合是**派生值**，与模型选择的解析同构（ADR-0013）：会话快照只存指针与选择（ADR-0018），激活
// 工具集、有效审批与完整模型行都在这里、从调用方现读的输入上现算——模式改了内容，指向它的会话
// 跟着变；模型行的一把密钥修正，下一次请求就生效——没有任何副本需要失效。产物只活在调用栈上，
// 从不进任何袋、从不落盘。
//
// 设置归属重构（spec §6）后输入换成两个窄来源：`toolDefaults` 是 ToolManager 的一次现读
// （`tools.json` 补默认后的视图），`modelView` 是 ModelManager 的一次现读（目录各行与默认 ref）。
// 原 `Settings.global` 的透传字段退场——bash 直读工具簇、retry 读引擎簇、队列模式读会话簇，
// 消费者各自直读持有者，组合视图不再代为携带。
import { DEFAULT_MODE_NAME } from "./types.ts";
import { DEFAULT_MODEL_NAME, type ModelChoice, type ModelConfig, rowOrPlaceholder } from "./llm/model-manager.ts";
import { recordedSelectionOf, type Session } from "./session/session-manager.ts";
import { narrowToKnown, type ToolDefaults } from "./tool/manager.ts";

/** 审批表闸住的工具：表里每个带 true 值的名字。 */
export function approvalToolsOf(approval: Record<string, boolean>): string[] {
	return Object.keys(approval).filter((name) => approval[name]);
}

/**
 * 全局默认工具集，收窄到本构建认识的工具。
 *
 * 默认的每个消费方共享的唯一答案——模式指针的解析、装配——因为「默认」有三种拼法会让重置写入
 * 一套集合而解析按另一套进行。
 */
export function defaultToolNames(defaultTools: readonly string[] | undefined, known: readonly string[]): string[] {
	const configured = defaultTools === undefined ? known : defaultTools;
	return narrowToKnown(configured, known);
}

/**
 * 引用所指名的行：调用方要求的，其次内置默认，再其次第一行。
 *
 * 调用方传入的是 *ref* 而不是名字——修复脚本写下的 `global.model`，和 session 记录的模型
 * 选择——两者都拼成 `<name>/<model-id>`。名字才是标识行的东西，所以两种拼写都在这里解析，而不是
 * 在每个调用方各自解析；之前 ref 直接匹配不到任何行，session 会悄悄开在别人的行上。
 *
 * {@link DEFAULT_MODEL_NAME} 是第三级，硬编码而不是猜用户有哪家的 key：它是这个应用围绕构建的
 * 模型，所以默认值指名了一行已被删除的行、或设置文件什么都没指名时，session 仍然开在它上面。只有
 * 机器上没有那一行才落到 `rows[0]`，只有一行都没有的机器才得不到行——调用方以占位行的事实作答
 * （`rowOrPlaceholder`），因为 session 必须能构建出来，窗口才能打开到足以说出缺什么的地步。
 */
export function selectModelRow(rows: readonly ModelConfig[], ref: string | undefined): ModelConfig | undefined {
	const name = ref?.split("/")[0];
	if (name !== undefined) {
		const named = rows.find((row) => row.name === name);
		if (named) return named;
	}
	return rows.find((row) => row.name === DEFAULT_MODEL_NAME) ?? rows[0];
}

/** 模型半的一次现读：目录各行与默认 ref（ModelManager 的 {@link ModelManager.catalog} / {@link ModelManager.defaultRef}）。 */
export interface ModelView {
	/** 本安装运行的模型行，按文件里的顺序。 */
	rows: readonly ModelConfig[];
	/** 新会话默认打开在哪一行：`name`，或 `<name>/<model-id>` ref；未设置即 undefined。 */
	defaultRef?: string;
}

/**
 * 会话与两个持有者组合出的设置：一个会话在一个时刻的**有效**视图（ADR-0019）。
 *
 * 会话侧只贡献选择——快照上的模式指针、审批增量与模型选择（`SessionSettings`）；global 侧贡献
 * 默认值与命名预设——来自 `toolDefaults` 的 `modes` 表、全局默认工具集与审批基线，以及来自
 * `modelView` 的默认行。三个解析出的字段是这份视图存在的理由：
 *
 * - `tools`：活跃工具集。模式指针指名的预设整份生效，指针缺席或悬空读作内置「默认」——全局默认
 *   的活视图。名字收窄到本构建仍认识的工具，升级中删掉的一个在读的时候被删掉，不会拒绝 session
 *   重开。
 * - `approval`：有效审批映射。模式（或全局默认）的基线在下、会话自己的增量在上——增量表达会话在
 *   个别工具上的明确决定（grant 的「不再问」、审批补丁），模式与全局默认的变化都不动它。
 * - `model`：完整模型行。按会话记录的选择从目录现查（回落链见 {@link resolveSettings}），一行都
 *   没有时以占位行的事实作答，拒绝发送的是传输层。
 */
export interface Settings {
	/** 会话这一刻的活跃工具集，收窄到本构建认识的工具。 */
	tools: string[];
	/** 有效审批映射：模式（或全局默认）的基线叠会话自己的增量。 */
	approval: Record<string, boolean>;
	/** 会话所在的模式的座位；指针缺席或悬空读作 undefined——窗口把它显示为内置「默认」。 */
	mode?: string;
	/** 解析出的完整模型行与档位；无行应答时 `config` 是占位行（保留被选的名字）。 */
	model: { config: ModelConfig; thinkingLevel?: string };
}

/**
 * 组合一个 session 的设置：快照的选择与两个持有者各自的现读，现算成一份有效视图。
 *
 * 这是「这个会话此刻处于什么配置」的唯一答案，每次读取都现算一次——一次运行、一次请求、一次快照、
 * 一次审批读取各算各的，产物用完即丢（ADR-0013）。输入由调用方现取：`toolDefaults` 与 `modelView`
 * 各是 ToolManager / ModelManager 的一次现读，`session` 是重放出的那只袋，`known` 是本构建认识的
 * 工具名。纯函数：它不读任何文件、不持有任何东西。
 *
 * 模型的回落链：会话记录的选择——模型以分支最后一条 assistant 消息作弱回落（`recordedSelectionOf`）
 * ——其次设置自己的默认值指名的，再其次内置默认行，最后第一行。档位是记录的那个；没有行应答的
 * 选择丢掉档位——它所属的请求即将被传输层拒绝而非发送。
 */
export function resolveSettings(
	session: Session,
	toolDefaults: ToolDefaults,
	modelView: ModelView,
	known: readonly string[],
): Settings {
	const selection = session.settings;

	// —— 工具集与审批基线：模式指针指向 `modes` 表的一个预设，缺席/悬空即内置「默认」 ——
	// 指针悬空——模式被改名或删除——读作全局默认，但指针本身保留在快照上：模式再出生时，会话
	// 重新挂上。这是指针语义的一部分，不是一次清理。
	const globalTools = defaultToolNames(toolDefaults.tools, known);
	const modes = toolDefaults.modes ?? [];
	let tools = globalTools;
	let baseline: Record<string, boolean> = toolDefaults.approval;
	let mode: string | undefined;
	if (selection.mode !== undefined && selection.mode !== DEFAULT_MODE_NAME) {
		const preset = modes.find((candidate) => candidate.name === selection.mode);
		if (preset !== undefined) {
			mode = preset.name;
			tools = narrowToKnown(preset.tools, known);
			// 具名模式的审批表就是一个选择，整体作为基线携带。
			baseline = { ...preset.approval };
		}
	}
	const approval = { ...baseline, ...selection.approval };

	// —— 模型：记录的选择 → 设置的默认 → 内置默认行 → 第一行 ——
	const recorded = recordedSelectionOf(session);
	const recordedRef =
		recorded.model === undefined ? undefined : `${recorded.model.name}/${recorded.model.modelId}`;
	const ref = recordedRef ?? modelView.defaultRef;
	const row = selectModelRow(modelView.rows, ref);
	const choice: ModelChoice = row === undefined ? {} : { name: row.name };
	// 一台没有任何行的机器仍然给出格式完好的视图：占位行的事实，由传输层拒绝发送。这里不抛任何异常。
	return {
		tools,
		approval,
		...(mode === undefined ? {} : { mode }),
		model: {
			config: rowOrPlaceholder(choice, modelView.rows),
			...(recorded.thinkingLevel === undefined ? {} : { thinkingLevel: recorded.thinkingLevel }),
		},
	};
}
