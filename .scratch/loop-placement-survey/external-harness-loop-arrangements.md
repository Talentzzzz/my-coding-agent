# 外部 harness 的 agent loop 组织方式调研

> 调研日期：2026-11-20。方法：直接阅读各仓库 main/dev 分支源码（raw.githubusercontent.com + GitHub API），关键文件已缓存于 `.scratch/loop-placement-survey/src-cache/`。所有断言均落到具体文件与行号；未能确认之处如实标注。
>
> 注意：本领域变动极快。调研期间发现多个仓库刚经历大重构：sst/opencode 已迁移至 anomalyco/opencode 且全面 Effect 服务化；OpenHands 主仓已转型 TS 的 "Agent Canvas"，Python agent 移入 OpenHands/software-agent-sdk；Goose 已迁至 aaif-goose/goose 并把 loop 引擎抽成 oi-kit-agent crate；Cline 拆成 apps/sdk monorepo，旧 src/core/task/index.ts 已不存在；badlogic/pi-mono 已迁至 earendil-works/pi；openai/codex 的 codex.rs 也已拆散。以下报告均以当前 HEAD 为准。

## 形态分类口径（沿用任务约定）

- **(a) 并入编排/会话类**：loop 是 Coder/Session/Conversation 等大类的方法，依赖直接字段访问。
- **(b) 独立对象/模块 + 依赖注入**：loop 独立成对象或模块，依赖经构造参数/回调/接口注入。
- **(c) 独立对象但直接持有共享状态**：loop 独立，但直接读写共享状态对象的字段。
- **(d) 纯函数/生成器循环**：loop 是函数，状态是函数局部变量，依赖全部经参数传入。
- **(e) 外层控制器驱动 step()**：循环在控制器，步进在 agent 对象。

## 一段话总结

十个样本呈明显的两极分布，且「独立 loop 模块 + 注入」这一侧占多数：**pi**（纯函数 loop，参数注入）、**Goose**（独立 engine crate + trait 注入）、**opencode**（独立 SessionRunner/SessionStep 服务 + Effect 依赖注入 + 回调 Input）、**Cline 新 SDK**（独立 AgentRuntime 类 + config/hooks 注入）是清晰的 (b)/(d) 形态；**Gemini CLI** 是分层变体——core 里每轮一个 Turn 对象（构造注入 chat），而「轮与轮之间」的循环被推到宿主应用层（nonInteractiveCli.ts 的 while(true)）；**Codex** 是介于两者之间的形态：loop 是自由函数（run_turn/run_turns），但依赖直接取自共享的 `Arc<Session>.services` 注册表，偏 (c)；**Aider**、**OpenHands SDK**、**SWE-agent** 是 (a)/(e) 形态——loop 是编排大类（Coder、LocalConversation、DefaultAgent）的方法或由它自驱 step()，依赖直接字段访问。值得注意的倾向：较新的/近期重构的代码库（opencode、Cline SDK、Goose、pi）全部选择了「独立 loop + 注入」，而较老的代码库（Aider、SWE-agent、OpenHands 的血脉）保留「并入编排类」；唯一接近我们 ADR-0016 立场的公开判据来自 Goose 的注释（loop 引擎不含 harness 语义）和 Cline 架构文档（"agents stays focused on the stateless loop"），但它们的 loop 之所以能独立，是因为它们把大量上下文准备/权限/生命周期职责留在了 harness 层，loop 只消费已准备好的输入——这与 ADR-0016 的判据（loop 即编排）并不直接冲突，详见第六节。

---

## 逐项目小节

### 1. opencode（anomalyco/opencode，TypeScript，Effect-TS）

- **loop 位置**：
  - 外层循环（跨 step，含 inbox/compaction/reload 处理）：`packages/core/src/session/runner/llm.ts` 的 `SessionRunner.drain`（`const drain = Effect.fn("SessionRunner.drain")`，L63 起；主 `while (true)` 在 L216）。
  - step 级循环（一次 step 内的 retry/compaction 重入）：同文件 `runStep`（L237，内部 `while (true)` L249）。
  - 单步执行（流式请求 + 并发工具 + 结算）：`packages/core/src/session/runner/step.ts` 的 `SessionStep.attempt`（L77；`make` 工厂 L71）。
