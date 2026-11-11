import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, internalError } from "./errors.ts";

/**
 * 本服务器路由的 HTTP 动词。这个集合刻意是封闭的：transport 是 REST，方法永远是一个查找键，而不是一条隧道。
 */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * `:name` 片段如何被读取。parser 返回值，或返回 `undefined` 表示"这不是那个资源"——router 会把它变成 404 而不是 400：`/api/sessions/foo` 不是格式错误的请求，而是对不存在事物的请求。
 */
export type ParamParser<T = string> = (raw: string) => T | undefined;

/**
 * 服务一条路由的东西。
 *
 * 刻意声明为带调用签名的 interface：这个位置的参数按 bivariant 检查，这让一个 params 为 `{ id: string }` 的路由能放进 params 为 `Record<string, unknown>` 的路由表。函数类型别名是严格检查的，会拒绝它。没有其他地方依赖这个放宽，而真正重要的类型——handler 内 `params.id` 是 `string`——在路由声明处检查。
 */
export interface RouteHandler<P> {
	(params: P, request: IncomingMessage, response: ServerResponse): Promise<void> | void;
}

export interface RouteEntry<P extends Record<string, unknown>> {
	method: Method;
	path: string;
	params: { [K in keyof P]: ParamParser<P[K]> };
	handle: RouteHandler<P>;
}

/**
 * 一条路由：一个方法、一个路径模板，以及服务它的 controller 方法。
 *
 * `params` 是被提取片段的类型，由 parser 推导，所以 handler 声明的参数不会偏离它挂载的路径——`{ id: stringParam }` 才让 `params.id` 在 handler 内是 `string`。
 */
export function route<P extends Record<string, unknown>>(entry: RouteEntry<P>): RouteEntry<P> {
	return entry;
}

/**
 * 路由表持有的一条路由。
 *
 * 这是本仓库唯一的 `any`，是明知故犯地打破惯例。路由表是异构的——一条路由的 params 是 `{ id: string }`，另一条是 `{ id: string, toolCallId: string }`——所以没有任何单一的具体实例化能同时接受它们：`Record<string, unknown>` 不行，因为要求 `id` 的 handler 不能接受可能没有 `id` 的 record；`Record<string, never>` 也不行，那样任何调用者都无法传任何 params；TypeScript 也没有"某个 `P`，在路由声明处检查"的存在类型。试过把 cast 藏在 helper 里，同样的原因编译不过。
 *
 * 代价是有界且刻意的：`Router` 只读 entry 的 `method`、`path`、`params` 和 `handle`，这些在运行时由 parser 验证。它保住的仍是重要的类型——`route({ params: { id: stringParam } })` 让 `params.id` 在该 entry 自己的 handler 内是 `string`，检查发生在真正会犯错的地方。
 */
export type ApiRoute = RouteEntry<any>;

export const stringParam: ParamParser<string> = (raw) => (raw.length === 0 ? undefined : raw);

/** 路径模板只切分一次，匹配时不再重新解析模式。 */
interface CompiledRoute {
	method: Method;
	segments: string[];
	params: Record<string, ParamParser<never>>;
	handle: RouteHandler<Record<string, unknown>>;
}

/**
 * 路由表：方法加路径进来，controller 方法出去。
 *
 * 这就是一个 Spring `DispatcherServlet` 做的事，仅此而已。有趣的部分在于它是唯一解释请求 URL 的地方——controller 收到的是验证过的 params 和 body，而不是原始请求。这才让第二个 surface、或一个测试，成为调用者而不是复制品。
 */
export class Router {
	readonly routes: readonly ApiRoute[];
	private readonly compiled: CompiledRoute[];

	constructor(routes: readonly ApiRoute[]) {
		this.routes = routes;
		this.compiled = routes.map((entry) => ({
			method: entry.method,
			segments: splitPath(entry.path),
			params: entry.params as Record<string, ParamParser<never>>,
			handle: entry.handle,
		}));
	}

