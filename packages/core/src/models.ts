import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type ChatTransport,
	createAssistantMessageEventStream,
	getSupportedThinkingLevels,
	Model,
	type ModelConfig,
	type ThinkingLevel as LlmThinkingLevel,
} from "@my-agent/llm";
import { anthropicCompatFor } from "./anthropic-models.ts";
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

/**
 * The field table the placeholder answers with, shared by the model and the state seed.
 *
 * The endpoint points nowhere on purpose: a request to it is never made, because the transport
 * answers for the placeholder before anything is sent. The window is a real one so a usage read has
 * something to measure against.
 */
const PLACEHOLDER_CONFIG: ModelConfig = {
	id: UNCONFIGURED_MODEL_ID,
	name: UNCONFIGURED_NAME,
	baseUrl: "http://127.0.0.1:1/v1",
	contextWindow: NEW_MODEL_DEFAULTS.contextWindow,
	maxTokens: NEW_MODEL_DEFAULTS.maxTokens,
};

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
	};
}

// ---------------------------------------------------------------------------- one config as a model

/**
 * The config with the facts its wire id implies filled in.
 *
 * `compat` is the one thing a person cannot know and should not be asked: it describes the endpoint
 * behind an id, and `anthropic-models.ts` is where that table lives.
 *
 * Nothing else is added here. The constants a config never names — `api`, `input`, `cost` — are
 * defaulted inside `Model`'s constructor, in the package that knows what they can be. This function is
 * the only translation left between "what a person wrote" and "what a request needs", and it exists
 * because app knowledge could not follow the constants into the transport.
 */
function withCapabilities(config: ModelConfig): ModelConfig {
	const compat = config.compat ?? anthropicCompatFor(config.id);
	return compat === undefined ? config : { ...config, compat };
}

/**
 * One config as the model a request is made with.
 *
 * The level is the second half of the same idea: it rides on the model, so "which endpoint" and "how
 * hard" are one object a request is made with and there is nowhere else for a strength to come from.
 * It is normalized here, so a string this app has no name for lands on "off" rather than on a value
 * the endpoint rejects. Omitted leaves the model with no level at all, which the wire reads as "do
 * not think" — what a caller building a model for a job of its own wants.
 *
 * `transport` is how this model will be sent. Left out, the model uses the package's one transport; a
 * session passes its own, which is where the retry policy and the "no row behind this model" answer
 * live.
 */
export function createModel(config: ModelConfig, thinkingLevel?: string, transport?: ChatTransport): Model {
	const model = new Model(withCapabilities(config), transport);
	if (thinkingLevel !== undefined) model.thinkingLevel = normalizeThinkingLevel(thinkingLevel);
	return model;
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
	return resolvedModel(placeholderModelState(), transport);
}

/** Whether a model is the placeholder rather than something the user entered. */
export function isUnconfigured(model: { name: string }): boolean {
	return model.name === UNCONFIGURED_NAME;
}

// ---------------------------------------------------------------------------- the stateless surface

/**
 * One model as pure data: the seed the client sent, plus whatever the last fill laid in.
 *
 * A session holds no live model object any more than it holds its transcript. What it holds is the
 * selection — the row's name and the level it is asked at, exactly what the composer's
 * {@link ModelSelection} carries — and {@link fillModel} lays the row's facts over the bag, in place,
 * before anything reads them. The seed is the bag's only source of truth about *which* model; every
 * field a request needs is a fill product, so a key corrected between two requests is the key the
 * second request sends with, and nothing in the bag can outlive the row it came from.
 */
export type ModelState = Partial<Omit<ModelConfig, "thinkingLevel">> & {
	/**
	 * The level as the seed named it, verbatim. `fillModel` normalizes what it keeps, and the readers
	 * normalize what they read, so a string the app has no name for lands on "off" by the time it is
	 * asked at. Undefined means nothing was asked for, which the wire reads as "do not think".
	 */
	thinkingLevel?: string;
};

