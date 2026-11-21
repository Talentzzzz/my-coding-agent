// 分层依赖方向的机械守卫（分层重构 spec §6，步 3 随 server 三分诞生）：
//
//   R1  依赖方向——五个模块（app / case / trigger / domain / infra）的 import 边不许越过允许
//       的方向：app → 全部；trigger → { case, infra }；case → domain；infra → domain；
//       domain → 零本仓依赖（只认 node 内建、外部依赖与自己的端口声明）。违规即失败。
//   R1b 成员禁令——case 与 trigger 不得拼写的成员访问：原 `check-server-facade` 的
//       bannedMembers 面随 server 包退役迁到这里继续扫（spec §6；ADR-0012/0023 族——会话操作
//       走 Agent 公开面，hold 簿记对传输层与应用层零感知）。
//   R2  子包隔离——domain/src/agent/ 的四个子包（context / llm / session / tool）只准 import
//       根 types.ts、自己包内的文件、node 内建与外部依赖；互不 import，哪怕单向（spec §6 R2、
//       §2.2）。被别的子包消费的定义独占在根 types.ts（共享内核），所以子包向上的相对 import
//       只许指到它。随步 4 激活。
//
// R3  domain 禁 fs（随步 5 激活）——domain/src/agent/ 不 import node:fs / node:fs/promises，
//      node:child_process 同题；例外 tool/ 包（用户工作目录事实，spec §4.5）与 context 包的
//      agents-md.ts（AGENTS.md 收集，§4.5 明文不端口化）。存储走注入的端口：SessionRepository /
//      三份 home-json / ToolResultsRepository，infra 实现、组合根注入——domain 从此不知道「真实的
//      home」，触盘的只有 infra。
//
// 与 check-tokens / check-server-facade 同一套先例：一个用正则的小脚本，接进 `npm run check`，
// 让不变量被机器检查而不是靠一条会腐烂的注释；import 说明符 → 包名映射判方向（facade 守卫的
// `importStatements` 正则先例）。**不加 dependency-cruiser**——不加新的运行时依赖。
// scripts/ 豁免（facade 守卫先例原文）：smoke 有意直接 import 各包的名字（测试接缝）。
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const packagesRoot = process.argv[2] ?? "packages";

const MODULES = ["app", "case", "trigger", "domain", "infra"] as const;
type Module = (typeof MODULES)[number];

/** R1：每个模块允许 import 的本仓包。domain 的清单是空的——它对任何本仓包都盲。 */
const allowedImports: Record<Module, readonly Module[]> = {
	app: ["domain", "infra", "case", "trigger"],
	trigger: ["case", "infra"],
	case: ["domain"],
	infra: ["domain"],
	domain: [],
};

/** 模块 → 包名：import 说明符按它映射到方向。子路径导出（`@my-agent/case/protocol`）按包名前缀归。 */
const packageNames: Record<Module, string> = {
	app: "@my-agent/app",
	trigger: "@my-agent/trigger",
	case: "@my-agent/case",
	infra: "@my-agent/infra",
	domain: "@my-agent/domain",
};

function moduleOfSpecifier(name: string): Module | undefined {
	return MODULES.find((m) => name === packageNames[m] || name.startsWith(`${packageNames[m]}/`));
}

