# 002 · 回调白名单答辩：动词清单与 LoopOptions 接口定稿

- 对象：票 002 草案 15 行（16 动词）逐项答辩 + `CompactOptions` 连带形状 + hooks 实现形状 + 保留项确认
- 依据：[research/001-touchpoint-inventory.md](001-touchpoint-inventory.md)（87 触点 / 67 行）＋ 2026-11-12 对
  `loop-manager.ts` / `hooks.ts` / `session/fanout.ts` / `session/model-choice.ts` / `session/tool-config.ts` /
  `tools/manager.ts` / `setting-manager.ts` / `agent.ts` 的逐一复核（下引行号同 001 报告口径）
- 结论概要：**定稿 19 动词 + `emit`**；草案 5+6 合并、`bagOf` 随之退出白名单；新增 `modelChoice` 与
  `appendMessage`；`CompactOptions` 改 pick 回调；hooks 拆三个显式回调；001 的全部触点（68 归档实例 +
  12 草案外行）都有归宿，无剩余。

## 1. 逐项答辩表

| 草案行 | 判决 | 理由（答辩） |
|---|---|---|
| 1 `contextMessages` | **保留**，签名收窄 | L291 是唯一触点，且只消费 `buildSessionContext(s).messages`——回调只答 loop 问的那一半：`(session) => readonly Message[]`。`SessionContext` 的 `thinkingLevel`/`model` 不进 loop。 |
| 2 `contextEntries` | **保留** | ×4（L527/850/881/911），形状无争议。 |
| 3 `modelCatalog` | **保留** | ×5（L279/515/667/806/932），settings 的最大消费面，一个动词。 |
| 4 `activeTools` | **保留并扩签名** | 吸收草案外 b（`declaredTools` ×3）：返回 `{ names, declared }`——活跃名单与同一派生查表所得的声明数组是一个语义操作（「这次请求的工具面」）。`ToolState.approvalOverride` 不进 loop：loop 的 prompt 审批走动词 `approvals`（L547），approvalOverride 在 loop 内无人消费。 |
| 5 `recordSelection` | **保留并扩收** | 一个语义操作：对比盘上基线（`recordedOnDisk`，L620）→ 需要时开全新袋（`bagOf`，L629）→ 三写（`setModel`/`setThinkingLevel`/`flushMeta`，L630-632）。拆开只会让 loop 知道「快照 vs 袋」的实现细节。签名 `(session, catalog, choice)`——catalog 是请求局部事实（loop 刚用它 `modelFor`），传入省一次设置读。 |
| 6 `recordedOnDisk` | **并入 5，消失** | 唯一消费者是 recordSelection（L620）。 |
| 7 `setSuspended` | **保留** | L226，快照显示缓存的一次翻转，形状无争议。 |
| 8 账本追加 ×3 | **不设族回调，定稿 3 个具名动词** | 族回调（`(kind, payload)`）把账本条目格式知识推进 loop，还丢掉每条追加自己的参数类型。追加的**种类**是概念归类，不是接口形状——Agent 实现里它们同为 `sessionManager` 转发即可。 |
| 9 `bashSettings` | **保留** | L602。 |
| 10 `retrySettings` | **保留，不与 9 合并** | 消费时机不同：bash 在 run 起点（`runContext`），retry 在首次失败（`pumpAttempts`）。合并迫使每次运行预先读 retry——大多数运行从不重试。 |
| 11 `executeTool` | **保留，定签名** | 镜像 `ToolManager.execute`（L1693 唯一生产触点）：`(name, toolCallId, params, run, signal?, onUpdate?) => Promise<ToolResult>`。ADR-0016 不动：Agent 侧实现就是 `this.tools.execute(...)` 转发，`Tool.execute` 的生产唯一入口仍是表。解析与调度留在 loop：`activeTool` 的 `manager.get`（L1196/1547）改为对 `activeTools` 给出的 `declared` 按名查——同一派生、同为表实例（表只增，实例同一），且让「模型被告知什么与它可以运行什么」的不变量更硬（调用只能解析到本请求声明过的工具）。 |
| 12 `rewriteContext` | **保留** | `hooks.apply("context")` 的动词化，L552。 |
| 13 `decideBeforeTool` / `decideAfterTool` | **保留（两个动词）** | `toolCallHooks` 包装方法（L450-458）消失：这两条回调**就是**运行自己的那对闸门，链上传递的形状从 `ToolCallHooks` 换成这两个回调成员。闸门本体（`beforeTool`/`afterTool` 的裁决归一化）留在 loop——suspend 结束运行的控制流是引擎机械。 |
| 14 `publish` | **保留** | publishState ×4（L235/729/737/756）。`servicesOf` 组装点随实现挪进 Agent 的闭包，`fanout.ts` 不动。 |
| 15 `approvals` | **保留，不与 14 合并** | 反驳 `publishView` 合并案：publish 是窗口契约的**发布**（全量快照广播），approvals 是 prompt 与闸门的**读取**（L547）——消费者、时机、返回形状都不同。它们共享 fanout 推导是实现细节，不进签名。 |

