import { element, icon, iconButton, option } from "../dom.ts";
import {
	APPROVAL_TOOLS,
	type BashSettings,
	type ModeSettings,
	type ModelInput,
	type ModelOption,
	type SettingsSnapshot,
	type SessionSnapshot,
} from "@my-agent/core/protocol";

/**
 * The built-in default mode's name, restated here rather than imported.
 *
 * The constant's home (`@my-agent/core/config.ts`) runs on Node, and the client must not pull that
 * into its bundle — the same restatement rule the font-size range follows.
 */
const DEFAULT_MODE_NAME = "默认";

/** A row being edited. `apiKey` is present only when the user typed a new one this session. */
export interface ModelDraft extends ModelOption {
	apiKey?: string;
}

/** A mode being edited: the stored shape, plus nothing — a mode carries no secret to hold back. */
type ModeDraft = ModeSettings;

/** A mode with nothing set: every tool off, every tool auto-allowed — the prototype's new mode. */
function blankMode(): ModeDraft {
	const approval: Record<string, boolean> = {};
	for (const key of APPROVAL_TOOLS) approval[key] = false;
	return { name: "新模式", tools: [], approval: approval as ModeDraft["approval"] };
}

/** A mode's one-line summary, the same shape the prototype's mode menu showed. */
export function modeSummaryOf(tools: readonly string[], approval: Record<string, boolean>): string {
	const ask = tools.filter((tool) => approval[tool as keyof typeof approval] === true).length;
	return `${tools.length} 个工具 · ${ask} 项询问`;
}

export interface SettingsHandlers {
	onClose(): void;
	onTheme(theme: "system" | "light" | "dark"): void;
	onFontSize(size: number): void;
	onSaveModels(rows: ModelInput[]): Promise<void>;
	onSaveModes(modes: ModeSettings[]): Promise<void>;
	onDefaultModel(ref: string): void;
	/** The global default active tool set, whole — the built-in default mode's save writes it. */
	onGlobalTools(names: string[]): Promise<void>;
	/** One tool of the global default approval map, which the built-in default mode reads. */
	onGlobalApproval(tool: string, value: boolean): Promise<void>;
	onBashTimeouts(patch: Partial<BashSettings>): void;
}

export interface SettingsState {
	settings?: SettingsSnapshot;
	models: readonly ModelOption[];
	/**
	 * The session on screen, when there is one. Its `allTools` is the one list of tool names this
	 * build has, and the global default tool set needs names to offer, so without a session the
	 * built-in default mode's form stands down rather than inventing a list.
	 */
	snapshot?: SessionSnapshot;
}

type Tab = "appearance" | "models" | "modes" | "defaults";

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
 * Whether a form has the three fields a row cannot exist without.
 *
 * The server refuses a row with no name of its own, no model id, and no endpoint — the same three
 * the old card stayed open on — so 保存 sits disabled until they are filled, rather than relaying
 * the refusal as an error after the click.
 */
function formComplete(form: ModelDraft): boolean {
	return form.name.trim().length > 0 && form.modelId.trim().length > 0 && form.baseUrl.trim().length > 0;
}

/**
 * The app-level settings panel.
 *
 * It holds what lasts longer than one conversation: how the window draws itself, which models this
 * machine has imported, and the defaults a session that never chose opens on — the default model, the
 * bash timeouts, the global default tool set and approval map (which are the built-in default mode),
 * and the user's named modes. The tools and approvals a session itself runs on are not here: they
 * follow the conversation and are chosen in the composer's mode seat, which applies a preset through
 * the session's own `tool_config`, with no second panel to edit them by hand. What is left here is
 * visited rarely and changed deliberately, which is what a panel behind one button is for and a row of
 * always-visible controls is not.
 *
 * The model list is edited one row at a time and saved one action at a time: an inline form's 保存
 * and a confirmed delete each send the list whole, because a half-saved list is the one state nobody
 * can reason about — a row deleted here and another added there have to land together. The appearance
 * controls are the opposite — they apply on the spot, since seeing the font size is how you choose it.
 */
export class SettingsPanel {
	readonly element: HTMLElement;
	private readonly handlers: SettingsHandlers;
	private readonly body: HTMLElement;
	private readonly navItems: { id: Tab; button: HTMLButtonElement }[] = [];
	private readonly note: HTMLElement;

