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
	return { status: 500, message: error instanceof Error ? error.message : String(error) };
}

/** How much body this server is willing to read: a prompt and a few names, never a file upload. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Read a JSON request body.
 *
 * Both halves of "the client sent something wrong" are a 400: a body that is not JSON, and a body
 * larger than this server will read. The size limit is checked before reading, because it exists to
 * bound memory, not to be reported after a megabyte already arrived.
 */
export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
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

	const text = Buffer.concat(chunks).toString("utf8").trim();
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
	const body = await readJsonBody(request);
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw httpStatus.badRequest("Request body must be a JSON object");
	}
	return body as Record<string, unknown>;
}
