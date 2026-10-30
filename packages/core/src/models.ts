import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type ChatTransport,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	getSupportedThinkingLevels,
	Model,
	type ModelConfig,
	type ModelThinkingLevel,
} from "@my-agent/llm";
import { anthropicCompatFor, anthropicThinkingLevelMapFor } from "./anthropic-models.ts";
import { AGENT_HOME } from "./config.ts";
import type { ModelOption } from "./protocol.ts";

/** The class itself, so a caller that only wants "a model" does not reach into the transport package. */
export { Model } from "@my-agent/llm";

/** The shape a row is written down in, re-exported so a caller need not name the package it lives in. */
export type { ModelConfig } from "@my-agent/llm";

/**
 * The models this installation runs, as configs a person wrote.
 *
 * There is no built-in catalog. pi-ai ships one, and it is deliberately not used: which endpoints
 * exist, what they cost, and how large their context is are all things the person paying the bill
 * knows better than a list compiled into a dependency. What pi-ai is still used for is everything
 * *after* the model is known — assembling the request, streaming the answer, retry classification,
 * thinking levels — which is the part worth not writing ourselves.
 *
 * Upstream pi-ai routed through a provider registry, where a provider owned a key and a base URL and a
 * set of models; that registry earned its keep when one host spoke several APIs with several credential
 * kinds, and this one does neither. A row already *is* "one endpoint, one key", so the registry held
 * one entry per row and its only content was a string the row already had. It is gone, and the key
 * travels from the row to the request directly.
 *
 * A row *is* a {@link ModelConfig}, and this file no longer keeps a second shape for it. There used to
 * be two: `UserModel`, the sparse facts a person typed, and `ModelInit`, the complete field table a
 * request needs, with `modelInitFor()` translating between them. That translation was one-way, held no
 * state, and lived for one call stack — the sign that the split was not doing work. The fields that
 * differed are constants of this build: `api` can only be one string, `input` can only be text, and
 * `cost` is unmeasured. Constants belong as defaults where the model is built, not as a mapping in the
 * layer above. So there is one shape now, owned by the package that constructs models from it, and the
 * stored file already has that shape.
 *
 * Two things stayed here instead of moving into `Model`. Which compat flags and thinking levels a
 * given wire id takes, because `anthropic-models.ts` is knowledge about endpoints rather than about
 * the transport. And the rules about what may be stored at all — {@link coerceModelConfig} — because
 * a config that came from a window or a text editor is not yet a config this app will send.
 */

/**
 * The user's models, as a session sees them.
 *
 * A session holds this for its whole life and reads it on every request rather than copying it, which
 * is what makes an edit take effect without reopening anything: a key corrected in the settings panel
 * is the key the next message uses, including from a window that has been open the whole time. The
 * read is one small file, so nothing here is cached and nothing has to be invalidated.
 */
export interface ModelSource {
	list(): readonly ModelConfig[];
}

/** The defaults a new row starts from, so the form never shows an empty numeric field. */
export const NEW_MODEL_DEFAULTS = {
	contextWindow: 200_000,
	maxTokens: 8_192,
	reasoning: false,
};

/**
 * The row a session opens on when nothing more specific names one.
 *
 * Hardcoded on purpose. Assembly used to answer this with "whichever row the user wrote first", which
 * is a guess that only looks like an answer when the first row happens to be the one they want: a
 * `models.json` rewritten by a repair script or a smoke run silently moves the default, and a stored
 * preference naming a row that has since been deleted moves it again. Naming the model here instead
 * means every session that nothing overrules opens on `deepseek-flash`, whatever order the file is in.
 *
 * This is the *default*, not an override: `settings.model` still names the row for new sessions, and
 * the composer still moves the session on screen. The same name is what the client plants when a
 * machine has no rows at all — see `DEFAULT_MODEL` in `packages/web/src/default-model.ts`, which
 * restates the literal because that module is bundled for the browser and this one runs on Node.
 */
export const DEFAULT_MODEL_NAME = "deepseek-flash";

