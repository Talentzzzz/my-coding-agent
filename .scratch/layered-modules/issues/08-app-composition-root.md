# app 组合根的形状

Type: grilling
Status: resolved
Blocked by: 07

## Question

app 的 `start(options)` 收什么？desktop 怎么对接？浏览器 dev 薄脚本长什么样？

具体待定：

- `start(options)` 的 options 面：哪些 home / transport / workDir 可覆盖？今天
  `HubOptions` 与 `CreateSessionAgentOptions` 的字段（settingsHome / modelsHome /
  chatTransport / sessionId / workDirAbsPath）哪些上浮到 app、哪些收进内部？
- desktop 对接：`launch.mjs` → Electron main 进程内调 `start` 的具体形状；
  `@my-agent/desktop` 的依赖声明从 `@my-agent/server` 换 `@my-agent/app`。
- 浏览器 dev 薄脚本：放哪（`scripts/` 还是 app 包内）、怎么把 Vite 与 `start` 拼起来、
  `npm run dev` / `npm run start` 两个根脚本指向哪。
- `close()` / shutdown 路径（`SIGINT` 落定、desktop 的 `shutdown.cjs`）在新世界谁负责。

前置：[端口方法集设计](07-port-method-sets.md)（options 面取决于端口的 home/接缝形状）。

## Answer

- **`start(options)` 的 options 面**：`{ workDirAbsPath*, host?(127.0.0.1), port?(8080),
  sessionId?(回退 `MY_AGENT_SESSION` env), settingsHome?, modelsHome?, chatTransport?,
  mux?(WireOptions 透传), vite? }`。homes 是**路径**不是端口——app 是唯一把 home 翻译成 infra
  实现的地方：session-store 指 `<settingsHome>/sessions`；home-json 按 settingsHome 与
  modelsHome（缺省跟 settingsHome）各造一份（07 的组合根职责）；tool-results 实现收 absPath、
  无 home 概念。**会话 store 跟随 settingsHome 派生**：`setSessionsDir` 消亡后不再有独立的
  store 缝，今天「settingsHome 与 storeRoot 两条缝」合一——生产从不传 homes，server 级 smoke
  从此一个 home 指全隔离。**验收线的显式边界**（map 冲突规则：摆出来，不静默）：产品面——REST、
  mux 帧、会话文件格式、生产 home 布局——零变化；测试缝的形状按 07 的「setSessionsDir 消亡」
  裁决变化，store 派生规则是其替代。`mux` 与 `sessionId` 两个透传各有实主：`mux` 归
  smoke-mux-live / smoke-liveness（毫秒驱动心跳预算），`sessionId` 归 smoke-boot 的钉住用例。
  默认 home 的解析（`MY_AGENT_HOME ?? ~/.my-agent`）搬进 app；smoke-boot **进程内半**的隔离法
  （env 先设、动态 import 后行）原样可用——子进程半见「dev 薄脚本」条。`createSessionAgent` 的 `toolManager` / `sink`
  **不上浮**：sink 归 hub 自己（构造工厂时递入自己的分发表，今天即如此），toolManager 是
  domain 级 smoke 的缝。返回面 `BootedServer` 原样保留（`{url, port, workDirAbsPath,
  sessionHub, muxServer, httpServerHandle, close}`），名字不改（搬迁不改名）。
- **工厂与 HubOptions 的 options 面：homes → 端口注入（07 的遗留裁决）**：`createSessionAgent`
  **活下来**，options 面从 homes 换成注入的端口：`{ sessionRepository*, modelRepository*,
  toolDefaultsRepository*, toolResultsRepository*, chatTransport?, toolManager?, sink? }`
  ——存储端口全必填（domain 造不出 infra，「缺省真实 home」不再是 domain 的知识；07 的「实例由
  编排层持有（构造注入）」没有缺席态，写边界的兜底归档永远有处可去），managers 仍由工厂构造：
  ADR-0012 的「工厂吸收 manager 构造」保留，原料从 homes 改为端口，修订措辞归票 10。
  `openAgent` 随工厂换面（ports + session bag 不变）。`HubOptions` 的存储/传输字段换端口透传，
  hub 保留工厂调用与 sink
  组装——「case = SessionHub 原样搬迁」（03）以换类型面的方式成立。`AGENT_HOME` 常量出
  domain（types.ts），搬到 app；domain 从此不知道「真实的 home」，一切绝对路径由组合根递入。
- **desktop 对接**：`main.cjs` 保持动态 import（CJS 壳 + TypeScript 类型剥离），目标从
  `packages/server/src/boot.ts` 文件路径换成包名 `await import("@my-agent/app")`；调用
  `start({ workDirAbsPath, host: "127.0.0.1", port: 0, vite })`，四个选项一字不变；「必须从
  仓库跑」的 existsSync 检查换成 import 失败的 catch，由 observability 的既有上报路径接住。
  `launch.mjs` / `shutdown.cjs` / `observability.cjs` 一概不动（map Out of scope：desktop 只换
  依赖指向）；desktop `package.json` 依赖 `@my-agent/server` → `@my-agent/app`——今天这个依赖
  本来就是声明而未被 import，改声明让 import 走正门。
- **浏览器 dev 薄脚本**：`packages/app/scripts/serve.ts`（镜像 desktop 自己养 `launch.mjs` 的
  先例；02 已决「仓库工具、不是产品 CLI」）。脚本动态 import app 调
  `start({ workDirAbsPath, port, vite })`、装 SIGINT/SIGTERM、打印 URL；**只收
  `--vite` / `--port` / `--workDir` 三个 flag**——后两个不是给产品的：smoke-boot 的**子进程半**
  今天 spawn `main.ts --workDir --port` 并断言 SIGTERM 落定（:232-280），新世界它 spawn 这个
  脚本、同 flags，SIGTERM 由脚本里的 handler 承接；`--host` / `--session` / `--help` 随
  main.ts 的 CLI 死掉。根脚本 `"dev"` / `"start"` 都经 workspace 委到 app 包内两个 script
  （`node scripts/serve.ts --vite` / 无 flag）——两个根脚本、一个脚本、一个 flag 之差。
- **close() / shutdown**：`close()` 编排（mux → hub → http 顺序）留在 `start`（它构造这些
  对象），`BootedServer.close` 语义不变。**app 不装任何信号 handler**：SIGINT/SIGTERM 从垂死的
  main.ts 搬进 dev 薄脚本；desktop 的 `shutdown.cjs`（before-quit 拦截、5 秒预算）原样，
  `smoke-desktop-close` 继续拿假件驱动它。
- **随层落位（机械细节，归 09/10 的清单）**：`muxUpgrade` → trigger（websocket/mux wiring，
  `MUX_PATH` 同行）；`sessionListeners` → trigger（`SessionListener` 类型住在 controllers
  旁）；`WEB_DIR` / `CLIENT_DIR` 解析 → app（`start` 算好 clientDir 递给 trigger 的
  `createServer`，vite devDep 随 http.ts 落 trigger）；server 级 smoke 的
  `setSessionsDir(storeRoot)` 调用点改传 `settingsHome`。
