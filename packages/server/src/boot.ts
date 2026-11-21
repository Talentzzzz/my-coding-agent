import type { ChatTransport } from "@my-agent/domain";
import { createServer, type HttpServerHandle } from "./http.ts";
import { SessionHub } from "./hub.ts";
import { SessionController, SystemController, type SessionListener } from "./controllers/sessions.ts";
import { createRoutes } from "./controllers/routes.ts";
import { Router } from "./http/routing.ts";
import { createMuxServer, type MuxConnection, type MuxServer } from "./mux.ts";
import type { FrameSink, WireOptions } from "./wire.ts";
import { WebSocketConnection } from "./http/websocket.ts";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

/**
 * `vite` 模式下的 client 源码目录，其余情况是构建产物。两者都解析到 packages/web 内，所以本模块必须留在包根的下一级目录，这些路径才能继续指向它。
 */
const WEB_DIR = fileURLToPath(new URL("../../web", import.meta.url));
const CLIENT_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** mux 所在的路径。只有这一个，且不在 `/api` 之下：它不是 REST 资源。 */
const MUX_PATH = "/mux";

export interface BootOptions {
	/** agent 可以触碰的目录。 */
	workDirAbsPath: string;
	/** 绑定地址。默认 `127.0.0.1`：这个服务器只服务自己的机器。 */
	host?: string;
	/**
	 * 绑定端口。默认 8080；`0` 向操作系统要一个空闲端口，桌面 shell 要的就是这个，两个应用永远不为一个固定数字争执。
	 */
	port?: number;
	sessionId?: string;
	/**
	 * 读取和写入全局设置所用的 agent home。默认是真实的那一个。
	 *
	 * 提供这个透传只有一个原因：驱动写设置命令的 smoke——比如隐藏一个目录——否则会改到机器自己的 `settings.json`。生产中没有任何东西设置它。
	 */
	settingsHome?: string;
	/**
	 * 本服务器打开的每个会话所对话的 transport。
	 *
	 * 真实进程里省略，意味着 Anthropic Messages。smoke 传入脚本化的 transport，让一次运行可以被驱动——最关键的是停在一个审批上——而完全不需要 provider key。这个透传正是该选项存在的全部理由：shutdown smoke 需要真实的 boot 路径，包括真实的 hub，直面它的最坏情况。
	 */
	chatTransport?: ChatTransport;
	/**
	 * wire 自己的定时器与五个预算，可覆盖以便 smoke 用毫秒驱动它们；mux 只是把这个对象透传给
	 * 每条连接自己的 wire。
	 *
	 * 用透传而不是逐字段的枚举：连接层拥有这些值的含义，在这里复述等于多一个要保持诚实的地方。生产中没有任何东西设置它。
	 */
	mux?: WireOptions;
	/** 用 Vite 服务 client 而不是构建产物，用于热更新。 */
	vite?: boolean;
}

export interface BootedServer {
	/** client 和 API 可达的地址，端口是实际绑定的那个。 */
	url: string;
	port: number;
	workDirAbsPath: string;
	/**
	 * 本进程唯一的 service：会话的编排订阅、侧栏行、这台机器的列表都从它问。
	 *
	 * REST 的 controller 与 mux 的连接 controller 面对的是同一个口子——行存储住在 hub 内部
	 * （原 `projection.ts` 已并入），想要这些行的调用者直接向 hub 要，hold 或会话删除都不依赖它问过。
	 */
	sessionHub: SessionHub;
	/** 常驻连接层：每个升级的 socket 一个。 */
	muxServer: MuxServer;
	httpServerHandle: HttpServerHandle;
	/** 先关连接，再关会话，最后关监听器。 */
	close(): Promise<void>;
}

/**
 * 在一个监听器上启动 API 和 client。
 *
 * 整个服务器就是这一次调用，因为嵌入它的宿主——CLI、smoke 脚本、桌面 shell——不应该被迫重建 wiring 描述的对象图。`main.ts` 是这个函数的命令行面孔，自身不拥有任何东西。
 */
