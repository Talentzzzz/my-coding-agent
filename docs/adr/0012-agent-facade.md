# 0012：server 只认 `Agent` 公开面——Manager 的消费者收进 core，构造由 `createSessionAgent()` 吸收

日期：2026-11-07 · 状态：已接受，**已落地**（hub-agent-facade 01–07 号票，见
`.scratch/hub-agent-facade/`；`npm run check`（tsc ×2 + tokens + 本 ADR 落地的机械守卫
`scripts/check-server-facade.ts`）与 `npm run build:web` 绿，八条验收 smoke 与改动前基线逐条
同色、零新红——`smoke-approval` 两侧都带同一条预存在的偶发闪失（wire 层非 JSON 下行，票 04
已在未改基线上复现），另十四条 hub 相关 smoke 全 PASS）
取代：[0006](0006-services-drop-instance-state.md)（部分，2026-11-07——决定 6 的**消费面**
叙述：hooks、transport、systemPrompt 留在构造注入上这一半一字不动；被取代的是「这组进程级
东西由 hub 装配、在它手里协调」的旧叙述——三只 Manager 的构造收进 `createSessionAgent()`，
它们在本进程的唯一消费者是 core 的编排层，hub 从协调者退为只认公开面的调用者）、
[0011](0011-tool-manager-instance-table.md)（部分，2026-11-07——决定 7 的「hub 冷热两条路
共用**自己那只**」那一半：工具表仍全进程只装配一只，但它住编排层手里，hub 不再持任何表）

设计过程见 `.scratch/hub-agent-facade/`（map + 01–08 号票；01–03 号票是裁决、04–07 号票是
执行，本 ADR 是 08 号票的收账）。

## 背景

本 ADR 之前的形状，要从三份 ADR 合起来读：[0006](0006-services-drop-instance-state.md) 定了
五个无属性单例（编排层 + 四只服务），会话状态表收进编排层（现由
[0013](0013-table-holds-live-half-only.md) 表述），[0011](0011-tool-manager-instance-table.md)
给工具域立了一张常驻实例表。落出来
的装配是：`SessionHub` 持有三样服务字段（`sessions: SessionManager`、`settings:
SettingManager`、`tools: ToolManager`）外加一个编排层，三只 Manager 由 hub 造、作为
`AgentConfig` 递进编排层；「要自己的设置」的冒烟经 `HubOptions.settings` 注入一只内存
manager。

这个形状里 server 包**知道** Manager，而且到处知道：

- controllers 直摸 `hub.settings.…` 约十处；projection 直摸 `hub.agent.sessionManager` 与
  `agentState().session`；hub 自己为 fork、rename、remove、冷读各写一条 held/cold 分支。
- 编排层的 `agentState()` 与 `sessionManager` 字段是公开的，状态对象
  （`AgentState` / `Session`）原样流到 server 侧。
- 「server 不得触碰 Manager」从来不是一条被写下或被检查的界线——它只是碰巧没有人系统地
  越过。每加一个窄读（侧边栏的时间戳、标题、提交位），server 就多一处伸手进袋子的调用点。

问题不在哪一处越界，而在界线不存在：读 server 代码的人必须知道三只 Manager 各自的形态
才知道什么不能碰，而这件事没有任何一处机器替他记着。

## 决定

