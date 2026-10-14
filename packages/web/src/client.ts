import type { ConnectionFrame, ConnectionItem, ServerMessage, StreamFrame } from "@my-agent/core/protocol";

/**
 * What the window believes about the physical channel.
 *
 * Three states, because the question "can I reach the server" has two answers that change
 * independently: whether this socket is up and *proved* to be up, and whether the REST plane is
 * answering. Only the first one lives here.
 *
 * - `connecting` — an attempt is in flight, or nothing has been attempted yet.
 * - `live` — the socket is open **and** the first frame on this connection has arrived. Not
 *   "open": a socket that opened and then went silent is exactly the case a client cannot otherwise
 *   notice, and calling it live would defeat the watchdog that watches for exactly that.
 * - `down` — the last attempt ended and a backoff is sleeping, or the browser is offline.
 */
export type ChannelState = "connecting" | "live" | "down";

/**
 * Why this window is watching a session.
 *
 * Reference counting is client-side and by source, because the service's table answers "what does
 * this connection subscribe to" and deliberately does not answer "why" — counting there would be
 * state nobody reads. Two sources exist because they are released on genuinely different events: a
 * pane lives as long as the window looks at the session, a send lives exactly as long as the run it
 * started.
 */
export type SubscriptionSource = "pane" | "send";

/** What one logical stream is doing on this connection. */
export type SubscriptionStatus =
	/** An `open` is out and the server has not ended it. */
	| "subscribed"
	/**
	 * The server sent `end`, so this stream is finished.
	 *
	 * The one state that survives a reconnect without being reopened: the server decided this
	 * logical stream is over, and asking again after every dropped connection would buy a second
	 * "there is no such session" for a session that is simply gone. It clears when the last
	 * reference goes away, so pointing a pane somewhere else and back re-subscribes normally — and it
	 * clears on a fresh `retain` too, so a new send on a session a still-pointing pane holds revives
	 * the stream rather than being added to a dead entry.
	 */
	| "ended";

/** The three events a socket can raise, as this layer needs them. */
export interface MuxSocketHandlers {
	onOpen(): void;
	onMessage(text: string): void;
	onClose(): void;
	onError(): void;
}

/** What this layer writes to. The browser socket, or a fake one in a smoke. */
export interface MuxSocket {
	send(text: string): void;
	close(code: number, reason: string): void;
}

/** Builds one socket. Injected so a smoke can drive the state machine without a server. */
export type MuxSocketFactory = (handlers: MuxSocketHandlers) => MuxSocket;

/**
 * This layer's timers.
 *
 * A seam for the same reason the socket is: a watchdog and a backoff cannot be checked with sleeps,
 * and a suite that waits out real seconds is slow and flaky in equal measure. Production uses the
 * globals and never thinks about it again.
 */
export interface MuxTimers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** The two network events the channel answers to. `window` in a browser, absent in a smoke. */
export interface NetworkEvents {
	addEventListener(type: "online" | "offline", listener: () => void): void;
	removeEventListener(type: "online" | "offline", listener: () => void): void;
}

export interface MuxOptions {
	/** Where the channel lives. */
	url: string;
	socket: MuxSocketFactory;
	/** Defaults to the globals. */
	timers?: MuxTimers;
	/** Defaults to `Math.random`. Only the backoff's jitter reads it. */
	random?: () => number;
	/** The browser's `window`, or nothing in a smoke. Without it there is no online/offline handling. */
	network?: NetworkEvents;
	/** See {@link READY_TIMEOUT_MS}. */
	readyTimeoutMs?: number;
	/** The tolerance before any heartbeat has reported an interval. See {@link WATCHDOG_MULTIPLIER}. */
	watchdogTimeoutMs?: number;
	/** Where the one line per disconnect goes. Defaults to the console. */
	log?: (line: string) => void;
}

