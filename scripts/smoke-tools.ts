// Tool-level smoke test: exercises the six tools against a temporary fixture directory.
// Run with: node scripts/smoke-tools.ts
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ARG_TRIM_MARKER,
	BRANCH_LABEL_MAX,
	clearableToolResultIds,
	clearedToolResultText,
	clearToolResult,
	compactionThresholdFor,
	CURRENT_SESSION_VERSION,
	appendCompaction,
	appendMessage,
	appendModelChange,
	appendTrimToolCallArgs,
	branch,
	buildContextEntries,
	buildSessionContext,
	createSessionState,
	createToolRegistry,
	createTools,
	deriveTitle,
	DIFF_MAX_ROWS,
	DIFF_TEXT_MAX_ROWS,
	diffText,
	estimateTokens,
	fillSession,
	getAbsSessionFile,
	getBranchPoints,
	getBranchTip,
	getEntry,
	getEntries,
	getHeader,
	getLeafId,
	getRecordedSettings,
	getRecordedToolConfig,
	getSessionId,
	getTitle,
	inMemorySessionState,
	fileDiff,
	isCacheProbablyExpired,
	prepareCompaction,
	PROJECT_DIR_NAME,
	resolvePath,
	sessionEntryToContextMessages,
	SessionManager,
	sessionPath,
	sessionsDir,
	SettingsManager,
	shouldCompact,
	spillOversizedToolResult,
	spillPathFor,
	trimmableToolArgEntryIds,
	Workspace,
	toolDefinitions,
	fillTools,
	openAgent,
	workspaceDir,
	type FileDiff,
	type ModelConfig,
	type SessionEntry,
	compactionSummaryOf,
} from "@my-agent/core";
import type { AgentTool } from "@my-agent/loop";
import type { Message } from "@my-agent/llm";

const root = await mkdtemp(join(tmpdir(), "my-agent-tools-"));
let failures = 0;

/**
 * Run a promise with a deadline that records a failure when it is exceeded.
 *
 * `ok: false` means the timeout fired, which is why callers assert on `ok` rather than on the value:
 * a `void` promise resolving to `undefined` would otherwise look identical to a timeout.
 */
