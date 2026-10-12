# 冒烟与验证策略

Type: grilling
Status: open
Blocked by: 05

## Question

`AGENTS.md` 的规则是："改完代码跑 `npm run check` 和对应的 smoke（都不需要供应商密钥）"。本次改动会同时推翻**四个**冒烟脚本对传输层的假设——它们在五个地方各自复制了一份"按 `\n\n` 切块、取 `data:` 行"的 SSE 解析器：

- `scripts/smoke-stream.ts:86-93`（`feed()`）
- `scripts/smoke-api.ts:62-75`（`readStream()`）与 `:140-147`（`collectFrames()`）
- `scripts/smoke-boot.ts:33`
- `scripts/smoke-approval.ts:123-135` 与 `:392-404`（两处 `pump()`）

它们**都不用 `EventSource`**（Node 没有这个 API）。传输换成 WebSocket 后（2026-10-12，见 `map.md`），问题从"改五份 SSE 解析器"变成"给冒烟一个 WS 客户端"：Node ≥22 自带全局 `WebSocket`（undici），本仓库引擎下限 22.19 正好够用，**不需要**为此引入 `ws` 依赖——但它在 22.19 上的确切行为归票 17 核实。

要钉死的是：

1. **要不要抽一个共享的测试工具**。五份重复实现是既有技术债。抽的话放在哪（`scripts/` 下一个模块？`packages/server` 里导出？）——注意 `docs/notes.md:31-33` 的规则"测试一次运行不需要供应商密钥"，以及 `scripts/fake-transport.ts` 是**模型**传输替身、不是 wire 替身，别混。
2. **每个脚本的断言怎么改**。逐条判定哪些断言在新模型下**语义变了**而不是"字段名变了"：
   - `smoke-stream.ts:155-170`（空闲流自我 `stream_end` + 会话被回收）——常驻连接里没有"空闲流"这回事；
   - `smoke-stream.ts:210-217`（断言 `stream_end` 的下标**严格大于** `agent_end`）——D2 已失效（票 05）；
   - `smoke-stream.ts:238-248`（第二条流在 `idle grace × 6` 后仍活着）；
   - `smoke-boot.ts:28-36`（打开 `/events`、解析第一帧、断言落到的是 `sessionId`）；
   - `smoke-api.ts:354-359` 与 `:375-384`（移动/新分支点必须作为新 `session` 帧到达流）——这两条断言的是"一棵变了的树是所有人的事"，在新模型下应该**保留**，只是运载方式变了；
   - `smoke-api.ts:305-307` 的注释说"未知会话在流 URL 上也必须是 404"，但**代码只请求了读取端点**——注释与代码不一致，`/events` 的 404 实际由 `smoke-stream.ts:192-197` 覆盖。这处漂移要不要顺手修。
3. **验收边怎么被证明**。`map.md` 的四条验收边目前没有一条有对应的测试：
   - "一个标签页同时订阅 N 个会话"——需要新的冒烟（现有脚本全部单会话）；
   - "逻辑流重开后收敛"——需要断连再连的冒烟；
   - "发送不依赖先 attach"——需要"无人观看时运行失败"的冒烟（今天的 D3 路径）；
   - "客户端能发现连接已死"——需要一个假死连接的冒烟。
   这些都是**新**脚本还是既有脚本的新段落？
4. **桌面外壳的退出路径**。`packages/desktop/main.cjs:254-261` 的 `before-quit` 注释写着"服务器持有着打开的事件流和活会话；关闭它们才能让进程真正退出，而不是等一个永不结束的响应"——这条关停顺序假设会随常驻连接而变（一条**没人会主动结束**的常驻响应正是最坏情况）。`docs/architecture.md:263` 把"泄漏的流 = 关不掉的服务器"当成承重事实。本票要决定用哪个冒烟证明关停仍然能完成——`scripts/smoke-boot.ts:38-47` 今天已经断言了"关闭后拒绝连接"，够不够。

   **研究票 02 把这条事实修正了**（`../research/sse-multiplex.md` Q3，实测挂起 3 s）：结论**成立**，但**机制描述不准确**——不是"资源泄漏 / 占着 socket 到进程结束"，而是"**只要有一条响应没结束，`server.close()` 的 `'close'` 事件与回调就不发生**"。而且**有明确出口**：`server.closeAllConnections()`（Node v18.2.0+）本仓库从未提及。**传输切换后的新事实**：WebSocket 连接要经过 HTTP `upgrade`，升级后的 socket 在 `server.close()` 记账里是什么地位**未确认**——DSH 的 WebServer 在 `upgrade` 时把 socket 自己记入 `upgradedSockets`、服务关闭时统一 `destroy()`（`../research/dsh-portability.md` §4 末尾），这正是"close 覆盖不到它们"的先例证据。本票要决定：本仓库照做，还是先让票 17 核实 Node 是否已经替你做；冒烟是断言"常驻连接下进程仍然能退出"，还是顺手改用 `closeAllConnections()` 让退出不依赖"每条流都被礼貌地结束"。

## Answer

<!-- 解决时在下面追加。 -->
