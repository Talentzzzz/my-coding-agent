import { APPROVAL_TOOLS, type ToolApprovalKey } from "../protocol.ts";
import { type SettingsState, getApprovals, getSettings, getTools } from "../settings-manager.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { fillTools, narrowToKnown, type ToolState } from "../tools/manager.ts";
import { type SessionManager, type Session } from "./session-manager.ts";

/** The tools an approval map gates, in the loadout's order. */
export function approvalToolsOf(approval: Record<ToolApprovalKey, boolean>): ToolApprovalKey[] {
	return APPROVAL_TOOLS.filter((name) => approval[name]);
}

/**
 * The global default tool set, narrowed to the tools this build knows.
 *
 * The one answer every consumer of the default shares — assembly, a branch move, and the follow-global
 * judgement — because three spellings of "the default" would let a reset write one set while the
 * panel judged the session against another, and a just-reset session would read as having chosen.
 */
export function defaultToolNames(s: SettingsState, registry: ToolRegistry): string[] {
	const configured = getTools(s);
	const names = configured === undefined ? registry.names() : configured;
	return narrowToKnown(names, registry.names());
}

/**
 * The global default mode's live view, as a {@link ToolState}.
 *
 * The built-in default mode is never stored (ADR-0005), so this is what it is instead: the settings
 * files' own tool set — the full set when they name none — and their approvals, filled through
 * {@link fillTools} the same way a named mode would be. Undefined approvals mean "the session never
 * chose", so the view stays live: a settings change is this mode's change.
 */
export function globalDefaultToolState(s: SettingsState, registry: ToolRegistry): ToolState {
	return fillTools(undefined, {
		modes: getSettings(s).modes ?? [],
		globalTools: defaultToolNames(s, registry),
		known: registry.names(),
	});
}

/**
 * The tool choice one session is in, derived from the ledger, on every read.
 *
 * The session's recorded choice — the `.json` snapshot's active set and approval map, both held
 * whole — is the first word, and every earlier one is gone by design, which is why nothing needs to
 * hold it: the registry's active set and the gate's approvals all read through here, and a write
 * lands in the ledger first, so the next read already answers from it. A session that never chose
 * falls back on the global default's live view — because "the choice the session never made" is the
 * global default. A session whose loadout is not its directory's own (the delegated child) says
 * so through its settings, which for it are the default this reads.
 *
 * The recorded set is narrowed to the tools this build still knows, so one an upgrade dropped is
 * dropped by the read too and cannot refuse the session its reopen — and the fallback is narrowed the
 * same way, for the same reason. A recorded approval is the session's own choice and is carried whole;
 * without one the fallback's answer stands, which for the global default is "follow the settings",
 * kept live.
 */
export function toolStateOf(sessions: SessionManager, state: Session, s: SettingsState, registry: ToolRegistry): ToolState {
	const recorded = sessions.getRecordedToolConfig(state);
	const fallback = globalDefaultToolState(s, registry);
	const names = narrowToKnown(recorded.activeTools ?? fallback.activeToolNames, registry.names());
	return {
		activeToolNames: names,
		approvalOverride: { ...(recorded.approval ?? fallback.approvalOverride ?? {}) },
	};
}

/**
 * Whether the session's recorded tool config equals the current global default, one half at a time.
 *
 * The judgement is field equality rather than "a choice exists": a reset is recorded as the *global*
 * values, so "has recorded anything" would report a just-reset session as having
 * chosen. A session with no recorded choice at all follows global on both halves — the effective
 * value there *is* the global one.
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
 * The follow-global judgement for one session over its directory's settings.
 *
 * The one shape both snapshot paths share — a live `Agent` and a cold read must answer the field
 * identically, or the panel's "沿用全局" label would disagree with itself between the two — so the
 * global default the judgement compares against is read here rather than passed in a second time.
 * (The judgement reads the session's recorded choice, which is no longer branch-relative: the
 * two-file split made it a session-level value.)
 */
export function followsGlobalOf(
	sessions: SessionManager,
	state: Session,
	s: SettingsState,
	registry: ToolRegistry,
): { toolsFollowGlobal: boolean; approvalsFollowGlobal: boolean } {
	const follows = toolConfigFollowsGlobal(
		sessions.getRecordedToolConfig(state),
		defaultToolNames(s, registry),
		getApprovals(s),
	);
	return { toolsFollowGlobal: follows.tools, approvalsFollowGlobal: follows.approvals };
}
