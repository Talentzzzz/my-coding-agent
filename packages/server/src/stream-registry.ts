import type { PendingApproval, SessionSnapshot } from "@my-agent/core";
import type { HostedSession, SessionHub } from "./hub.ts";
import type { EventStream } from "./http/event-stream.ts";

/**
 * How long a claim is outlived by the client that made it.
 *
 * A browser reconnects an `EventSource` on its own after a dropped connection, so releasing the
 * claim the moment the response ends would close the session — and the reconnect would then get a
 * fresh snapshot of a session that had been torn down and rebuilt for no reason. Two seconds covers
 * the reconnect without meaningfully extending how long an idle session stays resident.
 *
 * The wait starts when the client goes away, never when the stream opens: a live stream holds its
 * claim for as long as it is live, which is the whole point of holding one.
 */
const RELEASE_GRACE_MS = 2_000;

/**
 * How long a stream that attached to an idle session waits for a run before it ends itself.
 *
 * Under this phase a stream exists for a run, so the only reason a window is on one is that it is
 * about to send. A stream that arrives on a session with nothing running is therefore either a tab
 * mid-switch or a browser reconnect the server no longer needs to serve, and either way it must not
 * be a permanent subscription — which is what it would be if this wait were unbounded, because a
 * claim held by an idle stream is an `Agent` kept assembled for nobody.
 *
 * Fifteen seconds is long enough for a send that follows an attach by one round trip, and short
 * enough that a session abandoned mid-switch is reaped while the person is still looking elsewhere.
 */
const IDLE_GRACE_MS = 15_000;

/**
 * How this registry's idle wait is measured.
 *
 * An option only so a smoke can drive it in milliseconds; nothing in production sets it. The same
 * reason `HubOptions.approvalGraceMs` is an option: a timer a test cannot reach is a timer a test
 * cannot check, and guessing at one with sleeps is how a suite becomes slow and flaky at once.
 */
export interface StreamRegistryOptions {
	/** See {@link IDLE_GRACE_MS}. Defaults to fifteen seconds. */
	idleGraceMs?: number;
}

/**
 * The claims this server's event streams hold.
 *
 * This is the piece that used to be `Connection`: it turns one HTTP response into one claim on one
 * session, forwards that session's events for as long as the response lives, and gives the claim
 * back when it ends. Nothing about a session's lifetime is decided here — the hub owns that, and a
 * claim is still the one thing that keeps a session from being closed under it.
 *
 * What the phase added is when that response ends: a run ending ends the stream, and a stream that
 * arrived on nothing running ends itself once its grace is up. Both are the same frame
 * (`ServerMessage`'s `stream_end`) for the same reason — the browser has to be told to close,
 * because it cannot tell a normal end from a dropped connection on its own.
 */
export interface StreamRegistry {
	/**
	 * Attach one session to one response and start forwarding, or throw if there is no such session.
	 *
	 * The stream is built by `attach` only after the claim has succeeded, so a request for an unknown
	 * session is rejected before a single byte of it is written — which is what lets the router
	 * answer it as an ordinary JSON 404.
	 */
	open(sessionId: string, attach: () => EventStream): Promise<void>;
	/** Session ids a stream is attached to right now. */
	streaming(): readonly string[];
	/**
	 * Say something on every stream watching one session.
	 *
	 * For a failure that belongs to a run rather than to a request: the request that started the run
	 * has already been answered, so there is no response left to report it on. A session nobody is
	 * watching has nowhere to send it, and the transcript is still the record.
	 */
	announce(sessionId: string, message: string): void;
	/**
	 * Note how an approval was answered, for the frame that reports it back.
	 *
	 * The session only keeps answers, not the question's history, so without this every
	 * `tool_approval_settled` would read as a denial. Set by the approvals endpoint, read when the
	 * frame goes out, so a second tab or a script learns the answer it did not give.
	 */
	rememberApproval(toolCallId: string, approved: boolean): void;
	/** End every stream and let go of every claim, so a closing process waits for nothing. */
	close(): Promise<void>;
}

