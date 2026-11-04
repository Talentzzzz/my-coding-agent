import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	AGENT_HOME,
	mergeSettings,
	projectSettingsPath,
	settingsPath,
	type AppearanceSettings,
	type BashSettings,
	type ModeSettings,
	type RetrySettings,
	type Settings,
} from "./config.ts";
import { type ModelConfig, ModelConfigStore } from "./models.ts";
import type { QueueMode } from "./protocol.ts";

/**
 * The one door every configuration read and write walks through.
 *
 * The two settings files (the agent home's and the working directory's own) and the one models file
 * are read here and only here: the class turns what used to be a family of file-level functions
 * into methods that name the working directory and fetch the answer at the line that needs it. Nothing is cached: every method
 * builds a fresh state from the storage behind it, so a hand edit to a file, a write from another
 * session, or a corrected model key is the answer the next call gives, with nothing to invalidate.
 *
 * The manager is injected rather than found: the hub constructs one over its own agent home and
 * hands it to the orchestrator and to every assembly, so a smoke or a test constructs one over
 * its own storage ({@link SettingManagerOptions.storage}, {@link inMemorySettingManager}) and the
 * machine's files are never touched.
 */
export class SettingManager {
	private readonly home: string;
	private readonly modelStore: ModelConfigStore | undefined;
	private modelRows: readonly ModelConfig[] | undefined;
	private readonly storage: SettingsStorage | undefined;

	constructor(options: SettingManagerOptions = {}) {
		this.home = options.home ?? AGENT_HOME;
		this.storage = options.storage;
		// Rows handed in are the whole catalog for this manager's life: the file behind
		// `modelsHome` is not read and `replaceModels` writes back into the row list, which is
		// what a smoke driving its own rows wants — nothing lands in anyone's `models.json`.
		this.modelRows = options.models === undefined ? undefined : [...options.models];
		this.modelStore = options.models === undefined ? ModelConfigStore.create(options.modelsHome ?? this.home) : undefined;
	}

	// ---------------------------------------------------------------------------- the read surface

	/**
	 * The one read every settings method shares: the two files behind the working directory,
	 * merged into a fresh state.
	 *
	 * Nothing is kept between calls — the state is a snapshot of the files as of this call, and
	 * {@link SettingManager.applySettings} keeps the files it wrote in step. Two sessions over one
	 * directory therefore read through the same files rather than through bags that could drift,
	 * which is what makes a settings edit visible to a session that never reopened.
	 */
	private stateOf(workDirAbsPath: string): SettingsState {
		const storage =
			this.storage ?? new FileSettingsStorage(settingsPath(this.home), projectSettingsPath(workDirAbsPath));
		return settingsStateFromStorage(storage);
	}

	/** Every setting in effect, merged and defaulted, as a copy: mutating it changes nothing. */
	getSettings(workDirAbsPath: string): Settings {
		return structuredClone(this.stateOf(workDirAbsPath).settings);
	}

	/** The configured default model, as the row's name, or undefined when no layer names one. */
	getModel(workDirAbsPath: string): string | undefined {
		return this.stateOf(workDirAbsPath).settings.model;
	}

	/**
	 * The global default active tool set, or undefined for the registry's full set.
	 *
	 * Undefined is its own answer rather than an empty list, because "no field" and "nothing active"
	 * must stay distinguishable: the first is the old file's behaviour, the second would be a session
	 * that can call nothing.
	 */
	getTools(workDirAbsPath: string): string[] | undefined {
		const tools = this.stateOf(workDirAbsPath).settings.tools;
		return tools === undefined ? undefined : [...tools];
	}

	/** Theme and font size, as the window should draw itself. */
	getAppearance(workDirAbsPath: string): AppearanceSettings {
		return { ...this.stateOf(workDirAbsPath).settings.appearance };
	}

