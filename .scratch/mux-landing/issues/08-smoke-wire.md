# 08 - wire 冒烟装置与脚本

Type: task
Status: open
Blocked by: 04

## Question

`scripts/wire/client.ts` + `scripts/wire/proxy.ts` 两个共享装置加进 `npm run check` 的 include（只收新文件，不背既有 35 个错误）；新脚本 `smoke-mux.ts` / `smoke-liveness.ts` / `smoke-backpressure.ts`（连接层须 DOM-free、可注入 socket 与计时器）；既有四个 smoke 的 SSE 解析器换成 Node 全局 `WebSocket` 客户端（不引入 `ws` 依赖到脚本侧）；关停判据照旧图票 15（不调 `process.exit` 自行退出）。

## Comments

**2026-10-13，票 06 落地时追加（本票仍 open；smoke-api 的那份已清账）**：`scripts/smoke-api.ts` 已随票 06 落地换成 Node 全局 `WebSocket` 客户端（连 `/mux`、上行 `open`、按 `streamId` 顺序消费、连接级帧跳过），树段同时落成票 18 登记的最终形式——所以本票清单里"既有四个 smoke 的 SSE 解析器换帧解析"对 smoke-api 这一份**不再需要**，剩余三份（smoke-stream / smoke-boot / smoke-approval）照旧归本票。两处随落地变形的事实登记：①原树段的"移动作为新 `session` 帧到达流""新分支点被发到流"两条断言随最终形式移除（移动后不 attach 任何东西，没有流可收帧）——"一棵变了的树是所有人的事"在 mux 上由 `branch_changed` 触发整份基线承载，若 smoke-mux 尚无对应断言，值得在那里补一条；②smoke-api 的冷读断言用 2 秒等待代替"回收完成"的确定性信号——REST 面上没有可观察的回收信号（`running` 是 `submitting`，host 关闭不改行），票 18 判定这笔等待可接受，smoke-mux 若要更硬的形式可用 `end` 帧当信号。
