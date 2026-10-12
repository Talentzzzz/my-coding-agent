import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { httpStatus } from "./errors.ts";

/** Types the bundled client is made of. Anything else is served as bytes. */
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".woff2": "font/woff2",
	".ico": "image/x-icon",
	".map": "application/json; charset=utf-8",
};

/** One JSON response. Every controller answer that is not an event stream goes through here. */
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
		// The client is a single local user; a cached API answer is one more way to be confusingly stale.
		"cache-control": "no-store",
	});
	response.end(text);
}

/**
 * Serve the built client, falling back to `index.html` for anything that is not a file.
 *
 * The fallback is what makes a client-side route reloadable. It is deliberately the last resort: a
 * request that reached here already failed to match a route, so an unknown `/api/...` path becomes
 * the UI's HTML rather than a JSON 404. `isApiPath` is what keeps those two apart.
 */
export async function serveStatic(clientDir: string, pathname: string, response: ServerResponse): Promise<void> {
	const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
	const root = resolve(clientDir);
	const candidate = resolve(root, relative);
	// A separator, not just the prefix: without it a sibling directory named `<clientDir>-backup`
	// would pass the check and be served.
	if (candidate !== root && !candidate.startsWith(root + sep)) {
		const failure = httpStatus.notFound("Not found");
		sendJson(response, failure.status, { error: failure.message });
		return;
	}

	const info = await stat(candidate).catch(() => undefined);
	const file = info?.isFile() ? candidate : join(clientDir, "index.html");
	const fallback = await stat(file).catch(() => undefined);
	if (!fallback) {
		sendJson(response, 503, {
			error: `No client build at ${clientDir}. Run "npm run build:web", or start the server with --vite.`,
		});
		return;
	}

	response.writeHead(200, {
		"content-type": MIME[extname(file)] ?? "application/octet-stream",
		"cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600",
	});
	createReadStream(file).pipe(response);
}

/** Whether a path belongs to the API, so an unrouted one is a 404 instead of the client shell. */
export function isApiPath(pathname: string): boolean {
	return pathname === "/api" || pathname.startsWith("/api/");
}
