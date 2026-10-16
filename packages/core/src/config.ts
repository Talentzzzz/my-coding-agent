import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { QueueMode, ToolApprovalKey } from "./protocol.ts";

/** Directory holding sessions, settings, and stored credentials. */
export const AGENT_HOME = resolve(process.env.MY_AGENT_HOME ?? join(homedir(), ".my-agent"));

/** How this application names itself in files and messages it writes. */
export const APP_NAME = "my-agent";

/**
 * The directory a workspace uses for its own settings, beside the agent home's name.
 *
 * A repository can commit `<workspace>/.my-agent/settings.json`; `SettingsManager` merges it over the
 * agent home's file, so a checkout can carry its own approvals and limits without touching the
 * machine-wide ones. Nothing writes this directory until something is set at project scope.
 */
export const PROJECT_DIR_NAME = ".my-agent";

/**
 * The retry policy for a failed provider call.
 *
 * Field for field pi-ai's `RetryPolicy`, so the object is handed to `retryAssistantCall` without
 * translation: `maxRetries` counts retries, not calls, and `0` means "never retry".
 */
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	/** Per-attempt delay is `baseDelayMs * 2^(attempt-1)`. */
	baseDelayMs: number;
	/** Ceiling on one computed delay. */
	maxAgentDelayMs: number;
}

/**
 * How the window draws itself.
 *
 * Kept beside the other settings rather than in the browser's own storage because the desktop shell
 * serves a fresh port on every launch: `localStorage` is scoped to an origin, so a preference kept
 * there would be forgotten the moment the window reopened on a different port.
 */
export interface AppearanceSettings {
	/** `system` follows the OS. */
	theme: "system" | "light" | "dark";
	/**
	 * The body tier's font size in px — the one tier the type scale lets move; the shell's other
	 * four tiers are fixed and do not follow it.
	 */
	fontSize: number;
	/**
	 * The sidebar's width in px, as the drag handle last left it. Absent until the user has dragged
	 * once — the default width is the stylesheet's, and a preference that was never expressed must
	 * not be manufactured here.
	 */
	sidebarWidth?: number;
	/**
	 * The reading column's width in px, as its drag handle last left it. Absent until the user has
	 * dragged once — the default is the conversation column's own width minus a gutter at each side,
	 * computed at draw time, and a preference that was never expressed must not be manufactured here.
	 *
	 * The stored number is the *preference*, not the displayed width: the window clamps it to the
	 * range the current layout allows on every read, so a smaller window presses the display down
	 * without destroying the choice, which walks back in when the window grows again. The server's
	 * part is only the absolute range, {@link CONTENT_WIDTH_RANGE}.
	 */
	contentWidth?: number;
	/**
	 * The sidebar's per-workspace paging state, keyed by the workspace's absolute path.
	 *
	 * Absent until a workspace has actually been paged or collapsed — a list the user never touched
	 * keeps no entry, by the same rule the two widths follow. The path is the key rather than an id
	 * because it is the only identity a workspace group carries on the wire.
	 */
	workspaces?: Record<string, WorkspacePaging>;
}

/**
 * One workspace's paging state, as the sidebar last left it.
 *
 * Three fields, because two of the decided behaviours need a memory that survives the third: the
 * 「收起」 button returns to the first page *without* touching {@link savedPage}, so that reopening a
 * later heading-collapse still lands on the page the user had read down to — not on the page the
 * button had just reset to.
 */