- **形态**：(b) 独立模块。`runner/index.ts` 只声明 `SessionRunner.Interface`（单一方法 `drain`，L31-44），实现以 Effect Layer 注册为服务 `"@opencode/SessionRunner"`（llm.ts L43-44）。
- **依赖获取**：Effect Context 依赖注入——`const bus = yield* Bus.Service; const llm = yield* LLMClient.Service; ...`（llm.ts L46-58）；单步 `attempt` 另外接受一个显式 `Input` 记录，含回调字段 `interruption`、`retry`、`recoverOverflow` 与 `prepared.executeTool`（step.ts L43-64）。代码自注：`/** Captures Location-scoped dependencies without introducing another service or execution loop. */`（step.ts L70）。
- **状态归属**：全是函数局部变量——`step`、`continuing`、`force`、`assistantMessageID`、`toolRuns` 等都在 drain/runStep/attempt 闭包内；持久状态在数据库/Store，不挂在 loop 对象上（loop 根本不是类）。
- **评价**：这是本次调研中分层最激进的样本：生命周期（execution.ts 的 run-coordinator、claim/settlement）与 loop（SessionRunner）彻底分离，接口面被压到单方法 `drain`。代价是 Effect 框架的重度心智负担与多层间接。loop 的「回调袋」确实存在（Input 里 3-4 个回调），但被限定为「生命周期查询/决策」类窄回调。

### 2. Gemini CLI（google-gemini/gemini-cli，TypeScript）

- **loop 位置**：
  - 每轮流式处理：`packages/core/src/core/turn.ts` 的 `Turn` 类（文件自注 `// A turn manages the agentic loop turn within the server context.`），`async *run(...)` 是一个 async generator，把流切成 Content/Thought/ToolCallRequest/Finished 等事件。
  - 跨轮循环（模型调用→工具执行→结果回填→再调用）在**宿主应用层**：`packages/cli/src/nonInteractiveCli.ts` 的 `while (true)`（L358），循环内 `geminiClient.sendMessageStream`（L368）→ 收集 `ToolCallRequest` 事件（L401-411）→ `scheduler.schedule(...)`（L559）→ 把工具结果拼成下一条消息。交互模式对应 React hook `useGeminiStream`（同一职责的 UI 版）。
- **形态**：分层形态——core 提供每轮一个的 Turn 对象 + 事件流，循环本身在应用层。归类为 (b)（Turn 是注入式独立对象）+ 宿主驱动，接近「循环在控制器、步进在 core」的组合。
- **依赖获取**：`Turn` 构造参数注入 `chat: GeminiChat` 与 `prompt_id`；工具注册表经 `this.chat.loopContext.toolRegistry` 访问（turn.ts `handlePendingFunctionCall`）；工具执行由独立的 `CoreToolScheduler` 对象承担，由应用层构造并传入。
- **状态归属**：Turn 的瞬态（`pendingToolCalls`、`debugResponses`、`pendingCitations`、`finishReason`）都是 Turn 实例字段，每轮新建（`new Turn(this.getChat(), prompt_id)`）；跨轮历史在 GeminiChat。
- **评价**：Turn 被明确设计为「一次性的、按轮抛置的对象」，其价值在于把流式响应解析成类型化事件流；把「是否继续下一轮」的决策权留给宿主，使 CLI/TUI/IDE 多宿主可复用同一 core。Turn 自身不持有审批闸门——确认逻辑在 scheduler/宿主侧。

### 3. Codex CLI（openai/codex，Rust）

- **loop 位置**：
  - 任务级循环：`codex-rs/core/src/tasks/regular.rs`，`RegularTask::run`（L53）→ `run_turns`（L140），内部 `loop { Box::pin(run_turn(...)) }`（L154-156），按 pending input 决定是否继续。
  - 轮内循环（模型→工具→steer→再模型）：`codex-rs/core/src/session/turn.rs` 的自由函数 `run_turn(sess: Arc<Session>, turn_context: Arc<TurnContext>, ...)`（L227；文件约 4050 行），内部 `loop`（L573）驱动 `run_sampling_request` 与工具回填。
- **形态**：(c) 混合——loop 不是方法而是自由函数（接近纯函数形态），但依赖直接取自共享状态对象：`sess.services.model_client`、`sess.services.thread_extension_data`、`sess.clone_history()` 等（turn.rs L253-267 等）。
- **依赖获取**：`Arc<Session>` 上挂一个 services 注册表（`sess.services.*`），加上每轮的 `Arc<TurnContext>`（配置/模型快照）。没有回调袋；审批/权限走 Session 侧的审批通道。
- **状态归属**：轮内瞬态（`client_session`、`AssistantMessages`、`unfinished_plan_id`、`turn_diff_tracker`）是 run_turn 函数局部变量；跨轮状态（历史、任务队列）在 Session。
- **评价**：run_turn 所在文件达 4050 行，是全部样本里单文件最大的；Loop 语义（steer、compaction、hook 时机）深度耦合 Session 的服务面。Rust 侧没有独立的 loop 对象，但「loop=函数 + 共享状态」意味着它同样无法脱离 Session 单测——与我们的处境高度相似。

