import type {
	ClientFrame,
	PendingApproval,
	ServerFrame,
	ServerMessage,
	SessionRow,
	SessionSnapshot,
} from "@my-agent/core/protocol";
import { parseClientFrame } from "./http/client-frame.ts";
import type { SessionFeeds, SessionHub } from "./hub.ts";
import type { SessionProjection } from "./projection.ts";

/**
 * How long the server waits before deciding a client has stopped answering.
 *
 * RFC 6455 gives a Pong no deadline of its own — a server may ping as often as it likes — so the
 * interval and the tolerance are this layer's choices. Two seconds with two misses tolerated, which
 * makes the *third* unanswered ping the one that ends a connection: about six seconds.
 *
 * Two misses rather than one is not caution. RFC 6455 §5.5.3 explicitly allows a peer to answer only
 * the *last* of several pings it received, so a client that batches replies is behaving correctly and
 * a tolerance of one would kill healthy connections on timing alone.
 *
 * The cost of a false positive is a reconnection and a fresh baseline, not a wrong answer.
 */
const PING_INTERVAL_MS = 2_000;

/** How many pings may go unanswered before the connection is dropped. */
const MAX_MISSED_PONGS = 2;

/**
 * How often every connection is told, in one frame, that the channel is alive.
 *
 * Separate from the ping above because they have different readers and no other reason to agree. A
 * Pong is visible only here — the browser never sees one — so it cannot be what the client's read
 * timeout watches. This frame is what the client watches, and it exists because the browser's
 * WebSocket API offers it no equivalent signal of its own.
 *
 * Five seconds, and deliberately not a multiple of the ping interval: the two timers answer different
 * questions, and making one a function of the other would invite a later reader to treat a Pong as
 * proof the client is well — exactly the assumption that made the SSE heartbeat worthless.
 */
const HEARTBEAT_INTERVAL_MS = 5_000;

/** How many bytes may accumulate behind a connection that stopped accepting writes. */
const STALL_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * How long a stalled connection may stay stalled before it is closed.
 *
 * The other half of the same budget as {@link STALL_BUDGET_BYTES}, and the half that actually fires. A
 * peer that has stopped reading fills its socket buffer within a couple of frames, so the byte ceiling
 * is reached only by a peer reading slowly rather than not at all; the measured behaviour of a fully
 * stalled peer is a queue that levels off in the tens of kilobytes and a deadline that runs out.
 *
 * It must stay below the client's read timeout (fifteen seconds), and that ordering is the whole
 * point: a channel that has stopped moving should end with a *server* close, so the client reconnects
 * at once on a channel it already knows is broken, rather than discovering the problem by waiting out
 * its own watchdog.
 */
const STALL_DEADLINE_MS = 10_000;

/** RFC 6455 §7.4.1: "try again later". What a stalled connection is closed with. */
const CLOSE_TRY_AGAIN_LATER = 1013;

/** RFC 6455 §7.4.1: going away. What a server that is shutting down closes with. */
const CLOSE_GOING_AWAY = 1001;

/**
 * The reasons that go with those codes, in one place, because they are the same kind of string.
 *
 * English, deliberately: a Close reason is read by a client deciding what to do next, and it sits
 * beside codes like the `4000 "reconnect requested"` the client itself sends. The Chinese in this file
 * is for the people reading it — the one line this layer logs — and that line is deliberately not the
 * one on the wire.
 */
const REASON_STOPPED_READING = "subscription client stopped reading";
const REASON_SHUTTING_DOWN = "server is shutting down";

/**
 * What this layer writes to, so the queue can be tested without a socket.
 *
 * Four members, and they are the four the policy needs: whether the socket will take more, how to ask
 * it a protocol-level question, how to close it politely, and how to drop it when it has stopped
 * answering. Anything more would be a socket this seam cannot fake, which is the point of having it.
 */
export interface FrameSink {
	/**
	 * Write one frame.
	 *
	 * Returns what the socket's own `write()` returned. `false` means the connection can no longer be
	 * written to directly, and it is the only signal the whole stall policy rests on.
	 */
	send(frame: ServerFrame): boolean;
	/** Ask the peer a protocol-level question it must answer. */
	ping(): void;
	/** Close politely, with a code and reason the peer will see. */
	close(code: number, reason: string): void;
	/** Drop the connection without waiting for the peer. */
	terminate(): void;
	/** Whether this sink is finished, whoever finished it. */
	readonly isClosed: boolean;
}

/**
 * How this layer's timers and budgets are measured.
 *
 * An option only so a smoke can drive them in milliseconds; nothing in production sets it. The same
 * reason `HubOptions.approvalGraceMs` is one: a timer a test cannot reach is a timer a test cannot
 * check, and reaching it with sleeps makes a suite slow and flaky at the same time.
 */
export interface MuxOptions {
	/** See {@link PING_INTERVAL_MS}. */
	pingIntervalMs?: number;
	/** See {@link MAX_MISSED_PONGS}. */
	maxMissedPongs?: number;
	/** See {@link HEARTBEAT_INTERVAL_MS}. */
	heartbeatIntervalMs?: number;
	/** See {@link STALL_BUDGET_BYTES}. */
	stallBudgetBytes?: number;
	/** See {@link STALL_DEADLINE_MS}. */
	stallDeadlineMs?: number;
	/** Where the one line about a stalled connection goes. Defaults to the console. */
	log?: (line: string) => void;
}