export interface MuxHandlers {
	/** The channel moved. The window's only window-level state machine reports through this. */
	onChannel(state: ChannelState): void;
	/** A payload that belongs to no session: the row table, a row change, or a heartbeat. */
	onConnectionItem(item: ConnectionItem): void;
	/** One frame of one session's stream. */
	onStreamMessage(sessionId: string, message: ServerMessage): void;
	/** The server ended this stream. It will not be reopened until its references drop. */
	onStreamEnd(sessionId: string): void;
	/** A stream failed without ending — a refused `open`, or `announce`d trouble. */
	onStreamError(sessionId: string, message: string): void;
}

/**
 * The first delay's ceiling: `500ms`, doubling per attempt up to {@link BACKOFF_CAP_MS}.
 *
 * The first *real* wait is half of this — see {@link backoffDelay} — so reading "500" as the wait
 * is off by a factor of two.
 */
const BACKOFF_FIRST_MS = 500;

/** The ceiling every delay saturates at. There is no attempt limit: a resident channel never gives up. */
const BACKOFF_CAP_MS = 10_000;

/**
 * How long one attempt may take to become `live` before it is abandoned.
 *
 * "Connected" is not the bar — proof is. A socket that opens and never delivers a frame is a
 * connection that cannot be distinguished from a black hole, so this bounds the attempt that failed
 * to prove itself and hands the backoff a new round.
 *
 * Same number as the watchdog, and deliberately not the same timer: they measure two different
 * questions ("has this attempt proved itself yet" and "has a proved connection gone quiet"), and
 * collapsing them would leave a socket's first heartbeat with no owner.
 */
const READY_TIMEOUT_MS = 15_000;

/**
 * The silence budget before a heartbeat has said how often to expect one.
 *
 * A fallback rather than the real rule: once a heartbeat arrives it names its own interval and the
 * tolerance is derived from that, so this only governs the stretch between a channel proving itself
 * and its first heartbeat landing. It is an option so a smoke can drive the whole watchdog down to
 * milliseconds; production leaves it alone.
 */
const WATCHDOG_TIMEOUT_MS = 15_000;

/** Tolerance, in heartbeat intervals, before a live connection is declared dead. */
const WATCHDOG_MULTIPLIER = 3;

/** The code this client closes with when it decides the connection is dead. A client-chosen code. */
const CLOSE_RECONNECT_REQUESTED = 4000;

/** One session this connection is watching. */
interface Subscription {
	/** Why it is still wanted. Empty means the entry is being dropped. */
	sources: Set<SubscriptionSource>;
	status: SubscriptionStatus;
}

/** Every option resolved, which is what the state machine actually reads. */
interface ResolvedMuxOptions {
	url: string;
	socket: MuxSocketFactory;
	readyTimeoutMs: number;
	watchdogTimeoutMs: number;
	log: (line: string) => void;
}

/**
 * One resident channel to the server, and everything the window needs to know about its health.
 *
 * Three things live here that used to live elsewhere, and they live together for one reason: each
 * one is a clock or a counter that must not have a second owner.
 *
 * **The backoff timeline.** The browser reconnects `EventSource` by itself and reconnects
 * `WebSocket` not at all, so this is the only thing deciding when to try again. The cap doubles from
 * 500ms to 10s and the actual wait is 50–100% of it, which spreads out several windows that all lost
 * the same server instead of having them return in lockstep. There is no attempt ceiling, because a
 * channel that gave up would be indistinguishable from one whose server is gone for good.
 *
 * **Two deadlines that never overlap.** An attempt is bounded by {@link READY_TIMEOUT_MS} until it
 * proves itself; once it has, that deadline is gone and {@link WATCHDOG_TIMEOUT_MS} measures silence
 * instead. They share a value because they are the same question asked in two phases.
 *
 * **The watchdog.** Idle but healthy produces no frames at all — a logical stream only speaks when
 * the session it watches has something to say — so silence proves nothing on its own. What makes it
 * a verdict is the server's connection-level heartbeat: any frame resets the timer, and the tolerance
 * is three times the interval the server last reported, so the two numbers are written in one place.
 *
 * The subscription table is the fourth thing here, and it is deliberately the *only* state that
 * survives a failed attempt. Its entries are intent rather than a record of what arrived, so a
 * reconnect re-opens each one and gets a fresh baseline — which is the only recovery this transport
 * has, and the reason no cursor or gap-filling appears anywhere in it.
 *
 * Nothing here touches the DOM. The socket, the timers, the network events and the jitter are all
 * injected, which is what lets a smoke drive a fifteen-second state machine in milliseconds and
 * assert things a browser would need a proxy to reproduce.
 */
