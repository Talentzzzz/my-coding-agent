# app 组合根的形状

Type: grilling
Status: open
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
