# 05 - server：hub 公开面第二个动词 `rebaseline`——重发路径的活冷分岔也归 hub

Type: task
Status: done
Blocked-by: 01

## 为什么有这张票

票 03 的迁移会撞上一个契约缺口，spec 已明文预留：「open 路径与重发路径（对已订阅流的第二个 open、`branch_changed` 触发）共用 hub 侧决策（`subscribe` / **rebaseline** 语义）」。

现状 `packages/server/src/mux.ts` 的 `pushBaseline()` L386-396 是第二处活冷分岔：活半调 `hub.snapshotNow`（**同步**）、冷半重新布防 backlog 后走 `readColdBaseline`。票 03 要求 mux 里不再出现任何 `hub.isLive` / `hub.snapshotNow` / `hub.snapshotOf` 调用——但重发路径确实需要一份「此刻状态」，而它不能由 `subscribe` 提供（那会重复注册 watcher、多挂一条 feed），也不能由 mux 自己读（读法归 hub）。

按 spec 的签名陷阱：**不得**让 hub 交回 `Snapshot | undefined` 让 mux 分岔。分岔在 hub 内完成后只交付结果。

**本票只动 `packages/server/src/hub.ts`。不动 mux.ts（票 03）、不动 scripts/（票 02 负责 hub 级 smoke）。**

## 改动

### 1. `SessionHub.rebaseline(sessionId, sink)` —— 给已持有的订阅重发一份 baseline

```ts
rebaseline(sessionId: string, sink: SubscriptionSink): void;
```

契约（写进 JSDoc，与 `subscribe` 共用同一套措辞）：

- **活半**：`snapshotNow(sessionId)` 并在**本方法返回之前的同一同步块内**同步回调 `sink.onBaseline`——第二个 `open` 带走的是正在写出的 partial，而不是盘上上一次落定的状态（User Story 1 在重发路径上的同一要求）。
- **冷半**：`await this.agent.snapshotOf(sessionId)` 读盘，完成后**异步**回调 `onBaseline` **恰好一次**。
- **失败**：`sink.onError(error)` 恰好一次，原始 error 对象；措辞留 mux（票 03）。
- **无注册、无退订**：`rebaseline` 不碰 `watchers` / `feeds`，所以不返回退订函数。它只回答「这个会话此刻的状态，交付给你」，不回答「之后的变化归谁」——后者是 `subscribe` 的事。调用方对「这份 baseline 还有人要吗」的守卫（订阅身份、连接已关、backlog 状态）是它自己的帧序本域，留 mux，**不搬**（spec 不搬清单）。
- **恰好一次**：与 `subscribe` 同一套 `delivered` 守门；同一 sink 上不会既 onBaseline 又 onError。

### 2. 分岔唯一化：两个动词共用一处 `isLive` 判定

`subscribe` 与 `rebaseline` 必须共用同一段「活半同步交付 / 冷半读盘异步交付 / 失败 onError」的实现（抽一个私有方法，例如 `deliverBaseline(sessionId, sink, gate?)`，`gate` 是 subscribe 的 `cancelled` 而 rebaseline 传一个恒 false 的）。spec User Story 9 的要求是「活冷分岔只存在一处」——票 05 之后 `hub.ts` 里 `isLive` 的**决策**调用点应当只有那一处（`isLive()` 公开方法本身留着，projection 在用）。

### 3. `Subscribe` JSDoc 交叉引用

`subscribe` 的 JSDoc 里补一句：重发路径用 {@link rebaseline}，两者是同一个分岔的两个交付时机；两半保证的论证两边共用，不复述两份（写一份、另一处引用）。

## 测试

- 本票**不新增** smoke 文件：hub 级的 `scripts/smoke-subscribe.ts` 归票 02（票 02 已把 `rebaseline` 的两组断言纳入范围，且 blocked-by 本票）。
- TDD：先写一个**临时**脚本（放系统临时目录，不提交）证明「活半同步交付、冷半异步恰一次、失败恰一次」三条；实现后跑通、删掉。
- 验收：`npm run check` 绿 + 现有全部 smoke 绿（本票不改任何调用方，纯新增公开面）。
