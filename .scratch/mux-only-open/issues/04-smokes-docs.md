# 04 - smoke 与文档收账：全绿并翻转 ADR 状态

Type: task
Status: resolved
Blocked by: [01 - 服务端 open 幂等](01-server-mux.md)、[02 - 客户端 pending-open 状态机](02-client-pending-open.md)、[03 - openSession 重写与页面加载](03-web-open-session.md)

## Question

smoke 断言与文档跟到新实况，全量验证后把记录层翻转：ADR-0010 状态行去掉「尚未落地」、`docs/adr/README.md` 清单行补「已落地」、本 map 状态改 done。

## 要点

- **`scripts/smoke-mux-client.ts`**：重复 open 的断言从"被拒绝"改为"重发基线"；补一条"基线迟到 + series 作废"的用例（旧 baseline 后到 → 不画不报错）。
- **`scripts/smoke-projection.ts`**：envelope 断言应不变，核对无 REST 导航路径残留。
- **`docs/architecture.md`**：「谁拥有一个会话 / wire / API」三节里关于打开会话的描述改为单源说法；检查是否有"先 REST 读再订阅"的旧话。
- **`packages/web/src/main.ts`**：`openSession` 注释在票 03 已重写，本票只复核没有漏网的"两条 baseline"措辞（全仓搜 `api.read`、`replace it within a moment`、双源相关词）。
- **全量验证**：`npm run check` + `npm run build:web` + smoke-session / smoke-approval-queue / smoke-projection / smoke-mux-client / smoke-replay / smoke-backpressure 全绿（后两张与本图无直接关系，跑绿是回归底线）。

## 收账

- 全绿结果贴 Answer 节；ADR 状态行、README 清单行、map 状态三处翻转；Answer 节记录实际校准的超时值与依据（票 02 的未决项在此定稿）。

## Answer

**三处记录翻转了，两节文档改成单源说法，smoke 补上新语义并全绿。**

### smoke：`scripts/smoke-mux-client.ts`

新增 §10「两份基线：重复 open 再送一份，迟到的那份不画」，13 条断言。文件头那句"the four behaviours"也顺手改准了（02 之后它早已不止四条）。

- **重复 open 的断言（票面第一条）**：pane 归位到一个 send 还持有的会话——`retain` 再发 `open`，服务端那份基线**settle 这次导航**（`submitting: true` 也照收），并且照常交给窗口重画（`s1/baseline` 计到 2 次），全程没有一条错误帧。旧的"被拒绝"断言（在 `smoke-mux.ts` 服务端侧）01 号票已改，这里补的是客户端这一半：一份重复基线是**重画**，不是失败。
- **「基线迟到 + series 作废」（票面第二条）**：先点 a 再点 b，b 的基线先到、a 的后到。四条：迟到的那份**仍答清它自己那次导航**（不答就是一个三秒后怪"服务器慢"的定时器）、**被交到窗口手里**（这层不吞帧）、**不画**（画面仍是 b）、**不报错**（`onStreamError` 与窗口侧的报告都是空）。收尾再确认两条订阅都还在——作废只管画与报错，不管订阅。
- 关于"不画"这一半：`main.ts` 的 series 比较没有独立入口（`openSession` 是闭包），所以这一节把窗口那条规则（只有最新的 series 能画）在脚本里复述了 6 行，注释点名它复述的是谁。客户端侧的断言是硬的；窗口侧那一半是**模型**，真窗口的验收仍只有 03 号票那个脚本（见末条）。
- `scripts/smoke-projection.ts` **零改动**：envelope 断言（`open` / `cancel` 两个上行帧、`baseline` 在会话流上、行表在连接级）在新语义下全部照旧成立，"无 REST 导航路径残留"是核对项不是断言项——见下。

### 文档

**`docs/architecture.md`（四处）**

1. §谁拥有一个会话：`read()` 那段后面加一句"窗口打开一个会话也不走这条路"——打开、切换、页面加载都是一次订阅，`open` 帧以基线作答，前端导航路径上不发生任何读取；`read()` 退回它在命令面上的位置（脚本与诊断）。
2. §API：`GET /api/sessions/current` 从"落地端点"改为"页面加载的**起点**"——它只回答"该开哪一个"，打开仍旧是一帧 `open`，它自己不画任何东西；并新增一段说明 `GET /api/sessions/{id}` 与窗口无关（窗口从不发它）。
3. §wire 的函数签名注释："这条逻辑流的第一帧，且只有它一份"（01 号票点名留下的那句）→"这条逻辑流的起点：每次 open 一份，重复 open 再送一份"。
4. §wire 的 `baseline` 段落：补进幂等那一半——`open` 是幂等原语，重复订阅不被拒绝而是再送一份，所以一条流上的 `baseline` **不止一份**（分支移动的 `pushBaseline` 也是如此），"第一帧"是事实、"只有一份"不是；作废判定在窗口，按到达时的 series 整帧丢弃。上行帧那段也补了"已订阅也照发"。

