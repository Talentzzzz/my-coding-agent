import { element, icon, iconButton, option } from "../dom.ts";
import {
	APPROVAL_TOOLS,
	type BashSettings,
	type ModeSettings,
	type ModelInput,
	type ModelOption,
	type GlobalSettingsSnapshot,
	type SessionSnapshot,
} from "@my-agent/core/protocol";
import type { AppearanceSettings } from "../ui-settings.ts";

/**
 * 内置默认模式的名字，在这里复述而不是导入。
 *
 * 常量的家（`@my-agent/core` 的 `types.ts`）跑在 Node 上，客户端绝不能把它拉进 bundle —— 与字号
 * 范围出于同样理由遵循的同一条复述规则。
 */
const DEFAULT_MODE_NAME = "默认";

/** 一条被编辑的行。`apiKey` 只有用户本次输入了新密钥时才存在。 */
export interface ModelDraft extends ModelOption {
	apiKey?: string;
}

/** 一个被编辑的模式：存储形状本身 —— 模式没有要留一手的秘密。 */
type ModeDraft = ModeSettings;

/** 一个什么都不设置的模式：每个工具关、每个工具自动允许 —— 原型的"新模式"。 */
function blankMode(): ModeDraft {
	const approval: Record<string, boolean> = {};
	for (const key of APPROVAL_TOOLS) approval[key] = false;
	return { name: "新模式", tools: [], approval };
}

/** 一个模式的一行摘要，与原型的模式菜单同一形状。 */
export function modeSummaryOf(tools: readonly string[], approval: Record<string, boolean>): string {
	const ask = tools.filter((tool) => approval[tool] === true).length;
	return `${tools.length} 个工具 · ${ask} 项询问`;
}

export interface SettingsHandlers {
	onClose(): void;
	onTheme(theme: "system" | "light" | "dark"): void;
	onFontSize(size: number): void;
	onSaveModels(rows: ModelInput[]): Promise<void>;
	onSaveModes(modes: ModeSettings[]): Promise<void>;
	onDefaultModel(ref: string): void;
	/** 全局默认活跃工具集，整体 —— 内置默认模式的保存写它。 */
	onGlobalTools(names: string[]): Promise<void>;
	/** 全局默认审批表的一个工具，内置默认模式读它。 */
	onGlobalApproval(tool: string, value: boolean): Promise<void>;
	onBashTimeouts(patch: Partial<BashSettings>): void;
}

export interface SettingsState {
	settings?: GlobalSettingsSnapshot;
	/**
	 * 本窗口的 UI 设置的外观半（ADR-0029）：它住在客户端自己的存储，不骑服务端的设置快照。
	 * 外观页从它读；主题与字号的变更经 handlers 立即写回。
	 */
	appearance?: AppearanceSettings;
	models: readonly ModelOption[];
	/**
	 * 屏幕上的会话，若有。会话级的选择（模式座位、审批增量）从这里读。
	 */
	snapshot?: SessionSnapshot;
	/**
	 * 本构建注册的工具名清单（ADR-0020），启动时从 `GET /api/tools` 取一次。名字清单是进程级
	 * 事实、不随会话走，所以不再经过快照；清单还没取到的一瞬是空表，六个内置顶上。
	 */
	toolNames: readonly string[];
}

type Tab = "appearance" | "models" | "modes" | "defaults";

/**
 * 新行的起点，让表单从不带着空数字打开。
 *
 * 端点是 Anthropic 自己的，作为填好的默认而不是选择：每行都走 Anthropic Messages，指向空处的
 * 空白表单只会让用户重新输入那个几乎总是对的 URL。代理或中转是同一字段换个值。
 *
 * 空名字是表单说"还没起名"的方式：服务端拿 wire id 当名字，这就是卡片两个都填上之前一直开着
 * 的原因。
 */
const BLANK_DRAFT: ModelDraft = {
	name: "",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	id: "",
	contextWindow: 200_000,
	maxTokens: 8_192,
	thinkingLevels: [],
	hasApiKey: false,
};

/**
 * 表单是否有一行离不开的三个字段。
 *
 * 服务端拒绝没有自己的名字、没有模型 id、没有端点的行 —— 与旧卡片保持开启的是同样的三个 ——
 * 所以 保存 在它们填上之前禁用，而不是在点击之后把拒绝当错误转发。
 */
function formComplete(form: ModelDraft): boolean {
	return form.name.trim().length > 0 && form.id.trim().length > 0 && form.baseUrl.trim().length > 0;
}

/**
 * 应用级设置面板。
 *
 * 它持有比一段对话更长久的东西：窗口如何绘制自己、这台机器导入了哪些模型、从未选择过的会话
 * 开启时的默认 —— 默认模型、bash 超时、全局默认工具集与审批表（它们就是内置默认模式）、以及
 * 用户命名的模式。会话自己运行的工具与审批不在这里：它们跟随对话、在 composer 的模式席位选择，
 * 那里经会话自己的 `.json` 快照应用预设，没有第二个手动编辑它们的面板。留给这里的是很少被访问、
 * 刻意才改动的东西，这正是藏在侧栏一个按钮后面的面板该有的样子，而不是一排永远可见的控件。
 *
 * 模型列表一次编辑一行、一次保存一个动作：内联表单的 保存 和确认后的删除各自整体发送列表，
 * 因为半保存的列表是唯一谁也无法推理的状态 —— 这里删一行、那里加一行的两处变更必须一起落地。
 * 外观控件相反 —— 立即生效，因为看到字号正是选择它的方式。
 */
export class SettingsPanel {
	readonly element: HTMLElement;
	private readonly handlers: SettingsHandlers;
	private readonly body: HTMLElement;
	private readonly navItems: { id: Tab; button: HTMLButtonElement }[] = [];
	private readonly note: HTMLElement;

