import { element } from "../dom.ts";
import type { UsageTotals } from "@my-agent/core/protocol";

export interface StatusState {
	usage: UsageTotals;
	connected: boolean;
}

/**
 * The line under the composer.
 *
 * It carries exactly three numbers, all of them about the tokens this session has spent: the session's
 * total, how much of its prompt the provider served from its own cache, and how full the model's
 * context window is. All three are read at a glance and none is a control, which is why they sit below
 * the composer rather than in the header the conversation is read from.
 *
 * While the server is not answering the three are replaced by the one thing that is actually true,
 * because a stale percentage is worse than no percentage. It is the *server's* reachability that is
 * being reported and not a stream's: under a run-scoped stream, having no stream open is the normal
 * state of an idle conversation, and calling that "reconnecting…" would mean showing it all the time.
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
		if (!state.connected) {
			this.element.dataset.state = "down";
			// The one sentence that is still true goes in the first seat; the other two go blank.
			this.total.textContent = "已断开";
			this.cache.textContent = "";
			this.context.textContent = "";
			this.meterFill.style.width = "0%";
			return;
		}
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
		this.cache.textContent = hit === undefined ? "cache —" : `cache ${Math.round(hit * 100)}%`;
		this.cache.title =
			`${formatTokens(usage.cacheRead)} tokens read from cache, ` +
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
 * How much of the prompt the provider did not have to re-read.
 *
 * Against the whole prompt rather than against the fresh tokens alone: "96% cached" should mean the
 * request was almost free, and a ratio that could exceed 100% would not say that.
 */
function cacheHitRate(usage: UsageTotals): number | undefined {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	return prompt > 0 ? usage.cacheRead / prompt : undefined;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}
