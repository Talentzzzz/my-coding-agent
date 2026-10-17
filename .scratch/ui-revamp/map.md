# Map · 桌面 UI 优化（ui-revamp）

Label: wayfinder:map

## Destination

`my-coding-agent` 的窗口 UI 按一份**用户确认过的原型**完成六项改造：模型管理交互、模式（工具+权限预设）系统、空状态与侧栏文案、思考块样式、消息元信息（user / agent 脚注）、运行计时。终点是改动落地并通过 `npm run check` 与 smoke。

## Notes

- 域参考：`docs/architecture.md`、`AGENTS.md`（术语：tool_config、approval、tool set、assembly）。
- 原型是第一张 ticket：所有实现类 ticket 都以「原型已确认」为前提。
- UI 规则：窗口 UI 只读设计 token（`packages/web/src/tokens.css`），transcript 是窗口存在的唯一理由。
- 原型文件：`.scratch/ui-revamp/prototype.html`（已定稿确认）。用户参考截图：`优化/1.png` … `优化/6.png`。
- 执行属于本努力的范围（02–06 是实现票），但按用户指示**逐票推进**：01 已结，02–06 保持在前沿，等用户发起再取。

## Decisions so far

- [01 · 原型：六项 UI 改造的确认原型](issues/01-prototype.md)：四轮反馈后定稿——模型管理内联编辑/删除；模式系统（审批默认自动允许、会话只读）；空状态留白 +「新会话」；工具/思考扁平等宽条目（无框无图标、原名、流式滚动/定格首句）；user 消息「时间+复制」；agent 脚注「复制图标/用量/时间/用时」+ 运行计时。
- [02 · 模型管理交互改造](issues/02-model-manager.md)：已落地——无全局保存按钮，行内编辑/添加/删除各自发整表 PUT；省略 apiKey 的原样行由服务端保留密钥；保存门槛（名称/模型 ID/服务地址必填）；单一互斥交互 + 交互期间冻结行列表与 body；顺带修复 note 被 renderBody 清掉的既有 bug。

## Not yet specified

- 模式（mode）的数据形态如何与既有 `tool_config` entry、全局默认工具集兼容（默认模式是否就是现全局默认；切换模式是否写新 entry kind）。待原型确认后毕业成 ticket。
- 「总用时」的起止定义与事件来源（一轮的 start/stop 由哪个事件携带）；「运行中」计时器走客户端本地计时还是服务端事件。
- 折叠态思考文本「不断滚动」在流式输出时的更新策略（marquee 与流式追加如何共存）。

## Out of scope

- 插件 / MCP 机制（项目规则本就排除）。
- 会话级对模式的就地编辑（用户明确：模式只在全局设置里改，会话只用）。
