// Repair this machine's stored models/settings as ticket 04 part C asks:
//
//   - drop the `scripted` placeholder row (the one whose endpoint is 127.0.0.1:1),
//   - put the built-in `deepseek-flash` row in its place, with the vendor's numbers,
//   - point `settings.model` at it,
//   - mark the row as planted, so deleting it is final rather than "list is empty again, seed".
//
// That last line is not cosmetic: the window is what normally writes the marker, and this script
// planted the row without a window. Left unset, deleting the row and restarting would make
// `defaultModelDue` true again and the row would come back — the exact acceptance this repair is for.
//
// It goes through the production store and manager rather than editing JSON by hand, so the file it
// leaves behind is exactly the shape the app writes. Keys are never printed: the summary reports only
// whether a row carries one, and an existing `deepseek-flash` row keeps whatever key it already had.
// Run with: node .scratch/ui-fix-pass/research/fix-04-local-data.ts
import { coerceModel, SettingsManager, UserModelStore } from "@my-agent/core";
import { DEFAULT_MODEL } from "../../../packages/web/src/default-model.ts";

const store = UserModelStore.create();
const rows = store.list();

/** Report the key's presence, never its value. */
const keyState = (row: { apiKey?: string }): string => (row.apiKey ? "<stored>" : "<empty>");

const carried = rows.find((row) => row.name === DEFAULT_MODEL.name)?.apiKey ?? "";
const planted = coerceModel({ ...DEFAULT_MODEL, apiKey: carried });
if (planted === undefined) throw new Error("the built-in row was refused by coerceModel");

const kept = rows.filter((row) => row.name !== "scripted" && row.name !== DEFAULT_MODEL.name);
store.replace([planted, ...kept]);

const settings = SettingsManager.create(process.cwd());
settings.applySettings({
	model: `${DEFAULT_MODEL.name}/${DEFAULT_MODEL.modelId}`,
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
