import { DEFAULT_MODEL_NAME, type ModelChoice, type ModelConfig } from "../models.ts";
import type { SettingManager } from "../setting-manager.ts";
import type { Session, SessionManager } from "./session-manager.ts";

/**
 * The row one session opens on and runs with, derived from the transcript and the settings.
 *
 * This is the one answer to "which model is this session on", and it is a *derivation* rather than a
 * value anybody keeps (ADR-0019). Before, the assembly resolved it once and seeded it onto the bag it
 * mounted; a bag that stayed in the table could carry that seed for the session's life. Now every
 * read replays a fresh bag and drops it, so a seed would be thrown away with the copy it sat in —
 * and the second read would answer "nothing was ever chosen". So the choice is recomputed where it
 * is asked for: what the transcript recorded, else what the settings' own default names, else the
 * built-in row. That is the same order the assembly uses, because it *is* the assembly's order,
 * moved here to be shared by the two things that need it.
 *
 * `chosen` is the second rung: the row a caller named when it opened the session — the test-only
 * override on `openAgent`, which nothing in the files can reproduce. It speaks only for a session
 * whose file says nothing yet, which is why it needs no clearing: the first choice that reaches the
 * transcript takes over from it without either side knowing the other exists.
 */
export function modelChoiceOf(
	sessions: SessionManager,
	session: Session,
	settings: SettingManager,
	chosen?: ModelChoice,
): ModelChoice {
	const recorded = sessions.getRecordedSettings(session);
	const rows = settings.modelCatalog();
	// The recorded choice is a reference the way the settings file spells one — `<name>/<model-id>` —
	// and it is the first rung: a session that has chosen answers from its own file, and everything
	// below it only speaks for a session that has not chosen yet. The settings read is
	// short-circuited rather than hoisted, so a session that recorded anything never pays for it.
	const recordedRef =
		recorded.model === undefined ? undefined : `${recorded.model.name}/${recorded.model.modelId}`;
	const ref = recordedRef ?? chosen?.name ?? settings.getSettings(session.sessionSetting.workDirAbsPath).model;
	const row = selectModelRow(rows, ref);
	// A machine with no rows at all still answers with a well-formed choice: the empty one, which
	// every builder turns into the placeholder whose transport refuses to send. Nothing here throws.
	if (row === undefined) return {};
	const level = chosen?.thinkingLevel ?? recorded.thinkingLevel;
	return { name: row.name, ...(level === undefined ? {} : { thinkingLevel: level }) };
}

/**
 * The row a reference names: what the caller asked for, else the built-in default, else the first.
 *
 * Two callers hand a *ref* rather than a name — `settings.model` as a repair script wrote it, and a
 * session's recorded model choice — and both spell it `<name>/<model-id>`. The name is what identifies
 * the row, so both spellings are resolved here instead of at each caller; before, a ref simply matched
 * nothing and the session quietly opened on somebody else's row.
 *
 * {@link DEFAULT_MODEL_NAME} is the third rung and is hardcoded rather than a guess at which vendor
 * the user has a key for: it is the model this app was built around, so a default naming a row that
 * has been deleted, or a settings file that names none, still opens on it. Only a machine without that
 * row falls through to `rows[0]`, and only a machine with no rows at all gets `undefined` — which the
 * caller answers with the placeholder rather than throwing, because a session has to be buildable for
 * the window to open far enough to say what is missing.
 */
export function selectModelRow(rows: readonly ModelConfig[], ref: string | undefined): ModelConfig | undefined {
	const name = ref?.split("/")[0];
	if (name !== undefined) {
		const named = rows.find((row) => row.name === name);
		if (named) return named;
	}
	return rows.find((row) => row.name === DEFAULT_MODEL_NAME) ?? rows[0];
}
