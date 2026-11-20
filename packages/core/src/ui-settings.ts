import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	AGENT_HOME,
	CONTENT_WIDTH_RANGE,
	DEFAULT_APPEARANCE,
	FONT_SIZE_RANGE,
	settingsPath,
	SIDEBAR_WIDTH_RANGE,
	stringListOrUndefined,
} from "./config.ts";

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

/** UI 簇补默认后的视图：外观总是补齐，两个视图列表从未表达过时缺失。 */
export interface UiSettings {
	appearance: AppearanceSettings;
	/** 侧边栏不列出的目录，按绝对路径；缺失表示没有隐藏任何目录。 */
	hiddenDirectories?: string[];
	/** 侧边栏为目录显示的名字，按绝对路径；缺失表示没有改过任何一个名字。 */
	directoryNames?: Record<string, string>;
}

/** UI 簇的部分变更，只移动被点名的字段。 */
export interface UiSettingsPatch {
	appearance?: Partial<AppearanceSettings>;
	/** 整份列表：这个设置就是隐藏目录的集合，多藏一个目录就是之前的列表多一条。 */
	hiddenDirectories?: string[];
	/** 整份记录，携带变更的条目；空字符串收回一个名字。 */
	directoryNames?: Record<string, string>;
}

/**
 * UI 簇设置的唯一持有者：外观（主题、字号、两个宽度、目录翻页）、隐藏目录、目录改名——
 * 纯窗口视图偏好，独占自己的文件 `<agent home>/ui.json`（spec §3）。
 *
 * 与其他持有者同形：无状态、每次现读（ADR-0013），什么都不缓存——每个方法都从文件构建一份新
 * 状态，所以手编文件、另一窗口的写入，就是下一次调用给出的答案。文件读写直接内联，没有存储
 * 抽象。
 *
 * 首次读取时执行一次性迁移（spec §4.2）：ui.json 不存在而旧 settings.json 存在，就把 UI 簇
 * 从旧文件捡走、补默认后的视图落盘到 ui.json——之后旧文件被完全忽略，且永不删除、永不写入。
 */
export class UiSettingsManager {
	private readonly home: string;

	constructor(options: UiSettingsOptions = {}) {
		this.home = options.home ?? AGENT_HOME;
	}

	/** 补默认后的 UI 视图副本：改它不动任何东西。首读时顺手完成迁移。 */
	uiSettings(): UiSettings {
		return uiSettingsOf(this.layerOf());
	}

	/**
	 * 应用一次部分变更，返回前写盘。
	 *
	 * 只有被点名的字段移动：appearance 做嵌套合并（改主题不碰字号），hiddenDirectories 整体替换，
	 * directoryNames 按键合并（补丁携带它变更的条目，空字符串收回一个名字）——写路径的三条纪律
	 * 按 ADR-0028 在本持有者内联。变更合并到磁盘此刻的内容之上（读取含迁移语义），所以对同一文件
	 * 的手编不被这里一次无关的变更回滚；未知键原样保留。
	 */
	applyUiSettings(patch: UiSettingsPatch): void {
		const fields = Object.entries(patch)
			.filter(([, value]) => value !== undefined)
			.map(([field]) => field);
		if (fields.length === 0) return;

		const layer = this.layerOf();
		const changes: Record<string, unknown> = {};
		for (const field of fields) {
			const inherited = layer[field];
			const value = (patch as Record<string, unknown>)[field];
			changes[field] = isRecord(inherited) && isRecord(value) ? mergeLayers(inherited, value) : value;
		}
		// {@link UiSettingsManager.layerOf} 已经把磁盘此刻的内容（含迁移语义）读到手，合并基线就是
		// 它——一次读，不再重读文件。
		const merged = mergeLayers(layer, changes);
		writeAtomically(uiPath(this.home), `${JSON.stringify(merged, null, "\t")}\n`);
	}

