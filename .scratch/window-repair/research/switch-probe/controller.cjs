// Ticket 02's measuring controller: the real shell, driven with a chosen set of switches.
//
// Electron runs a *directory* whose `package.json` names a `main`. This one names the controller
// instead of `packages/desktop/main.cjs`, so the switches are applied here — one line *before* the
// real file is loaded — and the production file stays untouched. That matters because the question
// is *which of its lines may be deleted*: a test that edited the file would be measuring its own
// edit, and a copy of the file's `whenReady` would be measuring a copy.
//
//   $env:PROBE_SWITCHES="no-sandbox"; <electron.exe> .scratch/window-repair/research/switch-probe
//
// `PROBE_SWITCHES` is a comma-separated list of Chromium switches to append, `PROBE_SOFTWARE=1` adds
// the imperative `app.disableHardwareAcceleration()` (not a switch, so it cannot be spelled in the
// list), and `PROBE_LOG` names the log file. `PROBE_MEASURE=1` runs the window gauntlet once the
// page settles. Everything after the preamble is `require`ing the shell itself, so the window, the
// server and the failure surface are the production ones.
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");
const { app } = require("electron");

const DESKTOP = join(__dirname, "..", "..", "..", "..", "packages", "desktop");
const LOG = process.env.PROBE_LOG ?? join(__dirname, "probe.log");
const SWITCHES = (process.env.PROBE_SWITCHES ?? "")
	.split(",")
	.map((name) => name.trim())
	.filter((name) => name !== "");
/**
 * Whether the switches are passed as real `argv` entries instead of through `app.commandLine`.
 *
 * The difference is not cosmetic: `appendSwitch` runs after Chromium has already read its own command
 * line, so a switch set that way reaches child processes (whose command lines Chromium builds) and
 * not the browser process itself. `PROBE_VIA_ARGV=1` puts them on the real command line, which is
 * what a user typing them at a terminal does, and comparing the two is how the probe tells "this
 * switch does nothing" apart from "this switch never arrived".
 */
const VIA_ARGV = process.env.PROBE_VIA_ARGV === "1";
const SOFTWARE = process.env.PROBE_SOFTWARE === "1";

const startedAt = performance.now();
const say = (line) => {
	const stamped = `${new Date().toISOString()} +${Math.round(performance.now() - startedAt)}ms ${line}`;
	appendFileSync(LOG, `${stamped}\n`);
	process.stdout.write(`${stamped}\n`);
};

// ---- the shell's own preamble, parameterised ----------------------------------------------------
if (SOFTWARE) app.disableHardwareAcceleration();
if (!VIA_ARGV) {
	for (const name of SWITCHES) app.commandLine.appendSwitch(name);
}
say(`probe: switches=[${SWITCHES.join(",")}] softwareRendering=${SOFTWARE} via=${VIA_ARGV ? "argv" : "appendSwitch"}`);
say(`probe: argv=[${process.argv.slice(1).join(" ")}]`);
say(`probe: browser sees no-sandbox=${app.commandLine.hasSwitch("no-sandbox")} in-process-gpu=${app.commandLine.hasSwitch("in-process-gpu")}`);

process.on("uncaughtException", (error) => say(`probe: uncaughtException ${error.stack ?? error.message}`));
process.on("unhandledRejection", (reason) => say(`probe: unhandledRejection ${String(reason)}`));
app.on("child-process-gone", (_event, details) => say(`probe: child-process-gone ${JSON.stringify(details)}`));
app.on("render-process-gone", (_event, _wc, details) => say(`probe: render-process-gone ${JSON.stringify(details)}`));
app.on("gpu-process-crashed", (_event, killed) => say(`probe: gpu-process-crashed killed=${killed}`));

// ---- the real shell, verbatim -------------------------------------------------------------------
require(join(DESKTOP, "main.cjs"));

// ---- observation, attached to whatever windows the shell makes ----------------------------------
/** The window the shell's own `createWindow` made, whichever way it made it. */
const shellWindow = () => require("electron").BrowserWindow.getAllWindows()[0] ?? null;

