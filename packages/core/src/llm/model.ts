// Not vendored: this file is ours. Upstream pi-ai has no model object that can send — it hands a
// `Model<Api>` record to a `stream()` function that dispatches on `api`. This build keeps the record
// as the same fields (`Model` still satisfies every signature upstream wrote against it) and gives it
// the one capability every caller immediately wanted: the request.
import { anthropicMessages } from "./api/anthropic-messages.ts";
import type {
	AnthropicMessagesCompat,
	Api,
	ChatTransport,
	KnownApi,
	LlmContext,
	ModelCost,
	ModelInputLimits,
	ModelPromptCache,
	ThinkingLevel,
	SimpleStreamOptions,
} from "./types.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

/** The one protocol this build speaks, and the value an unnamed `api` means. */
const DEFAULT_API: KnownApi = "anthropic-messages";

/** What a model takes when its config does not say: text, because that is what this app sends. */
const DEFAULT_INPUT: ("text" | "image")[] = ["text"];

/** No measured spend. Rates are per million tokens; a config that names none claims none. */
const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * One model, as a value: the endpoint, the key that reaches it, and the facts a request needs.
 *
 * This is the only shape a model is written down in. A `models.json` row is one of these, the settings
 * panel edits one of these, and {@link Model} is constructed from one of these — there is no second
 * "stored" form that a translation step turns into this one. A config is therefore complete in the
 * only sense that matters: constructed from it, a model sends exactly one kind of request.
 *
 * The fields a config rarely names — `api`, `input`, `cost`, and the rest below — carry defaults
 * rather than being required, because for this build they can only mean one thing and asking a user
 * to type `"anthropic-messages"` on every row is asking them to transcribe a constant. A config that
 * names none of them still means "an Anthropic-Messages endpoint that takes text and costs nothing
 * measured", which is the honest description of what this app can drive.
 */
export interface ModelConfig<TApi extends Api = Api> {
	/** The wire id the endpoint knows this model by. */
	id: string;
	/** The row's identity as well as its label: what a transcript records and a config patch names. */
	name: string;
	baseUrl: string;
	apiKey?: string;
	contextWindow: number;
	maxTokens: number;
	/** Defaults to the one protocol this build drives. */
	api?: TApi;
	input?: ("text" | "image")[];
	cost?: ModelCost;
	inputLimits?: ModelInputLimits;
	headers?: Record<string, string>;
	thinkingLevel?: ThinkingLevel;
	promptCache?: ModelPromptCache;
	samplingParams?: Record<string, unknown>;
	compat?: AnthropicMessagesCompat;
}

/**
 * Every field a config decides, with the defaults this build can supply.
 *
 * Written once because the defaults are the interesting part — a config that names no `cost` costs
 * nothing measured, and that is a rule two copies would eventually disagree about. The constructor
 * copies this object onto the instance field by field, which is what lets each declaration be a plain
 * `id: string` instead of `id!: string`: tsc only believes an assignment it can see in the
 * constructor body, and a field added here but forgotten there is an error rather than a silent
 * `undefined`.
 */
function fieldsFrom<TApi extends Api>(config: ModelConfig<TApi>) {
	return {
		id: config.id,
		name: config.name,
		api: config.api ?? (DEFAULT_API as TApi),
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		input: [...(config.input ?? DEFAULT_INPUT)],
		inputLimits: config.inputLimits,
		cost: { ...(config.cost ?? ZERO_COST) },
		headers: config.headers,
		thinkingLevel: config.thinkingLevel,
		promptCache: config.promptCache,
		contextWindow: config.contextWindow,
		maxTokens: config.maxTokens,
		samplingParams: config.samplingParams,
		compat: config.compat,
	};
}

/**
 * One model: the endpoint, the key that reaches it, the facts a request needs — and the request.
 *
 * Every field here is the record upstream's `Model<Api>` described, so anything written against that
 * shape still takes one of these unchanged. What is new is {@link Model.stream}: the object a request
 * is made *with* is now also the object that makes it, which removes the question of which transport
 * a given model belongs to — a model carries its own, and `stream()` is the only way out.
 *
 * A host that rebuilds its model per request is the reason the fields are writable rather than
 * readonly: the model *is* a request's configuration, and building it fresh per request keeps a
 * corrected key two lines away from the request that needs it.
 */
export class Model<TApi extends Api = Api> {
	id: string;
	name: string;
	api: TApi;
	apiKey?: string;
	baseUrl: string;
	input: ("text" | "image")[];
	inputLimits?: ModelInputLimits;
	cost: ModelCost;
	headers?: Record<string, string>;
	/**
	 * The level this model is asked at.
	 *
	 * Carried here rather than passed beside the model, so "which endpoint" and "how hard" are one
	 * object. Absent means "do not think", which is the same request as `off`.
	 */
	thinkingLevel?: ThinkingLevel;
	promptCache?: ModelPromptCache;
	contextWindow: number;
	maxTokens: number;
	samplingParams?: Record<string, unknown>;
	/** Compatibility overrides for Anthropic Messages-compatible APIs. */
	compat?: AnthropicMessagesCompat;

	/**
	 * How this model is sent.
	 *
	 * Settable rather than fixed, because the host that assembles a session installs its own — the
	 * retry policy and the "no row behind this model" answer both belong around the transport, and
	 * they are the host's, not this package's. Everything else treats it as read-only.
	 */
	transport: ChatTransport;

	constructor(config: ModelConfig<TApi>, transport: ChatTransport = anthropicMessages) {
		this.transport = transport;
		// Spelled out one field at a time because these are the assignments tsc has to be able to see:
		// a declaration here carries no `!`, so a field missing from this list is a compile error.
		const f = fieldsFrom(config);
		this.id = f.id;
		this.name = f.name;
		this.api = f.api;
		this.baseUrl = f.baseUrl;
		this.apiKey = f.apiKey;
		this.input = f.input;
		this.inputLimits = f.inputLimits;
		this.cost = f.cost;
		this.headers = f.headers;
		this.thinkingLevel = f.thinkingLevel;
		this.promptCache = f.promptCache;
		this.contextWindow = f.contextWindow;
		this.maxTokens = f.maxTokens;
		this.samplingParams = f.samplingParams;
		this.compat = f.compat;
	}

	/**
	 * Send one request over this model's transport.
	 *
	 * The signature is the transport's own, minus the model: it is already here. A caller that wants
	 * the retry policy or a scripted answer replaces {@link Model.transport} rather than wrapping this
	 * method, so there is exactly one way a request leaves this object.
	 */
	stream(context: LlmContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
		return this.transport.stream(this, context, options);
	}
}
