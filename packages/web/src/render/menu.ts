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
 * Where a menu hangs relative to its anchor.
 *
 * A menu below its anchor is what a picker in the middle of the page wants; a menu above it is what
 * the composer's seats want, because they sit on the window's bottom edge and a menu hung underneath
 * them has nowhere to go. Either way the choice is a preference rather than a promise: a menu with
 * no room on the side it was asked for takes the other one, and both are clamped into the viewport.
 *
 * `align` picks the edge that lines up with the anchor's: `"start"` (the default) matches left edges,
 * `"end"` matches right edges, which is how a seat at the bar's right end keeps its menu inside the
 * card it belongs to instead of running off the window.
 */
export interface MenuPlacement {
	placement?: "above" | "below";
	align?: "start" | "end";
}

/**
 * The one self-drawn dropdown, and the only one.
 *
 * It was drawn for the directory picker — rows with icons, a full-path tooltip, and a footer action
 * that is not a choice among the listed values, none of which a native `select` can carry. The
 * composer's model and level seats joined it for the other thing a native control cannot do: its
 * popup is the platform's, not the theme's, so on a dark window it arrives as a light rectangle. The
 * two seats are the ones read and changed most often, so they wear this menu rather than that one.
 * Nothing outside these three uses it; a picker that has no such need stays a native control,
 * because a second popup implementation is a second set of focus, hover, and dismissal rules to
 * keep honest.
 *
 * One menu at a time, module-scoped: opening a menu closes the one before it, which is the behaviour
 * a popup has everywhere else on this platform. Dismissal is outside-pointerdown, Escape, and
 * selection; resize and re-layout are handled by closing, which is what menus without their own
 * positioning logic have always done.
 *
 * Two ways in, one menu: {@link openMenu} hangs it under (or over) an anchor element, and
 * {@link openMenuAt} puts it where the pointer was — the shape a `contextmenu` wants, since the
 * thing it was asked on is a row that may be rebuilt before the menu even draws.
 */
export function openMenu(anchor: HTMLElement, items: readonly MenuItem[], where: MenuPlacement = {}): void {
	closeMenu();
	const menu = build(items);
	// `position: fixed` against the viewport keeps the menu with the anchor without measuring the
	// page: the anchor's own rect is measured once, when the menu opens. The menu's own size is
	// read after it is on the page, so "does it fit" is answered by the drawn menu, not a guess.
	const rect = anchor.getBoundingClientRect();
	const { width, height } = menu.getBoundingClientRect();

	// The gap between anchor and menu, and the margin kept from the window's edges.
	const gap = 4;
	const inset = 8;

	const left = where.align === "end" ? rect.right - width : rect.left;
	menu.style.left = `${clamp(left, inset, window.innerWidth - width - inset)}px`;

	const above = rect.top - gap - height;
	const below = rect.bottom + gap;
	const fits = { above: above >= inset, below: below + height <= window.innerHeight - inset };
	const top =
		where.placement === "above" ? (fits.above ? above : below)
		: where.placement === "below" ? (fits.below ? below : above)
		: fits.below ? below
		: above;
	menu.style.top = `${clamp(top, inset, window.innerHeight - height - inset)}px`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
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
