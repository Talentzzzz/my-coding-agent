import { APPROVAL_TOOLS, type ToolApprovalKey } from "../protocol.ts";
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
 * earlier one is history. A branch that carries no entry answers nothing for either map: the caller
 * keeps the defaults, because that is the choice the session never made.
 *
 * Only the tool set is applied here. The approval map is answered instead, because the state belongs
 * to the session and the two callers hold it differently: assembly passes it into a session that does
 * not exist yet, while a session that moves onto another branch merges it into its own override.
 *
 * The recorded set is narrowed to the tools this build still knows, so one an upgrade dropped is
 * dropped by the replay too and cannot refuse the session its reopen.
 */
export function applyRecordedToolConfig(
	sessionManager: SessionManager,
	registry: ToolRegistry,
): { approval?: Record<ToolApprovalKey, boolean> } {
	const recorded = sessionManager.getRecordedToolConfig();
	if (recorded.activeTools !== undefined) {
		registry.setActive(recorded.activeTools.filter((name) => registry.get(name) !== undefined));
	}
	return recorded.approval === undefined ? {} : { approval: recorded.approval };
}