	private settingsState: SettingsState = { models: [], toolNames: [] };
	private tab: Tab = "appearance";
	/**
	 * 打开交互开始时的行，面板显示服务端持有的东西时为 undefined。
	 *
	 * 持有而不是每次渲染重读，让半输入的表单和它编辑的行坐在同一份冻结的清单上：编辑中途从服务端
	 * 到来的模型绝不能把表单下面的行挪走。一次只开一个交互，交互结束 —— 保存、确认或取消 —— 时
	 * 清除。
	 */
	private frozen?: ModelDraft[];
	/** 哪一行正打开编辑：行下标，或添加表单的空白行。 */
	private editing?: number | "new";
	/** 删除确认正站在其下的那一行。 */
	private confirming?: number;
	/** 打开的表单里输入的值，恰好表单开着时存在。 */
	private form?: ModelDraft;
	private saving = false;
	private signature = "";
	/**
	 * 模式标签页自己的交互状态，与模型的并排而不是共享：两个列表按同一条一次一个交互的规则编辑，
	 * 但它们的行形状不同、提交去向不同的端点，共享字段会把两条绝不能一起动的保存路径耦在一起。
	 */
	private modeFrozen?: ModeDraft[];
	/** 哪个模式正打开编辑：行下标，或添加表单的空白行。 */
	private modeEditing?: number | "new";
	/** 删除确认正站在其下的那个模式。 */
	private modeConfirming?: number;
	/** 打开的模式表单里输入的值，恰好开着时存在。 */
	private modeForm?: ModeDraft;
	/**
	 * 内置默认卡片是否打开编辑。它与存储模式的行是两个交互，因为它没有可冻结的清单 —— 它的
	 * 草稿就是全局默认 —— 但两者同时只开一个。
	 */
	private defaultEditing = false;
	/** 打开的默认表单正在编辑的全局默认，恰好开着时存在。 */
	private defaultForm?: ModeDraft;

	constructor(handlers: SettingsHandlers) {
		this.handlers = handlers;

		// 面板钉在视口上而不是按内容定尺寸（style.css 的 `.app-settings`），切换区块不会让它在指针
		// 下变大小。标题住在导航列，只有关闭控件留在内容列的头部。
		this.element = element("div", "settings-overlay", undefined, { hidden: true });
		const panel = element("div", "settings app-settings", undefined, { role: "dialog", "aria-label": "设置" });

		const nav = element("nav", "settings-nav");
		nav.append(element("h2", "settings-nav-title", "设置"));
		const navList = element("div", "settings-nav-list");
		for (const [id, label] of [
			["appearance", "外观"],
			["models", "模型"],
			["modes", "模式"],
			["defaults", "默认"],
		] as [Tab, string][]) {
			const button = element("button", "settings-nav-item", label, { type: "button" });
			button.addEventListener("click", () => {
				this.tab = id;
				this.renderNav();
				this.renderBody();
			});
			this.navItems.push({ id, button });
			navList.append(button);
		}
		nav.append(navList);

		const head = element("header", "settings-head");
		head.append(iconButton("close", "关闭设置", () => this.handlers.onClose()));

		const content = element("div", "settings-content");
		this.note = element("div", "settings-note");
		this.body = element("div", "settings-body");
		content.append(head, this.body, this.note);
		panel.append(nav, content);

		// 点击面板身后的暗区关闭；点内部绝不。
		this.element.addEventListener("click", (event) => {
			if (event.target === this.element) this.handlers.onClose();
		});

		this.element.append(panel);
	}

	get open(): boolean {
		return !this.element.hidden;
	}

	/**
	 * 打开面板，可选直接落到某个标签页 —— composer 的「去设置 › 模式」指名它的标签，因为点击
	 * 已经说了人要去那里做什么。
	 */
	show(tab?: Tab): void {
		if (tab !== undefined) this.tab = tab;
		this.element.hidden = false;
		this.clearInteraction();
		this.saving = false;
		this.signature = "";
		this.render();
	}

	hide(): void {
		this.element.hidden = true;
	}

	render(settingsState: SettingsState = this.settingsState): void {
		this.settingsState = settingsState;

		// 重建 body 会丢掉半输入的行，所以只在标签正在显示的东西真的动了时发生。打开的交互把 body
		// 整个冻结：表单是屏幕上唯一无法从状态重建的东西，因为它的最新值活在 DOM 和两个草稿字段
		// 里，而编辑中途到达的帧 —— 快照、流的节拍 —— 绝不能抢走输入所在的焦点。存储的模式经
		// `modeFrozen` 冻结，模型行走 `frozen`，内置默认卡片有自己的标志。冻结随交互结束，下一次
		// 渲染再照常比较签名。
		const signature = [
			this.tab,
			settingsState.appearance
				? [
						settingsState.appearance.theme,
						settingsState.appearance.fontSize,
					].join("/")
				: "",
			settingsState.settings
				? [
						settingsState.settings.bash.defaultTimeoutMs,
						settingsState.settings.bash.maxTimeoutMs,
						settingsState.settings.tools?.join(",") ?? "",
						Object.entries(settingsState.settings.approval).join(","),
						(settingsState.settings.modes ?? [])
							.map((mode) => `${mode.name}:${mode.tools.join(",")}:${Object.entries(mode.approval).join(",")}`)
							.join(";"),
					].join("/")
				: "",
			settingsState.models.map((model) => `${model.name}:${model.id}:${model.hasApiKey}`).join(","),
			settingsState.toolNames.join(","),
		].join("|");

		const stable =
			this.frozen !== undefined || this.modeFrozen !== undefined || this.defaultEditing || signature === this.signature;
		this.signature = signature;
		this.renderNav();
		if (!stable) this.renderBody();
	}

