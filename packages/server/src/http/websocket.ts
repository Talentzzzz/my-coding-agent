import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";

/**
 * The constant RFC 6455 §1.3 appends to the client's key before hashing. It exists so that a server
 * which has implemented the handshake cannot be confused with one that has merely heard of it.
 */
const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Opcodes this server reads or writes. The reserved ones are named only to be refused. */
const OPCODE = {
	continuation: 0x0,
	text: 0x1,
	binary: 0x2,
	close: 0x8,
	ping: 0x9,
	pong: 0xa,
} as const;

/** Close codes this server sends. 1013 is the one that means "you stopped reading". */
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_TOO_LARGE = 1009;
const CLOSE_TRY_AGAIN_LATER = 1013;

/**
 * The largest frame this server will buffer before giving up on a peer.
 *
 * A frame header is ten bytes and its length field is 64-bit, so "read whatever the peer claims" is
 * a promise to allocate up to four exabytes. Client frames are masked, which makes a claim cheap to
 * make and expensive to honour, so the ceiling is enforced before the payload is read rather than
 * after. It is far above any frame this server sends — the largest is a session baseline — so a peer
 * that hits it is either broken or hostile, and both end the same way.
 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * What a connection tells its owner.
 *
 * Three callbacks, because the connection layer has exactly three things to say: a client frame
 * arrived, the connection is over, and — separately — the connection is *unusable*. The last is what
 * a stalled peer looks like from here, and collapsing it into "over" would report a liveness failure
 * as an ordinary disconnect.
 */
export interface WebSocketHandlers {
	/** One complete text message, already unmasked and un-fragmented. */
	onMessage(text: string): void;
	/** The connection ended for any reason. Fires exactly once. */
	onClose(): void;
	/** The peer violated the protocol; the connection is being closed because of it. */
	onProtocolError(reason: string): void;
	/**
	 * A Pong arrived, so the peer is still there.
	 *
	 * Its own callback rather than something the owner polls for, because the alternative — asking the
	 * connection whether it has been answered — cannot distinguish "answered just now" from "answered
	 * long ago", and a liveness check that cannot tell those apart eventually kills a healthy peer.
	 */
	onPong(): void;
}

/**
 * One accepted WebSocket connection, as this server sees it.
 *
 * Hand-written rather than delegated, and the reason is not the codec. It is that the *write* side
 * has to be inspectable: the bounded queue needs `write()` to return `false` at the moment the
 * socket stops accepting, and it needs a `close()` it can call with a code. A wrapper that swallowed
 * either behind a "send returns void" API could not be given a budget at all.
 *
 * The read side is deliberately thin. Frames are reassembled here and handed up as whole text
 * messages; nothing above this layer sees an opcode, a mask, or a fragment.
 */
export class WebSocketConnection {
	/**
	 * Bytes read but not yet forming a whole frame.
	 *
	 * Typed as the wide `Buffer` so a chunk handed over by Node's stream types and one allocated here
	 * are the same type — the narrow default that `Buffer.alloc` infers is not assignable from a
	 * socket's `data` event, and the two meet on every single read.
	 */
	private buffer: Buffer = Buffer.alloc(0);
	/** The opcode a fragmented message started with, or null between messages. */
	private fragmentOpcode: number | null = null;
	/** The pieces of the message being assembled. */
	private fragments: Buffer[] = [];
	/** Whether this end has sent a Close frame. RFC 6455 §5.5.1: after it, nothing else may be sent. */
	private closeSent = false;
	private closed = false;
	/** Whether the underlying socket is gone, whatever the protocol thinks. */
	private gone = false;
	/**
	 * The owner, until {@link start} names one.
	 *
	 * Defaults rather than a constructor argument so the socket cannot deliver a frame between the
	 * handshake and the caller's own bookkeeping: `accept` returns a connection, and `start` is where
	 * the owner says what to do with it.
	 */
	private handlers: WebSocketHandlers = {
		onMessage: () => {},
		onClose: () => {},
		onProtocolError: () => {},
		onPong: () => {},
	};

	private readonly socket: Duplex;

	private constructor(socket: Duplex) {
		this.socket = socket;
	}