	private state: SettingsState = { models: [] };
	private tab: Tab = "appearance";
	/**
	 * The rows as they were when the open interaction began, or undefined while the panel is showing
	 * what the server holds.
	 *
	 * Held rather than re-read per render, so a half-typed form and the rows it edits sit on the same
	 * frozen list: a model arriving from the server mid-edit must not shift the row under the form.
	 * One interaction is open at a time, and this is cleared when it ends — saved, confirmed, or
	 * cancelled.
	 */
	private frozen?: ModelDraft[];
	/** Which row is open for editing: a row index, or the add form's blank one. */
	private editing?: number | "new";
	/** The row with a delete confirmation standing under it. */
	private confirming?: number;
	/** The values typed into the open form, present exactly while a form is open. */
	private form?: ModelDraft;
	private saving = false;
	private signature = "";
	/**
	 * The modes tab's own interaction state, kept beside the models' rather than shared with it:
	 * the two lists are edited on the same one-interaction-at-a-time rule, but their rows have
	 * different shapes and their commits go to different endpoints, so sharing the fields would
	 * couple two save paths that must never move together.
	 */
	private modeFrozen?: ModeDraft[];
	/** Which mode is open for editing: a row index, or the add form's blank one. */
	private modeEditing?: number | "new";
	/** The mode with a delete confirmation standing under it. */
	private modeConfirming?: number;
	/** The values typed into the open mode form, present exactly while one is open. */
	private modeForm?: ModeDraft;
	/**
	 * Whether the built-in default card is open for editing. It is a separate interaction from the
	 * stored modes' rows because it has no list to freeze — its draft is the global defaults — but only
	 * one of the two is open at a time.
	 */
	private defaultEditing = false;
	/** The global defaults as the open default form is editing them, present exactly while it is open. */
	private defaultForm?: ModeDraft;

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

		// Clicking the dimmed area behind the panel closes it; clicking inside must not.
		this.element.addEventListener("click", (event) => {
			if (event.target === this.element) this.handlers.onClose();
		});

