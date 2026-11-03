# 01：谁构造 AgentState——装配点留在工厂还是搬进 Agent

Type: grilling
Status: resolved

## Question

新的构建链是 `fillSession` → `fillSettings` → `live`，但**谁来调用这条链**还没定。现状只有一处：
`ensureSession()`（`packages/core/src/session-factory.ts:245`）调 `assemble()`（:134）解析工作目录、设置袋、
模型选择，再 `createOpenSession()` 造条目、`openSessions.ensure()` 落表、`sessionManager.adopt()` 把调用方的
`Session` 交给缓存。`Agent` 至今**不依赖 `SettingsManager`**：设置只以 `entry.settings` 的形式随条目进来，
构造参数里没有设置服务。

三条路：

- **(a) 装配仍只有一处**：`ensureSession` 建出 `AgentState`，交给 `agent.adopt(state)`（新公开方法）；`Agent`
  只持 Map + 读写，不新增 `SettingsManager` 依赖。`assemble()` 保留，内部顺序改成会话先、设置后。
- **(b) Agent 自己开**：`Agent.open(id)` 内部跑完三条链，`Agent` 新增 `settingsManager` 依赖，
  `ensureSession` / `assemble` 退成冷路径（`readSessionSnapshot`）专用。
- **(c) 两者都有**：工厂装配 + Agent 兜底自建——两个入口、两种顺序，迟早不一致。

约束：hub 的 open 有两条来源（`packages/server/src/hub.ts:688`）——磁盘上的文件，和这个进程刚建、`pending`
里还没落盘的 `Session`。(b) 会让 Agent 也必须知道 `pending` 这袋东西（见 03 号票）。

另需定：`AgentConfig.openSessions` 这个注入点换成什么。测试要能塞一张自己的表（`scripts/smoke-sessions.ts:884`
现在就是手建 `new OpenSessions()` 再 `createOpenSession` 的），所以选项是「构造收 `sessions?: Map`，缺省自建」
还是「只留 `adopt`，测试走同一条公开入口」。

➡️ 推荐 **(a)**：装配点唯一，Agent 不碰设置服务的构造，`AgentConfig.openSessions` 换成
`sessions?: Map<string, AgentState>`（缺省自建 + `adopt` 公开）。

## Answer

### 结论（一句话）

**(a)，并且把接法收到一个门**：装配仍然只有工厂一处——`assembleSession`（原 `ensureSession`）造出
`AgentState`，调用方 `agent.adopt(state)` 交表；`Agent` 不新增 `SettingsManager` 依赖；
`AgentConfig.openSessions` **整条删掉**，不换成 `sessions?: Map`——票面留给本票的那两个选项里，选"只留
`adopt`，测试走同一条公开入口"。

票面的 `➡️` 把两半写在一起（注入表 **加** `adopt`），本票只取后一半，理由在第 3、6 节：**注入一张表不是
一个便利参数，它是第二个能写这张表的人**；而"这张表只有 Agent 一个写者、一个删者"正是本图（登记处从 hub
搬进 Agent）唯一要买到的那件东西。`adopt` 单独就够表达注入表能表达的全部四件事：先种一个状态、
后种一个状态、同一 id 重复种、种完之后由 Agent 删。

### 1. 为什么装配点留在工厂，而不是搬进 `Agent`（否掉 (b)）

三条，第一条是硬的：

1. **冷读与热开共用一次装配，靠的就是 `assemble()` 这一个私有函数**（`session-factory.ts:134`，两个调用点
   `:188` 与 `:246`）。两条注释各自把这件事写成了自己的存在理由：`assemble()` 说它"两个调用者走同一条路"
   （`:126-133`），`readSessionSnapshot` 说"拆分出来是为了让没有在跑的会话由同一批决定描述，而不是由第二份
   实现描述"（`:175-186`）。装配搬进 `Agent` 之后，冷读要么也去问 `Agent`（但它不该有"没在跑"的会话，
   `entryOf` 的抛就是这个边界的表达），要么在工厂留第二份——后者正是这条要防的漂移。
2. **构造依赖就是权限**。`AgentConfig` 今天七个字段（`agent.ts:105-180`），没有一个是设置服务。加进
   `settingsManager` 之后，核心编排层就能读任何目录的设置，而它今天读设置只有一条路：**随条目进来的
   `entry.settings`**。设置是"这个会话在那个目录里被装配时看到的那一份"，不是"编排层随时可以去问的一个服务"
   ——这两者的区别在 05 号票（写回扇出）里会变成真问题。