async function within<T>(label: string, ms: number, work: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<{ ok: false }>((resolve) => {
		timer = setTimeout(() => {
			check(`${label} settles`, false, `still pending after ${ms} ms`);
			resolve({ ok: false });
		}, ms);
	});
	try {
		const value = await Promise.race([work.then((value) => ({ ok: true as const, value })), timeout]);
		return value;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

function tool(name: string): AgentTool<any> {
	const found = createTools({ workspace: new Workspace(root) }).find((candidate) => candidate.name === name);
	if (!found) throw new Error(`no tool named ${name}`);
	return found;
}

async function call(name: string, args: unknown): Promise<{ text: string; details?: unknown; error?: string }> {
	try {
		const result = await tool(name).execute("test", args, undefined, undefined);
		const text = result.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("");
		return { text, details: result.details };
	} catch (error) {
		return { text: "", error: error instanceof Error ? error.message : String(error) };
	}
}

/** The diff a tool result carries, so an assertion can say what it found rather than only that it failed. */
function diffOf(details: unknown): FileDiff | undefined {
	return (details as { diff?: FileDiff } | undefined)?.diff;
}

try {
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "app.ts"), "const first = 1;\nconst second = 2;\nconst third = 3;\n", "utf8");
	await writeFile(join(root, "src", "other.ts"), "export const value = 42;\n", "utf8");
	await writeFile(join(root, "crlf.txt"), "alpha\r\nbeta\r\ngamma\r\n", "utf8");
	await writeFile(join(root, "notes.md"), "# Notes\n\nvalue appears twice: value and value\n", "utf8");

	process.stdout.write("read\n");
	const numbered = await call("read", { path: "src/app.ts" });
	check("returns numbered lines", numbered.text.includes("1\u2192const first = 1;"), numbered.text);
	const limited = await call("read", { path: "src/app.ts", offset: 2, limit: 1 });
	check("honours offset and limit", limited.text.includes("2\u2192const second = 2;") && !limited.text.includes("third"));
	const missing = await call("read", { path: "nope.ts" });
	check("missing file throws", missing.error?.includes("File not found") === true, missing.error);

	// An image file is answered with the image itself: signature-sniffed, base64 on the wire, intact.
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	);
	await writeFile(join(root, "dot.png"), png);
	const image = await tool("read").execute("test", { path: "dot.png" }, undefined, undefined);
	const second = image.content[1];
	const isPng = second?.type === "image" && second.mimeType === "image/png" && Buffer.from(second.data, "base64").equals(png);
	check(
		"answers an image with the image itself",
		isPng && image.content[0]?.type === "text" && image.content[0].text.includes("image/png"),
		JSON.stringify(image.content.map((block) => block.type)),
	);

	process.stdout.write("glob\n");
	const found = await call("glob", { pattern: "src/**/*.ts" });
	check("finds both sources", found.text.includes("app.ts") && found.text.includes("other.ts"), found.text);
	const globEscapes = await call("glob", { pattern: "*", path: ".." });
	check("rejects a path above the root", globEscapes.error?.includes("escapes the workspace") === true, globEscapes.error);

	process.stdout.write("grep\n");
	const matches = await call("grep", { pattern: "value", include: "**/*.ts" });
	check("finds a match with line number", matches.text.includes("other.ts:1:"), matches.text);
	const absent = await call("grep", { pattern: "zzz-not-here" });
	check("reports no matches", absent.text.includes("none"), absent.text);

	process.stdout.write("write\n");
	const created = await call("write", { path: "src/new.ts", content: "export {};\n" });
	check("creates a file", created.text.includes("Created"), created.text);
	check("file exists on disk", (await readFile(join(root, "src", "new.ts"), "utf8")) === "export {};\n");
	const createdDiff = diffOf(created.details);
	check("reports the new file as a diff", createdDiff?.created === true && createdDiff.added === 1, JSON.stringify(createdDiff));
	check(
		"whose line is an addition numbered in the new file",
		createdDiff?.lines.length === 1 && createdDiff.lines[0]?.kind === "add" && createdDiff.lines[0].newLine === 1 && createdDiff.lines[0].oldLine === null,
		JSON.stringify(createdDiff?.lines),
	);
	const refused = await call("write", { path: "src/new.ts", content: "changed\n" });
	check("refuses to overwrite without the flag", refused.error?.includes("already exists") === true, refused.error);
	const overwritten = await call("write", { path: "src/new.ts", content: "changed\n", overwrite: true });
	check("overwrites with the flag", overwritten.text.includes("Replaced"), overwritten.text);
	const replacedDiff = diffOf(overwritten.details);
	check(
		"reports the overwrite as one line out and one line in",
		replacedDiff?.created === false &&
			replacedDiff.added === 1 &&
			replacedDiff.removed === 1 &&
			replacedDiff.lines.map((line) => `${line.kind}${line.oldLine ?? "-"}${line.newLine ?? "-"}`).join() === "remove1-,add-1",
		JSON.stringify(replacedDiff?.lines),
	);
	const unchanged = await call("write", { path: "src/new.ts", content: "changed\n", overwrite: true });
	check("reports a no-op write", unchanged.text.includes("No change"), unchanged.text);
	check("and claims no diff for a write that changed nothing", diffOf(unchanged.details) === undefined);

	process.stdout.write("edit\n");
	const edited = await call("edit", { path: "src/app.ts", old_string: "const second = 2;", new_string: "const second = 22;" });
	check("replaces text", edited.text.includes("1 replacement"), edited.text);
	check("reports a diff", edited.text.includes("-const second = 2;") && edited.text.includes("+const second = 22;"), edited.text);
	check("wrote the change", (await readFile(join(root, "src", "app.ts"), "utf8")).includes("second = 22"));
	const editedDiff = diffOf(edited.details);
	check("names the file it changed", editedDiff?.relPath.endsWith("app.ts") === true, String(editedDiff?.relPath));
	check(
		"with the changed line numbered in both files and its context",
		editedDiff?.lines.map((line) => `${line.kind}${line.oldLine ?? "-"}${line.newLine ?? "-"}`).join() ===
			"context11,remove2-,add-2,context33",
		JSON.stringify(editedDiff?.lines),
	);
	// The line gained a digit, so the mark is what was inserted: a range on the added side and nothing
	// on the removed one, which is what says the rest of the line was left alone.
	const removedLine = editedDiff?.lines.find((line) => line.kind === "remove");
	const addedLine = editedDiff?.lines.find((line) => line.kind === "add");
	check(
		"and the part of it that differs marked on the side it changed",
		removedLine?.changed?.[0] === removedLine?.changed?.[1] &&
			addedLine?.text.slice(addedLine.changed?.[0] ?? 0, addedLine.changed?.[1] ?? 0) === "2",
		JSON.stringify([removedLine?.changed, addedLine?.changed]),
	);
	const ambiguous = await call("edit", { path: "notes.md", old_string: "value", new_string: "thing" });
	// "value" appears three times in the fixture: twice in the body and once in the front matter line.
	check("rejects an ambiguous match", ambiguous.error?.includes("appears 3 times") === true, ambiguous.error);
	const all = await call("edit", { path: "notes.md", old_string: "value", new_string: "thing", replace_all: true });
	check("replace_all works", all.text.includes("3 replacements"), all.text);
	const crlf = await call("edit", { path: "crlf.txt", old_string: "beta", new_string: "BETA" });
	check("edits a CRLF file", crlf.error === undefined, crlf.error);
	check("keeps CRLF endings", (await readFile(join(root, "crlf.txt"), "utf8")).includes("BETA\r\n"));
	const absentNeedle = await call("edit", { path: "src/app.ts", old_string: "not in the file", new_string: "x" });
	check("missing old_string errors helpfully", absentNeedle.error?.includes("not found") === true, absentNeedle.error);

	process.stdout.write("bash\n");
	const echo = await call("bash", { command: "echo hello-from-bash" });
	check("runs a command", echo.text.includes("hello-from-bash"), echo.text);
	check("reports the exit code", echo.text.includes("exited with code 0"), echo.text);
	const absCwd = await call("bash", {
		command: process.platform === "win32" ? "cd" : "pwd",
	});
	check("runs in the workspace", absCwd.text.toLowerCase().includes(root.toLowerCase().replace(/\\/g, "\\")), `${absCwd.text} vs ${root}`);
	const failure = await call("bash", { command: "exit 3" });
	check("reports a non-zero exit", failure.text.includes("exited with code 3"), failure.text);
	// An hour is the shipped ceiling, so a ten-minute request now runs uncapped and says nothing about
	// a cap; the annotation is reserved for a request that was actually pulled down.
	const long = await call("bash", { command: "echo x", timeout_ms: 1_000_000 });
	check(
		"runs a request under the ceiling without a cap note",
		long.error === undefined && long.text.includes("x") && !long.text.includes("capped"),
		long.error ?? long.text,
	);
	// The timeouts are the run context's, not constants: a request built with a lower ceiling caps the
	// call at it and names the cap in the result, so the model can plan around it.
	const cappedTool = createToolRegistry(toolDefinitions()).build("bash", {
		workspace: new Workspace(root),
		bash: { defaultTimeoutMs: 60_000, maxTimeoutMs: 1_000 },
	});
	if (!cappedTool) throw new Error("no tool named bash");
	const capped = await cappedTool.execute("test", { command: "echo y", timeout_ms: 1_000_000 }, undefined, undefined);
	const cappedText = capped.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	check(
		"caps at the configured ceiling and says so",
		cappedText.includes("y") && cappedText.includes("requested 1000000 ms, capped at 1000 ms"),
		cappedText,
	);

	process.stdout.write("workspace guard\n");
	const outside = await call("read", { path: "../../../../etc/hosts" });
	check("rejects a relative escape", outside.error?.includes("escapes the workspace") === true, outside.error);

	process.stdout.write("session manager\n");
	await exerciseSessionManager();

	process.stdout.write("branch points\n");
	exerciseBranchPoints();

	process.stdout.write("branch label preview\n");
	exerciseBranchLabelPreview();

	process.stdout.write("session file format\n");
	await exerciseFileFormat();

	process.stdout.write("settings manager\n");
	await exerciseSettings();

	process.stdout.write("tool state fill\n");
	exerciseFillTools();

	process.stdout.write("compaction\n");
	exerciseCompaction();

	process.stdout.write("stale tool results\n");
	await exercisePruning();

	process.stdout.write("tool argument trimming\n");
	exerciseTrimToolCallArgs();

	process.stdout.write("file diffs\n");
	exerciseDiffs();

	process.stdout.write("oversized tool results\n");
	exerciseSpilling();

	process.stdout.write("session lifecycle\n");
	await exerciseSessionLifecycle();
} finally {
	// Sessions live under the agent home, keyed by the workspace path, so removing the temporary
	// workspace is not enough: without this every run leaves an orphan directory behind.
	await rm(workspaceDir(root), { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nall tool checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);

/** A session must survive a restart with the same transcript, and compaction must not delete lines. */
async function exerciseSessionManager(): Promise<void> {
	const manager = createSessionState(root);
	const first: Message = { role: "user", content: [{ type: "text", text: "first question" }], timestamp: 1 };
	const reply: Message = {
		role: "assistant",
		content: [{ type: "text", text: "first answer" }],
		api: "test",
		model: "test/model",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 2,
	};
	const firstEntryId = appendMessage(manager, first);
	appendMessage(manager, reply);

	const header = getHeader(manager);
	check("writes a versioned header", header?.version === CURRENT_SESSION_VERSION, String(header?.version));
	check("stamped with an ISO time", typeof header?.timestamp === "string" && !Number.isNaN(Date.parse(header.timestamp)), header?.timestamp);
	check("naming the workspace it belongs to", header?.cwd === resolvePath(root), header?.cwd);
	check("and no parent for a root session", header?.parentSession === undefined, String(header?.parentSession));
	check("the file leads with the creation stamp", (getAbsSessionFile(manager) ?? "").endsWith(`_${getSessionId(manager)}.jsonl`), String(getAbsSessionFile(manager)));
	check("derives a title from the first user message", getTitle(manager) === "first question", getTitle(manager));
	check("the first entry has no parent", getEntries(manager)[0]?.parentId === null, String(getEntries(manager)[0]?.parentId));
	check("each entry chains to the previous one", getEntries(manager)[1]?.parentId === firstEntryId, String(getEntries(manager)[1]?.parentId));
	check("the leaf is the last entry", getLeafId(manager) === getEntries(manager).at(-1)?.id, String(getLeafId(manager)));

	const absSessionFile = getAbsSessionFile(manager) ?? "";
	const reopened = fillSession(absSessionFile);
	check("reloads both messages", buildSessionContext(reopened).messages.length === 2, String(buildSessionContext(reopened).messages.length));
	check(
		"reads the same entry ids back",
		getEntries(reopened).map((entry) => entry.id).join() === getEntries(manager).map((entry) => entry.id).join(),
	);
	check("reads the same leaf back", getLeafId(reopened) === getLeafId(manager), String(getLeafId(reopened)));
	check("reads the title back", getTitle(reopened) === "first question", getTitle(reopened));
	check("finds the file by id", SessionManager.findSessionFilePathById(getSessionId(manager)) === absSessionFile);

	const listed = (await SessionManager.list(root)).find((entry) => entry.id === getSessionId(manager));
	check("lists the session for the workspace", listed !== undefined);
	check("the list shows the derived title", listed?.firstMessage === "first question", listed?.firstMessage);
	check("and counts the transcript", listed?.messageCount === 2, String(listed?.messageCount));

	// A compaction is a checkpoint: the entry it names and everything after it stay in context, the
	// summary stands for the rest, and the file keeps every line it ever wrote.
	const replyEntryId = getEntries(manager)[1]?.id ?? "";
	appendCompaction(manager, "a summary of the first exchange", replyEntryId, 120);
	const context = buildSessionContext(manager);
	check("the model view leads with the compaction summary", context.messages[0]?.role === "user", context.messages[0]?.role);
	check("carrying the summary text", compactionSummaryText(context.messages[0]) === "a summary of the first exchange");
	check("the kept entry is still there", context.messages[1]?.role === "assistant", context.messages[1]?.role);
	check("and what it replaced is not", !JSON.stringify(context.messages).includes("first question"), JSON.stringify(context.messages));
	check("while the file keeps every message", getEntries(manager).filter((entry) => entry.type === "message").length === 2);

	const compacted = fillSession(absSessionFile);
	check("and a reload reads the same checkpoint", buildSessionContext(compacted).messages[0]?.role === "user" && compactionSummaryText(buildSessionContext(compacted).messages[0]) !== undefined);
	check("with the same entries", getEntries(compacted).length === getEntries(manager).length, String(getEntries(compacted).length));

	check("deriveTitle ignores assistant messages", deriveTitle([reply]) === "新会话");
}

/**
 * Branch points, and the tip a branch would resume at.
 *
 * The entries have always been a tree, so these are the two questions a window asks of it: which
 * messages the conversation carried on from more than one way, and where one of those ways ends.
 */
function exerciseBranchPoints(): void {
	const manager = createSessionState(root);
	const question = (text: string, at: number): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: at });

	const firstId = appendMessage(manager, question("first", 1));
	const answerId = appendMessage(manager, answerMessage("answer one", 2));
	check("a chain has no branch points", getBranchPoints(manager).length === 0, JSON.stringify(getBranchPoints(manager)));
	check("and its tip is where it stopped", getBranchTip(manager, firstId) === answerId, `${getBranchTip(manager, firstId)} vs ${answerId}`);

	// Rewind, change the model, then ask again. A state entry is not a place a conversation can be
	// resumed at, so it must not read as an alternative of its own.
	branch(manager, firstId);
	const modelEntryId = appendModelChange(manager, "t", "m");
	const secondId = appendMessage(manager, question("second", 3));

	const points = getBranchPoints(manager);
	check("the message both ways carried on from is a branch point", points.length === 1 && points[0]?.entryId === firstId, JSON.stringify(points));
	check("with two continuations", points[0]?.options.length === 2, JSON.stringify(points[0]?.options));
	check(
		"named by the first message each leads to, the state entry descended through",
		(points[0]?.options ?? []).map((option) => option.label).join("|") === "answer one|second",
		JSON.stringify(points[0]?.options),
	);
	check(
		"and the alternative the leaf is on marked",
		points[0]?.options[0]?.active === false && points[0]?.options[1]?.active === true,
		JSON.stringify(points[0]?.options),
	);
	check("a branch resumes at its newest tip", getBranchTip(manager, modelEntryId) === secondId, `${getBranchTip(manager, modelEntryId)} vs ${secondId}`);
	// The move this exercise made is a real move, so it wrote its record as a child of the answer, and
	// the subtree's newest tip is that record. Landing on it is landing on the answer's branch — the
	// next append continues under it, and the replay takes the file's last word.
	const otherTip = getBranchTip(manager, points[0]?.options[0]?.entryId ?? "");
	const otherEntry = getEntry(manager, otherTip);
	check(
		"which for the other alternative ends at the record its move wrote",
		otherEntry?.type === "leaf" && otherEntry.parentId === answerId,
		`${otherTip} vs ${answerId}`,
	);
	check(
		"an entry the session does not have is refused",
		(() => {
			try {
				getBranchTip(manager, "no-such-entry");
				return false;
			} catch {
				return true;
			}
		})(),
	);

	// The gesture this window now offers: rewind to an *assistant answer* and ask again. The point is
	// that answer, and the card that names it has to say which question it answered.
	const assistantPoint = createSessionState(root);
	appendMessage(assistantPoint, question("q1", 10));
	const firstAnswer = appendMessage(assistantPoint, answerMessage("a1", 11));
	appendMessage(assistantPoint, question("q2", 12));
	branch(assistantPoint, firstAnswer);
	appendMessage(assistantPoint, question("q3", 13));
	const [ap] = getBranchPoints(assistantPoint);
	check("an assistant answer is a branch point", ap?.entryId === firstAnswer, JSON.stringify(ap));
	check("named by the user message above it", ap?.prompt === "q1", JSON.stringify(ap?.prompt));
	check(
		"and both ways are the prompts that continue it",
		(ap?.options ?? []).map((option) => option.label).join("|") === "q2|q3",
		JSON.stringify(ap?.options),
	);
}

