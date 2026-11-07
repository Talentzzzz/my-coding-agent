// Throwaway: verify the disk↔memory translation round-trips "level chosen, model never chosen"
// and a fully-chosen session, without changing the .json shape on disk.
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-state-07-"));
const store = join(root, "--C--test--");
mkdirSync(store, { recursive: true });

// A v5 pair whose snapshot has thinkingLevel but no model row, as recordSelection can leave it.
const jsonl = [
	JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi", timestamp: 1 } }),
	JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }], model: "wire-id", stopReason: "stop", timestamp: 2 } }),
	JSON.stringify({ type: "leaf", id: "l1", parentId: "m2", timestamp: "2026-01-01T00:00:02.000Z", leafId: null }),
].join("\n");
const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const stamp = "2026-01-01T00-00-00-000Z";
const absJsonl = join(store, `${stamp}_${sessionId}.jsonl`);
const absJson = join(store, `${stamp}_${sessionId}.json`);
writeFileSync(absJsonl, jsonl);
const diskBefore = {
	version: 5,
	id: sessionId,
	timestamp: "2026-01-01T00:00:00.000Z",
	workDir: root,
	thinkingLevel: "high",
	title: "t",
	activeTools: ["bash"],
	approval: { bash: true },
};
writeFileSync(absJson, `${JSON.stringify(diskBefore, null, "\t")}\n`);

const { fillSession, createSession, inMemorySession } = await import("../../packages/core/src/session/session-manager.ts");
const { SessionManager } = await import("../../packages/core/src/session/session-manager.ts");

const s = fillSession(absJsonl);
const fails = [];
const check = (name, ok, detail) => { if (!ok) fails.push(`${name}: ${detail}`); };

// Memory shape: regrouped, level inside model.
check("sessionSetting regrouped", JSON.stringify(s.sessionSetting) === JSON.stringify({
	workDirAbsPath: root,
	title: "t",
	model: { thinkingLevel: "high" },
	activeTools: ["bash"],
	approval: { bash: true },
}), JSON.stringify(s.sessionSetting));
check("timestamp carried", s.timestamp === diskBefore.timestamp, s.timestamp);

// getMeta answers the flat disk shape (snapshot.ts and the smokes read it). Key order is the
// writer's canonical order, so compare order-insensitively.
const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());
const meta = new SessionManager().getMeta(s);
check("flat meta rebuilt", canonical(meta) === canonical(diskBefore), JSON.stringify(meta));

// Write path: a rewrite reproduces the disk shape byte-for-byte at the parsed level.
const { setThinkingLevel } = new SessionManager();
setThinkingLevel(s, "low");
check("level change merged in place", s.sessionSetting.model?.thinkingLevel === "low", JSON.stringify(s.sessionSetting.model));
const onDisk = JSON.parse(readFileSync(absJson, "utf8"));
check("disk holds level, still no model row", onDisk.thinkingLevel === "low" && onDisk.model === undefined, JSON.stringify({ model: onDisk.model, thinkingLevel: onDisk.thinkingLevel }));
check("disk identity untouched", onDisk.version === 5 && onDisk.id === sessionId && onDisk.workDir === root && onDisk.parentSession === undefined, JSON.stringify({ version: onDisk.version, id: onDisk.id }));

// A fork's parentSession round-trips through parentSessionId.
const forked = new SessionManager().forkFrom(absJsonl, root, null);
check("fork names its source", new SessionManager().getMeta(forked).parentSession === absJsonl, String(new SessionManager().getMeta(forked).parentSession));

// The constructors still birth a valid bag.
const fresh = createSession(root);
check("createSession carries the workDir", fresh.sessionSetting.workDirAbsPath !== "" && fresh.persist, JSON.stringify(fresh.sessionSetting));
const mem = inMemorySession(root);
check("inMemorySession stays unpersisted", mem.persist === false && mem.sessionDirAbsPath === null && mem.sessionFileAbsPath === undefined, JSON.stringify({ persist: mem.persist, dir: mem.sessionDirAbsPath }));

rmSync(root, { recursive: true, force: true });
if (fails.length > 0) {
	console.error("FAIL");
	for (const f of fails) console.error(`  ${f}`);
	process.exit(1);
}
console.log("level round-trip ok");
