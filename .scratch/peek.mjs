import { readdirSync, readFileSync } from "node:fs";
const dir = String.raw`C:\Users\a1368\.my-agent\sessions\--C--Users-a1368-Desktop-my-coding-agent--`;
for (const name of readdirSync(dir)) {
  const text = readFileSync(`${dir}\\${name}`, "utf8");
  const lines = text.split("\n").filter(Boolean);
  let header = {};
  try { header = JSON.parse(lines[0]).cwd ? JSON.parse(lines[0]) : {}; } catch {}
  const firstUser = lines.map((l) => { try { const e = JSON.parse(l); return e; } catch { return null; } })
    .find((e) => e && e.type === "message" && e.message && e.message.role === "user");
  const body = JSON.stringify(firstUser?.message ?? "").slice(0, 120);
  console.log(name.slice(0, 40), "|", body);
}
