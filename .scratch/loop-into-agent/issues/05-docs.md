# 05 · 文档同步

Type: task（AFK）
Status: resolved
Blocked by: 03

## Question

（执行）合并落地后同步文档，使其描述合并后的现实：

- `AGENTS.md`：布局里 `packages/loop` 一行、术语里 loop 相关词条（loop 包不再是委派对象）、
  「vendored 两个 package」的表述改为一个；
- `docs/architecture.md`：对应章节（请求流程、loop 相关小节）；
- `README.md`：提及 loop 包处。

## Answer

三份文档按落地形状校正，**新增一个术语**承载这次合并的概念——`engine（引擎）`，因为它正是
03 号票删掉的那个委派对象的位置：`Agent.runEngine` 不是对象，文档里说的「循环」就是它。ADR-0008
是这条校正的出处，凡改到「为什么长这样」的地方都指向它。

**`AGENTS.md`**

- 开头：两个 vendored package → 一个（只剩 `packages/llm`）；「其余都是我们自己的」补上
  运行引擎。
- 布局：删 `packages/loop` 一行；`packages/core` 一行改成 `agent.ts（编排 + 引擎）、
  types.ts（引擎与工具的契约）`。
- 术语：新增 **engine（引擎）**（`runEngine` 是方法而非对象、一次运行一条链、
  有状态→私有成员 / 无状态→文件级函数、恢复机器仍由 `index.ts` 导出、旧的 `Loop` 与
  `packages/loop` 已删）；`approval` 的「loop 的恢复机器」→「引擎的恢复机器」；`retry` 那条
  删掉 `streamFn`（引擎不再收到它），改为 `startRun` 给这次运行包一层 transport。

**`docs/architecture.md`**

- 顶部流程图：`@my-agent/loop 循环、工具、hook` → `core：引擎、工具、hook`。
- *各 package 的职责*：`AgentEvent` 的出处从 @my-agent/loop 改为 `types.ts`，并补一句
  「引擎也住在这里」；职责表的 `Agent 循环、steering、事件` 行从 `@my-agent/loop` 改为我们、
  指向 `Agent.runEngine`。
- 依赖段：三个包 → 两个（`@my-agent/llm`、`typebox`），并写明 vendored 循环已不存在、
  `@ts-nocheck` 随它退场。
- 目录布局：`core/src` 的 `agent.ts（编排层 + 引擎）`、加 `types.ts`。
- *工具契约*：抛出 → 错误结果的那一句归给引擎。
- *Hook*：`before_tool` / `after_tool` 的调用点「循环的」→「引擎的」（`toolCallHooks()`）；
  闸门那一节「由 loop 的恢复机器」→「由引擎的」。
- *循环，端到端*：标题改为 `## 循环（`runEngine`），端到端`，开头点明这一段里的「循环」就是
  `Agent.runEngine`——文中其余那些以「循环」作主语的句子因此不必逐句改写，读法有了锚。
- *重试*：`在循环之下` → `在引擎之下`；删掉「引擎现位于 `packages/loop/src/loop.ts` 的
  `Loop.runLoop`」，并把 `streamFn` 适配器那段改为「引擎不再收到 `streamFn`，`startRun` 给这次
  运行包一层 transport」。
- *请求流程*：`-> @my-agent/loop` 一行改为 `-> core/agent.ts  runEngine：…`。
- *桌面外壳*：「客户端从不 import @my-agent/llm 或 @my-agent/loop」→「也不 import core 的引擎
  与其他内部模块」。
- *与原计划的偏离*：压缩那一行的「原计划」由 `@my-agent/loop` 改为「vendored 循环」，「实际」
  补「提示词对随引擎一起并入 `agent.ts`」。

**`README.md`**

- 开头：两个 pi package → 一个，并说明运行引擎原先是 pi 循环的 vendored 副本、已并入
  `packages/core/src/agent.ts`、不再跟踪上游（链到 ADR-0008）。
- *状态*：「核心循环」→「运行引擎（`Agent.runEngine`：多轮循环、steering、工具执行与恢复）」。

**顺带一处**（同一事实的另一半，不另开票）：`docs/notes.md` 第一节「两者都是 vendored 代码」→
「`packages/llm` 是 vendored 代码」——04 票已把那节改成「保留一半」，这句是它的残留。

**验证**：`npm run check` 绿（tsc ×3 + token 审计）。纯文档改动，smoke 不涉及。

**注**：工作树里既有一批未提交的改名与文档改动，凡与本票同文件的部分随本次提交一并落库
（沿用 03 号票的记法，commit message 里点名）。被带进来的有两处：`AGENTS.md` 的 service 词条
（「方法体就写在类里」那半句）与 `docs/architecture.md` 的*流式期间的输入*一段（`flushAccepted`
→ `drainTranscribed`）。

**审查后校正**（两轴 code review，Standards + Spec 各一条子代理）：

- **`docs/architecture.md` 留下一处死标识符**：*流式期间的输入*里「经 `getSteeringMessages` /
  `getFollowUpMessages` 拉取」——这两个名字在 `packages/` 里已不存在（只在 `pi-main/` 的上游参考
  里），ADR-0008 也写明取走点「从钩子变成 `drainTranscribed` 直读会话队列」。改成「直读会话自己的
  两条队列（`drainTranscribed`），并在**取走的那一刻**写进 store」。这是随那半段一并落库的旧句子，
  本票要的正是「过期陈述不得存活」，故就地修。
- **`@ts-nocheck` 的作用域**：依赖段原写「引擎并入 `agent.ts`、`@ts-nocheck` 一并退场」，紧跟在前
  一句「`packages/llm` 逐文件 `@ts-nocheck`」之后，读起来像在说 llm 也退了。改为「它那份
  `@ts-nocheck` 随文件一起退场」。
- **新增术语不许成为同义词许可**：初稿写「文档里说的「循环」指的就是它」，等于术语表替同义词背书
  （`docs/agents/domain.md`「不要漂移到术语表明确避开的同义词上」）。改为「「循环」从此不是组件的
  名字，只是那些轮次的日常说法」，并删掉与 architecture 重复的那条 `startRun → runEngine → …` 链。
- **`docs/agents/domain.md` 的术语索引漏了 engine**：那一行逐词枚举 `AGENTS.md` 的术语表，新词进场
  时它也是索引的一部分，补上。
- **`map.md` 缺 resolved 指针**（`docs/agents/issue-tracker.md` 的 Resolve 步骤要求）：补一条，
  把 03 的落地与 05 的文档同步并作一条；03 当时也没记，一并补上。

**审查未采纳的两条**：`agent.ts:1621` 那句「the caller's end-of-run sweep writes it」同样是
`dropQueued` 改名后留下的旧注释——但它是源码注释、不在本票范围（05 只动三份文档），留待下次动那
段代码时一并修。

