import { element, icon } from "./dom.ts";
import { openMenu } from "./render/menu.ts";
import type { ModelOption, PromptBehavior, QueuedPrompt } from "@my-agent/core/protocol";

export interface ComposerHandlers {
	onSubmit(text: string, behavior: PromptBehavior): void;
	onAbort(): void;
	onSelectModel(ref: string): void;
	onSelectLevel(level: string): void;
	/**
	 * 在模式按钮上方打开模式菜单。菜单的行由窗口来构建 —— 存在哪些模式、哪个开着，都是 composer
	 * 不持有的状态 —— 所以这里只交出锚点，别无其他。
	 */
	onModes(anchor: HTMLElement): void;
	/** 对本窗口所在的会话应用一个模式：其工具集与审批表，整体生效。 */
	onSelectMode(name: string): void;
}

/** 模型席位：哪一行应答，以及要求它多用力思考。 */
export interface ComposerSelection {
	models: readonly ModelOption[];
	/**
	 * 屏幕上的 ref，它可能指向 `models` 中已不存在的一行 —— 或者在尚未选择任何东西时为空字符串，
	 * 即没有打开会话的窗口所处的状态。
	 */
	model: string;
	levels: readonly string[];
	level: string;
}

/**
 * 模型席位的标签：行的名字，或它不指名任何一行的原因。
 *
 * 有三种处在列表之外的情形，只有其中一种是损失：什么都没配置、什么都还没选（空名字 —— 席位是
 * 下一段对话开始的地方）、以及名字所指的行已不在。只有最后一种说出了丢了什么。
 */
function modelLabel(selection: ComposerSelection): string {
	const modelOption = selection.models.find((model) => model.name === selection.model);
	if (modelOption !== undefined) return modelOption.name;
	if (selection.models.length === 0) return "未配置模型";
	if (selection.model.length === 0) return "选择模型";
	return `${selection.model}（已丢失）`;
}

/**
 * 输入框。
 *
 * Enter 发送，Shift+Enter 换行，Escape 中止本轮运行。agent 工作时提交会被接受而非拒绝：普通
 * Enter 排队一个等运行停止的后续消息，Ctrl/Cmd+Enter 则是插话（steer）。排队中的提示是会话自己的，
 * 由 {@link setQueue} 画在输入条上方 —— 队列本身，即服务端最后一次发布的版本。
 *
 * 输入框随内容增长，直到上限。提示常常有好几行 —— 一段堆栈、一个文件列表 —— 一个两行后就开始
 * 滚动的框会藏住正在写的东西。
 *
 * 没有提示行也没有占位符：输入条过去带着的两行说明，是读者早已学会的多余装饰（01 ④）；为模型
 * 命名的席位坐在输入条右端，理由与它坐在输入条上相同 —— 哪个模型应答、要求它多用力思考，都是
 * 按对话选择的，且经常在一段对话内改变。这两半在消息发出之前都由窗口持有 —— 在那之前这里没有
 * 任何东西到达服务端 —— 所以席位从 {@link setSelection} 绘制，它的变更以普通选择的形式上报。
 *
 * 输入条的三个选择器 —— 模式、模型、档位 —— 是同一样东西：一个在自己上方打开窗口菜单的 chip。
 * 它们过去是原生 `select`，模型和档位是窗口里最后两个原生控件，但原生弹窗由平台而不是主题绘制：
 * 在深色窗口上它是一块亮色矩形。每次都会被看到的席位，是最不该出现脱离主题控件的地方，所以它们
 * 穿上了目录选择器已有的菜单。三者都向上打开，因为输入条贴着窗口下边缘，挂在下面的菜单将无处
 * 安放。
 */
export class Composer {
	readonly element: HTMLFormElement;
	private readonly textarea: HTMLTextAreaElement;
	private readonly send: HTMLButtonElement;
	private readonly stop: HTMLButtonElement;
	private readonly queue: HTMLDivElement;
	private readonly modeButton: HTMLButtonElement;
	private readonly modeLabel: HTMLSpanElement;
	private readonly modelButton: HTMLButtonElement;
	private readonly modelLabelText: HTMLSpanElement;
	private readonly levelButton: HTMLButtonElement;
	private readonly levelLabelText: HTMLSpanElement;
	/** 两个菜单的构建来源：屏幕上的选项，截至上一次绘制。 */
	private selection: ComposerSelection = { models: [], model: "", levels: [], level: "" };
	private modelSignature = "";
	private levelSignature = "";
	/** 标签最后一次绘制所依据的模式名；与模型、档位的签名一样是一道门。 */
	private modeSignature: string | undefined;
	private streaming = false;
	private disabled = false;

