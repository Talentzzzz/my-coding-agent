/**
 * dom-shim —— 量具用的最小 DOM 宿主，**一份**。
 *
 * 为什么不各写各的：`scripts/smoke-sidebar.ts` 与 `jank-harness.ts` 各自手搓过一份 `FakeNode`，
 * 于是同一个缺失（`Node.contains`）在一边补了、在另一边没补——`482673a` 之后 `ensureHeading` 开始用
 * `contains`，sidebar 的 smoke 当场补上，量具却从那天起跑不起来，H6 之后的结论全变成读代码读出来的
 * （见 `.scratch/window-repair/issues/04-jank-harness.md`）。补齐一份、两边共用，是让这件事不再发生的
 * 唯一办法。
 *
 * 覆盖面按**今天的产品代码**算：`transcript.ts` / `sidebar.ts` / `statusbar.ts` / `settings.ts` /
 * `session-settings.ts` / `composer.ts` / `menu.ts` / `markdown.ts` / `diff.ts` / `dom.ts` /
 * `branch-view.ts` / `main.ts` 里出现过的每一个 DOM 成员都实现了。缺哪一个，下面 `installDom()` 的
 * **严格模式**会当场指名道姓地抛出来，而不是静默地 `undefined` 然后几十行之后才崩。
 *
 * 它**不是**浏览器：没有布局、没有事件循环、没有 CSS。绝对毫秒数因此不是真实帧时间，可靠的信号是
 * 同一把尺子下短 vs 长的比值。源码注释用英文（本仓库约定），本文件顶部的说明用中文。
 */

// ------------------------------------------------------------------ 严格模式

/**
 * 严格模式：量具**碰到**一个没实现的 DOM 成员就当场抛，而不是让 `undefined` 流到几帧之后。
 *
 * 这是这套 shim 从"能跑"到"对得上今天的产品代码"的那道闸——本文件的覆盖清单就是被它逼出来的。
 * `DOM_SHIM_LAX=1` 关掉，用于确认某次失败到底是 shim 缺件还是真的产品代码问题。
 */
let strict = process.env.DOM_SHIM_LAX !== "1";

function fail(node: FakeNode, member: string): never {
	throw new Error(
		`dom-shim：代码访问了没实现的 DOM 成员 .${member}（<${node.tag}>）——`
		+ `补上它，或 DOM_SHIM_LAX=1 只警告。`,
	);
}

function missing(node: FakeNode, member: string, value: unknown): unknown {
	if (value !== undefined) return value;
	// 那些"是个对象都会问一句"的成员：内建探测、调试器、Error 排版。它们不是产品代码在要 DOM。
	if (IGNORED.has(member)) return value;
	if (strict) fail(node, member);
	return value;
}

/** 内建/工具链自己会读的键，不算"产品代码在要一个 DOM 成员"。 */
const IGNORED = new Set(["then", "constructor", "prototype", "toJSON", "valueOf", "toString", "inspect", "nodeType"]);

// ------------------------------------------------------------------ 记账

/** 与时间无关的"工作量"计数：即使 shim 比浏览器快，它也能证明每帧确实做了 O(n) 的活。 */
export const work = { nodes: 0, appends: 0, qs: 0, qsNodes: 0 };

export function resetWork(): void {
	work.nodes = 0;
	work.appends = 0;
	work.qs = 0;
	work.qsNodes = 0;
}

