import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { QueueMode } from "./protocol.ts";

/** 存放会话、设置与已存凭据的目录。 */
export const AGENT_HOME = resolve(process.env.MY_AGENT_HOME ?? join(homedir(), ".my-agent"));

/** 本应用在自己写出的文件与消息里如何自称。 */
export const APP_NAME = "my-agent";

/**
 * 会话存放自己设置的目录，名字与 agent home 的并列。
 *
 * 仓库可以提交 `<workDirAbsPath>/.my-agent/settings.json`；`SettingManager` 会把它合并到 agent home
 * 的文件之上，所以一份 checkout 能带上自己的审批与限额，而不碰机器级的设置。在项目作用域设置过
 * 东西之前，没有任何写入会触及这个目录。
 */
export const PROJECT_DIR_NAME = ".my-agent";

/**
 * 供应商调用失败时的重试策略。
 *
 * 逐字段对应 pi-ai 的 `RetryPolicy`，对象无需转换即可交给 `retryAssistantCall`：`maxRetries` 数的是
 * 重试次数而非调用次数，`0` 表示「从不重试」。
 */
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	/** 每次尝试的延迟为 `baseDelayMs * 2^(attempt-1)`。 */
	baseDelayMs: number;
	/** 单次计算出的延迟的上限。 */
	maxAgentDelayMs: number;
}

/**
 * 窗口如何绘制自己。
 *
 * 与其他设置放在一起而不是存进浏览器自己的存储，因为桌面外壳每次启动都换一个新端口：
 * `localStorage` 按 origin 隔离，存在那里的偏好会在窗口换个端口重开的那一刻被忘掉。
 */
export interface AppearanceSettings {
	/** `system` 跟随操作系统。 */
	theme: "system" | "light" | "dark";
	/**
	 * 正文字号的 px 值——字号阶梯里唯一允许移动的一档；外壳其余四档固定，不跟随它。
	 */
	fontSize: number;
	/**
	 * 侧边栏宽度的 px 值，即拖动手柄最后一次留下的位置。用户拖过一次之前不存在——默认宽度由样式表
	 * 决定，从未表达过的偏好不该在这里被凭空造出来。
	 */
	sidebarWidth?: number;
	/**
	 * 阅读列宽度的 px 值，即其拖动手柄最后一次留下的位置。用户拖过一次之前不存在——默认值是会话列
	 * 自身宽度减去两侧各一条 gutter，绘制时计算，从未表达过的偏好不该在这里被凭空造出来。
	 *
	 * 存下的数字是*偏好*，不是实际显示宽度：窗口在每次读取时把它钳制到当前布局允许的范围内，所以
	 * 更小的窗口会压低显示而不毁掉选择，窗口变大时选择会自己回来。服务端只负责绝对范围
	 * {@link CONTENT_WIDTH_RANGE}。
	 */
	contentWidth?: number;
	/**
	 * 侧边栏按目录的翻页状态，以目录绝对路径为键。
	 *
	 * 某个目录真的被翻页或收起过之前不存在——用户从未碰过的列表不留条目，与两个宽度字段遵循同一
	 * 规则。用路径而不是 id 作键，因为路径是目录分组在线上唯一的身份。
	 */
	directories?: Record<string, DirectoryPaging>;
}

/**
 * 一个目录的翻页状态，即侧边栏最后一次留下的样子。
 *
 * 三个字段，因为其中两个已决定的行为需要第三者之上的记忆：「收起」按钮把 {@link page} 退回一页
 * ——撤销上一次「展开其余」加上的页——{@link savedPage} 随之移动，之后再次展开收起的标题组时，
 * 会落回用户真正读到的那一页。
 */
