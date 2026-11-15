// Settings smoke：对一个临时 agent home 里的真实文件驱动 settings 操作，并检查侧栏分页决策
// 所依赖的性质——每目录的分页状态要能完整走过序列化 → 恢复的往返。写入经由同一个 SettingManager
// 完成，再用对相同路径的*全新*读读回，因此必须能穿过 JSON.stringify → parse → mergeSettings
// 回来——内存层会把这一步跳掉。
// 这里不触网，无需服务器和 provider key。
// 运行：node scripts/smoke-settings.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clampDirectoryPaging,
	createSession,
	DEFAULT_GLOBAL_SETTINGS,
	inMemorySettingManager,
	isUnconfigured,
	resolveSettings,
	SessionManager,
	settingsPath,
	type ModelConfig,
	type Session,
	SettingManager,
} from "@my-agent/core";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

// ------------------------------------------------- 1. 写 → 重读 → 状态完好

process.stdout.write("\nsettings：收展状态跟着 appearance 走一遍真实的序列化\n");

{
	// 一个临时 agent home，随本块一起删除：manager 被显式指到它上面，而不是经由 MY_AGENT_HOME，
	// 机器自己的设置永远不会被读或写。
	const home = mkdtempSync(join(tmpdir(), "my-agent-settings-"));
	try {
		const manager = new SettingManager({ home });

		// 窗口的写入，按 main.ts 的 setPaging 发出的形状：一个目录读到第 2 页，一个收起到标题。
		manager.applySettings({
			appearance: {
				directories: {
					"/w/one": { collapsed: false, page: 2, savedPage: 2 },
					"/w/two": { collapsed: true, page: 1, savedPage: 3 },
				},
			},
		});

		// 对相同文件的一次全新读——下次启动读到的东西。三个字段必须各自回来：视图所在的页、
		// 收起时保存的页，以及收起本身。
		const restored = manager.getSettings().appearance;
		check("重读的 appearance 还带着 directories", restored.directories !== undefined, JSON.stringify(restored));
		check("第一个目录的页码原样回来", restored.directories?.["/w/one"]?.page === 2 && restored.directories?.["/w/one"]?.savedPage === 2, JSON.stringify(restored.directories));
		check("第二个目录收着、记忆在第 3 页", restored.directories?.["/w/two"]?.collapsed === true && restored.directories?.["/w/two"]?.savedPage === 3, JSON.stringify(restored.directories));

		// 文件本身真的持有它——就算写入丢了，内存副本也会通过检查，而文件才是第二个进程读的东西。
		const onDisk = JSON.parse(readFileSync(settingsPath(home), "utf8")) as { appearance?: { directories?: unknown } };
		check("磁盘上的 settings.json 写着同一份", onDisk.appearance?.directories !== undefined, JSON.stringify(onDisk));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 2. 从不造假，坏条目按条丢

process.stdout.write("\nsettings：没动过的目录不造假，写坏了的条目按条丢\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-settings-"));
	try {
		const manager = new SettingManager({ home });

		// 改主题不得造出一个 directories 字段：用户从未分页的 appearance 不留条目，与两个宽度
		// 字段遵循同一条规则。
		manager.applySettings({ appearance: { theme: "dark" } });
		check("只改主题不长出 directories", manager.getSettings().appearance.directories === undefined, JSON.stringify(manager.getSettings().appearance));

		// 手编的坏数据：文件是手可写的，一条坏条目单独被丢，不得连累好条目——也不能让空结果
		// 恢复存在。
		const path = settingsPath(home);
		const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		written.appearance = {
			...(written.appearance as Record<string, unknown>),
			directories: {
				"/w/good": { collapsed: false, page: 4, savedPage: 9 },
				"/w/bad": "不是一条记录",
				"": { collapsed: true, page: 1, savedPage: 1 },
			},
		};
		writeFileSync(path, `${JSON.stringify(written, null, "\t")}\n`, "utf8");
		const reread = manager.getSettings().appearance.directories;
		check("坏条目被丢、好条目还在", JSON.stringify(Object.keys(reread ?? {})) === JSON.stringify(["/w/good"]), JSON.stringify(reread));
		check("好条目的数字没被改", reread?.["/w/good"]?.page === 4 && reread?.["/w/good"]?.savedPage === 9, JSON.stringify(reread));

		// REST patch 用的规范化器，直接驱动：不是正整数的页码计数器落回第一页，而不是被相信。
		const clamped = clampDirectoryPaging({ "/w/x": { collapsed: true, page: 0, savedPage: "two" } });
		check("坏页码落回第一页", clamped?.["/w/x"]?.page === 1 && clamped?.["/w/x"]?.savedPage === 1, JSON.stringify(clamped));
		check("整个字段不是记录时是 undefined", clampDirectoryPaging("不是记录") === undefined, String(clampDirectoryPaging("不是记录")));
		check("空记录钳成 undefined 而不是空表", clampDirectoryPaging({}) === undefined, String(clampDirectoryPaging({})));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ------------------------------------------------- 3. modes 往返

process.stdout.write("\nsettings：模式跟着整表设置走一遍真实的序列化\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-settings-"));
	try {
		const manager = new SettingManager({ home });

		// 面板的写入，按 modes 页签发出的形状：一个保存的模式，整表一次写入。
		manager.applySettings({
			modes: [{ name: "只读", tools: ["read", "glob", "grep"], approval: { bash: false, write: false, edit: false } }],
		});
		const restored = manager.getSettings();
		check("重读的 modes 还带着那一个", restored.modes?.length === 1 && restored.modes[0]!.name === "只读", JSON.stringify(restored.modes));
		check("工具集整份回来", JSON.stringify(restored.modes?.[0]!.tools) === JSON.stringify(["read", "glob", "grep"]), JSON.stringify(restored.modes));
		check("审批补齐了没写的键", restored.modes?.[0]!.approval.read === false && restored.modes?.[0]!.approval.bash === false, JSON.stringify(restored.modes));

		// 缺席的 modes 字段绝不能被一个不相关的 patch 造出来——两个宽度字段与分页状态遵循的
		// 同一条规则。
		const fresh = mkdtempSync(join(tmpdir(), "my-agent-settings-"));
		try {
			const other = new SettingManager({ home: fresh });
			other.applySettings({ model: "a/b" });
			check("只改模型不长出 modes", other.getSettings().modes === undefined);
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}

		// 手编的坏数据：一条坏模式单独被丢，重名保留第一份，显式空列表是一次要存活的选择。
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
		const reread = manager.getSettings().modes;
		check("坏条目被丢、重名留第一份", JSON.stringify(reread?.map((mode) => mode.name)) === JSON.stringify(["好的", "空的"]), JSON.stringify(reread));
		check("好条目的审批落到标准默认", reread?.[0]!.approval.write === true && reread?.[0]!.approval.read === false, JSON.stringify(reread));
		check("空工具集是选择，不是缺失", reread?.[1]!.tools.length === 0 && reread?.[1]!.approval.bash === true, JSON.stringify(reread));

		// 删掉所有模式也是一次选择：空列表存活，不被读成"没有字段"。
		manager.applySettings({ modes: [] });
		check("清空后是空表而不是字段消失", JSON.stringify(manager.getSettings().modes) === "[]");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// --------------------------------- 4. 种过默认模型的标记活过一次真实重启

process.stdout.write("\nsettings：种过默认模型的标记活过一次重启\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-settings-"));
	try {
		const manager = new SettingManager({ home });
		// 从未写入是它自己的状态——旧文件的、新机器的——窗口因此能区分"从没有窗口提供过这一行"
		// 与"用户删掉了它"。
		check("没写过时没有标记", manager.getSettings().defaultModelSeeded === undefined, String(manager.getSettings().defaultModelSeeded));

		manager.applySettings({ defaultModelSeeded: true });
		check("写下去之后当场为真", manager.getSettings().defaultModelSeeded === true, String(manager.getSettings().defaultModelSeeded));

		// 对同一文件的全新读就是下次启动读到的东西：标记必须能穿过 JSON → mergeSettings 回来，
		// 否则用户删掉的种下行会被再次种上。
		check(
			"新进程从文件里读回真",
			manager.getSettings().defaultModelSeeded === true,
			String(manager.getSettings().defaultModelSeeded),
		);
		const onDisk = JSON.parse(readFileSync(settingsPath(home), "utf8")) as Record<string, unknown>;
		check("磁盘上就写着这个字段", onDisk.defaultModelSeeded === true, JSON.stringify(onDisk.defaultModelSeeded));

		// 手编要求再次提供是可以表示的：`false` 被保留而不是被读成缺席——在本例中那是一回事，
		// 但在 merge 自己的语义里不是。
		manager.applySettings({ defaultModelSeeded: false });
		check("手写的假也留得住", manager.getSettings().defaultModelSeeded === false, String(manager.getSettings().defaultModelSeeded));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// --------------------------------- 5. 无状态形态：写、重读、另一个家

process.stdout.write("\nsettings：无状态门面每次现读磁盘，写下去当场可读\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-settings-"));
	try {
		// manager 每次调用都读同一个 json 文件——截至本次调用的全新快照，背后没有任何缓存。
		const manager = new SettingManager({ home });
		check("新 home 读出空默认", manager.getSettings().modes === undefined, JSON.stringify(manager.getSettings()));

		// 写路径是 manager 自己的：字段到文件的路由和落盘写都发生在这里，没有外壳的任何参与。
		manager.applySettings({ modes: [{ name: "只读", tools: ["read"], approval: {} }] });
		check("补齐后的 modes 当场可读", manager.getSettings().modes?.length === 1, JSON.stringify(manager.getSettings().modes));

		// 没有任何缓存：两次读是同一份文件的两次独立读，所以写落到磁盘上后，之后的每次调用
		// ——这只 manager 或建在同一 home 上的另一只——都以它作答。
		manager.applySettings({ model: "a/b" });
		check("写下去当场可读", manager.getSettings().model === "a/b", String(manager.getSettings().model));
		check("第二只 manager 读回写盘的模型", new SettingManager({ home }).getSettings().model === "a/b", String(new SettingManager({ home }).getSettings().model));

		// agent home 是构造参数，不是缓存键：建在另一个 home 上的 manager 读那个 home 的全局
		// 文件，永远不以这个 home 的文件作答。
		const otherHome = mkdtempSync(join(tmpdir(), "my-agent-settings-other-"));
		try {
			const other = new SettingManager({ home: otherHome });
			check("另一个家读不到这只家的文件", other.getSettings().model === undefined, String(other.getSettings().model));
		} finally {
			rmSync(otherHome, { recursive: true, force: true });
		}

		// 存储接缝仍然可注入：把 settings 放在别处的 host 经由自己的后端读写，而不是经由
		// 真实文件。
		const overMemory = new SettingManager({
			storage: {
				read: () => `${JSON.stringify({ tools: ["read"] }, null, "\t")}\n`,
				write: () => {},
				path: () => "<fake settings>",
			},
		});
		check("自备存储读出工具集", JSON.stringify(overMemory.getSettings().tools) === JSON.stringify(["read"]));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// --------------------------------- 6. 两半组合：resolveSettings

process.stdout.write("\nsettings：global 与 session 两半组合成下游用的那一份（ADR-0019）\n");

{
	const workRoot = mkdtempSync(join(tmpdir(), "my-agent-settings-resolve-"));
	try {
		const store = new SessionManager();
		const known = ["read", "write", "edit", "glob", "grep", "bash"];
		const rows: ModelConfig[] = [
			{ id: "b-1", name: "b", baseUrl: "http://x/v1", contextWindow: 128_000, maxTokens: 8_192 },
			{ id: "a-1", name: "a", baseUrl: "http://x/v1", contextWindow: 128_000, maxTokens: 8_192 },
		];
		const bag = (): Session => createSession(workRoot, join(workRoot, "store"));

		// 会话记录了 b/high：组合出的模型行就是 b 那一行的完整事实——端点、窗口都随行而来，
		// 会话快照上仍然只有选择的名字与档位。
		const chosenSession = bag();
		store.setModel(chosenSession, "b", "b-1");
		store.setThinkingLevel(chosenSession, "high");
		const chosen = resolveSettings(chosenSession, DEFAULT_GLOBAL_SETTINGS, rows, known);
		check("记录的选择解析到完整行", chosen.model.config.id === "b-1" && chosen.model.config.name === "b", JSON.stringify(chosen.model));
		check("档位原样带过来", chosen.model.thinkingLevel === "high", String(chosen.model.thinkingLevel));

		// 没记录的会话回落到设置的默认行；设置没指名时回落内置默认行，再其次第一行。
		const plain = bag();
		const withDefault = resolveSettings(plain, { ...DEFAULT_GLOBAL_SETTINGS, model: "a" }, rows, known);
		check("设置的默认行是第二级", withDefault.model.config.name === "a", withDefault.model.config.name);
		const fallback = resolveSettings(plain, DEFAULT_GLOBAL_SETTINGS, rows, known);
		check("目录里没有内置默认行时落到第一行", fallback.model.config.name === "b", fallback.model.config.name);

		// （ADR-0021 收走了第四参：「打开时指名的行」随未出生袋一起删除，不再是 resolveSettings
		// 的输入——出生的选择由 createAndPrompt 在装配之前落到快照上，组合的
		// 回落链只剩记录的选择 → 设置默认行 → 内置默认行 → 第一行。）

		// 一行都没有的机器得到占位行，而不是一次异常：拒绝发送的是传输层。
		const empty = resolveSettings(plain, DEFAULT_GLOBAL_SETTINGS, [], known);
		check("无行目录得到占位行", isUnconfigured(empty.model.config), empty.model.config.name);

		// 模式指针：global 的 modes 表是工具集与审批基线的唯一来处；表改了内容，指向它的会话跟着变。
		const settings = inMemorySettingManager(
			{ tools: ["read", "bash"], modes: [{ name: "reader", tools: ["read"], approval: { bash: true } }] },
			[],
		);
		const pointed = bag();
		store.setMode(pointed, "reader");
		const reader = resolveSettings(pointed, settings.getSettings(), rows, known);
		check("指针解析出预设的工具集", JSON.stringify(reader.tools) === JSON.stringify(["read"]), JSON.stringify(reader.tools));
		check("座位就是指针", reader.mode === "reader", reader.mode);
		check("预设的审批是基线", reader.approval.bash === true && reader.approval.write === true, JSON.stringify(reader.approval));

		settings.applySettings({ modes: [{ name: "reader", tools: ["read", "grep"], approval: { bash: true } }] });
		check("表改了内容会话跟着变", JSON.stringify(resolveSettings(pointed, settings.getSettings(), rows, known).tools) === JSON.stringify(["read", "grep"]));

		// 会话自己的增量叠在基线之上：预设闸着 bash，会话明确放行。
		store.setApprovalOverride(pointed, { bash: false });
		const withDelta = resolveSettings(pointed, settings.getSettings(), rows, known);
		check("会话的增量叠在基线之上", withDelta.approval.bash === false, JSON.stringify(withDelta.approval));

		// 悬空的指针——模式被删了——读作默认，但指针保留在快照上：模式再出生时重新挂上。
		settings.applySettings({ modes: [] });
		const dangling = resolveSettings(pointed, settings.getSettings(), rows, known);
		check("悬空的指针读作默认", dangling.mode === undefined && JSON.stringify(dangling.tools) === JSON.stringify(["read", "bash"]), JSON.stringify(dangling.tools));
		check("但指针保留在快照上", store.getRecordedToolConfig(pointed).mode === "reader", store.getRecordedToolConfig(pointed).mode);
	} finally {
		rmSync(workRoot, { recursive: true, force: true });
	}
}

process.stdout.write(failures === 0 ? "\nsettings ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
