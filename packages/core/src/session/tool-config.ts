import type { SettingManager } from "../setting-manager.ts";
import { fillTools, narrowToKnown, type ToolState } from "../tools/manager.ts";
import { type SessionManager, type Session } from "./session-manager.ts";

/** 审批表闸住的工具：表里每个带 true 值的名字。 */
export function approvalToolsOf(approval: Record<string, boolean>): string[] {
	return Object.keys(approval).filter((name) => approval[name]);
}

/**
 * 全局默认工具集，收窄到本构建认识的工具。
 *
 * 默认的每个消费方共享的唯一答案——装配、分支移动、follow-global 判断——因为「默认」有三种拼法
 * 会让重置写入一套集合而面板按另一套判断 session，刚重置的 session 就会被读成已经选过。
 */
export function defaultToolNames(settings: SettingManager, workDirAbsPath: string, known: readonly string[]): string[] {
	const configured = settings.getTools(workDirAbsPath);
	const names = configured === undefined ? known : configured;
	return narrowToKnown(names, known);
}

/**
 * 全局默认模式的活视图，以 {@link ToolState} 形式。
 *
 * 内置的默认模式从不落盘（ADR-0004），所以这是它替代存在的方式：设置文件自己的工具集——没指名就
 * 是全集——加上它们的审批，像具名模式一样经 {@link fillTools} 填充。审批为 undefined 意味着「session
 * 从未选择」，所以视图保持活态：设置变更就是这个模式的变更。
 */
export function globalDefaultToolState(
	settings: SettingManager,
	workDirAbsPath: string,
	known: readonly string[],
): ToolState {
	return fillTools(undefined, {
		modes: settings.getSettings(workDirAbsPath).modes ?? [],
		globalTools: defaultToolNames(settings, workDirAbsPath, known),
		known,
	});
}

/**
 * 一个 session 所处的工具选择，每次读取时从账本推导。
 *
 * session 记录的选择——`.json` 快照里整体持有的激活集和审批表——是第一句话，更早的都被刻意丢弃，
 * 所以不需要任何东西持有它：激活集和闸门的审批都从这里读，而写入先落账本，下一次读取就已经按它
 * 回答。从未选择的 session 回落到全局默认的活视图——因为「session 从未做出的选择」就是全局默认。
 * loadout 不是其目录自己的 session（被委托的子 session）通过它的设置说明这一点，那些设置对它而言
 * 就是这里读到的默认。
 *
 * 回落值经由设置管理器按 session 自己 header 指名的目录活读——从不持有，所以设置一改下一次读取
 * 就生效，无须任何刷新。记录的工具集收窄到本构建仍认识的工具，升级中删掉的一个同样在读的时候被
 * 删掉，不会拒绝 session 重开——回落集出于同样理由同样收窄。记录的审批是 session 自己的选择，整体
 * 携带；没有记录时回落值作数，对全局默认而言就是「跟随设置」，保持活态。
 */
export function toolStateOf(
	sessionManager: SessionManager,
	session: Session,
	settings: SettingManager,
	known: readonly string[],
): ToolState {
	const recorded = sessionManager.getRecordedToolConfig(session);
	const workDirAbsPath = session.sessionSetting.workDirAbsPath;
	const fallback = globalDefaultToolState(settings, workDirAbsPath, known);
	const names = narrowToKnown(recorded.activeTools ?? fallback.activeToolNames, known);
	return {
		activeToolNames: names,
		approvalOverride: { ...(recorded.approval ?? fallback.approvalOverride ?? {}) },
	};
}

/**
 * session 记录的工具配置是否等于当前全局默认，逐半判断。
 *
 * 判断依据是字段相等而不是「存在记录」：重置被记录为*全局*值，按「有记录」判断会把刚重置的 session
 * 报告成已经选过。完全没有记录的 session 两半都跟随全局——那里的生效值*就是*全局值。
 *
 * 工具两半按集合比较，因为手改的设置文件不欠注册表一个顺序；审批两半按两侧所有 key 逐字段比较。
 */
function toolConfigFollowsGlobal(
	recorded: { activeTools?: string[]; approval?: Record<string, boolean> },
	globalTools: readonly string[],
	globalApprovals: Record<string, boolean>,
): { tools: boolean; approvals: boolean } {
	const tools =
		recorded.activeTools === undefined ||
		(recorded.activeTools.length === globalTools.length &&
			recorded.activeTools.every((name) => globalTools.includes(name)));

	let approvals = true;
	if (recorded.approval !== undefined) {
		const keys = new Set([...Object.keys(globalApprovals), ...Object.keys(recorded.approval)]);
		for (const key of keys) {
			if (globalApprovals[key] !== recorded.approval[key]) {
				approvals = false;
				break;
			}
		}
	}
	return { tools, approvals };
}

/**
 * 一个 session 相对其目录设置的 follow-global 判断。
 *
 * 两条快照路径共享的唯一形状——活的 `Agent` 和冷读必须对字段给出完全一致的回答，否则面板的「沿用
 * 全局」标签会在两者之间自相矛盾——所以判断所比较的全局默认在这里读，而不是第二次传入。（判断读的
 * 是 session 记录的选择，它已不再分支相对：两文件拆分让它成了 session 级的值。）
 */
export function followsGlobalOf(
	sessionManager: SessionManager,
	session: Session,
	settings: SettingManager,
	known: readonly string[],
): { toolsFollowGlobal: boolean; approvalsFollowGlobal: boolean } {
	const follows = toolConfigFollowsGlobal(
		sessionManager.getRecordedToolConfig(session),
		defaultToolNames(settings, session.sessionSetting.workDirAbsPath, known),
		settings.getApprovals(session.sessionSetting.workDirAbsPath),
	);
	return { toolsFollowGlobal: follows.tools, approvalsFollowGlobal: follows.approvals };
}
