// Vendored from @earendil-works/pi-ai (0.99.2) and cut down to what this app drives: the facts about
// a model that a request depends on. Upstream this file is also the provider registry — `Provider`,
// `Models`, `createProvider`, auth resolution, and the per-type dispatch that goes with them — and
// none of that survives here. This app has one transport and one key per model, so a catalog of
// providers was a registry of one entry whose only content was a string it already had. Checked by
// packages/llm/tsconfig.json under pi's own compiler settings; @ts-nocheck keeps the workspace's
// stricter root config from flagging this file, while every import into packages/core stays fully
// checked.
// @ts-nocheck
import type { Model } from "./model.ts";
import type { Api, ModelThinkingLevel } from "./types.ts";

export { ModelsError, type ModelsErrorCode } from "./utils/models-error.ts";

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "low", "medium", "high", "max"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "max") return mapped !== undefined;
		return true;
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}
