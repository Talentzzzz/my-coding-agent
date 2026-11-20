# 端口方法集设计

Type: grilling
Status: resolved

## Question

五个存储端口各自的精确方法面是什么？声明落在哪个包的哪个文件？infra 侧实现文件怎么划分？

具体待定：

- 会话文件对存储：账本追加、快照读写、fillSession 重放所需的原子的读、删除（rm 文件对）、
  目录扫描（`listDirectories` 的冷半）——一个端口还是按读写分？端口类型用 domain 的
  Entry / Snapshot 类型。
- `models.json` / `tools.json` / `sessions.json` 三个设置文件的端口：每个 manager 一个窄端口，
  还是一个 home 文件端口的三个视图？
- tool-results 归档（`.my-agent/tool-results/`）的端口：写 + 读 + 归档清理的方法面。
- 每个接口声明在哪个包的哪个文件（session 包的 types.ts？专用接口文件？）。
- infra 侧实现文件划分：`packages/infra/src/` 里按端口一个文件还是按存储域一个文件？
- smoke 的接缝（`settingsHome` / `modelsHome` / `chatTransport` / `toolManager`）在新世界怎么
  表达——smoke 自己当组合根，还是 app 提供测试组装？
- hold 闸下沉后的并发语义怎么在端口契约里说清（端口方法各自的原子性承诺、`UnknownSessionError`
  的抛出点归谁）。

前置：[端口化决策](04-portization.md)（已决：全存储端口化、消费方声明、hold 下沉）。

## Answer

- **端口面 = 触盘动词；袋子上的树操作不进端口**。今天 SessionManager、三个设置持有者与 spill 里
  所有触碰文件的方法进端口；`getBranch` / `buildContextEntries` / branch points 一族等袋上树操作
  原样留 session 包。同步/异步划分保今天：袋式写路径同步（引擎轮次中同步 `appendMessage`），发现
  半与 `remove` 异步——`hasSessionsFor` 随 `scanPairs` 异步化，REST 面不变。
- **SessionRepository（会话文件对）——一个端口，读写不分**：唯一消费者是 Agent 编排，冷读热写它
  全用，拆开只让编排拿两个对象。方法面 11 个（名字暂定，票 10 机械核对）：
  - `locate(id): string | undefined` —— id → `.jsonl` 路径，一次 stat；
  - `isDeleting(id): boolean` —— ADR-0023 否决式删除那一拍，读作「不存在」（`isDeletingSession`
    门面的支撑，是 domain 可观察语义，不是闸簿记）；
  - `fill(absJsonl): { meta, entries }` —— 冷读；配对检查+版本拒绝+prune 的编排归 infra（文件层
    卫生，与 hold 闸同类）；撞闸、复活守卫、打不开都以 `UnknownSessionError` 拒绝；
  - `readSnapshot(absJsonl): SessionMeta` —— 不 prune 的快照读（fork 源半、`recordedOnDisk`）；
  - `loadEntries(absJsonl): SessionEntry[]` —— 不 prune 的账本整读（fork 源半；fill 内部也用它）；
  - `createPair(absJsonl, entries, meta): void` —— 诞生与 fork 写目标半共用：两文件 `wx`、快照
    最后写（提交标记）；
  - `appendEntry(absJsonl, entry): void` —— 单行追加；
  - `writeSnapshot(absJsonl, meta): void` —— temp+rename 整体重写；
  - `remove(id): Promise<void>` —— 两步 rm，闸罩全程；
  - `scanPairs(): Promise<{ absJsonl, meta }[]>` —— settle 冷半：readdir+配对+prune+空流检测；
  - `scanLedger(absJsonl, visit): Promise<void>` —— 发现半流式行泵：infra 泵行+JSON.parse，
    派生（messageCount / 文本 / parentOf / leafId）留 domain 回调，内存特征与今天一致。
  - 两项子裁决（非方法）：fork 走哑读（今天 fork 不 prune，复用 fill 是行为变化）；
    `hasConversation` 闸（第一条消息才诞生）留 domain——对话知识，domain 判断后调 `createPair`。
