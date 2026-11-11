/** 默认的单工具输出预算。约 60 KB，或几千行。 */
export const DEFAULT_MAX_CHARS = 60_000;

export interface Truncated {
	text: string;
	truncated: boolean;
	omittedChars: number;
}

/**
 * 截断 tool result 并把这一点明确说出来。
 *
 * 静默切掉输出会让模型以为自己看到了全部，所以每次截断都带一行模型可以照着行动的说明。
 */
export function truncate(text: string, maxChars = DEFAULT_MAX_CHARS): Truncated {
	if (text.length <= maxChars) return { text, truncated: false, omittedChars: 0 };

	const head = Math.floor(maxChars * 0.7);
	const tail = maxChars - head;
	const omitted = text.length - head - tail;
	return {
		text: `${text.slice(0, head)}\n\n[... ${omitted} characters omitted; narrow the request ...]\n\n${text.slice(text.length - tail)}`,
		truncated: true,
		omittedChars: omitted,
	};
}

/** 截断一个列表并报告丢掉多少条。 */
export function truncateList<T>(items: readonly T[], max: number): { items: T[]; dropped: number } {
	if (items.length <= max) return { items: [...items], dropped: 0 };
	return { items: items.slice(0, max), dropped: items.length - max };
}
