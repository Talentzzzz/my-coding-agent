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
	 * Workspaces the sidebar does not list, by absolute path. A whole list, like `tools`: the setting
	 * is the set of hidden workspaces, so one more hidden workspace is the previous list with one more
	 * entry.
	 */
	hiddenWorkspaces?: string[];
	/**
	 * The name the sidebar shows for a workspace, by absolute path.
	 *
	 * A patch carries the entries it changes, and an empty string takes a name back — a record that
	 * merges per key has no other way to say "forget this one".
	 */
	workspaceNames?: Record<string, string>;
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
 * The pure-data state of one workspace's settings: what the settings operations read and write, and
 * nothing else.
 *
 * Every settings operation is a file-level function taking a `SettingsState` as its first parameter —
 * no class holds this state between calls (the `SettingsManager` class at the bottom of this file is
 * a stateless service whose methods take the state explicitly, plus the one per-workspace cache).
 * The state is plain data on purpose: which function touches which field is visible
 * in the signatures, and a test can construct a bare state and call any operation on it directly.
 *
 * The state is shared per workspace, not per request: the host holds one {@link SettingsState} per
 * workspace root and hands the same state to every session over that directory, so a toggle in one
 * session is the same value the next session reads rather than a copy taken when it was assembled.
 * The session never reads a settings file; it goes through these operations.
 *
 * The merged view is kept as {@link Settings} — every field filled with its default — while each layer
 * is kept as the file wrote it, unknown keys included. That split is what makes a write safe: only the
 * fields a patch names move, and the rest of the file, hand-edited or not, is written back unchanged.
 *
 * Writes are synchronous and unlocked. There is no write queue because there is nothing to queue
 * behind: one process owns the file, and a change is on disk before the call returns, so a host that
 * wants durable settings never has to remember to flush them.
 */
