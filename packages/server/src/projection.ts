import {
	type AgentSessionEvent,
	groupSessionsByWorkspace,
	SessionManager,
	type SessionRow,
	type WorkspaceGroup,
} from "@my-agent/core";
import type { HostedSession, SessionHub } from "./hub.ts";

/**
 * Told a whole row, rather than which field of it moved.
 *
 * A row is a stored identity plus three fields, so a diff would cost more to apply than to replace —
 * and a whole row makes each update idempotent, which is what lets a listener keep the last one it
 * received without caring whether any arrived in between.
 */
export interface RowListener {
	(row: SessionRow): void;
}

/** Told a row went away: the session behind it no longer exists, and the id is all there is to say. */
export interface RowGoneListener {
	(sessionId: string): void;
}

export interface SessionProjection {
	/**
	 * Every row, grouped by workspace and ordered the way the sidebar draws them.
	 *
	 * Seeded on the first call and served from memory after that: this process is the only writer of
	 * these values, so a rescan would re-read every transcript to learn nothing.
	 */
	groups(): Promise<WorkspaceGroup[]>;
	/** Every row, unordered, for a caller that draws its own groups. */
	rows(): Promise<SessionRow[]>;
	/** One row by id, or `undefined` for a session this process has never heard of. */
	row(sessionId: string): Promise<SessionRow | undefined>;
	/** Be told a row changed. Returns the way to stop listening. */
	onRow(listener: RowListener): () => void;
	/** Be told a row went away — deleted, not closed. Returns the way to stop listening. */
	onGone(listener: RowGoneListener): () => void;
	/**
	 * Re-read one row off disk and republish it.
	 *
	 * This is the road a stored rename takes to the sidebar: the row's title lives in the file, the
	 * live feeds carry no title of their own, so the row is read once and published whole. A session
	 * that is running keeps its live fields — the scan says `running: false` the way every cold read
	 * does, and overlaying them is what keeps a rename from idling a working row.
	 */
	refresh(sessionId: string): Promise<void>;
	/** Drop one row and stop following its session: the session behind it has been deleted. */
	forget(sessionId: string): void;
	/** Let go of everything this projection attached to the hub. */
	close(): void;
}

/**
 * What this process knows about every session on this machine, as rows.
 *
 * This is the store the sidebar reads, and the reason a row can say "running" at all. Today that fact
 * exists only inside a stream, so a session that ran a turn while the window was looking at a
 * different one left a sidebar row that never moved — not slowly, never, and not even a manual refresh
 * away. A projection that answers "what is each session doing" without asking whether anyone is
 * watching is what makes that row honest.
 *
 * Two rules shape everything here. **This process is the only writer** — sessions are created and
 * appended through the hub — so a directory scan's entire job is noticing files that arrived from
 * outside, which is why seeding happens once and re-scanning never does. And **a row is replaced
 * whole**, so nothing downstream merges two sources or tracks which of them is newer.
 *
 * It watches the hub's host-level point rather than its subscription mirror, deliberately: that mirror
 * answers "who is watching", and a reader of it would find this projection watching every session it
 * knows about — which is exactly the state an abandonment timer waits to *not* see.
 */
