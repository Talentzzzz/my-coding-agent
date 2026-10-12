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
	/** Root with its original casing, for display and for shell working directories. */
	readonly root: string;
	readonly name: string;
	/** Comparison key: canonicalized, and lowercased on Windows. */
	private readonly key: string;

	constructor(root: string) {
		this.root = resolve(root);
		this.name = basename(this.root) || this.root;
		this.key = canonicalize(this.root);
	}

	/** Resolve a tool-supplied path to an absolute path inside the workspace. */
	resolve(input: string): string {
		if (input.length === 0) throw new Error("Path must not be empty");
		if (input.includes("\0")) throw new Error(`Invalid path: ${input}`);

		const candidate = isAbsolute(input) ? normalize(input) : resolve(this.root, input);
		if (!this.contains(candidate)) {
			throw new Error(`Path escapes the workspace (${this.root}): ${input}`);
		}
		return candidate;
	}

	/** Path relative to the workspace root, with forward slashes, for display. */
	display(absolute: string): string {
		const rel = relative(this.root, absolute);
		if (rel.length === 0) return ".";
		return rel.split(sep).join("/");
	}

	/** True when `absolute` is the root itself or lives under it. */
	contains(absolute: string): boolean {
		const target = canonicalize(absolute);
		if (target === this.key) return true;
		return target.startsWith(this.key.endsWith(sep) ? this.key : this.key + sep);
	}

	exists(absolute: string): boolean {
		return existsSync(absolute);
	}
}

/**
 * Canonicalize a path for comparison, following symlinks when the path exists.
 * Windows paths are case-insensitive, so casing differences must not produce false mismatches.
 */
function canonicalize(absolute: string): string {
	let result = absolute;
	if (existsSync(absolute)) {
		try {
			result = realpathSync.native(absolute);
		} catch {
			result = absolute;
		}
	}
	return process.platform === "win32" ? result.toLowerCase() : result;
}