1. **`Agent` 公开面三类方法，server 及以下只调它们。** 对账（票 01）把 hub、controllers、
   projection 摸 Manager / 状态袋的每个调用点列全，逐一落到三类：
   - **会话生命周期**，held/cold 两路在编排层内部统一、调用点不再写分支：
     `snapshotOf(id)`（held 走表、cold 走 open + `readSessionSnapshot`）、`hold(id)`（held
     走表、disk 走 replay + open，hub 不再写 `has` 分支）、`setTitle(id, title)`、
     `forkFrom(sourceId, entryId)`（源路径解析在门面内部，`HostedSession` 不再为它持目录）、
     `create(workDirAbsPath)`。
     后续收口（2026-11-09）：`has(id)` 收成 class-private——表成员资格是编排层的内部事实。
     再收口（2026-11-10）：`ensure(id)` 换成一对 `hold(id)` / `release(id)`——hold 计数搬进编排层
     （它是那张表的驻留期，不是连接的兴趣），`ensure` 降为类私有 `materialize`；hub 的 `hold` /
     `release(host)` 只是把每次连接进出转手一次，"我要用它"成为开形状动词，而"这个 id 在不在内存里"
     不再是调用方的问句。
     再收口（2026-11-10）：`exists(id)` / `isOnDisk(id)` / `removeFromDisk(id)` 三个判据从
     公开面删除，换成一次删操作 `remove(id)`——「有没有文件、表里有没有」是删除内部的事，
     没有文件（创建未发言）就只忘状态，文件名不响就以 `UnknownSessionError` 拒绝。同一轮把
     「未知会话 → 404」变成类型：core 抛 `UnknownSessionError`，HTTP 边界（`internalError`）
     映射 404，于是 controllers 的五处 `if (!hub.has(...)) throw notFound` 与 mux 的 open
     前置检查一并消失——检查由被调命令自己说。`evict` / `drop` 维持公开——它们是出表动词，
     逐出边缘逻辑留在 hub（见「没有被取代的」），需要它们。
   - **窄状态读**，全部 held-only、返回**纯数据**：`fileAbsPathOf(id)`、`isRunning(id)`、
     `titleOf(id)`、`timestampOf(id, entryId)`（消息时间戳优先、entry 时间戳兜底，hub 的帧
     与 projection 的行因此不可能对「最后活跃」各执一词）、`messageRoleOf(id, entryId)`。
   - **设置与模型目录**，无状态转发：`modelCatalog()`、`replaceModels(models)`、
     `hiddenDirectories(workDir)`、`applySettings(workDir, patch)`、`settings(workDir)`；
     扫描类静态方法同签名转发（`listSessions` / `listDirectories` /
     `findSessionRowById`），不留自由函数例外清单。
   - **（修订）打开的模型默认不收实参。** `create` / `hold` / `snapshotOf` 只收目录或 id；
     模型与档位由装配在每次打开时从设置现读（全局与目录两份 `settings.json`），boot 的
     `--model` / `--thinking` 随之删除。模型默认是设置的事实，宿主不必也不该在每次打开时
     重说一遍；`create` 里那次 `await` 就是这次现读。
2. **状态对象不出 core。** `agentState()` 收成 private，`AgentState` / `Session` 类型从
   server 可见的面消失（禁名单见决定 4）；server 需要的一切都从窄读拿纯数据。一个会话的
   状态进表仍走装配（`assembleSession` 的唯一调用者仍是编排层的装配门 `Agent.assembleInto`，
   原名 `Agent.open`，见下方后续收口），出表仍只有
   `evict` / `drop`——会话状态表的形态不动（现由 [0013](0013-table-holds-live-half-only.md)
   表述）。
   后续收口（票 08 之后）：这扇门本身收成类 private 并更名 `assembleInto`（装配并进表）——
   外界只需要**读**
   （`snapshotOf` / `readSessionSnapshot`）、**造**（`create`）与**用**（`hold` / `release`）
   三种动词，何时装配、
   递哪只会话袋子进表不再是公开面上的事；唯一越过这条 private 的是 `openAgent`
   与 hub 级冒烟的 `mount-session.ts`，各经一处有类型的 cast 过门（`AssembleAgentStateOptions`
   类型随之不再出 core；`workDirAbsPath` 覆盖参数同期删除——工作目录是会话袋子自己的
   `sessionSetting.workDirAbsPath`，所有调用点传的本就是同一个值，冷读路径从未用过覆盖）。
   再收口（2026-11-10，[0013](0013-table-holds-live-half-only.md)）：这两个内部名字跟着新形状换了——
   装配门 `assembleInto` → `assembleAgentStateBySession`（装配产物只剩 live 半，`ensure` 那一半
   继承的名字不再准确），`materialize` → `ensureState`。**公开面一个方法都没变**：`create` /
   `hold` / `release` / `snapshotOf` / `readSessionSnapshot` / `setTitle` / `forkFrom` / `remove`
   仍是本 ADR 决定 1 的那张表。
3. **构造吸收。** `createSessionAgent({ settingsHome?, modelsHome?, api?, settings?,
   tools? })` 自己造三只 Manager（`settings` / `tools` 是 test-only 缝：内存设置门、自注册
   的工具表；生产面递 homes 与 api），然后走原有的 `AgentConfig` 构造器——一条构造路，
   构造器本票不动。`HubOptions` 收缩为 `{ workDirAbsPath, sessionId?, settingsHome?,
   modelsHome?, api?, model?, thinkingLevel? }`，boot 零改动；`SessionAgentServices` 类型
   退役。编排层公开的 Manager 字段只剩 `sessionManager`（`hooks` 是接缝面、不是 Manager，照旧
   公开）——它不再是 server 的路，而是冒烟的缝（见决定 6）。
4. **「server 不知道 Manager」是机械检查的不变量。** `scripts/check-server-facade.ts`
   （`npm run check` 在 check-tokens 之后追加一步，check-tokens 同款先例：独立小脚本 +
   regex）扫描 `packages/server/src/**/*.ts`：导入禁十名（三只 Manager、`createToolManager`、
   `createSession`、`readSessionSnapshot`、`SessionAgentServices`、`OpenAgentOptions`、
   `AgentState`、`Session`——后三个是决定 2 的机器化），成员访问禁 `.agentState(` /
   `.sessionManager` / `.settings`（排除方法调用形态 `.settings(`；`.tools` 不进名单——纯
   数据字段叫 `tools` 的太多，兜不住也不必，`ToolManager` 由导入名单堵死）。范围仅 server
   包源码；scripts/ 的冒烟按票 02 的裁定保留 Manager 访问。名单加名字 = 加一行。
