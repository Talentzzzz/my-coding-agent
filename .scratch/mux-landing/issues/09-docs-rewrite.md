# 09 - 文档改写到实况

Type: task
Status: resolved
Blocked by: 04, 05, 06, 07

## Question

代码落地后把文档从"决定已作、代码未动"改到"实况"：`docs/architecture.md`（开头 ASCII 图、`## 谁拥有一个会话`、`## wire`、`## API`、`## 与原计划的偏离`、未决一节）、`AGENTS.md` 术语 `transport` / `claim` 与"加一个端点"规则补句、`README.md`（*验证一次构建*与*状态*）、`docs/notes.md` §六、`docs/README.md` 指路行。各处清单已在 ADR 0001 的*文档落点*节登记。今天已先做的预告性标注见各文件（不重复）。

## Answer

**2026-10-13，落地完成。** 逐处（`transport` / `claim` 两个术语随票 04/05 已是新写法，本票只在其上补句）：

**1. `docs/architecture.md`（主体）**
- 删掉开头的*状态预告*块（它的存在意义就是"本文仍是 SSE 实况"）。
- 开头 ASCII 图 `--一条 SSE 流--` → `--一条常驻 WebSocket--`（其上是 N 条逻辑流）；下面"命令用 `POST`、事件用一条 `GET .../events`"整段改写成 mux：连接的生命周期是连接、逻辑流身份是 `streamId`、`abort` 留 REST 不帧化、上行 `cancel` 只关流不中止。
- `## 各 package 的职责`：server 一段补 `mux.ts` 的订阅表（订阅不拿 claim）与 `projection.ts`；web 一段补 `MuxClient` 与连接级载荷。
- 层归属表：`HTTP + SSE` → `HTTP + WebSocket`（手写 RFC6455、不引入 `ws`）；窗口 UI"架在事件流上" → 常驻通道。
- 目录布局：server 侧补 `mux.ts` / `projection.ts` / `http/websocket.ts` / `http/client-frame.ts`、删 `stream-registry.ts`；web 侧补 `rows.ts`。
- 循环端到端第 6 步：`{ type: "session_event", event }` 转发给"每一条打开的流" → `{ type: "event", event }` 发给每条订阅，并点明连接级载荷走 `streamId: null`。
- `## 谁拥有一个会话` 整节重写：claim 只由**改变会话的请求**与**在飞的运行**持有、订阅不拿也不保活；reap 即时（"比浏览器重连多活两秒"整段退场，那是 `EventSource` 的事）；`approvalGraceMs` 的含义是"被遗弃"而非"没人在看"；补 **"谁限制写？"** 半节（一条常驻连接是一个 `Writable`，写侧有界：4 MiB / 10 秒 / `1013`，且 10 s < 客户端 15 s 读超时）；把"一条泄漏的流就是一台关不掉的服务器"改成研究票 02 的准确说法（只要有一条响应没结束 `server.close()` 的回调就不发生；`closeAllConnections()` 收不掉 upgrade 后的 socket，所以服务端自持并 `destroy()`）。
- 会话树：`branch_changed` 的回应用 `session` 帧 → `baseline`；fork 的"claim 路径" → `open` 帧。
- `## API`：删掉 `GET /api/sessions/{id}/events` 行；`/api/health` 应答改 `{ ok, cwd, live }`；`/api/workspaces` 行注明 `sessions` 是 `SessionRow[]`；表下补一段"这里没有一行是会话事件的端点，唯一流式通道是 `/mux`；行由投影喂、通道不可用时 `GET /api/workspaces` 是 REST 兜底"。
- `## wire` 整节重写为三层类型：`ServerFrame`（信封，`streamId: string | null` 分开两种帧）→ `StreamFrame`（`item` / `end` / `error`）+ `ConnectionFrame`；`ServerMessage` 七成员（`baseline` / `event` / `entry` / `approval_request` / `approval_settled` / `status` / `error`）；`baseline` 与 `open` 是同一个原子动作、重开是替换不是追加；`ConnectionItem` 三类（`heartbeat` / `sessions` / `session_row`）＋应用层心跳与应用层 Ping/Pong 的分工；`ClientFrame` 两成员 + 未知 type 丢弃不关连接；答案表按会话键控的理由。
- `## 请求流程` 末两行：`GET .../events` + `EventController`/`StreamRegistry` → `server/mux.ts` + 客户端按 `streamId` 分道。
- `## 与原计划的偏离`：首行（SSE → 常驻 mux，`channel.ts` 长成 `mux.ts`）与"claim 由 attach 上来的人持有"一行都按新模型改写。
- `*Verifying a build*` → `*验证一次构建*`。

