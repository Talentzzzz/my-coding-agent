# 01 - 建立验收基线：改动前的 check + smoke 对跑清单

Type: task
Status: resolved

## Question

动任何源码之前，先把「改动前」这棵树实测一遍，逐条记进 Answer：

- `npm run check`（含 token 审计）一条；
- `README.md:131-161` / `AGENTS.md:179-181` 列出的 smoke 全套，逐条绿/红与失败原因；
- 特别标明两条**既有红**：`smoke-api`（需要一只在跑的服务器）与 `smoke-liveness`
  （本机时序断言，`.scratch/context-tool-unification/` 04 号票已记「改动前后同红」）。

用途：本图每张执行票按同一口径对跑，判据是「**零新红**」而不是「全绿」。基线要能逐条复现
（命令、端口、环境、随机 id / 端口导致的日志差异怎么归因）。AFK，agent 独自完成；红的照实记、不修。

➡️ 推荐：照跑不修。若 `npm run check` 今天不绿，先记下、不并入本图修（那是另一条线）；
`smoke-api` 起一只服务器再跑一遍，把「有服务器时 ok」也记上。

## Answer

实测于 **2026-11-06 13:57–14:02 +0800**，改动前那棵树（`git HEAD`
`10b3d8e9ea34b9b4cbdf77e1f7b256b23f759f41`，tracked 文件干净，`git status --short` 只有
untracked 的 `.scratch/` 项），AFK 独自跑完。**照跑不修**：每条红都原样记下，一行源码没动。

### 0. 环境与复现口径

完整环境在 `../smoke-runs/baseline/env.txt`，批量脚本 `../smoke-runs/run-all.sh`（沿用
`.scratch/context-tool-unification/smoke-runs/run-all.sh` 的口径：`ls scripts/smoke-*.ts | sort`、
串行、每脚本一个 node 进程、逐条 `<name>.log` + `summary.txt`）。win32 / Git Bash、
node v22.22.2、npm 11.12.1；`NODE_OPTIONS` 的宿主 language shim **保持原样未清**；
`CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=100000`（宿主默认 50 会挡在 smoke 清理临时 store
那一步）；开始时 8080 空闲、`MY_AGENT_HOME` / `MY_AGENT_URL` 在无服务器口径下都未设。

全部输出落在 `../smoke-runs/baseline/`：`check.log`、`summary.txt`、28 份 `<name>.log`、
`health.json`、`server.log`、`smoke-api-with-server.log`、四份 `rerun-*.log`。
**改动后对跑**：同一脚本换个输出目录（如 `smoke-runs/after/`），逐份 diff 日志即可，口径完全一致。

三条复现命令（仓库根）：

```bash
npm run check
bash .scratch/tool-manager-refactor/smoke-runs/run-all.sh .scratch/tool-manager-refactor/smoke-runs/baseline
MY_AGENT_URL=http://127.0.0.1:8080 node scripts/smoke-api.ts   # 需先起服务器，见 §4
```

### 1. `npm run check`：绿

`exit=0`。两棒 tsc（core+server、web 客户端）零输出，token 审计
`tokens ok: 137 defined, 111 referenced`；完整输出只有 npm 回显的三行，存 `check.log`。
今天没有「不绿」，票面「先记下、不并入本图修」那条分支未触发。

### 2. 全套 smoke（无服务器口径）：首轮 25 绿 / 3 红，稳态 26 绿 / 2 红

28 个脚本 = README:135-158 的全部，加 `scripts/smoke-*.ts` 全集里另两条库内 smoke
（`smoke-replay`、`smoke-stream`）——两套清单按同一口径一起跑，多跑的不算红也不算漏。
串行共 2m39s。逐条（`exit` / 秒，取自 `summary.txt`）：

| 脚本 | exit | s | 备注 |
|---|---|---|---|
| smoke-api | **1** | 0 | 既有红：无服务器，见 §3 |
| smoke-approval-endpoint | 0 | 10 | 绿；垫片那次 `\x00` 路径崩本次未复现 |
| smoke-approval-queue | 0 | 1 | |
| smoke-approval-recovery | 0 | 1 | |
| smoke-approval | **1** | 6 | 偶发，复跑 2/2 绿，见 §3 |
| smoke-backpressure | 0 | 1 | |
| smoke-boot | 0 | 6 | `index 200`（`packages/web/dist` 在） |
| smoke-branch | 0 | 0 | |
| smoke-default-model | 0 | 1 | |
| smoke-desktop-close | 0 | 0 | |
| smoke-desktop-observability | 0 | 0 | |
| smoke-frame | 0 | 1 | |
| smoke-liveness | **1** | 13 | 既有红：本机时序断言，见 §3 |
| smoke-model-form | 0 | 0 | |
| smoke-models | 0 | 0 | |
| smoke-modes | 0 | 0 | |
| smoke-mux-client | 0 | 0 | |
| smoke-mux-live | 0 | 17 | |
| smoke-mux | 0 | 13 | |
| smoke-projection | 0 | 10 | |
| smoke-replay | 0 | 0 | README 清单外 |
| smoke-session | 0 | 2 | |
| smoke-sessions | 0 | 55 | |
| smoke-settings | 0 | 1 | |
| smoke-sidebar | 0 | 0 | |
| smoke-stream | 0 | 17 | README 清单外 |
| smoke-tools | 0 | 2 | 223 行，逐字节对跑的好样本 |
| smoke-transcript | 0 | 1 | |