export class MuxClient {
	private readonly handlers: MuxHandlers;
	private readonly options: ResolvedMuxOptions;
	private readonly timers: MuxTimers;
	private readonly random: () => number;
	private readonly log: (line: string) => void;

	/**
	 * This attempt's socket.
	 *
	 * `undefined` while nothing is connected. Replacing it is the whole of reconnection: the new one
	 * is a physical replacement, and every logical stream above it is reopened by reference rather
	 * than by anything this class remembers about the old attempt.
	 */
	private socket?: MuxSocket;
	/**
	 * Which attempt is speaking.
	 *
	 * A socket fires `close` and `error` for a connection the client itself closed, exactly as it
	 * does for a dropped one, so the handlers below cannot tell the two apart by themselves. This
	 * counter is what lets them: an attempt bumps it, and every handler from a superseded attempt
	 * finds itself stale and does nothing.
	 */
	private generation = 0;
	private channelState: ChannelState = "connecting";
	/** How many attempts have failed since the last one proved itself. */
	private attempt = 0;
	/** Set only by {@link close}, which is the window going away rather than a connection failing. */
	private stopped = false;
	/** The browser said the network is gone, so no attempt is worth making. */
	private offline = false;
	/** The backoff sleep in progress, if any. */
	private retryTimer: unknown = null;
	/** The current attempt's ready deadline, while it is still trying to prove itself. */
	private readyTimer: unknown = null;
	/** The silence budget on a live connection, reset by every frame. */
	private watchdogTimer: unknown = null;
	/** The interval the server last reported, or `undefined` while it has reported none. */
	private heartbeatMs: number | undefined;
	/** What this connection is watching, by session. One entry per session, however many sources. */
	private readonly subscriptions = new Map<string, Subscription>();

	constructor(handlers: MuxHandlers, options: MuxOptions) {
		this.handlers = handlers;
		this.options = {
			url: options.url,
			socket: options.socket,
			readyTimeoutMs: options.readyTimeoutMs ?? READY_TIMEOUT_MS,
			watchdogTimeoutMs: options.watchdogTimeoutMs ?? WATCHDOG_TIMEOUT_MS,
			log: options.log ?? ((line) => console.warn(line)),
		};
		this.timers = options.timers ?? {
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		};
		this.random = options.random ?? Math.random;
		this.log = this.options.log;
		if (options.network !== undefined) this.watchNetwork(options.network);
	}

	/** Open the channel. The first attempt is immediate; only failures back off. */
	start(): void {
		if (this.stopped || this.socket !== undefined) return;
		this.attemptConnect();
	}

	/**
	 * Stop for good.
	 *
	 * Not the same as a disconnect: this is the window unloading, so no attempt follows. Everything
	 * else in this class that gives up on a connection is a *replacement*, and that is the whole
	 * reason this flag is class-wide — a per-attempt "give up" would be indistinguishable from this.
	 */
	close(): void {
		this.stopped = true;
		this.clearTimers();
		this.socket?.close(1000, "window is closing");
		this.socket = undefined;
	}

