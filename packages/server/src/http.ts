import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Router } from "./http/routing.ts";
import { isApiPath, serveStatic } from "./http/static.ts";

export interface HttpOptions {
	/** API 的路由表。没有路由认领的请求落到 client 上。 */
	router: Router;
	clientDir: string;
	/** 以 middleware 模式使用 Vite，让 client 在服务器不重启的情况下热更新。 */
	useVite?: boolean;
	/**
	 * 接管请求切换协议的连接。
	 *
	 * 一旦这个监听器存在，Node 已经把 socket 交出来且不会再碰它，所以 handler 完全拥有 socket：必须要么收下、要么销毁。"拒绝"不是它能做的事——一个无人认领的 upgrade 会永远开着，`close()` 也随之永远不会回调。
	 *
	 * 保留布尔值是为了让调用者可以对自己认识但拒绝的路径报告"已处理"，这与收下的结果相同。
	 */
	onUpgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
}

export interface HttpServerHandle {
	server: Server;
	/**
	 * 所有从 HTTP 升级走的 socket，shutdown 时用它结束它们。
	 *
	 * 由这里持有而不是 mux，因为这里是唯一知道 socket 不再是一个响应的地方：连接一旦升级就完全不在 `server` 的账上，否则 `close()` 会在它还开着的时候返回。
	 */
	readonly upgradeSockets: ReadonlySet<Duplex>;
	close(): Promise<void>;
}

/**
 * 一个 HTTP 服务器同时服务应用的两半：JSON API 和 client。
 *
 * 没有第二个 *listener*。命令是一个请求，会话事件是 client 打开的那条常驻连接上的 frame，服务器会做的一切，任何能写 HTTP 的东西——浏览器、脚本、`curl`——都能到达。
 */
export async function createServer(options: HttpOptions): Promise<HttpServerHandle> {
	const vite = options.useVite === true ? await createViteMiddleware(options.clientDir) : undefined;
	const upgradeSockets = new Set<Duplex>();

	const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const pathname = pathOf(request.url);

		try {
			if (await options.router.dispatch(request, response)) return;

			// 被路由的 API 路径却无人认领是 404，不是 client 的壳：给一个拼错的端点返回客户端 HTML，比承认端点不存在更糟。
			if (isApiPath(pathname)) {
				response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
				response.end(JSON.stringify({ error: `No route for ${request.method ?? "GET"} ${pathname}` }));
				return;
			}

			if (vite) {
				// Vite 自己服务 client 并对自己不处理的请求调 `next`，所以 fallback 链在 Vite 自己的调用之后而不是与它并排：await 这个 Promise，两者之一真正完成响应时才会 settle。
				await new Promise<void>((settle) => {
					vite.middlewares(request, response, () => {
						void serveStatic(options.clientDir, pathname, response).finally(settle);
					});
				});
				return;
			}

			await serveStatic(options.clientDir, pathname, response);
		} catch (error) {
			if (response.headersSent) return;
			const message = error instanceof Error ? error.message : String(error);
			response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
			response.end(JSON.stringify({ error: message }));
		}
	};

	const server = createHttpServer((request, response) => {
		void handler(request, response);
	});

	// 在 `listen` 之前注册，且仅在有人会用它时：`upgrade` 监听器会把事件从 Node 的默认处理中拿走，所以注册一个空的监听器会改变一个用不到它的服务器的行为。
	if (options.onUpgrade !== undefined) {
		server.on("upgrade", (request, socket, head) => {
			if (options.onUpgrade?.(request, socket, head) === true) {
				// 从升级成功的那一刻起就追踪，因为从那一刻起这个 socket 对 `server.close()` 是不可见的——见 `close`。
				upgradeSockets.add(socket);
				// 只有 `close` 和 `error` 会忘记它。半关闭的 peer 只是停止发送：socket 仍然开着，若在 `end` 时把它从集合里丢掉，它会脱离 `close()` 依赖的清扫——恰好重新引入这个集合要防的挂起。
				const forget = (): void => {
					upgradeSockets.delete(socket);
				};
				socket.on("close", forget);
				socket.on("error", forget);
			}
		});
	}

	return {
		server,
		upgradeSockets,
		close: async () => {
			await vite?.close();
			// 升级过的 socket 既不是响应也不是空闲连接：`server.close()` 等的是响应，`closeAllConnections()` 够得到空闲的 keep-alive 连接，两者都不管一个完成了握手并变成别的东西的 socket。两者都针对这个确切场景验证过，都让进程挂着不放、窗口还连着，所以上面这个集合是唯一能关闭它们的东西。
			for (const socket of [...upgradeSockets]) socket.destroy();
			upgradeSockets.clear();
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		},
	};
}

function pathOf(url: string | undefined): string {
	const raw = url ?? "/";
	const end = [raw.indexOf("?"), raw.indexOf("#")]
		.filter((index) => index >= 0)
		.reduce((lowest, index) => Math.min(lowest, index), raw.length);
	return decodeURI(raw.slice(0, end));
}

interface ViteMiddleware {
	middlewares(request: IncomingMessage, response: ServerResponse, next: () => void): void;
	close(): Promise<void>;
}

interface ViteInstance {
	middlewares: ViteMiddleware["middlewares"];
	close(): Promise<void>;
}

interface ViteModule {
	createServer(options: Record<string, unknown>): Promise<ViteInstance>;
}

/**
 * 通过变量 specifier 惰性加载 Vite，让生产启动永远不需要安装它，也让 `tsc` 在构建 server 时不要求 Vite 的类型。
 */
async function createViteMiddleware(clientDir: string): Promise<ViteMiddleware> {
	const specifier = "vite";
	const vite = (await import(specifier)) as unknown as ViteModule;
	const instance = await vite.createServer({
		root: clientDir,
		appType: "spa",
		server: { middlewareMode: true },
	});
	return {
		middlewares: (request, response, next) => {
			instance.middlewares(request, response, next);
		},
		close: () => instance.close(),
	};
}
