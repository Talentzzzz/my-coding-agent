# 11 - 全量验收：grep 清零、28 条 smoke 对跑、build:web、0016 状态行

Type: task
Status: resolved
Blocked by: 10

## Question

按 map *Destination* 收口整张图：代码（07–09）、文档（10）都已落地，本票只做「拿全套跑一遍、把数字写进
ADR」这一件事——不修代码、不改决定，除非跑出与 01 号票基线不同的红。

### 依据

- **01 号票的基线口径**：改动前 `10b3d8e` 实测 `check` 绿（`tokens ok: 137 defined, 111 referenced`）、
  28 条 smoke 稳态 **26 绿 / 2 既有红**（`smoke-api` 缺服务器、`smoke-liveness` 本机时序），
  判据是**零新红**而不是全绿；随机 id / 端口 / 毫秒数的归因也在那张票里。
- **06 §3.1 理由 2**：0016 的「不可逆性与代价」要写**已落地**的验收口径，数字只有本票跑完才有。
- **06 §4 验收行**：新 ADR 的状态行引用本票结论。
- **map *Destination***：代码落地、`check` 与 smoke 按基线零新红、`AGENTS.md` / `architecture.md` 与实况
  一致、ADR 收账、`ToolRegistry` 及其旧名词全仓清零。

### 要做的事

1. `npm run check`（core + server + 13 条脚本 + web token 检查）。
2. 28 条 smoke 全套对跑（`../smoke-runs/run-all.sh` 无服务器口径），逐份与基线 diff；
   `smoke-api` 的「起服务器后 ok」那一遍按 01 号票 §4 的方法补跑一次（这次有代码改动，不能再沿用旧结论）。
3. `npm run build:web`（map 的 endpoint 清单里点名了这一项）。
4. grep 清零复核：`ToolRegistry` / `createToolRegistry` / `createTools` / `toolDefinitions` /
   `toolListFor` 在 `packages/`、`scripts/`、`AGENTS.md`、`docs/architecture.md`、`README.md` 归零，
   豁免面（ADR 历史正文、`.scratch/`）逐条列命中数。
5. 把结论写进 `docs/adr/0016-*.md` 的状态行（照 0015 状态行的写法：日期、票号、「`check` 与 `build:web` 绿、
   smoke 与改动前逐条同色零新红」），并核 0016 的另外五节与实况不再打架。

### 边界（不做）

- 不修代码、不改 02–10 已 resolved 的票；跑出**新红**就停下来开新票或回写原因，不在本票顺手改。
- 不往 `AGENTS.md` / `architecture.md` / `notes.md` 加新段落（10 已收完）；只核对 0016 状态行。
- 不提交 `smoke-runs/` 日志与临时 home。

### 验收 / 产出

- `check` 绿、`build:web` 绿；28 条 smoke **零新红**，逐份 diff 的不等项全部落在 01 号票 §5 的随机量清单里。
- `docs/adr/0016` 状态行写的是本票数字（不是 06 的预期）。
- `map.md` 追加 07–11 的 Decisions so far 指针，*Not yet specified* 清空到「本图已走完」。

### 交接

`## Answer` 记：三套数字（check / smoke / build:web）、红集合与归因、grep 清零与豁免的命中数、
0016 状态行的最终措辞、以及整张图是否够格 graduate 关闭。

## Answer

**2026-11-07 00:29–00:45 +0800 全量验收**：`git HEAD` `417fa90`（10 号票），起点 `git status --short` 里
tracked 文件干净（未跟踪项是历史 scratch、`smoke-runs/` 的日志目录与 `.reviewtmp/`）。**零源码改动**——
本票只跑、只记账，动的两处全是文档数字（0016 状态行、`map.md` 收口）。输出全部落在
`.scratch/tool-manager-refactor/smoke-runs/after-11/`（`check.log`、`build-web.log`、`summary.txt`、
28 份 `<name>.log`、`server.log`、`health.json`、`smoke-api-with-server.log`、`rerun1..7/`），**不入提交**。

### 1. 三套数字

