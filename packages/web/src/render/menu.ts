import { element, icon, type IconName } from "../dom.ts";

/** One row of a menu. A `separator` kind draws the divider and ignores the rest. */
export interface MenuItem {
	label?: string;
	/**
	 * The row's second line, when a choice needs one more fact than its name carries — the mode
	 * picker's summaries are the reason this exists. A row with a detail stacks its two lines; the
	 * active mark still rides the first.
	 */
	detail?: string;
	icon?: IconName;
	/** The tooltip the row carries, which is usually the full path a label was shortened from. */
	title?: string;
	/** The row the choice currently sits on, marked rather than left to be discovered. */
	active?: boolean;
	/** A destructive row, named by colour as well as by words. */
	danger?: boolean;
	onSelect?(): void;
	kind?: "separator";
}

/**
 * The one self-drawn dropdown, and the only one.
 *
 * The workspace picker needs a menu that a native `select` cannot give it — rows with icons, a
 * full-path tooltip, and a footer action that is not a choice among the listed values — and that is
 * the whole justification for drawing one by hand. Anything else in this window stays a native
 * control, because a second popup implementation is a second set of focus, hover, and dismissal
 * rules to keep honest.
 *
 * One menu at a time, module-scoped: opening a menu closes the one before it, which is the behaviour
 * a popup has everywhere else on this platform. Dismissal is outside-pointerdown, Escape, and
 * selection; resize and re-layout are handled by closing, which is what menus without their own
 * positioning logic have always done.
 *
 * Two ways in, one menu: {@link openMenu} hangs it under an anchor element, and {@link openMenuAt}
 * puts it where the pointer was — the shape a `contextmenu` wants, since the thing it was asked on
 * is a row that may be rebuilt before the menu even draws.
 */
export function openMenu(anchor: HTMLElement, items: readonly MenuItem[]): void {
	closeMenu();
	const menu = build(items);
	const rect = anchor.getBoundingClientRect();
	// `position: fixed` against the viewport keeps the menu with the anchor without measuring the
	// page: the anchor's own rect is measured once, when the menu opens.
	menu.style.left = `${rect.left}px`;
	menu.style.top = `${rect.bottom + 4}px`;
}

/**
 * Open the menu at a pointer, clamped to the viewport.
 *
 * The clamp is the one thing a pointer-opened menu needs that an anchor-opened one does not: a row
 * near the window's edge would otherwise open a menu half outside it. Measured after appending, so
 * the menu's own size is what the clamp reads rather than a guess.
 */
export function openMenuAt(x: number, y: number, items: readonly MenuItem[]): void {
	closeMenu();
	const menu = build(items);
	menu.style.left = `${Math.min(x, window.innerWidth - menu.getBoundingClientRect().width - 8)}px`;
	menu.style.top = `${Math.min(y, window.innerHeight - menu.getBoundingClientRect().height - 8)}px`;
}

/** Build the menu's rows, put it on the page, and arm the dismissal listeners. */
function build(items: readonly MenuItem[]): HTMLElement {
	const menu = element("div", "menu", undefined, { role: "menu" });
	for (const item of items) {
		if (item.kind === "separator") {
			menu.append(element("div", "menu-separator"));
			continue;
		}
		const row = element("button", "menu-item", undefined, { type: "button", role: "menuitem" });
		row.dataset.active = item.active === true ? "true" : "false";
		if (item.danger === true) row.dataset.danger = "true";
		if (item.title !== undefined) row.title = item.title;
		if (item.icon !== undefined) row.append(icon(item.icon));
		if (item.detail !== undefined) {
			const text = element("span", "menu-text");
			text.append(element("span", "menu-label", item.label ?? ""), element("span", "menu-detail", item.detail));
			row.append(text);
		} else {
			row.append(element("span", "menu-label", item.label ?? ""));
		}
		row.addEventListener("click", () => {
			closeMenu();
			item.onSelect?.();
		});
		menu.append(row);
	}

	document.body.append(menu);
	open = menu;

	menu.addEventListener("pointerdown", (event) => event.stopPropagation());
	document.addEventListener("pointerdown", onOutside, true);
	document.addEventListener("keydown", onEscape, true);
	return menu;
}

/** The menu currently open, if any. One at a time, so a module variable is the whole registry. */
let open: HTMLElement | undefined;

export function closeMenu(): void {
	if (open === undefined) return;
	open.remove();
	open = undefined;
	document.removeEventListener("pointerdown", onOutside, true);
	document.removeEventListener("keydown", onEscape, true);
}

function onOutside(event: PointerEvent): void {
	// A press inside the open menu is the click choosing a row, not a dismissal. The check has to sit
	// here rather than trusting the menu's own `stopPropagation`: this listener is a capture listener
	// on the document, which runs before any listener on the menu itself, so by the time the menu
	// could speak the menu would already be gone — and the click it was protecting would land nowhere.
	if (open !== undefined && event.target instanceof Node && open.contains(event.target)) return;
	closeMenu();
}

function onEscape(event: KeyboardEvent): void {
	if (event.key === "Escape") {
		event.stopPropagation();
		closeMenu();
	}
}
