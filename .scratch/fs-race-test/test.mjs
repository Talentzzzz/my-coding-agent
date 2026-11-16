// 验证三件事：
// 1. 打开的句柄能不能被 unlink（FILE_SHARE_DELETE）
// 2. unlink 之后往句柄 write 会不会报错（还是静默丢失）
// 3. rename 到一个不存在的目标会不会把文件造回来
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-race-"));
console.log("Node:", process.version, "platform:", process.platform);
console.log("测试目录:", dir, "\n");

// ---- 实验 1+2：写者拿着打开的句柄，删除者 unlink，写者继续写 ----
const f = path.join(dir, "session.json");
fs.writeFileSync(f, "old-snapshot");

const fd = fs.openSync(f, "r+"); // 不带创建标志：文件不存在这里就会 ENOENT（原子的存在检查）
console.log("写者：open('r+') 成功，文件此刻存在");

try {
	fs.unlinkSync(f); // 删除者在写者读改写的中间动手
	console.log("删除者：unlink 成功（尽管句柄还开着）");
} catch (e) {
	console.log("删除者：unlink 被拒绝 →", e.code);
}

console.log("删除后 existsSync:", fs.existsSync(f));

try {
	fs.writeSync(fd, "new-snapshot"); // 写者浑然不觉，继续写回
	console.log("写者：write 成功返回，没有报任何错（数据写进了一个没名字的 inode）");
} catch (e) {
	console.log("写者：write 报错 →", e.code);
}
fs.closeSync(fd);

console.log("写完后 existsSync:", fs.existsSync(f), "← 文件没有复活，但数据也没落盘（静默丢失）\n");

// ---- 实验 3：快照写回的标准姿势（写临时文件 + rename）撞上目标已删 ----
const tmp = path.join(dir, "session.json.tmp");
fs.writeFileSync(tmp, "new-snapshot");
fs.renameSync(tmp, f); // 目标不存在，rename 会不会拒绝？
console.log("rename 到不存在的目标:", fs.existsSync(f) ? "文件被重新造出来了（僵尸）" : "被拒绝");

// 收尾
fs.rmSync(dir, { recursive: true, force: true });
