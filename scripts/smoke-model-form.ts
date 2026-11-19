// Model form smoke：settings → 模型 表单画的标签（ticket 04）。
//
// 这六个标签是面向用户的契约——「模型」「BASE URL」「上下文长度」……——漏改一个名字，或某个字段
// 从表单里消失，正是截图评审反复晚发现的那类问题。所以这里对着生产面板断言它们，用与其他视图
// smoke 相同的最小 DOM。不触网，无需服务器和 provider key。
// 运行：node scripts/smoke-model-form.ts
import { SettingsPanel, type SettingsHandlers } from "../packages/web/src/render/settings.ts";
import { installDom, type FakeNode } from "./dom-shim.ts";
import type { GlobalSettingsSnapshot } from "@my-agent/core/protocol";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

function all(root: FakeNode, className: string): FakeNode[] {
	const found: FakeNode[] = [];
	const walk = (node: FakeNode): void => {
		if (node.classList.contains(className)) found.push(node);
		for (const child of node.children) walk(child);
	};
	walk(root);
	return found;
}

function settingsOf(): GlobalSettingsSnapshot {
	return {
		appearance: { theme: "dark", fontSize: 15 },
		approval: { read: false, write: true, edit: true, glob: false, grep: false, bash: true },
		bash: { defaultTimeoutMs: 120_000, maxTimeoutMs: 3_600_000 },
	};
}

function handlers(): SettingsHandlers {
	return {
		onClose: () => {},
		onTheme: () => {},
		onFontSize: () => {},
		onSaveModels: async () => {},
		onSaveModes: async () => {},
		onDefaultModel: () => {},
		onGlobalTools: async () => {},
		onGlobalApproval: async () => {},
		onBashTimeouts: () => {},
	};
}

/**
 * 一个字段的标签，按表单绘制的方式读取：每个字段都在其控件上方放一个 `settings-label`。
 */
function fieldLabels(form: FakeNode): (string | undefined)[] {
	return all(form, "model-field").map((field) => {
		const label = field.children.find((child) => child.classList.contains("settings-label"));
		return label?.textContent;
	});
}

process.stdout.write("\nmodel-form：新建表单的六个标签逐字一致\n");

{
	installDom();
	const settingsPanel = new SettingsPanel(handlers());
	settingsPanel.render({ settings: settingsOf(), models: [], toolNames: [] });
	settingsPanel.show("models");

	// 添加表单就是展开的那一行本身：按钮把它原地展开。
	const add = all(settingsPanel.element as unknown as FakeNode, "model-add")[0]!;
	add.dispatch("click");
	const form = all(settingsPanel.element as unknown as FakeNode, "model-form")[0];
	check("「＋ 添加模型」展开一张表单", form !== undefined);

	const labels = fieldLabels(form!);
	check("六个字段齐全", labels.length === 6, JSON.stringify(labels));
	check(
		"标签逐字是用户要的六个",
		JSON.stringify(labels) ===
			JSON.stringify(["名称", "模型", "BASE URL", "API KEY", "上下文长度", "最大输出长度"]),
		JSON.stringify(labels),
	);

	// Thinking 不再是某一行的职责：强度归 composer，每行共用同样的四项，表单里没有任何一处
	// 与这两者相关的控件。
	check("表单里没有复选框", form!.querySelector('input[type="checkbox"]') === null);
	check(
		"表单里没有下拉",
		all(form!, "input").filter((fakeNode) => fakeNode.tag === "select").length === 0,
		String(all(form!, "input").filter((fakeNode) => fakeNode.tag === "select").length),
	);

	// 旧标签不得在表单里残留：每次改名都是替换一个字符串，漏掉一处就成了同一字段有两个名字。
	const rendered = JSON.stringify(form!.textContent);
	for (const stale of ["模型 ID", "服务地址", "上下文窗口", "最大输出（", "该模型支持推理", "默认思考等级", "思考模式", "默认思考强度"]) {
		check(`没有残留旧标签「${stale}」`, !rendered.includes(stale), rendered.slice(0, 200));
	}

	// 每个字段都要说明自己用来做什么。
	const hints = all(form!, "model-hint").map((fakeNode) => fakeNode.textContent);
	check("每个字段都带一句提示", hints.length === 6, JSON.stringify(hints));
}

process.stdout.write(failures === 0 ? "\nmodel form ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
