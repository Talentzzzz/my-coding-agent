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
} from "./llm/index.ts";
import { anthropicCompatFor } from "./anthropic-models.ts";
import { AGENT_HOME } from "./config.ts";
import type { ModelOption } from "./protocol.ts";

/** 类本身，让只想要「一个模型」的调用方不必伸手进传输层包。 */
export { Model } from "./llm/index.ts";

/** 一行写下来时的形状，转发出去让调用方不必点名它所在的包。 */
export type { ModelConfig } from "./llm/index.ts";

/**
 * 本安装所运行的模型，以人写下的 config 形式。
 *
 * 没有内置目录。pi-ai 自带一份，有意不用：哪些端点存在、各自多少钱、上下文多大，这些事付账单的人
 * 比编译进依赖的清单更清楚。pi-ai 仍然被用的是模型确定*之后*的一切——组装请求、流式返回、重试
 * 分类、思考档位——那才是值得不自己写的部分。
 *
 * 上游 pi-ai 经一个 provider registry 路由：provider 拥有密钥、base URL 和一组模型；当一台宿主要用
 * 几种凭据形态说几种 API 时，那个 registry 才有价值，而这里两者都不需要。一行*就是*「一个端点、
 * 一把密钥」，所以 registry 只是每行一条、内容仅剩行里已有的一个字符串。它被删了，密钥直接从行
 * 走到请求。
 *
 * 一行*就是*一个 {@link ModelConfig}，本文件不再为它保留第二种形状。曾经有两个：`UserModel`，人
 * 敲下的稀疏事实；`ModelInit`，请求所需的完整字段表，中间靠 `modelInitFor()` 翻译。那段翻译是单向
 * 的、不持状态、只活在一层调用栈里——这是拆分没有在干活的信号。有差异的字段是本构建的常量：
 * `api` 只能是一个字符串，`input` 只能是文本，`cost` 未计量。常量该作为构造模型处的默认值存在，
 * 而不是上一层的一张映射。所以现在只有一个形状，由用它构造模型的包拥有，存储文件已经是这个形状。
 *
 * 两样东西留在这里而不是搬进 `Model`：一个 wire id 对应哪些 compat 标志与思考档位，因为
 * `anthropic-models.ts` 是关于端点的知识而不是关于传输层的；以及「什么才允许被存下来」的规则
 * （{@link coerceModelConfig}），因为来自窗口或文本编辑器的 config 还不是本应用愿意发送的 config。
 */

/** 新行起步的默认值，让表单永远不出现空的数字字段。 */
export const NEW_MODEL_DEFAULTS = {
	contextWindow: 200_000,
	maxTokens: 8_192,
};

/**
 * 没有更具体的指名时，会话打开所在的那一行。
 *
 * 有意硬编码。装配曾用「用户写的第一行」来回答这个问题，那是个只在第一行恰好是用户想要的那行时
 * 才显得像答案的猜测：被修复脚本或 smoke 重写的 `models.json` 会悄悄挪动默认值，而存储的偏好指向
 * 一行已被删除的模型时又会挪一次。在这里点名模型，意味着凡是没有被谁推翻的会话都打开在
 * `deepseek-flash` 上，无论文件是什么顺序。
 *
 * 这是*默认*，不是覆盖：`settings.model` 仍为新会话指名，输入框仍能在窗口里挪动会话。机器一行都
 * 没有时，客户端种下的也是这个名字——见 `packages/web/src/default-model.ts` 的 `DEFAULT_MODEL`，
 * 那边重述一遍字面量，因为那个模块为浏览器打包，而这个跑在 Node 上。
 */
export const DEFAULT_MODEL_NAME = "deepseek-flash";

/** 模型行所在之处。一个文件，与设置、会话放在一起。 */
export function modelsPath(agentDir: string = AGENT_HOME): string {
	return join(agentDir, "models.json");
}

/**
 * 用户的模型，读写于一个 JSON 文件。
 *
 * 每次 {@link list} 都重读而不是缓存，因为文件又小又可手编：用编辑器加了一行的人不该为了看见它而
 * 重启应用，缓存会把显然的行为变成令人惊讶的行为。
 */