	/**
	 * Say that the window wants this session's content, for a reason that outlives one run.
	 *
	 * Idempotent per source and per session, so a caller can say "make sure something is watching
	 * this" without tracking whether it already is. A second `open` for a session this connection is
	 * already subscribed to is a protocol error the server answers, so this is what prevents it.
	 */
	retain(sessionId: string, source: SubscriptionSource): void {
		if (this.stopped) return;
		const existing = this.subscriptions.get(sessionId);
		if (existing !== undefined) {
			existing.sources.add(source);
			// A new want revives a stream the server ended. The `ended` mark exists to keep the
			// *reconnect* path — {@link replaySubscriptions} — from asking again for a session the
			// server has already declared over; it is not a verdict that outlives a fresh gesture of
			// intent. Without this, a session whose pane never let go could never be watched again:
			// the only other way out of `ended` is the reference count dropping to zero, which a pane
			// still pointing at the session prevents.
			if (existing.status === "ended") {
				existing.status = "subscribed";
				if (this.channelState === "live") this.writeOpen(sessionId);
			}
			return;
		}

		const subscription: Subscription = { sources: new Set([source]), status: "subscribed" };
		this.subscriptions.set(sessionId, subscription);
		// Not sent here when the channel is not live: there is nowhere to send it, and the live
		// transition replays every entry anyway. Recording the intent is the whole job right now.
		if (this.channelState === "live" && subscription.status !== "ended") this.writeOpen(sessionId);
	}

	/**
	 * Give up one reason for watching a session.
	 *
	 * The last one out sends `cancel` and drops the entry, which is also what releases the window's
	 * copy of that session — there is no second place to clean up, so "nobody is watching it" and
	 * "we hold nothing for it" are the same event by construction.
	 */
	release(sessionId: string, source: SubscriptionSource): void {
		const subscription = this.subscriptions.get(sessionId);
		if (subscription === undefined) return;
		subscription.sources.delete(source);
		if (subscription.sources.size > 0) return;

		this.subscriptions.delete(sessionId);
		if (this.channelState === "live" && subscription.status !== "ended") {
			this.write({ type: "cancel", sessionId });
		}
	}

	/** What this connection believes about itself. */
	get channel(): ChannelState {
		return this.channelState;
	}

	/** Whether this session currently has a live logical stream on this connection. */
	isWatching(sessionId: string): boolean {
		return this.subscriptions.get(sessionId)?.status === "subscribed";
	}

	/** Whether any reason at all still wants this session. */
	isRetained(sessionId: string): boolean {
		return (this.subscriptions.get(sessionId)?.sources.size ?? 0) > 0;
	}

	// ------------------------------------------------------------- the attempt

	/**
	 * One attempt, from a bare socket to a proved channel.
	 *
	 * Nothing here is remembered across attempts except the backoff counter, on purpose. A new
	 * attempt knows nothing about the old one — not its streams, not its frames — because everything
	 * above the channel converges from a fresh baseline, and a mechanism that remembered would be a
	 * second source of truth about what a window is looking at.
	 */
	private attemptConnect(): void {
		if (this.stopped || this.offline) return;
		const generation = ++this.generation;
		this.socket?.close(1000, "replaced by a new attempt");
		this.setChannel("connecting");

		const socket = this.options.socket({
			onOpen: () => {
				// Deliberately does *not* make the channel live. An open socket proves a handshake, and
				// the handshake is exactly what a black-holed connection still completes; the first
				// frame is the proof, and until it lands the ready deadline is what is running.
				if (generation !== this.generation) return;
			},
			onMessage: (text) => this.onFrame(generation, text),
			onClose: () => this.onLost(generation, "连接已断开"),
			onError: () => {
				// An `error` is always followed by `close`, which is where the backoff is decided —
				// deciding it in both places would start two sleeps and leave one of them to wake up
				// with nothing to do.
				if (generation !== this.generation) return;
			},
		});
		this.socket = socket;

		this.readyTimer = this.timers.setTimeout(() => {
			this.readyTimer = null;
			if (generation !== this.generation) return;
			// Opened, or nearly so, and still no frame. Abandon this socket rather than keep waiting:
			// the next attempt costs a backoff, and a socket that cannot prove itself is one the
			// watchdog would have to kill moments after declaring it live anyway.
			this.log("mux: 这次连接没能证明自己活着，放弃并重试");
			this.onLost(generation, "连接就绪超时");
		}, this.options.readyTimeoutMs);
	}

