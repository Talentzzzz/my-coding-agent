import { UnknownSessionError } from "@my-agent/core";
import type { IncomingMessage } from "node:http";

/**
 * A failure that already carries the status it should be answered with.
 *
 * This is the transport's only error type. Controllers throw it, the router maps it, and nothing in
 * between needs to know about HTTP. An error that is not an `HttpError` is a bug — it is answered as
 * a 500 and reported as such, including the message, because this is a local single-user server.
 */
export class HttpError extends Error {
	readonly status: number;
	/**
	 * Extra response headers this failure needs.
	 *
	 * Only `allow` uses it, for a 405: the header has to be written with the status, and calling
	 * `setHeader` before the router decides to answer at all is what made a 405 come back as a 500.
	 */
	headers?: Record<string, string>;

	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

/**
 * The statuses this API uses, by what the caller did rather than by number.
 *
 * Keeping the names here is what stops a controller from reaching for a bare `404` and leaves one
 * place to read the table: `/api/sessions/{id}` with an unknown id is `notFound`, a body that is not
 * JSON is `badRequest`, a tool name the session does not know is `conflict` (the session refused the
 * change, and the same request can succeed once the name is right).
 */
export const httpStatus = {
	badRequest: (message: string) => new HttpError(400, message),
	notFound: (message: string) => new HttpError(404, message),
	conflict: (message: string) => new HttpError(409, message),
} as const;

/** The status and message a thrown value deserves, including errors that never meant to be HTTP. */
export function internalError(error: unknown): { status: number; message: string } {
	if (error instanceof HttpError) return { status: error.status, message: error.message };
	// The data layer's own refusal, named as a type instead of sniffed from a sentence: an id that
	// exists nowhere. Every unknown-session road ends here, which is why no endpoint checks first.
	if (error instanceof UnknownSessionError) return { status: 404, message: error.message };
	return { status: 500, message: error instanceof Error ? error.message : String(error) };
}

/** How much body this server is willing to read: a prompt and a few names, never a file upload. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * The request body as text, trimmed, bounded by the size cap.
 *
 * The one reader both object readers share, because the cap exists to bound memory and is therefore
 * checked before reading — a check written twice would eventually be written once without it. The
 * size limit is reported before the megabyte arrives, not after.
 */
async function readBodyText(request: IncomingMessage): Promise<string> {
	const length = Number.parseInt(request.headers["content-length"] ?? "", 10);
	if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
		throw httpStatus.badRequest(`Request body is larger than ${MAX_BODY_BYTES} bytes`);
	}

	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = chunk as Buffer;
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw httpStatus.badRequest(`Request body is larger than ${MAX_BODY_BYTES} bytes`);
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8").trim();
}

/** The text as an object, or the two 400s a malformed body deserves. */
function parseObject(text: string): Record<string, unknown> {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw httpStatus.badRequest("Request body is not valid JSON");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw httpStatus.badRequest("Request body must be a JSON object");
	}
	return body as Record<string, unknown>;
}

/**
 * Read a JSON request body.
 *
 * An absent body is refused here rather than answered, because every caller of this reader names a
 * required field off it.
 */
export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const text = await readBodyText(request);
	if (text.length === 0) throw httpStatus.badRequest("A JSON body is required");
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw httpStatus.badRequest("Request body is not valid JSON");
	}
}

/**
 * The JSON body as an object, or a 400.
 *
 * Controllers destructure fields off the result, so this is where "the body is an object at all" is
 * settled once instead of in every handler.
 */
export async function readObjectBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	return parseObject(await readBodyText(request));
}

/**
 * The JSON body as an object, or `{}` when there is nothing there.
 *
 * For the one endpoint whose body names no required field: an empty `POST /api/sessions` has always
 * created a session, and the `workDirAbsPath` that may join it must not turn that into a request that needs a
 * body. Size and shape are checked exactly as {@link readObjectBody} checks them — only "empty" is
 * answered rather than refused.
 */
export async function optionalObjectBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const text = await readBodyText(request);
	return text.length === 0 ? {} : parseObject(text);
}