| 口径 | 结果 | 证据 |
|---|---|---|
| `npm run check` | **exit=0**，两棒 `tsc` 零输出 + `tokens ok: 137 defined, 111 referenced` | `after-11/check.log`（5 行、3 行非空，与基线**逐字节相同**） |
| 28 条 smoke（`run-all.sh`，无服务器） | **25 绿 / 3 红**；整轮墙钟 3m39s（后台任务计时，各条秒数合计 216 s） | `after-11/summary.txt` |
| `npm run build:web` | **exit=0**，25 模块，`dist/index.html` 1.49 kB、`index-L0rhCtf5.css` 52.98 kB、`index-DG-PbtuT.js` 116.90 kB，653 ms | `after-11/build-web.log` |
| 补跑 `smoke-api`（固定 8080 服务器） | **exit=0，2 s，44 行，末行 `api ok`** | `after-11/smoke-api-with-server.log` |

逐条 exit / 秒（`summary.txt` 原文）与 01 号票的同名表逐行同色：`smoke-mux-live` 33 s、`smoke-sessions`
86 s、`smoke-stream` 24 s 这些耗时较长的都绿，`smoke-api` 0 s、`smoke-liveness` 12 s、`smoke-approval` 6 s
三条红。

### 2. 红集合与归因：2 条既有红 + 1 条偶发，**零新红**

| 脚本 | exit | 判定 | 证据 |
|---|---|---|---|
| `smoke-api` | 1 | **既有红**：无服务器口径，缺的只是那只服务器 | `smoke-api.log` 3 行，与基线**逐字节相同**（`the mux connection failed`）；`smoke-api-with-server.log` 44 行 `api ok`，与基线只差 `created` / `baseline` ×2 / `replacement` 三个 UUID（4 行） |
| `smoke-liveness` | 1 | **既有红**：本机时序断言 | `within three of the heartbeats…` 实测 **2009 ms** 对 `3×50+1500 = 1650 ms` 预算；红在哪条断言与基线一致，只是本轮 FAIL 组合换成 `within three…` + `a second connection arrived at the relay 4`（基线是后一条 + `0 bytes dropped`）——01 §3 已写明「同一条脚本不同轮次 FAIL 组合并不一致，只比是否红 / 红在哪条」 |
| `smoke-approval` | 1 | **偶发，不计入红集合** | 与基线首轮**同一处、同一句话**：`scripts/wire/client.ts:209` 的 5 s 基线等待超时（首轮 6 s 崩在 `smoke-approval.ts:162`，日志与基线只差错误消息里的 UUID）。复跑 **7 次**：`rerun1` 1 s 崩在宿主 fs 垫片的 `\x00` 路径（`ERR_INVALID_ARG_VALUE`，01 §2 记过同款，是环境不是产品）、`rerun2` 30 s 崩在同一脚本第二进程段落的 `:633`（同一条等待）、`rerun3–7` **5/5 绿**（26–28 s） |

⇒ **稳态口径 26 绿 / 2 既有红，零新红**。这条换算的依据是**基线自己也是首轮 25 绿 / 3 红**（01 §2 的表里
`smoke-approval` 就是那第三条，同一句话 `wire: open … 之后没有等到基线`），两轮首轮**逐条同色**；第三轮的
差别只在复跑：基线 2/2 绿，本票 5/7 绿（另两次一次是宿主垫片崩、一次是同一条等待超时）。
`smoke-approval` 这次比基线多栽一次（`rerun2` 的 `:633`），判定仍是本机时序：同一脚本 5 次连绿、失败点每次
不同、且失败都是「5 s 内没等到 baseline 帧」这一条，与 09 号票记的「第三条红本机轮换」同一现象。**没有开新
票**——按票面「跑出新红就停下来开新票」，这不是新红（不是稳定红、不在产品断言上）。

### 3. 逐份 diff

**28 份中有 23 份与基线逐字节相同**（含抽查样本 `smoke-tools.log` 223 行，与基线、after-09 三方全同；
`smoke-sessions.log`、`smoke-mux.log`、`smoke-projection.log` 这些大日志也全同）。5 份不等，逐份归因：

