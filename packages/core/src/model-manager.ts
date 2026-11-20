import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AGENT_HOME, settingsPath } from "./config.ts";
import { coerceModelConfig, modelsPath, type ModelConfig } from "./models.ts";

/**
 * 模型簇的持有者：目录里的行、默认指向的行、以及「内置默认已种下」的标记。
 *
 * 设置归属重构（ADR-0028）把这三样交给模型自己：它们原本住在两份
 * 文件里——行在 `models.json`，另两样在旧 `settings.json`——现在同住 `models.json` 的两个可选键
 * （`defaultModel`、`defaultModelSeeded`），旧文件缺键即「未设置」，天然向后兼容。
 *
 * 与其他持有者同形：无状态门面、每次现读（ADR-0013 的既定模式）——文件又小又可手编，用编辑器
 * 改了什么的人下一次调用就得到答案，没有需要失效的东西。文件读写直接内联，不引入存储抽象。
 *
 * 与其余四个新文件不同，`models.json` 今天就已存在（上面一直住着行），所以迁移按「键」而不是按
 * 「文件」走：缺哪个键、旧文件里有对应的字段，就捡哪个——见 {@link load}。
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

	// ---------------------------------------------------------------------------- 读与迁移

	/**
	 * 文件此刻的内容：读 + 逐键迁移，本类一切方法的共同入口。
	 *
	 * 迁移按「键」裁决（`models.json` 今天就存在，不能整文件一刀切）：`defaultModel` 与
	 * `defaultModelSeeded` 各自检查——缺这个键、且旧 `settings.json` 带着对应字段（`model` /
	 * `defaultModelSeeded`），就从旧文件捡走、原子写回。一旦键已在，旧文件的对应字段被忽略；
	 * 没有东西可捡时一个字节都不写，机器上没有 `models.json` 的现状保持原样。旧文件本身永不
	 * 删除、永不写入。
	 */
	private load(): Record<string, unknown> {
		const disk = readDisk(modelsPath(this.home));

		const legacy = readLegacySettings(this.home);
		if (legacy !== undefined) {
			let migrated = false;
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
			if (migrated) {
				if (!("models" in disk)) disk.models = [];
				writeDisk(modelsPath(this.home), disk);
			}
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
