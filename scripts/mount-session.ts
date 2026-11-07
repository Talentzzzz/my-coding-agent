// Mounting a session in a hub by hand, for the smokes that need a session without an open.
//
// Production never does this: `SessionHub.open()` resolves which session to run from a request, and
// reads its settings through the orchestrator's own. A smoke wants a session whose id it knows up
// front, so the two steps an open takes are taken here instead: build a transcript bag, open it onto
// the hub's orchestrator through the same public door a production open uses, then mount the claim
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
}

export interface MountOptions {
	/** The working directory the session's tools resolve inside, and where its header says it lives. */
	root: string;
	/** The model row the session opens on, by name. */
	model?: string;
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
	// Open, not assemble-then-adopt: the state enters the hub's orchestrator through the same public
	// door a production open uses, so the smoke seeds nothing the orchestrator does not know about —
	// and the services it assembles over are the hub's own, which is what makes the mount invisible.
	await hub.agent.open({
		session: state,
		workDirAbsPath: options.root,
		...(options.model === undefined ? {} : { model: options.model }),
	});
	const host = new HostedSession(state.sessionId);
	internals.hosts.set(state.sessionId, host);
	return { id: state.sessionId, state, host };
}