/**
 * A branch label is the only text a card carries, so the preview has to be sized for a sentence.
 *
 * The card shows one ellipsised line, and nothing unfolds the rest — but an option travels in every
 * snapshot, so the label cannot be the message itself either: it is a preview, and the bound is what
 * keeps it one. It was capped at 64 characters, which cut the ordinary Chinese sentence below in
 * half, so the bound is now `BRANCH_LABEL_MAX` — this asserts the message arrives whole, and keeps a
 * future tightening of that bound from silently shortening every card in the branch graph.
 */
function exerciseBranchLabelPreview(): void {
	const manager = createSessionState(root);
	const question = (text: string, at: number): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: at });

	const firstId = appendMessage(manager, question("first", 1));
	// Long enough to have been cut by the old 64-character bound, short enough to survive today's — so
	// this fails on a regression rather than on a future, larger bound.
	const sentence = "把整个窗口的布局问题一次说清楚：从标题栏到输入框、从侧边栏到状态行，连同分支图卡片为什么会被一段很长的消息撑高、把下面那一行盖住。".slice(0, 150);
	appendMessage(manager, question(sentence, 2));
	// Back to the first message and ask again: the branch point is now `firstId` with two ways, which is
	// the shape a card is drawn from. Branching at the current leaf would write nothing at all.
	branch(manager, firstId);
	appendMessage(manager, question("second", 3));

	const options = getBranchPoints(manager)[0]?.options ?? [];
	check("一条很长的消息，标签仍然是整句（卡片靠它取名）", options.some((option) => option.label === sentence), options.map((option) => `${option.label.length}:${option.label}`).join(" | "));
	check("而另一条走法的标签照样是它自己那句", options.some((option) => option.label === "second"), JSON.stringify(options.map((option) => option.label)));
	check("一串没有空白的超长文本仍然被裁到上限", (() => {
		branch(manager, firstId);
		appendMessage(manager, question("x".repeat(BRANCH_LABEL_MAX + 50), 4));
		const capped = (getBranchPoints(manager)[0]?.options ?? []).find((option) => option.label.startsWith("xxx"))?.label ?? "";
		return capped.length === BRANCH_LABEL_MAX && capped.endsWith("...");
	})());
}