export class ModelConfigStore {
	private readonly absFile: string;

	private constructor(absFile: string) {
		this.absFile = absFile;
	}

	static create(agentDir: string = AGENT_HOME): ModelConfigStore {
		return new ModelConfigStore(modelsPath(agentDir));
	}

	/** 已存的 config，按写入顺序。文件缺失或读不了就是没有行。 */
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

	/** 替换全部行。整表写入正是名字与文件不漂移的原因。 */
	replace(models: readonly ModelConfig[]): void {
		mkdirSync(dirname(this.absFile), { recursive: true });
		writeFileSync(this.absFile, `${JSON.stringify({ models }, null, "\t")}\n`, "utf8");
	}
}

/**
 * 占位模型的名字，有意避开所有用户行。
 *
 * 名字如今是一行的全部身份，所以靠它拦住用户自己的行被误认成「未配置」。{@link coerceModelConfig}
 * 直接拒绝它，因为另一种做法——悄悄换个名字存下来——意味着设置面板显示一个用户没敲过的名字。
 */
const UNCONFIGURED_NAME = "my-agent:unconfigured";
const UNCONFIGURED_MODEL_ID = "no-model";

/**
 * 占位模型作答所用的字段表，也是无名选择回落到的那一份。
 *
 * 端点有意指向无处：对它的请求从不发出，因为传输层会在任何东西发出之前替占位模型作答。窗口是一
 * 个真实数字，让 usage 读数有可对照的量。
 */
const PLACEHOLDER_CONFIG: ModelConfig = {
	id: UNCONFIGURED_MODEL_ID,
	name: UNCONFIGURED_NAME,
	baseUrl: "http://127.0.0.1:1/v1",
	contextWindow: NEW_MODEL_DEFAULTS.contextWindow,
	maxTokens: NEW_MODEL_DEFAULTS.maxTokens,
};

/** 一个名字是否属于占位模型，而不是用户可能输入的某一行。 */
function isReserved(name: string): boolean {
	return name === UNCONFIGURED_NAME;
}

/**
 * 把一行进来的数据变成可存储的一行，做不到时返回 undefined。
 *
 * 这里不给名字做唯一化：名字*就是*行的身份，悄悄给重复名加后缀会改变每份提及它的 transcript 的
 * 含义。冲突如何裁决由调用方决定——设置面板拒绝整份列表并明说——这里只拒绝根本无法存储的：
 * 保留名、缺 model id、缺 base URL。
 *
 * `label` 作为名字读取，服务于名字成为身份之前写下的行，升级时保住的是用户选过的名字，而不是
 * 他们从未见过的 slug。代价是旧 ref——它们由那些 slug 构成：按旧 ref 记录的会话打开时没有模型，
 * 并提示选一个。这与重命名或删除结的是同一笔账，一次付清，好过永远留一块满是 slug 的面板。
 */
export function coerceModelConfig(input: unknown): ModelConfig | undefined {
	if (!isRecord(input)) return undefined;

	// `id` 是这个字段如今的名字。在 config 变成行之前写下的每个文件都把它记作 `modelId`，所以两个
	// 都读：升级保住已有的端点，而不是清空用户手工录入的模型列表。
	const id = stringOrUndefined(input.id) ?? stringOrUndefined(input.modelId);
	if (id === undefined) return undefined;

	// 用户还没想好叫什么时添加的 config，拿 wire id 当名字——反正那个字段他们横竖要填。
	const name = stringOrUndefined(input.name) ?? stringOrUndefined(input.label) ?? id;
	if (isReserved(name)) return undefined;

	const baseUrl = stringOrUndefined(input.baseUrl);
	if (baseUrl === undefined) return undefined;

	// 只复制人能有意义指名的字段。`api`、`input`、`cost` 是本构建的常量，不从可能另有所称的文件里
	// 读回——与提交的 config 无权挑选自己的传输层是同一个道理。
	return {
		id,
		name,
		baseUrl,
		apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
		contextWindow: positiveInt(input.contextWindow, NEW_MODEL_DEFAULTS.contextWindow),
		maxTokens: positiveInt(input.maxTokens, NEW_MODEL_DEFAULTS.maxTokens),
	};
}

