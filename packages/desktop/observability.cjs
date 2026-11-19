/**
 * 外壳的失败面：上行路上、或底下有什么死了的时候，用户看到的东西。
 *
 * 它单独存在，而不是内联在 `main.cjs` 里，理由与 `shutdown.cjs` 相同：重写这些 handler 的 smoke 是在断言自己的拷贝，而这里要钉住的是*接了哪些信号、它们说什么*。一切 Electron 形状的东西都以参数到达——`app`、窗口工厂、dialog、窗口查找——所以 smoke 可以用假件驱动真实的 handler，而且本文件可以被普通 Node 导入。
 *
 * 用 CommonJS 是因为外壳就是：Electron 在任何工具链运行之前加载 `main.cjs`。
 *
 * **语言。** 失败的两半以仓库为它们准备的两门语言书写。诊断行是英文，本外壳的诊断本来就是英文（`shutdown.cjs`，以及 `main.cjs` 自己的服务器和采集行都读作 `desktop: …`）——AGENTS.md 把诊断导向中文，而外壳是这一规则的长期例外，所以让新模块与邻居保持一致，比混排日志的惊讶更小。页面和对话框是中文，因为那是面向用户的字符串，而这是一个单语言环境的窗口。
 *
 * **这不是什么。** 不是策略。下面只有一个预算，它存在是因为 otherwise 一个挂起的 boot 与一次什么都没发生的启动无从区分；它不是关于"多久才算合理"的决定，本模块也不重试、不换端口、不选择下一步。它存在的意义是让失败*可见*——一行带原因的日志，和一个同样说了这句话的窗口。
 *
 * **为什么报告能在渲染进程死后幸存**，这是本文件最值得知道的一点：报告是一个 `data:` 页面，外壳自己绘制它，不必去问那个刚刚启动失败的服务器。死掉的渲染进程被一个新的顶替，新进程把这个页面画出来——在这台机器上用 `webContents.forcefullyCrashRenderer()` 实测过（`.scratch/window-repair/research/electron-probe/`）：`render-process-gone` 以 `{reason: "crashed", exitCode: 2}` 到达，随后 `loadURL(data:…)` settle，新渲染进程以报告页自己的标题应答，窗口可见。原生 dialog 是完全画不出页面的窗口的最后手段：它由 OS 在浏览器进程里绘制，不需要渲染进程——代价是阻塞直到有人点击，所以它永远不是第一选择。
 */

/**
 * 外壳在报告"服务器从未起来"之前等待多久。
 *
 * 是看门狗不是期限：导入服务器自己的 TypeScript 依赖图在这里约 415 ms，Vite 的首次变换是这里见过的最慢情况，所以预算内的 boot 就是常规路径。它买到的是：一个*挂起*而不是拒绝的 `bootServer()` 不再与什么都没做的外壳无从区分。`shutdown.cjs` 在生命周期的另一端为同样的理由备有同形的预算。
 */
const BOOT_BUDGET_MS = 20_000;

/** 加载失败的名字，无论外壳在哪里上报它——主窗口不是唯一的窗口。 */
const LOAD_FAILED_HEADLINE = "窗口没能加载 agent 服务";

/**
 * 接管外壳的失败面。
 *
 * @param {object} options
 * @param {{ on(event: string, listener: (...args: unknown[]) => void): void }} options.app Electron
 *   应用对象：只用它的 `on`。
 * @param {() => object} options.createWindow 构建绘制报告的窗口。外壳自己的工厂决定边框、主题和
 *   preload；报告不得成为第二种窗口。
 * @param {(workDirAbsPath: string) => Promise<{ url: string }>} options.boot 启动服务器，无法启动时 reject。
 * @param {number} [options.bootBudgetMs] 覆盖 {@link BOOT_BUDGET_MS}，让 smoke 用毫秒驱动挂起的
 *   boot，而不是等完真实预算。
 * @param {(line: string) => void} [options.log] 诊断行的去处。默认 `console.error`；smoke 改为收集。
 * @param {object} [options.dialog] Electron 的 `dialog` 模块。smoke 传记录器；外壳传真的那个——
 *   没有任何渲染进程能画的时候，它是剩下的唯一 surface。
 * @param {(webContents: object) => object | null} [options.windowFor] 解析一个 `webContents` 所属的
 *   窗口，供 `render-process-gone` 使用——渲染进程自己的窗口正是该事件的全部意义。默认为 Electron 的
 *   `BrowserWindow.fromWebContents`。
 */