### 4. OpenHands（OpenHands/software-agent-sdk，Python）

- **背景**：OpenHands 主仓（原 All-Hands-AI/OpenHands）已转型 TS 的 "Agent Canvas" 控制中心；经典 Python agent 循环血脉现居 `software-agent-sdk` 的 `openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py`。旧版 `AgentController`（controller.py 驱动 `agent.step()`）的职责已被并入 `LocalConversation`。
- **loop 位置**：`LocalConversation` 类（L251，文件约 3983 行）的 `run()`/`arun()`：`arun`（L2862）→ `_arun`（L2883）中 `while True:`（L2930）循环调用 `await self.agent.astep(self, ...)`（L3049、L3207）；同步版 `run` 调 `self.agent.step(self, on_event=..., on_token=...)`（L3824）。
- **形态**：(a)+(e)——大编排类自己持有循环并驱动 agent 的 step()。这正是任务简报中 OpenHands「外层控制器 + step」形态的现代表达，只是 controller 与 conversation 合体了。
- **依赖获取**：直接组合/字段访问——conversation 持有 `self.agent`、`self._state`（共享 ConversationState）、`self._on_event` 回调、hook processor 等。
- **状态归属**：运行瞬态在实例字段（`_arun_task`、`_cancel_token`，L2885-2886）与共享 `_state` 对象（execution_status、agent_state）；迭代计数 `iteration` 是函数局部变量。
- **评价**：这是「loop 即编排」的活样本：确认模式、stuck 检测、stop hook、ACP 消息插队、walk-back 全在循环体里，与状态机转换交织，无法从 conversation 拆出。它选择把 loop 留在编排类，理由和 ADR-0016 类似——循环体内引用的编排面太宽。

### 5. Aider（Aider-AI/aider，Python）

- **loop 位置**：`aider/coders/base_coder.py`，`Coder` 类（L88）的 `run()`（L876）内 `while True:`（L882）→ `run_one()`（L924）内 `while message:`（L932）：一问一答后经 `send_message`/`reply_completed` 链驱动模型与编辑工具。
- **形态**：(a) 并入编排类。BaseCoder/Coder 约 2500 行，是编排、UI 交互、git 操作、文件编辑确认的总汇。
- **依赖获取**：全部直接字段访问：`self.send_message`、`self.confirm_ask`、`self.io`、`self.repo` 等。
- **状态归属**：`self.num_reflections`、`self.edit_error_occurred` 等轮内瞬态在实例字段上重置（这区别于 run 局部变量——历史上这里出过未重置的 bug 类别）；消息历史 `self.abs_done` 等。
- **评价**：最老派的形态，loop 与编排高度纠缠；Aider 的单文件类规模（base_coder.py ~2500 行）与我们的 agent.ts（~3150 行）量级相同，可视为「并入编排类」路线的成熟稳态。

### 6. Cline（cline/cline，TypeScript）

- **背景**：旧的 `src/core/task/index.ts`（Task 类 + `recursivelyMakeClineRequests` 递归请求循环）已随仓库重构消失；新版把 agent 逻辑抽进 `sdk/` monorepo。
- **loop 位置**：`sdk/packages/agents/src/agent-runtime.ts` 的 `AgentRuntime` 类（L543，文件 2979 行），`run()`（L637）→ `execute()` 内 `for (;;)`（L1259）。
- **形态**：(b)+(c)——独立 loop 对象，依赖经 `AgentRuntimeConfig` 注入（model/streamFn、`toolExecution` 策略、`HookBag`：beforeRun/afterModel/beforeTool/afterTool/onEvent 等，L549-557），但运行状态直接挂在实例字段与 `state` 对象上（`messages`、`iteration`、`pendingToolCalls`、`overflowRecoveryAttempted` 等，L566-614）。
- **依赖获取**：构造参数注入 config + hooks 袋；工具经 `this.tools: Map<string, AgentTool>` 注册。
- **状态归属**：与 ADR 语境最相关的一句：Cline 的 loop 对象**自己持有跨轮状态**（恢复计数、消息列表都存在 runtime 上），这是它与 pi 的关键区别。官方架构文档明确把它描述为「stateless runtime loop」并给出分层规则：`@cline/agents` "Owns the stateless runtime loop: agent iteration loop"（sdk/ARCHITECTURE.md L104-106），以及 "`agents` stays focused on the stateless loop and provider/tool orchestration"（L665）。
- **评价**：官方文档把「loop 独立成包」作为显式设计原则写了下来（多宿主复用：CLI/VSCode/Hub 三类宿主都要驱动同一个 loop），这是「独立 loop」阵营里少见的成文判据——其动机是多消费者，而非抽象洁癖。

