import { element } from "../dom.ts";
import type { UsageTotals } from "@my-agent/core/protocol";

export interface StatusState {
	usage: UsageTotals;
}

/**
 * composer 下面的一行。
 *
 * 它恰好携带三个数字，全是这个会话花掉的 token：会话总计、整个会话里 provider 由自己缓存服务的
 * 提示占比、模型上下文窗口有多满。三个都是扫一眼就读的，且都不是控件，所以它们坐在 composer
 * 下面而不是阅读对话的头部里。
 *
 * 三个无条件绘制。过去服务端不应答时这一行会清空它们，理由是过时的百分比比没有更糟 —— 但
 * token 计数不是关于服务端的声明，它是本窗口最后一次看到这个会话做的事，清掉它是为了不显示
 * 过时的东西而丢掉一个真实的事实。死通道是另一个事实，由侧栏的连接指示器单独报告，那里不需要
 * 窗口忘掉它所知道的。
 */
export class StatusBar {
	readonly element: HTMLElement;
	private readonly total: HTMLElement;
	private readonly cache: HTMLElement;
	private readonly context: HTMLElement;
	private readonly meterFill: HTMLElement;

	constructor() {
		this.element = element("div", "status-bar");
		this.total = element("span", "status-stat");
		this.cache = element("span", "status-stat");
		this.context = element("span", "status-stat");
		this.meterFill = element("span", "status-meter-fill");
		const meter = element("span", "status-meter");
		meter.append(this.meterFill);
		// 上下文读数和它的条是一组，因为条只关于那个数字：它坐在自己度量的数字右侧。另外两个读数
		// 各占一席，这一行从左到右分成三等份：总计、缓存、上下文。
		const group = element("span", "status-group");
		group.append(this.context, meter);
		this.element.append(this.total, this.cache, group);
	}

	render(state: StatusState): void {
		this.element.dataset.state = "up";

		const usage = state.usage;
		const total = totalTokens(usage);
		this.total.textContent = total > 0 ? `total ${formatTokens(total)}` : "total —";
		this.total.title =
			total > 0
				? `${formatTokens(usage.input)} fresh input, ${formatTokens(usage.cacheRead)} read from cache, ` +
					`${formatTokens(usage.cacheWrite)} written, ${formatTokens(usage.output)} output`
				: "no request has been made yet";

		const hit = cacheHitRate(usage);
		// 这个席位读的是**会话的总计**，不是单次请求。按请求的读数会随每个回合的形状来回摆 ——
		// 每个携带大块新内容（工具结果、文件读取）的请求按定义几乎全是新鲜 token，所以数字摆动，
		// 而对话其实被缓存得很好 —— 看着这一行的人想知道的是这段对话的缓存是否正常工作，这正是
		// 终身比率回答的问题。按请求的数字留在总计席位的 tooltip 里，账单在那里。
		this.cache.textContent = hit === undefined ? "cache —" : `cache ${Math.round(hit * 100)}%`;
		this.cache.title =
			hit === undefined
				? "no request has been made yet"
				: `${Math.round(hit * 100)}% of the session's ${formatTokens(promptTokens(usage))} prompt tokens ` +
					`came from the provider's cache — ${formatTokens(usage.cacheRead)} read, ` +
					`${formatTokens(usage.input)} fresh, ${formatTokens(usage.cacheWrite)} written`;

		const percent = usage.contextWindow > 0 ? Math.min(100, (usage.contextTokens / usage.contextWindow) * 100) : 0;
		this.context.textContent =
			usage.contextWindow > 0 ? `context ${Math.round(percent)}%` : "context —";
		this.context.title =
			usage.contextWindow > 0
				? `${formatTokens(usage.contextTokens)} of ${formatTokens(usage.contextWindow)} tokens`
				: "no request has been made yet";
		this.meterFill.style.width = `${percent.toFixed(1)}%`;
		this.element.classList.toggle("warn", percent > 75);
	}
}

/**
 * 会话进进出出花掉的每个 token。
 *
 * 提示只计一次，无论 provider 怎么计费：从缓存读出的 token 和新的一样花在了请求上，不计它会让
 * 总计与账单对不上。
 */
function totalTokens(usage: UsageTotals): number {
	return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

/**
 * 会话的提示里 provider 不必重读的占比。
 *
 * 对会话的每个请求求和，且对整个提示而不是只对新鲜 token："96% 缓存"应该意味着请求几乎免费，
 * 而一个可能超过 100% 的比率说不出这一点。
 */
function cacheHitRate(usage: UsageTotals): number | undefined {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	return prompt > 0 ? usage.cacheRead / prompt : undefined;
}

/** 会话的提示，按 provider 计费的方式计数。 */
function promptTokens(usage: UsageTotals): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}
