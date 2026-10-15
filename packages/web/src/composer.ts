import { element, icon, iconButton, option } from "./dom.ts";
import type { ModelOption, PromptBehavior } from "@my-agent/core/protocol";

export interface ComposerHandlers {
	onSubmit(text: string, behavior: PromptBehavior): void;
	onAbort(): void;
	onSelectModel(ref: string): void;
	onSelectLevel(level: string): void;
	/** The session-level settings panel, which is what the composer's own button opens. */
	onOpenSessionSettings(): void;
}

/** The model seat: which row answers, and how hard it is asked to think. */
export interface ComposerSelection {
	models: readonly ModelOption[];
	/** The ref on screen, which may name a row that is no longer in `models`. */
	model: string;
	levels: readonly string[];
	level: string;
}

/**
 * The prompt box.
 *
 * Enter sends, Shift+Enter inserts a newline, and Escape aborts the run. Submitting while the agent
 * is working is accepted rather than refused: plain Enter queues a follow-up that waits for the run
 * to stop, Ctrl/Cmd+Enter steers it instead. The queued count is the session's, shown beside the
 * buttons by {@link setQueued}.
 *
 * The box grows with its content up to a cap. A prompt is often several lines — a stack trace, a
 * list of files — and a box that scrolls after two of them hides the thing being written.
 *
 * There are no hint lines and no placeholder: the two lines of instruction the bar used to carry
 * were chrome the reader had already learned (01 ④), and the seat that names the model sits on the
 * bar's right end for the same reason it sits on the bar at all — which model answers, and how hard
 * it is asked to think, are chosen per conversation and often changed inside one. Both halves are
 * held by the window until a message is sent with them — nothing here reaches the server until
 * then — so the two selects are drawn from {@link setSelection} and their changes are reported as
 * plain choices.
 */
export class Composer {
	readonly element: HTMLFormElement;
	private readonly textarea: HTMLTextAreaElement;
	private readonly send: HTMLButtonElement;
	private readonly stop: HTMLButtonElement;
	private readonly queue: HTMLElement;
	private readonly modelSelect: HTMLSelectElement;
	private readonly levelSelect: HTMLSelectElement;
	private modelSignature = "";
	private levelSignature = "";
	private streaming = false;
	private disabled = false;

	constructor(handlers: ComposerHandlers) {
		this.element = element("form", "composer");

		this.textarea = element("textarea", undefined, undefined, {
			rows: 1,
			spellcheck: false,
			"aria-label": "消息",
		});

		const bar = element("div", "composer-bar");
		this.queue = element("span", "composer-queued");
		this.queue.hidden = true;

		this.modelSelect = element("select", "composer-select", undefined, { "aria-label": "模型" });
		this.modelSelect.addEventListener("change", () => handlers.onSelectModel(this.modelSelect.value));
		this.levelSelect = element("select", "composer-select", undefined, { "aria-label": "思考档位" });
		this.levelSelect.addEventListener("change", () => handlers.onSelectLevel(this.levelSelect.value));

		const seat = element("div", "composer-seat");
		// The session's own settings lead the seat: they belong to the conversation the way the model
		// seat does, and the app-level ones stay behind the sidebar's one button. The whole seat rides
		// the bar's right end, the model picking just left of the send button.
		const sessionSettings = iconButton("gear", "会话设置", () => handlers.onOpenSessionSettings(), "icon-button composer-gear");
		seat.append(sessionSettings, this.modelSelect, this.levelSelect);

		this.stop = element("button", "button danger", undefined, { type: "button", hidden: true });
		this.stop.append(icon("stop"), element("span", undefined, "停止"));
		this.stop.addEventListener("click", () => handlers.onAbort());

		this.send = element("button", "button primary", undefined, { type: "submit" });
		this.send.append(element("span", undefined, "发送"), icon("send"));

		bar.append(seat, this.queue, this.stop, this.send);
		this.element.append(this.textarea, bar);

		this.element.addEventListener("submit", (event) => {
			event.preventDefault();
			this.submit(handlers, "followUp");
		});

		this.textarea.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				// Idle either way: the session starts a run rather than queueing. The distinction only
				// matters while one is streaming, which is where Ctrl/Cmd+Enter steers.
				this.submit(handlers, this.streaming && (event.ctrlKey || event.metaKey) ? "steer" : "followUp");
				return;
			}
			if (event.key === "Escape" && this.streaming) {
				event.preventDefault();
				handlers.onAbort();
			}
		});

		this.textarea.addEventListener("input", () => this.resize());
	}

	focus(): void {
		this.textarea.focus();
	}

	/** Put text back in the box, for a command that consumed it and then failed. */
	setDraft(text: string): void {
		this.textarea.value = text;
		this.resize();
	}

	draft(): string {
		return this.textarea.value;
	}

	setStreaming(streaming: boolean): void {
		this.streaming = streaming;
		this.stop.hidden = !streaming;
		this.send.firstElementChild!.textContent = streaming ? "排队" : "发送";
		this.syncDisabled();
	}

	/** How many messages are queued behind the current run. */
	setQueued(queued: number): void {
		this.queue.hidden = queued <= 0;
		this.queue.textContent = `已排队 ${queued} 条`;
	}

	/**
	 * Draw the model seat.
	 *
	 * The options are rebuilt only when the list they came from moved, so an ordinary re-render — which
	 * happens on every token — cannot close a dropdown the user has open or drop a value mid-choice.
	 * The session's own ref is always among the options: a row may have been deleted, or never existed
	 * at all for a session with nothing configured, and the control has to show where the session
	 * actually is rather than silently agree with a list that no longer mentions it.
	 */
	setSelection(selection: ComposerSelection): void {
		const modelSignature = `${selection.model}\n${selection.models.map((model) => `${model.name}/${model.modelId}`).join("\n")}`;
		if (modelSignature !== this.modelSignature) {
			this.modelSignature = modelSignature;
			this.modelSelect.replaceChildren(
				...selection.models.map((model) => option(`${model.name}/${model.modelId}`, model.name)),
			);
			if (!selection.models.some((model) => `${model.name}/${model.modelId}` === selection.model)) {
				const label = selection.models.length === 0 ? "未配置模型" : `${selection.model}（已丢失）`;
				this.modelSelect.append(option(selection.model, label));
			}
		}
		this.modelSelect.value = selection.model;
		this.modelSelect.disabled = selection.models.length === 0;

		const levelSignature = `${selection.level}\n${selection.levels.join(",")}`;
		if (levelSignature !== this.levelSignature) {
			this.levelSignature = levelSignature;
			this.levelSelect.replaceChildren(...selection.levels.map((level) => option(level, level)));
		}
		this.levelSelect.value = selection.level;
		// One level is not a choice: a model that cannot think has nothing to pick between.
		this.levelSelect.hidden = selection.levels.length <= 1;
	}

	setDisabled(disabled: boolean): void {
		this.disabled = disabled;
		this.syncDisabled();
	}

	private syncDisabled(): void {
		this.textarea.disabled = this.disabled;
		this.send.disabled = this.disabled;
	}

	/** Grow to fit the content, up to the stylesheet's cap, then scroll. */
	private resize(): void {
		this.textarea.style.height = "auto";
		this.textarea.style.height = `${this.textarea.scrollHeight}px`;
	}

	private submit(handlers: ComposerHandlers, behavior: PromptBehavior): void {
		const text = this.textarea.value.trim();
		if (text.length === 0 || this.disabled) return;
		this.textarea.value = "";
		this.resize();
		handlers.onSubmit(text, behavior);
	}
}