export interface WorkspacePaging {
	/** Whether the workspace shows only its heading. */
	collapsed: boolean;
	/** How many pages of conversations are expanded right now; the cap is `page * 5`. */
	page: number;
	/** The page the workspace was expanded to when its heading last collapsed it. */
	savedPage: number;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = { theme: "dark", fontSize: 15 };

/** The range the font-size control offers, shared by the parser and the client. */
export const FONT_SIZE_RANGE = { min: 10, max: 22 } as const;

/**
 * The range the sidebar's drag handle can reach, shared by the parser and the client.
 *
 * The numbers live beside the font-size range rather than only in the stylesheet because both ends
 * of the drag clamp against them in the client: a stored preference outside the range would survive
 * every resize the user could see and re-apply itself on the next boot.
 */
export const SIDEBAR_WIDTH_RANGE = { min: 208, max: 360 } as const;

/**
 * The absolute range the reading column's width can occupy, shared by the parser and the client.
 *
 * The layout-relative ends — the conversation column minus its gutters — are the client's formula,
 * because they depend on a width only the window knows; what the server clamps a stored preference
 * against is this pair, the same split the sidebar's range makes.
 */
export const CONTENT_WIDTH_RANGE = { min: 600, max: 1280 } as const;

/**
 * How long the `bash` tool lets one command run.
 *
 * The ceiling stays a setting rather than disappearing, because it guards against the model asking for
 * an unbounded run — but it is the user's number to move: a checkout that runs hour-long builds is a
 * project that names a higher one in its own settings file.
 */
export interface BashSettings {
	/** Used when a call names no `timeout_ms` of its own. */
	defaultTimeoutMs: number;
	/** The ceiling on any one command, however long the call asked for. */
	maxTimeoutMs: number;
}

export const DEFAULT_BASH_SETTINGS: BashSettings = { defaultTimeoutMs: 120_000, maxTimeoutMs: 3_600_000 };

export interface Settings {
	/** `<name>/<model-id>`. Undefined lets the session pick a default. */
	model?: string;
	/**
	 * The tools a session that never chose opens on, as the global default the session-level panel
	 * resets to. Undefined means the registry's full set, which is what today's sessions open on —
	 * so an old settings file needs no migration and no field of its own.
	 */
	tools?: string[];
	/** Theme and font size, as the window draws them. */
	appearance: AppearanceSettings;
	/** Tools that must be approved in the UI before they run. */
	approval: Record<ToolApprovalKey, boolean>;
	/**
	 * Workspaces the sidebar does not list, by absolute path.
	 *
	 * The list is a *view* decision and nothing more: 「删除」 on a workspace heading removes the group
	 * from the list and leaves every transcript exactly where it lies, so a workspace can be put aside
	 * without anything on disk being touched. That is the whole reason this is a stored setting rather
	 * than a delete — the sessions are still openable by id, and un-hiding is emptying this list.
	 *
	 * Absent rather than `[]` until the user hides the first one, by the same rule the two widths
	 * follow: a preference nobody expressed is not written down.
	 */
	hiddenWorkspaces?: string[];
	/** How many steered messages one drain point injects. */
	steeringMode: QueueMode;
	/** How many follow-up messages one drain point injects. */
	followUpMode: QueueMode;
	/** What to do with a transient provider failure. */
	retry: RetrySettings;
	/** How long the `bash` tool lets one command run. */
	bash: BashSettings;
}

export const DEFAULT_SETTINGS: Settings = {
	approval: { read: false, write: true, edit: true, glob: false, grep: false, bash: true },
	appearance: { ...DEFAULT_APPEARANCE },
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 },
	bash: { ...DEFAULT_BASH_SETTINGS },
};

/** The machine-wide settings file. `agentDir` is configurable so a test can point somewhere harmless. */
export function settingsPath(agentDir: string = AGENT_HOME): string {
	return join(agentDir, "settings.json");
}

/** The settings file a workspace can commit. Only `SettingsManager` decides whether to write it. */
export function projectSettingsPath(cwd: string): string {
	return join(resolve(cwd), PROJECT_DIR_NAME, "settings.json");
}

/**
 * Merge a partial settings object over the defaults. Unknown keys are ignored.
 *
 * Only the values are normalized here; reading and writing the files is `SettingsManager`'s job, which
 * is what lets the same normalization serve one layer, both layers at once, and a change made in memory.
 */