// ---------------------------------------------------------------------------- 一份 config 成为一个模型

/**
 * 补上 wire id 所隐含事实之后的 config。
 *
 * `compat` 是人不可能知道、也不该被问的那件事：它描述 id 背后的端点，那张表住在
 * `anthropic-models.ts`。
 *
 * 这里不添加别的。config 从不指名的常量——`api`、`input`、`cost`——在 `Model` 的构造函数里补
 * 默认值，那是知道它们可能是什么的包。这个函数是「人写了什么」与「请求需要什么」之间仅剩的翻译，
 * 它存在的原因是应用层知识无法跟着常量走进传输层。
 */
function withCapabilities(config: ModelConfig): ModelConfig {
	const compat = config.compat ?? anthropicCompatFor(config.id);
	return compat === undefined ? config : { ...config, compat };
}

/**
 * 一份 config，作为发起请求所用的模型。
 *
 * 档位是同一想法的另一半：它骑在模型上，「哪个端点」与「多用力」是发起请求的同一个对象，强度再
 * 无别处可来。在这里规范化，应用叫不出名字的字符串落到 "off"，而不是落到端点会拒绝的值上。省略
 * 则让模型完全没有档位，wire 读作「不思考」——这正是为自己的差事造模型的调用方想要的。
 *
 * `transport` 是这个模型的发送方式。省略时用本包唯一的传输层；会话传入自己的，重试策略与「这个
 * 模型背后没有行」的答案都住在那里。
 */
export function createModel(config: ModelConfig, thinkingLevel?: string, transport?: ChatTransport): Model {
	const model = new Model(withCapabilities(config), transport);
	if (thinkingLevel !== undefined) model.thinkingLevel = normalizeThinkingLevel(thinkingLevel);
	return model;
}

/**
 * 用户一行都没输入时，会话运行所用的模型。
 *
 * 会话横竖得用*某个*模型构建，否则窗口开不到能告诉别人缺了什么的地方：失败必须以 transcript 里
 * 一条消息的形态抵达——在那里才能描述怎么修——而不是以一台拒绝服务会话的服务器的形态。所以这
 * 是一个真实存在但其行不存在的模型，替它作答的是 {@link unconfiguredStream}。它的名字是那个保留名，
 * {@link isUnconfigured} 测的就是它，任何存储行都不得占用。
 */
export function placeholderModel(transport?: ChatTransport): Model {
	return createModel(PLACEHOLDER_CONFIG, undefined, transport);
}

/** 一个模型是否是占位模型，而不是用户输入的东西。 */
export function isUnconfigured(model: { name: string }): boolean {
	return model.name === UNCONFIGURED_NAME;
}

// ---------------------------------------------------------------------------- 无状态门面

/**
 * 会话运行在什么之上：行的名字，以及被要求多用力。
 *
 * 这是会话模型状态的全部，有意别无其他。请求在此之外需要的一切——端点、密钥、窗口、compat 标志
 * ——属于名字指向的那一行，在构造模型的时刻从目录现读（{@link modelFor}），从不复制进来。副本
 * 是第二件要跟着文件编辑保持同步的东西；名字不是。
 *
 * 形状与输入框自己的（{@link ModelSelection}）相同，字段按其本相命名：wire 叫它 `model`，因为
 * 窗口是在从列表里挑一个名字，而包内的一切都按名字称呼行。
 */
export type ModelChoice = {
	/** 行的名字——面板显示、transcript 记录的身份。 */
	name?: string;
	/**
	 * 档位按到达时的原样保存。{@link modelFor} 会规范化它，所以应用叫不出名字的字符串在被问到的
	 * 时刻已落在 "off" 上。undefined 表示没有被要求过，wire 读作「不思考」。
	 */
	thinkingLevel?: string;
};