3. **hub 的两条 open 来源在工厂里已经是同一种输入**。`hub.open()`（`hub.ts:688-704`）只做两件事：挑一个
   `Session`（`pending` 里的，或 `stateOf(id)` 的），然后 `ensureSession`。装配只认 `Session`，不认它是刚建的
   还是从盘上读的。搬进 `Agent` 就得把 `pending` 这袋东西的知识带进 `packages/core`——而 03 号票的推荐是
   **删掉 `pending`**。两票会互相打架：01 若能替它定，就不该把它留成"另需定"。

### 2. 为什么不是 (c)

两个入口不是"多一条兜底"，是**两种顺序**：工厂的顺序是"会话 → 设置 → live"（地图钉死的构建链），
`Agent.open(id)` 自成一套时它的顺序必然由它自己再写一遍，而两条链只有在产出的状态**恰好逐字段一致**时才不炸
——也就是说，这个设计的正确性依赖于两个实现永远同步，而不是依赖于结构。今天没有任何一处需要那个兜底：
`ensureSession` 的三个调用方（`session-factory.ts:361`、`hub.ts:694`、`mount-session.ts:55`）全都能先拿到状态。

### 3. 接法的精确形状：一个门、三处调用方、零注入

```ts
// packages/core/src/session-factory.ts
/** Assemble one session's state. Registration is the caller's: see `Agent.adopt`. */
export async function assembleSession(options: OpenAgentOptions): Promise<{
	sessionManager: SessionManager;
	state: AgentState;
}>;

// packages/core/src/agent.ts
export interface AgentConfig {
	sessionManager: SessionManager;
	models: ModelSource;
	tools: ToolRegistry;
	api?: ChatTransport;
	hooks?: Hooks;
	systemPrompt: …;
	// openSessions 删除；不新增任何表字段
}

export class Agent {
	private readonly sessions: Map<string, AgentState>;
	/** Put one assembled state in the table. The only way in. */
	adopt(state: AgentState): void;
}
```

三处调用方各自的样子：

```ts
// openAgent —— 状态先、Agent 后
const { sessionManager, state } = await assembleSession(options);
const agent = createSessionAgent({ sessionManager, models: options.models, … });
agent.adopt(state);            // 构造时表还是空的，这一行是两种顺序里都有的同一个动词
return agent;

// hub.open —— Agent 在进程启动时就存在了，状态每次 open 才来
const { state } = await assembleSession(this.sessionOptions(bag, workDirAbsPath));
this.agent.adopt(state);

// mount-session —— 与 hub 同形，且它今天就在"Agent 已存在"的这一侧
const { state } = await assembleSession({ … });
hub.agent.adopt(state);
```

**`openAgent` 也不需要一棵注入的表**：它可以先 `createSessionAgent` 再 `adopt`——`createSessionAgent`
不读表，只把表建出来持有。**选这条**，三处调用方就全走同一个动词，`AgentConfig` 里一个表字段都不必有，也就
没有"注入的空表"与"Agent 自建的表"这两种身份。若 08 落地时发现 `createSessionAgent` 里有东西在读表（今天
没有），那要回来**重开本票**，而不是就地加一个参数。

**`ensureSession` 改名 `assembleSession`**：它不再"确保一条登记"——登记是 `adopt` 的事，它只回答"这个会话
是什么"。留着旧名字会让下游票把"装配"与"入表"继续当成一件事（08 的接线、12 的 hub、14 的文档清扫都会
沿用它）。私有的 `assemble()` 保留：冷读用它，`assembleSession` = `assemble()` + 包成 `AgentState`。
**冷读不进表**（今天也不进：`readSessionSnapshot` 调的是 `assemble`，不是 `ensureSession`），这条在 07 把
类型立起来之后仍然成立。改名的波及面不止一处，归 14 一并清：`packages/core/src/index.ts` 的导出、
`AGENTS.md` 的 `assembly` 术语，以及 `docs/architecture.md` 的三处（`:72` 那句"装配 + ensure 条目 + adopt 袋"
整句失效，`:76`、`:79` 是名字）。

**两个服务袋跟着形变，`extends` 那条线必须断**：`SessionServices` 今天 `{ sessionManager, openSessions }`
（`session-factory.ts:223`）且被 `SessionAgentServices extends SessionServices` 继承（`:277`）。若只把前者的
字段换掉，后者就会要求 `createSessionAgent` 也收一个会话的 `state`——与"一个进程一个编排层"直接冲突
（`hub.ts:275` 的构造就是进程级的那一次）。所以：`SessionServices` 整个删掉，`assembleSession` 用自己
返回的形状（`{ sessionManager, state }`）；`SessionAgentServices` 不再继承任何东西，字段恢复成
`sessionManager` / `models` / `tools?` / `api?`；`OpenAgentOptions.openSessions`（`:99`）删除，
`session-factory.ts:307` 与 `:365` 两处构造不再传表。

