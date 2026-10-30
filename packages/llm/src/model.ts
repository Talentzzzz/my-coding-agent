// Not vendored: this file is ours. Upstream pi-ai has no model object that can send — it hands a
// `Model<Api>` record to a `stream()` function that dispatches on `api`. This build keeps the record
// as the same fields (`Model` still satisfies every signature upstream wrote against it) and gives it
// the one capability every caller immediately wanted: the request.
import { anthropicMessages } from "./api/anthropic-messages.ts";
import type {
	AnthropicMessagesCompat,
	Api,
	BaseModel,
	ChatTransport,
	KnownApi,
	LlmContext,
	ModelCost,
	ModelInputLimits,
	ModelPromptCache,
	ModelThinkingLevel,
	SimpleStreamOptions,
	ThinkingLevelMap,
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
	reasoning: boolean;
	/**
	 * The level a session opened on this row starts at, before anyone moves the composer.
	 *
	 * Held here rather than beside the config, because "a row" and "the default a row opens on" are
	 * one decision: a row that reasons has a level to start at, and a row that does not has nothing
	 * to say. It is not the level of any particular request — that is `Model.thinkingLevel`.
	 */
	defaultThinkingLevel?: ModelThinkingLevel;
	/** Defaults to the one protocol this build drives. */
	api?: TApi;
	input?: ("text" | "image")[];
	cost?: ModelCost;
	type?: "chat";
	inputLimits?: ModelInputLimits;
	headers?: Record<string, string>;
	thinkingLevelMap?: ThinkingLevelMap;
	thinkingLevel?: ModelThinkingLevel;
	promptCache?: ModelPromptCache;
	samplingParams?: Record<string, unknown>;
	compat?: AnthropicMessagesCompat;
}

/**
 * One model: the endpoint, the key that reaches it, the facts a request needs — and the request.
 *
 * Every field here is the record upstream's `Model<Api>` described, so anything written against that
 * shape still takes one of these unchanged. What is new is {@link Model.stream}: the object a request
 * is made *with* is now also the object that makes it, which removes the question of which transport
 * a given model belongs to — a model carries its own, and `stream()` is the only way out.
 *
 * A host that rebuilds its model per request (or reconfigures one in place) is the reason the fields
 * are writable rather than readonly: the model *is* a request's configuration, and a corrected key
 * has to reach the next request without a second kind of object to keep in step.
 */
export class Model<TApi extends Api = Api> implements BaseModel<TApi> {
	id!: string;
	name!: string;
	api!: TApi;
	apiKey?: string;
	baseUrl!: string;
	input!: ("text" | "image")[];
	inputLimits?: ModelInputLimits;
	cost!: ModelCost;
	headers?: Record<string, string>;
	type?: "chat";
	reasoning!: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	/**
	 * The level this model is asked at, when it reasons at all.
	 *
	 * Carried here rather than passed beside the model, so "which endpoint" and "how hard" are one
	 * object. Absent means "do not think", which is the same request as `off`; a model whose map says
	 * `off: null` cannot be asked either way and is sent no switch at all.
	 */
	thinkingLevel?: ModelThinkingLevel;
	promptCache?: ModelPromptCache;
	contextWindow!: number;
	maxTokens!: number;
	samplingParams?: Record<string, unknown>;
	/** Compatibility overrides for Anthropic Messages-compatible APIs. */
	compat?: AnthropicMessagesCompat;

	/**
	 * The level a session opened on this model starts at.
	 *
	 * Copied from the config because the config *is* the row: a caller assembling a session reads it
	 * here rather than being handed the row a second time beside the model.
	 */
	defaultThinkingLevel?: ModelThinkingLevel;

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
		this.reconfigure(config);
	}

	/**
	 * Overwrite every field from another config, keeping the transport.
	 *
	 * All of it or none of it: a caller that copies three fields by hand is the caller that leaves
	 * `thinkingLevelMap` describing the model that used to be here. A field the config leaves out
	 * resets to its default rather than keeping the old value, which is the same promise one step
	 * further in — a row edited to stop reasoning must not keep the level table it used to justify.
	 */
	reconfigure(config: ModelConfig<TApi>): void {
		this.id = config.id;
		this.name = config.name;
		this.api = config.api ?? (DEFAULT_API as TApi);
		this.baseUrl = config.baseUrl;
		this.apiKey = config.apiKey;
		this.input = [...(config.input ?? DEFAULT_INPUT)];
		this.inputLimits = config.inputLimits;
		this.cost = { ...(config.cost ?? ZERO_COST) };
		this.headers = config.headers;
		this.type = config.type;
		this.reasoning = config.reasoning;
		this.thinkingLevelMap = config.thinkingLevelMap;
		this.thinkingLevel = config.thinkingLevel;
		this.promptCache = config.promptCache;
		this.contextWindow = config.contextWindow;
		this.maxTokens = config.maxTokens;
		this.samplingParams = config.samplingParams;
		this.compat = config.compat;
		this.defaultThinkingLevel = config.defaultThinkingLevel;
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
