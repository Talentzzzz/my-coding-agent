import { createServer, type HttpServerHandle } from "./http.ts";
import { SessionHub } from "./hub.ts";
import { EventController } from "./controllers/events.ts";
import { SessionController, SystemController } from "./controllers/sessions.ts";
import { createRoutes } from "./controllers/routes.ts";
import { Router } from "./http/routing.ts";
import { createSessionProjection, type SessionProjection } from "./projection.ts";
import { createStreamRegistry } from "./stream-registry.ts";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

/**
 * Client source for `vite`, and the built assets otherwise. Both resolve inside packages/web, so
 * this module has to stay one directory below the package root for them to keep pointing at it.
 */
const WEB_DIR = fileURLToPath(new URL("../../web", import.meta.url));
const CLIENT_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));

export interface BootOptions {
	/** The directory the agent may touch. */
	cwd: string;
	/** Bind address. Defaults to `127.0.0.1`: this server is for its own machine. */
	host?: string;
	/**
	 * Port to bind. Defaults to 8080; `0` asks the operating system for a free one, which is what a
	 * desktop shell wants so two applications never fight over a fixed number.
	 */
	port?: number;
	model?: string;
	thinkingLevel?: string;
	sessionId?: string;
	continueSession?: boolean;
	/**
	 * How long a stream that attached to an idle session waits for a run before ending itself.
	 *
	 * Passed straight to the stream registry, and an option here only so a smoke can drive it in
	 * milliseconds; nothing in production sets it. See `StreamRegistryOptions.idleGraceMs`.
	 */
	idleGraceMs?: number;
	/** Serve the client through Vite instead of the built assets, for hot reload. */
	vite?: boolean;
}

export interface BootedServer {
	/** Where the client and the API are reachable, with the port actually bound. */
	url: string;
	port: number;
	cwd: string;
	hub: SessionHub;
	/**
	 * What this process knows about every session, as sidebar rows.
	 *
	 * Built here rather than inside the hub because it is a *reader* of the hub's two observation
	 * points, not a part of session lifetime: a caller that wants the rows asks this, and nothing about
	 * a claim, a reap or a host's closing depends on it having asked.
	 */
	projection: SessionProjection;
	server: HttpServerHandle;
	/** Close the event streams first, then the sessions, then the listener. */
	close(): Promise<void>;
}

/**
 * Start the API and the client on one listener.
 *
 * This is the whole server as one call, because a host that embeds it — the CLI, a smoke script, the
 * desktop shell — should not have to rebuild the object graph the wiring describes. `main.ts` is the
 * command-line face of this function and owns nothing on its own.
 */
export async function bootServer(options: BootOptions): Promise<BootedServer> {
	const cwd = options.cwd;
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 8080;
	const sessionId = options.sessionId ?? process.env.MY_AGENT_SESSION ?? undefined;

	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid port: ${port}`);
	}

	const hub = new SessionHub({
		cwd,
		...(options.model === undefined ? {} : { model: options.model }),
		...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
		// A shell with no project picker yet has no other way to be pointed at a conversation; the
		// environment is how a launcher or a capture run says which one to open.
		...(sessionId === undefined ? {} : { sessionId }),
		continueSession: options.continueSession ?? false,
	});

	// The event streams hold the claims that keep a session open, so they are built first: everything
	// that owns a session's lifetime is in one of these two objects, and the controllers are stateless
	// except for the two things only a stream can report — a run that failed to start, and an approval
	// answered in one tab that every other tab has to hear about.
	const streams = createStreamRegistry(hub, { ...(options.idleGraceMs === undefined ? {} : { idleGraceMs: options.idleGraceMs }) });
	// Built against the hub, not wired into it: the projection observes which sessions exist and what
	// they are doing, and neither of those is allowed to keep a session alive or hurry its closing.
	const projection = createSessionProjection(hub);
	const router = new Router(
		createRoutes({
			system: new SystemController(hub),
			sessions: new SessionController(hub, {
				onRunFailure: (sessionId, message) => streams.announce(sessionId, message),
				onApproval: (sessionId, toolCallId, approved) => streams.rememberApproval(sessionId, toolCallId, approved),
			}),
			events: new EventController(streams, hub),
		}),
	);

	const server = await createServer({
		router,
		clientDir: options.vite === true ? WEB_DIR : CLIENT_DIR,
		useVite: options.vite ?? false,
	});

	await new Promise<void>((resolveListen) => server.server.listen(port, host, resolveListen));
	const bound = (server.server.address() as AddressInfo | null)?.port ?? port;

	return {
		url: `http://${host}:${bound}`,
		port: bound,
		cwd,
		hub,
		projection,
		server,
		close: async () => {
			// Streams first: ending them lets go of the claims, so the hub's own close does not wait for
			// a response that is never going to end. The projection is released before either, since it
			// only listens — nothing it holds can delay what comes after.
			projection.close();
			await streams.close();
			await hub.close();
			await server.close();
		},
	};
}

/** Where the built client lives, for a caller that wants to report it. */
export const clientDirectory = CLIENT_DIR;
