// Engine settings smoke：对一个临时 agent home 里的真实文件驱动引擎簇（retry）的读与写。
// 覆盖迁移（spec §4.2：engine.json 缺席而旧 settings.json 在场时捡走 retry，补默认后的视图落盘，
// 旧文件永不写）、「文件在场则旧文件被完全忽略」、写路径的三条性质（写前重读、只动点名字段、
// 未知键原样保留，spec §4.3），以及「不重试」是一个设置而不是缺值——maxRetries=0 必须幸存。
// 这里不触网，无需服务器和 provider key。
// 运行：node scripts/smoke-engine-settings.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GLOBAL_SETTINGS, EngineSettings, settingsPath, type RetrySettings } from "@my-agent/core";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

function enginePathOf(home: string): string {
	return join(home, "engine.json");
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

// ------------------------------------------------- 1. 迁移：旧 settings.json 的 retry 被捡走

process.stdout.write("\nengine：首读迁移——旧 settings.json 的 retry 被捡走，补默认视图落盘\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-engine-"));
	try {
		// 旧文件带着用户手调过的 retry：enabled 关了、次数升到 5，其余字段缺省。
		writeJson(settingsPath(home), { retry: { enabled: false, maxRetries: 5 } });

		const engine = new EngineSettings({ home });
		const retry = engine.retrySettings();
		check("旧文件的手调字段原样回来", retry.enabled === false && retry.maxRetries === 5, JSON.stringify(retry));
		check("缺省字段补上默认", retry.baseDelayMs === DEFAULT_GLOBAL_SETTINGS.retry.baseDelayMs && retry.maxAgentDelayMs === DEFAULT_GLOBAL_SETTINGS.retry.maxAgentDelayMs, JSON.stringify(retry));

		// 补默认后的视图落盘：「迁移过」成为磁盘事实，旧文件之后不会再复活。
		const onDisk = JSON.parse(readFileSync(enginePathOf(home), "utf8")) as { retry?: Partial<RetrySettings> };
		check("engine.json 已在磁盘上", onDisk.retry !== undefined, JSON.stringify(onDisk));
		check("落盘的视图也是补默认的", onDisk.retry?.baseDelayMs === DEFAULT_GLOBAL_SETTINGS.retry.baseDelayMs, JSON.stringify(onDisk.retry));

		// 旧文件永不删除、永不写入：迁移前后逐字节一致。
		const legacyAfter = readFileSync(settingsPath(home), "utf8");
		check("旧 settings.json 原样未动", legacyAfter === `${JSON.stringify({ retry: { enabled: false, maxRetries: 5 }, }, null, "\t")}\n`, legacyAfter);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 2. engine.json 在场则旧文件被完全忽略

process.stdout.write("\nengine：engine.json 已存在时旧 settings.json 被完全忽略\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-engine-"));
	try {
		writeJson(settingsPath(home), { retry: { enabled: false, maxRetries: 9 } });
		writeJson(enginePathOf(home), { retry: { maxRetries: 1 } });

		const engine = new EngineSettings({ home });
		const retry = engine.retrySettings();
		check("读的是 engine.json 的行", retry.maxRetries === 1, JSON.stringify(retry));
		check("enabled 来自默认而不是旧文件", retry.enabled === DEFAULT_GLOBAL_SETTINGS.retry.enabled, JSON.stringify(retry));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 3. 写路径：嵌套合并、只动点名、未知键保留

process.stdout.write("\nengine：applyRetry 只动点名字段，未知键原样保留\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-engine-"));
	try {
		// 手编的文件带着未来版本才认识的键：顶层一个、retry 里一个。
		writeJson(enginePathOf(home), {
			retry: { maxRetries: 2, baseDelayMs: 3_000, futureFlag: true },
			futureCluster: { note: "reserved" },
		});

		const engine = new EngineSettings({ home });
		engine.applyRetry({ enabled: false });

		const retry = engine.retrySettings();
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

// ------------------------------------------------- 4. 「不重试」是设置：maxRetries=0 幸存

process.stdout.write("\nengine：maxRetries=0 是「不重试」的设置，不是缺值\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-engine-"));
	try {
		// 迁移路上就该幸存：旧文件把次数调成 0，规范化不得把它读成「没设过」。
		writeJson(settingsPath(home), { retry: { maxRetries: 0 } });
		const migrated = new EngineSettings({ home }).retrySettings();
		check("迁移后 maxRetries=0 幸存", migrated.maxRetries === 0, JSON.stringify(migrated));

		// 写路径同理：面板把重试关成 0，读回来必须还是 0。
		const engine = new EngineSettings({ home });
		engine.applyRetry({ maxRetries: 0 });
		check("applyRetry 后 maxRetries=0 幸存", engine.retrySettings().maxRetries === 0, JSON.stringify(engine.retrySettings()));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 5. 两边都缺：读完不落盘（spec §4.2）

process.stdout.write("\nengine：engine.json 与旧 settings.json 都不存在时，读完不写任何文件\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-engine-"));
	try {
		const engine = new EngineSettings({ home });
		const retry = engine.retrySettings();
		check("读到的是补默认的视图", retry.enabled === DEFAULT_GLOBAL_SETTINGS.retry.enabled && retry.maxRetries === DEFAULT_GLOBAL_SETTINGS.retry.maxRetries, JSON.stringify(retry));
		check("engine.json 没有被写出", !existsSync(enginePathOf(home)));
		check("旧 settings.json 也没有被写出", !existsSync(settingsPath(home)));

		// 只有第一次真正的写入才让 engine.json 出现。
		engine.applyRetry({ maxRetries: 2 });
		check("applyRetry 之后 engine.json 在场", existsSync(enginePathOf(home)));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 6. 写前重读：手编不被无关写入回滚

process.stdout.write("\nengine：写前重读——进程之外的手编不被一次无关的 applyRetry 回滚\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-engine-"));
	try {
		const engine = new EngineSettings({ home });
		engine.applyRetry({ maxRetries: 4 });

		// 构造之后、写入之前，有人用编辑器改了磁盘上的文件：加了一个未知键、调了一个值。
		const handEdited = { ...clusterOnDisk(home), futureFlag: true } as Record<string, unknown>;
		(handEdited.retry as Record<string, unknown>).baseDelayMs = 9_000;
		writeJson(enginePathOf(home), handEdited);

		// 一次与手编无关的补丁不得把编辑器的改动滚回去。
		engine.applyRetry({ enabled: false });

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
	return JSON.parse(readFileSync(enginePathOf(home), "utf8")) as Record<string, unknown>;
}

process.stdout.write(failures === 0 ? "\nengine settings ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