/** Every option resolved, which is what the connection and the server actually take. */
export type ResolvedMuxOptions = Required<MuxOptions>;

/**
 * One session this connection is watching.
 *
 * A subscription is a *connection × session* pair, which is why it lives here and not on the session:
 * two windows on one conversation hold two of these, each reporting approval differences from its own
 * starting point, and neither is a fact about the session.
 *
 * It holds no claim. Watching a session does not keep it running — a claim says somebody is running or
 * changing it — so nothing here is an input to the hub's decision about whether a session may be
 * closed. That separation is load-bearing: if a subscription held a claim, a window left open on an
 * idle conversation would keep an `Agent` assembled for nobody, forever.
 */
interface Subscription {
	/**
	 * The approvals this subscription has already told its browser about, by `toolCallId`.
	 *
	 * Keyed on the assumption that a `toolCallId` is unique within one session — the same assumption
	 * `Agent.pendingApprovals` is built on, backed by the provider's `tool_use` id semantics. Two
	 * sessions happening to share an id is a different fact and no defect: the answers table is keyed
	 * by session first, so one session's answer never reaches the other's window.
	 */
	pending: Map<string, PendingApproval>;
	/**
	 * Frames produced before the baseline went out, or `null` once it has.
	 *
	 * An array means "the baseline is still owed"; `null` means it is out. That distinction is why this
	 * is not a length test — the array is legitimately empty in both states, and an empty backlog after
	 * the baseline is the ordinary case rather than a special one.
	 */
	backlog: ServerFrame[] | null;
	/**
	 * Everything to undo, in the order it was set up.
	 *
	 * A list rather than a single reassignable function, and the reason is the order these things
	 * happen in: `observe` calls back *synchronously* for a session that is already running, so the
	 * feeds are attached before this subscription has even finished being created. A function that
	 * each step wrapped the previous one would have its work overwritten by the next assignment — and
	 * the lost half is the feed listeners, which is exactly the half that keeps a finished connection
	 * alive and still writing frames for a subscription the client cancelled.
	 */
	teardown: (() => void)[];
}

/**
 * One client connection: a subscription table, a bounded write queue, and the counter that judges
 * whether the peer is still answering.
 *
 * The connection's lifetime is the connection, not any run. It outlives every subscription on it and
 * every turn of every session they watch, and it ends only when the peer goes away or this server
 * decides it has — which is what lets one window hold several conversations at once instead of
 * reconnecting between them.
 */
export class MuxConnection {
	/** What this connection is watching, by session id. One stream per session, never two. */
	private readonly subscriptions = new Map<string, Subscription>();
	/**
	 * Frames that could not be written, oldest first.
	 *
	 * The queue exists because there is nowhere to push back. Events are produced by the agent loop and
	 * pushed at this layer; making `send` awaitable would propagate that wait into a vendored loop that
	 * must not change, so one browser pausing would stall the model instead of the window. Buffering
	 * keeps the loop running and puts the cost on the connection, the only party that can afford it.
	 */
	private readonly queue: ServerFrame[] = [];
	/** How many bytes the queue holds, so the budget is a comparison rather than a sum. */
	private queuedBytes = 0;
	/** Whether the socket has stopped accepting writes, and everything must wait its turn. */
	private stalled = false;
	/** When the socket stopped accepting, which is what the deadline is measured from. */
	private stalledSince = 0;
	/** The deadline, or null while nothing is waiting. */
	private stallTimer: NodeJS.Timeout | null = null;
	/** Pings sent since a Pong last arrived. */
	private missedPongs = 0;
	private closed = false;

	private readonly sink: FrameSink;
	private readonly hub: SessionHub;
	private readonly options: ResolvedMuxOptions;
	private readonly answers: ApprovalAnswers;

	constructor(
		sink: FrameSink,
		hub: SessionHub,
		options: ResolvedMuxOptions,
		answers: ApprovalAnswers,
	) {
		this.sink = sink;
		this.hub = hub;
		this.options = options;
		this.answers = answers;
	}

	/**
	 * Send one frame, queueing it if the connection has stopped accepting writes.
	 *
	 * Synchronous and `void`, and that is the interface the rest of the server is written against
	 * rather than a simplification. A run's frames are produced from inside the agent loop, which has
	 * no way to await anything; making this a promise would mean every call site had to become async
	 * and the loop would have to learn about one window's backpressure.
	 *
	 * On the normal path this is one `write()` and a return: no copy, no promise, no timer.
	 */
	send(frame: ServerFrame): void {
		if (this.closed) return;

		// A stalled connection is pumped before the new frame joins, so the queue stays in order and a
		// connection that recovered in the meantime never accumulates behind a burst it could have taken.
		if (this.stalled) this.pump();
		if (this.stalled) {
			this.enqueue(frame);
			return;
		}
		if (this.sink.send(frame)) return;

		// `false` means this frame was accepted into the socket's own buffer and is queued *there*, so
		// it must not be written again or it would be delivered twice. From here the connection counts
		// as stalled and everything after this frame waits.
		this.markStalled();
	}