	constructor(handlers: ComposerHandlers) {
		this.element = element("form", "composer");

		this.textarea = element("textarea", undefined, undefined, {
			rows: 1,
			spellcheck: false,
			"aria-label": "消息",
		});

		const bar = element("div", "composer-bar");
		this.queue = element("div", "composer-queue");
		this.queue.hidden = true;

		// 模式席位位于输入条左端：会话运行在哪套工具与审批预设上，是工作中选择、扫一眼就读的东西，
		// 而输入条左端正是这类控件所在。它是那里唯一的席位 —— 会话的工具与审批只能通过选模式设置，
		// 所以不存在可能与屏幕上那扇门不一致的第二扇门。菜单本身经 handler 打开 —— 行由窗口用它
		// 自己的状态来构建。
		this.modeButton = element("button", "composer-mode", undefined, {
			type: "button",
			"aria-haspopup": "menu",
			title: "模式：工具与审批的预设",
		});
		this.modeLabel = element("span", "composer-mode-label", "默认");
		this.modeButton.append(icon("sliders"), this.modeLabel, icon("chevron"));
		this.modeButton.addEventListener("click", () => handlers.onModes(this.modeButton));

		// 模型席位：模式席位语法里的两个 chip —— 一个标签和一个 chevron —— 各自在自己上方打开
		// 窗口的菜单。它们是按钮而不是原生 select，因为打开的菜单由本窗口的 token 绘制；见类注释。
		this.modelButton = element("button", "composer-pick", undefined, {
			type: "button",
			"aria-haspopup": "menu",
			"aria-label": "模型",
		});
		this.modelLabelText = element("span", "composer-pick-label");
		this.modelButton.append(this.modelLabelText, icon("chevron"));
		this.modelButton.addEventListener("click", () => {
			const { models, model } = this.selection;
			openMenu(
				this.modelButton,
				models.map((row) => ({
					label: row.name,
					active: row.name === model,
					onSelect: () => handlers.onSelectModel(row.name),
				})),
				{ placement: "above", align: "end" },
			);
		});

		this.levelButton = element("button", "composer-pick", undefined, {
			type: "button",
			"aria-haspopup": "menu",
			"aria-label": "思考档位",
		});
		this.levelLabelText = element("span", "composer-pick-label");
		this.levelButton.append(this.levelLabelText, icon("chevron"));
		this.levelButton.addEventListener("click", () => {
			const { levels, level } = this.selection;
			openMenu(
				this.levelButton,
				levels.map((name) => ({
					label: name,
					active: name === level,
					onSelect: () => handlers.onSelectLevel(name),
				})),
				{ placement: "above", align: "end" },
			);
		});

		// 模型席位守住输入条右端，紧挨发送按钮左侧。模式席位是输入条左端；没有别的控件在那里打头。
		const seat = element("div", "composer-seat");
		seat.append(this.modelButton, this.levelButton);

		this.stop = element("button", "button danger", undefined, { type: "button", hidden: true });
		this.stop.append(icon("stop"), element("span", undefined, "停止"));
		this.stop.addEventListener("click", () => handlers.onAbort());

		this.send = element("button", "button primary", undefined, { type: "submit" });
		this.send.append(element("span", undefined, "发送"), icon("send"));

		bar.append(this.modeButton, seat, this.stop, this.send);
		this.element.append(this.textarea, this.queue, bar);

		this.element.addEventListener("submit", (event) => {
			event.preventDefault();
			this.submit(handlers, "followUp");
		});

		this.textarea.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
			// 两种情形都是空闲：会话开启一次运行而不是排队。这个区分只在流式进行中才有意义，
			// Ctrl/Cmd+Enter 正是在那时插话。
				this.submit(handlers, this.streaming && (event.ctrlKey || event.metaKey) ? "steer" : "followUp");
				return;
			}
			if (event.key === "Escape" && this.streaming) {
				event.preventDefault();
				handlers.onAbort();
			}
		});

		this.textarea.addEventListener("input", () => this.resize());
	}

	focus(): void {
		this.textarea.focus();
	}

	/** 把文本放回输入框，给一条消费了文本却失败了的命令。 */
	setDraft(text: string): void {
		this.textarea.value = text;
		this.resize();
	}

	draft(): string {
		return this.textarea.value;
	}

	setStreaming(streaming: boolean): void {
		this.streaming = streaming;
		this.stop.hidden = !streaming;
		this.send.firstElementChild!.textContent = streaming ? "排队" : "发送";
		this.syncDisabled();
	}

	/**
	 * 绘制排队中的提示，每条一行，安静地。
	 *
	 * 列表是服务端最后一次发布的内容，不是本地回显：每次队列变更都整体替换，所以一条消息被排干
	 * 的时刻正是服务端说它被排干的时刻。文本是发送者写下的第一行 —— 一行只是点名这条消息，而不是
	 * 复述它。
	 */
	setQueue(queued: readonly QueuedPrompt[]): void {
		this.queue.hidden = queued.length === 0;
		this.queue.replaceChildren(
			...queued.map((prompt) => {
				const row = element("div", "composer-queue-row");
				row.append(element("span", "composer-queue-tag", "排队"), element("span", "composer-queue-text", firstLine(prompt.text)));
				return row;
			}),
		);
	}

	/**
	 * 绘制模型席位。
	 *
	 * 只有标签所指的东西移动了才重写标签，于是一次普通的重渲染 —— 每个 token 都会发生 —— 不会
	 * 关掉用户正打开的菜单，也不会在选择中途丢掉值。菜单本身在打开时才从 {@link selection} 构建，
	 * 出于同样的原因：用过期列表构建的菜单，会列出席位已不再同意的选项。
	 *
	 * 会话自己的 ref 永远被计入：行可能被删除、对什么都没配置的会话而言从未存在过、或者根本还没选
	 * —— 席位必须显示选择实际所处的位置，而不是默默附和一份不再提到它的列表。
	 */
	setSelection(selection: ComposerSelection): void {
		this.selection = selection;

		const modelSignature = `${selection.model}\n${selection.models.map((row) => row.name).join("\n")}`;
		if (modelSignature !== this.modelSignature) {
			this.modelSignature = modelSignature;
			const label = modelLabel(selection);
			this.modelLabelText.textContent = label;
			// chip 只有一行，所以放不下的长名在屏幕上被截短 —— tooltip 是它保持完整的地方。
			this.modelButton.title = label;
			this.modelButton.disabled = selection.models.length === 0;
		}

		const levelSignature = `${selection.level}\n${selection.levels.join(",")}`;
		if (levelSignature !== this.levelSignature) {
			this.levelSignature = levelSignature;
			this.levelLabelText.textContent = selection.level.length === 0 ? "思考档位" : selection.level;
		}
		// 只有一个档位不算选择：不能思考的模型没有可在其间挑选的东西。
		this.levelButton.hidden = selection.levels.length <= 1;
	}

	/**
	 * 绘制模式席位的标签。
	 *
	 * 名字是按钮唯一持有的东西：存在哪些预设、预设里有什么，属于每次打开时重建的菜单。一个不匹配
	 * 的会话 —— 其工具与审批没有哪个模式指名，通常是模式被编辑后留下的 —— 显示「自定义」，而不是
	 * 假装它还停留在已经离开的预设上。
	 */
	setModes(current: string | undefined): void {
		const label = current ?? "自定义";
		if (label === this.modeSignature) return;
		this.modeSignature = label;
		this.modeLabel.textContent = label;
	}

	setDisabled(disabled: boolean): void {
		this.disabled = disabled;
		this.syncDisabled();
	}

	private syncDisabled(): void {
		this.textarea.disabled = this.disabled;
		this.send.disabled = this.disabled;
	}

	/** 长到装下内容为止，到达样式表的上限后滚动。 */
	private resize(): void {
		this.textarea.style.height = "auto";
		this.textarea.style.height = `${this.textarea.scrollHeight}px`;
	}

	private submit(handlers: ComposerHandlers, behavior: PromptBehavior): void {
		const text = this.textarea.value.trim();
		if (text.length === 0 || this.disabled) return;
		this.textarea.value = "";
		this.resize();
		handlers.onSubmit(text, behavior);
	}
}

/** 消息的第一个非空行，一行排队提示只有这么多空间。 */
function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return "";
}
