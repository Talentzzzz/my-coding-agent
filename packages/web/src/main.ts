import {
	applyAppearance,
	initialState,
	reduce,
	reduceEnd,
	findWay,
	type ViewState,
} from "./state.ts";
import { SessionApi, ApiError } from "./api.ts";
import { browserSocket, MuxClient, muxUrl, type ChannelState } from "./client.ts";
import { OncePerFrame } from "./frame.ts";
import { SessionRows } from "./rows.ts";
import { Composer, type ComposerSelection } from "./composer.ts";
import { TranscriptView } from "./render/transcript.ts";
import { BranchView, shortId } from "./render/branch-view.ts";
import { Sidebar, pagingOf, directoryName } from "./render/sidebar.ts";
import { SettingsPanel, modeSummaryOf } from "./render/settings.ts";
import { openMenu, openMenuAt, type MenuItem } from "./render/menu.ts";
import { StatusBar } from "./render/statusbar.ts";
import { element, icon } from "./dom.ts";
import { DEFAULT_THINKING_LEVEL, seedDefaultModel } from "./default-model.ts";
import type { ConnectionItem, ModelOption, ServerMessage, DirectoryPaging } from "@my-agent/core/protocol";

/**
 * The one thing the desktop shell adds to the page: the OS's own folder picker. The app itself does
 * not browse the filesystem — "添加目录" hands the browsing to the system dialog — so a browser
 * without the shell has no picker, and the menu item says so rather than pretending.
 */
declare global {
	interface Window {
		desktop?: { pickFolder?: () => Promise<string | undefined> };
	}
}

/**
 * The built-in default mode's name, restated because its home (`@my-agent/core/config.ts`) runs on
 * Node and the client must not pull that into its bundle — the same restatement rule the settings
 * panel applies for the same reason.
 */
