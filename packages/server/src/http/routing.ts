import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, internalError } from "./errors.ts";

/**
 * The HTTP verbs this server routes. The set is closed on purpose: the transport is REST, so a
 * method is always a lookup key, never a tunnel.
 */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * How a `:name` segment is read. A parser returns the value, or `undefined` for "this is not that
 * resource" — which the router turns into a 404 rather than a 400: `/api/sessions/foo` is not a
 * malformed request, it is a request for something that does not exist.
 */
export type ParamParser<T = string> = (raw: string) => T | undefined;

/**
 * What serves a route.
 *
 * Declared as an interface with a call signature on purpose: parameters in that position are checked
 * bivariantly, which is what lets a route whose params are `{ id: string }` sit in a table of routes
 * whose params are `Record<string, unknown>`. A function type alias is checked strictly and would
 * reject it. Nothing else relies on the relaxation, and the typing that matters — `params.id` being
 * a `string` inside the handler — is checked where the route is declared.
 */
export interface RouteHandler<P> {
	(params: P, request: IncomingMessage, response: ServerResponse): Promise<void> | void;
}

export interface RouteEntry<P extends Record<string, unknown>> {
	method: Method;
	path: string;
	params: { [K in keyof P]: ParamParser<P[K]> };
	handle: RouteHandler<P>;
}

/**
 * One route: a method, a path template, and the controller method that serves it.
 *
 * `params` is the type of the extracted segments, inferred from the parsers, so a handler's declared
 * parameters cannot drift from the path it is attached to — `{ id: stringParam }` is what makes
 * `params.id` a `string` inside the handler.
 */
export function route<P extends Record<string, unknown>>(entry: RouteEntry<P>): RouteEntry<P> {
	return entry;
}

/**
 * A route as the table holds it.
 *
 * This is the one `any` in this repository, and the convention against it is being broken knowingly.
 * A table of routes is heterogeneous — one route's params are `{ id: string }`, another's are
 * `{ id: string, toolCallId: string }` — so no single concrete instantiation accepts all of them:
 * `Record<string, unknown>` does not, because a handler that requires `id` cannot accept a record
 * that might not have one; `Record<string, never>` does not either, because then no caller could pass
 * a handler any params at all; and TypeScript has no existential type for "some `P`, checked where
 * the route was declared". A cast hidden inside a helper was tried and does not compile for the same
 * reason.
 *
 * What this costs is bounded and deliberate: `Router` only ever reads `method`, `path`, `params`, and
 * `handle` off an entry, and those are validated at runtime by the parsers. What it still buys is the
 * typing that matters — `route({ params: { id: stringParam } })` types `params.id` as a `string`
 * inside that entry's own handler, which is checked where a mistake would actually be made.
 */
export type ApiRoute = RouteEntry<any>;

export const stringParam: ParamParser<string> = (raw) => (raw.length === 0 ? undefined : raw);

/** A path template split once, so matching never re-parses the pattern. */
interface CompiledRoute {
	method: Method;
	segments: string[];
	params: Record<string, ParamParser<never>>;
	handle: RouteHandler<Record<string, unknown>>;
}

/**
 * The routing table: method plus path in, controller method out.
 *
 * This is what a Spring `DispatcherServlet` does and no more. The interesting part is that it is the
 * ONLY place a request URL is interpreted — controllers receive validated params and a body, never a
 * raw request. That is what makes a second surface, or a test, a caller rather than a copy.
 */
export class Router {
	readonly routes: readonly ApiRoute[];
	private readonly compiled: CompiledRoute[];

	constructor(routes: readonly ApiRoute[]) {
		this.routes = routes;
		this.compiled = routes.map((entry) => ({
			method: entry.method,
			segments: splitPath(entry.path),
			params: entry.params as Record<string, ParamParser<never>>,
			handle: entry.handle,
		}));
	}

