// Throwaway probe: does the server, told to use the fake endpoint, actually reach it? Starts the
// fake provider and a real server, posts one prompt through REST, and prints what came back.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFakeAnthropic } from "./fake-anthropic.mjs";

const repo = resolve(process.cwd());
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const freePort = () =>
	new Promise((done) => {
		const probe = createServer();
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => done(port));
		});
	});

const provider = await startFakeAnthropic([{ text: "假端点的回答。".repeat(20), chunkChars: 4, everyMs: 5 }]);
const home = mkdtempSync(join(tmpdir(), "mca-probe-"));
mkdirSync(join(home, "sessions"), { recursive: true });
writeFileSync(
	join(home, "models.json"),
	`${JSON.stringify({
		models: [
			{
				name: "bench",
				baseUrl: provider.url,
				apiKey: "bench-key-not-a-secret",
				modelId: "bench",
				contextWindow: 200_000,
				maxTokens: 8_192,
				reasoning: false,
			},
		],
	})}\n`,
);

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(
	process.execPath,
	["packages/server/src/main.ts", "--port", String(port), "--cwd", repo, "--model", "bench/bench"],
	{ cwd: repo, env: { ...process.env, MY_AGENT_HOME: home }, stdio: "inherit" },
);

try {
	for (let tries = 0; tries < 100; tries += 1) {
		try {
			if ((await fetch(`${base}/api/health`)).ok) break;
		} catch {}
		await sleep(100);
	}
	const { sessionId } = await (await fetch(`${base}/api/sessions/current`)).json();
	console.log("session", sessionId);
	const posted = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "你好" }),
	});
	console.log("post", posted.status, await posted.text());
	await sleep(4000);
	const snapshot = await (await fetch(`${base}/api/sessions/${sessionId}`)).json();
	console.log("snapshot keys", Object.keys(snapshot));
	console.log("messages", JSON.stringify(snapshot.session?.messages)?.slice(0, 800));
} finally {
	server.kill();
	await provider.close();
	rmSync(home, { recursive: true, force: true });
}
