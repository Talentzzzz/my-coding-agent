// 会话文件对的存储实现（分层重构 spec §4.4）：SessionRepository 端口的 11 个方法 + hold 闸 +
// removeGate 测试缝 + migrateLegacyStore + 文件对路径规则，全家住这一个文件——按存储域划分，
// 不按端口。
//
// hold 闸自 SessionManager 迁入（spec §7 步 5；ADR-0023 修订）：「此刻谁在改变这个会话文件对」的
// 签到表是存储实现自己的簿记——domain 连闸的存在都不知道，只见端口方法各自原子的承诺与
// `UnknownSessionError` 的拒绝。manager 的进闸出闸变成了端口方法的原子性；每个触碰文件对的方法
// 对该文件对原子，闸、closing、复活守卫是实现内部细节。
import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
// 实现消费 domain 声明的端口与词汇（infra → domain 是允许的边）：错误种类、格式版本、路径语义。
import {
	CURRENT_SESSION_VERSION,
	resolvePath,
	UnknownSessionError,
	type SessionEntry,
	type SessionLedgerFile,
	type SessionMeta,
	type SessionRepository,
} from "@my-agent/domain";

// ============================================================================
// 文件对路径规则（自 session/paths.ts 迁入，spec §2.3：文件对命名规则是存储布局知识）
// ============================================================================

/**
 * 一个 session id 所指的 `.jsonl` 条目流。
 *
 * id→路径规则唯一的安放处：store 里其他所有地方都问这里，不自己拼名字。`storeDir` 是它的 store，
 * **必填**——文件对布局契约的声明半在 domain 的 SessionRepository（诞生命名拼同一条规则），实现
 * 两侧同源。
 */
export function sessionPath(sessionId: string, storeDir: string): string {
	return join(storeDir, `${sessionId}.jsonl`);
}

/** `.jsonl` 在 `absJsonlPath` 的 session 的 `.json` 快照路径——两个文件共享 stem，按 stem 配对。 */
export function sessionMetaPath(absJsonlPath: string): string {
	return absJsonlPath.replace(/\.jsonl$/, ".json");
}

/** `.json` 在 `absJsonPath` 的 session 的 `.jsonl` 流路径——配对的另一半。 */
export function sessionJsonlPath(absJsonPath: string): string {
	return absJsonPath.replace(/\.json$/, ".jsonl");
}

/** 一次查找可以建 key 的路径：已解析，并在文件系统不区分大小写的地方同样折叠。 */
function absPathKey(absPath: string): string {
	const absResolved = resolvePath(absPath);
	return process.platform === "win32" ? absResolved.toLowerCase() : absResolved;
}

// ============================================================================
// 快照与账本的读半（fill 的两半，独立成法——spec §4.1 #4/#5）
// ============================================================================

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;

/** 解析一行 JSONL，失败返回 null：一行读不了不能让 session 其余部分也读不了。 */
function parseJsonlLine(line: string): SessionEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as SessionEntry;
	} catch {
		return null;
	}
}

/** 整体读取一个 session 的条目流。`absFilePath` 已由调用方解析。 */
function loadJsonlEntries(absFilePath: string): SessionEntry[] {
	if (!existsSync(absFilePath)) return [];

	const entries: SessionEntry[] = [];
	let pending = "";
	const fd = openSync(absFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);

		for (;;) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const entry = parseJsonlLine(pending.slice(lineStart, newlineIndex));
				if (entry) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		const finalEntry = parseJsonlLine(pending);
		if (finalEntry) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}

	// 没有结尾换行的最后一行会被下一次追加接上去。
	if (pending) appendFileSync(absFilePath, "\n");
	return entries;
}

/**
 * 读取 session 的 `.json` 快照，读不了就拒绝。
 *
 * 读不了的文件、缺身份字段的文件、版本不是本构建的文件，答案都一样：不是本构建的 session。拒绝
 * 意味着什么由调用方决定——fill 把它变成删掉再抛，发现环节变成跳过。
 *
 * 消息文本里的 "my-agent" 是 {@link SessionMeta} 的身份措辞（APP_NAME 自 domain 迁往组合根后的
 * 内联，分层重构 §2.3）。
 */
