import { UnknownSessionError } from "@my-agent/domain";
import type { IncomingMessage } from "node:http";

/**
 * 一个已经带着应答所用 status 的失败。
 *
 * 这是 transport 唯一的错误类型。controller 抛它，router 映射它，中间的任何东西都不需要知道 HTTP。不是 `HttpError` 的错误就是 bug——按 500 应答并如实上报，包括消息，因为这是本地单用户服务器。
 */
export class HttpError extends Error {
	readonly status: number;
	/**
	 * 这个失败需要的额外响应头。
	 *
	 * 目前只有 `allow` 用它，用于 405：这个头必须和 status 一起写出，而在 router 尚未决定应答之前就调 `setHeader`，正是让 405 变成 500 的原因。
	 */
	headers?: Record<string, string>;

	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

/**
 * 本 API 用到的 status，按调用者做了什么来命名，而不是按数字。
 *
 * 把名字集中在这里，正是阻止 controller 顺手写裸 `404` 的东西，也让表格只有一个阅读处：未知 id 的 `/api/sessions/{id}` 是 `notFound`，不是 JSON 的 body 是 `badRequest`，会话不认识的工具名是 `conflict`（会话拒绝了这个变更，名字对了同样的请求就能成功）。
 */
export const httpStatus = {
	badRequest: (message: string) => new HttpError(400, message),
	notFound: (message: string) => new HttpError(404, message),
	conflict: (message: string) => new HttpError(409, message),
} as const;

/** 一个被抛出的值应得的 status 和消息，包括从未打算成为 HTTP 的错误。 */
export function internalError(error: unknown): { status: number; message: string } {
	if (error instanceof HttpError) return { status: error.status, message: error.message };
	// 数据层自己的拒绝，以类型命名而不是从句子文本里嗅探：一个哪里都不存在的 id。所有未知会话的路都汇到这里，这就是为什么没有任何端点先做存在性检查。
	if (error instanceof UnknownSessionError) return { status: 404, message: error.message };
	return { status: 500, message: error instanceof Error ? error.message : String(error) };
}

/** 本服务器愿意读多少 body：一个 prompt 加几个名字，绝不是文件上传。 */
const MAX_BODY_BYTES = 1_000_000;

/**
 * 请求 body 的文本形式，已 trim，受大小上限约束。
 *
 * 两个对象读取共用的唯一读取器，因为这个上限的目的是约束内存，所以必须在读取之前检查——写两遍的检查迟早有一遍会漏掉。大小超限在 megabyte 到来之前就上报，而不是之后。
 */
async function readBodyText(request: IncomingMessage): Promise<string> {
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
	return Buffer.concat(chunks).toString("utf8").trim();
}

/** 文本作为对象的形式，或格式错误的 body 应得的两个 400。 */
function parseObject(text: string): Record<string, unknown> {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw httpStatus.badRequest("Request body is not valid JSON");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw httpStatus.badRequest("Request body must be a JSON object");
	}
	return body as Record<string, unknown>;
}

/**
 * 读取 JSON 请求 body。
 *
 * 缺失的 body 在这里被拒绝而不是被应答，因为本读取器的每个调用者都会从结果上取一个必填字段。
 */
export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const text = await readBodyText(request);
	if (text.length === 0) throw httpStatus.badRequest("A JSON body is required");
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw httpStatus.badRequest("Request body is not valid JSON");
	}
}

/**
 * JSON body 作为对象的形式，否则 400。
 *
 * controller 会从结果上解构字段，所以"body 到底是不是对象"在这里一次定死，而不是在每个 handler 里各来一遍。
 */
export async function readObjectBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	return parseObject(await readBodyText(request));
}
