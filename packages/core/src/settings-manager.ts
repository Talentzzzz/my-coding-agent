import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	AGENT_HOME,
	mergeSettings,
	projectSettingsPath,
	settingsPath,
	type AppearanceSettings,
	type BashSettings,
	type RetrySettings,
	type Settings,
} from "./config.ts";
import type { QueueMode, ToolApprovalKey } from "./protocol.ts";

/**
 * The two files a session's settings come from.
 *
 * `global` is this machine's own file under the agent home. `project` is the workspace's
 * `.my-agent/settings.json`, which a repository can commit so a checkout brings its own approvals and
 * limits along. Project wins field by field, and nested objects merge — a project that names
 * `approval.write` keeps the global `approval.bash` beside it — so the two layers are read as one
 * settings object rather than as a choice between them.
 */
export type SettingsScope = "global" | "project";

/** One file's contents: the keys it actually carries, unknown ones included. */
type SettingsLayer = Record<string, unknown>;

/** A partial change to the settings, shaped like the config patch the browser sends. */
export interface SettingsPatch {
	model?: string;
	approval?: Partial<Record<ToolApprovalKey, boolean>>;
	/** Theme and font size. Part of a patch so one field can move without the other. */
	appearance?: Partial<AppearanceSettings>;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	retry?: Partial<RetrySettings>;
	/** How long the `bash` tool lets one command run. Partial so one timeout can move without the other. */
	bash?: Partial<BashSettings>;
}

/**
 * Where a scope's settings are read and written.
 *
 * Injected so the manager never picks the files it touches: the real one writes the global and project
 * paths for a workspace, and a test gets an in-memory one. A host that keeps settings somewhere else —
 * a database, a per-user store, a sandbox — supplies a different object rather than a manager change.
 */
export interface SettingsStorage {
	/** The scope's current text, or undefined when there is nothing there yet. */
	read(scope: SettingsScope): string | undefined;
	/** Replace the scope's text, creating the directory when it does not exist. */
	write(scope: SettingsScope, content: string): void;
	/** The file behind a scope, for error messages. */
	path(scope: SettingsScope): string;
}

/** The two real files: `<agent home>/settings.json` and `<workspace>/.my-agent/settings.json`. */
export class FileSettingsStorage implements SettingsStorage {
	private readonly paths: Record<SettingsScope, string>;

	constructor(globalPath: string, projectPath: string) {
		this.paths = { global: globalPath, project: projectPath };
	}

