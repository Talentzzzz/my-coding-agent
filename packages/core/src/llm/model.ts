// 不是 vendor 来的：这个文件是我们自己的。上游 pi-ai 没有能发送的 model 对象——它把一个
// `Model<Api>` record 交给一个按 `api` 分发的 `stream()` 函数。本构建保留 record 作为同样的字段
// （`Model` 仍然满足上游写过的每个签名），并给它每个调用方立刻都想要的那一个能力：请求本身。
import { anthropicMessages } from "./api/anthropic-messages.ts";
import type {
	AnthropicMessagesCompat,
	Api,
	ChatTransport,
	Context,
	KnownApi,
	ModelCost,
	ModelInputLimits,
	ModelPromptCache,
	ThinkingLevel,
	SimpleStreamOptions,
} from "./types.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

/** 本构建说的唯一协议，也是未指名 `api` 时的取值。 */
const DEFAULT_API: KnownApi = "anthropic-messages";

/** config 未说明时模型采用的输入：text，因为这是本应用发送的东西。 */
const DEFAULT_INPUT: ("text" | "image")[] = ["text"];

/** 无实测开销。费率按每百万 token 计；不指名费率的 config 即声明为零。 */
const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * 一个模型，作为一个值：端点、到达它的 key、以及一次请求需要的事实。
 *
 * 这是模型被写下的唯一形状。`models.json` 的一行是它，设置面板编辑的是它，{@link Model} 也是从它
 * 构建的——不存在第二种「存储形态」需要某个翻译步骤转换成它。因此一个 config 在唯一重要的意义上
 * 是完整的：由它构建的模型恰好发出一种请求。
 *
 * config 很少指名的字段——`api`、`input`、`cost` 和下面的其余——带默认值而不是必填，因为对本构建
 * 它们只能意味着一件事，让用户在每一行上输入 `"anthropic-messages"` 是让他们抄写一个常量。什么
 * 都不指名的 config 仍然意味着「一个接受 text、实测开销为零的 Anthropic-Messages 端点」，这正是
 * 本应用能驱动的那个东西的诚实描述。
 */
export interface ModelConfig<TApi extends Api = Api> {
	/** 端点认识这个模型的 wire id。 */
	id: string;
	/** 这一行的身份兼标签：transcript 记录的、配置补丁指名的东西。 */
	name: string;
	baseUrl: string;
	apiKey?: string;
	contextWindow: number;
	maxTokens: number;
	/** 默认为本构建驱动的唯一协议。 */
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
 * config 决定的每个字段，连同本构建能提供的默认值。
 *
 * 一次写出是因为默认值才是有意思的部分——不指名 `cost` 的 config 实测开销为零，而这是一条两份
 * 副本最终会不一致的规则。构造函数把这个对象逐字段拷到实例上，这让每个声明可以是普通的
 * `id: string` 而不是 `id!: string`：tsc 只相信它能在构造函数体内看见的赋值，这里加了字段却在
 * 那里漏掉的是编译错误，而不是无声的 `undefined`。
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
 * 一个模型：端点、到达它的 key、一次请求需要的事实——以及请求本身。
 *
 * 这里的每个字段都是上游 `Model<Api>` record 描述的那个，所以针对那个形状写的一切仍然原样接受
 * 其一。新东西是 {@link Model.stream}：请求*用*的对象现在也是*发出*请求的对象，这消除了「某个模型
 * 属于哪个传输」的问题——模型自带它的传输，`stream()` 是唯一的出口。
 *
 * 每个请求重建自己模型的 host，是字段可写而不是 readonly 的原因：模型*就是*一次请求的配置，每个
 * 请求现建一个，让修正过的 key 离需要它的请求只差两行。
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
	 * 请求这个模型时的 level。
	 *
	 * 放在这里而不是模型旁边另传，所以「哪个端点」和「多用力想」是一个对象。缺席即「不要思考」，
	 * 与 `off` 是同一个请求。
	 */
	thinkingLevel?: ThinkingLevel;
	promptCache?: ModelPromptCache;
	contextWindow: number;
	maxTokens: number;
	samplingParams?: Record<string, unknown>;
	/** Anthropic Messages 兼容 API 的兼容性覆盖。 */
	compat?: AnthropicMessagesCompat;

	/**
	 * 这个模型如何被发送。
	 *
	 * 可设置而不是固定，因为装配 session 的 host 会安装自己的——重试策略和「这个模型背后没有行」的
	 * 回答都属于传输的周围，它们是 host 的，不是这个包的。其他一切把它当只读。
	 */
	transport: ChatTransport;

	constructor(config: ModelConfig<TApi>, transport: ChatTransport = anthropicMessages) {
		this.transport = transport;
		// 逐字段写出，因为这些是 tsc 必须能看见的赋值：这里的声明不带 `!`，所以这个清单里缺一个
		// 字段就是编译错误。
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
	 * 经这个模型自己的传输发送一次请求。
	 *
	 * 签名就是传输自己的，减去模型：模型已经在这里了。想要重试策略或脚本化答案的调用方替换
	 * {@link Model.transport} 而不是包装这个方法，所以请求离开这个对象的方式恰好只有一种。
	 */
	stream(context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		return this.transport.stream(this, context, options);
	}
}