export interface SettingsState {
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
 * This is the combination the old constructor spread over its private fields — read the two layers as
 * each file wrote them, mark which fields each file declares, merge the layers into the defaulted
 * view — collapsed into one function, so a host that (re)builds a workspace's state has exactly one
 * way to do it. A file this build cannot parse is refused, never overwritten.
 */
export function settingsStateFromStorage(storage: SettingsStorage): SettingsState {
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
 * The settings of one workspace: the agent home's file and the workspace's own, project winning.
 *
 * The workspace root path is the seed; reading the two json files fills in the whole bag. This is the
 * replay entry a host calls when it first touches a workspace — and again whenever it wants the state
 * re-read from disk, since nothing here caches: the state is a snapshot of the files as of this call,
 * and {@link applySettings} keeps it in step with what it writes.
 */
export function fillSettings(absCwd: string, agentDir: string = AGENT_HOME): SettingsState {
	return settingsStateFromStorage(new FileSettingsStorage(settingsPath(agentDir), projectSettingsPath(absCwd)));
}

/**
 * A state over settings that were never written down.
 *
 * Everything a caller passes counts as that scope's file, so a later change is written back there
 * and read out of the state the same way a real one behaves — only the file is missing.
 */
export function inMemorySettingsState(
	settings: Partial<Settings> = {},
	scope: SettingsScope = "global",
): SettingsState {
	const storage = new InMemorySettingsStorage();
	storage.write(scope, `${JSON.stringify(settings, null, "\t")}\n`);
	return settingsStateFromStorage(storage);
}

/** Every setting in effect, merged and defaulted, as a copy: mutating it changes nothing. */
export function getSettings(s: SettingsState): Settings {
	return structuredClone(s.settings);
}

/** The configured default model, as the row's name, or undefined when no layer names one. */
export function getModel(s: SettingsState): string | undefined {
	return s.settings.model;
}

/**
 * The global default active tool set, or undefined for the registry's full set.
 *
 * Undefined is its own answer rather than an empty list, because "no field" and "nothing active"
 * must stay distinguishable: the first is the old file's behaviour, the second would be a session
 * that can call nothing.
 */
export function getTools(s: SettingsState): string[] | undefined {
	return s.settings.tools === undefined ? undefined : [...s.settings.tools];
}

/** Theme and font size, as the window should draw itself. */
export function getAppearance(s: SettingsState): AppearanceSettings {
	return { ...s.settings.appearance };
}

/**
 * The workspaces the sidebar leaves out, by absolute path.
 *
 * Always a list, never undefined: every reader of this asks "is this one hidden", and the answer
 * for a file that never named the field is the same as for an empty list.
 */
export function getHiddenWorkspaces(s: SettingsState): string[] {
	return [...(s.settings.hiddenWorkspaces ?? [])];
}

/**
 * The names the sidebar shows instead of folder names, by absolute path.
 *
 * Empty entries are dropped here rather than at every reader: a cleared name is stored as an empty
 * string, and "the folder's own name" is what the absence of a key means.
 */
export function getWorkspaceNames(s: SettingsState): Record<string, string> {
	const names: Record<string, string> = {};
	for (const [absCwd, name] of Object.entries(s.settings.workspaceNames ?? {})) {
		if (name.trim().length > 0) names[absCwd] = name;
	}
	return names;
}

/** The tools that must be approved in the UI before they run. */
export function getApprovals(s: SettingsState): Record<ToolApprovalKey, boolean> {
	return { ...s.settings.approval };
}

/**
 * Whether the workspace's files gate this tool.
 *
 * The files are the defaults a session opens on, so this answers for a session that has not
 * chosen: a session's own answer is `Agent.getApprovals()`, which is this map with the session's
 * recorded choices over it. The approval gate reads that one, never this.
 */
export function isApprovalRequired(s: SettingsState, tool: ToolApprovalKey): boolean {
	return s.settings.approval[tool];
}

export function getSteeringMode(s: SettingsState): QueueMode {
	return s.settings.steeringMode;
}

export function getFollowUpMode(s: SettingsState): QueueMode {
	return s.settings.followUpMode;
}

/** The retry policy, field for field the shape `retryAssistantCall` takes. */
export function getRetrySettings(s: SettingsState): RetrySettings {
	return { ...s.settings.retry };
}

/** How long the `bash` tool lets one command run. */
export function getBashSettings(s: SettingsState): BashSettings {
	return { ...s.settings.bash };
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
export function applySettings(s: SettingsState, patch: SettingsPatch, scope?: SettingsScope): void {
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
	refresh(s);
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

function refresh(s: SettingsState): void {
	s.settings = mergeSettings(mergeLayers(s.layers.global, s.layers.project));
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

/**
 * The settings service: a stateless shell over the operations above (ADR-0007 §2).
 *
 * Every method is a one-line delegation to the stateless operation of the same name — which carries
 * the real logic and its documentation — with the workspace's {@link SettingsState} as its first
 * parameter. The class owns no logic and holds no settings of its own; what it holds is the one
 * cache the files' sharing needs: {@link stateOf}, which keeps every reader and writer of one
 * workspace on the same state object, the way the hub's per-workspace table used to before the
 * cache moved in here.
 */
export class SettingsManager {
	/**
	 * Open workspace states by agent home and workspace root — fill-at-open, rebuildable from disk at
	 * any time (ADR-0007 §3).
	 *
	 * A workspace is filled the first time {@link stateOf} touches it and the same reference is reused
	 * after: every write lands on the one bag the next reader answers from, so a toggle written by one
	 * session is the value the next session reads rather than a copy taken when it was assembled. The
	 * key is the pair, not the root alone, because the two files a workspace's settings come from are
	 * looked up under one agent home — a process serving two homes must not answer one workspace's
	 * root with the other home's merge.
	 *
	 * The cache is never authoritative, which is why its rules are about writes and not about loss:
	 *
	 * - Nothing drops on write-back. {@link applySettings} mutates the cached bag in place — it
	 *   re-reads each file it touches before writing, so a hand edit to that file folds in rather than
	 *   being reverted, and the re-merged view is the cached one. The bag equals the files after every
	 *   write.
	 * - Nothing drops on workspace close, because this process never closes one: a workspace put aside
	 *   is a stored `hiddenWorkspaces` fact, not a teardown. A host that gains one drops the entry
	 *   there, the way the session service's `remove` does for a deleted session.
	 * - A hand edit to a field this process never writes stays invisible until restart. That is the
	 *   visibility the files had when this cache lived in the hub, and the price of one merged view
	 *   shared by every reader over the workspace.
	 */
	private readonly states = new Map<string, SettingsState>();

	/** The state of one workspace, filled from its files the first time it is touched. */
	stateOf(absWorkspaceRoot: string, agentDir: string = AGENT_HOME): SettingsState {
		const key = `${agentDir}\u0000${absWorkspaceRoot}`;
		const existing = this.states.get(key);
		if (existing) return existing;
		const created = fillSettings(absWorkspaceRoot, agentDir);
		this.states.set(key, created);
		return created;
	}

	getSettings(s: SettingsState): Settings {
		return getSettings(s);
	}

	getModel(s: SettingsState): string | undefined {
		return getModel(s);
	}

	getTools(s: SettingsState): string[] | undefined {
		return getTools(s);
	}

	getAppearance(s: SettingsState): AppearanceSettings {
		return getAppearance(s);
	}

	getHiddenWorkspaces(s: SettingsState): string[] {
		return getHiddenWorkspaces(s);
	}

	getWorkspaceNames(s: SettingsState): Record<string, string> {
		return getWorkspaceNames(s);
	}

	getApprovals(s: SettingsState): Record<ToolApprovalKey, boolean> {
		return getApprovals(s);
	}

	isApprovalRequired(s: SettingsState, tool: ToolApprovalKey): boolean {
		return isApprovalRequired(s, tool);
	}

	getSteeringMode(s: SettingsState): QueueMode {
		return getSteeringMode(s);
	}

	getFollowUpMode(s: SettingsState): QueueMode {
		return getFollowUpMode(s);
	}

	getRetrySettings(s: SettingsState): RetrySettings {
		return getRetrySettings(s);
	}

	getBashSettings(s: SettingsState): BashSettings {
		return getBashSettings(s);
	}

	applySettings(s: SettingsState, patch: SettingsPatch, scope?: SettingsScope): void {
		applySettings(s, patch, scope);
	}
}