export function camelToDash(name: string): string {
	return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

// ------------------------------------------------------------------ 最小 DOM

class FakeNode {
	children: FakeNode[] = [];
	parent: FakeNode | undefined;
	className: string;
	readonly tag: string;
	readonly attributes = new Map<string, string>();
	title = "";
	scrollTop = 0;
	scrollLeft = 0;
	scrollHeight = 0;
	/** 显式写进去的尺寸；没写就现读 `style`（见下面的存取器）。 */
	private readonly measured = { width: 0, height: 0 };
	/** 这个节点被构造过几次——`smoke-sidebar.ts` 拿它分辨"原地改"与"重建"。 */
	created = 1;
	/** 每个节点一个独有的 id，与真 DOM 一样。 */
	readonly id: string;
	private static counter = 0;
	/** 真 DOM 的 `open`（`<details>`）；`transcript.ts` 用它决定正文要不要解析。 */
	open = false;
	checked = false;
	disabled = false;
	multiple = false;
	selected = false;
	/** 被从父节点摘下来过，smoke 用它区分"移动"和"重建"。 */
	detached = false;
	private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();
	private _text: string | undefined;
	private _value: string | undefined;
	private _listeners = 0;

	/** `dataset` 是属性表的另一个拼法，真 DOM 就是这样，分开存会让两处读不到一起。 */
	readonly dataset: Record<string, string> = new Proxy({} as Record<string, string>, {
		get: (_target, key: string) => this.attributes.get(`data-${camelToDash(key)}`),
		set: (_target, key: string, value: string) => {
			this.attributes.set(`data-${camelToDash(key)}`, String(value));
			return true;
		},
		has: (_target, key: string) => this.attributes.has(`data-${camelToDash(key)}`),
		deleteProperty: (_target, key: string) => {
			this.attributes.delete(`data-${camelToDash(key)}`);
			return true;
		},
		ownKeys: () => [...this.attributes.keys()].filter((key) => key.startsWith("data-")).map((key) => key.slice(5)),
		getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
	});

	/**
	 * 行内样式。
	 *
	 * 属性袋 + `setProperty` / `removeProperty` / `getPropertyValue`，因为 `main.ts` 与
	 * `branch-view.ts` 两条路都在走：直接写 `style.left`，和写 `--dsw-*` 变量。
	 */
	readonly style: Record<string, unknown> = {
		setProperty: (key: string, value: string) => {
			this.style[key] = value;
		},
		removeProperty: (key: string) => {
			delete this.style[key];
		},
		getPropertyValue: (key: string) => String(this.style[key] ?? ""),
	};

	constructor(tag: string, className?: string, text?: string) {
		this.tag = tag;
		this.className = className ?? "";
		this._text = text;
		FakeNode.counter += 1;
		this.id = `n${FakeNode.counter}`;
		work.nodes += 1;
	}

	get nodeType(): number {
		return this.tag === "#text" ? 3 : 1;
	}
	get tagName(): string {
		return this.tag.toUpperCase();
	}
	get hidden(): boolean {
		return this.attributes.has("hidden");
	}
	set hidden(value: boolean) {
		if (value) this.attributes.set("hidden", "");
		else this.attributes.delete("hidden");
	}
	get value(): string {
		return this._value ?? this.attributes.get("value") ?? "";
	}
	set value(value: string) {
		this._value = String(value);
	}

	/**
	 * `classList`，读写回 `className`。
	 *
	 * 老 shim 在这里改的是一个**副本**：`add("dragging")` 落在一个马上被丢掉的 `Set` 上，
	 * `className` 纹丝不动——于是"拖宽时加类"这类行为在量具里从来没生效过，量出来的东西和产品
	 * 代码其实不是一回事。真 DOM 的 `classList` 是活的，这里必须也是。
	 */
	get classList(): { contains(name: string): boolean; add(...names: string[]): void; remove(...names: string[]): void; toggle(name: string, force?: boolean): boolean } {
		const read = (): Set<string> => new Set(this.className.split(/\s+/).filter(Boolean));
		const write = (names: Set<string>): void => {
			this.className = [...names].join(" ");
		};
		return {
			contains: (name) => read().has(name),
			add: (...names) => {
				const current = read();
				for (const name of names) current.add(name);
				write(current);
			},
			remove: (...names) => {
				const current = read();
				for (const name of names) current.delete(name);
				write(current);
			},
			toggle: (name, force) => {
				const current = read();
				const want = force ?? !current.has(name);
				if (want) current.add(name);
				else current.delete(name);
				write(current);
				return want;
			},
		};
	}

	get textContent(): string {
		if (this.children.length > 0) return this.children.map((child) => child.textContent).join("");
		return this._text ?? "";
	}
	set textContent(value: string) {
		for (const child of this.children) {
			child.parent = undefined;
			child.detached = true;
		}
		this.children.length = 0;
		this._text = value;
	}

	get innerText(): string {
		return this.textContent;
	}
	set innerText(value: string) {
		this.textContent = value;
	}

	get firstChild(): FakeNode | undefined {
		return this.children[0];
	}
	get lastChild(): FakeNode | undefined {
		return this.children[this.children.length - 1];
	}
	get firstElementChild(): FakeNode | undefined {
		return this.children[0];
	}
	get lastElementChild(): FakeNode | undefined {
		return this.children[this.children.length - 1];
	}
	get childElementCount(): number {
		return this.children.length;
	}
	get nextSibling(): FakeNode | undefined {
		if (this.parent === undefined) return undefined;
		const at = this.parent.children.indexOf(this);
		return this.parent.children[at + 1];
	}
	get previousSibling(): FakeNode | undefined {
		if (this.parent === undefined) return undefined;
		const at = this.parent.children.indexOf(this);
		return at <= 0 ? undefined : this.parent.children[at - 1];
	}
	get options(): FakeNode[] {
		return this.children.filter((child) => child.tag === "option");
	}
	/** `select.value` 在真 DOM 里读的是选中项，量具只需要"写进去什么读出来什么"。 */
	get selectedOptions(): FakeNode[] {
		return this.options.filter((option) => option.value === this.value);
	}

	append(...nodes: (FakeNode | string)[]): void {
		for (const value of nodes) {
			// 真 DOM 的 `append("文字")` 会现造一个文本节点；`paintSummary` 这类"一句话中间夹一个 <b>"
			// 的写法全靠它，只收节点会让这种写法在量具里当场崩。
			const node = typeof value === "string" ? textNode(value) : value;
			node.parent?.removeChild(node);
			node.parent = this;
			node.detached = false;
			this._text = undefined;
			this.children.push(node);
		}
		work.appends += nodes.length;
	}
	/** `prepend` 收多个：`sidebar.ensureHeading` 一次放回头行与搜索行。 */
	prepend(...nodes: (FakeNode | string)[]): void {
		for (const value of [...nodes].reverse()) {
			const node = typeof value === "string" ? textNode(value) : value;
			node.parent?.removeChild(node);
			node.parent = this;
			node.detached = false;
			this._text = undefined;
			this.children.unshift(node);
			work.appends += 1;
		}
	}
	replaceChildren(...nodes: (FakeNode | string)[]): void {
		for (const child of this.children) {
			child.detached = true;
			child.parent = undefined;
		}
		this.children.length = 0;
		this._text = undefined;
		this.append(...nodes);
	}
	removeChild(node: FakeNode): void {
		const at = this.children.indexOf(node);
		if (at >= 0) {
			this.children.splice(at, 1);
			node.detached = true;
			node.parent = undefined;
			// 空了就得把旧的 `_text` 忘掉：真 DOM 里 `textContent` 是"当下这些孩子拼起来的字"，
			// 留着一个早就被孩子盖掉、又被摘空的旧串，是这套 shim 自己造出来的第三态。
			if (this.children.length === 0) this._text = undefined;
		}
	}
	remove(): void {
		this.parent?.removeChild(this);
	}
	/**
	 * 真 DOM 的插入语义：已在树上的节点是**移动**，不是先摘再放。
	 *
	 * smoke-sidebar 靠这条把"移动"和"重建"分开：把移动标成 `detached` 会让一次正确的重排看起来像
	 * 重建，断言量的就成了 shim 而不是产品代码。
	 */
	insertBefore(node: FakeNode, reference: FakeNode | null | undefined): void {
		const from = node.parent;
		if (from !== undefined) {
			const at = from.children.indexOf(node);
			if (at >= 0) from.children.splice(at, 1);
		}
		node.parent = this;
		node.detached = false;
		const at = reference === null || reference === undefined ? this.children.length : this.children.indexOf(reference);
		this.children.splice(at < 0 ? this.children.length : at, 0, node);
		work.appends += 1;
	}
	/** 就地换人，`sidebar` 的改名编辑器用它把标题换成输入框再换回来。 */
	replaceWith(...nodes: FakeNode[]): void {
		const parent = this.parent;
		if (parent === undefined) return;
		const at = parent.children.indexOf(this);
		parent.removeChild(this);
		parent.children.splice(at, 0, ...nodes);
		for (const node of nodes) {
			node.parent?.removeChild(node);
			node.parent = parent;
			node.detached = false;
		}
	}
	/** 包含自己，和真 DOM 一样——`ensureHeading` 的 `contains(headRow)` 靠它。 */
	contains(node: FakeNode | null | undefined): boolean {
		if (node === undefined || node === null) return false;
		if (node === this) return true;
		return this.children.some((child) => child.contains(node));
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}
	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}
	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}
	focus(): void {}
	blur(): void {}
	select(): void {}
	click(): void {
		this.dispatch("click");
	}
	setPointerCapture(): void {}
	releasePointerCapture(): void {}
	scrollIntoView(): void {}
	/**
	 * A node's own size: what a test wrote on it, and failing that what its inline style says.
	 *
	 * The fallback is what makes the branch view measurable. The sizer's size is not stored anywhere the
	 * view can read back — it *is* `style.width` / `style.height`, which the paint sets and the graph's
	 * SVG child would in a browser turn into a height. A shim that answered zero there would report a
	 * scroll range of zero and quietly measure nothing.
	 */
	get clientWidth(): number {
		return this.measured.width || this.pixelsOf("width");
	}
	set clientWidth(value: number) {
		this.measured.width = value;
	}
	get clientHeight(): number {
		return this.measured.height || this.pixelsOf("height");
	}
	set clientHeight(value: number) {
		this.measured.height = value;
	}

	private pixelsOf(property: "width" | "height"): number {
		const value = Number.parseFloat(String(this.style[property] ?? ""));
		return Number.isFinite(value) ? value : 0;
	}

	/**
	 * The viewport box: a real box, not a zero one.
	 *
	 * There is no layout here, so a rect can only report what a test put on the node — but zero was a
	 * lie that one caller actually paid for: `branch-view.ts` anchors a zoom at the pointer by
	 * subtracting the viewport's rect from the sizer's, and with both at zero that arithmetic was being
	 * measured against an origin the browser never has. A node with no size set still answers zero,
	 * which is what a hidden node in a browser gives back.
	 */
	getBoundingClientRect(): { left: number; right: number; top: number; bottom: number; width: number; height: number } {
		return { left: 0, right: this.clientWidth, top: 0, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
	}
	/** `closest`：沿父链找选择器命中的第一个祖先（含自己）。 */
	closest(selector: string): FakeNode | null {
		let node: FakeNode | undefined = this;
		while (node !== undefined) {
			if (matches(node, selector)) return node;
			node = node.parent;
		}
		return null;
	}
	matches(selector: string): boolean {
		return matches(this, selector);
	}
	/** 事件记录而不丢弃，量具才能像真点击那样驱动控件。 */
	addEventListener(type: string, handler: (event?: unknown) => void): void {
		if (typeof handler !== "function") return;
		const list = this.listeners.get(type) ?? [];
		list.push(handler);
		this.listeners.set(type, list);
		this._listeners += 1;
	}
	removeEventListener(type: string, handler: (event?: unknown) => void): void {
		const list = this.listeners.get(type);
		if (list === undefined) return;
		const at = list.indexOf(handler);
		if (at >= 0) list.splice(at, 1);
	}
	/** 跑一次这个节点上登记的处理器，等于真事件到达。 */
	dispatch(type: string, event?: unknown): void {
		for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
	}
	/** 这个类型上登记了几个处理器——`transcript.trackScroll()` 之类只登记不触发的调用靠它被发现。 */
	listenerCount(type?: string): number {
		if (type === undefined) return this._listeners;
		return this.listeners.get(type)?.length ?? 0;
	}

	/**
	 * `innerHTML`：只造一个孩子，因为 `dom.ts` 只往里写图标，而 `icon()` 立刻把它读回来。
	 * 一个真的标记解析器在这里买不到任何东西。
	 */
	set innerHTML(_value: string) {
		for (const child of this.children) {
			child.parent = undefined;
			child.detached = true;
		}
		this.children.length = 0;
		const parsed = new FakeNode("svg");
		parsed.parent = this;
		this.children.push(parsed);
		work.nodes += 1;
	}
	get innerHTML(): string {
		return this.textContent;
	}

	/**
	 * `querySelector`：类选择器、属性选择器（可带值），以及它们的合写。
	 *
	 * 找得到返回节点，找不到返回 `null`——`sidebar` 明确用 `!== null` 判断，`undefined` 会让那条
	 * 分支永远走不到。
	 */
	querySelector(selector: string): FakeNode | null {
		work.qs += 1;
		let found: FakeNode | undefined;
		const walk = (node: FakeNode): void => {
			work.qsNodes += 1;
			if (found !== undefined) return;
			if (matches(node, selector)) {
				found = node;
				return;
			}
			for (const child of node.children) walk(child);
		};
		walk(this);
		return found ?? null;
	}
}

