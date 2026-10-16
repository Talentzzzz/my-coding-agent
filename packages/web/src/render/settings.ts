import { element, icon, iconButton, option } from "../dom.ts";
import { APPROVAL_TOOLS, type BashSettings, type ModelInput, type ModelOption, type SettingsSnapshot, type SessionSnapshot } from "@my-agent/core/protocol";

/** A row being edited. `apiKey` is present only when the user typed a new one this session. */
export interface ModelDraft extends ModelOption {
	apiKey?: string;
}

export interface SettingsHandlers {
	onClose(): void;
	onTheme(theme: "system" | "light" | "dark"): void;
	onFontSize(size: number): void;
	onSaveModels(rows: ModelInput[]): Promise<void>;
	onDefaultModel(ref: string): void;
	/** The global default active tool set, whole — the session-level panel resets to it. */
	onGlobalTools(names: string[]): void;
	/** One tool of the global default approval map. */
	onGlobalApproval(tool: string, value: boolean): void;
	onBashTimeouts(patch: Partial<BashSettings>): void;
}

export interface SettingsState {
	settings?: SettingsSnapshot;
	models: readonly ModelOption[];
	/**
	 * The session on screen, when there is one. The app-level panel does not edit it — the
	 * session-level panel does — but its `allTools` is the one list of tool names this build has, and
	 * the global default tool set needs names to offer.
	 */
	snapshot?: SessionSnapshot;
}

type Tab = "appearance" | "models" | "defaults";

/**
 * A starting point for a new row, so the form never opens with empty numbers in it.
 *
 * The endpoint is Anthropic's own, as a filled-in default rather than a choice: every row goes over
 * Anthropic Messages, so a blank form that pointed nowhere would only ask the user to retype the one
 * URL that is nearly always right. A proxy or a relay is the same field with a different value.
 *
 * An empty name is how the form says "not named yet": the server takes the wire id as the name, which
 * is why the card stays open until both fields are filled in.
 */
const BLANK_DRAFT: ModelDraft = {
	name: "",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	modelId: "",
	contextWindow: 200_000,
	maxTokens: 8_192,
	reasoning: false,
	thinkingLevels: [],
	defaultThinkingLevel: "off",
	hasApiKey: false,
};

/**
 * Every level this app has a name for, which is what the row form offers.
 *
 * The full set rather than the row's own: the form is edited before the wire id is settled, so the
 * server's per-row list would be about a model the user has not finished typing. Whichever level a
 * row cannot take is folded onto one it can when the list is saved, and the row comes back showing
 * what was actually kept.
 */
const THINKING_LEVELS = ["off", "low", "medium", "high", "max"] as const;

/**
 * The app-level settings panel.
 *
 * It holds what lasts longer than one conversation: how the window draws itself, which models this
 * machine has imported, and the defaults a session that never chose opens on — the default model, the
 * bash timeouts, the default approval map, and the default active tool set. The controls that follow
 * the *session* — its own tools and approvals — live in the panel behind the composer's button
 * (`./session-settings.ts`), because they are changed while working and recorded in the session's own
 * transcript. What is left here is visited rarely and changed deliberately, which is what a panel
 * behind one button is for and a row of always-visible controls is not.
 *
 * The model list is edited as a draft and saved whole, because a half-saved list is the one state
 * nobody can reason about: a row deleted here and another added there have to land together. The
 * appearance controls are the opposite — they apply on the spot, since seeing the font size is how you
 * choose it.
 */
export class SettingsPanel {
	readonly element: HTMLElement;
	private readonly handlers: SettingsHandlers;
	private readonly body: HTMLElement;
	private readonly navItems: { id: Tab; button: HTMLButtonElement }[] = [];
	private readonly note: HTMLElement;

	private state: SettingsState = { models: [] };
	private tab: Tab = "appearance";
	/** The rows as edited, or undefined while the panel is showing what the server holds. */
	private draft?: ModelDraft[];
	private saving = false;
	private signature = "";

