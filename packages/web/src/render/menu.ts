import { element, icon, type IconName } from "../dom.ts";

/** One row of a menu. A `separator` kind draws the divider and ignores the rest. */
export interface MenuItem {
	label?: string;
	icon?: IconName;
	/** The tooltip the row carries, which is usually the full path a label was shortened from. */
	title?: string;
	/** The row the choice currently sits on, marked rather than left to be discovered. */
	active?: boolean;
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
 */
export function openMenu(anchor: HTMLElement, items: readonly MenuItem[]): void {
	closeMenu();

	const menu = element("div", "menu", undefined, { role: "menu" });
	for (const item of items) {
		if (item.kind === "separator") {
			menu.append(element("div", "menu-separator"));
			continue;
		}
		const row = element("button", "menu-item", undefined, { type: "button", role: "menuitem" });
		row.dataset.active = item.active === true ? "true" : "false";
		if (item.title !== undefined) row.title = item.title;
		if (item.icon !== undefined) row.append(icon(item.icon));
		row.append(element("span", "menu-label", item.label ?? ""));
		row.addEventListener("click", () => {
			closeMenu();
			item.onSelect?.();
		});
		menu.append(row);
	}

	// `position: fixed` against the viewport keeps the menu with the anchor without measuring the
	// page: the anchor's own rect is measured once, when the menu opens.
	const rect = anchor.getBoundingClientRect();
	menu.style.left = `${rect.left}px`;
	menu.style.top = `${rect.bottom + 4}px`;
	document.body.append(menu);
	open = menu;

	menu.addEventListener("pointerdown", (event) => event.stopPropagation());
	document.addEventListener("pointerdown", onOutside, true);
	document.addEventListener("keydown", onEscape, true);
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
	closeMenu();
}

function onEscape(event: KeyboardEvent): void {
	if (event.key === "Escape") {
		event.stopPropagation();
		closeMenu();
	}
}
