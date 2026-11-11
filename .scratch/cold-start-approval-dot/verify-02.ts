// Ticket 02 acceptance check: the read side — a cold row's `pending` derives from the snapshot marker.
// Run: node .scratch/cold-start-approval-dot/verify-02.ts
// The write side (marker field, translation, write points) was ticket 01's; this script only reads
// rows — through a brand-new projection (cold seed, no host), a single-session probe, and the live
// overlay a held session gets. The rename closure is checked without touching projection code.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionManager,
	setSessionsDir,
	SettingManager,
	type ModelConfig,
	type SessionMeta,
	type SessionRow,
} from "@my-agent/core";
import { SessionHub } from "../../packages/server/src/hub.ts";
import { createSessionProjection } from "../../packages/server/src/projection.ts";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall } from "../../scripts/fake-transport.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
	process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` ${detail}`}\n`);
	if (!ok) failures += 1;
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(ready: () => boolean, ms = 5_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (ready()) return true;
		await sleep(10);
	}
	return ready();
}
/** Settle the microtask queue plus one macrotask, so a resolved probe has landed. */
const settle = (): Promise<void> => sleep(20);
const watchdog = setTimeout(() => {
	process.stdout.write("\nFAIL verify-02 did not settle within 60 s\n");
	process.exit(1);
}, 60_000);

const rows: ModelConfig[] = [
	{
		name: "anthropic",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "unused-by-the-scripted-transport",
		id: "claude-sonnet-4-5",
		contextWindow: 200_000,
		maxTokens: 8_192,
	},
];
const promptOptions = { selection: { model: "anthropic", thinkingLevel: "off" } } as const;

const root = await mkdtemp(join(tmpdir(), "verify-02-root-"));
const store = await mkdtemp(join(tmpdir(), "verify-02-store-"));
const home = await mkdtemp(join(tmpdir(), "verify-02-home-"));
setSessionsDir(store);
await writeFile(join(root, "notes.txt"), "the notes\n");
const seeder = new SettingManager({ home, modelsHome: home });
seeder.applySettings(root, { approval: { read: true } });
seeder.replaceModels(rows);
const fake = createFakeTransport();
const hubOptions = { workDirAbsPath: root, settingsHome: home, modelsHome: home, api: fake.api };

function metaPathOf(id: string): string {
	const jsonl = SessionManager.findSessionFilePathById(id);
	if (jsonl === undefined) throw new Error(`no file for ${id}`);
	return jsonl.replace(/\.jsonl$/, ".json");
}
async function readMeta(id: string): Promise<SessionMeta> {
	return JSON.parse(await readFile(metaPathOf(id), "utf8")) as SessionMeta;
}
async function writeMeta(id: string, meta: SessionMeta): Promise<void> {
	await writeFile(metaPathOf(id), `${JSON.stringify(meta, null, "\t")}\n`, "utf8");
}
function rowOf(all: readonly SessionRow[], id: string): SessionRow | undefined {
	return all.find((row) => row.id === id);
}

// The writer process: two parked sessions and one finished session, then it lets go of everything.
const writer = new SessionHub(hubOptions);
async function park(hub: SessionHub): Promise<string> {
	fake.setResponses([
		fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
		fakeAssistantMessage("done"),
	]);
	const id = await hub.newSession();
	const host = await hub.hold(id);
	await hub.agent.prompt(id, "read the notes", promptOptions);
	const parked = hub.agent.snapshot(id).pendingApprovals.length === 1 && !hub.agent.isSubmitting(id);
	hub.release(host);
	await until(() => !hub.live.includes(id));
	if (!parked) throw new Error("the session did not park, so the rest cannot run");
	return id;
}
const parkedId = await park(writer);
const strippedId = await park(writer);
const finishedId = await writer.newSession();
{
	const host = await writer.hold(finishedId);
	fake.setResponses([fakeAssistantMessage("all done")]);
	await writer.agent.prompt(finishedId, "a plain turn", promptOptions);
	writer.release(host);
	await until(() => !writer.live.includes(finishedId));
}
await writer.close();

// The reader process: a fresh hub over the same store, so every projection below seeds cold.
const reader = new SessionHub(hubOptions);
try {
	// A. Cold seed: a parked session's row lights up with no host anywhere.
	process.stdout.write("\nA. cold seed (no host): parked row pending 1, finished row pending 0\n");
	const cold = createSessionProjection(reader);
	const seeded = await cold.rows();
	const parkedRow = rowOf(seeded, parkedId);
	check("the parked session has a row", parkedRow !== undefined);
	check("pending === 1 from the marker", parkedRow?.pending === 1, JSON.stringify(parkedRow));
	check("running === false (a process fact, still)", parkedRow?.running === false, JSON.stringify(parkedRow));
	check("the finished session's row stays pending 0", rowOf(seeded, finishedId)?.pending === 0, JSON.stringify(rowOf(seeded, finishedId)));
	const probed = await SessionManager.findSessionRowById(parkedId);
	check("a single-session probe agrees (shared toSessionRow)", probed?.pending === 1 && probed.running === false, JSON.stringify(probed));
	cold.close();

	// B. An old snapshot without the field reads as pending 0, even with a dangling call in the ledger.
	process.stdout.write("\nB. snapshot without the field: pending 0\n");
	const meta = await readMeta(strippedId);
	check("precondition: the marker is there to strip", meta.suspended === true);
	delete meta.suspended;
	await writeMeta(strippedId, meta);
	const strippedProbe = await SessionManager.findSessionRowById(strippedId);
	check("probe of the stripped snapshot is pending 0", strippedProbe?.pending === 0, JSON.stringify(strippedProbe));
	const coldOld = createSessionProjection(reader);
	const oldSeed = await coldOld.rows();
	check("cold seed of the stripped snapshot is pending 0", rowOf(oldSeed, strippedId)?.pending === 0);
	check("while the marked one still lights up", rowOf(oldSeed, parkedId)?.pending === 1);
	coldOld.close();

	// C. The live overlay settles from the ledger when the host dies (the in-process fix, not regressed).
	process.stdout.write("\nC. host alive, then reaped: the row keeps the ledger's pending\n");
	const live = createSessionProjection(reader);
	const host = await reader.hold(parkedId);
	await settle();
	const heldRow = await live.row(parkedId);
	check("a held parked session's row is pending 1", heldRow?.pending === 1, JSON.stringify(heldRow));
	reader.release(host);
	await until(() => !reader.live.includes(parkedId));
	await settle();
	const reaped = await live.row(parkedId);
	check("after the reap the row is still pending 1", reaped?.pending === 1, JSON.stringify(reaped));
	check("and running false", reaped?.running === false, JSON.stringify(reaped));

	// D. A stale marker never reaches a live row: the overlay is the ledger, not the cache.
	process.stdout.write("\nD. stale marker on a session with no question: live row stays pending 0\n");
	const finishedMeta = await readMeta(finishedId);
	finishedMeta.suspended = true;
	await writeMeta(finishedId, finishedMeta);
	check("a cold probe reads the stale marker as pending 1", (await SessionManager.findSessionRowById(finishedId))?.pending === 1);
	const finishedHost = await reader.hold(finishedId);
	await settle();
	check("the live row overlays the ledger's 0", (await live.row(finishedId))?.pending === 0, JSON.stringify(await live.row(finishedId)));
	fake.setResponses([fakeAssistantMessage("another plain turn")]);
	await reader.agent.prompt(finishedId, "still no question", promptOptions);
	await settle();
	const afterRun = await live.row(finishedId);
	check("a run keeps the live row at pending 0", afterRun?.pending === 0 && afterRun.running === false, JSON.stringify(afterRun));
	reader.release(finishedHost);
	await until(() => !reader.live.includes(finishedId));

	// E. The rename closure: refresh on a host-less parked session republishes the probe row, marker included.
	process.stdout.write("\nE. rename a parked session with no host: the row keeps pending 1\n");
	await reader.rename(parkedId, "parked and renamed");
	await live.refresh(parkedId);
	const renamed = await live.row(parkedId);
	check("the rename reached the row", renamed?.title === "parked and renamed", JSON.stringify(renamed));
	check("and the dot stayed lit", renamed?.pending === 1, JSON.stringify(renamed));
	live.close();
} finally {
	clearTimeout(watchdog);
	await reader.close();
	await rm(root, { recursive: true, force: true });
	await rm(store, { recursive: true, force: true }).catch(() => {});
	await rm(home, { recursive: true, force: true }).catch(() => {});
}

process.stdout.write(failures === 0 ? "\nverify-02 ok\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;