function readMetaFile(absJsonPath: string): SessionMeta {
	const raw = JSON.parse(readFileSync(absJsonPath, "utf8")) as SessionMeta;
	if (
		typeof raw?.id !== "string" ||
		typeof raw?.timestamp !== "string" ||
		typeof raw?.workDir !== "string" ||
		raw.workDir === ""
	) {
		throw new Error(`Session file is not a valid my-agent session: ${absJsonPath}`);
	}
	if (raw.version !== CURRENT_SESSION_VERSION) {
		throw new Error(`Session version ${String(raw.version)} is not this build's ${CURRENT_SESSION_VERSION}: ${absJsonPath}`);
	}
	return raw;
}

// ============================================================================
// prune 与发现冷半（fill 的卫生与 scanPairs 的实现）
// ============================================================================

/**
 * 删除本构建无法打开的 session 的两半文件。
 *
 * v5 不保留迁移也不隔离：被本构建拒绝的配对是一个永远无法再打开的 session，留着它会让每次列表都
 * 为一个幽灵付代价。触发点是 store 扫描和 fill——每个证明配对打不开的读者都移除它，store 保持是
 * 一个 session 清单，而不是同时还是一片坟场。
 */
function pruneSessionFiles(absJsonPath: string, absJsonlPath: string): void {
	try {
		rmSync(absJsonPath, { force: true });
	} catch {
		// 删除失败不能掩盖配对失败的原因；下一次扫描会再试。
	}
	try {
		rmSync(absJsonlPath, { force: true });
	} catch {
		// 同理：反正配对已死，下一次扫描清理这一轮没清掉的。
	}
}

/** 一个 stem 的两个文件，按 store 扫描所见。 */
interface SessionFilePair {
	absJson?: string;
	absJsonl?: string;
}

/**
 * 按 stem 配对一个 store 的文件，并移除本构建打不开的一切。
 *
 * session 是共享一个 stem 的 `.json` + `.jsonl` 配对，`.json` 是提交标记：诞生时它最后写入，所以
 * 未配对的半边是半途夭折的诞生，版本不是本构建的文件是上一代写下的文件。两者都在这里删除——扫描
 * 是唯一走遍每个文件的地方，所以也是唯一一处能不跑第二遍就淘汰打不开的配对的地方。
 *
 * 清除抓不到进行中的诞生：整个函数是一个同步块，诞生（createPair）也是一个同步块，一个进程从不同时
 * 跑两者——并发写入的情形不在格式的章程之内。
 */
function settleSessionFiles(absDir: string): { absJsonl: string; meta: SessionMeta }[] {
	const pairs = new Map<string, SessionFilePair>();
	for (const file of readdirSync(absDir)) {
		const dot = file.lastIndexOf(".");
		if (dot <= 0) continue;
		const ext = file.slice(dot);
		if (ext !== ".json" && ext !== ".jsonl") continue;
		const pair = pairs.get(file.slice(0, dot)) ?? {};
		if (ext === ".json") pair.absJson = join(absDir, file);
		else pair.absJsonl = join(absDir, file);
		pairs.set(file.slice(0, dot), pair);
	}

	const settled: { absJsonl: string; meta: SessionMeta }[] = [];
	for (const pair of pairs.values()) {
		if (pair.absJson === undefined || pair.absJsonl === undefined) {
			pruneSessionFiles(pair.absJson ?? "", pair.absJsonl ?? "");
			continue;
		}
		try {
			const meta = readMetaFile(pair.absJson);
			// 快照存在时流在法律上不可能是空的——诞生先写完整条日志再写快照——所以空流是半途夭折
			// 的配对。
			if (statSync(pair.absJsonl).size === 0) {
				pruneSessionFiles(pair.absJson, pair.absJsonl);
				continue;
			}
			settled.push({ absJsonl: pair.absJsonl, meta });
		} catch {
			pruneSessionFiles(pair.absJson, pair.absJsonl);
		}
	}
	return settled;
}

// ============================================================================
// 旧布局迁移（migrateLegacyStore 随迁，spec §4.4）
// ============================================================================

