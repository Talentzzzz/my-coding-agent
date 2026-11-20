import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// 环安全：本模块只在函数体内使用 config.ts 的运行时值（模块顶层不碰它们），而 config.ts 只从
// 本模块取 `RetrySettings` 的类型——两条方向都是类型/调用期的引用，加载顺序无关紧要。
import { AGENT_HOME, DEFAULT_GLOBAL_SETTINGS, settingsPath } from "./config.ts";

/**
 * 引擎簇设置的持有者：编排层自己重试策略的家（spec「设置归属重构」§3）。
 *
 * retry 的唯一消费者就是编排层自己的重试泵，所以引擎簇不进任何公开门面——它由 {@link Agent}
 * 私有持有，server 无需看见它（`SettingsPatch.retry` 经门面路由进私有面）。将来引擎级的新设置
 * （如压缩阈值）落同一份 `engine.json`、进同一个持有者。
 *
 * 与其他持有者同形（spec §5）：无状态、每次现读（ADR-0013），构造只收 `home`（默认
 * {@link AGENT_HOME}，测试递临时目录），文件读写直接内联、不引入存储抽象。调用之间什么都不
 * 保留——状态是文件截至本次调用的快照，所以编辑器里的手改就是下一次调用给出的答案。
 */
export class EngineSettings {
	private readonly home: string;

	/** `home` 是 `engine.json` 所在的目录；递别的 home 是让测试指到无害的地方。 */
	constructor(home: string = AGENT_HOME) {
		this.home = home;
	}

	/**
	 * 供应商调用失败时的重试策略，补默认后的副本：改它不动任何东西。
	 *
	 * 本持有者的首次读取顺带执行迁移（spec §4.2）：`engine.json` 不存在而旧 `settings.json`
	 * 存在时，从旧文件捡走 retry 簇，把补默认后的视图原子落盘——「迁移过」从此是磁盘事实，旧文件
	 * 之后被完全忽略、永不删除也永不写入。
	 */
	retrySettings(): RetrySettings {
		return retryOr(this.layerWithMigration().retry);
	}

	/**
	 * 应用一次 retry 的部分变更，返回前写盘。
	 *
	 * 与今天 `SettingManager.applySettings` 的语义逐条一致（spec §4.3）：写前重读文件（本类本就
	 * 不持常驻袋）、只动被点名的字段（retry 嵌套合并）、未知键原样保留。写入只落在
	 * `engine.json` 上、别无他处。
	 */
	applyRetry(patch: Partial<RetrySettings>): void {
		const named = Object.entries(patch).filter(([, value]) => value !== undefined);
		if (named.length === 0) return;
		const layer = this.layerWithMigration();
		layer.retry = mergeLayers(isRecord(layer.retry) ? layer.retry : {}, Object.fromEntries(named));
		this.write(layer);
	}

	/**
	 * 引擎簇文件的内容，按它写下的原样（未知的键也算），缺文件时执行迁移。
	 *
	 * 本构建无法解析的文件被拒绝，从不被覆盖——与 `SettingManager` 对 settings.json 的裁定同形。
	 */
	private layerWithMigration(): Record<string, unknown> {
		const existing = readLayer(this.enginePath());
		if (existing !== undefined) return existing;

		// 首读：从旧 settings.json 捡走自己的簇（旧文件不在场就是全缺省），补默认后的视图落盘——
		// 字段全缺省也写出文件，把「迁移过」变成磁盘事实，避免旧文件复活。
		const legacy = readLayer(settingsPath(this.home));
		const view: Record<string, unknown> = { retry: retryOr(legacy?.retry) };
		this.write(view);
		return view;
	}

	private enginePath(): string {
		return join(this.home, "engine.json");
	}

	private write(layer: Record<string, unknown>): void {
		mkdirSync(this.home, { recursive: true });
		writeFileSync(this.enginePath(), `${JSON.stringify(layer, null, "\t")}\n`, "utf8");
	}
}

/**
 * 供应商调用失败时的重试策略。
 *
 * 逐字段对应 pi-ai 的 `RetryPolicy`，对象无需转换即可交给 `retryAssistantCall`：`maxRetries` 数的是
 * 重试次数而非调用次数，`0` 表示「从不重试」。
 */
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	/** 每次尝试的延迟为 `baseDelayMs * 2^(attempt-1)`。 */
	baseDelayMs: number;
	/** 单次计算出的延迟的上限。 */
	maxAgentDelayMs: number;
}

/**
 * 重试策略，逐字段落在默认值之上。
 *
 * `maxRetries` 是唯一可以为零的计数——「不重试」是一个设置，不是缺值——所以按非负整数解析，
 * 而不用 {@link numberOr}。默认值留守 `config.ts` 的 `DEFAULT_GLOBAL_SETTINGS`（spec §5）。
 */
export function retryOr(value: unknown): RetrySettings {
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

/** 有限正数，否则回落；export 只为 tools/manager.ts 的 bashOr 复用同一份解析。 */
export function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 文件的内容，缺文件时 undefined；坏了的文件被拒绝而不是被吞掉。 */
function readLayer(path: string): Record<string, unknown> | undefined {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		// 文件缺失是正常的首次运行。其余任何情况——权限、挡在路上的目录——都是真实的失败，不得以
		// 「未配置设置」的形态抵达调用方。
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}

	// trim 顺带去掉 UTF-8 BOM——Windows 编辑器会写它，而 `JSON.parse` 拒绝它。
	const text = content.trim();
	if (text === "") return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
	}
	if (!isRecord(parsed)) throw new Error(`${path} must hold a JSON object`);
	return parsed;
}

/** 补丁的嵌套对象逐键合并进已有的值，其余字段整体替换。 */
function mergeLayers(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) continue;
		const inherited = merged[key];
		merged[key] = isRecord(inherited) && isRecord(value) ? mergeLayers(inherited, value) : value;
	}
	return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
