# 实施步 2：core → domain（改名 + 套层 + protocol 解散）

Type: task
Status: resolved
Blocked by: 11

## Question

按 [spec.md](../spec.md) §7 步 2 落地：git mv core → domain、散件与子目录套进
`src/agent/`、protocol.ts 按 §2.4 解散、server/web/scripts 的 import 重指面（表见 §7）。
验收 = `npm run check` + 基础门 + smoke-projection + smoke-default-model。

## Answer

`lm/step2-core-to-domain`（f5635b7，123 文件），已并入 `layered-modules`。验收全绿（check +
基础门 + projection + default-model，另验 build:web 与 smoke-api）。已登记偏离：

1. session-factory.ts 按 §2.1 落 agent 根（§1.2 树把它列在 session/ 下是笔误——R2 子包隔离
   下唯一自洽位置）。
2. web/vite.config.ts 增构建配置：case 网关的**值** re-export（addUsage/EMPTY_USAGE/
   compactionSummaryOf/APPROVAL_TOOLS）会把 domain 整包拉进浏览器 bundle 且 node 内建替身
   无具名导出、构建直接炸——加 `moduleSideEffects` 判据 + node:* 具名空替身；bundle 122KB
   无 node 泄漏。网关值 re-export 的隐含必要条件。
3. 注释提法重指超出 spec 列的三处（web main.ts 第四处 + scripts 三条直述注释）；散文式旧
   路径提法留步 6。
4. server/tsconfig.json include 过渡改指 domain（步 3 随包消亡）。
5. domain index 增补 MessageDelta（web 经 protocol 消费）+ 信封七名移出。