export function createSessionProjection(hub: SessionHub): SessionProjection {
	/** The rows, by session id. */
	const rows = new Map<string, SessionRow>();
	/** Whoever wants to hear a row change. */
	const listeners = new Set<RowListener>();
	/** Whoever wants to hear that a row went away. */
	const goneListeners = new Set<RowGoneListener>();
	/** The live sessions being followed, with the unsubscribers that let them go again. */
	const following = new Map<string, { host: HostedSession; off: () => void }>();
	/**
	 * Ids whose row is being read for the first time.
	 *
	 * A session created but never spoken in has no file, so no row and no scan accounts for it. Its
	 * first message is what puts it on disk, and that message arrives as one of a burst of entries —
	 * this keeps the burst to one read instead of one per entry.
	 */
	const probing = new Set<string>();
	/**
	 * The scan, once.
	 *
	 * A promise rather than a flag so two callers arriving together share one scan instead of starting
	 * two, and so a scan that failed is not remembered as an empty store.
	 */
	let seeded: Promise<void> | undefined;

	/**
	 * Store one row and tell the listeners, if anything about it actually moved.
	 *
	 * The comparison is the design, not an optimization: a session publishes changes for reasons that
	 * have nothing to do with its row — a token arriving, a retry being scheduled — and re-sending an
	 * identical row for each would turn one turn into a burst of no-ops for every listener.
	 */
	const publish = (next: SessionRow): void => {
		const current = rows.get(next.id);
		if (current !== undefined && sameRow(current, next)) return;
		rows.set(next.id, next);
		for (const listener of listeners) listener(next);
	};

	/**
	 * A running session's row: whatever the store knows, with the two fields only a loop can say.
	 *
	 * The stored half has to exist before this can be called — a session nobody has a row for has no
	 * stored half yet, which is what {@link probe} is for.
	 */
	const liveRow = (sessionId: string, live: LiveFields): SessionRow | undefined => {
		const stored = rows.get(sessionId);
		if (stored === undefined) return undefined;
		return { ...stored, ...live };
	};

	/** Read those two fields off a running session. */
	const liveOf = (host: HostedSession): LiveFields => {
		const snapshot = hub.agent.snapshot(host.id);
		return { running: snapshot.submitting, pending: snapshot.pendingApprovals.length };
	};

	/**
	 * Follow one live session, for as long as it is live.
	 *
	 * Bound in the same synchronous block that the hub hands over the session, so there is no window
	 * in which a change could land before anything was listening.
	 */
	const follow = (sessionId: string, host: HostedSession): void => {
		if (following.has(sessionId)) return;

		const offEvent = hub.agent.onEvent(sessionId, (event) => onEvent(sessionId, event));
		const offChange = hub.agent.onChange(sessionId, (snapshot) => {
			const next = liveRow(sessionId, {
				running: snapshot.submitting,
				pending: snapshot.pendingApprovals.length,
			});
			if (next !== undefined) publish(next);
		});
		following.set(sessionId, { host, off: () => {
			offEvent();
			offChange();
		} });

		const next = liveRow(sessionId, liveOf(host));
		if (next !== undefined) publish(next);
	};

	/**
	 * Advance the two fields a single event can move.
	 *
	 * A message landing pushes `modified` forward, and a branch moving can change which message the
	 * title reads from. Nothing else an event carries has a row field of its own, and re-deriving the
	 * title per event would be a walk of the whole transcript for every token of a reply.
	 */
	const onEvent = (sessionId: string, event: AgentSessionEvent): void => {
		const current = rows.get(sessionId);
		if (current === undefined) {
			// No row means this session was created and has only just been written to: the creation
			// itself leaves nothing on disk. The first entry is therefore the moment the row can be
			// read at all, and reading it here is what makes the session appear in the sidebar when it
			// starts rather than when some later host change happens to re-probe it. Until then it is
			// deliberately absent — an empty「新会话」row is not a conversation.
			if (event.type !== "entry_appended" || probing.has(sessionId)) return;
			probing.add(sessionId);
			void refresh(sessionId).finally(() => probing.delete(sessionId));
			return;
		}
		const manager = hub.agent.sessionManager;
		// The bag the session writes through: the service's own cache answers the id with it.
		const state = manager.stateOf(sessionId);

		if (event.type === "branch_changed") {
			publish({ ...current, title: manager.getTitle(state) });
			return;
		}
		if (event.type !== "entry_appended") return;

		const entry = manager.getEntry(state, event.entryId);
		if (entry?.type !== "message") return;
		const at = messageTime(entry);
		if (at === undefined || at <= current.modified) return;
		// The title only moves when a *user* message lands on the branch, since that is the only
		// message a title is read from — an assistant reply cannot rename the conversation.
		const titled = entry.message.role === "user" ? manager.getTitle(state) : current.title;
		publish({ ...current, modified: at, title: titled });
	};

	/**
	 * Read one session's row off disk.
	 *
	 * Only for a session that no scan has accounted for: created or forked by this process, or dropped
	 * into the store by hand. The id has to be located first, which reads every store's headers, but
	 * only the file that matched is parsed — the alternative, a listing, would parse every transcript
	 * to learn about the one session that just appeared.
	 *
	 * A session nobody is running may not have a file yet at all, and says so by answering `undefined`;
	 * the row then appears when the session first writes, which is also when the host opens.
	 */
	const probe = (sessionId: string): Promise<SessionRow | undefined> => SessionManager.findSessionRowById(sessionId);

	/**
	 * Re-read one row and publish it, live fields included.
	 *
	 * The overlay is the same one {@link onHost} applies to a scanned row, and for the same reason:
	 * the file's own row says idle, and a session mid-turn is nothing of the sort. A session the scan
	 * cannot read — deleted between the rename and the re-read — leaves the stored row alone rather
	 * than replacing it with nothing.
	 */
	const refresh = async (sessionId: string): Promise<void> => {
		const scanned = await probe(sessionId);
		if (scanned === undefined) return;
		const entry = following.get(sessionId);
		publish(entry === undefined ? scanned : { ...scanned, ...liveOf(entry.host) });
	};

	/**
	 * Drop one row and stop following its session.
	 *
	 * Unbinding before the drop is what keeps the two facts in order: the feeds are gone before the
	 * listeners hear the row is, so nobody reacts to a removal by publishing to a session that no
	 * longer exists. A session this store never drew has no listeners to tell — "gone" is only news
	 * to someone who had it.
	 */
	const forget = (sessionId: string): void => {
		const entry = following.get(sessionId);
		entry?.off();
		following.delete(sessionId);
		if (!rows.delete(sessionId)) return;
		for (const listener of goneListeners) listener(sessionId);
	};

	/**
	 * The hub said a session appeared, started, or went away.
	 *
	 * Four cases, and what separates them is whether a host came with the news and whether a row
	 * already exists. A host and a row is the ordinary case: follow it, nothing to build. A host and no
	 * row is a session no scan has accounted for, so read its file and lay the live values over it. No
	 * host and no row is a session that was created or forked and is not running — exactly the session
	 * nobody is watching, and the one this store exists for. No host and a row is one that stopped
	 * running: unbind, and leave the row as it stands, because it already says `running: false` — that
	 * snapshot was published before the last claim was let go.
	 */
	const onHost = (sessionId: string, host: HostedSession | undefined): void => {
		if (host === undefined) {
			// The row's live fields came from the host that just went away, so they go with it: a session
			// whose host closed is not running and has nothing pending, whatever its last in-flight
			// publish said. Settling the row here is what keeps a finished unwatched run from leaving a
			// sidebar row stuck on `running: true` — the run's own final publish races the reap that
			// closes this host, and losing that race used to be losing the row's way back to false.
			const entry = following.get(sessionId);
			const stored = rows.get(sessionId);
			entry?.off();
			following.delete(sessionId);
			if (stored !== undefined && (stored.running || stored.pending !== 0)) {
				publish({ ...stored, running: false, pending: 0 });
			}
			if (!rows.has(sessionId)) {
				void probe(sessionId).then((scanned) => {
					if (scanned !== undefined) publish(scanned);
				});
			}
			return;
		}

		// Follow before probing. For a row that does not exist yet the two feeds recompute nothing —
		// there is no stored half to overlay — and the probe reads the file afterwards, so a change
		// arriving mid-read is covered by the snapshot taken once it lands rather than lost.
		follow(sessionId, host);
		if (rows.has(sessionId)) return;

		void probe(sessionId).then((scanned) => {
			if (scanned === undefined) return;
			const entry = following.get(sessionId);
			publish(entry === undefined ? scanned : { ...scanned, ...liveOf(entry.host) });
		});
	};

	/**
	 * Fill the store from the files on disk, once.
	 *
	 * Afterwards, every session being run by this process is re-read from its live loop, so a scan can
	 * never leave a running session's row claiming to be idle.
	 */
	const seed = async (): Promise<void> => {
		for (const group of await SessionManager.listWorkspaces()) {
			// Through `publish` rather than `rows.set`: a row may already be here from a probe, and a
			// listing knows things a single file does not — a fork's parent, above all. Going around the
			// comparison would leave that correction sitting in the store with nobody told.
			for (const row of group.sessions) publish(row);
		}
		for (const [sessionId, entry] of following) {
			const next = liveRow(sessionId, liveOf(entry.host));
			if (next !== undefined) publish(next);
		}
	};

	const ensureSeeded = async (): Promise<void> => {
		seeded ??= seed().catch((error: unknown) => {
			// Deliberately not cached: a scan that failed should be retried by the next caller rather
			// than remembered as an empty store.
			seeded = undefined;
			throw error;
		});
		await seeded;
	};

	const stopHosting = hub.onHostChange(onHost);

	return {
		async groups(): Promise<WorkspaceGroup[]> {
			await ensureSeeded();
			// Grouped by the store's own rule rather than a second copy of it: the sidebar draws one
			// order, and a reader that ordered differently would disagree with the listing it came from.
			return groupSessionsByWorkspace([...rows.values()]);
		},
		async rows(): Promise<SessionRow[]> {
			await ensureSeeded();
			return [...rows.values()];
		},
		async row(sessionId: string): Promise<SessionRow | undefined> {
			await ensureSeeded();
			return rows.get(sessionId);
		},
		onRow(listener: RowListener): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		onGone(listener: RowGoneListener): () => void {
			goneListeners.add(listener);
			return () => {
				goneListeners.delete(listener);
			};
		},
		refresh(sessionId: string): Promise<void> {
			return refresh(sessionId);
		},
		forget(sessionId: string): void {
			forget(sessionId);
		},
		close(): void {
			stopHosting();
			for (const entry of following.values()) entry.off();
			following.clear();
			listeners.clear();
			goneListeners.clear();
		},
	};
}

