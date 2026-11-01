// Settings smoke: drives the settings operations over real files in a scratch agent home, and
// checks the property the sidebar's paging decision leans on — that the per-workspace paging state
// survives a full serialization → restore round trip. The state is written through one bag and read
// back by a *fresh* fill over the same paths, so it has to come back through
// JSON.stringify → parse → mergeSettings, which an in-memory layer would skip.
// Nothing here reaches the network, so no server and no provider key are needed.
// Run with: node scripts/smoke-settings.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applySettings,
	clampWorkspacePaging,
	fillSettings,
	getAppearance,
	getModel,
	getSettings,
	settingsPath,
	settingsStateFromStorage,
	SettingsManager,
} from "@my-agent/core";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

// ------------------------------------------------- 1. write → re-read → state intact

process.stdout.write("\nsettings：收展状态跟着 appearance 走一遍真实的序列化\n");

{
	// A scratch agent home, deleted with the block: the state is pointed at it explicitly rather
	// than through MY_AGENT_HOME, so the machine's own settings are never read or written.
	const home = mkdtempSync(join(tmpdir(), "my-agent-settings-"));
	try {
		const absCwd = join(home, "workspace");
		const settings = fillSettings(absCwd, home);

		// The window's write, as main.ts's setPaging sends it: one workspace read down to page 2,
		// one folded away to its heading.
		applySettings(settings, {
			appearance: {
				workspaces: {
					"/w/one": { collapsed: false, page: 2, savedPage: 2 },
					"/w/two": { collapsed: true, page: 1, savedPage: 3 },
				},
			},
		});

		// A fresh fill over the same files — what the next launch reads. The three fields must
		// each come back: the page the view was on, the page the collapse saved, and the fold.
		const restored = getAppearance(fillSettings(absCwd, home));
		check("重读的 appearance 还带着 workspaces", restored.workspaces !== undefined, JSON.stringify(restored));
		check("第一个工作区的页码原样回来", restored.workspaces?.["/w/one"]?.page === 2 && restored.workspaces?.["/w/one"]?.savedPage === 2, JSON.stringify(restored.workspaces));
		check("第二个工作区收着、记忆在第 3 页", restored.workspaces?.["/w/two"]?.collapsed === true && restored.workspaces?.["/w/two"]?.savedPage === 3, JSON.stringify(restored.workspaces));

		// The file actually holds it — the in-memory copy would pass even if the write
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
		const absCwd = join(home, "workspace");
		const settings = fillSettings(absCwd, home);

		// A theme change must not manufacture a workspaces field: an appearance the user never paged
		// keeps no entry, by the same rule the two widths follow.
		applySettings(settings, { appearance: { theme: "dark" } });
		check("只改主题不长出 workspaces", getAppearance(fillSettings(absCwd, home)).workspaces === undefined, JSON.stringify(getAppearance(fillSettings(absCwd, home))));

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
		const reread = getAppearance(fillSettings(absCwd, home)).workspaces;
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
		const absCwd = join(home, "workspace");
		const settings = fillSettings(absCwd, home);

		// The panel's write, as the modes tab sends it: one saved mode, the whole list at once.
		applySettings(settings, {
			modes: [{ name: "只读", tools: ["read", "glob", "grep"], approval: { bash: false, write: false, edit: false } }],
		});
		const restored = getSettings(fillSettings(absCwd, home));
		check("重读的 modes 还带着那一个", restored.modes?.length === 1 && restored.modes[0]!.name === "只读", JSON.stringify(restored.modes));
		check("工具集整份回来", JSON.stringify(restored.modes?.[0]!.tools) === JSON.stringify(["read", "glob", "grep"]), JSON.stringify(restored.modes));
		check("审批补齐了没写的键", restored.modes?.[0]!.approval.read === false && restored.modes?.[0]!.approval.bash === false, JSON.stringify(restored.modes));

		// An absent modes field must never be manufactured by an unrelated patch — the same rule the
		// two widths and the paging state follow.
		const fresh = mkdtempSync(join(tmpdir(), "my-agent-settings-"));
		try {
			const other = fillSettings(join(fresh, "workspace"), fresh);
			applySettings(other, { model: "a/b" });
			check("只改模型不长出 modes", getSettings(fillSettings(join(fresh, "workspace"), fresh)).modes === undefined);
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
		const reread = getSettings(fillSettings(absCwd, home)).modes;
		check("坏条目被丢、重名留第一份", JSON.stringify(reread?.map((mode) => mode.name)) === JSON.stringify(["好的", "空的"]), JSON.stringify(reread));
		check("好条目的审批落到标准默认", reread?.[0]!.approval.write === true && reread?.[0]!.approval.read === false, JSON.stringify(reread));
		check("空工具集是选择，不是缺失", reread?.[1]!.tools.length === 0 && reread?.[1]!.approval.bash === true, JSON.stringify(reread));

		// Deleting every mode is also a choice: the empty list survives, and is not read as "no field".
		applySettings(settings, { modes: [] });
		check("清空后是空表而不是字段消失", JSON.stringify(getSettings(fillSettings(absCwd, home)).modes) === "[]");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// --------------------------------- 4. the seeded-default marker survives a real restart

process.stdout.write("\nsettings：种过默认模型的标记活过一次重启\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-settings-"));
	try {
		const absCwd = join(home, "workspace");
		const settings = fillSettings(absCwd, home);
		// Never written is its own state — the old file's and the fresh machine's — so the window can
		// tell "no window ever offered the row" from "the user deleted it".
		check("没写过时没有标记", getSettings(settings).defaultModelSeeded === undefined, String(getSettings(settings).defaultModelSeeded));

		applySettings(settings, { defaultModelSeeded: true });
		check("写下去之后当场为真", getSettings(settings).defaultModelSeeded === true, String(getSettings(settings).defaultModelSeeded));

		// A fresh fill over the same file is what the next launch reads: the marker must come back
		// through JSON → mergeSettings, or the planted row the user deleted would be planted again.
		check(
			"新进程从文件里读回真",
			getSettings(fillSettings(absCwd, home)).defaultModelSeeded === true,
			String(getSettings(fillSettings(absCwd, home)).defaultModelSeeded),
		);
		const onDisk = JSON.parse(readFileSync(settingsPath(home), "utf8")) as Record<string, unknown>;
		check("磁盘上就写着这个字段", onDisk.defaultModelSeeded === true, JSON.stringify(onDisk.defaultModelSeeded));

		// A hand edit asking for the offer again is representable: `false` is kept rather than read as
		// an absence, which would be the same thing here but not in the merge's own terms.
		applySettings(settings, { defaultModelSeeded: false });
		check("手写的假也留得住", getSettings(fillSettings(absCwd, home)).defaultModelSeeded === false, String(getSettings(fillSettings(absCwd, home)).defaultModelSeeded));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// --------------------------------- 5. the stateless form and the service's cache

process.stdout.write("\nsettings：无状态面用裸 SettingsState 走同一套读写,服务缓存共享同一引用\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-settings-"));
	try {
		const absCwd = join(home, "workspace");
		// fillSettings takes the workspace root as its seed and reads both json files into the bag —
		// the same two files the service's `stateOf` reads, reached without the cache.
		const s = fillSettings(absCwd, home);
		check("种子路径读出空默认", getSettings(s).modes === undefined, JSON.stringify(getSettings(s)));

		// The write path works on the bare state: field-to-file routing and the disk write are the
		// stateless operation's own, none of a shell's.
		applySettings(s, { modes: [{ name: "只读", tools: ["read"], approval: {} }] });
		check("补齐后的 modes 当场可读", getSettings(s).modes?.length === 1, JSON.stringify(getSettings(s).modes));

		// A replay from the same seed must land on the same merged view — that is what lets a host
		// re-fill a workspace's state at any time without losing a write.
		const replayed = fillSettings(absCwd, home);
		check("重灌的种子读回同一份", JSON.stringify(getSettings(replayed)) === JSON.stringify(getSettings(s)));

		// The service's cache is the sharing point: the first touch fills, and every touch after
		// answers the same object, so a write through the bare state is the value the service reads.
		const service = new SettingsManager();
		const cached = service.stateOf(absCwd, home);
		check("同一次触碰拿到同一引用", service.stateOf(absCwd, home) === cached, "");
		applySettings(cached, { model: "a/b" });
		check("写穿缓存,服务的袋跟上了", getModel(cached) === "a/b", String(getModel(cached)));
		// The cache is keyed by the agent home as well as the root: another home over the same root
		// is another workspace's files, and must not answer this one's merge.
		const other = new SettingsManager();
		const otherHome = mkdtempSync(join(tmpdir(), "my-agent-settings-other-"));
		try {
			check("另一个家是另一只袋", other.stateOf(absCwd, otherHome) !== cached, "");
		} finally {
			rmSync(otherHome, { recursive: true, force: true });
		}

		// A fresh fill over the same files reads the write back — the disk is what a restart reads.
		check("重灌读回写盘的模型", getModel(fillSettings(absCwd, home)) === "a/b", String(getModel(fillSettings(absCwd, home))));

		// The storage seam is still injectable: a host keeping settings somewhere else builds the
		// state from its own backend rather than from the two real files.
		const overMemory = settingsStateFromStorage({
			read: (scope) => (scope === "global" ? `${JSON.stringify({ tools: ["read"] }, null, "\t")}\n` : undefined),
			write: () => {},
			path: (scope) => `<fake ${scope}>`,
		});
		check("自备存储读出工具集", JSON.stringify(getSettings(overMemory).tools) === JSON.stringify(["read"]));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

process.stdout.write(failures === 0 ? "\nsettings ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
