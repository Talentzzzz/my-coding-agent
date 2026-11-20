// SessionDefaults smoke：对一个临时 agent home 驱动 SessionManager 新增的会话簇设置面——
// `sessions.json`（两条队列的全局默认模式）与它的读时迁移。写入经由 SessionManager 完成，再用对
// 相同路径的*全新*读读回，因此必须能穿过 JSON.stringify → parse 回来。
// 旧 `settings.json` 在这里是迁移源：它只被捡走自己的簇，此后被完全忽略——永不删除、永不写入。
// 这里不触网，无需服务器和 provider key。
// 运行：node scripts/smoke-session-settings.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, SessionManager, settingsPath, type Session } from "@my-agent/core";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/** 会话簇自己的文件，位于 manager 的 home 下。 */
function sessionsPathOf(home: string): string {
	return join(home, "sessions.json");
}

/** 读盘上的 sessions.json（存在时），供对文件本身的断言使用。 */
function diskSessions(home: string): Record<string, unknown> {
	return JSON.parse(readFileSync(sessionsPathOf(home), "utf8")) as Record<string, unknown>;
}

// ------------------------------------------------- 1. 读时迁移：旧文件的簇被捡走

process.stdout.write("\nsessions：settings.json 里的队列模式被一次性捡进 sessions.json\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-session-defaults-"));
	try {
		// 旧世界的文件：会话簇的两个字段混在整份 global 设置里。
		const legacy = {
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			model: "a/b",
			appearance: { theme: "dark", fontSize: 15 },
		};
		writeFileSync(settingsPath(home), `${JSON.stringify(legacy, null, "\t")}\n`, "utf8");
		const legacyOnDisk = readFileSync(settingsPath(home), "utf8");

		const manager = new SessionManager(home);
		const view = manager.sessionDefaults();
		check("steeringMode 从旧文件回来", view.steeringMode === "all", JSON.stringify(view));
		check("followUpMode 从旧文件回来", view.followUpMode === "one-at-a-time", JSON.stringify(view));

		// 迁移落盘的是补默认后的视图，也只有自己的簇：别的字段留在它们自己的持有者那里。
		const migrated = diskSessions(home);
		check("sessions.json 已落盘且写着捡走的值", migrated.steeringMode === "all" && migrated.followUpMode === "one-at-a-time", JSON.stringify(migrated));
		check("别的簇没有跟着搬", !("model" in migrated) && !("appearance" in migrated), JSON.stringify(migrated));

		// 旧文件只读不写：迁移前后一个字节都不动，删除更无从谈起。
		check("旧 settings.json 原封不动", readFileSync(settingsPath(home), "utf8") === legacyOnDisk);

		// 一次性：sessions.json 已在之后，旧文件被完全忽略——对它的手编改变不了答案。
		writeFileSync(settingsPath(home), `${JSON.stringify({ ...legacy, steeringMode: "one-at-a-time" }, null, "\t")}\n`, "utf8");
		check("迁移完成后旧文件被忽略", manager.sessionDefaults().steeringMode === "all", manager.sessionDefaults().steeringMode);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// --------------------------------- 2. 全缺省（与坏值）也落盘：把「迁移过」变成磁盘事实

process.stdout.write("\nsessions：旧文件没有簇字段时也写出补默认的文件，坏值回落默认\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-session-defaults-"));
	try {
		// 旧文件存在但没有任何队列字段——迁移照样发生，视图补上两个默认值。
		writeFileSync(settingsPath(home), `${JSON.stringify({ model: "a/b" }, null, "\t")}\n`, "utf8");
		const legacyOnDisk = readFileSync(settingsPath(home), "utf8");

		const manager = new SessionManager(home);
		const view = manager.sessionDefaults();
		check("缺省的 steeringMode 补上默认", view.steeringMode === "one-at-a-time", JSON.stringify(view));
		check("缺省的 followUpMode 补上默认", view.followUpMode === "one-at-a-time", JSON.stringify(view));
		check("字段全缺省也写出了 sessions.json", existsSync(sessionsPathOf(home)));
		const migrated = diskSessions(home);
		check("落盘的就是补默认后的视图", migrated.steeringMode === "one-at-a-time" && migrated.followUpMode === "one-at-a-time", JSON.stringify(migrated));
		check("旧文件依旧原封不动", readFileSync(settingsPath(home), "utf8") === legacyOnDisk);

		// 手编的坏值被吸收而不是被采信：不是两种队列模式的取值回落默认。
		const bad = mkdtempSync(join(tmpdir(), "my-agent-session-defaults-"));
		try {
			writeFileSync(settingsPath(bad), `${JSON.stringify({ steeringMode: "garbage", followUpMode: 42 }, null, "\t")}\n`, "utf8");
			const badView = new SessionManager(bad).sessionDefaults();
			check("坏值回落到默认", badView.steeringMode === "one-at-a-time" && badView.followUpMode === "one-at-a-time", JSON.stringify(badView));
		} finally {
			rmSync(bad, { recursive: true, force: true });
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// --------------------------------- 3. sessions.json 已在：旧文件从第一拍起就被忽略

process.stdout.write("\nsessions：sessions.json 已存在时旧文件被完全忽略\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-session-defaults-"));
	try {
		// 两份文件并存且答案相反：自己的文件赢。
		writeFileSync(sessionsPathOf(home), `${JSON.stringify({ steeringMode: "all" }, null, "\t")}\n`, "utf8");
		writeFileSync(settingsPath(home), `${JSON.stringify({ steeringMode: "one-at-a-time" }, null, "\t")}\n`, "utf8");
		const manager = new SessionManager(home);
		check("自己的文件赢过旧文件", manager.sessionDefaults().steeringMode === "all", manager.sessionDefaults().steeringMode);
		// 缺的键补默认，而不是向旧文件求援。
		check("缺的键补默认", manager.sessionDefaults().followUpMode === "one-at-a-time", manager.sessionDefaults().followUpMode);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// --------------------------------- 4. applySessionDefaults：只动点名，未知键原样保留

process.stdout.write("\nsessions：补丁只动点名的键，文件里的其他东西原样保留\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-session-defaults-"));
	try {
		writeFileSync(sessionsPathOf(home), `${JSON.stringify({ steeringMode: "all", handWritten: { note: "手编" } }, null, "\t")}\n`, "utf8");
		const manager = new SessionManager(home);

		manager.applySessionDefaults({ followUpMode: "all" });
		const onDisk = diskSessions(home);
		check("点名的键换了值", onDisk.followUpMode === "all", JSON.stringify(onDisk));
		check("没点名的键原地不动", onDisk.steeringMode === "all", JSON.stringify(onDisk));
		check("未知键原样保留", JSON.stringify(onDisk.handWritten) === JSON.stringify({ note: "手编" }), JSON.stringify(onDisk));

		// 空补丁什么都不做：连文件都不该被造出来。
		const untouched = mkdtempSync(join(tmpdir(), "my-agent-session-defaults-"));
		try {
			new SessionManager(untouched).applySessionDefaults({});
			check("空补丁不写盘", !existsSync(sessionsPathOf(untouched)));
		} finally {
			rmSync(untouched, { recursive: true, force: true });
		}

		// 写下去当场可读，第二只 manager 也以盘上的文件作答。
		check("写下去当场可读", manager.sessionDefaults().followUpMode === "all", manager.sessionDefaults().followUpMode);
		check("另一只 manager 读到同一份", new SessionManager(home).sessionDefaults().followUpMode === "all");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// --------------------------------- 5. 写前重读：手编不被一次无关的变更回滚

process.stdout.write("\nsessions：写入只落在文件此刻持有的内容之上（写前重读）\n");

{
	const home = mkdtempSync(join(tmpdir(), "my-agent-session-defaults-"));
	try {
		const manager = new SessionManager(home);
		manager.applySessionDefaults({ steeringMode: "all" });

		// 进程运行期间，用户用编辑器改了盘上的文件。
		writeFileSync(sessionsPathOf(home), `${JSON.stringify({ steeringMode: "one-at-a-time", handWritten: true }, null, "\t")}\n`, "utf8");

		// 这次补丁只点名 followUpMode：手编的 steeringMode 必须幸存。
		manager.applySessionDefaults({ followUpMode: "all" });
		const onDisk = diskSessions(home);
		check("手编的值在写前被重读回来", onDisk.steeringMode === "one-at-a-time", JSON.stringify(onDisk));
		check("点名的键照常落盘", onDisk.followUpMode === "all", JSON.stringify(onDisk));
		check("手编的未知键也幸存", onDisk.handWritten === true, JSON.stringify(onDisk));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// --------------------------------- 6. 零参构造行为不变；家与家互相隔绝

process.stdout.write("\nsessions：零参 new SessionManager() 照旧可用，家之间互不串门\n");

{
	const workRoot = mkdtempSync(join(tmpdir(), "my-agent-session-defaults-work-"));
	const homeA = mkdtempSync(join(tmpdir(), "my-agent-session-defaults-a-"));
	const homeB = mkdtempSync(join(tmpdir(), "my-agent-session-defaults-b-"));
	try {
		// 现有调用点（assembly、session-factory、各 smoke）的零参构造一字不改，袋式方法照常工作。
		const zeroArg = new SessionManager();
		const bag: Session = createSession(workRoot, join(workRoot, "store"));
		zeroArg.setThinkingLevel(bag, "high");
		check("零参构造的门面照常工作", zeroArg.getRecordedToolConfig(bag).mode === undefined);

		// home 是构造参数：建在另一个家上的 manager 读那个家的文件，永远不以这个家的作答。
		writeFileSync(sessionsPathOf(homeA), `${JSON.stringify({ steeringMode: "all" }, null, "\t")}\n`, "utf8");
		check("A 家读到自己文件里的值", new SessionManager(homeA).sessionDefaults().steeringMode === "all");
		check("B 家读不到 A 家的文件", new SessionManager(homeB).sessionDefaults().steeringMode === "one-at-a-time");
	} finally {
		rmSync(workRoot, { recursive: true, force: true });
		rmSync(homeA, { recursive: true, force: true });
		rmSync(homeB, { recursive: true, force: true });
	}
}

process.stdout.write(failures === 0 ? "\nsession settings ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
