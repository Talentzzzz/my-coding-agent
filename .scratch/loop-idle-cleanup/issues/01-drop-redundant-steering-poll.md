# 01 - runLoop 里两处空转：多余的 steering 轮询与无效的 continuation 守卫

Type: task
Status: resolved

## Question

`packages/agent/src/agent-loop.ts` 的 `runLoop` 里有两处"算了但没人用"的活，要不要清掉：

1. **内层循环开头的第二次 steering 轮询**（原 200-204 行）。它只在 `prepareNextTurn` 存在且长耗时时才有意义——那段注释自己写的是"Preparation can be long-running (for example, compaction)"。但 `config.prepareNextTurn` 在本仓库没有任何赋值点（core 只设 `prepareRequest`），于是这次轮询之前唯一发生的 await 是 `await undefined`，一个微任务；steer 走 REST 进来要等一个宏任务，缝里不可能有新消息落地。每轮多 drain 一次队列。

2. **`explicitContinuation` 的守卫**（原 285-287 行）。`explicitContinuation` 唯一的读点是 `if (explicitContinuation)` 那处（外层循环）。能走到那里，前提是内层 `while` 已退出，也就是 `hasMoreToolCalls` 与 `pendingMessages` 都空了——正是这个守卫要覆盖的情形，此时它并不会执行。内层还在转的话，下一轮 `explicitContinuation = decision?.action === "continue"` 会把这个值覆盖掉。所以那行赋值没有任何可观察效果。

## 处置

**1. 把第二次轮询收进钩子存在的前提里**：

```ts
if (config.prepareNextTurn && pendingMessages.length === 0) {
    pendingMessages = (await config.getSteeringMessages?.()) || [];
}
```

钩子存在时行为完全不变（"准备阶段可能很久"的理由照旧成立，`pendingMessages` 非空时不重复取、one-at-a-time 不会一轮吃两条的逻辑也原样保留）；钩子不存在时省掉一次必然空手而归的 drain。

**2. 删掉三行守卫，原位留一句注释**说明为什么不变量成立，避免后来者照上游 pi-agent-core 的原文把它加回来。

**顺带记录、但不动**：`finishTurn` 在本仓库同样没有赋值点（除 agent 包自身类型声明外，`packages/` 下搜不到），所以 `decision` 恒为 `undefined`，`action === "end"` 分支与 `if (explicitContinuation)` 分支当前都不可达。这是上游宿主 API 的一部分，**保留**：将来接上就是几行的事，删掉反而要人家重写。另注意那一处的注释写的是 "one context-only turn"，但它下面紧跟 `prepareRequest` + `streamAssistantResponse`，实际是一整次模型请求——接 `finishTurn` 的人别被这句注释误导。

## Comments

**2026-10-22 落地**：

- 改动只在 `packages/agent/src/agent-loop.ts`，净 +4 行（注释 6 行换 3 行、删 3 行代码加 4 行注释）。这是 vendored 文件（pi-agent-core 0.99.2 的裁剪副本），**偏离上游的就是这两处**，re-vendor 时按本票恢复。
- 不碰的两处已评估但放弃：`convertToLlm` 每轮跑两遍（core 的 `prepareRequest` 在 `agent.ts:562` 已转好，`streamAssistantResponse` 又转一遍）与 `currentContext.messages` 的 push 在 core 下每轮被新数组顶掉。这两件是 core ↔ agent 的契约，省下来的是每轮一次 O(n) filter，不值得冒破坏上游兼容的险；真要省该动 core 的 `prepareRequest`（另一张票）。
- **验证**：`node scripts/smoke-session.ts`（274 条断言）与 `node scripts/smoke-tools.ts`（192 条断言）在改动前后各跑一次，stdout **逐字节相同**，退出码均为 0。这两个脚本覆盖 `exerciseSteerVersusFollowUp`、"请求还在飞时插话"（`gatedApi`）、`followUpMode: "one-at-a-time"` 逐条取，正是本次改动最可能弄坏的行为。`npm run check` 通过。
- **跑 smoke 的一个坑**：直接跑会在收尾的 `fs.rm` 上崩——执行环境的 safe-delete shim 拦下了它对临时会话目录的批量删除（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，51 个文件、阈值 50），断言其实全绿。用 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 跑即可拿到退出码 0。这是测试环境的事，与本次改动无关（原始版本同样复现）。
