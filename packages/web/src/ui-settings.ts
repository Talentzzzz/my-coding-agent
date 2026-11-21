/**
 * UI 设置：窗口如何绘制自己，以及它对目录列表的三个视图决定。
 *
 * 与服务端设置分家（ADR-0029）：这些偏好只属于客户端——服务端读它们从来只是为了把窗口自己的
 * 决定原样递回去。存储经 {@link loadUiSettings} / {@link saveUiSettings} 走一个双路适配器：
 *
 * - **桌面外壳**：`window.desktop` 桥（preload 暴露、主进程写 Electron userData 下的文件）。
 *   外壳每次启动都换端口，`localStorage` 按 origin 隔离，存在那里的偏好在窗口换个端口重开的
 *   那一刻就被忘掉——这正是当初它们归服务端管的理由，如今由外壳自己的文件回答同一件事。
 * - **浏览器**：回落到 origin 作用域的 `localStorage`。浏览器的地址（含端口）是用户自己敲的，
 *   稳定，偏好在刷新与重启之间幸存。
 *
 * 两条路都写整份对象：适配器之上没有逐字段的路由，读-改-写整个 `UiSettings` 是唯一的写入形状，
 * 与服务端时代「每簇独立原子落盘」的 discipline 由桥那一侧的原子写承接。
 */

/** 一个目录的翻页状态，即侧边栏最后一次留下的样子。 */
export interface DirectoryPaging {
	/** 目录是否只显示标题。 */
	collapsed: boolean;
	/** 当前展开了多少页会话；上限是 `page * 5`。 */
	page: number;
	/** 目录标题最后一次被收起时展开到的页。 */
	savedPage: number;
}

export interface AppearanceSettings {
	/** `system` 跟随操作系统。 */
	theme: "system" | "light" | "dark";
	/** 正文字号的 px 值——字号阶梯里唯一允许移动的一档；外壳其余四档固定，不跟随它。 */
	fontSize: number;
	/** 侧边栏宽度的 px 值。用户拖过一次之前不存在——从未表达过的偏好不该在这里被凭空造出来。 */
	sidebarWidth?: number;
	/**
	 * 阅读列宽度的 px 值。存下的数字是*偏好*，不是实际显示宽度：绘制时把它钳制到当前布局允许的
	 * 范围内，更小的窗口压低显示而不毁掉选择，窗口变大时选择自己回来。
	 */
	contentWidth?: number;
	/** 侧边栏按目录的翻页状态，以目录绝对路径为键。某个目录真的被碰过之前不存在。 */
	directories?: Record<string, DirectoryPaging>;
}

/** UI 设置补默认后的视图：外观总是补齐，两个视图列表从未表达过时缺失。 */
export interface UiSettings {
	appearance: AppearanceSettings;
	/** 侧边栏不列出的目录，按绝对路径；缺失表示没有隐藏任何目录。 */
	hiddenDirectories?: string[];
	/** 侧边栏为目录显示的名字，按绝对路径；缺失表示没有改过任何一个名字。 */
	directoryNames?: Record<string, string>;
}

/** UI 设置的部分变更，只移动被点名的字段。 */
export interface UiSettingsPatch {
	appearance?: Partial<AppearanceSettings>;
	/** 整份列表：这个设置就是隐藏目录的集合，多藏一个目录就是之前的列表多一条。 */
	hiddenDirectories?: string[];
	/** 整份记录，携带变更的条目；空字符串收回一个名字。 */
	directoryNames?: Record<string, string>;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = { theme: "dark", fontSize: 15 };

/** 字号控件提供的范围。 */
export const FONT_SIZE_RANGE = { min: 10, max: 22 } as const;

/** 侧边栏拖动手柄可及的范围——样式表的同批 token（`--dsw-sidebar-min/max`）是它的镜像。 */
export const SIDEBAR_WIDTH_RANGE = { min: 208, max: 360 } as const;

/** 阅读列宽度可占用的绝对范围；布局相对的两端是绘制侧自己的公式。 */
export const CONTENT_WIDTH_RANGE = { min: 600, max: 1280 } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 字号落在控件提供的范围内；不是数字回落默认——坏字段是要吸收的笔误，不是拒绝的理由。 */
export function clampFontSize(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_APPEARANCE.fontSize;
	return Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, Math.round(value)));
}

/** 侧边栏宽度落在手柄可及的范围内，undefined 表示「从未拖动」。 */
export function clampSidebarWidth(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(SIDEBAR_WIDTH_RANGE.max, Math.max(SIDEBAR_WIDTH_RANGE.min, Math.round(value)));
}

/** 阅读列宽度落在绝对范围内，undefined 表示「从未拖动」。 */
export function clampContentWidth(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(CONTENT_WIDTH_RANGE.max, Math.max(CONTENT_WIDTH_RANGE.min, Math.round(value)));
}