### 4. `adopt` 的契约：**先到先得，不覆盖，不抛**

今天 `OpenSessions.ensure`（`open-session.ts:119-125`）逐字就是"首触由工厂建、之后原样返回"。`adopt` 必须继承
这条，而不是"最后一次写赢"：

- **覆盖会把三样东西换掉**：在飞的队列、订阅集合、跨栈 run 槽。这三样正是 ADR-0007 §4 判为"不能从磁盘重建"
  的那份状态——重开一个新状态装进去，等于把用户在运行中敲的消息和窗口的订阅一起丢掉，而这正是地图
  "打开即建、无人看且无运行即清"那条判据要保护的东西。
- **不抛**：同一 id 再 `adopt` 是幂等，不是错误。今天的 `ensure` 也不抛；hub 的 `opening` 表已经把并发开同一个
  id 挡在外面（`hub.ts:424-449`），`mountSession` 则是"先种表、再把 host 挂上"的第二条路——两条路撞上时，
  静默无操作是不新增失败模式的那个答案。
- **表的读点仍然只有一个**：`private readonly sessions` + `agentStateOf(id)`（08 把 `entryOf` 改名），缺失即抛
  `Session is not running: ${id}`，语义不变。**不公开 getter**，而这不影响接管者判"无人看"：判据的读取本来就
  发生在 Agent 内部——地图那条"Agent 提供 `evict` 并自己再判一次"说的就是这个，hub 只发 `evict(id)` 这个请求，
  自己手里那部分（claim 数、`hosts`）它本来就有。今天 hub 判删除资格用的也全是公开面
  （`hub.ts:622`：`hosted.claims`、`snapshot.submitting`、`hasPendingApprovals`），没有一处读条目。

### 5. hub 的两条 open 来源不受影响，03 号票的删 `pending` 也不受影响

装配只吃 `Session`，所以 `hub.open` 里"从 `pending` 还是从盘上取"这个分支**留在 hub**，`assembleSession` 一行
不改。等 03 把 `pending` 删掉，`open()` 只剩一条取 `Session` 的路，这里也不动。

顺带一处必须交代的连带项：`ensureSession` 今天最后一句 `sessionManager.adopt(options.session)`
（`session-factory.ts:266`）是"id 立刻答得出那个袋"的保证。**它不归本票**——`SessionManager` 的按 id 缓存是
10 号票删的，`adopt` 那条路随它一起消失；而在那之前，装配产出的 `state.session` 就是那个袋，`adopt(state)`
之后 id 由 Agent 的表回答（"未落盘的也答得出"这半边归 03）。本票只要求：装配返回的 `state` 里装的就是调用方
交进来的那个 `Session`，不是它的副本。

### 6. 删除权跟着表走（这条是删掉 `sessions?:` 的真正理由）

今天表的删除在 hub 三处：两处 `openSessions.delete`（`hub.ts:639` 删一个会话、`:804` 收摊）与一处
`clear()`（`:669` 关整个 hub）。表搬进 `Agent` 之后 hub 手上没有表，三处这样落：

- 前两处 → `agent.evict(id)`。两处要的都是同一件事——**把这条会话的 live 半丢掉**——而 `agent.close(id)` 今天
  就不干这件事（它只 abort + `settle`），所以别把"停跑"和"丢表"合成一个动词；判据归 04。
- `clear()` → **不需要替代品**。它是"进程收敛时把整张表倒掉"，而表现在长在编排层上：hub 关掉就是进程里那个
  Agent 关掉，`Agent` 自己那条 `close(id)` 循环走完，表随对象一起消失。为一个"整表清空"的动作造一个
  `agent.clear()`，等于给下一次误用留一条绕过逐会话判据的路——这正是 04 号票要堵的。

**若构造函数还收一张注入的表，"Agent 自己再判一次"就没有落点**：hub 仍能 `clear()` 一张 Agent 正在读的表，
而 Agent 无从知道自己被判空。这不是"多一个便利参数"，是把**表的写者与删者各变成两个**——§3 决定不注入表、
这一节决定删除权归 Agent，是同一条论证的两面。

### 7. 测试走哪条门

