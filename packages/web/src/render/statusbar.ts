import { element } from "../dom.ts";
import type { UsageTotals } from "@my-agent/core/protocol";
import type { MessageUsage } from "../state.ts";

export interface StatusState {
	usage: UsageTotals;
	/** The usage of the most recent request, which is what the cache seat reads. */
	last?: MessageUsage;
}

/**
 * The line under the composer.
 *
 * It carries exactly three numbers, all of them about the tokens this session has spent: the session's
 * total, how much of its prompt the provider served from its own cache, and how full the model's
 * context window is. All three are read at a glance and none is a control, which is why they sit below
 * the composer rather than in the header the conversation is read from.
 *
 * The three are drawn unconditionally. The line used to blank them whenever the server was not
 * answering, on the reasoning that a stale percentage is worse than no percentage — but a token count
 * is not a claim about the server, it is the last thing this window saw the session do, and clearing
 * it throws away a true fact to avoid showing a stale one. A dead channel is a different fact and it
 * is reported separately, by the sidebar's connection indicator, where it can be seen without the
 * window being asked to forget what it knows.
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
		// The context reading and its bar are one group, because the bar is about that figure and
		// nothing else: it sits to the right of the number it measures. The other two readings take a
		// seat each, so the line divides into three equal parts, left to right: total, cache, context.
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
		const cached = state.last?.cacheRead;
		// The seat reads **this request**, not the session's average. A lifetime average of hit rates
		// is the wrong shape for the thing it is asked to describe: every request that carries a big
		// new block (a tool result, a file read) is mostly fresh by definition, so the average saws
		// between 83% and 90% while the conversation is in fact being cached perfectly well. The
		// cached prefix, on the other hand, only ever grows (`.scratch/branch-line-and-smoothness/
		// issues/02-cache-reading.md` measured 18 real requests: miss ≈ growth, every time).
		this.cache.textContent = cached === undefined ? "cache —" : `cache ${formatTokens(cached)}`;
		this.cache.title =
			state.last === undefined
				? "no request has been made yet"
				: `${formatTokens(state.last.cacheRead)} of this request's ${formatTokens(promptTokens(state.last))} prompt ` +
					`tokens came from the provider's cache (${formatTokens(state.last.input)} fresh, ` +
					`${formatTokens(state.last.cacheWrite)} written)` +
					(hit === undefined ? "" : ` · session average ${Math.round(hit * 100)}%`);

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
 * Every token the session has spent, in and out.
 *
 * The prompt is counted once, whichever way the provider billed it: a token read from cache was spent
 * on the request just the same as a fresh one, and leaving it out would make the total disagree with
 * the bill.
 */
function totalTokens(usage: UsageTotals): number {
	return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

/**
 * How much of the prompt the provider did not have to re-read.
 *
 * Against the whole prompt rather than against the fresh tokens alone: "96% cached" should mean the
 * request was almost free, and a ratio that could exceed 100% would not say that.
 */
function cacheHitRate(usage: UsageTotals): number | undefined {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	return prompt > 0 ? usage.cacheRead / prompt : undefined;
}

/** One request's prompt, counted the way the provider bills it. */
function promptTokens(usage: MessageUsage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}
