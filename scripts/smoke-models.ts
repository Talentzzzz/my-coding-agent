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
	fillModel,
	isUnconfigured,
	listModelOptions,
	createModel,
	modelsPath,
	normalizeThinkingLevel,
	placeholderModel,
	placeholderModelState,
	resolvedModel,
	thinkingLevelsFor,
	unconfiguredStream,
	ModelConfigStore,
	type ModelState,
	type ModelSource,
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
		const source: ModelSource = { list: () => rows };
		const resolved = source.list().find((userModel) => userModel.name === "mine");
		check("the row is found by the name the user typed", resolved?.name === "mine", String(resolved?.name));

		const model = createModel(resolved!);
		check("whose wire id is what the endpoint is asked for", model.id === "wire-model", String(model.id));
		check("carrying the row's base URL", model.baseUrl === "http://127.0.0.1:1/v1", String(model.baseUrl));
		check("and the row's context window", model.contextWindow === 64_000, String(model.contextWindow));
		check("and its name as `name`", model.name === "mine", String(model.name));
		check("and its key, so the request carries its own credential", model.apiKey === "secret", String(model.apiKey));
		check("and is not the placeholder", !isUnconfigured(model));

		check("an unknown name resolves to nothing", source.list().find((userModel) => userModel.name === "nope") === undefined);
	}

	heading("the row behind a model is found by the name it carries");
	{
		const rows = [row()];
		const source: ModelSource = { list: () => rows };
		const model = createModel(rows[0]!);
		check("the model's row is found by the name it carries", source.list().find((userModel) => userModel.name === model.name)?.apiKey === "secret");
		check("and a model with no row behind it has none", source.list().find((userModel) => userModel.name === placeholderModel().name) === undefined);
		// Renaming the row is exactly what breaks the link, which is the documented cost of a name being
		// an identity: the model that was built from the old name no longer finds anything.
		rows[0]!.name = "renamed";
		const stale = createModel(row({ name: "mine" }));
		check("a renamed row stops answering to the old name", source.list().find((userModel) => userModel.name === stale.name) === undefined);
	}
	heading("two rows on one vendor keep their own keys");
	{
		const rows = [row({ name: "work", apiKey: "work-key" }), row({ name: "home", apiKey: "home-key" })];
		const source: ModelSource = { list: () => rows };
		const first = createModel(rows[0]!);
		const second = createModel(rows[1]!);
		check("the first row's key is the first row's", source.list().find((userModel) => userModel.name === first.name)?.apiKey === "work-key");
		check("and the second row's is not it", source.list().find((userModel) => userModel.name === second.name)?.apiKey === "home-key");
	}

	heading("with no rows, the answer says what to add");
	{
		const placeholder = placeholderModel();
		check("the placeholder has no row behind it", { list: () => [] }.list().find((userModel) => userModel.name === placeholder.name) === undefined);
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
		// rebuild, because a session holds the source and re-derives the model from it each time.
		const rows: ModelConfig[] = [];
		const source: ModelSource = { list: () => rows };
		check("an empty source resolves nothing", source.list().find((userModel) => userModel.name === "added") === undefined);

		rows.push(row({ name: "added", apiKey: "first" }));
		check("a row added to the source is resolvable", source.list().find((userModel) => userModel.name === "added") !== undefined);
		check("and its key is on the model a request would use", createModel(rows[0]!).apiKey === "first");

		rows[0]!.apiKey = "corrected";
		const rederived = createModel(source.list().find((userModel) => userModel.name === "added")!);
		check("a corrected key is read on the next lookup, with nothing rebuilt", rederived.apiKey === "corrected");

		rows.length = 0;
		check("a removed row stops resolving", source.list().find((userModel) => userModel.name === "added") === undefined);
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
				headers = new Headers(init?.headers as HeadersInit);
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

	// The stateless surface: a session holds the seed the client sent — the row's name and the level —
	// and `fillModel` lays the row's facts over it, in place, before anything reads them. The request
	// object is built from the bag at send time and dropped. These read the bag and the wire, so no
	// provider key is needed here either.
	heading("a bag is seeded with a name and filled from the catalog");
	{
		const rows = [row()];
		const state: ModelState = { name: "mine", thinkingLevel: "high" };
		const filled = state;
		fillModel(rows, state);
		check("fill lays the row's facts into the same bag, not a copy", filled === state && filled.id === "wire-model", String(filled?.id));
		check("the endpoint arrives", filled.baseUrl === "http://127.0.0.1:1/v1", String(filled.baseUrl));
		check("the key arrives, for the request path only", filled.apiKey === "secret", String(filled.apiKey));
		check("the window arrives", filled.contextWindow === 64_000, String(filled.contextWindow));
		check("and the seed's level is kept", filled.thinkingLevel === "high", String(filled.thinkingLevel));

		// Nothing of the row it last saw survives a refill: the whole of "editing a model takes effect
		// on the next request" is this, run again before every request.
		rows[0]!.apiKey = "corrected";
		rows[0]!.contextWindow = 32_000;
		fillModel(rows, state);
		check("a corrected key is laid in on the next fill, with nothing rebuilt", filled.apiKey === "corrected", String(filled.apiKey));
		check("and a resized window is too", filled.contextWindow === 32_000, String(filled.contextWindow));

		// A bag moving to a row that does not name a compat override must lose the old one, not keep it:
		// the override described the endpoint that used to be here.
		rows.push(row({ name: "plain", id: "deepseek-v4.1-flash" }));
		state.name = "plain";
		fillModel(rows, state);
		check("a row without a compat override leaves none behind", filled.compat === undefined, JSON.stringify(filled.compat));
		rows.push(row({ name: "claude", id: "claude-opus-4-7" }));
		state.name = "claude";
		fillModel(rows, state);
		check("and a row that has one lays it in", filled.compat?.supportsTemperature === false, JSON.stringify(filled.compat));
		state.name = "plain";
		fillModel(rows, state);
		check("and moving back drops it again", filled.compat === undefined, JSON.stringify(filled.compat));
		state.name = "mine";

		// A level is the seed's to name and the fill's to normalize: a string the app has no name for
		// lands on "off" by the time it is asked at, and no level at all stays none.
		state.thinkingLevel = "turbo";
		fillModel(rows, state);
		check("a level nobody has fills as off", filled.thinkingLevel === "off", String(filled.thinkingLevel));
		delete filled.thinkingLevel;
		fillModel(rows, state);
		check("no level fills as none", filled.thinkingLevel === undefined, String(filled.thinkingLevel));

		// The request object is run-local: built from the bag, used once, dropped. The constants the
		// row never names are its constructor's, not the fill's.
		filled.thinkingLevel = "max";
		const request = resolvedModel(filled);
		check("the request object carries the bag's wire id", request.id === "wire-model", String(request.id));
		check("and its level", request.thinkingLevel === "max", String(request.thinkingLevel));
		check("and the build's one transport is defaulted in", request.api === "anthropic-messages", String(request.api));
		check("and the build's input is too", JSON.stringify(request.input) === JSON.stringify(["text"]), JSON.stringify(request.input));

		let threw: string | undefined;
		try {
			fillModel(rows, { name: "nope" });
		} catch (error) {
			threw = error instanceof Error ? error.message : String(error);
		}
		check("a name no row answers throws", threw !== undefined, String(threw));
		check("and says which name went unanswered", (threw ?? "").includes("nope"), String(threw));
	}

	heading("the placeholder seed is complete and never fills");
	{
		const state = placeholderModelState();
		check("the seed is recognised as the placeholder", isUnconfigured(state));
		check("and it is a whole field table, not a bare name", state.id === "no-model" && state.contextWindow === 200_000, JSON.stringify(state));
		check("with no key of its own", state.apiKey === undefined, String(state.apiKey));

		// The name is reserved, so no catalog row can ever answer it: the fill refuses, and the stream
		// — not a request to the dead endpoint — is what a session answers with.
		let threw: string | undefined;
		try {
			fillModel([row()], state);
		} catch (error) {
			threw = error instanceof Error ? error.message : String(error);
		}
		check("no row fills a reserved name", threw !== undefined, String(threw));

		const message = await unconfiguredStream(resolvedModel(state)).result();
		check("asking it for an answer fails", message.stopReason === "error", String(message.stopReason));
		check("with a well-formed model on the failure", message.model === "no-model" && message.api === "anthropic-messages", `${message.model} / ${message.api}`);
	}
} finally {
	await rm(home, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nmodels ok\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
