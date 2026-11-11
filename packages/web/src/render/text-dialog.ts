import { element } from "../dom.ts";

/**
 * 在卡片里问的一小段输入。
 *
 * 本窗口除 composer 之外唯一需要的输入 —— 一个新文件夹的名字 —— 用画的而不用 `window.prompt`
 * 问，这不是选择：桌面外壳禁用了原生对话框，那里的 `prompt` 返回空，功能会无声失效。自己画
 * 也让卡片能坐在窗口自己的字体、颜色和主题里。
 *
 * 卡片是*模态的*，与 {@link openMenuAt} 的菜单不同：它居中、接管键盘、挡住身后的页面，而不是
 * 指针落在别处就自己散掉。问一个问题、再让答案被一次误点弄丢，就是让一次重命名变成耸肩。
 *
 * 一次一个，模块作用域，与菜单一样 —— 登记表就是屏幕上的那张卡，与离开它的唯一道路一起持有，
 * 所以没有卡片能被不回答地拿走。
 */

/** 卡片被要求什么。 */
export interface TextDialogOptions {
	/** 标题，一句短话："重命名目录"。 */
	title: string;
	/** 字段上方的标签，也是字段被宣告为何的名字。 */
	label: string;
	/** 字段打开时的文本，已全选。 */
	value: string;
	/** 字段下面的一行，给用户从卡片本身看不到的那一件事。 */
	hint?: string;
	/** 确认按钮的词："重命名"。 */
	confirm: string;
}

/**
 * 问一行文本。以输入的内容结算，没有被要求任何东西则为 `undefined`。
 *
 * 与卡片打开时相同的值结算为 `undefined` 而不是提交同一字符串：调用者的操作是"改这个"，按
 * Enter 但什么都没输的卡片什么都没改。这条规则住在这里，让每个调用者都不必重新推导。
 */
export function askForText(options: TextDialogOptions): Promise<string | undefined> {
	// 一次一张卡，且被替换的那张被结算而不是仅仅被拿走：被留下一个无路可答的 promise 的调用者，
	// 会一直等到窗口生命的尽头。
	open?.finish(undefined);
	return new Promise((resolve) => {
		show(options, resolve);
	});
}

/**
 * 屏幕上的卡片，连同离开它的唯一道路。
 *
 * 元素和它的 `finish` 被一起持有，因为它们必须一起使用：没有被结算就被移除的卡片，正是那个
 * 什么都回答不了的 promise。一次一张，所以一个模块变量就是全部登记表。
 */
let open: { overlay: HTMLElement; finish(value: string | undefined): void } | undefined;

/** 拿走卡片，若有。调用者的答案是 {@link open} 的 `finish`，不是这个。 */
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

	// 每条出去的路都是同一条，先到的赢：Enter、确认按钮和 Escape 都恰好结算一次。守卫是局部的
	// 而不是字段，因为唯一必须为真的是"这张卡回答过一次" —— 而 Escape 经这张卡发布的 `finish`
	// 到达它，那是同一个闭包而不是第二条出路。
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
	// 按在卡片身后的页面上什么都不做 —— 那不是关闭。卡片是一个有两个答案的问题，而两个答案里
	// 没有"指针在别处"。
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

/** Escape 像取消一样回答卡片："没被要求任何东西"，而不是"卡片没了"。 */
function onEscape(event: KeyboardEvent): void {
	if (event.key !== "Escape") return;
	event.stopPropagation();
	open?.finish(undefined);
}