### 7. Goose（aaif-goose/goose，Rust）

- **loop 位置**：
  - 引擎：`crates/oi-kit-agent/src/machine.rs` 的 `StateMachine`（L69），`step()`（L169）执行一条 pipeline（`Vec<Step>`，`Step = Operation | Inference`），直到某一步 Applied 或全部 NotApplicable（Yielded）。
  - 驱动循环：`crates/goose/src/agents/state_machine/session.rs` 的 `run_goose`：`loop { let mut result = machine.step(&session, emit).await?; ... }`（L291-293）。
- **形态**：(b) 独立 engine crate + trait 注入——`MachineSession`、`SessionLoader`、`EffectHandler`、`Emitter` 都是 trait（machine.rs L21-46），Goose 侧的具体 Operation 在 `crates/goose/src/agents/state_machine/ops_*.rs`（20+ 个小模块：toolcalling、retry、compaction、subagent……）。
- **依赖获取**：泛型 trait + `&S`（session 状态）按引用传入每一步；效果（消息、事件）经 `Emitter` 回调发布。
- **状态归属**：引擎无自有状态（除 cancel token 与 interrupted_step 标记）；会话状态在 `S: MachineSession` 里，由外部持有并加载。
- **评价**：Goose 是把 loop 引擎与 harness 语义分离得最彻底的样本——engine crate 理论上可复用于非编码 agent。代价是 pipeline 抽象的间接层（Operation/Effect/Emitter 三套词汇）。这证明「loop 可拆」在 Rust 里工程上是可行的，但其前提是把每轮的语义切分成 20+ 个可枚举的 Operation。

### 8. Claude Agent SDK（anthropics/claude-agent-sdk-python，Python）

- **loop 位置**：`src/claude_agent_sdk/_internal/query.py` 的 `Query` 类（L176）——但它只是宿主进程与 Claude Code CLI 子进程之间的**消息泵**（读 transport、分发 control response、管理 background/subagent 生命周期）。
- **形态**：不适用——真正的「LLM 调用→工具→回填」循环在闭源的 Claude Code CLI 进程内，本仓库**未能确认**其内部循环结构。
- **依赖获取 / 状态归属**：Query 持有 transport 与消息路由状态；与 loop 无关。
- **评价**：这个样本的价值在于印证了「loop 放在 harness 里、以协议暴露给多宿主」的路线：Anthropic 把 loop 埋进 CLI，外部 SDK 只看到流式消息协议。它对辩论的启示是：只要协议边界稳定，loop 的归属可以完全不可见。

### 9. pi（earendil-works/pi，TypeScript，我们 LLM 层的上游）

- **loop 位置**：`packages/agent/src/agent-loop.ts`：`agentLoop()`（L47）/`agentLoopContinue()`（L80）返回 `EventStream<AgentEvent, AgentMessage[]>`；核心是纯异步函数 `runLoop()`（L172，`while (true)` L188，内层 `while (hasMoreToolCalls || pendingMessages.length > 0)` L192）；工具执行函数 `executeToolCallsSequential/Parallel`（L540/L592）。
- **形态**：(d) 纯函数循环——依赖全部经参数注入：`(context: AgentContext, config: AgentLoopConfig, emit: AgentEventSink, signal, streamFn)`（L111-117）；没有类。
- **依赖获取**：`AgentLoopConfig` 显式列出 loop 需要的一切（`beforeToolCall`/`afterToolCall` hooks、streamFn……）；事件经 `emit: AgentEventSink` 回调发布。
- **状态归属**：全部函数局部——`newMessages`、`currentContext`、`lastCompletedTurn` 都是 runLoop 局部变量；持久上下文在调用方传入的 `AgentContext`。
- **评价**：这是我们已认识并参照过的形态（Loop 对象/函数 + 回调注入）的干净版本。注意 `Agent` 类（packages/agent/src/agent.ts L194）仍然存在，负责队列与 steer 时机，在 L446 调 `runAgentLoop`——即「编排在外、循环为纯函数」，与我们 Agent/loop 的关系刚好相反。