const DEFAULT_MODE_NAME = "默认";

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
	let absCurrentDirectory = "";
	/**
	 * The directory picker's own choice, held by the window and never by the server.
	 *
	 * Three controls read it and nothing else does: the composer chip that displays it, the new-session
	 * button that creates into it, and the sidebar's shadowed heading that names it. Empty means "no
	 * explicit choice", and the answer is then the active session's directory — so that heading can
	 * never contradict the conversation on screen — or the server's root when there is no session.
	 * Opening a session clears it, which is what keeps the choice a "next time" answer rather than a
	 * state that quietly outlives the moment it was made in. It survives no restart and lands in no
	 * file, by decision: a transient preference re-chosen at the moment it is needed is not worth a
	 * store.
	 */
	let absPickedDirectory = "";
	let collapsed = false;
	/**
	 * The sidebar's per-directory paging state, keyed by the directory's path.
	 *
	 * Seeded from the appearance settings when they arrive and written back through them on every
	 * click — the decision 09 号 landed: the state follows appearance, not `localStorage`, which the
	 * desktop shell's fresh port on every launch would strand. A directory the user never touched
	 * keeps no entry, so the map stays empty until a collapse or a page turn happens.
	 */
	let paging: Record<string, DirectoryPaging> = {};
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
	 * Which read of a session the window is on, counted up at every click.
	 *
	 * Reading a session is a request per click, and two of them are in flight the moment someone
	 * clicks a second row before the first has answered. The count is what decides which answer to
	 * keep: a read that is no longer the newest is dropped whole, because applying it would draw the
	 * conversation the user has already moved off — and retaining it would subscribe the pane to a
	 * session the click after it had left. Nothing cancels the request itself; a discarded answer
	 * costs one response body and no work.
	 */
	let openSeries = 0;
	/**
	 * The reads still in flight, by their series, so the loading notice leaves with the last of them.
	 *
	 * A set rather than a count, and the difference is visible: a superseded read finishes *after*
	 * the read that replaced it started, and a counter would have that late finish add nothing but
	 * take the notice down for a read that is still running. Removing a read that is not in the set
	 * is the no-op it should be — the newest read can always speak for the set it is in.
	 */
	const openReads = new Set<number>();

	/** Put the loading notice up for one read, or take it down once nothing is being read. */
	function showLoading(series: number, on: boolean): void {
		if (on) openReads.add(series);
		else openReads.delete(series);
		sessionLoading.hidden = openReads.size === 0;
	}

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

	// ---------------------------------------------------------------- the window band

	/**
	 * The top band: a window-level strip the page lays nothing out in.
	 *
	 * The shell's caption buttons are overlaid onto its right end, and that is its entire content —
	 * which is what makes them harmless. Every control below starts at row 2, so nothing the user can
	 * press ever sits under them. The fill and the drag region are the stylesheet's (`.titleband`);
	 * outside the shell's caption the row collapses to 0px and this element is nothing at all.
	 */
	const titleband = element("div", "titleband");

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
	 * The branch entry, the only door into the branch page.
	 *
	 * It names the way being read — `当前分支`, the short id cut from that way's entry, and the first
	 * sentence said under it. With fewer than two ways there is no way to name, so the id and the
	 * sentence stand empty and the chip reads the mark and the words alone: a single-way conversation
	 * is the one that most needs the door, and the page it opens answers with the how-to.
	 */
	const branchChip = element("button", "branch-chip", undefined, { type: "button", title: "打开分支视图" });
	const branchChipId = element("span", "branch-chip-id");
	const branchChipLabel = element("span", "branch-chip-label");
	branchChip.append(icon("fork"), element("span", undefined, "当前分支"), branchChipId, branchChipLabel);
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
	 * and the answer they chose rides along. The view has already resolved the entry the leaf lands
	 * on: a card on the line names the answer its question produced, so the conversation comes back
	 * showing the question and what it said, and the next prompt forks after the answer.
	 */
	const branchView = new BranchView({
		onSwitch: (entryId, landing) => {
			setPane("chat");
			void branch(entryId, landing === "tip");
		},
		onBack: () => setPane("chat"),
	});
	header.append(branchView.toolsBar);

	const transcriptHost = element("main", "transcript");
	const transcript = new TranscriptView(transcriptHost, {
		onUserContext: (entryId, x, y) => openUserMenu(entryId, x, y),
		onBranch: (entryId) => void branch(entryId, false),
	});
	transcript.trackScroll();

	/**
	 * The drag handle on the reading column's left edge.
	 *
	 * One handle, and it controls the prose's maximum width — the decision 04 took and this window
	 * never carried. The column is centred, so pushing the handle right narrows the text on both
	 * sides at once: the direction the prototype settled after the user said the first one was
	 * backwards. The width it moves is `--dsw-content-width`, and it is computed rather than looked
	 * up, because its default is a formula against the conversation column's own width: column minus
	 * a gutter at each side, ceiling the column minus the tight gutter, floor and absolute cap the
	 * tokens (`--dsw-content-min/cap`) the stylesheet declares. The formula lives here, citing those
	 * tokens — the same split the sidebar's handle makes, and for the same reason.
	 *
	 * Persistence follows the sidebar handle's two rules, which the reference implementation's match:
	 * the preference saved is the one the drag produced, a press that never moved commits nothing —
	 * an empty click must not overwrite a wider preference with whatever the current layout clamped
	 * the display to — and the stored number is clamped to the current layout on every read, so a
	 * smaller window presses the display down without destroying the choice. The server clamps the
	 * stored preference to the absolute range (`CONTENT_WIDTH_RANGE` in `@my-agent/core/config.ts`);
	 * the layout-relative ends are the window's alone, since only it knows the column's width.
	 */
	const contentResizer = element("div", "content-resizer", undefined, {
		role: "separator",
		"aria-orientation": "vertical",
		"aria-label": "调整正文宽度",
		tabindex: "0",
	});
	/** The keys turn the width in steps; the handle itself moves at half this rate, 2px of prose per 1px of pointer. */
	const CONTENT_RESIZE_STEP = 16;
	/**
	 * The formula's constants, read from the same tokens the stylesheet declares.
	 *
	 * Not imported from the config module — it runs on Node, and the client must not pull that into
	 * its bundle — so the tokens are read back, and the literals here are only what a stylesheet that
	 * failed to load falls back to.
	 */
	function contentTokens(): { min: number; cap: number; gutter: number; gutterTight: number } {
		const styles = getComputedStyle(document.documentElement);
		const read = (name: string, fallback: number): number => {
			const value = Number.parseFloat(styles.getPropertyValue(name));
			return Number.isFinite(value) ? value : fallback;
		};
		return {
			min: read("--dsw-content-min", 600),
			cap: read("--dsw-content-cap", 1280),
			gutter: read("--dsw-content-gutter", 35),
			gutterTight: read("--dsw-content-gutter-tight", 20),
		};
	}
	/**
	 * The width to draw for a preference, under this layout.
	 *
	 * `undefined` means the user never dragged: the default is the column minus the resting gutter at
	 * each side, and manufacturing a stored number for it would turn "never chose" into "chose the
	 * default" — the same rule the sidebar's width follows. The result is clamped either way: the
	 * floor is absolute, the ceiling the tighter of the cap and the column minus the tight gutter,
	 * and a column too narrow for the floor lets the ceiling win, because on a narrow window the
	 * prose must fill what is left rather than leave a gap the floor demands.
	 */
	function contentWidthFor(preference: number | undefined): number {
		const { min, cap, gutter, gutterTight } = contentTokens();
		const column = conversation.clientWidth;
		const max = Math.min(cap, column - gutterTight * 2);
		const wanted = preference ?? column - gutter * 2;
		return Math.min(max, Math.max(min, Math.round(wanted)));
	}
	/** The width last written to the variable, so a recompute that answers the same number is skipped. */
	let contentApplied: number | undefined;
	function applyContentWidth(preference: number | undefined): void {
		const width = contentWidthFor(preference);
		if (width === contentApplied) return;
		contentApplied = width;
		document.documentElement.style.setProperty("--dsw-content-width", `${width}px`);
	}
	/** The width on screen right now: what was last written, or what would be. */
	function contentWidthNow(): number {
		return contentApplied ?? contentWidthFor(contentPref);
	}
	/**
	 * The preference as the settings hold it, undefined while the user never dragged.
	 *
	 * Written when a settings snapshot arrives, read by the observer below on every layout change,
	 * and by the drag itself only as the starting point.
	 */
	let contentPref: number | undefined;
	// The default is a formula against the column's width, so anything that changes that width — the
	// window's, or the sidebar's — re-asks the question. The observer is the one place that
	// recomputation is scheduled from: a column resize is a resize, whichever handle caused it.
	new ResizeObserver(() => applyContentWidth(contentPref)).observe(conversation);
	let contentDrag: { x: number; width: number } | undefined;
	contentResizer.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		contentDrag = { x: event.clientX, width: contentWidthNow() };
		contentResizer.setPointerCapture(event.pointerId);
		contentResizer.classList.add("dragging");
	});
	contentResizer.addEventListener("pointermove", (event) => {
		if (contentDrag === undefined) return;
		// The column is centred, so one pixel of handle moves two pixels of prose — the factor the
		// prototype settled on, and what keeps the handle under the pointer as it drags.
		applyContentWidth(contentDrag.width - (event.clientX - contentDrag.x) * 2);
	});
	const endContentDrag = (): void => {
		contentDrag = undefined;
		contentResizer.classList.remove("dragging");
	};
	contentResizer.addEventListener("pointerup", (event) => {
		// Measured against where the drag began, so a click that never moved saves nothing — the same
		// guard the sidebar's handle puts between an empty press and the stored preference.
		const moved = contentDrag !== undefined && event.clientX !== contentDrag.x;
		endContentDrag();
		if (moved) {
			contentPref = contentWidthNow();
			void saveSettings({ appearance: { contentWidth: contentPref } });
		}
	});
	contentResizer.addEventListener("pointercancel", () => endContentDrag());
	contentResizer.addEventListener("keydown", (event) => {
		// Right narrows, left widens — the same direction a drag follows.
		const step = event.key === "ArrowRight" ? -CONTENT_RESIZE_STEP : event.key === "ArrowLeft" ? CONTENT_RESIZE_STEP : 0;
		if (step === 0) return;
		event.preventDefault();
		// Stored is what the draw clamped to, the same thing a drag commits: a keypress against a
		// clamp this layout already enforces must not file a wider preference that only takes effect
		// after the window grows.
		applyContentWidth(contentWidthNow() + step);
		contentPref = contentApplied;
		void saveSettings({ appearance: { contentWidth: contentPref } });
	});

	/**
	 * The transcript's wrapper: the grid row that flexes, and the handle's positioning context.
	 *
	 * The two live one layer apart on purpose — an absolutely positioned handle inside the scroll
	 * container itself would scroll away with the content, while the handle belongs to the layout
	 * the prose is read through, not to anything in it.
	 */
	const transcriptBody = element("div", "transcript-body");
	/**
	 * The notice that a session is being read, which is the window's only answer to "did my click
	 * do anything".
	 *
	 * Reading a session is one request and then one draw, and until the draw lands the previous
	 * transcript is still on screen — the deliberate behaviour of a pane that swaps rather than
	 * blanks, but indistinguishable from "the click was ignored" when the request is slow. So the
	 * wait gets a face: it appears over the pane the moment the read starts and leaves when the
	 * snapshot's first slice has been drawn.
	 *
	 * It sits in the wrapper rather than in the transcript because the transcript scrolls: a notice
	 * inside the scroll container would scroll away with the conversation it is replacing. That is
	 * the same one-layer-apart arrangement the reading column's handle makes.
	 */
	const sessionLoading = element("div", "session-loading", undefined, { role: "status", "aria-live": "polite" });
	const loadingRing = element("div", "loading-ring");
	const loadingLabel = element("div", "loading-label", "正在载入会话…");
	sessionLoading.append(loadingRing, loadingLabel);
	sessionLoading.hidden = true;
	transcriptBody.append(transcriptHost, contentResizer, sessionLoading);

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
	/** The composer head: the directory chip on the row above the input card, leftmost. */
	const composerHead = element("div", "composer-head");
	const composer = new Composer({
		onSubmit: (text, behavior) => void prompt(text, behavior),
		onAbort: () => void abort(),
		onSelectModel: (name) => {
			// Only the model moves. The level is the composer's, every model takes the same four, and a
			// strength the user chose should not be silently reset by switching which endpoint answers.
			chosen = { ...chosen, model: name };
			render();
		},
		onSelectLevel: (level) => {
			chosen = { ...chosen, thinkingLevel: level };
			render();
		},
		// The mode menu's rows are built here, where the presets and the session's live state are: the
		// built-in default first, then the stored modes, then the one road into editing them. It opens
		// upward: the mode seat is on the bar at the window's bottom edge, where a menu hung underneath
		// it would have nowhere to go.
		onModes: (anchor) => {
			const settings = state.settings;
			const allTools = state.snapshot?.allTools ?? [];
			const defaultTools = settings?.tools === undefined ? allTools : settings.tools.filter((name) => allTools.includes(name));
			const current = currentModeName();
			openMenu(
				anchor,
				[
					{
						label: DEFAULT_MODE_NAME,
						detail: modeSummaryOf(defaultTools, settings?.approval ?? {}),
						active: current === DEFAULT_MODE_NAME,
						onSelect: () => applyMode(DEFAULT_MODE_NAME),
					},
					...(settings?.modes ?? []).map((mode) => ({
						label: mode.name,
						detail: modeSummaryOf(mode.tools, mode.approval),
						active: current === mode.name,
						onSelect: () => applyMode(mode.name),
					})),
					{ kind: "separator" as const },
					{ label: "去设置 › 模式", onSelect: () => openSettings("modes") },
				],
				{ placement: "above" },
			);
		},
		onSelectMode: (name) => applyMode(name),
	});
	composerWrap.append(errorBar, approvalSeat, composerHead, composer.element);

	/**
	 * The directory chip, and the menu it opens.
	 *
	 * The chip is the picker's face: it shows where the *next* new session will land, and it lives on
	 * the row above the input card, leftmost — the composer is where a session starts, so that is
	 * where "where the next one starts" belongs (01 ⑦). The choice never rewrites the session on
	 * screen, and the chip is placed by the input it sits over rather than by what the transcript
	 * says, so it needs no phase to come and go with. Its menu lists the directories this machine
	 * already knows plus the one road in for one it does not; the list is drawn from the sidebar's
	 * own rows, so a directory that earned its place by having a session is the same list here.
	 */
	const directoryChip = element("button", "directory-chip", undefined, { type: "button", "aria-haspopup": "menu" });
	const chipLabel = element("span", "directory-chip-label");
	directoryChip.append(icon("folder"), chipLabel, icon("chevron"));
	directoryChip.addEventListener("click", () => {
		const groups = rows.groups();
		// Nothing known yet: a one-row menu whose only row is the add action is a menu that pretends
		// there was a choice, so the click goes straight to the picker, as the reference does.
		if (groups.length === 0) {
			void addDirectory();
			return;
		}
		const absChosenDir = directoryForNewSession();
		// Upward like the bar's three seats: the chip sits at the bottom of the window too, and a menu
		// that fell below it would land on the input card it hangs over.
		openMenu(
			directoryChip,
			[
				...groups.map((group) => ({
					icon: "folder" as const,
					label: state.settings?.directoryNames?.[group.workDirAbsPath] ?? directoryName(group.workDirAbsPath),
					title: group.workDirAbsPath,
					active: group.workDirAbsPath === absChosenDir,
					onSelect: () => {
						absPickedDirectory = group.workDirAbsPath;
						render();
					},
				})),
				{ kind: "separator" as const },
				{
					label: "添加目录…",
					onSelect: () => void addDirectory(),
				},
			],
			{ placement: "above" },
		);
	});
	composerHead.append(directoryChip);

	const statusBar = new StatusBar();

	// The branch page sits where the transcript sits: one grid row that flexes, whichever of the two
	// is on. Hiding is CSS's job (`body[data-pane]`), so the two pages trade places without any of
	// the chrome around them re-flowing.
	conversation.append(header, transcriptBody, branchView.element, banners, composerWrap, statusBar.element);

	// ------------------------------------------------------------------ sidebar

	const sidebar = new Sidebar({
		// The heading's own 「新建会话」 names the directory it was asked on; the top row names nothing
		// and follows the picker. The choice is folded into `absPickedDirectory` *before* the create goes
		// out, because `openSession` clears it — the picker has done its job once the session exists.
		onNewSession: (workDirAbsPath) => {
			if (workDirAbsPath !== undefined) absPickedDirectory = workDirAbsPath;
			void newSession(workDirAbsPath);
		},
		onSelectSession: (sessionId) => void openSession(sessionId),
		onToggleCollapsed: () => {
			collapsed = !collapsed;
			render();
		},
		onOpenSettings: () => openSettings(),
		onAddDirectory: () => void addDirectory(),
		// The row menu's fork copies a session whole — it acts on a session, not on a message, so this
		// is the `entryId: null` fork rather than anything a message used to offer.
		onForkSession: (sessionId) => void forkSession(sessionId),
		onDeleteSession: (sessionId) => void deleteSession(sessionId),
		onRenameSession: (sessionId, title) => void renameSession(sessionId, title),
		onToggleDirectory: (workDirAbsPath) => {
			const entry = pagingOf(paging, workDirAbsPath);
			// Expanding lands on the page the directory was read down to when it collapsed; collapsing
			// saves the page it was on. The two paging buttons write the saved page too — they are
			// where the reading happens — so the saved page is always the page on screen.
			setPaging(
				workDirAbsPath,
				entry.collapsed
					? { collapsed: false, page: entry.savedPage, savedPage: entry.savedPage }
					: { collapsed: true, page: entry.page, savedPage: entry.page },
			);
		},
		onPageDirectory: (workDirAbsPath) => {
			const entry = pagingOf(paging, workDirAbsPath);
			setPaging(workDirAbsPath, { collapsed: false, page: entry.page + 1, savedPage: entry.page + 1 });
		},
		onCollapseDirectory: (workDirAbsPath) => {
			// Step back the one page the last 「展开其余」 added — not a reset to the first, and the
			// saved page moves with it: un-expanding is un-reading, so reopening a later
			// heading-collapse lands on the page the user had actually read down to.
			const entry = pagingOf(paging, workDirAbsPath);
			const page = Math.max(1, entry.page - 1);
			setPaging(workDirAbsPath, { collapsed: false, page, savedPage: page });
		},
		onRenameDirectory: (workDirAbsPath, name) => void renameDirectory(workDirAbsPath, name),
		onDeleteDirectory: (workDirAbsPath) => void deleteDirectory(workDirAbsPath),
	});

	/**
	 * Fold one directory's paging state in, redraw, and persist it through appearance.
	 *
	 * The local map moves first so the redraw does not wait on a round trip; the map is then sent
	 * whole, the way every appearance field is. The server's answer lands in `apply`, which re-seeds
	 * this map from the saved settings — when the write failed, the report is the error bar and the
	 * view keeps the click, which is the honest split: the screen is what the user did, the file is
	 * what survived.
	 */
	function setPaging(workDirAbsPath: string, next: DirectoryPaging): void {
		paging = { ...paging, [workDirAbsPath]: next };
		renderSidebar();
		void saveSettings({ appearance: { directories: paging } });
	}

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
		onGlobalApproval: (tool, value) => saveSettings({ approval: { [tool]: value } }),
		onSaveModels: async (rows) => {
			const { models } = await api.updateModels(rows);
			apply({ ...state, models });
		},
		// The modes list, whole — the endpoint replaces it, so a rename here and a delete there land
		// together. The snapshot that comes back re-seeds every mode reader.
		onSaveModes: (modes) => saveSettings({ modes }),
		// The default a *new* session opens on, so it writes the settings files. The model a live session
		// is on is the composer's, and never goes through here.
		onDefaultModel: (name) => void saveSettings({ model: name }),
		onGlobalTools: (names) => saveSettings({ tools: names }),
	});

	// The handle sits between the two columns — it is the sidebar's right edge, which is the whole
	// point — and the rail's CSS hides it, since a 52px rail is not a width anyone is choosing.
	// The band goes first: as #app's first grid item it takes the window's top row, the one strip the
	// caption's buttons are overlaid onto, and it stays empty by design — every touchable thing the
	// page owns begins in row 2, so the buttons cannot cover anything.
	root.append(titleband, sidebar.element, sidebarResizer, conversation, settings.element);

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
				// beginning. Under the end-restart semantics (ADR-0006 §5) a run waiting on an approval
				// *is* over — the run ended at the gate and the answer arrives over REST — so settling
				// here releases the reference while the question stands; while the window stays on the
				// conversation the pane's own reference keeps watching, and the answer's resumed run is
				// reported on that.
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
				// Coalesced: a run's deltas arrive far faster than the display refreshes, and painting
				// each one is work no frame shows. The fold still happens here, per event; the draw is
				// asked for once and runs against the last state the frame reached.
				apply(reduce(state, message), { coalesce: true });
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
			// The fold before the row removal, so the sidebar draws once with both facts in hand: the
			// pane already elsewhere and the row already gone. The fold itself is the shared one —
			// a session deleted by another window folds this window exactly the way a local delete
			// does, because gone is gone whichever window said it.
			foldFromDeleted(item.sessionId);
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
		// with the directory count; the rows bump `rows.version` when they actually change.
		// The paging state is in the signature because it is one of the sidebar's inputs now: a
		// collapse or a page turn changes nothing in the row table, so a signature without it would
		// mean the click redraws nothing at all. Serialization is deterministic — the entries are
		// built with one fixed field order — so the string is stable across equal maps.
		// The names are in the signature for the same reason the paging map is: a rename moves nothing
		// in the row table, so a signature that ignored the labels would mean the click repaints nothing.
		const names = state.settings?.directoryNames;
		const drawn = `${rows.version}|${followed ?? ""}|${absPickedDirectory}|${collapsed ? 1 : 0}|${channel}|${JSON.stringify(paging)}|${JSON.stringify(names ?? {})}`;
		if (drawn === sidebarDrawn) return;
		sidebarDrawn = drawn;
		sidebar.render({
			directories: rows.groups(),
			...(followed === undefined ? {} : { activeSessionId: followed }),
			collapsed,
			paging,
			...(names === undefined ? {} : { directoryNames: names }),
			channel,
		});
	}

	/**
	 * Where the next new session lands, and the one answer to the question the picker exists for.
	 *
	 * The explicit choice wins, then the session on screen's directory, then the server's root — the
	 * order the shadowed heading's promise needs, since that heading names this answer and must never
	 * disagree with the conversation being read.
	 */
	function directoryForNewSession(): string {
		return absPickedDirectory || state.snapshot?.workDirAbsPath || absCurrentDirectory;
	}

	/**
	 * The OS folder picker, which is the only road a new directory enters the list by.
	 *
	 * The app never browses the filesystem itself: the system dialog does the browsing, and the path
	 * it answers becomes the picker's choice and a session in the same breath — a directory earns its
	 * place in the list by having a session, so adding one *is* starting one.
	 */
	async function addDirectory(): Promise<void> {
		if (window.desktop?.pickFolder === undefined) {
			report(new Error("选择文件夹需要桌面外壳；浏览器里可以直接用命令行把会话开在目标目录。"));
			return;
		}
		let absPath: string | undefined;
		try {
			absPath = await window.desktop.pickFolder();
		} catch (error) {
			report(error);
			return;
		}
		if (absPath === undefined) return;
		absPickedDirectory = absPath;
		await newSession(absPath);
	}

	/** Repaint the status line, and only when a new usage arrived to paint it with. */
	function renderStatusBar(): void {
		if (state.usage === usageDrawn) return;
		usageDrawn = state.usage;
		statusBar.render({ usage: state.usage });
	}

	/** How a fold reaches the screen: whole now, in bounded slices, or at most once per frame. */
	interface ApplyOptions {
		/** Draw a whole snapshot in bounded slices — the cost of a session switch, not of a delta. */
		deferred?: boolean;
		/** Land this draw on the next animation frame instead of in this one — a stream delta. */
		coalesce?: boolean;
	}

	/**
	 * The state the screen was last drawn from.
	 *
	 * The gates below compare a state against this rather than against the state the previous fold
	 * produced: several folds can land between two draws — that is the point of coalescing them — and
	 * "did this change" is a question about what is on screen, not about what the last event was.
	 */
	let drawnState: ViewState = state;

	/**
	 * The coalesced delta draw: many stream frames, one paint.
	 *
	 * A provider sends tens of deltas between two display refreshes, and repainting the transcript for
	 * each is work the reader never sees — the intermediate states are not on screen for a single
	 * frame. The fold itself still runs per event (it is a cheap immutable update), so nothing about
	 * the state is skipped; only the drawing is saved for the frame, which paints the last state the
	 * run reached.
	 */
	const deltaDraw = new OncePerFrame(() => {
		const previous = drawnState;
		drawnState = state;
		drawState(state, previous);
	});

	/**
	 * Fold a new state in and draw what it changed.
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
	function apply(next: ViewState, options: ApplyOptions = {}): void {
		state = next;
		if (options.coalesce === true) {
			deltaDraw.schedule();
			return;
		}
		// An immediate draw supersedes a queued one: it is about to paint this very state, and an armed
		// frame would paint it a second time a refresh later.
		deltaDraw.cancel();
		const previous = drawnState;
		drawnState = next;
		drawState(next, previous, options);
	}

	/** Draw the parts of `next` — which callers have already made `state` — that differ from the last draw. */
	function drawState(next: ViewState, previous: ViewState, options: ApplyOptions = {}): void {
		// A new settings snapshot may carry a content-width preference, and the reading column is the
		// one thing that draws from it. Same road the sidebar's width rides into `applyAppearance`,
		// except this one is layout-relative and so is painted here, beside the column it measures.
		if (next.settings !== previous.settings) {
			contentPref = next.settings?.appearance.contentWidth;
			applyContentWidth(contentPref);
			// The sidebar's paging state rides the same snapshot. Re-seeded rather than merged: the
			// settings are the authority, and a directory whose entry the server dropped — a bad line
			// in a hand-edited file — falls back to its default, not to this window's memory of it.
			paging = next.settings?.appearance.directories ?? {};
		}
		if (next.items !== previous.items || next.streaming !== previous.streaming) {
			// `deferred` is set by the one caller that hands over a whole conversation at once — the
			// session switch — where the draw is the cost of the switch and must not hold the frame.
			// Every other frame carries a delta the reader is watching arrive, and lands whole.
			if (options.deferred) transcript.renderDeferred(next.items, next.streaming);
			else transcript.render(next.items, next.streaming);
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
	 * list when the name names a row that is gone.
	 */
	function selectionForSend(): ComposerSelection {
		const snapshot = state.snapshot;
		const model = chosen.model ?? snapshot?.model ?? "";
		const row = rowOf(model);
		const levels = row?.thinkingLevels ?? snapshot?.thinkingLevels ?? [];
		const level = chosen.thinkingLevel ?? snapshot?.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
		return { models: state.models, model, levels, level };
	}

	/** The imported row behind a name, or undefined for one that was deleted or never existed. */
	function rowOf(name: string | undefined): ModelOption | undefined {
		return name === undefined ? undefined : state.models.find((model) => model.name === name);
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

	/** Open the app-level settings panel, optionally straight onto one tab. */
	function openSettings(tab?: "modes"): void {
		settings.show(tab);
		settings.render({
			models: state.models,
			...(state.settings ? { settings: state.settings } : {}),
			...(state.snapshot ? { snapshot: state.snapshot } : {}),
		});
	}

	/**
	 * Which mode the session on screen is on, matched by value (ADR-0005).
	 *
	 * The session records what it runs on in its `.json` snapshot, not as a mode reference, so
	 * the match is the snapshot's tools and approvals against each preset's — the built-in default
	 * first, since it *is* the global defaults a following-global session holds. No session on screen
	 * answers with the default, because that is what the next one opens on; a live session that
	 * matches nothing — left behind by a mode since edited, or by a tool set an older build recorded —
	 * answers undefined, which the seat draws as 「自定义」. Picking a mode is the one way back.
	 */
	function currentModeName(): string | undefined {
		const snapshot = state.snapshot;
		const settings = state.settings;
		if (snapshot === undefined || settings === undefined) return DEFAULT_MODE_NAME;

		const sameTools = (a: readonly string[], b: readonly string[]): boolean =>
			a.length === b.length && a.every((name) => b.includes(name));
		const sameApprovals = (a: Record<string, boolean>, b: Record<string, boolean>): boolean => {
			for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
				if (a[key] !== b[key]) return false;
			}
			return true;
		};

		// Both sides are narrowed to the tools this build knows before the comparison, the same
		// narrowing an apply performs — otherwise a preset naming a tool an upgrade dropped could be
		// applied correctly and still read back as 自定义.
		const defaultTools = (settings.tools ?? snapshot.allTools).filter((name) => snapshot.allTools.includes(name));
		if (sameTools(snapshot.activeTools, defaultTools) && sameApprovals(snapshot.approvals, settings.approval)) {
			return DEFAULT_MODE_NAME;
		}
		return settings.modes?.find(
			(mode) =>
				sameTools(mode.tools.filter((name) => snapshot.allTools.includes(name)), snapshot.activeTools) &&
				sameApprovals(mode.approval, snapshot.approvals),
		)?.name;
	}

	/**
	 * Put the session this window is on onto a mode: its tool set and its approval map, whole.
	 *
	 * The two halves are the session's own two commands — `PUT /tools` and the approval `PATCH` —
	 * and they land as one recorded choice in the session's `.json` snapshot. There is deliberately no mode
	 * endpoint: a preset *is* those two values, and a second spelling of the same command would only
	 * have to be kept in step with them.
	 */
	function applyMode(name: string): void {
		if (followed === undefined) {
			report(new Error("还没有挂上任何会话。"));
			return;
		}
		const settings = state.settings;
		const snapshot = state.snapshot;
		if (settings === undefined || snapshot === undefined) {
			report(new Error("设置还没有读到，稍后再试。"));
			return;
		}
		const preset =
			name === DEFAULT_MODE_NAME
				? { tools: settings.tools ?? snapshot.allTools, approval: { ...settings.approval } }
				: settings.modes?.find((mode) => mode.name === name);
		if (preset === undefined) {
			report(new Error(`没有叫「${name}」的模式，可能刚被删除。`));
			return;
		}
		// Narrowed to the tools this build knows, so a preset naming one an upgrade dropped applies the
		// rest instead of being refused whole — the same narrowing the session's recorded set gets.
		const tools = preset.tools.filter((candidate) => snapshot.allTools.includes(candidate));
		void api.setTools(followed, tools).catch(report);
		void api.setConfig(followed, { approval: { ...preset.approval } }).catch(report);
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
		const subtitleText = snapshot?.workDirAbsPath ?? (followed === undefined ? "连接中…" : followed);
		if (subtitleText !== subtitleDrawn) {
			subtitleDrawn = subtitleText;
			subtitle.textContent = subtitleText;
		}

		// The branch entry follows the session's branch shape, which a baseline or a finished message
		// can change, so the signature is the tree's identity and the three figures a label is cut
		// from. "none" is the single-way shape — the chip stands with nothing to name — and any move
		// between a tree and "none" changes the signature, so the label it carries is always redrawn
		// with it.
		const tree = state.branchTree;
		const branchSig =
			tree === undefined ? "none" : `${tree.currentId ?? "-"}|${tree.points}|${tree.options}|${snapshot?.title ?? ""}`;
		if (branchSig !== branchChipDrawn) {
			branchChipDrawn = branchSig;
			// Always visible: a conversation with one way is exactly the one that needs the door, and
			// the page it opens answers with the how-to. The id and the label are another matter: a
			// session with no fork has one branch, so "which one am I on" answers itself and the
			// figures only say "the newest user message" — noise. They appear when a fork exists,
			// which is when the question has an answer worth reading.
			if (tree !== undefined && tree.currentId !== undefined && tree.points > 0) {
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
			chipLabel.textContent = directoryName(directory);
			directoryChip.title = directory;
		}

		// What a send would carry is what the seat shows, so the seat is drawn from the same values
		// `prompt` reads rather than from the snapshot alone. The two selects inside gate themselves
		// on a signature, so this stays cheap per frame.
		composer.setSelection(selectionForSend());
		// The mode seat is the same kind of read: which preset the session's values equal, or none.
		composer.setModes(currentModeName());

		renderStatusBar();
		renderApprovals();

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
		open.addEventListener("click", () => openSettings());
		card.append(mark, text, open);

		banners.replaceChildren(card);
	}

	/**
	 * The takeover seat: one card per approval the session is waiting on, in the composer's place.
	 *
	 * A pending approval is the only thing this window can act on while it stands — under the
	 * end-restart semantics (ADR-0006 §5) the run has ended at the gate, and a prompt typed now would
	 * start a run whose recovery pass would sweep the still-dangling call aside. Replacing the composer
	 * is the honest rendering of that, and the card carries the two answers the protocol actually
	 * takes; answering one starts the run that resumes the conversation.
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
	 *
	 * Four things about the order are load-bearing, and each was a way the window used to stall or lose
	 * its place:
	 *
	 * - The pane flips to the conversation before the read, not after it. The read is slow enough to
	 *   work in, and a reader who has clicked a row, then gone to the branch page, must not have the
	 *   pane pulled out from under the tree they are looking at when the answer finally lands. A
	 *   conversation opens to be read, and that is a decision about the click rather than about the
	 *   answer — so a read that fails leaves the old conversation on screen instead of a blank pane.
	 * - The read is announced before it starts. It is the window's slowest, least predictable step —
	 *   a whole conversation over the wire and through `JSON.parse` — and the previous transcript stays
	 *   up throughout, which is right for the pane and mute about the click.
	 * - The snapshot is drawn deferred. It is the whole conversation in one frame, and every message in
	 *   it is new, so the draw is proportional to the session: drawn whole it is the freeze, drawn in
	 *   slices it is a first paint plus a handful of frames.
	 * - The subscription is retained before the list refresh, and the list refresh is not awaited. The
	 *   window is *live* on this session from the moment its baseline is on screen; the sidebar's rows
	 *   arrive on the channel anyway when it is up, and when it is not, the listing is a repair of a
	 *   column that is already drawn — not something the pane's liveness may queue behind.
	 */
	async function openSession(sessionId: string): Promise<void> {
		const series = (openSeries += 1);
		setPane("chat");
		showLoading(series, true);
		let snapshot;
		try {
			snapshot = await api.read(sessionId);
		} catch (error) {
			showLoading(series, false);
			// A superseded read's failure is not news about the pane: the user is looking at a session
			// that read fine, and a banner about the one they left — often the same server, often the
			// same request raced by a newer click — would name a problem that is not on screen. The
			// read that owns the pane owns the report too.
			if (series !== openSeries) return;
			unreachable(error);
			return;
		}
		showLoading(series, false);
		// A newer click moved the window while this read was in flight. Its answer names a session the
		// pane has already left, so it is dropped whole: no state, no draw, no subscription. The read
		// that superseded it owns all three.
		if (series !== openSeries) return;

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
		// has started — the one on screen now decides which directory the next session lands in, until
		// the chip is used again.
		absPickedDirectory = "";
		// The same rendering the branch command uses: a snapshot is a snapshot, whether it arrived on
		// the channel or on a read. The channel's own baseline will replace it within a moment.
		apply(reduce(state, { type: "baseline", session: snapshot }), { deferred: true });

		// Taken before the list is asked for, and that is the whole point of the order: the pane is live
		// on this session now, and the subscription is what a send needs. Asking for the listing first
		// would leave a window in which the conversation is on screen and nothing is listening to it.
		mux.retain(snapshot.id, "pane");
		// The listing is not awaited. It redraws the sidebar and nothing else, it is refused outright
		// while the channel is live (the channel is the authority on rows then), and the frame it would
		// have held up is the frame the reader is waiting on. A failure to get it is reported against
		// the window rather than against the pane, so it cannot undo the switch either.
		void refreshLists().catch(report);
	}

	/** Re-read the sidebar's rows over REST, but only while the channel is not the authority. */
	async function refreshLists(): Promise<void> {
		const { directories } = await api.listDirectories();
		reachable();
		// Refused while the channel is live. Two writers for one table is the race this avoids: a
		// listing computed from files would land after a `running: true` and put the row back to idle,
		// and the window would show a session that is working as one that is not.
		if (!rows.loadFrom(directories, channel === "live")) return;
		renderSidebar();
	}

	/**
	 * The tail of the settings writes, so one file's patches land one at a time.
	 *
	 * A save that moves a tool set and the approvals that came with it is several patches, and every
	 * answer carries the whole settings object: two in flight could apply the older answer last and
	 * repaint the window with a snapshot that has already been superseded. Chaining the requests keeps
	 * the answers — and the state they paint — in the order the user made them. Settings are one file,
	 * so one writer at a time is the contract the files already assume.
	 */
	let settingsWrites: Promise<void> = Promise.resolve();

	function saveSettings(patch: Parameters<SessionApi["updateSettings"]>[0]): Promise<void> {
		// The catch sits at the chain's end rather than in `writeSettings`: one refused patch is
		// reported once, the chain still resolves, and the next patch — about a different field — goes
		// out instead of being cancelled by its predecessor's rejection.
		const write = settingsWrites.then(() => writeSettings(patch)).catch((error: unknown) => {
			report(error);
		});
		settingsWrites = write;
		return write;
	}

	async function writeSettings(patch: Parameters<SessionApi["updateSettings"]>[0]): Promise<void> {
		const { settings: saved } = await api.updateSettings(patch);
		// Applied straight away rather than after a re-render: the font size and the theme are the
		// two settings whose whole value is seeing them change. The branch page measures its cards
		// off the type scale, so it is the one view that has to be told to measure again.
		applyAppearance(saved);
		branchView.remeasure();
		apply({ ...state, settings: saved });
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
	 * The directory travels with the request (`workDirAbsPath`), which is the whole of the picker's contract: a
	 * choice made for one creation is not a state the server keeps. The session it opens re-reads the
	 * lists, which is how a first session in a brand-new directory earns its directory group a place
	 * in the sidebar.
	 */
	async function newSession(workDirAbsPath?: string): Promise<void> {
		try {
			const created = await api.createSession(workDirAbsPath ?? (directoryForNewSession() || undefined));
			reachable();
			await openSession(created.sessionId);
		} catch (error) {
			unreachable(error);
		}
	}

	/**
	 * Give a directory a name the sidebar shows, and leave the disk alone.
	 *
	 * `name` is a label, not a path: nothing here builds a directory, and the answer carries the
	 * settings because that is where the label lives. The rows are untouched — a directory is
	 * identified by the directory its transcripts recorded — so the only thing this window owes the
	 * change is a repaint, which a cleared `sidebarDrawn` forces past the gate below.
	 *
	 * An empty name takes the custom one back and the heading falls to the folder's own name.
	 */
	async function renameDirectory(workDirAbsPath: string, name: string): Promise<void> {
		try {
			const answer = await api.renameDirectory(workDirAbsPath, name);
			reachable();
			apply({ ...state, settings: answer.settings });
			// The settings snapshot moved but nothing in the gate's signature has to: the rows are the
			// same rows, and a heading wearing a different label would otherwise keep its old text.
			sidebarDrawn = undefined;
			renderSidebar();
		} catch (error) {
			// A path this machine has no sessions for, a body the server cannot read: the error bar is
			// where those reasons are already shown.
			unreachable(error);
		}
	}

	/**
	 * Take a directory out of the sidebar, touching nothing on disk (票 06).
	 *
	 * Two roads, one per channel state, and the difference is not a detail: while the channel is live
	 * the *server* removes the group by re-sending the overview — the row table's one writer is the
	 * channel, and a REST listing is refused outright while it holds that pen (`rows.loadFrom` is that
	 * refusal). While it is down there are no frames, so the listing the answer carries is the only
	 * road, and it is applied here. What this window owes either of them is its settings snapshot: the
	 * hidden list is what the next reload leaves the group out by.
	 */
	async function deleteDirectory(workDirAbsPath: string): Promise<void> {
		try {
			const answer = await api.hideDirectory(workDirAbsPath);
			reachable();
			rows.loadFrom(answer.directories, channel === "live");
			applyAppearance(answer.settings);
			branchView.remeasure();
			apply({ ...state, settings: answer.settings });
			// The settings snapshot changed, but nothing in the signature the gate reads has to: a
			// window with no rows for this group would otherwise draw the same string it drew before.
			sidebarDrawn = undefined;
			renderSidebar();
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
	 * fact, the same rule the fork follows. The fold itself is {@link foldFromDeleted}, shared with
	 * that frame: whichever of the two lands first does the work, and the other finds the pane
	 * already elsewhere.
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
		foldFromDeleted(sessionId);
	}

	/**
	 * Fold the pane away from a session that no longer exists.
	 *
	 * Two doors lead here carrying the same verdict: this window's own delete, and the connection's
	 * `session_gone` frame for a session another window deleted. The transcript on screen is a view
	 * of something that is gone either way, so the fold is the same one — models, settings, and
	 * reachability kept, because those are the window's own facts and not the deleted session's.
	 * Releasing the pane reference here, on the frame rather than only on the local delete, is what
	 * keeps a reference held on a session the server has forgotten from turning the next reconnect
	 * into a refused `open` — and the refusal into a banner for a race nobody chose.
	 */
	function foldFromDeleted(sessionId: string): void {
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
			// A rewind — the fork button's case — is half a gesture: the branch is only real once
			// the next prompt is typed, so the composer takes the focus the press was aiming at.
			if (!descend) composer.focus();
		} catch (error) {
			report(error);
		}
	}

	/**
	 * The user message's right-click menu.
	 *
	 * `从此分支` rewinds to the message so the next prompt starts another way from it, which is why
	 * it stays on the conversation page: the branch page has no composer to type that prompt into.
	 * The door into the branch page itself is the header's chip alone — one entry, one place — so a
	 * streaming run, which is moving the very tree a branch would grow from, simply leaves the menu
	 * unopened rather than offering a look the chip already serves.
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
		if (items.length === 0) return;
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

	/**
	 * The imported rows, planting the window's built-in default when nothing is imported yet.
	 *
	 * This is the one place a message is ever written by the window without the user asking: a machine
	 * with no model can do nothing at all, and a notice explaining that is a worse first screen than
	 * the row that makes it untrue. The row is `DEFAULT_MODEL` — keyless, so it is a starting point and
	 * not a credential — and it goes through the ordinary model endpoint, exactly as if the user had
	 * typed it. After it lands, the settings marker records that this window made the offer, which is
	 * what keeps a deleted row deleted on the next launch; see `default-model.ts`.
	 *
	 * A planting that fails is reported and the read's own answer — possibly empty — still lands: the
	 * window opens, says what went wrong, and the settings panel is still the fix.
	 */
	async function importedModels(): Promise<ModelOption[]> {
		const { models } = await api.listModels();
		try {
			const planted = await seedDefaultModel({
				models,
				seeded: state.settings?.defaultModelSeeded === true,
				save: async (rows) => (await api.updateModels(rows)).models,
				markSeeded: () => saveSettings({ defaultModelSeeded: true }),
			});
			return planted ?? models;
		} catch (error) {
			report(error);
			return models;
		}
	}

	// Fill the panel and the list from the API, independently of the channel: a window that cannot open
	// a connection can still show what the server has, and can still say what is missing. So the first
	// connect happens here rather than at module load — the panel is worth having either way.
	void (async () => {
		try {
			const health = await api.health();
			absCurrentDirectory = health.workDirAbsPath;
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
			const models = await importedModels();
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
		// Which session to land on is the server's decision — `--session` pins one, otherwise a new
		// one is created and the pane opens on the welcome state — so the page asks rather than
		// picking from the list. From there this is the same path as a click in the sidebar: a read,
		// a render, and a subscription.
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
