import { sendJson } from "../http/static.ts";
import { optionalObjectBody, readObjectBody } from "../http/errors.ts";
import { route, stringParam, type ApiRoute } from "../http/routing.ts";
import type { SessionController, SystemController } from "./sessions.ts";

/**
 * The API, as a table.
 *
 * This is the equivalent of the annotations on a Spring controller, kept in one file so that one
 * read answers "what does this server expose?". Every entry names a method on a controller; nothing
 * here does work of its own.
 *
 * **The mux's uplink frames are not here, and that is not an omission.** They do not go through a URL:
 * `open` and `cancel` arrive as WebSocket messages on the one resident connection, and the router never
 * sees them. So this table is the whole REST surface — every entry is a request someone could make with
 * `curl` — while the frames above it are how a window says what it wants to watch. The line between the
 * two is not arbitrary: an action that has its own resource, a persistent consequence, and a URL that
 * reproduces it is a command and belongs here; one that only changes "what this connection receives"
 * belongs on the mux.
 *
 * The verbs carry meaning rather than being a convention:
 *
 * - `GET` reads, and never changes a session.
 * - `POST /api/sessions` creates one; `POST` on a sub-resource is a command that has an effect and
 *   returns as soon as it is accepted. Commands are `POST` rather than `PATCH` because they are not
 *   edits: sending the same prompt twice is two prompts, and sending `abort` twice is still one stop.
 *   `POST /api/sessions/:id/title` is the same shape — one accepted rename, one entry appended.
 * - `PATCH` changes part of a configuration.
 * - `PUT` replaces the active tool set outright, which is exactly the session's own contract.
 * - `DELETE` removes the resource for good. It exists once, on the session itself, because a session
 *   is the one thing here whose removal is the point rather than an effect on something else.
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
			path: "/api/workspaces",
			params: {},
			handle: async (_params, _request, response) => sendJson(response, 200, await controllers.system.workspaces()),
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
			// The body is optional and usually absent: an empty `POST` still creates a session in the
			// server's own workspace. A `cwd` in the body moves where that one session lands — a choice
			// made with the request, so it travels with it rather than becoming server state.
			path: "/api/sessions",
			params: {},
			handle: async (_params, request, response) =>
				sendJson(response, 201, await controllers.sessions.create(await optionalObjectBody(request))),
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
			method: "PUT",
			path: "/api/sessions/:id/tools",
			params: { id: stringParam },
			handle: async (params, request, response) =>
				sendJson(response, 200, await controllers.sessions.updateTools(params.id, await readObjectBody(request))),
		}),
		route({
			method: "POST",
			// A toolCallId the session is not waiting on is a 409, not a silent no-op — the controller
			// refuses before either the answers table or the session hears about the attempt.
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
			// 201 rather than 200: a rename creates one entry — the accepted request has a record in
			// the session file to show for it, which is what this status says.
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