/**
 * The on-disk shape is pi's: a header naming a workspace, then a tree of entries.
 *
 * Two invariants matter more than the field names. An entry kind this build does not understand has to
 * survive a read, because a newer build wrote it and the file is never rewritten; and an append has to
 * leave every earlier line exactly as it was, because that is what makes the file append-only.
 */
async function exerciseFileFormat(): Promise<void> {
	const id = "01a0a0a0-a0a0-70a0-a0a0-a0a0a0a0a0a0";
	const createdAt = new Date().toISOString();
	const dir = workspaceDir(root);
	await mkdir(dir, { recursive: true });
	const path = sessionPath(dir, id, createdAt);
	const lines = [
		JSON.stringify({ type: "SessionHeader", version: CURRENT_SESSION_VERSION, id, timestamp: createdAt, cwd: resolvePath(root) }),
		JSON.stringify({ type: "message", id: "aaaa0001", parentId: null, timestamp: createdAt, message: { role: "user", content: [{ type: "text", text: "written elsewhere" }], timestamp: 5 } }),
		JSON.stringify({ type: "message", id: "aaaa0002", parentId: "aaaa0001", timestamp: createdAt, message: { role: "assistant", content: [{ type: "text", text: "answered elsewhere" }], timestamp: 6 } }),
		JSON.stringify({ type: "future_thing", id: "aaaa0003", parentId: "aaaa0002", timestamp: createdAt, payload: { kept: true } }),
	];
	await writeFile(path, `${lines.join("\n")}\n`, "utf8");

	const manager = fillSession(path);
	check("reads both messages", buildSessionContext(manager).messages.length === 2, String(buildSessionContext(manager).messages.length));
	check("chains the entries it was given", getEntries(manager)[1]?.parentId === "aaaa0001", String(getEntries(manager)[1]?.parentId));
	check("the leaf is the last entry", getLeafId(manager) === "aaaa0003", String(getLeafId(manager)));
	check("keeps the messages an unknown entry does not touch", buildSessionContext(manager).messages.length === 2);

	const unknown = getEntries(manager).find((entry) => entry.type === "future_thing");
	check("keeps an unknown entry kind", unknown !== undefined);
	check("with the fields it arrived with", JSON.stringify(unknown).includes('"kept":true'), JSON.stringify(unknown));

	const appended = appendMessage(manager, { role: "user", content: [{ type: "text", text: "after the upgrade" }], timestamp: 20 });
	check("gives the new entry an id of its own", appended !== "aaaa0003" && appended.length === 8, appended);
	check("chained to the entry that was the tip", getEntries(manager).at(-1)?.parentId === "aaaa0003", String(getEntries(manager).at(-1)?.parentId));

	const text = await readFile(path, "utf8");
	check("never rewrites earlier lines", text.startsWith(lines.join("\n")), text.slice(0, 48));
	check("the unknown entry is still in the file", text.includes("future_thing"));

	const reopened = fillSession(path);
	check("reopens with the same transcript", buildSessionContext(reopened).messages.length === 3, String(buildSessionContext(reopened).messages.length));
	check("and the same leaf", getLeafId(reopened) === appended, String(getLeafId(reopened)));

	check("sessions live under the agent home", dir.startsWith(sessionsDir()), dir);
	check("in a directory named after the workspace", dir.endsWith("--") && dir.includes("my-agent-tools-"), dir);
}

/**
 * Settings come from two files and go back to the one that owns the field.
 *
 * The properties worth pinning are the two that are easy to get wrong: a project file must override
 * only the fields it names (a project that gates `write` must not un-gate `bash`), and a write must not
 * carry the rest of the in-memory view into the file, or a hand edit made while the process was running
 * is reverted by the next toggle.
 */
async function exerciseSettings(): Promise<void> {
	const agentDir = join(root, "settings-agent-home");
	const workspace = join(root, "settings-workspace");
	const globalFile = join(agentDir, "settings.json");
	const projectFile = join(workspace, PROJECT_DIR_NAME, "settings.json");
	await mkdir(join(workspace, PROJECT_DIR_NAME), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		globalFile,
		// `keepRecentTokens` is a key this build no longer reads: it stands in for anything a newer
		// build wrote, which has to survive a read and a write here untouched.
		JSON.stringify({ model: "faux/faux-1", approval: { bash: false }, keepRecentTokens: 5_000, customKey: "kept" }),
		"utf8",
	);
	await writeFile(projectFile, JSON.stringify({ approval: { write: false } }), "utf8");

	const settings = SettingsManager.create(workspace, agentDir);
	check("reads the agent home's file", settings.getModel() === "faux/faux-1", String(settings.getModel()));
	check("the project file overrides the field it names", settings.getApprovals().write === false, JSON.stringify(settings.getApprovals()));
	check("and the global value beside it survives", settings.getApprovals().bash === false, JSON.stringify(settings.getApprovals()));
	check("while an unnamed field keeps its default", settings.getApprovals().edit === true, JSON.stringify(settings.getApprovals()));

	// `approval` is the project file's to own, so this change belongs there and only this tool's key
	// may move: writing the whole merged map would pin all six tools in the repository's file.
	settings.applySettings({ approval: { read: true } });
	const project = JSON.parse(await readFile(projectFile, "utf8")) as { approval?: Record<string, boolean> };
	check("an approval is written to the file that owns it", project.approval?.read === true, JSON.stringify(project));
	check("keeping the other entries that file had", project.approval?.write === false, JSON.stringify(project));
	check("and adding no key it never named", project.approval?.bash === undefined, JSON.stringify(project));
	check("the change is in effect", settings.isApprovalRequired("read") === true);
	check("with the other layer still supplying its own value", settings.isApprovalRequired("bash") === false);

	// No file names the queue mode, so it is a new setting and goes to the agent home's file.
	settings.applySettings({ steeringMode: "all" });
	const global = JSON.parse(await readFile(globalFile, "utf8")) as Record<string, unknown>;
	check("a setting no file names goes to the global file", global.steeringMode === "all", JSON.stringify(global));
	check(
		"which keeps the keys it did not touch",
		global.customKey === "kept" && global.model === "faux/faux-1" && global.keepRecentTokens === 5_000,
		JSON.stringify(global),
	);
	check("and the mode is in effect", settings.getSteeringMode() === "all", settings.getSteeringMode());

	settings.applySettings({ bash: { maxTimeoutMs: 1_800_000 } });
	check("the bash ceiling moves with the patch", settings.getBashSettings().maxTimeoutMs === 1_800_000, JSON.stringify(settings.getBashSettings()));
	check("leaving the default timeout beside it", settings.getBashSettings().defaultTimeoutMs === 120_000, JSON.stringify(settings.getBashSettings()));
	const lowered = SettingsManager.inMemory({ bash: { defaultTimeoutMs: 9_000_000, maxTimeoutMs: 600_000 } });
	check("a default above the ceiling is pulled down to it", lowered.getBashSettings().defaultTimeoutMs === 600_000, JSON.stringify(lowered.getBashSettings()));

	// An edit made outside this process must survive the next write.
	await writeFile(globalFile, JSON.stringify({ ...global, model: "hand/edited" }), "utf8");
	settings.applySettings({ followUpMode: "all" });
	const rewritten = JSON.parse(await readFile(globalFile, "utf8")) as Record<string, unknown>;
	check("a hand edit is not reverted by the next write", rewritten.model === "hand/edited", JSON.stringify(rewritten));
	check("which still lands its own change", rewritten.followUpMode === "all", JSON.stringify(rewritten));

	// A settings file that cannot be parsed is an error, not a silent fall back to the defaults.
	await writeFile(projectFile, "{ not json", "utf8");
	let failure = "";
	try {
		SettingsManager.create(workspace, agentDir);
	} catch (error) {
		failure = (error as Error).message;
	}
	check("reports a settings file it cannot parse", failure.includes("settings.json"), failure);
}

