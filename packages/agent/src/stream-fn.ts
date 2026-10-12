// Vendored from @earendil-works/pi-agent-core (0.99.2) with the engine renamed against upstream:
// Agent → Loop, AgentState → LoopState, AgentOptions → LoopOptions, AgentInitialState →
// LoopInitialState; diff against pi-main with those in mind. Checked by packages/agent/tsconfig.json
// under pi's own compiler settings; @ts-nocheck keeps the workspace's stricter root config from
// flagging this file, while every import into packages/core stays fully checked.
// @ts-nocheck
import type { StreamFn } from "./types.ts";

let defaultStreamFn: StreamFn | undefined;

/**
 * Configure the fallback used by Loop and low-level loops when callers omit streamFn.
 *
 * Hosts that provide a default model runtime can install its stream function here
 * without making pi-agent-core depend on a provider catalog or compatibility layer.
 */
export function setDefaultStreamFn(streamFn: StreamFn | undefined): void {
	defaultStreamFn = streamFn;
}

export function getDefaultStreamFn(): StreamFn {
	if (!defaultStreamFn) {
		throw new Error("No default stream function configured. Pass streamFn explicitly or call setDefaultStreamFn().");
	}
	return defaultStreamFn;
}
