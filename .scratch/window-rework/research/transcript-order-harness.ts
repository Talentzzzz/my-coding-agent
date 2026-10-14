// Scratch verification for issue 05 / defect 2: does the transcript draw an item that lands at the
// *head* of `items` in the right place, or does it always append to the end?
//
// The report is "compaction, then another baseline" — a reconnect or a re-open that replays the
// session with the compaction summary now first. This drives the production `TranscriptView` against
// a minimal DOM host (the same shim trick scripts/smoke-sidebar.ts uses) and prints the container's
// child order after each render. Nothing reaches the network.
//
// Run with: node .scratch/window-rework/research/transcript-order-harness.ts

import { TranscriptView } from "../../../packages/web/src/render/transcript.ts";
import type { Item } from "../../../packages/web/src/state.ts";

// --------------------------------------------------------------------- a tiny DOM

class FakeNode {
	readonly children: FakeNode[] = [];
	parent: FakeNode | undefined;
	textContent: string | undefined;
	className: string;
	readonly tag: string;
	readonly attributes = new Map<string, string>();
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
	});
	readonly style: Record<string, unknown> & { setProperty(key: string, value: string): void; removeProperty(key: string): void } =
		Object.assign(Object.create(null) as Record<string, unknown>, {
			setProperty(_key: string, _value: string): void {},
			removeProperty(_key: string): void {},
		});
	title = "";
	hidden = false;
	disabled = false;
	scrollTop = 0;
	scrollHeight = 0;
	clientHeight = 0;

	constructor(tag: string, className?: string, text?: string) {
		this.tag = tag;
		this.className = className ?? "";
		this.textContent = text;
	}

	get classList(): { contains(name: string): boolean; add(name: string): void; remove(name: string): void; toggle(name: string, force?: boolean): void } {
		const self = this;
		return {
			contains: (name) => self.className.split(/\s+/).includes(name),
			add: (name) => {
				if (!self.className.split(/\s+/).includes(name)) self.className = `${self.className} ${name}`.trim();
			},
			remove: (name) => {
				self.className = self.className.split(/\s+/).filter((part) => part !== name).join(" ");
			},
			toggle: (name, force) => {
				const on = force ?? !self.classList.contains(name);
				if (on) self.classList.add(name);
				else self.classList.remove(name);
			},
		};
	}

	get firstChild(): FakeNode | undefined { return this.children[0]; }
	get firstElementChild(): FakeNode | undefined { return this.children[0]; }
	get lastElementChild(): FakeNode | undefined { return this.children[this.children.length - 1]; }
	get nextSibling(): FakeNode | undefined {
		if (this.parent === undefined) return undefined;
		const at = this.parent.children.indexOf(this);
		return this.parent.children[at + 1];
	}

	append(...nodes: FakeNode[]): void {
		for (const node of nodes) {
			node.parent?.removeChild(node);
			node.parent = this;
			this.children.push(node);
		}
	}
	prepend(node: FakeNode): void { this.insertBefore(node, this.children[0] ?? null); }
	replaceChildren(...nodes: FakeNode[]): void {
		for (const child of this.children) child.parent = undefined;
		this.children.length = 0;
		this.append(...nodes);
	}
	removeChild(node: FakeNode): void {
		const at = this.children.indexOf(node);
		if (at >= 0) { this.children.splice(at, 1); node.parent = undefined; }
	}
	remove(): void { this.parent?.removeChild(this); }
	insertBefore(node: FakeNode, reference: FakeNode | null): void {
		const from = node.parent;
		if (from !== undefined) {
			const at = from.children.indexOf(node);
			if (at >= 0) from.children.splice(at, 1);
		}
		node.parent = this;
		const at = reference === null ? this.children.length : this.children.indexOf(reference);
		this.children.splice(at < 0 ? this.children.length : at, 0, node);
	}
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }
	getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
	addEventListener(): void {}
	set innerHTML(_value: string) {
		this.children.length = 0;
		const parsed = new FakeNode("svg");
		parsed.parent = this;
		this.children.push(parsed);
	}
	querySelector(selector: string): FakeNode | undefined {
		const wantedClass = selector.startsWith(".") ? selector.slice(1) : undefined;
		const wantedAttr = selector.match(/^\[([a-z-]+)="([^"]*)"\]$/);
		let found: FakeNode | undefined;
		const walk = (node: FakeNode): void => {
			if (found !== undefined) return;
			const hit = wantedClass !== undefined
				? node.classList.contains(wantedClass)
				: node.getAttribute(wantedAttr?.[1] ?? "") === wantedAttr?.[2];
			if (hit) { found = node; return; }
			for (const child of node.children) walk(child);
		};
		walk(this);
		return found;
	}
}

function camelToDash(name: string): string {
	return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

const g = globalThis as unknown as Record<string, unknown>;
g.document = {
	createElement: (tag: string) => new FakeNode(tag),
	createTextNode: (text: string) => new FakeNode("#text", undefined, text),
	getElementById: () => null,
};
g.window = { matchMedia: () => ({ matches: false }), setTimeout: () => 0 };

// ------------------------------------------------------------------- the check

function message(id: string, role: string, text: string, notice = false): Item {
	return { kind: "message", id, role, text, notice, streaming: false };
}

const container = new FakeNode("div", "transcript");
const view = new TranscriptView(container as unknown as HTMLElement, { onFork: () => {}, onBranch: () => {} });

function order(): string[] {
	return container.children.map((child) => child.className.split(" ")[0] ?? child.tag);
}

/** The text under a node, so two turns that share a class can still be told apart. */
function textOf(node: FakeNode): string {
	if (node.children.length === 0) return node.textContent ?? "";
	return node.children.map(textOf).join("");
}

let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

const user = message("user:1", "user", "第一条");
const assistant = message("assistant:2", "assistant", "回答");
const summary = message("compactionSummary:3", "compactionSummary", "被折叠的历史", true);

// First draw: a normal conversation.
view.render([user, assistant], false);
process.stdout.write(`after first render:  ${order().join(", ")}\n`);
check("first render keeps the order", order().join(",") === "turn,turn", JSON.stringify(order()));

// Second draw: the compaction summary now sits at the *head*, the same way a replayed baseline would
// hand it over. `user` and `assistant` already have nodes; only `summary` is new.
view.render([summary, user, assistant], false);
process.stdout.write(`after baseline+summary: ${order().join(", ")}\n`);

const sections = container.children;
const summaryFirst = sections[0]?.className.includes("notice") === true;
check("the summary is drawn first, not last", summaryFirst, JSON.stringify(sections.map((s) => s.className)));

// Third draw: a mid-sequence insert. A message is edited/inserted between the user and the answer.
const inserted = message("assistant:2b", "assistant", "插在中间");
view.render([summary, user, inserted, assistant], false);
process.stdout.write(`after mid insert:    ${order().join(", ")}\n`);
// Both assistant turns share a class, so the mid-insert is told apart by the text it carries.
const texts = container.children.map((child) => textOf(child));
check(
	"a mid-sequence item lands in the middle",
	container.children.length === 4 &&
		texts[0]?.includes("被折叠的历史") === true &&
		texts[1]?.includes("第一条") === true &&
		texts[2]?.includes("插在中间") === true &&
		texts[3]?.includes("回答") === true,
	JSON.stringify(texts),
);

process.stdout.write(failures === 0 ? "\ntranscript order ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
