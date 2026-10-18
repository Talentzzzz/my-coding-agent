// 一个脚本化的 Anthropic 端点：`POST /v1/messages` 按 SSE 把固定文本一段段吐出来，形状就是
// `packages/ai/src/api/anthropic-messages.ts` 已经在解析的那几种事件。它存在的理由：窗口里的流式
// 卡顿要在**真的 transport + 真的服务端**下量，而不是在 DOM shim 上；同时不能花供应商的钱、也不能
// 每次节拍不一样。
import { createServer } from "node:http";

/**
 * 起一个假端点。`queue` 里每一步对应一次请求；`text` 是要流的回答。
 *
 *   { text, chunkChars = 4, everyMs = 2 }
 */
export async function startFakeAnthropic(queue) {
	const pending = [...queue];

	const server = createServer(async (request, response) => {
		// The SDK appends `?beta=true`, so the path is compared without the query.
		const path = request.url?.split("?")[0];
		if (request.method !== "POST" || path !== "/v1/messages") {
			console.log(`fake-anthropic: unexpected ${request.method} ${request.url}`);
			request.resume();
			response.writeHead(404).end();
			return;
		}
		// Drained rather than ignored: the window names the model on every request, and a request the
		// script did not expect is exactly what a silent bench gets wrong.
		const bodyChunks = [];
		for await (const chunk of request) bodyChunks.push(chunk);
		let body = {};
		try {
			body = JSON.parse(Buffer.concat(bodyChunks).toString("utf8"));
		} catch {
			// A body this endpoint cannot read is still a request; the script answers it anyway.
		}
		const step = pending.shift() ?? { text: "no more scripted answers" };
		console.log(
			`fake-anthropic: request model=${body.model ?? "?"} messages=${body.messages?.length ?? "?"} ` +
				`scripted=${pending.length + 1} answerChars=${step.text.length}`,
		);
		const chunkChars = step.chunkChars ?? 4;
		const everyMs = step.everyMs ?? 2;
		const chunks = [];
		for (let index = 0; index < step.text.length; index += chunkChars) chunks.push(step.text.slice(index, index + chunkChars));

		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		const send = (event, data) => {
			response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		};

		send("message_start", {
			type: "message_start",
			message: {
				id: `msg_bench_${Date.now()}`,
				type: "message",
				role: "assistant",
				model: "bench",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 8, output_tokens: 1 },
			},
		});
		send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		for (const chunk of chunks) {
			await new Promise((done) => setTimeout(done, everyMs));
			if (response.destroyed) return;
			send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } });
		}
		send("content_block_stop", { type: "content_block_stop", index: 0 });
		send("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: Math.ceil(step.text.length / 4) },
		});
		send("message_stop", { type: "message_stop" });
		response.end();
	});

	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		close: () => new Promise((done) => server.close(done)),
	};
}
