# 08 - wire 冒烟装置与脚本

Type: task
Status: resolved
Blocked by: 04

## Question

`scripts/wire/client.ts` + `scripts/wire/proxy.ts` 两个共享装置加进 `npm run check` 的 include（只收新文件，不背既有 35 个错误）；新脚本 `smoke-mux.ts` / `smoke-liveness.ts` / `smoke-backpressure.ts`（连接层须 DOM-free、可注入 socket 与计时器）；既有四个 smoke 的 SSE 解析器换成 Node 全局 `WebSocket` 客户端（不引入 `ws` 依赖到脚本侧）；关停判据照旧图票 15（不调 `process.exit` 自行退出）。

## Comments

**2026-10-13，票 06 落地时追加（本票仍 open；smoke-api 的那份已清账）**：`scripts/smoke-api.ts` 已随票 06 落地换成 Node 全局 `WebSocket` 客户端（连 `/mux`、上行 `open`、按 `streamId` 顺序消费、连接级帧跳过），树段同时落成票 18 登记的最终形式——所以本票清单里"既有四个 smoke 的 SSE 解析器换帧解析"对 smoke-api 这一份**不再需要**，剩余三份（smoke-stream / smoke-boot / smoke-approval）照旧归本票。两处随落地变形的事实登记：①原树段的"移动作为新 `session` 帧到达流""新分支点被发到流"两条断言随最终形式移除（移动后不 attach 任何东西，没有流可收帧）——"一棵变了的树是所有人的事"在 mux 上由 `branch_changed` 触发整份基线承载，若 smoke-mux 尚无对应断言，值得在那里补一条；②smoke-api 的冷读断言用 2 秒等待代替"回收完成"的确定性信号——REST 面上没有可观察的回收信号（`running` 是 `submitting`，host 关闭不改行），票 18 判定这笔等待可接受，smoke-mux 若要更硬的形式可用 `end` 帧当信号。

**2026-10-13，落地完成（第二个会话接手收尾；本票改 resolved）**：

**落地清单**：两个装置 `scripts/wire/client.ts` + `scripts/wire/proxy.ts`；三个新脚本 `smoke-mux.ts` / `smoke-liveness.ts` / `smoke-backpressure.ts`；`smoke-stream.ts` 与 `smoke-boot.ts` 按票 15 §2 重写；`smoke-approval.ts` 全量重写（见下）；`tsconfig.json` 的 `include` 加 `scripts/wire/**/*.ts` 与三个新脚本（旧文件的既有类型错误仍不在本票范围）。

**1. `smoke-boot.ts` 的最后一处红灯——根因与处置。** 现象是 wire 上只到 `["baseline","status","event"]`，没有 `approval_request`，而紧接着的 GET 显示 `pendingApprovals.length === 1`。前一个会话怀疑"冷订阅后再 bind"的 `backlog`/feeds 接续，**不是那个**：真因是**设闸那次 PATCH 自己把车道弄死了**。`PATCH /api/sessions/{id}` 走 `claiming()`，它 `claim` 一次、写一条 `tool_config`、把 claim 交回去；而这个会话此刻没有别的持有者，于是 `release()` 触发的 `reap()` 走完、宿主被关、观察者拿到 `undefined`——按落地语义（"看着的会话没了"）**订阅就此 `end`**。后续 `prompt` 虽然把宿主重新开起来，可观察者已在 `teardown` 里摘掉，车道再也收不到帧。用一次性探针核实过：`after PATCH: live=[] end={"ended":true,...,"ends":1}`，`after prompt: live=[<id>] end={...ends:1}`。

处置**不动生产语义**，改用本图既有的装置：**测试台自己持一条 claim**（bench claim），顺序变为 open → claim → PATCH → prompt。这与 `smoke-mux.ts` 第 7 段（"the bench claim keeps the host alive across both runs and the move"）和 `smoke-stream.ts` 的多处用法完全同形，也是"订阅不拿 claim、回收会 END 正在看的流"这两条落地设计的直接后果。**同时登记一条对下游有用的观察**：因为 `PATCH` 的 claim 只活一次写的长度，**生产里"窗口开着 → 用户拨一下会话级审批开关"会让那条车道结束**（`reduceEnd` 之后该订阅记 `ended`、不重放、也不重开），车道要等那一栏改指别处再回来自行恢复。这是三条已决事项（reap 只听 claim / 订阅不阻止回收 / `end`=判终不重开）的合成后果，本票不重开它们，只把它写在这里备查。

