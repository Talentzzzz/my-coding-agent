// 传输面 @my-agent/trigger 的公开面（分层重构步 3 自 server/src 迁入，spec §7 步 3）：REST 路由
// 与控制器、mux/wire/frames、静态文件。本包对 domain 盲——域词汇一律经 `@my-agent/case` 到手
// （hub 与信封网关），组合根 @my-agent/app 从这里取组装服务器所需的全部零件。
export { createServer, type HttpOptions, type HttpServerHandle } from "./http.ts";
export { Router, route, stringParam, type ApiRoute } from "./http/routing.ts";
export { createMuxServer, muxUpgrade, type MuxConnection, type MuxDeps, type MuxOptions, type MuxServer } from "./mux.ts";
export {
	CLOSE_GOING_AWAY,
	REASON_SHUTTING_DOWN,
	Wire,
	resolveWireOptions,
	type FrameSink,
	type ResolvedWireOptions,
	type WireOptions,
} from "./wire.ts";
export { createRoutes, type Controllers } from "./controllers/routes.ts";
export {
	SessionController,
	SystemController,
	sessionListeners,
	type SessionListener,
} from "./controllers/sessions.ts";
