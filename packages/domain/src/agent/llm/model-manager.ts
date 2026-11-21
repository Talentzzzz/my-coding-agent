import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type ChatTransport,
	createAssistantMessageEventStream,
	Model,
	type ModelConfig,
	type ThinkingLevel,
} from "./index.ts";
import { AGENT_HOME, DEFAULT_GLOBAL_SETTINGS, settingsPath, type RetrySettings } from "../types.ts";

/** 类本身，让只想要「一个模型」的调用方不必伸手进传输层包。 */
export { Model };

/** 一行写下来时的形状，转发出去让调用方不必点名它所在的包。 */
export type { ModelConfig };

/**
 * 用户输入的一个模型，以客户端看到的样子。
 *
 * API 密钥有意缺席——客户端可以添加或替换一把，但永远不会被回发一把，所以密钥无法经由仅仅渲染
 * 列表的页面泄露。表单显示的是 `hasApiKey`，让「存了密钥」与「这一行没有密钥」保持可区分。
 *
 * `name` 是行的身份，所以既是面板显示的，也是客户端指名这一行时回发的。`api` 是为会话记录而
 * 报告的，且永远是同一个值：本应用只说一种传输层，所以它是关于构建的事实，不是表单编辑的字段。
 */
export interface ModelOption {
	/** wire id，也是提交 config 时指名该模型所用的字段。 */
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	contextWindow: number;
	maxTokens: number;
	/**
	 * 该行上的会话可能处于的每个档位，从低到高。
	 *
	 * 每行都是同样四个——effort 是 wire 携带的唯一强度——但报告出来而不是假定出来，这样无论行是
	 * 存储的、本地种下的还是会话快照描述的，输入框读的都是同一个形状。
	 */
	thinkingLevels: string[];
	hasApiKey: boolean;
}

/**
 * 一行被客户端提交时的样子。
 *
 * 每个字段都可选，这正是它与 {@link ModelConfig} 的全部差别：省略的字段让已存的值原地不动，这才让
 * 「补丁」（这一行的密钥是新的）成为可表达的东西——整份 config 得把行里已有的每条事实重述一遍。
 * 形状是派生的而不是重述的，所以加进 config 的字段客户端就能发，不在这份列表里的（`api`、`input`、
 * `cost`）就不能。
 */
export type ModelInput = Partial<
	Pick<ModelConfig, "id" | "name" | "baseUrl" | "apiKey" | "contextWindow" | "maxTokens">
>;

/**
 * 哪个模型回答一条消息，以及被要求多用力地思考。
 *
 * 它随消息一起走，而不是作为会话自己的命令，因为两半在被请求真正使用之前都不为真：从未被用过的
 * 选择不是发生过的事，所以它不是会话记录的条目，也不是配置变更。缺失的字段让那一半保持会话
 * 已有的样子。
 */
export interface ModelSelection {
	/** 行的名字——设置面板显示、会话记录记录的身份。 */
	model?: string;
	thinkingLevel?: string;
}

/**
 * 本安装能驱动的每个模型被请求的 level，从低到高。
 *
 * 这个列表是常量，因为答案不依赖模型：effort 是这条 wire 携带的唯一强度，每个 Anthropic-Messages
 * 端点都接受这三档，不能思考的模型就停在 `off`。它就是 `ThinkingLevel` 指名的那个列表，也是
 * composer 渲染的那个。曾独自占着传输层的 `llm/models.ts`——上游是 provider 注册表，裁剪后整个
 * 文件只剩这一件事——搬进这里归位：档位表与模型行同住模型簇的持有者。
 */
const SUPPORTED_THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "high", "max"];

/** session 可以处于的所有 thinking level，从低到高。 */
export function getSupportedThinkingLevels(): ThinkingLevel[] {
	return [...SUPPORTED_THINKING_LEVELS];
}

