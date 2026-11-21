# 迁移顺序与验收编排

Type: grilling
Status: resolved
Blocked by: 06, 07, 08

## Question

spec 的脊柱：分几步搬、每步的顺序与验收是什么？

具体待定：

- 分步迁移顺序：每步结束时 `npm run check` + 相关 smoke 全绿的可验收状态是什么？
  候选思路——先立 infra 端口实现（并行于旧路径）再切 manager、还是先搬 trigger/case 等纯移动、
  ContextManager 与注入改造放在哪一步；一步一个绿状态，避免长期双轨。
- 每步的验收命令清单（五个 smoke 里哪些对哪一步有意义）。
- smoke 脚本归属：留根 `scripts/` 还是随包走？`check-server-facade.ts` 改造成依赖方向守卫的
  实现方式（静态 import 扫描？dependency-cruiser？自写脚本）与并入 `npm run check` 的时机。
- tsconfig / workspace 图的调整时机（一次到位还是随步走）。

前置：[ContextManager 的职责边界](06-context-manager-boundary.md)、
[端口方法集设计](07-port-method-sets.md)、[app 组合根的形状](08-app-composition-root.md)。

## Answer

- **总形状：六步，纯移动先行、翻面后置，每步一个绿状态**。候选裁决：「先立 infra 端口实现
  （并行于旧路径）再切 manager」被否——那就是本票点名要避免的长期双轨；「原地改造完再搬」同样
  被否——同一段代码审两遍、搬两次，且守卫规则要拖到最后一步才能激活。先搬后翻让每个后续 diff
  都落在最终地址。每步的绿状态 = `npm run check` + 基础门 smoke（见验收编排）；REST 面、mux 帧、
  会话文件格式零变化贯穿全程。步序：
  1. **骨架**：`packages/{app,trigger,case,domain,infra}` 五包建齐（package.json + tsconfig +
     stub `src/index.ts`），根 workspaces 注册、根 tsconfig 的 paths 与 include glob **一次写全**
     （stub 让 typecheck 立即可过）。**加法一次、减法随步**：此后每步只做旧名 repoint/移除
     （步 2 删 `@my-agent/core` 的 paths、步 3 删 server 的 include），不出现指向不存在代码的配置。
  2. **core→domain**：改名 + `src/agent/` 套层（02）+ `protocol.ts` 解散（05：行类型归 session
     包、其余 re-export 回归各包）一步落地；web 与 scripts 的 import 重指是本步最大的机械面
     （web 十几处 `@my-agent/core/protocol`）。验收附加：smoke-projection、smoke-default-model
     （protocol 信封与 coerceModelConfig 重指的直接消费者）。
  3. **server 三分**：hub→case、controllers/http/frames/mux/wire/http.ts→trigger、boot/main→app；
     08 的随层落位表照抄（`muxUpgrade`/`sessionListeners`→trigger、`WEB_DIR`/`CLIENT_DIR`→app）；
     desktop 依赖换 `@my-agent/app`、`main.cjs` import 目标换包名、import 失败接 observability；
     `main.ts` CLI 死、`serve.ts` 生（只收 `--vite`/`--port`/`--workDir`）、根 dev/start 委
     workspace。**两个子进程 spawn 点都换指 serve.ts**——smoke-boot（:232-234，08 已点）与
     **smoke-approval（:738-746，08 漏点、本票补上）**：同 flags、`MY_AGENT_HOME` env 承接、
     SIGTERM 落定改由脚本自己的 handler 承接（两处都因 `main.ts` 拒 `--port 0` 已用真端口，不变）。
     **守卫在本步诞生**：`check-server-facade.ts` 退役（扫描对象随 server 解散消失），新守卫接进
     `npm run check`，实现是**自写静态 import 扫描**（沿用其 `importStatements` 正则先例，import
     说明符→包名映射判方向；不加 dependency-cruiser——不加新的运行时依赖）；成员禁令（`.holds` /
     `.sessionManager` 等 ADR-0023 族）迁移继续扫 case+trigger；`scripts/` 豁免（先例原文）。
     规则集：trigger→{case, infra 纯 fs 读}、case→domain、infra→domain、domain→零本仓依赖、
     app→全部；desktop/web 不进扫描面。验收附加：smoke-api、boot、approval、mux-live、liveness、
     backpressure、stream、subscribe、mux-client、desktop-close、desktop-observability——触发面/
     启动面搬家的步，凡 import bootServer、spawn 子进程或测 wire 的全数入列。
  4. **ContextManager**（06 全量，纯 domain 内部）：总切法（编排留引擎、算法归 manager）、六文件
     映射、根 `types.ts` 共享内核收编、构造零依赖、投影函数注入、systemPrompt 注入点删除；守卫
     加**子包隔离规则**（四子包互不依赖、只准 import 根 types.ts、node 内建与外部依赖）。
     ADR-0006/0010/0016 的修订按票 10 清单在本步落笔（01 的不欠账）。验收附加：smoke-session
     （压缩与流式全链；smoke-tools 在基础门已覆盖 spill/trim 主链；smoke-replay 经查不触移动面，
     剔除）。
  5. **端口化 + 组合根翻面（07+08 全量，一步翻完）**：五端口声明落消费包、infra 三文件
     （session-store 全家**含 migrateLegacyStore 随迁**——store 今天已扁平、嵌套布局是 legacy 且
     今天就懒迁移，搬家不是发明新布局；**removeGate 保持模块级导出**——今天 `setRemoveGate` 就是
     模块级（session-manager.ts:850），消费者只有 smoke-sessions 与 smoke-api，不给 app 构造面添
     测试参数；home-json 一实现满足三声明；tool-results 只写）；hold 闸下沉；faces 翻面
     （`createSessionAgent` / `openAgent` / `HubOptions` 端口必填——耦合点就在 options 面，拆端口
     族只会让同一批调用点改三遍，不拆）；`AGENT_HOME` 出 domain 归 app；`setSessionsDir` 消亡，
     **12 个 smoke 文件、13 处调用**（smoke-approval 占两处）分两类改：起 server 的改传
     settingsHome、domain 级 `openAgent` 的自造
     infra 实现指临时目录（`createSessionAgent` 的 smoke 调用点仅 smoke-sessions 一处）；守卫激活
     **domain 禁 fs**（tool/ 包的用户工作目录事实例外）；ADR-0012/0023/0028 修订与**新增分层
     ADR**（五模块、依赖倒置、端口消费方声明、hold 下沉）在本步落笔。验收附加：smoke-approval-
     endpoint / queue / recovery、model-manager、model-settings、session-settings、tool-settings、
     settings、projection——凡构造 manager 或触盘的（12 个 smoke 文件、13 处 setSessionsDir
     调用，smoke-approval 占两处——全在本步改形）。
  6. **终验与文档收尾**：README「验证一次构建」全清单（含 smoke-api 的活服务器流程与
     MY_AGENT_HOME 临时目录保护）+ AGENTS.md（布局节、engine/compaction 术语句、ContextManager
     新条目）、architecture.md（各 package 职责、循环 §107–114、压缩 §250–266、Hook §149 住址、
     根 types.ts 头注释）、CONTEXT.md 的重写点全量落笔。本步不改代码。