	/**
	 * Deal with one uplink frame.
	 *
	 * `open` is the interesting one, and its whole meaning is that the subscription and its baseline
	 * are one atomic act: the entry is created, the feeds are attached, and the baseline is written
	 * without an `await` in between on the ordinary path. That is what makes "no gap between baseline
	 * and increments" true by construction rather than by argument — there is no moment at which a
	 * change could arrive between reading the session's state and starting to listen for it.
	 */
	handle(text: string): void {
		if (this.closed) return;
		const frame: ClientFrame | undefined = parseClientFrame(text);
		if (frame === undefined) {
			// Dropped rather than fatal, and logged rather than silent. See `parseClientFrame`: one
			// unreadable frame must not cost a window its whole connection.
			this.options.log(`mux: 丢弃一帧看不懂的上行帧（${text.length} 字节）`);
			return;
		}
		if (frame.type === "open") this.open(frame.sessionId);
		else this.cancel(frame.sessionId);
	}

	/**
	 * Start watching one session, or say why not.
	 *
	 * Two ways this can fail and they are not the same. A session that does not exist is a client's
	 * mistake. A session this connection is *already* watching is not: silently accepting the second
	 * `open` would leave a client believing it had two streams where the server has one, and that
	 * mismatch would surface much later as content arriving twice.
	 *
	 * Both are answered on the stream they concern — an `error` frame carrying the attribution, then an
	 * `end` so the failed attempt does not go on looking like a stream that is merely quiet — and the
	 * connection is untouched either way.
	 */
	private open(sessionId: string): void {
		if (this.subscriptions.has(sessionId)) {
			// The existing subscription is left alone. The duplicate request is refused, but the stream
			// that is already open keeps running — a client that sent this by mistake still has the one
			// conversation it asked for.
			this.send({ streamId: sessionId, error: { message: "这条连接已经订阅了这个会话。" } });
			this.endStream(sessionId, false);
			return;
		}
		if (!this.hub.has(sessionId)) {
			this.failStream(sessionId, `未知的会话：${sessionId}`);
			return;
		}

		const subscription: Subscription = { pending: new Map(), backlog: [], teardown: [] };
		this.subscriptions.set(sessionId, subscription);

		// Watching is not claiming, and it takes no claim: a window looking at an idle conversation must
		// not be the reason an `Agent` stays assembled. `observe` is keyed by id and re-binds itself if
		// this process later starts running the session, which is what lets "watch it, then send it a
		// message" work.
		//
		// `live` distinguishes "stopped running while I was watching" from "was never running", which is
		// the same distinction `bind` relies on: only the first ends the stream.
		let live = false;
		const stopWatching = this.hub.observe(sessionId, (feeds) => {
			if (feeds === undefined) {
				if (live) this.endStream(sessionId);
				return;
			}
			live = true;
			this.bind(sessionId, subscription, feeds);
		});

		// Registered after the `observe` call on purpose, and appended rather than assigned: `bind` may
		// already have appended the feed unsubscribers, and this must not displace them. See
		// `Subscription.teardown`.
		subscription.teardown.push(() => {
			stopWatching();
			// Whatever this subscription was still showing, nobody here will report it now: an answer
			// waiting only for readers that are gone is an answer with no reason to be kept.
			for (const toolCallId of subscription.pending.keys()) this.answers.hide(sessionId, toolCallId);
			subscription.pending.clear();
			subscription.backlog = null;
			this.subscriptions.delete(sessionId);
		});

		// Already running: `observe` called back synchronously above and the baseline is out. Cold: read
		// the transcript off disk, which is the one place an `await` is unavoidable — and the backlog is
		// what keeps that await from opening a gap.
		if (subscription.backlog !== null) void this.readColdBaseline(sessionId, subscription);
	}

	/**
	 * Undo one subscription: every step it registered, newest first.
	 *
	 * Reverse order because the steps are a stack — the feeds were attached after the watch was
	 * registered, so they are the later thing to let go of.
	 */
	private teardown(subscription: Subscription): void {
		for (let index = subscription.teardown.length - 1; index >= 0; index -= 1) {
			subscription.teardown[index]?.();
		}
		subscription.teardown = [];
	}

	/**
	 * The baseline for a session this process is not running.
	 *
	 * Reading a transcript is not running a session, so this never assembles anything and never claims
	 * anything. It is the answer to "watch an idle conversation", which is the case the old
	 * run-scoped stream refused to serve at all.
	 *
	 * Everything produced while the read is in flight waits in the subscription's backlog. That is the
	 * whole reason the backlog exists: without it, a run that started during the read would put frames
	 * on this stream *before* the state they describe, and the client would render a transcript
	 * jumping backwards.
	 */
	private async readColdBaseline(sessionId: string, subscription: Subscription): Promise<void> {
		let snapshot: SessionSnapshot;
		try {
			snapshot = await this.hub.snapshotOf(sessionId);
		} catch (error) {
			// The file went away between the existence check and the read. This is a failed `open`, so it
			// is answered like every other one: an error carrying the attribution, then the end that stops
			// the attempt from going on looking like a stream that is merely quiet.
			if (!this.closed && this.subscriptions.get(sessionId) === subscription) {
				this.failStream(sessionId, `读不出这个会话的记录：${describe(error)}`);
			}
			return;
		}
		// A `cancel` may have landed during the read, or the connection may have ended. Either way this
		// baseline has nowhere to go, and writing it anyway would put a frame on a stream that is over.
		if (this.closed || this.subscriptions.get(sessionId) !== subscription) return;
		if (subscription.backlog === null) return;
		this.writeBaseline(sessionId, subscription, snapshot);
	}

