# 05 三条已实证的小缺陷

Type: task
Status: resolved
Blocked by: （无）

## Question

三条互相独立、都已定位到行的小缺陷，一起修掉。

### 1. 侧边栏分组标题渲染在会话行**下面**

`packages/web/src/render/sidebar.ts:191-196` 的 `place()` 在第一行时锚点取 `parent.firstChild`，而
`sidebar.ts:225-229` 的 `groupFor()` 是**先** append 标题再 append 行。→ 第一行被插到标题前面，视觉顺序
变成"会话、会话、📁项目名"，分组越多越明显。

`scripts/smoke-sidebar.ts` 只遍历 `.session-item` 断言顺序，照不到这一层——**顺手把断言扩到子元素的顺序**，
否则修完还会再坏。

### 2. transcript 只增删、不重排

`packages/web/src/render/transcript.ts:69-92` 里没有"按 `items` 顺序重排已存在节点"的代码：新条目一律
append 到容器末尾。所以新条目落在序列**头部或中间**时（最典型：压缩产生的摘要）会被画到最下面。

用 `sidebar.renderRows` / `place` 那套手法补一次 place（侧边栏那边写对了，transcript 这边漏了）。

注意：触发路径"压缩后再来一次 baseline（重连或重新点进会话）"目前只是**单模块层面**确认的结构问题，
还没在真窗口里验证过——**先验证，再改**，别只按单模块结论动手。

### 3. 新会话的默认标题是英文 "New session"

`packages/core/src/session/session-manager.ts:785` 与 `:1836`。而且标题栏会先按 fallback 显示"新会话"
（`packages/web/src/main.ts:346`），快照一到就跳成英文——跳一下比一直英文更难看。

改成中文，并一并更新断言它的地方：`scripts/smoke-projection.ts:166`、`scripts/smoke-tools.ts:335`。

**跑**：`npm run check` + `smoke-sidebar.ts` / `smoke-projection.ts` / `smoke-tools.ts`。

## Answer

三条都修在根因上，全部验证通过。改动只落在点名的源码与 smoke 文件（外加本目录 `research/transcript-order-harness.ts` 这个最小 DOM 验证脚本）。

### 1. 侧边栏标题渲染在会话行之下

- **现象**：一个分组里第一行被 `insertBefore` 到标题前面，DOM/视觉顺序变成「会话 a > 会话 b > 📁项目名」，分组越多越明显。
- **根因**：`sidebar.ts` 的 `place()` 在 `previous === undefined` 时锚点取 `parent.firstChild`，而 `groupFor()` 把标题作为 wrapper 的第一个子元素先 append —— 于是「第一行」的锚点正好是标题本身。
- **修法**：`renderRows()` 里把 `previous` 的初值从 `undefined` 换成 `wrapper.firstElementChild`（即分组标题），第一行因此插在标题之后；后续行仍用前一行做锚点。
- **证据**：`scripts/smoke-sidebar.ts` 新增小节「分组标题在会话行之上」，断言每个 `.workspace` 的首个子元素是 `workspace-head` 且其后不再出现标题。临时回退修法时该断言红：`session-item > session-item > workspace-head`；修完绿：`workspace-head > session-item > session-item` 与 `workspace-head > session-item`。

### 2. transcript 只增删、不重排

- **现象**：压缩摘要（应落在序列头部）被画到最下面。用最小 DOM 宿主驱动生产 `TranscriptView` 复现：首帧 `[user, assistant]`，再喂 `[summary, user, assistant]`，容器子元素变成 `user, assistant, summary`（摘要垫底）。
- **修法**：`transcript.render()` 在增删之后补一次按 `items` 顺序的 `place`：逐项从 `turns`/`tools` 取已有节点，用新增的私有 `place()`（与 sidebar 同款「已在该处就不动」）排序。节点生命周期不变，只移动、不重建。
- **证据**：`.scratch/window-rework/research/transcript-order-harness.ts`。回退修法时两条断言红（"the summary is drawn first, not last"、"a mid-sequence item lands in the middle"），修完绿。
- **未验证**：真窗口里的端到端路径（真压缩 → 重连/re-open baseline）本子代理无法在 Electron 窗口内跑，只在单模块 + 最小 DOM 宿主层确认；结构上 baseline 就是按 `items` 顺序重放，与验证脚本喂的输入一致。

### 3. 新会话的默认标题是英文 "New session"

- **改法**：`session-manager.ts:785`（`titleOfBranch`）与 `:1836`（`deriveTitle`）的 `"New session"` → `"新会话"`，与 `main.ts` 的快照前 fallback 一致。
- **证据**：更新断言它的两处 —— `scripts/smoke-projection.ts:166`、`scripts/smoke-tools.ts:335`；两处都从红（旧值）变绿。
- **遗留**：`docs/architecture.md:214` 有一处散文引用了旧的 `"New session"` 占位名。它属于本 ticket 未点名的文件（硬约束：只碰点名文件），未改，建议主 agent 顺手更新。

### 验证

- `npm run check`：通过（`tokens ok: 104 defined, 81 referenced`）。
- `scripts/smoke-sidebar.ts`：通过（含新增的两条子树顺序断言）。
- `scripts/smoke-projection.ts`：通过。
- `scripts/smoke-tools.ts`：通过（`all tool checks passed`）。
- `scripts/smoke-mux-live.ts`：通过（04 号那条新 smoke 未受影响）。
- `scripts/smoke-sessions.ts`：通过。

未 commit、未建分支，改动留在工作区。
