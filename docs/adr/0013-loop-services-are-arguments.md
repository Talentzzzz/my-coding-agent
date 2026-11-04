# 0013：`LoopManager` 不持有任何服务——运行需要什么，由调用方在参数里交给它

日期：2026-11-04 · 状态：已接受并落地，**同日即被 [0014](0014-loop-manager-removed.md) 取代**
（0014 删掉了它描述的那个对象，`LoopServices` 也随之消失）
取代：[0012](0012-loop-manager-object.md) 的决定 2（「它不回头问 `Agent`」里「自带六件依赖」那一半）
与决定 4 的构造注入部分；[`.scratch/loop-manager/issues/01-injection.md`](../../.scratch/loop-manager/issues/01-injection.md)
里「`api` 与 `systemPrompt` 归 `LoopManagerConfig`」的归属

## 背景

ADR-0012 把一次运行从 `agent.ts` 里拆出来，成为一个对象，并且定下了它的依赖方向：

> `LoopManager` 自带六件依赖——账本、`SettingManager`、`ToolRegistry`、`Hooks`、prompt builder、
> `base: ChatTransport`——会话以 `AgentState` 作**参数**递进来。

这条被写成了判据：`loop-manager.ts` 在值的层面不 import `agent.ts`，所以「有没有绕回编排层」是编译期
可验证的。它成立，也一直成立。

问题在另一半：**这个类没有状态。** `run` 里的模型、abort controller、事件 sink、两个闸门全是局部变量，
`prepareRequest` 的请求对象是用完就丢的，压缩阶梯每一步都从账本重放。类上留下的六个字段，全是依赖
——也就是说，这个类的真实作用是**把六件东西绑成一个闭包**，好让 1942 行方法少写六个参数。

同一个文件里，1082 行那一段注释对这件事给过相反的判断：「Everything below is stateless: … which is why
it is a set of functions rather than more methods.」同一个标准，在方法与方法之间用了，在对象与函数
之间没有用。ADR-0012 论证了文件边界（`agent.ts` 2916 → 809 行），没有论证闭包比显式参数好在哪。

用户在同一天的第二次对话里把这条推翻，理由是两句话：

1. **「Loop 不该注入任何 Manager」**——它要什么，调它的那一方在调用时给。
2. **「剩下的都应该只用它自己的方法」**——引擎机械、填充链、压缩、重试、闸门，仍然都是它的方法。

所以这次改的不是「有没有对象」（0012 已定：有），而是「对象身上有没有东西」。

## 决定

1. **`LoopManager` 零字段、零构造参数。** 类壳保留（ADR-0012 的决定 1 与 3 不动），但类体里没有任何
   `readonly` 字段、没有 `constructor`。`new LoopManager()` 不接收任何东西。
2. **一次运行要用的六件，走调用的参数。** `LoopServices`（`loop-manager.ts`）就是原来
   `LoopManagerConfig` 的那六项，去掉全部可选：`sessionManager`、`settings`、`tools`、`hooks`、
   `systemPrompt`、`api`。两个公开方法的形状：
   - `run(state: AgentState, services: LoopServices, start: RunStart)`
   - `maybeCompact(state, services, entries, now, signal?, transport?)`
3. **`services` 一路作为首参传下去。** 十个私有方法各加一个 `services` 首参——`runEngine`、
   `prepareRequest`、`runContext`、`recordSelection`、`pumpAttempts`、`retryCallbacks`、`endRetry`、
   `compactFor`、`trimRecordedArgs`、`clearStaleToolResults`、`toolCallHooks`、`beforeTool`、
   `afterTool`、`drainTranscribed`、`dispatchEvent`——每个方法体第一行只解构它自己要的那几件
   （`const { sessionManager, settings, tools } = services;`），方法体其余部分不变，只是把
   `this.settings` 写成 `settings`。
4. **`Agent` 持有值，不持有方法的宿主。** `AgentConfig` 从 `{ sessionManager, settings, tools, loop }`
   变成 `{ loop, loopServices }`；`Agent` 的 `sessionManager` / `settings` / `hooks` / `tools` 变成取值器，
   从 `loopServices` 现取（**同一份实例，没有副本**）。三个入口只是把值原样转交：
   `this.loop.run(state, this.loopServices, …)`、`this.loop.maybeCompact(state, this.loopServices, …)`。
5. **装配点不变，默认值上移。** 仍然是 `createSessionAgent`：它建 hooks、解析工具目录、组出
   `loopServices`（`api: services.api ?? anthropicMessages`——默认值从构造函数搬到这里），再
   `new Agent({ loop: new LoopManager(), loopServices })`。
6. **`private get services()` 换成文件级函数 `sessionServicesOf(services)`。** fan-out 要的
   `{ sessionManager, settings, tools }` 从参数里切一刀，仍然在调用点现建，不落成字段（ADR-0007）。

