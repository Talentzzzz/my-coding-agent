// Model settings smoke：对一个临时 agent home 里的真实文件驱动模型簇（行、默认模型、retry）的读与写。
// 本脚本原是 `smoke-engine-settings.ts`（retry 曾住 engine.json、归编排层私有）；retry 簇并入
// ModelManager（ADR-0028 修正）后，同一组性质对着新的家复验：
// - 迁移按「键」走（spec §4.2）：`models.json` 缺 `retry` 键时先从 `engine.json` 捡、再从旧
//   `settings.json` 捡；键已在则旧文件被完全忽略。旧文件永不删除、永不写入。
// - 写路径的三条性质：写前重读、只动点名字段（嵌套合并）、未知键原样保留（spec §4.3）。
// - 「不重试」是一个设置而不是缺值——maxRetries=0 必须幸存。
// 这里不触网，无需服务器和 provider key。
// 运行：node scripts/smoke-model-settings.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GLOBAL_SETTINGS, ModelManager, type RetrySettings } from "@my-agent/domain";
import { HomeJsonStore } from "@my-agent/infra";

/** models.json 的落盘位置——文件名知识随端口化归持有者（spec §4.2）。 */
function modelsPathOf(home: string): string {
	return join(home, "models.json");
}

/** legacy settings.json（迁移源）。 */
function legacySettingsPath(home: string): string {
	return join(home, "settings.json");
}

