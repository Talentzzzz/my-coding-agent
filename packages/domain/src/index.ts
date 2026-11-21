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
// `AGENT_HOME` / `APP_NAME` / `settingsPath` / `modelsPath` 已随步 5 端口化迁出 domain
// （§2.3）：home 的解析住组合根（@my-agent/app），文件名的 join 住 infra 的实现——domain
// 从此不知道「真实的 home」。
export {
	APPROVAL_TOOLS,
	DEFAULT_MODE_NAME,
	DEFAULT_BASH_SETTINGS,
	DEFAULT_GLOBAL_SETTINGS,
	normalizePath,
	resolvePath,
	stringListOrUndefined,
	type ConfigPatch,
	type GlobalSettings,
	type GlobalSettingsSnapshot,
	type QueueMode,
	type RetrySettings,
	type SettingsPatch,
} from "./agent/types.ts";
// 端口声明（分层重构 spec §4）：domain 对存储只认自己声明的端口，infra 实现、组合根注入。
export { UnknownSessionError, type SessionLedgerFile, type SessionRepository } from "./agent/session/session-repository.ts";
export type { SessionDefaultsRepository } from "./agent/session/session-defaults-repository.ts";
export type { ModelRepository } from "./agent/llm/model-repository.ts";
export type { ToolDefaultsRepository } from "./agent/tool/tool-defaults-repository.ts";
export type { ToolResultsRepository } from "./agent/session/tool-results-repository.ts";
// RetrySettings 已随 retry 簇迁入 types.ts、所有权归 ModelManager（ADR-0028 修正），
// `EngineSettings` 随 engine.json 退场，包对外的类型名不变。
// UI 簇已迁往客户端存储（ADR-0029）：UiSettingsManager、UI 类型与规范化器随簇退场。
export { ModelManager, type ModelManagerOptions } from "./agent/llm/model-manager.ts";
// 压缩的算法半自 2026-11-21 起并入 session 包（ADR-0031）：编排层直调模块级函数，没有 ContextManager
// 实例。`prepareCompaction` 与 `spillOversizedToolResult` / `spillPathFor` 等是包内原语，供编排层外
// 的演练直接驱动；`buildRequestPrompt` 与 system prompt 拼装住 `@my-agent/prompt`（叶子库，ADR-0031）
// ——项目指示收集的端口在那里声明，经这里向 case 转出口。
export { type AgentsMdRepository } from "@my-agent/prompt";
export {
	compact,
	compactionThresholdFor,
	estimateTokens,
	shouldCompact,
} from "./agent/session/compaction.ts";
export { type CompactionPreparation, type CompactionResult, type Summarize, type SummarizeRequest } from "./agent/session/types.ts";
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
export { trimmableToolArgEntryIds } from "./agent/session/trim-tool-call-args.ts";
export {
	clearableToolResultIds,
	isCacheProbablyExpired,
	isClearedToolResult,
	REFETCHABLE_TOOLS,
} from "./agent/session/clear-tool-results.ts";
export {
	archiveToolResult,
	spillOversizedToolResult,
	spillPathFor,
	SPILL_KEEP_CHARS,
	SPILL_RESULT_CHARS,
} from "./agent/session/spill.ts";
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
} from "./agent/snapshot.ts";
export {
	type PromptBehavior,
	type QueuedPrompt,
} from "./agent/queues.ts";
export {
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	compactionSummaryOf,
} from "./agent/session/session.ts";
// 路径语义自 paths.ts 迁入根 types.ts（§2.3）；`sessionPath` / `sessionMetaPath` /
// `sessionJsonlPath` 迁 infra 的 session-store（文件对命名规则是存储布局知识），`sessionsDir` /
// `setSessionsDir` 随端口注入消亡。
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
	type SessionRef,
	type SessionRow,
	type SessionRowPatch,
	type MessageEntry,
	type LeafEntry,
	type UsageEntry,
	type DirectorySessions,
} from "./agent/session/session-manager.ts";
export { createAgentState, createLive, type ActiveRun, type AgentState, type Live } from "./agent/agent-state.ts";
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

// `prepareCompaction` 的投影缝（分层重构 §3——context 对 session 零 import）随合并消失（ADR-0031）：
// 算法半在 session 包内直取 `sessionEntryToContextMessages`，出口按单参形状直出，演练缝
// （smoke-tools）的调用形状不变。
export { prepareCompaction } from "./agent/session/compaction.ts";
