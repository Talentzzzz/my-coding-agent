import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolve } from "node:path";
import { AGENT_HOME } from "../config.ts";

/**
 * Where sessions live, using pi's layout:
 *
 * ```
 * <agent home>/sessions/--<cwd with its separators dashed out>--/<ISO stamp>_<session id>.jsonl
 * ```
 *
 * One directory per workspace, named after the absolute workspace path rather than a hash, so the
 * folder is readable and a session file is traceable to the project it belongs to without opening it.
 * The file name leads with the creation stamp so a directory listing sorts chronologically.
 */
export function sessionsDir(): string {
	return join(AGENT_HOME, "sessions");
}

/** The directory name for one workspace's sessions. */
function workspaceDirName(workspaceRootInput: string): string {
	const absRoot = resolvePath(workspaceRootInput);
	return `--${absRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function workspaceDir(workspaceRootInput: string): string {
	return join(sessionsDir(), workspaceDirName(workspaceRootInput));
}

/** `absDir` is a session directory; `createdAt` is the ISO stamp the header carries. */
export function sessionPath(absDir: string, sessionId: string, createdAt: string): string {
	return join(absDir, `${createdAt.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
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
