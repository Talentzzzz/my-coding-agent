// Print the three branch-graph fields exactly as the running server hands them to the client.
//
//   node .scratch/snapshot-dump.mjs
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(process.cwd());
const SOURCE_HOME = join(process.env.USERPROFILE ?? "", ".my-agent");
const WORKSPACE = "--C--Users-a1368-Desktop-my-coding-agent--";
const SESSION = "2026-10-26T15-09-37-746Z_01a178c2-8a52-77bd-b59c-c33a1fea4ed6.jsonl";
const SESSION_ID = "01a178c2-8a52-77bd-b59c-c33a1fea4ed6";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const home = mkdtempSync(join(tmpdir(), "mca-dump-home-"));
mkdirSync(join(home, "sessions", WORKSPACE), { recursive: true });
// Freeze the copy at the state the screenshot was taken from: the file is append-only, so the first
// N lines are exactly the transcript as it stood then.
const LIMIT = Number(process.env.LINES ?? 0);
const source = readFileSync(join(SOURCE_HOME, "sessions", WORKSPACE, SESSION), "utf8").split("\n");
const kept = (LIMIT > 0 ? source.slice(0, LIMIT) : source).join("\n");
writeFileSync(join(home, "sessions", WORKSPACE, SESSION), kept);
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

try {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${base}/api/health`)).ok) break;
		} catch {}
		await sleep(120);
	}
	const { session } = await fetch(`${base}/api/sessions/${SESSION_ID}`).then((r) => r.json());

	const text = (message) => {
		const content = message.content;
		const parts = typeof content === "string" ? [content] : (content ?? []).map((block) => block.text ?? "");
		const flat = parts.join(" ").replace(/\s+/g, " ").trim();
		return flat.length > 34 ? `${flat.slice(0, 34)}…` : flat;
	};

	console.log("leafId:", session.leafId);
	console.log("\nmessages: [");
	for (const message of session.messages) console.log(`  { role: "${message.role}", text: "${text(message)}" },`);
	console.log("]");
	console.log("\nmessageEntryIds:", JSON.stringify(session.messageEntryIds));
	console.log("\nbranchPoints:", JSON.stringify(session.branchPoints, null, 2));
} finally {
	server.kill();
}
