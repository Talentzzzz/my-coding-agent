// Ticket 01 acceptance check: the snapshot's `suspended` marker — field, translation, write points.
// Run: node .scratch/cold-start-approval-dot/verify-01.ts
// The read side (row `pending`) belongs to ticket 02; this script reads only the `.json` and the bag.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSessionAgent,
	fillSession,
	setSessionsDir,
	SessionManager,
	SettingManager,
	type ModelConfig,
	type Session,
	type SessionMeta,
} from "@my-agent/core";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall } from "../../scripts/fake-transport.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
	process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` ${detail}`}\n`);
	if (!ok) failures += 1;
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => {
	process.stdout.write("\nFAIL verify-01 did not settle within 60 s\n");
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

const root = await mkdtemp(join(tmpdir(), "verify-01-root-"));
const store = await mkdtemp(join(tmpdir(), "verify-01-store-"));
const home = await mkdtemp(join(tmpdir(), "verify-01-home-"));
setSessionsDir(store);
await writeFile(join(root, "notes.txt"), "the notes\n");
const seeder = new SettingManager({ home, modelsHome: home });
seeder.applySettings(root, { approval: { read: true } });
seeder.replaceModels(rows);
const fake = createFakeTransport();
const agent = createSessionAgent({ settingsHome: home, modelsHome: home, api: fake.api });

function metaPathOf(jsonl: string): string {
	return jsonl.endsWith(".json") ? jsonl : jsonl.replace(/\.jsonl$/, ".json");
}
async function readMeta(jsonl: string): Promise<SessionMeta> {
	return JSON.parse(await readFile(metaPathOf(jsonl), "utf8")) as SessionMeta;
}
function suspendedOf(bag: Session): boolean | undefined {
	return (bag.sessionSetting as { suspended?: boolean }).suspended;
}

/** One fresh session driven to the gate; `prompt` awaits the run, so it returns parked. */
async function parkFresh(): Promise<{ id: string; jsonl: string; toolCallId: string }> {
	fake.setResponses([
		fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
		fakeAssistantMessage("done"),
	]);
	const id = await agent.create(root);
	await agent.hold(id);
	await agent.prompt(id, "read the notes", { selection: { model: "anthropic", thinkingLevel: "off" } });
	const snapshot = await agent.snapshotOf(id);
	const call = snapshot.pendingApprovals[0];
	const jsonl = agent.fileAbsPathOf(id);
	check("a fresh session parks at the gate", call !== undefined && !agent.isSubmitting(id), JSON.stringify(snapshot.pendingApprovals));
	if (call === undefined || jsonl === undefined) throw new Error("the session did not park, so the rest cannot run");
	return { id, jsonl, toolCallId: call.toolCallId };
}

try {
	// A. Park writes true; the answer + recovery run clears it.
	process.stdout.write("\nA. park -> suspended: true; answer + recovery -> field gone\n");
	const a = await parkFresh();
	const parkedMeta = await readMeta(a.jsonl);
	check("parked .json carries suspended: true", parkedMeta.suspended === true, JSON.stringify(parkedMeta));
	check("fillSession reads suspended true", suspendedOf(fillSession(a.jsonl)) === true);
	await agent.respondApproval(a.id, a.toolCallId, true);
	const recoveredMeta = await readMeta(a.jsonl);
	check("after answer + recovery the field is gone", !("suspended" in recoveredMeta), JSON.stringify(recoveredMeta));
	check("fillSession reads suspended false", suspendedOf(fillSession(a.jsonl)) === false);
	check("the recovery run finished", !agent.isSubmitting(a.id));

	// B. Park, then abort: the abandonment sweep clears the marker without a run.
	process.stdout.write("\nB. park -> abort -> field gone\n");
	const b = await parkFresh();
	check("parked .json carries suspended: true", (await readMeta(b.jsonl)).suspended === true);
	await agent.abort(b.id);
	const abortedMeta = await readMeta(b.jsonl);
	check("after abort the field is gone", !("suspended" in abortedMeta), JSON.stringify(abortedMeta));
	check("no question is left pending", !(await agent.snapshotOf(b.id)).pendingApprovals.length);

	// C. Fork of a parked session inherits the marker; the source keeps its own.
	process.stdout.write("\nC. fork of a parked session carries the marker\n");
	const c = await parkFresh();
	const forkId = agent.forkFrom(c.id, null);
	const forkJsonl = SessionManager.findSessionFilePathById(forkId);
	if (forkJsonl === undefined) throw new Error("the fork was not written");
	check("the fork's .json carries suspended: true", (await readMeta(forkJsonl)).suspended === true);
	check("the source keeps its marker", (await readMeta(c.jsonl)).suspended === true);
	check("the fork's bag reads suspended true", suspendedOf(fillSession(forkJsonl)) === true);

	// D. An old snapshot with no field fills as false, without error or migration.
	process.stdout.write("\nD. old snapshot without the field\n");
	check("precondition: the recovered snapshot has no field", !("suspended" in recoveredMeta));
	const oldBag = fillSession(a.jsonl);
	check("fillSession reads suspended false", suspendedOf(oldBag) === false);
	check("the version did not move", oldBag.sessionId === a.id && (await readMeta(a.jsonl)).version === 5);

	// E. setSuspended: only a flip pays a rewrite.
	process.stdout.write("\nE. setSuspended no-op on same value\n");
	const manager = new SessionManager();
	const setter = (manager as unknown as { setSuspended?: (bag: Session, suspended: boolean) => void }).setSuspended;
	check("SessionManager.setSuspended exists", typeof setter === "function");
	if (typeof setter === "function") {
		const bag = fillSession(c.jsonl);
		const path = metaPathOf(c.jsonl);
		const before = (await stat(path)).mtimeMs;
		await sleep(40);
		setter.call(manager, bag, true);
		check("same-value write does not rewrite the snapshot", (await stat(path)).mtimeMs === before);
		setter.call(manager, bag, false);
		const flipped = (await stat(path)).mtimeMs;
		check("a flip rewrites and drops the field", flipped !== before && !("suspended" in await readMeta(c.jsonl)));
		await sleep(40);
		setter.call(manager, bag, false);
		check("same-value write does not rewrite again", (await stat(path)).mtimeMs === flipped);
	}

	agent.release(a.id);
	agent.release(b.id);
	agent.release(c.id);
} finally {
	clearTimeout(watchdog);
	await rm(root, { recursive: true, force: true });
	await rm(store, { recursive: true, force: true }).catch(() => {});
	await rm(home, { recursive: true, force: true }).catch(() => {});
}

process.stdout.write(failures === 0 ? "\nverify-01 ok\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;