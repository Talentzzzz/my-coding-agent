import { APPROVAL_TOOLS, type ToolApprovalKey } from "../protocol.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { SessionManager } from "./session-manager.ts";

/** The tools an approval map gates, in the loadout's order. */
export function approvalToolsOf(approval: Record<ToolApprovalKey, boolean>): ToolApprovalKey[] {
	return APPROVAL_TOOLS.filter((name) => approval[name]);
}

/**
 * Put a registry back on the tool set the active branch recorded, and answer its approval map.
 *
 * `tool_config` entries hold both maps whole, so the last one on the branch is the state and every
 * earlier one is history. A branch that carries no entry falls back on `globalTools` — the global
 * default the settings files now name (or the registry's full set, when they name nothing) — because
 * "the choice the session never made" is the global default, not "whatever the last branch left in
 * the registry".
 *
 * Only the tool set is applied here. The approval map is answered instead, because the state belongs
 * to the session and the two callers hold it differently: assembly passes it into a session that does
 * not exist yet, while a session that moves onto another branch merges it into its own override.
 *
 * The recorded set is narrowed to the tools this build still knows, so one an upgrade dropped is
 * dropped by the replay too and cannot refuse the session its reopen. `globalTools` is narrowed the
 * same way, for the same reason: a hand-edited settings file may name a tool this build no longer has.
 */
export function applyRecordedToolConfig(
	sessionManager: SessionManager,
	registry: ToolRegistry,
	globalTools: readonly string[],
): { approval?: Record<ToolApprovalKey, boolean> } {
	const recorded = sessionManager.getRecordedToolConfig();
	const names = recorded.activeTools ?? globalTools;
	registry.setActive(names.filter((name) => registry.get(name) !== undefined));
	return recorded.approval === undefined ? {} : { approval: recorded.approval };
}

/**
 * The global default tool set, narrowed to the tools this build knows.
 *
 * The one answer every consumer of the default shares — assembly, a branch move, and the follow-global
 * judgement — because three spellings of "the default" would let a reset write one set while the
 * panel judged the session against another, and a just-reset session would read as having chosen.
 */
export function defaultToolNames(settingsManager: SettingsManager, registry: ToolRegistry): string[] {
	const configured = settingsManager.getTools();
	return (configured === undefined ? registry.all().map((tool) => tool.name) : configured).filter(
		(name) => registry.get(name) !== undefined,
	);
}

/**
 * Whether the branch's recorded tool config equals the current global default, one half at a time.
 *
 * The judgement is field equality rather than "an entry exists": a reset is written as a new entry
 * that *holds* the global values, so "has an entry" would report a just-reset session as having
 * chosen. A branch with no entry at all follows global on both halves — the effective value there
 * *is* the global one.
 *
 * The tool halves are compared as sets, because a hand-edited settings file owes the registry no
 * order; the approval halves are compared field by field over every key either side names.
 */
function toolConfigFollowsGlobal(
	recorded: { activeTools?: string[]; approval?: Record<ToolApprovalKey, boolean> },
	globalTools: readonly string[],
	globalApprovals: Record<ToolApprovalKey, boolean>,
): { tools: boolean; approvals: boolean } {
	const tools =
		recorded.activeTools === undefined ||
		(recorded.activeTools.length === globalTools.length &&
			recorded.activeTools.every((name) => globalTools.includes(name)));

	let approvals = true;
	if (recorded.approval !== undefined) {
		const keys = new Set([...Object.keys(globalApprovals), ...Object.keys(recorded.approval)]);
		for (const key of keys) {
			if (globalApprovals[key as ToolApprovalKey] !== recorded.approval[key as ToolApprovalKey]) {
				approvals = false;
				break;
			}
		}
	}
	return { tools, approvals };
}

/**
 * The follow-global judgement for one session over its workspace's settings.
 *
 * The one shape both snapshot paths share — a live `Agent` and a cold read must answer the field
 * identically, or the panel's "沿用全局" label would disagree with itself between the two — so the
 * global default the judgement compares against is read here rather than passed in a second time.
 */
export function followsGlobalOf(
	sessionManager: SessionManager,
	settingsManager: SettingsManager,
	registry: ToolRegistry,
): { toolsFollowGlobal: boolean; approvalsFollowGlobal: boolean } {
	const follows = toolConfigFollowsGlobal(
		sessionManager.getRecordedToolConfig(),
		defaultToolNames(settingsManager, registry),
		settingsManager.getApprovals(),
	);
	return { toolsFollowGlobal: follows.tools, approvalsFollowGlobal: follows.approvals };
}
