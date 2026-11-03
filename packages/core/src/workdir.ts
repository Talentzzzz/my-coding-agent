import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

/**
 * How a tool path is read against the session's working directory.
 *
 * There is no fence here. A relative path is resolved against the working directory; an absolute one
 * is taken as it stands, wherever on the machine it points. That is the whole job: the directory
 * decides what a bare path means and where a command starts, and nothing about what the agent is
 * allowed to touch. A model asked to change one file on the machine next to the project has to be
 * able to say so.
 */

/**
 * Resolve a tool-supplied path: absolute stays absolute, relative joins the working directory.
 *
 * An empty path and an embedded NUL are refused because neither names a file — every other shape is
 * the caller's business, including `..` that walks out of the directory.
 */
export function resolveToolPath(workDirAbsPath: string, pathInput: string): string {
	if (pathInput.length === 0) throw new Error("Path must not be empty");
	if (pathInput.includes("\0")) throw new Error(`Invalid path: ${pathInput}`);
	return isAbsolute(pathInput) ? normalize(pathInput) : resolve(workDirAbsPath, pathInput);
}

/**
 * How a path is shown to the model and the window.
 *
 * Inside the working directory it reads as a relative path, because that is the name the model can
 * hand back to a tool and the name a reader compares against their project. Outside it, the absolute
 * path is the only honest answer: a `../../..` chain is shorter to compute and worse to read, and it
 * would imply the directory is still the frame of reference.
 */
export function displayToolPath(workDirAbsPath: string, absPath: string): string {
	const relPath = relative(workDirAbsPath, absPath);
	if (relPath.length === 0) return ".";
	if (relPath === ".." || relPath.startsWith(`..${sep}`) || isAbsolute(relPath)) return toSlashes(normalize(absPath));
	return toSlashes(relPath);
}

/** Forward slashes, so a path reads the same in a message on every platform. */
function toSlashes(path: string): string {
	return path.split(sep).join("/");
}
