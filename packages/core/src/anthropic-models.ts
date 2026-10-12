import type { AnthropicMessagesCompat, ThinkingLevelMap } from "@my-agent/ai";

/**
 * What a model has to be told, derived from its wire id.
 *
 * pi-ai carries these facts as generated metadata in a catalog this app deliberately does not use
 * (`models.ts` says why). A hand-typed row has only its wire id to key them by, which is enough for
 * Claude: what the API accepts moved by generation — 4.7 and later reject a temperature — and the id
 * names the generation.
 *
 * Thinking is deliberately not one of them. Every reasoning row is asked the same way, adaptive with
 * an effort: `thinking.type: "enabled"` is deprecated on Anthropic's own side (the SDK warns about
 * it), and an effort is the one strength knob a model that speaks this wire is certain to have. What
 * is left here is only how a level is *spelled* — an endpoint with fewer native efforts than the app
 * has levels needs one folded onto another, and a family with no way to stop thinking says so — plus
 * which levels exist at all.
 *
 * A wrong value here is not cosmetic. An effort a model has no native level for is rejected with a
 * 400, and a temperature a model refuses fails the whole request. So the Claude entries are a port of
 * pi's own per-model rules rather than a guess: `isAnthropicTemperatureUnsupportedModel` and the
 * `thinkingLevelMap` merges next to it in pi's `scripts/generate-models.ts`. DeepSeek's entry is the
 * one pi has no counterpart for, because pi reaches DeepSeek over a different API;
 * {@link FOLDED_EFFORT_LEVELS} says what it rests on.
 */

/** Families that reject the `temperature` field outright, whatever its value. */
const REJECTS_TEMPERATURE = ["opus-4-7", "opus-4.7", "opus-4-8", "opus-4.8", "opus-5", "opus.5", "sonnet-5-5", "sonnet-5.5"];

/** Families with a native `max` effort. */
const NATIVE_MAX = [
	"opus-4-6",
	"opus-4.6",
	"opus-4-7",
	"opus-4.7",
	"opus-4-8",
	"opus-4.8",
	"opus-5",
	"opus.5",
	"sonnet-4-6",
	"sonnet-4.6",
	"sonnet-5",
	"sonnet.5",
	"fable-5",
];

/**
 * Families whose endpoint takes fewer native efforts than the app has levels.
 *
 * DeepSeek is the one. Its Anthropic-compatible endpoint reads the strength from
 * `output_config.effort`, takes three efforts, and ignores `budget_tokens` entirely — which is now
 * simply the shape every row is asked in, so all this entry still decides is the spelling: without
 * it `medium` would go out as a value the endpoint rejects. pi has no counterpart to port, because
 * pi reaches DeepSeek over `openai-completions`.
 *
 * What this describes is an endpoint, and a wire id cannot see one: pi verifies facts like this per
 * provider as well as per model, while a row here is a name, a URL, and a key. A row merely named
 * after a DeepSeek model therefore gets this even when it points somewhere else, which is the price
 * of the only thing this table can read; `baseUrl` is the user's to type.
 */
const FEWER_NATIVE_EFFORTS = /^deepseek[-/]/;

/** Whether this endpoint has fewer native efforts than the app has levels. */
function foldsLevels(modelId: string): boolean {
	return FEWER_NATIVE_EFFORTS.test(normalize(modelId));
}

/** DeepSeek takes three efforts, so two of the app's four levels fold onto `high`. */
const FOLDED_EFFORT_LEVELS: ThinkingLevelMap = { low: "low", medium: "high", high: "high", max: "max" };

/** The compatibility overrides this model needs, or undefined when it needs none. */
export function anthropicCompatFor(modelId: string): AnthropicMessagesCompat | undefined {
	const id = normalize(modelId);
	const compat: AnthropicMessagesCompat = {};
	if (includesAny(id, REJECTS_TEMPERATURE)) compat.supportsTemperature = false;
	return Object.keys(compat).length > 0 ? compat : undefined;
}

/**
 * The thinking levels this model actually has, or undefined when the defaults are already right.
 *
 * `max` is only offered when the model has a native level for it, `off` is removed from a family that
 * has no way to stop thinking, and an endpoint with fewer native efforts than the app has levels gets
 * a spelling for each, so no level goes out as a value the endpoint rejects.
 */
export function anthropicThinkingLevelMapFor(modelId: string): ThinkingLevelMap | undefined {
	const id = normalize(modelId);
	const map: ThinkingLevelMap = {};
	if (includesAny(id, NATIVE_MAX)) Object.assign(map, { max: "max" });
	if (id.includes("fable-5")) Object.assign(map, { off: null });
	if (foldsLevels(id)) Object.assign(map, FOLDED_EFFORT_LEVELS);
	return Object.keys(map).length > 0 ? map : undefined;
}

/** A gateway id prefixes the vendor path (`anthropic/claude-opus-5`); the model behind it is the same. */
function normalize(modelId: string): string {
	return modelId.toLowerCase().replace(/^~?anthropic\//, "");
}

function includesAny(id: string, needles: readonly string[]): boolean {
	return needles.some((needle) => id.includes(needle));
}
