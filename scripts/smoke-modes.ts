// Modes UI smoke: drives the production settings panel's modes tab, the composer's mode seat, and
// the mode menu against the minimal DOM, and checks the behaviours a screenshot cannot — that the
// built-in default card opens the same inline form and saves the global defaults whole, that a user
// mode's form commits the list whole, that the built-in's name is refused, and that a menu row's
// detail line reaches the DOM. Nothing reaches the network, so no server and no provider key are
// needed.
// Run with: node scripts/smoke-modes.ts
import { SettingsPanel, modeSummaryOf, type SettingsHandlers } from "../packages/web/src/render/settings.ts";
import { Composer, type ComposerHandlers } from "../packages/web/src/composer.ts";
import { openMenu } from "../packages/web/src/render/menu.ts";
import { installDom, type FakeNode } from "./dom-shim.ts";
import type { ModeSettings, SettingsSnapshot, SessionSnapshot } from "@my-agent/core/protocol";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/** Let a synchronously dispatched handler's promises settle before the next assertion reads. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function all(root: FakeNode, className: string): FakeNode[] {
	const found: FakeNode[] = [];
	const walk = (node: FakeNode): void => {
		if (node.classList.contains(className)) found.push(node);
		for (const child of node.children) walk(child);
	};
	walk(root);
	return found;
}

function byTitle(root: FakeNode, title: string): FakeNode | undefined {
	return all(root, "icon-button").find((node) => node.getAttribute("title") === title);
}

const ALL_TOOLS = ["read", "write", "edit", "glob", "grep", "bash", "SubAgent", "SubAgentControl"];

function settingsOf(modes: ModeSettings[] | undefined, tools?: string[]): SettingsSnapshot {
	return {
		appearance: { theme: "dark", fontSize: 15 },
		approval: { read: false, write: true, edit: true, glob: false, grep: false, bash: true },
		bash: { defaultTimeoutMs: 120_000, maxTimeoutMs: 3_600_000 },
		...(tools === undefined ? {} : { tools }),
		...(modes === undefined ? {} : { modes }),
	} as SettingsSnapshot;
}

function snapshotOf(): SessionSnapshot {
	return { allTools: ALL_TOOLS } as unknown as SessionSnapshot;
}

function handlers(over: Partial<SettingsHandlers> = {}): SettingsHandlers {
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
		...over,
	};
}

function composerHandlers(over: Partial<ComposerHandlers> = {}): ComposerHandlers {
	return {
		onSubmit: () => {},
		onAbort: () => {},
		onSelectModel: () => {},
		onSelectLevel: () => {},
		onModes: () => {},
		onSelectMode: () => {},
		...over,
	};
}

// ------------------------------------------------- 1. the tab draws the default card and the modes

process.stdout.write("\nmodes：模式页画出内置默认卡与用户模式\n");

{
	installDom();
	const panel = new SettingsPanel(handlers());
	panel.render({
		// The default tools include `bash`, so the card's summary has a question to count: the standard
		// approval map marks write/edit/bash, and bash is the one the list carries.
		settings: settingsOf([{ name: "只读", tools: ["read", "glob", "grep"], approval: { bash: false, write: false, edit: false, read: false, glob: false, grep: false } }], ["read", "glob", "bash"]),
		models: [],
		snapshot: snapshotOf(),
	});
	panel.show("modes");

	const badges = all(panel.element as unknown as FakeNode, "mode-badge");
	check("内置默认卡带着「内置」徽标", badges.length === 1 && badges[0]!.textContent === "内置");
	const rows = all(panel.element as unknown as FakeNode, "model-row");
	check("默认卡加一个用户模式，共两张卡", rows.length === 2, String(rows.length));
	const summaries = all(panel.element as unknown as FakeNode, "mode-summary");
	check("默认卡的摘要来自全局默认值", summaries[0]?.textContent === "3 个工具 · 1 项询问", summaries[0]?.textContent);
	check("用户模式的摘要整份算出", summaries[1]?.textContent === "3 个工具 · 0 项询问", summaries[1]?.textContent);

	// Collapsed, the default card is the same one-line row a user mode is: the tools are behind the
	// head, which is the door into the inline form.
	const defaultTools = all(rows[0] as FakeNode, "mode-tool");
	check("默认卡收起时只有一行摘要", defaultTools.length === 0, String(defaultTools.length));
	const defaultHead = rows[0]!.children.find((child) => child.classList.contains("model-row-head"));
	check("默认卡的头是门", defaultHead?.tag === "button", defaultHead?.tag);
}

// -------------------------------------- 2. the default card edits the globals on save

process.stdout.write("\nmodes：默认卡展开同一套表单并写全局默认\n");

{
	installDom();
	const toolsWrites: string[][] = [];
	const approvalWrites: [string, boolean][] = [];
	const panel = new SettingsPanel(
		handlers({
			onGlobalTools: async (names) => {
				toolsWrites.push(names);
			},
			onGlobalApproval: async (tool, value) => {
				approvalWrites.push([tool, value]);
			},
		}),
	);
	panel.render({ settings: settingsOf(undefined), models: [], snapshot: snapshotOf() });
	panel.show("modes");

	const rows = all(panel.element as unknown as FakeNode, "model-row");
	const head = rows[0]!.children.find((child) => child.classList.contains("model-row-head"))!;
	head.dispatch("click");
	const form = all(panel.element as unknown as FakeNode, "model-form")[0];
	check("点默认卡的头展开内联表单", form !== undefined);

	// The name is the one field the built-in cannot edit: it is shown as a label with the badge, not
	// as a text input.
	check("默认模式的名称不可编辑", form!.querySelector('input[type="text"]') === null);
	const nameBadges = all(form!, "mode-badge");
	check("表单里仍是「默认」+「内置」", nameBadges.length === 1 && nameBadges[0]!.textContent === "内置", nameBadges[0]?.textContent);

	const toolRows = all(form!, "mode-tool");
	check("展开后每工具一行", toolRows.length === ALL_TOOLS.length, String(toolRows.length));

	// `bash` is the sixth row and starts checked (the standard default). The shim does not reproduce
	// the browser's click-then-change order, so the toggle is set the way a click would leave it
	// before the change event dispatches.
	const bashRow = toolRows[5]!;
	const bashBox = bashRow.querySelector("input")!;
	check("bash 默认勾着", bashBox.getAttribute("aria-label") === "启用 bash" && bashBox.checked === true);
	bashBox.checked = false;
	bashBox.dispatch("change");
	check("表单里的修改不立刻写全局", toolsWrites.length === 0 && approvalWrites.length === 0, JSON.stringify([toolsWrites, approvalWrites]));

	// The approval select rides the same row; moving it edits the draft too. Only the six keyed tools
	// carry one, so the fourth select is `glob`.
	const select = all(form!, "mode-tool-approval")[3]!;
	select.value = "ask";
	select.dispatch("change");
	check("审批修改也留在草稿里", approvalWrites.length === 0, JSON.stringify(approvalWrites));

	const save = all(form!, "button").find((button) => button.textContent === "保存")!;
	save.dispatch("click");
	await flush();
	check("保存把整份工具集写下去", JSON.stringify(toolsWrites.at(-1)) === JSON.stringify(ALL_TOOLS.filter((name) => name !== "bash")), JSON.stringify(toolsWrites.at(-1)));
	check("保存只写变更过的审批", JSON.stringify(approvalWrites) === JSON.stringify([["glob", true]]), JSON.stringify(approvalWrites));
	check("保存后表单收起", all(panel.element as unknown as FakeNode, "model-form").length === 0);

	// Without a session the default form stands down, the way the old defaults section did: its
	// toggles cannot name the build's own list, and writing the six built-ins over a set that may
	// name more would be inventing one — the exact thing that path refuses to do.
	const bareWrites: string[][] = [];
	const bare = new SettingsPanel(
		handlers({
			onGlobalTools: async (names) => {
				bareWrites.push(names);
			},
		}),
	);
	bare.render({ settings: settingsOf(undefined), models: [] });
	bare.show("modes");
	const bareRows = all(bare.element as unknown as FakeNode, "model-row");
	const bareHead = bareRows[0]!.children.find((child) => child.classList.contains("model-row-head"))!;
	bareHead.dispatch("click");
	const bareForm = all(bare.element as unknown as FakeNode, "model-form")[0]!;
	const bareBox = all(bareForm, "mode-tool")[5]!.querySelector("input")!;
	check("无会话时默认表单的开关退场", bareBox.disabled === true, String(bareBox.disabled));
	const bareSave = all(bareForm, "button").find((button) => button.textContent === "保存")!;
	check("无会话时保存退场", bareSave.disabled === true, String(bareSave.disabled));
	bareSave.dispatch("click");
	check("无会话时默认卡不写编造的工具集", bareWrites.length === 0, JSON.stringify(bareWrites));
}

// ------------------------------------------------------- 3. a mode's form commits the list whole

process.stdout.write("\nmodes：用户模式整表保存\n");

{
	installDom();
	const saves: ModeSettings[][] = [];
	const panel = new SettingsPanel(handlers({ onSaveModes: async (modes) => saves.push(modes) }));
	panel.render({ settings: settingsOf([{ name: "只读", tools: ["read"], approval: { bash: false, write: false, edit: false, read: false, glob: false, grep: false } }]), models: [], snapshot: snapshotOf() });
	panel.show("modes");

	const rows = all(panel.element as unknown as FakeNode, "model-row");
	// The head is the door: clicking it opens the form in place.
	const head = rows[1]!.children.find((child) => child.classList.contains("model-row-head"))!;
	head.dispatch("click");
	let form = all(panel.element as unknown as FakeNode, "model-form")[0];
	check("点头部打开内联表单", form !== undefined);

	const name = form!.querySelector("input");
	name!.value = "只读改的";
	name!.dispatch("input");
	// Turn `bash` on in the form; its approval select comes up with it, at 自动允许. The shim needs
	// the click's end state set by hand before the change dispatches.
	const toolRows = all(form!, "mode-tool");
	const bashRow = toolRows.find((row) => row.querySelector("input")!.getAttribute("aria-label") === "启用 bash")!;
	const bashBox = bashRow.querySelector("input")!;
	bashBox.checked = true;
	bashBox.dispatch("change");
	const bashSelect = bashRow.querySelector("select")!;
	check("勾上的工具带出审批下拉", bashSelect.getAttribute("disabled") === null, String(bashSelect.getAttribute("disabled")));
	check("新勾的工具默认自动允许", bashSelect.value === "allow", bashSelect.value);

	const save = all(form!, "button").find((button) => button.textContent === "保存")!;
	save.dispatch("click");
	await flush();
	check("保存把整份清单发下去", saves.length === 1, JSON.stringify(saves));
	check("改名与工具变更一起落地", saves[0]?.[0]?.name === "只读改的" && saves[0]?.[0]?.tools.includes("bash") === true, JSON.stringify(saves[0]));
	form = all(panel.element as unknown as FakeNode, "model-form")[0];
	check("成功后表单收起", form === undefined);
}

// ----------------------------------------------- 4. the built-in's name and duplicates are refused

process.stdout.write("\nmodes：名字冲突就地拒绝\n");

{
	installDom();
	const saves: ModeSettings[][] = [];
	const panel = new SettingsPanel(handlers({ onSaveModes: async (modes) => saves.push(modes) }));
	panel.render({
		settings: settingsOf([{ name: "只读", tools: ["read"], approval: { bash: false, write: false, edit: false, read: false, glob: false, grep: false } }]),
		models: [],
		snapshot: snapshotOf(),
	});
	panel.show("modes");

	// The add form is the expanded row itself; the blank draft's name goes into the input.
	const add = all(panel.element as unknown as FakeNode, "model-add")[0]!;
	add.dispatch("click");
	let form = all(panel.element as unknown as FakeNode, "model-form")[0];
	check("新建模式展开空表单", form !== undefined);

	const reserved = form!.querySelector("input");
	reserved!.value = "默认";
	reserved!.dispatch("input");
	const save = all(form!, "button").find((button) => button.textContent === "保存")!;
	save.dispatch("click");
	await flush();
	check("内置名被拒绝且不下发", saves.length === 0, JSON.stringify(saves));
	const note = all(panel.element as unknown as FakeNode, "settings-note")[0]!;
	check("拒绝写在面板的注记里", note.textContent.includes("默认"), note.textContent);

	// The client refuses a duplicate before the server ever sees the list, the same way.
	reserved!.value = "只读";
	reserved!.dispatch("input");
	save.dispatch("click");
	await flush();
	check("重名被拒绝", saves.length === 0, JSON.stringify(saves));

	// An empty tools list is a choice, not a mistake: saving it goes through.
	reserved!.value = "全关";
	reserved!.dispatch("input");
	save.dispatch("click");
	await flush();
	check("空工具集的模式照常保存", saves.length === 1 && saves[0]?.[1]?.name === "全关" && saves[0]?.[1]?.tools.length === 0, JSON.stringify(saves));
	form = all(panel.element as unknown as FakeNode, "model-form")[0];
	check("保存后表单收起", form === undefined);
}

// ------------------------------------------------------------- 5. deleting asks once, then goes

process.stdout.write("\nmodes：删除先问一次\n");

{
	installDom();
	const saves: ModeSettings[][] = [];
	const panel = new SettingsPanel(handlers({ onSaveModes: async (modes) => saves.push(modes) }));
	panel.render({ settings: settingsOf([{ name: "只读", tools: ["read"], approval: { bash: false, write: false, edit: false, read: false, glob: false, grep: false } }]), models: [], snapshot: snapshotOf() });
	panel.show("modes");

	const rows = all(panel.element as unknown as FakeNode, "model-row");
	const trash = byTitle(rows[1] as FakeNode, "删除这个模式");
	check("悬停的回收站在行上", trash !== undefined);
	trash!.dispatch("click");
	const bar = all(panel.element as unknown as FakeNode, "model-confirm")[0];
	check("确认条站在行内", bar !== undefined && bar.textContent.includes("只读"), bar?.textContent);
	const danger = all(bar!, "button").find((button) => button.textContent === "删除")!;
	danger.dispatch("click");
	await flush();
	check("确认后清单少了一份", saves.length === 1 && saves[0]?.length === 0, JSON.stringify(saves));

	// The default card has no trash: there is nothing to delete.
	const defaultTrash = byTitle(rows[0] as FakeNode, "删除这个模式");
	check("默认卡没有删除", defaultTrash === undefined);
}

// --------------------------------------------------------------- 6. the seat and the menu rows

process.stdout.write("\nmodes：输入框的模式座位与菜单\n");

{
	installDom();
	const picked: string[] = [];
	const composer = new Composer(composerHandlers({ onSelectMode: (name) => picked.push(name) }));
	check("输入框 bar 上只剩模式座位", all(composer.element as unknown as FakeNode, "composer-gear").length === 0);

	composer.setModes("默认");
	const label = all(composer.element as unknown as FakeNode, "composer-mode-label")[0]!;
	check("座位标着当前模式", label.textContent === "默认", label.textContent);
	composer.setModes(undefined);
	check("没有命中的会话显示自定义", label.textContent === "自定义", label.textContent);
	composer.setModes("只读");
	composer.setModes("只读");
	check("同名重画被门槛挡住", label.textContent === "只读" && all(composer.element as unknown as FakeNode, "composer-mode-label").length === 1);

	// The menu hangs off the seat: one row per mode with its summary line, and a click applies.
	const anchor = all(composer.element as unknown as FakeNode, "composer-mode")[0]!;
	openMenu(anchor as unknown as HTMLElement, [
		{ label: "默认", detail: "6 个工具 · 3 项询问", active: true, onSelect: () => picked.push("默认") },
		{ label: "只读", detail: "3 个工具 · 0 项询问", onSelect: () => picked.push("只读") },
	]);
	const details = all(document.body as unknown as FakeNode, "menu-detail");
	check("菜单行带着摘要行", details.map((node) => node.textContent).join("|") === "6 个工具 · 3 项询问|3 个工具 · 0 项询问", JSON.stringify(details.map((node) => node.textContent)));
	const items = all(document.body as unknown as FakeNode, "menu-item");
	items[1]!.dispatch("click");
	await flush();
	check("点选菜单行发出模式名", picked.join(",") === "只读", JSON.stringify(picked));
	check("选完菜单收起", all(document.body as unknown as FakeNode, "menu-item").length === 0);
}

// --------------------------------------------------------------------- 7. the summary helper

process.stdout.write("\nmodes：摘要一行算对\n");

{
	check(
		"启用数与询问数各算各的",
		modeSummaryOf(["read", "write", "bash"], { read: false, write: true, edit: true, glob: false, grep: false, bash: true }) === "3 个工具 · 2 项询问",
		modeSummaryOf(["read", "write", "bash"], { read: false, write: true, edit: true, glob: false, grep: false, bash: true }),
	);
	check("空模式是 0 个工具", modeSummaryOf([], { read: false, write: false, edit: false, glob: false, grep: false, bash: false }) === "0 个工具 · 0 项询问");
}

process.stdout.write(failures === 0 ? "\nmodes ui ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