## 为什么不是「`run` 开头存到 `this` 上」

因为**并发的两条 run 会互相踩**。`live.activeRun` 是**每个会话**一份（`AgentState.live`），不是每个进程
一份：两个会话可以同时流式，同一个 `LoopManager` 实例会同时跑两遍 `run`。参数一旦被收下再记住，
后进的那条会把先进的那条的账本换掉——而且症状是「写进了另一个会话的文件」，不是崩溃。

所以唯一的实现是把 `services` 一路传下去。这也是这次改动的全部机械成本的来源。

## 后果

换来的：

- **「它不认识任何 Manager」成了字面事实。** 类上没有任何字段可以指向账本、配置或目录；想用它就必须
  在调用点把六件凑齐，凑不齐编译不过。依赖不再靠「读构造函数」推断，而是在每个签名上写着。
- **并发安全从「靠约定」变成「结构上不可能」。** 之前靠「没人给这个实例塞 per-run 状态」这条自觉
  （ADR-0006 §5 写的正是这条），现在连可以把状态塞进去的槽都没有了。
- **`AgentConfig` 少三个字段。** 三个服务不再各写一份、各带一段文档；一个 `loopServices` 是唯一来源，
  `Agent` 的公开读面（`sessionManager` / `settings` / `hooks`）原样保留，改成取值器。
- **默认值到了它该在的地方。** `anthropicMessages` 从「运行对象构造时补的默认」变成「装配进程时解析
  的一次选择」，对象本身不再猜任何默认。

背上的：

- **十二个签名多一个参数。** `run` 与 `maybeCompact` 是入口，其余十个是内部传递；每个方法体第一行
  多一行解构。这是这次改动的全部噪音，也是它唯一让人犹豫的地方。
- **`Agent` 知道了 `api` 存在。** 01 号票当初把 `api` 与 `systemPrompt` 移出 `AgentConfig`，理由是
  「`Agent` 不知道 `api` 存在」。现在它必须持有并转交，那条理由作废——但换来的是运行对象不再
  自己持有任何东西，取舍点从「谁知道 transport」挪到了「谁持有服务」。
- **一个六字段的值挂在 `Agent` 上。** ADR-0007 反对「聚合袋」，这里确实有一个。区别在于：它只有一个
  持有者、只有一个读取点（每个 `loop.*` 调用的第二个实参），且不含任何会话数据——它是**一次调用的
  参数表**，不是被四处传递的袋子。

## 不可逆性与代价

- **难逆转。** 回去要把十二个签名撤掉、把六件重新塞回构造函数、把 `AgentConfig` 拆回四个字段、
  把 `Agent` 的取值器改回字段。不止一处，也不止一个文件。
- **没有上下文会让人困惑。** 0012 说「自带六件依赖，一次都不回头问 `Agent`」，0013 说「一件都不持有」，
  而两份文档都写着理由。区分它们的是**依赖方向**与**所有权**两件事：0012 定的是「不绕回编排层」，
  0013 定的是「不把服务绑在对象上」——前者仍然成立，后者是这次推翻的那一半。
- **是真实取舍。** 换来零状态与并发上的结构性安全，付出十二个参数与 `Agent` 重新知道 `api`。

## 被取代的是什么

- **ADR-0012 决定 2 的后半句**（「自带六件依赖 … 都是它的方法」）：六件不再自带，改为调用时递入。
  决定 2 的前半句（不回头问 `Agent`、值层面不 import `agent.ts`）原样有效，且因为参数是值而更硬。
- **ADR-0012 决定 4 的构造注入**：`AgentConfig` 不再是 `{ sessionManager, settings, tools, loop }`，
  `LoopManager` 不再有 `LoopManagerConfig`。
- **01 号票的归属结论**：`api` 与 `systemPrompt` 回到 `AgentConfig`（以 `loopServices` 的形式）。

## 没有被取代的

- **ADR-0012 决定 1**（一次运行的全部是 `LoopManager` 的方法）与**决定 3**（共享扇出住
  `session/fanout.ts`）：一字不改。引擎机械、填充链、压缩阶梯、重试泵、两个闸门、事件 sink 仍是
  这个类的方法。
- **ADR-0012 决定 5–7**：`Agent` 留下的是会话不是运行；`abort` / `settle` / `close` 不搬；事件类型住
  `session/events.ts`。
- **ADR-0006 §5**：运行期瞬态仍是这次运行的局部变量（模型、abort controller、事件 sink、两个闸门）。
  这次改的是**服务**从哪来，不是瞬态住哪。
- **ADR-0007**：服务无属性、每次现读；fan-out 的参数形状 `(state, SessionServices)` 现建不持有。