	/**
	 * UI 簇的文件内容，按它写下的原样；文件还不存在时先走迁移。
	 *
	 * 状态是一次调用的值，不是常驻视图——现建它，任何地方都不把它持有过本次调用。
	 */
	private layerOf(): Record<string, unknown> {
		const existing = this.readLayer();
		if (existing !== undefined) return existing;

		// 自己的文件不存在而旧 settings.json 存在 → 用现有的规范化函数从旧文件捡走 UI 簇，把补
		// 默认后的视图落盘。簇字段全缺省也要写出文件：把「迁移过」变成磁盘事实，避免删掉 ui.json
		// 的手让旧文件复活。旧文件本身永不删除、永不写入。
		const legacy = readRecordOrUndefined(settingsPath(this.home));
		if (legacy === undefined) return {};

		const layer: Record<string, unknown> = { appearance: appearanceOr(legacy.appearance) };
		const hiddenDirectories = stringListOrUndefined(legacy.hiddenDirectories);
		if (hiddenDirectories !== undefined) layer.hiddenDirectories = hiddenDirectories;
		const directoryNames = stringRecordOrUndefined(legacy.directoryNames);
		if (directoryNames !== undefined) layer.directoryNames = directoryNames;
		writeAtomically(uiPath(this.home), `${JSON.stringify(layer, null, "\t")}\n`);
		return layer;
	}

	/** ui.json 的内容，按它写下的原样；文件缺失时为 undefined。 */
	private readLayer(): Record<string, unknown> | undefined {
		return readRecordOrUndefined(uiPath(this.home));
	}
}

/** 调用方可提供什么，把 {@link UiSettingsManager} 指到机器自己的文件之外。 */
export interface UiSettingsOptions {
	/**
	 * ui.json 读取与写入所在的 agent home。默认用真实的那一个。
	 *
	 * 测试「会*写*UI 设置」的 smoke 不得写机器自己的文件。
	 */
	home?: string;
}

/** `<agent home>/ui.json`——UI 簇唯一的一份。 */
function uiPath(home: string): string {
	return join(home, "ui.json");
}

/** 补默认后的视图：外观总是补齐，两个视图列表按各自「从未表达过即缺失」的规则。 */
function uiSettingsOf(layer: Record<string, unknown>): UiSettings {
	const view: UiSettings = { appearance: appearanceOr(layer.appearance) };
	const hiddenDirectories = stringListOrUndefined(layer.hiddenDirectories);
	if (hiddenDirectories !== undefined) view.hiddenDirectories = hiddenDirectories;
	const directoryNames = stringRecordOrUndefined(layer.directoryNames);
	if (directoryNames !== undefined) view.directoryNames = directoryNames;
	return view;
}

/** 一份 JSON 文件的内容；文件缺失时为 undefined。本构建无法解析的文件被拒绝，从不被覆盖。 */
function readRecordOrUndefined(absPath: string): Record<string, unknown> | undefined {
	let content: string;
	try {
		content = readFileSync(absPath, "utf8");
	} catch (error) {
		// 文件缺失是正常的首次运行。其余任何情况——权限、挡在路上的目录——都是真实的失败，不得以
		// 「未配置设置」的形态抵达调用方。
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}

	// trim 顺带去掉 UTF-8 BOM——Windows 编辑器会写它，而 `JSON.parse` 拒绝它。
	const text = content.trim();
	if (text === "") return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${absPath} is not valid JSON: ${(error as Error).message}`);
	}
	if (!isRecord(parsed)) throw new Error(`${absPath} must hold a JSON object`);
	return parsed;
}

/**
 * 先写临时文件再改名：读者看到的要么是旧内容、要么是完整的新内容，没有写了一半的中间态。
 * temp 名带 pid，防两个进程同时落盘时撞同一个临时名——与其余持有者的写路径同形。
 */
function writeAtomically(absPath: string, content: string): void {
	mkdirSync(dirname(absPath), { recursive: true });
	const temporary = `${absPath}.${process.pid}.tmp`;
	writeFileSync(temporary, content, "utf8");
	renameSync(temporary, absPath);
}

/** 补丁的嵌套对象逐键合并进已有的值，其余字段整体替换。 */
function mergeLayers(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		const inherited = merged[key];
		merged[key] = isRecord(inherited) && isRecord(value) ? mergeLayers(inherited, value) : value;
	}
	return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 主题与字号，各自独立回落，让一个坏字段不会连带重置另一个。 */
export function appearanceOr(value: unknown): AppearanceSettings {
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

/**
 * 以路径为键的名字映射，undefined 表示「从未写过」。
 *
 * 空字符串在这里幸存而不是被丢弃：空名字是「已清除条目」的存储形态，而渲染侧边栏的读取者是决定
 * 其含义的唯一地方。目录改名是 UI 簇独有的字段，规范化器随簇住在这里；`stringListOrUndefined`
 * 仍留在 config.ts，因为工具簇与模式表共用它。
 */
export function stringRecordOrUndefined(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string" && entry[0].trim().length > 0,
	);
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
}