/**
 * 模型簇的持有者：目录里的行、默认指向的行、「内置默认已种下」的标记，以及重试策略。一并住着
 * 这些行成为的一切——可存储的形状、发起请求的模型、无行时的占位与自述失败、选择的窄形状与
 * 客户端视图（原 `models.ts`，2026-11-20 并入；档位表更早随 `llm/models.ts` 的删除搬来）。
 *
 * 设置归属重构（ADR-0028）把前三样交给模型自己：它们原本住在两份
 * 文件里——行在 `models.json`，另两样在旧 `settings.json`——现在同住 `models.json` 的两个可选键
 * （`defaultModel`、`defaultModelSeeded`），旧文件缺键即「未设置」，天然向后兼容。
 *
 * 重试（`retry`）同住这份文件（ADR-0028 修正，2026-11-20）：它描述的是「模型调用失败后怎么重试」，
 * 唯一合理的家就是模型簇自己的持有者。原 `EngineSettings`（`engine.json`）随迁退场——迁移按
 * 「键」走：`models.json` 缺 `retry` 键时，先从 `engine.json` 捡（旧持有者的文件，只作迁移源），
 * 再从旧 `settings.json` 捡；键已在则两份旧文件都被忽略。旧文件永不删除、永不写入。
 *
 * 与其他持有者同形：无状态门面、每次现读（ADR-0013 的既定模式）——文件又小又可手编，用编辑器
 * 改了什么的人下一次调用就得到答案，没有需要失效的东西。文件读写直接内联，不引入存储抽象。
 */
export class ModelManager {
	private readonly home: string;

	/** `home` 是 `models.json` 所在的目录；递别的 home 是让测试指到无害的地方。 */
	constructor(options: ModelManagerOptions = {}) {
		this.home = options.home ?? AGENT_HOME;
	}

	/**
	 * 本安装运行的模型行，每次调用都从文件读取。
	 *
	 * 行走 {@link coerceModelConfig} 规范化——来自文件或文本编辑器的条目还不是本应用愿意发送的
	 * config，读不回来的行被丢。缺文件 = 空目录。
	 */
	catalog(): readonly ModelConfig[] {
		const disk = this.load();
		const entries = Array.isArray(disk.models) ? disk.models : [];
		const rows: ModelConfig[] = [];
		for (const entry of entries) {
			const config = coerceModelConfig(entry);
			if (config !== undefined) rows.push(config);
		}
		return rows;
	}

	/**
	 * 替换全部行。整表写入正是名字与文件不漂移的原因。
	 *
	 * 行之外的一切——两个新键与未知键——取自写前重读的文件，原样保留。
	 */
	replaceRows(rows: readonly ModelConfig[]): void {
		const disk = this.load();
		disk.models = rows;
		this.persist(disk);
	}

	/**
	 * 新会话默认打开在哪一行：`name`，或 `<name>/<model-id>` ref。
	 *
	 * 非空字符串才算设置——与旧 `settings.json` 上 `model` 字段同一条 `stringOrUndefined` 规则，
	 * 手编文件里的空白值读作「未设置」而不是一颗哑弹。
	 */
	defaultRef(): string | undefined {
		return this.modelSettings().defaultModel;
	}

	/**
	 * 默认模型侧补默认后的窄读视图：默认 ref 与种下标记。
	 *
	 * 门面的读模型（`Agent.settings()` 组装 `GlobalSettings` 形状的视图）从这里取这两样——与
	 * {@link applyModelSettings} 的补丁字段同形，磁盘键（`defaultModel`）不外露。可选字段按「未设置」
	 * 保持 undefined，与文件各自的缺席规则一致。
	 */
	modelSettings(): { defaultModel?: string; defaultModelSeeded?: boolean } {
		const disk = this.load();
		const view: { defaultModel?: string; defaultModelSeeded?: boolean } = {};
		const ref = disk.defaultModel;
		if (typeof ref === "string" && ref.trim().length > 0) view.defaultModel = ref.trim();
		if (typeof disk.defaultModelSeeded === "boolean") view.defaultModelSeeded = disk.defaultModelSeeded;
		return view;
	}

