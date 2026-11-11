// loop 边界的机械守卫（.scratch/wayfinder/loop-extraction 票 005）：loop 对 Agent 的认识只能
// 来自 loopOptions 里传进来的回调与数据（ADR-0022 决定 5），不能 import `agent.ts`——这是
// 0012 决定 2 判据（「值层面不 import」）的机器化。与 check-server-facade 同一套做法：一个
// 用正则的小脚本，接进 `npm run check`。范围是 `packages/core/src/loop-manager.ts` 一个文件
// ——分区本身就是 ADR-0022 决定 1 的内容，loop 只住这一个文件。两个方向一起查：
// loop-manager.ts 不得 import agent.ts（负向），agent.ts 必须仍 import loop-manager.ts 的
// 公开面（正向，边界消失时守卫报错而不是空转）。
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

// import 位置上模块说明符以 `/agent.ts`（对应 `/loop-manager.ts`）结尾的引用：静态
// `… from "…"`、side-effect `import "…"`、动态 `import("…")` 同一个正则命中，`./x.ts` 与
// `../core/x.ts` 都算。近名说明符如 `./session/agent-state.ts`、`./context/agents-md.ts`
// 不命中——`/` 必须紧挨文件名；普通字符串里的路径字样也不命中——说明符必须紧跟
// `from` / `import`。源文本先剥注释，loop 头上「绝不 import `agent.ts`」的文档注释不会
// 触发自己的守卫。
const agentImport = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'][^"']*\/agent\.ts["']/;
const loopImport = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'][^"']*\/loop-manager\.ts["']/;

const findings: string[] = [];
for (const { path, mode, label } of [
	{ path: loopPath, mode: "loop" as const, label: "loop 不得 import agent.ts（ADR-0022 决定 5）" },
	{
		path: agentPath,
		mode: "orchestrator" as const,
		label: "agent.ts 必须仍 import loop-manager.ts 的公开面",
	},
]) {
	let text: string;
	try {
		text = withoutComments(await readFile(path, "utf8"));
	} catch {
		// 守卫点名了这两个文件；缺任何一个都说明边界本身挪走了——报错而不是空转，
		// 重开守卫要随 ADR 一起。
		findings.push(`${path} 不存在 ——${label}，守卫目标已挪走，须随 ADR 重开本守卫`);
		continue;
	}
	if (mode === "loop") {
		for (const match of text.matchAll(new RegExp(agentImport, "g"))) {
			findings.push(
				`${path}:${lineOf(text, match.index ?? 0)} \`${match[0]}\` ——loop 对 Agent 的认识只来自 loopOptions`,
			);
		}
	} else if (!loopImport.test(text)) {
		findings.push(`${path} 没有 import loop-manager.ts ——依赖方向是单向的，编排层必须消费 loop 公开面`);
	}
}

if (findings.length === 0) {
	console.log("loop 边界 ok：loop 不 import agent.ts，方向单向");
} else {
	console.log(`loop 边界被破坏，${findings.length} 处：`);
	for (const finding of findings) console.log(`  ${finding}`);
	process.exitCode = 1;
}
