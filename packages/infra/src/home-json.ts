// home JSON 文件族的原语实现（分层重构 spec §4.4）：一个实现满足三个同形声明
// （SessionDefaultsRepository / ModelRepository / ToolDefaultsRepository）——三簇设置文件的读写是
// 同一份字节级机械：join home、缺文件语义、坏 JSON 拒绝、同目录 temp+rename 落盘。
//
// 这不是「共享存储抽象」的复活（ADR-0028）：规范化与合并函数（viewOf / approvalOr / bashOr /
// modesOr / queueModeOr / retryOr / mergeLayers）与迁移编排仍各簇内联、一行不共享——这里只有字节
// 原语，是它下面一层的机械。`file` 是文件名，join home 在实现里（spec §4.2）；「哪份是 legacy」
// 的知识归各持有者，实现不懂。
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ModelRepository,
	SessionDefaultsRepository,
	ToolDefaultsRepository,
} from "@my-agent/domain";

/** {@link HomeJsonStore} 的构造 options：文件族所在的 agent home，绝对路径。 */
export interface HomeJsonStoreOptions {
	home: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 三个设置簇同形的 home JSON 读写：一次构造、三份声明。
 *
 * `modelsHome` ≠ `settingsHome` 时组合根各造一份（spec §5.1）；`settingsHome` 的一份同时充当
 * SessionDefaultsRepository（`sessions.json` 及 legacy `settings.json`）与 ToolDefaultsRepository
 * （`tools.json`）——文件名是读取方的簇知识，实现只管机械。
 */
export class HomeJsonStore implements SessionDefaultsRepository, ModelRepository, ToolDefaultsRepository {
	private readonly home: string;

	constructor(options: HomeJsonStoreOptions) {
		this.home = options.home;
	}

	read(file: string): Record<string, unknown> | undefined {
		const absPath = join(this.home, file);
		let text: string;
		try {
			text = readFileSync(absPath, "utf8");
		} catch (error) {
			// 文件缺失是正常的首次运行。其余任何情况——权限、挡在路上的目录——都是真实的失败，不得以
			// 「未配置设置」的形态抵达调用方。
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}

		// trim 顺带去掉 UTF-8 BOM——Windows 编辑器会写它，而 `JSON.parse` 拒绝它。空文件是一个空层。
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

	write(file: string, layer: Record<string, unknown>): void {
		const absPath = join(this.home, file);
		// 原子落盘：写同目录的 temp 文件再 rename 盖上去（temp 名带 pid，防多进程撞名）——读者要么
		// 看到旧文件要么看到新文件，绝不会看到写到一半的。目录不存在时创建它。
		mkdirSync(dirname(absPath), { recursive: true });
		const absTemp = `${absPath}.${process.pid}.tmp`;
		const fd = openSync(absTemp, "wx");
		try {
			writeFileSync(fd, `${JSON.stringify(layer, null, "\t")}\n`);
		} finally {
			closeSync(fd);
		}
		renameSync(absTemp, absPath);
	}
}