	/** 在 body 下方报告一次保存的结果，引发它的按钮在那里。 */
	reportNote(message: string, tone: "ok" | "error"): void {
		this.note.textContent = message;
		this.note.dataset.tone = tone;
	}

	/**
	 * 当前的行，让调用者可以不读 DOM 就把它们交给 API。
	 *
	 * 交互开着时是冻结的清单 —— 表单是对着它打开的 —— 否则是服务端的清单，复制过，让调用者
	 * splice 而不碰状态。
	 */
	get rows(): ModelDraft[] {
		return this.frozen ?? this.settingsState.models.map((model) => ({ ...model }));
	}

	private renderNav(): void {
		for (const { id, button } of this.navItems) {
			button.classList.toggle("active", id === this.tab);
			// 一列纯按钮的垂直导航：用 aria-current 而不是 aria-selected，后者只在列表不携带的
			// tablist 角色上有意义。
			if (id === this.tab) button.setAttribute("aria-current", "true");
			else button.removeAttribute("aria-current");
		}
	}

	private renderBody(): void {
		this.note.textContent = "";
		switch (this.tab) {
			case "appearance":
				this.body.replaceChildren(this.appearanceSection());
				return;
			case "models":
				this.body.replaceChildren(this.modelsSection());
				return;
			case "modes":
				this.body.replaceChildren(this.modesSection());
				return;
			default:
				this.body.replaceChildren(this.defaultsSection());
		}
	}

	// ------------------------------------------------------------------ appearance

	private appearanceSection(): HTMLElement {
		const appearance = this.settingsState.appearance;
		const section = element("section", "settings-section");

		const themeRow = element("div", "settings-field");
		themeRow.append(element("span", "settings-label", "主题"));
		const group = element("div", "segmented");
		const current = appearance?.theme ?? "system";
		for (const [value, label, iconName] of [
			["system", "跟随系统", "monitor"],
			["light", "浅色", "sun"],
			["dark", "深色", "moon"],
		] as const) {
			const button = element("button", `segment${value === current ? " active" : ""}`, undefined, { type: "button" });
			button.append(icon(iconName), element("span", undefined, label));
			button.addEventListener("click", () => this.handlers.onTheme(value));
			group.append(button);
		}
		themeRow.append(group);
		section.append(themeRow);

		const sizeRow = element("div", "settings-field");
		sizeRow.append(element("span", "settings-label", "字号"));
		// 兜底是 ./ui-settings.ts 的 DEFAULT_APPEARANCE.fontSize，在这里复述 —— 滑块的 10–22
		// 两端是同一种复述（FONT_SIZE_RANGE），理由相同。
		const size = appearance?.fontSize ?? 15;
		const value = element("span", "settings-value", `${size}px`);
		const slider = element("input", "slider", undefined, {
			type: "range",
			min: 10,
			max: 22,
			step: 1,
			value: size,
			"aria-label": "字号",
		});
		slider.addEventListener("input", () => {
			value.textContent = `${slider.value}px`;
		});
		// 松手时提交而不是拖动的每个像素都提交：滑块的每一步都是对设置文件的一次写，一次拖动会是
		// 几十次。
		slider.addEventListener("change", () => this.handlers.onFontSize(Number(slider.value)));
		const control = element("div", "settings-control");
		control.append(slider, value);
		sizeRow.append(control);
		section.append(sizeRow);

		return section;
	}

	// ---------------------------------------------------------------------- models

	private modelsSection(): HTMLElement {
		const rows = this.rows;
		const section = element("section", "settings-section");

		section.append(
			element(
				"p",
				"settings-hint",
				"每个模型是一行「端点 + 密钥」。点击条目中部进入编辑；右侧回收站删除；「＋ 添加模型」直接展开一张空表单。",
			),
		);

		if (rows.length === 0 && this.editing !== "new") {
			section.append(element("p", "settings-hint empty", "还没有模型。添加一个才能开始对话。"));
		}

		for (const [index, row] of rows.entries()) section.append(this.modelRow(row, index));

		// 添加表单就是展开的那一行，而不是按钮切换出的模式，所以它开着时按钮退下 —— 第二次点击
		// 已经没有东西可加。
		if (this.editing === "new" && this.form !== undefined) {
			section.append(this.modelForm(this.form, () => this.closeInteraction(), () => void this.commitAdd()));
		} else {
			const add = element("button", "model-add", undefined, { type: "button" });
			add.append(icon("plus"), element("span", undefined, "添加模型"));
			add.addEventListener("click", () => this.beginAdd());
			section.append(add);
		}

		return section;
	}

	/**
	 * 一行：打开它编辑的头部、问一次的回收站，以及打开时的表单。
	 *
	 * 头部是覆盖行中部的按钮 —— 名字和 wire ref —— 回收站骑在旁边、悬停时露出。它们是兄弟而不是
	 * 头部包着回收站，因为按钮不能装按钮；回收站定位于头部预留的右侧内边距上。
	 */
	private modelRow(modelDraft: ModelDraft, index: number): HTMLElement {
		const rowEl = element("div", "model-row");
		if (this.editing === index) rowEl.classList.add("editing");
		if (this.confirming === index) rowEl.classList.add("confirming");

		const head = element("button", "model-row-head", undefined, { type: "button" });
		head.append(
			element("span", "model-label", modelDraft.name.length > 0 ? modelDraft.name : "新模型"),
			element("span", "model-ref", modelDraft.id.length > 0 ? `${modelDraft.name || "未命名"}/${modelDraft.id}` : "未配置"),
		);
		head.addEventListener("click", () => this.beginEdit(index));
		rowEl.append(head);

		rowEl.append(iconButton("trash", "删除这个模型", () => this.beginConfirm(index), "icon-button model-row-del"));

		if (this.editing === index && this.form !== undefined) {
			rowEl.append(this.modelForm(this.form, () => this.closeInteraction(), () => void this.commitRow(index)));
		}
		if (this.confirming === index) rowEl.append(this.confirmBar(modelDraft, index));

		return rowEl;
	}

