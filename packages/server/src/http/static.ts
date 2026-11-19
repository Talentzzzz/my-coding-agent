import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { httpStatus } from "./errors.ts";

/** 打包 client 由这些类型构成。其余一律按字节返回。 */
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".woff2": "font/woff2",
	".ico": "image/x-icon",
	".map": "application/json; charset=utf-8",
};

/** 一个 JSON 响应。所有 controller 的非事件流应答都从这里走。 */
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
		// 客户端是单个本地用户；缓存的 API 应答只是多一种令人困惑的过期方式。
		"cache-control": "no-store",
	});
	response.end(text);
}

/**
 * 服务构建好的 client，对任何不是文件的东西回退到 `index.html`。
 *
 * 这个回退是客户端路由可以刷新的原因。它刻意是最后手段：到达这里的请求已经没匹配上任何路由，所以未知的 `/api/...` 路径会变成 UI 的 HTML 而不是 JSON 404。`isApiPath` 就是把两者分开的东西。
 */
export async function serveStatic(clientDir: string, pathname: string, response: ServerResponse): Promise<void> {
	const relPath = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
	const absRoot = resolve(clientDir);
	const absPath = resolve(absRoot, relPath);
	// 要比的是分隔符，而不只是前缀：没有它，名为 `<clientDir>-backup` 的兄弟目录也能通过检查并被服务。
	if (absPath !== absRoot && !absPath.startsWith(absRoot + sep)) {
		const httpError = httpStatus.notFound("Not found");
		sendJson(response, httpError.status, { error: httpError.message });
		return;
	}

	const info = await stat(absPath).catch(() => undefined);
	const absFile = info?.isFile() ? absPath : join(clientDir, "index.html");
	const fallback = await stat(absFile).catch(() => undefined);
	if (!fallback) {
		sendJson(response, 503, {
			error: `No client build at ${clientDir}. Run "npm run build:web", or start the server with --vite.`,
		});
		return;
	}

	response.writeHead(200, {
		"content-type": MIME[extname(absFile)] ?? "application/octet-stream",
		"cache-control": absFile.endsWith("index.html") ? "no-store" : "public, max-age=3600",
	});
	createReadStream(absFile).pipe(response);
}

/** 路径是否属于 API，让未路由的 API 路径成为 404 而不是 client 壳。 */
export function isApiPath(pathname: string): boolean {
	return pathname === "/api" || pathname.startsWith("/api/");
}