	constructor(handlers: SettingsHandlers) {
		this.handlers = handlers;

		// The panel is pinned to the viewport rather than sized by its content (`.app-settings` in
		// style.css), so switching sections never resizes it under the pointer. The title lives in
		// the nav column, the close control alone stays in the content column's head.
		this.element = element("div", "settings-overlay", undefined, { hidden: true });
		const panel = element("div", "settings app-settings", undefined, { role: "dialog", "aria-label": "设置" });

		const nav = element("nav", "settings-nav");
		nav.append(element("h2", "settings-nav-title", "设置"));
		const navList = element("div", "settings-nav-list");
		for (const [id, label] of [
			["appearance", "外观"],
			["models", "模型"],
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

		// Clicking the dimmed area behind the panel closes it; clicking inside must not.
		this.element.addEventListener("click", (event) => {
			if (event.target === this.element) this.handlers.onClose();
		});

		this.element.append(panel);
	}

	get open(): boolean {
		return !this.element.hidden;
	}

	show(): void {
		this.element.hidden = false;
		this.draft = undefined;
		this.signature = "";
		this.render();
	}

	hide(): void {
		this.element.hidden = true;
	}

	render(state: SettingsState = this.state): void {
		this.state = state;

		// Rebuilding the body would throw away a half-typed row, so it only happens when the thing the
		// tab is showing actually moved — or when the user has nothing unsaved to lose.
		const signature = [
			this.tab,
			state.settings
				? [
						state.settings.appearance.theme,
						state.settings.appearance.fontSize,
						state.settings.bash.defaultTimeoutMs,
						state.settings.bash.maxTimeoutMs,
						state.settings.tools?.join(",") ?? "",
						Object.entries(state.settings.approval).join(","),
					].join("/")
				: "",
			state.models.map((model) => `${model.name}:${model.modelId}:${model.hasApiKey}`).join(","),
			state.snapshot?.allTools.join(",") ?? "",
		].join("|");

		const stable = this.draft === undefined && signature === this.signature;
		this.signature = signature;
		this.renderNav();
		if (!stable) this.renderBody();
	}

	/** Report the outcome of a save under the body, where the button that caused it is. */
	reportNote(message: string, tone: "ok" | "error"): void {
		this.note.textContent = message;
		this.note.dataset.tone = tone;
	}

	/** The rows as they stand, so a caller can hand them to the API without reading the DOM. */
	get rows(): ModelDraft[] {
		return this.draft ?? this.state.models.map((model) => ({ ...model }));
	}

	private renderNav(): void {
		for (const { id, button } of this.navItems) {
			button.classList.toggle("active", id === this.tab);
			// A vertical nav of plain buttons: aria-current rather than aria-selected, which is only
			// meaningful on a tablist role the list does not carry.
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
			default:
				this.body.replaceChildren(this.defaultsSection());
		}
	}

	// ------------------------------------------------------------------ appearance

	private appearanceSection(): HTMLElement {
		const settings = this.state.settings;
		const section = element("section", "settings-section");

		const themeRow = element("div", "settings-field");
		themeRow.append(element("span", "settings-label", "主题"));
		const group = element("div", "segmented");
		const current = settings?.appearance.theme ?? "system";
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
		// The fallback is DEFAULT_APPEARANCE.fontSize in @my-agent/core/config.ts, restated here —
		// that module runs on Node, and the client must not pull it into its bundle. The slider's
		// 12–20 ends are the same kind of restatement (FONT_SIZE_RANGE), for the same reason.
		const size = settings?.appearance.fontSize ?? 15;
		const value = element("span", "settings-value", `${size}px`);
		const slider = element("input", "slider", undefined, {
			type: "range",
			min: 12,
			max: 20,
			step: 1,
			value: size,
			"aria-label": "字号",
		});
		slider.addEventListener("input", () => {
			value.textContent = `${slider.value}px`;
		});
		// Committed on release rather than on every pixel of the drag: each step of the slider is a
		// write to the settings file, and a drag would be a few dozen of them.
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
				"没有内置模型列表。下面每个模型都是手动录入的，也只有它们能被运行。",
			),
		);

		if (rows.length === 0) {
			section.append(element("p", "settings-hint empty", "还没有模型。添加一个才能开始对话。"));
		}

		for (const [index, row] of rows.entries()) section.append(this.modelCard(row, index));

		const add = element("button", "button", undefined, { type: "button" });
		add.append(icon("plus"), element("span", undefined, "添加模型"));
		add.addEventListener("click", () => {
			this.draft = [...this.rows, { ...BLANK_DRAFT }];
			this.renderBody();
		});
		section.append(add);

		const actions = element("div", "settings-actions");
		const save = element("button", "button primary", undefined, { type: "button" });
		save.textContent = this.saving ? "保存中…" : "保存模型";
		save.disabled = this.saving;
		save.addEventListener("click", () => void this.save());
		actions.append(save);
		section.append(actions);

		return section;
	}

