// Settings smoke：ADR-0019 组合视图（resolveSettings）的行为测试。
//
// 设置归属重构后，组合视图的输入换成两个窄来源——ToolManager 的一次现读（toolDefaults）与
// ModelManager 的一次现读（rows + defaultRef）——本文件钉住的就是这条解析链：模式指针 → 工具集
// 与审批基线、记录的选择 → 默认 ref → 内置默认行 → 第一行，以及会话自己的增量叠在基线之上。
// 持有者各自文件（tools.json / models.json）的往返行为由 smoke-tool-settings / smoke-model-manager
// 覆盖；这里驱动的是组合语义。
// 这里不触网，无需服务器和 provider key。
// 运行：node scripts/smoke-settings.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSession,
	createToolManager,
	ModelManager,
	resolveSettings,
	SessionManager,
	type ModelConfig,
	type Session,
} from "@my-agent/core";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

// --------------------------------- 两半组合：resolveSettings

process.stdout.write("\nsettings：session 的选择与两个持有者的现读组合成下游用的那一份（ADR-0019）\n");

{
	const workRoot = mkdtempSync(join(tmpdir(), "my-agent-settings-resolve-"));
	const home = mkdtempSync(join(tmpdir(), "my-agent-settings-home-"));
	try {
		const sessionManager = new SessionManager();
		const known = ["read", "write", "edit", "glob", "grep", "bash"];
		const rows: ModelConfig[] = [
			{ id: "b-1", name: "b", baseUrl: "http://x/v1", contextWindow: 128_000, maxTokens: 8_192 },
			{ id: "a-1", name: "a", baseUrl: "http://x/v1", contextWindow: 128_000, maxTokens: 8_192 },
		];
		const toolManager = createToolManager({ home });
		const modelManager = new ModelManager(home);
		modelManager.replaceRows(rows);
		// 组合的输入是各持有者的一次现读，与 agent 装配时的取法同形。
		const modelView = (): { rows: readonly ModelConfig[]; defaultRef?: string } => ({
			rows: modelManager.catalog(),
			defaultRef: modelManager.defaultRef(),
		});
		const bag = (): Session => createSession(workRoot);

		// 会话记录了 b/high：组合出的模型行就是 b 那一行的完整事实——端点、窗口都随行而来，
		// 会话快照上仍然只有选择的名字与档位。
		const chosenSession = bag();
		sessionManager.setModel(chosenSession, "b", "b-1");
		sessionManager.setThinkingLevel(chosenSession, "high");
		const chosen = resolveSettings(chosenSession, toolManager.toolDefaults(), modelView(), known);
		check("记录的选择解析到完整行", chosen.model.config.id === "b-1" && chosen.model.config.name === "b", JSON.stringify(chosen.model));
		check("档位原样带过来", chosen.model.thinkingLevel === "high", String(chosen.model.thinkingLevel));

		// 没记录的会话回落到设置的默认行；设置没指名时回落内置默认行，再其次第一行。
		const plain = bag();
		modelManager.applyModelSettings({ model: "a" });
		const withDefault = resolveSettings(plain, toolManager.toolDefaults(), modelView(), known);
		check("设置的默认行是第二级", withDefault.model.config.name === "a", withDefault.model.config.name);
		// 另一个 home 的 ModelManager：目录里有行、但从未指名默认——回落链的后两级在这里走。
		const plainHome = mkdtempSync(join(tmpdir(), "my-agent-settings-plain-"));
		try {
			const plainModels = new ModelManager(plainHome);
			plainModels.replaceRows(rows);
			const plainView = (): { rows: readonly ModelConfig[]; defaultRef?: string } => ({
				rows: plainModels.catalog(),
				defaultRef: plainModels.defaultRef(),
			});
			check("没指名时 defaultRef 缺席", plainModels.defaultRef() === undefined, String(plainModels.defaultRef()));
			const fallback = resolveSettings(plain, toolManager.toolDefaults(), plainView(), known);
			check("目录里没有内置默认行时落到第一行", fallback.model.config.name === "b", fallback.model.config.name);

			// 一行都没有的机器得到占位行，而不是一次异常：拒绝发送的是传输层。
			plainModels.replaceRows([]);
			const empty = resolveSettings(plain, toolManager.toolDefaults(), plainView(), known);
			check("无行目录得到占位行", empty.model.config.name === "my-agent:unconfigured", empty.model.config.name);
		} finally {
			rmSync(plainHome, { recursive: true, force: true });
		}

		// 模式指针：ToolManager 的 modes 表是工具集与审批基线的唯一来处；表改了内容，指向它的会话跟着变。
		toolManager.applyToolDefaults({ tools: ["read", "bash"], modes: [{ name: "reader", tools: ["read"], approval: { bash: true } }] });
		const pointed = bag();
		sessionManager.setMode(pointed, "reader");
		const reader = resolveSettings(pointed, toolManager.toolDefaults(), modelView(), known);
		check("指针解析出预设的工具集", JSON.stringify(reader.tools) === JSON.stringify(["read"]), JSON.stringify(reader.tools));
		check("座位就是指针", reader.mode === "reader", reader.mode);
		check("预设的审批是基线", reader.approval.bash === true && reader.approval.write === true, JSON.stringify(reader.approval));

		toolManager.applyToolDefaults({ modes: [{ name: "reader", tools: ["read", "grep"], approval: { bash: true } }] });
		check("表改了内容会话跟着变", JSON.stringify(resolveSettings(pointed, toolManager.toolDefaults(), modelView(), known).tools) === JSON.stringify(["read", "grep"]));

		// 会话自己的增量叠在基线之上：预设闸着 bash，会话明确放行。
		sessionManager.setApprovalOverride(pointed, { bash: false });
		const withDelta = resolveSettings(pointed, toolManager.toolDefaults(), modelView(), known);
		check("会话的增量叠在基线之上", withDelta.approval.bash === false, JSON.stringify(withDelta.approval));

		// 悬空的指针——模式被删了——读作默认，但指针保留在快照上：模式再出生时重新挂上。
		toolManager.applyToolDefaults({ modes: [] });
		const dangling = resolveSettings(pointed, toolManager.toolDefaults(), modelView(), known);
		check("悬空的指针读作默认", dangling.mode === undefined && JSON.stringify(dangling.tools) === JSON.stringify(["read", "bash"]), JSON.stringify(dangling.tools));
		check("但指针保留在快照上", sessionManager.getRecordedToolConfig(pointed).mode === "reader", sessionManager.getRecordedToolConfig(pointed).mode);
	} finally {
		rmSync(workRoot, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
}

process.stdout.write(failures === 0 ? "\nsettings ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