	/**
	 * 删除确认，站在它将要作用的那一行里。
	 *
	 * 一次确认，然后删除：确认条就地发问 —— 指名它即将移除的行 —— 两个答案都把它收下，破坏性的
	 * 那个以发送缩短后的列表收下。按钮按原型的顺序放，破坏性的在前。
	 */
	private confirmBar(modelDraft: ModelDraft, index: number): HTMLElement {
		const bar = element("div", "model-confirm");
		bar.append(element("span", undefined, `删除 ${modelDraft.name.length > 0 ? modelDraft.name : "未命名"}？此操作不可撤销。`));
		bar.append(element("span", "model-confirm-spacer"));
		const remove = element("button", "button danger", undefined, { type: "button" });
		remove.textContent = "删除";
		remove.disabled = this.saving;
		remove.addEventListener("click", () => void this.commitRemove(index));
		bar.append(remove);
		const cancel = element("button", "button", undefined, { type: "button" });
		cancel.textContent = "取消";
		cancel.addEventListener("click", () => this.closeInteraction());
		bar.append(cancel);
		return bar;
	}

	/**
	 * 内联表单，编辑与添加共用。
	 *
	 * 输入写 `this.form` 且从不重渲染 —— 每击键一次重建会抢走输入所在的焦点 —— 所以表单里唯一
	 * 读它的部分（保存的门）由手工同步。省略的 API key 让服务端保留已存的那个，所以字段是替换
	 * 的提示，而不是展示的值。
	 */
	private modelForm(draft: ModelDraft, onCancel: () => void, onSave: () => void): HTMLElement {
		const form = element("div", "model-form");
		let save: HTMLButtonElement | undefined;
		const syncSave = (): void => {
			if (save !== undefined) save.disabled = this.saving || !formComplete(this.form ?? draft);
		};
		const update = (patch: Partial<ModelDraft>): void => {
			this.form = { ...(this.form ?? draft), ...patch };
			syncSave();
		};

		form.append(
			this.textField("名称", draft.name, "这个名字同时是它的身份：改名等于换一个模型，用过它的会话要重新选", (value) =>
				update({ name: value }),
			),
		);
		form.append(this.textField("模型", draft.id, "接口那边的名字，例如 claude-opus-5", (value) =>
			update({ id: value }),
		));
		form.append(this.textField("BASE URL", draft.baseUrl, "Anthropic Messages 接口的地址；代理或中转填它自己的", (value) =>
			update({ baseUrl: value }),
		));
		form.append(this.keyField(draft, update));
		form.append(
			this.numberField("上下文长度", draft.contextWindow, "模型能接受多少 tokens；压缩由它决定", (value) =>
				update({ contextWindow: value }),
			),
		);
		form.append(
			this.numberField("最大输出长度", draft.maxTokens, "一次回答最多多少 tokens", (value) => update({ maxTokens: value })),
		);

		const actions = element("div", "model-actions");
		const cancel = element("button", "button", undefined, { type: "button" });
		cancel.textContent = "取消";
		cancel.addEventListener("click", onCancel);
		save = element("button", "button primary", undefined, { type: "button" });
		save.textContent = this.saving ? "保存中…" : "保存";
		save.addEventListener("click", onSave);
		actions.append(cancel, save);
		form.append(actions);
		syncSave();

		return form;
	}

	private keyField(modelDraft: ModelDraft, update: (patch: Partial<ModelDraft>) => void): HTMLElement {
		const input = element("input", "input", undefined, {
			type: "password",
			autocomplete: "off",
			// 已存的密钥从不发给浏览器，所以这是替换它的提示，不是展示它的字段。
			placeholder: modelDraft.hasApiKey ? "•••••••• 已保存 — 输入即可替换" : "未设置",
		});
		input.addEventListener("input", () => update({ apiKey: input.value }));
		return this.field("API KEY", input, "保存在本机，不会回传给浏览器；这是唯一的鉴权方式");
	}

	private textField(label: string, value: string, hint: string, onInput: (value: string) => void): HTMLElement {
		const input = element("input", "input", undefined, { type: "text", value });
		input.addEventListener("input", () => onInput(input.value));
		return this.field(label, input, hint);
	}

	private numberField(label: string, value: number, hint: string, onInput: (value: number) => void): HTMLElement {
		const input = element("input", "input", undefined, { type: "number", min: 1, value });
		input.addEventListener("input", () => {
			const parsed = Number(input.value);
			if (Number.isFinite(parsed) && parsed > 0) onInput(parsed);
		});
		return this.field(label, input, hint);
	}

	private field(label: string, control: HTMLElement, hint: string): HTMLElement {
		const wrapper = element("label", "model-field");
		wrapper.append(element("span", "settings-label", label), control, element("span", "model-hint", hint));
		return wrapper;
	}

	// ------------------------------------------------- 模型交互

	/** 打开一个交互 —— 一行、添加表单、或一次删除确认 —— 并关掉站着的那个。 */
	private begin(next: { editing?: number | "new"; confirming?: number; form?: ModelDraft }): void {
		this.editing = next.editing;
		this.confirming = next.confirming;
		this.form = next.form;
		// 没有打开的东西就没有要对着冻结的：下一次渲染可以比较签名并从服务端持有的东西重建。
		// 已有交互站着时重新冻结，保住表单输入时对着的那份清单，而不是在编辑中途把它挪到表单
		// 底下。
		this.frozen =
			next.editing === undefined && next.confirming === undefined ? undefined : this.rows;
		this.renderBody();
	}

