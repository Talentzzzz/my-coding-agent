import { applyAppearance, initialState, reduce, reduceEnd, findWay, type ViewState } from "./state.ts";
import { SessionApi, ApiError } from "./api.ts";
import { browserSocket, MuxClient, muxUrl, type ChannelState } from "./client.ts";
import { SessionRows } from "./rows.ts";
import { Composer, type ComposerSelection } from "./composer.ts";
import { TranscriptView } from "./render/transcript.ts";
import { BranchView, shortId } from "./render/branch-view.ts";
import { Sidebar, workspaceName } from "./render/sidebar.ts";
import { SettingsPanel } from "./render/settings.ts";
import { SessionSettingsPanel } from "./render/session-settings.ts";
import { openMenu, openMenuAt, type MenuItem } from "./render/menu.ts";
import { StatusBar } from "./render/statusbar.ts";
import { element, icon } from "./dom.ts";
import type { ConnectionItem, ModelOption, ServerMessage } from "@my-agent/core/protocol";

/**
 * The one thing the desktop shell adds to the page: the OS's own folder picker. The app itself does
 * not browse the filesystem — "添加工作区" hands the browsing to the system dialog — so a browser
 * without the shell has no picker, and the menu item says so rather than pretending.
 */
declare global {
	interface Window {
		desktop?: { pickFolder?: () => Promise<string | undefined> };
	}
}

/** What a failed request should say. The status is part of it: 404 and 409 mean different things. */
function describe(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	return error instanceof Error ? error.message : String(error);
}

/**
 * Whether this frame says the session has nothing running.
 *
 * Two members carry the fact and each hides it in a different place, which is why this is a helper
 * rather than a pair of conditions at the call site: a run's last word is `submitting: false` on
 * whichever of the two happens to arrive, and the release of a send's reference must not depend on
 * which one that was.
 *
 * `undefined` for every other member, because most of them say nothing about runs at all — and "says
 * nothing" must never be read as "settled", since releasing on it would drop the reference while the
 * run was still going.
 */
function settled(message: ServerMessage): boolean {
	if (message.type === "status") return !message.submitting;
	if (message.type === "baseline") return !message.session.submitting;
	return false;
}