### 10. SWE-agent（SWE-agent/SWE-agent，Python）

- **loop 位置**：`sweagent/agent/agents.py`，`DefaultAgent` 类（L443）的 `run()`（L1265）：`while not step_output.done: step_output = self.step()`（L1283-1285）；`step()`（L1235）做一次「模型调用→动作解析→环境执行」。
- **形态**：(a)/(e)——run 循环与 step 同在一个 agent 类里，自己驱动自己；依赖直接字段访问（`self.env`、`self.model`、`self._chook` hooks）。
- **状态归属**：轨迹、历史、info 都在实例字段。
- **评价**：与 Aider 同类的老式形态；`RetryAgent`（L257）是一个薄包装，在 run 层加重试——说明该仓库的多消费者需求（重试、评审变体）是通过「包装整个 agent」而非「抽出 loop」解决的。

---

## 汇总表

| 项目 | loop 位置 | 形态 | 依赖传递方式 | 循环内瞬态归属 |
|---|---|---|---|---|
| pi | `packages/agent/src/agent-loop.ts::runLoop`（纯函数） | (d) 纯函数循环 | 参数注入（context/config/emit/signal/streamFn） | 函数局部变量 |
| Goose | `oi-kit-agent/src/machine.rs::StateMachine.step` + `state_machine/session.rs::run_goose` 的 loop | (b) 独立 engine crate | trait（MachineSession/EffectHandler/Emitter）+ &session 引用 | 引擎近乎无状态，会话状态在 S |
| opencode | `session/runner/llm.ts::SessionRunner.drain` + `runner/step.ts::SessionStep.attempt` | (b) 独立模块（Effect 服务） | Effect Context DI + 窄回调 Input（interruption/retry/recoverOverflow/executeTool） | 函数局部变量 |
| Cline（新 SDK） | `sdk/packages/agents/src/agent-runtime.ts::AgentRuntime.execute`（for(;;)） | (b)+(c) 独立 loop 类 | config + HookBag 注入 | **对象字段**（state.messages/iteration/恢复计数） |
| Gemini CLI | core：`Turn`（每轮对象）；跨轮循环在 `cli/src/nonInteractiveCli.ts` while(true) | (b) + 宿主驱动分层 | 构造注入 GeminiChat；工具走独立 CoreToolScheduler；事件流上行 | Turn 实例字段（每轮新建） |
| Codex | `tasks/regular.rs::run_turns`（loop）→ `session/turn.rs::run_turn`（轮内 loop） | (c) 自由函数 + 共享状态 | `sess.services.*` 注册表直接字段访问 + `Arc<TurnContext>` | 函数局部变量；跨轮状态在 Session |
| OpenHands SDK | `conversation/impl/local_conversation.py::LocalConversation.arun`（while True）驱动 `agent.astep()` | (a)+(e) 编排类持有循环 | 直接字段访问（self.agent/_state/回调） | 实例字段 + 共享 _state |
| Aider | `coders/base_coder.py::Coder.run`（while True）→ `run_one`（while message） | (a) 并入编排类 | 直接字段访问 | **实例字段**（每轮重置） |
| SWE-agent | `agent/agents.py::DefaultAgent.run`（while not done）+ `self.step()` | (a)/(e) 自驱 step | 直接字段访问 | 实例字段 |
| Claude Agent SDK | 仅消息泵（`_internal/query.py::Query`）；真正 loop 在闭源 CLI | 未能确认 | 流式消息协议 | — |

分布统计（按主要形态）：**独立 loop 模块 + 注入：5**（pi、Goose、opencode、Cline SDK、Gemini CLI 的 Turn+宿主循环）；**并入编排类/共享状态：4**（OpenHands、Aider、SWE-agent、Codex）；**不可见：1**（Claude Agent SDK）。若按「loop 代码与编排类是否物理分离」计，分离派占 5/9 可见样本；若按「较新或近期重构的代码库」计，分离派占 5/5（pi、opencode、Cline SDK、Goose、OpenHands SDK 的新 conversation 是重构产物中唯一反向的——它反而把旧 AgentController 合并回了编排类）。

---

## 对我们的辩论意味着什么（诚实版）

