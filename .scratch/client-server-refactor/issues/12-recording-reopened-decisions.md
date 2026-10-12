# 重开的那些决定怎么记录

Type: grilling
Status: open

## Question

本图重开了 `docs/notes.md:9` 标题为「**与用户共同作出、不得重开的决定**」的一节里的若干条（清单见 `map.md` 的 Notes 表格）。那节自己的说明是：

> 这些决定在 `split-the-claim` 与 `run-scoped-stream` 两个阶段各记录过一次，结论一致。之所以单独列出来，是因为它们看起来"可以改得更好"，而每一次都已经被否决过。

现在的处境和它防的正是同一件事：**看起来可以改得更好**。所以"重开"这个动作本身必须留下可追溯的痕迹，否则下一次有人读 `docs/notes.md` 会以为这次是未经思考的漂移。

要钉死的是：

1. **写在哪**。候选：改写 `docs/notes.md` 那一节（划线 + 指明取代它的记录）；新建 `docs/adr/`（目前不存在，`docs/README.md:44` 说明这是预期的惰性创建）；新建 `CONTEXT.md`（同样不存在，`docs/agents/domain.md:45` 说在它出现之前以 `AGENTS.md` 的术语章节为准）。三者的分工是什么——ADR 记"为什么改主意"，`notes.md` 记"哪些结论作废"，术语表记"现在的词是什么意思"？
2. **`docs/notes.md` 那一节怎么处理**。那节明文说"不得重开"。是删掉重开的条目、还是保留原文并在旁边标注"已于 <日期> 由 <ADR 链接> 取代"？后者更诚实，但会让那节的标题变成谎言——标题要不要一起改。
3. **哪些既有文本必须跟着改**（这张地图的"落地"部分包含这些）：
   - `AGENTS.md:42-45` 的术语 `transport`（"REST 加 server-sent events，**从不用 socket**"）与 `claim`；
   - `AGENTS.md:111` 的规则"加一个端点 = 控制器上一个方法 + `createRoutes()` 里一条记录"（新通道是不是打破了这个形状）；
   - `docs/architecture.md` 的开头 ASCII 图（`:7` 标注"一条 SSE 流"）、`## 谁拥有一个会话`（`:232-263`）、`## wire`（`:347-366`）、`## API`（`:316-339`）、`## 与原计划的偏离`（`:403-408`，第一行就是传输决定）；
   - `docs/notes.md` §二（8 条验证过的陷阱）与 §六（被否决的方案为什么输了）——§六 整节讲的正是本次在做的事；
   - `README.md:139-151`（验证一次构建）与 `:171-173`（状态）；
   - `docs/README.md:24`/`:32`（"修改 claim、事件流、分支、或审批相关代码之前，先读这份"）。
4. **两处已知漂移顺手修不修**：
   - `docs/architecture.md:351-360` 的 `ServerMessage` 代码块只列了 7 个成员，缺 `stream_end`（代码里有，`docs/notes.md:45` 也记录了 D2）。
   - `docs/architecture.md:263` 那句"**一条泄漏的流就是一台关不掉的服务器**"：研究票 02 实测**结论成立、机制描述不准确**——不是"资源泄漏/占着 socket 到进程结束"，而是"**只要有一条响应没结束，`server.close()` 的 `'close'` 回调就不发生**"；而且存在一个仓库从未提及的出口 `server.closeAllConnections()`（Node v18.2.0+）。这是一句会被后人当承重事实引用的话，值得改成准确的说法。
5. **ADR 的门槛**。按 `docs/agents/domain.md` 引的惯例，只有"难以逆转 + 没有上下文会让人困惑 + 是真实取舍的结果"三条同时成立才值得一条 ADR。本次重开里哪几条过这个门槛（原判断：多路复用与"不用 WebSocket"各一条。**2026-10-12 传输重开后两者并成一条**：「传输改为 WebSocket 多路复用 mux」一条 ADR——它们本来就是同一个决定的两半——其余的并入其中）。

## Answer

<!-- 解决时在下面追加。 -->

## Comments

**2026-10-12，票 10 解决时追加（本票仍 open，这里登记落点清单与一处顺手的旧账）**：票 10 只产出决定、代码一行未动，落点清单在它 §7 的表里，本票落地时要接的有：`packages/core/src/protocol.ts`（新增 `SessionRow`，`WorkspaceGroup.sessions` 的元素类型换成它，两个连接级载荷类型）；`packages/core/src/session/session-manager.ts`（`newestAt` 改读 `modified`，`:1612-1614`；包一个"一个文件 → 一行"的探针）；新文件 `packages/server/src/projection.ts`；`packages/server/src/hub.ts`（host 级观察点）；`packages/server/src/boot.ts`；`packages/server/src/controllers/sessions.ts`（列表应答改由投影答）；mux / 连接层两帧；`packages/web/src/main.ts`（连接级行 store、`refreshLists()` 退成兜底）；`packages/web/src/render/sidebar.ts`（行读 `modified` + 第二行状态 + 顶部连接指示器 + 原地改行）；`docs/architecture.md` 的 `## wire` / `## API` / 侧边栏与列表那一段。另外一处**只登记、不要求动**的旧账：`packages/web/src/state.ts:84` 的 `ViewState.sessions` 今天**没有任何读者**（侧边栏只读 `workspaces`，而 `api.ts:89` 那个列表请求的应答只被写进这里）——落地时它要么被删、要么改由投影喂，两种都行。