/**
 * 各目录的翻页状态，逐条目处理，undefined 表示「从未碰过」。坏条目自己被丢弃，不连累其他目录；
 * 不是正整数的页码回落到第一页，而不是被采信。
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
		...(sidebarWidth === undefined ? {} : { sidebarWidth }),
		...(contentWidth === undefined ? {} : { contentWidth }),
		...(directories === undefined ? {} : { directories }),
	};
}

/** 以路径为键的名字映射，undefined 表示「从未写过」；空字符串幸存——它是「已清除」的存储形态。 */
function directoryNamesOr(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string" && entry[0].trim().length > 0,
	);
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** 隐藏目录列表，undefined 表示「从未藏过」；坏条目被丢弃而不是拒绝。 */
function hiddenDirectoriesOr(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const kept = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
	return kept.length === 0 ? undefined : kept;
}

/** 任意来源的一块数据，规范化成补默认后的 {@link UiSettings}。 */
export function uiSettingsOr(value: unknown): UiSettings {
	const record = isRecord(value) ? value : {};
	const view: UiSettings = { appearance: appearanceOr(record.appearance) };
	const hiddenDirectories = hiddenDirectoriesOr(record.hiddenDirectories);
	if (hiddenDirectories !== undefined) view.hiddenDirectories = hiddenDirectories;
	const directoryNames = directoryNamesOr(record.directoryNames);
	if (directoryNames !== undefined) view.directoryNames = directoryNames;
	return view;
}

/**
 * 把一个补丁合并进已有的设置：appearance 嵌套合并（改主题不碰字号），hiddenDirectories 整体
 * 替换，directoryNames 按键合并（空字符串收回一个名字）。返回新的对象，不动传入的那份。
 */
export function applyUiPatch(settings: UiSettings, patch: UiSettingsPatch): UiSettings {
	const next: UiSettings = { ...settings };
	if (patch.appearance !== undefined) {
		const appearance: Record<string, unknown> = { ...settings.appearance };
		for (const [key, value] of Object.entries(patch.appearance)) {
			if (value === undefined) continue;
			appearance[key] = value;
		}
		next.appearance = appearance as unknown as AppearanceSettings;
	}
	if (patch.hiddenDirectories !== undefined) {
		if (patch.hiddenDirectories.length === 0) delete next.hiddenDirectories;
		else next.hiddenDirectories = patch.hiddenDirectories;
	}
	if (patch.directoryNames !== undefined) {
		const merged: Record<string, string> = { ...(settings.directoryNames ?? {}) };
		for (const [path, name] of Object.entries(patch.directoryNames)) merged[path] = name;
		if (Object.keys(merged).length === 0) delete next.directoryNames;
		else next.directoryNames = merged;
	}
	return next;
}

/**
 * 两个目录路径是否指名同一个目录。
 *
 * 存储的键是各来源给出的绝对路径——会话 header、系统对话框、`resolve` 过的字符串——Windows
 * 上同一目录可以有大小写与分隔符的分歧，比较做大小写折叠并把结尾的分隔符归一。
 */
export function sameDirectory(a: string, b: string): boolean {
	const normalize = (input: string): string => {
		const trimmed = input.replace(/[\\/]+$/, "");
		return trimmed.length === 0 ? input : trimmed;
	};
	const left = normalize(a);
	const right = normalize(b);
	return left.toLowerCase() === right.toLowerCase();
}

/** 桌面外壳给页面增加的 UI 设置桥：主进程持有的那份设置的读写。 */
interface UiSettingsBridge {
	readUiSettings?: () => Promise<unknown>;
	writeUiSettings?: (value: unknown) => Promise<void>;
}

/** `localStorage` 里承载 UI 设置的那把键。 */
const STORAGE_KEY = "my-agent.ui-settings";

function readFromLocalStorage(): UiSettings {
	try {
		const text = window.localStorage.getItem(STORAGE_KEY);
		if (text === null) return { appearance: { ...DEFAULT_APPEARANCE } };
		return uiSettingsOr(JSON.parse(text));
	} catch {
		// 坏掉的存储回落到默认，而不是让窗口起不来：设置读不出来不该是一次崩溃。
		return { appearance: { ...DEFAULT_APPEARANCE } };
	}
}

function writeToLocalStorage(settings: UiSettings): void {
	window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** 读出本窗口的 UI 设置：外壳桥优先，浏览器回落 localStorage。 */
export async function loadUiSettings(): Promise<UiSettings> {
	const bridge = (window as unknown as { desktop?: UiSettingsBridge }).desktop;
	if (bridge?.readUiSettings !== undefined) {
		try {
			return uiSettingsOr(await bridge.readUiSettings());
		} catch {
			// 桥那一侧读不出来（首次启动没有文件、或文件损坏）时按默认起步；下一次写入会重建它。
			return { appearance: { ...DEFAULT_APPEARANCE } };
		}
	}
	return readFromLocalStorage();
}

/** 写回本窗口的 UI 设置：外壳桥优先，浏览器回落 localStorage。 */
export async function saveUiSettings(settings: UiSettings): Promise<void> {
	const bridge = (window as unknown as { desktop?: UiSettingsBridge }).desktop;
	if (bridge?.writeUiSettings !== undefined) {
		await bridge.writeUiSettings(settings);
		return;
	}
	writeToLocalStorage(settings);
}