5. **冷路径契约落在各自方法的文档上。** `setTitle`（一冷写一次同步块、不拿 claim）、
   `snapshotOf`（不留痕：无 host、无 run、无 claim、不追加任何 entry）、`remove`（文件先删、
   再忘状态；不拿 hold、不碰 hosts/observers——那是 hub 的账）、`hold` 的 disk 半（无写窗口可保护——replay 与
   assembly 都不写盘，进表本身就是它的目的）。两个性质（写窗口、不留痕）是 per-method
   的，分开放才不会在某一侧腐化；hub 侧只留一行「为什么敢直接调」。

   **（2026-11-17 Superseded，[0023](0023-holds-into-session-manager-veto-delete.md)：仅第 5 条里
   `remove` 与 `hold` 的两处文件半描述——删除改否决式、rm 先 `.json` 后 `.jsonl` 且在 Manager
   自己的文件闸内，hub 的 hold / release 通道退场；各方法的冷路径契约本身仍成立。）**
6. **两处顺延的收口**（票 05 连带标记、票 07 落定）：全仓零消费者的 `workDirOf` 删除（对
   票 01 窄读清单的偏离，授权在票 05「去留随票 07」）；`fileAbsPathOf` 留——断言改写给了
   它三个冒烟消费者。`sessionManager` 字段保持公开但改缝口径：`getEntries` /
   `getRecordedSettings` / `appendMessage` 播种这类「读袋子本身」的断言在窄读清单里本没有
   对应物，生产调用者没有这条路。

## 为什么界线要由守卫而不是由 review 背书

「server 只认公开面」是一条会烂的注释，除非机器检查它。TypeScript 层面藏导出不可行（core
与 server 同一个 tsconfig，拆 project references 远超本 feature 的规模），只靠 review 等于
没有界线。守卫是唯一既便宜（一个脚本、一份名单）又不腐烂的选择——它与 `check-tokens` 对
设计 token 的守卫是同一个先例：被引用却不存在的东西直接报错，而不是等 review 记得。

## 后果

换来的：

- **server 包成为编排层的一个纯客户端。** 读 `hub.ts`、controllers、projection 不再需要
  先学三只 Manager 的形态；「会话怎么开、怎么 fork、怎么删、冷读代价是什么」每条都在
  `Agent` 公开面的方法文档里。
- **held/cold 分支从调用点消失。** 从前 hub 为每条命令写两路（表内一路、磁盘一路）；现在
  分支住在门面方法内部，调用点一行。
- **一个窄读有且只有一个答案。** `timestampOf` 的取时规则在门面里，hub 的帧与 projection
  的行读同一个实现——从前两处各读各的，靠巧合一致。
- **装配的诚实是构造出来的。** 「表里每份状态都装配自编排层自己的服务」从一条约定变成
  一个构造事实：工厂造好 Manager 再走构造器，调用者递不出第二只。

背上的：

- **`Agent` 的公开面宽了一截。** 三类二十一个方法（含票 04 增补的 `messageRoleOf`），其中
  窄读一族是为「状态对象不出 core」付的价——每一条 server 需要的窄读都得在门面上有名有
  姓，而不是让 server 顺手读一个字段。
- **（修订）模型默认三个方法都不收实参。** 它不进编排层，早期版本因此让每个打开形状的方法
  多带一个可选实参；现在默认只在设置里、装配每次现读——编排层仍不持宿主事实，这份代价换成
  了装配的一次文件读。
- **守卫名单要跟着公开面长。** 今后 core 新增一个 server 不该碰的出口，守卫的禁名单就得
  加一行——漏加不报错，名单不是完备性证明，只是已知名单。
- **冒烟的种子方式变了形状。** hub 级冒烟不再注入内存 manager，改为临时 homes + 一次性
  `SettingManager` 播种（`applySettings` + `replaceModels` 写进临时文件，复用 coercion）；
  门面每读现取，盘上临时文件与内存存储语义等价，但「直接递一只内存 manager」这个更省事
  的形状没有了。

## 不可逆性与代价

三条门槛逐条成立：

- **难逆转。** 回去要把十九个门面方法拆掉、hub 的 held/cold 分支逐条写回、三只 Manager
  的构造从工厂挪回 `HubOptions`、守卫脚本删除、四个冒烟的播种方式再改一次——不止一处。
