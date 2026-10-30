import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, normalize, relative, resolve, sep } from "node:path";

/** How to launch a shell command on this platform. */
export interface Launcher {
	file: string;
	args: string[];
}

export function defaultLauncher(): Launcher {
	if (process.platform === "win32") {
		return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] };
	}
	return { file: process.env.SHELL ?? "/bin/sh", args: ["-c"] };
}

/**
 * The directory the agent is allowed to touch.
 *
 * Every tool path goes through {@link Workspace.resolve}, so a tool cannot read or write outside
 * the workspace even when the model asks for `../../etc/passwd`. Absolute paths inside the
 * workspace are accepted; absolute paths outside it are rejected.
 */
export class Workspace {
	/** The root, absolute, with its original casing — for display and for shell working directories. */
	readonly absRoot: string;
	/** The folder's own name, for a label; not a path. */
	readonly name: string;
	/** Comparison key: canonicalized, and lowercased on Windows. */
	private readonly key: string;

	constructor(rootInput: string) {
		this.absRoot = resolve(rootInput);
		this.name = basename(this.absRoot) || this.absRoot;
		this.key = canonicalize(this.absRoot);
	}

	/** Resolve a tool-supplied path to an absolute path inside the workspace. */
	resolve(pathInput: string): string {
		if (pathInput.length === 0) throw new Error("Path must not be empty");
		if (pathInput.includes("\0")) throw new Error(`Invalid path: ${pathInput}`);

		const absCandidate = isAbsolute(pathInput) ? normalize(pathInput) : resolve(this.absRoot, pathInput);
		if (!this.contains(absCandidate)) {
			throw new Error(`Path escapes the workspace (${this.absRoot}): ${pathInput}`);
		}
		return absCandidate;
	}

	/** Path relative to the workspace root, with forward slashes, for display. */
	display(absPath: string): string {
		const relPath = relative(this.absRoot, absPath);
		if (relPath.length === 0) return ".";
		return relPath.split(sep).join("/");
	}

	/** True when `absPath` is the root itself or lives under it. */
	contains(absPath: string): boolean {
		const absTarget = canonicalize(absPath);
		if (absTarget === this.key) return true;
		return absTarget.startsWith(this.key.endsWith(sep) ? this.key : this.key + sep);
	}

	exists(absPath: string): boolean {
		return existsSync(absPath);
	}
}

/**
 * Canonicalize a path for comparison, following symlinks when the path exists.
 * Windows paths are case-insensitive, so casing differences must not produce false mismatches.
 */
function canonicalize(absPath: string): string {
	let result = absPath;
	if (existsSync(absPath)) {
		try {
			result = realpathSync.native(absPath);
		} catch {
			result = absPath;
		}
	}
	return process.platform === "win32" ? result.toLowerCase() : result;
}