/** The two row fields a running loop is the only source for. */
interface LiveFields {
	running: boolean;
	pending: number;
}



/**
 * Every field a row has, in the order they are declared.
 *
 * Read from the type rather than written out by hand twice, because a comparison that quietly forgets
 * a field would stop noticing rows that differ only in it — and the symptom would be a row that never
 * updates, which is precisely the bug this store exists to remove. The `satisfies` line is what makes
 * adding a field to `SessionRow` a compile error here rather than a silent omission.
 */
const ROW_FIELDS = [
	"id",
	"absCwd",
	"createdAt",
	"title",
	"parentId",
	"modified",
	"running",
	"pending",
] as const satisfies readonly (keyof SessionRow)[];

type RowField = (typeof ROW_FIELDS)[number];

/** Compile-time proof that the list above covers `SessionRow` exactly. */
type _EveryRowFieldIsListed = Exclude<keyof SessionRow, RowField> extends never ? true : never;
const _everyRowFieldIsListed: _EveryRowFieldIsListed = true;
void _everyRowFieldIsListed;

/**
 * Whether two rows would draw the same, so an identical one need not be sent.
 *
 * Compared field by field rather than by serialization: the wire form is a string, and building one to
 * throw it away would be both slower and a lie about what this checks.
 */
function sameRow(a: SessionRow, b: SessionRow): boolean {
	return ROW_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * When a message entry records activity.
 *
 * The message's own stamp, falling back to the entry's — the same order the scan prefers, so a row
 * pushed forward by a live event and a row read off disk afterwards agree on where "last active" is.
 */
function messageTime(entry: { message: unknown; timestamp: string }): number | undefined {
	const stamp = (entry.message as { timestamp?: unknown }).timestamp;
	if (typeof stamp === "number") return stamp;
	const parsed = new Date(entry.timestamp).getTime();
	return Number.isNaN(parsed) ? undefined : parsed;
}