// 一条可以出故障的 TCP 中继：客户端连它，它连真服务器，字节两边搬。
//
// 装置，不含任何断言（旧图票 15 §1(a)）。它存在的原因是验收第 4 条的装置关键：客户端判活的
// 输入是应用层帧，所以要制造"服务端一直在说话、客户端却什么都收不到"的局面——中继在黑屏时
// **继续读服务端方向、继续丢**，socket 一概不关。它若不读，测到的就是服务端的停滞策略
// （票 11 的写侧队列）而不是客户端的 watchdog；两者的装置不能混。
import { connect as tcpConnect, createServer, type Server, type Socket } from "node:net";

export interface FaultyProxy {
	/** 客户端连这里。 */
	readonly url: string;
	/**
	 * 停止把服务端方向的字节转给客户端，但**继续读、继续丢**——socket 不关。
	 *
	 * 上行不受影响：客户端仍然以为自己连着，发出去的字节也照常到达服务端。断的是下行的
	 * 应用层帧，这正是"客户端不发请求也能发现连接已死"要面对的最坏情况。
	 */
	blackout(on: boolean): void;
	/** 黑屏期间被丢掉的字节数：服务端一直在说话的证据。 */
	readonly dropped: { bytes: number };
	/** 客户端连了几次：重连的证据。 */
	readonly connections: number;
	close(): Promise<void>;
}

/** 起一条中继。`target` 是真服务器的 `http://host:port`。 */
export async function faultyProxy(target: URL): Promise<FaultyProxy> {
	const host = target.hostname === "localhost" ? "127.0.0.1" : target.hostname;
	const port = Number(target.port);

	let blackedOut = false;
	const dropped = { bytes: 0 };
	let connections = 0;
	const upstreams = new Set<Socket>();

	const server: Server = createServer((client) => {
		connections += 1;
		const upstream = tcpConnect({ host, port });
		upstreams.add(upstream);

		// 上行照搬：客户端的 open / cancel 与 WebSocket 握手都走这个方向，黑屏不断它。
		client.pipe(upstream);

		// 下行手搬，黑屏才有落点：`pipe` 没有 halfway 丢字的模式，而"继续读"这件事必须显式写出来
		// 才算数——不读的话，TCP 的窗口很快填满，测到的就成了服务端的停滞策略。
		upstream.on("data", (chunk: Buffer) => {
			if (blackedOut) {
				dropped.bytes += chunk.length;
				return;
			}
			// 中继自己也是一个写侧：socket 拒收时暂停读，drain 了再继续。冒烟里的流量很小，
			// 这几行大概率永远不触发，但装置不该靠"流量小"活着。
			if (!client.write(chunk)) {
				upstream.pause();
				client.once("drain", () => upstream.resume());
			}
		});

		const tear = (): void => {
			client.destroy();
			upstream.destroy();
			upstreams.delete(upstream);
		};
		client.on("error", tear);
		upstream.on("error", tear);
		client.on("close", tear);
		upstream.on("close", tear);
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		// 端口交给操作系统挑（票 15 决定 9：新装置只吃 URL，不写死端口）。
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", rejectListen);
			resolveListen();
		});
	});

	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("proxy: 没拿到监听地址");

	return {
		url: `ws://127.0.0.1:${address.port}/mux`,
		blackout(on: boolean) {
			blackedOut = on;
		},
		dropped,
		get connections(): number {
			return connections;
		},
		close(): Promise<void> {
			for (const upstream of upstreams) upstream.destroy();
			upstreams.clear();
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}
