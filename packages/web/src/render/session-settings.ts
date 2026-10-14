import { element, iconButton } from "../dom.ts";
import type { SettingsSnapshot, SessionSnapshot } from "@my-agent/core/protocol";

export interface SessionSettingsHandlers {
	onClose(): void;
	/** Replace this session's active tool set; the server refuses a name it does not know, whole. */
	onActiveTools(names: string[]): void;
	/** One tool of this session's approval map. */
	onApproval(tool: string, value: boolean): void;
	/**
	 * Follow the global defaults again: the global default tool set over `PUT /tools` and the global
	 * approval map over `PATCH`, which together write one `tool_config` entry that *holds* the global
	 * values — the session layer has no undo, so "reset" is "record the default", and the field
	 * equality the snapshot reports reads it as following global again.
	 */
	onFollowGlobal(): void;
}

export interface SessionSettingsState {
	/** The global defaults, which are both the display's reference and the reset's payload. */
	settings?: SettingsSnapshot;
	/** The session on screen; absent means there is nothing here to configure. */
	snapshot?: SessionSnapshot;
}

/**
 * The session-level settings panel.
 *
 * Tools and approvals are the one decision a session makes about itself, recorded in its own
 * transcript as `tool_config` entries — which is why they are *not* in the app-level panel: they
 * follow the conversation, and they are set while working. Each half shows whether it currently
 * matches the global default ("沿用全局") or has been set apart ("已单独设置"), and one action puts
 * both back on the defaults.
 *
 * The judgement is field equality rather than "an entry exists", and the panel just displays what the
 * snapshot reports: a reset writes an entry, so counting entries would call a just-reset session
 * "已单独设置" — the opposite of what the user just did.
 */
export class SessionSettingsPanel {
	readonly element: HTMLElement;
	private readonly handlers: SessionSettingsHandlers;
	private readonly body: HTMLElement;
	private readonly note: HTMLElement;

	private state: SessionSettingsState = {};
	private signature = "";

	constructor(handlers: SessionSettingsHandlers) {
		this.handlers = handlers;

		this.element = element("div", "settings-overlay", undefined, { hidden: true });
		const panel = element("div", "settings session-settings", undefined, { role: "dialog", "aria-label": "会话设置" });

		const head = element("header", "settings-head");
		head.append(element("h2", undefined, "会话设置"));
		head.append(iconButton("close", "关闭会话设置", () => this.handlers.onClose()));

		this.note = element("div", "settings-note");
		this.body = element("div", "settings-body");
		panel.append(head, this.body, this.note);

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
		this.signature = "";
		this.render();
	}

	hide(): void {
		this.element.hidden = true;
	}

	render(state: SessionSettingsState = this.state): void {
		this.state = state;
		const snapshot = state.snapshot;

		const signature = [
			snapshot ? snapshot.activeTools.join(",") : "",
			snapshot ? Object.entries(snapshot.approvals).join(",") : "",
			snapshot ? `${snapshot.toolsFollowGlobal}/${snapshot.approvalsFollowGlobal}` : "",
			snapshot?.allTools.join(",") ?? "",
			state.settings ? `${state.settings.tools?.join(",") ?? ""}/${Object.entries(state.settings.approval).join(",")}` : "",
		].join("|");
		if (signature === this.signature) return;
		this.signature = signature;

		this.note.textContent = "";
		this.body.replaceChildren(...this.sections());
	}

	private sections(): HTMLElement[] {
		const snapshot = this.state.snapshot;
		if (snapshot === undefined) {
			return [element("p", "settings-hint empty", "还没有挂上任何会话。")];
		}

		const follow = element("button", "button", undefined, { type: "button" });
		follow.textContent = "沿用全局";
		// Both halves reset together, because the action's promise is one sentence — "this session runs
		// on the defaults again" — and two buttons for one sentence would only ask which half the user
		// meant. Disabled while nothing is set apart: a reset that does nothing is a lie.
		follow.disabled = snapshot.toolsFollowGlobal && snapshot.approvalsFollowGlobal;
		follow.addEventListener("click", () => this.handlers.onFollowGlobal());

		const actions = element("div", "settings-actions");
		actions.append(follow);

		return [this.toolSection(snapshot), this.approvalSection(snapshot), actions];
	}

	/** The tools this session lets the model call, against this build's own registry order. */
	private toolSection(snapshot: SessionSnapshot): HTMLElement {
		const group = element("div", "settings-field stack");
		group.append(element("span", "settings-label", "模型可调用的工具"));
		group.append(element("span", "model-hint", followHint(snapshot.toolsFollowGlobal)));
		const active = new Set(snapshot.activeTools);
		for (const name of snapshot.allTools) {
			const label = element("label", "settings-check");
			const box = element("input", undefined, undefined, { type: "checkbox" });
			box.checked = active.has(name);
			box.addEventListener("change", () => {
				// The endpoint replaces the whole set, and the order is taken from the registry so the
				// payload does not depend on the order boxes happened to be clicked in.
				const next = new Set(active);
				if (box.checked) next.add(name);
				else next.delete(name);
				this.handlers.onActiveTools(snapshot.allTools.filter((candidate) => next.has(candidate)));
			});
			label.append(box, document.createTextNode(name));
			group.append(label);
		}
		return group;
	}

	/** The tools this session asks about before running, over the same list the map has keys for. */
	private approvalSection(snapshot: SessionSnapshot): HTMLElement {
		const group = element("div", "settings-field stack");
		group.append(element("span", "settings-label", "运行前先询问"));
		group.append(element("span", "model-hint", followHint(snapshot.approvalsFollowGlobal)));
		for (const name of snapshot.allTools) {
			const label = element("label", "settings-check");
			const box = element("input", undefined, undefined, { type: "checkbox" });
			box.checked = snapshot.approvals[name as keyof typeof snapshot.approvals] === true;
			box.addEventListener("change", () => this.handlers.onApproval(name, box.checked));
			label.append(box, document.createTextNode(name));
			group.append(label);
		}
		return group;
	}
}

/** The one-line "where does this half stand" the reference to global defaults is for. */
function followHint(follows: boolean): string {
	return follows ? "当前沿用全局设置。" : "当前已单独设置；「沿用全局」可回到全局默认。";
}
