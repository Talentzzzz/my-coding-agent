/**
 * 元素构造辅助函数。
 *
 * 客户端直接构建 DOM，所以这里就是每个视图需要的两个动词：造一个元素，往里放文字。图标只从本
 * 模块自己的常量走 `innerHTML` —— 模型输出永远到不了那条路径。
 */

type Attributes = Record<string, string | number | boolean | undefined>;

/**
 * 创建一个元素。
 *
 * `className` 和 `text` 覆盖常见情形；`attributes` 覆盖其余。布尔值 `true` 写出空属性（如
 * `hidden`），`false` 和 `undefined` 跳过，数字会字符串化 —— 这正是 `data-*` 和 `colspan` 需要
 * 的。
 */
export function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
	attributes?: Attributes,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className !== undefined) node.className = className;
	if (text !== undefined) node.textContent = text;
	if (attributes) {
		for (const [name, value] of Object.entries(attributes)) {
			if (value === undefined || value === false) continue;
			node.setAttribute(name, value === true ? "" : String(value));
		}
	}
	return node;
}

/** 一个 `<option>`：唯一需要 value 和 label 不同的元素。 */
export function option(value: string, label: string): HTMLOptionElement {
	const node = document.createElement("option");
	node.value = value;
	node.textContent = label;
	return node;
}

/**
 * 一个图标按钮。
 *
 * 外壳里的每个图标都是同一种控件 —— 方形、token 级的 hover、tooltip —— 所以几何尺寸只在这里
 * 写一处。
 */
export function iconButton(name: IconName, label: string, onClick: () => void, className = "icon-button"): HTMLButtonElement {
	const button = element("button", className, undefined, { type: "button", title: label, "aria-label": label });
	button.innerHTML = ICONS[name];
	button.addEventListener("click", onClick);
	return button;
}

/** 一个命名的图标，内联 SVG。 */
export function icon(name: IconName): SVGElement {
	const wrapper = document.createElement("div");
	wrapper.innerHTML = ICONS[name];
	return wrapper.firstElementChild as SVGElement;
}

export type IconName =
	| "plus"
	| "panel"
	| "sliders"
	| "search"
	| "folder-add"
	| "send"
	| "stop"
	| "chevron"
	| "shield"
	| "sparkle"
	| "sidebar"
	| "folder"
	| "gear"
	| "close"
	| "trash"
	| "fork"
	| "tree"
	| "monitor"
	| "sun"
	| "moon"
	| "copy"
	| "check"
	| "database"
	| "clock"
	| "timer";

/**
 * 24×24 网格上的线性图标，以 `currentColor` 描边。
 *
 * 采用内联而非字体或雪碧图，是为了让图标继承所在按钮的颜色，包括 hover 和两种主题，且不需要
 * 第二次请求。
 */
const ICONS: Record<IconName, string> = {
	plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
	panel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>`,
	sliders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/></svg>`,
	search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4"/></svg>`,
	// 选择器的"添加目录"：一个带加号的文件夹，一个字形而不是两个文字想法。
	"folder-add": `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/></svg>`,
	send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M12 6l6 6-6 6"/></svg>`,
	stop: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>`,
	chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`,
	shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.4-2.9 7.9-7 9-4.1-1.1-7-4.6-7-9V6z"/><path d="M12 9v4M12 16h.01"/></svg>`,
	sparkle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/></svg>`,
	sidebar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>`,
	folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
	gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
	close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
	trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>`,
	// 从别的会话派生出来的会话上的标记：一条离开上方那条的线。
	fork: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v7a4 4 0 0 0 4 4h7"/><path d="M14 12l3 3-3 3"/></svg>`,
	// 分支页的标记：岔路口，按树生长的方向从左往右读。
	tree: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M7 5h4a4 4 0 0 1 4 4v0"/><path d="M7 19h4a4 4 0 0 0 4-4v0"/></svg>`,
	monitor: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/></svg>`,
	sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
	moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>`,
	// 消息 meta 行的复制：两张叠放的纸。
	copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
	// 复制按钮的成功状态，显示一拍后两张纸回来。
	check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>`,
	// 底部信息条的用量：一个实心数据库。
	database: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>`,
	// 底部信息条的消息墙钟时间。
	clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
	// 底部信息条与运行行的已用时间：一只秒表。
	timer: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6M12 2v3"/></svg>`,
};
