// Client channel smoke: drives the production `MuxClient` through a fake socket and a fake clock, and
// asserts the four behaviours the window depends on — that a connection is only "live" once a frame
// proves it, that silence kills it, that a reconnect re-opens what the window still wants, and that a
// stream the server ended is never re-opened.
// Nothing here touches the network or the DOM, so no server and no provider key are needed.
// Run with: node scripts/smoke-mux-client.ts
import { MuxClient, type ChannelState, type MuxHandlers, type MuxSocket, type MuxSocketFactory, type MuxTimers } from "../packages/web/src/client.ts";
import { SessionRows } from "../packages/web/src/rows.ts";
import { reduceEnd, initialState, reduce, type ViewState } from "../packages/web/src/state.ts";
import type { ServerMessage, SessionRow, SessionSnapshot, ToolApprovalKey } from "@my-agent/core/protocol";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/**
 * A clock the test drives, rather than one it waits on.
 *
 * The whole point of the seam is that a fifteen-second state machine can be checked in milliseconds:
 * `tick(ms)` fires everything due within `ms` and returns, so no assertion has to guess how long a
 * real timer would have taken and no suite has to be slow and flaky at the same time.
 */
function fakeClock(): MuxTimers & { tick(ms: number): void; readonly pending: number } {
	let now = 0;
	let next = 1;
	const due = new Map<number, { at: number; fn: () => void }>();

	return {
		setTimeout(fn, ms) {
			const id = next++;
			due.set(id, { at: now + ms, fn });
			return id;
		},
		clearTimeout(handle) {
			due.delete(handle as number);
		},
		tick(ms) {
			const until = now + ms;
			// Fired in time order, and anything a callback schedules inside the window fires too — a
			// backoff that reschedules itself is the case this has to get right.
			for (;;) {
				const ready = [...due.entries()]
					.filter(([, entry]) => entry.at <= until)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (ready === undefined) break;
				due.delete(ready[0]);
				now = ready[1].at;
				ready[1].fn();
			}
			now = until;
		},
		get pending() {
			return due.size;
		},
	};
}

/** One recorded socket, and everything the test needs to drive or inspect it. */
interface FakeSocket extends MuxSocket {
	readonly sent: string[];
	readonly closes: { code: number; reason: string }[];
	/** Push a frame up from the "server". */
	deliver(text: string): void;
	/** The socket dropped without the client asking. */
	drop(): void;
	/** Sockets built since the last reset, so a reconnect can be counted. */
}

function fakeSockets(): { factory: MuxSocketFactory; all: FakeSocket[]; latest(): FakeSocket | undefined } {
	const all: FakeSocket[] = [];
	const factory: MuxSocketFactory = (handlers) => {
		const socket: FakeSocket = {
			sent: [],
			closes: [],
			send(text) {
				socket.sent.push(text);
			},
			close(code, reason) {
				socket.closes.push({ code, reason });
				handlers.onClose();
			},
			deliver: (text) => handlers.onMessage(text),
			drop: () => handlers.onClose(),
		};
		all.push(socket);
		return socket;
	};
	return { factory, all, latest: () => all.at(-1) };
}

/** What the test watched the client do, in the order it happened. */
interface Recorder {
	channels: ChannelState[];
	items: string[];
	messages: string[];
	ended: string[];
	errors: string[];
}

/** A heartbeat, which is what a real server's first frame is. */
function heartbeat(everyMs = 100): string {
	return JSON.stringify({ streamId: null, item: { type: "heartbeat", everyMs } });
}

/** The approval map every snapshot has to carry, all six keys, none of them on. */
const NO_APPROVALS: Record<ToolApprovalKey, boolean> = {
	read: false,
	write: false,
	edit: false,
	glob: false,
	grep: false,
	bash: false,
};

/** A snapshot with nothing in it but the fields a caller has to set, for building frames and folds. */
function snapshot(sessionId: string, submitting = false): SessionSnapshot {
	return {
		id: sessionId,
		cwd: "/tmp",
		createdAt: 1,
		title: sessionId,
		model: "m/1",
		thinkingLevel: "off",
		thinkingLevels: ["off"],
		approvals: { ...NO_APPROVALS },
		allTools: [],
		activeTools: [],
		toolsFollowGlobal: true,
		approvalsFollowGlobal: true,
		messages: [],
		messageEntryIds: [],
		branchPoints: [],
		leafId: null,
		submitting,
		queued: 0,
		isRetrying: false,
		retryAttempt: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, contextWindow: 1000 },
		pendingApprovals: [],
	};
}

