import type { ServerMessage } from "@my-agent/core/protocol";

export interface StreamHandlers {
	onMessage(message: ServerMessage): void;
	/**
	 * This tab is now watching a different session — a reload landing on a stored one, a session that
	 * went away being replaced, or the server naming the one it opened.
	 */
	onFollow(sessionId: string): void;
}

/** How long to wait before reopening a stream the browser itself gave up on. */
const RECONNECT_MS = 2_000;

/** How long {@link SessionStream.whenOpen} waits for an attach before calling it a failure. */
const ATTACH_TIMEOUT_MS = 10_000;

/**
 * The session stream, and the reconnect behaviour around it.
 *
 * One `EventSource` per tab, pointed at one session, and it exists for a run rather than for the tab:
 * viewing an idle session is a plain `GET` (`./api.ts`), and this is opened only when there is
 * something to watch — a run in flight, or a message about to be sent. The server closes it with a
 * `stream_end` frame once the run is over, and this class must not put it back.
 *
 * The browser reconnects an event stream by itself, so what is left here is what it cannot know: when
 * a reconnect is right (a dropped connection mid-run, which the opening snapshot makes lossless) and
 * when it is wrong (the stream ended, which is now the normal way one ends).
 *
 * Switching sessions is close-one-open-another. That is the visible cost of a one-directional
 * stream: commands are ordinary requests and may name any session at any time, but the stream this
 * tab is reading is bound to exactly one session.
 */
export class SessionStream {
	private stream?: EventSource;
	/** Set only by {@link close}, which is the app going away rather than a session changing. */
	private stopped = false;
	private sessionId?: string;
	/** Bumped per `connect`, so a superseded attempt cannot touch state or emit anything. */
	private generation = 0;
	/** What {@link whenOpen} is waiting for, one entry per caller still waiting. */
	private readonly waiting = new Set<(attached: boolean) => void>();
	private readonly handlers: StreamHandlers;

	constructor(handlers: StreamHandlers) {
		this.handlers = handlers;
	}

	/**
	 * Watch a session, opening a stream for it if there is not one already.
	 *
	 * Idempotent for the session already being watched, which is what lets a caller say "make sure
	 * something is watching this" without having to know whether it already is: a second
	 * `EventSource` for one session would be a second claim on it, and closing the first would take
	 * the run's frames with it.
	 */
	watch(sessionId: string): void {
		if (this.stopped || this.sessionId === sessionId) return;
		this.sessionId = sessionId;
		void this.connect(sessionId);
	}

	/**
	 * Wait until a stream for this session has been attached, and answer whether it ever was.
	 *
	 * The point is the ordering, not the convenience: a run that fails to start is reported with
	 * `announce`, which goes to the streams attached at that moment and is *not* buffered, so a
	 * message posted before the stream exists can lose its own failure. Attaching first is what makes
	 * that impossible, and `false` here is what tells the caller not to send at all.
	 */
	whenOpen(sessionId: string, ms = ATTACH_TIMEOUT_MS): Promise<boolean> {
		if (this.stopped) return Promise.resolve(false);
		this.watch(sessionId);

		// A stream the browser is already holding open needs no wait: the server attached it before
		// this call, so a prompt posted now is already observable on it.
		if (this.stream?.readyState === EventSource.OPEN) return Promise.resolve(true);

		return new Promise<boolean>((resolve) => {
			const settle = (attached: boolean): void => {
				if (!this.waiting.delete(settle)) return;
				clearTimeout(timer);
				resolve(attached);
			};
			const timer = setTimeout(() => settle(false), ms);
			this.waiting.add(settle);
		});
	}

	close(): void {
		this.stopped = true;
		this.stream?.close();
	}

	/**
	 * Attach one session.
	 *
	 * `generation` is the only thing that stops a stream the client itself closed from being reopened:
	 * `EventSource` fires `error` on a close it did not ask for exactly as it does on a dropped
	 * connection, so the handler below cannot tell the two apart by itself. Bumping the counter before
	 * closing makes an abandoned attempt's handlers no-ops — including the `error` that close
	 * produces, which would otherwise schedule a reconnect (`RECONNECT_MS`).
	 */
	private async connect(sessionId: string): Promise<void> {
		if (this.stopped) return;
		const generation = ++this.generation;
		this.stream?.close();

		const stream = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
		this.stream = stream;

		/** Whether this attempt got a stream at all, which is what a waiting caller is owed. */
		let attached = false;
		const took = (): void => {
			attached = true;
			for (const settle of [...this.waiting]) settle(true);
		};

		stream.addEventListener("open", () => {
			if (generation !== this.generation) return;
			took();
		});

		stream.addEventListener("message", (event) => {
			if (generation !== this.generation) return;
			let message: ServerMessage;
			try {
				message = JSON.parse(String(event.data)) as ServerMessage;
			} catch {
				// A frame this client cannot parse is a protocol bug; dropping it keeps the session usable.
				return;
			}

			// Any frame is proof the attach worked, whether or not `open` got here first.
			took();

			if (message.type === "baseline" && message.session.id !== this.sessionId) {
				// A baseline names the session this attempt landed on, which is how a fork or a
				// replacement is followed without the caller having to guess.
				this.sessionId = message.session.id;
				this.handlers.onFollow(message.session.id);
			}
			this.handlers.onMessage(message);
		});

		stream.addEventListener("error", () => {
			if (generation !== this.generation) return;
			// `EventSource` retries on its own while it is `CONNECTING`, which covers a dropped
			// connection and needs nothing from here.
			if (stream.readyState !== EventSource.CLOSED) return;

			// The browser gave up, which means it got a response it will not retry — a 404, most
			// likely, because the session this tab was watching is gone. Whether this counts as an
			// attach is what a waiting sender needs to know, and an attempt that never got a stream
			// is one a prompt must not be posted into.
			for (const settle of [...this.waiting]) settle(attached);
		});
	}
}
