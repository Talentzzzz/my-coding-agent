import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	getSupportedThinkingLevels,
	type Model,
} from "@my-agent/ai";
import { anthropicCompatFor, anthropicThinkingLevelMapFor } from "./anthropic-models.ts";
import { AGENT_HOME } from "./config.ts";
import type { ModelOption } from "./protocol.ts";

/**
 * The wire id every model here carries.
 *
 * `Model.api` is a string field, and pi-ai dispatches on it. This app has exactly one value it can
 * be, so it is named once and written in both places a model is built rather than typed twice.
 */
const ANTHROPIC_MESSAGES_API = "anthropic-messages";

/**
 * The models this installation runs, as rows the user typed.
 *
 * There is no built-in catalog. pi-ai ships one, and it is deliberately not used: which endpoints
 * exist, what they cost, and how large their context is are all things the person paying the bill
 * knows better than a list compiled into a dependency. What pi-ai is still used for is everything
 * *after* the model is known — assembling the request, streaming the answer, retry classification,
 * thinking levels — which is the part worth not writing ourselves.
 *
 * A row is the whole of a model here: the endpoint, the key that reaches it, and the model's own
 * facts. There is no layer between a row and a request. Upstream pi-ai routed through a provider
 * registry, where a provider owned a key and a base URL and a set of models; that registry earned its
 * keep when one host spoke several APIs with several credential kinds, and this one does neither. A
 * row already *is* "one endpoint, one key", so the registry held one entry per row and its only
 * content was a string the row already had. It is gone, and the key travels from the row to the
 * request directly.
 */

/**
 * One model the user entered.
 *
 * Every row goes over Anthropic Messages — there is no transport field, because there is nothing to
 * choose between. A row is the endpoint, the key that reaches it, and the model's own facts.
 *
 * `name` is the row's identity as well as its label. It is what the transcript records, what a config
 * patch names, and what the settings panel shows, so those are one thing rather than two that can drift
 * apart. The cost is stated plainly: renaming a row that sessions were using breaks their reference to
 * it, exactly as deleting the row does, and both are answered the same way — the session opens with no
 * model and a sentence saying to pick one.
 */
export interface UserModel {
	/** The row's identity, and what the picker shows. Unique among the rows, at the user's hand. */
	name: string;
	baseUrl: string;
	/** Sent to the endpoint. The one way this app authenticates. */
	apiKey: string;
	/** The name the endpoint knows the model by. */
	modelId: string;
	contextWindow: number;
	maxTokens: number;
	/** Whether the transport should offer thinking levels for this model. */
	reasoning: boolean;
	/**
	 * The level a session opened on this row starts at, before anyone moves the composer.
	 *
	 * A per-row default rather than one per workspace, because the levels are the model's: a level
	 * that is the middle of a five-level family is not a level a three-effort endpoint has. Absent
	 * means the row was added before this field existed or the user never chose, and the session opens
	 * as quiet as the model gets.
	 */
	defaultThinkingLevel?: ThinkingLevel;
}

/**
 * The user's models, as a session sees them.
 *
 * A session holds this for its whole life and reads it on every request rather than copying it, which
 * is what makes an edit take effect without reopening anything: a key corrected in the settings panel
 * is the key the next message uses, including from a window that has been open the whole time. The
 * read is one small file, so nothing here is cached and nothing has to be invalidated.
 */
export interface ModelSource {
	list(): readonly UserModel[];
}

/** The defaults a new row starts from, so the form never shows an empty numeric field. */
export const NEW_MODEL_DEFAULTS = {
	contextWindow: 200_000,
	maxTokens: 8_192,
	reasoning: false,
};

/** The vendor whose endpoint a blank row points at, as a starting value rather than a choice. */
export const DEFAULT_BASE_URL = "https://api.anthropic.com";

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
export class UserModelStore {
	private readonly file: string;

	private constructor(file: string) {
		this.file = file;
	}

	static create(agentDir: string = AGENT_HOME): UserModelStore {
		return new UserModelStore(modelsPath(agentDir));
	}

	/** The stored rows, in the order they were written. A missing or unreadable file is no rows. */
	list(): UserModel[] {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
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
			throw new Error(`${this.file} is not valid JSON: ${(error as Error).message}`);
		}
		const entries = isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : [];
		const rows: UserModel[] = [];
		for (const entry of entries) {
			const model = coerceModel(entry);
			if (model !== undefined) rows.push(model);
		}
		return rows;
	}

	/** Replace every row. The whole-list write is what keeps the names and the file from drifting apart. */
	replace(models: readonly UserModel[]): void {
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(this.file, `${JSON.stringify({ models }, null, "\t")}\n`, "utf8");
	}
}

/**
 * The placeholder's name, kept deliberately out of the way of any user row.
 *
 * A name is the whole identity of a row now, so this is what stops a user's own row from being mistaken
 * for "nothing configured". {@link coerceModel} refuses it outright, because the alternative — quietly
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
export function coerceModel(input: unknown): UserModel | undefined {
	if (!isRecord(input)) return undefined;

	const modelId = stringOrUndefined(input.modelId);
	if (modelId === undefined) return undefined;

	// A row added before the user has thought about what to call it takes the wire id as its name, which
	// is the same field they would have to fill in anyway.
	const name = stringOrUndefined(input.name) ?? stringOrUndefined(input.label) ?? modelId;
	if (isReserved(name)) return undefined;

	const baseUrl = stringOrUndefined(input.baseUrl);
	if (baseUrl === undefined) return undefined;

	// A level this app has no name for is dropped rather than stored: the file is hand-editable, and a
	// typo should leave the row on its own default instead of being carried around. A level the
	// *model* has no room for is a different question, and assembly settles it.
	const defaultThinkingLevel = thinkingLevelOr(input.defaultThinkingLevel);

	return {
		name,
		baseUrl,
		apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
		modelId,
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

/** `name/wire-id` — the ref the transcript records and a config patch names. */
export function modelRefOf(row: UserModel): string {
	return `${row.name}/${row.modelId}`;
}