/** 选择所点名的行，没有行应答时为 undefined。 */
export function rowFor(choice: ModelChoice, catalog: readonly ModelConfig[]): ModelConfig | undefined {
	return catalog.find((candidate) => candidate.name === choice.name);
}

/**
 * 一个选择所点名的模型：在目录里现查、现建、只用于一次请求、用完即丢。
 *
 * 查找按名字——行的名字是它的身份——且在这里、每次构造时进行，而不是提前铺进选择里。这正是让
 * 一把修正的密钥、一个挪走的端点、一个改过的窗口无需任何失效步骤、无需任何同步就抵达下一次请求
 * 的原因：没有副本会变陈旧。
 *
 * 没有行应答的名字不抛错。会话横竖要能构建——快照、usage 表、失败消息都需要一个良构的模型——
 * 所以这里以占位模型的事实、按被要求的名字作答，而传输层自己的「这个模型背后没有行」检查
 * （{@link unconfiguredStream}）才是拒绝发送的东西。档位在 `createModel` 里规范化，应用叫不出名字
 * 的字符串落在 "off"，而不是端点会拒绝的值上。
 */
export function modelFor(choice: ModelChoice, catalog: readonly ModelConfig[], transport?: ChatTransport): Model {
	const row = rowFor(choice, catalog);
	if (row !== undefined) return createModel(row, choice.thinkingLevel, transport);
	// 保留被选的名字而不是替换掉：窗口看着一个行被删掉的会话时，该说的是它失去了哪个模型，
	// 而不是它没有模型。
	const placeholder: ModelConfig =
		choice.name === undefined ? PLACEHOLDER_CONFIG : { ...PLACEHOLDER_CONFIG, name: choice.name };
	return createModel(placeholder, choice.thinkingLevel, transport);
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
 * 会自己解释的答案。
 *
 * 手写而成，因为没有请求可发：无行会话的全部意义，就是在用户正盯着看的 transcript 里，以一句
 * 用户能照着行动的话失败。它的形状与任何传输层的流一致，引擎读它如同读一次真实的失败。
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
	// 异步推送，让在流结束之前就挂上来的调用方——引擎正是——能像看到传输层的失败那样看到它。
	queueMicrotask(() => {
		stream.push({ type: "error", reason: "error", error: message });
		stream.end();
	});
	return stream;
}

// ---------------------------------------------------------------------------- 查找

/** 各行收窄成客户端可见的样子。密钥本身永不离开服务器。 */
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
			// 档位随行一起走，让要挪模型的输入框在挪动抵达服务器之前就拿到列表。每一行都是同样四个；
			// 字段保留是因为无论行是存储的、种下的还是会话报告的，输入框读的都是同一个形状。
			thinkingLevels: [...getSupportedThinkingLevels()],
			hasApiKey: (config.apiKey ?? "").length > 0,
		};
	});
}

/** 会话可能处于的每个思考档位，从低到高。 */
export function thinkingLevelsFor(): string[] {
	return [...getSupportedThinkingLevels()];
}

/**
 * 会话可能处于的思考档位。
 *
 * 阶梯是传输层的，转发出去让包内调用方不必为了拼一个档位伸手去 `./llm/index.ts`——转发而不是
 * 重述，因为四个字符串字面量手写两份，正是本文件刚用一个类型消灭的漂移。
 */
export type ThinkingLevel = LlmThinkingLevel;

/**
 * 把被要求的档位变成本应用能记录的档位。
 *
 * 集合对每个模型都一样——effort 是 wire 携带的唯一强度——所以这是名字检查，不是钳制：应用叫不出
 * 名字的字符串，与什么都没要求的调用方，都落在 "off"。这是对「没有被要求」的诚实回答，并且在
 * wire 上把这一点说出来的是请求本身。
 */
export function normalizeThinkingLevel(level: string | undefined): ThinkingLevel {
	const allowed = getSupportedThinkingLevels();
	return allowed.includes(level as LlmThinkingLevel) ? (level as ThinkingLevel) : "off";
}

// ---------------------------------------------------------------------------- 解析

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