	private beginEdit(index: number): void {
		const row = this.rows.at(index);
		if (row === undefined) return;
		this.begin({ editing: index, form: { ...row } });
	}

	private beginAdd(): void {
		this.begin({ editing: "new", form: { ...BLANK_DRAFT } });
		// 表单在列表末尾打开，列表长时在折叠处之下，所以它自己走进视野 —— 原型给那次点击的
		// 同一份礼遇。
		this.body.lastElementChild?.scrollIntoView({ block: "nearest" });
	}

	private beginConfirm(index: number): void {
		if (this.rows.at(index) === undefined) return;
		this.begin({ confirming: index });
	}

	/** 不保存地收下一个打开的表单或确认。 */
	private closeInteraction(): void {
		this.begin({});
	}

	/** 直接结束任何打开的交互，连同两份冻结一起丢掉。 */
	private clearInteraction(): void {
		this.editing = undefined;
		this.confirming = undefined;
		this.form = undefined;
		this.frozen = undefined;
		this.dropModeInteraction();
		this.dropDefaultForm();
	}

	/** 不重画地丢掉一个存储模式打开的表单 —— 关闭它的状态那一半。 */
	private dropModeInteraction(): void {
		this.modeEditing = undefined;
		this.modeConfirming = undefined;
		this.modeForm = undefined;
		this.modeFrozen = undefined;
	}

	/** 不重画地丢掉内置默认卡片打开的表单。 */
	private dropDefaultForm(): void {
		this.defaultEditing = false;
		this.defaultForm = undefined;
	}

	/**
	 * 把一个动作的清单整体发送，并折入答案。
	 *
	 * 每个动作 —— 一行的 保存、一次确认的 删除、添加表单的 保存 —— 都落到它想要存储的清单，
	 * 因为端点是整体替换：`apiKey` 省略的行保留已存的那个，所以没动过的行带着这个面板从未见过的
	 * 密钥往返。成功结束交互并解除冻结，下一次渲染显示服务端实际存储的东西，而不是输入的东西。
	 */
	private async commit(rows: ModelInput[]): Promise<void> {
		this.saving = true;
		this.renderBody();
		let outcome: { message: string; tone: "ok" | "error" } | undefined;
		try {
			await this.handlers.onSaveModels(rows);
			this.clearInteraction();
			this.signature = "";
		} catch (error) {
			outcome = { message: error instanceof Error ? error.message : String(error), tone: "error" };
		} finally {
			this.saving = false;
			this.renderBody();
		}
		// 在重建之后而不是之前上报，因为 renderBody 进门时会清掉 note —— 先上报，结果就会被那趟
		// 恰好为它腾出地方的重绘抹掉。成功什么都不说：表单关闭、行显示服务端存的东西就是确认，
		// 每次保存下面都来一条绿色的"已保存"，只是为窗口已经显示的事实多一件要读的东西。
		if (outcome !== undefined) this.reportNote(outcome.message, outcome.tone);
	}

	private async commitRow(index: number): Promise<void> {
		const form = this.form;
		if (form === undefined || !formComplete(form)) return;
		await this.commit(this.rows.map((row, at) => (at === index ? form : row)));
	}

	private async commitAdd(): Promise<void> {
		const form = this.form;
		if (form === undefined || !formComplete(form)) return;
		await this.commit([...this.rows, form]);
	}

	private async commitRemove(index: number): Promise<void> {
		if (this.rows.at(index) === undefined) return;
		await this.commit(this.rows.filter((_row, at) => at !== index));
	}

	// ---------------------------------------------------------------- 模式

	/**
	 * 模式标签页：内置默认卡片，以及它下面的用户模式。
	 *
	 * 默认卡片是全局默认的 live 读取（ADR-0005）—— 过去 defaults 标签页带的同样两个控件，搬到
	 * 这里因为一个模式*就是*一个工具集加一个审批集，通往同一个值的两扇门只会漂移。它读起来像
	 * 用户的模式：一行的头部打开内联表单，其 保存 写全局的 `tools` 和 `approval` 而不是 `modes`
	 * 清单。用户的模式拥有与模型行相同的内联编辑 / 确认删除。
	 */
	private modesSection(): HTMLElement {
		const section = element("section", "settings-section");
		section.append(
			element(
				"p",
				"settings-hint",
				"模式 = 一组工具与审批配置。会话在输入框左下角选择模式；模式只能在这里修改，会话只用。",
			),
		);
		section.append(this.defaultModeCard());

		const modes = this.modeRows;
		for (const [index, mode] of modes.entries()) section.append(this.modeRow(mode, index));

		if (this.modeEditing === "new" && this.modeForm !== undefined) {
			section.append(this.modeFormCard(this.modeForm, () => this.closeModeInteraction(), () => void this.commitModeAdd()));
		} else {
			const add = element("button", "model-add", undefined, { type: "button" });
			add.append(icon("plus"), element("span", undefined, "新建模式"));
			add.addEventListener("click", () => this.beginAddMode());
			section.append(add);
		}
		return section;
	}

	/** 现在的模式：交互开着时是冻结的清单，否则是服务端的。 */
	private get modeRows(): ModeDraft[] {
		return this.modeFrozen ?? (this.settingsState.settings?.modes ?? []).map((mode) => ({ ...mode, approval: { ...mode.approval } }));
	}

	/**
	 * 一个模式的表单提供的工具，按开关行绘制的顺序。
	 *
	 * 本构建自己的清单（启动时从 `GET /api/tools` 取，ADR-0020）——还没取到的一瞬六个内置顶上
	 * ——加上模式已经指名、构建不再有的任何东西，让升级删掉的工具仍然能被取消勾选，而不是被
	 * 悄悄带着。兜底清单只是显示的便利：清单缺失只发生在启动的一瞬，不会把六个写在一个可能
	 * 更多的集合上。
	 */
	private modeToolList(mode: ModeDraft): string[] {
		const all = this.settingsState.toolNames;
		const base = all.length > 0 ? [...all] : [...APPROVAL_TOOLS];
		for (const name of mode.tools) if (!base.includes(name)) base.push(name);
		return base;
	}