app.on("browser-window-created", (_event, window) => {
	window.once("ready-to-show", () => {
		say(`probe: ready-to-show at ${Math.round(performance.now() - startedAt)}ms visible=${window.isVisible()}`);
	});
	window.webContents.on("did-finish-load", () => {
		say(`probe: did-finish-load at ${Math.round(performance.now() - startedAt)}ms`);
	});
	window.webContents.on("render-process-gone", () => say("probe: that window's renderer is gone"));
});

app.whenReady().then(async () => {
	say("probe: app ready");
	// A window built with `show: false` is only shown by the shell's `ready-to-show` handler, so
	// whether it ever becomes visible is the machine-readable form of "did the window open". It is
	// sampled rather than read once because a compositor that produces its first frame late is a
	// different finding from one that never does.
	const timeline = setInterval(() => {
		const live = require("electron").BrowserWindow.getAllWindows()[0];
		if (live) say(`probe: tick visible=${live.isVisible()} minimized=${live.isMinimized()}`);
	}, 1_000);
	timeline.unref?.();
	// The shell boots the server and loads the window; nothing here waits on it but the clock, so the
	// survey below just has to arrive after it has had its chance.
	await new Promise((done) => setTimeout(done, Number(process.env.PROBE_SETTLE_MS ?? 8_000)));
	clearInterval(timeline);
	await survey();
	if (process.env.PROBE_MEASURE === "1") await measure();
	finish();
});

/** Everything the main process can say about how the window came up. */
async function survey() {
	say(`probe: gpuFeatureStatus ${JSON.stringify(app.getGPUFeatureStatus())}`);
	say(
		`probe: appMetrics ${JSON.stringify(
			app.getAppMetrics().map((metric) => ({ type: metric.type, pid: metric.pid, cpu: metric.cpu?.percentCPUUsage })),
		)}`,
	);
	// What Chromium told the renderer and the utility process, which is where a switch that never
	// reached the browser process still shows up as if it had.
	try {
		const { execFileSync } = require("node:child_process");
		const lines = execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-Command",
				"Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | ForEach-Object { $t = if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'browser' }; ('{0} :: {1}' -f $t, $_.CommandLine) }",
			],
			{ encoding: "utf8" },
		);
		for (const line of lines.split(/\r?\n/).filter((l) => l.trim() !== "")) {
			const switches = (line.match(/--[a-z0-9-]+(=[^ ]*)?/g) ?? []).filter((name) =>
				/no-sandbox|in-process-gpu|disable-gpu|use-angle|use-gl|gpu/.test(name),
			);
			say(`probe: cmdline ${line.split(" :: ")[0]} gpu-relevant=[${switches.join(" ")}]`);
		}
	} catch (error) {
		say(`probe: could not read child command lines — ${error.message}`);
	}
	const window = shellWindow();
	if (window === null) {
		say("probe: no window was created");
		return;
	}
	say(`probe: window visible=${window.isVisible()} destroyed=${window.isDestroyed()}`);
	try {
		say(`probe: renderer pid ${window.webContents.getOSProcessId()}`);
		const page = await window.webContents.executeJavaScript(
			"({title: document.title, ready: document.readyState, body: (document.body?.innerText ?? '').slice(0, 120)})",
		);
		say(`probe: page ${JSON.stringify(page)}`);
	} catch (error) {
		say(`probe: the page could not be read — ${error.message}`);
	}
}

/**
 * The window gauntlet: what the page's own rendering costs, measured in the renderer.
 *
 * Three numbers, because "is it software composited" and "does the window keep up" are different
 * questions. `frame` is the interval between animation frames with a paint forced in each one — the
 * shape the client has while a turn streams — and the gaps over 33 ms are the visible stutter.
 * `feedback` is the wall-clock delay between typing into a textarea and the DOM's own answer, with
 * ten synthetic transitions running, which is what `disableHardwareAcceleration` makes most
 * expensive. Both are reported as a distribution rather than a mean, because a mean hides the stall
 * that a user actually notices.
 */
