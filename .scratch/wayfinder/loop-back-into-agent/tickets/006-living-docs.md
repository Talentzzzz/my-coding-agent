---
status: open
assignee: workbuddy
Blocked-by: 003, 004
---

# 006 实况文档同步（ADR 之外的那五份）

## Question

代码搬家之后，实况文档里仍写着「`loop-manager.ts` 的零字段 `LoopManager`」——哪些句子必须改，
哪些只是好看。

## 口径

**只改陈述实况的句子，不改历史叙述。** ADR 里那句「它曾是一个对象」是历史，留着；`architecture.md`
与 `AGENTS.md` 里「引擎住在 `loop-manager.ts`」是实况，必须改。判断标准：这句话现在是否会让读者
去找一个不存在的文件或一条不存在的边界。

行号会随编辑漂移，**按引文 grep，不要按行号跳**。

## 逐份清单

### `AGENTS.md`

| 位置 | 原文特征 | 改成 |
|---|---|---|
| 布局代码块里 `packages/core` 那一行 | `loop-manager.ts（零字段 LoopManager：一次运行的引擎 + 填充链 + 压缩 + 重试 + 闸门）` | 把这段并进 `agent.ts` 的括号里：`agent.ts（编排：会话表、命令、审批、投影、事件契约，以及一次运行的引擎 + 填充链 + 压缩 + 重试 + 闸门）`；`loop-manager.ts` 整个删掉 |
| **engine（引擎）** 词条（约 38–47 行） | 以 `LoopManager.run（loop-manager.ts，零字段）` 开头，整条讲 `loopOptions` 与 19 动词白名单 | **整条重写**，压到原长度的六成：引擎是 `Agent.run`，与 `runEngine` / `prepareRequest` / 压缩阶梯 / 重试泵 / 两个闸门一起是 `Agent` 的私有方法；读的接缝是这次运行的局部变量与 `this`（三只 Manager、hooks、transport、prompt builder）；`RunInput` 只有三件值；loop 不再是一个边界，所以没有回调面、没有白名单、没有守卫（ADR-0024）。**保留**原来那段「工具调用经 `executeTool`、解析只对本请求声明过的数组按名查」的不变量，它仍然成立 |
| **retry（重试）** 词条 | `LoopManager.run 给这次运行包一层 transport` | `Agent.run 给这次运行包一层 transport` |

### `CONTEXT.md`

| 词条 | 处置 |
|---|---|
| **Agent（编排层）** | 去掉定义末尾「白名单回调的回答方」，它在这次之后不回答任何人 |
| **LoopManager** | **删整条**——词条指向的东西不存在了 |
| **loopOptions** | **删整条** |
| **回调白名单** | **删整条** |
| **run bag（运行袋）** | 改写一句：落选择的写经 `Agent.recordSelection`（原来是「回调 `recordSelection`」），开袋仍由编排层在自己的会话表上开 |
| 新增 **RunInput** | 一行：一次运行的三件值（`state` / `bag` / `start`），没有依赖面；运行要用的服务是 `Agent` 自己。`_Avoid_: LoopOptions、参数袋、loopOptions` |

### `README.md`

| 位置 | 原文特征 | 改成 |
|---|---|---|
| 开头第 4 行 | `如今是 packages/core/src/loop-manager.ts 里零字段的 LoopManager（ADR-0022、ADR-0023）` | `如今是 core/agent.ts 里 Agent 的私有方法（先并入 core，[ADR-0008]；抽成对象又删掉，[ADR-0012]→[0014]；回来又出去，[ADR-0022]→[0023]；最终并回编排层，[ADR-0024]）`——一句话交代五次往返，别展开 |
| 能力清单那段 | `运行引擎（LoopManager.run：多轮循环…）` | `运行引擎（Agent.run：多轮循环…）` |
| check 清单 | 若提到 `check-loop-boundary` | 删掉该条（守卫已随文件消失），并说明 `check` 现在四条 |

### `docs/architecture.md`

这一份最长，但改动都是替换名词：

| 位置特征 | 改动 |
|---|---|
| core 段（`运行引擎住在 loop-manager.ts 的零字段 LoopManager`） | 改成「运行引擎是 `Agent` 的私有方法（ADR-0024）」；同一句里 `Agent` 在三个运行入口组一只 `loopOptions`（回调面 19 动词）→ **删掉整段组袋描述**，换成「三个运行入口各自把三件值递给 `Agent.run`」；「账本、settings、tools、hooks 对 loop 完全不可见」→ 改成「运行与命令面读同一批服务」（那句在合并后不再成立，不能留） |
| 责任表那一行（`运行引擎、steering、事件｜我们｜loop-manager.ts 的 LoopManager.run…`） | `agent.ts` 的 `Agent.run`；括号里的 0022/0023 改指 0024 |
| `packages/core/src/llm/` 那段末尾（`如今是 loop-manager.ts 的零字段 LoopManager`） | `如今是 agent.ts 里 Agent 的方法` |
| 目录树里 `loop-manager.ts（零字段 LoopManager：…）` 那一行 | 删行；`agent.ts` 那行补上「引擎、填充链、压缩、重试、闸门」 |
| 小节标题 `## 循环（LoopManager.run），端到端` | `## 循环（Agent.run），端到端`；正文第一段把「引擎是零字段的 LoopManager（0022；0012 立起、0013 削空、0014 删除、0022 请回来…）」压成一句「引擎是 `Agent` 的私有方法（ADR-0024；它的归属在 0008–0023 之间往返过五次）」，后面「递给 `loopOptions` 的不是它们——是回调面（读 8、写 6…）」整段删除 |
| `executeToolCalls` 那段 | `引擎（agent.ts 里的 executeToolCalls 及其兄弟函数）` |
| 请求流程两行（`-> core/agent.ts Agent.prompt()：写用户消息，组 loopOptions 交给 LoopManager.run` / `-> core/loop-manager.ts run：流、工具调用…`） | 合成一行 `-> core/agent.ts  Agent.prompt → startPromptedRun → run：流、工具调用、before_tool / after_tool` |
| 「压缩建立在 vendored 循环的辅助函数上」那行 | `提示词对随引擎一起搬进了 agent.ts` |

### `docs/notes.md`

第 35 行那条「部分取代」的追记末尾补一句：`（2026-11-13 再补：引擎随 0024 并回 Agent，loop-manager.ts 已删除。）`
`notes.md` 是工作笔记，不加更多。

## 完成判据

```bash
grep -rn "LoopManager\|loop-manager\|loopOptions\|回调白名单" --include=*.md \
  AGENTS.md CONTEXT.md README.md docs/architecture.md docs/notes.md
```

判据：剩下的命中**全部**在历史追记或 ADR 指针里（即同一句里带 `ADR-0024` 或写成「曾是」）。
实况叙述里一条都不许留。