/** 一条选择器：`.a.b`、`[attr]`、`[attr="v"]`、`tag`，以及它们的组合。 */
function matches(node: FakeNode, selector: string): boolean {
	const trimmed = selector.trim();
	if (trimmed.length === 0) return false;
	const attributes = [...trimmed.matchAll(/\[([a-zA-Z-]+)(?:=["']([^"']*)["'])?\]/g)];
	const classes = [...trimmed.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((match) => match[1]!);
	const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(trimmed)?.[0];
	// 后代/子选择器不是这套 shim 的活：`transcript` 的 `.turn[data-role="user"]` 是唯一一次
	// 跨层查询，而它上面每层都被 `closest` 往上走了。真遇到不认识的选择器就当场说。
	if (/[\s>+~]/.test(trimmed.replace(/\[[^\]]*\]/g, ""))) {
		throw new Error(`dom-shim：querySelector 不支持组合选择器 ${selector}`);
	}
	if (tag !== undefined && node.tag !== tag.toLowerCase()) return false;
	for (const name of classes) if (!node.classList.contains(name)) return false;
	for (const attribute of attributes) {
		const value = node.getAttribute(attribute[1]!);
		if (value === null) return false;
		if (attribute[2] !== undefined && value !== attribute[2]) return false;
	}
	return tag !== undefined || classes.length > 0 || attributes.length > 0;
}

