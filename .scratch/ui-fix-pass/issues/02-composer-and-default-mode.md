# 02 · 输入框左下角只留模式座位；「默认」模式改成可编辑

Type: task
Status: resolved

## Question

两件事同一个座位，一起改：

**A. 删掉会话级设置（`优化/2.png`）**
输入框 bar 左端现在是「模式座位 + 会话设置齿轮」。齿轮打开 `SessionSettingsPanel`——这一会话的工具集与审批映射，和模式是两套独立的状态。用户定的方向是：左下角只留模式座位，会话的工具/审批**只由模式决定**。

要做的：composer 不再创建齿轮，`ComposerHandlers.onOpenSessionSettings` 一并拿掉；`SessionSettingsPanel` 及其 DOM、样式、`onFollowGlobal` 的入口退出；随之清理主窗口里不再被引用的 `followed`/面板状态（若 `followed` 只服务于它）。老会话里已有的 `tool_config` entry 仍照常回放，只是不再有手动编辑入口——选中一个模式就是唯一的修正方式。

**B. 「默认」模式改不了（`优化/7.png`）**
`defaultModeCard()` 的头是普通 `div`，正文常展开，所以它不像别的模式那样“点开头 → 行内表单”。里面的开关其实改得动（写全局 `tools`/`approval`），但交互读起来就是只读。

要做的（保持 ADR-0005：默认模式不存储，是全局默认的活视图）：

- 头部可点，展开同一套 `modeFormCard`：名称只读（显示「默认」+「内置」徽标），工具勾选与审批下拉可改。
- 保存 = 写全局 `tools` 与 `approval`（走现有 `onGlobalTools` / `onGlobalApproval` 的整表写入），不回写 `modes` 列表。
- 没有删除；校验仍拒绝把「默认」当作用户模式名。
- 收起时卡片只显示一行摘要（`modeSummaryOf`），与普通模式行一致。

**C. 「自动允许」拥挤（`优化/7.png`）**
`.mode-tooltable` 行间距 6px、`.mode-tool-approval` 高 26px，下拉几乎顶到上一行。把行距/行高调到能一眼分开（建议行高 30px、gap 8px 起，按窗口实际效果定），选中行的复选框与名称仍与下拉同一基线。

验收：窗口里左下角只有一个座位；设置 → 模式里「默认」可点开、可保存，保存后新开会话按新工具集与你选的审批开；`npm run check` 与 `scripts/smoke-api.ts`（若动了端点调用）通过。

## Answer

A、B、C 三件全部落地：

1. **A · 左下角只留模式座位**：`composer.ts` 不再造齿轮，`ComposerHandlers.onOpenSessionSettings`
   删除，bar 的左端只剩 `modeButton`；`render/session-settings.ts` 整份删除，`main.ts` 的构造、
   `onOpenSessionSettings` 入口、打开渲染、Escape 收起与 `root.append` 一并拿掉。`.composer-gear` 与
   `.session-settings` 的 CSS 也删了。`followed` 保留——它是「当前窗口跟着哪个会话」这个全窗口的
   事实，不只服务于面板，没有可清理的其余面板状态。老会话的 `tool_config` 仍照常回放；会话的工具与
   审批现在只有「选一个模式」一条改动路径。
2. **B · 「默认」模式可编辑**：`defaultModeCard()` 的头部改成按钮，收起时与用户模式行同形——名称 +
   「内置」徽标 + 一行 `modeSummaryOf` 摘要；点开复用 `modeFormCard()`（新增 `builtIn` 选项），名称为
   只读展示（`默认` + 徽标），工具勾选与审批下拉改的是卡片自己的草稿，保存才写出去。保存走既有
   `onGlobalTools`（整份工具集，按 build 顺序收窄）与 `onGlobalApproval`（只写变过的键），不回写
   `modes`；没有删除；用户模式名的「默认」校验原样保留。没有会话时（拿不到 `allTools`）表单整体
   stand down，和旧默认开关同一条规则。保存和用户模式的保存一样处于「保存中…」，等所有补丁落地后
   才收起表单；`main.ts` 的 `saveSettings` 改成串行队列，同一秒发出的 tools + 多个 approval 补丁
   按发出顺序应用，旧快照不会最后落地。收起摘要与输入框菜单的「默认」行口径一致：有会话时按
   `allTools` 收窄，没有会话时照文件里的原样显示。
3. **C · 行距与行高**：`.mode-tooltable` 的 `gap` 6px → 8px，`.mode-tool` 加 `min-height: 30px`，
   `.mode-tool-approval` 高 26px → 30px，`.mode-name-static` 同样 30px；复选框、名称与下拉在
   `align-items: center` 下共用一条中线（浏览器实测三者的中线差 < 1px）。

验证：`npm run check` 通过；`scripts/smoke-modes.ts` 按新交互重写并通过（默认卡展开表单、草稿不
落盘、保存写全局、无会话退场、bar 上没有齿轮）；`.scratch/ui-fix-pass/research/verify-02.ts` 在真
Chromium 里核对四个座位事实、表单交互、行距/行高/中线，并确认保存后新建会话按新工具集与新审批打开
（`node .scratch/ui-fix-pass/research/verify-02.ts --shots` 全部 ok，图见同目录 `after-02-*.png`）。
README 里列出的无服务器 smoke 全部通过，`npm run smoke:boot` 与 `scripts/smoke-api.ts` 通过。

文档同步：`AGENTS.md` 的 settings/mode 两条定义、`docs/architecture.md` 的设置与模式一节改成「没有
会话级手动入口，选模式是唯一改动路径」；ADR-0005 末尾加「后续变更」记录面板被删与默认卡改为行内表单，
核心决定不变。
