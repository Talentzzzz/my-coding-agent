// ModelManager smoke：对一个临时 agent home 里的真实 models.json 与旧 settings.json 驱动
// 模型目录操作，并检查这张票立住的几条性质——两个新键（defaultModel / defaultModelSeeded）
// 的逐键读时迁移（false 原样搬运）、写前重读（手编不被回滚）、未知键原样保留。
// 写入经由同一个 ModelManager 完成，再用对相同路径的*全新*读读回，因此必须能穿过
// JSON.stringify → parse → coerceModelConfig 回来。
// 这里不触网，无需服务器和 provider key。
// 运行：node scripts/smoke-model-manager.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUnconfigured, ModelManager, modelsPath, settingsPath, type ModelConfig } from "@my-agent/core";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

function row(overrides: Partial<ModelConfig> = {}): ModelConfig {
	return {
		name: "mine",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "secret",
		id: "wire-model",
		contextWindow: 64_000,
		maxTokens: 4_096,
		...overrides,
	};
}

/** 在临时 home 里写下 models.json（手编的样子：未知键也带上）。 */
function seedModelsFile(home: string, content: Record<string, unknown>): void {
	writeFileSync(modelsPath(home), `${JSON.stringify(content, null, "\t")}\n`, "utf8");
}

/** 在临时 home 里写下旧 settings.json（迁移源）。 */
function seedLegacySettings(home: string, content: Record<string, unknown>): void {
	writeFileSync(settingsPath(home), `${JSON.stringify(content, null, "\t")}\n`, "utf8");
}

function modelsDisk(home: string): Record<string, unknown> {
	return JSON.parse(readFileSync(modelsPath(home), "utf8")) as Record<string, unknown>;
}

// ------------------------------------------------- 1. 首读迁移：缺键 + 旧文件带字段

