// 票 11 的实验：真正的"对端停止读取"下，服务端写侧会发生什么。
//
// 研究票 02（research/sse-multiplex.md Q5b）把"真正的对端停止读取"列为**未做实验**，本脚本补上。
//
// 装置：一个 node:http 服务器 + 一个**真的不读**的对端（收下一批之后 socket.pause()，
// 内核接收缓冲填满后 TCP 接收窗口归零；实测先吃掉约 64 KiB，小帧那一组是 8363 B）。
// 服务器按两种策略写帧：
//
//   blind       —— 今天的形状（packages/server/src/http/event-stream.ts:100）：丢掉 write() 的返回值，一直写。
//   respecting  —— 看返回值：false 之后停手，等 'drain'，超时则掐掉连接。
//
// 这个装置测的是 net.Socket / ServerResponse 的写侧性质，而 SSE 的 ServerResponse 与
// WebSocket 的 socket 底下是**同一个 net.Socket**——所以结论对两者同样成立。
// 唯一的限定：这里没有经过 ws 包或手写帧编码（那属于票 17），它只增加一层编码，不改变 socket 的缓冲性质。
//
// 用法：node backpressure-stalled-peer.mjs
// 环境变量：CHUNK（帧字节数，默认 8192）、BUDGET（每用例毫秒，默认 10000）、HWM（socket 高水位，默认不设）
//   CHUNK=30 node …              # 心跳量级的帧（JSON 实为 11 B，见票 11 的 Answer §1 表）
//   HWM=1024 node …              # 显式设小 socket 高水位，看 write() 何时返回 false
//   HWM=1024 CHUNK=8192 BUDGET=4000 node …
import { createServer } from "node:http";
import { connect } from "node:net";

const say = (line) => process.stdout.write(line + "\n");
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const mb = (b) => Number((b / 1024 / 1024).toFixed(2));

const CHUNK = Number(process.env.CHUNK ?? 8 * 1024);
const BUDGET_MS = Number(process.env.BUDGET ?? 10_000);
const HWM = process.env.HWM === undefined ? undefined : Number(process.env.HWM);
const FRAME = Buffer.from(JSON.stringify({ pad: "x".repeat(Math.max(0, CHUNK - 40)) }) + "\n");
// 小帧那一路单独打一个前缀，好让它在日志里一眼分得出来（`{}` 那条 JSON 只有 11 B）。
const RESULT_PREFIX = CHUNK <= 64 ? "HEARTBEAT" : "MAIN";

/** 事件循环延迟：一个 20 ms 的 ticker 实际多久回来一次。 */
let lag = 0;
let expected = performance.now() + 20;
const ticker = setInterval(() => {
	const now = performance.now();
	lag = Math.max(lag, now - expected);
	expected = now + 20;
}, 20);
ticker.unref();

const server = createServer({ highWaterMark: HWM }, (req, res) => {
	const mode = req.url.includes("respecting") ? "respecting" : "blind";
	say("REQ " + req.url);
	if (req.url.startsWith("/health")) {
		res.writeHead(200).end("ok");
		return;
	}
	res.writeHead(200, { "content-type": "application/octet-stream" });

	let seq = 0;
	let sawFalse = -1;
	let peakWritable = 0;
	let peakRss = process.memoryUsage().rss;
	const t0 = performance.now();
	const sampler = setInterval(() => {
		peakWritable = Math.max(peakWritable, res.writableLength);
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
	}, 25);
	sampler.unref();

	const status = setInterval(() => {
		say(
			RESULT_PREFIX +
				" PROGRESS " +
				JSON.stringify({
					mode,
					frames: seq,
					mib: mb(seq * FRAME.length),
					writableLength: res.writableLength,
					rssMiB: mb(process.memoryUsage().rss),
					lagMs: Math.round(lag),
					ms: Math.round(performance.now() - t0),
				}),
		);
	}, 1000);
	status.unref();

	const finish = (reason) => {
		clearInterval(sampler);
		clearInterval(status);
		say(
			RESULT_PREFIX +
				" RESULT " +
				JSON.stringify({
					mode,
					reason,
					chunk: FRAME.length,
					highWaterMark: HWM ?? res.writableHighWaterMark,
					frames: seq,
					mibWritten: mb(seq * FRAME.length),
					sawFalseAtFrame: sawFalse,
					sawFalseAtBytes: sawFalse < 0 ? -1 : sawFalse * FRAME.length,
					writableLengthNow: res.writableLength,
					peakWritableLength: peakWritable,
					peakRssMiB: mb(peakRss),
					ms: Math.round(performance.now() - t0),
					lagWorstMs: Math.round(lag),
				}),
		);
		res.destroy();
	};

	const deadline = setTimeout(() => finish("budget-exhausted"), BUDGET_MS);
	deadline.unref();

	if (mode === "blind") {
		const pump = () => {
			while (true) {
				seq += 1;
				const ok = res.write(FRAME);
				if (!ok && sawFalse < 0) sawFalse = seq;
				if (res.writableLength > 2 * 1024 * 1024 || seq % 256 === 0) {
					setImmediate(pump); // 让出，好让定时器跑：测的是内存，不是"不让出有多快"
					return;
				}
			}
		};
		pump();
		return;
	}

	const resume = () => {
		while (true) {
			seq += 1;
			const ok = res.write(FRAME);
			if (!ok) {
				sawFalse = seq;
				clearTimeout(deadline);
				const waited = setTimeout(() => finish("drain-timeout"), BUDGET_MS);
				waited.unref();
				res.once("drain", () => {
					clearTimeout(waited);
					resume();
				});
				return;
			}
		}
	};
	resume();
});

server.listen(0, "127.0.0.1");
await sleep(300);
const port = server.address().port;
say(
	"LISTEN " +
		port +
		" prefix=" +
		RESULT_PREFIX +
		" chunk=" +
		FRAME.length +
		" budgetMs=" +
		BUDGET_MS +
		" hwm=" +
		String(HWM ?? "default"),
);

/** 一个真的不读的对端：收 4 KiB 之后就不再 read()。 */
function stalledPeer(path) {
	const peer = connect(port, "127.0.0.1", () => {
		peer.write("GET " + path + " HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n");
	});
	let received = 0;
	let stopped = false;
	peer.on("data", (buf) => {
		received += buf.length;
		if (!stopped && received >= 4096) {
			stopped = true;
			peer.pause();
			say(RESULT_PREFIX + " PEER paused after " + received + " bytes at " + Math.round(performance.now()) + "ms");
		}
	});
	peer.on("error", () => {});
	return peer;
}

async function health() {
	const t = performance.now();
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`);
		return { text: await response.text(), ms: Math.round(performance.now() - t) };
	} catch (error) {
		return { text: "ERROR " + String(error), ms: Math.round(performance.now() - t) };
	}
}

// A：blind（今天的形状），并在它灌的时候问 health。
{
	const peer = stalledPeer("/stall?mode=blind");
	await sleep(4000);
	say(RESULT_PREFIX + " HEALTH-DURING-BLIND " + JSON.stringify(await health()));
	await sleep(BUDGET_MS - 4000 + 500);
	peer.destroy();
	await sleep(500);
}

// B：respecting。
{
	const peer = stalledPeer("/stall?mode=respecting");
	await sleep(BUDGET_MS + 1500);
	peer.destroy();
	await sleep(500);
}

server.close();
await sleep(200);
process.exit(0);
