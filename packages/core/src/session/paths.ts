import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolve } from "node:path";
import { AGENT_HOME } from "../config.ts";

/**
 * session 存放的位置：
 *
 * ```
 * <agent home>/sessions/<session id>.jsonl
 * <agent home>/sessions/<session id>.json
 * ```
 *
 * store 是扁平的，id **就是**地址：`sessions/<id>.jsonl` 是 session 唯一可能在的地方，定位一个
 * session 是一次 stat 而不是遍历所有目录。session 属于哪个项目不在路径里——在快照的 `workDir`
 * 里，列表反正也是从那里读的；把路径拆成文件夹名的目录命名方案可读但不可逆，而且每次查找都要全
 * store 扫描。
 *
 * 这个布局放弃的是按时间命名的文件名：文件管理器现在按 id 序列出 store，而 uuidv7 的 id 序本来就是
 * 毫秒级的创建顺序。
 */
let sessionsRoot = join(AGENT_HOME, "sessions");

/** 所有 session 文件所在的目录。 */
export function sessionsDir(): string {
	return sessionsRoot;
}

/**
 * 把 store 指到别处，给测试或不得触碰机器自身 session 的嵌入方用。进程级、调用时读取，所以必须在
 * 任何 session 工作之前设置——默认是 agent home 的 `sessions`，生产环境从不调用。
 */
export function setSessionsDir(absDir: string): void {
	sessionsRoot = resolvePath(absDir);
}

/**
 * 一个 session id 所指的 `.jsonl` 条目流；`absDir` 是它的 store，默认为本进程的。
 *
 * id→路径规则唯一的安放处：store 里其他所有地方都问这里，不自己拼名字。
 */
export function sessionPath(sessionId: string, absDir: string = sessionsRoot): string {
	return join(absDir, `${sessionId}.jsonl`);
}

/**
 * `.jsonl` 在 `absJsonlPath` 的 session 的 `.json` 快照路径。
 *
 * 两个文件共享 stem：快照是身份那一半，流是会话记录那一半，按 stem 配对才让 session 是一个
 * 东西而不是两个。
 */
export function sessionMetaPath(absJsonlPath: string): string {
	return absJsonlPath.replace(/\.jsonl$/, ".json");
}

/** `.json` 在 `absJsonPath` 的 session 的 `.jsonl` 流路径——配对的另一半。 */
export function sessionJsonlPath(absJsonPath: string): string {
	return absJsonPath.replace(/\.json$/, ".jsonl");
}

/** 把 Git Bash、MSYS、Cygwin 和 WSL 的盘符路径转换成原生 Windows API 接受的形式。 */
function normalizeWindowsShellPath(pathInput: string): string {
	if (!pathInput.startsWith("/") || pathInput.startsWith("//") || pathInput.includes("\\")) return pathInput;
	const match = pathInput.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return pathInput;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
}

/** 展开开头的 `~` 并规范化 shell 风格的盘符路径，其余不动。 */
export function normalizePath(pathInput: string): string {
	let normalized = pathInput;
	if (process.platform === "win32") normalized = normalizeWindowsShellPath(normalized);

	const home = homedir();
	if (normalized === "~") return home;
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return join(home, normalized.slice(2));
	}
	return normalized;
}

export function resolvePath(pathInput: string, baseDirInput: string = process.cwd()): string {
	const normalized = normalizePath(pathInput);
	const base = normalizePath(baseDirInput);
	return isAbsolute(normalized) ? nodeResolve(normalized) : nodeResolve(base, normalized);
}