	/**
	 * Complete the handshake on a socket that has just been upgraded, or refuse it.
	 *
	 * Returns the connection when the request was a valid handshake, or `undefined` after writing a
	 * refusal — the caller destroys the socket in that case. The refusal is a complete HTTP response
	 * rather than a bare close, because the peer has not spoken WebSocket yet and will read whatever
	 * HTTP says.
	 */
	static accept(request: { headers: Record<string, unknown> }, socket: Duplex): WebSocketConnection | undefined {
		const key = request.headers["sec-websocket-key"];
		const version = request.headers["sec-websocket-version"];
		const upgrade = request.headers.upgrade;

		if (typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket") {
			refuse(socket, 400, "Bad Request", "This endpoint speaks WebSocket.");
			return undefined;
		}
		// RFC 6455 §4.2.1: the version is a single token, and 13 is the only one that exists.
		if (version !== "13") {
			refuse(socket, 400, "Bad Request", "Only WebSocket version 13 is supported.");
			return undefined;
		}
		if (typeof key !== "string" || key.length === 0) {
			refuse(socket, 400, "Bad Request", "A Sec-WebSocket-Key header is required.");
			return undefined;
		}

		const accept = createHash("sha1").update(key + HANDSHAKE_GUID).digest("base64");
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\n" +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		return new WebSocketConnection(socket);
	}

	/**
	 * Start reading, calling back through `handlers`.
	 *
	 * Separate from construction so the caller can hold the connection before anything can arrive on
	 * it — a `data` listener attached in the constructor could fire before the owner had a reference
	 * to store the first frame against. Bytes that arrived between the handshake and this call are
	 * still in Node's buffer and are delivered as soon as the listener is attached.
	 */
	start(handlers: WebSocketHandlers): void {
		this.handlers = handlers;

		this.socket.on("data", (chunk: Buffer) => {
			this.consume(chunk);
		});
		this.socket.on("close", () => this.finish());
		this.socket.on("end", () => this.finish());
		this.socket.on("error", () => this.finish());
	}

	/**
	 * Feed in bytes that arrived with the upgrade request itself.
	 *
	 * The last frame a client sends can be part of the same TCP segment as the handshake, and Node hands
	 * those bytes over as `head` rather than as a `data` event. Dropping them would lose a frame that
	 * was legitimately sent — and a client whose very first act is `open` is exactly the case, so this
	 * is not a corner. Idempotent to call with an empty buffer, which is what makes it safe to call
	 * unconditionally.
	 */
	replay(head: Buffer): void {
		if (head.length === 0) return;
		this.consume(head);
	}

	/**
	 * Write one text frame.
	 *
	 * Returns what the socket's own `write()` returned, and that return value is the entire basis of
	 * the backpressure policy above: `false` means the kernel or the socket's buffer is full, and from
	 * here on this connection must not be written to directly. Nothing here retries, buffers, or
	 * throws — a caller that needs those has to own them, because only the caller knows what
	 * dropping a frame would cost.
	 *
	 * A connection that has sent its Close frame is inert, and says so by returning `true`: from the
	 * caller's side there is nothing more to write and nothing more to wait for.
	 */
	send(text: string): boolean {
		if (this.closed || this.gone) return true;
		if (this.closeSent) return true;
		return this.socket.write(encode(OPCODE.text, Buffer.from(text, "utf8")));
	}

	/**
	 * Send a Ping.
	 *
	 * A control frame, so it bypasses the application queue entirely — see {@link send} for why that
	 * return value is not offered here. RFC 6455 §5.5.2 caps a control payload at 125 bytes, which
	 * this server never approaches: it sends an empty Ping and correlates by arrival order.
	 */
	ping(): void {
		if (this.closed || this.gone || this.closeSent) return;
		this.socket.write(encode(OPCODE.ping, Buffer.alloc(0)));
	}

	/**
	 * Send a Close frame and let the socket finish.
	 *
	 * `code` and `reason` are the code and text the peer will see. Only the first Close frame counts:
	 * a second one is a protocol error, and a connection that has already said goodbye answers a
	 * peer's goodbye with silence rather than with another one.
	 */
	close(code: number = CLOSE_NORMAL, reason = ""): void {
		if (this.closed || this.gone) return;
		if (this.closeSent) {
			// The peer asked first; our end is done once the frame it sent has been answered.
			this.end();
			return;
		}
		this.closeSent = true;

		const reasonBytes = Buffer.from(reason, "utf8");
		// RFC 6455 §5.5.1: the reason may not push the control payload past 125 bytes. A longer one is
		// truncated rather than refused — the code is the part the client acts on.
		const room = 125 - 2;
		const trimmed = reasonBytes.length > room ? reasonBytes.subarray(0, room) : reasonBytes;
		const payload = Buffer.alloc(2 + trimmed.length);
		payload.writeUInt16BE(code, 0);
		trimmed.copy(payload, 2);

		this.socket.write(encode(OPCODE.close, payload));
		this.end();
	}

	/**
	 * Drop the connection without a closing handshake.
	 *
	 * For a peer that has stopped answering, where waiting out a handshake would mean waiting out a
	 * peer that is not there. Everything the connection held goes with the socket.
	 */
	terminate(): void {
		if (this.gone) return;
		this.gone = true;
		this.socket.destroy();
		this.finish();
	}