export interface DirectoryPaging {
	/** 目录是否只显示标题。 */
	collapsed: boolean;
	/** 当前展开了多少页会话；上限是 `page * 5`。 */
	page: number;
	/** 目录标题最后一次被收起时展开到的页。 */
	savedPage: number;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = { theme: "dark", fontSize: 15 };

/** 字号控件提供的范围，解析器与客户端共用。 */
export const FONT_SIZE_RANGE = { min: 10, max: 22 } as const;

/**
 * 侧边栏拖动手柄可及的范围，解析器与客户端共用。
 *
 * 这组数字与字号范围放在一起而不是只留在样式表里，因为拖动的两端在客户端都要对它钳制：一个超出
 * 范围的存储偏好会在用户看得见的每次缩放中幸存，并在下次启动时重新生效。
 */
export const SIDEBAR_WIDTH_RANGE = { min: 208, max: 360 } as const;

/**
 * 阅读列宽度可占用的绝对范围，解析器与客户端共用。
 *
 * 布局相对的两端——会话列减去它的 gutter——是客户端的公式，因为它们依赖只有窗口才知道的宽度；
 * 服务端钳制存储偏好用的就是这一对数字，与侧边栏范围的分工相同。
 */
export const CONTENT_WIDTH_RANGE = { min: 600, max: 1280 } as const;

/**
 * `bash` 工具允许一条命令运行多久。
 *
 * 上限保留为设置而不是干脆取消，因为它防的是模型要求无界的运行——但这个数字由用户来改：一个要跑
 * 小时级构建的 checkout，会在自己的设置文件里写一个更高的值。
 */
export interface BashSettings {
	/** 调用未自带 `timeout_ms` 时使用。 */
	defaultTimeoutMs: number;
	/** 任何一条命令的上限，无论调用要求多长。 */
	maxTimeoutMs: number;
}

export const DEFAULT_BASH_SETTINGS: BashSettings = { defaultTimeoutMs: 120_000, maxTimeoutMs: 3_600_000 };

/**
 * 内置默认模式的名字，设置从不存储它。
 *
 * 默认模式*就是*全局默认——默认工具集与默认审批映射，实时读取——所以它没有自己的一行需要与它们
 * 保持同步（ADR-0004）。这个名字是保留名：一个存储模式若占用它，会遮住输入框必须永远能找到的那
 * 个答案。
 */
export const DEFAULT_MODE_NAME = "默认";

/**
 * 一个模式：工具与审批的命名预设，在应用级设置里编辑，整体应用到会话上。
 *
 * 两半都整体传输，与记录在会话快照上的选择遵循同一份契约（`.json` 快照的活跃集与审批映射）：
 * 模式是一个决定，所以应用它时不得与该会话之前持有的东西合并。名字是模式的身份——输入框靠把值与
 * 这份列表匹配来命名活跃模式，这就是重名被拒绝而不是被改成唯一名的原因。
 */
export interface ModeSettings {
	name: string;
	/** 模式应用的整体活跃工具集。空列表也是一个选择：什么都不活跃。 */
	tools: string[];
	/** 按工具名的逐工具审批；会话将其作为一个补丁整体应用。 */
	approval: Record<string, boolean>;
}

export interface Settings {
	/**
	 * 新会话打开在哪一行：`name`，或会话记录记录的 `<name>/<model-id>` ref。
	 *
	 * 两种写法都接受，因为设置面板写第一种，修复脚本写第二种。undefined 不是「没有模型」：装配会
	 * 回落到 `DEFAULT_MODEL_NAME`（`packages/core/src/models.ts`），只有连那一行都没有的机器才打开
	 * 在第一行上。
	 */
	model?: string;
	/**
	 * 窗口是否已经种下内置的默认模型行。
	 *
	 * 没有导入任何模型时，客户端会种一行起始行（`packages/web/src/default-model.ts`），用户可以删掉
	 * 它。这个标记让删除成为终局：没有它，下次启动看到空列表又会把行种回来。它是设置而不是浏览器
	 * 自己的存储，因为桌面外壳每次启动都换新端口，而 `localStorage` 按 origin 隔离——这个标记恰恰会
	 * 被它为之存在的重启忘掉。
	 *
	 * 缺失表示「从未种过」，这也是旧设置文件和从未启动过窗口的机器的状态。
	 */
	defaultModelSeeded?: boolean;
	/**
	 * 从未选择过的会话打开时的工具集，也是会话级面板重置到的全局默认。undefined 表示注册表的全集，
	 * 即如今的会话打开时的样子——所以旧设置文件无需迁移，也无需自己的字段。
	 */
	tools?: string[];
	/**
	 * 用户的模式，整体存放，按选择器列出的顺序。缺失表示没有：内置默认模式从不存储，所以旧文件
	 * 已经是一份合法的 modes 文件（ADR-0004）。
	 */
	modes?: ModeSettings[];
	/** 主题与字号，即窗口绘制自己的方式。 */
	appearance: AppearanceSettings;
	/** 运行前必须在 UI 里获得批准的工具，按工具名为键。 */
	approval: Record<string, boolean>;
	/**
	 * 侧边栏不列出的目录，按绝对路径。
	 *
	 * 这份列表只是*视图*决定，别无其他：目录标题上的「删除」把分组从列表移走，让每份会话记录原地
	 * 不动，所以一个目录可以被搁置而不碰磁盘上的任何东西。这正是它作为存储设置而非删除操作存在的
	 * 全部理由——会话仍可按 id 打开，取消隐藏就是清空这份列表。
	 *
	 * 用户藏起第一个目录之前缺失而不是 `[]`，与两个宽度字段遵循同一规则：没人表达过的偏好不落笔。
	 */
	hiddenDirectories?: string[];
	/**
	 * 侧边栏为目录显示的名字，按绝对路径。
	 *
	 * 与 `hiddenDirectories` 完全同类、且出于同样理由的视图决定：磁盘上的文件夹保留文件系统给它起的
	 * 名字，每份会话记录保留其头部记录的 `workDirAbsPath`。所以在这里重命名目录不会让任何会话
	 * 找不到，也不会碰 agent 自己设置之外的任何东西。
	 *
	 * 空字符串是收回一个名字的方式——分组落回文件夹自己的名字——因为按键合并的记录无法用「省略」
	 * 表达「忘掉这一条」。
	 */
	directoryNames?: Record<string, string>;
	/** 一个取走点注入多少条 steer 消息。 */
	steeringMode: QueueMode;
	/** 一个取走点注入多少条 followUp 消息。 */
	followUpMode: QueueMode;
	/** 如何处理一次瞬时的供应商失败。 */
	retry: RetrySettings;
	/** `bash` 工具允许一条命令运行多久。 */
	bash: BashSettings;
}

export const DEFAULT_SETTINGS: Settings = {
	approval: { read: false, write: true, edit: true, glob: false, grep: false, bash: true },
	appearance: { ...DEFAULT_APPEARANCE },
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 },
	bash: { ...DEFAULT_BASH_SETTINGS },
};

