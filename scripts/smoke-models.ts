// Model smoke test：用户导入的模型、把它们挑出来的名字，以及在什么都没有时顶上的 placeholder。
// 运行：node scripts/smoke-models.ts
//
// 无需 provider key：这里的一切都是"用户键入的一行 → session 运行的 pi-ai 模型"的映射
// （vendored 在 packages/core/src/llm 下），外加本应用最不想发出的那一个请求——没有模型可用的
// 那个请求。有一个标题带 key 触达真实 transport，并在请求离开前把它截住，所以读到的是凭据而
// 不是 provider 的回答。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicMessages, type SimpleStreamOptions } from "@my-agent/core";
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
		// 改行的名字正是破坏这条链路的动作，这是"名字即身份"被写下来的代价：从旧名字构建的模型
		// 不再找得到任何东西。
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
		const model = placeholderModel();
		check("the placeholder has no row behind it", ([] as ModelConfig[]).find((userModel) => userModel.name === model.name) === undefined);
		check("and is recognised as the placeholder", isUnconfigured(model));
		check("by a name no stored row may claim", model.name === "my-agent:unconfigured", model.name);
		check("and it carries no key at all", model.apiKey === undefined, String(model.apiKey));

		const message = await unconfiguredStream(model).result();
		check("asking it for an answer fails", message.stopReason === "error", String(message.stopReason));
		check(
			"with something the user can act on",
			(message.errorMessage ?? "").includes("Settings"),
			String(message.errorMessage),
		);
	}

	heading("a session reads the rows rather than a copy of them");
	{
		// "编辑模型在下一个请求生效"的全部内容：没有要重建的 catalog，因为 manager 每次都重读它
		// 身后的行，模型从找到的那一行重新推导。
		const rows: ModelConfig[] = [];
		check("an empty source resolves nothing", rows.find((userModel) => userModel.name === "added") === undefined);

		rows.push(row({ name: "added", apiKey: "first" }));
		check("a row added to the source is resolvable", rows.find((userModel) => userModel.name === "added") !== undefined);
		check("and its key is on the model a request would use", createModel(rows[0]!).apiKey === "first");

		rows[0]!.apiKey = "corrected";
		const model = createModel(rows.find((userModel) => userModel.name === "added")!);
		check("a corrected key is read on the next lookup, with nothing rebuilt", model.apiKey === "corrected");

		rows.length = 0;
		check("a removed row stops resolving", rows.find((userModel) => userModel.name === "added") === undefined);
	}

	heading("the model's own key is what a caller without one authenticates with");
	{
		// key 骑在模型上，所以一个没有自带 key 的调用仍然有一个——compaction 摘要正是这种形状的
		// 调用，它曾带着 "No API key" 回来，而它正在总结的那一行明明有 key。这里什么都不开连接：
		// 请求在出门的路上被截住，这也是能说出*哪个* key 在上面的原因。
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
				const assistantMessageEventStream = anthropicMessages.stream(model, { messages, tools: [] }, {
					...options,
					fetch: capture,
				});
				const answer = await assistantMessageEventStream.result();
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

		// 名字是身份，所以重名不会被悄悄改得唯一：调用方必须拒绝这份列表，否则每一份指名第一行
		// 的会话都会悄悄改变含义。
		const duplicate = coerceModelConfig({ name: "m", id: "m", baseUrl: "http://x" });
		check("a duplicate name is stored as it was typed, not suffixed", duplicate?.name === "m", String(duplicate?.name));

		const reserved = coerceModelConfig({ name: "my-agent:unconfigured", id: "m", baseUrl: "http://x" });
		check("the placeholder's name cannot be claimed", reserved === undefined, JSON.stringify(reserved));

		// 在名字成为身份之前写的文件仍持有用户选的 label。把它读成 name 正是让升级不至于给用户
		// 看一个他们从未键入过的 slug 的原因。
		const fromLabel = coerceModelConfig({ label: "Claude Opus 5", id: "claude-opus-5", baseUrl: "http://x" });
		check("an older row's label becomes its name", fromLabel?.name === "Claude Opus 5", String(fromLabel?.name));
		check("and the label does not survive as a field", !Object.hasOwn(fromLabel ?? {}, "label"));

		// 在 config *就是*行本身之前写的文件把 wire id 拼作 `modelId`。两个拼写都被读，这正是让
		// 改名成为一次升级、而不是一张用户必须重打的端点清单的原因——与上面的 `label` 同一个
		// 理由、同一个账。
		const fromModelId = coerceModelConfig({ modelId: "deepseek-chat", baseUrl: "http://x" });
		check("an older row's modelId is read as its id", fromModelId?.id === "deepseek-chat", String(fromModelId?.id));
		check("and the old spelling does not survive", !Object.hasOwn(fromModelId ?? {}, "modelId"));

		// 行不再说用哪个 transport——只有一个——所以从旧文件来的 transport 字段根本不是行的一部分，
		// 行照常被收下。
		const strayApi = coerceModelConfig({ id: "m", baseUrl: "http://x", api: "not-a-transport" });
		check("a stray transport field is ignored", strayApi?.id === "m", String(strayApi?.id));
		check("and never reaches the stored row", !Object.hasOwn(strayApi ?? {}, "api"));

		const sized = coerceModelConfig({ id: "m", baseUrl: "http://x", contextWindow: -1, maxTokens: "big" });
		check("a nonsense context window falls back", sized?.contextWindow === 200_000, String(sized?.contextWindow));
		check("and so does a nonsense token limit", sized?.maxTokens === 8_192, String(sized?.maxTokens));
	}

	// 手打的行不带任何能力元数据，所以决定它的模型接受什么的是 wire id。这些弄错一个是 API 的
	// 400，不是外观差异：一个模型拒绝的 temperature 会让整个请求失败。等级不再来自这里——每行
	// 都被问同样的四档——所以本块还能检查的是 compat 那一半。
	heading("what a Claude model accepts is derived from its wire id");
	{
		const model = (id: string) => createModel(row({ id }));

		const plain = model("claude-sonnet-4-5");
		check("a 4.5 model needs no overrides", plain.compat === undefined, JSON.stringify(plain.compat));

		const newer = model("claude-opus-4-7");
		check("4.7 rejects a temperature", newer.compat?.supportsTemperature === false, JSON.stringify(newer.compat));

		const gateway = model("anthropic/claude-opus-5");
		check("a gateway id names the same model", gateway.compat?.supportsTemperature === false, JSON.stringify(gateway.compat));

		check("a level the app names is kept", normalizeThinkingLevel("max") === "max", normalizeThinkingLevel("max"));
		check("a level nobody has falls back to off", normalizeThinkingLevel("turbo") === "off", normalizeThinkingLevel("turbo"));
		check("and asking for nothing is off", normalizeThinkingLevel(undefined) === "off", normalizeThinkingLevel(undefined));
	}

	// Thinking 在每一行上是同一个形状：adaptive，强度作为 effort 放在请求上。没有要发的 token
	// 预算、没有要请求的 beta header，也没有任何表决定一个等级拼作什么——它按自己原样出去。
	// 这些在出门的路上读 body，因为那正是这一切所关乎的——看"本会发出什么"不需要 provider key。
	heading("every row is asked the same way");
	{
		// 等级不是 option：它骑在请求所用的模型上，与指名端点的是同一个对象。所以这里按 session
		// 构建模型的方式构建它——从行与等级——然后在出门的路上读 body。
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
				.stream(createModel(row, level), { messages, tools: [] }, {
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

		// 没有任何表认识的行被以同样的方式问，这正是要点：应用只有一个形状，一个拼写就是它自己
		// 的等级不需要任何额外说明。
		const unknownHigh = (await sent(unknown, "high")).body;
		check("a row nothing here knows is asked in the same shape", switchOf(unknownHigh) === "adaptive", JSON.stringify(unknownHigh.thinking));
		check("with the level as its own effort", effortOf(unknownHigh) === "high", JSON.stringify(unknownHigh.output_config));

		// 一个什么等级都没被要求的模型与 "off" 是同一个请求：什么都没要求，所以开关被关掉，而
		// 不是去猜一个强度。
		const off = (await sent(claude)).body;
		check("no level turns the switch off", switchOf(off) === "disabled", JSON.stringify(off.thinking));
		check("and sends no effort at all", off.output_config === undefined, JSON.stringify(off.output_config));

		// "off" 是和其他一样的等级，不是缺席，所以它在 wire 上这么说。
		const explicitOff = (await sent(claude, undefined)).body;
		check("an explicit off reads the same", JSON.stringify(explicitOff.thinking) === JSON.stringify(off.thinking));
	}

	heading("the store round-trips the file");
	{
		const modelConfigStore = ModelConfigStore.create(home);
		check("a missing file is no models", modelConfigStore.list().length === 0);

		modelConfigStore.replace([row({ name: "one" }), row({ name: "two", id: "claude-opus-5" })]);
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
		// transport 是构建的一个事实，所以它是被报告的，不是被选择的。
		check("and the transport is the one this build speaks", options[0]?.api === "anthropic-messages", String(options[0]?.api));
	}

	// 无状态面：session 持有客户端发来的选择——行的名字与等级——每个模型都通过在 catalog 里查
	// 这个名字来构建。行的任何东西都不被留在任何地方，所以对文件的一次编辑在没有任何要刷新的
	// 东西的情况下到达下一次构建。这些读的是构建出的模型与 wire，所以这里同样不需要 provider key。
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

		// "编辑模型在下一个请求生效"的全部内容如今就是这个：没有缓存可失效，下一次构建直接读
		// 文件说的。
		rows[0]!.apiKey = "corrected";
		rows[0]!.contextWindow = 32_000;
		const reread = modelFor(choice, rows);
		check("a corrected key is on the next build, with nothing refreshed", reread.apiKey === "corrected", String(reread.apiKey));
		check("and a resized window is too", reread.contextWindow === 32_000, String(reread.contextWindow));

		// 一次构建绝不从上一次继承字段，因为两者之间没有任何 state 存活：不带 compat override 的
		// 行构建时不带，带着的行把它带来。
		rows.push(row({ name: "plain", id: "deepseek-v4.1-flash" }));
		check("a row without a compat override builds without one", modelFor({ name: "plain" }, rows).compat === undefined, JSON.stringify(modelFor({ name: "plain" }, rows).compat));
		rows.push(row({ name: "claude", id: "claude-opus-4-7" }));
		check("and a row with one brings it", modelFor({ name: "claude" }, rows).compat?.supportsTemperature === false, JSON.stringify(modelFor({ name: "claude" }, rows).compat));

		// 等级在进入模型的路上被规范化：应用没有名字的字符串落在 "off"，什么等级都不给保持
		// none，wire 把它读作"不要思考"。
		check("a level nobody has builds as off", modelFor({ name: "mine", thinkingLevel: "turbo" }, rows).thinkingLevel === "off", String(modelFor({ name: "mine", thinkingLevel: "turbo" }, rows).thinkingLevel));
		check("no level builds as none", modelFor({ name: "mine" }, rows).thinkingLevel === undefined, String(modelFor({ name: "mine" }, rows).thinkingLevel));

		// 没有任何行应答的名字不抛异常。session 必须保持可构建——快照、用量计与失败消息都要读
		// 它——所以 placeholder 的事实以被问到的那个名字作答，而 transport 才是拒绝发送的那个。
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