/**
 * 严格模式的闸门。
 *
 * 读一个**没实现**的成员当场抛。实现过的成员走原型，一次不碰——所以这层代理只在有人越界时才说话。
 *
 * **它只管元素。** `document` 与 `window` 是普通对象，不代理：那里少几个成员通常是"这条路没走到"，
 * 而不是"用错了"。所以量具跑得完，等于**它走过的那条路上**要的元素成员齐了——不等于整棵 DOM 面齐了。
 */
function guard(node: FakeNode): FakeNode {
	return new Proxy(node, {
		get(target, member, receiver) {
			if (member in target) return Reflect.get(target, member, receiver) as unknown;
			return missing(target, String(member), undefined);
		},
	});
}

// ------------------------------------------------------------------ 装配全局

/**
 * `document` 的形状。
 *
 * 它得有个名字：`installDom()` 返回的 `document` 是 `unknown` 时，每个量具的第一行都要自己写一次
 * 断言转换——`smoke-transcript.ts` 就是这么在 `npm run check` 之外活了很久的。这里的每个成员都返回
 * `FakeNode`，量具因此可以直接 `.children` / `.textContent`，不必再穿一层类型。
 */
export interface FakeDocument {
	createElement(tag: string): FakeNode;
	createElementNS(namespace: string, tag: string): FakeNode;
	createTextNode(text: string): FakeNode;
	createDocumentFragment(): FakeNode;
	getElementById(id: string): FakeNode | null;
	querySelector(selector: string): FakeNode | null;
	readonly activeElement: FakeNode | null;
	readonly body: FakeNode;
	readonly documentElement: FakeNode;
	addEventListener(): void;
	removeEventListener(): void;
}