**2. `smoke-approval.ts` 重写为五段**（装置换成共享 wire 客户端；两处 `EventController` 与 `stream-registry` 随票 04/05 删除；rig 手搭图 + `muxUpgrade(mux)`，`port: 0`；`docs/notes.md` §一的怪异 `new SessionHub({ workspaceRoot: root })` 与手挂宿主**原样保留**，该文件因此继续留在 check 的 `include` 之外）：
- **①往返回路**：车道见 `approval_request` → REST 答 200 → 车道见 `approval_settled(true)`。**并入票 07 留给本票的那条**（票 14 §2 的"失败请求不污染差量帧"）：先对未知 `toolCallId` 发一次答案拿 409，断言车道上**一帧 `approval_settled` 都没有**，再答真答案，断言**恰好一帧且是 `true`**——即票 13 `[true,false,false]` 那类缺陷的反面。
- **②三条连接**（不是三条流，票 05 第 1 条）：三个连接各自 `open` 同一会话，都看到请求、都收到同一个真答案。
- **③一个 id 两个会话**（票 19）：两个会话拿同一个 `toolCallId`，第一个答准予、第二个走 abort 落成拒绝，两条车道各听到自己的答案。
- **④停在审批上的运行**：三条 grace 档（60 s / 30 ms / 3 s）分别钉"等回来""没人回来才拒绝""看一眼又走开时 reap 让位并可再次启动"。原来那句"流的 claim 靠 reconnect grace 多活一会"的前提已随订阅不拿 claim 消失，注释与等待都改了：**viewer 的 claim 现在是唯一的持有者**。
- **⑤重启后基线里没有那次审批**（票 14 §1，本票欠的）：真 `bootServer`（脚本化传输）把一次运行停在审批上 → `close()` → **真子进程** `main.ts --cwd <同一工作区> --port <bind-to-0 探到的空闲端口>`，`MY_AGENT_HOME` 显式算出、就绪判据轮询 `/api/health` → 新进程上 `open` 那条会话，断言基线 `pendingApprovals` 为空、且 transcript 里那次工具调用**还在**。票 14 的另一条（未知 id 409）已由票 07 的 `smoke-approval-endpoint.ts` 覆盖，这里不重复。

**3. `smoke-mux.ts` 两处固定 `sleep(100)` 改成轮询。** 单跑绿、随整套连跑时红过：`open` 一个不存在的会话要 `SessionManager.findAnywhere()` **扫遍本机所有会话目录**，机器上临时会话目录攒多之后 100 ms 不够。断言等的是帧、不是一个时长，所以改成 `until(...)` 各自等 5 s。这不是新增断言，是同一断言更稳的写法。

**4. 三处生产修复（落地旧图票 08 的已决行为，都是票 15 冒烟的前提）**：
① `packages/core/src/agent.ts` `prompt()`：`await this.loop.prompt()` 包进 `try/finally`，`finally` 里 `publish()`——此前拒绝路径永远不发 `submitting:false` 那一帧（探针核实过）；
② `packages/server/src/projection.ts` `onHost(undefined)`：宿主关闭时把行落成 `{running:false, pending:0}`——修掉"无人观看的运行结束后那一行卡在 `running:true`"的 reap/publish 竞态（smoke-mux 暴露的）；
③ `packages/server/src/boot.ts` `onRunFailure`：先 `console.error` 再 `mux.announce`（旧图票 08 决定 7 的服务端日志）；
④ `packages/server/src/boot.ts` 另两处重构：mux upgrade 的装配抽成导出的 `muxUpgrade(mux)`（三个冒烟 rig 共用，不再各自复制 waiting-frames 那段）；`BootOptions` 增加 `api?: ChatTransport` 透传给 `SessionHub`（停在审批上的运行必须能不用供应商密钥驱动）。

**5. 两处与票 15 预判的分歧（按落地代码断言，不按票 15 字面改回去）**：
- **重复 `open` 是"拒绝"，不是票 15 写的"替换"**——按票 04 的落地语义（该连接已经订阅了它会回 `error` + `end`，原订阅照常），`smoke-mux.ts` 第 2 段这么断言的。
- **`status(submitting:false)` 先于 `item.error` 到达**，票 15 §2 形状 C 写的"`item.error` 先、`status` 后"在**这个装配**下不可达：`finally` 在 `Agent.prompt()` 内、`announce` 在控制器的 `.catch()` 里，拒绝先穿过 `finally`（发 `status`）再落到 `.catch`（发 `item.error`）。`smoke-stream.ts` 第 4 段对两帧各用一个 `waitFor`，所以断言本身与次序无关；这里登记次序，免得下一个人照票 15 改注释。

