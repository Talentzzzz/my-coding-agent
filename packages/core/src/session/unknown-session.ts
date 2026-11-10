/**
 * The failure "this id names no session", as a type rather than a sentence.
 *
 * It exists so the transport does not have to *ask* before it acts. A caller that has to check
 * existence first is a caller that can get the answer wrong twice — once when it asks, once when the
 * answer changes between the question and the command — and the check has to be spelled in the same
 * place for every endpoint. Here the command itself refuses, and the transport maps one type to one
 * status, which is the shape every unknown-id path takes: a read, a delete, a hold, a prompt.
 *
 * The message is kept stable because it is also the 404 body a client shows: `Unknown session: <id>`.
 */
export class UnknownSessionError extends Error {
	/** The id that named nothing, for a caller that has to tell several of them apart. */
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Unknown session: ${sessionId}`);
		this.name = "UnknownSessionError";
		this.sessionId = sessionId;
	}
}
