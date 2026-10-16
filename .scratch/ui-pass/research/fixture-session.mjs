// Writes a hand-made session file with one branch point and two ways, so the branch page can be
// driven against the real client without a provider key. Throwaway repro scaffolding.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CWD = process.argv[2] ?? "C:\\Users\\a1368\\Desktop\\test";
const dirName = `--${CWD.replace(/[\\/:]/g, "-")}--`;
const dir = join(homedir(), ".my-agent", "sessions", dirName);
mkdirSync(dir, { recursive: true });

const stamp = (n) => new Date(Date.UTC(2026, 9, 16, 12, 0, n)).toISOString();
const id = "feed0001";

const entries = [
	{ type: "session", version: 3, id, timestamp: stamp(0), cwd: CWD },
];

const add = (entry) => entries.push(entry);

const msg = (entryId, parentId, at, role, text) => ({
	type: "message",
	id: entryId,
	parentId,
	timestamp: stamp(at),
	message: { role, content: [{ type: "text", text }], timestamp: Date.UTC(2026, 9, 16, 12, 0, at) },
});

add(msg("aaaaaaa1", null, 1, "user", "先问一句：这个仓库里有什么"));
add(msg("aaaaaaa2", "aaaaaaa1", 2, "assistant", "这是一个演示用的仓库。"));

// The fork: two ways continue from `aaaaaaa2`.
add(msg("bbbbbbb1", "aaaaaaa2", 3, "user", "第一条走法：帮我看看 README"));
add(msg("bbbbbbb2", "bbbbbbb1", 4, "assistant", "README 里写了安装和设置。"));

add(msg("ccccccc1", "aaaaaaa2", 5, "user", "第二条走法：帮我看看测试"));
add(msg("ccccccc2", "ccccccc1", 6, "assistant", "测试在 scripts 下面。"));
add({ type: "leaf", id: "leaf0001", parentId: "ccccccc2", timestamp: stamp(7), leafId: "ccccccc2" });

writeFileSync(join(dir, `2026-10-16T12-00-00-000Z_${id}.jsonl`), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
process.stdout.write(`${join(dir, `2026-10-16T12-00-00-000Z_${id}.jsonl`)}\n`);
