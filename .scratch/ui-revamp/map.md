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
- [03 · 模式系统](issues/03-modes.md)：已落地（数据形态毕业为 [ADR-0005](../../docs/adr/0005-modes-are-a-tool-config-choice.md)）——`modes` 整表进 settings；内置「默认」不存储、即全局默认活视图；选模式 = 现有 `PUT /tools` + 审批 `PATCH` 组合，落既有 `tool_config` entry，无新 entry kind、无会话端点；设置面板「模式」页（默认卡就地生效 + 用户模式卡），「默认」页的工具/审批两组控件移入默认卡；输入框左下角模式座位（自绘菜单加两行 `detail`），按值匹配当前模式。
- [04 · 空状态与侧栏文案](issues/04-empty-state-sidebar.md)：已落地——空会话页只留 sparkle 图标 +「想做点什么?」（说明段落整段去掉）；侧栏顶部按钮「新会话」；工作区右键菜单的「新建会话」不动（它命名工作区，是另一个控件）。
- [05 · 思考块改成工具块样式](issues/05-thinking-block.md)：已落地——思考行复用工具卡容器与头部（`details.tool` + chevron +「思考」名位），灯泡图标与分隔点删除；折叠态流式中整段文本 marquee 横滚（轨道双份文本无缝循环、时长按宽度解算、重写节流 2s），结束后定格第一句；展开时头行摘要隐藏、正文 meta 档 prose 缩进对齐工具输出行首；mask 墨色入 token（`--dsw-mask-ink`）。
- [06 · 消息元信息与运行计时](issues/06-message-meta.md)：已落地——user 气泡下右侧「时间+复制」（替代分隔线，turn 下边距放大留空隙）；agent 脚注只画在轮末 assistant 消息下（复制图标/用量/时间/用时）；运行中底部一行「用时 mm:ss」本地递增。计时来源敲定：轮起点 = 轮 user 消息 `timestamp`；看过的运行由客户端在 streaming 翻回时定格，没看过的退化用末条 assistant `timestamp` − user `timestamp`（少计末段流式，可接受）；计时器为本地 interval，不加 wire 事件。

## Out of scope

- 插件 / MCP 机制（项目规则本就排除）。
- 会话级对模式的就地编辑（用户明确：模式只在全局设置里改，会话只用）。
