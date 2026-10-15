import type { SessionRow, WorkspaceGroup } from "@my-agent/core/protocol";

/**
 * The sidebar's rows, kept at the connection level.
 *
 * Deliberately not part of `ViewState` and not something {@link reduce} sees. Rows answer "what is
 * every session on this machine doing", which is a question about the connection rather than about
 * the conversation one pane happens to be showing — and the deciding test is whether a field stays
 * true with nothing subscribed. `running` and `pending` do; a token count would not, which is why
 * `usage` never comes here.
 *
 * There are two writers, and they never overlap. While the channel is `live` the rows come only from
 * it, and REST is not consulted at all; while the channel is down, a REST listing is the only thing
 * saying anything. One writer at a time is what removes the race: without it, a listing that started
 * before a `running: true` arrived could land afterwards and put the row back to `false`, and the
 * window would show a session as idle while it was working.
 */
export class SessionRows {
	private readonly rows = new Map<string, SessionRow>();

	/**
	 * Bumped by every mutation, read by the window's render gate.
	 *
	 * The sidebar's rows change on their own schedule while a streaming frame changes none of them,
	 * and a redraw decision needs to tell those apart without diffing the table. A counter is the
	 * cheapest honest answer: a frame that changed no row reads the same number it drew last, and a
	 * frame that changed one does not.
	 */
	version = 0;

	/**
	 * Replace the whole table, which is what the connection's opening frame is.
	 *
	 * A replacement rather than a merge, so a row for a session that has since been deleted
	 * disappears on its own — there is no tombstone to carry and no removal frame to define.
	 */
	replaceAll(rows: readonly SessionRow[]): void {
		this.rows.clear();
		for (const row of rows) this.rows.set(row.id, row);
		this.version += 1;
	}

	/**
	 * One row changed.
	 *
	 * The server sends the whole row because a row is small and a whole row is idempotent — the same
	 * row arriving twice, or out of order, leaves the same table. Merging field by field would be the
	 * only thing here that could produce a row that is half old and half new.
	 */
	put(row: SessionRow): void {
		this.rows.set(row.id, row);
		this.version += 1;
	}

	/**
	 * One row went away: the session behind it was deleted.
	 *
	 * A no-op for an id the table never held, because "gone" is only news to a window that had it —
	 * but the version still moves for the one that did, since a row disappearing is a change the
	 * render gate has to see.
	 */
	remove(sessionId: string): void {
		if (!this.rows.delete(sessionId)) return;
		this.version += 1;
	}

	/**
	 * Take a REST listing, as the fallback for a channel that is not up.
	 *
	 * Rejected while the channel is `live`, which is the whole point of the rule: at that moment the
	 * channel is the authority on these rows, and a listing computed from files would overwrite a
	 * running session's row with an idle one. Returns whether it was taken, so a caller can tell the
	 * difference between "refreshed" and "the channel owns this now".
	 */
	loadFrom(groups: readonly WorkspaceGroup[], channelIsLive: boolean): boolean {
		if (channelIsLive) return false;
		this.rows.clear();
		for (const group of groups) {
			for (const row of group.sessions) this.rows.set(row.id, row);
		}
		this.version += 1;
		return true;
	}

	/** One row, or `undefined` for a session nothing has told this window about. */
	get(sessionId: string): SessionRow | undefined {
		return this.rows.get(sessionId);
	}

	/** Every row, newest activity first — the order the sidebar draws. */
	list(): SessionRow[] {
		return [...this.rows.values()].sort((a, b) => b.modified - a.modified);
	}

	/**
	 * The rows as the sidebar's groups, each group ordered by its own newest row.
	 *
	 * The same shape the server's projection answers with, and the same ordering — groups by their
	 * newest activity, most recent first, so the workspace a message just landed in is the first one
	 * the sidebar shows. A REST fallback and a live channel produce an identical list: a store and a
	 * reader that each sorted for themselves would disagree the first time a row moved.
	 */
	groups(): WorkspaceGroup[] {
		const byCwd = new Map<string, SessionRow[]>();
		for (const row of this.list()) {
			const group = byCwd.get(row.cwd);
			if (group === undefined) byCwd.set(row.cwd, [row]);
			else group.push(row);
		}
		return [...byCwd.entries()]
			.map(([cwd, sessions]) => ({ cwd, sessions }))
			.sort((a, b) => newest(b.sessions) - newest(a.sessions));
	}
}

/** A group's most recent activity, which is what orders the groups against each other. */
function newest(rows: readonly SessionRow[]): number {
	return rows.reduce((latest, row) => Math.max(latest, row.modified), 0);
}