/** 机器级的设置文件。`agentDir` 可配置，让测试能指到无害的地方。 */
export function settingsPath(agentDir: string = AGENT_HOME): string {
	return join(agentDir, "settings.json");
}

/** 工作目录可以提交的设置文件。是否写入由设置操作自行决定。 */
export function projectSettingsPath(workDirAbsPath: string): string {
	return join(resolve(workDirAbsPath), PROJECT_DIR_NAME, "settings.json");
}

/**
 * 把一份部分设置对象合并到默认值之上。未知的键被忽略。
 *
 * 这里只做值的规范化；读写文件是 `SettingManager` 的职责（它的读取纳入一个目录的两层，
 * `applySettings` 把变更写回），这正是同一套规范化能同时服务单层、双层与内存中变更的原因。
 */
export function mergeSettings(input: unknown): Settings {
	const record = isRecord(input) ? input : {};
	const approval = isRecord(record.approval) ? record.approval : {};

	const merged: Settings = {
		approval: { ...DEFAULT_SETTINGS.approval },
		appearance: appearanceOr(record.appearance),
		steeringMode: queueModeOr(record.steeringMode, DEFAULT_SETTINGS.steeringMode),
		followUpMode: queueModeOr(record.followUpMode, DEFAULT_SETTINGS.followUpMode),
		retry: retryOr(record.retry),
		bash: bashOr(record.bash),
	};

	const model = stringOrUndefined(record.model);
	if (model !== undefined) merged.model = model;

	// 两种取值都原样保留：`false` 是手编文件要求重新种回内置行的写法，在这里把它变成缺失会让这个
	// 请求无法表达。与其他字段一样按层合并，所以项目文件的 `false` 覆盖 home 文件的 `true`。
	if (typeof record.defaultModelSeeded === "boolean") merged.defaultModelSeeded = record.defaultModelSeeded;

	const tools = stringListOrUndefined(record.tools);
	if (tools !== undefined) merged.tools = tools;

	const modes = modesOr(record.modes);
	if (modes !== undefined) merged.modes = modes;

	const hiddenDirectories = stringListOrUndefined(record.hiddenDirectories);
	if (hiddenDirectories !== undefined) merged.hiddenDirectories = hiddenDirectories;

	const directoryNames = stringRecordOrUndefined(record.directoryNames);
	if (directoryNames !== undefined) merged.directoryNames = directoryNames;

	for (const [key, value] of Object.entries(approval)) {
		if (typeof value === "boolean") merged.approval[key] = value;
	}
	return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 重试策略，逐字段落在默认值之上。
 *
 * `maxRetries` 是唯一可以为零的计数——「不重试」是一个设置，不是缺值——所以按非负整数解析，
 * 而不用 {@link numberOr}。
 */
function retryOr(value: unknown): RetrySettings {
	const record = isRecord(value) ? value : {};
	return {
		enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_SETTINGS.retry.enabled,
		maxRetries: countOr(record.maxRetries, DEFAULT_SETTINGS.retry.maxRetries),
		baseDelayMs: numberOr(record.baseDelayMs, DEFAULT_SETTINGS.retry.baseDelayMs),
		maxAgentDelayMs: numberOr(record.maxAgentDelayMs, DEFAULT_SETTINGS.retry.maxAgentDelayMs),
	};
}

function countOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * bash 超时，逐字段落在默认值之上。
 *
 * 高于上限的默认值会被压到上限而不是照办：否则每一次未自带 `timeout_ms` 的调用都注定超时。
 */
function bashOr(value: unknown): BashSettings {
	const record = isRecord(value) ? value : {};
	const maxTimeoutMs = numberOr(record.maxTimeoutMs, DEFAULT_BASH_SETTINGS.maxTimeoutMs);
	return {
		defaultTimeoutMs: Math.min(
			numberOr(record.defaultTimeoutMs, DEFAULT_BASH_SETTINGS.defaultTimeoutMs),
			maxTimeoutMs,
		),
		maxTimeoutMs,
	};
}

/** 主题与字号，各自独立回落，让一个坏字段不会连带重置另一个。 */
function appearanceOr(value: unknown): AppearanceSettings {
	const record = isRecord(value) ? value : {};
	const theme = record.theme;
	const sidebarWidth = clampSidebarWidth(record.sidebarWidth);
	const contentWidth = clampContentWidth(record.contentWidth);
	const directories = clampDirectoryPaging(record.directories);
	return {
		theme: theme === "light" || theme === "dark" || theme === "system" ? theme : DEFAULT_APPEARANCE.theme,
		fontSize: clampFontSize(record.fontSize),
		// 可选，从未拖动过的外观不留字段：默认宽度由样式表决定，在这里写一个值会把「从未选择」变成
		// 「选择了默认值」。
		...(sidebarWidth === undefined ? {} : { sidebarWidth }),
		...(contentWidth === undefined ? {} : { contentWidth }),
		...(directories === undefined ? {} : { directories }),
	};
}

/**
 * 字号落在控件提供的范围内。
 *
 * 钳制而不是拒绝：文件是手编的，超范围的字号是要吸收的笔误，不是拒绝给窗口设置的理由。
 */
export function clampFontSize(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_APPEARANCE.fontSize;
	return Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, Math.round(value)));
}

