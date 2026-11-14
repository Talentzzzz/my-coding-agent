import type { SettingManager } from "../setting-manager.ts";
import { fillTools, narrowToKnown, type ToolFillContext, type ToolState } from "../tools/manager.ts";
import { type SessionManager, type Session } from "./session-manager.ts";

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
export function defaultToolNames(settings: SettingManager, workDirAbsPath: string, known: readonly string[]): string[] {
	const configured = settings.getTools(workDirAbsPath);
	const names = configured === undefined ? known : configured;
	return narrowToKnown(names, known);
}

/** 一次模式解析所依据的 context：目录的设置现读，从不持有。 */
function fillContextOf(
	settings: SettingManager,
	workDirAbsPath: string,
	known: readonly string[],
): ToolFillContext {
	return {
		modes: settings.getSettings(workDirAbsPath).modes ?? [],
		globalTools: defaultToolNames(settings, workDirAbsPath, known),
		known,
	};
}

/**
 * 一个 session 所处的工具选择：记录的模式名指向的预设，叠上会话自己的审批增量。
 *
 * 会话记录的是**指针**不是值（ADR-0018）：`.json` 快照里的 `mode` 指名 settings `modes` 表里的
 * 一个预设，激活集与审批基线在每次读取时从它活态解析——模式改了内容，会话跟着变，没有任何副本
 * 需要失效。指针缺席就是内置「默认」模式：全局默认的活视图（`fillTools(undefined, …)`）。
 *
 * 指针悬空——模式被改名或删除——读作全局默认，但指针本身保留在快照上：模式再出生时，会话重新
 * 挂上。这是指针语义的一部分，不是一次清理。增量 `approval` 表达会话在个别工具上的明确决定
 * （grant 的「不再问」、审批补丁），叠在解析出的审批基线之上，模式与全局默认的变化都不动它。
 *
 * 回落值经由设置管理器按 session 自己 header 指名的目录活读——从不持有，所以设置一改下一次读取
 * 就生效，无须任何刷新。工具名收窄到本构建仍认识的工具，升级中删掉的一个同样在读的时候被删掉，
 * 不会拒绝 session 重开。
 */
export function toolStateOf(
	sessionManager: SessionManager,
	session: Session,
	settings: SettingManager,
	known: readonly string[],
): ToolState {
	const recorded = sessionManager.getRecordedToolConfig(session);
	const context = fillContextOf(settings, session.sessionSetting.workDirAbsPath, known);
	let base: ToolState;
	try {
		base = fillTools(recorded.mode, context);
	} catch {
		base = fillTools(undefined, context);
	}
	return {
		activeToolNames: base.activeToolNames,
		approvalOverride: { ...base.approvalOverride, ...recorded.approval },
	};
}

/**
 * 会话此刻所在的模式的座位名，窗口直接显示的那个。
 *
 * 指针缺席（跟随全局默认）或悬空（名字不再存在于 `modes` 表）都读作 undefined——窗口把
 * undefined 显示为内置「默认」。指针在而名字解析成功时返回它，所以快照的字段就是座位，不再有
 * 按值匹配（ADR-0018 取代 ADR-0004 的决定 3）。
 */
export function modeSeatOf(
	sessionManager: SessionManager,
	session: Session,
	settings: SettingManager,
): string | undefined {
	const recorded = sessionManager.getRecordedToolConfig(session);
	if (recorded.mode === undefined) return undefined;
	const modes = settings.getSettings(session.sessionSetting.workDirAbsPath).modes ?? [];
	return modes.some((mode) => mode.name === recorded.mode) ? recorded.mode : undefined;
}
