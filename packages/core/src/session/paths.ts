import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolve } from "node:path";
import { AGENT_HOME } from "../config.ts";

/**
 * Where sessions live:
 *
 * ```
 * <agent home>/sessions/<session id>.jsonl
 * <agent home>/sessions/<session id>.json
 * ```
 *
 * The store is flat, and the id **is** the address: `sessions/<id>.jsonl` is the only place a
 * session can be, so locating one is a stat rather than a walk of every directory. The project a
 * session belongs to is not in the path — it is in the snapshot's `workDir`, which is where a
 * listing reads it from anyway; a directory name that dashes a path into a folder name was readable
 * and not reversible, and it cost a full store scan per lookup.
 *
 * What the layout gives up is the chronological filename: a file manager now lists the store in id
 * order, which for a uuidv7 is creation order to the millisecond anyway.
 */
let sessionsRoot = join(AGENT_HOME, "sessions");

/** The directory every session file lives in. */
export function sessionsDir(): string {
	return sessionsRoot;
}

/**
 * Point the store somewhere else, for a test or an embedder that must not touch the machine's own
 * sessions. Process-wide and read at call time, so it has to be set before any session work — the
 * default is the agent home's `sessions`, and production never calls this.
 */
export function setSessionsDir(absDir: string): void {
	sessionsRoot = resolvePath(absDir);
}

/**
 * The `.jsonl` entry stream a session id names; `absDir` is its store, defaulting to this process's.
 *
 * The only place the id→path rule lives: everything else in the store asks this instead of building
 * a name of its own.
 */
export function sessionPath(sessionId: string, absDir: string = sessionsRoot): string {
	return join(absDir, `${sessionId}.jsonl`);
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
