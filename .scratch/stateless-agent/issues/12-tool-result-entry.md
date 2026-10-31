# 12:shown 半边落成 entry(tool_result_view)

Type: task
Status: resolved
Blocked by: 08

## Question

实现票 06 的决定:`after_tool` hook 改写结果时,把 `shown` 半边落成账本 entry。

- 新 entry kind(建议名 `tool_result_view`):记录 `toolCallId` + `shown`
  内容;`stored` 已在账本消息里,不重复存。
- 重放:遇到该 entry 时灌回双份视图(派生出与旧 `toolResultViews` 等价的
  查询能力,供「发请求用 shown、写账本用 stored」两条读路径使用)。
- 交互红线:`clear_tool_result` / `trim_tool_call_arg` 与新 entry 的先后
  语义(改写 entry 必须在其 toolResult 之后重放;清空结果时视图随结果一起
  失效);legacy kind 映射(`prune`/`argtrim`)不受影响。
- 纯服务端:不进 wire 协议、不进快照、不发客户端。
- `npm run check` + `smoke-sessions.ts`(补该 entry 的往返用例)通过。

## Answer

按建议落成 `tool_result_view` entry(`ToolResultViewEntry`:`toolCallId` +
`shown`,`stored` 不重复存)。

- **写入时机**:不在 `after_tool` 当场写,而是等 loop 的 toolResult 消息在
  `message_end` 落账时(`Agent.recordToolResultView`)作为该消息 entry 的
  **child** 紧随其后写——文件序与树位都满足「改写 entry 在其 toolResult
  之后」;`after_tool` 到 `message_end` 之间的窗口由内存
  `pendingToolResultViews` 桥接,落账即写即删。
- **重放**:新模块 `context/tool-result-views.ts` 的
  `toolResultViewsOf(entries)`——把每个 view entry 的 `shown` 与其
  toolResult 消息的 `stored` 按 toolCallId 配对,派生出与旧
  `toolResultViews` 等价的查询。调用方传请求所用的同一份 context entries,
  所以天然分支相对。`forModel` 改查这份重放视图,不再持有常驻 map;快照与
  wire 仍读 stored(entry 不进客户端)。
- **红线**:`tool_result_view` 走既有 view 管线(buildContextEntries 的
  compaction → trim → clear 之后),配对时两处丢弃——result 被压缩折掉的
  (无 stored 可配)、result 读作 cleared 通知的(清空胜过改写,视图随结果
  失效;`clear-tool-results.ts` 导出 `isClearedToolResult` 供其复用)。
  `trim_tool_call_arg` 只动 assistant 参数,不相干;`prune`/`argtrim`
  映射未动。
- **验证**:`npm run check` 通过;`smoke-sessions.ts` 补无状态往返用例
  (配对、分支相对、clear 失效、compaction 孤儿丢弃),`smoke-session.ts`
  的 `after_tool` 段扩到重启存活(reopen 后请求仍用 shown)。

**顺带修复的一个既有 bug**:probe 发现 `prepareRequestOnLoop` 从未被执行
——`Loop` 构造时把 `prepareRequest` 快照进 `baseConfig`,而 agent.ts 在构造
**之后**才赋值 `this.loop.prepareRequest`,请求永远拿不到它。这才是
smoke-session 在 master 上 27 项失败(compaction、model_change 记录、
shown 视图等全在 prepareRequest 里)的根因。修复:改经 `new Loop({...})`
的构造参数传入(`LoopOptions` 本就收它)。此修复后 smoke-session 290 项
全绿。
