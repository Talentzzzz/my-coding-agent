import type { ServerResponse } from "node:http";

/**
 * One server-sent-events response.
 *
 * SSE rather than a socket because everything this endpoint does is one-directional: the session
 * pushes, the browser never talks back on this connection. Commands are ordinary HTTP requests
 * against the same session, which is also why any of them — including stopping a run — works from a
 * terminal, a script, or another tab.
 */
export interface EventStream {
	/** Whether anything was actually written, i.e. whether a `session` frame went out. */
	readonly started: boolean;
	/** Whether this response is over, whoever ended it. */
	readonly closed: boolean;
	/**
	 * Settles when the response ends for any reason — the client leaving, or the server closing it.
	 *
	 * Whoever holds a claim needs this to know its stream is over, which is why it does not try to
	 * distinguish the two cases: a stream that ended is a stream that ended. Shutdown is told apart by
	 * asking {@link closed} once the process has decided it is closing.
	 */
	readonly clientGone: Promise<void>;
	send(message: unknown): void;
	close(): void;
}

/**
 * How long an idle connection is kept alive with a comment line.
 *
 * Load balancers and proxies drop a connection that has been silent for a while, and the client only
 * learns about it through a missing keep-alive. Fifteen seconds is well inside every default this
 * server is likely to sit behind.
 */
const KEEP_ALIVE_MS = 15_000;

/**
 * Take over a response as an event stream.
 *
 * The headers are written immediately: that both starts the response — so the router knows a later
 * failure can no longer be turned into a JSON error — and makes the client's `EventSource` resolve
 * as soon as the first frame arrives.
 */
export function openEventStream(response: ServerResponse): EventStream {
	response.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		// `no-transform` is the one that matters: it forbids anything in the path from re-chunking a
		// stream whose framing is the payload.
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		// For proxies that buffer unless told not to. Harmless where nothing reads it.
		"x-accel-buffering": "no",
	});
	response.flushHeaders();

	let started = false;
	let closed = false;
	let settleGone = (): void => {};
	const gone = new Promise<void>((settle) => {
		settleGone = settle;
	});

	const keepAlive = setInterval(() => {
		if (!closed) response.write(": ping\n\n");
	}, KEEP_ALIVE_MS);
	// A stream must never be the reason the process stays up.
	keepAlive.unref();

	const finish = (): void => {
		if (closed) return;
		closed = true;
		clearInterval(keepAlive);
		// `close` fires for a server-side end too, and that is not the client going away.
		response.off("close", onClose);
		response.end();
	};

	const onClose = (): void => {
		// The response ended without `close()` being asked for: the client is gone, and only now is it
		// worth starting the reconnect grace.
		if (closed) return;
		closed = true;
		clearInterval(keepAlive);
		settleGone();
	};
	response.on("close", onClose);

	return {
		get started() {
			return started;
		},
		get closed() {
			return closed;
		},
		clientGone: gone,
		send(message: unknown): void {
			if (closed) return;
			// One JSON document per frame, on one line: `JSON.stringify` escapes newlines, so a
			// payload can never be mistaken for the blank line that ends a frame.
			response.write(`data: ${JSON.stringify(message)}\n\n`);
			started = true;
		},
		close(): void {
			finish();
			settleGone();
		},
	};
}