/**
 * The row a ref came from: everything before the first slash.
 *
 * The name, not the wire id, is what a ref leads with, so this reads a name out of a ref without having
 * to know which rows exist. A wire id may itself contain slashes, which is why only the first one counts.
 */
export function rowNameFromRef(ref: string): string {
	const slash = ref.indexOf("/");
	return slash === -1 ? ref : ref.slice(0, slash);
}

// ---------------------------------------------------------------------------- one row as a model

/**
 * One row as the model a request is made with.
 *
 * The row's wire id becomes `Model.id` and the row's name becomes `Model.name` — and the name is
 * load-bearing rather than decorative, because it is what the session records in its transcript and what
 * a config patch names to get back to this row. The row's key rides along as `Model.apiKey`, so a
 * request carries its own credential instead of the loop looking one up by a name it was handed.
 *
 * That only works because the caller rebuilds this for every request: see `Agent.adoptCurrentRow`, which
 * re-derives the model from the live row rather than keeping one. A captured model would hold a
 * captured key.
 *
 * The level is the second half of the same idea: it rides on the model, so "which endpoint" and "how
 * hard" are one object a request is made with and there is nowhere else for a strength to come from.
 * Omitted leaves the model with no level at all, which the wire reads as "do not think" — that is what
 * a caller building a model for a job of its own wants, and what this returns when the row has no
 * default either. A named level is normalized against this model, so a level it has no room for lands
 * on one it does rather than on a value the endpoint rejects.
 */
export function modelFor(row: UserModel, thinkingLevel?: string): Model<Api> {
	// The per-model facts are derived from the wire id, because a hand-typed row has nothing else to
	// key them by. They are read only for a row that says it thinks: a row with `reasoning` off asks
	// for a request with no thinking parameters in it at all, and a level map would put one back.
	const compat = row.reasoning ? anthropicCompatFor(row.modelId) : undefined;
	const thinkingLevelMap = row.reasoning ? anthropicThinkingLevelMapFor(row.modelId) : undefined;
	const model: Model<Api> = {
		id: row.modelId,
		name: row.name,
		api: ANTHROPIC_MESSAGES_API,
		apiKey: row.apiKey,
		// Required and absolute: the transport reads the base URL off the model.
		baseUrl: row.baseUrl,
		reasoning: row.reasoning,
		input: ["text"],
		// Pricing is per million tokens and the user is not asked for it, so every rate is zero. The
		// cost the status bar would show is therefore always $0.00, which is the honest answer to
		// "what did this app measure" rather than a guess at someone's contract.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: row.contextWindow,
		maxTokens: row.maxTokens,
		...(compat === undefined ? {} : { compat }),
		...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
	};
	return thinkingLevel === undefined
		? model
		: { ...model, thinkingLevel: normalizeThinkingLevel(model, thinkingLevel) };
}

/**
 * The row behind a model, or undefined when there is none.
 *
 * A model carries its row's name, so this is the one lookup that turns "which model is this session on"
 * back into "which row is that". Undefined means the placeholder: a session with no row to send with.
 */
export function rowFor(models: ModelSource, model: { name: string }): UserModel | undefined {
	return models.list().find((row) => row.name === model.name);
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
export function placeholderModel(): Model<Api> {
	return {
		id: UNCONFIGURED_MODEL_ID,
		name: UNCONFIGURED_NAME,
		api: ANTHROPIC_MESSAGES_API,
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
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

/** Parse `name/wire-id`, or a bare wire id when exactly one row has it. */
export function resolveModelRef(rows: readonly UserModel[], ref: string): UserModel | undefined {
	const trimmed = ref.trim();
	if (trimmed.length === 0) return undefined;

	const slash = trimmed.indexOf("/");
	if (slash > 0) {
		const name = trimmed.slice(0, slash);
		const modelId = trimmed.slice(slash + 1);
		return rows.find((row) => row.name === name && row.modelId === modelId);
	}

	const matches = rows.filter((row) => row.modelId === trimmed);
	return matches.length === 1 ? matches[0] : undefined;
}

/** The rows, narrowed to what a client may see. The key itself never leaves the server. */
export function listModelOptions(models: readonly UserModel[]): ModelOption[] {
	return models.map((model) => {
		const built = modelFor(model);
		return {
			name: model.name,
			api: ANTHROPIC_MESSAGES_API,
			baseUrl: model.baseUrl,
			modelId: model.modelId,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			// The levels travelled with the row rather than being worked out by the client, which has no
			// way to know what an endpoint takes. A composer that moves the model needs the new row's own
			// list, and it needs it before the move is sent anywhere.
			thinkingLevels: [...getSupportedThinkingLevels(built)],
			defaultThinkingLevel: normalizeThinkingLevel(built, model.defaultThinkingLevel),
			hasApiKey: model.apiKey.length > 0,
		};
	});
}

/** Every thinking level the model accepts, lowest first. A model that always thinks has no "off". */
export function thinkingLevelsFor(model: Model<Api>): string[] {
	return [...getSupportedThinkingLevels(model)];
}

/** Thinking levels a session can be in, matching pi-ai's scale. */
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";

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
