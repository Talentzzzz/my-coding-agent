/**
 * A real-Chromium harness over the DevTools protocol.
 *
 * The smokes drive the client on a DOM shim, which has no layout and no compositor: it can say a
 * node exists, not that it sits in the middle of the canvas, and it cannot show a frame. Anything
 * about what the window looks like or how it paints has to be read back from a browser that lays
 * out — and the browser has to be the same Chromium generation the desktop shell runs, because that
 * is the engine the person is actually looking at.
 *
 * Nothing here needs a dependency: Chrome speaks JSON over a WebSocket, and Node has both. The
 * browser is started headless with a throwaway profile, so no session, extension, or theme of the
 * machine's own Chrome leaks into a capture.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where a Chromium binary might be, most specific first. `CHROME_PATH` always wins. */
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

/** The Chromium binary this run will drive, or a sentence naming what to install. */
export function browserPath(): string {
	for (const candidate of CHROME_CANDIDATES) {
		if (candidate !== undefined && existsSync(candidate)) return candidate;
	}
	throw new Error("找不到 Chromium：装一个 Chrome/Edge，或用 CHROME_PATH 指向可执行文件");
}

export interface Chromium {
	/** The port the DevTools endpoint listens on, chosen by the OS. */
	port: number;
	close(): Promise<void>;
}

/** Start a headless Chromium window of the given size and wait until it is listening. */
export async function launchChromium(size: { width: number; height: number } = { width: 1280, height: 820 }): Promise<Chromium> {
	const profile = mkdtempSync(join(tmpdir(), "my-agent-cdp-"));
	const child = spawn(
		browserPath(),
		[
			"--headless=new",
			// Port 0: the OS picks a free one, so two captures never collide. The chosen number and
			// the browser's WebSocket path land in `DevToolsActivePort` once it is listening.
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			`--window-size=${size.width},${size.height}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			"--disable-sync",
			"--disable-features=Translate,MediaRouter",
			// The app under measurement is driven by timers and frames; Chromium throttles both in a
			// window it believes is hidden, which headless is.
			"--disable-background-timer-throttling",
			"--disable-renderer-backgrounding",
			"--disable-backgrounding-occluded-windows",
			// The harness only ever drives a localhost dev server, and a machine-level proxy
			// (HTTP_PROXY or the system's own) would otherwise swallow even that.
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
			// Two lines: the port, then the browser target's path.
			const first = readFileSync(portFile, "utf8").split("\n")[0];
			if (first !== undefined && first !== "") port = Number.parseInt(first, 10);
		} catch {
			// The file appears only once the browser is listening; until then there is nothing to read.
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
	/** One protocol call; resolves with the `result` member. */
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
	/** Listen for one protocol event (only the ones a measurement wants are worth subscribing to). */
	on(event: string, listener: (params: Record<string, unknown>) => void): void;
	/** Run an expression in the page and return its value, or throw with the page's own error. */
	evaluate<T>(expression: string): Promise<T>;
	/** Poll an expression until it is true. */
	waitFor(expression: string, timeoutMs?: number): Promise<void>;
	/** Press an element; throws when the selector matches nothing. */
	click(selector: string): Promise<void>;
	/** Press an element with the pointer: a press and a release at its centre. */
	press(selector: string): Promise<void>;
	/** Write a PNG of the current viewport. */
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
 * Open a page target on the browser at `port` and navigate it to `url`.
 *
 * The viewport is pinned with `Emulation.setDeviceMetricsOverride` rather than left to the window
 * size: a capture has to be the same box every run, and the override is what a CDP client can also
 * change mid-run (a narrower window, a bigger font scale).
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

	const socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("连不上 DevTools WebSocket")), { once: true });
	});

	let next = 0;
	const pending = new Map<number, Pending>();
	const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();

	socket.addEventListener("message", (event) => {
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
			socket.send(JSON.stringify({ id, method, params }));
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
			// A real press, not `click()`: the branch page decides selection on `pointerup` so a pan
			// never selects what it stopped on, and a synthetic click would never reach that handler.
			await send("Input.dispatchMouseEvent", { type: "mousePressed", x: centre.x, y: centre.y, button: "left", clickCount: 1 });
			await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: centre.x, y: centre.y, button: "left", clickCount: 1 });
		},
		screenshot: async (file) => {
			const shot = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
			writeFileSync(file, Buffer.from(shot.data, "base64"));
		},
		close: async () => {
			socket.close();
		},
	};

	await send("Page.enable");
	await send("Runtime.enable");
	if (options.initScript !== undefined) {
		// Before the document exists: an observer installed after the app has booted would miss the
		// frames and long tasks this run exists to count.
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