### 新增动词（001 草案外形状）

| 动词 | 来源 | 签名 | 理由 |
|---|---|---|---|
| `modelChoice` | 草案外 a | `(session, chosen?: ModelChoice) => ModelChoice` | modelChoiceOf ×3（L278/516/931）。「这个会话在哪个模型上」是派生答案（ADR-0019），与 3/5 同属选择派生族；`chosen` 是运行局部的 `live.openedOn`，由 loop 传入。 |
| `appendMessage` | 草案外 e | `(state, session, message) => void` | drainTranscribed → appendMessageEntry 链 ×3（L413/420/1003）。签名带 `state`：fanout 组装点要清 `live.unwritten` 并发 `entry_appended`——活半的读者在 state 上，这是 fanout 两个组装点（与 `publish` 同理）把 state 递回的形状。 |

`systemPrompt`（草案外 d）与 `api`（草案外 c）**不新增动词**：二者已是「loop 只认函数」的既有形状，
答案归保留项确认（§3 Q4）。

## 2. 覆盖率复核

001 报告的归档 68 实例 + 草案外 12 行，对定稿逐一着落：

- 草案内 56 实例 → §1 各行（其中动词 11 的传参链行改为 `declared` 按名查，不再经 manager）；
- a → `modelChoice`；b → `activeTools` 扩签名；c → `api` 保留；d → `systemPrompt` 保留；
  e → `appendMessage`；f（servicesOf 组装机制行）→ 随 `publish`/`approvals` 的 Agent 侧实现消失；
- `bagOf`（L629）与 `recordedOnDisk`（L620）→ 并入 `recordSelection`。

**合计 100% 着落，无剩余触点。**

## 3. 四个子问题的回答

**Q1（合/拆/改名/定签名）**：合并一处（5+6，连带 `bagOf` 退出）、扩展一处（4 吸收声明面）、
新增两个（`modelChoice`、`appendMessage`）、否决两个合并案（8 的族回调、14+15 的 `publishView`）。
其余按草案定名定签名。定稿动词数 16 → **19**。

**Q2（CompactOptions）**：Pick 链上不再有 Manager 字段，pick 的正是压缩阶梯要的回调与值：

```ts
export interface CompactOptions
	extends Pick<
		LoopOptions,
		| "state"
		| "bag"
		| "modelCatalog"
		| "modelChoice"
		| "contextEntries"
		| "appendCompaction"
		| "appendTrimToolCallArgs"
		| "appendClearToolResults"
	> {
	entries: readonly SessionEntry[];
	now: number;
	signal?: AbortSignal;
	transport?: ChatTransport;
}
```

不取整袋（`Omit<LoopOptions, "start">`）：压缩不需要执行链与 hooks 三动词，让 `compact` 的调用方
（编排层 `maybeCompact`、smoke）少递一堆用不上的回调，Pick 链本身就是压缩阶梯的依赖清单。

**Q3（hooks 在 Agent 侧的形状）**：**拆成三个显式回调成员**（`rewriteContext` / `decideBeforeTool` /
`decideAfterTool`），不保留 `apply` 门面在袋上。`Hooks` 服务本身留在 Agent 侧原样（进程级配置，
ADR-0007 §6），`apply` 门面不变；三个回调的 Agent 侧实现就是 `this.hooks.apply(name, event)` 的一行转发。
loop 侧的事件/答案类型在 `loop-manager.ts` **结构定义**（守卫将禁 import hooks 所在模块；
`ToolResultContent` 用与 hooks.ts 相同的一行别名 `ToolResult<unknown>["content"]` 重定义）。
形状同步点在 `agent.ts` 的接线处：`decideBeforeTool: (event) => this.hooks.apply("before_tool", event)`
——结构不合编译即失败，不需要额外守卫。

**Q4（保留项确认）**：`state` / `bag` / `start` / `api` / `emit` / `systemPrompt` **原样不动**。
唯一修正：**`bagOf` 退出白名单**——它唯一的运行触点就是 recordSelection 内的开袋（L629），
动词 5 收编后 loop 不再有任何自开袋路径。白名单从「定有两项」变为「一条 sink（`emit`）+ 19 动词」。

## 4. 定稿 LoopOptions 接口