/**
 * The lifecycle calls must settle before they resolve, not just fire a signal.
 *
 * Persistence happens as the loop reports messages, so an abort cannot lose them. What this contract
 * guarantees is that a caller can hand the socket to a new session only once no more frames can arrive
 * from the old one. These assertions pin the "settles rather than hangs" half of it.
 */
async function exerciseSessionLifecycle(): Promise<void> {
	const state = createSessionState(root);
	const question: Message = { role: "user", content: [{ type: "text", text: "lifecycle question" }], timestamp: 1 };
	appendMessage(state, question);

	// In memory: a config change must land in the manager the caller holds, and never in the
	// developer's `~/.my-agent/settings.json`. Before settings became an injected manager, this test
	// wrote that file.
	const settingsManager = SettingsManager.inMemory({
		approval: { read: false, write: false, edit: false, glob: false, grep: false, bash: false },
	});
	// A model has to be imported for assembly to have one to record: the catalog is the user's now, and
	// an empty one yields the placeholder, which is deliberately never written to a transcript.
	const configured: ModelConfig = {
		name: "smoke",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "unused",
		id: "smoke-model",
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
	const session = await openAgent({
		absWorkspaceRoot: root,
		sessionState: state,
		models: { list: () => [configured] },
		settingsManager,
	});

	check("opens with the stored transcript", session.snapshot.messages.length === 1, String(session.snapshot.messages.length));
	check("is idle before any prompt", session.isLooping === false);

	session.applyConfig({ approval: { bash: true } });
	check("the session exposes the manager it was given", session.settingsManager === settingsManager);
	// An approval chosen in a session is that session's own: it lives in the transcript as a
	// `tool_config` entry, and the settings file 鈥攚hich every other session over this workspace reads
	// 鈥攊s left exactly as it was.
	check(
		"applyConfig leaves the settings file alone",
		settingsManager.getApprovals().bash === false,
		JSON.stringify(settingsManager.getApprovals()),
	);
	check("and the session reflects it", session.snapshot.approvals.bash === true, JSON.stringify(session.snapshot.approvals));
	check(
		"recording the choice in the transcript",
		getRecordedToolConfig(state).approval?.bash === true,
		JSON.stringify(getRecordedToolConfig(state)),
	);
	check(
		"beside the tool set in force",
		JSON.stringify(getRecordedToolConfig(state).activeTools) === JSON.stringify(session.activeTools),
		JSON.stringify(getRecordedToolConfig(state).activeTools),
	);

	// Both calls must resolve without an active run, and must not disturb the transcript.
	const aborted = await within("abort()", 5_000, session.abort());
	check("abort() settles when idle", aborted.ok);
	const closed = await within("close()", 5_000, session.close());
	check("close() settles", closed.ok);
	check("lifecycle calls keep the transcript", session.snapshot.messages.length === 1, String(session.snapshot.messages.length));

	const reloaded = fillSession(session.sessionFile ?? "");
	check(
		"the transcript is still on disk",
		getEntries(reloaded).filter((entry) => entry.type === "message").length === 1,
		String(getEntries(reloaded).length),
	);
	// Assembly writes nothing, and neither does a config change: a session that opened on a model and
	// was never spoken to has not used it, so the transcript stays the transcript it opened with. The
	// entries land with the first request that carries them — see `smoke-session.ts`.
	check(
		"and neither assembly nor a config change recorded a model",
		getRecordedSettings(reloaded).model === undefined,
		JSON.stringify(getRecordedSettings(reloaded)),
	);

	// The choice is durable and session-scoped: reopening the same file restores it, while a second
	// session over the same workspace still opens on the settings defaults.
	check(
		"the transcript kept the tool choices",
		getRecordedToolConfig(reloaded).approval?.bash === true,
		JSON.stringify(getRecordedToolConfig(reloaded)),
	);
	const reopened = await openAgent({
		absWorkspaceRoot: root,
		sessionState: reloaded,
		models: { list: () => [configured] },
		settingsManager,
	});
	check("reopening restores the approval the session chose", reopened.snapshot.approvals.bash === true, JSON.stringify(reopened.snapshot.approvals));
	const other = await openAgent({
		absWorkspaceRoot: root,
		sessionState: createSessionState(root),
		models: { list: () => [configured] },
		settingsManager,
	});
	check(
		"while another session over the workspace keeps the defaults",
		other.snapshot.approvals.bash === false,
		JSON.stringify(other.snapshot.approvals),
	);
}

/**
 * The tool choice is a fill: a mode seed in, a complete `ToolState` out.
 *
 * What the checks pin: the built-in default mode is the global default's live view and reads no
 * stored entry; a name this build no longer knows is dropped from the answer rather than thrown at
 * (a replayed set must not refuse a session its reopen); and an unknown mode name throws, because a
 * session asked to run in a mode nobody defined has no configuration to fall back on.
 */
function exerciseFillTools(): void {
	const known = toolDefinitions().names();
	const modes = [
		{
			name: "reader",
			tools: ["read", "glob", "vanished"],
			approval: { read: false, write: true, edit: true, glob: false, grep: true, bash: true },
		},
	];
	const context = { modes, globalTools: [...known, "vanished"], known };

	check(
		"a missing seed is the global default's view",
		JSON.stringify(fillTools(undefined, context).activeToolNames) === JSON.stringify(known),
		JSON.stringify(fillTools(undefined, context)),
	);
	check(
		"and so is the built-in mode's name",
		JSON.stringify(fillTools("默认", context).activeToolNames) === JSON.stringify(known),
		JSON.stringify(fillTools("默认", context)),
	);
	check(
		"the default view carries no approval override of its own",
		fillTools(undefined, context).approvalOverride === undefined,
		JSON.stringify(fillTools(undefined, context).approvalOverride),
	);
	check(
		"a name this build dropped is narrowed out of the default",
		fillTools(undefined, context).activeToolNames.includes("vanished") === false,
		JSON.stringify(fillTools(undefined, context).activeToolNames),
	);

	const reader = fillTools("reader", context);
	check("a named mode picks its own tool set", JSON.stringify(reader.activeToolNames) === JSON.stringify(["read", "glob"]), JSON.stringify(reader.activeToolNames));
	check("carrying its approval map whole", reader.approvalOverride?.write === true && reader.approvalOverride?.read === false, JSON.stringify(reader.approvalOverride));

	let threw = "";
	try {
		fillTools("no-such-mode", context);
	} catch (error) {
		threw = (error as Error).message;
	}
	check("an unknown mode name throws", threw.includes("no-such-mode"), threw);
}

function exerciseCompaction(): void {
	const manager = inMemorySessionState(root);
	for (let index = 0; index < 10; index += 1) {
		appendMessage(manager, { role: "user", content: [{ type: "text", text: `question ${index} ${"x".repeat(50)}` }], timestamp: index * 2 + 1 });
		appendMessage(manager, {
			role: "assistant",
			content: [{ type: "text", text: `answer ${index}` }],
			api: "t",
			model: "m",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: index * 2 + 2,
		});
	}
	// The trigger is the model's own window minus a fixed 33k reserve, halved for a window that cannot
	// give up that much.
	check("the trigger follows the model's window", compactionThresholdFor(128_000) === 95_000, String(compactionThresholdFor(128_000)));
	check(
		"a window under the reserve gives up half of itself",
		compactionThresholdFor(32_768) === 16_384,
		String(compactionThresholdFor(32_768)),
	);
	check("a window nobody declared never triggers", compactionThresholdFor(0) === 0, String(compactionThresholdFor(0)));

	const messages = buildSessionContext(manager).messages;
	const threshold = 10;

	check("estimates tokens from content", estimateTokens(messages) > 0);
	check("does not compact below the threshold", shouldCompact(messages, 1_000_000) === false);
	check("compacts above the threshold", shouldCompact(messages, threshold) === true);

	const prepared = prepareCompaction(buildContextEntries(manager) as SessionEntry[]);
	check("produces a preparation", prepared !== undefined);
	if (!prepared) return;

	// Nothing is kept verbatim: every finished turn is folded, and only the turn in flight survives.
	const entries = getEntries(manager);
	check(
		"summarizing every finished turn",
		prepared.messagesToSummarize.length === messages.length - 2,
		`${prepared.messagesToSummarize.length} of ${messages.length}`,
	);
	check("cutting between turns rather than inside one", prepared.messagesToSummarize.length % 2 === 0, String(prepared.messagesToSummarize.length));
	check("and keeping the newest turn", prepared.firstKeptEntryId === entries[entries.length - 2]?.id, String(prepared.firstKeptEntryId));
	check("naming an entry the transcript still has", getEntry(manager, prepared.firstKeptEntryId) !== undefined);

	appendCompaction(manager, "summary of the dropped turns", prepared.firstKeptEntryId, prepared.tokensBefore);
	check("is smaller after compaction", estimateTokens(buildSessionContext(manager).messages) < estimateTokens(messages));
	check("with the summary in front", compactionSummaryText(buildSessionContext(manager).messages[0]) !== undefined);
	check(
		"and nothing left but the turn it kept",
		buildSessionContext(manager).messages.length === 3,
		String(buildSessionContext(manager).messages.length),
	);
	check("and nothing left to compact again", prepareCompaction(buildContextEntries(manager) as SessionEntry[]) === undefined);
}

/** One entry as the store writes it, with the timestamp the test needs rather than today's. */
function messageEntry(id: string, parentId: string | null, at: number, message: Message): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date(at).toISOString(), message };
}

