// Minimal dependency installer.
//
// npm 11.12.1 on this machine fails with "zlib: incorrect data check" on very large registry
// packuments (vite, @types/node), because its HTTP client mis-decodes those gzip responses.
// Node's own fetch handles the same URLs correctly, so this script resolves and unpacks the
// dependency tree itself. It is a build-time workaround, not part of the agent: once npm works
// again, `npm install` replaces it.

import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = "https://registry.npmjs.org";
const cache = join(root, ".npm-tarball-cache");

const workspaces = ["packages/ai", "packages/agent", "packages/core", "packages/server", "packages/web", "packages/desktop", "."];

async function main(): Promise<void> {
	await mkdir(cache, { recursive: true });
	const installed = new Map();
	const filter = process.argv[2];

	for (const workspace of workspaces) {
		if (filter !== undefined && workspace !== filter && !filter.startsWith("packages/")) continue;
		const manifest = await readManifest(join(root, workspace));
		const names = [
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.devDependencies ?? {}),
		].filter((name) => !name.startsWith("@my-agent/"));

		const modulesDir = join(root, workspace, "node_modules");
		await mkdir(modulesDir, { recursive: true });

		for (const name of names) {
			const range = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name] ?? "latest";
			await install(name, range, modulesDir, installed);
			await linkBins(join(modulesDir, ...name.split("/")), modulesDir);
		}
		process.stdout.write(`installed ${names.length} direct dependencies for ${workspace}\n`);
	}

	await linkWorkspaces();
}

/**
 * Link every workspace package into the repository root's `node_modules/@my-agent`.
 *
 * npm would do this for workspaces; the unpacking above replaces npm, so the links are made here.
 * Node resolves `@my-agent/*` imports by walking up from the importing file to this directory.
 */
async function linkWorkspaces(): Promise<void> {
	const scopeDir = join(root, "node_modules", "@my-agent");
	await mkdir(scopeDir, { recursive: true });
	for (const workspace of workspaces) {
		if (workspace === ".") continue;
		const manifest = await readManifest(join(root, workspace));
		if (!manifest.name?.startsWith("@my-agent/")) continue;
		const link = join(scopeDir, manifest.name.slice("@my-agent/".length));
		try {
			await rm(link, { recursive: true });
		} catch {
			// nothing linked yet
		}
		await symlink(join(root, workspace), link, "junction");
	}
}

/**
 * Create the `node_modules/.bin` shims npm would normally write.
 *
 * Without these, `npm run <script>` cannot find `vite`, `tsc`, or any other tool the scripts call.
 */
async function linkBins(packageDir: string, modulesDir: string): Promise<void> {
	let manifest: { name?: string; bin?: string | Record<string, string> };
	try {
		manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as typeof manifest;
	} catch {
		return;
	}
	const bin = manifest.bin;
	if (bin === undefined) return;

	const entries: [string, string][] =
		typeof bin === "string" ? [[manifest.name ?? "", bin]] : Object.entries(bin);

	const binDir = join(modulesDir, ".bin");
	await mkdir(binDir, { recursive: true });
	for (const [name, relative] of entries) {
		if (name.length === 0) continue;
		const script = join(packageDir, relative);
		if (!existsSync(script)) continue;
		await writeFile(join(binDir, `${name}.cmd`), `@ECHO off\r\nnode "${script}" %*\r\n`, "utf8");
		await writeFile(join(binDir, `${name}.ps1`), `#!/usr/bin/env pwsh\nnode "${script}" $args\nexit $LASTEXITCODE\n`, "utf8");
		const shim = join(binDir, name);
		await writeFile(shim, `#!/bin/sh\nexec node "${script}" "$@"\n`, "utf8");
		if (process.platform !== "win32") await chmod(shim, 0o755);
	}
}

interface Manifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

async function readManifest(directory: string): Promise<Manifest> {
	return JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as Manifest;
}

