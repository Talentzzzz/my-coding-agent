import { sendJson } from "../http/static.ts";
import { readObjectBody } from "../http/errors.ts";
import { route, stringParam, type ApiRoute } from "../http/routing.ts";
import type { SessionController, SystemController } from "./sessions.ts";

/**
 * 以表的形式呈现的 API。
 *
 * 这相当于 Spring controller 上的注解，集中在一个文件里，读一次就能回答"这个服务器暴露了什么"。每个 entry 指名一个 controller 上的方法；这里没有任何东西自己做工作。
 *
 * **mux 的上行 frame 不在这里，而且这不是遗漏。** 它们不走 URL：`open` 和 `cancel` 作为 WebSocket 消息到达那条常驻连接上，router 永远见不到它们。所以这张表就是完整的 REST surface——每个 entry 都是一个用 `curl` 就能发出的请求——而它之上的 frame 是窗口表达想看什么的方式。两者的分界不是任意的：一个拥有自己的资源、有持久后果、且 URL 能复现它的动作是命令，属于这里；只改变"这条连接收到什么"的动作属于 mux。
 *
 * 动词承载语义而不只是约定：
 *
 * - `GET` 读取，从不改变会话。
 * - `POST /api/sessions` 出生一个会话（body 必填第一条消息）；子资源上的 `POST` 是一个生效即返回的命令。命令用 `POST` 而不是 `PATCH`，因为它们不是编辑：同一 prompt 发两次就是两个 prompt，而 `abort` 发两次仍然是一次停止。`POST /api/sessions/:id/title` 同形——一次被接受的改名，一份快照被重写。
 * - `PATCH` 改配置的一部分：模式指针、会话的审批增量、队列模式。
 * - `PUT` 整体替换一张表：模型清单（`/api/models`）。会话不再有 PUT——工具配置只经模式指针变更
 *   （ADR-0018）。
 * - `DELETE` 永久移除资源。它只存在一次，在会话本身上，因为会话是这里唯一一个"移除本身是目的"而不是"对别的东西产生影响"的对象。
 */
export interface Controllers {
	system: SystemController;
	sessions: SessionController;
}