/** An assistant turn whose only content is one tool call, as the loop records it. */
function callMessage(callId: string, toolName: string, at: number): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: toolName, arguments: {} }],
		api: "t",
		model: "m",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: at,
	};
}

/** What a tool answered, as the loop records it. */
function resultMessage(callId: string, toolName: string, text: string, at: number): Message {
	return { role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text }], isError: false, timestamp: at };
}

/** The final assistant turn, so the transcript ends with a provider call rather than a result. */
function answerMessage(text: string, at: number): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "t",
		model: "m",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: at,
	};
}

/** The messages a selection of entries stands for 鈥攖he view `maybeCompact` answers with. */
function project(entries: readonly SessionEntry[]): Message[] {
	return entries.flatMap((entry) => sessionEntryToContextMessages(entry));
}

/**
 * A session file whose entries are stamped two hours ago.
 *
 * A store appends with today's clock and there is no seam for a test to move it, so the fixture is
 * written by hand: whether a clear happens is a decision about the clock, and only a file can hold
 * yesterday's time. Writing it also lets the test read the session back the way a new process would.
 */
async function writeIdleSession(dir: string, entries: readonly SessionEntry[], at: number): Promise<string> {
	const file = join(dir, "idle-session.jsonl");
	const lines = [
		JSON.stringify({
			type: "SessionHeader",
			version: CURRENT_SESSION_VERSION,
			id: "idle-session",
			timestamp: new Date(at).toISOString(),
			absCwd: resolvePath(dir),
		}),
	];
	let clock = at;
	for (const entry of entries) {
		clock += 1_000;
		lines.push(JSON.stringify({ ...entry, timestamp: new Date(clock).toISOString() }));
	}
	await writeFile(file, `${lines.join("\n")}\n`, "utf8");
	return file;
}

/**
 * A conversation that sat idle for over an hour loses its prompt cache, so the tool results nobody
 * has looked at since are being paid for in full.
 *
 * What a tool can produce again is the cheapest thing in the transcript to lose, and clearing it costs
 * no request at all 鈥攚hich is why it happens before a summary is paid for. What no tool can produce
 * again, such as a subagent's report, is never touched however old it is. The clear is recorded rather
 * than held in memory, so the file is the thing every later reader decides from.
 */
