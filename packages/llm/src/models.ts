// Vendored from @earendil-works/pi-ai (0.99.2) and cut down to what this app drives: the facts about
// a model that a request depends on. Upstream this file is also the provider registry — `Provider`,
// `Models`, `createProvider`, auth resolution, and the per-type dispatch that goes with them — and
// none of that survives here. This app has one transport and one key per model, so a catalog of
// providers was a registry of one entry whose only content was a string it already had. Checked by
// packages/llm/tsconfig.json under pi's own compiler settings; @ts-nocheck keeps the repo root's
// stricter config from flagging this file, while every import into packages/core stays fully
// checked.
// @ts-nocheck
import type { ThinkingLevel } from "./types.ts";

export { ModelsError, type ModelsErrorCode } from "./utils/models-error.ts";

/**
 * The levels every model this build can drive is asked at, lowest first.
 *
 * The list is constant because the answer no longer depends on the model: an effort is the one
 * strength this wire carries, every Anthropic-Messages endpoint takes the three, and a model that
 * cannot think is simply left at `off`. It is the same list `ThinkingLevel` names, and the same one
 * the composer renders.
 */
const SUPPORTED_THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "high", "max"];

/** Every thinking level a session can be in, lowest first. */
export function getSupportedThinkingLevels(): ThinkingLevel[] {
	return [...SUPPORTED_THINKING_LEVELS];
}