	/**
	 * Stop watching one session.
	 *
	 * The only meaning of dropping a subscription is "no more frames for this session on this
	 * connection" — not "stop the run", not "close the session", not "release anything". A run started
	 * from this window keeps its own claim and keeps going, which is what lets a window navigate away
	 * from a conversation that is still answering.
	 *
	 * No acknowledgement: the client's intent is complete once it has sent `cancel`, and a reply would
	 * be a frame on a stream it has just said it does not want.
	 */
	private cancel(sessionId: string): void {
		const subscription = this.subscriptions.get(sessionId);
		if (subscription !== undefined) this.teardown(subscription);
	}

	/**
	 * Bind a subscription to a live session's feeds.
	 *
	 * A session this process is running answers synchronously, and then the whole thing — attach, read,
	 * baseline — is one block with no `await` in it. That is the case the no-gap guarantee is built
	 * around, and the cold path in {@link readColdBaseline} is the exception that pays for it.
	 *
	 * A session that *starts* running while a cold subscription is still reading its file lands here
	 * too, and the baseline is not sent again: the subscription has exactly one, and whichever read
	 * finishes first is the one that owns it.
	 */
	private bind(sessionId: string, subscription: Subscription, feeds: SessionFeeds): void {
		const onEvent = feeds.onEvent((event) => {
			this.push(sessionId, subscription, { type: "event", event });
			// A leaf that moved changes the whole transcript, so what goes out for it is the session's
			// current state rather than a difference: the event says the tree moved, this says where to.
			if (event.type === "branch_changed") this.pushBaseline(sessionId, subscription);
			if (event.type === "entry_appended") this.pushEntry(sessionId, subscription, event.entryId);
		});

		const onChange = feeds.onChange((snapshot) => {
			this.pushStatus(sessionId, subscription, snapshot);
			// A pending approval is published as a change like any other, so this is where a window
			// learns to show the banner. The baseline only seeds the ones already waiting.
			this.pushApprovalChanges(sessionId, subscription, snapshot);
		});

		// Appended, never assigned — see `Subscription.teardown`. On the live path this lands *before*
		// `open` registers its own step, which is why the teardown list is walked in reverse.
		subscription.teardown.push(() => {
			onEvent();
			onChange();
		});

		// Already baselined means a cold read won the race; this subscription keeps the feeds it just
		// acquired and leaves the frame to the read that is already in flight.
		if (subscription.backlog === null) return;
		this.writeBaseline(sessionId, subscription, this.hub.snapshotNow(sessionId));
	}

	/**
	 * Put a frame on this subscription's stream, holding it back if the baseline has not gone yet.
	 *
	 * The backlog is the answer to the one gap this design could otherwise have: a *cold* session's
	 * transcript has to be read from disk, which is asynchronous, and something could be published
	 * during that read. Buffering until the baseline is out, then flushing in order, keeps the
	 * guarantee identical to the synchronous case — the client sees the state first and every change
	 * after it, in the order they happened.
	 */
	private push(sessionId: string, subscription: Subscription, item: ServerMessageItem): void {
		const frame: ServerFrame = { streamId: sessionId, item };
		if (subscription.backlog === null) {
			this.send(frame);
			return;
		}
		subscription.backlog.push(frame);
	}

	/**
	 * Put the baseline out, then everything that piled up behind it.
	 *
	 * Called once per subscription, by whichever of the two reads finishes first. Flushed in the order
	 * it was produced, so a client cannot see the transcript jump backwards.
	 */
	private writeBaseline(sessionId: string, subscription: Subscription, snapshot: SessionSnapshot): void {
		if (subscription.backlog === null) return;
		for (const approval of snapshot.pendingApprovals) {
			subscription.pending.set(approval.toolCallId, approval);
			this.answers.show(sessionId, approval.toolCallId);
		}
		this.send({ streamId: sessionId, item: { type: "baseline", session: snapshot } });

		const backlog = subscription.backlog;
		subscription.backlog = null;
		for (const frame of backlog) this.send(frame);
	}

	/** Re-send the whole state, because a branch move invalidates the differences since the last one. */
	private pushBaseline(sessionId: string, subscription: Subscription): void {
		this.push(sessionId, subscription, { type: "baseline", session: this.hub.snapshotNow(sessionId) });
	}

	/** The entry an `entry_appended` names, paired with the timestamp a transcript orders by. */
	private pushEntry(sessionId: string, subscription: Subscription, entryId: string): void {
		const timestamp = this.hub.timestampOf(sessionId, entryId);
		this.push(sessionId, subscription, {
			type: "entry",
			entryId,
			...(typeof timestamp === "number" ? { messageTimestamp: timestamp } : {}),
		});
	}