export function mergeSettings(input: unknown): Settings {
	const record = isRecord(input) ? input : {};
	const approval = isRecord(record.approval) ? record.approval : {};

	const merged: Settings = {
		approval: { ...DEFAULT_SETTINGS.approval },
		appearance: appearanceOr(record.appearance),
		steeringMode: queueModeOr(record.steeringMode, DEFAULT_SETTINGS.steeringMode),
		followUpMode: queueModeOr(record.followUpMode, DEFAULT_SETTINGS.followUpMode),
		retry: retryOr(record.retry),
		bash: bashOr(record.bash),
	};

	const model = stringOrUndefined(record.model);
	if (model !== undefined) merged.model = model;

	const tools = stringListOrUndefined(record.tools);
	if (tools !== undefined) merged.tools = tools;

	const hiddenWorkspaces = stringListOrUndefined(record.hiddenWorkspaces);
	if (hiddenWorkspaces !== undefined) merged.hiddenWorkspaces = hiddenWorkspaces;

	for (const key of Object.keys(merged.approval) as ToolApprovalKey[]) {
		const value = approval[key];
		if (typeof value === "boolean") merged.approval[key] = value;
	}
	return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The retry policy, field by field over the defaults.
 *
 * `maxRetries` is the one count that may be zero — "no retries" is a setting, not a missing value —
 * so it is parsed as a non-negative integer rather than with {@link numberOr}.
 */
function retryOr(value: unknown): RetrySettings {
	const record = isRecord(value) ? value : {};
	return {
		enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_SETTINGS.retry.enabled,
		maxRetries: countOr(record.maxRetries, DEFAULT_SETTINGS.retry.maxRetries),
		baseDelayMs: numberOr(record.baseDelayMs, DEFAULT_SETTINGS.retry.baseDelayMs),
		maxAgentDelayMs: numberOr(record.maxAgentDelayMs, DEFAULT_SETTINGS.retry.maxAgentDelayMs),
	};
}

function countOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * The bash timeouts, field by field over the defaults.
 *
 * A default above the ceiling is pulled down rather than honored: it would otherwise make every call
 * that names no `timeout_ms` a guaranteed timeout.
 */
function bashOr(value: unknown): BashSettings {
	const record = isRecord(value) ? value : {};
	const maxTimeoutMs = numberOr(record.maxTimeoutMs, DEFAULT_BASH_SETTINGS.maxTimeoutMs);
	return {
		defaultTimeoutMs: Math.min(
			numberOr(record.defaultTimeoutMs, DEFAULT_BASH_SETTINGS.defaultTimeoutMs),
			maxTimeoutMs,
		),
		maxTimeoutMs,
	};
}

/** Theme and font size, each falling back on its own so one bad field does not reset the other. */
function appearanceOr(value: unknown): AppearanceSettings {
	const record = isRecord(value) ? value : {};
	const theme = record.theme;
	const sidebarWidth = clampSidebarWidth(record.sidebarWidth);
	const contentWidth = clampContentWidth(record.contentWidth);
	const workspaces = clampWorkspacePaging(record.workspaces);
	return {
		theme: theme === "light" || theme === "dark" || theme === "system" ? theme : DEFAULT_APPEARANCE.theme,
		fontSize: clampFontSize(record.fontSize),
		// Optional, so an appearance never dragged keeps no field: the default width is the
		// stylesheet's, and writing one here would turn "never chose" into "chose the default".
		...(sidebarWidth === undefined ? {} : { sidebarWidth }),
		...(contentWidth === undefined ? {} : { contentWidth }),
		...(workspaces === undefined ? {} : { workspaces }),
	};
}

/**
 * Font size within what the control offers.
 *
 * Clamped rather than rejected: the file is hand-editable, and a size outside the range is a typo to
 * absorb, not a reason to refuse the window its settings.
 */
export function clampFontSize(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_APPEARANCE.fontSize;
	return Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, Math.round(value)));
}

/**
 * The sidebar's width within what the handle can reach, or undefined for "never dragged".
 *
 * Clamped rather than rejected, for the same reason the font size is: a hand-edited file, or a
 * preference left wider than the current range allows, is a number to pull back inside — not a
 * reason to forget it.
 */
export function clampSidebarWidth(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(SIDEBAR_WIDTH_RANGE.max, Math.max(SIDEBAR_WIDTH_RANGE.min, Math.round(value)));
}

/**
 * The reading column's width within its absolute range, or undefined for "never dragged".
 *
 * Clamped rather than rejected, for the same reason the sidebar's width is: a hand-edited file, or a
 * preference left outside the range by an older build, is a number to pull back inside — not a
 * reason to forget it.
 */
export function clampContentWidth(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(CONTENT_WIDTH_RANGE.max, Math.max(CONTENT_WIDTH_RANGE.min, Math.round(value)));
}

/**
 * The workspaces' paging state, entry by entry, or undefined for "never touched".
 *
 * Clamped rather than rejected, for the same reason the widths are: the file is hand-editable, and
 * one workspace's bad entry is dropped on its own — it should not cost the other workspaces their
 * state, and it should not cost the whole field its place in the appearance. A page counter that is
 * not a positive integer falls back to the first page rather than being believed.
 */
export function clampWorkspacePaging(value: unknown): Record<string, WorkspacePaging> | undefined {
	if (!isRecord(value)) return undefined;
	const out: Record<string, WorkspacePaging> = {};
	for (const [cwd, entry] of Object.entries(value)) {
		if (cwd.trim().length === 0 || !isRecord(entry)) continue;
		const clampPage = (input: unknown): number =>
			typeof input === "number" && Number.isInteger(input) && input >= 1 ? input : 1;
		out[cwd] = {
			collapsed: entry.collapsed === true,
			page: clampPage(entry.page),
			savedPage: clampPage(entry.savedPage),
		};
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** The two queue modes pi-agent-core understands; anything else keeps the default. */
function queueModeOr(value: unknown, fallback: QueueMode): QueueMode {
	return value === "all" || value === "one-at-a-time" ? value : fallback;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * A list of tool names, or undefined when the field is absent or not an array.
 *
 * The file is hand-editable, so an entry that is not a non-empty string is dropped rather than
 * refused — one bad line should not cost the whole field. The empty list is *kept*: an absent field
 * means "every tool" (the old file's behaviour), while an explicit empty list is a choice — "nothing
 * active" — and silently rewriting a choice into its opposite is the one thing a settings reader must
 * not do.
 */
function stringListOrUndefined(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}