1. **外部确实以「独立 loop + 注入」居多，但这不直接推翻 ADR-0016。** 差异要从「为什么能拆」看：pi、Goose、opencode、Cline 的 loop 能独立，前提是**每轮开始前的上下文准备、权限/审批、生命周期、持久化都被留在了 harness 层**，loop 只消费已准备好的输入、通过窄接口上报事件。例如 opencode 的 SessionStep.Input 显式传 `prepared`（已构造的请求）与 4 个生命周期回调；Goose 的 engine 甚至不知道 "coding agent" 的存在；pi 的 runLoop 参数表就是一份「loop 所需最小依赖清单」。**形状相似不等于判据相同**：它们的判据是「多宿主/多消费者复用同一 loop」（Cline ARCHITECTURE.md 明说三类宿主共用；pi 的 AgentLoop 是给第三方包用的公共 API；Goose 的 oi-kit 试图平台化），而不是「loop 在逻辑上可以独立于编排」。

2. **与我们处境最像的两个样本，恰恰选择了不拆。** Codex 的 `run_turn`（自由函数但直取 `sess.services.*`，文件 4050 行）和 OpenHands 的 `LocalConversation`（loop 即编排方法，确认/stuck/hook/插队全在循环体内）。尤其是 OpenHands：它的旧架构就是任务简报里说的「外层 AgentController 驱动 step()」，而他们在 SDK 重构中**主动把 controller 合并回了 conversation 编排类**——方向与我们 ADR-0016 的结论一致。这是「判据相同」的最强外部证据：当一个 harness 的循环体要引用审批闸门、状态机转换、steer 队列、hook 时机时，拆出去的接口面就是会膨胀。

3. **注意「loop 有没有自己的状态」这条分界线在样本中成立。** 独立派（pi、Goose、opencode）的循环瞬态全是函数局部变量；不拆派（Aider、SWE-agent、Cline SDK）则有对象字段承载跨轮状态（Aider 每轮重置的实例字段甚至是个 bug 温床）。这与 ADR-0016 的判据——「loop 没有任何自己持有的状态，瞬态全是 run 局部变量」——在经验上吻合：我们的 loop 没有自有状态，这正是它「不值得成为对象」的一条证据。

4. **「回调袋」在外部确实存在，但规模比 19 个小。** opencode 的 Input 有 ~4 个回调；pi 的 AgentLoopConfig 有 2 个 hook + emit + streamFn；Goose 用 3 个 trait。如果一个拆分方案需要 19 个回调，这在样本里没有先例——最接近的 Cline HookBag 也只有 6 个槽位，且那是因为它把工具策略和遥测也挂了上去。这可以作为对「依赖袋」方案的成本参照，但要注意它们的宿主层已经承担了 prepareRequest 之外的大部分职责；如果我们的 prepareRequest 本身就是编排（ADR-0016 的说法），那么 19 个回调与 0 个回调之间的差距，正说明我们的 loop 边界画法和它们不同。

5. **Gemini CLI 的分层提供了一个中间路线的真实样本**：core 暴露「每轮 Turn 对象 + 类型化事件流」，把「是否/如何继续」留给宿主。它之所以可行，是因为 Gemini CLI 把工具确认（CoreToolScheduler + confirmationDetails）也做成了独立可注入对象。对照我们的 ADR 判据：这等价于把 loop 切成「步进器」（Turn）+「控制器」（宿主）——恰是形态 (e)，而 OpenHands 的实践表明，当控制职责越来越重时，这个形态会被重新合并。若未来我们的桌面 UI、CLI、远程多路复用需要共用 loop，Turn+事件流的分层可作为迁移方向的参照，但当前单一消费者的现实下，ADR-0016 维持 loop 在 Agent 内与主流老牌 harness（Codex、OpenHands、Aider）一致。

6. **一句话结论**：外部证据支持「独立 loop 在多宿主/多入口场景下是主流选择」，但不支持「单消费者的编码 agent 应当把 loop 拆成对象」——后者最像我们的三个样本（Codex、OpenHands、Aider）都把 loop 留在了编排体内或紧贴共享状态。ADR-0016 的判据与外部实践并不矛盾，只是我们更应该引用的是判据本身（无自有状态、依赖全在编排面），而不是引用「大家都这么拆」——因为那不是事实。

### 11. deepseek-harness-java（小傅哥社群项目，Java/DDD，上游为 DeepSeek 官方 deepseek-harness）