	private pushStatus(sessionId: string, subscription: Subscription, snapshot: SessionSnapshot): void {
		this.push(sessionId, subscription, {
			type: "status",
			usage: snapshot.usage,
			submitting: snapshot.submitting,
			queued: snapshot.queued,
			isRetrying: snapshot.isRetrying,
			retryAttempt: snapshot.retryAttempt,
		});
	}

	/**
	 * Report the difference in this subscription's pending approvals.
	 *
	 * Per subscription, not per session: each window learns about an approval from its own starting
	 * point. One that disappeared is settled — *denied* unless something recorded an answer for it,
	 * because an abort and a closing session both deny and that is the honest default.
	 */
	private pushApprovalChanges(sessionId: string, subscription: Subscription, snapshot: SessionSnapshot): void {
		const current = new Map(snapshot.pendingApprovals.map((approval) => [approval.toolCallId, approval]));

		for (const [toolCallId, approval] of current) {
			if (subscription.pending.has(toolCallId)) continue;
			this.push(sessionId, subscription, { type: "approval_request", request: approval });
			this.answers.show(sessionId, approval.toolCallId);
		}
		for (const toolCallId of subscription.pending.keys()) {
			if (current.has(toolCallId)) continue;
			this.push(sessionId, subscription, {
				type: "approval_settled",
				toolCallId,
				approved: this.answers.wasApproved(sessionId, toolCallId),
			});
			this.answers.hide(sessionId, toolCallId);
		}

		subscription.pending.clear();
		for (const [toolCallId, approval] of current) subscription.pending.set(toolCallId, approval);
	}

	/**
	 * Tell a client its `open` did not work, and end the attempt.
	 *
	 * Error first, then end: the error carries the attribution and the end stops the attempt from going
	 * on looking like a stream that is merely quiet. The distinction the client draws is whether this
	 * stream ever carried a baseline — it did not, so the client knows its own `open` failed and does
	 * not reopen.
	 */
	private failStream(sessionId: string, message: string): void {
		this.send({ streamId: sessionId, error: { message } });
		this.endStream(sessionId);
	}

	/**
	 * End one logical stream and forget it.
	 *
	 * The entry goes *before* the frame, because after an `end` this connection must have nothing
	 * further to say about that session — that is the whole meaning of the frame, and a client that saw
	 * anything after it would have no way to tell which stream it belonged to.
	 *
	 * `forget` is what a duplicate `open` needs and what the other two callers must not have: the failed
	 * attempt here is a *second* request for a stream that is already open and working, so dropping the
	 * entry would end a healthy subscription and leave its client with a stream that carried a baseline
	 * and then ended — which a client reads as "this session is gone, do not reopen".
	 */
	private endStream(sessionId: string, forget = true): void {
		if (forget) {
			const subscription = this.subscriptions.get(sessionId);
			if (subscription !== undefined) this.teardown(subscription);
		}
		this.send({ streamId: sessionId, end: true });
	}

	/** Say something on every stream this connection has watching one session. */
	announce(sessionId: string, message: string): void {
		if (!this.subscriptions.has(sessionId)) return;
		this.send({ streamId: sessionId, item: { type: "error", message } });
	}

	/** This connection's opening overview, or a fresh one after the list moved: the rows it may see. */
	sendSessions(rows: readonly SessionRow[]): void {
		this.send({ streamId: null, item: { type: "sessions", sessions: [...rows] } });
	}

	/** One row changed. The whole row, because a row is small and a replacement is idempotent. */
	sendRow(row: SessionRow): void {
		this.send({ streamId: null, item: { type: "session_row", session: row } });
	}

	/** One row went away. The id is the whole payload: dropping it is all a client can do. */
	sendGone(sessionId: string): void {
		this.send({ streamId: null, item: { type: "session_gone", sessionId } });
	}

	/** The application-level liveness frame. Connection-level by construction: no stream id. */
	heartbeat(): void {
		this.send({ streamId: null, item: { type: "heartbeat", everyMs: this.options.heartbeatIntervalMs } });
	}

	/**
	 * One round of the protocol-level liveness question.
	 *
	 * Counts a miss first and only pings if the count is still survivable, so the connection that
	 * exceeds the tolerance is never pinged again on its way out. Dropping it is `terminate` rather than
	 * `close`: a peer that has stopped answering Pongs will not read a Close frame either, and waiting
	 * for one would mean waiting on the thing that has already gone.
	 */
	tick(): void {
		if (this.closed) return;
		if (this.missedPongs >= this.options.maxMissedPongs) {
			this.options.log("mux: 客户端连续未回应 Ping，关闭连接");
			this.sink.terminate();
			this.close();
			return;
		}
		this.missedPongs += 1;
		this.sink.ping();
	}

	/** A Pong arrived: the peer is alive and the count starts again. */
	notePong(): void {
		this.missedPongs = 0;
	}

	/** How many pings are unanswered. */
	get missed(): number {
		return this.missedPongs;
	}

