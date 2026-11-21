# 0030：五模块分层——domain / case / trigger / infra / app，对存储只认自己声明的端口

日期：2026-11-21 · 状态：已接受，**已落地**（分层重构六步迁移，spec 是唯一事实来源，见
`.scratch/layered-modules/`；步 1–4 骨架、core→domain、server 三分、ContextManager 先行，步 5
端口化 + 组合根翻面一次落地本 ADR 的全部决定；步 6 终验与文档收尾）
取代：[0012](0012-agent-facade.md)（部分，2026-11-21——决定 3 的「构造吸收」保留，但原料从 homes
换成注入的端口，`AGENT_HOME` 出 domain 归组合根，见该 ADR 的取代者注记）、
[0023](0023-holds-into-session-manager-veto-delete.md)（部分，2026-11-21——holds 表自
SessionManager 迁 infra 的 session-store 实现，hold 契约三条进 SessionRepository 的接口文档；
「server 与编排层不感知」升级为「domain 也不感知」）、
[0028](0028-settings-ownership-per-manager.md)（部分，2026-11-21——「不共享读写抽象」的精确化：
三个设置持有者共享的是 infra home-json 的字节级 I/O 原语，规范化与迁移编排仍各簇内联，见该 ADR
的取代者注记）、[0016](0016-loop-is-orchestration.md) 的取代者注记里「ADR-0030 随步 5 落笔」的
预期、[0006](0006-services-drop-instance-state.md) 与
[0010](0010-llm-folded-into-core.md) 的同款预期
取代者：[0031](0031-context-folded-into-session.md)（部分，2026-11-21——决定 5 的「domain 四子包
互不依赖」改为三子包：context 并入 session，R2 子包清单收窄为 llm / session / tool；R1 升为六模块，
`domain → { prompt }`、`infra → { domain, prompt }` 两条新边，prompt 是对本仓零依赖的叶子库；
§4.5 不端口化清单里的「AGENTS.md/CLAUDE.md 收集」随端口化推翻——`AgentsMdRepository` 端口住
prompt 包、infra 实现、组合根注入，R3 的 agents-md 路径豁免删除。端口纪律与五模块分层其余全部
决定不变）

设计过程见 `.scratch/layered-modules/`（map + 01–09 号票 + spec；spec.md 把全部决策汇成执行者
不再需要做任何决定的记录，本文只收编其中跨模块的骨架）。

## 背景

分层面之前的形状：core（无头 agent）与 server（传输 + hub + boot）两个包，desktop 与 web 是
外壳与客户端。core 对存储是**直接**的——`SessionManager` 自己握住文件 I/O、各设置持有者直接
读写自己的文件、`AGENT_HOME` 作为一个模块级常量住在 core 的 types.ts 里，谁 import 谁知道真实
的 home。测试接缝靠进程级全局（`setSessionsDir`）与 home 参数透传，domain 里留着「缺省真实
home」的知识。

这套安排能跑，但两件事越绷越紧：

1. **domain 与文件系统的耦合没有形状。** 「会话是两个文件」（0008）是格式知识，「文件放哪、
   怎么写」是存储布局知识，「此刻谁在改变这对文件」（0023 的 holds 表）是并发簿记——三者都住
   在 SessionManager 一个文件里，想换存储（事务型、远端）意味着重写 domain 的一半。
2. **传输面与域词汇的边界靠自觉。** server 的 controllers 直摸域对象、frames 拼域词汇，路由、
   帧序、行折算、编排装配住在同几个文件里——包的形状不再回答「谁可以知道什么」。

## 决定

**1. 五模块，各一句话职责。**