	/**
	 * 若有路由认领这个 URL 就服务它，并报告是否有。
	 *
	 * `false` 表示"不归我"——调用者落到静态 client 上，这就是一个进程同时服务 API 和打包 UI 的方式。错误在这里映射而不是由调用者映射，因为这里是唯一知道路由是否匹配的地方：未路由路径的 404 是调用者的职责，而 405 或 controller 内部的失败是本方法的。
	 */
	async dispatch(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const method = (request.method ?? "GET").toUpperCase();
		if (!isMethod(method)) return false;

		const pathname = pathOf(request.url);
		const allowed: Method[] = [];
		for (const entry of this.compiled) {
			const params = match(entry, pathname);
			if (params === undefined) continue;
			if (entry.method !== method) {
				allowed.push(entry.method);
				continue;
			}

			try {
				await entry.handle(params, request, response);
			} catch (error) {
				this.fail(error, response);
			}
			return true;
		}

		// 路径存在但动词不对：返回 405 并附上允许的动词，而不是一个会让调用者去找路径拼写错误的 404。
		if (allowed.length > 0) {
			const failure = new HttpError(405, `Method ${method} is not allowed for ${pathname}`);
			failure.headers = { allow: [...new Set(allowed)].join(", ") };
			this.fail(failure, response);
			return true;
		}
		return false;
	}

	/** 把失败作为 JSON 应答，或当响应已开始时不再碰它。 */
	private fail(error: unknown, response: ServerResponse): void {
		if (response.headersSent) {
			// 已经没有有意义的话可说——事件流已经启动，或 body 已经写出。放手；客户端只会看到流结束。
			return;
		}
		const failure = internalError(error);
		const body = JSON.stringify({ error: failure.message });
		const extra = error instanceof HttpError && error.headers !== undefined ? error.headers : {};
		response.writeHead(failure.status, {
			"content-type": "application/json; charset=utf-8",
			"content-length": Buffer.byteLength(body),
			...extra,
		});
		response.end(body);
	}
}

/**
 * 请求 URL 的路径，永远不含 query：query 是过滤器，不是路由。
 *
 * 保持百分号编码。每个片段在 `match` 中解码一次，因为在这里解码整个路径会把编码的斜杠变成分隔符，改变请求所属的路由。
 */
function pathOf(url: string | undefined): string {
	const raw = url ?? "/";
	const end = [raw.indexOf("?"), raw.indexOf("#")]
		.filter((index) => index >= 0)
		.reduce((lowest, index) => Math.min(lowest, index), raw.length);
	const pathname = raw.slice(0, end);
	return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function splitPath(path: string): string[] {
	return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * 读出路径提供的 params，路由不匹配时返回 `undefined`。
 *
 * parser 拒绝一个值意味着该路由不适用——`/api/sessions/health` 是 404，因为 "health" 不是会话 id；不是 400，更绝不是以错误类型调用的 controller。
 */
function match(entry: CompiledRoute, pathname: string): Record<string, unknown> | undefined {
	const segments = splitPath(pathname);
	if (segments.length !== entry.segments.length) return undefined;

	const params: Record<string, unknown> = {};
	for (let index = 0; index < entry.segments.length; index += 1) {
		// 逐片段做百分号解码，而不是对整个路径：会话 id 或 tool call id 是不透明的，可能含冒号或相当于斜杠的标点，`decodeURI` 对 `%3A` 置之不理，而原始的 `%2F` 绝不能把一个片段劈成两个。
		const segment = decodeSegment(segments[index] ?? "");
		if (segment === undefined) return undefined;
		const pattern = entry.segments[index] ?? "";
		if (!pattern.startsWith(":")) {
			if (pattern !== segment) return undefined;
			continue;
		}

		const name = pattern.slice(1);
		const parse = entry.params[name];
		if (parse === undefined) return undefined;
		const value = parse(segment);
		if (value === undefined) return undefined;
		params[name] = value;
	}
	return params;
}

/** 原样返回路径片段，不是合法百分号编码时返回 `undefined`。 */
function decodeSegment(segment: string): string | undefined {
	try {
		return decodeURIComponent(segment);
	} catch {
		// 格式错误的转义不是本服务器拥有的资源；router 把它当作未匹配。
		return undefined;
	}
}

function isMethod(method: string): method is Method {
	return method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}