/** The opening frame a real server sends before anything else. */
function baseline(sessionId: string, submitting = false): string {
	return JSON.stringify({ streamId: sessionId, item: { type: "baseline", session: snapshot(sessionId, submitting) } });
}

/** Build a client wired to a fake clock and fake sockets, plus the recorder it writes into. */
function harness(): {
	client: MuxClient;
	clock: ReturnType<typeof fakeClock>;
	sockets: ReturnType<typeof fakeSockets>;
	saw: Recorder;
} {
	const clock = fakeClock();
	const sockets = fakeSockets();
	const saw: Recorder = { channels: [], items: [], messages: [], ended: [], errors: [] };

	// Jitter pinned to its floor, so a backoff is exactly half its ceiling and the waits below are
	// readable numbers rather than ranges.
	const client = new MuxClient(
		{
			onChannel: (state) => saw.channels.push(state),
			onConnectionItem: (item) => saw.items.push(item.type),
			onStreamMessage: (sessionId, message: ServerMessage) => saw.messages.push(`${sessionId}/${message.type}`),
			onStreamEnd: (sessionId) => saw.ended.push(sessionId),
			onStreamError: (sessionId, message) => saw.errors.push(`${sessionId || "-"}:${message}`),
		} satisfies MuxHandlers,
		{
			url: "ws://test/mux",
			socket: sockets.factory,
			timers: clock,
			random: () => 0,
			readyTimeoutMs: 500,
			watchdogTimeoutMs: 300,
			log: () => {},
		},
	);
	return { client, clock, sockets, saw };
}

/** The uplink frames a socket received, as typed objects. */
function uplink(socket: FakeSocket): { type: string; sessionId: string }[] {
	return socket.sent.map((text) => JSON.parse(text) as { type: string; sessionId: string });
}

// ---------------------------------------------------------------- 1. liveness

process.stdout.write("\nmux client: 就绪与判活\n");

{
	const { client, clock, sockets, saw } = harness();
	client.start();

	// A socket that opened is not a channel yet: the ready deadline is what is running, and calling
	// it live here is exactly the mistake that makes a black-holed connection look healthy.
	check("刚建连时不是 live", client.channel === "connecting", `got ${client.channel}`);
	check("第一帧到达才是 live", (() => {
		sockets.latest()?.deliver(heartbeat());
		return client.channel === "live";
	})(), `got ${client.channel}`);
	check("心跳也交给窗口（相对时间的 tick）", saw.items.includes("heartbeat"), JSON.stringify(saw.items));

	// Three heartbeat intervals of quiet is the tolerance, because the tolerance is derived from what
	// the server said rather than from a number written separately on this side.
	check("容忍度按 everyMs 的三倍推", (() => {
		clock.tick(299);
		return client.channel === "live";
	})(), `became ${client.channel} early`);
	check("超过容忍度即判死", (() => {
		clock.tick(2);
		return client.channel === "down";
	})(), `got ${client.channel}`);
	check("判死后用客户端自己的 close code", sockets.all[0]?.closes.at(-1)?.code === 4000, JSON.stringify(sockets.all[0]?.closes));
	client.close();
}

// ------------------------------------------------------------- 2. ready deadline

process.stdout.write("\nmux client: 一次尝试的硬截止\n");

{
	const { client, clock, sockets, saw } = harness();
	client.start();
	// A socket that opens and never delivers. The handshake completes in this state perfectly well,
	// which is why "open" cannot be what proves a connection.
	sockets.latest()?.deliver("");
	check("没有帧就不算 live", client.channel === "connecting");

	// One millisecond short of the deadline: still trying, still one socket.
	clock.tick(499);
	check("就绪截止未到时不放弃", sockets.all.length === 1 && client.channel === "connecting", `built ${sockets.all.length}, ${client.channel}`);

	// The deadline fires and this attempt is abandoned. The backoff is 50% of its ceiling, so the
	// first wait is half of 500ms rather than 500ms itself — reading "500" as the wait is off by two.
	clock.tick(1);
	check("就绪超时后进入退避", client.channel === "down", `got ${client.channel}`);
	check("放弃后不再往这条 socket 上写", sockets.all[0]?.sent.length === 0, JSON.stringify(sockets.all[0]?.sent));

	clock.tick(249);
	check("退避未满不重试", sockets.all.length === 1, `built ${sockets.all.length}`);
	clock.tick(1);
	check("退避满后重试", sockets.all.length === 2, `built ${sockets.all.length}`);
	check("重试期间窗口看到的是 connecting", saw.channels.at(-1) === "connecting", JSON.stringify(saw.channels));
	client.close();
}