export function createStreamRegistry(hub: SessionHub, options: StreamRegistryOptions = {}): StreamRegistry {
	const idleGraceMs = options.idleGraceMs ?? IDLE_GRACE_MS;
	/** How many streams are attached to each session id. */
	const attached = new Map<string, number>();
	/** The streams themselves, so shutdown can end every response. */
	const streams = new Set<EventStream>();
	/** Which streams watch which session, so a message can be said on all of them. */
	const watchers = new Map<string, Set<EventStream>>();
	/** Resolved by `close()`, which is what lets a stream waiting out a client stop waiting. */
	let noteShutdown = (): void => {};
	const shutdown = new Promise<void>((settle) => {
		noteShutdown = settle;
	});
	let shuttingDown = false;

	/**
	 * Undo an attach: subscribe nothing, count nothing, and end the response.
	 *
	 * Ending it here is not tidiness. An SSE response that is never ended holds its socket for the
	 * life of the process, and `server.close()` never calls back while one is open — which is what
	 * would make shutdown hang.
	 */
	const detach = (sessionId: string, stream: EventStream): void => {
		stream.close();
		streams.delete(stream);
		const watching = watchers.get(sessionId);
		watching?.delete(stream);
		if (watching !== undefined && watching.size === 0) watchers.delete(sessionId);

		const remaining = (attached.get(sessionId) ?? 1) - 1;
		if (remaining <= 0) attached.delete(sessionId);
		else attached.set(sessionId, remaining);
	};

	/** Which approvals were granted, so a settled frame can say so rather than guess. */
	const granted = new Set<string>();

	return {
		async open(sessionId: string, attach: () => EventStream): Promise<void> {
			if (shuttingDown) throw new Error("The server is shutting down");

			const host = await hub.claim(sessionId);

			let stream: EventStream;
			try {
				// Only now does anything get written: a claim that failed above must still be answerable
				// as a JSON error by the router.
				stream = attach();
			} catch (error) {
				// There is no response to stream to, so the claim has no reason to outlive this call.
				hub.release(host);
				throw error;
			}

			attached.set(host.id, (attached.get(host.id) ?? 0) + 1);
			streams.add(stream);
			const watching = watchers.get(host.id) ?? new Set<EventStream>();
			watching.add(stream);
			watchers.set(host.id, watching);

			/** The session's state as this stream sees it open, and what the opening frame carries. */
			const opening = host.session.snapshot;

			/** The approvals this stream has told the browser about, so it can report the difference. */
			const pending = new Map<string, PendingApproval>(
				opening.pendingApprovals.map((approval) => [approval.toolCallId, approval]),
			);

			let released = false;
			const release = (): void => {
				if (released) return;
				released = true;
				clearTimeout(idleTimer);
				for (const off of unsubscribe) off();
				detach(host.id, stream);
				hub.release(host);
			};

			/**
			 * End this stream the one way that stops the browser from coming back.
			 *
			 * The frame comes first, and it is the frame rather than the end of the response that
			 * carries the meaning: `EventSource` reconnects after a normal end, so a stream closed
			 * without it would be reopened immediately, claimed again, and waited out again — a
			 * heartbeat that keeps the idle session resident, which is the opposite of the point.
			 *
			 * Nothing else is needed to give the claim back. Ending the response settles `clientGone`,
			 * and `holdForReconnect` then sees `stream.closed` and skips its grace, so the session is
			 * reaped as soon as it is over instead of two seconds later.
			 */
			const end = (): void => {
				stream.send({ type: "stream_end" });
				stream.close();
			};

			/**
			 * Whether `submitting` has been true on this stream.
			 *
			 * The rule is about a run *this stream observed*, not about the session being idle: a
			 * stream that attached to a run already in flight has seen one too, and a stream that
			 * attached to a parked approval — `submitting` is true there as well — must outlive it,
			 * so what ends a stream is the run ending, never the run starting.
			 */
			let sawRun = false;

			/**
			 * Rule 2's timer: a stream that attached to nothing running must not wait forever.
			 *
			 * One shot, and unref'd for the same reason every other timer here is — a stream waiting
			 * on a person must never be what keeps the process up. A run starting cancels it; if the
			 * grace runs out first, the stream ends itself exactly as a finished run would.
			 */
			const idleTimer = setTimeout(() => {
				if (!released) end();
			}, idleGraceMs);
			idleTimer.unref();

			/** A run is in flight, so there is something to wait for rather than a grace to run out. */
			const armsRun = (): void => {
				sawRun = true;
				clearTimeout(idleTimer);
			};

			const unsubscribe = [
				host.session.onEvent((event) => {
					stream.send({ type: "session_event", event });
					// A leaf that moved changes the whole transcript, so the frame for it is the snapshot
					// itself rather than a difference: the session event says the tree moved, this says
					// where to. Every window on this session hears it, not only the one that asked.
					if (event.type === "branch_changed") stream.send({ type: "session", session: host.session.snapshot });
					if (event.type === "entry_appended") sendEntry(host, stream, event.entryId);
				}),
				host.session.onChange((snapshot) => {
					stream.send({
						type: "status",
						usage: snapshot.usage,
						submitting: snapshot.submitting,
						queued: snapshot.queued,
						isRetrying: snapshot.isRetrying,
						retryAttempt: snapshot.retryAttempt,
					});
					// A pending approval is published by the session as a change like any other, so this
					// is where the browser learns to show the banner. The snapshot above only seeds the
					// approvals that were already waiting when this stream attached.
					sendApprovalChanges(stream, pending, snapshot, granted);

					// Rule 1: the run this stream was following is over, so the stream is too. The change
					// that reports `submitting: false` is the last one a run produces, so this lands after
					// `agent_end` has gone out and there is nothing left to watch.
					if (snapshot.submitting) armsRun();
					else if (sawRun) end();
				}),
			];

			stream.send({ type: "session", session: opening });

			// A stream the client has already abandoned releases its claim without waiting for a grace
			// period that exists for a reconnect this response can never serve.
			if (!stream.started) {
				release();
				return;
			}

			// The opening snapshot carries the same fact the `onChange` above reads, so a stream that
			// attached *to* a run arms the rule here as well. Otherwise a run that ended without
			// changing again would leave this stream open with nothing left to report.
			if (opening.submitting) armsRun();

			void holdForReconnect(stream, shutdown).then(release);
		},

		streaming(): readonly string[] {
			return [...attached.keys()];
		},

		announce(sessionId: string, message: string): void {
			for (const stream of watchers.get(sessionId) ?? []) stream.send({ type: "error", message });
		},

		rememberApproval(toolCallId: string, approved: boolean): void {
			if (approved) granted.add(toolCallId);
			else granted.delete(toolCallId);
		},

		async close(): Promise<void> {
			shuttingDown = true;
			// Ending every response is what settles `clientGone` for each stream, so the claims come
			// back before the hub is asked to close anything.
			noteShutdown();
			for (const stream of [...streams]) stream.close();
		},
	};
}

