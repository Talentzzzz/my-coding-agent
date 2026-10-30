import { element } from "../dom.ts";
import type { UsageTotals } from "@my-agent/core/protocol";

export interface StatusState {
	usage: UsageTotals;
}

/**
 * The line under the composer.
 *
 * It carries exactly three numbers, all of them about the tokens this session has spent: the session's
 * total, what share of its prompts the provider served from its own cache over the whole session, and
 * how full the model's context window is. All three are read at a glance and none is a control, which
 * is why they sit below the composer rather than in the header the conversation is read from.
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
		// The seat reads the **session's totals**, not one request. A per-request reading saws with
		// the shape of each turn — every request that carries a big new block (a tool result, a file
		// read) is mostly fresh by definition, so the figure swings while the conversation is in fact
		// being cached perfectly well — and what a person watching the line wants to know is whether
		// this conversation's caching works, which is exactly the question the lifetime ratio answers.
		// The per-request numbers stay in the total seat's tooltip, where the bill lives.
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
 * How much of the session's prompts the provider did not have to re-read.
 *
 * Summed over every request the session has made, and against the whole prompt rather than against
 * the fresh tokens alone: "96% cached" should mean the requests were almost free, and a ratio that
 * could exceed 100% would not say that.
 */
function cacheHitRate(usage: UsageTotals): number | undefined {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	return prompt > 0 ? usage.cacheRead / prompt : undefined;
}

/** The session's prompts, counted the way the provider bills them. */
function promptTokens(usage: UsageTotals): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}
