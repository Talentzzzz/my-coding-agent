// Mounting a session in a hub by hand, for the smokes that need settings of their own.
//
// Production never does this: `SessionHub.open()` resolves a session's settings from disk,
// because that is what a window's own directory means. A smoke wants something else — an in-memory
// settings bag with the approval gate switched on, so a scripted transport can park a run at it — and
// the hub offers no option for that on purpose (nothing in production sets one).
//
// So the two steps an open takes are taken here instead: seed the registry entry with the assembly
// the caller wants, then mount the claim token the hub keys it by. The hub's one orchestrator then
// serves the session like any other, because every call it answers names the id. This is why the two
// casts are acceptable: what a smoke needs is the hub's own registry, not a second copy of it.
import {
	type SettingsState,
	type Session,
	SessionManager,
	OpenSessions,
	createSession,
	ensureSession,
	inMemorySettingsState,
} from "@my-agent/core";
import { HostedSession, type SessionHub } from "../packages/server/src/hub.ts";

/** The hub's private half, as a smoke reaches it. */
interface HubInternals {
	hosts: Map<string, HostedSession>;
	sessions: SessionManager;
	openSessions: OpenSessions;
}

export interface MountOptions {
	/** The working directory the session's tools resolve inside, and where its header says it lives. */
	root: string;
	/** The model row the session opens on, by name. */
	model?: string;
	/** The settings the session reads and writes, as a bag. Defaults to empty settings. */
	settings?: SettingsState;
}

/** What a mounted session is: the id every call names, the transcript bag behind it, and its claim token. */
export interface MountedSession {
	id: string;
	state: Session;
	host: HostedSession;
}

/**
 * Seed a session into a hub's registry and mount its claim token.
 *
 * The session is idle — no claim is taken here, exactly as `newSession()` returns an id without
 * claiming it — so a caller that wants it held open asks `hub.claim()` for that.
 */
export async function mountSession(hub: SessionHub, options: MountOptions): Promise<MountedSession> {
	const internals = hub as unknown as HubInternals;
	const state = createSession(options.root);
	await ensureSession({
		workDirAbsPath: options.root,
		session: state,
		models: hub.models,
		sessionManager: internals.sessions,
		openSessions: internals.openSessions,
		settingsState: options.settings ?? inMemorySettingsState({}),
		...(options.model === undefined ? {} : { model: options.model }),
	});
	const host = new HostedSession(state.sessionId, options.root);
	internals.hosts.set(state.sessionId, host);
	return { id: state.sessionId, state, host };
}
