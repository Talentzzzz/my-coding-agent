// Find custom properties a stylesheet references but never defines. A missing token does not fail
// loudly — it makes the declaring rule invalid at computed-value time, so the property silently
// falls back instead of showing the wrong color, which is exactly the kind of bug a screenshot
// cannot explain.
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
