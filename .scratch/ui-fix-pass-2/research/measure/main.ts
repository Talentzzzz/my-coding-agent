// 票 04 的量具：同一段 8k 字回答、同样的 delta 节拍，量「服务端每帧要写多少字节」「客户端每帧要
// 解析多少 JSON」「每帧要重算多少文本」。跑在真 Chromium 里（V8 与桌面壳同一代），由
// measure-streaming.mjs 通过 CDP 驱动，Performance.getMetrics 在两次运行前后各读一次。
//
// 两条路径：
//   old —— HEAD 的帧形状：`message_update` 同时带整条 partial 消息和供应商的 delta 事件（后者里还有
//          一份同样的 partial），所以 JSON 里是两份全文；客户端每帧对全文跑一次 contentToText。
//   new —— 现在的帧形状：只有 { timestamp, kind, contentIndex, text }；客户端走生产代码的 reduce()。
//
// 旧的 reduce 不是生产代码了，没法原样跑；量的是它每帧做的那件与答案长度成正比的事（重算文本），
// 用生产代码里同一个 contentToText。其余开销（一次数组拷贝、一项比较）与答案长度无关。
import { contentToText, initialState, reduce } from "../../../../packages/web/src/state.ts";
import type { ServerMessage, UsageTotals } from "@my-agent/core/protocol";

const ANSWER_CHARS = 8_000;
const CHUNK_CHARS = 4;
const TIMESTAMP = 1_700_000_000_000;
const BUCKETS = 8;

const USAGE: UsageTotals = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	contextWindow: 200_000,
};

const PARAGRAPH = "这是一段用来测量流式成本的回答，它足够长，长到后半段每来一个 token 都值得算一次账。";
const answer = PARAGRAPH.repeat(Math.ceil(ANSWER_CHARS / PARAGRAPH.length)).slice(0, ANSWER_CHARS);
const chunks: string[] = [];
for (let index = 0; index < answer.length; index += CHUNK_CHARS) chunks.push(answer.slice(index, index + CHUNK_CHARS));

interface Bucket {
	from: number;
	to: number;
	answerChars: number;
	bytes: number;
	parseMs: number;
	reduceMs: number;
}

interface Totals {
	frames: number;
	answerChars: number;
	bytes: number;
	peakBytes: number;
	parseMs: number;
	reduceMs: number;
	buckets: Bucket[];
}

function baseline(): ServerMessage {
	return {
		type: "baseline",
		session: {
			id: "measured",
			cwd: "/measured",
			createdAt: 1,
			title: "measured",
			model: "measured/measured",
			thinkingLevel: "off",
			thinkingLevels: ["off"],
			approvals: { read: false, write: false, edit: false, glob: false, grep: false, bash: false },
			allTools: [],
			activeTools: [],
			toolsFollowGlobal: true,
			approvalsFollowGlobal: true,
			messages: [],
			messageEntryIds: [],
			branchPoints: [],
			leafId: null,
			submitting: true,
			queued: 0,
			isRetrying: false,
			retryAttempt: 0,
			usage: USAGE,
			pendingApprovals: [],
		},
	};
}

function partialMessage(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		model: "measured",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: TIMESTAMP,
	};
}

function emptyBuckets(): Bucket[] {
	return Array.from({ length: BUCKETS }, (_, index) => ({
		from: Math.floor((index * chunks.length) / BUCKETS),
		to: Math.floor(((index + 1) * chunks.length) / BUCKETS) - 1,
		answerChars: 0,
		bytes: 0,
		parseMs: 0,
		reduceMs: 0,
	}));
}

function sum(buckets: Bucket[], field: "bytes" | "parseMs" | "reduceMs"): number {
	return buckets.reduce((total, bucket) => total + bucket[field], 0);
}

/** HEAD 的帧：整条 partial 出现两次，每帧解析并重算全文。 */
function runOld(): Totals {
	const buckets = emptyBuckets();
	let text = "";
	let peakBytes = 0;
	for (let index = 0; index < chunks.length; index += 1) {
		text += chunks[index] ?? "";
		const message = partialMessage(text);
		// The wire frame HEAD sent: `message` is a shallow copy, `assistantMessageEvent.partial` is
		// the live accumulator — JSON.stringify writes both, which is the double copy in the ticket.
		const frame = {
			streamId: "measured",
			item: {
				type: "event",
				event: {
					type: "message_update",
					message: { ...message },
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunks[index] ?? "", partial: message },
				},
			},
		};
		const json = JSON.stringify(frame);
		const bytes = json.length;
		peakBytes = Math.max(peakBytes, bytes);

		const parseStart = performance.now();
		const parsed = JSON.parse(json) as { item: { event: { message: { content: unknown } } } };
		const parseEnd = performance.now();
		const event = parsed.item.event;
		// What the old reducer did per frame: read the whole content back into text.
		const textStart = performance.now();
		const rebuilt = contentToText(event.message.content);
		const textEnd = performance.now();
		void rebuilt;

		const bucket = buckets[Math.floor((index * BUCKETS) / chunks.length)]!;
		bucket.answerChars = text.length;
		bucket.bytes += bytes;
		bucket.parseMs += parseEnd - parseStart;
		bucket.reduceMs += textEnd - textStart;
	}
	return {
		frames: chunks.length,
		answerChars: answer.length,
		bytes: sum(buckets, "bytes"),
		peakBytes,
		parseMs: sum(buckets, "parseMs"),
		reduceMs: sum(buckets, "reduceMs"),
		buckets,
	};
}

/** 现在的帧：只有 delta，客户端走生产代码的 reduce()。 */
function runNew(): Totals {
	const buckets = emptyBuckets();
	let state = reduce(initialState(), baseline());
	let peakBytes = 0;
	for (let index = 0; index < chunks.length; index += 1) {
		const frame = {
			streamId: "measured",
			item: {
				type: "event",
				event: {
					type: "message_update",
					delta: { timestamp: TIMESTAMP, kind: "text", contentIndex: 0, text: chunks[index] ?? "" },
				},
			},
		};
		const json = JSON.stringify(frame);
		const bytes = json.length;
		peakBytes = Math.max(peakBytes, bytes);

		const parseStart = performance.now();
		const parsed = JSON.parse(json) as ServerMessage;
		const parseEnd = performance.now();
		const reduceStart = performance.now();
		state = reduce(state, parsed);
		const reduceEnd = performance.now();

		const bucket = buckets[Math.floor((index * BUCKETS) / chunks.length)]!;
		bucket.answerChars = (index + 1) * CHUNK_CHARS;
		bucket.bytes += bytes;
		bucket.parseMs += parseEnd - parseStart;
		bucket.reduceMs += reduceEnd - reduceStart;
	}
	return {
		frames: chunks.length,
		answerChars: answer.length,
		bytes: sum(buckets, "bytes"),
		peakBytes,
		parseMs: sum(buckets, "parseMs"),
		reduceMs: sum(buckets, "reduceMs"),
		buckets,
	};
}

window.__run = (phase: "old" | "new") => (phase === "old" ? runOld() : runNew());
window.__ready = true;

declare global {
	interface Window {
		__ready?: boolean;
		__run?: (phase: "old" | "new") => Totals;
	}
}