/** Where the rows live. One file, beside the settings and the sessions. */
export function modelsPath(agentDir: string = AGENT_HOME): string {
	return join(agentDir, "models.json");
}

/**
 * The user's models, read from and written to one JSON file.
 *
 * Read on every {@link list} rather than cached, because the file is small and hand-editable: someone
 * who adds a row with an editor should not have to restart the app to see it, and a cache would make
 * that the surprising behaviour rather than the obvious one.
 */
export class ModelConfigStore {
	private readonly absFile: string;

	private constructor(absFile: string) {
		this.absFile = absFile;
	}

	static create(agentDir: string = AGENT_HOME): ModelConfigStore {
		return new ModelConfigStore(modelsPath(agentDir));
	}

	/** The stored configs, in the order they were written. A missing or unreadable file is no rows. */
	list(): ModelConfig[] {
		let text: string;
		try {
			text = readFileSync(this.absFile, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}

		const trimmed = text.trim();
		if (trimmed === "") return [];

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			throw new Error(`${this.absFile} is not valid JSON: ${(error as Error).message}`);
		}
		const entries = isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : [];
		const rows: ModelConfig[] = [];
		for (const entry of entries) {
			const config = coerceModelConfig(entry);
			if (config !== undefined) rows.push(config);
		}
		return rows;
	}

	/** Replace every row. The whole-list write is what keeps the names and the file from drifting apart. */
	replace(models: readonly ModelConfig[]): void {
		mkdirSync(dirname(this.absFile), { recursive: true });
		writeFileSync(this.absFile, `${JSON.stringify({ models }, null, "\t")}\n`, "utf8");
	}
}

/**
 * The placeholder's name, kept deliberately out of the way of any user row.
 *
 * A name is the whole identity of a row now, so this is what stops a user's own row from being mistaken
 * for "nothing configured". {@link coerceModelConfig} refuses it outright, because the alternative — quietly
 * storing the row under a different name — would mean the settings panel showed a name the user did not
 * type.
 */
const UNCONFIGURED_NAME = "my-agent:unconfigured";
const UNCONFIGURED_MODEL_ID = "no-model";

/** Whether a name is the placeholder's rather than a row the user could have entered. */
function isReserved(name: string): boolean {
	return name === UNCONFIGURED_NAME;
}

/**
 * Turn one incoming row into a stored one, or undefined when it cannot be.
 *
 * A name is not made unique here: it *is* the row's identity, so silently suffixing a duplicate would
 * change what every transcript referring to it means. The caller decides what a collision is — the
 * settings panel refuses the whole list and says so — and this only refuses what cannot be stored at
 * all: a reserved name, a missing model id, or a missing base URL.
 *
 * `label` is read as a name for a row written before a name was the identity, so an upgrade keeps the
 * names the user chose rather than the slugs they never saw. It costs the old refs, which were built
 * from those slugs: a session recorded against one of them comes up with no model and says to pick one.
 * That is the same account a rename or a deletion settles, and it is paid once rather than left as a
 * panel full of slugs forever.
 */
export function coerceModelConfig(input: unknown): ModelConfig | undefined {
	if (!isRecord(input)) return undefined;

	// `id` is the field's name now. `modelId` is what every file written before the config became the
	// row spends it under, so both are read: an upgrade keeps the endpoints it already had instead of
	// emptying a list of models the user entered by hand.
	const id = stringOrUndefined(input.id) ?? stringOrUndefined(input.modelId);
	if (id === undefined) return undefined;

	// A config added before the user has thought about what to call it takes the wire id as its name,
	// which is the same field they would have to fill in anyway.
	const name = stringOrUndefined(input.name) ?? stringOrUndefined(input.label) ?? id;
	if (isReserved(name)) return undefined;

	const baseUrl = stringOrUndefined(input.baseUrl);
	if (baseUrl === undefined) return undefined;

	// A level this app has no name for is dropped rather than stored: the file is hand-editable, and a
	// typo should leave the row on its own default instead of being carried around. A level the
	// *model* has no room for is a different question, and assembly settles it.
	const defaultThinkingLevel = thinkingLevelOr(input.defaultThinkingLevel);

	// Only the fields a person can meaningfully name are copied. `api`, `input`, and `cost` are
	// constants of this build, so they are not read back out of a file that could claim otherwise —
	// the same reason a submitted config does not get to choose its own transport.
	return {
		id,
		name,
		baseUrl,
		apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
		contextWindow: positiveInt(input.contextWindow, NEW_MODEL_DEFAULTS.contextWindow),
		maxTokens: positiveInt(input.maxTokens, NEW_MODEL_DEFAULTS.maxTokens),
		reasoning: input.reasoning === true,
		...(defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel }),
	};
}

