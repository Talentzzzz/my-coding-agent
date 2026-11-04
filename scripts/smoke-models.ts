// Model smoke test: the user's imported models, the names that pick them out, and the placeholder that
// stands in for none. Run with: node scripts/smoke-models.ts
//
// No provider key: everything here is the mapping from a row the user typed to the pi-ai model a
// session runs (vendored as @my-agent/llm), plus the one request this app never wants to make — the one
// that has no model to make it with. One heading reaches the real transport with a key, and captures
// the request before it leaves, so what it reads is the credential rather than a provider's answer.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicMessages, type SimpleStreamOptions } from "@my-agent/llm";
import {
	coerceModelConfig,
	isUnconfigured,
	listModelOptions,
	createModel,
	modelFor,
	modelsPath,
	normalizeThinkingLevel,
	placeholderModel,
	rowFor,
	thinkingLevelsFor,
	unconfiguredStream,
	ModelConfigStore,
	type ModelChoice,
	type ModelConfig,
} from "@my-agent/core";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	if (condition) {
		process.stdout.write(`  ok   ${label}\n`);
		return;
	}
	failures += 1;
	process.stdout.write(`  FAIL ${label} ${detail}\n`);
}

function heading(title: string): void {
	process.stdout.write(`${title}\n`);
}

function row(overrides: Partial<ModelConfig> = {}): ModelConfig {
	return {
		name: "mine",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "secret",
		id: "wire-model",
		contextWindow: 64_000,
		maxTokens: 4_096,
		...overrides,
	};
}

const home = await mkdtemp(join(tmpdir(), "my-agent-models-"));

