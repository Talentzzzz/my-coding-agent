// Model smoke test: the user's imported models, the refs that name them, and the placeholder that
// stands in for none. Run with: node scripts/smoke-models.ts
//
// No provider key: everything here is the mapping from a row the user typed to the pi-ai model a
// session runs (vendored as @my-agent/ai), plus the one request this app never wants to make — the one
// that has no model to make it with. One heading reaches the real transport with a key, and captures
// the request before it leaves, so what it reads is the credential rather than a provider's answer.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicMessages, normalizeContext, type SimpleStreamOptions } from "@my-agent/ai";
import {
	coerceModel,
	isUnconfigured,
	listModelOptions,
	modelFor,
	modelRefOf,
	modelsPath,
	normalizeThinkingLevel,
	placeholderModel,
	resolveModelRef,
	rowFor,
	rowNameFromRef,
	thinkingLevelsFor,
	unconfiguredStream,
	UserModelStore,
	type ModelSource,
	type UserModel,
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

function row(overrides: Partial<UserModel> = {}): UserModel {
	return {
		name: "mine",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "secret",
		modelId: "wire-model",
		contextWindow: 64_000,
		maxTokens: 4_096,
		reasoning: false,
		...overrides,
	};
}

const home = await mkdtemp(join(tmpdir(), "my-agent-models-"));

try {
	heading("a row becomes a runnable model");
	{
		const rows = [row()];
		const ref = modelRefOf(row());
		check("the ref is the row name and the wire id", ref === "mine/wire-model", ref);

		const resolved = resolveModelRef(rows, ref);
		check("the ref resolves", resolved !== undefined);
		check("to the row the user typed", resolved?.name === "mine", String(resolved?.name));

		const model = modelFor(resolved!);
		check("whose wire id is what the endpoint is asked for", model.id === "wire-model", String(model.id));
		check("carrying the row's base URL", model.baseUrl === "http://127.0.0.1:1/v1", String(model.baseUrl));
		check("and the row's context window", model.contextWindow === 64_000, String(model.contextWindow));
		check("and its name as `name`", model.name === "mine", String(model.name));
		check("and its key, so the request carries its own credential", model.apiKey === "secret", String(model.apiKey));
		check("and is not the placeholder", !isUnconfigured(model));

		const bare = resolveModelRef(rows, "wire-model");
		check("a bare wire id resolves when only one row has it", bare?.name === "mine", String(bare?.name));

		check("an unknown ref resolves to nothing", resolveModelRef(rows, "nope/nope") === undefined);
		check("the row name comes back out of the ref", rowNameFromRef(ref) === "mine", rowNameFromRef(ref));
	}

	heading("the row behind a model is found by the name it carries");
	{
		const rows = [row()];
		const source: ModelSource = { list: () => rows };
		check("the model's row is found by the name it carries", rowFor(source, modelFor(rows[0]!))?.apiKey === "secret");
		check("and a model with no row behind it has none", rowFor(source, placeholderModel()) === undefined);
		// Renaming the row is exactly what breaks the link, which is the documented cost of a name being
		// an identity: the model that was built from the old name no longer finds anything.
		rows[0]!.name = "renamed";
		check("a renamed row stops answering to the old name", rowFor(source, modelFor(row({ name: "mine" }))) === undefined);
	}
	heading("two rows on one vendor keep their own keys");
	{
		const rows = [row({ name: "work", apiKey: "work-key" }), row({ name: "home", apiKey: "home-key" })];
		const source: ModelSource = { list: () => rows };
		check("the first row's key is the first row's", rowFor(source, modelFor(rows[0]!))?.apiKey === "work-key");
		check("and the second row's is not it", rowFor(source, modelFor(rows[1]!))?.apiKey === "home-key");
	}

	heading("with no rows, the answer says what to add");
	{
		const placeholder = placeholderModel();
		check("the placeholder has no row behind it", rowFor({ list: () => [] }, placeholder) === undefined);
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
		const rows: UserModel[] = [];
		const source: ModelSource = { list: () => rows };
		check("an empty source resolves nothing", resolveModelRef(source.list(), "added/wire-model") === undefined);

		rows.push(row({ name: "added", apiKey: "first" }));
		check("a row added to the source is resolvable", resolveModelRef(source.list(), "added/wire-model") !== undefined);
		check("and its key is on the model a request would use", modelFor(rows[0]!).apiKey === "first");

		rows[0]!.apiKey = "corrected";
		const rederived = modelFor(resolveModelRef(source.list(), "added/wire-model")!);
		check("a corrected key is read on the next lookup, with nothing rebuilt", rederived.apiKey === "corrected");

		rows.length = 0;
		check("a removed row stops resolving", resolveModelRef(source.list(), "added/wire-model") === undefined);
	}

	heading("the model's own key is what a caller without one authenticates with");
	{
		// A key rides on the model, so a call that names no key of its own still has one — the
		// compaction summary is the call shaped like that, and it used to come back with "No API key"
		// while the row it was summarizing had one all along. Nothing here opens a connection: the
		// request is captured on its way out, which is also what says *which* key was on it.
		const attempt = async (
			model: ReturnType<typeof modelFor>,
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
				const stream = anthropicMessages.streamSimple(model, normalizeContext({ messages }), {
					...options,
					fetch: capture,
				});
				const answer = await stream.result();
				return { key, authorization, message: answer.errorMessage ?? "" };
			} catch (error) {
				return { key, authorization, message: error instanceof Error ? error.message : String(error) };
			}
		};

		const keyed = await attempt(modelFor(row({ apiKey: "secret" })));
		check("a keyed row sends the row's key, with no key passed in", keyed.key === "secret", String(keyed.key));

		const keyless = await attempt(modelFor(row({ apiKey: "" })));
		check("a row with no key still fails in setup", keyless.message.includes("No API key"), keyless.message);

		const byHeader = await attempt(modelFor(row({ apiKey: "" })), { headers: { authorization: "Bearer gateway" } });
		check(
			"and a gateway's own credential is what reaches the request instead",
			byHeader.authorization === "Bearer gateway" && byHeader.key === "",
			`${byHeader.authorization} / ${byHeader.key}`,
		);

		const explicit = await attempt(modelFor(row({ apiKey: "stale" })), { apiKey: "passed-in" });
		check("while a key the caller passes wins over the row's", explicit.key === "passed-in", String(explicit.key));
	}

	heading("rows are validated rather than trusted");
	{
		check("a row without a model id is refused", coerceModel({ baseUrl: "http://x" }) === undefined);
		check("a row without a base URL is refused", coerceModel({ modelId: "m" }) === undefined);

		const derived = coerceModel({ name: "DeepSeek Chat", modelId: "deepseek-chat", baseUrl: "http://x" });
		check("a name is kept as it was typed", derived?.name === "DeepSeek Chat", String(derived?.name));

		const unnamed = coerceModel({ modelId: "deepseek-chat", baseUrl: "http://x" });
		check("a missing name falls back to the wire id", unnamed?.name === "deepseek-chat", String(unnamed?.name));

		// A name is an identity, so a duplicate is not quietly made unique: the caller has to refuse the
		// list, or every transcript referring to the first row would silently change meaning.
		const duplicate = coerceModel({ name: "m", modelId: "m", baseUrl: "http://x" });
		check("a duplicate name is stored as it was typed, not suffixed", duplicate?.name === "m", String(duplicate?.name));

		const reserved = coerceModel({ name: "my-agent:unconfigured", modelId: "m", baseUrl: "http://x" });
		check("the placeholder's name cannot be claimed", reserved === undefined, JSON.stringify(reserved));

		// A file written before a name was the identity still holds the label the user chose. Reading it
		// as the name is what keeps an upgrade from showing them a slug they never typed.
		const fromLabel = coerceModel({ label: "Claude Opus 5", modelId: "claude-opus-5", baseUrl: "http://x" });
		check("an older row's label becomes its name", fromLabel?.name === "Claude Opus 5", String(fromLabel?.name));
		check("and the label does not survive as a field", !Object.hasOwn(fromLabel ?? {}, "label"));

		// A row no longer says which transport to use — there is one — so a transport field that arrives
		// from an older file is simply not part of a row, and the row is still accepted.
		const strayApi = coerceModel({ modelId: "m", baseUrl: "http://x", api: "not-a-transport" });
		check("a stray transport field is ignored", strayApi?.modelId === "m", String(strayApi?.modelId));
		check("and never reaches the stored row", !Object.hasOwn(strayApi ?? {}, "api"));

		const sized = coerceModel({ modelId: "m", baseUrl: "http://x", contextWindow: -1, maxTokens: "big" });
		check("a nonsense context window falls back", sized?.contextWindow === 200_000, String(sized?.contextWindow));
		check("and so does a nonsense token limit", sized?.maxTokens === 8_192, String(sized?.maxTokens));
	}

	// A hand-typed row carries no capability metadata, so the wire id is what decides what its model
	// accepts. Getting one of these wrong is a 400 from the API, not a cosmetic difference: an effort
	// the model has no native level for is rejected, and so is a temperature a model refuses.
	heading("what a Claude model accepts is derived from its wire id");
	{
		const model = (modelId: string, reasoning = true) => modelFor(row({ modelId, reasoning }));

		const plain = model("claude-sonnet-4-5");
		check("a 4.5 model needs no overrides", plain.compat === undefined, JSON.stringify(plain.compat));
		check("and has no level list of its own", plain.thinkingLevelMap === undefined, JSON.stringify(plain.thinkingLevelMap));
		check(
			"so it offers the default levels",
			JSON.stringify(thinkingLevelsFor(plain)) === JSON.stringify(["off", "low", "medium", "high"]),
			JSON.stringify(thinkingLevelsFor(plain)),
		);

		const newer = model("claude-opus-4-7");
		check("4.7 takes a max effort", newer.thinkingLevelMap?.max === "max", JSON.stringify(newer.thinkingLevelMap));
		check("and rejects a temperature", newer.compat?.supportsTemperature === false, JSON.stringify(newer.compat));

		const newerGeneration = model("claude-opus-5");
		check("opus-5 takes a max effort too", newerGeneration.thinkingLevelMap?.max === "max", JSON.stringify(newerGeneration.thinkingLevelMap));
		check(
			"and rejects a temperature like 4.7",
			newerGeneration.compat?.supportsTemperature === false,
			JSON.stringify(newerGeneration.compat),
		);
		check("so off is a level it has", thinkingLevelsFor(newerGeneration).includes("off"), JSON.stringify(thinkingLevelsFor(newerGeneration)));
		check("a level it has is kept", normalizeThinkingLevel(newerGeneration, "max") === "max", normalizeThinkingLevel(newerGeneration, "max"));
		check(
			"and a level nobody has still falls back to the quietest one",
			normalizeThinkingLevel(newerGeneration, "turbo") === "off",
			normalizeThinkingLevel(newerGeneration, "turbo"),
		);

		const alwaysThinking = model("claude-fable-5");
		check("fable-5 takes a max effort", alwaysThinking.thinkingLevelMap?.max === "max", JSON.stringify(alwaysThinking.thinkingLevelMap));
		check(
			"and has no way to stop thinking",
			JSON.stringify(thinkingLevelsFor(alwaysThinking)) === JSON.stringify(["low", "medium", "high", "max"]),
			JSON.stringify(thinkingLevelsFor(alwaysThinking)),
		);

		const gateway = model("anthropic/claude-opus-5");
		check("a gateway id names the same model", gateway.thinkingLevelMap?.max === "max", JSON.stringify(gateway.thinkingLevelMap));

		const silent = model("claude-opus-5", false);
		check("a row that does not reason is asked for no thinking parameters", silent.compat === undefined, JSON.stringify(silent.compat));
		check("so its only level is off", JSON.stringify(thinkingLevelsFor(silent)) === JSON.stringify(["off"]), JSON.stringify(thinkingLevelsFor(silent)));
	}

	heading("a DeepSeek row spells its levels as the three efforts it takes");
	{
		// Its Anthropic-compatible endpoint reads the strength from `output_config.effort` — the shape
		// every row is asked in now — and takes three efforts rather than the app's four, so its map is
		// what keeps `medium` from going out as a value the endpoint rejects.
		const deepseek = modelFor(row({ modelId: "deepseek-v4.1-flash", reasoning: true }));
		check("the row needs no compatibility overrides", deepseek.compat === undefined, JSON.stringify(deepseek.compat));
		check(
			"the four levels fold onto the three efforts it takes",
			JSON.stringify(deepseek.thinkingLevelMap) === JSON.stringify({ low: "low", medium: "high", high: "high", max: "max" }),
			JSON.stringify(deepseek.thinkingLevelMap),
		);
		check(
			"and off stays a level, because the switch is not an effort",
			JSON.stringify(thinkingLevelsFor(deepseek)) === JSON.stringify(["off", "low", "medium", "high", "max"]),
			JSON.stringify(thinkingLevelsFor(deepseek)),
		);
	}

	// Thinking is one shape on every row: adaptive, with the strength on the request as an effort.
	// There is no token budget to send and no beta header to ask for, and a family that cannot stop
	// thinking is not told to. These read the body on its way out, because that is what any of this is
	// about — a provider key is not needed to see what would have been sent.
	heading("every reasoning row is asked the same way");
	{
		// The level is not an option: it rides on the model the request is made with, which is the same
		// object that names the endpoint. So these build the model the way a session does — from the row
		// and the level — and read the body on its way out.
		const sent = async (
			row: UserModel,
			level?: "low" | "medium" | "high" | "max",
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
				.streamSimple(modelFor(row, level), normalizeContext({ messages }), {
					apiKey: "secret",
					fetch: capture,
				} satisfies SimpleStreamOptions)
				.result();
			return { body, headers };
		};
		const effortOf = (body: Record<string, unknown>): unknown => (body.output_config as { effort?: unknown } | undefined)?.effort;
		const switchOf = (body: Record<string, unknown>): unknown => (body.thinking as { type?: unknown } | undefined)?.type;
		const displayOf = (body: Record<string, unknown>): unknown => (body.thinking as { display?: unknown } | undefined)?.display;

		const claude = row({ modelId: "claude-opus-4-6", reasoning: true });
		const deepseek = row({ modelId: "deepseek-v4.1-flash", reasoning: true });
		const unknown = row({ modelId: "glm-4.6", reasoning: true });

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

		const deepseekMedium = (await sent(deepseek, "medium")).body;
		check("a level it has no effort for folds onto one it does", effortOf(deepseekMedium) === "high", JSON.stringify(deepseekMedium.output_config));

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

		// Fable 5 has no off to be in, so it is not asked for one.
		const alwaysThinking = row({ modelId: "claude-fable-5", reasoning: true });
		const cannotStop = (await sent(alwaysThinking)).body;
		check("a family that cannot stop thinking is sent no switch at all", cannotStop.thinking === undefined, JSON.stringify(cannotStop.thinking));
	}

	heading("the store round-trips the file");
	{
		const store = UserModelStore.create(home);
		check("a missing file is no models", store.list().length === 0);

		store.replace([row({ name: "one" }), row({ name: "two", modelId: "claude-opus-5", reasoning: true })]);
		const reloaded = UserModelStore.create(home).list();
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
} finally {
	await rm(home, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nmodels ok\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