	/**
	 * 应用一次默认模型侧的部分变更，返回前写盘。
	 *
	 * 只有被点名的字段移动，所以改默认 ref 的补丁不碰种下标记——`false` 是「要求重新种回内置行」
	 * 的写法，必须能原样写下去，不得被读成缺席。写入只落在 `models.json` 上，行与未知键取自写前
	 * 重读的文件。
	 */
	applyModelSettings(patch: { model?: string; defaultModelSeeded?: boolean }): void {
		// 与今天 applySettings 相同的点名规则：值缺席的字段不是变更。
		const named = Object.entries(patch).filter(([, value]) => value !== undefined);
		if (named.length === 0) return;

		const disk = this.load();
		for (const [field, value] of named) {
			// 补丁沿用旧 `GlobalSettings` 的字段名（`model`），磁盘键是它搬进这张文件后的本名
			// （`defaultModel`）——wire 与 REST 面不因搬家而改口。
			disk[field === "model" ? "defaultModel" : field] = value;
		}
		this.persist(disk);
	}

	/**
	 * 供应商调用失败时的重试策略，补默认后的副本：改它不动任何东西。
	 *
	 * 读路径按 {@link retryOr} 补默认——`models.json` 缺 `retry` 键（或缺文件）读到的就是缺省视图。
	 */
	retrySettings(): RetrySettings {
		return retryOr(this.load().retry);
	}

	/**
	 * 应用一次重试策略的部分变更，返回前写盘。
	 *
	 * 写路径与 {@link applyModelSettings} 同一条纪律：写前重读（本类本就不持常驻袋）、只动被点名
	 * 的字段（`retry` 对象嵌套合并）、`retry` 里的未知键原样保留。写入只落在 `models.json` 的
	 * `retry` 键上，行与其余键取自写前重读的文件。
	 */
	applyRetry(patch: Partial<RetrySettings>): void {
		const named = Object.entries(patch).filter(([, value]) => value !== undefined);
		if (named.length === 0) return;
		const disk = this.load();
		disk.retry = mergeLayers(isRecord(disk.retry) ? disk.retry : {}, Object.fromEntries(named));
		this.persist(disk);
	}

	// ---------------------------------------------------------------------------- 读与迁移

	/**
	 * 文件此刻的内容：读 + 逐键迁移，本类一切方法的共同入口。
	 *
	 * 迁移按「键」裁决（`models.json` 今天就存在，不能整文件一刀切）：`defaultModel` 与
	 * `defaultModelSeeded` 各自检查——缺这个键、且旧 `settings.json` 带着对应字段（`model` /
	 * `defaultModelSeeded`），就从旧文件捡走、原子写回。`retry` 键同理，但旧持有者的 `engine.json`
	 * 优先于旧 `settings.json`（原 `EngineSettings` 首读时已把 retry 正式落盘过）。一旦键已在，
	 * 旧文件的对应字段被忽略；没有东西可捡时一个字节都不写，机器上没有 `models.json` 的现状保持
	 * 原样。旧文件本身永不删除、永不写入。
	 */
	private load(): Record<string, unknown> {
		const disk = readDisk(modelsPath(this.home));

		const legacy = readLegacySettings(this.home);
		let migrated = false;
		if (legacy !== undefined) {
			if (!("defaultModel" in disk)) {
				const ref = legacy.model;
				if (typeof ref === "string" && ref.trim().length > 0) {
					disk.defaultModel = ref.trim();
					migrated = true;
				}
			}
			if (!("defaultModelSeeded" in disk)) {
				// 两种取值都原样搬运：`false` 是手编文件要求重新种回内置行的写法，把它变成缺失会让
				// 这个请求无法表达。
				if (typeof legacy.defaultModelSeeded === "boolean") {
					disk.defaultModelSeeded = legacy.defaultModelSeeded;
					migrated = true;
				}
			}
		}

		// retry 的迁移源按优先级：engine.json（退场持有者的文件）→ 旧 settings.json。值原样搬运，
		// 规范化是读路径的事（retryOr）——「不重试」（maxRetries=0）这样的显式设置不得被读成缺席。
		if (!("retry" in disk)) {
			const engine = readDisk(enginePath(this.home));
			const source = isRecord(engine.retry) ? engine : legacy;
			if (source !== undefined && isRecord(source.retry)) {
				disk.retry = source.retry;
				migrated = true;
			}
		}

		if (migrated) {
			if (!("models" in disk)) disk.models = [];
			writeDisk(modelsPath(this.home), disk);
		}

		return disk;
	}