/** One of the five levels this app has a name for, or undefined. */
function thinkingLevelOr(value: unknown): ThinkingLevel | undefined {
	return value === "off" || value === "low" || value === "medium" || value === "high" || value === "max"
		? value
		: undefined;
}

// ---------------------------------------------------------------------------- one config as a model

/**
 * The config with the facts its wire id implies filled in.
 *
 * `compat` and `thinkingLevelMap` are the two things a person cannot know and should not be asked:
 * they describe the endpoint behind an id, and `anthropic-models.ts` is where that table lives. Only a
 * config that says it reasons gets them — a row with `reasoning` off must produce a request with no
 * thinking parameters in it at all, and handing it a level table would be a promise the transport then
 * keeps.
 *
 * Nothing else is added here. The constants a config never names — `api`, `input`, `cost` — are
 * defaulted inside `Model.reconfigure`, in the package that knows what they can be. This function is
 * the only translation left between "what a person wrote" and "what a request needs", and it exists
 * because app knowledge could not follow the constants into the transport.
 */
function withCapabilities(config: ModelConfig): ModelConfig {
	if (!config.reasoning) return config;
	const compat = config.compat ?? anthropicCompatFor(config.id);
	const thinkingLevelMap = config.thinkingLevelMap ?? anthropicThinkingLevelMapFor(config.id);
	return {
		...config,
		...(compat === undefined ? {} : { compat }),
		...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
	};
}

/**
 * One config as the model a request is made with.
 *
 * The level is the second half of the same idea: it rides on the model, so "which endpoint" and "how
 * hard" are one object a request is made with and there is nowhere else for a strength to come from.
 * It is normalized against the built model, so a level the model has no room for lands on one it does
 * rather than on a value the endpoint rejects. Omitted leaves the model with no level at all, which the
 * wire reads as "do not think" — what a caller building a model for a job of its own wants, and what a
 * row with no default produces.
 *
 * `transport` is how this model will be sent. Left out, the model uses the package's one transport; a
 * session passes its own, which is where the retry policy and the "no row behind this model" answer
 * live.
 */
export function createModel(config: ModelConfig, thinkingLevel?: string, transport?: ChatTransport): Model {
	const model = new Model(withCapabilities(config), transport);
	if (thinkingLevel !== undefined) model.thinkingLevel = normalizeThinkingLevel(model, thinkingLevel);
	return model;
}

/**
 * Re-derive a live model from the config behind it, in place.
 *
 * What `Agent.adoptCurrentRow` calls before every request: the object the loop holds is the object that
 * changes, so a corrected key, a moved endpoint, a resized window, and a level table the row no longer
 * justifies all reach the next request without a new object being threaded through a run already going.
 *
 * The level is carried across by the caller rather than taken from the config — the config says what
 * the model can be asked, and the session is the one that chose — and it is re-normalized here, which
 * is what turns a row edited to stop reasoning into a session back at "off" instead of one still
 * claiming a level the row no longer has.
 */
export function applyRowToModel(model: Model, config: ModelConfig, thinkingLevel?: string): void {
	model.reconfigure(withCapabilities(config));
	if (thinkingLevel !== undefined) model.thinkingLevel = normalizeThinkingLevel(model, thinkingLevel);
}

/**
 * The model a session runs on when the user has entered none.
 *
 * A session still has to be built with *some* model, or the window cannot open far enough to tell
 * anyone what is missing: the failure has to arrive as a message in the transcript, where the fix can
 * be described, rather than as a server that refuses to serve a session. So this is a real model whose
 * row does not exist, and {@link unconfiguredStream} is what answers for it. Its name is the reserved
 * one, which is what {@link isUnconfigured} tests and what no stored row may claim.
 */
