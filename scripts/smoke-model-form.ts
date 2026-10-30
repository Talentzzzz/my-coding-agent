// Model form smoke: the labels the settings → 模型 form draws (ticket 04).
//
// The six labels are a user-facing contract — 「模型」「BASE URL」「上下文长度」… — and a rename that
// misses one, or a field that goes missing from the form, is exactly what a screenshot review keeps
// catching late. So they are asserted against the production panel here, in the same minimal DOM the
// other view smokes use. Nothing reaches the network, so no server and no provider key are needed.
// Run with: node scripts/smoke-model-form.ts
import { SettingsPanel, type SettingsHandlers } from "../packages/web/src/render/settings.ts";
import { installDom, type FakeNode } from "./dom-shim.ts";
import type { SettingsSnapshot } from "@my-agent/core/protocol";

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

function settingsOf(): SettingsSnapshot {
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
 * One field's label, read the way the form draws it: every field puts a `settings-label` above its
 * control.
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
	const panel = new SettingsPanel(handlers());
	panel.render({ settings: settingsOf(), models: [] });
	panel.show("models");

	// The add form is the expanded row itself: the button opens it in place.
	const add = all(panel.element as unknown as FakeNode, "model-add")[0]!;
	add.dispatch("click");
	const form = all(panel.element as unknown as FakeNode, "model-form")[0];
	check("「＋ 添加模型」展开一张表单", form !== undefined);

	const labels = fieldLabels(form!);
	check("六个字段齐全", labels.length === 6, JSON.stringify(labels));
	check(
		"标签逐字是用户要的六个",
		JSON.stringify(labels) ===
			JSON.stringify(["名称", "模型", "BASE URL", "API KEY", "上下文长度", "最大输出长度"]),
		JSON.stringify(labels),
	);

	// Thinking is no longer a row's business: the strength belongs to the composer, every row takes the
	// same four, and the form has no control for either half of that.
	check("表单里没有复选框", form!.querySelector('input[type="checkbox"]') === null);
	check(
		"表单里没有下拉",
		all(form!, "input").filter((node) => node.tag === "select").length === 0,
		String(all(form!, "input").filter((node) => node.tag === "select").length),
	);

	// Old labels must not survive anywhere in the form: each rename replaces a string, so a missed one
	// is a second name for the same field.
	const rendered = JSON.stringify(form!.textContent);
	for (const stale of ["模型 ID", "服务地址", "上下文窗口", "最大输出（", "该模型支持推理", "默认思考等级", "思考模式", "默认思考强度"]) {
		check(`没有残留旧标签「${stale}」`, !rendered.includes(stale), rendered.slice(0, 200));
	}

	// Every field says what it is for.
	const hints = all(form!, "model-hint").map((node) => node.textContent);
	check("每个字段都带一句提示", hints.length === 6, JSON.stringify(hints));
}

process.stdout.write(failures === 0 ? "\nmodel form ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