/**
 * The state a session with no row holds: the placeholder's own field table, laid in once.
 *
 * It never fills — the name is reserved, so no catalog row can answer it — and the stream it answers
 * with is the sentence that says what to add. The table is complete rather than a bare seed so a
 * snapshot, a usage read, and the error message all read a well-formed model without a special case.
 */
export function placeholderModelState(): ModelState {
	return { ...PLACEHOLDER_CONFIG };
}

/**
 * Lay the row a state names over the state, in place.
 *
 * The lookup is by the seed's name — a row's name is its identity — and a name no row answers throws:
 * the caller decides what an unknown model means, and a session answers it with the sentence that says
 * what to add rather than with a request to a placeholder endpoint. Idempotent by construction, and
 * meant to be re-run before every request: the bag keeps nothing of the row it last saw, so an
 * endpoint moved or a key corrected reaches the next request with nothing rebuilt.
 *
 * Every field a row can carry is assigned, present or not — a bag moving from a row that had a compat
 * override to one that does not must lose the old one, not keep it. The fields a row never carries are
 * the build's constants, and those are the request object's constructor's to default. The key is laid
 * in like any other row fact: it rides to the request path and nowhere else, never to an event, a
 * snapshot, or a REST answer.
 */
export function fillModel(catalog: readonly ModelConfig[], model: ModelState): void {
	const row = catalog.find((candidate) => candidate.name === model.name);
	if (row === undefined) throw new Error(`No model row is named ${model.name ?? "(nothing)"}`);
	const capable = withCapabilities(row);
	model.id = capable.id;
	model.name = capable.name;
	model.baseUrl = capable.baseUrl;
	model.apiKey = capable.apiKey;
	model.contextWindow = capable.contextWindow;
	model.maxTokens = capable.maxTokens;
	model.compat = capable.compat;
	if (model.thinkingLevel !== undefined) model.thinkingLevel = normalizeThinkingLevel(model.thinkingLevel);
}

/**
 * The run-local request object a filled state is sent with: built fresh, used for the one request,
 * dropped.
 *
 * The bag is the state; this is the request. `Model`'s constructor defaults the constants a row never
 * names, so the only precondition is that the state went through {@link fillModel} — or the
 * placeholder seed — first, which is what makes the cast safe to make here and nowhere else.
 */
export function resolvedModel(model: ModelState, transport?: ChatTransport): Model {
	return new Model(model as ModelConfig, transport);
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
			// The levels travel with the row so a composer that moves the model has the list before the
			// move reaches the server. It is the same four for every row; the field stays because the
			// composer reads one shape whether the row is stored, planted or reported by a session.
			thinkingLevels: [...getSupportedThinkingLevels()],
			hasApiKey: (config.apiKey ?? "").length > 0,
		};
	});
}

/** Every thinking level a session can be in, lowest first. */
export function thinkingLevelsFor(): string[] {
	return [...getSupportedThinkingLevels()];
}

/**
 * Thinking levels a session can be in.
 *
 * The scale is the transport's, re-exported so a caller in this package does not reach for
 * `@my-agent/llm` merely to spell a level — and re-exported rather than restated, because two
 * hand-written copies of four string literals is the drift this file just spent a type removing.
 */
export type ThinkingLevel = LlmThinkingLevel;

/**
 * A requested level as one this app can record.
 *
 * The set is the same for every model — an effort is the one strength the wire carries — so this is a
 * name check, not a clamp: a string the app has no name for, and the caller that asked for nothing,
 * both land on "off". That is the honest answer for "nothing was asked", and it is the request that
 * says so on the wire.
 */
export function normalizeThinkingLevel(level: string | undefined): ThinkingLevel {
	const allowed = getSupportedThinkingLevels();
	return allowed.includes(level as LlmThinkingLevel) ? (level as ThinkingLevel) : "off";
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
