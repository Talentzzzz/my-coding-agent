import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";

/**
 * RFC 6455 §1.3 规定追加到客户端 key 之后再做哈希的常量。它存在的原因是：让一个真正实现了握手的服务器，不会与一个只是听说过该协议的服务器混淆。
 */
const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** 本服务器会读写的 opcode。保留的几个被命名只是为了拒绝它们。 */
const OPCODE = {
	continuation: 0x0,
	text: 0x1,
	binary: 0x2,
	close: 0x8,
	ping: 0x9,
	pong: 0xa,
} as const;

/** 本服务器会发送的 Close code。1013 就是那个表示"你停止读取了"的码。 */
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_TOO_LARGE = 1009;
const CLOSE_TRY_AGAIN_LATER = 1013;

/**
 * 本服务器在放弃一个 peer 之前愿意缓冲的最大 frame 大小。
 *
 * frame 头是十个字节，长度字段是 64 位，所以"peer 声称多大就读多大"等于承诺分配至多四 exabyte。客户端 frame 是带掩码的，声明一个巨大的长度毫无成本、兑现却代价高昂，所以上限在读取 payload 之前强制执行，而不是之后。它远高于本服务器会发送的任何 frame——最大的是一个 session baseline——因此撞上这个上限的 peer 要么坏了要么有恶意，两者的结局相同。
 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * 连接向其所有者报告的事情。
 *
 * 三个回调，因为连接层恰好有三件事要说：一个客户端 frame 到达、连接结束、以及——单独一回事——连接*不可用*。最后一件就是停滞的 peer 从这里看起来的样子；把它并入"结束"会把存活性问题当成一次普通断连报告出去。
 */
export interface WebSocketHandlers {
	/** 一条完整的文本消息，已去掩码、已拼装。 */
	onMessage(text: string): void;
	/** 连接因任何原因结束。恰好触发一次。 */
	onClose(): void;
	/** peer 违反了协议；连接因此被关闭。 */
	onProtocolError(reason: string): void;
	/**
	 * 收到一个 Pong，说明 peer 还在。
	 *
	 * 它有自己的回调，而不是让所有者轮询，因为替代方案——问连接是否已被应答——无法区分"刚刚应答"和"很久以前应答"，而一个分不清这两者的存活检查最终会杀掉健康的 peer。
	 */
	onPong(): void;
}

/**
 * 一个被接受的 WebSocket 连接，按本服务器所见的形态。
 *
 * 手写而不是委托出去，原因不在编解码。而是在于*写入*侧必须可检视：有界队列需要 `write()` 在 socket 停止接收的那一刻返回 `false`，还需要一个可以带 code 调用的 `close()`。一个把这两者都吞在"send 返回 void"背后的包装层，根本无法被给予预算。
 *
 * 读取侧刻意很薄。frame 在这里拼装，以整条文本消息上交；这层之上的任何东西都看不到 opcode、掩码或分片。
 */