	// ---------------------------------------------------------------------------- 写路径

	/**
	 * 把整份内容写到文件上。
	 *
	 * 写前已重读（每个写方法都先过 {@link load}），所以进程运行期间的手编不被这里一次无关的变更
	 * 回滚——一次默认模型切换不得弄丢用户刚敲进文件的行。经同目录 temp + rename 落盘：读者要么
	 * 看到旧文件要么看到新文件，绝不会看到写到一半的。
	 */
	private persist(disk: Record<string, unknown>): void {
		if (!("models" in disk)) disk.models = [];
		writeDisk(modelsPath(this.home), disk);
	}
}

/** 调用方可指明模型簇住在哪个 home，把 {@link ModelManager} 指到机器自己的文件之外。 */
export interface ModelManagerOptions {
	/**
	 * `models.json` 读取与写入所在的 agent home。默认用真实的那一个。
	 *
	 * 递入自己模型行的 smoke 不得把它们留在机器的 `models.json` 里。
	 */
	home?: string;
}

// ---------------------------------------------------------------------------- 文件读写（内联）

/** 一份文件的 JSON 对象内容，按它写下的原样——未知键也在。缺的文件是一个空记录。 */
function readDisk(absPath: string): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(absPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}

	// trim 顺带去掉 UTF-8 BOM——Windows 编辑器会写它，而 `JSON.parse` 拒绝它。
	const trimmed = text.trim();
	if (trimmed === "") return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		throw new Error(`${absPath} is not valid JSON: ${(error as Error).message}`);
	}
	if (!isRecord(parsed)) throw new Error(`${absPath} must hold a JSON object`);
	return parsed;
}

/** temp + rename 的一次性落盘，目录不存在时先创建。 */
function writeDisk(absPath: string, disk: Record<string, unknown>): void {
	mkdirSync(dirname(absPath), { recursive: true });
	const absTemp = `${absPath}.${process.pid}.tmp`;
	const fd = openSync(absTemp, "wx");
	try {
		writeFileSync(fd, `${JSON.stringify(disk, null, "\t")}\n`);
	} finally {
		closeSync(fd);
	}
	renameSync(absTemp, absPath);
}

/**
 * 旧 `settings.json`，迁移的只读源头。
 *
 * 缺的文件、空文件、解析不了的文件、不是对象的文件，都返回 undefined——迁移跳过。旧文件被拒绝
 * 的那些建构在 ADR-0028 之前的统一门面读取上就会以异常显形，不该在这里以每读必炸的形态复活；而
 * 「永不删除」意味着一旦开始炸就永远炸下去。键值按消费方的规则各取所需：`model` 收非空字符串，
 * `defaultModelSeeded` 收布尔——两种取值都是值，`false` 不是缺席。
 */
