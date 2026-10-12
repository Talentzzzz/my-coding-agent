import type { ServerResponse } from "node:http";
import { httpStatus } from "../http/errors.ts";
import { openEventStream } from "../http/event-stream.ts";
import type { SessionHub } from "../hub.ts";
import type { StreamRegistry } from "../stream-registry.ts";

/**
 * The one streaming endpoint: everything a session pushes, for as long as a client is listening.
 *
 * The stream is the read half of a session and the controllers are the write half, which is the
 * whole shape of this transport. It replaces the server-to-client half of the old socket: the same
 * frames, in the same order — the snapshot first, then one frame per session event, one per entry
 * that event names, and one per status change.
 */
export class EventController {
	private readonly registry: StreamRegistry;
	/**
	 * Asked whether a session exists before the registry is.
	 *
	 * Held rather than reached through the registry because existence is the hub's question, not the
	 * stream's: `hub.has` answers it for a session on disk as well as one this process runs.
	 */
	private readonly hub: SessionHub;

	constructor(registry: StreamRegistry, hub: SessionHub) {
		this.registry = registry;
		this.hub = hub;
	}

	/**
	 * Attach a response to a session.
	 *
	 * Existence is settled here, before the registry is asked to claim, because the registry's answer
	 * for an id it cannot find is the transport's own 500: `SessionHub.claim` throws a plain `Error`,
	 * and a plain error is a bug by this server's own rule. An id that names no session is not a bug —
	 * it is a 404, and it has to be one on the *stream* as much as on the read, because a window
	 * decides a session is gone by asking for it this way.
	 *
	 * The check takes no claim and writes nothing: nothing is written until the claim below succeeds.
	 */
	async stream(sessionId: string, response: ServerResponse): Promise<void> {
		if (!this.hub.has(sessionId)) throw httpStatus.notFound(`Unknown session: ${sessionId}`);
		await this.registry.open(sessionId, () => openEventStream(response));
	}

	/**
	 * The sessions with a stream attached, for the health endpoint.
	 *
	 * Deliberately not the hub's live set: a session a request is holding open is running without
	 * anybody watching it, and that is a different thing from being streamed.
	 */
	streaming(): readonly string[] {
		return this.registry.streaming();
	}
}