	/** One row, collapsed to its name and expanded into the form that edits it. */
	private modelCard(row: ModelDraft, index: number): HTMLElement {
		const card = element("details", "model-card");
		// A row with no model id is one that was just added, so it opens ready to be filled in.
		if (row.modelId === "" || row.name === "") card.open = true;

		const summary = element("summary");
		summary.append(
			element("span", "model-label", row.name.length > 0 ? row.name : "新模型"),
			element("span", "model-ref", row.modelId.length > 0 ? `${row.name || "未命名"}/${row.modelId}` : "未配置"),
		);
		card.append(summary);

		const form = element("div", "model-form");
		const update = (patch: Partial<ModelDraft>): void => {
			this.draft = this.rows.map((candidate, at) => (at === index ? { ...candidate, ...patch } : candidate));
		};

		form.append(
			this.textField("名称", row.name, "这个名字同时是它的身份：改名等于换一个模型，用过它的会话要重新选", (value) =>
				update({ name: value }),
			),
		);
		form.append(this.textField("模型 ID", row.modelId, "接口那边的名字，例如 claude-opus-5", (value) => update({ modelId: value })));
		form.append(this.textField("服务地址", row.baseUrl, "Anthropic Messages 接口的地址；代理或中转填它自己的", (value) => update({ baseUrl: value })));
		form.append(this.keyField(row, update));
		form.append(
			this.numberField("上下文窗口", row.contextWindow, "模型能接受多少 tokens；压缩由它决定", (value) =>
				update({ contextWindow: value }),
			),
		);
		form.append(
			this.numberField("最大输出", row.maxTokens, "一次回答最多多少 tokens", (value) => update({ maxTokens: value })),
		);

		const reasoning = element("label", "model-check");
		const box = element("input", undefined, undefined, { type: "checkbox" });
		box.checked = row.reasoning;
		box.addEventListener("change", () => update({ reasoning: box.checked }));
		reasoning.append(box, document.createTextNode("该模型支持推理 / 思考档位"));
		form.append(reasoning);

		// The level a session opened on this row starts at. It belongs to the row rather than to the
		// workspace, because the levels are the model's: the middle of a five-level family is not a
		// level a three-effort endpoint has.
		const level = element("select", "input");
		for (const candidate of THINKING_LEVELS) level.append(option(candidate, candidate));
		level.value = row.defaultThinkingLevel;
		level.addEventListener("change", () => update({ defaultThinkingLevel: level.value }));
		form.append(this.field("默认思考等级", level, "这个模型新建会话时的档位；模型没有的档位会被落到它支持的一档"));

		const actions = element("div", "model-actions");
		const remove = element("button", "button danger", undefined, { type: "button" });
		remove.append(icon("trash"), element("span", undefined, "删除"));
		remove.addEventListener("click", () => {
			this.draft = this.rows.filter((_candidate, at) => at !== index);
			this.renderBody();
		});
		actions.append(remove);
		form.append(actions);

		card.append(form);
		return card;
	}

