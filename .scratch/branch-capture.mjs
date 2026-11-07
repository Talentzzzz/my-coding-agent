// Run the real app (server + client, from source via Vite) and photograph its branch page.
//
//   node .scratch/branch-capture.mjs
//
// The session is copied into a throwaway agent home, so this reads the real transcript and never
// writes to the real one.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchChromium, openPage } from "../scripts/cdp.ts";

const repo = resolve(process.cwd());
const SOURCE_HOME = join(process.env.USERPROFILE ?? "", ".my-agent");
const WORKSPACE = "--C--Users-a1368-Desktop-my-coding-agent--";
const SESSION = "2026-10-26T15-09-37-746Z_01a178c2-8a52-77bd-b59c-c33a1fea4ed6.jsonl";
const SESSION_ID = "01a178c2-8a52-77bd-b59c-c33a1fea4ed6";
const OUT = join(repo, ".scratch");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const home = mkdtempSync(join(tmpdir(), "mca-branch-home-"));
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
// `--vite`: the client is served from source, so this is the code in the working tree, not a build.
const server = spawn(
	process.execPath,
	["packages/server/src/main.ts", "--port", String(port), "--cwd", repo, "--session", SESSION_ID, "--vite"],
	{ cwd: repo, env: { ...process.env, MY_AGENT_HOME: home }, stdio: "inherit" },
);

let browser;
try {
	const deadline = Date.now() + 40_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${base}/api/health`)).ok) break;
		} catch {}
		await sleep(150);
	}

	browser = await launchChromium({ width: 1280, height: 820 });
	const page = await openPage(browser.port, base, { width: 1280, height: 820, scale: 2 });
	await page.waitFor('document.querySelectorAll(".turn").length > 0', 30_000);
	await sleep(800);

	console.log("header :", await page.evaluate('document.querySelector(".header-title h1")?.textContent ?? ""'));
	console.log("chip   :", await page.evaluate('document.querySelector(".branch-chip")?.textContent ?? ""'));
	console.log("turns  :", await page.evaluate('document.querySelectorAll(".turn").length'));

	await page.click(".branch-chip");
	await sleep(1500);

	const dump = await page.evaluate(`(() => {
		const box = (node) => { const r = node.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
		return {
			pane: document.body.dataset.pane,
			tools: document.querySelector(".branch-tools")?.textContent ?? "",
			zoom: document.querySelector(".zoom-value")?.textContent ?? "",
			edges: document.querySelectorAll(".graph-svg path").length,
			dots: document.querySelectorAll(".graph-svg circle").length,
			cards: [...document.querySelectorAll(".gnode")].map((card) => ({
				id: card.dataset.id,
				label: card.querySelector(".lbl")?.textContent ?? "",
				meta: card.querySelector(".meta")?.textContent ?? "",
				flags: Object.keys(card.dataset),
				box: box(card),
			})),
		};
	})()`);
	console.log(JSON.stringify(dump, null, 2));
	await page.screenshot(join(OUT, "branch-real.png"));

	// One press: the page only selects, and the header's button changes what it offers to do.
	const branchId = await page.evaluate(
		`(() => { const card = [...document.querySelectorAll(".gnode")].find((node) => !("current" in node.dataset)); return card ? card.dataset.id : null; })()`,
	);
	if (branchId !== null && branchId !== undefined) {
		await page.press(`.gnode[data-id="${branchId}"]`);
		await sleep(500);
		console.log("selected:", branchId);
		console.log("button  :", await page.evaluate('document.querySelector(".back-button")?.textContent ?? ""'));
		await page.screenshot(join(OUT, "branch-real-selected.png"));
	}
} finally {
	if (browser !== undefined) await browser.close();
	server.kill();
}
