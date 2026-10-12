import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Router } from "./http/routing.ts";
import { isApiPath, serveStatic } from "./http/static.ts";

export interface HttpOptions {
	/** The API's routing table. A request no route claims falls through to the client. */
	router: Router;
	clientDir: string;
	/** Use Vite in middleware mode so the client hot-reloads while the server stays up. */
	useVite?: boolean;
}

export interface HttpServerHandle {
	server: Server;
	close(): Promise<void>;
}

/**
 * One HTTP server for both halves of the app: the JSON API and the client.
 *
 * There is no second transport to open. A command is a request, a session's event stream is a
 * `GET` that never ends, and everything the server knows how to do is reachable by anything that can
 * write HTTP — a browser, a script, `curl`.
 */
export async function createServer(options: HttpOptions): Promise<HttpServerHandle> {
	const vite = options.useVite ? await createViteMiddleware(options.clientDir) : undefined;

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

	return {
		server,
		close: async () => {
			await vite?.close();
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
