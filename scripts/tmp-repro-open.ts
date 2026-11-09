import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, inMemorySettingManager, openAgent } from "@my-agent/core";

const root = mkdtempSync(join(tmpdir(), "repro-open-"));
const session = createSession(root);
const settings = inMemorySettingManager({ approval: { read: true }, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" } as never, []);
const agent = await openAgent({ session, settings });
process.stdout.write(`workDir on bag: ${session.sessionSetting.workDirAbsPath}\n`);
process.stdout.write(`getApprovals: ${JSON.stringify(agent.getApprovals(session.sessionId))}\n`);
process.stdout.write(`authorize(read): ${String(await agent.authorize(session.sessionId, "read", "x", {}))}\n`);
