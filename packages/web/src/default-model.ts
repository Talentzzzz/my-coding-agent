import type { ModelInput, ModelOption } from "@my-agent/core/protocol";

/**
 * The row the window plants when this machine has imported no model at all.
 *
 * A fresh install used to open on the 「还没有配置模型」 notice and a placeholder that fails every
 * request, which is an accurate account of the machine but a poor first screen: the one thing the app
 * needs before it can do anything was also the one thing it would not offer to write down. So the
 * client ships one starter row — a name, an endpoint, and the vendor's own numbers — and the first
 * window that finds the list empty stores it through the ordinary model endpoint.
 *
 * It is deliberately not a catalog: it is one row, the user may edit every field of it, and deleting it
 * is final (see {@link defaultModelDue}). The endpoint is DeepSeek's Anthropic-compatible one because
 * the model the row names speaks this app's only transport. The numbers are the row's facts rather
 * than a guess, and they are what the compaction threshold and the output limit read.
 *
 * `apiKey` is absent on purpose, both halves of that: the app never ships a credential, and an absent
 * field is what the endpoint reads as "keep whatever is stored". The row is therefore keyless until
 * the user pastes one in, which is the one thing only they can do.
 *
 * `name` restates `DEFAULT_MODEL_NAME` from `packages/core/src/models.ts`, where the server's half of
 * the same decision lives: that module runs on Node and this one is bundled for the browser, so the
 * literal is written twice. The two must agree — the name here is what the row is planted as, and the
 * name there is what assembly opens a session on.
 */
export const DEFAULT_MODEL: ModelInput = {
	name: "deepseek-flash",
	baseUrl: "https://api.deepseek.com/anthropic",
	id: "deepseek-flash",
	contextWindow: 1_000_000,
	maxTokens: 384_000,
};

/**
 * The strength a window starts on when neither the session nor the user has said.
 *
 * A default level is the client's fact, not the row's: the row says which endpoint answers, and the
 * composer is the thing that is showing a strength — so the value lives where the composer does and
 * travels with each message. `high` is the answer that matches the row planted above: a reasoning
 * model asked to think, which is what someone opening this app for the first time is asking for.
 */
export const DEFAULT_THINKING_LEVEL = "high";

/**
 * Whether the built-in row is due: nothing imported, and no earlier window ever planted it.
 *
 * `seeded` is the persistent marker, not a copy of "is the row there" — the user is free to delete
 * the planted row, and a deleted row must stay deleted. That is why the marker lives in the settings
 * files rather than in the browser's own storage: the desktop shell serves a fresh port on every
 * launch, so an origin-scoped store would forget the decision by the next start.
 */
export function defaultModelDue(models: readonly ModelOption[], seeded: boolean): boolean {
	return models.length === 0 && !seeded;
}

/** What the window can do about the built-in row, passed in so the decision stays testable. */
export interface DefaultModelHost {
	/** The imported rows, as the window last read them. */
	models: readonly ModelOption[];
	/** Whether a previous window already planted the row — the settings' own marker. */
	seeded: boolean;
	/** Store the list whole; resolves with the rows the server kept. */
	save(rows: ModelInput[]): Promise<ModelOption[]>;
	/** Record that the row was planted, so deleting it later is a decision rather than a gap. */
	markSeeded(): Promise<void>;
}

/**
 * Plant {@link DEFAULT_MODEL} when it is due, and answer the rows the window should now show.
 *
 * `undefined` means nothing was planted — either rows are already imported, or they were imported
 * once and the user has since deleted them. The row is stored **before** the marker is written: a
 * failed save must leave the marker unset so the next launch tries again, while marking first would
 * leave a machine with no rows that never plants one.
 */
export async function seedDefaultModel(host: DefaultModelHost): Promise<ModelOption[] | undefined> {
	if (!defaultModelDue(host.models, host.seeded)) return undefined;
	const models = await host.save([DEFAULT_MODEL]);
	await host.markSeeded();
	return models;
}
