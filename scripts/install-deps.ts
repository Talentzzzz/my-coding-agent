// 极简依赖安装器。
//
// 本机上的 npm 11.12.1 在处理超大 registry packument（vite、@types/node）时报
// "zlib: incorrect data check"——它的 HTTP 客户端对那些 gzip 响应解码有误。Node 自带的 fetch 能
// 正确处理同样的 URL，所以这个脚本自己解析并解开依赖树。它是构建期的权宜之计，不是 agent 的
// 一部分：npm 恢复正常后，`npm install` 就把它换掉。

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
const registry = process.env.NPM_REGISTRY ?? "https://registry.npmjs.org";
const cache = join(root, ".npm-tarball-cache");

const workspaces = [
	"packages/core",
	"packages/server",
	"packages/web",
	"packages/desktop",
	"packages/app",
	"packages/trigger",
	"packages/case",
	"packages/domain",
	"packages/infra",
	".",
];

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
 * 把每个 workspace 包链接到仓库根的 `node_modules/@my-agent`。
 *
 * npm 本来会为 workspaces 做这件事；上面的解包替代了 npm，所以链接在这里建立。Node 解析
 * `@my-agent/*` import 时从导入文件一路向上走到这个目录。
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
 * 建立 npm 本来会写的 `node_modules/.bin` shim。
 *
 * 没有它们，`npm run <script>` 找不到 `vite`、`tsc` 或脚本调用的任何其他工具。
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

	// 可选依赖携带预构建的原生二进制（esbuild、rolldown）。安装与本平台匹配的那些，跳过其余。
	for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {})) {
		if (await platformMatches(name, range)) dependencies[name] = range;
	}

	for (const [dependency, dependencyRange] of Object.entries(dependencies)) {
		// 嵌套安装：提升的那份不符合时，包解析自己的树。
		await installNested(dependency, dependencyRange, modulesDir, installed);
	}
}

/** 可选依赖未声明平台限制、或本机满足其声明时为真。 */
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
 * 安装 `modulesDir` 内已解包某个包的依赖。
 *
 * 复用优先：Node 会向上查找每一层 `node_modules`，所以一个已存在的兼容副本就足够了。只有真正
 * 不匹配才添加嵌套副本。
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

/** 沿树向上找已安装的副本，与 Node 解析模块的方式一致。 */
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
	// Windows 自带 bsdtar 即 tar.exe；--strip-components 去掉开头的 "package/" 目录。
	// 本机的 tar 偶尔报目标目录不存在，所以显式创建父目录并重试一次。
	await mkdir(dirname(target), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await rm(target, { recursive: true, force: true });
		await mkdir(target, { recursive: true });
		try {
			// --force-local + 正斜杠：Git Bash 的 GNU tar 把 `Z:\` 的盘符冒号当远程主机、把反斜杠当转义符，
			// 两个旗标一起让它按本地正斜杠路径读；Windows 的 bsdtar 两种写法都认。
			await run(
				"tar",
				["-xzf", tarball.replaceAll("\\", "/"), "-C", target.replaceAll("\\", "/"), "--strip-components", "1", "--force-local"],
				{
					maxBuffer: 32 * 1024 * 1024,
					windowsHide: true,
				},
			);
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

/** semver 子集：精确、^、~、>=、>、<=、<、||、x-range 与连字符区间。 */
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
			// 1.x 或 1.2.x 这类 x-range
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
