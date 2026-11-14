// Client channel smoke: drives the production `MuxClient` through a fake socket and a fake clock, and
// asserts the behaviours the window depends on — that a connection is only "live" once a frame proves
// it, that silence kills it, that a reconnect re-opens what the window still wants, that a stream the
// server ended is never re-opened, and that opening a session is a `retain` whose baseline completes
// it: every `open` is answered, so a repeated one is a fresh snapshot rather than a refusal, and a
// baseline that arrives after the pane has moved on is handed over to be dropped whole.
// Nothing here touches the network or the DOM, so no server and no provider key are needed.
// Run with: node scripts/smoke-mux-client.ts
import { MuxClient, type ChannelState, type MuxHandlers, type MuxOptions, type MuxSocket, type MuxSocketFactory, type MuxTimers } from "../packages/web/src/client.ts";
import { SessionRows } from "../packages/web/src/rows.ts";
import { reduceEnd, initialState, reduce, type ViewState } from "../packages/web/src/state.ts";
import type { ServerMessage, SessionRow, SessionSnapshot } from "@my-agent/core/protocol";

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

/** A snapshot with nothing in it but the fields a caller has to set, for building frames and folds. */
function snapshot(sessionId: string, submitting = false): SessionSnapshot {
	return {
		id: sessionId,
		workDirAbsPath: "/tmp",
		createdAt: 1,
		title: sessionId,
		model: "m/1",
		thinkingLevel: "off",
		thinkingLevels: ["off"],
		allTools: [],
		messages: [],
		messageEntryIds: [],
		branchPoints: [],
		leafId: null,
		submitting,
		queued: [],
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
function harness(
	overrides: Partial<MuxOptions> = {},
): {
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
			...overrides,
		},
	);
	return { client, clock, sockets, saw };
}

/** The uplink frames a socket received, as typed objects. */
function uplink(socket: FakeSocket): { type: string; sessionId: string }[] {
	return socket.sent.map((text) => JSON.parse(text) as { type: string; sessionId: string });
}

/** The `open` frames alone — the wait/unwait pair rides the same uplink since issue 13. */
function opens(socket: FakeSocket): { type: string; sessionId: string }[] {
	return uplink(socket).filter((f) => f.type === "open");
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
	// Two reasons for the same session: one entry between them, both surviving a reconnect — and the
	// second one still *asks*. `open` is an idempotent primitive now, so re-asking is how a pane
	// coming back to a session a send is still holding gets a fresh baseline instead of silence.
	client.retain("s2", "send");
	check("每次 retain 都发 open，重复订阅也发", opens(sockets.all[0]!).length === 3, JSON.stringify(uplink(sockets.all[0]!)));
	check("同一会话的第二个理由再发一次 open", opens(sockets.all[0]!).filter((f) => f.sessionId === "s2").length === 2, JSON.stringify(uplink(sockets.all[0]!)));
	// The send reference carries its own frame (issue 13): one `wait` for the run's result, reported
	// when the source was first taken — a pane's retain says nothing about results, and a repeated
	// retain of the same source does not report again.
	const waits = uplink(sockets.all[0]!).filter((f) => f.type === "wait");
	check("send 的引用恰好报告了一次 wait", waits.length === 1 && waits[0]?.sessionId === "s2", JSON.stringify(uplink(sockets.all[0]!)));

	// The drop. Everything the window still wants has to come back, and it comes back by reference —
	// not because anything here remembered which sessions were open.
	sockets.latest()?.drop();
	check("掉线时频道变 down", client.channel === "down");
	clock.tick(250);
	sockets.latest()?.deliver(heartbeat());

	const replayed = uplink(sockets.all[1]!);
	check("重连后逐条重放 open", opens(sockets.all[1]!).length === 2, JSON.stringify(replayed));
	check("重放的是窗口仍持有的会话", new Set(opens(sockets.all[1]!).map((f) => f.sessionId)).size === 2, JSON.stringify(replayed));
	// The wait rides the same replay: the connection that held it is dead, and a send reference that
	// survived the drop is still waiting for its run's result on the new one (issue 13).
	check("仍持有的 send 引用重放了 wait", replayed.filter((f) => f.type === "wait").length === 1, JSON.stringify(replayed));
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
	// The wait is the send reference's own frame, released with the reference and before the last
	// reference's `cancel` — the two answer different questions (issue 13).
	check("send 释放时发出 unwait", uplink(sockets.all[0]!).some((f) => f.type === "unwait" && f.sessionId === "s"), JSON.stringify(uplink(sockets.all[0]!)));
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
	return { id, workDirAbsPath: "/w", createdAt: 1, title: id, modified, running, pending };
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
	const taken = rows.loadFrom([{ workDirAbsPath: "/w", sessions: [row("a", 100, false)] }], true);
	check("通道 live 时 REST 列表被拒收", taken === false && rows.get("a")?.running === true, `taken=${taken}`);

	rows.loadFrom([{ workDirAbsPath: "/w", sessions: [row("a", 100, false)] }], false);
	check("通道不在时 REST 兜底", rows.get("a")?.running === false);
	check("兜底也是整表替换（删掉的行会消失）", rows.get("b") === undefined, JSON.stringify([...rows.list()].map((r) => r.id)));
}