	/**
	 * 内置默认模式：从不存储，永远是全局默认。
	 *
	 * 它打开与存储模式相同的内联表单，带着作为 live 视图而非行（ADR-0005）而生的两处不同：名字
	 * 是标签而不是输入，保存 写全局的 `tools`/`approval` 而不是 `modes` 清单。折叠时它是与用户
	 * 模式相同的一行，所以读起来是平级，而不是一个永远展开的面板。
	 */
	private defaultModeCard(): HTMLElement {
		const settings = this.settingsState.settings;
		const allTools = this.settingsState.toolNames;
		const storedTools = settings?.tools ?? allTools;
		// 摘要指名与 composer 默认行相同的工具：构建清单在手上时，升级删掉的存储名不是本构建
		// 有的工具，这里也不计入。清单还没取到的一瞬，文件里是什么就是唯一真实的答案。
		const summaryTools = allTools.length === 0 ? storedTools : storedTools.filter((name) => allTools.includes(name));
		const card = element("div", "model-row mode-default");
		if (this.defaultEditing) card.classList.add("editing");

		const head = element("button", "model-row-head", undefined, { type: "button" });
		head.append(element("span", "model-label", DEFAULT_MODE_NAME), element("span", "mode-badge", "内置"));
		if (!this.defaultEditing) {
			head.append(element("span", "mode-summary", modeSummaryOf(summaryTools, settings?.approval ?? {})));
		}
		head.addEventListener("click", () => this.beginDefaultEdit());
		card.append(head);

		if (this.defaultEditing && this.defaultForm !== undefined) {
			card.append(
				this.modeFormCard(this.defaultForm, () => this.closeDefaultInteraction(), () => void this.commitDefault(), {
					builtIn: true,
				}),
			);
		}
		return card;
	}

	/** 一个用户模式：打开它的头部、问一次的回收站，以及打开时的表单。 */
	private modeRow(mode: ModeDraft, index: number): HTMLElement {
		const row = element("div", "model-row");
		if (this.modeEditing === index) row.classList.add("editing");
		if (this.modeConfirming === index) row.classList.add("confirming");

		const head = element("button", "model-row-head", undefined, { type: "button" });
		head.append(
			element("span", "model-label", mode.name),
			element("span", "mode-summary", modeSummaryOf(mode.tools, mode.approval)),
		);
		head.addEventListener("click", () => this.beginModeEdit(index));
		row.append(head);

		row.append(iconButton("trash", "删除这个模式", () => this.beginModeConfirm(index), "icon-button model-row-del"));

		if (this.modeEditing === index && this.modeForm !== undefined) {
			row.append(this.modeFormCard(this.modeForm, () => this.closeModeInteraction(), () => void this.commitModeRow(index)));
		}
		if (this.modeConfirming === index) row.append(this.modeConfirmBar(mode, index));

		return row;
	}

	/** 一个模式的删除确认，站在它将要作用的那一行里。 */
	private modeConfirmBar(mode: ModeDraft, index: number): HTMLElement {
		const bar = element("div", "model-confirm");
		bar.append(element("span", undefined, `删除模式「${mode.name}」？此操作不可撤销。`));
		bar.append(element("span", "model-confirm-spacer"));
		const remove = element("button", "button danger", undefined, { type: "button" });
		remove.textContent = "删除";
		remove.disabled = this.saving;
		remove.addEventListener("click", () => void this.commitModeRemove(index));
		bar.append(remove);
		const cancel = element("button", "button", undefined, { type: "button" });
		cancel.textContent = "取消";
		cancel.addEventListener("click", () => this.closeModeInteraction());
		bar.append(cancel);
		return bar;
	}

	/**
	 * 一个模式的工具表：每个工具一行开关，审批下拉骑在旁边。
	 *
	 * 它永远编辑草稿：内置默认卡片的草稿是全局默认，存储模式的表单是各自的行，只有 保存 把任何
	 * 一个变成写。只有审批表有键的工具带下拉 —— 被委托的调用按设计不问任何人 —— 所以注册表
	 * 多出来的工具只画开关。未勾选工具的下拉禁用而不是隐藏：它将持有的选择仍然属于这个模式。
	 */
	private modeToolTable(mode: ModeDraft): HTMLElement {
		const table = element("div", "mode-tooltable");

		const active = new Set(mode.tools);
		for (const name of this.modeToolList(mode)) {
			const row = element("div", "mode-tool");
			const box = element("input", undefined, undefined, { type: "checkbox", "aria-label": `启用 ${name}` });
			box.checked = active.has(name);
			box.addEventListener("change", () => {
				const tools = new Set(mode.tools);
				if (box.checked) tools.add(name);
				else tools.delete(name);
				mode.tools = [...tools];
			});
			row.append(box, element("span", "mode-tool-name", name));

		if (APPROVAL_TOOLS.includes(name)) {
			const select = element("select", "input mode-tool-approval");
			select.append(option("allow", "自动允许"), option("ask", "每次询问"));
			select.value = mode.approval[name] === true ? "ask" : "allow";
			select.disabled = !box.checked;
			box.addEventListener("change", () => {
				select.disabled = !box.checked;
			});
			select.addEventListener("change", () => {
				mode.approval[name] = select.value === "ask";
			});
				row.append(select);
			}
			table.append(row);
		}
		return table;
	}

