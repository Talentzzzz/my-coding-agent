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
 * bash timeouts, the default approval map, and the default active tool set. The controls that follow
 * the *session* — its own tools and approvals — live in the panel behind the composer's button
 * (`./session-settings.ts`), because they are changed while working and recorded in the session's own
 * transcript. What is left here is visited rarely and changed deliberately, which is what a panel
 * behind one button is for and a row of always-visible controls is not.
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
		// DOM and in `this.form`, and a frame arriving mid-edit — a snapshot, a stream tick — must not
		// steal the focus the typing is in. The freeze ends when the interaction does, and the next
		// render then compares signatures as usual.
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

		const stable = this.frozen !== undefined || signature === this.signature;
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
		form.append(this.textField("模型 ID", draft.modelId, "接口那边的名字，例如 claude-opus-5", (value) =>
			update({ modelId: value }),
		));
		form.append(this.textField("服务地址", draft.baseUrl, "Anthropic Messages 接口的地址；代理或中转填它自己的", (value) =>
			update({ baseUrl: value }),
		));
		form.append(this.keyField(draft, update));
		form.append(
			this.numberField("上下文窗口", draft.contextWindow, "模型能接受多少 tokens；压缩由它决定", (value) =>
				update({ contextWindow: value }),
			),
		);
		form.append(
			this.numberField("最大输出", draft.maxTokens, "一次回答最多多少 tokens", (value) => update({ maxTokens: value })),
		);

		const reasoning = element("label", "model-check");
		const box = element("input", undefined, undefined, { type: "checkbox" });
		box.checked = draft.reasoning;
		box.addEventListener("change", () => update({ reasoning: box.checked }));
		reasoning.append(box, document.createTextNode("该模型支持推理 / 思考档位"));
		form.append(reasoning);

		// The level a session opened on this row starts at. It belongs to the row rather than to the
		// workspace, because the levels are the model's: the middle of a five-level family is not a
		// level a three-effort endpoint has.
		const level = element("select", "input");
		for (const candidate of THINKING_LEVELS) level.append(option(candidate, candidate));
		level.value = draft.defaultThinkingLevel;
		level.addEventListener("change", () => update({ defaultThinkingLevel: level.value }));
		form.append(this.field("默认思考等级", level, "这个模型新建会话时的档位；模型没有的档位会被落到它支持的一档"));

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

	/** End any open interaction outright, dropping the freeze with it. */
	private clearInteraction(): void {
		this.editing = undefined;
		this.confirming = undefined;
		this.form = undefined;
		this.frozen = undefined;
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