	/** How many bytes are waiting behind a connection that stopped accepting writes. */
	get queuedByteLength(): number {
		return this.queuedBytes;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/**
	 * Give up every subscription and stop.
	 *
	 * Subscriptions go first so their feeds are released before anything tries to close the sessions
	 * they were watching.
	 */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const subscription of [...this.subscriptions.values()]) this.teardown(subscription);
		this.subscriptions.clear();
		this.queue.length = 0;
		this.queuedBytes = 0;
		// The stall bookkeeping goes too, so a connection inspected after closing reports a settled state
		// rather than one that looks like it is still waiting for a socket that will never drain.
		this.stalled = false;
		this.stalledSince = 0;
		this.clearStallTimer();
	}

	/**
	 * Remember that the socket stopped accepting writes.
	 *
	 * The clock starts here rather than when the queue first has something in it, because those are
	 * the same instant — the frame that got `false` is already in the socket's buffer, so the next one
	 * is the first this layer holds, and the two readings differ by at most one frame.
	 */
	private markStalled(): void {
		if (this.stalled) return;
		this.stalled = true;
		this.stalledSince = Date.now();
		this.stallTimer = setTimeout(() => this.onStallDeadline(), this.options.stallDeadlineMs);
		// A timer waiting on a peer that may never come back must not be why the process stays up.
		this.stallTimer.unref();
	}

	/** Hold a frame, and enforce both halves of the budget. */
	private enqueue(frame: ServerFrame): void {
		this.queue.push(frame);
		this.queuedBytes += sizeOf(frame);
		if (this.queuedBytes > this.options.stallBudgetBytes) this.onStallDeadline();
	}

	/**
	 * Write what is queued, in order, until the socket refuses again.
	 *
	 * The trigger is "this attempt succeeded", not a `'drain'` event. Nothing here listens for one, so
	 * there is no listener to leak when a connection ends mid-stall and no second timer to keep in step
	 * with the first: the next attempt is simply the next thing this connection tries to write.
	 */
	private pump(): void {
		// Whether this attempt actually got a frame out. It is the only thing that may clear the stall,
		// and the distinction matters: a pump over an *empty* queue writes nothing, so treating it as a
		// success would clear the stall state and cancel the deadline on the very first frame after a
		// stall began — leaving a connection that never recovers and never gives up either.
		let wrote = false;
		while (this.queue.length > 0 && !this.closed) {
			const frame = this.queue[0] as ServerFrame;
			if (!this.sink.send(frame)) return;
			this.queuedBytes -= sizeOf(frame);
			this.queue.shift();
			wrote = true;
		}
		if (!wrote || this.closed) return;
		this.stalled = false;
		this.clearStallTimer();
	}

	/**
	 * The peer is not reading, or not fast enough. Close the whole connection.
	 *
	 * The *whole* connection, and that is not a simplification: one connection is one socket with one
	 * write buffer, so there is no such thing as sparing one stream from a stalled peer. The client
	 * recovers by reconnecting and re-subscribing, a path that already exists and needs nothing new —
	 * whereas ending one stream would need a way to say "you fell behind" on a frame that is defined
	 * not to carry a reason.
	 */
	private onStallDeadline(): void {
		if (this.closed) return;
		const waited = Date.now() - this.stalledSince;
		const backlog = Math.round(this.queuedBytes / 1024);
		this.options.log(`mux: 停滞 ${waited} ms，积压 ${backlog} KB，关闭连接（1013）：订阅端停止读取`);
		this.sink.close(CLOSE_TRY_AGAIN_LATER, REASON_STOPPED_READING);
		this.close();
	}

	private clearStallTimer(): void {
		if (this.stallTimer === null) return;
		clearTimeout(this.stallTimer);
		this.stallTimer = null;
	}
}

/**
 * What rides a logical stream: the same payloads `ServerMessage` has always carried.
 *
 * Written out rather than extracted from `ServerFrame`, because that type is an intersection with a
 * union and `Extract` cannot see through it — the property this needs is only reachable after the
 * union has been distributed, which a conditional type over an intersection does not do. Naming the
 * type here rather than importing it also keeps the answer in one place: this is the one payload set a
 * subscription ever writes, and a connection-level payload cannot reach it by construction.
 */
type ServerMessageItem = ServerMessage;

/** One frame's worth of JSON, which is what the byte budget is denominated in. */
function sizeOf(frame: ServerFrame): number {
	return Buffer.byteLength(JSON.stringify(frame));
}

/**
 * What went wrong, in words a client can show.
 *
 * Only the `Error` case is interesting: `snapshotOf` rejects with one for a session it cannot find, and
 * its message is already written for that. Anything else is a bug, so it is named as one rather than
 * interpolated — a frame is not the place to hand a stack trace to a browser.
 */
function describe(error: unknown): string {
	return error instanceof Error ? error.message : "未知的错误";
}

/** One approval somebody is showing: the answer to report, and how many readers are showing it. */
interface ShownApproval {
	/** How it was answered, or denied while nothing has said otherwise. */
	approved: boolean;
	/** How many subscriptions are showing it right now. */
	showing: number;
}

/**
 * How the approvals on screen were answered, and who is showing them.
 *
 * One entry per approval some subscription has on screen, because that is one fact: the frame that
 * reports an answer is that subscription's own difference, so a subscription showing an approval is
 * the only reader its answer will ever have, and the answer is worth holding exactly as long as the
 * count is above zero.
 *
 * Entries live one table per session, and that keying is a decision this layer settles rather than
 * inherits. A `toolCallId` two sessions happen to share is two approvals — several Anthropic-compatible
 * endpoints number their tool calls the same way — and one being granted must never reach the other's
	* window.
 */