export class WebSocketConnection {
	/**
	 * 已读但尚未构成完整 frame 的字节。
	 *
	 * 类型声明为宽的 `Buffer`，让 Node 流类型交来的 chunk 和这里分配的 buffer 是同一类型——`Buffer.alloc` 推导出的窄默认类型无法从 socket 的 `data` 事件赋值，而两者在每次读取时都会相遇。
	 */
	private buffer: Buffer = Buffer.alloc(0);
	/** 分片消息开始时的 opcode，消息之间为 null。 */
	private fragmentOpcode: number | null = null;
	/** 正在拼装的消息的各个片段。 */
	private fragments: Buffer[] = [];
	/** 本端是否已发送 Close frame。RFC 6455 §5.5.1：之后不能再发送任何东西。 */
	private closeSent = false;
	private closed = false;
	/** 底层 socket 是否已经消失，无论协议层怎么认为。 */
	private gone = false;
	/**
	 * 所有者，直到 {@link start} 指定为止。
	 *
	 * 用默认值而不是构造参数，这样 socket 无法在握手与调用者自己的簿记之间投递 frame：`accept` 返回一个连接，`start` 才是所有者决定如何处理它的地方。
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
	 * 在刚被升级的 socket 上完成握手，或拒绝它。
	 *
	 * 请求是合法握手时返回连接；否则在写完拒绝响应后返回 `undefined`——那种情况下调用者销毁 socket。拒绝是一个完整的 HTTP 响应而不是裸关闭，因为 peer 还没说过 WebSocket，它读到的是 HTTP 说什么。
	 */
	static accept(request: { headers: Record<string, unknown> }, socket: Duplex): WebSocketConnection | undefined {
		const key = request.headers["sec-websocket-key"];
		const version = request.headers["sec-websocket-version"];
		const upgrade = request.headers.upgrade;

		if (typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket") {
			refuse(socket, 400, "Bad Request", "This endpoint speaks WebSocket.");
			return undefined;
		}
		// RFC 6455 §4.2.1：version 是单个 token，而 13 是唯一存在的一个。
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
	 * 开始读取，通过 `handlers` 回调。
	 *
	 * 与构造分离，让调用者能在任何东西到达之前先持有连接——构造函数里挂的 `data` 监听器可能在所有者还没拿到引用去存放第一个 frame 之前就触发。握手与本调用之间到达的字节仍在 Node 的缓冲里，监听器一挂上就会送达。
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
	 * 喂入随升级请求一起到达的字节。
	 *
	 * 客户端发送的最后一个 frame 可能与握手在同一个 TCP segment 里，Node 把那些字节作为 `head` 交出而不是作为 `data` 事件。丢掉它们会丢掉一个合法发送的 frame——而客户端的第一个动作就是 `open` 恰恰是常态，所以这不是角落情况。传空 buffer 是幂等的，这正是可以无条件调用的原因。
	 */
	replay(head: Buffer): void {
		if (head.length === 0) return;
		this.consume(head);
	}

	/**
	 * 写一个文本 frame。
	 *
	 * 返回 socket 自己的 `write()` 返回的值，而这个返回值就是上面 backpressure 策略的全部依据：`false` 表示内核或 socket 缓冲已满，从这一刻起不得再直接向这个连接写入。这里不做重试、缓冲或抛出——需要这些的调用者必须自己拥有它们，因为只有调用者知道丢一个 frame 的代价。
	 *
	 * 已发送 Close frame 的连接是惰性的，通过返回 `true` 表明：从调用者一侧看，没有更多可写，也没有更多可等。
	 */
	send(text: string): boolean {
		if (this.closed || this.gone) return true;
		if (this.closeSent) return true;
		return this.socket.write(encode(OPCODE.text, Buffer.from(text, "utf8")));
	}

	/**
	 * 发送一个 Ping。
	 *
	 * 控制帧，完全绕开应用层队列——至于为什么这里不提供那个返回值，见 {@link send}。RFC 6455 §5.5.2 把控制帧 payload 上限定在 125 字节，本服务器远达不到：它发送空 Ping，按到达顺序关联。
	 */
	ping(): void {
		if (this.closed || this.gone || this.closeSent) return;
		this.socket.write(encode(OPCODE.ping, Buffer.alloc(0)));
	}

	/**
	 * 发送 Close frame 并让 socket 收尾。
	 *
	 * `code` 和 `reason` 是 peer 将看到的码和文本。只有第一个 Close frame 有效：第二个是协议错误，已经道过别的连接以沉默回应 peer 的道别，而不是再道一次。
	 */
	close(code: number = CLOSE_NORMAL, reason = ""): void {
		if (this.closed || this.gone) return;
		if (this.closeSent) {
			// peer 先请求了关闭；我们发的 frame 被应答后，本端就完成了。
			this.end();
			return;
		}
		this.closeSent = true;

		const reasonBytes = Buffer.from(reason, "utf8");
		// RFC 6455 §5.5.1：reason 不得让控制帧 payload 超过 125 字节。超长的被截断而不是拒绝——code 才是客户端据此行动的部分。
		const room = 125 - 2;
		const trimmed = reasonBytes.length > room ? reasonBytes.subarray(0, room) : reasonBytes;
		const payload = Buffer.alloc(2 + trimmed.length);
		payload.writeUInt16BE(code, 0);
		trimmed.copy(payload, 2);

		this.socket.write(encode(OPCODE.close, payload));
		this.end();
	}

	/**
	 * 不做关闭握手，直接丢弃连接。
	 *
	 * 用于已停止应答的 peer——对这样的 peer 等握手结束等于等一个不在场的东西。连接持有的一切随 socket 一起消失。
	 */
	terminate(): void {
		if (this.gone) return;
		this.gone = true;
		this.socket.destroy();
		this.finish();
	}

	/** 本连接是否已结束，无论由谁结束。 */
	get isClosed(): boolean {
		return this.closed || this.gone;
	}

	/**
	 * 半关闭 socket，让 Node 把已缓冲的内容写完。
	 *
	 * 结束写入侧而不是销毁，这样已入队的 Close frame 仍能到达正在读取的 peer——一个 peer 永远看不到的关闭，从 peer 的角度与进程已死无异。
	 */
	private end(): void {
		if (this.gone) return;
		this.socket.end();
	}

	/** 恰好一次地报告连接已结束。 */
	private finish(): void {
		if (this.closed) return;
		this.closed = true;
		this.buffer = Buffer.alloc(0);
		this.fragments = [];
		this.handlers.onClose();
	}

	/**
	 * 因协议违规判定连接失败，并用专属的 code 说明原因。
	 *
	 * `code` 是参数而不是恒为 1002，因为这些失败里有两个不属于同一种过错：本服务器无法表示的 frame 是 1009（"too large"），其余——保留位、缺掩码、坏 UTF-8、多余的 continuation——是 1002。这个区别对查看关闭原因的人很重要，而 code 硬编码在这里时它就不可见了。
	 *
	 * 每次失败一行日志，因为 peer 说错协议是服务器既不能忽略也不能重试绕过的唯一失败：它发来的 frame 无法解读，唯一诚实的做法就是说明并停止。
	 */
	private fail(reason: string, code: number = CLOSE_PROTOCOL_ERROR): void {
		this.handlers.onProtocolError(reason);
		this.close(code, reason);
	}

	/**
	 * 收下字节，把补齐的整 frame 上交。
	 *
	 * 对尾部循环而不是递归，这样把许多小 frame 塞进一个 chunk 的 peer 只花一趟扫描，而不是每 frame 一个栈帧。
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
	 * 从缓冲取出一个完整 frame，目前的字节不够一个时返回 `undefined`。
	 *
	 * 每个长度在被信任之前都先验证：带掩码 frame 的掩码是四个字节，必须先在场上才能定位 payload；64 位长度被直接拒绝而不是收窄，因为收窄正是 peer 让你为大 frame 分配小 buffer 的手法。
	 */
	private take(): { fin: boolean; opcode: number; payload: Buffer } | undefined {
		const buffer = this.buffer;
		if (buffer.length < 2) return undefined;

		const first = buffer[0] ?? 0;
		const second = buffer[1] ?? 0;
		const fin = (first & 0x80) !== 0;
		// 未协商任何扩展，所以三个保留位必须全部为零。
		if ((first & 0x70) !== 0) {
			this.fail("A reserved bit was set but no extension was negotiated.");
			return undefined;
		}
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		// RFC 6455 §5.1：客户端发给服务器的 frame 必须带掩码，不带掩码是 peer 根本不在说这个协议的最明确信号。
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
		// 控制帧不携带 continuation，且必须小于 125 字节（RFC 6455 §5.5）。
		const isControl = (opcode & 0x8) !== 0;
		if (isControl && (length > 125 || !fin)) {
			this.fail("A control frame was fragmented or too long.");
			return undefined;
		}
		if (length > MAX_FRAME_BYTES) {
			// 1009，也是该 code 唯一被使用的地方：`fail` 自己会关闭连接，在这里再调 `close` 会被已发送的 Close frame 吞掉。
			this.fail(`A frame of ${length} bytes is larger than this server accepts.`, CLOSE_TOO_LARGE);
			return undefined;
		}

		// 四个掩码字节位于长度与 payload 之间，定位 payload 需要它们。
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

	/** 处理一个完整 frame：控制帧在这里处理，消息先拼装。 */
	private dispatch(fin: boolean, opcode: number, payload: Buffer): void {
		switch (opcode) {
			case OPCODE.close:
				this.onCloseFrame(payload);
				return;
			case OPCODE.ping:
				// RFC 6455 §5.5.2：回一个回显 payload 的 Pong，要及时，且不受应用层正在做什么的影响——这就是为什么在 frame 读取器内部应答，而不是交给下面的队列。
				if (!this.closeSent) this.socket.write(encode(OPCODE.pong, payload));
				return;
			case OPCODE.pong:
				// Pong 的全部意义：peer 听到了 Ping 并这样说。上报而不是吞掉，因为这是本侧能得到的唯一存活证据。
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

	/** 开始一条消息，或拒绝与进行中的消息交错的开始。 */
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

	/** 继续或完成正在拼装的消息。 */
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
	 * 把整条消息上交。
	 *
	 * 拒绝二进制而不是 base64：本协议的上行是两个 JSON frame，发送二进制的 peer 是在说别的什么，与坏 opcode 同一种情况。
	 */
	private deliver(opcode: number, payload: Buffer): void {
		if (opcode === OPCODE.binary) {
			this.fail("This protocol carries text frames only.");
			return;
		}
		// RFC 6455 §5.6：不是合法 UTF-8 的文本帧判定连接失败。不带 `fatal` 解码会替换成替换字符，把一条 peer 从未发过的消息交上去。
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
	 * 应答 peer 的 Close。
	 *
	 * RFC 6455 §5.5.1：对方给了 code 就原样回显，然后关闭 socket。如果本端已发送 Close，握手只完成了一半，socket 直接收尾——第二个 Close frame 本身就是协议错误。
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
			// 回显 peer 自己的 code 而不是编一个，让请求离开的客户端看到它自己要求的理由。
			this.socket.write(encode(OPCODE.close, payload.subarray(0, 2)));
		}
		this.closeSent = true;
		this.end();
		this.finish();
	}
}

/** 101 握手的同伴：一个 HTTP 拒绝响应，给那个从未成为 WebSocket 的请求。 */
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
 * 一个已去掩码、未分片的 frame——本服务器唯一会写出的形态。
 *
 * 服务器到客户端的 frame 从不掩码（RFC 6455 §5.1）也从不分片：本服务器发送的 frame 是一份完整的 JSON 文档，拆开它只会为每个分片多付头部字节，去表达读者反正要重新拼装的东西。
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
