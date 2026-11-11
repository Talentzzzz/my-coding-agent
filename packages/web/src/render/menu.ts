import { element, icon, type IconName } from "../dom.ts";

/** 菜单的一行。`separator` 类型画分隔线并忽略其余。 */
export interface MenuItem {
	label?: string;
	/**
	 * 行的第二行，当一个选择需要比名字更多的一个事实时 —— 模式选择器的摘要就是它存在的原因。
	 * 带 detail 的行把两行叠放；active 标记仍然落在第一行。
	 */
	detail?: string;
	icon?: IconName;
	/** 行携带的 tooltip，通常是一个标签被缩短前的完整路径。 */
	title?: string;
	/** 当前选择所在的那一行，标记出来而不是靠发现。 */
	active?: boolean;
	/** 破坏性的一行，用颜色和文字双重指名。 */
	danger?: boolean;
	onSelect?(): void;
	kind?: "separator";
}

/**
 * 菜单相对锚点的位置。
 *
 * 锚点下方是页面中间的选择器想要的；锚点上方是 composer 席位想要的，因为它们贴着窗口下边缘，
 * 挂在下面的菜单无处安放。无论哪种，选择都是偏好而不是承诺：被要求的那一侧放不下时菜单取另一
 * 侧，且都被夹进视口。
 *
 * `align` 选择与锚点对齐的边：`"start"`（默认）对左缘，`"end"` 对右缘，这正是输入条右端的席位
 * 让菜单留在它所属的卡片里而不是跑出窗口的方式。
 */
export interface MenuPlacement {
	placement?: "above" | "below";
	align?: "start" | "end";
}

/**
 * 唯一自绘的下拉菜单，仅此一个。
 *
 * 它为目录选择器而画 —— 带图标的行、完整路径的 tooltip、以及一个不是"在列出的值中做选择"的
 * 底部动作，这些原生 `select` 都带不了。composer 的模型和档位席位加入它，为了原生控件做不到的
 * 另一件事：它的弹窗是平台的，不是主题的，深色窗口上它是一块亮色矩形。这两个席位是读得最多、
 * 改得最多的，所以它们穿这个菜单而不是那一个。这三处之外没有任何东西用它；没有这种需求的选择
 * 器保持原生控件，因为第二个弹窗实现就是第二套焦点、悬停和关闭规则要去维护。
 *
 * 一次一个菜单，模块作用域：打开一个菜单就关闭前一个，这是弹窗在本平台其他所有地方的行为。
 * 关闭方式是外部 pointerdown、Escape 和选择；resize 和重排以关闭处理，这是没有自己的定位逻辑的
 * 菜单一直在做的事。
 *
 * 两种入口，一个菜单：{@link openMenu} 把它挂在锚点元素的下（或上）方，{@link openMenuAt} 把它
 * 放在指针所在处 —— `contextmenu` 要的形状，因为它被按下的那一行可能在菜单画出来之前就被
 * 重建。
 */
export function openMenu(anchor: HTMLElement, items: readonly MenuItem[], where: MenuPlacement = {}): void {
	closeMenu();
	const menu = build(items);
	// 对视口 `position: fixed` 让菜单跟着锚点而无需测量页面：锚点自己的 rect 在菜单打开时测一次。
	// 菜单自身的尺寸在它上页之后读，所以"装不装得下"由画出来的菜单回答，而不是猜测。
	const rect = anchor.getBoundingClientRect();
	const { width, height } = menu.getBoundingClientRect();

	// 锚点与菜单之间的间隙，以及距窗口边缘保留的边距。
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
 * 在指针处打开菜单，夹进视口。
 *
 * 这个夹断是指针打开的菜单唯一需要而锚点打开的不需要的：靠窗口边缘的行否则会打开一个半在窗外的
 * 菜单。在追加之后测量，所以夹断读到的是菜单自己的尺寸而不是猜测。
 */
export function openMenuAt(x: number, y: number, items: readonly MenuItem[]): void {
	closeMenu();
	const menu = build(items);
	menu.style.left = `${Math.min(x, window.innerWidth - menu.getBoundingClientRect().width - 8)}px`;
	menu.style.top = `${Math.min(y, window.innerHeight - menu.getBoundingClientRect().height - 8)}px`;
}

/** 构建菜单的行、放上页面、并装好关闭监听。 */
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

/** 当前打开的菜单，若有。一次一个，所以一个模块变量就是全部的登记表。 */
let open: HTMLElement | undefined;

export function closeMenu(): void {
	if (open === undefined) return;
	open.remove();
	open = undefined;
	document.removeEventListener("pointerdown", onOutside, true);
	document.removeEventListener("keydown", onEscape, true);
}

function onOutside(event: PointerEvent): void {
	// 在打开菜单内部的按压是选择一行的点击，不是关闭。检查必须在这里做，而不是信任菜单自己的
	// `stopPropagation`：本监听是 document 上的捕获监听，先于菜单上的任何监听运行，等菜单来得及
	// 说话时菜单已经没了 —— 它要保护的点击会落在空处。
	if (open !== undefined && event.target instanceof Node && open.contains(event.target)) return;
	closeMenu();
}

function onEscape(event: KeyboardEvent): void {
	if (event.key === "Escape") {
		event.stopPropagation();
		closeMenu();
	}
}
