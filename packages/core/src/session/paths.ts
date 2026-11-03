import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolve } from "node:path";
import { AGENT_HOME } from "../config.ts";

/**
 * Where sessions live, using pi's layout:
 *
 * ```
 * <agent home>/sessions/--<workDir with its separators dashed out>--/<ISO stamp>_<session id>.jsonl
 * ```
 *
 * One directory per working directory, named after its absolute path rather than a hash, so the
 * folder is readable and a session file is traceable to the project it belongs to without opening it.
 * The file name leads with the creation stamp so a directory listing sorts chronologically.
 */
export function sessionsDir(): string {
	return join(AGENT_HOME, "sessions");
}

/** The directory name for one working directory's sessions. */
function sessionDirName(workDirAbsPath: string): string {
	const absWorkDir = resolvePath(workDirAbsPath);
	return `--${absWorkDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Where the sessions started in `workDirAbsPath` are stored. */
export function sessionDir(workDirAbsPath: string): string {
	return join(sessionsDir(), sessionDirName(workDirAbsPath));
}

/** `absDir` is a session directory; `createdAt` is the ISO stamp the header carries. */
export function sessionPath(absDir: string, sessionId: string, createdAt: string): string {
	return join(absDir, `${createdAt.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
}

/**
 * The `.json` snapshot's path for a session whose `.jsonl` is `absJsonlPath`.
 *
 * The two files share a stem: the snapshot is the identity half, the stream the transcript half,
 * and pairing them by stem is what makes a session one thing rather than two.
 */
export function sessionMetaPath(absJsonlPath: string): string {
	return absJsonlPath.replace(/\.jsonl$/, ".json");
}

/** The `.jsonl` stream's path for a session whose `.json` is `absJsonPath` — the pairing's other half. */
export function sessionJsonlPath(absJsonPath: string): string {
	return absJsonPath.replace(/\.json$/, ".jsonl");
}

/** Convert Git Bash, MSYS, Cygwin, and WSL drive paths to a form native Windows APIs accept. */
function normalizeWindowsShellPath(pathInput: string): string {
	if (!pathInput.startsWith("/") || pathInput.startsWith("//") || pathInput.includes("\\")) return pathInput;
	const match = pathInput.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return pathInput;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
}

/** Expand a leading `~` and normalize shell-style drive paths, without touching the rest. */
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