/**
 * 旧构建写入的遗留布局，跑过它的机器上仍然能找到：
 * `<storeDir>/--<dashed workDir>--/<ISO stamp>_<id>.jsonl`。扁平 store 读不了它——id 埋在文件名
 * 里、藏在时间戳后面——所以第一次触碰 store 时，把每个配对移进扁平根目录并忘掉那些文件夹。
 *
 * 什么都不删：本构建读不了的配对，或目标 id 已被已诞生 session 占用的配对，原地不动；文件夹只在
 * 什么都不剩时才移除。移动每个 store 实例发生一次、惰性触发，在第一个否则会错过遗留配对的查找或
 * 列表时进行——之后，locate 就是一次 stat。
 */
function migrateLegacyStore(storeDir: string): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(storeDir, { withFileTypes: true });
	} catch {
		return; // 没有 sessions 目录就是正常的首次运行。
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const absDir = join(storeDir, entry.name);
		if (!migrateLegacyDirectory(storeDir, absDir)) continue;
		try {
			rmdirSync(absDir);
		} catch {
			// 拿不走的空文件夹无害，不值得为它让启动失败。
		}
	}
}

/** 把 `absDir` 里的每个完整配对移进扁平 store；该目录里配对的东西都不剩时返回 true。 */
function migrateLegacyDirectory(storeDir: string, absDir: string): boolean {
	let names: string[];
	try {
		names = readdirSync(absDir);
	} catch {
		return false;
	}
	let empty = true;
	for (const name of names) {
		if (!name.endsWith(".json")) continue; // 每个配对按其快照（身份那一半）找到
		const absJson = join(absDir, name);
		const absJsonl = sessionJsonlPath(absJson);
		if (!existsSync(absJsonl)) continue;
		let id: string;
		try {
			id = readMetaFile(absJson).id;
		} catch {
			empty = false; // 读不了：store 扫描会清理它，这次移动不碰它
			continue;
		}
		const target = sessionPath(id, storeDir);
		if (existsSync(sessionMetaPath(target))) {
			empty = false; // 已诞生的 session 占用了这个 id：旧配对原地不动
			continue;
		}
		try {
			// 先移流，后移快照：两次 rename 之间目标处放着一个未配对的流，所有读者把它读成
			// 「没有这个 session」——绝不会读成半个诞生的 session。被早前中断的一轮遗落在那的流
			// 本来就是这个 id 自己的日志，所以 rename 之前清掉它不会让另一个 session 付出任何代价。
			rmSync(target, { force: true });
			renameSync(absJsonl, target);
			renameSync(absJson, sessionMetaPath(target));
		} catch {
			empty = false;
		}
	}
	return empty;
}

// ============================================================================
// removeGate 测试缝（随迁并保持模块级导出，spec §4.4 / ADR-0023 修订）
// ============================================================================

/**
 * 仅测试的接缝：挂在 remove 的两步 rm 之间，让冒烟测试能把删除钉在中间态上——闸内的写被拒、闸
 * 放行后盘上无残留，这些只有一次可控的删除才能观察得到。生产代码永远不设置它。模块级导出
 * （消费者 smoke-sessions 与 smoke-api 重指 `@my-agent/infra`），不给组合根的构造面添测试参数。
 */
let removeGate: (() => Promise<void>) | undefined;

/** 设置或清除 {@link removeGate}；传 `undefined` 即清除。 */
export function setRemoveGate(gate: (() => Promise<void>) | undefined): void {
	removeGate = gate;
}

// ============================================================================
// 存储实现
// ============================================================================

/** {@link SessionFileStore} 的构造 options：会话文件对所在的扁平 store 目录，绝对路径。 */
export interface SessionFileStoreOptions {
	/** store 根——`<id>.jsonl` 与 `<id>.json` 并排所在的目录。组合根递 `<settingsHome>/sessions`。 */
	storeDir: string;
}

/**
 * 会话文件对全家：SessionRepository 的 11 个方法，加上 hold 闸与旧布局迁移。
 *
 * 构造收 store 目录（组合根从 settingsHome 翻译而来，spec §5.1），目录按需创建——第一次诞生写入
 * 时（createPair），构造时不建，生产 home 布局零变化。
 */
