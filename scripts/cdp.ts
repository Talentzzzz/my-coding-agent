/**
 * 建立在 DevTools protocol 之上的真 Chromium 装置。
 *
 * smoke 在 DOM shim 上驱动客户端，而 shim 没有布局、没有合成器：它能说某个节点存在，说不了它
 * 是否坐在画布中央，也画不出一帧。窗口看起来什么样、如何绘制这类问题必须从一台真的会做布局的
 * 浏览器读回——而且这台浏览器必须与桌面外壳运行的 Chromium 同代，因为那才是人真正在看的引擎。
 *
 * 这里不需要任何依赖：Chrome 用 WebSocket 说 JSON，Node 两样都有。浏览器以无头模式、一次性
 * profile 启动，机器自己的 Chrome 的会话、扩展或主题都不会泄进截图。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Chromium 二进制可能所在的位置，按具体程度排序。`CHROME_PATH` 永远优先。 */
const CHROME_CANDIDATES = [
	process.env.CHROME_PATH,
	process.env.ProgramFiles === undefined ? undefined : join(process.env.ProgramFiles, "Google/Chrome/Application/chrome.exe"),
	process.env["ProgramFiles(x86)"] === undefined
		? undefined
		: join(process.env["ProgramFiles(x86)"], "Google/Chrome/Application/chrome.exe"),
	process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
	process.env.ProgramFiles === undefined ? undefined : join(process.env.ProgramFiles, "Microsoft/Edge/Application/msedge.exe"),
	process.env["ProgramFiles(x86)"] === undefined
		? undefined
		: join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe"),
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** 本次运行要驱动的 Chromium 二进制，或一句说明该装什么的报错。 */
export function browserPath(): string {
	for (const candidate of CHROME_CANDIDATES) {
		if (candidate !== undefined && existsSync(candidate)) return candidate;
	}
	throw new Error("找不到 Chromium：装一个 Chrome/Edge，或用 CHROME_PATH 指向可执行文件");
}

export interface Chromium {
	/** DevTools 端点监听的端口，由操作系统挑选。 */
	port: number;
	close(): Promise<void>;
}

/** 启动一个指定尺寸的无头 Chromium 窗口，等到它开始监听为止。 */
export async function launchChromium(size: { width: number; height: number } = { width: 1280, height: 820 }): Promise<Chromium> {
	const profile = mkdtempSync(join(tmpdir(), "my-agent-cdp-"));
	const child = spawn(
		browserPath(),
		[
			"--headless=new",
			// 端口 0：由操作系统挑一个空闲端口，两次截图不会相撞。选定的号码与浏览器的 WebSocket
			// 路径在它开始监听后落进 `DevToolsActivePort`。
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			`--window-size=${size.width},${size.height}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			"--disable-sync",
			"--disable-features=Translate,MediaRouter",
			// 被测应用靠定时器和帧驱动；Chromium 会节流它认为隐藏的窗口里的这两样，无头窗口正是
			// 隐藏的。
			"--disable-background-timer-throttling",
			"--disable-renderer-backgrounding",
			"--disable-backgrounding-occluded-windows",
			// 装置只会驱动一个 localhost 开发服务器，而机器级代理（HTTP_PROXY 或系统自己的）
			// 否则会把它也吞掉。
			"--no-proxy-server",
			"about:blank",
		],
		{ stdio: "ignore" },
	);

	let exited = false;
	child.once("exit", () => {
		exited = true;
	});

	const portFile = join(profile, "DevToolsActivePort");
	const deadline = Date.now() + 20_000;
	let port: number | undefined;
	while (port === undefined) {
		if (exited) throw new Error("Chromium 一启动就退出了");
		if (Date.now() > deadline) throw new Error("等不到 Chromium 的 DevTools 端口");
		try {
			// 两行：第一行是端口，第二行是浏览器 target 的路径。
			const first = readFileSync(portFile, "utf8").split("\n")[0];
			if (first !== undefined && first !== "") port = Number.parseInt(first, 10);
		} catch {
			// 文件只在浏览器开始监听后才出现；在那之前没有东西可读。
		}
		if (port === undefined) await new Promise((done) => setTimeout(done, 50));
	}

	return {
		port,
		close: async () => {
			if (!exited) {
				const gone = new Promise<void>((done) => child.once("exit", () => done()));
				child.kill();
				await gone;
			}
			rmSync(profile, { recursive: true, force: true });
		},
	};
}

export interface Page {
	/** 一次协议调用；以 `result` 成员落定。 */
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
	/** 监听一个协议事件（只订阅测量想要的那些才值得）。 */
	on(event: string, listener: (params: Record<string, unknown>) => void): void;
	/** 在页面里执行一段表达式并返回其值，页面自己的报错则抛出。 */
	evaluate<T>(expression: string): Promise<T>;
	/** 轮询一个表达式直到为真。 */
	waitFor(expression: string, timeoutMs?: number): Promise<void>;
	/** 按下一个元素；selector 匹配不到时抛出。 */
	click(selector: string): Promise<void>;
	/** 用指针按下元素：在其中心一次按下与一次释放。 */
	press(selector: string): Promise<void>;
	/** 把当前视口写成一张 PNG。 */
	screenshot(file: string): Promise<void>;
	close(): Promise<void>;
}

interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface Target {
	type: string;
	webSocketDebuggerUrl?: string;
}

/**
 * 在 `port` 的浏览器上打开一个 page target，并导航到 `url`。
 *
 * 视口用 `Emulation.setDeviceMetricsOverride` 钉住，而不是交给窗口尺寸决定：截图每一次运行都得
 * 是同一个盒子，而且这份 override 也是 CDP 客户端能在运行中改的（更窄的窗口、更大的字体缩放）。
 */
export async function openPage(
	port: number,
	url: string,
	options: { width: number; height: number; scale?: number; initScript?: string } = { width: 1280, height: 820 },
): Promise<Page> {
	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
	const targets = (await response.json()) as Target[];
	const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl !== undefined);
	if (target?.webSocketDebuggerUrl === undefined) throw new Error("Chromium 没有给出可连接的页面");

	const webSocket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise<void>((resolve, reject) => {
		webSocket.addEventListener("open", () => resolve(), { once: true });
		webSocket.addEventListener("error", () => reject(new Error("连不上 DevTools WebSocket")), { once: true });
	});

	let next = 0;
	const pending = new Map<number, Pending>();
	const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();

	webSocket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data)) as {
			id?: number;
			method?: string;
			params?: Record<string, unknown>;
			result?: unknown;
			error?: { message: string };
		};
		if (message.id !== undefined) {
			const waiter = pending.get(message.id);
			if (waiter === undefined) return;
			pending.delete(message.id);
			if (message.error === undefined) waiter.resolve(message.result);
			else waiter.reject(new Error(message.error.message));
			return;
		}
		for (const listener of listeners.get(message.method ?? "") ?? []) listener(message.params ?? {});
	});

	const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
		new Promise((resolve, reject) => {
			next += 1;
			const id = next;
			pending.set(id, { resolve, reject });
			webSocket.send(JSON.stringify({ id, method, params }));
		});

	const evaluate = async <T>(expression: string): Promise<T> => {
		const answer = (await send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		})) as { result?: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
		if (answer.exceptionDetails !== undefined) {
			throw new Error(`页面里报错：${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`);
		}
		return answer.result?.value as T;
	};

	const page: Page = {
		send,
		on: (event, listener) => {
			const set = listeners.get(event) ?? new Set();
			set.add(listener);
			listeners.set(event, set);
		},
		evaluate,
		waitFor: async (expression, timeoutMs = 10_000) => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (await evaluate<boolean>(`Boolean(${expression})`)) return;
				await new Promise((done) => setTimeout(done, 50));
			}
			throw new Error(`等不到：${expression}`);
		},
		click: async (selector) => {
			const pressed = await evaluate<boolean>(
				`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node === null) return false; node.click(); return true; })()`,
			);
			if (!pressed) throw new Error(`找不到可点的元素：${selector}`);
		},
		press: async (selector) => {
			const centre = await evaluate<{ x: number; y: number } | null>(
				`(() => {
					const node = document.querySelector(${JSON.stringify(selector)});
					if (node === null) return null;
					const box = node.getBoundingClientRect();
					return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
				})()`,
			);
			if (centre === null) throw new Error(`找不到可按的元素：${selector}`);
			// 真正的按下，不是 `click()`：branch 页面在 `pointerup` 上才决定选中，这样平移就不会
			// 选中它停下的东西，而合成的 click 永远到不了那个 handler。
			await send("Input.dispatchMouseEvent", { type: "mousePressed", x: centre.x, y: centre.y, button: "left", clickCount: 1 });
			await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: centre.x, y: centre.y, button: "left", clickCount: 1 });
		},
		screenshot: async (file) => {
			const shot = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
			writeFileSync(file, Buffer.from(shot.data, "base64"));
		},
		close: async () => {
			webSocket.close();
		},
	};

	await send("Page.enable");
	await send("Runtime.enable");
	if (options.initScript !== undefined) {
		// 在文档存在之前注入：应用启动后才装的 observer 会错过本次运行要统计的帧与长任务。
		await send("Page.addScriptToEvaluateOnNewDocument", { source: options.initScript });
	}
	await send("Emulation.setDeviceMetricsOverride", {
		width: options.width,
		height: options.height,
		deviceScaleFactor: options.scale ?? 1,
		mobile: false,
	});
	await send("Page.navigate", { url });
	await page.waitFor('document.readyState === "complete"', 20_000);
	return page;
}