| 日志 | 不等行 | 归因 |
|---|---|---|
| `smoke-session.log` | 31 | 07/08/09 已记的断言改写（`build()` → `get()`、`active()` 退场、新增「同一实例」「重新启用即照跑」「批次」各条）；**与 after-09 逐字节相同** |
| `smoke-approval-recovery.log` | 3 | 09 新增的三条 `ok`（名单外的 grant 不到闸门）；**与 after-09 逐字节相同** |
| `smoke-boot.log` | 6 | 随机端口 `52411`→`51176`、临时 home `…-Gd453x`→`…-bUJivi`、会话 id `01a1af6f-…`→`01a1b1b1-…`，01 §5 点名的三处随机量 |
| `smoke-liveness.log` | 9 | 毫秒数 + FAIL 组合（见 §2），01 §5 点名「逐字节 diff 必然不等」 |
| `smoke-approval.log` | 2 | 错误消息里的 UUID，01 §5 点名按值忽略 |

另与 after-09（上一轮，代码已收口）对跑：28 份中 24 份逐字节相同，4 份不等——`smoke-boot`（随机量）、
`smoke-liveness`（毫秒）、`smoke-approval`（本轮红 run 对 09 的绿 run；09 那次绿），以及 `smoke-mux-live`
（**09 那轮它是第三条红**，本轮绿且与基线逐字节相同，6 行差就是那次 flake 的痕迹）。
`smoke-api-with-server.log` 与基线的差只有 `created` / `baseline` / `replacement` 三个 UUID（4 行），44 行结构一致。

### 4. grep 清零复核

命令同 10 号票 §3（`grep -rn -F`，文档面 `AGENTS.md` / `docs/architecture.md` / `README.md` / `docs/notes.md`，
源码面 `packages/{core,server,web,desktop}/src` + `scripts`，`--include=*.ts --include=*.tsx`）：

| 词条 | 文档面 | 源码面 |
|---|---|---|
| `ToolRegistry` / `createToolRegistry` / `ToolDefinition(s)` | 0 | 0 |
| `createTools(run)` / `toolDefinitions()` / `toolListFor` | 0 | 0 |
| `active(state, run)` / 「现建可执行集合」 / 「五个方法」 | 0 | 0 |
| 「不在任何一处持有」 / `tools/registry.ts` / 「工具目录」 / 「工具注册表」 | 0 | 0 |

对五个旧符号（`ToolRegistry` / `createToolRegistry` / `createTools` / `toolDefinitions` / `toolListFor`）
另跑一遍不带括号的口径，`packages/` + `scripts/` 亦为 **0**（排除 `dist/` 与 `*.map` 的构建产物；`packages/web/dist`
是本次 `build:web` 重生成的新产物，里面本来也没有这些名字——窗口只消费快照里的字符串数组）。

**豁免面（历史叙述，逐条列命中数）**：

| 面 | 命中 | 明细 |
|---|---|---|
| `docs/adr/` 全目录 | **7 处 / 3 个文件** | `0012` 1、`0013` 1（只增不改的历史正文）；`0016` 自己 **4 行 5 处**（背景 2 行 `ToolRegistry` + `toolDefinitions()`、同名反义 1 行、决定 1 的 1 行含 `ToolRegistry` 与 `createToolRegistry` 两个） |
| `.scratch/` 全目录 | **16 个文件 / 215 处** | 按词条（写完本 Answer 之后重数）：`ToolRegistry` 79 / `createToolRegistry` 42 / `createTools` 28 / `toolDefinitions` 41 / `toolListFor` 25。16 个文件里 13 个是本图 02–11 的决策票与 `map.md`，另 3 个是更早的 `agent-state` / `pure-services` / `stateless-agent` 历史票 |

与 10 §3 记的「`.scratch/` 16 个文件、69 处」的差不是漂移，是**口径**：10 只数了本图决策票里「旧名字作为
被处置对象」的那些行，本票数全目录五符号的全部命中。**本票自己的正文也会被数进来**：写 Answer 之前同一口径
是 196 处，写完是 215 处，多出的 19 行正是这段正文里点名旧符号的地方——这正是「决策票是历史叙述」的豁免
依据本身。文件数在两次测量里都是 16，说明被引用的面没有扩散。

### 5. 0016 状态行：最终措辞