**`docs/adr/0010-open-session-over-mux.md`**：状态行去掉"尚未落地"；验收边 1 的措辞按 03 号票的实况写准（"不产生任何**会话** REST 请求"，侧边栏列表修复仍走 `/api/directories`，那不属于打开会话）；落地清单里 `api.ts` 那行改成实况（只删 `read`，`current()` 留着）；未决事项的超时那条改写成定稿记录（见下）。

**`docs/adr/README.md`**：0010 清单行由「**尚未落地**」改为「已落地——01–04 号票跑绿 check、build:web 与 smoke 全套」。

**`packages/web/src/main.ts`**：**零改动**。全仓搜 `api.read`、`replace it within a moment`、`openReads`、`两条基线`/`two baselines` 均无命中；`openSession` 的四条顺序注释已经是帧的说法，没有任何一处还在承诺"REST 先画、基线随后替换"。

### 超时取值：3 s，定稿（票 02 的未决项）

保留 **3 s**（`openTimeoutMs` 可覆盖，smoke 压到 120 ms）。依据是实测 + 判断两半：基线信封的 `JSON.parse`（200 条 / 0.13 MiB → 0.3 ms；1000 条 / 0.64 MiB → 1.4 ms；3000 条 / 1.93 MiB → 3.5 ms）说明 CPU 三个数量级有余，真正的等待是基线排在一个大帧后面——所以 3 s 买的是**排队余量**；往下收紧只会把"忙"报成"坏"，而"坏"这一格今天没有别的机制兜（服务端 10 s 停滞上限要等到 `1013` 才动）。**仍未测**：真实大会话 + 流式刷屏下的写侧排队时长（要真 provider 跑大会话），所以 ADR 那条从"随手写的初始值"变成"有下限论证的初始值"，而不是消失。

### 全量验证（本机，Node 22.22.2 / Windows）

```
npm run check          → 绿（三个 tsc 项目 + token 审计 137 定义 / 111 引用）
npm run build:web      → 绿（25 modules，116.71 kB js / 52.98 kB css）
```

smoke 全绿（19 张，逐张跑）：

`smoke-mux-client`（含新 §10）、`smoke-projection`、`smoke-session`、`smoke-approval-queue`、`smoke-replay`、`smoke-backpressure`——票面点名的六张；回归另跑 `smoke-mux`、`smoke-mux-live`、`smoke-liveness`、`smoke-boot`、`smoke-stream`、`smoke-transcript`、`smoke-branch`、`smoke-frame`、`smoke-sidebar`、`smoke-settings`、`smoke-modes`、`smoke-models`、`smoke-model-form`、`smoke-default-model`、`smoke-sessions`、`smoke-approval{,-endpoint,-recovery}`、`smoke-desktop-close`、`smoke-desktop-observability`。

两处如实记下：

- **`smoke-mux-live` 这次是绿的**（03 号票记过它在本机 flaky：心跳 60 ms、看门狗 180 ms）。本轮没动它，绿是运气好，那条隐患仍在。
- **`smoke-tools` 首轮在末尾崩了一次**（输出尾巴是 Node 的未捕获异常，栈没留住；Windows 临时目录清理那类），紧接着连跑两次全绿。与本图无关，但记在这里，免得下次当成新问题。
- `smoke-api` 需要先起服务器（`MY_AGENT_URL`），本机没起，未跑（与 01/03 号票一致）。

### 没做的一件事：`accept.ts` 不升格为 `scripts/smoke-window.ts`

03 号票留的问题，本轮定为**不升格**：它要真 Chromium + `dist` 产物，而现有 19 张 smoke 全是纯 Node、不需要浏览器也不需要打包（`scripts/cdp.ts` 目前无人引用）。把它塞进"全量验证"会让一套类型检查 + 无依赖脚本的验证线多出一个外部依赖和一套时序 flaky。它留在 `.scratch/mux-only-open/accept.ts`，作为 ADR 验收边 1–4 的**一次性验收记录**（6/6 绿）而不是常规回归；真要常规化，应当单开一张票，顺带决定 CI 里怎么弄浏览器。