function readLegacySettings(home: string): Record<string, unknown> | undefined {
	let text: string;
	try {
		text = readFileSync(settingsPath(home), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}

	const trimmed = text.trim();
	if (trimmed === "") return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	return isRecord(parsed) ? parsed : undefined;
}

/** `engine.json` 的位置——退场持有者的文件，只作 retry 的迁移源。 */
function enginePath(home: string): string {
	return join(home, "engine.json");
}

/**
 * 重试策略，逐字段落在默认值之上（ADR-0028 修正：规范化器随簇住在持有者文件里）。
 *
 * `maxRetries` 是唯一可以为零的计数——「不重试」是一个设置，不是缺值——所以按非负整数解析，
 * 而不用 {@link numberOr}。默认值留守 `types.ts` 的 `DEFAULT_GLOBAL_SETTINGS`。
 */
function retryOr(value: unknown): RetrySettings {
	const record = isRecord(value) ? value : {};
	return {
		enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_GLOBAL_SETTINGS.retry.enabled,
		maxRetries: countOr(record.maxRetries, DEFAULT_GLOBAL_SETTINGS.retry.maxRetries),
		baseDelayMs: numberOr(record.baseDelayMs, DEFAULT_GLOBAL_SETTINGS.retry.baseDelayMs),
		maxAgentDelayMs: numberOr(record.maxAgentDelayMs, DEFAULT_GLOBAL_SETTINGS.retry.maxAgentDelayMs),
	};
}

function countOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** 有限正数，否则回落。私有副本，刻意不与其他持有者共享抽象（ADR-0028：复制是买的保险）。 */
function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 补丁的嵌套对象逐键合并进已有的值，其余字段整体替换。 */
function mergeLayers(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const merged = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) continue;
		const inherited = merged[key];
		merged[key] = isRecord(inherited) && isRecord(value) ? mergeLayers(inherited, value) : value;
	}
	return merged;
}

// ---------------------------------------------------------------------------- 一行成为的一切（原 models.ts，2026-11-20 并入）

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
 * 一行*就是*一个 {@link ModelConfig}，这里不再为它保留第二种形状。曾经有两个：`UserModel`，人
 * 敲下的稀疏事实；`ModelInit`，请求所需的完整字段表，中间靠 `modelInitFor()` 翻译。那段翻译是单向
 * 的、不持状态、只活在一层调用栈里——这是拆分没有在干活的信号。有差异的字段是本构建的常量：
 * `api` 只能是一个字符串，`input` 只能是文本，`cost` 未计量。常量该作为构造模型处的默认值存在，
 * 而不是上一层的一张映射。所以现在只有一个形状，由用它构造模型的包拥有，存储文件已经是这个形状。
 *
 * 一样东西留在这里而不是搬进 `Model`：「什么才允许被存下来」的规则（{@link coerceModelConfig}），
 * 因为来自窗口或文本编辑器的 config 还不是本应用愿意发送的 config。
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