export interface ApprovalAnswers {
	/** Note an answer, for the subscriptions that will report it — and only when one of them can. */
	remember(sessionId: string, toolCallId: string, approved: boolean): void;
	/** How this approval was answered. Denied is the answer when nothing recorded one. */
	wasApproved(sessionId: string, toolCallId: string): boolean;
	/** One more subscription is showing this approval. */
	show(sessionId: string, toolCallId: string): void;
	/** One subscription is done with it, dropping it once nobody is left to report the answer. */
	hide(sessionId: string, toolCallId: string): void;
}

function createApprovalAnswers(): ApprovalAnswers {
	/** Per session, the approvals one of its subscriptions has on screen. */
	const shown = new Map<string, Map<string, ShownApproval>>();

	return {
		remember(sessionId, toolCallId, approved) {
			const approval = shown.get(sessionId)?.get(toolCallId);
			// Nothing to record: no subscription is showing it, so no frame will ever report it. Holding
			// one anyway would only let unanswered questions outlive the process that was told.
			if (approval === undefined) return;
			approval.approved = approved;
		},
		wasApproved(sessionId, toolCallId) {
			return shown.get(sessionId)?.get(toolCallId)?.approved ?? false;
		},
		show(sessionId, toolCallId) {
			const perSession = shown.get(sessionId) ?? new Map<string, ShownApproval>();
			if (!shown.has(sessionId)) shown.set(sessionId, perSession);
			const approval = perSession.get(toolCallId);
			if (approval === undefined) perSession.set(toolCallId, { approved: false, showing: 1 });
			else approval.showing += 1;
		},
		hide(sessionId, toolCallId) {
			const perSession = shown.get(sessionId);
			const approval = perSession?.get(toolCallId);
			if (perSession === undefined || approval === undefined) return;
			approval.showing -= 1;
			if (approval.showing <= 0) perSession.delete(toolCallId);
			// The same hygiene the per-session entry got: a table with nothing in it has no reason to
			// outlive the last reader that would have reported from it.
			if (perSession.size === 0) shown.delete(sessionId);
		},
	};
}

/**
 * Every connection, and the two timers that judge them.
 *
 * One timer each for the whole process rather than one per connection: a hundred idle windows should
 * not be a hundred intervals, and a per-connection timer would make "how often does this server ping"
 * a question with a hundred answers.
 */
export class MuxServer {
	private readonly connections = new Set<MuxConnection>();
	private readonly pingTimer: NodeJS.Timeout;
	private readonly heartbeatTimer: NodeJS.Timeout;
	/**
	 * Approval answers, shared by every connection.
	 *
	 * One table for the process rather than one per connection, and the reason is a window that did not
	 * answer: the frame reporting an approval's answer is the *answering* subscription's own difference,
	 * so a second window watching the same approval must be told what it was answered with. If each
	 * connection kept its own table, the second window would find nothing recorded and report a denial —
	 * which is the cross-session bug this keying exists to prevent, reappearing one level up.
	 */
	private readonly answers: ApprovalAnswers = createApprovalAnswers();
	private shuttingDown = false;
	/** Let go of the projection's row listeners, so this server stops being reachable from it. */
	private readonly stopRows: () => void;
	private readonly stopGone: () => void;

	private readonly hub: SessionHub;
	private readonly projection: SessionProjection;
	private readonly options: ResolvedMuxOptions;

	constructor(hub: SessionHub, projection: SessionProjection, options: ResolvedMuxOptions) {
		this.hub = hub;
		this.projection = projection;
		this.options = options;
		this.pingTimer = setInterval(() => this.pingAll(), options.pingIntervalMs);
		// Never the reason the process stays up: a server with no windows open must still exit.
		this.pingTimer.unref();

		this.heartbeatTimer = setInterval(() => this.heartbeatAll(), options.heartbeatIntervalMs);
		this.heartbeatTimer.unref();

		// The overview is a connection-level stream that is never opened and never cancelled, so it is
		// fed from the one place that knows a row changed rather than from a subscription table.
		//
		// The unsubscribe is kept rather than dropped: a projection outlives any one mux server, and a
		// listener left behind would keep this whole object graph — and every connection it holds — alive
		// after `close()`. In the real process the projection is closed first and clears its listeners
		// anyway, which is why the bug would not have shown up there.
		this.stopRows = projection.onRow((row) => {
			if (!this.listed(row)) return;
			for (const connection of this.connections) connection.sendRow(row);
		});
		// The removal rides the same connection-level seat the rows do, and for the same reason: it is
		// about the machine's list, not about any stream. Kept like `stopRows` is — a projection
		// outlives this server, and a listener left behind would hold the whole graph alive.
		this.stopGone = projection.onGone((sessionId) => {
			for (const connection of this.connections) connection.sendGone(sessionId);
		});
	}