export interface DomShim {
	document: FakeDocument;
	body: FakeNode;
	/** 页面根元素，`applyAppearance` 与两条拖宽都往上写变量。 */
	root: FakeNode;
	/** 窗口，带能被真正派发的监听器（`branch-view.ts` 的 `pointerup` 挂在这里）。 */
	window: FakeWindow;
	/**
	 * 跑掉当前排队的那一批动画帧回调。
	 *
	 * shim 没有帧循环，`requestAnimationFrame` 只能把回调收下来——调用方自己决定什么时候"过一帧"。
	 * 返回这一批实际跑掉的个数，好让调用方知道还有没有下一批（回调里再排一帧就会出现）。
	 */
	frames(): number;
}

/** `installDom()` 装上的窗口：常量、两个计时器，以及可以派发的监听器。 */
export interface FakeWindow {
	addEventListener(type: string, handler: (event?: unknown) => void): void;
	removeEventListener(type: string, handler: (event?: unknown) => void): void;
	dispatch(type: string, event?: unknown): void;
	listenerCount(type?: string): number;
	readonly innerWidth: number;
	readonly innerHeight: number;
	readonly location: { href: string; protocol: string; host: string; origin: string };
	readonly desktop: unknown;
}

export interface InstallOptions {
	/** 覆盖严格模式；不传就用 `DOM_SHIM_LAX` 的默认。 */
	strict?: boolean;
	/** 视口尺寸，菜单的钳位读它。 */
	viewport?: { width: number; height: number };
}