function main(): void {
	const root = document.querySelector<HTMLElement>("#app");
	if (!root) throw new Error("#app is missing from index.html");

	let state: ViewState = initialState();
	/** The session this window is streaming. Commands name it explicitly, so it is never inferred. */
	let followed: string | undefined;
	/**
	 * The model's seat's own choice, before any message has carried it.
	 *
	 * Both halves are the window's until a send hands them to the server, which is why they are here
	 * and not read straight off the snapshot: a choice that no request was made with is not a state the
	 * session is in, so nothing on the server would report it. A field is dropped as soon as the
	 * snapshot agrees, which is how the seat stops being an override and goes back to following the
	 * session.
	 */
	let chosen: { model?: string; thinkingLevel?: string } = {};
	/** The directory this server runs over, which is where "新建会话" writes by default. */
	let currentWorkspace = "";
	/**
	 * The workspace picker's own choice, held by the window and never by the server.
	 *
	 * Three controls read it and nothing else does: the composer chip that displays it, the new-session
	 * button that creates into it, and the sidebar's "当前" mark that names it. Empty means "no
	 * explicit choice", and the answer is then the active session's workspace — so the mark can never
	 * contradict the conversation on screen — or the server's root when there is no session. Opening a
	 * session clears it, which is what keeps the choice a "next time" answer rather than a state that
	 * quietly outlives the moment it was made in. It survives no restart and lands in no file, by
	 * decision: a transient preference re-chosen at the moment it is needed is not worth a store.
	 */
	let pickedWorkspace = "";
	let collapsed = false;
	/**
	 * Whether the resident channel is up.
	 *
	 * A local rather than a field on `ViewState`, because it is a fact about the connection and not
	 * about any session — which is the same reason the sidebar rows are kept out of the state. The
	 * reducer never sees it, so a baseline cannot overwrite it, and what the window can send still
	 * depends on `state.reachable` alone.
	 */
	let channel: ChannelState = "connecting";
	/** The sidebar's rows, written by the channel when it is up and by REST when it is not. */
	const rows = new SessionRows();

	/**
	 * What each piece of chrome was last drawn from.
	 *
	 * The transcript re-renders on every token, and everything around it used to redraw too — the
	 * sidebar walked its rows, the status line rewrote its figures, the banner area rebuilt its
	 * cards — all per frame, all for inputs the frame had not touched. Each gate below compares
	 * against the last draw instead: a cheap reference or string comparison that skips a walk whose
	 * inputs did not move. A frame that changes one of them still draws it, and the first draw
	 * happens because every gate starts unset.
	 */
	let sidebarDrawn: string | undefined;
	let usageDrawn: ViewState["usage"] | undefined;
	let headingDrawn: string | undefined;
	let headingTipDrawn: string | undefined;
	let subtitleDrawn: string | undefined;
	/** The directory the chip's label was last drawn from, so an unchanged one is not rewritten. */
	let chipDrawn: string | undefined;
	/** The signature the branch entry was last drawn from; a baseline is what can move it. */
	let branchChipDrawn: string | undefined;
	/** The approvals the takeover seat was last drawn from; a new array means something to answer. */
	let approvalsDrawn: ViewState["approvals"] | undefined;
	let noticesDrawn: ViewState["models"] | undefined;

	// ---------------------------------------------------------------- the column

	const conversation = element("section", "conversation");

	/**
	 * The fixed header: the session title on the left of its first row, the branch entry on its
	 * right, and — on the branch page only — the tools row. It spans the whole conversation column
	 * and never follows the reading column in, so resizing the prose never moves it.
	 */
	const header = element("header", "header");
	const headerRow = element("div", "header-row");

	const title = element("div", "header-title");
	const heading = element("h1", undefined, "新会话");
	const subtitle = element("div", "header-subtitle", "");
	title.append(heading, subtitle);
	// Only the title lives here. The controls that follow the *session* — the model and its thinking
	// level — are on the composer, one row below the thing they affect, because they move with the
	// conversation rather than with the app. Everything that lasts across sessions is a setting, and
	// settings live in the panel behind the one button in the sidebar.

	/**
	 * The branch entry, the one door into the branch page.
	 *
	 * It names the way being read — `当前分支`, the short id cut from that way's entry, and the first
	 * sentence said under it — and hides when the conversation has fewer than two ways, where
	 * "branching" names nothing. Hidden also is every other door: this chip and the user message's
	 * right-click menu are the only two ways in, and the branch page's own button is the only way out.
	 */
	const branchChip = element("button", "branch-chip", undefined, { type: "button", title: "打开分支视图" });
	const branchChipId = element("span", "branch-chip-id");
	const branchChipLabel = element("span", "branch-chip-label");
	branchChip.append(icon("fork"), element("span", undefined, "当前分支"), branchChipId, branchChipLabel);
	branchChip.hidden = true;
	branchChip.addEventListener("click", () => setPane("branch"));

	headerRow.append(title, branchChip);
	header.append(headerRow);

	/**
	 * Which page the conversation column shows.
	 *
	 * Two, by the ticket's count: the conversation, and the branch tree that replaces it whole — not
	 * an overlay and not a side panel. Recorded on the body so one CSS rule can retire the composer,
	 * the status line, and the banners together, because the branch page has none of them.
	 */
	let pane: "chat" | "branch" = "chat";
	function setPane(next: "chat" | "branch"): void {
		if (pane === next) return;
		pane = next;
		document.body.dataset.pane = next;
		if (next === "branch") branchView.enter();
		else branchView.leave();
	}

	/**
	 * The branch page, and the fixed header's second row.
	 *
	 * Switching is the two-beat the prototype settled on: a click on a node only selects, and the
	 * button in the tools row is what moves the leaf and returns to the conversation — which is why
	 * `onSwitch` flips the pane first and moves the session second: the person pressed "go back",
	 * and the answer they chose rides along.
	 */
	const branchView = new BranchView({
		onSwitch: (entryId) => {
			setPane("chat");
			void branch(entryId, true);
		},
		onBack: () => setPane("chat"),
	});
	header.append(branchView.toolsBar);

	const transcriptHost = element("main", "transcript");
	const transcript = new TranscriptView(transcriptHost, {
		onUserContext: (entryId, x, y) => openUserMenu(entryId, x, y),
	});
	transcript.trackScroll();

	const banners = element("div", "banners");

	const composerWrap = element("div", "composer-wrap");
	const errorBar = element("div", "error-bar");
	errorBar.hidden = true;
	/**
	 * The approval card's seat, which is the composer's own seat.
	 *
	 * A pending approval replaces the input box rather than hanging above it: the question is the only
	 * thing the window can act on while it stands, and a card that took over the seat is the shape the
	 * reference gives it — warning border, command, two answers — where a banner above an input that
	 * is still taking text reads like decoration on something that is not listening anyway.
	 */
	const approvalSeat = element("div", "approval-seat");
	approvalSeat.hidden = true;
	/** The composer head: the workspace chip on the row above the input card, leftmost. */
	const composerHead = element("div", "composer-head");
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
		onOpenSessionSettings: () => {
			sessionSettings.show();
			sessionSettings.render({
				...(state.settings ? { settings: state.settings } : {}),
				...(state.snapshot ? { snapshot: state.snapshot } : {}),
			});
		},
	});
	composerWrap.append(errorBar, approvalSeat, composerHead, composer.element);

	/**
	 * The workspace chip, and the menu it opens.
	 *
	 * The chip is the picker's face: it shows where the *next* new session will land, and it lives on
	 * the row above the input card, leftmost — the composer is where a session starts, so that is
	 * where "where the next one starts" belongs (01 ⑦). The choice never rewrites the session on
	 * screen, and the chip is placed by the input it sits over rather than by what the transcript
	 * says, so it needs no phase to come and go with. Its menu lists the workspaces this machine
	 * already knows plus the one road in for one it does not; the list is drawn from the sidebar's
	 * own rows, so a workspace that earned its place by having a session is the same list here.
	 */
	const workspaceChip = element("button", "workspace-chip", undefined, { type: "button", "aria-haspopup": "menu" });
	const chipLabel = element("span", "workspace-chip-label");
	workspaceChip.append(icon("folder"), chipLabel, icon("chevron"));
	workspaceChip.addEventListener("click", () => {
		const groups = rows.groups();
		// Nothing known yet: a one-row menu whose only row is the add action is a menu that pretends
		// there was a choice, so the click goes straight to the picker, as the reference does.
		if (groups.length === 0) {
			void addWorkspace();
			return;
		}
		const chosenDirectory = directoryForNewSession();
		openMenu(workspaceChip, [
			...groups.map((group) => ({
				icon: "folder" as const,
				label: workspaceName(group.cwd),
				title: group.cwd,
				active: group.cwd === chosenDirectory,
				onSelect: () => {
					pickedWorkspace = group.cwd;
					render();
				},
			})),
			{ kind: "separator" as const },
			{
				label: "添加工作区…",
				onSelect: () => void addWorkspace(),
			},
		]);
	});
	composerHead.append(workspaceChip);

	const statusBar = new StatusBar();

	// The branch page sits where the transcript sits: one grid row that flexes, whichever of the two
	// is on. Hiding is CSS's job (`body[data-pane]`), so the two pages trade places without any of
	// the chrome around them re-flowing.
	conversation.append(header, transcriptHost, branchView.element, banners, composerWrap, statusBar.element);

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
		onAddWorkspace: () => void addWorkspace(),
		// The row menu's fork copies a session whole — it acts on a session, not on a message, so this
		// is the `entryId: null` fork rather than anything a message used to offer.
		onForkSession: (sessionId) => void forkSession(sessionId),
		onDeleteSession: (sessionId) => void deleteSession(sessionId),
		onRenameSession: (sessionId, title) => void renameSession(sessionId, title),
	});

	/**
	 * The drag handle on the sidebar's right edge.
	 *
	 * A separator, not a button: the pointer grabs the sidebar's edge and drags it — right widens,
	 * the direction the prototype settled — and the keyboard reaches the same clamp through the
	 * arrow keys, which is why the element is focusable at all. The width it moves is
	 * `--dsw-sidebar-width`, the one variable the grid's first column is drawn from.
	 *
	 * Persistence follows the reading handle's two rules: the preference saved is the one the drag
	 * produced, clamped to the range the server also enforces, and a press that never moved commits
	 * nothing — an empty click must not overwrite a stored width with whatever the current layout
	 * had clamped it to.
	 */
	const sidebarResizer = element("div", "side-resizer", undefined, {
		role: "separator",
		"aria-orientation": "vertical",
		"aria-label": "调整侧栏宽度",
		tabindex: "0",
	});
	/** The keys turn the width in steps, which is finer than a drag and needs a named number. */
	const SIDEBAR_RESIZE_STEP = 8;
	/**
	 * The drag range, read from the same tokens the stylesheet declares (`--dsw-sidebar-min/max`).
	 *
	 * The numbers' home is `tokens.css`, mirrored by `SIDEBAR_WIDTH_RANGE` in `@my-agent/core/config.ts`
	 * where the server clamps a stored preference. They are not imported into the client — the config
	 * module runs on Node, and the client must not pull that into its bundle — so the tokens are read
	 * back instead, and the literals here are only what a stylesheet that failed to load falls back to.
	 */
	function sidebarRange(): { min: number; max: number } {
		const styles = getComputedStyle(document.documentElement);
		const read = (name: string, fallback: number): number => {
			const value = Number.parseFloat(styles.getPropertyValue(name));
			return Number.isFinite(value) ? value : fallback;
		};
		return { min: read("--dsw-sidebar-min", 208), max: read("--dsw-sidebar-max", 360) };
	}
	/** The width the variable currently carries, or the token's default before anything set it. */
	function sidebarWidthNow(): number {
		const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dsw-sidebar-width"));
		return Number.isFinite(value) ? value : 232;
	}
	function setSidebarWidth(width: number): void {
		const { min, max } = sidebarRange();
		document.documentElement.style.setProperty("--dsw-sidebar-width", `${Math.min(max, Math.max(min, Math.round(width)))}px`);
	}
	let sidebarDrag: { x: number; width: number } | undefined;
	sidebarResizer.addEventListener("pointerdown", (event) => {
		if (collapsed) return;
		event.preventDefault();
		sidebarDrag = { x: event.clientX, width: sidebarWidthNow() };
		sidebarResizer.setPointerCapture(event.pointerId);
		sidebarResizer.classList.add("dragging");
	});
	sidebarResizer.addEventListener("pointermove", (event) => {
		if (sidebarDrag === undefined) return;
		setSidebarWidth(sidebarDrag.width + event.clientX - sidebarDrag.x);
	});
	const endSidebarDrag = (): void => {
		sidebarDrag = undefined;
		sidebarResizer.classList.remove("dragging");
	};
	sidebarResizer.addEventListener("pointerup", (event) => {
		// The drag that ends here is measured against where it began, so a click that never moved
		// saves nothing: the stored preference keeps the value the user chose, not one the current
		// layout's clamp would have whispered over it.
		const moved = sidebarDrag !== undefined && event.clientX !== sidebarDrag.x;
		endSidebarDrag();
		if (moved) void saveSettings({ appearance: { sidebarWidth: sidebarWidthNow() } });
	});
	sidebarResizer.addEventListener("pointercancel", () => endSidebarDrag());
	sidebarResizer.addEventListener("keydown", (event) => {
		const step = event.key === "ArrowLeft" ? -SIDEBAR_RESIZE_STEP : event.key === "ArrowRight" ? SIDEBAR_RESIZE_STEP : 0;
		if (step === 0 || collapsed) return;
		event.preventDefault();
		setSidebarWidth(sidebarWidthNow() + step);
		void saveSettings({ appearance: { sidebarWidth: sidebarWidthNow() } });
	});

	// ----------------------------------------------------------------- settings

	const settings = new SettingsPanel({
		onClose: () => settings.hide(),
		onTheme: (theme) => void saveSettings({ appearance: { theme } }),
		onFontSize: (fontSize) => void saveSettings({ appearance: { fontSize } }),
		onBashTimeouts: (bash) => void saveSettings({ bash }),
		// The global default approval map: what a session that never chose opens on. Writing it here
		// writes the settings files, and a session with recorded choices of its own keeps them.
		onGlobalApproval: (tool, value) => void saveSettings({ approval: { [tool]: value } }),
		onSaveModels: async (rows) => {
			const { models } = await api.updateModels(rows);
			apply({ ...state, models });
		},
		// The default a *new* session opens on, so it writes the settings files. The model a live session
		// is on is the composer's, and never goes through here.
		onDefaultModel: (ref) => void saveSettings({ model: ref }),
		onGlobalTools: (names) => void saveSettings({ tools: names }),
	});

	/**
	 * The session-level panel, behind the composer's own button.
	 *
	 * Its controls write the session's transcript — `PUT /tools` and the approval `PATCH` — which is
	 * the same path the old settings panel used, moved to the seat that says which level it edits. The
	 * reset sends the global defaults through the two endpoints together, which is what writes one
	 * `tool_config` entry *holding* the defaults; the snapshot's field-equality booleans then read it
	 * as following global again.
	 */
	const sessionSettings = new SessionSettingsPanel({
		onClose: () => sessionSettings.hide(),
		onActiveTools: (names) => {
			if (followed === undefined) {
				report(new Error("还没有挂上任何会话。"));
				return;
			}
			void api.setTools(followed, names).catch(report);
		},
		onApproval: (tool, value) => {
			if (followed === undefined) {
				report(new Error("还没有挂上任何会话。"));
				return;
			}
			// Session-scoped: the choice is recorded in this session's own transcript, so it must not go
			// through the settings endpoint, which writes the workspace files that only decide what a
			// *new* session opens on.
			void api.setConfig(followed, { approval: { [tool]: value } }).catch(report);
		},
		onFollowGlobal: () => {
			if (followed === undefined || state.snapshot === undefined) return;
			const allTools = state.snapshot.allTools;
			const global = state.settings;
			if (global === undefined) {
				report(new Error("全局设置还没有读到，稍后再试。"));
				return;
			}
			const names = global.tools === undefined ? allTools : global.tools.filter((name) => allTools.includes(name));
			void api.setTools(followed, names).catch(report);
			void api.setConfig(followed, { approval: { ...global.approval } }).catch(report);
		},
	});

	// The handle sits between the two columns — it is the sidebar's right edge, which is the whole
	// point — and the rail's CSS hides it, since a 52px rail is not a width anyone is choosing.
	root.append(sidebar.element, sidebarResizer, conversation, settings.element, sessionSettings.element);

	// ------------------------------------------------------------------- wiring

	const api = new SessionApi();

	/**
	 * The one resident channel, and the window's whole view of the server's liveness.
	 *
	 * Frames are routed here by `streamId` alone, which is the whole contract: `null` names the
	 * connection and everything else names one session. Nothing below re-examines the payload's shape,
	 * so a new member of either union is an addition to the protocol rather than a change to every
	 * client that reads it.
	 */
	const mux = new MuxClient(
		{
			onChannel: (next) => {
				channel = next;
				// Coming back up brings a fresh row table with it, and nothing here triggers a fetch:
				// the channel's own baseline is the authority from that moment on.
				//
				// Going down is the other half. The rows drawn are the last thing this window was told,
				// and emptying them would hide the machine's state at the exact moment it stops updating —
				// so they stay, and a REST listing is asked for instead. Without that, the sidebar would
				// freeze for as long as the outage lasted, which is the one behaviour the row table
				// exists to prevent.
				if (next === "down") void refreshLists().catch(report);
				render();
			},
			onConnectionItem: (item) => onConnectionItem(item),
			onStreamMessage: (sessionId, message) => {
				// A send's reference lasts exactly as long as the run it started, and "settled" is the
				// stream saying `submitting: false` — not the request being accepted and not the run
				// beginning. A run parked on an approval still reports `submitting: true`, which is the
				// point: the stream has to survive until the user has answered, or the banner would be
				// dropped from under them.
				//
				// Checked **before** the pane test below, and that ordering is load-bearing. Navigating
				// away mid-run releases the pane's reference but not the send's — that is what the
				// reference is for — so this session's frames keep arriving with nobody watching them,
				// and the run's last `submitting: false` is exactly the frame that has to be read. Bailing
				// out on the pane first would drop it, and the stream would then be held for the rest of
				// the window's life and re-opened by every reconnect, for a run that had already finished.
				if (settled(message)) mux.release(sessionId, "send");

				// A frame for a session this window has moved away from. Not an error and not worth
				// redrawing for: the pane's reference was released, so the server has no reason to send
				// it, and if one arrives it is a frame that arrived before the release reached it.
				if (followed !== sessionId) return;
				apply(reduce(state, message));
			},
			onStreamEnd: (sessionId) => {
				// The send's reference has a third exit besides a settled status and a refused run: the
				// server ending the stream. Released before the pane test below, for the same reason
				// `onStreamError` releases before it draws anything — the reference belongs to the run,
				// not to the pane, so a window that navigated away mid-run still holds it. Releasing
				// unconditionally is safe: an id this connection does not hold is a no-op.
				mux.release(sessionId, "send");
				if (followed !== sessionId) return;
				apply(reduceEnd(state));
			},
			onStreamError: (sessionId, message) => {
				// The notice goes to this window's error line rather than into whichever conversation
				// the window happens to be showing: the person who has to act on it is looking at the
				// window, not at a session id.
				report(new Error(message));
				// A run that could not start is reported here and never reports itself finished, so this
				// is one of the exits a send's reference has. Without it a failed send would hold its
				// stream open for the rest of the window's life — which nobody would notice, since it is
				// usually a stream the pane wants anyway.
				//
				// Only for a session's own stream. The empty id is the envelope-level failure, which is
				// about the connection and names no session, so there is nothing here to release.
				if (sessionId !== "") mux.release(sessionId, "send");
			},
		},
		{ url: muxUrl(window.location), socket: browserSocket(muxUrl(window.location)), network: window },
	);

	/**
	 * One connection-level payload: the row table, a changed row, or the heartbeat.
	 *
	 * The heartbeat is the one with no work of its own — `MuxClient` already consumed it to arm the
	 * watchdog — and it is used here as the tick that keeps the sidebar's relative times honest. Riding
	 * an existing frame rather than opening a second timer means there is one clock in the window, and
	 * it stops when the channel does, which is the correct time for "how long ago" to stop updating.
	 */
	function onConnectionItem(item: ConnectionItem): void {
		if (item.type === "sessions") {
			rows.replaceAll(item.sessions);
			renderSidebar();
			return;
		}
		if (item.type === "session_row") {
			rows.put(item.session);
			renderSidebar();
			return;
		}
		if (item.type === "session_gone") {
			rows.remove(item.sessionId);
			renderSidebar();
			return;
		}
		sidebar.tick();
	}

	/** Repaint just the sidebar. Rows change on their own schedule, not the state's. */
	function renderSidebar(): void {
		// The gate here is the whole per-frame story for this column: a streaming frame changes none
		// of the inputs the sidebar reads — the row table's version, the followed session, and the
		// window's own three facts — so it is skipped here rather than walked and patched inside.
		// Rendering the sidebar on every token was the profile's H7, a flat per-frame tax that grew
		// with the workspace count; the rows bump `rows.version` when they actually change.
		const directory = directoryForNewSession();
		const drawn = `${rows.version}|${followed ?? ""}|${directory}|${pickedWorkspace}|${collapsed ? 1 : 0}|${channel}`;
		if (drawn === sidebarDrawn) return;
		sidebarDrawn = drawn;
		sidebar.render({
			workspaces: rows.groups(),
			...(followed === undefined ? {} : { activeSessionId: followed }),
			currentWorkspace: directory,
			collapsed,
			channel,
		});
	}

	/**
	 * Where the next new session lands, and the one answer to the question the picker exists for.
	 *
	 * The explicit choice wins, then the session on screen's workspace, then the server's root — the
	 * order the "当前" mark's promise needs, since the mark names this answer and must never disagree
	 * with the conversation being read.
	 */
	function directoryForNewSession(): string {
		return pickedWorkspace || state.snapshot?.cwd || currentWorkspace;
	}

	/**
	 * The OS folder picker, which is the only road a new workspace enters the list by.
	 *
	 * The app never browses the filesystem itself: the system dialog does the browsing, and the path
	 * it answers becomes the picker's choice and a session in the same breath — a workspace earns its
	 * place in the list by having a session, so adding one *is* starting one.
	 */
	async function addWorkspace(): Promise<void> {
		if (window.desktop?.pickFolder === undefined) {
			report(new Error("选择文件夹需要桌面外壳；浏览器里可以直接用命令行把会话开在目标目录。"));
			return;
		}
		let path: string | undefined;
		try {
			path = await window.desktop.pickFolder();
		} catch (error) {
			report(error);
			return;
		}
		if (path === undefined) return;
		pickedWorkspace = path;
		await newSession(path);
	}

	/** Repaint the status line, and only when a new usage arrived to paint it with. */
	function renderStatusBar(): void {
		if (state.usage === usageDrawn) return;
		usageDrawn = state.usage;
		statusBar.render({ usage: state.usage });
	}

	/**
	 * Fold a new state in and redraw what changed.
	 *
	 * The columns are redrawn independently because they change at very different rates: the transcript
	 * on every token, the sidebar on a row change, the status bar on a settled turn. Testing for a
	 * change here is what keeps a streaming answer from re-rendering the session list.
	 *
	 * `reachable` is the one field whose transitions matter to the composer rather than to a column,
	 * so it is watched on its own: whether the window can send is a fact about the server, and reading
	 * it off a change in `streaming` — which is how the old code got there — meant a failure between
	 * sends left the input box enabled with nothing behind it.
	 */
	function apply(next: ViewState): void {
		const previous = state;
		state = next;

		if (next.items !== previous.items || next.streaming !== previous.streaming) {
			transcript.render(next.items, next.streaming);
		}
		if (next.reachable !== previous.reachable) composer.setDisabled(!next.reachable);
		if (next.streaming !== previous.streaming || next.queued !== previous.queued) {
			composer.setStreaming(next.streaming);
			composer.setQueued(next.queued);
		}
		if (next.usage !== previous.usage) renderStatusBar();
		if (next.error !== previous.error) {
			errorBar.hidden = next.error === undefined;
			errorBar.textContent = next.error ?? "";
		}
		// Approvals are not drawn here: the gated `renderNotices()` at the end of `render()` is the
		// one writer of the banner area, and it fires on exactly the frames this line used to fire on.
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

		// Each piece below draws itself only when one of its own inputs moved. A streaming frame
		// changes none of them, so its cost ends at the transcript — the point of the gates above.
		renderSidebar();

		const headingText = snapshot?.title ?? "新会话";
		if (headingText !== headingDrawn) {
			headingDrawn = headingText;
			heading.textContent = headingText;
		}
		const headingTip = snapshot?.title ?? "";
		if (headingTip !== headingTipDrawn) {
			headingTipDrawn = headingTip;
			heading.title = headingTip;
		}
		const subtitleText = snapshot?.cwd ?? (followed === undefined ? "连接中…" : followed);
		if (subtitleText !== subtitleDrawn) {
			subtitleDrawn = subtitleText;
			subtitle.textContent = subtitleText;
		}

		// The branch entry follows the session's branch shape, which only a baseline can change, so
		// the signature is the tree's identity and the three figures a label is cut from.
		const tree = state.branchTree;
		const branchSig =
			tree === undefined ? "none" : `${tree.currentId ?? "-"}|${tree.points}|${tree.options}|${snapshot?.title ?? ""}`;
		if (branchSig !== branchChipDrawn) {
			branchChipDrawn = branchSig;
			// Fewer than two ways, "branching" names nothing — the entry is gone whole, and with it
			// the only door into the branch page.
			branchChip.hidden = tree === undefined;
			if (tree !== undefined && tree.currentId !== undefined) {
				branchChipId.textContent = shortId(tree.currentId);
				branchChipLabel.textContent = findWay(tree, tree.currentId)?.label ?? "";
			} else {
				branchChipId.textContent = "";
				branchChipLabel.textContent = "";
			}
		}

		// The branch page draws itself from the same tree, and gates on the same rarity: its render
		// costs one comparison unless a baseline changed the tree or a run changed the lock.
		branchView.render(tree, state.streaming);

		// The chip is the composer head's only tenant and is permanent there: the row above the input
		// is where "where the next session lands" belongs, whatever the transcript above is doing.
		const directory = directoryForNewSession();
		if (chipDrawn !== directory) {
			chipDrawn = directory;
			chipLabel.textContent = workspaceName(directory);
			workspaceChip.title = directory;
		}

		// What a send would carry is what the seat shows, so the seat is drawn from the same values
		// `prompt` reads rather than from the snapshot alone. The two selects inside gate themselves
		// on a signature, so this stays cheap per frame.
		composer.setSelection(selectionForSend());

		renderStatusBar();
		renderApprovals();

		if (settings.open) {
			settings.render({
				models: state.models,
				...(state.settings ? { settings: state.settings } : {}),
				...(snapshot ? { snapshot } : {}),
			});
		}
		if (sessionSettings.open) {
			sessionSettings.render({
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
	 *
	 * The gate is the identity of the array it draws from. Rebuilding the banner area on a frame that
	 * did not change it was the last unconditional per-frame write left in `render()` — cheap per
	 * frame, but a rebuild is not nothing, and it ran whether or not any of this was on screen.
	 */
	function renderNotices(): void {
		if (state.models === noticesDrawn) return;
		noticesDrawn = state.models;

		if (state.models.length > 0) {
			banners.replaceChildren();
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

		banners.replaceChildren(card);
	}

	/**
	 * The takeover seat: one card per approval the session is waiting on, in the composer's place.
	 *
	 * A pending approval is the only thing this window can act on while it stands — the run is parked
	 * mid-tool, and typing into an input box would queue words behind a question nobody has answered.
	 * Replacing the composer is the honest rendering of that, and the card carries the two answers the
	 * protocol actually takes.
	 */
	function renderApprovals(): void {
		if (state.approvals === approvalsDrawn) return;
		approvalsDrawn = state.approvals;
		const pending = state.approvals;
		approvalSeat.replaceChildren(...pending.map(approvalCard));
		approvalSeat.hidden = pending.length === 0;
		// The composer hides rather than disables: a visible-but-muted input box under an approval card
		// invites typing that would be queued behind a question. Hidden, the card *is* the input.
		composer.element.hidden = pending.length > 0;
	}

	function approvalCard(approval: ViewState["approvals"][number]): HTMLElement {
		const card = element("div", "approval-card");

		const strip = element("div", "approval-strip");
		strip.append(element("span", "approval-dot"), element("span", undefined, "等待审批"));
		card.append(strip);

		const body = element("div", "approval-body-wrap");
		const cardTitle = element("div", "approval-headline");
		cardTitle.append(icon("shield"), element("span", undefined, `允许运行 ${approval.toolName}？`));
		body.append(cardTitle, element("pre", "approval-command", approval.summary));
		card.append(body);

		const deny = element("button", "button", undefined, { type: "button" });
		deny.textContent = "拒绝";
		const allow = element("button", "button primary", undefined, { type: "button" });
		allow.textContent = "允许一次";
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
	 * Note that the server answered a request, which is what `reachable` means.
	 *
	 * This is the old `connected`, renamed to say what it measures, and its meaning is unchanged: any
	 * successful request proves the server is there. What is new is that it no longer doubles as "the
	 * channel is up" — that is {@link channel}'s own state machine, and the two disagree routinely, in
	 * both directions, without either being wrong. A channel that is down while this is true is normal:
	 * the window can still send, and the request answers for itself.
	 */
	function reachable(): void {
		if (!state.reachable) apply({ ...state, reachable: true });
	}

	/** A request that failed, in the one case where it says something about reaching the server. */
	function unreachable(error: unknown): void {
		if (!(error instanceof TypeError)) {
			report(error);
			return;
		}
		apply({ ...state, reachable: false, error: "无法连接到服务端。" });
	}

	/**
	 * Point the window at a session, and start watching it.
	 *
	 * The one path every session change goes through — a click in the sidebar, a new session, a fork,
	 * and the page load that lands on `GET /api/sessions/current`. Reading it is still a plain `GET`:
	 * viewing an idle conversation costs one request and one render, and no agent is assembled for it.
	 * The subscription on top is what makes the window *live* for that session, and it is exactly what
	 * makes "send" work — the frames a run produces have somewhere to go, so a run that could not start
	 * can say so.
	 *
	 * A run already in flight needs nothing extra: its `submitting` flag is in the snapshot, and the
	 * frames are already coming.
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
		// The previous pane's reference goes before the new one is taken, so a session is never watched
		// by two panes at once on one connection — which is not two subscriptions but a second `open`
		// for a stream the server already has, and the server answers that with an error.
		if (followed !== undefined) mux.release(followed, "pane");
		followed = snapshot.id;
		// A different conversation is a different seat: what was chosen for the one before it says
		// nothing about this one, which opens on whatever its own branch recorded.
		chosen = {};
		// The picker's explicit choice is about the session that was *about* to start, and that session
		// has started — the one on screen now decides what "当前" names until the chip is used again.
		pickedWorkspace = "";
		// A conversation opens to be read. Whatever page the window was on — someone was still staring
		// at another session's tree — the new session starts on its own conversation.
		setPane("chat");
		// The same rendering the branch command uses: a snapshot is a snapshot, whether it arrived on
		// the channel or on a read. The channel's own baseline will replace it within a moment.
		apply(reduce(state, { type: "baseline", session: snapshot }));

		try {
			await refreshLists();
		} catch (error) {
			report(error);
		}

		mux.retain(snapshot.id, "pane");
	}

	/** Re-read the sidebar's rows over REST, but only while the channel is not the authority. */
	async function refreshLists(): Promise<void> {
		const { workspaces } = await api.listWorkspaces();
		reachable();
		// Refused while the channel is live. Two writers for one table is the race this avoids: a
		// listing computed from files would land after a `running: true` and put the row back to idle,
		// and the window would show a session that is working as one that is not.
		if (!rows.loadFrom(workspaces, channel === "live")) return;
		renderSidebar();
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

	/**
	 * Send a message to the session this window is on.
	 *
	 * The subscription is taken **before** the request goes out, and that ordering is the whole reason
	 * the old "attach first, then post, and do not post if the attach failed" dance could be deleted.
	 * A failure to start is reported by `announce`, which is not buffered and only reaches connections
	 * already watching — so a message posted before the window was listening would lose its own error
	 * with nothing on screen to show for it. Retaining first makes the destination impossible to miss.
	 *
	 * The `send` reference is separate from the pane's and lives exactly as long as the run it starts,
	 * which is what lets the window navigate away from a conversation that is still answering: the
	 * stream outlives the pane precisely while there is a run to report.
	 */
	async function prompt(text: string, behavior?: "steer" | "followUp"): Promise<void> {
		// Held rather than read twice: taking the reference hands control back to the channel, and a
		// click in the sidebar during that wait would otherwise post this message to the session the
		// window moved *to* rather than the one the text was written for.
		const target = followed;
		if (target === undefined) {
			report(new Error("还没有挂上任何会话。"));
			return;
		}

		mux.retain(target, "send");
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
			// Nothing is running, so the reference has no run to live for. Dropping it here rather
			// than waiting for a settle that will never come is the release the old code did not have.
			mux.release(target, "send");
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

	/**
	 * Start a conversation in the picker's directory, and point the window at it.
	 *
	 * The directory travels with the request (`cwd`), which is the whole of the picker's contract: a
	 * choice made for one creation is not a state the server keeps. The session it opens re-reads the
	 * lists, which is how a first session in a brand-new directory earns its workspace group a place
	 * in the sidebar.
	 */
	async function newSession(cwd?: string): Promise<void> {
		try {
			const created = await api.createSession(cwd ?? (directoryForNewSession() || undefined));
			reachable();
			await openSession(created.sessionId);
		} catch (error) {
			unreachable(error);
		}
	}

	/**
	 * Copy a session whole into a new file, and open the copy.
	 *
	 * `entryId: null` is the whole-log fork: every entry and every leaf rides along, and the copy
	 * continues from where the source stopped. The row menu acts on a session rather than on any one
	 * message of it, which is why there is no entry in the call.
	 */
	async function forkSession(sessionId: string): Promise<void> {
		try {
			const created = await api.forkSession(sessionId, null);
			reachable();
			await openSession(created.sessionId);
		} catch (error) {
			unreachable(error);
		}
	}

	/**
	 * Give a session a name of its own, stored server-side.
	 *
	 * The sidebar's row does not change here — the name comes back on the `session_row` frame, the
	 * same road every other row fact takes. What this window does beyond the request is keep the
	 * header honest when the renamed session is the one on screen: the header reads the snapshot's
	 * title, and a snapshot does not refresh on a row frame, so the confirmed name is folded in once,
	 * at the moment the server said it stuck.
	 */
	async function renameSession(sessionId: string, title: string): Promise<void> {
		try {
			const { title: stored } = await api.renameSession(sessionId, title);
			reachable();
			if (followed === sessionId && state.snapshot !== undefined) {
				apply({ ...state, snapshot: { ...state.snapshot, title: stored } });
			}
		} catch (error) {
			unreachable(error);
		}
	}

	/**
	 * Delete a session whole, and leave it if this window was reading it.
	 *
	 * The row leaves on the connection's `session_gone` frame, never by a local edit — one road per
	 * fact, the same rule the fork follows. What only the deleting window can do is let go of the
	 * pane: the transcript on screen is a view of something that no longer exists, so it is folded
	 * back to the empty state — models, settings, and reachability kept, because those are the
	 * window's own facts and not the deleted session's.
	 */
	async function deleteSession(sessionId: string): Promise<void> {
		try {
			await api.deleteSession(sessionId);
			reachable();
		} catch (error) {
			// A busy session — a run in flight, an approval waiting — is the server refusing with its
			// reasons named; the error bar is where those reasons are already shown.
			unreachable(error);
			return;
		}
		if (followed !== sessionId) return;
		mux.release(followed, "pane");
		followed = undefined;
		apply({
			...initialState(),
			reachable: state.reachable,
			models: state.models,
			...(state.settings === undefined ? {} : { settings: state.settings }),
		});
	}

	/**
	 * Move this session onto another branch of its own tree.
	 *
	 * `descend` chooses the landing: true follows an alternative to where it stopped, false rewinds
	 * to the message itself so the next prompt starts a new way from there. The answer is applied
	 * here *and* arrives on the channel: the server sends the same snapshot to every window on this
	 * session, and applying the response as well is what keeps the window that clicked from waiting
	 * a round trip to see its own move. Both are the same session state, so the second one to arrive
	 * changes nothing.
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

	/**
	 * The user message's right-click menu — one of the two doors into branching.
	 *
	 * `从此分支` rewinds to the message so the next prompt starts another way from it, which is why
	 * it stays on the conversation page: the branch page has no composer to type that prompt into.
	 * `查看分支图` is the other half, into the page itself. A run in flight is writing to the tree
	 * the first item would move, so while one is streaming the menu offers the look, not the move.
	 */
	function openUserMenu(entryId: string | undefined, x: number, y: number): void {
		const items: MenuItem[] = [];
		if (entryId !== undefined && !state.streaming) {
			items.push({
				label: "从此分支",
				icon: "fork",
				title: "在本会话里从这条消息继续：其后内容保留为另一条分支",
				onSelect: () => void branch(entryId, false),
			});
		}
		items.push({ label: "查看分支图", icon: "tree", onSelect: () => setPane("branch") });
		openMenuAt(x, y, items);
	}

	function report(error: unknown): void {
		apply({ ...state, error: describe(error) });
	}

	// ---------------------------------------------------------------- listeners

	/**
	 * Whether the focus is somewhere keys mean something else.
	 *
	 * The takeover's Enter and Escape are for a person reading the card, not for a form: a button
	 * already focused answers with its own key, and an input that is visible — the panels', the
	 * search's — must not have its typing turned into an answer.
	 */
	function typingTarget(): boolean {
		const target = document.activeElement;
		return (
			target instanceof HTMLElement &&
			["INPUT", "TEXTAREA", "BUTTON", "SELECT", "SUMMARY"].includes(target.tagName)
		);
	}

	window.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			// The menu closes itself in its own capture listener, which stops the event before it gets
			// here; the panels go in the order they were likely opened in.
			if (settings.open) {
				settings.hide();
				return;
			}
			if (sessionSettings.open) {
				sessionSettings.hide();
				return;
			}
			if (state.approvals.length > 0 && followed !== undefined && !typingTarget()) {
				void api.approve(followed, state.approvals[0]!.toolCallId, false).catch(report);
				return;
			}
		}
		if (event.key === "Enter" && state.approvals.length > 0 && followed !== undefined && !typingTarget()) {
			// Enter allows, Escape denies — the two answers the takeover card offers, from the keyboard
			// it replaced the input box for.
			void api.approve(followed, state.approvals[0]!.toolCallId, true).catch(report);
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

	// Fill the panel and the list from the API, independently of the channel: a window that cannot open
	// a connection can still show what the server has, and can still say what is missing. So the first
	// connect happens here rather than at module load — the panel is worth having either way.
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
		// subscription.
		try {
			const { sessionId } = await api.currentSession();
			reachable();
			await openSession(sessionId);
		} catch (error) {
			unreachable(error);
		}
		// Last, so the subscription the pane just took is recorded before the first attempt goes out
		// and can be replayed onto it. Starting earlier would race: the channel could come up, replay
		// nothing, and leave a pane that had asked to be watched unwatched until the next reconnect.
		mux.start();
	})();

	composer.focus();
}

main();