export async function bootServer(options: BootOptions): Promise<BootedServer> {
	const workDirAbsPath = options.workDirAbsPath;
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 8080;
	const sessionId = options.sessionId ?? process.env.MY_AGENT_SESSION ?? undefined;

	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid port: ${port}`);
	}

	const sessionHub = new SessionHub({
		workDirAbsPath,
		// 还没有项目选择器的 shell 除此之外无法被指向某个会话；环境变量是启动器或采集运行指明打开哪个会话的方式。
		...(sessionId === undefined ? {} : { sessionId }),
		...(options.settingsHome === undefined ? {} : { settingsHome: options.settingsHome }),
		...(options.chatTransport === undefined ? {} : { chatTransport: options.chatTransport }),
	});

	// mux 持有连接，行存储住在 hub 内部：hub 观察哪些会话存在、它们在做什么，而这两者都不允许
	// 让会话保持存活或催促它关闭。
	//
	// 顺序之所以重要，仅仅因为每条连接的第一帧就是 overview，所以 hub 必须能在任何窗口开口之前回答"有哪些会话"——那正是行存储的首读播种。
	// mux 就是连接级 controller：服务在这里注入，所以每条连接自己不必去够任何全局，也不再
	// 有一个工厂把"连接的业务侧"藏在 mux 背后（ADR-0025）。
	const muxServer = createMuxServer({ sessionHub }, options.mux ?? {});
	// 两个 controller 共用一组 listener，且在两者之前构建：目录改名由 system controller 接收，落在 hub 的行上——与会话 controller 的 rename 和 delete 走的是同一块。
	const listeners = sessionListeners({ sessionHub });
	const router = new Router(
		createRoutes({
			systemController: new SystemController(sessionHub, listeners),
			// run 失败是关于一次运行的事实，而不是关于某个仍开着的请求，且是 transport 的分内事：见 {@link sessionListeners}，那是它唯一的家，smoke 借此可以经由与本服务器相同的函数接线。
			sessionController: new SessionController(sessionHub, listeners),
		}),
	);

	const httpServerHandle = await createServer({
		router,
		clientDir: options.vite === true ? WEB_DIR : CLIENT_DIR,
		useVite: options.vite ?? false,
		onUpgrade: muxUpgrade(muxServer),
	});

	await new Promise<void>((resolveListen) => httpServerHandle.server.listen(port, host, resolveListen));
	const bound = (httpServerHandle.server.address() as AddressInfo | null)?.port ?? port;

	return {
		url: `http://${host}:${bound}`,
		port: bound,
		workDirAbsPath,
		sessionHub,
		muxServer,
		httpServerHandle,
		close: async () => {
			// 先关连接，且在会话之前：窗口的订阅在它们正在观看的会话还在时被释放，不需要从活着的 feed 底下拆东西。hub 的收摊自己放下行跟随（它只监听），然后才停运行。
			muxServer.close();
			// 升级的 socket 由监听器自己的 close 销毁，那是唯一能碰到它们的地方；mux 只是停止需要它们。
			await sessionHub.close();
			await httpServerHandle.close();
		},
	};
}

/** 请求 URL 的路径，不含 query。 */
function pathOf(url: string | undefined): string {
	const raw = url ?? "/";
	const end = raw.indexOf("?");
	return end < 0 ? raw : raw.slice(0, end);
}

/**
 * mux 的 `upgrade` handler，作为它所服务服务器的一个函数。
 *
 * 从 `bootServer` 里提出来，因为它接的线不是 boot 期的秘密：自建对象图的 smoke（用脚本化模型替代 provider、用自己的 hub）恰恰需要在自己的 mux 前面接上这段 wiring，复制它会让微妙的部分——在 `accept()` 返回之前到达的 frame、作为本侧唯一存活证据的 Pong——散落成三份各自漂移的拷贝。handler 对每个服务器都相同；不同的只是站在它背后的 mux。
 */