async function measure() {
	const window = shellWindow();
	if (window === null) {
		say("probe: nothing to measure, no window");
		return;
	}
	const gauntlet = `(() => {
		const raf = () => new Promise((done) => requestAnimationFrame(done));
		window.__probeStep = "start";
		return (async () => {
			// A paint in every frame, or there is no compositing to measure: the client's surfaces are
			// translucent and blurred, so a backdrop-filter read is the closest stand-in for its work.
			const box = document.createElement("div");
			box.style.cssText = "position:fixed;left:-40px;top:-40px;width:20px;height:20px;backdrop-filter:blur(2px);background:rgba(0,0,0,.01)";
			document.body.appendChild(box);
			const frame = [];
			window.__probeStep = "awaiting-first-frame";
			let previous = await raf();
			window.__probeStep = "frames";
			for (let i = 0; i < 120; i += 1) {
				box.style.transform = "translateX(" + i + "px)";
				getComputedStyle(box).backdropFilter;
				const now = await raf();
				frame.push(now - previous);
				previous = now;
			}

			// A real input path: a keystroke, then the DOM's own answer, while transitions run.
			window.__probeStep = "feedback";
			const field = document.createElement("textarea");
			field.style.cssText = "position:fixed;left:0;top:0;width:200px;height:40px";
			document.body.appendChild(field);
			for (let i = 0; i < 10; i += 1) {
				const chip = document.createElement("div");
				chip.style.cssText = "position:fixed;left:" + i * 30 + "px;bottom:0;width:24px;height:24px;transition:transform 300ms linear;background:rgba(0,0,0,.02)";
				document.body.appendChild(chip);
				chip.style.transform = "translateY(-8px)";
			}
			const latencies = [];
			for (let i = 0; i < 40; i += 1) {
				field.focus();
				const before = performance.now();
				document.execCommand("insertText", false, "x");
				field.value;
				await raf();
				latencies.push(performance.now() - before);
			}
			const stats = (samples) => {
				const sorted = [...samples].sort((a, b) => a - b);
				const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
				return {
					n: sorted.length,
					median: +at(0.5).toFixed(2),
					p95: +at(0.95).toFixed(2),
					max: +sorted[sorted.length - 1].toFixed(2),
					mean: +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2),
				};
			};
			box.remove();
			field.remove();
			window.__probeStep = "webgl";
			return {
				frame: stats(frame),
				over33: frame.filter((gap) => gap > 33).length,
				feedback: stats(latencies),
				webgl: (() => {
					const canvas = document.createElement("canvas");
					canvas.width = 64;
					canvas.height = 64;
					const gl = canvas.getContext("webgl");
					if (!gl) return "no-webgl";
					const info = gl.getExtension("WEBGL_debug_renderer_info");
					return {
						renderer: String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
						vendor: String(info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
					};
				})(),
			};
		})().then((value) => (window.__probe = value));
	})()`;

	try {
		await window.webContents.executeJavaScript(gauntlet);
	} catch (error) {
		say(`probe: measure script threw ${error.message}`);
		return;
	}
	for (let i = 0; i < 30; i += 1) {
		const ready = await window.webContents.executeJavaScript("!!window.__probe").catch(() => false);
		if (ready) break;
		await new Promise((done) => setTimeout(done, 1_000));
	}
	const result = await window.webContents
		.executeJavaScript("window.__probe ?? {stuckAt: window.__probeStep ?? '(no step)'}")
		.catch((error) => ({ error: error.message }));
	say(`probe: measure ${JSON.stringify(result)}`);
	const gpu = app.getAppMetrics().find((metric) => metric.type === "GPU");
	say(`probe: gpuChild ${gpu ? `pid ${gpu.pid} cpu ${JSON.stringify(gpu.cpu)}` : "none in app metrics"}`);
}

function finish() {
	say("probe: finished");
	setTimeout(() => app.exit(0), 300);
}

// A probe must never outlive its own evidence: if anything above hangs, the log says so and the
// process goes away rather than holding a window open for a human to close.
setTimeout(() => {
	say("probe: watchdog fired");
	app.exit(2);
}, Number(process.env.PROBE_TIMEOUT_MS ?? 90_000)).unref();
