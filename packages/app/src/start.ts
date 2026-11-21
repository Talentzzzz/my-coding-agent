import type { ChatTransport } from "@my-agent/domain";
import { SessionHub } from "@my-agent/case";
import { HomeJsonStore, SessionFileStore, ToolResultsArchive } from "@my-agent/infra";
import {
	createServer,
	createRoutes,
	createMuxServer,
	muxUpgrade,
	sessionListeners,
	Router,
	SessionController,
	SystemController,
	type HttpServerHandle,
	type MuxServer,
	type WireOptions,
} from "@my-agent/trigger";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { AGENT_HOME } from "./agent-home.ts";

/**
 * `vite` 模式下的 client 源码目录，其余情况是构建产物。两者都解析到 packages/web 内，所以本模块必须留在包根的下一级目录，这些路径才能继续指向它。
 */
const WEB_DIR = fileURLToPath(new URL("../../web", import.meta.url));
const CLIENT_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));

export interface StartOptions {
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
	 * 会话文件对、两份设置文件与默认模型所在的 agent home。缺省走 {@link AGENT_HOME} 的解析
	 * （`MY_AGENT_HOME ?? ~/.my-agent`，分层重构 §5.1）。
	 *
	 * homes 是**路径**不是端口——本组合根是唯一把 home 翻译成 infra 实现的地方：session store 指
	 * `<settingsHome>/sessions`，home-json 第一份服务 `sessions.json` 与 `tools.json`。提供这个
	 * 透传的原因：驱动写设置命令的 smoke 与隔离运行的 dev 脚本不得触碰机器自己的文件——一个 home
	 * 指全隔离，不再有独立的 store 缝。
	 */
	settingsHome?: string;
	/**
	 * 读取和写入导入模型行所用的 agent home。缺省跟 {@link StartOptions.settingsHome}。
	 *
	 * 与 {@link StartOptions.settingsHome} 相同的透传，对应另一份 home-json（ModelManager 用）：
	 * 把模型行交给服务器的 smoke 不得把它们留在机器的 `models.json` 里，也不得依赖运行它的人恰好
	 * 在那里配置了什么。生产中没有任何东西设置它。
	 */
	modelsHome?: string;
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
 * 整个服务器就是这一次调用，因为嵌入它的宿主——dev 薄脚本（`scripts/serve.ts`）、smoke 脚本、桌面 shell——不应该被迫重建 wiring 描述的对象图。组合根只提供这个程序化入口，自身不拥有任何 CLI。
 */
export async function start(options: StartOptions): Promise<BootedServer> {
	const workDirAbsPath = options.workDirAbsPath;
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 8080;
	const sessionId = options.sessionId ?? process.env.MY_AGENT_SESSION ?? undefined;

	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid port: ${port}`);
	}

	// home → infra 实现的翻译（分层重构 §5.1 的翻译表）：app 是唯一把 home 路径变成存储实现的地方。
	// settingsHome 派生会话 store（`<settingsHome>/sessions`，`setSessionsDir` 消亡后的替代缝）与
	// 第一份 home-json（sessions.json + tools.json）；modelsHome 缺省跟 settingsHome，另一份
	// home-json 服务 models.json。tool-results 实现收绝对路径、无 home 概念。同一实现满足
	// SessionDefaults 与 ToolDefaults 两份同形声明（结构化类型，spec §4.2）。
	const settingsHome = options.settingsHome ?? AGENT_HOME;
	const modelsHome = options.modelsHome ?? settingsHome;
	const settingsStore = new HomeJsonStore({ home: settingsHome });
	const sessionStore = new SessionFileStore({ storeDir: join(settingsHome, "sessions") });

	const sessionHub = new SessionHub({
		workDirAbsPath,
		// 还没有项目选择器的 shell 除此之外无法被指向某个会话；环境变量是启动器或采集运行指明打开哪个会话的方式。
		...(sessionId === undefined ? {} : { sessionId }),
		sessionRepository: sessionStore,
		sessionDefaultsRepository: settingsStore,
		modelRepository: modelsHome === settingsHome ? settingsStore : new HomeJsonStore({ home: modelsHome }),
		toolDefaultsRepository: settingsStore,
		toolResultsRepository: new ToolResultsArchive(),
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

/** 构建产出的 client 所在的位置，供想上报它的调用者使用。 */
export const clientDirectory = CLIENT_DIR;
