// Throwaway: verify the level-only selection change reaches the disk (ticket 08 regression fix).
//
// The regression: `applyModelSelection` writes the choice into the in-memory bag, and
// `recordSelection` compared against that same bag — self-comparison, so a level-only move never
// rewrote the `.json` and a reopen came back at the old level. The fix reads the write baseline
// from the snapshot on disk (`recordedOnDisk`) and flushes the bag when the setters' gates see
// nothing to do. This script drives a real agent over a scripted transport and follows one
// selection all the way to the file and back:
//
//   prompt at high → disk says high → level-only move to max (disk unchanged) → prompt →
//   disk says max → fillSession reads max back. Then: a run of turns on one selection costs no
//   rewrite, and a rename records the row whole.
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-state-08-"));

const watchdog = setTimeout(() => {
	console.error("FAIL the script did not settle within 60 s");
	process.exit(1);
}, 60_000);

const { createFakeTransport, fakeAssistantMessage } = await import("../../scripts/fake-transport.ts");
const { openAgent, createSession, fillSession, inMemorySettingsState, SessionManager } = await import(
	"../../packages/core/src/index.ts"
);

const fails = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
	if (!ok) fails.push(name);
};

// Two rows, so the rename half has somewhere to go. No default is named, so the seed falls to
// rows[0] ("faux") — the session opens on it with no level.
const ROW1 = {
	name: "faux",
	baseUrl: "http://127.0.0.1:1/v1",
	apiKey: "unused-by-the-scripted-transport",
	id: "faux-1",
	contextWindow: 128_000,
	maxTokens: 16_384,
};
const ROW2 = { ...ROW1, name: "faux2", id: "faux-2" };
const models = { list: () => [ROW1, ROW2] };

const scripted = createFakeTransport();
scripted.setResponses([
	fakeAssistantMessage("one"),
	fakeAssistantMessage("two"),
	fakeAssistantMessage("three"),
	fakeAssistantMessage("four"),
]);

const bag = createSession(root);
const session = await openAgent({
	workDirAbsPath: root,
	session: bag,
	models,
	api: scripted.api,
	settingsState: inMemorySettingsState({}),
});

const id = bag.sessionId;
const absJson = bag.sessionFileAbsPath.replace(/\.jsonl$/, ".json");
const disk = () => JSON.parse(readFileSync(absJson, "utf8"));

// Move 1: prompt at high. The files are born with the first message, and the snapshot carries the
// row the turn was answered by plus the level it was asked at.
await session.prompt(id, "hello", { selection: { thinkingLevel: "high" } });
check("files born with the first prompt", bag.fileCreated === true, String(bag.fileCreated));
check(
	"disk records the row and high",
	JSON.stringify(disk().model) === JSON.stringify({ name: "faux", modelId: "faux-1" }) && disk().thinkingLevel === "high",
	JSON.stringify({ model: disk().model, thinkingLevel: disk().thinkingLevel }),
);

// The level-only move: in memory at once, on disk only once a request is made with it.
session.applyModelSelection(id, { thinkingLevel: "max" });
check(
	"the move alone leaves the disk at high",
	disk().thinkingLevel === "high",
	String(disk().thinkingLevel),
);

// Move 2: the same row, the new level. The disk baseline (high) differs from what is in force
// (max) while the bag already carries max — the setters no-op and the flush is what writes.
await session.prompt(id, "again");
check(
	"disk holds max after the level-only prompt",
	disk().thinkingLevel === "max" && disk().model?.name === "faux",
	JSON.stringify({ model: disk().model, thinkingLevel: disk().thinkingLevel }),
);

// The round-trip the regression broke: a reopen reads the level the file now holds.
const replayed = fillSession(bag.sessionFileAbsPath);
const recorded = new SessionManager().getRecordedSettings(replayed);
check(
	"fillSession reads max back",
	recorded.thinkingLevel === "max" && recorded.model?.name === "faux",
	JSON.stringify(recorded),
);

// A run of turns on one selection costs one write: another prompt at the same level rewrites
// nothing — the content is identical and the snapshot's mtime does not move.
const before = { text: readFileSync(absJson, "utf8"), mtimeMs: statSync(absJson).mtimeMs };
await session.prompt(id, "third");
const after = { text: readFileSync(absJson, "utf8"), mtimeMs: statSync(absJson).mtimeMs };
check(
	"a turn on the same selection rewrites nothing",
	before.text === after.text && before.mtimeMs === after.mtimeMs,
	JSON.stringify({ sameText: before.text === after.text, before: before.mtimeMs, after: after.mtimeMs }),
);

// The rename half still records the row whole: name and wire id land together with the level.
session.applyModelSelection(id, { model: "faux2", thinkingLevel: "low" });
await session.prompt(id, "fourth");
check(
	"the rename records the row and the level",
	JSON.stringify(disk().model) === JSON.stringify({ name: "faux2", modelId: "faux-2" }) && disk().thinkingLevel === "low",
	JSON.stringify({ model: disk().model, thinkingLevel: disk().thinkingLevel }),
);

rmSync(root, { recursive: true, force: true });
clearTimeout(watchdog);
if (fails.length > 0) {
	console.error("FAIL");
	process.exit(1);
}
console.log("record-selection disk round-trip ok");