	/**
	 * Serve one request if a route claims its URL, and report whether one did.
	 *
	 * `false` means "not mine" — the caller falls through to the static client, which is how one
	 * process serves both the API and the bundled UI. Errors are mapped here rather than by the
	 * caller, because this is the one place that knows a route matched: a 404 for an unrouted path is
	 * the caller's job, while a 405 or a failure inside a controller is this method's.
	 */
	async dispatch(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const method = (request.method ?? "GET").toUpperCase();
		if (!isMethod(method)) return false;

		const pathname = pathOf(request.url);
		const allowed: Method[] = [];
		for (const entry of this.compiled) {
			const params = match(entry, pathname);
			if (params === undefined) continue;
			if (entry.method !== method) {
				allowed.push(entry.method);
				continue;
			}

			try {
				await entry.handle(params, request, response);
			} catch (error) {
				this.fail(error, response);
			}
			return true;
		}

		// The path exists but not for this verb: 405 with the verbs that do, rather than a 404 that
		// would send a caller looking for a typo in the path.
		if (allowed.length > 0) {
			const failure = new HttpError(405, `Method ${method} is not allowed for ${pathname}`);
			failure.headers = { allow: [...new Set(allowed)].join(", ") };
			this.fail(failure, response);
			return true;
		}
		return false;
	}

	/** Answer a failure as JSON, or leave the response alone once it has started. */
	private fail(error: unknown, response: ServerResponse): void {
		if (response.headersSent) {
			// Nothing sensible is left to say — an event stream that already started, or a body already
			// written. Leave it; the client sees the stream end.
			return;
		}
		const failure = internalError(error);
		const body = JSON.stringify({ error: failure.message });
		const extra = error instanceof HttpError && error.headers !== undefined ? error.headers : {};
		response.writeHead(failure.status, {
			"content-type": "application/json; charset=utf-8",
			"content-length": Buffer.byteLength(body),
			...extra,
		});
		response.end(body);
	}
}

/**
 * The path of a request URL, never its query: a query is a filter, not a route.
 *
 * Left percent-encoded. Each segment is decoded once, in `match`, because decoding the whole path
 * here would turn an encoded slash into a separator and change which route the request is for.
 */
function pathOf(url: string | undefined): string {
	const raw = url ?? "/";
	const end = [raw.indexOf("?"), raw.indexOf("#")]
		.filter((index) => index >= 0)
		.reduce((lowest, index) => Math.min(lowest, index), raw.length);
	const pathname = raw.slice(0, end);
	return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function splitPath(path: string): string[] {
	return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * Read the params a path supplies, or `undefined` when the route does not match.
 *
 * A parser rejecting a value means the route does not apply — `/api/sessions/health` is a 404
 * because "health" is not a session id, not a 400, and certainly not a controller invoked with the
 * wrong type.
 */
function match(entry: CompiledRoute, pathname: string): Record<string, unknown> | undefined {
	const segments = splitPath(pathname);
	if (segments.length !== entry.segments.length) return undefined;

	const params: Record<string, unknown> = {};
	for (let index = 0; index < entry.segments.length; index += 1) {
		// Percent-decoded per segment, not on the whole path: a session id or a tool call id is opaque
		// and may contain a colon or a slash's worth of punctuation, and `decodeURI` leaves `%3A` alone
		// while a raw `%2F` must not be allowed to split one segment into two.
		const segment = decodeSegment(segments[index] ?? "");
		if (segment === undefined) return undefined;
		const pattern = entry.segments[index] ?? "";
		if (!pattern.startsWith(":")) {
			if (pattern !== segment) return undefined;
			continue;
		}

		const name = pattern.slice(1);
		const parse = entry.params[name];
		if (parse === undefined) return undefined;
		const value = parse(segment);
		if (value === undefined) return undefined;
		params[name] = value;
	}
	return params;
}

/** A path segment as written, or `undefined` when it is not valid percent-encoding. */
function decodeSegment(segment: string): string | undefined {
	try {
		return decodeURIComponent(segment);
	} catch {
		// A malformed escape is not a resource this server has; the router treats it as no match.
		return undefined;
	}
}

function isMethod(method: string): method is Method {
	return method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}