- **没有上下文会让人困惑。** 0006 写「五个单例可构造注入」，0011 写「hub 冷热两条路共用
  自己那只」表——两份 ADR 都还立在原处，而代码里 hub 既不注入也不持有任何 Manager，连
  构造编排层的那一行都是工厂包办的。第一反应必然是「构造注入哪去了」。这份 ADR 就是那个
  「注入还在构造器上，只是递东西的手从 hub 换成了工厂」。
- **是真实取舍。** 放弃的是「server 直读状态的便利」与「注入内存 manager 的直捷测试缝」，
  换来的是一条被机器守着的服务边界。窄读一族是这个取舍的定价：每一条便利都要在门面上
  正式立户，而不是顺手摸一把。

## 被取代的是什么

逐条对照：

- **[0006](0006-services-drop-instance-state.md) 决定 6 的消费面。** 原文的主体——hooks、
  transport（含 retry 策略）、systemPrompt 构建函数是进程生命周期内不可变的配置，留在
  构造函数上——**一字不动**；工具域那一半已由 0011 处理。被取代的是围绕它的旧叙述：这组
  进程级东西「由 hub 装配、在 hub 手里协调」。今天的装配是 `createSessionAgent()` 造好三只
  Manager（含 transport 的默认解析与 hooks 默认值的安装）再走构造器，编排层是它们在本
  进程的唯一消费者，hub 贡献给构造的只有 homes、api 与模型选项。0006 头部的取代者指针与
  决定 6 的就地标注都指向本 ADR。
- **[0011](0011-tool-manager-instance-table.md) 决定 7 的「hub 持表」那一半。** 原文
  「进程里只装配一只（hub 冷热两条路共用自己那只，`openAgent` 转交 `assemble` 造的那只）」
  ——「只装配一只」原样成立（表的单写者、只增键、四法公开面全部不动），不成立的是
  「hub 自己那只」：表现在由工厂造、住编排层手里，hub 的冷热两条路（读快照、跑会话）经
  同一个编排层到达同一只表。0011 头部加取代者指针，决定 7 就地标注。
- **server 侧的旧调用形态**（`hub.settings.*`、`agentState().session`、held/cold 分支）：
  全部改道，已无残留——这不是取代一条 ADR 决定，而是清掉从未被任何 ADR 承认过的实际
  越界。

## 没有被取代的

明确不动、读者不该跟着本 ADR 一起重开的：

- **[0001](0001-transport-websocket-mux.md) 的整条 wire 与 hub 的传输层事实。** claims、
  observers、waiting、reaping、`HostedSession`、`opening` / `closing` 全留在 hub——「谁在
  持有这个会话」是传输层的问题，编排层不回答它。REST 命令面与 mux 帧一字不改。
- **会话状态表（[0013](0013-table-holds-live-half-only.md)）。** `Map<id, AgentState>`、
  装配经 `Agent.assembleInto` 进表、`evict` / `drop` 出表、进程重启即清空——本 ADR 只把这张表的
  读取面收成纯数据窄读，表的形态与出入口不动。
- **[0011](0011-tool-manager-instance-table.md) 的实例表形态。** 一张常驻 `Map<name, Tool>`、
  四法公开面、引擎经它执行、单写者只增键——变的只是消费入口（编排层经它转发，hub 不再
  经手），表的每一条不变式原样。
- **[0006](0006-services-drop-instance-state.md) 决定 1/2 的会话域形态。** `SessionManager`
  与 `SettingManager` 仍是无属性服务：每样数据在用到它的那一行现取、不养聚合袋、可构造
  注入——本 ADR 改的是**谁**构造与**谁**消费它们，不是它们的内部形态。
- ~~**fanout 的 `SessionServices` 参数袋。**~~（2026-11-14 由
  [0017](0017-fanout-folded-into-agent.md) 取代：fanout 的读者只剩编排层一个，文件级函数并入
  `Agent` 成为私有方法，参数袋随共享的消失一并退役。）`session/fanout.ts` 曾以
  `(state, SessionServices)` 为参数形状——那是编排层把 `this` 上的服务递给无状态函数的形状，
  与「server 不知 Manager」正交；退役的构造缝 `SessionAgentServices` 与它不是同一个
  类型，这条正交性不受 0017 影响。
- **`OpenAgentOptions` 与 `openAgent()`。** 形状不动（本就是测试缝集合），唯一变化是
  `OpenAgentOptions.sessionManager` 字段成为死缝——工厂不再收 ledger，字段文档已注明它只服务于
  冷读；`Agent.sessionManager` 公开字段是另一回事，保持公开为冒烟的缝（口径见决定 6）。
  `openAgent() == create + open` 的组合照旧——只是其中那步 open 如今经类 private 的门走
  （见决定 2 的后续收口），组合本身没有拼出任何新动词。