| 模块 | 职责 |
| --- | --- |
| **domain**（`@my-agent/domain`） | 无头 agent 本体：编排层 `Agent`（引擎、会话表、命令、审批、投影）、四子包（context / llm / session / tool）、managers——对存储只认自己声明的端口。 |
| **case**（`@my-agent/case`） | 会话应用层：`SessionHub` 原样（订阅表、baseline 交付、行折算、birth / fork / rename / remove、close），trigger 与 web 共用的类型网关（协议信封）。 |
| **trigger**（`@my-agent/trigger`） | 传输面：REST 路由与控制器、mux / wire / frames、静态文件——**域盲**（域词汇一律经 case 的 protocol 网关到手），对 infra 至多纯 fs 读（服务 web/dist）。 |
| **infra**（`@my-agent/infra`） | 存储实现：实现 domain 声明的全部端口（会话文件对、home JSON 文件族、tool-results 归档），hold 闸住在这里。 |
| **app**（`@my-agent/app`） | 组合根：把 home 路径翻译成 infra 实现、注入给 domain、构造 case 与 trigger、`start(options)` 启动与 close 编排。没有 CLI，入口是程序化的 `start(options)`；浏览器 dev 走薄脚本。 |

依赖图与静态守卫（`scripts/check-layering.ts`，一个用正则的小脚本，接进 `npm run check`——
界线由守卫背书，不由 review，ADR-0012 的先例）：

```
app → 全部；trigger → { case, infra(仅纯 fs 读) }；case → domain；infra → domain；
domain → 零本仓依赖。desktop → app、web → case（type-only），不进守卫扫描面。
```

**2. 依赖倒置：domain 对存储只认自己声明的端口。** 端口面 = 触盘动词，五个：

- **SessionRepository**（11 方法 + hold 契约三条写在接口文档里）：会话文件对的读写不分——
  locate / isDeleting / fill / readSnapshot / loadEntries / createPair / appendEntry /
  writeSnapshot / remove / scanPairs / scanLedger。同步/异步划分保端口的过去：袋式写路径同步
  （引擎轮次中同步追加），发现半与 remove 异步。fork 走**哑读**（readSnapshot + loadEntries，
  不走 fill 的 prune 编排）；`hasConversation` 闸（第一条消息才诞生）**留 domain**——对话知识，
  domain 判断后调 `createPair`。
- **SessionDefaultsRepository / ModelRepository / ToolDefaultsRepository**：三簇设置同形接口
  （`read(file)` / `write(file, layer)`，`file` 是文件名）——文件名与迁移编排留 manager（簇知识），
  infra 的 home-json 实现负责 join home + temp+rename。一个实现满足三份声明。
- **ToolResultsRepository**：只写（`writeIfAbsent`）——今天没有任何代码读归档，读不进端口；
  清理不发明。

**不端口化清单**（换 mysql 也不变的固有本地事实）：用户工作目录的 AGENTS.md/CLAUDE.md 收集、
六个工具的文件读写与 shell 执行、路径解析；llm 的供应商 HTTP（`ChatTransport` 已是缝）。

**3. 端口归消费方声明**——消费方包内专用 `xxx-repository.ts`，**不设独立 ports 包**。infra
按存储域一个实现文件（session-store / home-json / tool-results），import domain 的类型。

**4. hold 下沉 infra。** 0023 的 holds 表（`Map<fileKey, { holds, closing? }>` 原样）自
SessionManager 迁 infra 的 session-store 实现；Manager 的进闸出闸变成端口方法的**原子性承诺**
（每个触碰文件对的方法对该文件对原子），闸、closing、复活守卫是实现内部细节。domain 连闸的
存在都不知道，只见 `UnknownSessionError` 与撞闸拒绝的语义。`removeGate` 测试缝随迁 infra、
**保持模块级导出**（不给组合根的构造面添测试参数），消费者 smoke 重指；`migrateLegacyStore`
随迁。hold 契约三条（原子性、错误语义、fill 的副作用）写进 SessionRepository 接口文档。

**5. domain 四子包互不依赖 + 根 types.ts 共享内核。** `domain/src/agent/` 套一层，context /
llm / session / tool 四子包只准 import 根 `types.ts`、node 内建与外部依赖，互不 import 哪怕
单向；被别的子包消费的定义独占在根 types.ts（消息族、`Tool` 一族、模型事实族、SessionEntry
族与政策常量）。守卫 R2 扫这条；R3 扫「domain 禁 fs，例外 tool/ 包与 agents-md 收集」。