	private keyField(row: ModelDraft, update: (patch: Partial<ModelDraft>) => void): HTMLElement {
		const input = element("input", "input", undefined, {
			type: "password",
			autocomplete: "off",
			// The stored key is never sent to a browser, so this is a prompt to replace it rather than a
			// field showing it.
			placeholder: row.hasApiKey ? "•••••••• 已保存 — 输入即可替换" : "未设置",
		});
		input.addEventListener("input", () => update({ apiKey: input.value }));
		return this.field("API 密钥", input, "保存在本机，不会回传给浏览器；这是唯一的鉴权方式");
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

	private async save(): Promise<void> {
		this.saving = true;
		this.renderBody();
		try {
			await this.handlers.onSaveModels(this.rows);
			// The server owns the ids it derived, so the draft is dropped and the next render shows
			// what was actually stored rather than what was typed.
			this.draft = undefined;
			this.signature = "";
			this.reportNote("模型已保存。", "ok");
		} catch (error) {
			this.reportNote(error instanceof Error ? error.message : String(error), "error");
		} finally {
			this.saving = false;
			this.renderBody();
		}
	}

	// --------------------------------------------------------------------- defaults

	/**
	 * The defaults a session that never chose opens on.
	 *
	 * Each one is a value in the settings files, which is why the section renders whether or not a
	 * session happens to be on screen — these are the answers for a session that does not exist yet.
	 * The session's own choices are the other panel's, and the model a live session is on is the
	 * composer's; nothing here reaches either.
	 */
	private defaultsSection(): HTMLElement {
		const section = element("section", "settings-section");

		section.append(this.defaultModelSection());

		// The bash timeouts belong to the settings files, not to the session on screen.
		section.append(this.bashSection());

		section.append(this.globalApprovalSection());
		section.append(this.globalToolsSection());
		return section;
	}

	/**
	 * The row a new session starts on.
	 *
	 * This is the half of the model choice that outlives one conversation, so it is a setting: the
	 * composer moves the session on screen, while this decides where the next conversation begins. It
	 * writes through the settings endpoint rather than the session's, because there may be no session
	 * on screen at all when it is set.
	 */
	private defaultModelSection(): HTMLElement {
		const current = this.state.settings?.model ?? "";
		const select = element("select", "input");
		select.append(option("", "第一个导入的模型"));
		for (const candidate of this.state.models) {
			select.append(option(`${candidate.name}/${candidate.modelId}`, candidate.name));
		}
		// A default naming a row that is gone is a real state — the file is hand-editable — so it gets a
		// row of its own rather than being shown as something else.
		if (current.length > 0 && ![...select.options].some((entry) => entry.value === current)) {
			select.append(option(current, `${current}（已丢失）`));
		}
		select.value = current;
		select.addEventListener("change", () => {
			if (select.value.length > 0) this.handlers.onDefaultModel(select.value);
		});
		return this.field("默认模型", select, "新建会话时用的模型；本会话用哪个在输入框下面选");
	}

	/** The two bash timeouts, in seconds. The settings hold milliseconds; a user holds seconds. */
	private bashSection(): HTMLElement {
		const group = element("div", "settings-field stack");
		group.append(element("span", "settings-label", "Bash 命令超时"));
		group.append(
			element("span", "model-hint", "对所有工作区生效。命令超过时限会被终止；默认 120 秒，上限 3600 秒。"),
		);
		const bash = this.state.settings?.bash;
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

	/** A timeout in seconds over a milliseconds setting, committed on change like the model numbers. */
	private secondsField(label: string, ms: number, hint: string, onCommit: (ms: number) => void): HTMLElement {
		const input = element("input", "input", undefined, { type: "number", min: 1, value: Math.round(ms / 1000) });
		input.addEventListener("change", () => {
			const seconds = Number(input.value);
			if (Number.isFinite(seconds) && seconds >= 1) onCommit(Math.round(seconds * 1000));
		});
		return this.field(label, input, hint);
	}

	/**
	 * The global default approval map, over the six tools the map has keys for.
	 *
	 * The keys are the loadout's rather than a session's active set — the map gates tools whether or
	 * not a given session has them active — so the list is the fixed six and not whatever one session
	 * happens to carry. A session that has chosen its own answers keeps them: this only decides what
	 * the next unchoosing session opens on.
	 */
	private globalApprovalSection(): HTMLElement {
		const group = element("div", "settings-field stack");
		group.append(element("span", "settings-label", "运行前先询问"));
		group.append(
			element("span", "model-hint", "新建会话的默认值；已单独选过的会话不受影响。这里没勾选的工具会直接运行、不再询问。"),
		);
		for (const key of APPROVAL_TOOLS) {
			const label = element("label", "settings-check");
			const box = element("input", undefined, undefined, { type: "checkbox" });
			box.checked = this.state.settings?.approval[key] === true;
			box.addEventListener("change", () => this.handlers.onGlobalApproval(key, box.checked));
			label.append(box, document.createTextNode(key));
			group.append(label);
		}
		return group;
	}

	/**
	 * The global default active tool set.
	 *
	 * The names on offer are the build's, which the client only knows from a session's `allTools` —
	 * so without one on screen the section says so rather than inventing a list. No field at all means
	 * every tool, and the checkboxes show that as the effective set: unchecking one writes the whole
	 * rest, which is the session-level endpoint's own replace-whole contract.
	 */
	private globalToolsSection(): HTMLElement {
		const group = element("div", "settings-field stack");
		group.append(element("span", "settings-label", "默认启用的工具"));
		group.append(
			element("span", "model-hint", "新建会话默认打开哪些工具；已单独选过的会话不受影响。不设置就是全部启用。"),
		);
		const allTools = this.state.snapshot?.allTools;
		if (allTools === undefined || allTools.length === 0) {
			group.append(element("span", "model-hint empty", "还没有挂上任何会话，暂时列不出本构建的工具名。"));
			return group;
		}
		// Undefined is the full set, so the effective default is what the checkboxes have to show and
		// edit — never an absent field behind a half-ticked list.
		const effective = this.state.settings?.tools ?? allTools;
		const active = new Set(effective.filter((name) => allTools.includes(name)));
		for (const name of allTools) {
			const label = element("label", "settings-check");
			const box = element("input", undefined, undefined, { type: "checkbox" });
			box.checked = active.has(name);
			box.addEventListener("change", () => {
				const next = new Set(active);
				if (box.checked) next.add(name);
				else next.delete(name);
				// Sent in the registry's order, so the stored list does not depend on click order.
				this.handlers.onGlobalTools(allTools.filter((candidate) => next.has(candidate)));
			});
			label.append(box, document.createTextNode(name));
			group.append(label);
		}
		return group;
	}
}