export class SessionFileStore implements SessionRepository {
	/** 会话文件对所在的扁平 store 目录——布局契约的声明半（SessionRepository.storeDir）。 */
	readonly storeDir: string;

	/** 旧布局的惰性迁移只做一次：迁移过的 store 不再触碰遗留目录。 */
	private migrated = false;

	constructor(options: SessionFileStoreOptions) {
		this.storeDir = options.storeDir;
	}

	/** 旧布局迁移的惰性触发点：locate 与 scanPairs——两个否则会错过遗留配对的读取。 */
	private ensureStoreMigrated(): void {
		if (this.migrated) return;
		this.migrated = true;
		migrateLegacyStore(this.storeDir);
	}

	// ---------------------------------------------------------------- hold 闸

	/**
	 * 此刻谁在改变哪个会话文件对：按**文件键**键控的持有计数表。触碰一对文件的端口方法在自己的
	 * 长度内持闸，remove 是唯一跨 await 的持有者、闸罩它全程。
	 *
	 * 键是会话文件对的规范文件键：以 `.jsonl` 绝对路径经 {@link absPathKey}（resolvePath + win32
	 * 大小写折叠）折叠。id → 文件的解析只在进闸前做一次，此后簿记的领域里没有 id——锁的单位与它
	 * 保护的东西（同一 stem 的 `.json` + `.jsonl`）重合。进闸时发现 `closing` 在场（一次删除正跨着
	 * await），以 `UnknownSessionError` 拒绝——读作「没有这个会话」。同步方法的进出是瞬时的：
	 * 单线程进程里同步块不可被打断，它的意义不是互斥等待，而是与 `closing` 闸的相遇点。热读
	 * （readSnapshot / loadEntries / scanLedger）从不进闸；fill 是冷路径唯一的入口，做 I/O 且可能
	 * prune，所以进闸。
	 *
	 * 这张表是易失簿记——重启即空、不落盘、不可重建也不需重建（ADR-0023 修订：它自 SessionManager
	 * 迁入，成为存储实现自己的簿记）。它同时也是**存储原语缺失税**：文件系统没有「存在才写」的原子
	 * 原语（实证：`.scratch/fs-race-test/test.mjs`），「两个写入方不同时碰一对文件」只能靠一张进程内
	 * 的计数表补出来。换成事务型存储的那天——方法变事务、调用方一字不动——这张表该跟着消失。
	 */
	private readonly holds = new Map<string, { holds: number; closing?: Promise<void> }>();

	/**
	 * 进闸：文件键计数 +1；闸正被一次删除占着时，以「没有这个会话」拒绝。返回它立起的条目，让
	 * 唯一跨 await 的持有者（remove）在同一拍挂上 `closing`，而不必回头再查一次表。
	 */
	private enterHold(fileKey: string, sessionId: string): { holds: number; closing?: Promise<void> } {
		const entry = this.holds.get(fileKey);
		if (entry?.closing !== undefined) throw new UnknownSessionError(sessionId);
		const fresh = { holds: (entry?.holds ?? 0) + 1 };
		this.holds.set(fileKey, fresh);
		return fresh;
	}

	/** 出闸：宽容释放（无人持有的文件键无事发生）、归零删条目。 */
	private leaveHold(fileKey: string): void {
		const entry = this.holds.get(fileKey);
		if (entry === undefined) return;
		const remaining = Math.max(0, entry.holds - 1);
		if (remaining === 0) this.holds.delete(fileKey);
		else this.holds.set(fileKey, { holds: remaining });
	}

	/** 以文件键进门的同一层闸括号：进闸、动作、出闸在同一个同步块里完成，嵌套不存在。 */
	private holdingFileKey<T>(fileKey: string, sessionId: string, action: () => T): T {
		this.enterHold(fileKey, sessionId);
		try {
			return action();
		} finally {
			this.leaveHold(fileKey);
		}
	}

