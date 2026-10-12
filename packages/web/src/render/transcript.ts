import { element, icon, iconButton } from "../dom.ts";
import type { Item, ToolCard } from "../state.ts";
import type { BranchOption } from "@my-agent/core/protocol";
import { diffStat, renderFileDiff } from "./diff.ts";
import { renderMarkdown } from "./markdown.ts";

export interface TranscriptOptions {
	/** Called with the entry a user message's "派生新会话" control belongs to. */
	onFork(entryId: string): void;
	/**
	 * Called with the entry a branch move starts at, and which end of it the leaf should land on.
	 *
	 * `descend` is true for choosing an alternative the conversation already has — land where it
	 * stopped — and false for rewinding to the message itself, so the next prompt starts another one.
	 */
	onBranch(entryId: string, descend: boolean): void;
}

/** One rendered conversation entry, plus the little state needed to patch it in place. */
interface Turn {
	section: HTMLElement;
	body: HTMLElement;
	/** Blocks already rendered into `body`, so a streaming message only touches its tail. */
	blocks: number;
	text: string;
	/**
	 * The item this turn is currently drawn from.
	 *
	 * The controls are built once with the section and patched afterwards, and they read through here
	 * rather than closing over the item: a snapshot can replace every item, so the entry a control acts
	 * on is whatever the last render said it was.
	 */
	item: Extract<Item, { kind: "message" }>;
}

/**
 * The conversation column.
 *
 * Rendering is a reconcile against `items` rather than a rebuild, because the transcript is the hot
 * path: a `message_update` arrives many times a second and must cost work proportional to the delta,
 * not to the conversation so far. Three things make that true — a message keeps its element and gets
 * appended to, a tool group is only rebuilt when its card list actually changes, and anything that
 * left `items` is dropped.
 *
 * The view owns its scroll policy: it follows the bottom while the reader is already there, and stops
 * the moment they scroll away, so reading history is never yanked back by a token.
 */
export class TranscriptView {
	private readonly container: HTMLElement;
	private readonly options: TranscriptOptions;
	private readonly turns = new Map<string, Turn>();
	private readonly tools = new Map<string, { section: HTMLElement; cards: ToolCard[] }>();
	private welcome?: HTMLElement;
	private sticky = true;

	constructor(container: HTMLElement, options: TranscriptOptions) {
		this.container = container;
		this.options = options;
	}

	/** Follow the bottom unless the reader has scrolled away from it. */
	trackScroll(): void {
		this.container.addEventListener("scroll", () => {
			const distance = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight;
			this.sticky = distance < 80;
		});
	}

	render(items: readonly Item[], streaming: boolean): void {
		const seen = new Set<string>();

		for (const item of items) {
			seen.add(item.id);
			if (item.kind === "message") this.renderMessage(item);
			else this.renderTools(item.id, item.cards);
		}

		for (const [id, turn] of [...this.turns]) {
			if (seen.has(id)) continue;
			this.turns.delete(id);
			turn.section.remove();
		}
		for (const [id, group] of [...this.tools]) {
			if (seen.has(id)) continue;
			this.tools.delete(id);
			group.section.remove();
		}

		this.setWelcome(items.length === 0 && !streaming);
		this.container.classList.toggle("streaming", streaming);
		if (this.sticky) this.container.scrollTop = this.container.scrollHeight;
	}

	scrollToBottom(): void {
		this.sticky = true;
		this.container.scrollTop = this.container.scrollHeight;
	}

	/** Whether the reader is at the bottom, which decides if a redraw should chase it. */
	following(): boolean {
		return this.sticky;
	}

	private renderMessage(item: Extract<Item, { kind: "message" }>): void {
		let turn = this.turns.get(item.id);
		if (!turn) {
			turn = this.createTurn(item);
			this.turns.set(item.id, turn);
			this.container.append(turn.section);
			this.sticky = true;
		}
		turn.item = item;
		this.applyControls(turn);

		// A notice is plain text and never streams, so it is written once and left alone.
		if (item.notice) {
			if (turn.text !== item.text) {
				turn.body.replaceChildren(element("p", undefined, item.text));
				turn.text = item.text;
			}
			return;
		}

		if (item.text === turn.text) return;
		turn.blocks = renderMarkdown(turn.body, item.text, turn.blocks);
		turn.text = item.text;
	}

