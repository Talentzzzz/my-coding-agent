// Boot the server the way the desktop shell does — in-process, on an assigned port — and check what
// a shell depends on: the client is served, the API answers, the landing session is the one the
// server says it is, and closing actually releases the listener.
import { bootServer } from "../packages/server/src/boot.ts";

const server = await bootServer({ cwd: process.cwd(), port: 0 });
console.log(`booted on ${server.url} (port ${server.port})`);

const health = await fetch(`${server.url}/api/health`);
console.log(`health ${health.status} ${await health.text()}`);

const index = await fetch(server.url);
const html = await index.text();
console.log(`index ${index.status} ${index.headers.get("content-type")} ${html.length} bytes, has #app: ${html.includes('id="app"')}`);

const models = await fetch(`${server.url}/api/models`);
const body = (await models.json()) as { models?: unknown[] };
console.log(`models ${models.status} count=${body.models?.length ?? 0}`);

// The landing session is the server's decision, not the client's: the pinned session must be the one
// the stream serves, which is what makes `--session` (and MY_AGENT_SESSION) visible in the UI.
const landing = await fetch(`${server.url}/api/sessions/current`);
const { sessionId } = (await landing.json()) as { sessionId: string };
const hubId = await server.hub.currentSessionId();
console.log(`current ${landing.status} sessionId=${sessionId} hub=${hubId} agrees=${sessionId === hubId}`);

const controller = new AbortController();
const stream = await fetch(`${server.url}/api/sessions/${encodeURIComponent(sessionId)}/events`, { signal: controller.signal });
const reader = stream.body!.getReader();
const chunk = await reader.read();
const first = new TextDecoder().decode(chunk.value ?? new Uint8Array());
controller.abort();
const line = first.split("\n").find((entry) => entry.startsWith("data: ")) ?? "";
const frame = JSON.parse(line.slice(6)) as { type?: string; session?: { id?: string; title?: string } };
console.log(`first frame: ${frame.type} id=${frame.session?.id} title=${JSON.stringify(frame.session?.title)}`);
console.log(`stream serves the landing session: ${frame.session?.id === sessionId}`);

await server.close();
console.log("closed");

// A closed listener must refuse connections, or a shell would leak a server every time it restarts.
try {
	await fetch(server.url);
	console.log("FAIL: still answering after close");
	process.exitCode = 1;
} catch {
	console.log("ok: refuses connections after close");
}
