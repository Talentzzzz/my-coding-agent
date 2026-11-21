// hub-facade 边界的机械守卫（.scratch/hub-agent-facade 的 issue 03）：server 包只能经由 `Agent`
// 公开面操作 session，绝不触碰 Manager、构造入口或 state 对象。与 check-tokens 同一套先例：一个
// 用正则的小脚本，接进 `npm run check`，让不变量被机器检查而不是靠一条会腐烂的注释。范围仅限
// `packages/server/src`——scripts/ 里的 smoke 有意保留 Manager 访问（测试接缝），守卫不得对它们报警。
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = process.argv[2] ?? "packages/server/src";

// server 包不得拼写其 import 的名字：Manager 与设置簇持有者、它们的工厂、ledger 的构造与 replay
// 入口，以及随门面不再从 core 导出的纯数据形状（`SessionAgentServices`、`OpenAgentOptions`、
// `AgentState`、`Session`）。`SettingManager` 已随设置归属重构退场（spec §2），代之以禁它拆出的
// 三个持有者——server 对设置的一切访问必须走 `Agent` 门面的按簇路由。`EngineSettings` 随 retry
// 簇并入 ModelManager（ADR-0028 修正）而退场。
const bannedImports = [
	"SessionManager",
	"ToolManager",
	"ModelManager",
	"createToolManager",
	"createSession",
	"readSessionSnapshot",
	"SessionAgentServices",
	"OpenAgentOptions",
	"AgentState",
	"Session",
];

// server 包不得拼写的成员访问。`.settings` 被禁，但方法调用形式 `.settings(` 例外——那是
// controller 方法自己的名字；`.tools` 完全不在列表上：名为 `tools` 的纯数据字段到处都是，
// 且 import 禁令已经把 `ToolManager` 挡住了。hold / release / holds 通道同样全数被禁
// （ADR-0023：持有簿记迁入 SessionManager，传输层零感知）——写成成员访问形式避免误伤普通词。
const bannedMembers: [RegExp, string][] = [
	[/\.agentState\s*\(/, ".agentState("],
	[/\.sessionManager\b/, ".sessionManager"],
	[/\.settings\b(?!\s*\()/, ".settings"],
	[/\.hold\s*\(/, ".hold("],
	[/\.release\s*\(/, ".release("],
	[/\.holdsOf\s*\(/, ".holdsOf("],
	[/\.heldSessionIds\s*\(/, ".heldSessionIds("],
	// `.holds` 无豁免（ADR-0023：server 包里该名字零出现，出现即违例）——不排除调用形式，
	// 让任何拼写的成员访问都失败。
	[/\.holds\b/, ".holds"],
];

async function sources(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const name of await readdir(dir, { withFileTypes: true })) {
		const path = resolve(dir, name.name);
		if (name.isDirectory()) out.push(...(await sources(path)));
		else if (name.name.endsWith(".ts")) out.push(path);
	}
	return out;
}

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

/** 全部 import / re-export 语句，含多行大括号，直到模块说明符为止。 */
function importStatements(text: string): { statement: string; offset: number }[] {
	return [...text.matchAll(/(?:^|\n)[ \t]*(?:import|export)\b[^;]*?from\s*["'][^"'\n]*["']/g)].map((match) => ({
		statement: match[0],
		offset: match.index ?? 0,
	}));
}

function lineOf(text: string, offset: number): number {
	return text.slice(0, offset).split("\n").length;
}

const findings: string[] = [];
for (const path of await sources(root)) {
	const text = withoutComments(await readFile(path, "utf8"));
	const where = relative(process.cwd(), path).replaceAll("\\", "/");
	for (const { statement, offset } of importStatements(text)) {
		for (const name of bannedImports) {
			if (new RegExp(`\\b${name}\\b`).test(statement)) {
				findings.push(`${where}:${lineOf(text, offset)} \`${name}\` ——server 不 import Manager`);
			}
		}
	}
	for (const [pattern, label] of bannedMembers) {
		for (const match of text.matchAll(new RegExp(pattern, "g"))) {
			findings.push(`${where}:${lineOf(text, match.index ?? 0)} \`${label}\` ——会话操作走 Agent 公开面`);
		}
	}
}

if (findings.length === 0) {
	console.log("server 门面 ok：无 Manager 导入、无状态直读");
} else {
	console.log(`server 不得触碰 Manager，${findings.length} 处：`);
	for (const finding of findings) console.log(`  ${finding}`);
	process.exitCode = 1;
}
