import type { ChatTransport } from "@my-agent/ai";
import { createServer, type HttpServerHandle } from "./http.ts";
import { SessionHub } from "./hub.ts";
import { SessionController, SystemController, type SessionListener } from "./controllers/sessions.ts";
import { createRoutes } from "./controllers/routes.ts";
import { Router } from "./http/routing.ts";
import { createSessionProjection, type SessionProjection } from "./projection.ts";
import { createMuxServer, type FrameSink, type MuxConnection, type MuxOptions, type MuxServer } from "./mux.ts";
import { WebSocketConnection } from "./http/websocket.ts";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

/**
 * Client source for `vite`, and the built assets otherwise. Both resolve inside packages/web, so
 * this module has to stay one directory below the package root for them to keep pointing at it.
 */
const WEB_DIR = fileURLToPath(new URL("../../web", import.meta.url));
const CLIENT_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** Where the mux lives. One path, and it is not under `/api`: it is not a REST resource. */
const MUX_PATH = "/mux";

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
	 * The transport every session this server opens talks to.
	 *
	 * Omitted in the real process, where it means Anthropic Messages. A smoke passes a scripted
	 * transport so a run can be driven — parked on an approval, most importantly — with no provider
	 * key. The pass-through is the whole reason the option exists: the shutdown smoke needs the real
	 * boot path, including the real hub, behind its worst case.
	 */
	api?: ChatTransport;
	/**
	 * The mux's own timers and budgets, overridable so a smoke can drive them in milliseconds.
	 *
	 * A pass-through rather than a field per timer: the connection layer owns what these mean, and
	 * restating them here would be a second place to keep them honest. Nothing in production sets it.
	 */
	mux?: MuxOptions;
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
	/** The resident connection layer: one per upgraded socket. */
	mux: MuxServer;
	server: HttpServerHandle;
	/** Close the connections first, then the sessions, then the listener. */
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
		...(options.api === undefined ? {} : { api: options.api }),
	});

	// The mux holds the connections, and the projection is built against the hub rather than wired
	// into it: the projection observes which sessions exist and what they are doing, and neither of
	// those is allowed to keep a session alive or hurry its closing.
	//
	// Order matters only in that the mux needs the projection — its first frame on every connection is
	// the overview, so it has to be able to answer "what sessions exist" before any window asks.
	const projection = createSessionProjection(hub);
	const mux = createMuxServer(hub, projection, options.mux ?? {});
	const router = new Router(
		createRoutes({
			system: new SystemController(hub),
			// Both listeners are facts about a run rather than about a request that is still open, and
			// both are the transport's business: see {@link sessionListeners}, which is the one home
			// they have so a smoke can be wired through the same function this server is.
			sessions: new SessionController(hub, sessionListeners(mux)),
		}),
	);

	const server = await createServer({
		router,
		clientDir: options.vite === true ? WEB_DIR : CLIENT_DIR,
		useVite: options.vite ?? false,
		onUpgrade: muxUpgrade(mux),
	});

	await new Promise<void>((resolveListen) => server.server.listen(port, host, resolveListen));
	const bound = (server.server.address() as AddressInfo | null)?.port ?? port;

	return {
		url: `http://${host}:${bound}`,
		port: bound,
		cwd,
		hub,
		projection,
		mux,
		server,
		close: async () => {
			// Connections first, and before the sessions: a window's subscriptions are released while the
			// sessions they were watching are still there, so nothing has to be torn down from underneath
			// a live feed. The projection goes first of all because it only listens — nothing it holds can
			// delay what comes after.
			projection.close();
			mux.close();
			// The upgraded sockets are destroyed by the listener's own close, which is the only place that
			// can reach them; the mux only stops wanting them.
			await hub.close();
			await server.close();
		},
	};
}

/** The path of a request URL, without its query. */
function pathOf(url: string | undefined): string {
	const raw = url ?? "/";
	const end = raw.indexOf("?");
	return end < 0 ? raw : raw.slice(0, end);
}

/**
 * The mux's `upgrade` handler, as one function of the server it serves.
 *
 * Lifted out of `bootServer` because the assembly it wires is not a boot-time secret: a smoke that
 * builds its own graph (a scripted model in place of a provider, a hub of its own) needs exactly this
 * wiring in front of its own mux, and duplicating it would put the subtle parts — the frames that
 * arrive before `accept()` returns, the Pong that is the only liveness evidence this side gets —
 * into three copies that drift. The handler is the same for every server; what differs is which mux
 * stands behind it.
 */
