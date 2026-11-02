# 01 · Loop 并入 Agent 的形态

Type: grilling
Status: resolved
Resolved: 2026-11-02，经 grilling 会话与用户逐题敲定

## Question

Loop 类并入 Agent 后，代码以什么形态住进 agent.ts？哪些部分变成 Agent 的成员、哪些保持
文件级？对外导出（`runToolCall`、恢复机器函数）怎么处理？vendored 立场是去是留？

## Answer

- **全部代码住 `packages/core/src/agent.ts`**（用户选 a，明确动机：`prepareRequest` 从构造
  函数传递变成调 Agent 私有方法；`dispatchEvent` 同理）。对外再无 Loop 对象，run 的入口
  就是 Agent 自己的方法。
- **有状态部分成为 Agent 的私有成员**：`dispatchEvent`、`prepareRequest`（并入现有方法链）、
  activeRun 槽位、`subscribe` / `abort` / `waitForIdle`、`listeners`、`runModel`。
- **无状态助手保持文件级函数**（工具批次执行、截断失败处理、dangling 扫描等——它们本就
  无实例状态）。
- **恢复机器（`recoverPendingToolCalls` 等）保持文件级导出**，供 `smoke-approval-recovery`
  直接驱动（Q6 选 ii：改动最小、测试语义不变、与 (a) 完全兼容——所有代码仍住 agent.ts）。
- **`runToolCall` 降为 agent.ts 内部文件级函数**，不进 `index.ts`（Q8；全仓库无使用者，
  真有工具需要嵌套调用时再导出）。
- **接受收编 vendored 代码**（Q1）：与上游 pi-main 的对照能力随合并消失，头注释的
  vendored/diff 说明删除；streamFn 接缝保留现状（`config.api` 注入 transport，重试策略每次
  run 现场包装）。