		this.element.append(panel);
	}

	get open(): boolean {
		return !this.element.hidden;
	}

	/**
	 * Open the panel, optionally straight onto one tab — the composer's 「去设置 › 模式」 names its
	 * tab, because the click already said what the person is going there for.
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

	render(state: SettingsState = this.state): void {
		this.state = state;

		// Rebuilding the body would throw away a half-typed row, so it only happens when the thing the
		// tab is showing actually moved. An open interaction freezes the body outright: the form is the
		// one thing on screen that cannot be rebuilt from state, because its latest values live in the
		// DOM and in the two draft fields, and a frame arriving mid-edit — a snapshot, a stream tick —
		// must not steal the focus the typing is in. A stored mode freezes through `modeFrozen`, the
		// model rows through `frozen`, the built-in default card through its own flag. The freeze ends
		// when the interaction does, and the next render then compares signatures as usual.
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
						(state.settings.modes ?? [])
							.map((mode) => `${mode.name}:${mode.tools.join(",")}:${Object.entries(mode.approval).join(",")}`)
							.join(";"),
					].join("/")
				: "",
			state.models.map((model) => `${model.name}:${model.modelId}:${model.hasApiKey}`).join(","),
			state.snapshot?.allTools.join(",") ?? "",
		].join("|");

		const stable =
			this.frozen !== undefined || this.modeFrozen !== undefined || this.defaultEditing || signature === this.signature;
		this.signature = signature;
		this.renderNav();
		if (!stable) this.renderBody();
	}

	/** Report the outcome of a save under the body, where the button that caused it is. */
	reportNote(message: string, tone: "ok" | "error"): void {
		this.note.textContent = message;
		this.note.dataset.tone = tone;
	}

	/**
	 * The rows as they stand, so a caller can hand them to the API without reading the DOM.
	 *
	 * The frozen list while an interaction is open — the one the form was opened against — and the
	 * server's list otherwise, copied so a caller may splice it without touching the state.
	 */
	get rows(): ModelDraft[] {
		return this.frozen ?? this.state.models.map((model) => ({ ...model }));
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
			case "modes":
				this.body.replaceChildren(this.modesSection());
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
		// 10–22 ends are the same kind of restatement (FONT_SIZE_RANGE), for the same reason.
		const size = settings?.appearance.fontSize ?? 15;
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
				"每个模型是一行「端点 + 密钥」。点击条目中部进入编辑；右侧回收站删除；「＋ 添加模型」直接展开一张空表单。",
			),
		);

		if (rows.length === 0 && this.editing !== "new") {
			section.append(element("p", "settings-hint empty", "还没有模型。添加一个才能开始对话。"));
		}

		for (const [index, row] of rows.entries()) section.append(this.modelRow(row, index));

		// The add form is the expanded row itself rather than a mode the button toggles, so the button
		// stands down while it is open — there is nothing left for a second click to add.
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
	 * One row: the head that opens it for editing, the trash that asks once, and the form when open.
	 *
	 * The head is a button covering the row's middle — the name and the wire ref — and the trash rides
	 * beside it, revealed on hover. They are siblings rather than head housing the trash, because a
	 * button cannot hold another; the trash is positioned over the head's reserved right padding.
	 */
	private modelRow(row: ModelDraft, index: number): HTMLElement {
		const rowEl = element("div", "model-row");
		if (this.editing === index) rowEl.classList.add("editing");
		if (this.confirming === index) rowEl.classList.add("confirming");

		const head = element("button", "model-row-head", undefined, { type: "button" });
		head.append(
			element("span", "model-label", row.name.length > 0 ? row.name : "新模型"),
			element("span", "model-ref", row.modelId.length > 0 ? `${row.name || "未命名"}/${row.modelId}` : "未配置"),
		);
		head.addEventListener("click", () => this.beginEdit(index));
		rowEl.append(head);

		rowEl.append(iconButton("trash", "删除这个模型", () => this.beginConfirm(index), "icon-button model-row-del"));

		if (this.editing === index && this.form !== undefined) {
			rowEl.append(this.modelForm(this.form, () => this.closeInteraction(), () => void this.commitRow(index)));
		}
		if (this.confirming === index) rowEl.append(this.confirmBar(row, index));

		return rowEl;
	}

	/**
	 * The delete confirmation, standing in the row it would act on.
	 *
	 * One confirmation, then the delete: the bar asks in place — naming the row it is about to remove
	 * — and both answers take it down, the destructive one by sending the shortened list. The buttons
	 * sit in the prototype's order, the destructive one first.
	 */
	private confirmBar(row: ModelDraft, index: number): HTMLElement {
		const bar = element("div", "model-confirm");
		bar.append(element("span", undefined, `删除 ${row.name.length > 0 ? row.name : "未命名"}？此操作不可撤销。`));
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
	 * The inline form, shared by editing and adding.
	 *
	 * Typing writes `this.form` and never re-renders — a rebuild per keystroke would steal the focus
	 * the typing is in — so the one piece of the form that reads it (保存's gate) is synced by hand.
	 * An omitted API key keeps the stored one on the server, which is why the field is a prompt to
	 * replace rather than a value on show.
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
		form.append(this.textField("模型", draft.modelId, "接口那边的名字，例如 claude-opus-5", (value) =>
			update({ modelId: value }),
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

		// A checkbox and not a select: this is one capability the row either has or does not, so it
		// reads as a switch. It keeps the field column's shape — the check with its label, the hint
		// under it — rather than joining the other controls' label-above-control rows.
		const reasoning = element("div", "model-field");
		const check = element("label", "model-check");
		const box = element("input", undefined, undefined, { type: "checkbox" });
		box.checked = draft.reasoning;
		box.addEventListener("change", () => update({ reasoning: box.checked }));
		check.append(box, document.createTextNode("思考模式"));
		reasoning.append(check, element("span", "model-hint", "打开表示这个模型支持推理；关闭后请求不带任何思考参数"));
		form.append(reasoning);

		// The level a session opened on this row starts at. It belongs to the row rather than to the
		// workspace, because the levels are the model's: the middle of a five-level family is not a
		// level a three-effort endpoint has.
		const level = element("select", "input");
		for (const candidate of THINKING_LEVELS) level.append(option(candidate, candidate));
		level.value = draft.defaultThinkingLevel;
		level.addEventListener("change", () => update({ defaultThinkingLevel: level.value }));
		form.append(this.field("默认思考强度", level, "这个模型新建会话时的强度；模型没有的档位会被落到它支持的一档"));

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

	private keyField(row: ModelDraft, update: (patch: Partial<ModelDraft>) => void): HTMLElement {
		const input = element("input", "input", undefined, {
			type: "password",
			autocomplete: "off",
			// The stored key is never sent to a browser, so this is a prompt to replace it rather than a
			// field showing it.
			placeholder: row.hasApiKey ? "•••••••• 已保存 — 输入即可替换" : "未设置",
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

	// ------------------------------------------------------- model interactions

	/** Open one interaction — a row, the add form, or a delete ask — and close whatever stood. */
	private begin(next: { editing?: number | "new"; confirming?: number; form?: ModelDraft }): void {
		this.editing = next.editing;
		this.confirming = next.confirming;
		this.form = next.form;
		// Nothing open means nothing to freeze against: the next render may compare signatures and
		// rebuild from what the server holds. Re-freezing while one stood keeps the list the open
		// form was typed against, rather than moving it under the form mid-edit.
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
		// The form opens at the list's end, below the fold when the list is long, so it walks itself
		// into view — the same courtesy the prototype paid the click.
		this.body.lastElementChild?.scrollIntoView({ block: "nearest" });
	}

	private beginConfirm(index: number): void {
		if (this.rows.at(index) === undefined) return;
		this.begin({ confirming: index });
	}

	/** Take an open form or confirmation down without saving. */
	private closeInteraction(): void {
		this.begin({});
	}

	/** End any open interaction outright, dropping both freezes with it. */
	private clearInteraction(): void {
		this.editing = undefined;
		this.confirming = undefined;
		this.form = undefined;
		this.frozen = undefined;
		this.dropModeInteraction();
		this.dropDefaultForm();
	}

	/** Drop a stored mode's open form without redrawing — the state half of closing it. */
	private dropModeInteraction(): void {
		this.modeEditing = undefined;
		this.modeConfirming = undefined;
		this.modeForm = undefined;
		this.modeFrozen = undefined;
	}

	/** Drop the built-in default card's open form without redrawing. */
	private dropDefaultForm(): void {
		this.defaultEditing = false;
		this.defaultForm = undefined;
	}

	/**
	 * Send one action's list whole, and fold the answer in.
	 *
	 * Every action — a row's 保存, a confirmed 删除, the add form's 保存 — resolves to the list it
	 * wants stored, because the endpoint replaces the list whole: a row whose `apiKey` is omitted
	 * keeps the stored one, so untouched rows round-trip with the keys this panel was never shown.
	 * Success ends the interaction and drops the freeze, so the next render shows what the server
	 * actually stored rather than what was typed.
	 */
	private async commit(rows: ModelInput[]): Promise<void> {
		this.saving = true;
		this.renderBody();
		let outcome: { message: string; tone: "ok" | "error" };
		try {
			await this.handlers.onSaveModels(rows);
			this.clearInteraction();
			this.signature = "";
			outcome = { message: "模型已保存。", tone: "ok" };
		} catch (error) {
			outcome = { message: error instanceof Error ? error.message : String(error), tone: "error" };
		} finally {
			this.saving = false;
			this.renderBody();
		}
		// Reported after the rebuild rather than before it, because renderBody clears the note on its
		// way in — reporting first would have the outcome wiped by the very redraw that made room
		// for it, and with the global save button gone this note is the only word a failed action
		// gets.
		this.reportNote(outcome.message, outcome.tone);
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

	// ----------------------------------------------------------------------- modes

	/**
	 * The modes tab: the built-in default card and the user's modes beneath it.
	 *
	 * The default card is the global defaults read live (ADR-0005) — the same two controls the
	 * defaults tab used to carry, moved here because a mode *is* a tool set plus an approval set, and
	 * two doors to one value would only drift apart. It reads like the user's modes: a one-line head
	 * that opens an inline form, whose 保存 writes the global `tools` and `approval` rather than the
	 * `modes` list. The user's modes get the same inline edit / confirmed delete the model rows have.
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

	/** The modes as they stand: the frozen list while an interaction is open, the server's otherwise. */
	private get modeRows(): ModeDraft[] {
		return this.modeFrozen ?? (this.state.settings?.modes ?? []).map((mode) => ({ ...mode, approval: { ...mode.approval } }));
	}

	/**
	 * The tools one mode's form offers, in the order the toggle rows draw.
	 *
	 * The build's own list — which only a session's `allTools` can name, so without one the six
	 * built-ins stand in — plus anything the mode already names that the build no longer has, so a
	 * tool an upgrade dropped can still be unchecked rather than silently carried. The fallback list
	 * is a display convenience only: the built-in default's form stands down without a session, so it
	 * never writes the six over a set that may name more.
	 */
	private modeToolList(mode: ModeDraft): string[] {
		const all = this.state.snapshot?.allTools;
		const base = all !== undefined && all.length > 0 ? [...all] : [...APPROVAL_TOOLS];
		for (const name of mode.tools) if (!base.includes(name)) base.push(name);
		return base;
	}

	/**
	 * The built-in default mode: never stored, always the global defaults.
	 *
	 * It opens the same inline form a stored mode does, with the two differences that follow from
	 * being a live view rather than a row (ADR-0005): the name is a label rather than an input, and
	 * 保存 writes the global `tools`/`approval` instead of the `modes` list. Collapsed it is the same
	 * one-line row the user's modes are, so it reads as a peer rather than as an always-expanded panel.
	 */
	private defaultModeCard(): HTMLElement {
		const settings = this.state.settings;
		const allTools = this.state.snapshot?.allTools;
		const storedTools = settings?.tools ?? allTools ?? [];
		// The summary names the same tools the composer's default row does: when a session can name the
		// build's list, a stored name an upgrade dropped is not a tool this build has, so it is not
		// counted here either. Without a session there is no list to narrow against, and what the file
		// holds is the only true answer.
		const summaryTools =
			allTools === undefined || allTools.length === 0 ? storedTools : storedTools.filter((name) => allTools.includes(name));
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

	/** One user mode: the head that opens it, the trash that asks once, and the form when open. */
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

	/** The delete confirmation for one mode, standing in the row it would act on. */
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
	 * One mode's tool table: a toggle row per tool, the approval select riding beside it.
	 *
	 * It always edits a draft: the built-in default card's draft holds the global defaults and the
	 * stored modes' forms hold their rows, and only 保存 turns either into a write. Only the tools the
	 * approval map has keys for carry a select — a delegated call asks nobody by design — so the extra
	 * tools a registry adds draw their toggle alone. An unchecked tool's select is disabled rather
	 * than hidden: the choice it would hold still belongs to the mode. `standDown` is the built-in
	 * default's form with no session: there is no build's own list to name, so the toggles stand down
	 * rather than write the six built-ins over a set that may name more.
	 */
	private modeToolTable(mode: ModeDraft, standDown = false): HTMLElement {
		const table = element("div", "mode-tooltable");
		if (standDown) {
			table.append(element("span", "model-hint", "还没有挂上任何会话，暂时列不出本构建的工具名；挂上会话后再改默认集。"));
		}

		const active = new Set(mode.tools);
		for (const name of this.modeToolList(mode)) {
			const row = element("div", "mode-tool");
			const box = element("input", undefined, undefined, { type: "checkbox", "aria-label": `启用 ${name}` });
			box.checked = active.has(name);
			box.disabled = standDown;
			box.addEventListener("change", () => {
				const tools = new Set(mode.tools);
				if (box.checked) tools.add(name);
				else tools.delete(name);
				mode.tools = [...tools];
			});
			row.append(box, element("span", "mode-tool-name", name));

			if ((APPROVAL_TOOLS as readonly string[]).includes(name)) {
				const select = element("select", "input mode-tool-approval");
				select.append(option("allow", "自动允许"), option("ask", "每次询问"));
				select.value = mode.approval[name as keyof typeof mode.approval] === true ? "ask" : "allow";
				select.disabled = standDown || !box.checked;
				box.addEventListener("change", () => {
					select.disabled = standDown || !box.checked;
				});
				select.addEventListener("change", () => {
					mode.approval[name as keyof typeof mode.approval] = select.value === "ask";
				});
				row.append(select);
			}
			table.append(row);
		}
		return table;
	}

	/**
	 * The inline mode form, shared by editing, adding, and the built-in default card.
	 *
	 * A stored mode's name is an input, because the name is its identity. The built-in's name is a
	 * label with the badge: it is the global defaults, so renaming it is not a thing that exists.
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

		const standDown = options.builtIn === true && (this.state.snapshot?.allTools.length ?? 0) === 0;
		form.append(this.modeToolTable(draft, standDown));

		const actions = element("div", "model-actions");
		const cancel = element("button", "button", undefined, { type: "button" });
		cancel.textContent = "取消";
		cancel.addEventListener("click", onCancel);
		const save = element("button", "button primary", undefined, { type: "button" });
		save.textContent = this.saving ? "保存中…" : "保存";
		save.disabled = this.saving || standDown;
		save.addEventListener("click", onSave);
		actions.append(cancel, save);
		form.append(actions);
		return form;
	}

	// ------------------------------------------------ mode interactions

	/** Open one mode interaction and close whatever stood, freezing the list it edits against. */
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
	 * Open the built-in default card's form, seeded from the global defaults as they stand.
	 *
	 * The draft is the card's own until 保存, so a toggle does not write the settings file on every
	 * click; a stored mode's form is closed first, because one interaction is open at a time. The seed
	 * keeps `settings.tools` as it is rather than narrowing it, so a tool an upgrade dropped still has
	 * a row — checked — that can be turned off, and saving then drops it from the global set.
	 */
	private beginDefaultEdit(): void {
		if (this.defaultEditing) return;
		const settings = this.state.settings;
		const allTools = this.state.snapshot?.allTools ?? [];
		this.dropModeInteraction();
		this.defaultEditing = true;
		this.defaultForm = {
			name: DEFAULT_MODE_NAME,
			tools: settings?.tools === undefined ? [...allTools] : [...settings.tools],
			approval: { ...(settings?.approval ?? {}) } as ModeDraft["approval"],
		};
		this.renderBody();
	}

	/** Take the open default form down without saving. */
	private closeDefaultInteraction(): void {
		this.dropDefaultForm();
		this.renderBody();
	}

	/**
	 * Save the default form: the global `tools` and `approval`, never the `modes` list.
	 *
	 * The tool set is written whole in the build's own order — the same contract every tool-set write
	 * has — and narrowed to the tools this build knows, so a name an upgrade dropped is dropped here
	 * too. Approvals move one key at a time through `onGlobalApproval`, and only the keys that moved:
	 * a save that touched nothing but tools never rewrites the approval map. With no session there is
	 * no build list to write against, so the save is a no-op — the form's own controls already stand
	 * down.
	 *
	 * The writes are awaited before the form closes. Each answer carries the whole settings object, so
	 * the collapsed summary is drawn from the last one; closing first would flash a summary built from
	 * the old values while a patch was still in flight. The button says 保存中… meanwhile, the same
	 * wait the stored modes' save has.
	 */
	private async commitDefault(): Promise<void> {
		const draft = this.defaultForm;
		const grounded = this.state.snapshot?.allTools;
		if (draft === undefined || grounded === undefined || grounded.length === 0) return;

		const nextTools = grounded.filter((name) => draft.tools.includes(name));
		const currentTools = this.state.settings?.tools ?? grounded;
		const unchanged =
			currentTools.length === nextTools.length && nextTools.every((name) => currentTools.includes(name));

		const writes: Promise<void>[] = [];
		if (!unchanged) writes.push(this.handlers.onGlobalTools(nextTools));
		for (const name of APPROVAL_TOOLS) {
			const asked = draft.approval[name] === true;
			if ((this.state.settings?.approval[name] === true) !== asked) writes.push(this.handlers.onGlobalApproval(name, asked));
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

	/** Send one mode action's list whole, and fold the answer in — the model commit's twin. */
	private async commitModes(modes: ModeSettings[]): Promise<void> {
		this.saving = true;
		this.renderBody();
		let outcome: { message: string; tone: "ok" | "error" };
		try {
			await this.handlers.onSaveModes(modes);
			this.dropModeInteraction();
			this.signature = "";
			outcome = { message: "模式已保存。", tone: "ok" };
		} catch (error) {
			outcome = { message: error instanceof Error ? error.message : String(error), tone: "error" };
		} finally {
			this.saving = false;
			this.renderBody();
		}
		this.reportNote(outcome.message, outcome.tone);
	}

	/**
	 * The sentence refusing a draft's name, or undefined when it may join the list.
	 *
	 * Empty and reserved names never reach the commit, and neither does a duplicate — the name is a
	 * mode's identity, so the client refuses before the server ever sees the list. `skip` is the row
	 * being edited, which owns its own name.
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

	// --------------------------------------------------------------------- defaults

	/**
	 * The defaults a session that never chose opens on.
	 *
	 * The tool set and the approval map are not here any more: they are the built-in default mode now
	 * (ADR-0005), and the modes tab is their one door. What stays is the half that is *not* a mode —
	 * the row a new session starts on, and the bash timeouts.
	 */
	private defaultsSection(): HTMLElement {
		const section = element("section", "settings-section");

		section.append(this.defaultModelSection());

		// The bash timeouts belong to the settings files, not to the session on screen.
		section.append(this.bashSection());
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
}
