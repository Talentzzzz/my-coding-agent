// Repro: a session whose leaf sits on its first user message (one card on the line).
// Copies the session into a temp agent home, starts the server, opens the branch page and dumps
// what the canvas actually holds.
//
//   node .scratch/inspect-single.mjs
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchChromium, openPage } from "../scripts/cdp.ts";

const repo = resolve(process.cwd());
const SOURCE_HOME = join(process.env.USERPROFILE ?? "", ".my-agent");
const WORKSPACE = "--C--Users-a1368-Desktop-my-coding-agent--";
const SESSION = "2026-10-18T13-21-59-086Z_01a14f2d-1d25-7118-8613-be38c23a579c.jsonl";
const SESSION_ID = "01a14f2d-1d25-7118-8613-be38c23a579c";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const home = mkdtempSync(join(tmpdir(), "mca-inspect-home-"));
mkdirSync(join(home, "sessions", WORKSPACE), { recursive: true });
copyFileSync(join(SOURCE_HOME, "sessions", WORKSPACE, SESSION), join(home, "sessions", WORKSPACE, SESSION));
for (const file of ["settings.json", "models.json"]) {
	const from = join(SOURCE_HOME, file);
	if (existsSync(from)) copyFileSync(from, join(home, file));
}

const port = await new Promise((done, fail) => {
	const probe = createServer();
	probe.once("error", fail);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		probe.close(() => done(address.port));
	});
});
const base = `http://127.0.0.1:${port}`;
const server = spawn(
	process.execPath,
	["packages/server/src/main.ts", "--port", String(port), "--cwd", repo, "--session", SESSION_ID],
	{ cwd: repo, env: { ...process.env, MY_AGENT_HOME: home }, stdio: "ignore" },
);

let browser;
try {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${base}/api/health`)).ok) break;
		} catch {}
		await sleep(100);
	}
	browser = await launchChromium({ width: 1280, height: 820 });
	const page = await openPage(browser.port, base, { width: 1280, height: 820 });
	await page.waitFor('document.querySelectorAll(".turn").length > 0', 20_000);
	await sleep(500);
	console.log("turns:", await page.evaluate('document.querySelectorAll(".turn").length'));
	console.log("chip:", await page.evaluate('document.querySelector(".branch-chip")?.textContent ?? ""'));
	await page.click(".branch-chip");
	await sleep(900);
	const dump = await page.evaluate(`(() => {
		const viewport = document.querySelector(".graph-viewport");
		const layer = document.querySelector(".graph-zoom");
		const svg = document.querySelector(".graph-svg");
		const box = (node) => { if (node === null) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
		return {
			pane: document.body.dataset.pane,
			viewport: box(viewport),
			layer: box(layer),
			layerTransform: layer === null ? "" : layer.style.transform,
			svg: box(svg),
			cards: [...document.querySelectorAll(".gnode")].map((card) => ({
				id: card.dataset.id,
				label: card.querySelector(".lbl")?.textContent ?? "",
				box: box(card),
				style: { left: card.style.left, top: card.style.top, width: card.style.width, height: card.style.height },
			})),
			summary: document.querySelector(".branch-sum")?.textContent ?? "",
			zoom: document.querySelector(".zoom-value")?.textContent ?? "",
		};
	})()`);
	console.log(JSON.stringify(dump, null, 2));
	await page.screenshot(join(repo, ".scratch", "inspect-single.png"));
} finally {
	if (browser !== undefined) await browser.close();
	server.kill();
}
