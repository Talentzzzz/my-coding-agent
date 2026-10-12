import { mkdirSync } from "node:fs";
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

/** The directory name for one workspace's sessions. Exported so a test can name it without creating it. */
export function workspaceDirName(workspaceRoot: string): string {
	const resolved = resolvePath(workspaceRoot);
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function workspaceDir(workspaceRoot: string): string {
	return join(sessionsDir(), workspaceDirName(workspaceRoot));
}

/** `dir` is a session directory; `createdAt` is the ISO stamp the header carries. */
export function sessionPath(dir: string, sessionId: string, createdAt: string): string {
	return join(dir, `${createdAt.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
}

export function ensureWorkspaceDir(workspaceRoot: string): string {
	const dir = workspaceDir(workspaceRoot);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Convert Git Bash, MSYS, Cygwin, and WSL drive paths to a form native Windows APIs accept. */
export function normalizeWindowsShellPath(filePath: string): string {
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return filePath;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
}

/** Expand a leading `~` and normalize shell-style drive paths, without touching the rest. */
export function normalizePath(input: string): string {
	let normalized = input;
	if (process.platform === "win32") normalized = normalizeWindowsShellPath(normalized);

	const home = homedir();
	if (normalized === "~") return home;
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return join(home, normalized.slice(2));
	}
	return normalized;
}

export function resolvePath(input: string, baseDir: string = process.cwd()): string {
	const normalized = normalizePath(input);
	const base = normalizePath(baseDir);
	return isAbsolute(normalized) ? nodeResolve(normalized) : nodeResolve(base, normalized);
}