	/**
	 * 写前复核提交标记仍在——**复活守卫**：删除完成后陈旧调用方进闸时已撞不到 `closing`，闸条目随
	 * remove 的 finally 整条退场；没有这道复核，一次 append 会把 `.jsonl` 造回来、一次 writeSnapshot
	 * 会把 `.json` 造回去，被删的会话无声诈尸成半个会话。标记不在即以 `UnknownSessionError` 拒绝。
	 */
	private reviveGuard(absJsonl: string): void {
		if (!existsSync(sessionMetaPath(absJsonl))) {
			throw new UnknownSessionError(basename(absJsonl, ".jsonl"));
		}
	}

	// ---------------------------------------------------------------- 端口方法

	locate(id: string): string | undefined {
		this.ensureStoreMigrated();
		const absJsonl = sessionPath(id, this.storeDir);
		// 流旁边的 `.json` 快照是诞生的提交标记，它的存在才是「配对存在」的那一半。快照没了的名字
		// 回答 `undefined`，每个调用方读作「没有这个 session」；流没了的快照是一次半途夭折的诞生，
		// fill 被要求打开它时会清除。
		return existsSync(sessionMetaPath(absJsonl)) ? absJsonl : undefined;
	}

	isDeleting(id: string): boolean {
		const absPath = this.locate(id);
		if (absPath === undefined) return false;
		return this.holds.get(absPathKey(absPath))?.closing !== undefined;
	}

	fill(absPath: string): { meta: SessionMeta; entries: SessionEntry[] } {
		const resolved = resolvePath(absPath);
		// 路径可指两半中的任何一个：手里拿着 `.json` 的调用方传它，流在同一 stem 上找到。
		const absJsonl = resolved.endsWith(".json") ? sessionJsonlPath(resolved) : resolved;
		const absJson = sessionMetaPath(absJsonl);
		const id = basename(absJsonl, ".jsonl");
		try {
			return this.holdingFileKey(absPathKey(absJsonl), id, () => {
				if (!existsSync(absJsonl)) {
					// 无论如何都是未配对：清掉存在的半边，拒绝打开。
					if (existsSync(absJson)) pruneSessionFiles(absJson, absJsonl);
					throw new UnknownSessionError(id);
				}
				let meta: SessionMeta;
				try {
					meta = readMetaFile(absJson);
				} catch {
					pruneSessionFiles(absJson, absJsonl);
					throw new UnknownSessionError(id);
				}
				const entries = loadJsonlEntries(absJsonl);
				if (entries.length === 0) {
					// 快照存在时条目流在法律上不能是空的：诞生是两边一起写的，空流就是半途夭折的配对。
					// 和其他情况一样清掉。
					pruneSessionFiles(absJson, absJsonl);
					throw new UnknownSessionError(id);
				}
				return { meta, entries };
			});
		} catch (error) {
			// 撞闸（进闸时的 closing 在场）已经是正确的种类；其余的打开失败——契约 #2——也读作
			// 「没有这个会话」。
			if (error instanceof UnknownSessionError) throw error;
			throw new UnknownSessionError(id);
		}
	}

	readSnapshot(absPath: string): SessionMeta {
		const resolved = resolvePath(absPath);
		// 快照读半：不 prune、不进闸（读不拿锁）。打不开以普通错误拒绝——调用方决定怎么读它
		// （fork 的源半、recordedOnDisk、发现环节的尽力而为各不相同）。
		return readMetaFile(resolved.endsWith(".jsonl") ? sessionMetaPath(resolved) : resolved);
	}

	loadEntries(absPath: string): SessionEntry[] {
		const resolved = resolvePath(absPath);
		return loadJsonlEntries(resolved.endsWith(".json") ? sessionJsonlPath(resolved) : resolved);
	}