export function muxUpgrade(
	muxServer: MuxServer,
): (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean {
	return (request, socket, head) => {
		if (pathOf(request.url) !== MUX_PATH) {
			// 在这里销毁而不是拒绝，因为拒绝不是本服务器能做的事：只要存在任何 `upgrade` 监听器，Node 就已经把 socket 交出且永远不会再碰它。不销毁就返回会让它永远开着——而只要有一个开着，`server.close()` 就永远不回调，所以任何一个打到别的路径上的 `Upgrade:` 头都会把 shutdown 永久卡死。
			socket.destroy();
			return true;
		}
		const webSocketConnection = WebSocketConnection.accept(request, socket);
		if (webSocketConnection === undefined) return true;

		// WebSocket 之上的 `FrameSink`，让连接层的策略永远看不到 socket，frame 编解码永远看不到订阅。整个分层就系在这条缝上。
		const frameSink: FrameSink = {
			send: (frame) => webSocketConnection.send(JSON.stringify(frame)),
			ping: () => webSocketConnection.ping(),
			close: (code, reason) => webSocketConnection.close(code, reason),
			terminate: () => webSocketConnection.terminate(),
			get isClosed() {
				return webSocketConnection.isClosed;
			},
		};

		/**
		 * 在连接对象存在之前到达的上行 frame。
		 *
		 * `accept()` 要 await hub 的首次行读取（overview 的播种），所以无法同步交回连接——而第一个动作就是 `open` 的客户端会把那个 frame 放在与握手同一个 TCP segment 里，它甚至在 `accept()` 被调用*之前*就被 replay。丢掉这些 frame 会让那个客户端永远等一个不会到来的 baseline，而心跳还在喂它的看门狗，令它毫无察觉。所以它们在这里按顺序等待，一旦有了可交付的对象立刻 replay。
		 */
		const waiting: string[] = [];

		let muxConnection: MuxConnection | undefined;
		webSocketConnection.start({
			onMessage: (text) => {
				if (muxConnection === undefined) {
					if (!webSocketConnection.isClosed) waiting.push(text);
					return;
				}
				muxServer.handle(muxConnection, text);
			},
			onClose: () => {
				// 连接从未成为会话对象时没有东西要忘，但挂起的 frame 无论如何都要丢：已经没有可以把它们送达的对象了。
				waiting.length = 0;
				if (muxConnection !== undefined) muxServer.forget(muxConnection);
			},
			onProtocolError: (reason) => {
				console.warn(`mux: 协议错误，关闭连接：${reason}`);
			},
			// 本侧能得到的唯一存活证据。没有它，连接层会把未应答的 Ping 记在一个应答完全正常的 peer 头上，并把它丢掉。
			onPong: () => {
				if (muxConnection !== undefined) muxServer.notePong(muxConnection);
			},
		});

		void muxServer
			.accept(frameSink)
			.then((accepted) => {
				muxConnection = accepted;
				// 在（被 await 的）overview 读取期间结束的连接，不能留在服务器的集合里却没有留下任何能关闭它的东西。
				if (webSocketConnection.isClosed) {
					muxServer.forget(accepted);
					return;
				}
				// 只有在确认连接活着之后才安全：它收到的第一帧是 overview，客户端反正无法把这些和自己的 frame 区分开。
				for (const text of waiting.splice(0)) muxServer.handle(accepted, text);
			})
			.catch((error: unknown) => {
				console.warn(`mux: 拒绝一个连接：${error instanceof Error ? error.message : String(error)}`);
			});
		if (head.length > 0) webSocketConnection.replay(head);
		return true;
	};
}

/**
 * 会话 controller 向 transport 报告的事项，为每个服务会话的服务器接线一次。
 *
 * 从 `bootServer` 里提出来，理由与 {@link muxUpgrade} 相同：这段 wiring 不是 boot 期的秘密，自建对象图的 smoke 恰恰需要它。微妙的半截是那行日志——一次运行的失败会在观看该会话的连接上宣布，而空的订阅表意味着这个 frame 根本没有读者，所以日志是"没有人在看的失败"仍然可闻的唯一地方。复制这些日志行的 smoke 是在断言自己的拷贝；经由这里接线，它能证明的事情是：删掉这个 `console.error` 它就会变红。
 *
 * `hub` 是收件人：run 失败的措辞只经 hub 扇出，而 rename 和 delete 首先是*行*事实，其次才是 frame 事实——hub 的行存储先更新，各自发出的 frame 走的是普通的发布之路。
 */
export function sessionListeners(deps: { sessionHub: SessionHub }): SessionListener {
	const { sessionHub } = deps;
	return {
		onRunFailure: (sessionId, message) => {
			console.error(`会话 ${sessionId} 的运行失败：${message}`);
			sessionHub.publishFailure(sessionId, message);
		},
		onCreated: (sessionId) => {
			void sessionHub.refreshRow(sessionId);
		},
		onRenamed: (sessionId) => {
			void sessionHub.refreshRow(sessionId);
		},
		onRemoved: (sessionId) => {
			sessionHub.forgetRow(sessionId);
		},
	};
}

/** 构建产出的 client 所在的位置，供想上报它的调用者使用。 */
export const clientDirectory = CLIENT_DIR;