- **验收编排**：基础门（每步）= `npm run check` + 四条**自足**的 headline——`smoke-tools` /
  `smoke-sessions` / `smoke-models` / `smoke-mux`（全部自带夹具或服务器、无需外部环境与密钥）；
  `smoke-api`（唯一需要**外部预先启动**服务器的一条，主半打 `MY_AGENT_URL`、进程内半自带
  bootServer 钉 remove/202 竞态）从步 3 起入列；每步针对性附加如
  各步所列；终步全清单。每步同步落笔该步已为真的 ADR 修订，大重写归步 6。
- **smoke 脚本归属：全留根 `scripts/`**：这批 smoke 是跨层集成测试（boot 起进程、api 打 HTTP、
  desktop 起 Electron、mux-live 连真服务器），不是包的单测，随包拆会把「验证一次构建」清单打碎；
  共享件（fake-transport / mount-session / dom-shim / wire/）随留——只有 smoke import 它们，没有
  包代码碰。02 给 dev 脚本的判词「仓库工具，不是产品 CLI」对它们同样成立。守卫豁免 scripts/
  （facade 守卫先例原文）；mount-session 经 `hub.agent.sessionManager.appendMessage` 的内部门继续
  可用（smoke 有意保留 Manager 访问）。
- **守卫**：自写静态 import 扫描（`check-server-facade.ts` 的正则先例扩展）；步 3 随 server 解散
  诞生、旧守卫同步退役；规则随步激活（步 4 子包隔离、步 5 domain 禁 fs）；`scripts/` 豁免。
  守卫脚本的名字是机械活，票 10 定。
- **tsconfig / workspace**：骨架步一次到位（五包 stub、paths 与 include 写全），旧名随步撤。