// R1b：成员访问禁令，形状与 facade 守卫逐字相同（迁移不改语义）。`.settings` 被禁，但方法调用
// 形式 `.settings(` 例外——那是 controller 方法自己的名字；hold / release / holds 通道全数被禁。
const bannedMembers: [RegExp, string][] = [
	[/\.agentState\s*\(/, ".agentState("],
	[/\.sessionManager\b/, ".sessionManager"],
	[/\.settings\b(?!\s*\()/, ".settings"],
	[/\.hold\s*\(/, ".hold("],
	[/\.release\s*\(/, ".release("],
	[/\.holdsOf\s*\(/, ".holdsOf("],
	[/\.heldSessionIds\s*\(/, ".heldSessionIds("],
	// `.holds` 无豁免（ADR-0023：这些包里该名字零出现，出现即违例）——不排除调用形式，
	// 让任何拼写的成员访问都失败。
	[/\.holds\b/, ".holds"],
];

/** R1b 扫描的模块：成员禁令只住触发面与会话应用层（spec §6；domain 的边界由 R2/R3 另管）。 */
const memberScannedModules: readonly Module[] = ["case", "trigger"];

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

function specifierOf(statement: string): string | undefined {
	const match = statement.match(/from\s*["']([^"']+)["']/);
	return match?.[1];
}

function lineOf(text: string, offset: number): number {
	return text.slice(0, offset).split("\n").length;
}

/** Windows 反斜杠路径折成正斜杠，让前缀比较在两种分隔符下同一个答案。 */
function normalize(path: string): string {
	return path.replaceAll("\\", "/");
}

// R2 的扫描面：domain/src/agent/ 下的四个子包目录与共享内核（根 types.ts）的住址。
const domainAgentDir = resolve(packagesRoot, "domain", "src", "agent");
const subpackageDirs = ["context", "llm", "session", "tool"].map((name) => normalize(resolve(domainAgentDir, name)));
const rootTypesFile = normalize(resolve(domainAgentDir, "types.ts"));

// R3 的扫描面（随步 5 激活）：domain 禁 node:fs 一族 import（fs / fs/promises），node:child_process
// 同题——存储走注入的端口（SessionRepository / 三份 home-json / ToolResultsRepository），infra 实现、
// 组合根注入。**例外：tool/ 包**（spec §4.5 的不端口化清单——用户工作目录的固有本地事实：六工具的
// 文件读写与 shell；child_process 属同一个例外）与 **context 包的 agents-md.ts**（AGENTS.md/CLAUDE.md
// 收集，§4.5 明文不端口化，不搬出 context——子包隔离禁它 import tool）。
const fsBannedSpecifiers = new Set(["node:fs", "node:fs/promises", "node:child_process"]);
const toolDir = normalize(resolve(domainAgentDir, "tool"));
const agentsMdFile = normalize(resolve(domainAgentDir, "context", "agents-md.ts"));

/** R3：一个 domain 文件是否被豁免某条 fs 类 import。 */
function fsExempt(path: string, specifier: string): boolean {
	const normalizedPath = normalize(path);
	if (normalizedPath.startsWith(`${toolDir}/`)) return true; // 用户工作目录事实（spec §4.5）
	if (specifier === "node:child_process") return false; // shell 只有工具用
	if (normalizedPath === agentsMdFile) return true; // AGENTS.md 收集（spec §4.5）
	return false;
}

/** 文件住在哪个子包里；不在任何子包（agent 根自身）时为 undefined——R2 只管子包。 */
function subpackageOf(path: string): string | undefined {
	const normalizedPath = normalize(path);
	for (const dir of subpackageDirs) {
		if (normalizedPath.startsWith(`${dir}/`)) return dir;
	}
	return undefined;
}

const findings: string[] = [];

for (const module of MODULES) {
	const srcDir = resolve(packagesRoot, module, "src");
	for (const path of await sources(srcDir)) {
		const text = withoutComments(await readFile(path, "utf8"));
		const where = relative(process.cwd(), path).replaceAll("\\", "/");
		for (const { statement, offset } of importStatements(text)) {
			const specifier = specifierOf(statement);
			if (specifier === undefined) continue;
			if (specifier.startsWith(".")) {
				// 相对 import 只许留在本模块自己的 src 里：跨包相对路径是绕过包名映射的暗道，
				// 方向上与一条被禁的边等价。
				const target = normalize(resolve(resolve(path, ".."), specifier));
				const into = MODULES.find((m) => m !== module && target.startsWith(`${normalize(resolve(packagesRoot, m))}/`));
				if (into !== undefined) {
					findings.push(`${where}:${lineOf(text, offset)} 相对 import 跨进 ${into} ——跨包一律走包名`);
				}
				// R2：子包的相对 import 只许落在自己包内或指到根 types.ts——其余一切（别的子包、
				// agent 根的其他文件）都是被禁的边。
				const owningSubpackage = subpackageOf(path);
				if (owningSubpackage !== undefined && target !== rootTypesFile && !target.startsWith(`${owningSubpackage}/`)) {
					findings.push(
						`${where}:${lineOf(text, offset)} ${specifier} ——子包只准 import 根 types.ts、自己包内、node 内建与外部依赖（R2）`,
					);
				}
				continue;
			}
			const target = moduleOfSpecifier(specifier);
			if (target === undefined || target === module) continue;
			if (!allowedImports[module].includes(target)) {
				findings.push(`${where}:${lineOf(text, offset)} ${specifier} ——${module} 不许 import ${target}`);
			}
		}
		if (memberScannedModules.includes(module)) {
			for (const [pattern, label] of bannedMembers) {
				for (const match of text.matchAll(new RegExp(pattern, "g"))) {
					findings.push(`${where}:${lineOf(text, match.index ?? 0)} \`${label}\` ——会话操作走 Agent 公开面`);
				}
			}
		}
		if (module === "domain") {
			for (const { statement, offset } of importStatements(text)) {
				const specifier = specifierOf(statement);
				if (specifier === undefined || !fsBannedSpecifiers.has(specifier)) continue;
				if (fsExempt(path, specifier)) continue;
				findings.push(
					`${where}:${lineOf(text, offset)} ${specifier} ——domain 禁触盘：存储走注入的端口，fs 是 infra 的（R3，例外 tool/ 包与 agents-md 收集）`,
				);
			}
		}
	}
}

if (findings.length === 0) {
	console.log("layering ok：依赖方向与成员禁令无违例");
} else {
	console.log(`layering 违例 ${findings.length} 处：`);
	for (const finding of findings) console.log(`  ${finding}`);
	process.exitCode = 1;
}
