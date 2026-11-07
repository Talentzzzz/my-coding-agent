// Mechanical guard for the hub-facade boundary (issue 03 of .scratch/hub-agent-facade): the server
// package operates sessions only through the `Agent` public face and never touches a Manager, a
// construction entry, or a state object. Same precedent as check-tokens: a small script with
// regexes, wired into `npm run check`, so the invariant is machine-checked instead of a comment
// that rots. Scope is `packages/server/src` only — the smokes in scripts/ deliberately keep
// Manager access (test seams), and the guard must not fire on them.
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = process.argv[2] ?? "packages/server/src";

// Names whose import the server package must never spell: the three Managers, their factory, the
// ledger's construction and replay entries, and the pure-data shapes (`SessionAgentServices`,
// `OpenAgentOptions`, `AgentState`, `Session`) that stopped leaving core with the facade.
const bannedImports = [
	"SessionManager",
	"SettingManager",
	"ToolManager",
	"createToolManager",
	"createSession",
	"readSessionSnapshot",
	"SessionAgentServices",
	"OpenAgentOptions",
	"AgentState",
	"Session",
];

// Member accesses the server package must never spell. `.settings` is banned except in the
// method-call form `.settings(` — the controller method's own name — and `.tools` is not on the
// list at all: plain-data fields named `tools` are everywhere and the import ban already walls
// the `ToolManager` off.
const bannedMembers: [RegExp, string][] = [
	[/\.agentState\s*\(/, ".agentState("],
	[/\.sessionManager\b/, ".sessionManager"],
	[/\.settings\b(?!\s*\()/, ".settings"],
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

/** Drop comments so a doc comment explaining the guard cannot trip it; a `://` inside a string survives. */
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

/** Every import / re-export statement, multiline braces included, up to its module specifier. */
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