	/** The last thing an attempt does, whatever ended it: report down, then back off. */
	private onLost(generation: number, why: string): void {
		if (generation !== this.generation) return;
		this.generation += 1;
		this.clearTimers();
		this.socket = undefined;
		if (this.stopped) return;

		this.log(`mux: ${why}（第 ${this.attempt + 1} 次）`);
		this.setChannel("down");
		if (this.offline) return;

		// The subscription table survives deliberately. Its entries are *intent*, not a record of
		// what arrived: a session that was watched before the drop is still watched, and the next
		// `live` re-opens each one and gets a fresh baseline for it.
		const cap = this.backoffCap(this.attempt + 1);
		this.attempt += 1;
		this.retryTimer = this.timers.setTimeout(() => {
			this.retryTimer = null;
			this.attemptConnect();
		}, this.backoffDelay(cap));
	}

	/**
	 * One frame off the wire.
	 *
	 * This is the only place that decides what a frame means, and it decides by `streamId` alone:
	 * `null` names the connection, anything else names a logical stream. A client that checked the
	 * payload's shape would have to know every member of two unions to route a frame, and a new
	 * member would be a breaking change to the router rather than an addition.
	 *
	 * Liveness is checked **after** the frame is recognised rather than before, and the order is the
	 * point. Bytes arriving prove the socket is open, but they do not prove the far end understands
	 * this protocol — so a payload this client cannot read must leave the ready deadline running. Were
	 * it the other way round, one corrupt or foreign frame would promote a channel that has said
	 * nothing intelligible since it opened, and the deadline that exists to catch exactly that would
	 * have been cancelled by the thing it was watching for.
	 */
	private onFrame(generation: number, text: string): void {
		if (generation !== this.generation) return;

		let frame: unknown;
		try {
			frame = JSON.parse(text);
		} catch {
			// Dropped, not fatal: one unreadable frame costs less than closing a channel over it, and
			// the ready deadline still gets its chance to fire.
			return;
		}
		if (typeof frame !== "object" || frame === null) return;
		const record = frame as { streamId?: unknown };
		if (record.streamId === null) {
			this.noteAlive();
			this.onConnectionFrame(frame as ConnectionFrame);
			return;
		}
		// Not routed, and not counted as proof of life either: a payload with no session id on it is
		// one this protocol has no shape for, and treating it as a sign of health would let the one
		// frame that means nothing cancel the deadline watching for exactly that.
		if (typeof record.streamId !== "string") return;
		this.noteAlive();
		this.onStreamFrame(record.streamId, frame as StreamFrame);
	}

	private onConnectionFrame(frame: ConnectionFrame): void {
		// `in` rather than `!== undefined`, for the same reason as the stream branch: these are three
		// shapes told apart by which key is present, and a lookup on a key two of them lack is asking
		// the wrong question.
		if ("item" in frame) {
			// The heartbeat's own consumer is the watchdog, and the interval it carries is what the
			// tolerance is computed from — so that number is read here rather than guessed here.
			if (frame.item.type === "heartbeat") this.heartbeatMs = frame.item.everyMs;
			this.handlers.onConnectionItem(frame.item);
			return;
		}
		// An envelope-level failure belongs to no session, so there is no column to put it in. The
		// empty id is how this layer says "belongs to none", and it is what keeps the window from
		// filing a connection problem into whichever conversation happens to be on screen.
		this.handlers.onStreamError("", frame.error.message);
	}

	private onStreamFrame(sessionId: string, frame: StreamFrame): void {
		// `in` rather than `!== undefined`: the three shapes are told apart by which key carries the
		// payload, and two of them have no `item` key at all — so asking for it is a type error, not a
		// lookup that happens to miss.
		if ("item" in frame) {
			this.handlers.onStreamMessage(sessionId, frame.item);
			return;
		}
		if ("error" in frame) {
			// A stream-level failure is not terminal by itself: a run that could not start is reported
			// here and the stream stays open. What decides whether this subscription is finished is
			// whether the server follows it with an `end`, which is handled below.
			this.handlers.onStreamError(sessionId, frame.error.message);
			return;
		}
		if (frame.end === true) this.endStream(sessionId);
	}

