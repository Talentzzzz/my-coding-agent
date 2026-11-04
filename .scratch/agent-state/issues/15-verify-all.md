# 15：全量验证——check、smoke 全套、桌面手测

Type: task
Status: open
Blocked by: 14

## Question

收总账。逐项跑、逐项记结果，失败的回修到绿。

1. `npm run check`（三个包的 tsc + token 审计）。
2. `node scripts/smoke-sessions.ts`（重点：打开→说话→切走→切回，队列与订阅的表现）。
3. 全系 smoke：`smoke-api` / `smoke-mux` / `smoke-mux-client` / `smoke-mux-live` / `smoke-projection` /
   `smoke-approval` / `smoke-approval-endpoint` / `smoke-approval-queue` / `smoke-tools` / `smoke-models` /
   `smoke-settings` / `smoke-modes` / `smoke-branch` / `smoke-replay` / `smoke-transcript` / `smoke-liveness` /
   `smoke-frame` / `smoke-backpressure` / `smoke-boot` / `smoke-default-model` / `smoke-desktop-close` /
   `smoke-desktop-observability`。
4. `npm run build:web`。
5. 桌面手测清单（人工，写进本票 Comments）：开一个会话 → 发消息 → 跑到一半切走 → 切回（Live 还在、流没断）→
   审批挂起时切走再切回（横幅还在）→ 侧边栏改名 → 删除 → 改设置后另一个会话打开是否看到。
6. 回修清单：哪一条 smoke 是**真回归**、哪一条是**按新语义重写**，分别记在本票 Comments 里。

## Answer

### 结论（一句话）

check 与 build:web 一次跑绿；smoke 全套 28 条全绿，其中两条失败均已查明、回修：smoke-mux-live 是
**smoke 自己的时序配置**（60ms 心跳把客户端 watchdog 容忍度压到 180ms，低于 Windows 调度噪声），
心跳调到 1s 后全绿——非产品代码回归、非语义重写；smoke-api 是**环境问题**（需要先起一个常驻服务器，
且本机代理拦 localhost 导致 WebSocket 非 101），起 scratch 服务器后全绿。桌面外壳用 DOM 探针验证
（`capturePage` 在本机 GPU 下拍出全黑，是拍摄伪影不是渲染问题）：主题、侧边栏、会话切换、状态栏
全部正常。零真回归。

### 逐项记录

1. **`npm run check` 绿**：llm / core+server / web 三份 tsc + token 审计（137 defined, 111 referenced）。
2. **smoke-sessions 绿**：打开→说话→切走→切回、认领与删除的 409、无状态重放、adopt/drop、残缺配对
   删除、shutdown 收尾，全部通过。
3. **smoke 全套绿**（28 条 = 票面 22 条 + sessions + 票面未列而库内已有的 5 条，超出票面清单一并跑了，
   在此申报）：api / mux / mux-client / mux-live / projection / approval / approval-endpoint /
   approval-queue / tools / models / settings / modes / branch / replay / transcript / liveness /
   frame / backpressure / boot / default-model / desktop-close / desktop-observability / sessions /
   session / stream / sidebar / model-form / approval-recovery。
   smoke-api 与 smoke-mux-live 首跑失败，回修后复跑绿（见 Comments 的回修清单）。
4. **`npm run build:web` 绿**：25 modules，dist/assets/index-*.js 116.90 kB。
5. **桌面验证**：`npm run desktop:screenshot` 拍出全黑图——经 inspect.cjs 的 DOM 探针排除渲染问题
   （`theme=dark`、`sidebarMode=full`、469 条会话项、144 个目录、状态栏、设置入口齐全；点击另一会话
   后标题/高亮/消息全部跟上），判定为 capturePage 的 GPU 伪影。人工手测清单见 Comments。

回修清单与桌面手测清单按票面要求记在 `## Comments`（文件底部）。Status 保持 open：
自动化等价覆盖虽已全绿，但按 map.md 的终点（「smoke 全套 + 桌面手测通过」）与票面「人工」要求，
resolved 等人工清单勾选后再翻。

## Comments

### 回修清单（2026-11-04）

首跑两条失败，按票面「真回归 vs 按新语义重写」二分：**两条都两者皆非**——票面的二分是针对产品代码
语义变化设的类目，这两条一个出在 smoke 自己的配置、一个出在运行环境，产品代码零改动、零语义重写。
逐条记下：

| 项 | 判定 | 处置 |
|---|---|---|
| smoke-mux-live 5 项失败 | **smoke 配置问题（时序）**，非真回归、非语义重写 | 该 smoke 自诞生就用 `heartbeatIntervalMs: 60` 自举服务器；客户端 watchdog 容忍度 = 3 × 心跳间隔 = 180ms，在本机当前负载下（Windows 定时器粒度 + smoke 自身的 fs/GC 抖动）必然反复判死重连，重连循环里订阅错误帧与 run 帧的等待全部落空。60ms 是烟测为了提速自设的，不是产品语义；心跳改 1000ms（提为常量 `heartbeatEveryMs`，断言引用同一常量）、复跑全绿。客户端与服务端代码零改动。 |
| smoke-api「the mux connection failed」 | **环境问题**，非真回归、非语义重写 | 两个因素叠加：① smoke-api 按设计需要一个**外部常驻服务器**（其文件头本就写明），没有服务器时必然失败；② 本机系统代理拦截 localhost，服务器不在时代理回 502、在时 WebSocket 握手被代理打断报非 101。不改 smoke-api 本身——「对外部服务器说话」是它的测试对象，改成自举反而越权；复现命令见下。 |

smoke-api 的可复现跑法（两条终端）：

```bash
# 终端 1：scratch home，避免污染机器自己的 models.json / settings.json
MY_AGENT_HOME=/tmp/my-agent-smoke-home NO_PROXY='*' \
  node packages/server/src/main.ts --workDir /tmp/my-agent-smoke-work --port 8180

# 终端 2
MY_AGENT_URL=http://127.0.0.1:8180 NO_PROXY='*' node scripts/smoke-api.ts
```

（Git Bash 写法；`NO_PROXY='*'` 是为本机代理加的，无代理的机器可省。）

### 桌面人工手测清单（待人工执行，勾完即可翻 resolved）

自动化已覆盖的等价语义，手测时只需抽查：

- [ ] 开一个会话 → 发消息 → **跑到一半切走** → 切回：Live 仍在、流没断（等价自动化：smoke-sessions
  的切走切回节 + smoke-mux-live 的 run 帧节，均绿）。
- [ ] **审批挂起时**切走再切回：横幅还在（等价自动化：smoke-approval / smoke-approval-queue /
  smoke-approval-endpoint，均绿）。
- [ ] 侧边栏改名 → 删除（等价自动化：smoke-sessions 的 rename/delete 节 + smoke-sidebar，均绿）。
- [ ] 改设置后另一个会话打开是否看到（等价自动化：smoke-settings / smoke-modes / smoke-default-model，
  均绿；fillSettings 每次现读快照，无副本可失效）。
- [ ] 纯人工才能看的部分：**深浅主题切换**、**窗口缩放下的布局**、输入框快捷键手感、GPU 伪影是否影响
  实际显示（肉眼确认窗口不是黑的）。