**6. `end` 随回收到达的语义（登记）**：宿主被回收时，绑定过它的那条车道收到 `end`。落地实现是 `MuxConnection.open()` 里 `live` 那个布尔——"看着的会话停了"与"从来没在跑"是两件事，只有前者发 `end`。它落在 `smoke-stream.ts`（"released, the host went, the lane went with it"）与 `smoke-mux.ts` 第 7 段（"the lane ends when the host it watched goes away"）里，是本图的既定行为，不是 bug（见第 1 条那条备查观察的边界）。

**7. 验证**：`npm run check` 绿（tsc ×4 + token 审计）；`smoke-backpressure` / `smoke-mux` / `smoke-liveness` / `smoke-stream` / `smoke-boot` / `smoke-projection` / `smoke-mux-client` / `smoke-mux-live` / `smoke-tools` / `smoke-sessions` / `smoke-models` / `smoke-approval` / `smoke-approval-endpoint` / `smoke-session` 全绿（`smoke-session` 单跑绿；把十几份冒烟塞进同一条命令连跑时，环境的批量删除守卫会在中途要求确认，那是运行器的事，与脚本无关）。

**8. `/code-review` 两轴过完，顺带的改动**：
- **run-failure 那条接线从四处副本收成一处**：`boot.ts` 导出 `sessionListeners(mux)`（与 `muxUpgrade(mux)` 同形），`bootServer` 与 `smoke-stream` / `smoke-mux` / `smoke-approval` 的 rig 都改用它。**这不是纯去重**：冒烟此前自己接 `console.error`，于是"服务端记了一行日志"这条断言证的是**脚本自己那份副本**；改成经由同一个函数接线之后，删掉生产里那句 `console.error` 会让它变红。
- **`smoke-stream.ts` 第 5 段补齐票 15 §2 要的那半条**："运行期间 `hub.live` 含它"。原来那段自持 bench claim（`sabotagePersistence` 需要宿主），把"运行自己守着会话"这条盖住了——现在**先把 bench claim 交回去**，再断言 `hub.live` 仍含它，然后才等 settle、才断言回收。这是本票唯一一处"断言被装置掩盖"的补漏。
- **`smoke-approval.ts` 第 1 段补上响应体文案**：票 14 要的"响应体说明这个 id 不是待回答的审批"，原先只断了 409 状态码。
- **`scripts/smoke-sessions.ts:89,90,123`** 按票 09 决定 6 改成先 `currentSessionId()` 再 `claim(id)`。注意 `hub.claim(sessionId?)` 的**可选 id 今天仍在**（票 09 决定 6 的签名收紧没落地），所以这三处是"用生产的形状写冒烟"，不是修 bug。
- **`scripts/wire/client.ts` 导出的 `until` 收编了** `smoke-boot.ts` / `smoke-liveness.ts` / `smoke-backpressure.ts` 各自的那一份——该装置本来就写着"装置自己不用，留给各 rig"。
- **`smoke-boot.ts` 前面 `const fake` 两行多出的一个前导 tab**（上一会话留下的）改正。
- **`smoke-mux.ts` 两处固定 `sleep(100)` 改成轮询**（见第 3 条）。

**9. 评审登记、本票不动**：
- **`AGENTS.md`"源码注释一律中文"与整棵树的实际不一致**：`packages/*` 与 `scripts/*` 的源码注释**一律英文**（`mux.ts` / `hub.ts` / `boot.ts` / 全部既有冒烟），只有 `scripts/wire/client.ts`、`proxy.ts` 两份新装置是中文。本票新写的 `smoke-approval.ts` 与重写的两份维持英文以与同级脚本一致；这条规则与实况怎么对齐（改规则还是改注释）归**票 09**（AGENTS.md 的改写）。
- **`smoke-mux.ts` 第 2/8 段的"`cancel` 之后该 `streamId` 再没有帧""发出 `end` 即删掉条目"没有独立断言**：由第 6 段"`cancel` 之后从别处改动、再 `open` **成功**"推出来（条目还在的话那次 `open` 会被拒）。要更硬的形式需要一条负向观察，本票不为它付一笔 sleep。
- **`smoke-backpressure.ts` 与票 15 §3 字面的两处分歧**（队头会被下一次 `send` 重试一次；队列是"越界即关"而不是"从不越界"）都是落地写侧策略本身，按落地断言——与第 5 条同性质。
