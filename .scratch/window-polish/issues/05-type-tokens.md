# 05 排版 token 化：收掉散值

Type: task
Status: resolved
Blocked by: 01, 04

## Question

把 `packages/web/src/style.css` 里的字号散值收成一组**新的 `--dsw-*` 名字**，并让应用级设置的
"字号"驱动整棵树。

要做的：

1. 按 04 拍下的阶，在 `tokens.css` 新增一组（前缀 `--dsw-*`，例如 `--dsw-font-size-body` /
   `-title` / `-meta` / `-caption` / `-code`），**每个都带行高**——字号与行高是一个决定，分开写
   就是同一个错误犯两次。
2. 把 `style.css` 里所有 `font-size: 10px | 10.5px | 11px | 11.5px | 12px | 12.5px | 13px | 14px`
   的散值逐个换成 token。**逐处判断它属于哪一档**，不要把 11.5 一律当 12：参考实现的会话行标题是
   14/20、次要行是 12，状态行的技术读数是另一档。
3. 应用级设置里的"字号"按 04 的结论驱动整棵树（要么只动正文，要么一个 delta 缩放全部）。
4. `npm run check` 要绿——token 审计会拒绝"引用了却没定义"的 `--dsw-*` 名字，也会在
   `style.css` 里出现字面颜色时报错。

**答案里给一张对照表**：改前的字面值 → 改后的 token 名 → 落在界面的哪一处。

## Answer

四条全做。`style.css` 里近 60 处字号散值（10 / 10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 14 八档，
外加 8 处骑 `--app-font-size` 的派生式）全部收进 04 拍的五档 token，`npm run check` 绿
（token 审计：122 defined / 100 referenced）。

### 轴怎么走

- `--app-font-size` 退役。设置里的"字号"滑杆发布的就是 `--dsw-fs-body` 的值（`state.ts` 的
  `applyAppearance`），其余四档不跟轴，照 04。
- **`--dsw-lh-body` 改为派生**：`calc(var(--dsw-fs-body) * 25 / 15)`。票面说"每个都带行高"，
  但 body 是活档——如果行高是第二个静态值，滑杆一动字号与行高就拆了对，"字号与行高是一个决定"
  在轴上失效。派生式让 15/25 的比例在滑杆每一档都成立，其余四档仍写作静态对。
- 默认从 14 抬到 15：`DEFAULT_APPEARANCE.fontSize` 与 README 示例同步改。已存过 14 的设置文件
  保持 14——那是用户的明确选择，不是缺省。

### 对照表

改前字面值 → token → 落在界面的哪一处。（calc 派生式按默认 14 折算成 px 记。）

