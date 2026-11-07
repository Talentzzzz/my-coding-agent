# 06:toolResultViews 落 entry——shown 半边持久化,双份视图从账本补齐

Type: grilling
Status: resolved

## Question

`after_tool` hook 改写工具结果后,同一结果有两个受众:发模型请求用 `shown`
(改写后的),写账本用 `stored`(工具真实产出)。现状用内存
`Map<toolCallId, ToolResultView>` 记两份;重启方案下运行会结束,这份内存
跨运行存活且进程重启即丢——怎么让恢复语义闭合?

## Answer

**把 `shown` 半边落成一种 entry**(新 kind,如 `tool_result_view`,记录
toolCallId + shown 内容)。`stored` 本来就在账本消息里,不需要新家。

效果:
- `toolResultViews` 从「累积态」升级为「可补齐态」:重放时从 entries 灌回,
  进程重启不再丢改写;补齐链完全闭合。
- 「压缩上下文不丢工具产出」的保证落到文件上——与 compaction 的既有约定
  (文件永远保留全文、每步裁剪是一条 entry)同一形态。
- 该 entry 是纯服务端账本记录,不进 wire 协议、不进快照、不发客户端。

实施细节归实现票 12:entry kind 命名、与 `clear_tool_result`/`trim_tool_call_arg`
的交互、重放顺序(改写 entry 必须在对应 toolResult 之后被重放)。