// ------------------------------------------------------------------- 8. reducer

process.stdout.write("\nreducer：end 与 baseline 的边界\n");

{
	// An `end` clears the banner and stops the spinner, and keeps the session. A banner left up
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
	check("end 保留会话记录", ended.items.length === 1);

	// An error is the record of a failed operation, and only a successful operation erases it. A
	// reconnect that worked is not one of the user's operations — and a baseline arriving after a
	// reconnect is exactly that.
	const failed: ViewState = { ...initialState(), error: "跑不起来" };
	const rebased = reduce(failed, { type: "baseline", session: snapshot("s1") });
	check("baseline 不清掉 error", rebased.error === "跑不起来", `got ${String(rebased.error)}`);
	check("baseline 换掉会话记录", rebased.snapshot?.id === "s1", JSON.stringify(rebased.snapshot?.id));

	// The retry countdown is not rebuilt from a baseline, and not carried over either: the seconds
	// left only ever came from the frame that scheduled the backoff, so there is nothing to rebuild
	// from and the old value would be a countdown on a backoff this stream never watched begin.
	const retrying: ViewState = { ...initialState(), retry: { attempt: 2, maxAttempts: 5, delayMs: 4000 } };
	const afterRetry = reduce(retrying, { type: "baseline", session: snapshot("s1", true) });
	check("baseline 清掉重试倒计时", afterRetry.retry === undefined, JSON.stringify(afterRetry.retry));
	check("基线本身仍带着 isRetrying，头部照常显示重试中", afterRetry.snapshot?.isRetrying === false);
}

// ------------------------------------------------------- 9. navigation in flight

process.stdout.write("\nmux client: 导航的完成与失败\n");

/** What became of a promise, read without letting a rejection escape the test. */
type Outcome<T> = { state: "pending" } | { state: "resolved"; value: T } | { state: "rejected"; error: string };

/** Watch a promise from the moment it exists, so a rejection is handled rather than floating. */
function watch<T>(promise: Promise<T> | undefined): () => Outcome<T> {
	let outcome: Outcome<T> = { state: "pending" };
	promise?.then(
		(value) => {
			outcome = { state: "resolved", value };
		},
		(error: unknown) => {
			outcome = { state: "rejected", error: error instanceof Error ? error.message : String(error) };
		},
	);
	return () => outcome;
}

