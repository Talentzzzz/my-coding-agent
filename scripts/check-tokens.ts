// 找出样式表里引用了却从未定义的自定义属性。缺失的 token 不会大声报错——它会让声明该属性的规则
// 在计算值阶段整条失效，属性于是静默回退而不是显示错误的颜色，这正是截图无法解释的那类 bug。
import { readFile } from "node:fs/promises";

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("usage: node scripts/check-tokens.ts <file.css> [...]");

const defined = new Set();
const referenced = new Map();

for (const file of files) {
	const text = await readFile(file, "utf8");
	for (const match of text.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) defined.add(match[1]);
	for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
		const where = referenced.get(match[1]) ?? new Set();
		where.add(file);
		referenced.set(match[1], where);
	}
}

const missing = [...referenced.keys()].filter((name) => !defined.has(name)).sort();
if (missing.length === 0) {
	console.log(`tokens ok: ${defined.size} defined, ${referenced.size} referenced`);
} else {
	console.log(`${missing.length} referenced but never defined:`);
	for (const name of missing) console.log(`  ${name}`);
	process.exitCode = 1;
}
