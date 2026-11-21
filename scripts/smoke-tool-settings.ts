// Tool settings smoke：对一个临时 agent home 里的真实文件驱动 ToolManager 的工具簇设置面
// （`tools.json`）——读时迁移、写前重读、只动点名字段。写入经由 ToolManager 完成，再用对相同
// 路径的*全新*读读回，因此必须能穿过 JSON.stringify → parse → 补默认视图回来。
// 这里不触网，无需服务器和 provider key；机器自己的 home 永不被碰——文件行为全部发生在临时
// home，零参工厂只验证建表（`names()` 不触碰 tools.json）。
// 运行：node scripts/smoke-tool-settings.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolManager } from "@my-agent/domain";
import { HomeJsonStore } from "@my-agent/infra";

/** 端口化后的 manager 构造：HomeJsonStore 实现满足 ToolDefaultsRepository 声明（spec §4.2）。 */
function toolsOf(home: string): ReturnType<typeof createToolManager> {
	return createToolManager({ toolDefaultsRepository: new HomeJsonStore({ home }) });
}

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

// 断言的真相来自 spec，不来自实现：标准审批映射与 bash 超时默认值的独立底账。
const STANDARD_APPROVAL: Record<string, boolean> = { read: false, write: true, edit: true, glob: false, grep: false, bash: true };

const toolsJsonOf = (home: string): string => join(home, "tools.json");
const mkHome = (): string => mkdtempSync(join(tmpdir(), "my-agent-tool-settings-"));
function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

// --------------------------------- 1. 读时迁移：从旧 settings.json 捡走工具簇

process.stdout.write("\ntools.json：首次读取从旧 settings.json 捡走工具簇，补默认视图落盘\n");