	/**
	 * Take a connection that has just been upgraded, and start serving it.
	 *
	 * The overview baseline goes out before any subscription can be opened: it is the frame that makes
	 * the sidebar correct without a single `GET`, and a connection that has to be asked what exists is
	 * the connection this transport exists to replace.
	 *
	 * Returns the connection so a caller that owns the socket can hand uplink frames to it.
	 */
	async accept(sink: FrameSink): Promise<MuxConnection> {
		if (this.shuttingDown) {
			sink.close(CLOSE_GOING_AWAY, REASON_SHUTTING_DOWN);
			throw new Error("The server is shutting down");
		}

		const connection = new MuxConnection(sink, this.hub, this.options, this.answers);
		this.connections.add(connection);

		// A heartbeat first, deliberately: it is the frame the client's watchdog is waiting for, so a
		// connection that has sent one is a connection the client can already call live. The overview
		// follows, and the socket's write order is the order they arrive in.
		connection.heartbeat();
		connection.sendSessions(await this.overview());

		sink.ping();
		return connection;
	}

	/** One uplink frame, for a connection this server owns. */
	handle(connection: MuxConnection, text: string): void {
		if (!this.connections.has(connection)) return;
		connection.handle(text);
	}

	/** A Pong arrived on one connection: the peer is alive. */
	notePong(connection: MuxConnection): void {
		// Guarded like `handle`, and for the same reason: a Pong can arrive after the connection has been
		// forgotten, and reviving a counter on a connection nobody holds would keep it looking alive to
		// whatever still has a reference to it.
		if (!this.connections.has(connection)) return;
		connection.notePong();
	}

	/** Forget a connection that has ended. */
	forget(connection: MuxConnection): void {
		this.connections.delete(connection);
		connection.close();
	}

	/** How many connections are open. Read by tests; nothing in production does. */
	get size(): number {
		return this.connections.size;
	}

	/** Say something on every connection watching one session. */
	announce(sessionId: string, message: string): void {
		for (const connection of this.connections) connection.announce(sessionId, message);
	}

	/** Note an approval answer, for every connection showing it. */
	rememberApproval(sessionId: string, toolCallId: string, approved: boolean): void {
		this.answers.remember(sessionId, toolCallId, approved);
	}

	/**
	 * Whether this connection's window is allowed to see a row.
	 *
	 * The rule is the hub's ({@link SessionHub.listsWorkspace}) and the filter is applied here, at both
	 * points a row reaches a window: the overview a connection opens on, and every changed row after
	 * it. Filtering only the overview would let a workspace the user put aside come back the moment one
	 * of its sessions changed — a group that returns on its own is worse than one that never left.
	 */
	private listed(row: SessionRow): boolean {
		return this.hub.listsWorkspace(row.workDirAbsPath);
	}

	/** This connection's opening overview: every row this process lists, once. */
	private overview(): Promise<SessionRow[]> {
		return this.projection.rows().then((rows) => rows.filter((row) => this.listed(row)));
	}

	/**
	 * Send every connection a fresh overview.
	 *
	 * The one thing a window cannot be told by a row: a workspace entering or leaving the list is a
	 * change to the list itself, and there is no `session_row` for a group. Re-sending the overview is
	 * how the frame that already means "here is the machine's list" says "…and it moved" — the same
	 * frame a connection opens on, so no client learns a second shape of news about a sidebar.
	 */
	async broadcastSessions(): Promise<void> {
		const rows = await this.overview();
		for (const connection of this.connections) connection.sendSessions(rows);
	}

	/** One round of the protocol-level liveness question, and the sweep of whoever it finished. */
	private pingAll(): void {
		for (const connection of [...this.connections]) {
			connection.tick();
			if (connection.isClosed) this.forget(connection);
		}
	}

	/**
	 * One round of the application-level heartbeat.
	 *
	 * This doubles as the floor on write attempts, which is why it goes through the ordinary send path
	 * rather than around the queue: when nothing else is being written, it is the one attempt that will
	 * still be made, and a connection that recovered gets its backlog flushed by it.
	 */
	private heartbeatAll(): void {
		for (const connection of [...this.connections]) {
			connection.heartbeat();
			if (connection.isClosed) this.forget(connection);
		}
	}

	/** End every connection, so a closing process is not held open by a window that never leaves. */
	close(): void {
		this.shuttingDown = true;
		this.stopRows();
		this.stopGone();
		clearInterval(this.pingTimer);
		clearInterval(this.heartbeatTimer);
		for (const connection of [...this.connections]) connection.close();
		this.connections.clear();
	}
}

/** Build a server with its defaults, or with whatever a test needs to drive them faster. */
export function createMuxServer(
	hub: SessionHub,
	projection: SessionProjection,
	options: MuxOptions = {},
): MuxServer {
	return new MuxServer(hub, projection, {
		pingIntervalMs: options.pingIntervalMs ?? PING_INTERVAL_MS,
		maxMissedPongs: options.maxMissedPongs ?? MAX_MISSED_PONGS,
		heartbeatIntervalMs: options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
		stallBudgetBytes: options.stallBudgetBytes ?? STALL_BUDGET_BYTES,
		stallDeadlineMs: options.stallDeadlineMs ?? STALL_DEADLINE_MS,
		log: options.log ?? ((line) => console.warn(line)),
	});
}