	/**
	 * The directories the sidebar leaves out, by absolute path.
	 *
	 * Always a list, never undefined: every reader of this asks "is this one hidden", and the answer
	 * for a file that never named the field is the same as for an empty list.
	 */
	getHiddenDirectories(workDirAbsPath: string): string[] {
		return [...(this.stateOf(workDirAbsPath).settings.hiddenDirectories ?? [])];
	}

	/**
	 * The names the sidebar shows instead of folder names, by absolute path.
	 *
	 * Empty entries are dropped here rather than at every reader: a cleared name is stored as an empty
	 * string, and "the folder's own name" is what the absence of a key means.
	 */
	getDirectoryNames(workDirAbsPath: string): Record<string, string> {
		const names: Record<string, string> = {};
		for (const [dir, name] of Object.entries(this.stateOf(workDirAbsPath).settings.directoryNames ?? {})) {
			if (name.trim().length > 0) names[dir] = name;
		}
		return names;
	}

	/** The tools that must be approved in the UI before they run, keyed by tool name. */
	getApprovals(workDirAbsPath: string): Record<string, boolean> {
		return { ...this.stateOf(workDirAbsPath).settings.approval };
	}

	/**
	 * Whether the directory's files gate this tool.
	 *
	 * The files are the defaults a session opens on, so this answers for a session that has not
	 * chosen: a session's own answer is `Agent.getApprovals()`, which is this map with the session's
	 * recorded choices over it. The approval gate reads that one, never this.
	 */
	isApprovalRequired(workDirAbsPath: string, tool: string): boolean {
		return this.stateOf(workDirAbsPath).settings.approval[tool] === true;
	}

	getSteeringMode(workDirAbsPath: string): QueueMode {
		return this.stateOf(workDirAbsPath).settings.steeringMode;
	}

	getFollowUpMode(workDirAbsPath: string): QueueMode {
		return this.stateOf(workDirAbsPath).settings.followUpMode;
	}

	/** The retry policy, field for field the shape `retryAssistantCall` takes. */
	getRetrySettings(workDirAbsPath: string): RetrySettings {
		return { ...this.stateOf(workDirAbsPath).settings.retry };
	}

	/** How long the `bash` tool lets one command run. */
	getBashSettings(workDirAbsPath: string): BashSettings {
		return { ...this.stateOf(workDirAbsPath).settings.bash };
	}

	// ---------------------------------------------------------------------------- the write surface

	/**
	 * Apply a partial change to one directory's settings and write it to disk before returning.
	 *
	 * Each field goes to the file that already names it, so a toggle lands where the value the user is
	 * looking at came from: a project file that names any part of `approval` keeps owning the approval
	 * set, while a setting no layer has ever named goes to the global file. `scope` forces one target
	 * instead. Only the named fields move, and nested ones merge, so a patch that changes one tool's
	 * approval leaves the other tools' entries in the file alone.
	 *
	 * The write lands on the files and nothing else — there is no bag to update, because no reader
	 * holds one: the next read of any method here sees the change, and so does every session over
	 * this directory.
	 */
	applySettings(workDirAbsPath: string, patch: SettingsPatch, scope?: SettingsScope): void {
		applyPatch(this.stateOf(workDirAbsPath), patch, scope);
	}

	// ---------------------------------------------------------------------------- the model rows

	/**
	 * The model rows this installation runs, read from the file on every call.
	 *
	 * The read is one small file, so nothing is cached and nothing has to be invalidated: someone who
	 * adds a row with an editor, or corrects a key in the settings panel, is answered by the next
	 * request without a restart.
	 */
	modelCatalog(): readonly ModelConfig[] {
		return this.modelRows ?? this.modelStore!.list();
	}

	/** Replace every row. The whole-list write is what keeps the names and the file from drifting apart. */
	replaceModels(models: readonly ModelConfig[]): void {
		if (this.modelRows !== undefined) {
			this.modelRows = [...models];
			return;
		}
		this.modelStore!.replace(models);
	}
}