export function muxUpgrade(
	mux: MuxServer,
): (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean {
	return (request, socket, head) => {
		if (pathOf(request.url) !== MUX_PATH) {
			// Destroyed here rather than declined, because declining is not a thing this server can do:
			// once any `upgrade` listener exists, Node has already handed the socket over and will
			// never touch it again. Returning without destroying leaves it open forever — and
			// `server.close()` never calls back while one is, so a single stray `Upgrade:` header to
			// any other path would wedge shutdown permanently.
			socket.destroy();
			return true;
		}
		const connection = WebSocketConnection.accept(request, socket);
		if (connection === undefined) return true;

		// `FrameSink` over the WebSocket, so the connection layer's policy never sees a socket and the
		// frame codec never sees a subscription. This is the seam the whole split rests on.
		const sink: FrameSink = {
			send: (frame) => connection.send(JSON.stringify(frame)),
			ping: () => connection.ping(),
			close: (code, reason) => connection.close(code, reason),
			terminate: () => connection.terminate(),
			get isClosed() {
				return connection.isClosed;
			},
		};

		/**
		 * Uplink frames that arrived before the connection object existed.
		 *
		 * `accept()` awaits the projection's first read, so it cannot hand back a connection
		 * synchronously — and a client whose first act is `open` puts that frame in the very TCP
		 * segment as the handshake, which is replayed *before* `accept()` is even called. Dropping
		 * those frames would leave that client waiting for a baseline that was never going to come,
		 * while heartbeats kept its watchdog fed so it never noticed. So they wait here instead, in
		 * order, and are replayed the moment there is something to replay them to.
		 */
		const waiting: string[] = [];

		let owned: MuxConnection | undefined;
		connection.start({
			onMessage: (text) => {
				if (owned === undefined) {
					if (!connection.isClosed) waiting.push(text);
					return;
				}
				mux.handle(owned, text);
			},
			onClose: () => {
				// Nothing to forget if the connection never became one, but the pending frames are
				// dropped either way: there is no longer anything they could be delivered to.
				waiting.length = 0;
				if (owned !== undefined) mux.forget(owned);
			},
			onProtocolError: (reason) => {
				console.warn(`mux: 协议错误，关闭连接：${reason}`);
			},
			// The only evidence of liveness this side gets. Without it the connection layer would
			// count unanswered Pings against a peer that is answering perfectly well, and drop it.
			onPong: () => {
				if (owned !== undefined) mux.notePong(owned);
			},
		});

		void mux
			.accept(sink)
			.then((accepted) => {
				owned = accepted;
				// A connection that ended during the (awaited) overview read must not be left in the
				// server's set with nothing left to close it.
				if (connection.isClosed) {
					mux.forget(accepted);
					return;
				}
				// Only safe once the connection is known to be live: the first frame it receives is the
				// overview, so a client cannot tell these from its own until it has seen one anyway.
				for (const text of waiting.splice(0)) mux.handle(accepted, text);
			})
			.catch((error: unknown) => {
				console.warn(`mux: 拒绝一个连接：${error instanceof Error ? error.message : String(error)}`);
			});
		if (head.length > 0) connection.replay(head);
		return true;
	};
}

/**
 * What a session controller tells the transport about, wired once for every server that serves one.
 *
 * Lifted out of `bootServer` for the same reason {@link muxUpgrade} was: this wiring is not a
 * boot-time secret, and a smoke that builds its own graph needs exactly it. The subtle half is the
 * log line — a run's failure is announced on the connections watching the session, and an empty
 * subscription table means the frame has no reader at all, so the log is the only place a failure
 * nobody was watching is still audible. A smoke that copied these lines instead would be asserting
 * its own copy; wired through here, the thing it proves is that deleting this `console.error` turns
 * it red.
 */
export function sessionListeners(mux: MuxServer): SessionListener {
	return {
		onRunFailure: (sessionId, message) => {
			console.error(`会话 ${sessionId} 的运行失败：${message}`);
			mux.announce(sessionId, message);
		},
		onApproval: (sessionId, toolCallId, approved) => mux.rememberApproval(sessionId, toolCallId, approved),
	};
}

/** Where the built client lives, for a caller that wants to report it. */
export const clientDirectory = CLIENT_DIR;
