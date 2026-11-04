# 0014：删掉 `LoopManager`——一次运行回到 `Agent` 的方法，服务重新是它的字段

日期：2026-11-04 · 状态：已接受，**已落地**（同日改完跑绿 `check` 与除 `smoke-api` 外的 smoke 全套）
取代：[0012](0012-loop-manager-object.md) 的全部决定（对象、六件依赖、构造注入、`AgentConfig` 的形状）与
[0013](0013-loop-services-are-arguments.md) 的全部决定（零字段、`LoopServices` 参数、取值器）
复活：[0008](0008-loop-merged-into-agent.md) 的决定 1 与决定 2——引擎是 `Agent` 的方法，住在 `agent.ts`

## 背景

同一天的三个形状，每一步都有理由，每一步都被下一步推翻：

1. **0008（上午）**：删 `packages/loop` 与 `Loop` 对象，引擎并入 `agent.ts`。代价写得清楚——
   `agent.ts` 2043 → 2956 行，「没有第二个文件可以指」。
2. **0012（下午）**：把一次运行抽成 `LoopManager`，`Agent` 通过构造注入持有它。理由不是「对象有状态」，
   而是「`agent.ts` 太大，读一段要先判断这是运行的还是会话的」。同时定了依赖方向：自带六件依赖，
   值层面不 import `agent.ts`。
3. **0013（晚上）**：用户指出这个类**没有任何状态**——`run` 里的模型、abort、sink、闸门全是局部变量，
   类上只剩六个字段，全是依赖。于是六件改成每次调用的 `LoopServices` 参数，类变成零字段。

到这一步，`LoopManager` 剩下的东西是：一个类名、一个空构造、以及「这些方法是它的」这一句话。
用户的判断是「加了这个没啥用」，并选择把方法搬回 `Agent`。

这个判断成立，理由正是 0013 自己写下的那条：一个不持有任何东西的对象，唯一的作用是给 1900 行方法
提供一个 `this`。而 `Agent` 已经是这样一个 `this`——它持有账本、配置、工具、seams、prompt builder、
transport，正好是那六件。

## 决定

1. **删除 `packages/core/src/loop-manager.ts`。** 类里的一次运行整套机械成为 `Agent` 的私有方法：
   `run`（入口，私有）、`runEngine`、`prepareRequest`、`runContext`、`recordSelection`、`pumpAttempts`、
   `retryCallbacks`、`endRetry`、`compactFor`、`trimRecordedArgs`、`clearStaleToolResults`、
   `toolCallHooks`、`beforeTool`、`afterTool`、`drainTranscribed`、`dispatchEvent`、`handleRunFailure`、
   `finishRun`。搬过去时唯一的机械改动是把 `const { sessionManager, settings } = services;` 变成
   `= this;`，方法体其余不动。
2. **引擎的文件级机械跟着搬进 `agent.ts` 末尾**，仍是文件级函数：`streamAssistantResponse`、
   `failToolCallsFromTruncatedMessage`、工具批次（`executeToolCalls` 及其兄弟）、恢复机器
   （`danglingToolCallsOf`、`recoverPendingToolCalls`、`synthesizeToolResult`）、`pairLateToolResults`、
   `messagesOf`、`failureMessage` 等。ADR-0008 决定 3 的分界继续成立：**有状态 → 成员，无状态 →
   文件级函数**。恢复机器仍然导出（smoke 直接驱动，ADR-0006 §5）。
3. **`AgentConfig` 回到六个必需字段**：`sessionManager`、`settings`、`tools`、`hooks`、`systemPrompt`、
   `api`。`loop` 与 `loopServices` 消失；`Agent` 的取值器改回字段（`sessionManager` / `settings` /
   `hooks` 公开，`tools` / `systemPrompt` / `api` 私有）。`api` 的默认值仍在 `createSessionAgent` 解析。
4. **少一层转发。** `Agent.maybeCompact(id, …)` 直接算模型、调 `compactFor`——原来它只是转发给运行对象
   的同名方法。