// ------------------------------------------------------- 3. replay by reference

process.stdout.write("\nmux client: 重连后按引用重放\n");

{
	const { client, clock, sockets } = harness();
	client.start();
	sockets.latest()?.deliver(heartbeat());

	client.retain("s1", "pane");
	client.retain("s2", "pane");
	// Two reasons for the same session: one open between them, and both must survive a reconnect.
	client.retain("s2", "send");
	check("两个会话各发一次 open", uplink(sockets.all[0]!).length === 2, JSON.stringify(uplink(sockets.all[0]!)));
	check("同一会话的第二个理由不再发帧", new Set(uplink(sockets.all[0]!).map((f) => f.sessionId)).size === 2);

	// The drop. Everything the window still wants has to come back, and it comes back by reference —
	// not because anything here remembered which sessions were open.
	sockets.latest()?.drop();
	check("掉线时频道变 down", client.channel === "down");
	clock.tick(250);
	sockets.latest()?.deliver(heartbeat());

	const replayed = uplink(sockets.all[1]!);
	check("重连后逐条重放 open", replayed.length === 2, JSON.stringify(replayed));
	check("重放的是窗口仍持有的会话", new Set(replayed.map((f) => f.sessionId)).size === 2, JSON.stringify(replayed));
	client.close();
}

// ------------------------------------------------------------ 4. ended is final

process.stdout.write("\nmux client: end 之后不再重开\n");

{
	const { client, clock, sockets, saw } = harness();
	client.start();
	sockets.latest()?.deliver(heartbeat());
	client.retain("gone", "pane");
	client.retain("alive", "pane");

	sockets.latest()?.deliver(JSON.stringify({ streamId: "gone", end: true }));
	check("end 通知到窗口", saw.ended.includes("gone"), JSON.stringify(saw.ended));
	check("判终的流不再算被订阅", !client.isWatching("gone"));

	sockets.latest()?.drop();
	clock.tick(250);
	sockets.latest()?.deliver(heartbeat());
	const replayed = uplink(sockets.all[1]!).map((f) => f.sessionId);
	check("重连不为已判终的流重发 open", !replayed.includes("gone"), JSON.stringify(replayed));
	check("重连仍为其余的流重发", replayed.includes("alive"), JSON.stringify(replayed));

	// Pointing the pane away and back is a new gesture, so the terminal mark goes with the last
	// reference and the stream comes back — once, not twice: nothing here is re-sending on reconnect.
	client.release("gone", "pane");
	client.retain("gone", "pane");
	const backAgain = uplink(sockets.all[1]!).filter((f) => f.sessionId === "gone");
	check("重新指过去会再次订阅一次", backAgain.length === 1 && backAgain[0]?.type === "open", JSON.stringify(backAgain));
	client.close();
}

// ------------------------------------------------------ 5. references drop out

process.stdout.write("\nmux client: 引用归零\n");

{
	const { client, sockets } = harness();
	client.start();
	sockets.latest()?.deliver(heartbeat());

	client.retain("s", "pane");
	client.retain("s", "send");
	client.release("s", "pane");
	check("还有理由时不发 cancel", !uplink(sockets.all[0]!).some((f) => f.type === "cancel"), JSON.stringify(uplink(sockets.all[0]!)));

	client.release("s", "send");
	check("最后一个理由消失才发 cancel", uplink(sockets.all[0]!).some((f) => f.type === "cancel" && f.sessionId === "s"), JSON.stringify(uplink(sockets.all[0]!)));
	check("之后不再持有这个会话", !client.isRetained("s"));
	client.close();
}

// ------------------------------------------------------------ 6. envelope shapes

process.stdout.write("\nmux client: 按 streamId 分派\n");

