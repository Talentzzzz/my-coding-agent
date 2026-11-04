import type { ClientFrame } from "@my-agent/core/protocol";

/**
 * Read one uplink frame, or answer `undefined` for anything that is not one.
 *
 * This is the server's only trust boundary: everything above it works with `ClientFrame` values and
 * trusts them, so the shape is established here and nowhere else. It is deliberately *not* a
 * validation framework — two actions cannot be abused into anything, and a schema library to say so
 * would cost more than the thing it protects.
 *
 * The two rejects are the ones with a stated policy behind them. A frame that is not JSON, or not
 * one of the four known actions, is dropped and logged by the caller rather than closing the
 * connection: the alternative turns one mistake in a hand-written smoke script into a window that
 * will not open at all, and "refresh and it works" is worth a log line.
 *
 * `open` for a session that does not exist, `open` for one already subscribed, and `wait` /
 * `unwait` for a session this connection has never named before, are *not* dropped here — those are
 * answers, and the connection layer is what has the state to answer them with. The wait pair in
 * particular is deliberately independent of the subscription table: a send's reference can be
 * reported before the `open` it travels beside has been processed, and a wait recorded for a
 * session that turns out not to exist is one `unwait` away from gone (issue 13).
 */
export function parseClientFrame(text: string): ClientFrame | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

	const record = value as Record<string, unknown>;
	// Fields this server does not know are ignored rather than refused: `window` is specified and
	// carries no meaning yet (nothing produces it), and a client that sends one must not be punished
	// for it.
	if (record.type === "open") {
		if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return undefined;
		return {
			type: "open",
			sessionId: record.sessionId,
			...(record.window === undefined ? {} : { window: record.window }),
		};
	}
	if (record.type === "cancel" || record.type === "wait" || record.type === "unwait") {
		if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return undefined;
		return { type: record.type, sessionId: record.sessionId };
	}
	return undefined;
}