```text
日期：2026-11-06 · 状态：已接受，**已落地**（07–09 号票；2026-11-07 全量验收，见
[11 号票](../../.scratch/tool-manager-refactor/issues/11-full-acceptance.md)：`npm run check` 与 `build:web` 绿
（`tokens ok: 137 defined, 111 referenced`），28 条 smoke 与改动前逐条同色、零新红——`smoke-approval` 两边都
以首轮偶发红、复跑绿收场，`smoke-api` 要一只在跑的服务器（起了就 `api ok`），`smoke-liveness` 的时序断言在
本机改动前后同为红；五个旧符号与旧说法在 `packages/`、`scripts/`、`AGENTS.md`、`architecture.md`、
`README.md` 里归零）
```

照 0015 状态行的四件事：日期、票号、`check` 与 `build:web` 绿、「smoke 与改动前逐条同色零新红」。
**写的是本票实测数字（137/111、28 条、`api ok`），不是 06 的预期。** `docs/adr/README.md` 的 0016 清单行
（ADR 收账的入口清单）同一笔同步成「11 号票全量验收：`check` 与 `build:web` 绿、smoke 逐条同色零新红」，
否则那份清单会把状态停在 10 号票的口径上。

**另外五节与实况核对**（逐条对到今天的代码，未改一字——核对结论记在这里）：

- **决定 1/2/3**：`packages/core/src/tools/` 里 `registry.ts` 已不在；`manager.ts` 的 `ToolManager` 四法
  （`names:131` / `get:142` / `execute:154` / `register:174`）、`ensureFilled:192` 一次填满六个零参工厂、
  `ToolRunContext` 从 `llm/types.ts:445` re-export。**对**。
- **决定 4**：`manager.execute(...)` 是生产代码唯一的 `Tool.execute` 调用点——`agent.ts:2534` 调用、
  `manager.ts:164` 转发，`grep "tool.execute("` 在 `packages/core/src` 只剩这一处转发。`activeTool` 在
  `agent.ts:2021`，`Tool <name> not found` 只在 `prepareToolCall:2388`。`PreparedToolCall.tool` 已不在。**对**。
- **决定 5**：`declaredTools:1326` 按名单 `map(get)`，`toToolDeclaration` / `streamAssistantResponse` 不动，
  压缩摘要 `agent.ts:1576` 仍是 `tools: []`。**对**。
- **决定 6**：`session/tool-config.ts` 的四函数都在，`defaultToolNames` / `globalDefaultToolState` /
  `toolStateOf` / `followsGlobalOf` 均收 `known: readonly string[]`，账本格式未动。**对**。
- **决定 7**：`AgentConfig.tools: ToolManager`（`agent.ts:133`）、`SessionServices.tools`（`fanout.ts:27`）、
  进程一只——`hub.ts:199` 的 `readonly tools: ToolManager = createToolManager()`，`session-factory.ts:149/293`
  的 `?? createToolManager()` 是测试与单会话的自组口，`openAgent` 转交 `assembleSession` 造的那只（同文件
  `openAgent` 段，注释里点明「two managers would mean two sets of instances」）。**对**。

### 6. `map.md` 收口与 graduate 结论

- *Decisions so far* 追加 **11** 一条（三套数字、零新红的归因路径、grep 面与豁免数、Destination 达成）；
  07–10 的四条原本已在。
- *Not yet specified* 清空成**「本图已走完（2026-11-07，11 号票收账）」**，保留两行历史留痕（切票理由、
  四块旧雾的归属），票号清单不再重复（它们在 *Decisions so far* 里）。
- 头部 `Status: open` → **`closed`**。

**够格 graduate 关闭**：Destination 六条逐条成立——①代码落地（07–09 + 本票核对）；②`npm run check` 绿；
③smoke 全套按基线零新红（本票实测，两条既有红有归属）；④`AGENTS.md` / `docs/architecture.md` 与实况一致
（10 号票逐句改写，本票核对到的七条决定与两份文档不打架）；⑤ADR 收账（0016 + 四份取代者指针 + 八处标注 +
清单行，状态行已填本票数字）；⑥`ToolRegistry` 及其旧名词在 `packages/` / `scripts/` / 三份文档全仓清零，
豁免面只剩历史正文与决策票。

**两条既有红不随本图关闭**：`smoke-liveness` 的 5 s→1650 ms 预算与 `smoke-api` 的「要一只在跑的服务器」
都是本机/rig 的环境问题，`context-tool-unification` 04 号票与 01 号票已各自登记，本图不动。