export function placeholderModel(transport?: ChatTransport): Model {
	return new Model(
		{
			id: UNCONFIGURED_MODEL_ID,
			name: UNCONFIGURED_NAME,
			baseUrl: "http://127.0.0.1:1/v1",
			contextWindow: 200_000,
			maxTokens: 8_192,
			reasoning: false,
		},
		transport,
	);
}

/** Whether a model is the placeholder rather than something the user entered. */
export function isUnconfigured(model: { name: string }): boolean {
	return model.name === UNCONFIGURED_NAME;
}

const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * The answer that explains itself.
 *
 * Written by hand because there is no request to make: the whole point of a session with no row is to
 * fail with a sentence the user can act on, in the transcript where they are already looking. It is
 * shaped like any transport's stream, so the loop reads it the way it reads a real failure.
 */
export function unconfiguredStream(model: Model<Api>): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		model: model.id,
		usage: ZERO_USAGE,
		stopReason: "error",
		errorMessage: "No model is configured yet. Open Settings and add one, then pick it for this session.",
		timestamp: Date.now(),
	};
	// Pushed asynchronously so a caller that attaches to the stream before it ends — the loop does —
	// sees the failure the same way it would see a transport's.
	queueMicrotask(() => {
		stream.push({ type: "error", reason: "error", error: message });
		stream.end();
	});
	return stream;
}

// ---------------------------------------------------------------------------- lookup

/** The rows, narrowed to what a client may see. The key itself never leaves the server. */
export function listModelOptions(models: readonly ModelConfig[]): ModelOption[] {
	return models.map((config) => {
		const built = createModel(config);
		return {
			id: config.id,
			name: config.name,
			api: built.api,
			baseUrl: config.baseUrl,
			contextWindow: config.contextWindow,
			maxTokens: config.maxTokens,
			reasoning: config.reasoning,
			// The levels travelled with the row rather than being worked out by the client, which has no
			// way to know what an endpoint takes. A composer that moves the model needs the new row's own
			// list, and it needs it before the move is sent anywhere.
			thinkingLevels: [...getSupportedThinkingLevels(built)],
			defaultThinkingLevel: normalizeThinkingLevel(built, config.defaultThinkingLevel),
			hasApiKey: (config.apiKey ?? "").length > 0,
		};
	});
}

/** Every thinking level the model accepts, lowest first. A model that always thinks has no "off". */
export function thinkingLevelsFor(model: Model<Api>): string[] {
	return [...getSupportedThinkingLevels(model)];
}

/**
 * Thinking levels a session can be in.
 *
 * The scale is the transport's, named here so a caller in this package does not reach for
 * `@my-agent/llm` merely to spell a level — and named as an alias rather than restated, because two
 * hand-written copies of five string literals is the drift this file just spent a type removing.
 */
export type ThinkingLevel = ModelThinkingLevel;

/**
 * Clamp a requested level to one this model supports.
 *
 * A level the model does not have is not a level a session can be in, so it lands on the quietest one
 * the model does have: "off" where thinking can be turned off, and the lowest effort where it cannot —
 * which is what a model with `off: null` in its `thinkingLevelMap` says about itself. Falling back to
 * "off" unconditionally would record a level the transport then ignores, and on a model that always
 * thinks adaptively that means the request goes out with thinking on while the window says it is off.
 */
export function normalizeThinkingLevel(model: Model<Api>, level: string | undefined): ThinkingLevel {
	const allowed = getSupportedThinkingLevels(model);
	const quietest = (allowed.includes("off") ? "off" : allowed[0] ?? "off") as ThinkingLevel;
	if (level === undefined || level === "off") return quietest;
	if (!allowed.includes(level as ThinkingLevel)) return quietest;
	return clampThinkingLevel(model, level as ThinkingLevel) as ThinkingLevel;
}

// ---------------------------------------------------------------------------- parsing

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