- **三个设置文件端口——home JSON 文件族原语、各簇一个声明**：接口形状
  `{ read(file): Record<string, unknown> | undefined; write(file, layer): void }`（undefined =
  不存在），文件名留在 manager——簇知识，今天就在那：自己的文件（`tools.json` / `models.json` /
  `sessions.json`）之外，legacy 迁移源（旧 `settings.json`、退场持有者的 `engine.json`）也经同一
  端口按名现读。三个 manager 各自在自己包里声明同形接口
  （04 的消费方声明原则，结构化类型让 infra 一个实现满足三个声明）：
  - `session/session-defaults-repository.ts` → `SessionDefaultsRepository`（sessions.json）；
  - `llm/model-repository.ts` → `ModelRepository`（models.json）；
  - `tool/tool-defaults-repository.ts` → `ToolDefaultsRepository`（tools.json）。
  - **迁移编排留 manager**：「什么时候迁移、捡哪些键、补不补默认、engine.json 优先」是簇知识，
    原样留在各 manager 的 load / toolState 分支，经同一端口跨文件现读；infra 不懂「settings.json
    是 legacy」。语义窄端口（`readLegacyLayer` 一类）被否——models 还要 engine.json，接口特设化。
  - ADR-0028 张力的精确化：端口共享的是**字节级文件 I/O**；规范化/合并函数（`viewOf` /
    `approvalOr` / `mergeLayers` / `retryOr`）仍各簇内联、一行不共享。票 10 给 ADR-0028 加一条
    精确化说明。
- **ToolResultsRepository（tool-results 归档）——只写**：`context/tool-results-repository.ts`，
  方法面就一个：`writeIfAbsent(absPath, text): boolean`（不存在才写+mkdir，失败 false 回落硬截断）。
  **读不进端口**——今天没有任何代码读归档（模型用 read 工具，用户工作目录 04 已决不端口化）；
  **清理不发明**——今天不存在这套逻辑，零行为变化约束下不做，将来要做先改本票。
  `spillPathFor` 留 context 包：relPath 是模型可见视图文案的一部分，路径规则是视图知识不是字节
  I/O；端口收 absPath，infra 最哑。实例由编排层持有（构造注入），经参数表递给
  `spillOversizedToolResult` 与 `archiveToolResult`（06 的 ContextManager 零依赖约束）。
- **声明落点——每端口一个专用 `xxx-repository.ts`**：接口类型名 `XxxRepository` 与文件同名。会话
  包两个端口分两个文件（文件对端口大、sessions.json 原语小）。**显式修订 04 的措辞**：04 说
  「在自己的 types.ts 里声明」，本票细化为「消费方包内专用 xxx-repository.ts」——types.ts 是值
  类型的家，11 方法+并发契约文档的接口混进去会稀释；04 的两原则（消费方声明、不设 ports 包）不变。
  票 10 记录时引用 04 摆明这一条。
- **infra 实现按存储域，不按端口**：`packages/infra/src/session-store.ts`（会话文件对全家：11 方法
  实现 + hold 闸 + `removeGate` 测试缝随迁；**旧 session 目录布局 → 扁平 store 的迁移**也归它——
  那是文件布局卫生，与 Q5 留在 manager 的**设置簇** legacy 迁移是两回事）、
  `packages/infra/src/home-json.ts`（一个实现满足三个同形声明；构造收 home，`modelsHome` ≠
  `settingsHome` 时组合根各造一份）、`packages/infra/src/tool-results.ts`，`index.ts` 导出面给
  组合根。
- **smoke 自己当组合根**：core/domain 级 smoke 直接构造 infra 实现（指临时目录）注入；
  `setSessionsDir` 进程级全局**消亡**（端口注入取代）；`removeGate` 随闸下沉 infra 实现（模块级
  导出或构造 option，机械细节票 09 定）；`chatTransport` / `toolManager` / `sink` 三缝不动——它们
  是 domain 缝不是存储缝。起 server 的 smoke 走 `app.start(options)` 的覆盖面，那个面归 08；
  `createSessionAgent` 的 options 面是否随之改形（homes → 端口注入），也归 08 裁决。
- **hold 契约三条**（写进 SessionRepository 的接口文档）：
  1. **原子性**：每个触碰文件对的方法对该文件对原子；闸、closing、复活守卫是实现内部细节；跨方法
     无事务（与今天一致）。
  2. **错误语义**：`UnknownSessionError` 类型声明归 domain session 包（消费方词汇），infra 抛出
     （infra→domain import 合法）。撞闸、复活守卫失败、fill 打不开、remove 未知 id——全部读作
     「没有这个会话」。
  3. **fill 的副作用**：fill 是一次可能删除文件的读取——打不开的配对先 prune 再抛；编排层接受这个
     事实但不依赖其细节。
  `remove` 的两步 rm 顺序（先 `.json` 后 `.jsonl`）不进契约正文——实现买的中间态语义，契约只承诺
  「返回时文件对已不存在；中间态的一切读答『不存在』」。