```ts
/** 一次请求的工具面：活跃名单与同一派生查表所得的声明数组，一个回调、一次派生。 */
export interface ActiveTools {
	/** 本次请求活跃的名字：整条链成员判断的唯一依据。 */
	names: readonly string[];
	/** 同一派生按名字查表的声明数组：元素是表自己的实例（ADR-0016）。 */
	declared: readonly Tool<any>[];
}

/** hooks 三动词的事件与答案：结构定义在本文件，与 HookMap 的同步点在 agent.ts 的接线处。 */
export interface ContextInjection {
	sessionId: string;
	messages: Message[];
	systemPrompt: string;
}
export interface ContextRewrite {
	messages?: Message[];
	systemPrompt?: string;
}
export interface BeforeToolEvent {
	sessionId: string;
	toolCallId: string;
	toolName: string;
	args: unknown;
}
export interface BeforeToolDecision {
	block?: { reason: string };
	args?: unknown;
	terminate?: boolean;
	suspend?: boolean;
}
export interface AfterToolEvent {
	sessionId: string;
	toolCallId: string;
	toolName: string;
	content: ToolResultContent;
	isError: boolean;
}
export interface AfterToolDecision {
	content?: ToolResultContent;
}

/**
 * 一次运行调用的唯一参数袋：三件每次调用的值、两件既有形状（api / systemPrompt）、
 * 白名单 sink（emit）与回调面（19 动词）。越过边界的全部在这个类型上一次性可见，
 * 三只 Manager 与 hooks 对 loop 完全不可见（ADR-0023）。
 */
export interface LoopOptions {
	// —— 三件每次调用的值（保留项）——
	/** 这次运行写瞬态的对象：两条队列、在飞运行、partial、重试与挂起位（ADR-0019 的 live 半）。 */
	state: AgentState;
	/** 运行袋：开跑时重放一次盘得到的 transcript，整条运行只带这一只（ADR-0019）。 */
	bag: Session;
	/** 运行起点：打开它的那条消息，或恢复用来关闭悬空调用的答案。 */
	start: RunStart;

	// —— 既有形状（保留项）——
	/** 每个请求真正离开的地方：传输层，重试策略包上它之前的那个。 */
	api: ChatTransport;
	/** prompt builder：活跃工具集与审批映射点名的东西会中途变化，所以是函数不是字符串。 */
	systemPrompt: (
		workDirAbsPath: string,
		agentsMd: readonly AgentsMdFile[],
		toolNames: readonly string[],
		approvals: Record<string, boolean>,
	) => string;
	/** 白名单 sink：事件去向（落盘、清队列、投影的组合政策，实现是 `Agent.dispatchEvent`）。 */
	emit: (state: AgentState, session: Session, event: AgentEvent) => Promise<void> | void;

	// —— 回调面 · 读（8）——
	/** 运行打开时对着的那份消息（`buildSessionContext` 的 messages 半）。 */
	contextMessages: (session: Session) => readonly Message[];
	/** 账本重放出的 entry 视图：填充链与压缩阶梯共用的答案。 */
	contextEntries: (session: Session) => readonly SessionEntry[];
	/** 本构建认识的模型行。 */
	modelCatalog: () => readonly ModelConfig[];
	/** 这个会话现在在哪个模型上（`chosen` = 运行局部的 `live.openedOn`）。 */
	modelChoice: (session: Session, chosen?: ModelChoice) => ModelChoice;
	/** 本次请求活跃的工具名单与同一派生的声明数组。 */
	activeTools: (session: Session) => ActiveTools;
	/** 生效中的审批映射：闸门默认处理器、快照与 prompt 三者共同的唯一读取点。 */
	approvals: (session: Session) => Record<string, boolean>;
	/** bash 工具允许一条命令运行多久（实时读）。 */
	bashSettings: (workDirAbsPath: string) => BashSettings;
	/** 供应商调用的重试策略（实时读）。 */
	retrySettings: (workDirAbsPath: string) => RetrySettings;

	// —— 回调面 · 写（6）——
	/** 把本次请求所用的选择写进会话：对比盘上基线，需要时在 Agent 的表上开新袋补写。 */
	recordSelection: (session: Session, catalog: readonly ModelConfig[], choice: ModelChoice) => void;
	/** 快照显示缓存的挂起标志翻转。 */
	setSuspended: (session: Session, suspended: boolean) => void;
	/** 追加一条消息条目并宣布（fanout 组装点：清 `live.unwritten`、发 `entry_appended`）。 */
	appendMessage: (state: AgentState, session: Session, message: Message) => void;
	/** 账本追加：压缩摘要。 */
	appendCompaction: (
		session: Session,
		summary: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		usage?: Usage,
	) => string;
	/** 账本追加：截短重型工具被记录的参数。 */
	appendTrimToolCallArgs: (session: Session, trimmedEntryIds: readonly string[], tokensBefore: number) => string;
	/** 账本追加：清掉缓存大概已过期的工具结果。 */
	appendClearToolResults: (session: Session, clearedEntryIds: readonly string[], tokensBefore: number) => string;

	// —— 回调面 · 执行（1）——
	/** 运行一次工具调用：查工具并转发（`ToolManager.execute` 的动词化，ADR-0016 不动）。 */
	executeTool: (
		name: string,
		toolCallId: string,
		params: unknown,
		run: ToolRunContext,
		signal?: AbortSignal,
		onUpdate?: ToolUpdateCallback<any>,
	) => Promise<ToolResult<any>>;

	// —— 回调面 · 接缝（3，hooks 三动词）——
	/** 改写给供应商的内容。 */
	rewriteContext: (injected: ContextInjection) => Promise<ContextRewrite>;
	/** 在工具调用之前裁决：阻止、精修参数、终止或挂起（审批闸门）。 */
	decideBeforeTool: (event: BeforeToolEvent) => Promise<BeforeToolDecision>;
	/** 在工具结果上裁决：改写即定稿。 */
	decideAfterTool: (event: AfterToolEvent) => Promise<AfterToolDecision>;

	// —— 回调面 · 窗口（1）——
	/** 全量快照广播（fanout 组装点，`publishState` 的动词化）。 */
	publish: (state: AgentState, session: Session) => void;
}
```