/** 模型行所在之处。一个文件，与设置、会话放在一起。读取与写入由 {@link ModelManager} 负责。 */
export function modelsPath(agentDir: string = AGENT_HOME): string {
	return join(agentDir, "models.json");
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
 * 这里不给名字做唯一化：名字*就是*行的身份，悄悄给重复名加后缀会改变每份提及它的会话记录的
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
 * 一份 config，作为发起请求所用的模型。
 *
 * 档位是同一想法的另一半：它骑在模型上，「哪个端点」与「多用力」是发起请求的同一个对象，强度再
 * 无别处可来。在这里规范化，应用叫不出名字的字符串落到 "off"，而不是落到端点会拒绝的值上。省略
 * 则让模型完全没有档位，wire 读作「不思考」——这正是为自己的差事造模型的调用方想要的。
 *
 * `transport` 是这个模型的发送方式。省略时用本包唯一的传输层；会话传入自己的，重试策略与「这个
 * 模型背后没有行」的答案都住在那里。
 */
export function createModel(config: ModelConfig, thinkingLevel?: string, chatTransport?: ChatTransport): Model {
	const model = new Model(config, chatTransport);
	if (thinkingLevel !== undefined) model.thinkingLevel = normalizeThinkingLevel(thinkingLevel);
	return model;
}

/**
 * 用户一行都没输入时，会话运行所用的模型。
 *
 * 会话横竖得用*某个*模型构建，否则窗口开不到能告诉别人缺了什么的地方：失败必须以会话记录里
 * 一条消息的形态抵达——在那里才能描述怎么修——而不是以一台拒绝服务会话的服务器的形态。所以这
 * 是一个真实存在但其行不存在的模型，替它作答的是 {@link unconfiguredStream}。它的名字是那个保留名，
 * {@link isUnconfigured} 测的就是它，任何存储行都不得占用。
 */
export function placeholderModel(chatTransport?: ChatTransport): Model {
	return createModel(PLACEHOLDER_CONFIG, undefined, chatTransport);
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
	/** 行的名字——面板显示、会话记录记录的身份。 */
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
 * 选择点名的行，没有行应答时以占位行的事实、按被选的名字作答。
 *
 * 从 `modelFor` 的查找半抽出，供组合的设置（`settings.ts` 的 `resolveSettings`）与它共用：没有行
 * 应答的名字不抛错——会话横竖要能构建，快照、usage 表、失败消息都需要一个良构的模型——占位行
 * 替它作答，而传输层自己的「这个模型背后没有行」检查（{@link unconfiguredStream}）才是拒绝发送的
 * 东西。保留被选的名字而不是替换掉：窗口看着一个行被删掉的会话时，该说的是它失去了哪个模型，
 * 而不是它没有模型。
 */
export function rowOrPlaceholder(choice: ModelChoice, catalog: readonly ModelConfig[]): ModelConfig {
	const row = rowFor(choice, catalog);
	if (row !== undefined) return row;
	return choice.name === undefined ? { ...PLACEHOLDER_CONFIG } : { ...PLACEHOLDER_CONFIG, name: choice.name };
}

/**
 * 一个选择所点名的模型：在目录里现查、现建、只用于一次请求、用完即丢。
 *
 * 查找按名字——行的名字是它的身份——且在这里、每次构造时进行，而不是提前铺进选择里。这正是让
 * 一把修正的密钥、一个挪走的端点、一个改过的窗口无需任何失效步骤、无需任何同步就抵达下一次请求
 * 的原因：没有副本会变陈旧。档位在 `createModel` 里规范化，应用叫不出名字的字符串落在 "off"，
 * 而不是端点会拒绝的值上。
 */
export function modelFor(choice: ModelChoice, catalog: readonly ModelConfig[], chatTransport?: ChatTransport): Model {
	return createModel(rowOrPlaceholder(choice, catalog), choice.thinkingLevel, chatTransport);
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
 * 手写而成，因为没有请求可发：无行会话的全部意义，就是在用户正盯着看的会话记录里，以一句
 * 用户能照着行动的话失败。它的形状与任何传输层的流一致，引擎读它如同读一次真实的失败。
 */
export function unconfiguredStream(model: Model<Api>): AssistantMessageEventStream {
	const assistantMessageEventStream = createAssistantMessageEventStream();
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
		assistantMessageEventStream.push({ type: "error", reason: "error", error: message });
		assistantMessageEventStream.end();
	});
	return assistantMessageEventStream;
}

// ---------------------------------------------------------------------------- 查找

/** 各行收窄成客户端可见的样子。密钥本身永不离开服务器。 */
export function listModelOptions(models: readonly ModelConfig[]): ModelOption[] {
	return models.map((config) => {
		const model = createModel(config);
		return {
			id: config.id,
			name: config.name,
			api: model.api,
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

/**
 * 会话可能处于的思考档位。
 *
 * 阶梯与模型行同住本文件（模型簇的持有者），转发出去让包内调用方不必为了拼一个档位伸手进传输层
 * 包——转发而不是重述，因为四个字符串字面量手写两份，正是本文件刚用一个类型消灭的漂移。
 */
export type { ThinkingLevel };

/**
 * 把被要求的档位变成本应用能记录的档位。
 *
 * 集合对每个模型都一样——effort 是 wire 携带的唯一强度——所以这是名字检查，不是钳制：应用叫不出
 * 名字的字符串，与什么都没要求的调用方，都落在 "off"。这是对「没有被要求」的诚实回答，并且在
 * wire 上把这一点说出来的是请求本身。
 */
export function normalizeThinkingLevel(level: string | undefined): ThinkingLevel {
	const allowed = getSupportedThinkingLevels();
	return allowed.includes(level as ThinkingLevel) ? (level as ThinkingLevel) : "off";
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
