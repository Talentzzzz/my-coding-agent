// Rebuild `probe-output.txt` from the run logs.
//
// `.gitignore` has `*.log`, and every number in this ticket's report comes from those logs, so the
// evidence is submitted as one `.txt` transcript. This script is what builds it, ordered by the time
// each run happened — that order is the story: the first two runs are the discovery, the six-run
// matrix is the switch comparison, and the rest each answer one follow-up question.
//
// It is Node rather than PowerShell for a reason worth knowing: Windows PowerShell 5.1 reads a
// BOM-less `.ps1` as ANSI, so Chinese text inside a script file arrives as mojibake and fails to
// parse. Its sibling scripts (`run-matrix.ps1`, `gpu-sightings.ps1`, `read.ps1`) are ASCII-only and
// are meant to stay that way; a script that has to say something in Chinese belongs here instead.
//
//   node .scratch/window-repair/research/switch-probe/make-evidence.mjs
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const logsDir = join(here, "logs");
const out = join(here, "probe-output.txt");

// Every log in the directory, oldest first, so a re-run cannot silently drop one.
const files = readdirSync(logsDir)
	.filter((name) => name.endsWith(".log"))
	.map((name) => ({ name, at: statSync(join(logsDir, name)).mtimeMs }))
	.sort((a, b) => a.at - b.at);

const header = [
	"# 票 02 的全部原始探针输出（2026-10-16，本机）",
	"#",
	"# 这是 research/switch-probe/logs/*.log 的**逐字副本**，按产生时间拼接，每段一个",
	"# `== logs/<名字>` 标题。每行带 `+Nms` 墙钟。这些行是本票所有数字的唯一来源。",
	"# `*.log` 在 .gitignore 里，所以证据以这个 .txt 提交；重建用 make-evidence.mjs。",
	"#",
	"# 注意：中文在这个文件里是 UTF-8，用按 ANSI 代码页读的工具打开会显示成乱码",
	"# （`新建会话` -> `鏂板缓浼氳瘽`）——那是读法的问题，结论不依赖中文字符串。",
	"",
];

const sections = files.flatMap((file) => [
	"=".repeat(100),
	`== logs/${file.name}`,
	"=".repeat(100),
	readFileSync(join(logsDir, file.name), "utf8").trimEnd(),
	"",
]);

writeFileSync(out, [...header, ...sections].join("\n"), "utf8");
console.log(`wrote ${out}: ${statSync(out).size} bytes, ${files.length} logs`);
for (const file of files) console.log(`  ${file.name}`);