### Agent 侧实现对照（票 004 落地的现成件清单）

全部住在 `Agent.loopOptions()` 的闭包里，`servicesOf` 与 `toolCallHooks` 随之消失：

| 动词 | Agent 侧实现 |
|---|---|
| contextMessages | `this.sessionManager.buildSessionContext(s).messages` |
| contextEntries | `this.sessionManager.buildContextEntries(s)` |
| modelCatalog | `this.settingsManager.modelCatalog()` |
| modelChoice | `modelChoiceOf(this.sessionManager, s, this.settingsManager, chosen)` |
| activeTools | `toolStateOf(this.sessionManager, s, this.settingsManager, this.tools.names())` → `{ names, declared: names→this.tools.get(n) 过滤 undefined }` |
| approvals | `approvalsOf({ sessionManager, settings, tools }, s)`（三件现凑挪进闭包） |
| bashSettings / retrySettings | `this.settingsManager.getBashSettings(...)` / `getRetrySettings(...)` |
| recordSelection | `recordedOnDisk` 对比 + `this.bag(s.sessionId)` + `setModel`/`setThinkingLevel`/`flushMeta`（`rowFor`/`normalizeThinkingLevel` 随行移址） |
| setSuspended | `this.sessionManager.setSuspended(s, flag)` |
| appendMessage | `appendMessageEntry(state, s, this.sessionManager, m)`（fanout 不动） |
| appendCompaction / appendTrimToolCallArgs / appendClearToolResults | `this.sessionManager` 同名转发 |
| executeTool | `this.tools.execute(name, toolCallId, params, run, signal, onUpdate)` |
| rewriteContext / decideBeforeTool / decideAfterTool | `this.hooks.apply("context" / "before_tool" / "after_tool", event)` |
| publish | `publishState(state, s, { sessionManager, settings, tools })`（组装点挪进闭包） |
| emit / api / systemPrompt / state / bag / start | 原样不动 |

## 5. 连带影响与移交项

- **类型驻地（移交票 005 守卫口径 + 票 004 落地）**：`Session` / `SessionEntry` 现与 `SessionManager`
  同模块（session-manager.ts）；`ToolRunContext` / `ToolUpdateCallback` 现经 tools/index.ts；
  `BashSettings` / `RetrySettings` 在 config.ts（无需动）。守卫「禁 import 三只 Manager 与 hooks 所在
  模块」需要决定口径：按模块禁就要先给值类型安新家，或按 Manager 类型标识符禁。
- **`ToolState` 收窄**：loop 消费面只剩 `{ activeToolNames }` + 声明数组；`approvalOverride` 仍被
  `approvalsOf`（Agent 侧）消费，`tool-config.ts` 不动。
- **恢复机器**：`recoverPendingToolCalls` / `danglingToolCallsOf` 导出保持（ADR-0006 §5、
  smoke-approval-recovery 直驱）；签名从 `manager + hooks` 改为 `declared + executeTool + 两闸门回调`，
  形状变化、语义只搬不改。
- **随实现消失的件**：`servicesOf`（L155-157）、`toolCallHooks`（L450-458）、`declaredTools` 私有方法
  （L583-590，Agent 侧重写）、`activeTool` 的表解析半（名单半保留为 `declared` 查找）。
- **loop-manager.ts 的 import 面收窄**：不再 import session-manager.ts / setting-manager.ts /
  tools/manager.ts / hooks.ts 的任何东西；`models.ts` 的 `rowFor` / `normalizeThinkingLevel` 随
  recordSelection 移址 agent.ts，loop 留 `modelFor` / `unconfiguredStream`；fanout 文件级函数照旧。