	/**
	 * The server ended this stream.
	 *
	 * The entry stays, holding whatever still wants this session, because "nobody wants it any more"
	 * is not what happened: the pane is still looking at it. What changed is that this logical
	 * stream is over, so it must not be reopened by the next reconnect — the server already gave its
	 * answer, and asking again would fetch a second copy of it. The `ended` mark clears when the
	 * last reference goes, so pointing the pane away and back subscribes afresh.
	 */
	private endStream(sessionId: string): void {
		const subscription = this.subscriptions.get(sessionId);
		if (subscription !== undefined) subscription.status = "ended";
		this.handlers.onStreamEnd(sessionId);
	}

	// --------------------------------------------------------------- liveness

	/**
	 * A frame arrived on a live connection: the silence budget starts over.
	 *
	 * Also where a proved attempt stops being an attempt. The ready deadline is cancelled here
	 * rather than left to expire into a channel that is working fine — that expiry would close a
	 * perfectly good connection the moment a slow first frame stretched past it.
	 */
	private noteAlive(): void {
		if (this.readyTimer !== null) {
			this.timers.clearTimeout(this.readyTimer);
			this.readyTimer = null;
		}
		if (this.channelState !== "live") {
			// A channel that just proved itself starts its backoff over: it says nothing about how
			// healthy the next outage will be, and carrying the old count would make the first retry
			// after a long healthy stretch wait ten seconds for no reason.
			this.attempt = 0;
			this.setChannel("live");
			this.replaySubscriptions();
		}

		if (this.watchdogTimer !== null) this.timers.clearTimeout(this.watchdogTimer);
		this.watchdogTimer = this.timers.setTimeout(() => {
			this.watchdogTimer = null;
			const socket = this.socket;
			if (socket === undefined || this.channelState !== "live") return;
			this.log("mux: 太久没有收到任何帧，判定连接已死");
			// Closed with a client code rather than dropped: this is a decision, and the close frame
			// is how the server learns the subscription table should go. `onLost` follows from here
			// exactly as it would from a server-side close.
			socket.close(CLOSE_RECONNECT_REQUESTED, "reconnect requested");
			this.onLost(this.generation, "读超时");
		}, this.watchdogTolerance());
	}

	/**
	 * How long a live connection may be quiet.
	 *
	 * Once a heartbeat has reported an interval, the tolerance is derived from it so the two sides
	 * cannot drift: the server says how often it will speak, and this side allows three of those to
	 * be late before it calls the channel dead. Before the first report there is nothing to derive
	 * from, so the configured value stands — which is why it is an option at all.
	 */
	private watchdogTolerance(): number {
		return this.heartbeatMs === undefined
			? this.options.watchdogTimeoutMs
			: WATCHDOG_MULTIPLIER * this.heartbeatMs;
	}

	// ---------------------------------------------------------------- network

	/**
	 * The browser's own word on the network.
	 *
	 * `offline` suspends rather than fails: there is nothing to connect to, and burning backoff
	 * attempts on a machine with no route spends the counter that a real outage will need.
	 *
	 * `online` does **not** reconnect directly — it interrupts the current wait, resets the counter,
	 * and then sleeps one ordinary backoff. The reason is that "the network is back" and "the server
	 * is back" are different facts, and the second one is only established by an attempt. Sleeping
	 * once keeps a flapping link from turning into a tight reconnect loop, without making a genuine
	 * recovery wait longer than it otherwise would.
	 */
	private watchNetwork(network: NetworkEvents): void {
		network.addEventListener("offline", () => {
			this.offline = true;
			if (this.retryTimer !== null) {
				this.timers.clearTimeout(this.retryTimer);
				this.retryTimer = null;
			}
			if (this.stopped || this.channelState !== "live") return;
			this.generation += 1;
			this.clearTimers();
			this.socket?.close(1000, "the browser went offline");
			this.socket = undefined;
			this.setChannel("down");
		});

		network.addEventListener("online", () => {
			this.offline = false;
			if (this.stopped || this.channelState === "live") return;
			if (this.retryTimer !== null) {
				this.timers.clearTimeout(this.retryTimer);
				this.retryTimer = null;
			}
			this.attempt = 0;
			const cap = this.backoffCap(1);
			this.retryTimer = this.timers.setTimeout(() => {
				this.retryTimer = null;
				this.attemptConnect();
			}, this.backoffDelay(cap));
		});
	}