### 3. 两条既有红，加一条偶发红

- **`smoke-api`（无服务器）**：`exit=1`，3 行日志——`target http://127.0.0.1:8080` →
  `FAIL: Error: the mux connection failed`。票面标的那条既有红，缺的只是那只服务器（§4 补齐）。
- **`smoke-liveness`（本机时序断言）**：`exit=1`，**稳定红**。首轮全套里是 4 个 FAIL
  （baseline 0 / `0 bytes dropped` / second connection 8 / re-opened with fresh baseline 1）；
  单独复跑 2/2 仍红，但收窄成票面那条断言——`within three of the heartbeats it was promised,
  plus margin for the runtime`，实测 **1943 / 1898 ms**，预算 `3×50+1500 = 1650 ms`
  （`scripts/smoke-liveness.ts:118-122`）。与 `.scratch/context-tool-unification/`
  04 号票记的 1967 / 1974 / 1982 ms 是同一处、改动前后同红；那张票已证过清掉 `NODE_OPTIONS`
  垫片仍红，本次不重复、不改断言、不修。**同一条脚本在不同轮次的 FAIL 组合并不一致**，
  对跑时只比「是否红 / 红在哪条断言」，不逐字节比这份日志。
- **`smoke-approval`（偶发，非既有红）**：首轮 `exit=1`，6 s 就崩（正常 21 s），
  `Error: wire: open 01a1af6f-… 之后没有等到基线`（`scripts/wire/client.ts:209` 的 5 s 基线等待
  超时）。单独复跑两次都 `exit=0`（各 21 s），见 `rerun-smoke-approval-1.log` / `-2.log`。
  判定本机时序抖动导致的偶发，与 `context-tool-unification` 04 号票记的
  `smoke-approval-endpoint` 垫片偶发崩同类。**不计入既有红集合**；对跑时若再出现，按
  「单独复跑 2 次」定性，别直接算新红。

于是**稳态基线红集合 = { `smoke-api`（无服务器）, `smoke-liveness`（本机时序）}**，26 绿。
「零新红」就是不出现第 3 条稳定红。

### 4. `smoke-api` 有服务器：`api ok`

```bash
MY_AGENT_HOME=C:/Users/a1368/Desktop/my-coding-agent/.scratch/tool-manager-refactor/smoke-runs/baseline/agent-home \
  node packages/server/src/main.ts --workDir . --port 8080
# GET /api/health → {"ok":true,"workDirAbsPath":"C:\\Users\\...\\my-coding-agent","live":[]}
MY_AGENT_URL=http://127.0.0.1:8080 node scripts/smoke-api.ts
```

`exit=0`，2 s，44 行日志末行 `api ok`，存 `smoke-api-with-server.log`；服务器日志与 health
响应存 `server.log` / `health.json`。占位模型 `my-agent:unconfigured` 立即以
`No model is configured yet` 收尾，供应商失败仍是 settled run，没走脚本注释里那段 ~14 s 的
retry 回退。服务器跑完已停（8080 只剩 `TIME_WAIT`，无 LISTENING）。
**「有服务器时 ok」记上了**：无服务器那条红纯粹是环境缺失，不是产品回归。

### 5. 随机 id / 端口导致的日志差异怎么归因

- `smoke-boot.log`：随机端口 `52411`、临时 home `…\AppData\Local\Temp\my-agent-boot-Gd453x`、
  会话 id `01a1af6f-…` —— 三处每轮必不同，不算行为差异。
- `smoke-api-with-server.log`：`created` / `baseline` / `replacement` 两个 UUID；
  `smoke-approval.log`：错误消息里的 UUID。同为每轮必不同，按值忽略。
- `smoke-liveness.log` 与 `rerun-smoke-liveness-*.log`：毫秒数与 FAIL 计数随本机时序抖动
  （首轮 4 个、复跑各 1 个），逐字节 diff 必然不等。
- `server.log` / `health.json` / `smoke-api.log` 里的 `127.0.0.1:8080` 是本次**固定**口径、不是
  随机端口；复现就固定 8080，别让它落在别处。
- 其余 24 份日志没有随机量，对跑应逐字节相同；`smoke-tools.log` 223 行可作抽查样本
  （`context-tool-unification` 04 号票也用的这条）。

### 6. 结论与交接

改动前基线：**`npm run check` 绿；28 条 smoke 稳态 26 绿 / 2 既有红；`smoke-api` 起服务器后 ok**。
后续每张执行票用 `run-all.sh` 换输出目录按同一口径对跑，判据「零新红」；偶发红走复跑定性。
本票未改任何源码、未修任何红，也没有把任何红并入本图。