	/**
	 * 内联模式表单，编辑、添加和内置默认卡片共用。
	 *
	 * 存储模式的名字是输入，因为名字是它的身份。内置的名字是带徽章的标签：它是全局默认，给它
	 * 改名不是一个存在的东西。
	 */
	private modeFormCard(
		draft: ModeDraft,
		onCancel: () => void,
		onSave: () => void,
		options: { builtIn?: boolean } = {},
	): HTMLElement {
		const form = element("div", "model-form");
		if (options.builtIn === true) {
			const shown = element("div", "mode-name-static");
			shown.append(element("span", "model-label", DEFAULT_MODE_NAME), element("span", "mode-badge", "内置"));
			const nameField = element("div", "model-field");
			nameField.append(
				element("span", "settings-label", "模式名称"),
				shown,
				element("span", "model-hint", "内置模式的名称不可改。它的工具与审批就是全局默认，保存写回全局设置，不写模式列表。"),
			);
			form.append(nameField);
		} else {
			const nameInput = element("input", "input", undefined, { type: "text", value: draft.name });
			nameInput.addEventListener("input", () => {
				draft.name = nameInput.value;
			});
			const nameField = element("label", "model-field");
			nameField.append(
				element("span", "settings-label", "模式名称"),
				nameInput,
				element("span", "model-hint", "这个名字是模式的身份；「默认」是内置模式的名字，不能用"),
			);
			form.append(nameField);
		}

		form.append(this.modeToolTable(draft));

		const actions = element("div", "model-actions");
		const cancel = element("button", "button", undefined, { type: "button" });
		cancel.textContent = "取消";
		cancel.addEventListener("click", onCancel);
		const save = element("button", "button primary", undefined, { type: "button" });
		save.textContent = this.saving ? "保存中…" : "保存";
		save.disabled = this.saving;
		save.addEventListener("click", onSave);
		actions.append(cancel, save);
		form.append(actions);
		return form;
	}

	// ------------------------------------------------ 模式交互

	/** 打开一个模式交互并关掉站着的那个，冻结它编辑所对的清单。 */
	private beginMode(next: { editing?: number | "new"; confirming?: number; form?: ModeDraft }): void {
		this.dropDefaultForm();
		this.modeEditing = next.editing;
		this.modeConfirming = next.confirming;
		this.modeForm = next.form;
		this.modeFrozen =
			next.editing === undefined && next.confirming === undefined ? undefined : this.modeRows;
		this.renderBody();
	}

	private beginModeEdit(index: number): void {
		const mode = this.modeRows.at(index);
		if (mode === undefined) return;
		this.beginMode({ editing: index, form: { ...mode, approval: { ...mode.approval } } });
	}

	private beginAddMode(): void {
		this.beginMode({ editing: "new", form: blankMode() });
		this.body.lastElementChild?.scrollIntoView({ block: "nearest" });
	}

	private beginModeConfirm(index: number): void {
		if (this.modeRows.at(index) === undefined) return;
		this.beginMode({ confirming: index });
	}

	private closeModeInteraction(): void {
		this.beginMode({});
	}

	/**
	 * 打开内置默认卡片的表单，以当前的全局默认播种。
	 *
	 * 草稿在 保存 之前是卡片自己的，所以每次点击不写一次设置文件；存储模式的表单先关，因为一次
	 * 只开一个交互。播种保持 `settings.tools` 原样而不是收窄它，让升级删掉的工具仍然有一行
	 * —— 勾着的 —— 可以关掉，保存时再从全局集合里去掉它。
	 */
	private beginDefaultEdit(): void {
		if (this.defaultEditing) return;
		const settings = this.settingsState.settings;
		const allTools = this.settingsState.toolNames;
		this.dropModeInteraction();
		this.defaultEditing = true;
		this.defaultForm = {
			name: DEFAULT_MODE_NAME,
			tools: settings?.tools === undefined ? [...allTools] : [...settings.tools],
			approval: { ...(settings?.approval ?? {}) },
		};
		this.renderBody();
	}

	/** 不保存地收下打开的默认表单。 */
	private closeDefaultInteraction(): void {
		this.dropDefaultForm();
		this.renderBody();
	}

	/**
	 * 保存默认表单：全局的 `tools` 和 `approval`，绝不是 `modes` 清单。
	 *
	 * 工具集以本构建自己的顺序整体写入 —— 每次工具集写入的同一契约 —— 并收窄到本构建认识的
	 * 工具，升级删掉的名字在这里也被去掉。审批经 `onGlobalApproval` 一次一键移动，且只动动过的
	 * 键：只碰了工具的保存绝不重写审批表。名字清单还没取到（启动拉取未应答）时保存是空操作。
	 *
	 * 写入在表单关闭之前 await。每个答案携带整个设置对象，折叠的摘要从最后一个画；先关会让摘要
	 * 从旧值闪现，而补丁还在路上。按钮 meanwhile 说 保存中…，与存储模式的保存同样的等待。
	 */
	private async commitDefault(): Promise<void> {
		const draft = this.defaultForm;
		const grounded = this.settingsState.toolNames;
		if (draft === undefined || grounded.length === 0) return;

		const nextTools = grounded.filter((name) => draft.tools.includes(name));
		const currentTools = this.settingsState.settings?.tools ?? grounded;
		const unchanged =
			currentTools.length === nextTools.length && nextTools.every((name) => currentTools.includes(name));

		const writes: Promise<void>[] = [];
		if (!unchanged) writes.push(this.handlers.onGlobalTools(nextTools));
		for (const name of APPROVAL_TOOLS) {
			const asked = draft.approval[name] === true;
			if ((this.settingsState.settings?.approval[name] === true) !== asked) writes.push(this.handlers.onGlobalApproval(name, asked));
		}

		this.saving = true;
		this.renderBody();
		try {
			await Promise.all(writes);
		} finally {
			this.saving = false;
			this.dropDefaultForm();
			this.signature = "";
			this.renderBody();
		}
	}