| 改前 | token | 哪里 |
|---|---|---|
| body `--app-font-size` (14) | title | 全窗缺省基准 |
| `.sidebar` 14px | title | 左栏整栏基准 |
| `.channel-indicator` 11px | caption | 栏脚连接状态 |
| `.session-list-heading` 11px | meta | 列表分组标题 |
| `.search-input` 12.5px | title | 搜索框 |
| `.session-item-time` 11px | caption | 会话行时间 |
| `.workspace-current` 10px | caption | 工作区行的「当前」徽章 |
| `.session-list-empty` 12px | caption | 空列表文案 |
| `.session-more` 11.5px | caption | 「显示更多」 |
| `.workspace-head` 11.5px | meta | 工作区分组头 |
| `.header-title h1` fs+1 (15) | title | 会话标题 |
| `.header-subtitle` fs−2 (12) | meta | 固定头副标题 |
| `.branch-chip` fs−2 (12) | meta | 分支入口 |
| `.branch-chip-id` fs−3 (11) | caption | 分支短 id |
| `.branch-tools` fs−2 (12) | meta | 分支页工具行 |
| `.zoom-button` fs−2 (12) | meta | 分支页缩放按钮 |
| `.zoom-value` fs−3 (11) | caption | 缩放读数 |
| `.back-button` fs−2 (12) | meta | 分支页返回按钮 |
| `.welcome h2` 17px | body | 欢迎标题 |
| `.welcome p` 13px | meta | 欢迎副文 |
| `.turn-role` fs−2 (12) | caption | 角色行 |
| `.turn-role .avatar` 10px | caption | 头像字母 |
| `.turn-body` `--app-font-size` (14) | body（骑轴） | 正文 |
| `.turn.notice .turn-body` 13px | meta | 通知回合 |
| `.code-head` 11px | caption | 代码块头 |
| `.code-copy` 11px | caption | 复制按钮 |
| `.code-block code` 12.5px | code | 代码块 |
| `.reasoning` fs−1 (13) | meta | 思考行 |
| `.reasoning-body` `--app-font-size` (14) | body（骑轴） | 思考正文 |
| `.tool > summary` 13px | meta | 工具卡行 |
| `.tool-name` 12.5px | code | 工具名 |
| `.tool-preview` 12px | code | 工具预览 |
| `.tool-output` 12px | code | 工具输出 |
| `.diff` 12px | code | diff 块 |
| `.diff-row.omitted` 11.5px | caption | diff 省略行 |
| `.branch-sum` fs−3 (11) | caption | 分支页摘要行 |
| `.gnode` fs−2 (12) | meta | 分支节点 |
| `.gnode .meta` fs−4 (10) | caption | 节点短 id |
| `.approval-strip` 12px | caption | 审批卡状态条 |
| `.approval-command` 12px | code | 审批命令 |
| `.workspace-chip` 12.5px | meta | 输入框上方工作区 chip |
| `.composer textarea` 14px | **body（骑轴）** | 输入框正文 |
| `.composer-select` 12px | caption | 模型 / 思考选择 |
| `.composer-hint` 11px | caption | 输入框键盘提示 |
| `.menu-item` 13px | meta | 右键菜单行 |
| `.button` 13px | meta | 通用按钮 |
| `.error-bar` 13px | meta | 错误条 |
| `.status-bar` 11px | caption（+等宽，原有） | 状态行 total/cache/context |
| `.notice-text` 13px | meta | 通知卡正文 |
| `.notice-text span` 12px | caption | 通知卡次行 |
| `.settings-head h2` fs+2 (16) | title | 设置面板标题 |
| `.settings-tab` 13px | meta | 设置页签 |
| `.settings-hint` 12px | caption | 设置提示 |
| `.settings-label` 12px | caption | 字段标签 |
| `.settings-value` 12px | caption | 当前值读数 |
| `.settings-note` 12px | caption | 保存结果行 |
| `.settings-check` 12.5px | caption | 设置勾选项 |
| `.segment` 12.5px | caption | 主题分段选择 |
| `.input` 13px | title | 设置文本输入 |
| `.model-ref` 11.5px | caption | 模型 ref |
| `.model-hint` 11.5px | caption | 模型字段提示 |
| `.model-check` 12.5px | caption | 模型勾选项 |

档外值不再存在：改后 `style.css` 里的 `font-size` 只剩 `var(--dsw-fs-*)` 与 `.turn-body` 标题
层的相对 `em`（骑 body 档的比例，不另立档）。

### 两处值得说明的判断

1. **composer 的输入框落 body 档、骑轴**，不落 04 表里"输入框 → title"的那一档。表里那格说的是
   左栏的小输入框（搜索、就地改名，它们已落 title）；输入框正文是用户自己的正文——发出去就是下
   一条气泡——跟 transcript 同轴才所见即所得，也才让"为可读性放大字号"的人连自己打的字一起放大。
   一个超表的判断，理由写在规则旁的注释里。
2. **状态行钉 caption + 等宽**，照 04 的改判（typography.html 的 13/20 按 index.html 改 12/16），
   不跟轴——它们是读数不是正文。

### 顺带

`render/settings.ts` 里字号滑杆的 `?? 14` 兜底改 15 并注明来源（`DEFAULT_APPEARANCE.fontSize` 的
复述，照 main.ts 拖宽把手的先例：config 模块跑在 Node 上，客户端不把它拉进 bundle）；滑杆
12–20 的两端同理仍是 `FONT_SIZE_RANGE` 的复述。`npm run check`、`smoke-sidebar`、`smoke-boot`、
`smoke-sessions`、`vite build` 全绿。