	/** Whether this connection has ended, whoever ended it. */
	get isClosed(): boolean {
		return this.closed || this.gone;
	}

	/**
	 * Half-close the socket and let Node finish what is buffered.
	 *
	 * The write side is ended rather than destroyed so a Close frame that has already been queued
	 * still reaches a peer that is reading — a close the peer never sees is indistinguishable, from
	 * the peer, from the process having died.
	 */
	private end(): void {
		if (this.gone) return;
		this.socket.end();
	}

	/** Report the connection over, exactly once. */
	private finish(): void {
		if (this.closed) return;
		this.closed = true;
		this.buffer = Buffer.alloc(0);
		this.fragments = [];
		this.handlers.onClose();
	}

	/**
	 * Fail the connection on a protocol violation, and say why with a code of its own.
	 *
	 * `code` is a parameter rather than always 1002 because two of these failures are not the same
	 * fault: a frame this server cannot represent is 1009 ("too large"), while everything else — a
	 * reserved bit, a missing mask, bad UTF-8, a stray continuation — is 1002. The distinction matters
	 * to whoever is looking at the close, and it is invisible if the code is hardcoded here.
	 *
	 * One log line per failure, because a peer speaking the wrong protocol is the one failure a server
	 * can neither ignore nor retry around: the frames it sent cannot be interpreted, so the only honest
	 * answer is to say so and stop.
	 */
	private fail(reason: string, code: number = CLOSE_PROTOCOL_ERROR): void {
		this.handlers.onProtocolError(reason);
		this.close(code, reason);
	}

	/**
	 * Take in bytes and hand up whatever whole frames they complete.
	 *
	 * Loops rather than recurses on the tail, so a peer that packs many small frames into one chunk
	 * costs one pass rather than one stack frame each.
	 */
	private consume(chunk: Buffer): void {
		if (this.closed) return;
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

		for (;;) {
			const frame = this.take();
			if (frame === undefined) return;
			this.dispatch(frame.fin, frame.opcode, frame.payload);
			if (this.closed) return;
		}
	}

	/**
	 * Pull one whole frame off the buffer, or answer `undefined` if the bytes so far do not make one.
	 *
	 * Every length is validated before it is trusted: a masked frame's mask is four bytes that must
	 * be present before the payload can be located at all, and the 64-bit length is refused outright
	 * rather than narrowed, because narrowing it is how a peer gets you to allocate a small buffer for
	 * a large frame.
	 */
	private take(): { fin: boolean; opcode: number; payload: Buffer } | undefined {
		const buffer = this.buffer;
		if (buffer.length < 2) return undefined;

		const first = buffer[0] ?? 0;
		const second = buffer[1] ?? 0;
		const fin = (first & 0x80) !== 0;
		// No extension has been negotiated, so all three reserved bits must be clear.
		if ((first & 0x70) !== 0) {
			this.fail("A reserved bit was set but no extension was negotiated.");
			return undefined;
		}
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		// RFC 6455 §5.1: a frame from a client to a server must be masked, and an unmasked one is the
		// clearest sign that the peer is not speaking this protocol at all.
		if (!masked) {
			this.fail("A client frame arrived unmasked.");
			return undefined;
		}

		let length = second & 0x7f;
		let offset = 2;
		if (length === 126) {
			if (buffer.length < offset + 2) return undefined;
			length = buffer.readUInt16BE(offset);
			offset += 2;
		} else if (length === 127) {
			if (buffer.length < offset + 8) return undefined;
			const wide = buffer.readBigUInt64BE(offset);
			if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
				this.fail("A frame declared a length this server cannot represent.");
				return undefined;
			}
			length = Number(wide);
			offset += 8;
		}
		// A control frame carries no continuation and stays under 125 bytes (RFC 6455 §5.5).
		const isControl = (opcode & 0x8) !== 0;
		if (isControl && (length > 125 || !fin)) {
			this.fail("A control frame was fragmented or too long.");
			return undefined;
		}
		if (length > MAX_FRAME_BYTES) {
			// 1009, and the only place that code is used: `fail` closes the connection itself, so calling
			// `close` again here would be swallowed by the Close frame already sent.
			this.fail(`A frame of ${length} bytes is larger than this server accepts.`, CLOSE_TOO_LARGE);
			return undefined;
		}

		// The four mask bytes sit between the length and the payload, and are needed to locate it.
		if (buffer.length < offset + 4) return undefined;
		const mask = buffer.subarray(offset, offset + 4);
		offset += 4;

		if (buffer.length < offset + length) return undefined;
		const payload = Buffer.from(buffer.subarray(offset, offset + length));
		for (let index = 0; index < payload.length; index += 1) {
			payload[index] = (payload[index] as number) ^ (mask[index % 4] as number);
		}
		this.buffer = buffer.subarray(offset + length);