- **来源说明**：`gitcode.net/KnowledgePlanet/deepseek-harness-java` 为付费社群仓库（克隆需登录）；本节基于 GitHub 公开镜像 `ZeroKingHao/deepseek-harness-java`（其 `docs/PUBLICATION.md` 注明上游即该 gitcode 仓库）。上游原型是 DeepSeek 官方开源的 `deepseek-ai/deepseek-harness`（TypeScript，Cordis「一切皆插件」架构——loop 本身也是插件，见下节备注）。
- **loop 位置**：`deepseek-harness-java-domain/src/main/java/.../domain/agent/service/run/ReactLoopAgent.java`（994 行），实现 `AgentRun` 接口。
- **形态**：**(a) loop 与编排合并为一个大类**——但它不是进程单例，而是**每会话一只的常驻对象**：`AgentRunFactory.wireAgent` 每个会话装配一只（创建专属 `Inbox`/`SessionLog`/`ToolCallExecutor`/`ToolRegistry`），存进 `liveAgents: ConcurrentMap<String, AgentRun>`（与我们的 AgentState 表同构）。类内包含：inbox 消费循环（`kick` 的 `while(true)`）、turn 循环、step（流式 LLM + 请求构建 + 工具执行）、Phase 状态机（Idle/Running/Maintenance）、cancel、压缩触发、SSE sink——与我们的 `Agent` 完全同构，连请求填充（`buildRequest`/`truncateToBudget`）都是 loop 类的私有方法。
- **依赖获取**：**构造注入，约 11 个依赖**——`ILlmRuntimePort`（端口接口，Infrastructure 侧 DeepSeek/Anthropic 适配器实现）、`ToolRegistry`、`ToolCallExecutor`、`SystemPromptAssembler`、`CompactionEngine`、`SessionLog`、`Inbox`、`AgentEventListener` 等，loop 用 `this.llm.stream(...)` / `this.toolExecutor.execute(...)` 直取。无回调袋；唯一的回调是事后安装的 SSE sink（`setStreamDeltaSink` 等 volatile 字段）。共享的东西（LLM 端口、hooks、权限矩阵、审批网关）由 Factory 持有并注入，每会话的东西（Inbox、SessionLog、执行器实例）在装配时新建。
- **与我们的关键差异**：
  1. **对象生命周期**：他们 loop+编排合并对象是**会话级**的（实例即会话，字段上放 turnCount/phase/options 都合法）；我们的 `Agent` 是**进程级单例**（所以 per-run 的量必须是局部变量，ADR-0007 决定 8 的裁剪正因此）。两者排布同构，生命周期不同。
  2. **审批闸门下移**：审批不在 loop 里，而是装配时挂在 `ToolCallExecutor` 上（`executor.setApprovalGate(new MatrixRuntimeApprovalGate(...))`），loop 调执行器时闸门自动生效；我们的闸门留在编排层（`beforeToolCall`）。
  3. **领域端口即我们的 Manager**：六边形架构要求领域层不依赖具体技术，所以这些注入依赖全是接口——这等价于我们「server 包不认 Manager、只认编排层」的消费边界，只是用 Java 接口而非脚本守卫来表达。