async function exercisePruning(): Promise<void> {
	const now = Date.now();
	const longAgo = now - 2 * 60 * 60 * 1000;
	// Big bodies on the three oldest results, so clearing them is what brings the estimate down; the
	// five newest are small and survive, which is the "keep the newest five" half of the rule.
	const bodyOf = (index: number): string => (index < 3 ? `body ${index} ${"x".repeat(20_000)}` : `body ${index}`);

	const store = createSessionState(root);
	appendMessage(store, { role: "user", content: [{ type: "text", text: "look through the package" }], timestamp: longAgo });
	const resultEntryIds: string[] = [];
	for (let index = 0; index < 8; index += 1) {
		appendMessage(store, callMessage(`call-${index}`, "read", longAgo));
		resultEntryIds.push(appendMessage(store, resultMessage(`call-${index}`, "read", bodyOf(index), longAgo)));
	}
	appendMessage(store, callMessage("call-task", "task", longAgo));
	appendMessage(store, resultMessage("call-task", "task", "SUBAGENT REPORT: rewrote the parser", longAgo));
	appendMessage(store, answerMessage("done", longAgo));

	// The entries are appended with today's stamps, so the store is rewound to the idle conversation the
	// clock test is about: this is the only way to hand a session a transcript that sat for two hours.
	const fixture = await writeIdleSession(root, getEntries(store), longAgo);
	const store2 = fillSession(fixture);
	const entries = getEntries(store2);

	const text = (view: readonly SessionEntry[]): string => JSON.stringify(project(view));

	// The clock is the newest provider call, and the message a user just typed is not one.
	const lastCall = Date.parse(entries[entries.length - 1]!.timestamp);
	check("a transcript fresh off a call is not expired", isCacheProbablyExpired(entries, lastCall + 59 * 60 * 1000) === false);
	check("and one idle for an hour is", isCacheProbablyExpired(entries, lastCall + 60 * 60 * 1000) === true);
	check(
		"a transcript with no call in it never expires",
		isCacheProbablyExpired([messageEntry("only", null, longAgo, { role: "user", content: [{ type: "text", text: "hi" }], timestamp: longAgo })], now) === false,
	);

	// Which results a clear would empty: the three oldest, because the newest five are kept.
	const view = buildContextEntries(store2);
	const clearable = clearableToolResultIds(view);
	check(
		"the three oldest read results are the ones to clear",
		clearable.join() === resultEntryIds.slice(0, 3).join(),
		clearable.join(),
	);
	check("a subagent report is never a candidate", !clearable.includes(entries[entries.length - 2]!.id), clearable.join());
	check(
		"clearing keeps the entry and replaces only its text",
		(() => {
			const cleared = clearToolResult(entries.find((entry) => entry.id === resultEntryIds[0])!);
			return (
				cleared.id === resultEntryIds[0] &&
				cleared.type === "message" &&
				cleared.message.role === "toolResult" &&
				cleared.message.content.length === 1 &&
				cleared.message.content[0]?.type === "text" &&
				cleared.message.content[0].text === clearedToolResultText("read") &&
				estimateTokens(project([cleared])) < 20
			);
		})(),
	);

	// The whole point of clearing first: when it is enough on its own, no summary is paid for.
	const configured: ModelConfig = {
		name: "smoke",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "unused",
		id: "smoke-model",
		// 33,500 puts the trigger at 500 estimated tokens, between the transcript before the clear and
		// the one after it.
		contextWindow: 33_500,
		maxTokens: 8_192,
	};
	const session = await openAgent({
		absWorkspaceRoot: root,
		sessionState: store2,
		models: { list: () => [configured] },
		settingsManager: SettingsManager.inMemory({ approval: { read: false, write: false, edit: false, glob: false, grep: false, bash: false } }),
	});
	const announced: string[] = [];
	session.onEvent((event) => {
		if (event.type === "compaction" || event.type === "compaction_failed" || event.type === "tool_results_cleared") announced.push(event.type);
	});

	check("the trigger fired before the clear", estimateTokens(project(buildContextEntries(store2))) > 500);
	const kept = await session.maybeCompact(buildContextEntries(store2), now);
	const keptText = text(kept);
	check("the clear alone left it under the trigger", estimateTokens(project(kept)) <= 500, String(estimateTokens(project(kept))));
	check("so the request carries the cleared view", keptText.includes(clearedToolResultText("read")) && !keptText.includes("body 0 "));
	check("and the newest results as they were", keptText.includes("body 7") && keptText.includes("SUBAGENT REPORT"));
	check("the clear was announced and nothing was summarized", announced.join() === "tool_results_cleared", JSON.stringify(announced));
	check(
		"and one record now says what it cleared",
		getEntries(store2).filter((entry) => entry.type === "clear_tool_result").length === 1,
		JSON.stringify(getEntries(store2).map((entry) => entry.type)),
	);

	// A second pass has nothing left to clear and the trigger no longer fires, so nothing is written.
	await session.maybeCompact(buildContextEntries(store2), now);
	check("a second pass writes no second record", getEntries(store2).filter((entry) => entry.type === "clear_tool_result").length === 1);
	await session.close();

	// The point of recording it: a process that reads the file again sees the cleared view without
	// re-deciding anything, and the file still holds every result the view dropped.
	const reread = fillSession(fixture);
	const rereadText = text(buildContextEntries(reread));
	check("a reload reads the cleared view", rereadText.includes(clearedToolResultText("read")) && !rereadText.includes("body 0 "));
	check("with the newest results still there", rereadText.includes("body 7") && rereadText.includes("SUBAGENT REPORT"));
	check("and nothing left for a clear to do", clearableToolResultIds(buildContextEntries(reread)).length === 0);
	check(
		"while the file itself keeps what the view dropped",
		getEntries(reread).some((entry) => JSON.stringify(entry).includes("body 0 ")),
	);
}

/**
 * The heavy bodies a `write` or an `edit` carried are in the files they changed, so the recorded
 * arguments are the cheapest thing compaction can shorten: no request, no clock.
 *
 * What the checks pin: only a call whose result is already on the branch is a candidate 鈥攖he
 * arguments of a call still in flight belong to the turn the model is inside 鈥攁nd the trim is a
 * recorded view, so the file keeps the full body while every reader of the context sees the marker.
 */
function exerciseTrimToolCallArgs(): void {
	const manager = createSessionState(root);
	const body = Array.from({ length: 500 }, (_, index) => `line-${index} ${"x".repeat(10)}`).join("\n");
	appendMessage(manager, { role: "user", content: [{ type: "text", text: "write a big file" }], timestamp: 1 });
	const answeredWrite = appendMessage(manager, {
		role: "assistant",
		content: [{ type: "toolCall", id: "big-write", name: "write", arguments: { path: "src/big.ts", content: body } }],
		api: "t",
		model: "m",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 2,
	});
	appendMessage(manager, resultMessage("big-write", "write", "Created src/big.ts.", 3));
	// Same shape, but its result has not been recorded: the call may still be the turn in flight.
	const openWrite = appendMessage(manager, {
		role: "assistant",
		content: [{ type: "toolCall", id: "open-write", name: "write", arguments: { path: "src/other.ts", content: body } }],
		api: "t",
		model: "m",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 4,
	});

	const candidates = trimmableToolArgEntryIds(buildContextEntries(manager));
	check("an answered write call is the candidate", candidates.join() === answeredWrite, candidates.join());
	check("a call awaiting its result is not", !candidates.includes(openWrite), candidates.join());

	const before = estimateTokens(project(buildContextEntries(manager)));
	appendTrimToolCallArgs(manager, candidates, before);
	const view = buildContextEntries(manager);
	// The open write keeps its body on purpose, so the assertions below target the answered call only.
	const entryText = (needle: string): string => {
		const entry = view.find((candidate) => candidate.type === "message" && JSON.stringify(candidate.message).includes(needle));
		return entry ? JSON.stringify(entry) : "";
	};
	const answeredText = entryText("big-write");
	const openText = entryText("open-write");
	check("the answered call's view drops the body", answeredText !== "" && !answeredText.includes("line-250"), answeredText.slice(0, 200));
	check("with the marker in its place", answeredText.includes(ARG_TRIM_MARKER) && answeredText.includes("line-0"), answeredText.slice(0, 300));
	check("keeping the arguments that say what happened", answeredText.includes("src/big.ts"));
	check("while the call in flight keeps its body whole", openText.includes("line-250"));
	check("the estimate fell with the body", estimateTokens(project(view)) < before);
	check("the file keeps the full argument", getEntries(manager).some((entry) => JSON.stringify(entry).includes("line-250")));
	check(
		"a reload reads the same trimmed view",
		!JSON.stringify(project(buildContextEntries(fillSession(getAbsSessionFile(manager) ?? ""))).find((message) => JSON.stringify(message).includes("big-write"))).includes("line-250"),
	);
	check("and nothing is left for a second trim", trimmableToolArgEntryIds(view).length === 0);
}