function createObservability(options) {
	const { app, createWindow, boot } = options;
	const budgetMs = options.bootBudgetMs ?? BOOT_BUDGET_MS;
	const log = options.log ?? ((line) => console.error(line));
	// 按需解析而不是在构造时：普通 Node 进程里 `require("electron")` 返回的是路径，而一个只能在 Electron 内加载的模块，就轮不到本文件为之存在的 smoke 来驱动了。
	const electron = () => require("electron");
	const dialog = options.dialog ?? electron().dialog;
	const windowFor =
		options.windowFor ??
		((webContents) => {
			try {
				return electron().BrowserWindow.fromWebContents(webContents) ?? null;
			} catch {
				return null;
			}
		});

	/** 已经被告知渲染进程死亡的窗口，让一次死亡只说一件事。 */
	const reported = new WeakSet();

	/** `exitCode` 写成 crash dump 用的十六进制，因为负数十进制没法读。 */
	function hex(exitCode) {
		return typeof exitCode === "number" && exitCode < 0
			? `0x${(exitCode >>> 0).toString(16).toUpperCase()}`
			: String(exitCode);
	}

	/** 消失的子进程的一行：哪一个、为什么、退出码是什么。 */
	function describeChild(details) {
		const name = details.name ?? details.serviceName ?? "unnamed child";
		const why =
			details.reason === "clean-exit"
				? "exited cleanly"
				: `went away (${details.reason}, exit code ${hex(details.exitCode)})`;
		return `${details.type} process ${name} ${why}`;
	}

	/** 消失的渲染进程的一行。 */
	function describeRenderer(details) {
		return `the renderer went away (${details.reason}, exit code ${hex(details.exitCode)})`;
	}

	/**
	 * 失败的三个部分，各放在它可读的位置。
	 *
	 * @param {string} headline 一行说出失败的是什么，用窗口自己的话。
	 * @param {Error | string} cause 原因。`Error` 把它的堆栈带上页面，这是"能行动的报告"与"只知道
	 *   坏了"的区别。
	 */
	function failureParts(headline, cause) {
		return {
			headline,
			message: cause instanceof Error ? cause.message : String(cause),
			detail: cause instanceof Error && cause.stack ? `\n\n${cause.stack}` : "",
		};
	}

	/**
	 * 阻塞面，给那个页面也画不出来的窗口。
	 *
	 * 它阻塞到有人点击为止，恰恰在这里可以容忍：替代方案是一次用户永远不会被告知的失败。连 dialog 自己都抛错的情形记日志后吞掉——再抛出去就是拿进程陪葬最后手段的"说明失败"。
	 */
	function showNativeDialog(parts) {
		try {
			dialog.showErrorBox(parts.headline, `${parts.message}${parts.detail.slice(0, 2000)}`);
		} catch (error) {
			log(`desktop: even the native dialog refused to open — ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * 在一个专属的窗口里画出一个失败，并把窗口交回。
	 *
	 * `data:` 页面是用户能读、能滚、能复制的 surface，而且外壳自己绘制它，所以既不需要刚失败的服务器、也不需要健康的渲染进程。它在页面到达时显示，而不是等 `ready-to-show`——外壳自己的窗口等的是后者：该事件对 `data:` URL 不触发，所以等它的报告会是一个画进永远无人看见的窗口的失败页——正是本模块存在要修的问题形状。监听器在 `loadURL` 之前挂上，同步完成的加载也能找到一个。
	 *
	 * @returns {object | null} 页面正在进入的窗口，或连窗口都没有时的 `null`——调用者手里就只剩
	 *   已记录的那一行日志。
	 */
	function showInWindow(headline, cause) {
		const parts = failureParts(headline, cause);
		const escape = (text) => text.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"));
		const page =
			"data:text/html;charset=utf-8," +
			encodeURIComponent(
				`<!doctype html><meta charset="utf-8"><title>my-coding-agent</title>` +
					`<body style="font:14px/1.6 system-ui;background:#151517;color:#e9ecf2;padding:2rem">` +
					`<h1 style="font-size:16px">${escape(parts.headline)}</h1>` +
					// 先截断再转义，顺序绝不能反：切进 `&amp;` 中间会在页面里留下半个实体，而堆栈是这里唯一被允许截断的部分。
					`<pre style="white-space:pre-wrap;color:#f25a5a">${escape(parts.message)}${escape(parts.detail.slice(0, 4000))}</pre>`,
			);
		try {
			const browserWindow = createWindow();
			if (browserWindow.webContents && typeof browserWindow.webContents.once === "function") {
				browserWindow.webContents.once("did-finish-load", () => {
					if (!browserWindow.isDestroyed()) browserWindow.show();
				});
			}
			void browserWindow.loadURL(page).catch((error) => {
				log(`desktop: the failure page did not draw — ${error instanceof Error ? error.message : String(error)}`);
				showNativeDialog(parts);
			});
			return browserWindow;
		} catch (error) {
			log(
				`desktop: no window could be opened for the report — ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
			);
			showNativeDialog(parts);
			return null;
		}
	}

	/**
	 * 上报一次失败：一行带原因的诊断日志，然后是一个说着同样的话的窗口。
	 *
	 * @param {string} headline 一行说出失败的是什么。
	 * @param {Error | string} cause 原因，有堆栈时带上堆栈。
	 * @returns {object | null} 报告正在其中绘制的窗口，或连这一步也失败时的 `null`。
	 */
	function report(headline, cause) {
		log(`desktop: ${headline} — ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`);
		return showInWindow(headline, cause);
	}

	/**
	 * 被杀死的渲染进程留在屏幕上的东西，在它必须被说出的两个地方说出。
	 *
	 * 窗口不可用了——页面搭起的一切随进程而去——所以这是唯一不能等用户自己发现的失败。日志行先去诊断处，让原因即使在没人看屏幕时也已落盘；然后是报告窗口：顶替的渲染进程即使旧进程刚死也能画出 `data:` 页面，用户因此在一个可读的地方拿到原因，而不是一个不再重绘的窗口。
	 */
	function reportRendererGone(webContents, details) {
		const message = describeRenderer(details);
		log(`desktop: ${message}`);
		const source = windowFor(webContents);
		// 一个不再有人在看的窗口——已关闭，或从未创建——屏幕上没有任何需要解释的东西，而同一次死亡的第二个报告是噪音。
		if (source === null || source.isDestroyed() || reported.has(source)) return;
		reported.add(source);
		showInWindow(
			"窗口的渲染进程没了",
			new Error(`${message}\n\n画着这个窗口的进程已经没了，所以它不会再画任何东西；关掉它，重新启动一次外壳。`),
		);
	}

	/**
	 * 接线那些自己发生的失败，在应用 ready 之后。
	 *
	 * 四个信号，且它们不是同一种消息。子进程消失只是一行日志：GPU 或网络子进程是用户从未要求过的进程，在他们正在使用的窗口前弹对话框是噪音。日志行让下一次死亡可诊断而非神秘——本外壳曾经携带的那些开关，正是靠这样的日志行被发现、测量、然后删除的（ADR-0004）。渲染进程消失让他们失去那个窗口，所以它得到一个自己的报告窗口。主进程里的异常两者都不是：外壳在这里的工作是启动服务器和画窗口，而窗口和服务器都是别人的孩子——所以上报并让进程继续站着，而不是让一个游离的异常终结用户正身处其中的一段对话。没人处理的 promise 拒绝与抛出的错误是同一种消息，只是到达时没有进程自己的警报，所以用同样的方式上报。
	 */
	function watch() {
		app.on("child-process-gone", (_event, details) => {
			log(`desktop: ${describeChild(details)}`);
		});

		app.on("render-process-gone", (_event, webContents, details) => {
			reportRendererGone(webContents, details);
		});

		process.on("uncaughtException", (error) => {
			report("外壳遇到了一个没人处理的异常", error);
		});

		process.on("unhandledRejection", (reason) => {
			report("外壳有一个没人处理的 promise 拒绝", reason instanceof Error ? reason : String(reason));
		});
	}

	/**
	 * 在预算内把服务器带回来；带不回来就让失败可见，然后交还 `null`。
	 *
	 * 三条出口，各有一次自己的报告：预算内成功是寻常路径——没有行、没有窗口，服务器原样回来；
	 * boot 拒绝是已经知道的失败——一行原因加上一个说着同样的话的窗口；挂起则由看门狗在预算到点
	 * 时代言，`null` 交还给外壳而 boot 自己还挂着的那个 promise 不被放弃——它后来无论落在哪一头，
	 * 都有一行日志把这件事说出来（成功说出 url，失败说出原因），因为报告已经画出去的那一次启动
	 * 不该无声无息地结束。
	 *
	 * @param {string} workDirAbsPath 交给 {@link boot} 的工作目录。
	 * @returns {Promise<{ url: string } | null>} 预算内的服务器，或预算耗尽／启动失败时的 `null`。
	 */
	function bootWithinBudget(workDirAbsPath) {
		return new Promise((resolve) => {
			let settled = false;
			const watchdog = setTimeout(() => {
				if (settled) return;
				settled = true;
				log(`desktop: the server did not come up within its ${budgetMs} ms budget`);
				report("agent 服务没有启动起来", new Error(`the server did not come up within ${budgetMs} ms`));
				resolve(null);
			}, budgetMs);
			boot(workDirAbsPath).then(
				(booted) => {
					if (settled) {
						log(`desktop: the server came up late, on ${booted.url}`);
						return;
					}
					settled = true;
					clearTimeout(watchdog);
					resolve(booted);
				},
				(error) => {
					if (settled) {
						log(`desktop: the late server boot failed too — ${error instanceof Error ? error.message : String(error)}`);
						return;
					}
					settled = true;
					clearTimeout(watchdog);
					report("agent 服务没有启动起来", error);
					resolve(null);
				},
			);
		});
	}

	return { watch, report, bootWithinBudget };
}

module.exports = { createObservability, BOOT_BUDGET_MS, LOAD_FAILED_HEADLINE };
