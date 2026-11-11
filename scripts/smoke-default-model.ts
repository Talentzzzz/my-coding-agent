// Default-model smoke：没有导入任何模型时窗口种下的那一行。
//
// 机制完全在客户端（ticket 04）：一个 `packages/web` 里的常量，经由既有的 `PUT /api/models` 存储，
// 外加一个持久标记，保证被删掉的行不会被种回来。这里不触网——store 就是一对回调——所以无需
// 服务器和 provider key。服务器*本来会*保留什么，用端点同一个 `coerceModelConfig` 来核对。
// 运行：node scripts/smoke-default-model.ts
import { coerceModelConfig, listModelOptions } from "@my-agent/core";
import type { ModelInput, ModelOption } from "@my-agent/core/protocol";
import {
	DEFAULT_MODEL,
	DEFAULT_THINKING_LEVEL,
	defaultModelDue,
	seedDefaultModel,
	type DefaultModelHost,
} from "../packages/web/src/default-model.ts";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/** 客户端视角下的一行模型，供"已导入过东西"的用例使用。 */
function modelOption(name: string): ModelOption {
	return {
		name,
		api: "anthropic-messages",
		baseUrl: "https://example.invalid",
		id: name,
		contextWindow: 1_000,
		maxTokens: 1_000,
		thinkingLevels: ["off", "low", "high", "max"],
		hasApiKey: true,
	};
}

/** 服务端对一次保存的应答：它收下的那些行，wire 形状。 */
function savedModels(rows: ModelInput[]): ModelOption[] {
	return rows.map((row) => modelOption(row.name ?? row.id ?? "row"));
}

type Harness = DefaultModelHost & { events: string[]; writes: ModelInput[][] };

function host(over: Partial<DefaultModelHost> = {}): Harness {
	const events: string[] = [];
	const writes: ModelInput[][] = [];
	return {
		events,
		writes,
		models: [],
		seeded: false,
		save: async (rows) => {
			events.push("save");
			writes.push(rows);
			return savedModels(rows);
		},
		markSeeded: async () => {
			events.push("markSeeded");
		},
		...over,
	};
}

// --------------------------------------------------- 1. 那一行逐字是用户要的

process.stdout.write("\ndefault-model：内置的那一行逐字是用户要的\n");

{
	check("名称是 deepseek-flash", DEFAULT_MODEL.name === "deepseek-flash", String(DEFAULT_MODEL.name));
	check("模型 id 是 deepseek-flash", DEFAULT_MODEL.id === "deepseek-flash", String(DEFAULT_MODEL.id));
	check(
		"BASE URL 是 DeepSeek 的 Anthropic 端点",
		DEFAULT_MODEL.baseUrl === "https://api.deepseek.com/anthropic",
		String(DEFAULT_MODEL.baseUrl),
	);
	check("上下文长度是 1,000,000", DEFAULT_MODEL.contextWindow === 1_000_000, String(DEFAULT_MODEL.contextWindow));
	check("最大输出长度是 384,000", DEFAULT_MODEL.maxTokens === 384_000, String(DEFAULT_MODEL.maxTokens));
	check("客户端默认思考强度是 high", DEFAULT_THINKING_LEVEL === "high", DEFAULT_THINKING_LEVEL);
	// 密钥由用户自己填：种下的行不得带密钥，也不能带一个可能覆盖已有密钥的字段——字段缺席时
	// 端点会保留已存储的密钥。
	check("不带密钥字段，留给用户填", DEFAULT_MODEL.apiKey === undefined, String(DEFAULT_MODEL.apiKey));

	// 用端点自己的 coercion，因此核对的是服务器实际会保留的那一行，而不是面板碰巧显示的形状。
	const stored = coerceModelConfig(DEFAULT_MODEL);
	check("服务端收下这一行", stored !== undefined, JSON.stringify(stored));
	check("存下来的上下文窗口没被改", stored?.contextWindow === 1_000_000, String(stored?.contextWindow));
	check("存下来的输出上限没被改", stored?.maxTokens === 384_000, String(stored?.maxTokens));
	check("存下来是空密钥", stored?.apiKey === "", JSON.stringify(stored?.apiKey));
	check("按行名能被找到", (stored === undefined ? [] : [stored]).find((userModel) => userModel.name === "deepseek-flash") !== undefined);
	const shown = listModelOptions(stored === undefined ? [] : [stored]);
	check("客户端看到的行没有密钥", shown[0]?.hasApiKey === false, String(shown[0]?.hasApiKey));
	check(
		"客户端看到的是四档，含 high 与 max",
		shown[0]?.thinkingLevels.join(",") === "off,low,high,max",
		JSON.stringify(shown[0]?.thinkingLevels),
	);
}

// ------------------------------------------- 2. 只在「一行都没有、也从没种过」时该种

process.stdout.write("\ndefault-model：只在「一行都没有、也从没种过」时该种\n");

{
	check("一行都没有、没种过 → 该种", defaultModelDue([], false));
	check("一行都没有、种过（用户删了）→ 不种回", !defaultModelDue([], true));
	check("已经有行、没种过 → 不种", !defaultModelDue([modelOption("mine")], false));
	check("已经有行、种过 → 不种", !defaultModelDue([modelOption("mine")], true));
}

// ------------------------------------------------------------------ 3. 种下之后先存行、再落标记

process.stdout.write("\ndefault-model：种下之后先存行、再落标记\n");

{
	const one = host();
	const answer = await seedDefaultModel(one);
	const writes = one.writes;
	check("存的就是那唯一一行", writes.length === 1 && writes[0]?.length === 1, JSON.stringify(writes));
	check("存的是内置常量本身", writes[0]?.[0]?.name === DEFAULT_MODEL.name && writes[0]?.[0]?.maxTokens === 384_000, JSON.stringify(writes[0]));
	check("标记在存行之后落地", JSON.stringify(one.events) === JSON.stringify(["save", "markSeeded"]), JSON.stringify(one.events));
	check("答案是服务端收下的行", answer?.[0]?.name === "deepseek-flash", JSON.stringify(answer));

	// 种过之后标记已置位，同一份空列表不再该种：这正是"删掉了、又重启"的情形，按下次启动的
	// 问法来断言。
	const relaunch = host({ seeded: true });
	const none = await seedDefaultModel(relaunch);
	check("种过之后的新窗口不再种", none === undefined, JSON.stringify(none));
	check("也不再发任何请求", relaunch.events.length === 0, JSON.stringify(relaunch.events));

	// 没能存下的行不得留下标记：先落标记意味着下次启动会以为行已存在，永远不再尝试。
	const broken = host({
		save: async () => {
			throw new Error("put refused");
		},
	});
	let refused: unknown;
	try {
		await seedDefaultModel(broken);
	} catch (error) {
		refused = error;
	}
	check("存行失败会抛给调用方", refused instanceof Error && refused.message === "put refused", String(refused));
	check("失败时不落标记", !broken.events.includes("markSeeded"), JSON.stringify(broken.events));
}

process.stdout.write(failures === 0 ? "\ndefault-model ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