	/** 整体发送一个模式动作的清单，并折入答案 —— 模型提交的孪生。 */
	private async commitModes(modes: ModeSettings[]): Promise<void> {
		this.saving = true;
		this.renderBody();
		let outcome: { message: string; tone: "ok" | "error" } | undefined;
		try {
			await this.handlers.onSaveModes(modes);
			this.dropModeInteraction();
			this.signature = "";
		} catch (error) {
			outcome = { message: error instanceof Error ? error.message : String(error), tone: "error" };
		} finally {
			this.saving = false;
			this.renderBody();
		}
		if (outcome !== undefined) this.reportNote(outcome.message, outcome.tone);
	}

	/**
	 * 拒绝一个草稿名字的那句话，或它可以加入清单时为 undefined。
	 *
	 * 空名和保留名到不了提交，重名也是 —— 名字是模式的身份，所以客户端在服务端看到清单之前就
	 * 拒绝。`skip` 是被编辑的行，它拥有自己的名字。
	 */
	private nameErrorFor(name: string, rows: readonly ModeDraft[], skip?: number): string | undefined {
		if (name.length === 0) return "模式要有自己的名字。";
		if (name === DEFAULT_MODE_NAME) return "「默认」是内置模式的名字，不能另用。";
		if (rows.some((mode, at) => at !== skip && mode.name === name)) return `模式名「${name}」已经在用。`;
		return undefined;
	}

	private async commitModeRow(index: number): Promise<void> {
		const form = this.modeForm;
		if (form === undefined) return;
		const name = form.name.trim();
		const refused = this.nameErrorFor(name, this.modeRows, index);
		if (refused !== undefined) {
			this.reportNote(refused, "error");
			return;
		}
		await this.commitModes(this.modeRows.map((mode, at) => (at === index ? { ...form, name, approval: { ...form.approval } } : mode)));
	}

	private async commitModeAdd(): Promise<void> {
		const form = this.modeForm;
		if (form === undefined) return;
		const name = form.name.trim();
		const refused = this.nameErrorFor(name, this.modeRows);
		if (refused !== undefined) {
			this.reportNote(refused, "error");
			return;
		}
		await this.commitModes([...this.modeRows, { ...form, name, approval: { ...form.approval } }]);
	}

	private async commitModeRemove(index: number): Promise<void> {
		if (this.modeRows.at(index) === undefined) return;
		await this.commitModes(this.modeRows.filter((_mode, at) => at !== index));
	}

	// ---------------------------------------------------------------- 默认

	/**
	 * 从未选择过的会话开启时的默认。
	 *
	 * 工具集和审批表不在这里了：它们现在是内置默认模式（ADR-0005），模式标签页是它们的唯一之门。
	 * 留下的是*不是*模式的那一半 —— 新会话起始的行，和 bash 超时。
	 */
	private defaultsSection(): HTMLElement {
		const section = element("section", "settings-section");

		section.append(this.defaultModelSection());

		// bash 超时属于设置文件，不属于屏幕上的会话。
		section.append(this.bashSection());
		return section;
	}

	/**
	 * 新会话起始的行。
	 *
	 * 这是模型选择里活得比一段对话久的另一半，所以它是设置：composer 移动屏幕上的会话，这个决定
	 * 下一段对话从哪开始。它经设置端点写而不是会话的，因为设置它时屏幕上可能根本没有会话。
	 */
	private defaultModelSection(): HTMLElement {
		const current = this.settingsState.settings?.model ?? "";
		const select = element("select", "input");
		select.append(option("", "第一个导入的模型"));
		for (const candidate of this.settingsState.models) {
			select.append(option(candidate.name, candidate.name));
		}
		// 指名已不在的行的默认是真实状态 —— 文件可以手改 —— 所以它有自己的行，而不是被显示成
		// 别的东西。
		if (current.length > 0 && ![...select.options].some((entry) => entry.value === current)) {
			select.append(option(current, `${current}（已丢失）`));
		}
		select.value = current;
		select.addEventListener("change", () => {
			if (select.value.length > 0) this.handlers.onDefaultModel(select.value);
		});
		return this.field("默认模型", select, "新建会话时用的模型；本会话用哪个在输入框下面选");
	}

	/** 两个 bash 超时，以秒计。设置存毫秒；用户握的是秒。 */
	private bashSection(): HTMLElement {
		const group = element("div", "settings-field stack");
		group.append(element("span", "settings-label", "Bash 命令超时"));
		group.append(
			element("span", "model-hint", "对所有会话生效。命令超过时限会被终止；默认 120 秒，上限 3600 秒。"),
		);
		const bash = this.settingsState.settings?.bash;
		if (bash) {
			group.append(this.secondsField("默认超时（秒）", bash.defaultTimeoutMs, "模型没有指定时限的命令跑多久", (ms) =>
				this.handlers.onBashTimeouts({ defaultTimeoutMs: ms }),
			));
			group.append(this.secondsField("最大超时（秒）", bash.maxTimeoutMs, "任何命令的时限上限，模型请求更久也会被压到这里", (ms) =>
				this.handlers.onBashTimeouts({ maxTimeoutMs: ms }),
			));
		}
		return group;
	}

	/** 以秒显示、按毫秒设置提交的超时，与模型数字一样在 change 时提交。 */
	private secondsField(label: string, ms: number, hint: string, onCommit: (ms: number) => void): HTMLElement {
		const input = element("input", "input", undefined, { type: "number", min: 1, value: Math.round(ms / 1000) });
		input.addEventListener("change", () => {
			const seconds = Number(input.value);
			if (Number.isFinite(seconds) && seconds >= 1) onCommit(Math.round(seconds * 1000));
		});
		return this.field(label, input, hint);
	}
}
