// UI 设置持有者 smoke：对临时 agent home 里的真实文件驱动 uiSettings / applyUiSettings，检查
// 设置归属重构（spec §4.2/§4.3）交给 ui.json 的性质——旧 settings.json 的一次性迁移、写路径只动
// 点名字段、写前重读。写入经由 UiSettingsManager 完成，再用对相同路径的*全新*读读回，因此必须能
// 穿过 JSON.stringify → parse → 规范化回来。
// 这里不触网，无需服务器和 provider key。
// 运行：node scripts/smoke-ui-settings.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clampContentWidth,
	clampDirectoryPaging,
	clampFontSize,
	clampSidebarWidth,
	settingsPath,
	UiSettingsManager,
} from "@my-agent/core";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

function homeWithFiles(files: Record<string, string>): string {
	const home = mkdtempSync(join(tmpdir(), "my-agent-ui-settings-"));
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(home, name), content, "utf8");
	}
	return home;
}

function uiPath(home: string): string {
	return join(home, "ui.json");
}

// ------------------------------------------------- 1. 首读迁移：从旧 settings.json 捡走 UI 簇

process.stdout.write("\nui：ui.json 不存在而旧 settings.json 在——首读迁移，补默认后的视图落盘\n");

{
	const legacyText = `${JSON.stringify(
		{
			model: "a/b",
			appearance: {
				theme: "light",
				fontSize: 14,
				sidebarWidth: 300,
				directories: {
					"/w/one": { collapsed: false, page: 2, savedPage: 2 },
					"/w/bad": "不是一条记录",
				},
			},
			hiddenDirectories: ["/w/a", "", 42],
			directoryNames: { "/w/a": "备查", "": "空键" },
		},
		null,
		"\t",
	)}\n`;
	const home = homeWithFiles({ "settings.json": legacyText });
	try {
		const manager = new UiSettingsManager({ home });
		const view = manager.uiSettings();

		check("ui.json 已被写出", existsSync(uiPath(home)), uiPath(home));
		check("外观跟着旧文件走", view.appearance.theme === "light" && view.appearance.fontSize === 14, JSON.stringify(view));
		check("拖过的宽度被捡走", view.appearance.sidebarWidth === 300, JSON.stringify(view.appearance));
		check("坏分页条目被丢、好条目还在", JSON.stringify(Object.keys(view.appearance.directories ?? {})) === JSON.stringify(["/w/one"]), JSON.stringify(view.appearance.directories));
		check("隐藏目录清掉坏条目", JSON.stringify(view.hiddenDirectories) === JSON.stringify(["/w/a"]), JSON.stringify(view.hiddenDirectories));
		check("目录名字清掉空键", JSON.stringify(view.directoryNames) === JSON.stringify({ "/w/a": "备查" }), JSON.stringify(view.directoryNames));

		// 落盘的是补默认后的视图，不是旧文件的切片：第二次读（或第二个进程）直接从 ui.json 作答。
		const onDisk = JSON.parse(readFileSync(uiPath(home), "utf8")) as Record<string, unknown>;
		check("磁盘上的 ui.json 带着 appearance", typeof onDisk.appearance === "object", JSON.stringify(onDisk));
		check("迁移不捡别的簇", onDisk.model === undefined && onDisk.hiddenDirectories !== undefined, JSON.stringify(onDisk));

		// 旧文件永不删除、永不写入：一个字节都不动。
		check("旧 settings.json 原样保留", readFileSync(settingsPath(home), "utf8") === legacyText, "旧文件被改动");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 2. 簇字段全缺省也要写出文件

process.stdout.write("\nui：旧文件里没有任何 UI 字段——迁移照样落盘，把「迁移过」变成磁盘事实\n");

{
	const legacyText = `${JSON.stringify({ model: "a/b" }, null, "\t")}\n`;
	const home = homeWithFiles({ "settings.json": legacyText });
	try {
		const view = new UiSettingsManager({ home }).uiSettings();
		check("ui.json 仍被写出", existsSync(uiPath(home)), uiPath(home));
		check("外观落到默认", view.appearance.theme === "dark" && view.appearance.fontSize === 15, JSON.stringify(view));
		check("从未表达过的偏好不被造出来", view.appearance.sidebarWidth === undefined && view.hiddenDirectories === undefined && view.directoryNames === undefined, JSON.stringify(view));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 3. ui.json 已存在：旧文件被完全忽略

process.stdout.write("\nui：ui.json 已存在——旧 settings.json 被忽略，读取也不重写 ui.json\n");

{
	const uiText = `${JSON.stringify({ appearance: { theme: "light", fontSize: 12 } }, null, "\t")}\n`;
	const legacyText = `${JSON.stringify({ appearance: { theme: "dark", fontSize: 20 }, hiddenDirectories: ["/w/legacy"] }, null, "\t")}\n`;
	const home = homeWithFiles({ "ui.json": uiText, "settings.json": legacyText });
	try {
		const view = new UiSettingsManager({ home }).uiSettings();
		check("读到的是 ui.json 的外观", view.appearance.theme === "light" && view.appearance.fontSize === 12, JSON.stringify(view));
		check("旧文件的隐藏目录不复活", view.hiddenDirectories === undefined, JSON.stringify(view.hiddenDirectories));
		check("读取不重写 ui.json", readFileSync(uiPath(home), "utf8") === uiText, "ui.json 被重写");
		check("旧 settings.json 原样保留", readFileSync(settingsPath(home), "utf8") === legacyText, "旧文件被改动");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 4. 写路径：只动点名字段，未知键保留

process.stdout.write("\nui：applyUiSettings 只动点名字段——appearance 嵌套合并、列表整体替换\n");

{
	const home = homeWithFiles({
		"ui.json": `${JSON.stringify(
			{
				appearance: {
					theme: "light",
					fontSize: 14,
					directories: { "/w/one": { collapsed: false, page: 2, savedPage: 2 } },
				},
				hiddenDirectories: ["/w/old"],
				directoryNames: { "/w/a": "旧名" },
				unknownKey: { keep: true },
			},
			null,
			"\t",
		)}\n`,
	});
	try {
		const manager = new UiSettingsManager({ home });

		// appearance 是嵌套合并：点名的 theme 挪动，同在 appearance 里的字号与分页原样不动。
		manager.applyUiSettings({ appearance: { theme: "dark" } });
		let view = manager.uiSettings();
		check("点名的主题挪动", view.appearance.theme === "dark", JSON.stringify(view.appearance));
		check("没点名的字号原地不动", view.appearance.fontSize === 14, JSON.stringify(view.appearance));
		check("没点名的分页原地不动", view.appearance.directories?.["/w/one"]?.page === 2, JSON.stringify(view.appearance.directories));
		check("没点名的列表原地不动", JSON.stringify(view.hiddenDirectories) === JSON.stringify(["/w/old"]), JSON.stringify(view.hiddenDirectories));

		// 列表整体替换：这个设置就是那一份集合，多藏一个目录就是列表多一条。名字映射按键合并——
		// 补丁携带它变更的条目，空字符串收回一个名字（与 SettingManager.applySettings 逐字段一致）。
		manager.applyUiSettings({ hiddenDirectories: ["/w/new", "/w/other"], directoryNames: { "/w/b": "新名" } });
		view = manager.uiSettings();
		check("隐藏目录整体替换", JSON.stringify(view.hiddenDirectories) === JSON.stringify(["/w/new", "/w/other"]), JSON.stringify(view.hiddenDirectories));
		check("名字映射按键合并", JSON.stringify(view.directoryNames) === JSON.stringify({ "/w/a": "旧名", "/w/b": "新名" }), JSON.stringify(view.directoryNames));

		// 空字符串是收回一个名字的存储形态，在视图里幸存而不是被丢弃。
		manager.applyUiSettings({ directoryNames: { "/w/a": "" } });
		view = manager.uiSettings();
		check("空字符串收回一个名字", view.directoryNames?.["/w/a"] === "" && view.directoryNames?.["/w/b"] === "新名", JSON.stringify(view.directoryNames));

		// 文件里手编的未知键原样写回，不得被这里的一次变更抹掉。
		const onDisk = JSON.parse(readFileSync(uiPath(home), "utf8")) as Record<string, unknown>;
		check("未知键原样保留", JSON.stringify(onDisk.unknownKey) === JSON.stringify({ keep: true }), JSON.stringify(onDisk));
		check("appearance 之外的簇字段都在磁盘上", onDisk.hiddenDirectories !== undefined && onDisk.directoryNames !== undefined, JSON.stringify(onDisk));

		// 空补丁不动文件。
		const before = readFileSync(uiPath(home), "utf8");
		manager.applyUiSettings({});
		check("空补丁不写盘", readFileSync(uiPath(home), "utf8") === before, "空补丁重写了文件");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 5. 写前重读：手编不被一次无关的变更回滚

process.stdout.write("\nui：写前重读磁盘——进程外敲进文件的键不被这里的一次变更回滚\n");

{
	const home = homeWithFiles({
		"ui.json": `${JSON.stringify(
			{
				appearance: {
					theme: "light",
					fontSize: 14,
					directories: { "/w/one": { collapsed: false, page: 2, savedPage: 2 } },
				},
			},
			null,
			"\t",
		)}\n`,
	});
	try {
		const manager = new UiSettingsManager({ home });

		// 用户在进程运行期间用编辑器改了字号：写路径重读文件，合并发生在磁盘此刻的内容之上。
		const edited = JSON.parse(readFileSync(uiPath(home), "utf8")) as Record<string, unknown>;
		const editedAppearance = edited.appearance as Record<string, unknown>;
		editedAppearance.fontSize = 20;
		writeFileSync(uiPath(home), `${JSON.stringify(edited, null, "\t")}\n`, "utf8");

		manager.applyUiSettings({ appearance: { directories: { "/w/two": { collapsed: true, page: 1, savedPage: 1 } } } });
		const view = manager.uiSettings();
		check("手编的字号幸存", view.appearance.fontSize === 20, JSON.stringify(view.appearance));
		check("手编目录与新目录共存", view.appearance.directories?.["/w/one"]?.page === 2 && view.appearance.directories?.["/w/two"]?.collapsed === true, JSON.stringify(view.appearance.directories));

		// 无状态：同一 home 上的另一只 manager 现读同一份文件，看到的就是刚落盘的。
		const fresh = new UiSettingsManager({ home }).uiSettings();
		check("第二只 manager 读回落盘的视图", fresh.appearance.fontSize === 20 && fresh.appearance.theme === "light", JSON.stringify(fresh));

		// home 是构造参数：另一个家读不到这个家的文件。
		const otherHome = mkdtempSync(join(tmpdir(), "my-agent-ui-settings-other-"));
		try {
			const stranger = new UiSettingsManager({ home: otherHome }).uiSettings();
			check("另一个家落到默认", stranger.appearance.theme === "dark" && stranger.hiddenDirectories === undefined, JSON.stringify(stranger));
		} finally {
			rmSync(otherHome, { recursive: true, force: true });
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 6. clamp* 从新导出源可用

process.stdout.write("\nui：外观规范化纯函数随簇搬进 ui-settings.ts，包对外的名字不变\n");

{
	check("字号钳到上界", clampFontSize(99) === 22, String(clampFontSize(99)));
	check("字号钳到下界", clampFontSize(3) === 10, String(clampFontSize(3)));
	check("坏字号落回默认", clampFontSize("不是数字") === 15, String(clampFontSize("不是数字")));
	check("侧栏宽度钳到界内", clampSidebarWidth(100) === 208 && clampSidebarWidth(999) === 360, `${clampSidebarWidth(100)} ${clampSidebarWidth(999)}`);
	check("从未拖动是 undefined", clampSidebarWidth(undefined) === undefined && clampContentWidth(undefined) === undefined, String(clampSidebarWidth(undefined)));
	check("阅读列宽钳到上界", clampContentWidth(9999) === 1280, String(clampContentWidth(9999)));
	const clamped = clampDirectoryPaging({ "/w/x": { collapsed: true, page: 0, savedPage: "two" } });
	check("坏页码落回第一页", clamped?.["/w/x"]?.page === 1 && clamped?.["/w/x"]?.savedPage === 1, JSON.stringify(clamped));
	check("整个字段不是记录时是 undefined", clampDirectoryPaging("不是记录") === undefined, String(clampDirectoryPaging("不是记录")));
}

process.stdout.write(failures === 0 ? "\nui-settings ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
