import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Router } from "./http/routing.ts";
import { isApiPath, serveStatic } from "./http/static.ts";

export interface HttpOptions {
	/** The API's routing table. A request no route claims falls through to the client. */
	router: Router;
	clientDir: string;
	/** Use Vite in middleware mode so the client hot-reloads while the server stays up. */
	useVite?: boolean;
	/**
	 * Take over a connection that asked to switch protocols.
	 *
	 * Once this listener exists Node has already handed the socket over and will not touch it again, so
	 * the handler owns the socket completely: it must either take it or destroy it. Declining is not a
	 * thing it can do — an unclaimed upgrade would stay open forever, and `close()` would then never call
	 * back.
	 *
	 * The boolean is kept so a caller can report "handled" for a path it recognised but refused, which
	 * is the same outcome as taking it.
	 */
	onUpgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
}

export interface HttpServerHandle {
	server: Server;
	/**
	 * Every socket that was upgraded away from HTTP, so shutdown can end them.
	 *
	 * Held here rather than by the mux because this is the one place that knows a socket stopped being
	 * a response: once a connection is upgraded it is no longer in `server`'s accounting at all, and
	 * `close()` would otherwise return while it was still open.
	 */
	readonly upgradeSockets: ReadonlySet<Duplex>;
	close(): Promise<void>;
}

/**
 * One HTTP server for both halves of the app: the JSON API and the client.
 *
 * There is no second *listener*. A command is a request and a session's events are frames on the one
 * resident connection the client opens, and everything the server knows how to do is reachable by
 * anything that can write HTTP — a browser, a script, `curl`.
 */
export async function createServer(options: HttpOptions): Promise<HttpServerHandle> {
	const vite = options.useVite === true ? await createViteMiddleware(options.clientDir) : undefined;
	const upgradeSockets = new Set<Duplex>();

	const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const pathname = pathOf(request.url);

		try {
			if (await options.router.dispatch(request, response)) return;

			// A routed API path that nothing claimed is a 404, not the client shell: handing a client
			// HTML for a mistyped endpoint is worse than saying the endpoint does not exist.
			if (isApiPath(pathname)) {
				response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
				response.end(JSON.stringify({ error: `No route for ${request.method ?? "GET"} ${pathname}` }));
				return;
			}

			if (vite) {
				// Vite serves the client itself and calls `next` for what it does not handle, so the
				// fallback is chained onto Vite's own call rather than run beside it: awaiting this
				// settles once one of the two has actually finished the response.
				await new Promise<void>((settle) => {
					vite.middlewares(request, response, () => {
						void serveStatic(options.clientDir, pathname, response).finally(settle);
					});
				});
				return;
			}

			await serveStatic(options.clientDir, pathname, response);
		} catch (error) {
			if (response.headersSent) return;
			const message = error instanceof Error ? error.message : String(error);
			response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
			response.end(JSON.stringify({ error: message }));
		}
	};

	const server = createHttpServer((request, response) => {
		void handler(request, response);
	});

	// Registered before `listen`, and only when something will use it: an `upgrade` listener takes the
	// event away from Node's default handling, so registering an empty one would change behaviour for a
	// server that has no use for it.
	if (options.onUpgrade !== undefined) {
		server.on("upgrade", (request, socket, head) => {
			if (options.onUpgrade?.(request, socket, head) === true) {
				// Tracked from the moment the upgrade succeeds, because from that moment this socket is
				// invisible to `server.close()` — see `close`.
				upgradeSockets.add(socket);
				// Only `close` and `error` forget it. A peer that half-closes has merely stopped sending:
				// the socket is still very much open, and dropping it from the set on `end` would put it
				// outside the sweep that `close()` depends on — reintroducing exactly the hang the set
				// exists to prevent.
				const forget = (): void => {
					upgradeSockets.delete(socket);
				};
				socket.on("close", forget);
				socket.on("error", forget);
			}
		});
	}

	return {
		server,
		upgradeSockets,
		close: async () => {
			await vite?.close();
			// An upgraded socket is not a response and not an idle connection: `server.close()` waits for
			// responses, `closeAllConnections()` reaches idle keep-alive ones, and neither of them
			// accounts for a socket that finished its handshake and became something else. Both were
			// measured against this exact case and both let the process hang with a window still attached,
			// so the set above is the only thing that closes them.
			for (const socket of [...upgradeSockets]) socket.destroy();
			upgradeSockets.clear();
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		},
	};
}

function pathOf(url: string | undefined): string {
	const raw = url ?? "/";
	const end = [raw.indexOf("?"), raw.indexOf("#")]
		.filter((index) => index >= 0)
		.reduce((lowest, index) => Math.min(lowest, index), raw.length);
	return decodeURI(raw.slice(0, end));
}

interface ViteMiddleware {
	middlewares(request: IncomingMessage, response: ServerResponse, next: () => void): void;
	close(): Promise<void>;
}

interface ViteInstance {
	middlewares: ViteMiddleware["middlewares"];
	close(): Promise<void>;
}

interface ViteModule {
	createServer(options: Record<string, unknown>): Promise<ViteInstance>;
}

/**
 * Load Vite lazily, by variable specifier, so a production start never needs it installed and so
 * `tsc` does not require Vite's types for the server build.
 */
async function createViteMiddleware(clientDir: string): Promise<ViteMiddleware> {
	const specifier = "vite";
	const vite = (await import(specifier)) as unknown as ViteModule;
	const instance = await vite.createServer({
		root: clientDir,
		appType: "spa",
		server: { middlewareMode: true },
	});
	return {
		middlewares: (request, response, next) => {
			instance.middlewares(request, response, next);
		},
		close: () => instance.close(),
	};
}