**2. `AGENTS.md`**
- "加一个端点"规则补一句：**mux 的上行帧不是端点**（`open` / `cancel` 不走 URL，加一个帧类型不违反这条形状）。
- 布局两行：`packages/server` 的 `REST + SSE` → `REST 命令 + 一条常驻 WebSocket mux`；`packages/web` 的"渲染事件流" → "渲染常驻通道上的逻辑流"。
- `## 约定` 的语言规则按票 08 §9 的指派改成实况：**文档中文 / 源码注释英文**（整棵树如此，新代码照此；`scripts/wire/client.ts`、`proxy.ts` 的中文注释是**已登记的唯一例外**），面向人的字符串按位置写（窗口文案与诊断日志简体中文，状态行英文）。

**3. `README.md`**：开头"读成一条 server-sent event 流" → 常驻 WebSocket 通道；*从 shell 驱动它* 里那条已经过期的 `curl -N .../events` 换成"REST 发命令 + 一段用 Node 全局 `WebSocket` 开订阅读帧"的示例；*状态* 里"带事件流的 REST API" → "REST API 加一条常驻 WebSocket 通道（`/mux`）"。*验证一次构建* 的脚本清单随票 08 已补全，本票未动。

**4. `docs/notes.md`**：§二领读段收窄（1–3、5 是 `EventSource`/旧订阅模型的机制），并按 ADR 的要求加一张**"机制事实 / 结论"两栏表**（八条逐条判"仍成立 / 换了载体 / 随传输退场"）；§二第 8 条的语言规则指向 `AGENTS.md` 的 `## 约定`。§六与 §三、§五 bug 3 的注已在（票 12/06/08 落位时写下），不重复。

**5. `docs/README.md`**：指路行两处（"哪些已经被重开过"那句 + ADR 一行）；notes §3 描述"尚未解决" → "已解决"；architecture"含 21 个章节" → 20（HEAD 时就是 20，属顺手纠错）。

**6. ADR *文档落点* 里本票名下、Question 却没列的那一问**（`.scratch/client-server-refactor/issues/15-smoke-strategy.md`：关停判据）：在该文件末尾补一条 Comment 记它**已由该票 Answer 的决定 8 + 票 17 的实测回答**，落点是 `scripts/smoke-boot.ts` 末尾的 `unref()` 自然退出看门狗与子进程 `SIGTERM` 断言。

**7. 顺带**：改掉 `packages/server/src/hub.ts` 两处与本票新写进 `architecture.md` 的说法直接矛盾的注释（`RELEASE_GRACE_MS`、"the stream registry's reconnect grace"）——它们是票 04/05 删旧传输层时漏掉的引用。

**验证**：`npm run check` 绿（tsc ×4 + token 审计）；`node scripts/smoke-mux.ts`（含"重开是整份新基线""看着的宿主走了车道也结束""无人观看的运行照样改行"）与 `node scripts/smoke-boot.ts`（含"最坏情况在场时 `close()` 返回""子进程带一条常驻连接退出"）绿——这两条正是本票改写里最容易被写歪的断言。其余冒烟与本次改动无关（对源码只动了注释），未跑。

**明确没做的**：`scripts/wire/client.ts` 与 `proxy.ts` 的中文注释**保持原样**——`AGENTS.md` 已把它登记为唯一例外并写明出处；把它们翻成英文是另一件事（票 08 §9 的"改规则还是改注释"两半，本票选了改规则这一半）。