		return { fin, opcode, payload };
	}

	/** Act on one whole frame: control frames here, messages reassembled first. */
	private dispatch(fin: boolean, opcode: number, payload: Buffer): void {
		switch (opcode) {
			case OPCODE.close:
				this.onCloseFrame(payload);
				return;
			case OPCODE.ping:
				// RFC 6455 §5.5.2: a Pong echoing the payload, promptly, and not subject to whatever
				// the application layer is doing — which is why it is answered from inside the frame
				// reader rather than handed to the queue below.
				if (!this.closeSent) this.socket.write(encode(OPCODE.pong, payload));
				return;
			case OPCODE.pong:
				// The whole point of a Pong: the peer heard a Ping and says so. Reported rather than
				// swallowed, because it is the only evidence of liveness this side will ever get.
				this.handlers.onPong();
				return;
			case OPCODE.continuation:
				this.onContinuation(fin, payload);
				return;
			case OPCODE.text:
			case OPCODE.binary:
				this.onData(fin, opcode, payload);
				return;
			default:
				this.fail(`Opcode 0x${opcode.toString(16)} is reserved.`);
				return;
		}
	}

	/** Start a message, or refuse one that would interleave with the one in progress. */
	private onData(fin: boolean, opcode: number, payload: Buffer): void {
		if (this.fragmentOpcode !== null) {
			this.fail("A new message started before the previous one finished.");
			return;
		}
		if (fin) {
			this.deliver(opcode, payload);
			return;
		}
		this.fragmentOpcode = opcode;
		this.fragments = [payload];
	}

	/** Continue, or finish, the message being assembled. */
	private onContinuation(fin: boolean, payload: Buffer): void {
		const opcode = this.fragmentOpcode;
		if (opcode === null) {
			this.fail("A continuation frame arrived with no message to continue.");
			return;
		}
		this.fragments.push(payload);
		if (!fin) return;

		this.fragmentOpcode = null;
		const whole = Buffer.concat(this.fragments);
		this.fragments = [];
		this.deliver(opcode, whole);
	}

	/**
	 * Hand a whole message up.
	 *
	 * Binary is refused rather than base64'd: this protocol's uplink is two JSON frames, and a peer
	 * sending binary is a peer speaking something else, which is the same situation as a bad opcode.
	 */
	private deliver(opcode: number, payload: Buffer): void {
		if (opcode === OPCODE.binary) {
			this.fail("This protocol carries text frames only.");
			return;
		}
		// RFC 6455 §5.6: a text frame that is not valid UTF-8 fails the connection. Decoding without
		// `fatal` would substitute replacement characters and hand a peer a message it never sent.
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
		} catch {
			this.fail("A text frame was not valid UTF-8.");
			return;
		}
		this.handlers.onMessage(text);
	}

	/**
	 * Answer a peer's Close.
	 *
	 * RFC 6455 §5.5.1: echo the code back when one was given, and close the socket. If this end
	 * already sent a Close, the handshake is half-done and the socket is simply finished — a second
	 * Close frame would itself be a protocol error.
	 */
	private onCloseFrame(payload: Buffer): void {
		if (this.closeSent) {
			this.end();
			this.finish();
			return;
		}
		if (payload.length === 1) {
			this.fail("A Close frame carried a one-byte payload.");
			return;
		}
		if (payload.length >= 2) {
			// Echo the peer's own code rather than inventing one, so a client that asked to leave sees
			// the reason it asked for.
			this.socket.write(encode(OPCODE.close, payload.subarray(0, 2)));
		}
		this.closeSent = true;
		this.end();
		this.finish();
	}
}

/** The 101 handshake's companion: an HTTP refusal, for a request that never became a WebSocket. */
function refuse(socket: Duplex, status: number, phrase: string, message: string): void {
	const body = `${message}\n`;
	socket.write(
		`HTTP/1.1 ${status} ${phrase}\r\n` +
			"content-type: text/plain; charset=utf-8\r\n" +
			`content-length: ${Buffer.byteLength(body)}\r\n` +
			"connection: close\r\n" +
			"\r\n" +
			body,
	);
	socket.destroy();
}

/**
 * One unmasked, unfragmented frame — the only shape this server ever writes.
 *
 * Server-to-client frames are never masked (RFC 6455 §5.1) and never fragmented: a frame this server
 * sends is a whole JSON document, and splitting one would only cost header bytes per fragment to
 * express something the reader has to reassemble anyway.
 */
function encode(opcode: number, payload: Buffer): Buffer {
	const length = payload.length;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.allocUnsafe(2);
		header[0] = 0x80 | opcode;
		header[1] = length;
	} else if (length < 65_536) {
		header = Buffer.allocUnsafe(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.allocUnsafe(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([header, payload], header.length + length);
}
