# 01 - server：hub 公开面新增 `subscribe`（注册 + 活冷分岔 + baseline 交付一体完成）

Type: task
Status: done
Blocked-by: （无——这是图的根）

## 背景与指针

- Spec：`Z:/my-coding-agent/.scratch/hub-subscribe-baseline/spec.md`（Implementation Decisions 全部 + User Stories 7/8/9/12/14）。
- 现状代码：`packages/server/src/hub.ts`（`watch` L209-218、`isLive` L166-168、`snapshotNow` L186-189、`feeds` L341-360、`watchers`/`feedMap` L101-109、`remove` L312-318、`close` L326-331）。
- 分岔泄漏的现状：`packages/server/src/mux.ts` 的 `open()` L259 与 `pushBaseline()` L387-395 两处 `hub.isLive` 分岔（本票**不动 mux**——迁移是票 03）。
- 文档：`docs/architecture.md`「谁拥有一个会话」节的 `SessionHub.watch` 段（本票可暂不动文档，文档归票 04；但代码注释要写全契约）。

**本票只动 `packages/server/src/hub.ts` 与 `scripts/smoke-projection.ts`（唯一使用 `hub.watch` 的非 mux 消费者，随装配调整）。mux.ts 一个字不改。**

## 改动

### 1. `SessionHub.subscribe(sessionId, watcher, sink)` —— 新的原子订阅原语

```ts
interface SubscriptionSink {
	onBaseline(snapshot: SessionSnapshot): void;
	onError(error: unknown): void;
}
subscribe(sessionId: string, watcher: SessionWatcher, sink: SubscriptionSink): () => void;
```

契约（写进 JSDoc，spec Implementation Decisions 第 2 条逐条落字）：

- **活半**：`watcher(feeds)` 注册同一拍同步回调（沿用现 `watch` 的形状——恒交，冷会话同样成立），然后在 **`subscribe` 返回之前的同一同步块内** `snapshotNow(sessionId)` 并同步回调 `sink.onBaseline(snapshot)`。注册与快照之间没有任何 `await`、没有任何事件循环拍——no-gap 由构造成立，想违反都没有违反的写法。
- **冷半**：`await this.agent.snapshotOf(sessionId)`（读盘归 hub——spec Implementation Decisions 第 3 条）完成后**异步**回调 `onBaseline` **恰好一次**。
- **失败**：冷读盘失败（含未知会话的 `UnknownSessionError`）→ `sink.onError(error)` **恰好一次**，此后 `watcher` 不再收到 feeds/undefined 之外的东西。错误**归因的措辞**（用户可读的帧文案）不在 hub——hub 交的是原始 error 对象，措辞留 mux（票 03）。
- **恰好一次的实现**：hub 内部以一个 delivered/failed 标志保证两条回调互斥且各至多一次；冷读盘返回时若订阅已退订，交付随之终结（hub 侧的终结即交付不再发生；mux 侧的 backlog/cancel 竞态检查**不搬**——spec 明确不搬清单）。
- **`watcher(undefined)`**：只在会话删除（`remove`）或进程收摊（`close`）时到达，语义与现 `watch` 一字不差（`remove`/`close` 的遍历逻辑照旧覆盖 subscribe 注册的 watcher）。
- **返回值**：退订函数，语义与现 `watch` 相同——宽容、幂等、最后一个退订清理该会话的条目。
- **签名陷阱**（spec Implementation Decisions 第 7 条）：不得返回 `Snapshot | undefined` 让调用方分岔，不得暴露「先注册再让调用方自己问快照」的任何形状。分岔在 hub 内部完成后只交付结果。

### 2. 旧 `watch` 的处置

`watch` 的生产调用方只有 mux 一处（`mux.ts` L237），非 mux 消费者只有 `scripts/smoke-projection.ts` L234。按 spec「不得保留任何『裸注册、分岔交调用方』的公开形状」：**删除 `watch` 公开面**，`SessionWatcher` 类型保留（subscribe 的 watcher 形状沿用）。

- `scripts/smoke-projection.ts` L234-244 的 `hub.watch(afterStop, ...)` 随装配改写为 `subscribe`（或 `feeds` + `remove` 告别语义，实施者按该 smoke 的意图——「观看不拼装任何东西」——选最贴的形状）；**该 smoke 的既有断言一字不改**，只改到达断言的装配。
- `isLive` / `snapshotNow` / `feeds` 保留原样：projection 仍在用（`projection.ts` L108-122，不搬清单明说 projection 装配不动），`snapshotNow` 的 JSDoc 改写——它不再是「mux 保证」的理由（那是票 03 之后 mux 的历史），而是 subscribe 活半半的内部依据与 projection 的读法。

### 3. 两半保证的 hub 半 + 顺序论证随代码迁移（spec Further Notes 最后一条）

`subscribe` 的 JSDoc 写下：hub 保证「注册与快照原子」（机制半）；JS 单线程 + hub 内同步块的顺序论证（「subscribe 返回前活半已同步交付 baseline，任何 emit 只能发生在下一个事件循环拍」）必须落在这里，不得散佚。mux 半（baseline 帧先于 backlog 中任何帧）归票 03 的 mux 注释。

## 测试

- 本票不新增 smoke 文件——hub 级 smoke（`smoke-subscribe.ts`）是票 02 的活，两票并行，票 02 会对本票的契约逐条钉住。
- 本票的验收是：`npm run check` 绿 + 受影响的既有 smoke 全绿（`smoke-projection.ts` 断言未动而通过；`smoke-sessions.ts`、`smoke-stream.ts` 等使用 hub 公开面的 smoke 不受影响）。
- 按 TDD：先为「活半同步交付、冷半异步恰一次、onError 恰一次」写最小断言脚本验证（可临时脚本或直接并入票 02 的开头，但**不得**把票 02 的完整用例集提前实现——那是票 02 的边界）。
