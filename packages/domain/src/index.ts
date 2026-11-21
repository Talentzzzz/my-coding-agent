export { Agent, type AgentConfig, type AgentSessionEvent, type MessageDelta, type SessionEventListener, type SessionListener, type SessionSink } from "./agent/agent.ts";
// 恢复机器随 ADR-0016 住进 `agent.ts`；re-export 源直指它，包对外的名字不变。
export { danglingToolCallsOf, recoverPendingToolCalls } from "./agent/agent.ts";
export type { AgentEvent } from "./agent/types.ts";
export type { Message } from "./agent/types.ts";
// core 之外的调用方仍会直接点名的传输层出口：server 持有 `ChatTransport`，
// smoke 则像引擎那样驱动流和模型。消息与工具词汇自分层重构步 4 起定义在共享内核
// （agent/types.ts，§2.3）；传输机械仍住 llm。
export {
	anthropicMessages,
	createAssistantMessageEventStream,
	getSystemMessageText,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type ChatTransport,
	type Context,
	type SimpleStreamOptions,
} from "./agent/llm/index.ts";
export {
	type ImageContent,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolExecutionMode,
	type ToolResult,
	type ToolResultMessage,
	type ToolUpdateCallback,
	type Usage,
} from "./agent/types.ts";
// 设置的形状与默认值已随原 `config.ts` 并入 `types.ts`（原独立文件，曾短暂住过 agent.ts），
// 包对外的名字不变。原 `protocol.ts` 已随分层重构步 2 解散：它的域词汇各归属主（行与快照归
// session、模型选择归 llm、diff 归 tool、设置快照与审批政策归根 `types.ts`），wire 信封住
// `@my-agent/case/protocol` 的网关——包对外的名字不变，只有信封七个名字改从 case 拿。
export {
	AGENT_HOME,
	APP_NAME,
	APPROVAL_TOOLS,
	DEFAULT_MODE_NAME,
	DEFAULT_BASH_SETTINGS,
	DEFAULT_GLOBAL_SETTINGS,
	settingsPath,
	stringListOrUndefined,
	type ConfigPatch,
	type GlobalSettings,
	type GlobalSettingsSnapshot,
	type QueueMode,
	type RetrySettings,
	type SettingsPatch,
} from "./agent/types.ts";
// RetrySettings 已随 retry 簇迁入 types.ts、所有权归 ModelManager（ADR-0028 修正），
// `EngineSettings` 随 engine.json 退场，包对外的类型名不变。
// UI 簇已迁往客户端存储（ADR-0029）：UiSettingsManager、UI 类型与规范化器随簇退场。
export { ModelManager, type ModelManagerOptions } from "./agent/llm/model-manager.ts";
// 压缩与填充的算法半自分层重构步 4 起住 context 包的 ContextManager（§3）：公开脸是 manager.ts，
// 六个实现文件是里子。模块级函数与类型保留既有出口——smoke 的演练缝不经 ContextManager 实例。
// `prepareCompaction` 与 `spillOversizedToolResult` / `spillPathFor` 等是包内原语，供编排层外的
// 演练直接驱动；`buildSystemPrompt` / `loadAgentsMd` 已降为包内（由 `buildRequestPrompt` 组合）。
export { ContextManager } from "./agent/context/manager.ts";
export {
	compact,
	compactionThresholdFor,
	estimateTokens,
	shouldCompact,
} from "./agent/context/compaction.ts";
export { type CompactionPreparation, type CompactionResult, type Summarize, type SummarizeRequest } from "./agent/context/types.ts";
export {
	ARG_KEEP_CHARS,
	ARG_TRIM_MARKER,
	clearToolResult,
	trimToolCallArgs,
} from "./agent/session/view.ts";
export {
	ARG_TRIM_THRESHOLD_CHARS,
	ARG_TRIM_TOOLS,
	clearedToolResultText,
	describeToolCall,
} from "./agent/types.ts";
export { trimmableToolArgEntryIds } from "./agent/context/trim-tool-call-args.ts";
export {
	clearableToolResultIds,
	isCacheProbablyExpired,
	isClearedToolResult,
	REFETCHABLE_TOOLS,
} from "./agent/context/clear-tool-results.ts";
export {
	archiveToolResult,
	spillOversizedToolResult,
	spillPathFor,
	SPILL_KEEP_CHARS,
	SPILL_RESULT_CHARS,
} from "./agent/context/spill.ts";
export {
	boundToolContent,
	createHooks,
	MAX_TOOL_RESULT_BYTES,
	type HookEvent,
	type HookMap,
	type HookName,
	type HookResult,
	type Hooks,
} from "./agent/hooks.ts";
export type { ToolResultContent } from "./agent/types.ts";
export {
	coerceModelConfig,
	isUnconfigured,
	listModelOptions,
	createModel,
	modelFor,
	rowFor,
	DEFAULT_MODEL_NAME,
	modelsPath,
	NEW_MODEL_DEFAULTS,
	normalizeThinkingLevel,
	Model,
	placeholderModel,
	unconfiguredStream,
	type ModelChoice,
	type ModelConfig,
	type ModelInput,
	type ModelOption,
	type ModelSelection,
	type ThinkingLevel,
} from "./agent/llm/model-manager.ts";
export {
	createSessionAgent,
	openAgent,
	type CreateSessionAgentOptions,
} from "./agent/session-factory.ts";
export {
	readSessionSnapshot,
	type OpenAgentOptions,
} from "./agent/agent.ts";
export {
	addUsage,
	EMPTY_USAGE,
	type PendingApproval,
	type SessionSnapshot,
	type UsageTotals,
} from "./agent/session/snapshot.ts";
export {
	type PromptBehavior,
	type QueuedPrompt,
} from "./agent/session/queues.ts";
export {
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	compactionSummaryOf,
} from "./agent/session/messages.ts";
export {
	normalizePath,
	resolvePath,
	sessionMetaPath,
	sessionPath,
	sessionsDir,
	setSessionsDir,
} from "./agent/session/paths.ts";
export {
	BRANCH_LABEL_MAX,
	CURRENT_SESSION_VERSION,
	SessionManager,
	createSession,
	deriveTitle,
	fillSession,
	groupSessionsByDirectory,
	inMemorySession,
	newSession,
	persistEntry,
	sessionEntryToContextMessages,
	setRemoveGate,
	shortenTitle,
	toSessionRef,
	type CompactionEntry,
	type TrimToolCallArgEntry,
	type BranchOption,
	type BranchPoint,
	type ClearToolResultEntry,
	type DirectoryGroup,
	type SessionContext,
	type SessionEntry,
	type SessionEntryBase,
	type SessionEntryMapById,
	type SessionMeta,
	type SessionInfo,
	type SessionDefaults,
	type SessionManagerOptions,
	type Session,
	type SessionSettings,
	type SessionRef,
	type SessionRow,
	type SessionRowPatch,
	type MessageEntry,
	type LeafEntry,
	type UsageEntry,
	type DirectorySessions,
} from "./agent/session/session-manager.ts";
export { UnknownSessionError } from "./agent/session/unknown-session.ts";
export { createAgentState, createLive, type ActiveRun, type AgentState, type Live } from "./agent/session/agent-state.ts";
export { recordedSelectionOf } from "./agent/session/session-manager.ts";
export {
	approvalToolsOf,
	defaultToolNames,
	resolveSettings,
	selectModelRow,
	type Settings,
} from "./agent/settings.ts";
export {
	type BashSettings,
	createToolManager,
	type ModeSettings,
	fillTools,
	narrowToKnown,
	ToolManager,
	type ToolDefaults,
	type ToolDefaultsPatch,
	type ToolManagerOptions,
	type ToolRunContext,
	type ToolState,
} from "./agent/tool/index.ts";
export {
	DIFF_CONTEXT,
	DIFF_MAX_ROWS,
	DIFF_TEXT_MAX_ROWS,
	diffText,
	fileDiff,
	type DiffLine,
	type DiffOptions,
	type FileDiff,
} from "./agent/tool/diff.ts";
export { defaultLauncher, type Launcher } from "./agent/tool/shell.ts";

// `prepareCompaction` 的算法半收显式的投影函数参数（分层重构 §3——context 对 session 零 import）。
// 这里的既有出口按单参形状保留：根可以直取 session 包，所以在出口上绑定编排层递给算法的同一投影，
// 演练缝（smoke-tools）的调用形状不变。
import { prepareCompaction as prepareCompactionInContext } from "./agent/context/compaction.ts";
import { sessionEntryToContextMessages } from "./agent/session/session-manager.ts";
import type { CompactionPreparation } from "./agent/context/types.ts";
import type { SessionEntry } from "./agent/session/session-manager.ts";
export function prepareCompaction(contextEntries: readonly SessionEntry[]): CompactionPreparation | undefined {
	return prepareCompactionInContext(contextEntries, sessionEntryToContextMessages);
}