{
	const home = mkHome();
	try {
		const legacyPath = join(home, "settings.json");
		writeFileSync(
			legacyPath,
			`${JSON.stringify(
				{
					model: "a/b",
					tools: ["read", "bash"],
					modes: [{ name: "只读", tools: ["read"], approval: { bash: false } }],
					approval: { write: false, junk: "不是布尔" },
					bash: { defaultTimeoutMs: 5_000 },
					appearance: { theme: "light", fontSize: 15 },
				},
				null,
				"\t",
			)}\n`,
			"utf8",
		);
		const legacyBefore = readFileSync(legacyPath, "utf8");

		const view = toolsOf(home).toolDefaults();
		check("迁移捡走默认工具集", JSON.stringify(view.tools) === JSON.stringify(["read", "bash"]), JSON.stringify(view));
		check("迁移捡走模式表", view.modes?.length === 1 && view.modes[0]?.name === "只读", JSON.stringify(view.modes));
		check(
			"模式的审批缺键补默认",
			view.modes?.[0]?.approval.bash === false && view.modes?.[0]?.approval.read === STANDARD_APPROVAL.read && view.modes?.[0]?.approval.write === true,
			JSON.stringify(view.modes),
		);
		check(
			"全局审批捡走布尔条目",
			view.approval.write === false && view.approval.read === STANDARD_APPROVAL.read && view.approval.bash === STANDARD_APPROVAL.bash,
			JSON.stringify(view.approval),
		);
		check("非布尔审批条目被丢", view.approval.junk === undefined, JSON.stringify(view.approval));
		check("bash 超时捡走并补默认", view.bash.defaultTimeoutMs === 5_000 && view.bash.maxTimeoutMs === 3_600_000, JSON.stringify(view.bash));

		// 落盘的是补默认后的视图：第二个进程对 tools.json 的全新读就是迁移后的答案。
		check("迁移写出 tools.json", existsSync(toolsJsonOf(home)));
		const onDisk = readJson(toolsJsonOf(home));
		const migratedModes = (onDisk.modes as { approval?: Record<string, unknown> }[] | undefined) ?? [];
		check(
			"落盘的是补默认后的视图",
			onDisk.bash !== undefined && (onDisk.bash as Record<string, unknown>).maxTimeoutMs === 3_600_000 && migratedModes[0]?.approval?.read === STANDARD_APPROVAL.read,
			JSON.stringify(onDisk),
		);
		check("其他簇的字段不搬进 tools.json", onDisk.model === undefined && onDisk.appearance === undefined, JSON.stringify(onDisk));
		check("旧 settings.json 一字未动", readFileSync(legacyPath, "utf8") === legacyBefore);

		// tools.json 已存在之后，旧文件被完全忽略——哪怕旧文件随后又被改了簇字段。
		writeFileSync(
			legacyPath,
			`${JSON.stringify({ tools: ["grep"], bash: { defaultTimeoutMs: 999_999 } }, null, "\t")}\n`,
			"utf8",
		);
		const second = toolsOf(home).toolDefaults();
		check(
			"迁移后旧文件被完全忽略",
			JSON.stringify(second.tools) === JSON.stringify(["read", "bash"]) && second.bash.defaultTimeoutMs === 5_000,
			JSON.stringify(second),
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

process.stdout.write("\ntools.json：簇字段全缺省也落盘；没有迁移源就不落盘\n");

{
	const home = mkHome();
	try {
		// 边界情形（spec §4.2）：旧文件存在但工具簇一个字段都没有——也必须写出 tools.json，
		// 把「迁移过」变成磁盘事实，避免旧文件在每次首读时复活。
		writeFileSync(join(home, "settings.json"), `${JSON.stringify({ model: "a/b" }, null, "\t")}\n`, "utf8");
		const view = toolsOf(home).toolDefaults();
		check(
			"簇全缺省时视图是标准默认",
			view.tools === undefined && view.modes === undefined && view.bash.defaultTimeoutMs === 120_000 && view.approval.bash === STANDARD_APPROVAL.bash,
			JSON.stringify(view),
		);
		check("簇全缺省也写出 tools.json", existsSync(toolsJsonOf(home)));
		const onDisk = readJson(toolsJsonOf(home));
		check(
			"落盘的视图带着补默认的 approval 与 bash",
			(onDisk.approval as Record<string, unknown>)?.read === STANDARD_APPROVAL.read && (onDisk.bash as Record<string, unknown>)?.maxTimeoutMs === 3_600_000,
			JSON.stringify(onDisk),
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

{
	const home = mkHome();
	try {
		const view = toolsOf(home).toolDefaults();
		check("空白 home 读出标准默认", view.approval.bash === STANDARD_APPROVAL.bash && view.bash.defaultTimeoutMs === 120_000, JSON.stringify(view));
		check("没有迁移源就不落盘", !existsSync(toolsJsonOf(home)));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// --------------------------------- 2. tools.json 已存在 → 旧文件被完全忽略

process.stdout.write("\ntools.json：已存在时旧 settings.json 被完全忽略\n");

{
	const home = mkHome();
	try {
		writeFileSync(
			toolsJsonOf(home),
			`${JSON.stringify({ tools: ["grep"], bash: { defaultTimeoutMs: 1_000 }, approval: { read: true }, custom: "keep" }, null, "\t")}\n`,
			"utf8",
		);
		writeFileSync(
			join(home, "settings.json"),
			`${JSON.stringify({ tools: ["write"], bash: { defaultTimeoutMs: 999_999 } }, null, "\t")}\n`,
			"utf8",
		);
		const view = toolsOf(home).toolDefaults();
		check(
			"簇字段以 tools.json 为准",
			JSON.stringify(view.tools) === JSON.stringify(["grep"]) && view.bash.defaultTimeoutMs === 1_000,
			JSON.stringify(view),
		);
		check("tools.json 的审批缺键补默认", view.approval.read === true && view.approval.bash === STANDARD_APPROVAL.bash, JSON.stringify(view.approval));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// --------------------------------- 3. applyToolDefaults：只动点名字段，未知键原样保留

process.stdout.write("\ntools.json：applyToolDefaults 四字段各自只动点名，未知键保留\n");

{
	const home = mkHome();
	try {
		const manager = toolsOf(home);
		// 预置一份带未知键与既有审批条目的文件：补丁不认识的东西必须原样幸存。
		writeFileSync(
			toolsJsonOf(home),
			`${JSON.stringify({ custom: "keep", approval: { grep: true } }, null, "\t")}\n`,
			"utf8",
		);

		manager.applyToolDefaults({ approval: { bash: false } });
		let view = manager.toolDefaults();
		check("approval 补丁合并进已有条目", view.approval.grep === true && view.approval.bash === false, JSON.stringify(view.approval));
		check("approval 缺键补默认", view.approval.write === STANDARD_APPROVAL.write, JSON.stringify(view.approval));
		check("未知键原样保留", readJson(toolsJsonOf(home)).custom === "keep", JSON.stringify(readJson(toolsJsonOf(home))));
		check(
			"没点名的字段不长出来",
			view.tools === undefined && view.modes === undefined && view.bash.defaultTimeoutMs === 120_000,
			JSON.stringify(view),
		);

		manager.applyToolDefaults({ tools: ["read", "grep"] });
		view = manager.toolDefaults();
		check("tools 整份列表替换", JSON.stringify(view.tools) === JSON.stringify(["read", "grep"]), JSON.stringify(view.tools));

		manager.applyToolDefaults({ modes: [{ name: "只读", tools: ["read"], approval: {} }] });
		view = manager.toolDefaults();
		check("modes 整份列表替换", view.modes?.length === 1 && view.modes[0]?.tools.length === 1, JSON.stringify(view.modes));
		check("modes 的审批缺键补默认", view.modes?.[0]?.approval.bash === STANDARD_APPROVAL.bash, JSON.stringify(view.modes));

		manager.applyToolDefaults({ bash: { defaultTimeoutMs: 5_000 } });
		view = manager.toolDefaults();
		check("bash 嵌套合并不整份替换", view.bash.defaultTimeoutMs === 5_000 && view.bash.maxTimeoutMs === 3_600_000, JSON.stringify(view.bash));
		check("先前的 approval 补丁还在", view.approval.bash === false && view.approval.grep === true, JSON.stringify(view.approval));

		// 空补丁一支笔都不落。
		const before = readFileSync(toolsJsonOf(home), "utf8");
		manager.applyToolDefaults({});
		check("空补丁不写盘", readFileSync(toolsJsonOf(home), "utf8") === before);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// --------------------------------- 4. 写前重读：手编的文件不被无关补丁回滚

process.stdout.write("\ntools.json：写前重读，进程外的手编不被下一次补丁回滚\n");

{
	const home = mkHome();
	try {
		const manager = toolsOf(home);
		manager.applyToolDefaults({ approval: { bash: false } });

		// 进程外的一只手：模拟用户在两次补丁之间用编辑器改了文件。
		const path = toolsJsonOf(home);
		const handEdited = readJson(path);
		handEdited.approval = { ...(handEdited.approval as Record<string, boolean>), grep: true };
		handEdited.custom = "keep";
		writeFileSync(path, `${JSON.stringify(handEdited, null, "\t")}\n`, "utf8");

		manager.applyToolDefaults({ approval: { bash: true } });
		const onDisk = readJson(path);
		check(
			"写前重读保住手编条目",
			(onDisk.approval as Record<string, unknown>).grep === true && (onDisk.approval as Record<string, unknown>).bash === true && onDisk.custom === "keep",
			JSON.stringify(onDisk),
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// --------------------------------- 5. 零参工厂：默认 home 照常建表，不触碰机器文件

process.stdout.write("\ntools.json：零参 createToolManager 在默认 home 照常建表\n");

{
	// names()/get() 只触常驻实例表，不读 tools.json——机器自己的文件因此不被碰。
	const manager = toolsOf(mkdtempSync(join(tmpdir(), "my-agent-tool-settings-zero-")));
	check("零参工厂照常建表", manager.names().length === 6 && manager.get("bash") !== undefined, JSON.stringify(manager.names()));
}

process.stdout.write(failures === 0 ? "\ntool settings ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
