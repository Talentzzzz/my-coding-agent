import { applyAppearance, initialState, reduce, type ViewState } from "./state.ts";
import { SessionApi, ApiError } from "./api.ts";
import { SessionStream } from "./client.ts";
import { Composer, type ComposerSelection } from "./composer.ts";
import { TranscriptView } from "./render/transcript.ts";
import { Sidebar } from "./render/sidebar.ts";
import { SettingsPanel } from "./render/settings.ts";
import { StatusBar } from "./render/statusbar.ts";
import { element, icon } from "./dom.ts";
import type { ModelOption } from "@my-agent/core/protocol";

/** What a failed request should say. The status is part of it: 404 and 409 mean different things. */
function describe(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	return error instanceof Error ? error.message : String(error);
}

function main(): void {
	const root = document.querySelector<HTMLElement>("#app");
	if (!root) throw new Error("#app is missing from index.html");

	let state: ViewState = initialState();
	/** The session this window is streaming. Commands name it explicitly, so it is never inferred. */
	let followed: string | undefined;
	/**
	 * The model seat's own choice, before any message has carried it.
	 *
	 * Both halves are the window's until a send hands them to the server, which is why they are here
	 * and not read straight off the snapshot: a choice that no request was made with is not a state the
	 * session is in, so nothing on the server would report it. A field is dropped as soon as the
	 * snapshot agrees, which is how the seat stops being an override and goes back to following the
	 * session.
	 */
	let chosen: { model?: string; thinkingLevel?: string } = {};
	/** The directory this server runs over, which is where "新建会话" writes. */
	let currentWorkspace = "";
	let collapsed = false;

	// ---------------------------------------------------------------- the column

	const conversation = element("section", "conversation");
	const header = element("header", "header");

	const title = element("div", "header-title");
	const heading = element("h1", undefined, "新会话");
	const subtitle = element("div", "header-subtitle", "");
	title.append(heading, subtitle);
	// Only the title lives here. The controls that follow the *session* — the model and its thinking
	// level — are on the composer, one row below the thing they affect, because they move with the
	// conversation rather than with the app. Everything that lasts across sessions is a setting, and
	// settings live in the panel behind the one button in the sidebar.
	header.append(title);

	const transcriptHost = element("main", "transcript");
	const transcript = new TranscriptView(transcriptHost, {
		onFork: (entryId) => void fork(entryId),
		onBranch: (entryId, descend) => void branch(entryId, descend),
	});
	transcript.trackScroll();

	const banners = element("div", "banners");

	const composerWrap = element("div", "composer-wrap");
	const errorBar = element("div", "error-bar");
	errorBar.hidden = true;
	const composer = new Composer({
		onSubmit: (text, behavior) => void prompt(text, behavior),
		onAbort: () => void abort(),
		onSelectModel: (ref) => {
			// The two halves move together: a level belongs to a model, so a new row lands on that row's
			// own default rather than carrying the old row's level into a model that may not have it.
			chosen = { model: ref, thinkingLevel: rowOf(ref)?.defaultThinkingLevel };
			render();
		},
		onSelectLevel: (level) => {
			chosen = { ...chosen, thinkingLevel: level };
			render();
		},
	});
	composerWrap.append(errorBar, composer.element);

	const statusBar = new StatusBar();

	conversation.append(header, transcriptHost, banners, composerWrap, statusBar.element);

	// ------------------------------------------------------------------ sidebar

	const sidebar = new Sidebar({
		onNewSession: () => void newSession(),
		onSelectSession: (sessionId) => void openSession(sessionId),
		onToggleCollapsed: () => {
			collapsed = !collapsed;
			render();
		},
		onOpenSettings: () => {
			settings.show();
			settings.render({ models: state.models, ...(state.settings ? { settings: state.settings } : {}), ...(state.snapshot ? { snapshot: state.snapshot } : {}) });
		},
	});

	// ----------------------------------------------------------------- settings

	const settings = new SettingsPanel({
		onClose: () => settings.hide(),
		onTheme: (theme) => void saveSettings({ appearance: { theme } }),
		onFontSize: (fontSize) => void saveSettings({ appearance: { fontSize } }),
		// Session-scoped, like the tool toggles beside it: the choice is recorded in this session's own
		// transcript, so it must not go through the settings endpoint, which writes the workspace files
		// that only decide what a *new* session opens on.
		onApproval: (tool, value) => {
			if (followed === undefined) {
				report(new Error("还没有挂上任何会话。"));
				return;
			}
			void api.setConfig(followed, { approval: { [tool]: value } }).catch(report);
		},
		onBashTimeouts: (bash) => void saveSettings({ bash }),
		onSaveModels: async (rows) => {
			const { models } = await api.updateModels(rows);
			apply({ ...state, models });
		},
		// The default a *new* session opens on, so it writes the settings files. The model a live session
		// is on is the composer's, and never goes through here.
		onDefaultModel: (ref) => void saveSettings({ model: ref }),
		onActiveTools: (names) => {
			if (followed !== undefined) void api.setTools(followed, names).catch(report);
		},
	});

	root.append(sidebar.element, conversation, settings.element);

	// ------------------------------------------------------------------- wiring

	const api = new SessionApi();

	// The stream exists for a run, not for the tab: the window reads a session with a plain `GET` and
	// attaches this only when there is something to watch. It is therefore built with nothing to say
	// until `openSession` or `prompt` asks for it.
	const stream = new SessionStream({
		onMessage: (message) => apply(reduce(state, message)),
		onFollow: (sessionId) => void follow(sessionId),
	});

	/**
	 * Fold a new state in and redraw what changed.
	 *
	 * The columns are redrawn independently because they change at very different rates: the transcript
	 * on every token, the sidebar on a new session, the status bar on a settled turn. Testing for a
	 * change here is what keeps a streaming answer from re-rendering the session list.
	 */
	function apply(next: ViewState): void {
		const previous = state;
		state = next;

		if (next.items !== previous.items || next.streaming !== previous.streaming) {
			transcript.render(next.items, next.streaming);
		}
		if (next.streaming !== previous.streaming || next.queued !== previous.queued || next.connected !== previous.connected) {
			composer.setStreaming(next.streaming);
			composer.setQueued(next.queued);
			composer.setDisabled(!next.connected);
		}
		if (next.usage !== previous.usage || next.connected !== previous.connected) {
			statusBar.render({ usage: next.usage, connected: next.connected });
		}
		if (next.error !== previous.error) {
			errorBar.hidden = next.error === undefined;
			errorBar.textContent = next.error ?? "";
		}
		if (next.approvals !== previous.approvals) renderApprovals();

		render();
	}

	/**
	 * The model seat, as both the control and the next message see it.
	 *
	 * The window's own choice wins over the session's, because the session's is what the *last* request
	 * used and the choice is what the *next* one will. The level list comes from the row being shown —
	 * the levels are the model's, and the server sends each row its own — falling back to the session's
	 * list when the ref names a row that is gone.
	 */
	function selectionForSend(): ComposerSelection {
		const snapshot = state.snapshot;
		const model = chosen.model ?? snapshot?.model ?? "";
		const row = rowOf(model);
		const levels = row?.thinkingLevels ?? snapshot?.thinkingLevels ?? [];
		const level = chosen.thinkingLevel ?? snapshot?.thinkingLevel ?? row?.defaultThinkingLevel ?? "off";
		return { models: state.models, model, levels, level };
	}

	/** The imported row behind a ref, or undefined for one that was deleted or never existed. */
	function rowOf(ref: string | undefined): ModelOption | undefined {
		return ref === undefined ? undefined : state.models.find((model) => `${model.name}/${model.modelId}` === ref);
	}

	/**
	 * Drop the parts of the seat the session has caught up with.
	 *
	 * A field is only an override while it disagrees with the server. Clearing it the moment they agree
	 * is what makes a send hand the control back: the request that used the choice recorded it, the
	 * snapshot says so, and the seat follows the session again instead of shadowing it forever.
	 */
	function syncChosen(): void {
		const snapshot = state.snapshot;
		if (snapshot === undefined) return;
		if (chosen.model !== undefined && chosen.model === snapshot.model) delete chosen.model;
		if (chosen.thinkingLevel !== undefined && chosen.thinkingLevel === snapshot.thinkingLevel) {
			delete chosen.thinkingLevel;
		}
	}

	function render(): void {
		syncChosen();
		const snapshot = state.snapshot;

		sidebar.render({
			workspaces: state.workspaces,
			...(followed === undefined ? {} : { activeSessionId: followed }),
			currentWorkspace,
			collapsed,
		});

		heading.textContent = snapshot?.title ?? "新会话";
		heading.title = snapshot?.title ?? "";
		subtitle.textContent = snapshot?.cwd ?? (followed === undefined ? "连接中…" : followed);

		// What a send would carry is what the seat shows, so the seat is drawn from the same values
		// `prompt` reads rather than from the snapshot alone.
		composer.setSelection(selectionForSend());

		statusBar.render({ usage: state.usage, connected: state.connected });

		if (settings.open) {
			settings.render({
				models: state.models,
				...(state.settings ? { settings: state.settings } : {}),
				...(snapshot ? { snapshot } : {}),
			});
		}

		renderNotices();
	}

	/**
	 * The one thing worth interrupting an empty window with.
	 *
	 * With no model imported there is nothing this app can do, and the failure would otherwise arrive
	 * as an error message after the user had already typed a question and waited for it.
	 */
	function renderNotices(): void {
		if (state.models.length > 0) {
			banners.replaceChildren(...state.approvals.map((approval) => approvalCard(approval)));
			return;
		}

		const card = element("div", "notice-card");
		const mark = element("div", "notice-mark");
		mark.append(icon("gear"));
		const text = element("div", "notice-text");
		text.append(
			element("strong", undefined, "还没有配置模型"),
			element("span", undefined, "在「设置」里添加服务地址和密钥，再在输入框下面为本会话选一个模型。"),
		);
		const open = element("button", "button primary", undefined, { type: "button" });
		open.textContent = "打开设置";
		open.addEventListener("click", () => {
			settings.show();
			settings.render({ models: state.models, ...(state.settings ? { settings: state.settings } : {}) });
		});
		card.append(mark, text, open);

		banners.replaceChildren(
			card,
			...state.approvals.map((approval) => approvalCard(approval)),
		);
	}

	function renderApprovals(): void {
		if (state.models.length === 0) return;
		banners.replaceChildren(...state.approvals.map((approval) => approvalCard(approval)));
	}

	function approvalCard(approval: ViewState["approvals"][number]): HTMLElement {
		const card = element("div", "approval");
		const cardTitle = element("div", "approval-title");
		cardTitle.append(icon("shield"), element("span", undefined, `允许运行 ${approval.toolName}？`));
		card.append(cardTitle, element("pre", "approval-body", approval.summary));

		const deny = element("button", "button", undefined, { type: "button" });
		deny.textContent = "拒绝";
		const allow = element("button", "button primary", undefined, { type: "button" });
		allow.textContent = "允许";
		// One request per answer, against the session the prompt came from.
		deny.addEventListener("click", () => {
			if (followed !== undefined) void api.approve(followed, approval.toolCallId, false).catch(report);
		});
		allow.addEventListener("click", () => {
			if (followed !== undefined) void api.approve(followed, approval.toolCallId, true).catch(report);
		});

		const actions = element("div", "approval-actions");
		actions.append(deny, allow);
		card.append(actions);
		return card;
	}

	// ---------------------------------------------------------------- commands

	/**
	 * Note that the server answered, which is what `connected` means now.
	 *
	 * It used to mean "an event stream is open", and that reading breaks under this phase: no stream
	 * is the normal state, so the first run's end would disable the composer forever. What the
	 * window actually needs to know before it offers to send is whether anything is listening, and
	 * that is what a successful request — any successful request — proves.
	 */
	function reachable(): void {
		if (!state.connected) apply({ ...state, connected: true });
	}

	/** A request that failed, in the one case where it says something about reaching the server. */
	function unreachable(error: unknown): void {
		if (!(error instanceof TypeError)) {
			report(error);
			return;
		}
		apply({ ...state, connected: false, error: "无法连接到服务端。" });
	}

	/**
	 * Point the window at a session, and watch it only if there is something to watch.
	 *
	 * The one path every session change goes through — a click in the sidebar, a new session, a fork,
	 * and the page load that lands on `GET /api/sessions/current`. Reading is a snapshot, not an
	 * assembly: viewing an idle conversation costs one `GET` and one render, and no `Agent` is built
	 * for it. A session that is running — including one parked at an approval, which reports
	 * `submitting: true` — gets a stream, because a stream is what a run is watched on.
	 */
	async function openSession(sessionId: string): Promise<void> {
		let snapshot;
		try {
			snapshot = await api.read(sessionId);
		} catch (error) {
			unreachable(error);
			return;
		}

		reachable();
		followed = snapshot.id;
		// A different conversation is a different seat: what was chosen for the one before it says
		// nothing about this one, which opens on whatever its own branch recorded.
		chosen = {};
		// The same rendering the branch command uses: a snapshot is a snapshot, whether it arrived on
		// a stream or on a read.
		apply(reduce(state, { type: "baseline", session: snapshot }));

		try {
			await refreshLists();
		} catch (error) {
			report(error);
		}

		if (snapshot.submitting) stream.watch(snapshot.id);
	}

	/**
	 * Point the window at the session the stream is actually on.
	 *
	 * The stream names its session in the opening snapshot, and that is still what happens when it
	 * reconnects mid-run or lands on a session this window did not ask for, so this keeps answering
	 * "which conversation am I looking at".
	 */
	async function follow(sessionId: string): Promise<void> {
		followed = sessionId;
		// A different conversation is a different seat: what was chosen for the one before it says
		// nothing about this one, which opens on whatever its own branch recorded.
		chosen = {};
		try {
			await refreshLists();
		} catch (error) {
			report(error);
		}
	}

	/** Re-read the sidebar's rows. The store is the only place that knows a session exists. */
	async function refreshLists(): Promise<void> {
		const [{ workspaces }, { sessions }] = await Promise.all([api.listWorkspaces(), api.listSessions()]);
		reachable();
		apply({ ...state, workspaces, sessions });
	}

	async function saveSettings(patch: Parameters<SessionApi["updateSettings"]>[0]): Promise<void> {
		try {
			const { settings: saved } = await api.updateSettings(patch);
			// Applied straight away rather than after a re-render: the font size and the theme are the
			// two settings whose whole value is seeing them change.
			applyAppearance(saved);
			apply({ ...state, settings: saved });
		} catch (error) {
			report(error);
		}
	}

	async function prompt(text: string, behavior?: "steer" | "followUp"): Promise<void> {
		// Held rather than read twice: awaiting the attach hands control back, and a click in the
		// sidebar during that wait would otherwise post this message to the session the window moved
		// *to* rather than the one the text was written for.
		const target = followed;
		if (target === undefined) {
			report(new Error("还没有挂上任何会话。"));
			return;
		}
		// Attach before sending, and send only if it worked. A run that fails to start is reported
		// with `announce`, which goes to the streams already attached and is not buffered, so a
		// message that went out first could lose its own failure with nothing to show for it. When
		// the attach fails, the text goes back in the box rather than being dropped.
		if (!(await stream.whenOpen(target))) {
			composer.setDraft(text);
			report(new Error("连接不到该会话，消息没有发出。"));
			return;
		}
		// The seat's choice travels with the message and only with it: the server applies the selection
		// as it accepts the prompt, so a choice is never a command that could be applied on its own.
		const selection = selectionForSend();
		try {
			await api.prompt(target, text, behavior, {
				model: selection.model,
				thinkingLevel: selection.level,
			});
			reachable();
		} catch (error) {
			composer.setDraft(text);
			unreachable(error);
		}
	}

	async function abort(): Promise<void> {
		if (followed === undefined) return;
		try {
			await api.abort(followed);
			reachable();
		} catch (error) {
			unreachable(error);
		}
	}

	async function newSession(): Promise<void> {
		try {
			const created = await api.createSession();
			reachable();
			apply({ ...state, sessions: created.sessions });
			await openSession(created.sessionId);
		} catch (error) {
			unreachable(error);
		}
	}

	async function fork(entryId: string | null): Promise<void> {
		if (followed === undefined) return;
		try {
			const created = await api.forkSession(followed, entryId);
			reachable();
			apply({ ...state, sessions: created.sessions });
			await openSession(created.sessionId);
		} catch (error) {
			unreachable(error);
		}
	}

	/**
	 * Move this session onto another branch of its own tree.
	 *
	 * The answer is applied here *and* arrives on the stream: the stream sends the same snapshot to
	 * every window on this session, and applying the response as well is what keeps the window that
	 * clicked from waiting a round trip to see its own move. Both are the same session state, so the
	 * second one to arrive changes nothing.
	 */
	async function branch(entryId: string, descend: boolean): Promise<void> {
		if (followed === undefined) return;
		try {
			const { session } = await api.branchSession(followed, entryId, descend);
			apply(reduce(state, { type: "baseline", session }));
		} catch (error) {
			report(error);
		}
	}

	function report(error: unknown): void {
		apply({ ...state, error: describe(error) });
	}

	// ---------------------------------------------------------------- listeners

	window.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && settings.open) {
			settings.hide();
			return;
		}
		if (event.key === "n" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void newSession();
		}
		if (event.key === "b" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			collapsed = !collapsed;
			render();
		}
	});

	// The desktop flags (`data-theme`, `data-platform`, `data-desktop-caption`) are set by the inline
	// boot script in index.html, before the first paint. They are not repeated here: the caption has to
	// reserve its space before the stylesheet renders, not after the module loads.

	// Fill the panel and the list from the API, independently of any stream: a window that cannot
	// attach to a session can still show what the server has, and can still say what is missing.
	void (async () => {
		try {
			const health = await api.health();
			currentWorkspace = health.cwd;
			reachable();
		} catch (error) {
			unreachable(error);
		}
		try {
			const { settings: stored } = await api.getSettings();
			applyAppearance(stored);
			reachable();
			apply({ ...state, settings: stored });
		} catch (error) {
			report(error);
		}
		try {
			const { models } = await api.listModels();
			reachable();
			apply({ ...state, models });
		} catch (error) {
			report(error);
		}
		try {
			await refreshLists();
		} catch (error) {
			report(error);
		}
		// Which session to land on is the server's decision — `--session` pins one, `--continue`
		// resumes one, an empty history creates one — so the page asks rather than picking from the
		// list. From there this is the same path as a click in the sidebar: a read, a render, and a
		// stream only if something is running. Page load is no longer a special case, and it no
		// longer opens a stream on an idle conversation.
		try {
			const { sessionId } = await api.currentSession();
			reachable();
			await openSession(sessionId);
		} catch (error) {
			unreachable(error);
		}
	})();

	composer.focus();
}

main();
