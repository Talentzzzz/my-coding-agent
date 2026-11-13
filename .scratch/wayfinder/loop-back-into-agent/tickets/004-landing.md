---
status: closed
closed: 2026-11-14
assignee: workbuddy
Blocked-by: 001, 002, 003
---

# 004 落地：把 loop 并回 Agent

## 目标状态

`packages/core/src/loop-manager.ts`（1886 行）消失；`agent.ts` 1251 → **约 2820 行**；
`npm run check` 的 tsc 归零；行为零变化（语义只搬不改）。

## 步序

每一步之后跑一次 `npx tsc -p tsconfig.json`，别攒着。

### 1. 搬类体

- 源：`loop-manager.ts` 254–980 行（`export class LoopManager {` 到它的收尾 `}`），共 14 个成员。
- 目标：`agent.ts` 的 `startPromptedRun` 方法之后、`abort` 的文档注释之前，插一节
  `// ---- 一次运行`（分隔线宽度与文件里既有的小节标题一致：`// ` + 76 个 `-` + 空格 + 标题）。
- 缩进不动：类体成员原本就是一层 tab，与 `Agent` 成员同级。
- 每个方法前面加或改一行说明「它读的是 `this`」，其余原有注释随成员一起搬（它们的论证仍然成立，
  只是不再跨文件）。

### 2. 三个全局改名与逐词替换

先 `\bloopOptions\b` → `input`（33 处调用 + 15 处形参）。**然后按票 001 §C 的表逐词替换
`input.<动词>`**——不能正则一把梭：`input.state` / `input.bag` / `input.start` 必须原样留下，
它们是 `RunInput` 的三个字段。

### 3. 不在票 001 表里的四处特例

| 原样 | 改成 |
|---|---|
| `const { api } = input;` | `const api = this.api;` |
| `input.systemPrompt(`（×1，四实参） | `this.systemPrompt(` |
| `input.entries` / `input.now` / `input.signal`（只在 `compact` 里） | 变成 `compact` 的形参 |
| `const emit: AgentEventSink = (event) => input.emit(state, session, event);` | `… => this.dispatchEvent(state, session, event)` |

### 4. `chain` 的构造（`runEngine` 里）

三个值改成箭头，`executeTool` 的**首参是 `name`**（票 001 §D 有完整形状）。漏了会在
`executePreparedToolCall` 里报六个 `implicitly has an 'any'`。

### 5. `compact` 与 `maybeCompact`

`compact` 改名为私有 + 六参 `(state, bag, entries, now, signal?, transport?)`；
`maybeCompact` 的方法体剩一行：

```ts
return this.compact(this.agentState(id), this.bag(id), entries, now, signal, transport);
```

它原来的文档注释里「通向 `CompactOptions` 的 Pick 链」那句要改掉（票 006 之外唯一留在这里的注释
收口）。

### 6. 类型落地（票 002 §「随文件迁到 agent.ts 的类型」）

`RunInput` / `RunStart` / `ActiveTools` 放在 `AgentConfig` 之后、`Agent` 之前；`AgentEventSink` /
`ToolChain` / 三个 `ToolChain*` 别名放在机件一节的开头。

### 7. 三个运行入口

```ts
// 两处
await this.run({ state, bag, start: { prompt: message } });
await this.run({ state, bag, start: { answers: { [toolCallId]: answer } } });
```

（第二个在 `respondApproval` 里。）

### 8. 机件搬到文件末尾

`loop-manager.ts` 1010–1886 行整段（`// ---- 引擎机件` 那一节）接到 `agent.ts` 末尾，顺序不变。
恢复机器（`danglingToolCallsOf` / `recoverPendingToolCalls`）**保持 `export`**——`smoke-approval-recovery`
直接驱动它（ADR-0006 §5）。

### 9. 删

- `packages/core/src/loop-manager.ts`
- `scripts/check-loop-boundary.ts`
- `package.json` 的 `check` 里 `&& node scripts/check-loop-boundary.ts` 这一段
- `agent.ts` 的 `private readonly loop = new LoopManager();`、`loopCallbacks()`、`loopOptions()`