/**
 * Wait out the client's reconnect window, or the moment this server stops caring about it.
 *
 * The wait begins when the response ends, which is when the client left. Nothing starts a timer while
 * the client is still attached: a healthy stream holds its claim until it is not healthy.
 */
async function holdForReconnect(stream: EventStream, shutdown: Promise<void>): Promise<void> {
	await Promise.race([stream.clientGone, shutdown]);
	// A stream the registry ended is already over: there is no reconnect left to wait out.
	if (stream.closed) return;
	await new Promise<void>((settle) => {
		const timer = setTimeout(settle, RELEASE_GRACE_MS);
		timer.unref();
	});
}

/** The entry an `entry_appended` names, paired with the message it holds. */
function sendEntry(host: HostedSession, stream: EventStream, entryId: string): void {
	const entry = host.session.sessionManager.getEntry(entryId);
	const timestamp = entry?.type === "message" ? entry.message.timestamp : undefined;
	stream.send({
		type: "entry",
		entryId,
		...(typeof timestamp === "number" ? { messageTimestamp: timestamp } : {}),
	});
}

/**
 * Turn a change in the session's pending approvals into the two frames that describe it.
 *
 * The snapshot is the state; these frames are the difference since the last one, which is what lets a
 * client that is already attached learn about an approval instead of only finding it by reloading. An
 * approval that appeared is a request; one that disappeared is settled, and it is settled *denied*
 * unless it left because someone approved it. An abort and a closing session both deny, so that
 * default is the honest one, and the browser only uses this frame to take the banner down.
 */
function sendApprovalChanges(
	stream: EventStream,
	pending: Map<string, PendingApproval>,
	snapshot: SessionSnapshot,
	granted: Set<string>,
): void {
	const current = new Map(snapshot.pendingApprovals.map((approval) => [approval.toolCallId, approval]));

	for (const [toolCallId, approval] of current) {
		if (!pending.has(toolCallId)) stream.send({ type: "tool_approval_request", request: approval });
	}
	for (const toolCallId of pending.keys()) {
		if (current.has(toolCallId)) continue;
		stream.send({ type: "tool_approval_settled", toolCallId, approved: granted.delete(toolCallId) || false });
	}

	pending.clear();
	for (const [toolCallId, approval] of current) pending.set(toolCallId, approval);
}
