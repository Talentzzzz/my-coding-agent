// Mounting a session in a hub by hand, for the smokes that need a session without an open.
//
// Production never does this: `SessionHub.open()` resolves which session to run from a request, and
// reads its settings through the orchestrator's own. A smoke wants a session whose id it knows up
// front, so the two steps an open takes are taken here instead: build a transcript bag, open it onto
// the hub's orchestrator through the same public door a production open uses, then mount the hold
// token the hub keys it by. The hub's one orchestrator then serves the session like any other,
// because every call it answers names the id.
//
// Settings are not part of what a mount can choose: the configuration is the orchestrator's, and one
// orchestrator serves every session of the process through the one it was built with. A smoke that
// wants its own settings — a gate of its own, rows of its own — seeds them onto the files behind the
// hub's settings and models homes (`HubOptions.settingsHome` / `modelsHome`) before the hub is built,
// and every session it mounts reads through those.
import { type Session, createSession } from "@my-agent/core";
import { HostedSession, type SessionHub } from "../packages/server/src/hub.ts";

/** The hub's private half, as a smoke reaches it. */
interface HubInternals {
	hosts: Map<string, HostedSession>;
	announceHost(sessionId: string, host: HostedSession | undefined): void;
}

export interface MountOptions {
	/** The working directory the session's tools resolve inside, and where its header says it lives. */
	root: string;
	/** The model row the session opens on, by name. */
	model?: string;
}

/** What a mounted session is: the id every call names, the transcript bag behind it, and its hold token. */
export interface MountedSession {
	id: string;
	state: Session;
	host: HostedSession;
}

/**
 * Seed a session into a hub's registry and mount its hold token.
 *
 * The session is idle — no hold is taken here, exactly as `newSession()` returns an id without
 * holding it — so a caller that wants it held open asks `hub.hold()` for that.
 */
export async function mountSession(hub: SessionHub, options: MountOptions): Promise<MountedSession> {
	const internals = hub as unknown as HubInternals;
	const state = createSession(options.root);
	// Enter, not assemble-then-adopt: the state enters the hub's orchestrator through the same door a
	// production assembly uses, so the smoke seeds nothing the orchestrator does not know about — and
	// the services it assembles over are the hub's own, which is what makes the mount invisible. The
	// door is class-private (`hold` / `create` are the verbs a host spells), so the
	// mount reaches it like any other private half. The bag carries its own working directory, which
	// is where the mount's `root` lands.
	const door = hub.agent as unknown as {
		assembleAgentStateBySession(options: { session: Session; model?: string; thinkingLevel?: string }): Promise<unknown>;
	};
	await door.assembleAgentStateBySession({
		session: state,
		...(options.model === undefined ? {} : { model: options.model }),
	});
	const host = new HostedSession(state.sessionId);
	internals.hosts.set(state.sessionId, host);
	// The announcement a production `open` makes: a mount that stays silent leaves the projection
	// deaf to the session, so its row never wears the live fields the process actually knows.
	internals.announceHost(state.sessionId, host);
	return { id: state.sessionId, state, host };
}
