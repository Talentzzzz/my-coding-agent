# 物理布局与启动面

Type: grilling
Status: resolved

## Question

五个模块的物理形态是什么？desktop / web 放哪？domain 内部套不套层？app 的入口形状是什么？

## Answer

- **仍是 `packages/` 下的 npm workspace**：`packages/{app,trigger,case,domain,infra}`；
  `install-deps`、`npm run check`、tsconfig 机制全部不动。
- **desktop / web 保持独立 package**：desktop（Electron 外壳）依赖从 `@my-agent/server` 换成
  `@my-agent/app`，经 `launch.mjs` 进程内启动；web 不动。
- **domain 套层**：`packages/domain/src/agent/{context,llm,session,tool}/` + `agent.ts` +
  `types.ts`——按 domain 模块下有一个 agent 包的字面形状，给未来第二个包留位。
- **app 无 CLI**：只做桌面端，入口是程序化 `start(options)`；今天 `main.ts` 的参数解析不再是一个
  CLI 面孔。浏览器 dev 模式保留一个**薄开发脚本**（仓库工具，不是产品 CLI）调 `start` 起 8080，
  `npm run dev` 照旧可用，smoke 与无窗口调试靠它。