/** Let the promise callbacks the last action queued run. */
async function flushed(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

{
	const { client, sockets } = harness();
	client.start();
	sockets.latest()?.deliver(heartbeat());

	// A navigation is a `retain` that names a series, and what it waits for is the baseline the server
	// sends for that `open` — the same frame the stream anchors itself on, so no second one is asked
	// for and nothing new appears on the wire.
	const opened = watch(client.retain("s1", "pane", 1));
	check("导航的 retain 发出 open", uplink(sockets.all[0]!).some((f) => f.type === "open" && f.sessionId === "s1"), JSON.stringify(uplink(sockets.all[0]!)));
	check("基线之前导航未完成", opened().state === "pending", JSON.stringify(opened()));

	sockets.latest()?.deliver(baseline("s1"));
	await flushed();
	const landed = opened();
	check("基线 settle 导航并交回快照", landed.state === "resolved" && landed.value.id === "s1", JSON.stringify(landed));

	// A pane coming back to a session a send still holds: the retain asks again (ADR-0009), and that
	// second baseline is what completes the second navigation.
	const again = watch(client.retain("s1", "pane", 2));
	check("已订阅的会话再导航仍发 open", uplink(sockets.all[0]!).filter((f) => f.type === "open" && f.sessionId === "s1").length === 2, JSON.stringify(uplink(sockets.all[0]!)));
	sockets.latest()?.deliver(baseline("s1"));
	await flushed();
	check("第二份基线完成第二次导航", again().state === "resolved", JSON.stringify(again()));

	// A send's reference asks for nothing to be completed, so there is no promise to leak — but it
	// still asks for the stream, which is what keeps the run's frames coming.
	check("send 的 retain 不索取完成", client.retain("s2", "send") === undefined);
	check("send 的 retain 也发 open", uplink(sockets.all[0]!).some((f) => f.type === "open" && f.sessionId === "s2"), JSON.stringify(uplink(sockets.all[0]!)));
	client.close();
}

{
	const { client, sockets } = harness();
	client.start();
	sockets.latest()?.deliver(heartbeat());

	// One stream answers both asks, so a second navigation to the same session joins the wait rather
	// than ending the first: the same snapshot answers both, and which click draws is the caller's own
	// series to compare — this layer does not adjudicate that.
	const first = watch(client.retain("s1", "pane", 1));
	const second = watch(client.retain("s1", "pane", 2));
	await flushed();
	check("同一会话的第二次导航加入等待，不判第一次失败", first().state === "pending" && second().state === "pending", JSON.stringify([first(), second()]));

	sockets.latest()?.deliver(baseline("s1"));
	await flushed();
	check("一份基线答清两次等待", first().state === "resolved" && second().state === "resolved", JSON.stringify([first(), second()]));
	client.close();
}

{
	const { client, sockets, saw } = harness();
	client.start();
	sockets.latest()?.deliver(heartbeat());

	// A refused stream is an answer, not a baseline that is still coming: the window hears it at once
	// instead of waiting out its own timeout for a frame the server has decided not to send.
	const opened = watch(client.retain("nope", "pane", 3));
	sockets.latest()?.deliver(JSON.stringify({ streamId: "nope", error: { message: "未知的会话。" } }));
	await flushed();
	const refused = opened();
	check("error 帧让导航失败", refused.state === "rejected" && refused.error === "未知的会话。", JSON.stringify(refused));
	check("窗口照原样收到这条错误", saw.errors.includes("nope:未知的会话。"), JSON.stringify(saw.errors));
	check("失败不撤订阅（重试由用户发起）", client.isRetained("nope") && client.isWatching("nope"));
	client.close();
}

{
	const { client, sockets } = harness();
	client.start();
	sockets.latest()?.deliver(heartbeat());

	// An ended stream will never carry a baseline, so the navigation is answered now.
	const opened = watch(client.retain("gone", "pane", 4));
	sockets.latest()?.deliver(JSON.stringify({ streamId: "gone", end: true }));
	await flushed();
	check("end 帧让导航失败", opened().state === "rejected", JSON.stringify(opened()));
	client.close();
}

{
	// A short timeout, so the deadline can be crossed on the fake clock; the heartbeat names a long
	// interval so the watchdog is not what fires during this block.
	const { client, clock, sockets } = harness({ openTimeoutMs: 120 });
	client.start();
	sockets.latest()?.deliver(heartbeat(60_000));

	const opened = watch(client.retain("slow", "pane", 5));
	clock.tick(119);
	await flushed();
	check("超时之前仍在等", opened().state === "pending", JSON.stringify(opened()));
	clock.tick(1);
	await flushed();
	check("本地超时让导航失败", opened().state === "rejected", JSON.stringify(opened()));
	// The subscription stays: the baseline may still be queued, and a `cancel` would queue behind it.
	// Letting go would release the stream, not the backlog.
	check("超时不撤订阅、不发 cancel", client.isRetained("slow") && !uplink(sockets.all[0]!).some((f) => f.type === "cancel"), JSON.stringify(uplink(sockets.all[0]!)));
	client.close();
}

{
	const { client, clock, sockets } = harness();
	client.start();
	sockets.latest()?.deliver(heartbeat());
	const opened = watch(client.retain("s1", "pane", 6));

	// Dropping the connection is not an answer about the session, so the navigation keeps waiting.
	sockets.latest()?.drop();
	check("掉线时导航仍在等", opened().state === "pending", JSON.stringify(opened()));

	clock.tick(250);
	sockets.latest()?.deliver(heartbeat());
	check("重放为在等的会话再发 open", uplink(sockets.all[1]!).some((f) => f.type === "open" && f.sessionId === "s1"), JSON.stringify(uplink(sockets.all[1]!)));
	sockets.latest()?.deliver(baseline("s1"));
	await flushed();
	check("重放带来的基线完成导航", opened().state === "resolved", JSON.stringify(opened()));
	client.close();
}

{
	// The page load's own case: the pane is retained before the channel has proved itself. There is no
	// frame to send, so a navigation is refused now rather than timing out later about a server nobody
	// asked — while the intent stays recorded for the first live transition to replay.
	const { client, sockets } = harness();
	client.start();
	const opened = watch(client.retain("early", "pane", 7));
	await flushed();
	check("通道未 live 时导航立即失败", opened().state === "rejected", JSON.stringify(opened()));
	check("这条 retain 没有发出任何帧", (sockets.all[0]?.sent.length ?? 0) === 0, JSON.stringify(sockets.all[0]?.sent));
	check("意图仍记着，留给重放", client.isRetained("early"));
	client.close();
}

{
	const { client, sockets } = harness();
	client.start();
	sockets.latest()?.deliver(heartbeat());
	const opened = watch(client.retain("s1", "pane", 8));
	// A window going away has nobody left to answer, so nothing is left waiting on a baseline this
	// connection will never receive.
	client.close();
	await flushed();
	check("关掉通道让在等的导航失败", opened().state === "rejected", JSON.stringify(opened()));
}

// ------------------------------------------- 10. two baselines, one drawer

process.stdout.write("\n两份基线：重复 open 再送一份，迟到的那份不画\n");

{
	const { client, sockets, saw } = harness();
	client.start();
	sockets.latest()?.deliver(heartbeat());

	// The window's half of the rule, restated here because nothing in this suite drives the window
	// itself: a click is a number, and only the newest number may draw (main.ts keeps it as
	// `openSeries`). The client has no opinion about it — ADR-0009's first behaviour row puts that
	// verdict in the caller — so what this block checks *about this layer* is that every baseline is
	// handed over and none is turned into an error.
	let series = 0;
	const reported: string[] = [];
	let drawn: ViewState = initialState();
	const navigate = (sessionId: string): (() => Outcome<SessionSnapshot>) => {
		const mine = (series += 1);
		const promise = client.retain(sessionId, "pane", mine);
		const landed = watch(promise);
		void promise.then(
			(snapshot) => {
				// A snapshot for a click the pane has already left is dropped whole: no draw, no report.
				if (mine !== series) return;
				drawn = reduce(drawn, { type: "baseline", session: snapshot });
			},
			(error: unknown) => {
				if (mine !== series) return;
				reported.push(error instanceof Error ? error.message : String(error));
			},
		);
		return landed;
	};

	const opensOn = (sessionId: string): number =>
		uplink(sockets.all[0]!).filter((f) => f.type === "open" && f.sessionId === sessionId).length;

	// A second `open` on a session somebody else already holds is not refused — it is answered with a
	// fresh baseline (ADR-0009, decision 1). That is the whole point of the idempotent primitive: the
	// pane coming back to a running session is shown the half sentence instead of silence.
	const first = navigate("s1");
	check("第一次导航发出 open", opensOn("s1") === 1, JSON.stringify(uplink(sockets.all[0]!)));
	sockets.latest()?.deliver(baseline("s1"));
	await flushed();
	check("第一次导航落地", first().state === "resolved", JSON.stringify(first()));

	// Someone else's reason still holds the stream (a send that outlived a run), and the pane points
	// back at it. Every retain asks, so the send's own reference added an `open` too — what matters
	// here is that navigating back asks *again* rather than trusting the entry it finds.
	client.retain("s1", "send");
	const beforeComingBack = opensOn("s1");
	const back = navigate("s1");
	check("已订阅的会话再打开仍发 open", opensOn("s1") === beforeComingBack + 1, JSON.stringify(uplink(sockets.all[0]!)));
	sockets.latest()?.deliver(baseline("s1", true));
	await flushed();
	const reopened = back();
	check(
		"重复 open 的基线 settle 这次导航，而不是被拒绝",
		reopened.state === "resolved" && reopened.value.submitting === true,
		JSON.stringify(reopened),
	);
	check("这份基线照常交给窗口（它是一次重画，不是一条错误）", saw.messages.filter((m) => m === "s1/baseline").length === 2, JSON.stringify(saw.messages));
	check("也没有谁把重复 open 说成失败", saw.errors.length === 0 && reported.length === 0, JSON.stringify([saw.errors, reported]));
	check("画的是刚到的这份（运行中的会话带 submitting）", drawn.snapshot?.id === "s1" && drawn.snapshot.submitting === true, JSON.stringify(drawn.snapshot?.submitting));

	// Two rows clicked in a row: each click asks for its own session, and the two baselines can come
	// back in the other order — the late one belongs to a click the pane has already left.
	const old = navigate("a");
	const now = navigate("b");
	await flushed();
	sockets.latest()?.deliver(baseline("b"));
	await flushed();
	check("后点的那次先落地", now().state === "resolved", JSON.stringify(now()));
	check("先落地的画面是后点的那条", drawn.snapshot?.id === "b", JSON.stringify(drawn.snapshot?.id));

	sockets.latest()?.deliver(baseline("a"));
	await flushed();
	const stale = old();
	// Still answered: the frame is an answer about `a`, and a promise nobody settles is a timer that
	// fires three seconds later blaming a server that did exactly what it was asked.
	check("迟到的基线仍答清它自己那次导航", stale.state === "resolved" && stale.value.id === "a", JSON.stringify(stale));
	check("它被交到窗口手里（这层不吞帧）", saw.messages.includes("a/baseline"), JSON.stringify(saw.messages));
	check("迟到的那份不画：画面仍是最后一次点击", drawn.snapshot?.id === "b", JSON.stringify(drawn.snapshot?.id));
	check("也不报错（被作废的那次没有变成错误条）", saw.errors.length === 0 && reported.length === 0, JSON.stringify([saw.errors, reported]));
	check(
		"两条订阅都还在，也没有谁替它们发过 cancel",
		client.isRetained("a") && client.isRetained("b") && !uplink(sockets.all[0]!).some((f) => f.type === "cancel"),
		JSON.stringify(uplink(sockets.all[0]!)),
	);
	client.close();
}

process.stdout.write(failures === 0 ? "\nmux client ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
