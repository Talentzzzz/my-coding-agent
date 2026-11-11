// Modes UI smoke：对着最小 DOM 驱动生产设置面板的 modes 页签、composer 的模式座位与模式菜单，
// 检查截图检查不了的那些行为——内置默认卡展开同一套内联表单并整份保存全局默认，用户模式的
// 表单整表提交清单，内置的名字被拒绝，菜单行带着摘要行到达 DOM。不触网，无需服务器和
// provider key。
// 运行：node scripts/smoke-modes.ts
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

/** 让同步派发的 handler 的 promise 在下一条断言读取之前落定。 */
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

const ALL_TOOLS = ["read", "write", "edit", "glob", "grep", "bash"];

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

// ------------------------------------------------- 1. 页签画出默认卡与各模式

process.stdout.write("\nmodes：模式页画出内置默认卡与用户模式\n");

{
	installDom();
	const panel = new SettingsPanel(handlers());
	panel.render({
		// 默认工具包含 `bash`，所以卡片的摘要有一个问题可数：标准审批映射标记 write/edit/bash，
		// 而 bash 正是列表携带的那个。
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

	// 收起时，默认卡就是用户模式那种单行卡片：工具藏在头部之后，头部正是进入内联表单的门。
	const defaultTools = all(rows[0] as FakeNode, "mode-tool");
	check("默认卡收起时只有一行摘要", defaultTools.length === 0, String(defaultTools.length));
	const defaultHead = rows[0]!.children.find((child) => child.classList.contains("model-row-head"));
	check("默认卡的头是门", defaultHead?.tag === "button", defaultHead?.tag);
}

// -------------------------------------- 2. 默认卡在保存时写全局默认

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

	// 名称是内置唯一不可编辑的字段：它显示为带徽标的 label，而不是文本输入框。
	check("默认模式的名称不可编辑", form!.querySelector('input[type="text"]') === null);
	const nameBadges = all(form!, "mode-badge");
	check("表单里仍是「默认」+「内置」", nameBadges.length === 1 && nameBadges[0]!.textContent === "内置", nameBadges[0]?.textContent);

	const toolRows = all(form!, "mode-tool");
	check("展开后每工具一行", toolRows.length === ALL_TOOLS.length, String(toolRows.length));

	// `bash` 是第六行，初始勾着（标准默认）。shim 不复现浏览器"先 click 再 change"的顺序，所以
	// 开关按 click 在 change 派发之前会留下的状态手工设置。
	const bashRow = toolRows[5]!;
	const bashBox = bashRow.querySelector("input")!;
	check("bash 默认勾着", bashBox.getAttribute("aria-label") === "启用 bash" && bashBox.checked === true);
	bashBox.checked = false;
	bashBox.dispatch("change");
	check("表单里的修改不立刻写全局", toolsWrites.length === 0 && approvalWrites.length === 0, JSON.stringify([toolsWrites, approvalWrites]));

	// 审批下拉与工具同一行；移动它也是改草稿。只有六个有键的工具带下拉，所以第四个 select 是
	// `glob`。
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

	// 没有 session 时默认表单退场，与旧 defaults 区块的做法一致：它的开关无法指名构建自带的
	// 那份列表，把六个内置工具写到一个可能指名更多的集合上等于编造一份——正是这条路拒绝做的事。
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

// ------------------------------------------------------- 3. 模式的表单整表提交清单

process.stdout.write("\nmodes：用户模式整表保存\n");

{
	installDom();
	const saves: ModeSettings[][] = [];
	const panel = new SettingsPanel(handlers({ onSaveModes: async (modes) => saves.push(modes) }));
	panel.render({ settings: settingsOf([{ name: "只读", tools: ["read"], approval: { bash: false, write: false, edit: false, read: false, glob: false, grep: false } }]), models: [], snapshot: snapshotOf() });
	panel.show("modes");

	const rows = all(panel.element as unknown as FakeNode, "model-row");
	// 头部是门：点击它原地展开表单。
	const head = rows[1]!.children.find((child) => child.classList.contains("model-row-head"))!;
	head.dispatch("click");
	let form = all(panel.element as unknown as FakeNode, "model-form")[0];
	check("点头部打开内联表单", form !== undefined);

	const name = form!.querySelector("input");
	name!.value = "只读改的";
	name!.dispatch("input");
	// 在表单里勾上 `bash`；它的审批下拉随之出现，停在 自动允许。shim 需要在 change 派发之前
	// 手工设置 click 的终态。
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

// ----------------------------------------------- 4. 内置名与重名就地拒绝

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

	// 添加表单就是展开的那一行本身；空白草稿的名字进输入框。
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

	// 客户端在服务器看到列表之前就以同样方式拒绝重名。
	reserved!.value = "只读";
	reserved!.dispatch("input");
	save.dispatch("click");
	await flush();
	check("重名被拒绝", saves.length === 0, JSON.stringify(saves));

	// 空工具列表是一次选择，不是失误：保存它照常通过。
	reserved!.value = "全关";
	reserved!.dispatch("input");
	save.dispatch("click");
	await flush();
	check("空工具集的模式照常保存", saves.length === 1 && saves[0]?.[1]?.name === "全关" && saves[0]?.[1]?.tools.length === 0, JSON.stringify(saves));
	form = all(panel.element as unknown as FakeNode, "model-form")[0];
	check("保存后表单收起", form === undefined);
}

// ------------------------------------------------------------- 5. 删除先问一次

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

	// 默认卡没有回收站：没有什么可删的。
	const defaultTrash = byTitle(rows[0] as FakeNode, "删除这个模式");
	check("默认卡没有删除", defaultTrash === undefined);
}

// --------------------------------------------------------------- 6. 座位与菜单行

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

	// 菜单挂在座位上：每个模式一行、带它的摘要行，点击即应用。
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

// --------------------------------------------------------------------- 7. 摘要助手

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
