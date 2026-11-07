// Put the hardcoded default row back on this machine, and point the stored default at it.
//
// The stored half of "default model" had drifted twice: `settings.json` named
// `deepseek-flash/deepseek-flash`, a row this machine no longer has, while `models.json` held only the
// `scripted` placeholder — so assembly fell through to the first row and the composer opened on
// `scripted`. The code half of the repair is `DEFAULT_MODEL_NAME` in `packages/core/src/models.ts`;
// this is the data half, and it goes through the production store so the file it leaves behind is
// exactly the shape the app writes.
//
// The stored name is the plain row name, which is the spelling the settings panel writes. Keys are
// never printed: the summary reports only whether a row carries one, and a row that is already there
// keeps whatever key it had.
//
// Run with: node .scratch/default-model-hardcode/plant-default-model.ts
import { coerceModel, DEFAULT_MODEL_NAME, SettingsManager, UserModelStore } from "@my-agent/core";
import { DEFAULT_MODEL } from "../../packages/web/src/default-model.ts";

/** Report the key's presence, never its value. */
const keyState = (row: { apiKey?: string }): string => (row.apiKey ? "<stored>" : "<empty>");

const rows = UserModelStore.create().list();
const carried = rows.find((row) => row.name === DEFAULT_MODEL_NAME)?.apiKey ?? "";
const planted = coerceModel({ ...DEFAULT_MODEL, apiKey: carried });
if (planted === undefined) throw new Error("the built-in row was refused by coerceModel");

// The built-in row goes first — not because order decides anything any more, but because the file
// reads better with the default at the top. Every other row, `scripted` included, is left alone.
const kept = rows.filter((row) => row.name !== DEFAULT_MODEL_NAME);
UserModelStore.create().replace([planted, ...kept]);

SettingsManager.create(process.cwd()).applySettings({
	model: DEFAULT_MODEL_NAME,
	defaultModelSeeded: true,
});

const stored = UserModelStore.create().list();
process.stdout.write(`models.json now holds ${stored.length} row(s):\n`);
for (const row of stored) {
	process.stdout.write(
		`  ${row.name} · ${row.baseUrl} · ${row.modelId} · ctx ${row.contextWindow} · max ${row.maxTokens} · reasoning ${row.reasoning} · level ${row.defaultThinkingLevel ?? "-"} · key ${keyState(row)}\n`,
	);
}
const reread = SettingsManager.create(process.cwd()).getSettings();
process.stdout.write(`settings.model = ${reread.model ?? "<unset>"}\n`);
process.stdout.write(`settings.defaultModelSeeded = ${reread.defaultModelSeeded ?? "<unset>"}\n`);