function enginePathOf(home: string): string {
	return join(home, "engine.json");
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

/** 端口化后的 manager 构造：HomeJsonStore 实现满足 ModelRepository 声明。 */
function modelsOf(home: string): ModelManager {
	return new ModelManager({ modelRepository: new HomeJsonStore({ home }) });
}

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

// ------------------------------------------------- 1. 迁移：退场持有者的 engine.json 优先被捡走

process.stdout.write("\nmodel：首读迁移——engine.json 的 retry 被捡进 models.json，engine.json 原样未动\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-model-"));
	try {
		// 旧持有者的文件带着用户手调过的 retry：enabled 关了、次数升到 5，其余字段缺省。
		writeJson(enginePathOf(home), { retry: { enabled: false, maxRetries: 5 } });

		const models = modelsOf(home);
		const retry = models.retrySettings();
		check("旧持有者文件的手调字段原样回来", retry.enabled === false && retry.maxRetries === 5, JSON.stringify(retry));
		check("缺省字段补上默认", retry.baseDelayMs === DEFAULT_GLOBAL_SETTINGS.retry.baseDelayMs && retry.maxAgentDelayMs === DEFAULT_GLOBAL_SETTINGS.retry.maxAgentDelayMs, JSON.stringify(retry));

		// 捡来的值原样落盘：「迁移过」成为磁盘事实，engine.json 之后不会再复活。
		const onDisk = JSON.parse(readFileSync(modelsPathOf(home), "utf8")) as { retry?: Partial<RetrySettings> };
		check("models.json 已在磁盘上", onDisk.retry !== undefined, JSON.stringify(onDisk));
		check("落盘的键带着手调值", onDisk.retry?.maxRetries === 5, JSON.stringify(onDisk.retry));

		// 旧文件永不删除、永不写入：迁移前后逐字节一致。
		const engineAfter = readFileSync(enginePathOf(home), "utf8");
		check("engine.json 原样未动", engineAfter === `${JSON.stringify({ retry: { enabled: false, maxRetries: 5 }, }, null, "\t")}\n`, engineAfter);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 2. 退路的迁移：engine.json 不在、旧 settings.json 在场

process.stdout.write("\nmodel：engine.json 缺席时 retry 从旧 settings.json 被捡走\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-model-"));
	try {
		writeJson(legacySettingsPath(home), { retry: { enabled: false, maxRetries: 9 } });

		const models = modelsOf(home);
		const retry = models.retrySettings();
		check("旧 settings.json 的手调字段原样回来", retry.enabled === false && retry.maxRetries === 9, JSON.stringify(retry));

		const onDisk = JSON.parse(readFileSync(modelsPathOf(home), "utf8")) as Record<string, unknown>;
		check("models.json 已在磁盘上", onDisk.retry !== undefined, JSON.stringify(onDisk));
		check("旧 settings.json 原样未动", readFileSync(legacySettingsPath(home), "utf8") === `${JSON.stringify({ retry: { enabled: false, maxRetries: 9 }, }, null, "\t")}\n`);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 3. retry 键已在则两份旧文件被完全忽略

process.stdout.write("\nmodel：models.json 已有 retry 键时两份旧文件被完全忽略\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-model-"));
	try {
		writeJson(legacySettingsPath(home), { retry: { enabled: false, maxRetries: 9 } });
		writeJson(enginePathOf(home), { retry: { maxRetries: 8 } });
		writeJson(modelsPathOf(home), { retry: { maxRetries: 1 } });

		const models = modelsOf(home);
		const retry = models.retrySettings();
		check("读的是 models.json 的键", retry.maxRetries === 1, JSON.stringify(retry));
		check("enabled 来自默认而不是旧文件", retry.enabled === DEFAULT_GLOBAL_SETTINGS.retry.enabled, JSON.stringify(retry));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 4. 写路径：嵌套合并、只动点名、未知键保留

process.stdout.write("\nmodel：applyRetry 只动点名字段，未知键原样保留\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-model-"));
	try {
		// 手编的文件带着未来版本才认识的键：retry 里一个、顶层一个。
		writeJson(modelsPathOf(home), {
			models: [],
			retry: { maxRetries: 2, baseDelayMs: 3_000, futureFlag: true },
			futureCluster: { note: "reserved" },
		});

		const models = modelsOf(home);
		models.applyRetry({ enabled: false });

		const retry = models.retrySettings();
		check("点名的字段动了", retry.enabled === false, JSON.stringify(retry));
		check("没点名的字段保持原值", retry.maxRetries === 2 && retry.baseDelayMs === 3_000, JSON.stringify(retry));
		check("retry 里的未知键幸存", retrySettingsOnDisk(home).futureFlag === true, JSON.stringify(retrySettingsOnDisk(home)));
		check("顶层的未知键幸存", clusterOnDisk(home).futureCluster !== undefined, JSON.stringify(clusterOnDisk(home)));

		// 嵌套合并而非整体替换：只给一个字段的补丁不把 retry 其余的键抹掉。
		const onDiskRetry = retrySettingsOnDisk(home);
		check("retry 是合并不是整体替换", onDiskRetry.enabled === false && onDiskRetry.maxRetries === 2, JSON.stringify(onDiskRetry));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 5. 「不重试」是设置：maxRetries=0 幸存

process.stdout.write("\nmodel：maxRetries=0 是「不重试」的设置，不是缺值\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-model-"));
	try {
		// 迁移路上就该幸存：engine.json 把次数调成 0，规范化不得把它读成「没设过」。
		writeJson(enginePathOf(home), { retry: { maxRetries: 0 } });
		const migrated = modelsOf(home).retrySettings();
		check("迁移后 maxRetries=0 幸存", migrated.maxRetries === 0, JSON.stringify(migrated));

		// 写路径同理：面板把重试关成 0，读回来必须还是 0。
		const models = modelsOf(mkdtempSync(join(tmpdir(), "my-agent-model-")));
		models.applyRetry({ maxRetries: 0 });
		check("applyRetry 后 maxRetries=0 幸存", models.retrySettings().maxRetries === 0, JSON.stringify(models.retrySettings()));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 6. 两边都缺：读完不落盘（spec §4.2）

process.stdout.write("\nmodel：models.json、engine.json 与旧 settings.json 都不存在时，读完不写任何文件\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-model-"));
	try {
		const models = modelsOf(home);
		const retry = models.retrySettings();
		check("读到的是补默认的视图", retry.enabled === DEFAULT_GLOBAL_SETTINGS.retry.enabled && retry.maxRetries === DEFAULT_GLOBAL_SETTINGS.retry.maxRetries, JSON.stringify(retry));
		check("models.json 没有被写出", !existsSync(modelsPathOf(home)));
		check("engine.json 没有被写出", !existsSync(enginePathOf(home)));
		check("旧 settings.json 也没有被写出", !existsSync(legacySettingsPath(home)));

		// 只有第一次真正的写入才让 models.json 出现。
		models.applyRetry({ maxRetries: 2 });
		check("applyRetry 之后 models.json 在场", existsSync(modelsPathOf(home)));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 7. 写前重读：手编不被无关写入回滚

process.stdout.write("\nmodel：写前重读——进程之外的手编不被一次无关的 applyRetry 回滚\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-model-"));
	try {
		const models = modelsOf(home);
		models.applyRetry({ maxRetries: 4 });

		// 构造之后、写入之前，有人用编辑器改了磁盘上的文件：加了一个未知键、调了一个值。
		const handEdited = { ...clusterOnDisk(home), futureFlag: true } as Record<string, unknown>;
		(handEdited.retry as Record<string, unknown>).baseDelayMs = 9_000;
		writeJson(modelsPathOf(home), handEdited);

		// 一次与手编无关的补丁不得把编辑器的改动滚回去。
		models.applyRetry({ enabled: false });

		const onDisk = retrySettingsOnDisk(home);
		check("手编的未知键还在", clusterOnDisk(home).futureFlag === true, JSON.stringify(clusterOnDisk(home)));
		check("手编的值没被回滚", onDisk.baseDelayMs === 9_000, JSON.stringify(onDisk));
		check("补丁自己也落了盘", onDisk.enabled === false, JSON.stringify(onDisk));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

function retrySettingsOnDisk(home: string): Record<string, unknown> {
	return (clusterOnDisk(home).retry ?? {}) as Record<string, unknown>;
}

function clusterOnDisk(home: string): Record<string, unknown> {
	return JSON.parse(readFileSync(modelsPathOf(home), "utf8")) as Record<string, unknown>;
}

process.stdout.write(failures === 0 ? "\nmodel settings ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