{
	const { client, sockets, saw } = harness();
	client.start();
	const socket = sockets.all[0];

	socket?.deliver(heartbeat());
	socket?.deliver(baseline("s1"));
	socket?.deliver(JSON.stringify({ streamId: "s1", error: { message: "跑不起来" } }));
	socket?.deliver(JSON.stringify({ streamId: null, error: { message: "服务端内部错误" } }));
	socket?.deliver("这不是 JSON");
	socket?.deliver(JSON.stringify({ streamId: 42 }));

	check("会话帧与连接帧各走各的路由", saw.messages.includes("s1/baseline") && saw.items.includes("heartbeat"), JSON.stringify(saw.messages));
	check("读不懂的帧被丢掉而连接照旧活着", client.channel === "live", `got ${client.channel}`);
	check("会话级错误带上会话 id", saw.errors.includes("s1:跑不起来"), JSON.stringify(saw.errors));
	check("连接级错误不带会话 id", saw.errors.includes("-:服务端内部错误"), JSON.stringify(saw.errors));
	client.close();
}

// --------------------------------------------------------------- 7. row store

process.stdout.write("\n行 store：一个写者\n");

function row(id: string, modified: number, running = false, pending = 0): SessionRow {
	return { id, cwd: "/w", createdAt: 1, title: id, modified, running, pending };
}

{
	const rows = new SessionRows();
	rows.replaceAll([row("a", 100), row("b", 300)]);

	// Newest activity first, and groups ordered by their own newest row — the same rule the server's
	// projection applies, so a live channel and a REST fallback draw the same list.
	const groups = rows.groups();
	check("组内按 modified 降序", groups[0]?.sessions.map((r) => r.id).join(",") === "b,a", JSON.stringify(groups[0]?.sessions.map((r) => r.id)));
	check("整行替换", rows.get("a")?.modified === 100);

	rows.put({ ...row("a", 100), running: true });
	check("增量替换整行", rows.get("a")?.running === true);

	// The rule that removes the race: while the channel owns the rows, a listing is refused outright
	// rather than merged, so a file-derived snapshot can never put a working session back to idle.
	const taken = rows.loadFrom([{ cwd: "/w", sessions: [row("a", 100, false)] }], true);
	check("通道 live 时 REST 列表被拒收", taken === false && rows.get("a")?.running === true, `taken=${taken}`);

	rows.loadFrom([{ cwd: "/w", sessions: [row("a", 100, false)] }], false);
	check("通道不在时 REST 兜底", rows.get("a")?.running === false);
	check("兜底也是整表替换（删掉的行会消失）", rows.get("b") === undefined, JSON.stringify([...rows.list()].map((r) => r.id)));
}

// ------------------------------------------------------------------- 8. reducer

process.stdout.write("\nreducer：end 与 baseline 的边界\n");

{
	// An `end` clears the banner and stops the spinner, and keeps the transcript. A banner left up
	// after its stream is over is a button whose request goes nowhere.
	const running: ViewState = {
		...initialState(),
		streaming: true,
		items: [{ kind: "message", id: "user:1", role: "user", text: "在吗", notice: false, streaming: false }],
		approvals: [{ toolCallId: "t1", toolName: "bash", args: {}, summary: "rm -rf /" }],
	};
	const ended = reduceEnd(running);
	check("end 清空待回答的审批", ended.approvals.length === 0, JSON.stringify(ended.approvals));
	check("end 停掉转圈", ended.streaming === false);
	check("end 保留 transcript", ended.items.length === 1);

	// An error is the record of a failed operation, and only a successful operation erases it. A
	// reconnect that worked is not one of the user's operations — and a baseline arriving after a
	// reconnect is exactly that.
	const failed: ViewState = { ...initialState(), error: "跑不起来" };
	const rebased = reduce(failed, { type: "baseline", session: snapshot("s1") });
	check("baseline 不清掉 error", rebased.error === "跑不起来", `got ${String(rebased.error)}`);
	check("baseline 换掉 transcript", rebased.snapshot?.id === "s1", JSON.stringify(rebased.snapshot?.id));

	// The retry countdown is not rebuilt from a baseline, and not carried over either: the seconds
	// left only ever came from the frame that scheduled the backoff, so there is nothing to rebuild
	// from and the old value would be a countdown on a backoff this stream never watched begin.
	const retrying: ViewState = { ...initialState(), retry: { attempt: 2, maxAttempts: 5, delayMs: 4000 } };
	const afterRetry = reduce(retrying, { type: "baseline", session: snapshot("s1", true) });
	check("baseline 清掉重试倒计时", afterRetry.retry === undefined, JSON.stringify(afterRetry.retry));
	check("基线本身仍带着 isRetrying，头部照常显示重试中", afterRetry.snapshot?.isRetrying === false);
}

process.stdout.write(failures === 0 ? "\nmux client ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;