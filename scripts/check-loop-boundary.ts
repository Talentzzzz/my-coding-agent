// loop 边界的机械守卫（.scratch/wayfinder/loop-zero-manager 票 005，ADR-0023 决定 7）：loop 层
// 零 Manager 可见性——loop-manager.ts 不 import 编排层 agent.ts（0022 决定 5 保留），也不 import
// 三只 Manager 与 hooks 所在模块（session/session-manager.ts、setting-manager.ts、tools/、
// hooks.ts）。口径（票 005 定 ADR-0023 尚未决定 1）：按模块说明符禁，值类型先安新家——
// Session / SessionEntry / SessionSetting / sessionEntryToContextMessages 住 session/ledger.ts
// （session-manager.ts 只转出口），ToolRunContext 从 llm/types.ts 直取。静态 `… from "…"`、
// side-effect `import "…"`、`export … from`、动态 `import("…")` 同一个正则命中；注释先剥掉，
// 普通字符串里的路径字样不命中——说明符必须紧跟 `from` / `import`。与 check-server-facade
// 同一套做法：一个用正则的小脚本，接进 `npm run check`、排在它之后。
// 正向保留（0022 决定 2 判据的机器化）：agent.ts 必须仍 import loop-manager.ts 的公开面——
// 依赖方向单向，边界消失时守卫报错而不是空转。两个守卫点名文件任一缺失都报错而非空转：
// 守卫目标挪走了，重开守卫要随 ADR 一起。
import { readFile } from "node:fs/promises";

const loopPath = process.argv[2] ?? "packages/core/src/loop-manager.ts";
const agentPath = process.argv[3] ?? "packages/core/src/agent.ts";

/** 去掉注释，免得一段解释守卫自身的文档注释触发它；字符串内的 `://` 不受影响。 */
function withoutComments(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.split("\n")
		.map((line) => {
			const comment = line.search(/(?<!:)\/\//);
			return comment === -1 ? line : line.slice(0, comment);
		})
		.join("\n");
}

function lineOf(text: string, offset: number): number {
	return text.slice(0, offset).split("\n").length;
}

// 负向清单：loop 不得 import 的模块。每条共享同一个前缀——模块说明符必须紧跟 `from` / `import`，
// 所以近名说明符（如 `./session/ledger.ts`、`./context/agents-md.ts`、`./llm/types.ts`）与普通
// 字符串里的路径字样不命中；`./x.ts` 与 `../core/x.ts` 都算。
const bannedImports = [
	{
		pattern: /(?:\bfrom\s*|\bimport\s*\(?\s*)["'][^"']*\/agent\.ts["']/g,
		label: "编排层 agent.ts（ADR-0022 决定 5）",
	},
	{
		pattern: /(?:\bfrom\s*|\bimport\s*\(?\s*)["'][^"']*\/session-manager\.ts["']/g,
		label: "SessionManager 所在模块（ADR-0023 决定 7）",
	},
	{
		pattern: /(?:\bfrom\s*|\bimport\s*\(?\s*)["'][^"']*\/setting-manager\.ts["']/g,
		label: "SettingManager 所在模块（ADR-0023 决定 7）",
	},
	{
		pattern: /(?:\bfrom\s*|\bimport\s*\(?\s*)["'][^"']*\/tools\/[^"']*["']/g,
		label: "工具域 tools/（ADR-0023 决定 7）",
	},
	{
		pattern: /(?:\bfrom\s*|\bimport\s*\(?\s*)["'][^"']*\/hooks\.ts["']/g,
		label: "hooks 所在模块（ADR-0023 决定 7）",
	},
];
const loopImport = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'][^"']*\/loop-manager\.ts["']/;

const findings: string[] = [];

// 负向：loop-manager.ts 对禁令清单的每一处命中都要报出来。
let loopText: string | null = null;
try {
	loopText = withoutComments(await readFile(loopPath, "utf8"));
} catch {
	// 守卫点名了这个文件；缺了它说明边界本身挪走了——报错而不是空转，重开守卫要随 ADR 一起。
	findings.push(`${loopPath} 不存在 ——loop 层零 Manager 可见性（ADR-0023 决定 7），守卫目标已挪走，须随 ADR 重开本守卫`);
}
if (loopText !== null) {
	for (const { pattern, label } of bannedImports) {
		for (const match of loopText.matchAll(pattern)) {
			findings.push(
				`${loopPath}:${lineOf(loopText, match.index ?? 0)} \`${match[0]}\` ——loop 不得 import ${label}`,
			);
		}
	}
}

// 正向：编排层必须仍消费 loop 的公开面。
let agentText: string | null = null;
try {
	agentText = withoutComments(await readFile(agentPath, "utf8"));
} catch {
	findings.push(`${agentPath} 不存在 ——agent.ts 必须仍 import loop-manager.ts 的公开面，守卫目标已挪走，须随 ADR 重开本守卫`);
}
if (agentText !== null && !loopImport.test(agentText)) {
	findings.push(`${agentPath} 没有 import loop-manager.ts ——依赖方向是单向的，编排层必须消费 loop 公开面`);
}

if (findings.length === 0) {
	console.log("loop 边界 ok：loop 零 Manager 可见性，方向单向");
} else {
	console.log(`loop 边界被破坏，${findings.length} 处：`);
	for (const finding of findings) console.log(`  ${finding}`);
	process.exitCode = 1;
}
