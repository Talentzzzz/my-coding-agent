// Default-model smoke: the row the window plants when no model is imported.
//
// The mechanism is entirely client-side (ticket 04): a constant in `packages/web`, stored through the
// existing `PUT /api/models`, with a persistent marker that keeps a deleted row deleted. Nothing here
// reaches the network — the store is a pair of callbacks — so no server and no provider key are
// needed. What the server *would* keep is checked through the same `coerceModelConfig` the endpoint uses.
// Run with: node scripts/smoke-default-model.ts
import { coerceModelConfig, listModelOptions } from "@my-agent/core";
import type { ModelInput, ModelOption } from "@my-agent/core/protocol";
import {
	DEFAULT_MODEL,
	defaultModelDue,
	seedDefaultModel,
	type DefaultModelHost,
} from "../packages/web/src/default-model.ts";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/** A row as the client would see one, for the "something is already imported" cases. */
function modelOption(name: string): ModelOption {
	return {
		name,
		api: "anthropic-messages",
		baseUrl: "https://example.invalid",
		id: name,
		contextWindow: 1_000,
		maxTokens: 1_000,
		reasoning: false,
		thinkingLevels: ["off"],
		defaultThinkingLevel: "off",
		hasApiKey: true,
	};
}

/** The server's answer to a save: the rows it kept, in the wire shape. */
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

// --------------------------------------------------- 1. the row is the one the user named

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
	check("思考模式开着", DEFAULT_MODEL.reasoning === true, String(DEFAULT_MODEL.reasoning));
	check("默认思考强度是 high", DEFAULT_MODEL.defaultThinkingLevel === "high", String(DEFAULT_MODEL.defaultThinkingLevel));
	// The key is the user's to fill: the planted row must not carry one, and must not send a field
	// that could overwrite one either — the endpoint keeps a stored key when the field is absent.
	check("不带密钥字段，留给用户填", DEFAULT_MODEL.apiKey === undefined, String(DEFAULT_MODEL.apiKey));

	// The endpoint's own coercion, so this is the row the server would actually keep rather than a
	// shape the panel happens to show.
	const stored = coerceModelConfig(DEFAULT_MODEL);
	check("服务端收下这一行", stored !== undefined, JSON.stringify(stored));
	check("存下来的上下文窗口没被改", stored?.contextWindow === 1_000_000, String(stored?.contextWindow));
	check("存下来的输出上限没被改", stored?.maxTokens === 384_000, String(stored?.maxTokens));
	check("存下来是空密钥", stored?.apiKey === "", JSON.stringify(stored?.apiKey));
	check("按行名能被找到", (stored === undefined ? [] : [stored]).find((userModel) => userModel.name === "deepseek-flash") !== undefined);
	const shown = listModelOptions(stored === undefined ? [] : [stored]);
	check("客户端看到的行没有密钥", shown[0]?.hasApiKey === false, String(shown[0]?.hasApiKey));
	check(
		"客户端看到的默认强度是 high",
		shown[0]?.defaultThinkingLevel === "high",
		String(shown[0]?.defaultThinkingLevel),
	);
	check(
		"客户端看到的档位含 medium 与 high（DeepSeek 把两者折到同一档）",
		shown[0]?.thinkingLevels.includes("medium") === true && shown[0]?.thinkingLevels.includes("high") === true,
		JSON.stringify(shown[0]?.thinkingLevels),
	);
}

// ------------------------------------------- 2. due only when nothing is imported and never seeded

process.stdout.write("\ndefault-model：只在「一行都没有、也从没种过」时该种\n");

{
	check("一行都没有、没种过 → 该种", defaultModelDue([], false));
	check("一行都没有、种过（用户删了）→ 不种回", !defaultModelDue([], true));
	check("已经有行、没种过 → 不种", !defaultModelDue([modelOption("mine")], false));
	check("已经有行、种过 → 不种", !defaultModelDue([modelOption("mine")], true));
}

// ------------------------------------------------------------------ 3. the seed writes and marks

process.stdout.write("\ndefault-model：种下之后先存行、再落标记\n");

{
	const one = host();
	const answer = await seedDefaultModel(one);
	const writes = one.writes;
	check("存的就是那唯一一行", writes.length === 1 && writes[0]?.length === 1, JSON.stringify(writes));
	check("存的是内置常量本身", writes[0]?.[0]?.name === DEFAULT_MODEL.name && writes[0]?.[0]?.maxTokens === 384_000, JSON.stringify(writes[0]));
	check("标记在存行之后落地", JSON.stringify(one.events) === JSON.stringify(["save", "markSeeded"]), JSON.stringify(one.events));
	check("答案是服务端收下的行", answer?.[0]?.name === "deepseek-flash", JSON.stringify(answer));

	// After the seed the marker is set, so the same empty list is no longer due: this is the
	// "deleted, then restarted" case, asserted as the next launch would ask it.
	const relaunch = host({ seeded: true });
	const none = await seedDefaultModel(relaunch);
	check("种过之后的新窗口不再种", none === undefined, JSON.stringify(none));
	check("也不再发任何请求", relaunch.events.length === 0, JSON.stringify(relaunch.events));

	// A row that could not be stored must not leave the marker behind: marking first would mean the
	// next launch believed the row existed and never tried again.
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