async function install(
	name: string,
	range: string,
	modulesDir: string,
	installed: Map<string, string>,
): Promise<void> {
	const key = `${modulesDir}\u0000${name}`;
	const already = installed.get(key);
	const target = join(modulesDir, ...name.split("/"));

	if (already !== undefined || existsSync(join(target, "package.json"))) {
		const version = await installedVersion(target);
		if (already !== undefined || satisfies(version, range)) return;
	}

	const packument = await fetchJson(`${registry}/${encodeURIComponent(name)}`);
	const version = pickVersion(packument, range);
	if (!version) throw new Error(`No version of ${name} satisfies ${range}`);

	const manifest = packument.versions[version];
	const tarball = manifest.dist?.tarball;
	if (typeof tarball !== "string") throw new Error(`No tarball for ${name}@${version}`);

	process.stdout.write(`  ${name}@${version}\n`);
	await extract(await download(tarball), target);
	installed.set(key, version);

	const dependencies: Record<string, string> = { ...(manifest.dependencies ?? {}) };

	// Optional dependencies carry the prebuilt native binaries (esbuild, rolldown). Install the ones
	// that match this platform and skip the rest.
	for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {})) {
		if (await platformMatches(name, range)) dependencies[name] = range;
	}

	for (const [dependency, dependencyRange] of Object.entries(dependencies)) {
		// Nested install: the package resolves its own tree when the hoisted copy does not fit.
		await installNested(dependency, dependencyRange, modulesDir, installed);
	}
}

/** True when an optional dependency declares no platform restriction, or one this machine satisfies. */
async function platformMatches(name: string, range: string): Promise<boolean> {
	let manifest: { os?: string[]; cpu?: string[] };
	try {
		const packument = await fetchJson(`${registry}/${encodeURIComponent(name)}`);
		const version = pickVersion(packument, range);
		if (!version) return false;
		manifest = packument.versions[version] ?? {};
	} catch {
		return false;
	}

	const os = manifest.os ?? [];
	const cpu = manifest.cpu ?? [];
	const osOk = os.length === 0 || os.some((entry) => entry === process.platform);
	const cpuOk = cpu.length === 0 || cpu.some((entry) => entry === process.arch);
	return osOk && cpuOk;
}

/**
 * Install a dependency of something already unpacked inside `modulesDir`.
 *
 * Reuse wins: Node looks in every `node_modules` on the way up, so an already present compatible
 * copy is all that is needed. Only a real mismatch adds a nested copy.
 */
async function installNested(
	name: string,
	range: string,
	modulesDir: string,
	installed: Map<string, string>,
): Promise<void> {
	const hoisted = findHoisted(dirname(modulesDir), name);
	if (hoisted) {
		const version = await installedVersion(hoisted);
		if (satisfies(version, range)) return;
	}
	await install(name, range, modulesDir, installed);
}

