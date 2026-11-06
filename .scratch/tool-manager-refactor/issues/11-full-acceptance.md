# 11 - 全量验收：grep 清零、28 条 smoke 对跑、build:web、0016 状态行

Type: task
Status: open
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