	/**
	 * One turn.
	 *
	 * A user message is a bubble against the right margin with no name on it — it is the reader's own
	 * words, and labelling them "You" wastes the line they sit on. The agent's work is the opposite:
	 * it runs the full width of the column, because it is what is being read, and it keeps its name so
	 * a long transcript still says who is speaking.
	 */
	private createTurn(item: Extract<Item, { kind: "message" }>): Turn {
		const section = element("section", `turn ${item.role}${item.notice ? " notice" : ""}`);
		const body = element("div", "turn-body");
		const turn: Turn = { section, body, blocks: 0, text: "", item };

		if (item.role === "user") {
			section.dataset.role = "user";
			// The two ways on from a message: another alternative inside this session, or a session of
			// its own. They sit together because they answer one question — "what if I went another way
			// here" — and only the tooltips have to carry which one keeps the rest of the tree.
			const actions = element("div", "turn-actions");
			actions.append(this.branchButton(turn), this.forkButton(turn), this.branchNav(turn));
			section.append(actions, body);
			return turn;
		}

		const role = element("div", "turn-role");
		role.append(element("span", "avatar", initialFor(item.role)), element("span", "role-name", labelFor(item.role)));
		// An agent message can be a branch point too — asking twice from the same answer forks there —
		// so it carries the switcher, without the two controls that only make sense on your own words.
		role.append(this.branchNav(turn));
		section.append(role, body);
		return turn;
	}

	/**
	 * Fill in the controls a turn's own message says it has.
	 *
	 * Everything here can arrive after the section was built: a user message is written to the store
	 * before the loop echoes it, so its entry id lands a frame later, and a branch point only exists
	 * once the conversation has been rewound. So the controls are created inert and told what they act
	 * on by each render — the turn reads through {@link Turn.item}, which every render replaces.
	 */
	private applyControls(turn: Turn): void {
		const { item, section } = turn;
		const entryId = item.forkEntryId ?? undefined;

		const branchButton = section.querySelector<HTMLButtonElement>(".branch-button");
		if (branchButton) branchButton.disabled = entryId === undefined;

		const forkButton = section.querySelector<HTMLButtonElement>(".fork-button");
		if (forkButton) forkButton.disabled = entryId === undefined;

		const nav = section.querySelector<HTMLElement>(".branch-nav");
		if (!nav) return;

		const options = item.branch?.options ?? [];
		// One alternative is not a choice, so a message that never forked shows no switcher at all.
		nav.hidden = options.length < 2;
		if (options.length < 2) return;

		const active = Math.max(1, options.findIndex((option) => option.active) + 1);
		const count = nav.querySelector<HTMLElement>(".branch-count");
		if (count) count.textContent = `${active}/${options.length}`;
		const previous = nav.querySelector<HTMLButtonElement>('[data-step="-1"]');
		const next = nav.querySelector<HTMLButtonElement>('[data-step="1"]');
		if (previous) previous.disabled = active <= 1;
		if (next) next.disabled = active >= options.length;
		// The alternatives that are not on screen are the ones worth naming, and the active one is
		// marked so the list also says which of them is being read.
		nav.title = options.map((option, index) => `${index + 1}.${option.active ? " ●" : ""} ${labelOf(option)}`).join("\n");
	}

	/** Rewind to this message, so the next prompt starts another alternative from it. */
	private branchButton(turn: Turn): HTMLButtonElement {
		const button = element("button", "turn-action branch-button", "从此分支", {
			type: "button",
			title: "在本会话里从这条消息继续：其后内容保留为另一条分支",
		});
		button.disabled = true;
		button.addEventListener("click", () => {
			const entryId = turn.item.forkEntryId;
			if (entryId) this.options.onBranch(entryId, false);
		});
		return button;
	}

	/**
	 * The "派生新会话" control on a user message.
	 *
	 * It starts a session of its own rather than moving this one, and that is the difference the
	 * tooltip has to carry: a fork copies the branch into a new file and leaves this conversation be.
	 */
	private forkButton(turn: Turn): HTMLButtonElement {
		const button = element("button", "turn-action fork-button", "派生新会话", {
			type: "button",
			title: "从这条消息另起一个会话，当前会话保持不变",
		});
		button.disabled = true;
		button.addEventListener("click", () => {
			const entryId = turn.item.forkEntryId;
			if (entryId) this.options.onFork(entryId);
		});
		return button;
	}

	/**
	 * Which of the conversation's own alternatives is on screen, and the way to the others.
	 *
	 * A count between two steps rather than a list, because a branch point rarely has more than two
	 * continuations, and the one that is not shown is the one a reader wants named — which the tooltip
	 * does, from the labels the server derived from where each alternative actually goes.
	 */
	private branchNav(turn: Turn): HTMLElement {
		const nav = element("span", "branch-nav");
		nav.hidden = true;

		const step = (direction: -1 | 1, label: string, glyph: string): HTMLButtonElement => {
			const button = element("button", "branch-step", glyph, {
				type: "button",
				"data-step": String(direction),
				title: label,
			});
			button.addEventListener("click", () => {
				const options = turn.item.branch?.options ?? [];
				const active = Math.max(1, options.findIndex((option) => option.active) + 1);
				const option = options[active - 1 + direction];
				if (option) this.options.onBranch(option.entryId, true);
			});
			return button;
		};

		nav.append(step(-1, "上一条分支", "‹"), element("span", "branch-count", "1/1"), step(1, "下一条分支", "›"));
		return nav;
	}