- **`scripts/mount-session.ts:55` 是真正的样板**：它在 hub 的 `Agent` 已经存在之后种一个状态（为了让一个脚本
  用上内存设置袋）。改成 `hub.agent.adopt(state)` 之后，`HubInternals.openSessions` 这个 cast 字段整条删掉
  ——测试不再需要穿透，因为公开入口就是它要的那件事。
- **`scripts/smoke-sessions.ts:884-910` 那段测的是 `OpenSessions` 自己的契约**（首触建、同 id 同条目、`delete`、
  `clear` 后重建）。14 号票删掉该类后，这段改成 Agent 的表契约，断言换成行为：两次 `adopt` 之后队列与订阅
  **没被换掉**、`evict` 之后重开是新的、没开过的 id 上 `snapshot` 抛。
- **`scripts/smoke-sessions.ts:141` 的 `(hub as unknown as { openSessions }).get(id)`** 改成读行为
  （`agent.snapshot(id)` 或该脚本已有的探测点）。这是 12 号票的落点，登记在这里以免漏。

### 8. 落点（本票代码一行未动）

| 下游票 | 它从本票拿走的东西 |
|---|---|
| 06 ADR | 反 (b) 的三条理由（尤其"构造依赖即权限"与"冷读共用一次装配"）；"登记处从 hub 搬进 Agent"的正确读法是**表的所有权搬家，不是装配搬家** |
| 07 类型 | `AgentState` 由 `assembleSession` 产出（`fillSession` → `fillSettings` → `live` 的**顺序**仍由 08 的接线定，本票只定"谁调这条链"）；私有 `assemble()` 保留给冷读；`AgentState` 里没有"谁装的"这回事 |
| 08 接线 | 表落在 `Agent`（`private readonly sessions`）、`entryOf` → `agentStateOf`、`adopt` 公开且先到先得、`AgentConfig` 删 `openSessions`、`OpenAgentOptions.openSessions` 删、`session-factory.ts:307` 与 `:365` 两处构造不再传表、`SessionServices` 删掉且 `SessionAgentServices` 断开 `extends`、`openAgent` 加一行 `adopt` |
| 12 hub | 删 `openSessions` 字段（`hub.ts:226`）与构造里的那一次传参（`:278`）、`sessionOptions` 不再传表（`:740`）、两处 `delete` 改 `agent.evict`、`clear()` 删除、`mountSession` 的 cast 字段删除、三处 `ensureSession` 调用改名 |
| 14 删旧 | `OpenSessions` / `createOpenSession` 清零；`ensureSession` 的导出、`AGENTS.md` 的 `assembly` / `OpenSessions` 两条术语、`docs/architecture.md` 三处（`:72` 整句失效，`:76`、`:79` 是名字）一并改 |
| 15 验证 | 全量 smoke；`smoke-sessions` 那两段的改写见第 7 节 |

**对 08 号票正文的一处修正**：08 现在写着「`AgentConfig.openSessions` 换成 `sessions?`，缺省自建（01 号票定的
接法）」。那句话**作废**——01 定的是相反的一半（不注入表，`adopt` 是唯一入口）。08 其余清单（字段搬家、
`stateOf` 换 `agentStateOf`、`modelSelection` 的去向）不受影响。

### 决定记录（下游可以直接依赖的）

| # | 决定 | 直接约束谁 |
|---|---|---|
| 1 | 装配点唯一且留在工厂（`assembleSession`）；`Agent` 不新增 `SettingsManager` 依赖 | 06、07、08 |
| 2 | `Agent` 持有 `private readonly sessions: Map<string, AgentState>`；**唯一入口是 `adopt(state)`**；`AgentConfig.openSessions` 删除，**不**换成 `sessions?: Map` | 07、08、12 |
| 3 | `adopt` 先到先得：已有该 id 时不覆盖、不抛（继承 `OpenSessions.ensure` 的语义）；不公开 getter | 08、13 |
| 4 | 删除权随表：hub 不再有表，`evict`（判据归 04）/ `close` 由 `Agent` 承担；`clear()` 取消，表随编排层对象一起消失（不造 `agent.clear()`） | 04、12、13 |
| 5 | `ensureSession` → `assembleSession`，返回 `{ sessionManager, state }`；`SessionServices` 删除、`SessionAgentServices` 断开 `extends`；冷读继续走私有 `assemble()`，**不进表** | 08、12、14 |

**本票没有回答的**（别当成已定）：未落盘的会话算不算"打开"、`pending` 与 `SessionManager.adopt` 的旧语义怎么退场
（03、10）；驱逐的完整判据与宽限期（04）；`AgentState` 的字段形状（07）与三条链的落地顺序（08）；设置变更的
写回扇出（05）。

