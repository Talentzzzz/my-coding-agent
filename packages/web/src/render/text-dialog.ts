import { element } from "../dom.ts";

/**
 * One short piece of typing, asked for in a card.
 *
 * The only input this window ever needs that is not the composer's — a new folder name — and it is
 * drawn rather than asked for with `window.prompt`, which is not a choice: the desktop shell disables
 * the native dialog, so a `prompt` there returns nothing and the feature would silently do nothing.
 * Drawing it is also what lets the card sit inside the window's own type, colour, and theme.
 *
 * The card is a *modal*, unlike {@link openMenuAt}'s menu: it is centred, it takes the keyboard, and it
 * blocks the page behind it rather than dismissing itself when the pointer lands elsewhere. Asking a
 * question and letting the answer be lost by a stray click is how a rename becomes a shrug.
 *
 * One at a time, module-scoped, the way the menu is — the registry is the card that is on screen,
 * held with the one road out of it so no card can be taken away without being answered.
 */

/** What the card is asked for. */
export interface TextDialogOptions {
	/** The heading, one short line: "重命名目录". */
	title: string;
	/** The label above the field, which is also what the field is announced as. */
	label: string;
	/** The text the field opens with, already selected. */
	value: string;
	/** The line under the field, for the one thing the user cannot see from the card alone. */
	hint?: string;
	/** The confirming button's word: "重命名". */
	confirm: string;
}

/**
 * Ask for one line of text. Resolves with what was typed, or `undefined` if nothing was asked for.
 *
 * A value identical to the one the card opened with is `undefined` rather than a commit of the same
 * string: the caller's operation is "change this", and a card dismissed with Enter and nothing typed
 * has not changed anything. That rule lives here so no caller has to re-derive it.
 */
export function askForText(options: TextDialogOptions): Promise<string | undefined> {
	// One card at a time, and the one it replaces is settled rather than merely taken away: a caller
	// left holding a promise no road can answer waits for the rest of the window's life.
	open?.finish(undefined);
	return new Promise((resolve) => {
		show(options, resolve);
	});
}

/**
 * The card on screen, with the one road out of it.
 *
 * The element and its `finish` are held together because they have to be used together: a card removed
 * without being settled is exactly the promise nothing can answer. One at a time, so a module variable
 * is the whole registry.
 */
let open: { overlay: HTMLElement; finish(value: string | undefined): void } | undefined;

/** Take the card away, if one is up. The caller's answer is {@link open}'s `finish`, not this. */
function closeTextDialog(): void {
	if (open === undefined) return;
	open.overlay.remove();
	open = undefined;
	document.removeEventListener("keydown", onEscape, true);
}

function show(options: TextDialogOptions, settle: (value: string | undefined) => void): void {
	const overlay = element("div", "text-dialog-overlay", undefined, { role: "presentation" });
	const card = element("div", "text-dialog", undefined, { role: "dialog", "aria-modal": "true" });
	card.append(element("div", "text-dialog-title", options.title));

	const input = element("input", "text-dialog-input", undefined, {
		type: "text",
		"aria-label": options.label,
	});
	input.value = options.value;
	card.append(element("label", "text-dialog-label", options.label), input);
	if (options.hint !== undefined) card.append(element("div", "text-dialog-hint", options.hint));

	const actions = element("div", "text-dialog-actions");
	const cancel = element("button", "button", "取消", { type: "button" });
	const confirm = element("button", "button primary", options.confirm, { type: "button" });
	actions.append(cancel, confirm);
	card.append(actions);
	overlay.append(card);

	// Every road out is the same one, and the first to arrive wins: Enter, the confirming button, and
	// Escape all settle exactly once. The guard is a local rather than a field because the only thing
	// that has to be true is "this card answered once" — and Escape reaches it through the `finish`
	// this card publishes, which is the same closure rather than a second way out.
	let settled = false;
	const finish = (value: string | undefined): void => {
		if (settled) return;
		settled = true;
		closeTextDialog();
		settle(value);
	};
	const commit = (): void => {
		const typed = input.value.trim();
		finish(typed.length === 0 || typed === options.value.trim() ? undefined : typed);
	};

	cancel.addEventListener("click", () => finish(undefined));
	confirm.addEventListener("click", commit);
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			commit();
		}
	});
	// A press on the page behind the card does nothing at all — it is not a dismissal. The card is a
	// question with two answers, and neither of them is "the pointer was somewhere else".
	overlay.addEventListener("pointerdown", (event) => {
		event.stopPropagation();
		if (event.target === overlay) input.focus();
	});

	document.body.append(overlay);
	open = { overlay, finish };
	document.addEventListener("keydown", onEscape, true);
	input.focus();
	input.select();
}

/** Escape answers the card the way 取消 does: "nothing was asked", not "the card went away". */
function onEscape(event: KeyboardEvent): void {
	if (event.key !== "Escape") return;
	event.stopPropagation();
	open?.finish(undefined);
}