/**
 * 侧边栏宽度落在手柄可及的范围内，undefined 表示「从未拖动」。
 *
 * 与字号同理，钳制而不是拒绝：手编的文件，或宽于当前范围的旧偏好，都是要拉回界内的数字——
 * 不是忘掉它的理由。
 */
export function clampSidebarWidth(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(SIDEBAR_WIDTH_RANGE.max, Math.max(SIDEBAR_WIDTH_RANGE.min, Math.round(value)));
}

/**
 * 阅读列宽度落在绝对范围内，undefined 表示「从未拖动」。
 *
 * 与侧边栏宽度同理，钳制而不是拒绝：手编的文件，或旧构建留下的超范围偏好，都是要拉回界内的
 * 数字——不是忘掉它的理由。
 */
export function clampContentWidth(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(CONTENT_WIDTH_RANGE.max, Math.max(CONTENT_WIDTH_RANGE.min, Math.round(value)));
}

/**
 * 各目录的翻页状态，逐条目处理，undefined 表示「从未碰过」。
 *
 * 与两个宽度同理，钳制而不是拒绝：文件是手编的，一个目录的坏条目自己被丢弃——不该连累其他目录
 * 的状态，也不该连累整个字段在 appearance 里的位置。不是正整数的页码回落到第一页，而不是被采信。
 */