/**
 * The line diff behind the cards, checked where the interesting cases live rather than only through
 * a tool call: a change in the middle of a long file has to skip the lines between its hunks without
 * losing their numbers, and a report longer than its bound has to say what it left out.
 */
function exerciseDiffs(): void {
	const file = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n");
	const changed = file.split("\n");
	changed[9] = "line 10 rewritten";
	changed[49] = "line 50 rewritten";

	const twoHunks = fileDiff("src/long.ts", file, changed.join("\n"));
	check("reports one addition and one removal per rewritten line", twoHunks.added === 2 && twoHunks.removed === 2, JSON.stringify(twoHunks));
	check("names the file it was given", twoHunks.relPath === "src/long.ts", twoHunks.relPath);
	check("does not call an existing file new", twoHunks.created === false);

	const skip = twoHunks.lines.find((line) => line.kind === "skip");
	// Lines 7-13 and 47-53 are shown with their context; the 33 lines between the two hunks are not.
	check("gathers the change and its context into hunks", twoHunks.lines.length === 17, JSON.stringify(twoHunks.lines.map((line) => `${line.kind}${line.oldLine ?? "-"}`)));
	check("and says how many lines it skipped between them", skip?.skipped === 33, JSON.stringify(skip));
	check("the skipped head of the file is not reported as a gap", twoHunks.lines[0]?.oldLine === 7, JSON.stringify(twoHunks.lines[0]));
	const afterSkip = twoHunks.lines[twoHunks.lines.indexOf(skip!) + 1];
	check("and the numbers resume where the file says", afterSkip?.oldLine === 47 && afterSkip.newLine === 47, JSON.stringify(afterSkip));

	const insertion = fileDiff("src/app.ts", "one\ntwo\n", "one\ninserted\ntwo\n");
	check(
		"an inserted line numbers the lines below it in the new file only",
		insertion.lines.map((line) => `${line.kind}${line.oldLine ?? "-"}${line.newLine ?? "-"}`).join() ===
			"context11,add-2,context23",
		JSON.stringify(insertion.lines),
	);

	const deletion = fileDiff("src/app.ts", "one\ntwo\n", "one\n");
	check(
		"a deleted line is a removal with no new number",
		deletion.lines.map((line) => `${line.kind}${line.oldLine ?? "-"}${line.newLine ?? "-"}`).join() === "context11,remove2-",
		JSON.stringify(deletion.lines),
	);

	const empty = fileDiff("src/app.ts", "one\n", "one\n");
	check("no change is no diff", empty.lines.length === 0 && empty.added === 0 && empty.removed === 0, JSON.stringify(empty));

	const shrunk = fileDiff("src/app.ts", "const total = 100;\n", "const total = 1;\n");
	const removedPart = shrunk.lines.find((line) => line.kind === "remove");
	const addedPart = shrunk.lines.find((line) => line.kind === "add");
	check(
		"a rewritten line marks the characters that went and the ones that arrived",
		removedPart?.text.slice(removedPart.changed?.[0] ?? 0, removedPart.changed?.[1] ?? 0) === "00" &&
			addedPart?.changed?.[0] === addedPart?.changed?.[1],
		JSON.stringify([removedPart?.changed, addedPart?.changed]),
	);

	const rewritten = fileDiff("src/app.ts", "one\ntwo\n", "three\nfour\n");
	check(
		"a line with nothing left in common is not marked at all",
		rewritten.lines.every((line) => line.changed === undefined),
		JSON.stringify(rewritten.lines),
	);

	const big = fileDiff("src/big.ts", "", Array.from({ length: 700 }, (_, index) => `new line ${index}`).join("\n"), {
		maxLines: DIFF_MAX_ROWS,
	});
	check("a new file is every line added", big.created === true && big.added === 700 && big.removed === 0, JSON.stringify({ created: big.created, added: big.added }));
	check("a report longer than its bound says how much it left out", big.lines.length === DIFF_MAX_ROWS && big.omitted === 200, `${big.lines.length} rows, ${big.omitted} omitted`);

	const text = diffText(big);
	check("the model's half of the report is capped on its own", text.split("\n").length === DIFF_TEXT_MAX_ROWS + 1, String(text.split("\n").length));
	check("and says so rather than ending mid-change", text.endsWith(`[... ${700 - DIFF_TEXT_MAX_ROWS} diff lines omitted ...]`), text.slice(-48));
	check(
		"the text form carries no line numbers",
		diffText(fileDiff("p", "old\n", "new\n")) === "-old\n+new",
		JSON.stringify(diffText(fileDiff("p", "old\n", "new\n"))),
	);
}

/**
 * A result no tool bounded is archived into the workspace whole, and the model is served its head and
 * tail plus the archive's path 鈥攕o nothing is lost, and the agent can read the rest back itself.
 */
function exerciseSpilling(): void {
	const workspace = new Workspace(root);
	const middle = Array.from({ length: 10_000 }, (_, index) => `line-${index} ${"y".repeat(8)}`).join("\n");
	const content = [{ type: "text" as const, text: `BEGIN-OF-OUTPUT\n${middle}\nEND-OF-OUTPUT` }];

	const small = spillOversizedToolResult(workspace, "spill-session", "bash", "small-call", [{ type: "text", text: "small" }]);
	check("a small result is not touched", small === undefined);

	const view = spillOversizedToolResult(workspace, "spill-session", "bash", "spill/call:1", content);
	check("an oversized result comes back as a view", view !== undefined);
	if (!view) return;
	const shown = view.find((block) => block.type === "text");
	const { absPath, relPath } = spillPathFor(workspace, "spill-session", "bash", "spill/call:1");
	const archived = existsSync(absPath) ? readFileSync(absPath, "utf8") : "";
	check("the full text is archived in the workspace", archived.startsWith("BEGIN-OF-OUTPUT") && archived.endsWith("END-OF-OUTPUT"), absPath);
	check("under the path the view names", archived.length > 0 && shown?.type === "text" && shown.text.includes(relPath), relPath);
	check("the view keeps the head", shown?.type === "text" && shown.text.startsWith("BEGIN-OF-OUTPUT"));
	check("and the tail", shown?.type === "text" && shown.text.endsWith("END-OF-OUTPUT"));
	check("and drops the middle", shown?.type === "text" && !shown.text.includes("line-5000"));
	check("and says how to read the rest", shown?.type === "text" && shown.text.includes("use the read tool"));

	const again = spillOversizedToolResult(workspace, "spill-session", "bash", "spill/call:1", content);
	check("a second pass reuses the archive without rewriting it", again !== undefined && existsSync(absPath));
}

function compactionSummaryText(message: unknown): string | undefined {
	return compactionSummaryOf(message as Message);
}