	/**
	 * One tool group, rebuilt only when its card list changed.
	 *
	 * Cards of a group update as the tool runs — its output grows, then it settles — so the reshape
	 * key is the number of cards plus each card's run state, output length, and whether it brought a
	 * diff back. Rebuilding on every `tool_execution_update` would throw away the `<details>` the
	 * reader just opened.
	 */
	private renderTools(id: string, cards: readonly ToolCard[]): void {
		const shape = cards
			.map(
				(card) =>
					`${card.toolCallId}:${card.running ? "r" : "d"}:${card.isError ? "e" : "o"}:${card.output.length}:${card.diff ? "D" : "-"}`,
			)
			.join("|");
		let group = this.tools.get(id);
		if (group && group.section.dataset.shape === shape) return;

		if (!group) {
			const section = element("section", "tool-group");
			group = { section, cards: [] };
			this.tools.set(id, group);
			this.container.append(section);
			this.sticky = true;
		}

		group.section.dataset.shape = shape;
		group.section.replaceChildren(...cards.map((card) => renderTool(card)));
	}

	/** The first-run state: an empty conversation says what this is and what to do. */
	private setWelcome(visible: boolean): void {
		if (!visible) {
			this.welcome?.remove();
			this.welcome = undefined;
			return;
		}
		if (this.welcome) return;

		const welcome = element("div", "welcome");
		const mark = element("div", "welcome-mark");
		mark.append(icon("sparkle"));
		welcome.append(
			mark,
			element("h2", undefined, "想做点什么？"),
			element(
				"p",
				undefined,
				"描述要改的地方、要修的 bug，或要解释的内容。智能体运行的每个工具都会显示在这份记录里，任何要改动磁盘的操作都会先征求同意。",
			),
		);
		this.welcome = welcome;
		this.container.append(welcome);
	}
}

/** What a message's role reads as in the transcript. */
function labelFor(role: string): string {
	if (role === "user") return "你";
	if (role === "assistant") return "智能体";
	if (role === "compactionSummary") return "上下文摘要";
	return role;
}

/**
 * How one alternative reads in a switcher's tooltip.
 *
 * A branch point's alternatives are told apart by the first thing said below each one, which can be
 * either side of the conversation — so the label says who speaks before it says what was said. An
 * assistant turn that only called a tool has no text at all, and saying so beats an empty line.
 */
function labelOf(option: BranchOption): string {
	return `${labelFor(option.role)}：${option.label.length > 0 ? option.label : "（无文本）"}`;
}

function initialFor(role: string): string {
	if (role === "user") return "你";
	if (role === "assistant") return "智";
	return "•";
}

/**
 * One tool card: a summary line that always shows what was called, and the result behind it.
 *
 * A call that changed a file shows the change itself, which is the one thing about it worth reading:
 * the diff carries the path and the counts that the tool's own text was there to state, so the text
 * is left out rather than repeated in a worse form. Every other call — and any tool that reported no
 * diff — falls back to its output.
 */
function renderTool(card: ToolCard): HTMLElement {
	const details = element("details", `tool${card.isError ? " error" : ""}${card.running ? " running" : ""}`);
	if (card.isError || card.running) details.open = true;

	const summary = element("summary");
	const chevron = element("span", "tool-chevron");
	chevron.append(icon("chevron"));
	summary.append(
		chevron,
		element("span", "tool-status"),
		element("span", "tool-name", card.toolName),
		// A diff names the file it changed, which is what a card says when its arguments had no path
		// to preview in the first place.
		element("span", "tool-preview", previewOf(card.args) || (card.diff?.path ?? "")),
	);
	if (card.diff) summary.append(diffStat(card.diff));

	details.append(summary, card.diff ? renderFileDiff(card.diff) : outputOf(card));
	return details;
}

function outputOf(card: ToolCard): HTMLElement {
	const output = element("pre", "tool-output");
	output.textContent = card.output.length > 0 ? card.output : card.running ? "运行中…" : "无输出";
	return output;
}

/**
 * The one argument a tool card shows collapsed.
 *
 * These are the tools whose call is recognizable from a single value, in the order that reads best:
 * a shell command, then a path, then a pattern. Anything else shows nothing rather than a JSON blob,
 * which would only be a worse version of what the expanded card already shows.
 */
function previewOf(args: unknown): string {
	if (args === undefined || args === null) return "";
	const record = args as Record<string, unknown>;
	for (const key of ["command", "path", "pattern", "include"]) {
		const value = record[key];
		if (typeof value === "string") {
			const single = value.replace(/\s+/g, " ").trim();
			return single.length > 90 ? `${single.slice(0, 87)}…` : single;
		}
	}
	return "";
}