/** 一个文本节点：`markdown.ts` 的 inline 渲染与 `diff.ts` 的行都往元素里塞它。 */
function textNode(text: string): FakeNode {
	return new FakeNode("#text", "", text);
}

/**
 * `Element` 与 `HTMLElement`，**导出**给量具用。
 *
 * 产品代码里 `branch-view.ts` 用一个 `event.target instanceof Element` 决定一次 window 级
 * `pointerup` 算不算点中了卡片。shim 的节点不是这两个类的实例就没有意义，所以量具造事件目标时
 * 必须拿得到它们——藏在这里会让每个量具自己 `as unknown as Element` 硬转，而那正是 shim 不该
 * 逼出来的写法。
 */
export class FakeElement {}
export class FakeHTMLElement extends FakeElement {}

/**
 * 装上一整套最小 DOM。
 *
 * `Element` / `HTMLElement` 是**空类**：`transcript.ts:76` 与 `branch-view.ts:146` 的
 * `event.target instanceof Element` 在量具里应当为假——量具直接调用控制器方法，不走事件的
 * `target`——但真代码里那些判断必须有个类可比，缺了它会 `ReferenceError`。量具要造一个**真的会
 * 被当成卡片**的事件目标时，用下面导出的这两个类包一层。
 *
 * 有一条边界值得写在这里：`getComputedStyle` **不解析 `calc()`**，它只是一张名字到值的表。产品代码
 * 量一个 `calc()` 令牌的方式因此必须是量元素的盒子（`branch-view.ts` 的探针），而不是 `parseFloat`
 * 那个令牌串——真浏览器把未注册的自定义属性算回来时 `calc()` 还在，`parseFloat` 得到 `NaN`。
 */
