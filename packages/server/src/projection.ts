import { type AgentSessionEvent, SessionManager, type SessionRow, type WorkspaceGroup } from "@my-agent/core";
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
	/** The live sessions being followed, with the unsubscribers that let them go again. */
	const following = new Map<string, { host: HostedSession; off: () => void }>();
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
	 * stored half yet, which is what {@link probeRow} is for.
	 */
	const liveRow = (sessionId: string, live: LiveFields): SessionRow | undefined => {
		const stored = rows.get(sessionId);
		if (stored === undefined) return undefined;
		return { ...stored, ...live };
	};

	/**
	 * Follow one live session, for as long as it is live.
	 *
	 * Bound in the same synchronous block that the hub hands over the session, so there is no window
	 * in which a change could land before anything was listening.
	 */
	const follow = (sessionId: string, host: HostedSession): void => {
		if (following.has(sessionId)) return;

		const offEvent = host.session.onEvent((event) => onEvent(sessionId, host, event));
		const offChange = host.session.onChange((snapshot) => {
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
	const onEvent = (sessionId: string, host: HostedSession, event: AgentSessionEvent): void => {
		const current = rows.get(sessionId);
		if (current === undefined) return;
		const manager = host.session.sessionManager;

		if (event.type === "branch_changed") {
			publish({ ...current, title: manager.getTitle() });
			return;
		}
		if (event.type !== "entry_appended") return;

		const entry = manager.getEntry(event.entryId);
		if (entry?.type !== "message") return;
		const at = messageTime(entry);
		if (at === undefined || at <= current.modified) return;
		// The title only moves when a *user* message lands on the branch, since that is the only
		// message a title is read from — an assistant reply cannot rename the conversation.
		const titled = entry.message.role === "user" ? manager.getTitle() : current.title;
		publish({ ...current, modified: at, title: titled });
	};

	/**
	 * Read one session's row off disk.
	 *
	 * Only for a session that no scan has accounted for: created or forked by this process, or dropped
	 * into the store by hand. One file, not the machine — a scan here would cost a full parse of every
	 * transcript to learn about the one session that just appeared.
	 */
	const probeRow = async (sessionId: string): Promise<SessionRow | undefined> => {
		return SessionManager.rowForId(sessionId);
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
			following.get(sessionId)?.off();
			following.delete(sessionId);
			if (!rows.has(sessionId)) {
				void probeRow(sessionId).then((scanned) => {
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

		void probeRow(sessionId).then((scanned) => {
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
			for (const row of group.sessions) rows.set(row.id, row);
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
			return orderedGroups([...rows.values()]);
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
		close(): void {
			stopHosting();
			for (const entry of following.values()) entry.off();
			following.clear();
			listeners.clear();
		},
	};
}

/** The two row fields a running loop is the only source for. */
interface LiveFields {
	running: boolean;
	pending: number;
}

/** Read those two fields off a running session. */
function liveOf(host: HostedSession): LiveFields {
	const snapshot = host.session.snapshot;
	return { running: snapshot.submitting, pending: snapshot.pendingApprovals.length };
}

/**
 * Rows as the sidebar's groups: newest activity first within a group, and groups ordered by their own
 * newest row.
 *
 * The group order reads `modified` rather than `createdAt` because a workspace's recency is the
 * recency of its most recent conversation — reading `createdAt` there put a workspace someone worked
 * in all morning below one they opened and abandoned.
 */
function orderedGroups(rows: readonly SessionRow[]): WorkspaceGroup[] {
	const groups = new Map<string, SessionRow[]>();
	for (const row of rows) {
		const group = groups.get(row.cwd);
		if (group === undefined) groups.set(row.cwd, [row]);
		else group.push(row);
	}
	return [...groups.entries()]
		.map(([cwd, sessions]) => ({ cwd, sessions: byModified(sessions) }))
		.sort((a, b) => newestAt(b) - newestAt(a));
}

/** The most recent activity in a group. */
function newestAt(group: WorkspaceGroup): number {
	return group.sessions.reduce((newest, row) => Math.max(newest, row.modified), 0);
}

/**
 * Most recently active first.
 *
 * A copy rather than an in-place sort: the order belongs to whoever asked for it, and two callers
 * asking at once must not reorder each other's view.
 */
function byModified(rows: readonly SessionRow[]): SessionRow[] {
	return [...rows].sort((a, b) => b.modified - a.modified);
}

/** Whether two rows would draw the same, so an identical one need not be sent. */
function sameRow(a: SessionRow, b: SessionRow): boolean {
	return (
		a.id === b.id &&
		a.cwd === b.cwd &&
		a.createdAt === b.createdAt &&
		a.title === b.title &&
		a.parentId === b.parentId &&
		a.modified === b.modified &&
		a.running === b.running &&
		a.pending === b.pending
	);
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