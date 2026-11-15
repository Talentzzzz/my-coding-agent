// 手工把一个 session 挂载到 hub 上，供那些不需要 open 就要拿到 session 的 smoke 使用。
//
// 生产路径从不这么做：`SessionHub.open()` 会从请求里解析出要运行哪个 session，并经由
// orchestrator 自己的配置读取其设置。而 smoke 希望预先知道 session 的 id，所以这里替它走完
// open 的两个步骤：构建会话 bag 并让它出生（ADR-0021：会话随第一条消息存在），经由与生产
// open 相同的公共入口把它挂到 hub 的 orchestrator 上，然后挂上 hub 用作键的 hold token。
// hub 的唯一 orchestrator 随后像对待其他 session 一样服务它，因为它应答的每个调用都会指名
// 这个 id。
//
// 设置不属于 mount 可选的范围：配置归 orchestrator 所有，一个 orchestrator 以构建时的那份配置
// 服务进程内的所有 session。想要自己设置的 smoke——自己的 gate、自己的行——要在 hub 构建
// 之前把配置种到 hub 的 settings 与 models 目录（`HubOptions.settingsHome` / `modelsHome`）
// 背后的文件里，它挂载的每个 session 都会经由那里读取。模型行同理：会话打开在哪一行是
// 「记录的选择 → 设置默认行 → 第一行」的现算答案，这里的出生消息不点名任何一行。
import { type Session, createSession } from "@my-agent/core";
import { HostedSession, type SessionHub } from "../packages/server/src/hub.ts";

/** hub 的私有半区，从 smoke 的视角可达。 */
interface HubInternals {
	hostedSessionMap: Map<string, HostedSession>;
	announceHost(sessionId: string, host: HostedSession | undefined): void;
}

export interface MountOptions {
	/** session 的工具在其中解析的工作目录，也是其头部声明它所在的位置。 */
	root: string;
}

/** 挂载后的 session：每个调用指名的 id、其背后的会话袋，以及它的 hold token。 */
export interface MountedSession {
	id: string;
	session: Session;
	host: HostedSession;
}

/**
 * 把一个 session 种入 hub 的注册表并挂载其 hold token。
 *
 * session 处于 idle——这里不取 hold，正如 `hub.birth()` 只返回 id 而不持有它——需要持有的
 * 调用方应向 `hub.hold()` 请求。
 */
export async function mountSession(hub: SessionHub, options: MountOptions): Promise<MountedSession> {
	const internals = hub as unknown as HubInternals;
	const session = createSession(options.root);
	// 出生（ADR-0021）：一条 user 消息落盘，`.json` 与 `.jsonl` 同时诞生——编排层按 id 现开
	// 文件，不经此步，挂载后的第一次 prompt / snapshot 都会在 open 里被拒绝。
	hub.agent.sessionManager.appendMessage(session, {
		role: "user",
		content: [{ type: "text", text: "the mounted session's birth message" }],
		timestamp: 1,
	});
	// 走入口，而不是组装后收养：session 经由与生产组装相同的门进入 hub 的 orchestrator，smoke 不会
	// 种下 orchestrator 不知道的东西——其上组装的服务都是 hub 自己的，这正是 mount 不可见的原因。
	// 这扇门是 class-private（`hold` / `createAndPrompt` 是 host 会拼写的动词），所以 mount 和其他
	// 私有半区一样直达它。袋子自带工作目录，mount 的 `root` 就落在那里。
	const door = hub.agent as unknown as {
		assembleAgentStateBySession(options: { session: Session }): Promise<unknown>;
	};
	await door.assembleAgentStateBySession({ session });
	const host = new HostedSession(session.sessionId);
	internals.hostedSessionMap.set(session.sessionId, host);
	// 生产 `open` 会做的公告：保持沉默的 mount 会让 projection 对这个 session 失聪，它的行就永远
	// 穿不上进程实际知道的 live 字段。
	internals.announceHost(session.sessionId, host);
	return { id: session.sessionId, session, host };
}