	read(scope: SettingsScope): string | undefined {
		try {
			return readFileSync(this.paths[scope], "utf8");
		} catch (error) {
			// A missing file is the normal first run. Anything else — a permission, a directory in the
			// way — is a real failure, and must not reach the caller as "no settings configured".
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	write(scope: SettingsScope, content: string): void {
		const path = this.paths[scope];
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf8");
	}

	path(scope: SettingsScope): string {
		return this.paths[scope];
	}
}

/** Settings with no file behind them, for a test or an embedded host. */
export class InMemorySettingsStorage implements SettingsStorage {
	private readonly contents: Record<SettingsScope, string | undefined> = { global: undefined, project: undefined };

	read(scope: SettingsScope): string | undefined {
		return this.contents[scope];
	}

	write(scope: SettingsScope, content: string): void {
		this.contents[scope] = content;
	}

	path(scope: SettingsScope): string {
		return `<in-memory ${scope} settings>`;
	}
}

/**
 * The settings of one workspace: both files read, merged, and written back field by field.
 *
 * This is the one owner of the settings files. A host builds one per workspace and hands it to every
 * session over that workspace, so a toggle in one session is the same value the next session reads
 * rather than a copy taken when it was assembled. The session never reads a settings file; it asks
 * this object.
 *
 * The merged view is kept as {@link Settings} — every field filled with its default — while each layer
 * is kept as the file wrote it, unknown keys included. That split is what makes a write safe: only the
 * fields a patch names move, and the rest of the file, hand-edited or not, is written back unchanged.
 *
 * Writes are synchronous and unlocked. There is no write queue because there is nothing to queue
 * behind: one process owns the file, and a change is on disk before the call returns, so a host that
 * wants durable settings never has to remember to flush them.
 */
export class SettingsManager {
	private readonly storage: SettingsStorage;
	private readonly layers: Record<SettingsScope, SettingsLayer>;
	/** The fields each file supplies, so a change can be written where the value already lives. */
	private readonly declared: Record<SettingsScope, Set<string>>;
	private settings: Settings;

	private constructor(storage: SettingsStorage, layers: Record<SettingsScope, SettingsLayer>) {
		this.storage = storage;
		this.layers = layers;
		this.declared = {
			global: new Set(Object.keys(layers.global)),
			project: new Set(Object.keys(layers.project)),
		};
		this.settings = mergeSettings(mergeLayers(layers.global, layers.project));
	}

	/** The settings of a workspace: the agent home's file and the workspace's own, project winning. */
	static create(cwd: string, agentDir: string = AGENT_HOME): SettingsManager {
		return SettingsManager.fromStorage(new FileSettingsStorage(settingsPath(agentDir), projectSettingsPath(cwd)));
	}

	/** A manager over any storage backend. */
	static fromStorage(storage: SettingsStorage): SettingsManager {
		return new SettingsManager(storage, {
			global: readLayer(storage, "global"),
			project: readLayer(storage, "project"),
		});
	}

	/**
	 * A manager over settings that were never written down.
	 *
	 * Everything a caller passes counts as that scope's file, so a later change is written back there
	 * and read out of the manager the same way a real one behaves — only the file is missing.
	 */
	static inMemory(settings: Partial<Settings> = {}, scope: SettingsScope = "global"): SettingsManager {
		const storage = new InMemorySettingsStorage();
		storage.write(scope, `${JSON.stringify(settings, null, "\t")}\n`);
		return SettingsManager.fromStorage(storage);
	}

	/** Every setting in effect, merged and defaulted, as a copy: mutating it changes nothing. */
	getSettings(): Settings {
		return structuredClone(this.settings);
	}

	/** The configured default model, as `<name>/<model-id>`, or undefined when no layer names one. */
	getModel(): string | undefined {
		return this.settings.model;
	}

	/** Theme and font size, as the window should draw itself. */
	getAppearance(): AppearanceSettings {
		return { ...this.settings.appearance };
	}

	/** The tools that must be approved in the UI before they run. */
	getApprovals(): Record<ToolApprovalKey, boolean> {
		return { ...this.settings.approval };
	}

	/**
	 * Whether the workspace's files gate this tool.
	 *
	 * The files are the defaults a session opens on, so this answers for a session that has not
	 * chosen: a session's own answer is `Agent.getApprovals()`, which is this map with the session's
	 * recorded choices over it. The approval gate reads that one, never this.
	 */
	isApprovalRequired(tool: ToolApprovalKey): boolean {
		return this.settings.approval[tool];
	}

	getSteeringMode(): QueueMode {
		return this.settings.steeringMode;
	}

	getFollowUpMode(): QueueMode {
		return this.settings.followUpMode;
	}

	/** The retry policy, field for field the shape `retryAssistantCall` takes. */
	getRetrySettings(): RetrySettings {
		return { ...this.settings.retry };
	}

	/** How long the `bash` tool lets one command run. */
	getBashSettings(): BashSettings {
		return { ...this.settings.bash };
	}

	/**
	 * Apply a partial change and write it to disk before returning.
	 *
	 * Each field goes to the file that already names it, so a toggle lands where the value the user is
	 * looking at came from: a project file that names any part of `approval` keeps owning the approval
	 * set, while a setting no layer has ever named goes to the global file. `scope` forces one target
	 * instead.
	 *
	 * Only the named fields move, and nested ones merge, so a patch that changes one tool's approval
	 * leaves the other tools' entries in the file alone.
	 */
	applySettings(patch: SettingsPatch, scope?: SettingsScope): void {
		const fields = Object.entries(patch)
			.filter(([, value]) => value !== undefined)
			.map(([field]) => field);
		if (fields.length === 0) return;

		const changes: Record<SettingsScope, SettingsLayer> = { global: {}, project: {} };
		for (const field of fields) {
			const target = scope ?? this.scopeOf(field);
			const layer = this.layers[target];
			const inherited = layer[field];
			const value = (patch as Record<string, unknown>)[field];
			layer[field] = isRecord(inherited) && isRecord(value) ? mergeLayers(inherited, value) : value;
			this.declared[target].add(field);
			changes[target][field] = layer[field];
		}

		for (const target of ["global", "project"] as const) {
			if (Object.keys(changes[target]).length > 0) this.persist(target, changes[target]);
		}
		this.refresh();
	}

	/**
	 * Write one scope's changed fields onto whatever that file holds now, then take the result as this
	 * manager's copy of the layer.
	 *
	 * Re-reading before writing is what keeps a hand edit to the same file from being reverted by an
	 * unrelated change made here: a model switch must not drop a key the user typed in while the
	 * process was running.
	 */
	private persist(scope: SettingsScope, changes: SettingsLayer): void {
		const merged = mergeLayers(readLayer(this.storage, scope), changes);
		this.storage.write(scope, `${JSON.stringify(merged, null, "\t")}\n`);
		this.layers[scope] = merged;
	}

	private refresh(): void {
		this.settings = mergeSettings(mergeLayers(this.layers.global, this.layers.project));
	}

	/** The file that owns a field, so a change does not go somewhere the value would be overridden. */
	private scopeOf(field: string): SettingsScope {
		return this.declared.project.has(field) ? "project" : "global";
	}
}

/** One file's settings, as that file wrote them. A file that is not there is an empty layer. */
function readLayer(storage: SettingsStorage, scope: SettingsScope): SettingsLayer {
	const content = storage.read(scope);
	if (content === undefined) return {};

	// Trimming also drops a UTF-8 BOM, which a Windows editor writes and `JSON.parse` rejects.
	const text = content.trim();
	if (text === "") return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${storage.path(scope)} is not valid JSON: ${(error as Error).message}`);
	}
	if (!isRecord(parsed)) throw new Error(`${storage.path(scope)} must hold a JSON object`);
	return parsed;
}

/** Project wins over global, key by key and nested object by nested object. */
function mergeLayers(base: SettingsLayer, overrides: SettingsLayer): SettingsLayer {
	const merged: SettingsLayer = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) continue;
		const inherited = merged[key];
		merged[key] = isRecord(inherited) && isRecord(value) ? mergeLayers(inherited, value) : value;
	}
	return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