process.stdout.write("\nmodels：首读把旧 settings.json 的两个键逐个捡进 models.json\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-model-manager-"));
	try {
		seedLegacySettings(home, { model: "deepseek-flash", defaultModelSeeded: false, tools: ["read"] });
		const manager = new ModelManager(home);

		// 缺文件 = 空目录，与今天的 list() 现行为一致——但迁移照做。
		check("缺文件时目录为空", manager.catalog().length === 0, JSON.stringify(manager.catalog()));
		check("默认 ref 从旧文件捡来", manager.defaultRef() === "deepseek-flash", String(manager.defaultRef()));

		// 迁移是磁盘事实：models.json 现在带着两个键，false 原样保留（它是「要求重新种回」的写法，
		// 变成缺失会让这个请求无法表达）。只属于设置簇的 tools 不跟过来。
		const disk = modelsDisk(home);
		check("磁盘上写着捡来的默认 ref", disk.defaultModel === "deepseek-flash", JSON.stringify(disk));
		check("磁盘上的 false 原样保留", disk.defaultModelSeeded === false, JSON.stringify(disk.defaultModelSeeded));
		check("设置簇的字段不跟过来", !("tools" in disk), JSON.stringify(disk));
		check("models 包裹键就位", Array.isArray(disk.models), JSON.stringify(disk));

		// 旧文件永不删除、永不写入：原样躺在原地。
		const legacy = JSON.parse(readFileSync(settingsPath(home), "utf8")) as Record<string, unknown>;
		check("旧 settings.json 原样未动", legacy.model === "deepseek-flash" && legacy.defaultModelSeeded === false && Array.isArray(legacy.tools), JSON.stringify(legacy));

		// 迁移过就是迁移过：删掉旧文件再建一只 manager，答案不回到 undefined。
		rmSync(settingsPath(home), { force: true });
		check("旧文件删了迁移结果还在", new ModelManager(home).defaultRef() === "deepseek-flash", String(new ModelManager(home).defaultRef()));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 2. 已带键：旧文件被忽略（逐键）

process.stdout.write("\nmodels：models.json 已带的键压住旧文件，缺的键仍逐个捡\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-model-manager-"));
	try {
		// defaultModel 已有主，defaultModelSeeded 缺席——迁移按键逐个裁决，不是按文件。
		seedModelsFile(home, { models: [row()], defaultModel: "mine" });
		seedLegacySettings(home, { model: "旧主人", defaultModelSeeded: true });
		const manager = new ModelManager(home);

		check("已带的 defaultModel 压住旧文件", manager.defaultRef() === "mine", String(manager.defaultRef()));
		const disk = modelsDisk(home);
		check("已带键时磁盘不被改写", disk.defaultModel === "mine" && disk.defaultModelSeeded === true, JSON.stringify(disk));
		check("缺的 defaultModelSeeded 仍被捡走", disk.defaultModelSeeded === true, JSON.stringify(disk.defaultModelSeeded));
		check("行原样还在", manager.catalog().length === 1, JSON.stringify(manager.catalog()));

		// 另一半：seeded 已在、model 缺——只捡 model。
		const home2 = mkdtempSync(join(tmpdir(), "my-agent-model-manager-"));
		try {
			seedModelsFile(home2, { models: [], defaultModelSeeded: false });
			seedLegacySettings(home2, { model: "捡我", defaultModelSeeded: true });
			const other = new ModelManager(home2);
			check("false 压住旧文件的 true", modelsDisk(home2).defaultModelSeeded === false, JSON.stringify(modelsDisk(home2)));
			check("缺的 defaultModel 仍被捡走", other.defaultRef() === "捡我", String(other.defaultRef()));
		} finally {
			rmSync(home2, { recursive: true, force: true });
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 3. applyModelSettings：只动点名的键

process.stdout.write("\nmodels：applyModelSettings 只动点名键，未知键原样保留\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-model-manager-"));
	try {
		seedModelsFile(home, {
			models: [row()],
			defaultModel: "mine",
			defaultModelSeeded: true,
			手编的未知键: { nested: "别动我" },
		});
		const manager = new ModelManager(home);

		// 补丁只点名 model：seeded 与未知键、行都不许挪。
		manager.applyModelSettings({ model: "switched" });
		const disk = modelsDisk(home);
		check("点名的 model 落盘", disk.defaultModel === "switched", JSON.stringify(disk));
		check("没点名的 seeded 不动", disk.defaultModelSeeded === true, JSON.stringify(disk.defaultModelSeeded));
		check("未知键原样保留", JSON.stringify(disk["手编的未知键"]) === JSON.stringify({ nested: "别动我" }), JSON.stringify(disk["手编的未知键"]));
		check("行不动", manager.catalog().length === 1, JSON.stringify(manager.catalog()));

		// false 是一个值，不是缺席：手编要求重新种回的写法要能写下去。
		manager.applyModelSettings({ defaultModelSeeded: false });
		check("手写的 false 留得住", modelsDisk(home).defaultModelSeeded === false, JSON.stringify(modelsDisk(home)));

		// 空补丁什么都不写：没有 models.json 的 home 上不得凭空造出文件。
		const fresh = mkdtempSync(join(tmpdir(), "my-agent-model-manager-"));
		try {
			new ModelManager(fresh).applyModelSettings({});
			new ModelManager(fresh).applyModelSettings({ model: undefined, defaultModelSeeded: undefined });
			let exists = true;
			try {
				readFileSync(modelsPath(fresh), "utf8");
			} catch {
				exists = false;
			}
			check("空补丁不造文件", !exists, String(exists));
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}

		// 读侧规范化：写下去的非空字符串裁边，空串读作未设置——与旧 settings.json 上 model 字段
		// 的 stringOrUndefined 规则同一条。
		const sloppy = mkdtempSync(join(tmpdir(), "my-agent-model-manager-"));
		try {
			seedModelsFile(sloppy, { models: [], defaultModel: "   " });
			check("空白 ref 读作未设置", new ModelManager(sloppy).defaultRef() === undefined, String(new ModelManager(sloppy).defaultRef()));
		} finally {
			rmSync(sloppy, { recursive: true, force: true });
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 4. replaceRows：整表替换，键与未知键保留

process.stdout.write("\nmodels：replaceRows 整表替换行，defaultModel / seeded / 未知键保留\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-model-manager-"));
	try {
		seedModelsFile(home, {
			models: [row()],
			defaultModel: "mine",
			defaultModelSeeded: false,
			手编的未知键: 42,
		});
		const manager = new ModelManager(home);

		const next = [row({ name: "第二台", id: "wire-2" }), row({ name: "第三台", id: "wire-3" })];
		manager.replaceRows(next);
		check("整表替换当场可读", manager.catalog().length === 2 && manager.catalog()[1]!.name === "第三台", JSON.stringify(manager.catalog()));
		const disk = modelsDisk(home);
		check("defaultModel 活过整表替换", disk.defaultModel === "mine", JSON.stringify(disk));
		check("defaultModelSeeded 活过整表替换", disk.defaultModelSeeded === false, JSON.stringify(disk.defaultModelSeeded));
		check("未知键活过整表替换", disk["手编的未知键"] === 42, JSON.stringify(disk));

		// 规范化的行走 coerceModelConfig：缺 baseUrl 的行读不回来——写坏的数据不抵达调用方。
		seedModelsFile(home, { models: [row(), { id: "x", name: "没端点" }] });
		const coerced = new ModelManager(home).catalog();
		check("读不回来的行被丢", coerced.length === 1 && coerced[0]!.name === "mine", JSON.stringify(coerced));

		// 无行目录读出占位行的事实由 rowOrPlaceholder 保证，这里只查目录本身不造假。
		check("目录行不是占位名", !isUnconfigured(coerced[0]!), coerced[0]!.name);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 5. 写前重读：手编不被回滚

process.stdout.write("\nmodels：写前重读——进程运行期间的手编不被一次无关的写入回滚\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-model-manager-"));
	try {
		seedModelsFile(home, { models: [row()], defaultModel: "mine" });
		const manager = new ModelManager(home);

		// manager 构造之后、写入之前，用户在编辑器里加了一行、改了默认 ref。
		seedModelsFile(home, { models: [row(), row({ name: "手编的", id: "wire-hand" })], defaultModel: "手编的" });

		// 一次与手编无关的写入不得把它滚回去：写入基于此刻的文件，不是构造时的快照。
		manager.applyModelSettings({ defaultModelSeeded: true });
		const disk = modelsDisk(home);
		check("手编的行活过补丁", manager.catalog().length === 2 && manager.catalog()[1]!.name === "手编的", JSON.stringify(manager.catalog()));
		check("手编的默认 ref 活过补丁", disk.defaultModel === "手编的", JSON.stringify(disk));
		check("点名的 seeded 照常落盘", disk.defaultModelSeeded === true, JSON.stringify(disk));

		// 同一条性质对整表替换也成立：键取自写前重读的文件。
		seedModelsFile(home, { models: [row()], defaultModel: "again", defaultModelSeeded: false });
		manager.replaceRows([row({ name: "重读后的", id: "wire-again" })]);
		const reread = modelsDisk(home);
		check("replaceRows 取的是写前那一刻的键", reread.defaultModel === "again" && reread.defaultModelSeeded === false, JSON.stringify(reread));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

process.stdout.write(failures === 0 ? "\nmodel-manager ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