/** What a caller may supply to point a {@link SettingManager} somewhere other than the machine's own files. */
export interface SettingManagerOptions {
	/**
	 * The agent home the global settings file is read from and written to. Defaults to the real one.
	 *
	 * A smoke that exercises a command which *writes* settings must not write the machine's own file.
	 */
	home?: string;
	/**
	 * The agent home the model rows are read from and written to. Defaults to {@link home}.
	 *
	 * The sibling of `home` for the other file: a smoke that hands the manager rows of its own must
	 * not leave them in the machine's `models.json`.
	 */
	modelsHome?: string;
	/**
	 * A storage backend that replaces the two settings files entirely.
	 *
	 * Injected so the manager never picks the files it touches: a test gets an in-memory one, and a
	 * host that keeps settings somewhere else — a database, a per-user store, a sandbox — supplies a
	 * different object rather than a manager change. Set together with `models`, the manager touches
	 * no file at all.
	 */
	storage?: SettingsStorage;
	/** Rows that replace the models file entirely, for a smoke driving its own catalog. */
	models?: readonly ModelConfig[];
}

/**
 * A {@link SettingManager} over settings and rows that were never written down.
 *
 * Everything the caller passes counts as the global layer's file and the whole catalog, so a later
 * write is kept in memory and read back the same way a real one behaves — only the file is missing.
 */
export function inMemorySettingManager(
	settings: Partial<Settings> = {},
	models?: readonly ModelConfig[],
): SettingManager {
	const storage = new InMemorySettingsStorage();
	storage.write("global", `${JSON.stringify(settings, null, "\t")}\n`);
	return new SettingManager({ storage, models });
}

/**
 * The two files a session's settings come from.
 *
 * `global` is this machine's own file under the agent home. `project` is the working directory's
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
	/** The window's "already planted the built-in default" marker; see `Settings.defaultModelSeeded`. */
	defaultModelSeeded?: boolean;
	/** The global default active tool set. A whole list, like the tool set on a session. */
	tools?: string[];
	/**
	 * The user's modes, sent whole like `tools` (ADR-0005): the panel edits a list, and a mode
	 * renamed here and another deleted there have to land together or not at all.
	 */
	modes?: ModeSettings[];
	/**
	 * Directories the sidebar does not list, by absolute path. A whole list, like `tools`: the setting
	 * is the set of hidden directories, so one more hidden directory is the previous list with one more
	 * entry.
	 */
	hiddenDirectories?: string[];
	/**
	 * The name the sidebar shows for a directory, by absolute path.
	 *
	 * A patch carries the entries it changes, and an empty string takes a name back — a record that
	 * merges per key has no other way to say "forget this one".
	 */
	directoryNames?: Record<string, string>;
	/** The approval entries that moved, keyed by tool name; keys left out keep the value in force. */
	approval?: Record<string, boolean>;
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
 * Injected so the manager never picks the files it touches: the real one reads and writes the global
 * and project paths for a working directory, and a test gets an in-memory one. A host that keeps
 * settings somewhere else — a database, a per-user store, a sandbox — supplies a different object
 * rather than a manager change.
 */
export interface SettingsStorage {
	/** The scope's current text, or undefined when there is nothing there yet. */
	read(scope: SettingsScope): string | undefined;
	/** Replace the scope's text, creating the directory when it does not exist. */
	write(scope: SettingsScope, content: string): void;
	/** The file behind a scope, for error messages. */
	path(scope: SettingsScope): string;
}

/** The two real files: `<agent home>/settings.json` and `<working directory>/.my-agent/settings.json`. */
class FileSettingsStorage implements SettingsStorage {
	private readonly absPaths: Record<SettingsScope, string>;

	constructor(globalPath: string, projectPath: string) {
		this.absPaths = { global: globalPath, project: projectPath };
	}