**6. case 兼作协议信封与类型网关。** wire 信封（ServerFrame 一族）住 `case/src/protocol.ts`
并 re-export 客户端与触发面需要的域词汇（含 `UnknownSessionError` class——404 映射要
instanceof）。理由：trigger 域盲（禁 import domain），而 frames 今天就要信封与错误类型，所以
信封必须住在 trigger 可达的最近一层；web 的 import 面保持单一来源
（`@my-agent/case/protocol`）。

**7. 测试缝的形状变化**（本 ADR 唯一的显式边界，生产面零变化）：`setSessionsDir` /
`sessionsDir` 消亡——会话 store 随 `settingsHome` 派生（`<settingsHome>/sessions`）；
`setRemoveGate` 迁 infra 后重指；`settingsPath` / `modelsPath` 消亡（文件名 join 进 infra 的
home-json 实现）；`AGENT_HOME` / `APP_NAME` 迁 app。smoke 的播种方式随之改形：起 server 的传
`settingsHome`，domain/case 级的自造 infra 实现指临时目录注入。

## 后果

换来的：

- **domain 的存储可替换性第一次有了形状**：换存储 = 换 infra 的三个实现文件 + 组合根一行注入，
  domain 与 case/trigger 一个字不动。「换成事务型存储的那天这张表跟着消失」（0023）从论断变成
  一条可以真的走的路。
- **home 是路径不是端口**：app 是唯一把 home 翻译成 infra 实现的地方，一个 home 指全隔离
  （smoke 的 store 缝与 settings 缝合一），domain 里「缺省真实 home」的知识清零。
- **包的形状回答「谁可以知道什么」**：域词汇的可达面由 import 规则机械保证，trigger 域盲由
  守卫背书。
- desktop 外壳的依赖声明换 `@my-agent/app`，`main.cjs` 的动态 import 换包名；web 只换 type-only
  的信封来源，其余不动。

背上的：

- 端口方法各自原子，闸不再包住调用方的内存变更——被拒绝的写先把变更留在袋里，靠「袋随调用
  栈消亡」不外泄（文件与 REST/mux 面不变）。
- 多一层组合根：跨包的新增动「包 + 端口 + 注入」三处，而不是一处。
- fill 的错误语义收紧为 `UnknownSessionError`（契约 #2）——打不开的配对一律读作「没有这个
  会话」，诊断细节由 prune 的磁盘事实与日志承担。

## 不可逆性与代价

五包的依赖方向由守卫钉死，回退到「core+server 双包」意味着拆掉端口与网关两套缝；这不是本 ADR
想保留的退路——值得保留的退路在端口**之下**（换 infra 实现），不在分层**之上**。真正的代价
是每次跨模块改动的三处同步；换来的是每处改动的知识边界都由 import 表说话。

## 被取代的是什么

- **0012 决定 3 的「homes 与 api 透传」半**：工厂仍吸收 manager 构造，原料从 homes 换成注入的
  端口；「缺省真实 home」不再是 domain 的知识。公开面三类方法、窄读一族、守卫思想全部不动。
- **0023 的 holds 住址**：闸簿记迁 infra，进闸出闸变成端口方法的原子性承诺；「core 的 Agent
  不再有 hold / release 动词」原样成立且更深——domain 连闸的存在都不知道。
- **0028 的「不共享读写抽象」字面**：三个设置持有者共享的是字节级文件 I/O 原语（infra
  home-json 的 read/write）；规范化与合并函数、迁移编排仍各簇内联、一行不共享。
- **0016 / 0006 / 0010 取代者注记里的「ADR-0030 随步 5 落笔」预期**：本文即那笔。

## 没有被取代的

- 0008 的两文件格式、0013 的表只装 live 半、0014 的扁平 store、0021 的懒会话身份、0027 的行
  现算——全部原样，只换了实现者的住址。
- 0011 的 ToolManager 常驻实例表、0023 对 0006 的第二个例外——端口化不触碰内存形态。
- ContextManager 的构造零依赖与编排半（ADR-0016 的判据）——步 4 已落，端口化不重开。