try {
	heading("a row becomes a runnable model");
	{
		const rows = [row()];
		const resolved = rows.find((userModel) => userModel.name === "mine");
		check("the row is found by the name the user typed", resolved?.name === "mine", String(resolved?.name));

		const model = createModel(resolved!);
		check("whose wire id is what the endpoint is asked for", model.id === "wire-model", String(model.id));
		check("carrying the row's base URL", model.baseUrl === "http://127.0.0.1:1/v1", String(model.baseUrl));
		check("and the row's context window", model.contextWindow === 64_000, String(model.contextWindow));
		check("and its name as `name`", model.name === "mine", String(model.name));
		check("and its key, so the request carries its own credential", model.apiKey === "secret", String(model.apiKey));
		check("and is not the placeholder", !isUnconfigured(model));

		check("an unknown name resolves to nothing", rows.find((userModel) => userModel.name === "nope") === undefined);
	}

	heading("the row behind a model is found by the name it carries");
	{
		const rows = [row()];
		const model = createModel(rows[0]!);
		check("the model's row is found by the name it carries", rows.find((userModel) => userModel.name === model.name)?.apiKey === "secret");
		check("and a model with no row behind it has none", rows.find((userModel) => userModel.name === placeholderModel().name) === undefined);
		// Renaming the row is exactly what breaks the link, which is the documented cost of a name being
		// an identity: the model that was built from the old name no longer finds anything.
		rows[0]!.name = "renamed";
		const stale = createModel(row({ name: "mine" }));
		check("a renamed row stops answering to the old name", rows.find((userModel) => userModel.name === stale.name) === undefined);
	}
	heading("two rows on one vendor keep their own keys");
	{
		const rows = [row({ name: "work", apiKey: "work-key" }), row({ name: "home", apiKey: "home-key" })];
		const first = createModel(rows[0]!);
		const second = createModel(rows[1]!);
		check("the first row's key is the first row's", rows.find((userModel) => userModel.name === first.name)?.apiKey === "work-key");
		check("and the second row's is not it", rows.find((userModel) => userModel.name === second.name)?.apiKey === "home-key");
	}

	heading("with no rows, the answer says what to add");
	{
		const placeholder = placeholderModel();
		check("the placeholder has no row behind it", ([] as ModelConfig[]).find((userModel) => userModel.name === placeholder.name) === undefined);
		check("and is recognised as the placeholder", isUnconfigured(placeholder));
		check("by a name no stored row may claim", placeholder.name === "my-agent:unconfigured", placeholder.name);
		check("and it carries no key at all", placeholder.apiKey === undefined, String(placeholder.apiKey));

		const message = await unconfiguredStream(placeholder).result();
		check("asking it for an answer fails", message.stopReason === "error", String(message.stopReason));
		check(
			"with something the user can act on",
			(message.errorMessage ?? "").includes("Settings"),
			String(message.errorMessage),
		);
	}

	heading("a session reads the rows rather than a copy of them");
	{
		// The whole of "editing a model takes effect on the next request": there is no catalog to
		// rebuild, because the manager re-reads the rows behind it each time and the model is
		// re-derived from the row it finds.
		const rows: ModelConfig[] = [];
		check("an empty source resolves nothing", rows.find((userModel) => userModel.name === "added") === undefined);

		rows.push(row({ name: "added", apiKey: "first" }));
		check("a row added to the source is resolvable", rows.find((userModel) => userModel.name === "added") !== undefined);
		check("and its key is on the model a request would use", createModel(rows[0]!).apiKey === "first");

		rows[0]!.apiKey = "corrected";
		const rederived = createModel(rows.find((userModel) => userModel.name === "added")!);
		check("a corrected key is read on the next lookup, with nothing rebuilt", rederived.apiKey === "corrected");

		rows.length = 0;
		check("a removed row stops resolving", rows.find((userModel) => userModel.name === "added") === undefined);
	}

	heading("the model's own key is what a caller without one authenticates with");
	{
		// A key rides on the model, so a call that names no key of its own still has one — the
		// compaction summary is the call shaped like that, and it used to come back with "No API key"
		// while the row it was summarizing had one all along. Nothing here opens a connection: the
		// request is captured on its way out, which is also what says *which* key was on it.
		const attempt = async (
			model: ReturnType<typeof createModel>,
			options: SimpleStreamOptions = {},
		): Promise<{ key: string | undefined; authorization: string | undefined; message: string }> => {
			let key: string | undefined;
			let authorization: string | undefined;
			const capture = (async (_input: unknown, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				key = headers.get("x-api-key") ?? "";
				authorization = headers.get("authorization") ?? "";
				throw new Error("captured on the way out");
			}) as typeof fetch;
			const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: Date.now() }];
			try {
				const stream = anthropicMessages.stream(model, { messages }, {
					...options,
					fetch: capture,
				});
				const answer = await stream.result();
				return { key, authorization, message: answer.errorMessage ?? "" };
			} catch (error) {
				return { key, authorization, message: error instanceof Error ? error.message : String(error) };
			}
		};

		const keyed = await attempt(createModel(row({ apiKey: "secret" })));
		check("a keyed row sends the row's key, with no key passed in", keyed.key === "secret", String(keyed.key));

		const keyless = await attempt(createModel(row({ apiKey: "" })));
		check("a row with no key still fails in setup", keyless.message.includes("No API key"), keyless.message);

		const byHeader = await attempt(createModel(row({ apiKey: "" })), { headers: { authorization: "Bearer gateway" } });
		check(
			"and a gateway's own credential is what reaches the request instead",
			byHeader.authorization === "Bearer gateway" && byHeader.key === "",
			`${byHeader.authorization} / ${byHeader.key}`,
		);

		const explicit = await attempt(createModel(row({ apiKey: "stale" })), { apiKey: "passed-in" });
		check("while a key the caller passes wins over the row's", explicit.key === "passed-in", String(explicit.key));
	}

	heading("rows are validated rather than trusted");
	{
		check("a row without a model id is refused", coerceModelConfig({ baseUrl: "http://x" }) === undefined);
		check("a row without a base URL is refused", coerceModelConfig({ id: "m" }) === undefined);

		const derived = coerceModelConfig({ name: "DeepSeek Chat", id: "deepseek-chat", baseUrl: "http://x" });
		check("a name is kept as it was typed", derived?.name === "DeepSeek Chat", String(derived?.name));

		const unnamed = coerceModelConfig({ id: "deepseek-chat", baseUrl: "http://x" });
		check("a missing name falls back to the wire id", unnamed?.name === "deepseek-chat", String(unnamed?.name));

		// A name is an identity, so a duplicate is not quietly made unique: the caller has to refuse the
		// list, or every transcript referring to the first row would silently change meaning.
		const duplicate = coerceModelConfig({ name: "m", id: "m", baseUrl: "http://x" });
		check("a duplicate name is stored as it was typed, not suffixed", duplicate?.name === "m", String(duplicate?.name));

		const reserved = coerceModelConfig({ name: "my-agent:unconfigured", id: "m", baseUrl: "http://x" });
		check("the placeholder's name cannot be claimed", reserved === undefined, JSON.stringify(reserved));

		// A file written before a name was the identity still holds the label the user chose. Reading it
		// as the name is what keeps an upgrade from showing them a slug they never typed.
		const fromLabel = coerceModelConfig({ label: "Claude Opus 5", id: "claude-opus-5", baseUrl: "http://x" });
		check("an older row's label becomes its name", fromLabel?.name === "Claude Opus 5", String(fromLabel?.name));
		check("and the label does not survive as a field", !Object.hasOwn(fromLabel ?? {}, "label"));

		// A file written before the config *was* the row spells the wire id `modelId`. Both are read,
		// which is what makes the rename an upgrade rather than a list of endpoints the user has to
		// retype — the same account `label` above settles, for the same reason.
		const fromModelId = coerceModelConfig({ modelId: "deepseek-chat", baseUrl: "http://x" });
		check("an older row's modelId is read as its id", fromModelId?.id === "deepseek-chat", String(fromModelId?.id));
		check("and the old spelling does not survive", !Object.hasOwn(fromModelId ?? {}, "modelId"));

		// A row no longer says which transport to use — there is one — so a transport field that arrives
		// from an older file is simply not part of a row, and the row is still accepted.
		const strayApi = coerceModelConfig({ id: "m", baseUrl: "http://x", api: "not-a-transport" });
		check("a stray transport field is ignored", strayApi?.id === "m", String(strayApi?.id));
		check("and never reaches the stored row", !Object.hasOwn(strayApi ?? {}, "api"));

		const sized = coerceModelConfig({ id: "m", baseUrl: "http://x", contextWindow: -1, maxTokens: "big" });
		check("a nonsense context window falls back", sized?.contextWindow === 200_000, String(sized?.contextWindow));
		check("and so does a nonsense token limit", sized?.maxTokens === 8_192, String(sized?.maxTokens));
	}

	// A hand-typed row carries no capability metadata, so the wire id is what decides what its model
	// accepts. Getting one of these wrong is a 400 from the API, not a cosmetic difference: a
	// temperature a model refuses fails the whole request. Levels no longer come from here — every row
	// is asked at the same four — so what this block can still check is the compat half.
	heading("what a Claude model accepts is derived from its wire id");
	{
		const model = (id: string) => createModel(row({ id }));

		const plain = model("claude-sonnet-4-5");
		check("a 4.5 model needs no overrides", plain.compat === undefined, JSON.stringify(plain.compat));
		check(
			"and offers every level the app has",
			JSON.stringify(thinkingLevelsFor()) === JSON.stringify(["off", "low", "high", "max"]),
			JSON.stringify(thinkingLevelsFor()),
		);

		const newer = model("claude-opus-4-7");
		check("4.7 rejects a temperature", newer.compat?.supportsTemperature === false, JSON.stringify(newer.compat));

		const gateway = model("anthropic/claude-opus-5");
		check("a gateway id names the same model", gateway.compat?.supportsTemperature === false, JSON.stringify(gateway.compat));

		check("a level the app names is kept", normalizeThinkingLevel("max") === "max", normalizeThinkingLevel("max"));
		check("a level nobody has falls back to off", normalizeThinkingLevel("turbo") === "off", normalizeThinkingLevel("turbo"));
		check("and asking for nothing is off", normalizeThinkingLevel(undefined) === "off", normalizeThinkingLevel(undefined));
	}

	// Thinking is one shape on every row: adaptive, with the strength on the request as an effort.
	// There is no token budget to send and no beta header to ask for, and no table decides what a
	// level is spelled as — it goes out as itself. These read the body on its way out, because that is
	// what any of this is about — a provider key is not needed to see what would have been sent.
	heading("every row is asked the same way");
	{
		// The level is not an option: it rides on the model the request is made with, which is the same
		// object that names the endpoint. So these build the model the way a session does — from the row
		// and the level — and read the body on its way out.
		const sent = async (
			row: ModelConfig,
			level?: "low" | "high" | "max",
		): Promise<{ body: Record<string, unknown>; headers: Headers }> => {
			let body: Record<string, unknown> = {};
			let headers = new Headers();
			const capture = (async (_input: unknown, init?: RequestInit) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				headers = new Headers(init?.headers as [string, string][]);
				throw new Error("captured on the way out");
			}) as typeof fetch;
			const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: Date.now() }];
			await anthropicMessages
				.stream(createModel(row, level), { messages }, {
					apiKey: "secret",
					fetch: capture,
				} satisfies SimpleStreamOptions)
				.result();
			return { body, headers };
		};
		const effortOf = (body: Record<string, unknown>): unknown => (body.output_config as { effort?: unknown } | undefined)?.effort;
		const switchOf = (body: Record<string, unknown>): unknown => (body.thinking as { type?: unknown } | undefined)?.type;
		const displayOf = (body: Record<string, unknown>): unknown => (body.thinking as { display?: unknown } | undefined)?.display;

		const claude = row({ id: "claude-opus-4-6" });
		const deepseek = row({ id: "deepseek-v4.1-flash" });
		const unknown = row({ id: "glm-4.6" });

		const claudeHigh = (await sent(claude, "high")).body;
		check("a Claude row turns thinking on adaptively", switchOf(claudeHigh) === "adaptive", JSON.stringify(claudeHigh.thinking));
		check("asks for its thinking as text", displayOf(claudeHigh) === "summarized", JSON.stringify(claudeHigh.thinking));
		check("and carries its strength as an effort", effortOf(claudeHigh) === "high", JSON.stringify(claudeHigh.output_config));
		check("sending no budget at all", !JSON.stringify(claudeHigh).includes("budget_tokens"), JSON.stringify(claudeHigh.thinking));
		check(
			"and nothing added to the conversation",
			(claudeHigh.messages as unknown[] | undefined)?.length === 1,
			JSON.stringify(claudeHigh.messages),
		);

		const deepseekHigh = await sent(deepseek, "high");
		check("a DeepSeek row is asked in the same shape", switchOf(deepseekHigh.body) === "adaptive", JSON.stringify(deepseekHigh.body.thinking));
		check("with its effort on the request", effortOf(deepseekHigh.body) === "high", JSON.stringify(deepseekHigh.body.output_config));
		check("and no budget either", !JSON.stringify(deepseekHigh.body).includes("budget_tokens"));
		check(
			"and no interleaved-thinking beta header to reject",
			deepseekHigh.headers.get("anthropic-beta") === null,
			String(deepseekHigh.headers.get("anthropic-beta")),
		);

		const deepseekMax = (await sent(deepseek, "max")).body;
		check("and max is sent as max", effortOf(deepseekMax) === "max", JSON.stringify(deepseekMax.output_config));

		// A row no table knows is asked the same way, which is the point: the app has one shape, and a
		// level that is its own spelling needs nothing said about it.
		const unknownHigh = (await sent(unknown, "high")).body;
		check("a row nothing here knows is asked in the same shape", switchOf(unknownHigh) === "adaptive", JSON.stringify(unknownHigh.thinking));
		check("with the level as its own effort", effortOf(unknownHigh) === "high", JSON.stringify(unknownHigh.output_config));

		// A model asked for no level at all is the same request as "off": nothing was asked for, so the
		// switch goes off rather than a strength being guessed at.
		const off = (await sent(claude)).body;
		check("no level turns the switch off", switchOf(off) === "disabled", JSON.stringify(off.thinking));
		check("and sends no effort at all", off.output_config === undefined, JSON.stringify(off.output_config));

		// "off" is a level like the others, not the absence of one, so it says so on the wire.
		const explicitOff = (await sent(claude, undefined)).body;
		check("an explicit off reads the same", JSON.stringify(explicitOff.thinking) === JSON.stringify(off.thinking));
	}

	heading("the store round-trips the file");
	{
		const store = ModelConfigStore.create(home);
		check("a missing file is no models", store.list().length === 0);

		store.replace([row({ name: "one" }), row({ name: "two", id: "claude-opus-5" })]);
		const reloaded = ModelConfigStore.create(home).list();
		check("both rows come back", reloaded.length === 2, String(reloaded.length));
		check("with their names", reloaded[0]?.name === "one" && reloaded[1]?.name === "two");
		check("their keys", reloaded[0]?.apiKey === "secret", String(reloaded[0]?.apiKey));
		check("and their endpoints", reloaded[1]?.baseUrl === "http://127.0.0.1:1/v1", String(reloaded[1]?.baseUrl));
		check("the file is where it is documented to be", modelsPath(home).endsWith("models.json"));
	}

	heading("the client is never sent a key");
	{
		const options = listModelOptions([row({ apiKey: "secret" })]);
		check("the key is absent from the wire shape", !Object.hasOwn(options[0] ?? {}, "apiKey"));
		check("its presence is reported instead", options[0]?.hasApiKey === true);
		check("a keyless row says so", listModelOptions([row({ apiKey: "" })])[0]?.hasApiKey === false);
		check("and the row's name is what the client names it by", options[0]?.name === "mine", String(options[0]?.name));
		// The transport is a fact about the build, so it is reported rather than chosen.
		check("and the transport is the one this build speaks", options[0]?.api === "anthropic-messages", String(options[0]?.api));
	}

	// The stateless surface: a session holds the choice the client sent — the row's name and the level —
	// and every model is built from it by looking the name up in the catalog. Nothing of the row is
	// kept anywhere, so an edit to the file reaches the next build with nothing to refresh. These read
	// the built model and the wire, so no provider key is needed here either.
	heading("a choice is looked up in the catalog, and every build reads it fresh");
	{
		const rows = [row()];
		const choice: ModelChoice = { name: "mine", thinkingLevel: "high" };
		const model = modelFor(choice, rows);
		check("the row is what answers the name", rowFor(choice, rows)?.id === "wire-model", String(rowFor(choice, rows)?.id));
		check("the build carries the row's wire id", model.id === "wire-model", String(model.id));
		check("the endpoint", model.baseUrl === "http://127.0.0.1:1/v1", String(model.baseUrl));
		check("the key, for the request path only", model.apiKey === "secret", String(model.apiKey));
		check("the window", model.contextWindow === 64_000, String(model.contextWindow));
		check("and the choice's level", model.thinkingLevel === "high", String(model.thinkingLevel));
		check("the constants the row never names are the constructor's", model.api === "anthropic-messages" && JSON.stringify(model.input) === JSON.stringify(["text"]), `${model.api} / ${JSON.stringify(model.input)}`);
		check("the choice itself gained nothing: it is a choice, not a copy of the row", JSON.stringify(choice) === '{"name":"mine","thinkingLevel":"high"}', JSON.stringify(choice));

		// The whole of "editing a model takes effect on the next request" is now this: nothing was cached
		// to invalidate, so the next build simply reads what the file says.
		rows[0]!.apiKey = "corrected";
		rows[0]!.contextWindow = 32_000;
		const reread = modelFor(choice, rows);
		check("a corrected key is on the next build, with nothing refreshed", reread.apiKey === "corrected", String(reread.apiKey));
		check("and a resized window is too", reread.contextWindow === 32_000, String(reread.contextWindow));

		// A build never inherits a field from an earlier one, because no state survives between them: a
		// row with no compat override builds without one, and a row that has one brings it.
		rows.push(row({ name: "plain", id: "deepseek-v4.1-flash" }));
		check("a row without a compat override builds without one", modelFor({ name: "plain" }, rows).compat === undefined, JSON.stringify(modelFor({ name: "plain" }, rows).compat));
		rows.push(row({ name: "claude", id: "claude-opus-4-7" }));
		check("and a row with one brings it", modelFor({ name: "claude" }, rows).compat?.supportsTemperature === false, JSON.stringify(modelFor({ name: "claude" }, rows).compat));

		// A level is normalized on the way into the model: a string the app has no name for lands on
		// "off", and no level at all stays none, which the wire reads as "do not think".
		check("a level nobody has builds as off", modelFor({ name: "mine", thinkingLevel: "turbo" }, rows).thinkingLevel === "off", String(modelFor({ name: "mine", thinkingLevel: "turbo" }, rows).thinkingLevel));
		check("no level builds as none", modelFor({ name: "mine" }, rows).thinkingLevel === undefined, String(modelFor({ name: "mine" }, rows).thinkingLevel));

		// A name no row answers does not throw. A session has to stay buildable — a snapshot, a usage
		// meter, and a failure message all read it — so the placeholder's facts answer under the name
		// that was asked for, and the transport is what refuses to send.
		check("a name no row answers finds no row", rowFor({ name: "nope" }, rows) === undefined);
		const missing = modelFor({ name: "nope" }, rows);
		check("but still builds, keeping the name that was asked for", missing.name === "nope", String(missing.name));
		check("on the placeholder's field table", missing.id === "no-model" && missing.contextWindow === 200_000, `${missing.id} / ${missing.contextWindow}`);
		const refused = await unconfiguredStream(missing).result();
		check("asking it for an answer fails", refused.stopReason === "error", String(refused.stopReason));
		check("with the sentence that says what to add", (refused.errorMessage ?? "").includes("No model is configured"), String(refused.errorMessage));
	}

	heading("the placeholder is a whole field table, and no row answers it");
	{
		const model = placeholderModel();
		check("it is recognised as the placeholder", isUnconfigured(model));
		check("and it is a whole field table, not a bare name", model.id === "no-model" && model.contextWindow === 200_000, `${model.id} / ${model.contextWindow}`);
		check("with no key of its own", model.apiKey === undefined, String(model.apiKey));
		check("no row's name answers it", rowFor({ name: model.name }, [row()]) === undefined);

		const message = await unconfiguredStream(model).result();
		check("asking it for an answer fails", message.stopReason === "error", String(message.stopReason));
		check("with a well-formed model on the failure", message.model === "no-model" && message.api === "anthropic-messages", `${message.model} / ${message.api}`);
	}
} finally {
	await rm(home, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nmodels ok\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