	read(scope: SettingsScope): string | undefined {
		try {
			return readFileSync(this.absPaths[scope], "utf8");
		} catch (error) {
			// A missing file is the normal first run. Anything else — a permission, a directory in the
			// way — is a real failure, and must not reach the caller as "no settings configured".
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	write(scope: SettingsScope, content: string): void {
		const absPath = this.absPaths[scope];
		mkdirSync(dirname(absPath), { recursive: true });
		writeFileSync(absPath, content, "utf8");
	}

	path(scope: SettingsScope): string {
		return this.absPaths[scope];
	}
}

/** Settings with no file behind them, for a test or an embedded host. */
class InMemorySettingsStorage implements SettingsStorage {
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
 * The pure-data state of one working directory's settings: what the manager's reads and writes work
 * on, and nothing else.
 *
 * The merged view is kept as {@link Settings} — every field filled with its default — while each layer
 * is kept as the file wrote it, unknown keys included. That split is what makes a write safe: only the
 * fields a patch names move, and the rest of the file, hand-edited or not, is written back unchanged.
 *
 * The state is a value of one call, not a resident view: {@link SettingManager.stateOf} builds it
 * fresh, and nothing anywhere holds it past the call.
 */
interface SettingsState {
	storage: SettingsStorage;
	layers: Record<SettingsScope, SettingsLayer>;
	/** The fields each file supplies, so a change can be written where the value already lives. */
	declared: Record<SettingsScope, Set<string>>;
	settings: Settings;
}

/**
 * Read both files behind `storage` into a fresh {@link SettingsState}: the one entry point that turns
 * a storage backend into the state the settings operations work on.
 *
 * A file this build cannot parse is refused, never overwritten.
 */
function settingsStateFromStorage(storage: SettingsStorage): SettingsState {
	const layers: Record<SettingsScope, SettingsLayer> = {
		global: readLayer(storage, "global"),
		project: readLayer(storage, "project"),
	};
	return {
		storage,
		layers,
		declared: {
			global: new Set(Object.keys(layers.global)),
			project: new Set(Object.keys(layers.project)),
		},
		settings: mergeSettings(mergeLayers(layers.global, layers.project)),
	};
}

/**
 * Apply a partial change and write it to disk before returning.
 *
 * Each field goes to the file that already names it, so a toggle lands where the value the user is
 * looking at came from. The change reaches the files behind the state and nothing else — the state
 * itself is dropped by the caller, and the files are what every later read re-reads.
 */
function applyPatch(s: SettingsState, patch: SettingsPatch, scope?: SettingsScope): void {
	const fields = Object.entries(patch)
		.filter(([, value]) => value !== undefined)
		.map(([field]) => field);
	if (fields.length === 0) return;

	const changes: Record<SettingsScope, SettingsLayer> = { global: {}, project: {} };
	for (const field of fields) {
		const target = scope ?? scopeOf(s, field);
		const layer = s.layers[target];
		const inherited = layer[field];
		const value = (patch as Record<string, unknown>)[field];
		layer[field] = isRecord(inherited) && isRecord(value) ? mergeLayers(inherited, value) : value;
		s.declared[target].add(field);
		changes[target][field] = layer[field];
	}

	for (const target of ["global", "project"] as const) {
		if (Object.keys(changes[target]).length > 0) persist(s, target, changes[target]);
	}
}

/**
 * Write one scope's changed fields onto whatever that file holds now, then take the result as this
 * state's copy of the layer.
 *
 * Re-reading before writing is what keeps a hand edit to the same file from being reverted by an
 * unrelated change made here: a model switch must not drop a key the user typed in while the
 * process was running.
 */
function persist(s: SettingsState, scope: SettingsScope, changes: SettingsLayer): void {
	const merged = mergeLayers(readLayer(s.storage, scope), changes);
	s.storage.write(scope, `${JSON.stringify(merged, null, "\t")}\n`);
	s.layers[scope] = merged;
}

/** The file that owns a field, so a change does not go somewhere the value would be overridden. */
function scopeOf(s: SettingsState, field: string): SettingsScope {
	return s.declared.project.has(field) ? "project" : "global";
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