export function installDom(options: InstallOptions = {}): DomShim {
	if (options.strict !== undefined) strict = options.strict;
	const g = globalThis as unknown as Record<string, unknown>;

	const root = guard(new FakeNode("html"));
	const body = guard(new FakeNode("body"));
	const app = guard(new FakeNode("div", "", undefined));
	app.setAttribute("id", "app");
	root.append(body);
	body.append(app);

	const createElement = (tag: string): FakeNode => guard(new FakeNode(tag));

	/**
	 * 按 `id` 找节点：从页面根往下走，**不是**从一张"创建过的节点"表里查。
	 *
	 * 那张表看着方便，其实是把整棵被丢弃的 DOM 钉死在堆上——切换会话场景每换一条会话就丢掉一整棵
	 * 500 turn 的树，12 次之后 Node 的 4 GB 堆就满了（实测 `FATAL ERROR: Ineffective mark-compacts`）。
	 * 真 DOM 里被摘掉的节点是可以回收的，这里也必须能。
	 */
	const byId = (id: string): FakeNode | null => {
		let found: FakeNode | null = null;
		const walk = (node: FakeNode): void => {
			if (found !== null) return;
			if (node.id === id) {
				found = node;
				return;
			}
			for (const child of node.children) walk(child);
		};
		walk(root);
		return found;
	};

	const document: FakeDocument = {
		createElement,
		// SVG 元素在 shim 里就是一个普通元素：`branch-view.ts` 造出来的那些只用 `setAttribute`，
		// 而属性表本来就与标签名无关。
		createElementNS: (_namespace: string, tag: string): FakeNode => createElement(tag),
		createTextNode: (text: string): FakeNode => guard(textNode(text)),
		createDocumentFragment: () => guard(new FakeNode("#fragment")),
		getElementById: byId,
		querySelector: (selector: string) => root.querySelector(selector),
		get activeElement(): FakeNode | null {
			return null;
		},
		get body(): FakeNode {
			return body;
		},
		get documentElement(): FakeNode {
			return root;
		},
		addEventListener: () => {},
		removeEventListener: () => {},
	};

	/**
	 * 排队的动画帧回调，按挂号顺序。
	 *
	 * 生产代码里唯一用它的是 `drain.ts`——一帧一小批地把整棵 transcript 画出来。shim 不自己跑它，
	 * 因为"一帧"在量具里是调用方说了算；缺了这一层，`requestAnimationFrame` 收下回调就扔，量具会
	 * 静默地只画出第一批，而那正是量具曾经废掉一次的形状。
	 */
	const frameHandles = new Map<number, (time: number) => void>();
	let frameHandle = 0;

	/**
	 * The window, with events that can actually be delivered.
	 *
	 * `branch-view.ts` attaches its `pointerup` to the window rather than to its own viewport — the
	 * release of a pan can land anywhere, so the decision "this was a click" belongs to the window —
	 * and that listener is where selecting a node lives. A no-op `addEventListener` here would make the
	 * one interaction the page exists for untestable, so the window keeps handlers and dispatches them
	 * like a node does.
	 */
	const windowListeners = new Map<string, ((event?: unknown) => void)[]>();

	const windowObject = {
		matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
		addEventListener: (type: string, handler: (event?: unknown) => void): void => {
			if (typeof handler !== "function") return;
			windowListeners.set(type, [...(windowListeners.get(type) ?? []), handler]);
		},
		removeEventListener: (type: string, handler: (event?: unknown) => void): void => {
			const list = windowListeners.get(type);
			if (list === undefined) return;
			const at = list.indexOf(handler);
			if (at >= 0) list.splice(at, 1);
		},
		/** Deliver one window-level event, the way `FakeNode.dispatch` delivers a node's. */
		dispatch(type: string, event?: unknown): void {
			for (const handler of [...(windowListeners.get(type) ?? [])]) handler(event);
		},
		listenerCount(type?: string): number {
			if (type === undefined) return [...windowListeners.values()].reduce((total, list) => total + list.length, 0);
			return windowListeners.get(type)?.length ?? 0;
		},
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		innerWidth: options.viewport?.width ?? 1280,
		innerHeight: options.viewport?.height ?? 800,
		setTimeout: () => 0,
		clearTimeout: () => {},
		requestAnimationFrame: (callback: (time: number) => void): number => {
			frameHandle += 1;
			frameHandles.set(frameHandle, callback);
			return frameHandle;
		},
		cancelAnimationFrame: (handle: number): void => {
			frameHandles.delete(handle);
		},
		location: { href: "http://127.0.0.1:0/", protocol: "http:", host: "127.0.0.1:0", origin: "http://127.0.0.1:0" },
		desktop: undefined,
	};

	/** 一"帧"：把挂号的那批取出来跑，回调里再挂的算下一帧。 */
	const frames = (): number => {
		const batch = [...frameHandles.values()];
		frameHandles.clear();
		for (const callback of batch) callback(Date.now());
		return batch.length;
	};

	g.document = document;
	g.window = windowObject;
	// 生产代码直接调全局的这两个（`drain.ts`），不是 `window.requestAnimationFrame`。
	g.requestAnimationFrame = windowObject.requestAnimationFrame;
	g.cancelAnimationFrame = windowObject.cancelAnimationFrame;
	g.Element = FakeElement;
	g.HTMLElement = FakeHTMLElement;
	g.Node = FakeElement;
	g.SVGElement = FakeElement;
	g.Comment = FakeElement;
	g.DocumentFragment = FakeElement;
	g.getComputedStyle = () => ({ getPropertyValue: () => "" });
	g.ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	};
	g.matchMedia = windowObject.matchMedia;
	// Node 22 起 `navigator` 是只读的全局，只能用 defineProperty 盖。
	Object.defineProperty(g, "navigator", {
		value: { clipboard: { writeText: () => Promise.resolve() }, userAgent: "dom-shim" },
		configurable: true,
		writable: true,
	});

	return { document, body, root, window: windowObject, frames };
}

/**
 * Hand a shim node to code that is typed against the real DOM.
 *
 * The one bridge between the two types, and it exists because the views are typed against
 * `HTMLElement` — that is what they run on in the browser — while the shim implements the members they
 * actually call. Every caller is a harness, so the gap between the two types is never what is under
 * test; keeping the cast here means there is one place to look when it finally bites.
 */
export function asElement(node: FakeNode): HTMLElement {
	return node as unknown as HTMLElement;
}

/**
 * `FakeNode` 是**值**导出，不只是类型：量具要能改它的 `getBoundingClientRect`，好回答"布局会给这个
 * 元素多大的盒子"。量具没有布局引擎，而产品代码（`branch-view.ts` 的几何探针）问的正是盒子——所以
 * 这里留一个原型方法可以顶替，而不是给 `InstallOptions` 再开一张表。
 */
export { FakeNode };
