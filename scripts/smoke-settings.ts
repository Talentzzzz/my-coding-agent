// Settings smoke: drives the real `SettingsManager` over real files in a scratch agent home, and
// checks the property the sidebar's paging decision leans on — that the per-workspace paging state
// survives a full serialization → restore round trip. The state is written through one manager and
// read back by a *new* manager over the same paths, so it has to come back through
// JSON.stringify → parse → mergeSettings, which an in-memory layer would skip.
// Nothing here reaches the network, so no server and no provider key are needed.
// Run with: node scripts/smoke-settings.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clampWorkspacePaging, settingsPath, SettingsManager } from "@my-agent/core";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

// ------------------------------------------------- 1. write → re-read → state intact

process.stdout.write("\nsettings：收展状态跟着 appearance 走一遍真实的序列化\n");

{
	// A scratch agent home, deleted with the block: the manager is pointed at it explicitly rather
	// than through MY_AGENT_HOME, so the machine's own settings are never read or written.
	const home = mkdtempSync(join(tmpdir(), "my-agent-settings-"));
	try {
		const cwd = join(home, "workspace");
		const manager = SettingsManager.create(cwd, home);

		// The window's write, as main.ts's setPaging sends it: one workspace read down to page 2,
		// one folded away to its heading.
		manager.applySettings({
			appearance: {
				workspaces: {
					"/w/one": { collapsed: false, page: 2, savedPage: 2 },
					"/w/two": { collapsed: true, page: 1, savedPage: 3 },
				},
			},
		});

		// A fresh manager over the same files — what the next launch reads. The three fields must
		// each come back: the page the view was on, the page the collapse saved, and the fold.
		const restored = SettingsManager.create(cwd, home).getAppearance();
		check("重读的 appearance 还带着 workspaces", restored.workspaces !== undefined, JSON.stringify(restored));
		check("第一个工作区的页码原样回来", restored.workspaces?.["/w/one"]?.page === 2 && restored.workspaces?.["/w/one"]?.savedPage === 2, JSON.stringify(restored.workspaces));
		check("第二个工作区收着、记忆在第 3 页", restored.workspaces?.["/w/two"]?.collapsed === true && restored.workspaces?.["/w/two"]?.savedPage === 3, JSON.stringify(restored.workspaces));

		// The file actually holds it — the manager's in-memory copy would pass even if the write
		// were lost, and the file is what a second process reads.
		const onDisk = JSON.parse(readFileSync(settingsPath(home), "utf8")) as { appearance?: { workspaces?: unknown } };
		check("磁盘上的 settings.json 写着同一份", onDisk.appearance?.workspaces !== undefined, JSON.stringify(onDisk));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 2. never manufactured, bad entries dropped

process.stdout.write("\nsettings：没动过的工作区不造假，写坏了的条目按条丢\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-settings-"));
	try {
		const cwd = join(home, "workspace");
		const manager = SettingsManager.create(cwd, home);

		// A theme change must not manufacture a workspaces field: an appearance the user never paged
		// keeps no entry, by the same rule the two widths follow.
		manager.applySettings({ appearance: { theme: "dark" } });
		check("只改主题不长出 workspaces", SettingsManager.create(cwd, home).getAppearance().workspaces === undefined, JSON.stringify(SettingsManager.create(cwd, home).getAppearance()));

		// Hand-edited garbage: the file is writable by hand, so one bad entry is dropped on its own
		// and must not cost the good one its place — nor an empty result its absence.
		const path = settingsPath(home);
		const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		written.appearance = {
			...(written.appearance as Record<string, unknown>),
			workspaces: {
				"/w/good": { collapsed: false, page: 4, savedPage: 9 },
				"/w/bad": "不是一条记录",
				"": { collapsed: true, page: 1, savedPage: 1 },
			},
		};
		writeFileSync(path, `${JSON.stringify(written, null, "\t")}\n`, "utf8");
		const reread = SettingsManager.create(cwd, home).getAppearance().workspaces;
		check("坏条目被丢、好条目还在", JSON.stringify(Object.keys(reread ?? {})) === JSON.stringify(["/w/good"]), JSON.stringify(reread));
		check("好条目的数字没被改", reread?.["/w/good"]?.page === 4 && reread?.["/w/good"]?.savedPage === 9, JSON.stringify(reread));

		// The normalizer the REST patch uses, driven directly: a page counter that is not a positive
		// integer falls back to the first page rather than being believed.
		const clamped = clampWorkspacePaging({ "/w/x": { collapsed: true, page: 0, savedPage: "two" } });
		check("坏页码落回第一页", clamped?.["/w/x"]?.page === 1 && clamped?.["/w/x"]?.savedPage === 1, JSON.stringify(clamped));
		check("整个字段不是记录时是 undefined", clampWorkspacePaging("不是记录") === undefined, String(clampWorkspacePaging("不是记录")));
		check("空记录钳成 undefined 而不是空表", clampWorkspacePaging({}) === undefined, String(clampWorkspacePaging({})));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 3. modes round trip

process.stdout.write("\nsettings：模式跟着整表设置走一遍真实的序列化\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-settings-"));
	try {
		const cwd = join(home, "workspace");
		const manager = SettingsManager.create(cwd, home);

		// The panel's write, as the modes tab sends it: one saved mode, the whole list at once.
		manager.applySettings({
			modes: [{ name: "只读", tools: ["read", "glob", "grep"], approval: { bash: false, write: false, edit: false } }],
		});
		const restored = SettingsManager.create(cwd, home).getSettings();
		check("重读的 modes 还带着那一个", restored.modes?.length === 1 && restored.modes[0]!.name === "只读", JSON.stringify(restored.modes));
		check("工具集整份回来", JSON.stringify(restored.modes?.[0]!.tools) === JSON.stringify(["read", "glob", "grep"]), JSON.stringify(restored.modes));
		check("审批补齐了没写的键", restored.modes?.[0]!.approval.read === false && restored.modes?.[0]!.approval.bash === false, JSON.stringify(restored.modes));

		// An absent modes field must never be manufactured by an unrelated patch — the same rule the
		// two widths and the paging state follow.
		const fresh = mkdtempSync(join(tmpdir(), "my-agent-settings-"));
		try {
			const other = SettingsManager.create(join(fresh, "workspace"), fresh);
			other.applySettings({ model: "a/b" });
			check("只改模型不长出 modes", SettingsManager.create(join(fresh, "workspace"), fresh).getSettings().modes === undefined);
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}

		// Hand-edited garbage: one bad mode is dropped on its own, a duplicate name keeps the first,
		// and an explicit empty list is a choice that survives.
		const path = settingsPath(home);
		const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		written.modes = [
			{ name: "好的", tools: ["read"], approval: {} },
			"不是一条记录",
			{ tools: ["read"], approval: {} },
			{ name: "好的", tools: ["bash"], approval: {} },
			{ name: "空的", tools: [], approval: { bash: true } },
		];
		writeFileSync(path, `${JSON.stringify(written, null, "\t")}\n`, "utf8");
		const reread = SettingsManager.create(cwd, home).getSettings().modes;
		check("坏条目被丢、重名留第一份", JSON.stringify(reread?.map((mode) => mode.name)) === JSON.stringify(["好的", "空的"]), JSON.stringify(reread));
		check("好条目的审批落到标准默认", reread?.[0]!.approval.write === true && reread?.[0]!.approval.read === false, JSON.stringify(reread));
		check("空工具集是选择，不是缺失", reread?.[1]!.tools.length === 0 && reread?.[1]!.approval.bash === true, JSON.stringify(reread));

		// Deleting every mode is also a choice: the empty list survives, and is not read as "no field".
		manager.applySettings({ modes: [] });
		check("清空后是空表而不是字段消失", JSON.stringify(SettingsManager.create(cwd, home).getSettings().modes) === "[]");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

process.stdout.write(failures === 0 ? "\nsettings ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