	createPair(absJsonl: string, entries: readonly SessionEntry[], meta: SessionMeta): void {
		const resolved = resolvePath(absJsonl);
		const id = basename(resolved, ".jsonl");
		// 诞生写入在闸内：两文件 `wx`、快照最后写（提交标记）——半途夭折的诞生留下未配对的半边，
		// 由 store 扫描清除而不是保留。
		this.holdingFileKey(absPathKey(resolved), id, () => {
			mkdirSync(dirname(resolved), { recursive: true });
			const fd = openSync(resolved, "wx");
			try {
				for (const entry of entries) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
			} catch (error) {
				// 没能落盘的流什么也不留下；下一次有闸门的写入从同一份内存日志重试诞生。
				closeSync(fd);
				rmSync(resolved, { force: true });
				throw error;
			}
			closeSync(fd);
			const absTemp = `${sessionMetaPath(resolved)}.${process.pid}.tmp`;
			const metaFd = openSync(absTemp, "wx");
			try {
				writeFileSync(metaFd, `${JSON.stringify(meta, null, "\t")}\n`);
			} finally {
				closeSync(metaFd);
			}
			renameSync(absTemp, sessionMetaPath(resolved));
		});
	}

	appendEntry(absJsonl: string, entry: SessionEntry): void {
		const resolved = resolvePath(absJsonl);
		// 复活守卫先于闸（与闸迁移前同一顺序）：已诞生的会话的追加一律以提交标记在场为前提。
		this.reviveGuard(resolved);
		this.holdingFileKey(absPathKey(resolved), basename(resolved, ".jsonl"), () => {
			appendFileSync(resolved, `${JSON.stringify(entry)}\n`);
		});
	}

	writeSnapshot(absJsonl: string, meta: SessionMeta): void {
		const resolved = resolvePath(absJsonl);
		this.reviveGuard(resolved);
		this.holdingFileKey(absPathKey(resolved), basename(resolved, ".jsonl"), () => {
			// 整体重写 `.json` 快照：写一个同目录的 temp 文件，再 rename 盖到快照上——读者要么看到
			// 旧快照要么看到新快照，绝不会看到撕裂的。
			const absJson = sessionMetaPath(resolved);
			const absTemp = `${absJson}.${process.pid}.tmp`;
			const fd = openSync(absTemp, "wx");
			try {
				writeFileSync(fd, `${JSON.stringify(meta, null, "\t")}\n`);
			} finally {
				closeSync(fd);
			}
			renameSync(absTemp, absJson);
		});
	}

	async remove(id: string): Promise<void> {
		this.ensureStoreMigrated();
		const absPath = this.locate(id);
		if (absPath === undefined) throw new UnknownSessionError(id);
		const fileKey = absPathKey(absPath);
		const entry = this.enterHold(fileKey, id);
		const closing = (async () => {
			// 两步 rm 的顺序是刻意的：先删 `.json`（诞生的提交标记），后删 `.jsonl`（流）。`.json`
			// 先走，两步 rm 之间到达的一切新写入方都查 meta、都读到「不存在」——中间态读作半途夭折
			// 的诞生，由既有扫描自愈。两步 rm 都带 `force`：扫描自愈可能在 rm 的 await 窗口里抢先
			// 清掉另一半——文件已被删掉就是删除已经达成。
			await rm(sessionMetaPath(absPath), { force: true });
			if (removeGate !== undefined) await removeGate();
			await rm(absPath, { force: true });
		})();
		entry.closing = closing;
		try {
			await closing;
		} finally {
			this.holds.delete(fileKey);
		}
	}

	async scanPairs(): Promise<{ absJsonl: string; meta: SessionMeta }[]> {
		this.ensureStoreMigrated();
		// 缺失或读不了的目录是正常的首次运行/不可读的 store：发现是尽力而为，回答空表（与迁移前的
		// existsSync 守卫 + try/catch 同一答案）。
		try {
			return settleSessionFiles(this.storeDir);
		} catch {
			return [];
		}
	}

	async scanLedger(
		absJsonl: string,
		visit: (entry: SessionEntry, file: SessionLedgerFile) => void,
		signal?: AbortSignal,
	): Promise<void> {
		const resolved = resolvePath(absJsonl);
		const file: SessionLedgerFile = { mtimeMs: (await stat(resolved)).mtimeMs };
		const lines = createInterface({
			input: createReadStream(resolved, { encoding: "utf8", signal }),
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		for await (const line of lines) {
			const entry = parseJsonlLine(line);
			if (entry) visit(entry, file);
		}
	}
}