- **评价**：又一个支持「loop 即编排」的样本：Java/DDD 生态按自己的惯例得出了与我们相同的排布——合并的运行对象 + 构造注入的服务面。规模上 ReactLoopAgent 994 行 ≈ 我们机件段+类的量级。值得注意的是它的 SSE sink 直接以可变字段挂在领域对象上（UI 关注点漏进了 domain 层），这点我们的投影/事件扇出（ADR-0017）更干净。
- **整体分层（自外向里，2026-11-20 深查补充）**：`app`（Spring Boot 装配）→ `trigger`（19 个 REST Controller，只管协议/认证/路由）→ `api`（Facade+DTO）→ `case`（用例编排层：十余条 CasePipeline 策略树，节点串联——对话主线为 AgentResolveNode 找/建 agent → AgentIntentNode 意图识别 → AgentDispatchNode 构造消息 `agent.send(msg, NEXT_TURN, true)` 投递 inbox 并唤醒 → AgentCollectNode `whenIdle().join()` 后遍历 SessionLog 事件重放出响应；另有 task/approval/goal/plugin/workflow/terminal 等用例线同款）→ `domain`（27 个限界上下文，ReactLoopAgent/ToolCallExecutor/端口接口住这）→ `infrastructure`（反向实现端口：DeepSeek/Anthropic LLM 适配器、DAO、Shell/MCP 适配器）。
- **与我们概念的一一对应**：Inbox.claim/nextStep ≈ 队列取走点（ADR-0002）；SessionLog 的 turnStart/stepStart/userMessage/assistantMessage/toolCall/toolResult 事件 ≈ JSONL 账本六种 kind；CollectNode 从事件重放出响应 ≈ 投影（ADR-0017）；whenIdle ≈ settle；liveAgents 表 ≈ AgentState 表；ILlmRuntimePort ≈ transport；case 层只经 send/inbox/whenIdle 窄入口驱动 loop、不碰循环内部 ≈ ADR-0012「server 只认公开面」。
- **差异点**：①审批门挂 ToolCallExecutor 而非编排层；②意图识别在 case 层用**正则启发式改写用户消息**（如「/tmp 目录里有什么」被改写成"执行 ls -la /tmp"的提示）——把提示词工程硬编码进 Java，与我们交给模型 + system prompt 的做法相反，脆弱且难维护；③loop 事件粒度较粗（turn/step 级，无我们 tool_execution 级的细事件）；④驱动器递归重入（kick 结束时若有 wake 请求则重新 kick）而非单一 run 槽位。
- **上游备注**：DeepSeek 官方 `deepseek-ai/deepseek-harness`（TypeScript）走得更远：基于 Cordis 的「一切皆插件」，模型适配器、工具注册表、会话日志、**agent loop 本身**都是插件，均可从配置替换、卸载即撤销注册。那是「loop 可拆」的极限形态，动机是插件生态的完全可组合性——与单消费者项目的选择不在同一约束下。

---

## 引用清单

源码（均以 2026-11-20 HEAD 为准，行号来自本地缓存副本 `src-cache/`，可能与 HEAD 漂移）：

1. pi（earendil-works/pi，原 badlogic/pi-mono）：`packages/agent/src/agent-loop.ts`（agentLoop L47、runAgentLoop L111、runLoop L172、while L188）；`packages/agent/src/agent.ts`（Agent L194、runAgentLoop 调用 L446）。
2. Goose（aaif-goose/goose，原 block/goose）：`crates/oi-kit-agent/src/machine.rs`（StateMachine L69、step L169、trait L21-46）；`crates/goose/src/agents/state_machine/session.rs`（loop L291）；`crates/goose/src/agents/state_machine/mod.rs`。
3. opencode（anomalyco/opencode，原 sst/opencode）：`packages/core/src/session/runner/llm.ts`（drain L63、while L216、runStep L237）；`packages/core/src/session/runner/step.ts`（Input L43-64、make L71、attempt L77）；`packages/core/src/session/runner/index.ts`（Interface L31-44）；`packages/core/src/session/execution.ts`（SessionExecution layer）。
4. Gemini CLI（google-gemini/gemini-cli）：`packages/core/src/core/turn.ts`（Turn 类与 run）；`packages/core/src/core/client.ts`（GeminiClient.sendMessageStream/processTurn）；`packages/cli/src/nonInteractiveCli.ts`（while(true) L358、schedule L559）。
5. Codex（openai/codex）：`codex-rs/core/src/tasks/regular.rs`（RegularTask::run L53、run_turns L140、loop L154）；`codex-rs/core/src/session/turn.rs`（run_turn L227、轮内 loop L573）。
6. OpenHands（OpenHands/software-agent-sdk，原 All-Hands-AI/OpenHands）：`openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py`（LocalConversation L251、arun L2862、_arun L2883、while L2930、astep L3049/L3207、step L2756/L3824）。
7. Aider（Aider-AI/aider）：`aider/coders/base_coder.py`（Coder L88、run L876、while L882、run_one L924）。
8. Cline（cline/cline）：`sdk/packages/agents/src/agent-runtime.ts`（AgentRuntime L543、HookBag L549-557、state L566、run L637、for(;;) L1259）；`sdk/ARCHITECTURE.md`（L104-106、L171、L665）。
9. SWE-agent（SWE-agent/SWE-agent）：`sweagent/agent/agents.py`（DefaultAgent L443、step L1235、run L1265、while L1284）。
10. Claude Agent SDK（anthropics/claude-agent-sdk-python）：`src/claude_agent_sdk/_internal/query.py`（Query L176，消息泵；实际 loop 在闭源 CLI，未能确认）。

二手资料（仅用于定位入口）：
- grep.app 代码搜索（用于定位 opencode SessionRunner 引用）。
- GitHub 网页目录浏览（用于在仓库重构后寻找新路径）。