export function createRoutes(controllers: Controllers): ApiRoute[] {
	const routes: ApiRoute[] = [
		route({
			method: "GET",
			path: "/api/health",
			params: {},
			handle: (_params, _request, response) => sendJson(response, 200, controllers.system.health()),
		}),
		route({
			method: "GET",
			path: "/api/models",
			params: {},
			handle: (_params, _request, response) => sendJson(response, 200, { models: controllers.system.models() }),
		}),
		route({
			method: "GET",
			path: "/api/tools",
			params: {},
			handle: (_params, _request, response) => sendJson(response, 200, { tools: controllers.system.toolNames() }),
		}),
		route({
			method: "PUT",
			path: "/api/models",
			params: {},
			handle: async (_params, request, response) =>
				sendJson(response, 200, controllers.system.updateModels(await readObjectBody(request))),
		}),
		route({
			method: "GET",
			path: "/api/settings",
			params: {},
			handle: (_params, _request, response) => sendJson(response, 200, controllers.system.settings()),
		}),
		route({
			method: "PATCH",
			path: "/api/settings",
			params: {},
			handle: async (_params, request, response) =>
				sendJson(response, 200, controllers.system.updateSettings(await readObjectBody(request))),
		}),
		route({
			method: "GET",
			path: "/api/directories",
			params: {},
			handle: async (_params, _request, response) => sendJson(response, 200, await controllers.system.directories()),
		}),
		route({
			method: "POST",
			// 是命令而不是对某个目录资源做 `PATCH`，因为目录在这里没有 id：它由它所在的目录命名，body 把路径与用户输入的名字一起带来。之所以是命令，是因为它不改变任何资源：它把一个标签写进 settings，目录保持文件系统给它的名字。
			path: "/api/directories/rename",
			params: {},
			handle: async (_params, request, response) =>
				sendJson(response, 200, await controllers.system.renameDirectory(await readObjectBody(request))),
		}),
		route({
			method: "POST",
			// 只是从列表里移除，别的什么都不动：会话记录及其命名的目录原地保留。URL 里用 `hide` 而不是 `delete` 正是为了说明这一点，因为这里的 DELETE 会承诺一件本命令刻意不做的事。
			path: "/api/directories/hide",
			params: {},
			handle: async (_params, request, response) =>
				sendJson(response, 200, await controllers.system.hideDirectory(await readObjectBody(request))),
		}),
		route({
			method: "GET",
			path: "/api/sessions",
			params: {},
			handle: async (_params, _request, response) => sendJson(response, 200, await controllers.system.sessions()),
		}),
		route({
			method: "GET",
			path: "/api/sessions/current",
			params: {},
			handle: async (_params, _request, response) => sendJson(response, 200, await controllers.system.current()),
		}),
		route({
			method: "POST",
			// 出生证明（ADR-0021）：body 必填 `text` —— 会话与它的第一条消息在同一个请求里原子出生，
			// 服务端在第一条消息之前完全无状态。`workDirAbsPath` / `mode` / `model` / `thinkingLevel`
			// 是随这条消息出发的选择；响应 201，id 由服务端铸。
			path: "/api/sessions",
			params: {},
			handle: async (_params, request, response) =>
				sendJson(response, 201, await controllers.sessions.birth(await readObjectBody(request))),
		}),
		route({
			method: "GET",
			path: "/api/sessions/:id",
			params: { id: stringParam },
			handle: async (params, _request, response) => sendJson(response, 200, await controllers.sessions.read(params.id)),
		}),
		route({
			method: "POST",
			path: "/api/sessions/:id/messages",
			params: { id: stringParam },
			handle: async (params, request, response) =>
				sendJson(response, 202, await controllers.sessions.prompt(params.id, await readObjectBody(request))),
		}),
		route({
			method: "POST",
			path: "/api/sessions/:id/abort",
			params: { id: stringParam },
			handle: async (params, _request, response) =>
				sendJson(response, 200, await controllers.sessions.abort(params.id)),
		}),
		route({
			method: "PATCH",
			path: "/api/sessions/:id",
			params: { id: stringParam },
			handle: async (params, request, response) =>
				sendJson(response, 200, await controllers.sessions.updateConfig(params.id, await readObjectBody(request))),
		}),
		route({
			method: "POST",
			// 会话没有在等的一个 toolCallId 是 409 而不是静默的 no-op——controller 在 answers 表和会话听到这个尝试之前就拒绝了。
			path: "/api/sessions/:id/approvals/:toolCallId",
			params: { id: stringParam, toolCallId: stringParam },
			handle: async (params, request, response) =>
				sendJson(
					response,
					200,
					await controllers.sessions.approve(params.id, params.toolCallId, await readObjectBody(request)),
				),
		}),
		route({
			method: "POST",
			path: "/api/sessions/:id/forks",
			params: { id: stringParam },
			handle: async (params, request, response) =>
				sendJson(response, 201, await controllers.sessions.fork(params.id, await readObjectBody(request))),
		}),
		route({
			// 201 而不是 200：改名会重写快照——被接受的请求在会话文件里留下了一个新值可以指认，这正是这个 status 所说的。
			method: "POST",
			path: "/api/sessions/:id/title",
			params: { id: stringParam },
			handle: async (params, request, response) =>
				sendJson(response, 201, await controllers.sessions.rename(params.id, await readObjectBody(request))),
		}),
		route({
			method: "DELETE",
			path: "/api/sessions/:id",
			params: { id: stringParam },
			handle: async (params, _request, response) => sendJson(response, 200, await controllers.sessions.remove(params.id)),
		}),
		route({
			method: "POST",
			path: "/api/sessions/:id/branch",
			params: { id: stringParam },
			handle: async (params, request, response) =>
				sendJson(response, 200, await controllers.sessions.branch(params.id, await readObjectBody(request))),
		}),
	];
	return routes;
}