5. **装配点仍是 `createSessionAgent`**，全仓库仍然只有一处 `new Agent(`。

## 后果

换来的：

- **零层间接。** 读「一次运行怎么开始」不用在两个文件之间跳：`prompt` → `startPromptedRun` → `run` →
   `runEngine` 都在一个文件里，按调用顺序排。
- **服务就近可读。** 引擎里不再有 `services.xxx` 或解构参数，`this.settings` 就是配置，`this.sessionManager`
  就是账本——和命令面用的是同一个 `this`，不可能配错。
- **两个对象不会漂到不同账本上。** 0013 里这条靠「装配点只交一次」保证，现在结构上不存在第二个持有者。

背上的：

- **`agent.ts` 2658 行，`Agent` 类约 1730 行。** 0008 那笔「最直白的代价」原样回来了：读这个文件的人
  仍要先判断一段是运行的还是会话的——只不过这次的分界是文件里的两个小节标题（`the engine` 与
  上面的命令面），而不是两个文件。
- **`session/events.ts` 与 `session/fanout.ts` 的分工变了形状。** 它们当初被抽出来是因为「两个对象都发
  事件」；现在只有一个对象，但文件不动——fan-out 仍是无状态函数，仍是命令面与引擎共用的那一半，
  抽出来这件事本身没有错。
- **`npm run check` 与 smoke 的形状没变**，但 `index.ts` 少了 `LoopManager` / `LoopServices` 两个出口。

## 不可逆性与代价

- **难逆转。** 回去要把 18 个方法再切出去、重新定义对象与它的参数形状、把 `AgentConfig` 拆一次、
  把 800 行机械搬回一个单独文件。一天之内第三次搬同一批代码，也正是这条门槛的证据。
- **没有上下文会让人困惑。** 三份 ADR 连读会看到：0008 说「引擎是方法」，0012 说「引擎是对象」，
  0013 说「对象不持有东西」，0014 说「那就别要对象」。这条链是连贯的——每一份都推翻了前一份的
  一条，而 0013 是转折点：它证明了 0012 留下的对象**没有内容**，0014 只是把这句话执行完。
- **是真实取舍。** 换来零层间接与就近可读，付出一个 2658 行的文件。

## 被取代的是什么

- **0012 全部决定**：对象（决定 1）、自带依赖与不回头问（决定 2）、扇出抽离（决定 3，见下）、构造注入
  （决定 4）、`Agent` 留下的清单（决定 5）、`abort` / `settle` / `close` 不搬（决定 6）、事件类型搬家
  （决定 7）。其中决定 3 与 6、7 的**内容**仍然有效，只是不再需要「搬去 `LoopManager`」这个说法。
- **0013 全部决定**：零字段、`LoopServices` 参数、十二个签名、取值器、`sessionServicesOf`。
- **0008 的决定 1 与 2 复活**：引擎是 `Agent` 的方法，住 `agent.ts`。0008「后果」一节里那句
  「`agent.ts` 从 2043 行长到 2956 行……没有第二个文件可以指」原样成立。

## 没有被取代的

- **ADR-0006 §5 的结束重启审批**：恢复机器、悬空扫描、答案配对、孤儿收尾一字不改；默认闸门仍经
  `Hooks` 的 `before_tool` 回答，处理器仍调 `Agent.authorize`。
- **ADR-0007 的无属性服务**：四个服务仍无实例状态，每次现读；fan-out 的参数形状仍是在调用点现建。
- **ADR-0011 的 `AgentState`**：`state.session` 与 `state.live` 的分半、`adopt` / `evict` / `drop` 的唯一
  出入口不动。
- **ADR-0003 的取走点落盘**、**ADR-0009 的两文件格式**：不动。
- **`session/fanout.ts` 与 `session/events.ts` 的存在**：模块化本身不是这次要撤的，撤的只是「运行是
  一个对象」。
- **`Agent` 仍然只决定 transcript 命名哪一行**：`modelFor()` 每次请求按选择现查目录。
