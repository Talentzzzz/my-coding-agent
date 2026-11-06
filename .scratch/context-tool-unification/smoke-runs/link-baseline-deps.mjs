// 给基线工作树接上依赖:node_modules 用 junction 指回主仓库,`@my-agent/*` 指回基线自己的 packages。
// 这不是仓库的一部分,只是「改动前那一版还能跑」的脚手架(见 .scratch/context-tool-unification/issues/04)。
import { mkdirSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const main = "C:/Users/a1368/Desktop/my-coding-agent";
const base = process.argv[2];

function link(target, path) {
	if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	symlinkSync(target, path, "junction");
}

for (const ws of ["packages/core", "packages/server", "packages/web", "packages/desktop"]) {
	mkdirSync(join(base, ws), { recursive: true });
	const from = join(main, ws, "node_modules");
	if (!existsSync(from)) continue;
	link(from, join(base, ws, "node_modules"));
}

mkdirSync(join(base, "packages/llm"), { recursive: true });
link(join(main, "packages/core/node_modules"), join(base, "packages/llm/node_modules"));

mkdirSync(join(base, "node_modules/@my-agent"), { recursive: true });
link(join(main, "node_modules/typescript"), join(base, "node_modules/typescript"));
link(join(main, "node_modules/@types"), join(base, "node_modules/@types"));

for (const name of ["core", "server", "web", "desktop", "llm"]) {
	link(join(base, "packages", name), join(base, "node_modules/@my-agent", name));
}

process.stdout.write("baseline deps linked\n");