/** Walk up the tree looking for an already installed copy, the way Node resolves modules. */
function findHoisted(from: string, name: string): string | undefined {
	let current = from;
	for (;;) {
		const candidate = join(current, "node_modules", ...name.split("/"));
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

async function installedVersion(directory: string): Promise<string> {
	try {
		const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { version?: string };
		return manifest.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

interface Packument {
	"dist-tags"?: Record<string, string>;
	versions: Record<string, { dist?: { tarball?: string }; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>;
}

async function fetchJson(url: string): Promise<Packument> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const response = await fetch(url, { headers: { accept: "application/json" } });
			if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
			return (await response.json()) as Packument;
		} catch (error) {
			if (attempt === 2) throw error;
			await new Promise((done) => setTimeout(done, 500 * (attempt + 1)));
		}
	}
	throw new Error(`unreachable: ${url}`);
}

async function download(url: string): Promise<string> {
	const file = join(cache, url.slice(url.lastIndexOf("/") + 1));
	if (existsSync(file)) return file;
	const response = await fetch(url);
	if (!response.ok || !response.body) throw new Error(`Cannot download ${url}: ${response.status}`);
	await pipeline(response.body, createWriteStream(file));
	return file;
}

async function extract(tarball: string, target: string): Promise<void> {
	// Windows ships bsdtar as tar.exe; --strip-components drops the leading "package/" directory.
	// On this machine tar occasionally reports a missing target directory, so create the parents
	// explicitly and retry once.
	await mkdir(dirname(target), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await rm(target, { recursive: true, force: true });
		await mkdir(target, { recursive: true });
		try {
			await run("tar", ["-xzf", tarball, "-C", target, "--strip-components", "1"], {
				maxBuffer: 32 * 1024 * 1024,
				windowsHide: true,
			});
			if (existsSync(join(target, "package.json"))) return;
		} catch (error) {
			if (attempt === 1) throw error;
		}
		await new Promise((done) => setTimeout(done, 200));
	}
	throw new Error(`Failed to extract ${tarball} into ${target}`);
}

function pickVersion(packument: Packument, range: string): string | undefined {
	if (range.startsWith("workspace:") || range.startsWith("file:")) return undefined;
	const wantsPrerelease = /-\w/.test(range);
	const versions = Object.keys(packument.versions)
		.filter((version) => wantsPrerelease || !version.includes("-"))
		.filter((version) => satisfies(version, range));
	if (versions.length === 0) return packument["dist-tags"]?.latest;
	versions.sort(compareVersions);
	return versions[versions.length - 1];
}

function compareVersions(a: string, b: string): number {
	const left = parse(a);
	const right = parse(b);
	for (let index = 0; index < 3; index += 1) {
		const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	if (left.prerelease === right.prerelease) return 0;
	if (left.prerelease === "") return 1;
	if (right.prerelease === "") return -1;
	return left.prerelease.localeCompare(right.prerelease);
}

function parse(version: string): { parts: number[]; prerelease: string } {
	const [core = "0.0.0", prerelease = ""] = version.split("-", 2);
	return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), prerelease };
}

/** Semver subset: exact, ^, ~, >=, >, <=, <, ||, x-ranges, and hyphen ranges. */
function satisfies(version: string, range: string): boolean {
	const trimmed = range.trim();
	if (trimmed === "" || trimmed === "*" || trimmed === "latest") return true;
	return trimmed
		.split("||")
		.some((alternative) => alternative.trim().split(/\s+/).every((part) => satisfiesPart(version, part.trim())));
}

function satisfiesPart(version: string, part: string): boolean {
	if (part === "" || part === "*") return true;

	const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(part);
	if (hyphen) return compareVersions(version, hyphen[1] ?? "0.0.0") >= 0 && compareVersions(version, hyphen[2] ?? "0.0.0") <= 0;

	const match = /^(\^|~|>=|<=|>|<|=)?\s*v?(\S+)$/.exec(part);
	if (!match) return true;
	const operator = match[1] ?? "=";
	const target = match[2] ?? "0.0.0";
	const current = parse(version);
	const wanted = parse(target);

	switch (operator) {
		case "^": {
			const upper =
				wanted.parts[0] === 0
					? wanted.parts[1] === 0
						? `0.0.${(wanted.parts[2] ?? 0) + 1}`
						: `0.${(wanted.parts[1] ?? 0) + 1}.0`
					: `${(wanted.parts[0] ?? 0) + 1}.0.0`;
			return compareVersions(version, target) >= 0 && compareVersions(version, upper) < 0;
		}
		case "~": {
			const upper = `${wanted.parts[0] ?? 0}.${(wanted.parts[1] ?? 0) + 1}.0`;
			return compareVersions(version, target) >= 0 && compareVersions(version, upper) < 0;
		}
		case ">=":
			return compareVersions(version, target) >= 0;
		case ">":
			return compareVersions(version, target) > 0;
		case "<=":
			return compareVersions(version, target) <= 0;
		case "<":
			return compareVersions(version, target) < 0;
		default:
			// x-ranges such as 1.x or 1.2.x
			if (target.includes("x") || target.includes("*")) {
				const parts = target.split(".");
				return parts.every((part, index) => part === "x" || part === "*" || part === String(current.parts[index] ?? 0));
			}
			return current.parts[0] === wanted.parts[0] &&
				current.parts[1] === wanted.parts[1] &&
				current.parts[2] === wanted.parts[2] &&
				current.prerelease === wanted.prerelease;
	}
}

await main();
