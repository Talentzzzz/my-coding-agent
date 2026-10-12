/** Default per-tool output budget. Roughly 60 KB, or a few thousand lines. */
export const DEFAULT_MAX_CHARS = 60_000;

export interface Truncated {
	text: string;
	truncated: boolean;
	omittedChars: number;
}

/**
 * Cap a tool result and say so explicitly.
 *
 * Silently cutting output makes the model think it saw everything, so every truncation carries a
 * line the model can act on.
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

/** Cap a list and report how many entries were dropped. */
export function truncateList<T>(items: readonly T[], max: number): { items: T[]; dropped: number } {
	if (items.length <= max) return { items: [...items], dropped: 0 };
	return { items: items.slice(0, max), dropped: items.length - max };
}