### 10. `index.ts`

```ts
export { danglingToolCallsOf, recoverPendingToolCalls } from "./agent.ts";
```

注释里「恢复机器住在 `loop-manager.ts`」那句改掉。`scripts/smoke-approval-recovery.ts` 若直取源文件，
路径同步。

## 三个已经踩过的坑

1. **行尾是 CRLF。** 整仓 1251/1251、1886/1886 全是 `\r\n`。用脚本搬时按 LF 处理、写回 CRLF；
   否则整个文件变成「全部行已修改」，review 无从看起。
2. **不能靠正则一次替换 `input.`。** `input.state` / `input.bag` / `input.start` 是保留字段；
   而 `input.appendMessage(state, session, message)` 这类要换成 `appendMessageEntry(...)`，参数顺序也变。
3. **`executeTool` 的首参是 `name` 还是 `toolCallId`** —— `ToolChain` 的签名有 6 个参数，私有方法也有
   6 个，别名时少一个不会报「参数个数」，只会报一串隐式 any。先看 `ToolChain` 再写箭头。

## 完成判据

`npx tsc -p tsconfig.json` 零错误，且 `agent.ts` 的 diff 里没有一处 `loopOptions` / `LoopManager` /
`loop-manager.ts` 的残留引用（注释里的也要清——票 005 的 grep 会查）。

## Comments

### 2026-11-14 · workbuddy（落地实况，供票 005 §五记账）

- 实测 `wc -l packages/core/src/agent.ts` = **2928 行**（评审修掉一处重复的 RunStart docblock 后定稿；预算约 2820，偏差 +108：八个新方法的
  docblock 比回调面注释更完整、机件一节新写了引言与 `ToolChain` 三别名；语义零变化）。
- 一处计划内偏差：机件段（1010–1886）**内含 `RunStart` 的定义**，按票 002 让它住 `AgentConfig`
  之后后成了重复声明——机件段里那份剔除（`DanglingToolCall` 等仍原样在机件段）。
- `npm run check` 全绿（四条，`check-loop-boundary` 随文件消失）；残留 grep（票 005 §三口径）
  对 `packages` + `scripts` 的 `*.ts`/`*.json` **零命中**（types.ts / events.ts / ledger.ts 三个
  头注释里指名 `loop-manager.ts` 的实况句一并改掉）。
- smoke：approval-recovery / approval / session / sessions / models / default-model / projection /
  boot / mux / backpressure / liveness 全绿；**smoke-tools 与基线同色**（干净 HEAD 同一处在
  `exercisePruning` 抛 `UnknownSessionError: idle-session`）。
- 落地脚本跑完即删，未入库。

### 2026-11-14 · 票 005 §五记账（终态验证实测）

- `wc -l` = **2928**（与上节一致）；`Agent` 类 204–1998 ≈ **1795 行**，文件末尾机件段约 915 行。
  上节与票 001 §F 引的「Agent 类约 2450」对不上它自己的 2820 总数（2820 − 文件头 ≈ 200 − 机件 ≈ 900
  ≈ 1720），ADR-0024 后果已按终态实测改写。
- 形状级偏差：**无新增**。§一 check 四条全绿（`check-loop-boundary` 确认随文件消失）；§三 残留 grep
  零命中；§四 四件事全过（CRLF 2928/2928 无损，diff +1809/−132，净 +1677 = 2928−1251）。
- smoke 复核：session / approval-recovery / approval 全绿；smoke-tools 与基线**同色**——干净 HEAD
  `c667b9f` 上逐字同处同错（`exercisePruning` 的 `UnknownSessionError: idle-session`，:1007）。
  其余清单全绿，唯 smoke-desktop-observability 与基线同色（`observability.cjs:207` 的
  `ReferenceError: bootWithinBudget is not defined`，基线由 `c667b9f` worktree/detach 现场取证）。
