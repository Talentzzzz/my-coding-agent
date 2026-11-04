import type { AnthropicMessagesCompat } from "./llm/index.ts";

/**
 * What a model has to be told, derived from its wire id.
 *
 * pi-ai carries these facts as generated metadata in a catalog this app deliberately does not use
 * (`models.ts` says why). A hand-typed row has only its wire id to key them by, which is enough for
 * Claude: what the API accepts moved by generation — 4.7 and later reject a temperature — and the id
 * names the generation.
 *
 * Thinking is deliberately not one of them. Every row is asked the same way, adaptive with an
 * effort, and the four levels this app has are the four names that wire takes, so a level goes out
 * as itself. That is also what removed the per-model level table this file used to carry: the app no
 * longer claims to know which models can think or which of them have a native `max`, it asks and lets
 * an endpoint that disagrees answer for itself.
 *
 * A wrong value here is not cosmetic: a temperature a model refuses fails the whole request. So the
 * Claude entries are a port of pi's own `isAnthropicTemperatureUnsupportedModel` rather than a guess.
 */

/** Families that reject the `temperature` field outright, whatever its value. */
const REJECTS_TEMPERATURE = ["opus-4-7", "opus-4.7", "opus-4-8", "opus-4.8", "opus-5", "opus.5", "sonnet-5-5", "sonnet-5.5"];

/** The compatibility overrides this model needs, or undefined when it needs none. */
export function anthropicCompatFor(modelId: string): AnthropicMessagesCompat | undefined {
	const id = normalize(modelId);
	const compat: AnthropicMessagesCompat = {};
	if (includesAny(id, REJECTS_TEMPERATURE)) compat.supportsTemperature = false;
	return Object.keys(compat).length > 0 ? compat : undefined;
}

/** A gateway id prefixes the vendor path (`anthropic/claude-opus-5`); the model behind it is the same. */
function normalize(modelId: string): string {
	return modelId.toLowerCase().replace(/^~?anthropic\//, "");
}

function includesAny(id: string, needles: readonly string[]): boolean {
	return needles.some((needle) => id.includes(needle));
}
