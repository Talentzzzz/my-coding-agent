# 01 - core：holds 迁入 SessionManager（文件级簿记 + 方法内化持有）

Type: task
Status: resolved
Blocked-by: （无——这是图的根）

## 背景与指针

- Spec：`Z:/my-coding-agent/.scratch/holds-into-manager/spec.md`（实现决定第 1、2 条 + Testing Decisions 的 Manager 级用例）。
- 探索笔记（行号、现状代码、全部细节）：`C:/Users/Administrator/WorkBuddy/spaces/2026_11_17_14-35-39/holds-into-manager-notes/exploration.md` §1、§3。
- 上一棒迁移的历史文档：`docs/handoff-remove-host-lifecycle.md`（只读参照）。

本票**只动 core 包与 scripts/smoke-sessions.ts**。server 包不动（hub 的 holds 与新簿记短暂共存，票 03 拆除）。

## 改动

### 1. SessionManager 的第一张常驻表

`packages/core/src/session/session-manager.ts`：

- 新增实例字段 `private readonly holds = new Map<string, { holds: number; closing?: Promise<void> }>()`。
  键是**会话文件对的规范文件键**：以 `.jsonl` 绝对路径经 `absPathKey`（L834-838，resolvePath + win32 大小写折叠）折叠。id → 文件的解析只在进闸前做一次，此后簿记领域里没有 id。
- JSDoc 明确两件事：①这是对 ADR-0006 无属性服务形态的**有意识的修订**——易失簿记（重启即空、不落盘、不可重建也不需重建），与 ToolManager 实例表（ADR-0011）同类；②这张计数表是**「存储原语缺失税」**——文件系统没有「存在才写」的原子原语（实证：`.scratch/fs-race-test/test.mjs`），换成事务型存储的那天这张表该跟着消失，不是搬进新存储。
- 私有帮手（不对外）：
  - 进闸：解析文件键 → 若条目的 `closing` 在 → 抛 `UnknownSessionError`（读作「没有这个会话」）；否则计数 +1。解析不出文件（未诞生的袋、无所指 id）不进闸——无文件可保护。
  - 出闸：宽容释放（`Math.max(0, n-1)`）、归零删条目——与 hub 旧 `release()` 语义一字不差（exploration §1.4）。
- **内部帮手函数不重复进出**：公开方法持闸、内部互调不重复计账（spec Implementation Decisions 第 2 条；新形态里锁只有一个进出层，嵌套不存在）。

### 2. 公开方法内化持有（spec 点名的集合）

在自己的长度内持闸的公开方法（exploration §3.2 行号）：

- meta setter 7 个：`setThinkingLevel` / `setModel` / `flushMeta` / `setMode` / `setApprovalOverride` / `setSuspended` / `setTitle`；
- append 族 5 个：`appendMessage` / `appendUsage` / `appendCompaction` / `appendClearToolResults` / `appendTrimToolCallArgs`；
- 写 leaf 记录的两个：`branch` / `resetLeaf`；
- `open(id)`（冷路径入口，id → 文件解析本身就是进闸前的一次地址解析）；
- `forkFrom`（**只罩写目标半**；对源文件的读不拿闸——「读不拿锁」边界原样保留）；
- `remove(id)`——**唯一跨 await 的持有者**，闸罩它全程（本票先保留现有 rm 顺序与守卫行为，只包闸；rm 顺序反转归票 02）。

以袋为第一参数的方法从 `session.sessionFileAbsPath` 取文件键；`fileCreated === false`（尚未诞生的袋）不进闸。同步方法的进出是瞬时的——它的意义不是互斥等待，而是**与 `closing` 闸的相遇点**。

### 3. Manager 级文件闸冒烟用例（scripts/smoke-sessions.ts）

参照该文件既有断言风格（`check` + `until` + `setSessionsDir` 接缝），新增一组（spec Testing Decisions）：

1. 同一 id 的两次进闸解析出同一文件键（可经两次 open / 两次写观察到同一条目——不断言内部 Map）；
2. 对无所指 id：`open` / `remove` 在进闸前即抛 `UnknownSessionError`；
3. **删除闸内的写被拒**：需要可控 gate——给 `remove` 造一个 test-only 接缝（例如模块级 hook，仿 `setSessionsDir` 的先例），在 `.json` 与 `.jsonl` 两步 rm 之间挂起；此时对该会话做 meta setter / append → `UnknownSessionError`；闸放行后删除完成，盘上无任何残留文件；
4. 宽容释放语义不随搬家消失：内部簿记的 release 对无人持有的文件键无异常、无变化（经外部可观察面断言，不偷看 Map——例如对同一 id 连续两次不匹配的进/出闸后系统仍正常工作）。

好的测试只断言外部行为，不偷看内部计数（spec Testing Decisions 第一条）。

### 4. 不要做的

- 不动 server 包（hub.ts / controllers / routes / health 全部不碰）；
- 不动 `Agent`（编排层零感知——本票之后 `Agent` 仍不知道 holds）；
- 不动 `persistEntry` 的诞生路径与运行写入（袋 → persistEntry 不过闸，由票 02 的删除序覆盖）；
- 不删 hub 的 hold/release（票 03）。

## 验收

- `npm run check` 绿（含 check-server-facade 现状口径——server 包没有新 import）；
- `scripts/smoke-sessions.ts` 全绿（含新增用例）；
- 其余 smoke 脚本不受影响（本票不改它们的依赖面）。