export function clampDirectoryPaging(value: unknown): Record<string, DirectoryPaging> | undefined {
	if (!isRecord(value)) return undefined;
	const out: Record<string, DirectoryPaging> = {};
	for (const [workDirAbsPath, entry] of Object.entries(value)) {
		if (workDirAbsPath.trim().length === 0 || !isRecord(entry)) continue;
		const clampPage = (input: unknown): number =>
			typeof input === "number" && Number.isInteger(input) && input >= 1 ? input : 1;
		out[workDirAbsPath] = {
			collapsed: entry.collapsed === true,
			page: clampPage(entry.page),
			savedPage: clampPage(entry.savedPage),
		};
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** pi-agent-core 认识的两种队列模式；其他取值保留默认。 */
function queueModeOr(value: unknown, fallback: QueueMode): QueueMode {
	return value === "all" || value === "one-at-a-time" ? value : fallback;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * 工具名列表，字段缺失或不是数组时为 undefined。
 *
 * 文件是手编的，所以不是非空字符串的条目被丢弃而不是拒绝——一行坏数据不该连累整个字段。空列表
 * 会被*保留*：缺失的字段表示「全部工具」（旧文件的行为），而显式空列表是一个选择——「什么都不
 * 活跃」——把一个选择悄悄改写成它的反面，是设置读取者唯一不可做的事。
 */
function stringListOrUndefined(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/**
 * 以路径为键的名字映射，undefined 表示「从未写过」。
 *
 * 空字符串在这里幸存而不是被丢弃：空名字是「已清除条目」的存储形态，而渲染侧边栏的读取者是决定
 * 其含义的唯一地方。
 */
function stringRecordOrUndefined(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string" && entry[0].trim().length > 0,
	);
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * 用户的模式，逐条目处理，undefined 表示「从未写过」。
 *
 * 文件是手编的，其他列表字段的宽容同样适用这里：不是 record、没有自己的名字、或把非字符串当作
 * 工具名的条目自己被丢弃——一个坏模式不该连累其他模式的位置。重名保留第一次出现的，因为名字是
 * 输入框匹配的身份，两行同答一个名字会让匹配变成掷硬币。空列表会被*保留*：删光所有模式的用户
 * 做了一个选择，缺失字段必须与它保持可区分。
 *
 * 模式的审批映射在标准默认值之上规范化而不是被采信：UI 总是写全每个键，缺键即手编，而它回落到的
 * 答案正是全新会话打开时的那张映射。
 */
function modesOr(value: unknown): ModeSettings[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: ModeSettings[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const name = stringOrUndefined(entry.name);
		if (name === undefined) continue;
		if (out.some((mode) => mode.name === name)) continue;
		const tools = stringListOrUndefined(entry.tools);
		if (tools === undefined) continue;
		const approvalRecord = isRecord(entry.approval) ? entry.approval : {};
		const approval = { ...DEFAULT_SETTINGS.approval };
		for (const [key, value] of Object.entries(approvalRecord)) {
			if (typeof value === "boolean") approval[key] = value;
		}
		out.push({ name, tools, approval });
	}
	return out;
}