	// ---------------------------------------------------------------- writing

	/**
	 * Re-open every logical stream this connection still has a reason to hold.
	 *
	 * Called on the transition into `live`, which is the only moment a frame can be sent. Each entry
	 * that is not `ended` is re-opened by reference: the server treats this as a brand new
	 * subscription and answers with a fresh baseline, so what the window ends up showing is "what
	 * this looks like now" rather than "what I missed" — which is the only recovery this transport
	 * has, and the reason no cursor or gap-filling exists anywhere in it.
	 */
	private replaySubscriptions(): void {
		for (const [sessionId, subscription] of this.subscriptions) {
			if (subscription.status === "ended" || subscription.sources.size === 0) continue;
			subscription.status = "subscribed";
			this.writeOpen(sessionId);
		}
	}

	private writeOpen(sessionId: string): void {
		this.write({ type: "open", sessionId });
	}

	/**
	 * Send one uplink frame, or drop it because there is no channel.
	 *
	 * Dropping rather than queueing is deliberate. The only two frames are `open` and `cancel`, and
	 * both are statements about *intent* that the subscription table already holds — a dropped
	 * `open` is re-sent by the next `live`, and a dropped `cancel` refers to a session this
	 * connection has already forgotten. A queue would be a second copy of the table, and the one
	 * thing that must never be wrong about a reconnect is what it thinks it is watching.
	 */
	private write(frame: { type: "open" | "cancel"; sessionId: string }): void {
		const socket = this.socket;
		if (socket === undefined || this.channelState !== "live") return;
		try {
			socket.send(JSON.stringify(frame));
		} catch (error) {
			// Sending on a socket the browser has already forgotten throws rather than fails softly.
			// It is a lost frame rather than a broken channel: the table still holds the intent, and
			// the watchdog or the close event will drive the replacement that re-sends it.
			this.log(`mux: 上行帧发不出去：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private setChannel(state: ChannelState): void {
		if (this.channelState === state) return;
		this.channelState = state;
		this.handlers.onChannel(state);
	}

	private clearTimers(): void {
		for (const timer of [this.retryTimer, this.readyTimer, this.watchdogTimer]) {
			if (timer !== null) this.timers.clearTimeout(timer);
		}
		this.retryTimer = null;
		this.readyTimer = null;
		this.watchdogTimer = null;
	}

	/** The ceiling for the nth attempt, doubling to {@link BACKOFF_CAP_MS} and stopping there. */
	private backoffCap(attempt: number): number {
		return Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, attempt - 1));
	}

	/**
	 * How long to actually wait: half the ceiling, plus up to another half of jitter.
	 *
	 * The jitter is not decoration. Several windows watching the same server lose it at the same
	 * moment, and a fixed delay would bring them all back at the same moment too — turning one
	 * outage into a thundering herd against a server that has just restarted.
	 */
	private backoffDelay(cap: number): number {
		const half = cap / 2;
		return half + this.random() * half;
	}
}

/** Where the channel lives for a page served by this server. Same origin, one fixed path. */
export function muxUrl(location: { protocol: string; host: string }): string {
	const scheme = location.protocol === "https:" ? "wss:" : "ws:";
	return `${scheme}//${location.host}/mux`;
}

/** A socket factory over the browser's own `WebSocket`. */
export function browserSocket(url: string): MuxSocketFactory {
	return (handlers) => {
		const socket = new WebSocket(url);
		socket.addEventListener("open", () => handlers.onOpen());
		socket.addEventListener("message", (event) => handlers.onMessage(String(event.data)));
		socket.addEventListener("close", () => handlers.onClose());
		socket.addEventListener("error", () => handlers.onError());
		return {
			send: (text) => socket.send(text),
			close: (code, reason) => socket.close(code, reason),
		};
	};
}