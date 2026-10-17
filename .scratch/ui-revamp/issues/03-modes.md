# 03 · 实现模式（工具+权限预设）系统

Type: task
Status: resolved
Blocked by: 01

## Question

按确认的原型实现模式系统：

- 全局设置新增「模式」：创建 / 编辑 / 删除（内置默认模式不可删），每个模式 = 工具集合 + 每工具审批映射。
- 输入框左下角改为模式下拉；选模式即选工具集与权限集；会话内不可编辑模式，只能选。
- 数据形态与既有 `tool_config` entry、全局默认工具集的兼容方案（见 map「Not yet specified」，原型确认后先行敲定再动手）。

## Answer

已落地。数据形态先行敲定为 [ADR-0005](../../../docs/adr/0005-modes-are-a-tool-config-choice.md)：**模式是一次工具集与审批集的选择，不是一个新状态层**。

**数据形态**（兼容方案，原 map「Not yet specified」毕业）：

- 模式整表存在 settings 的新字段 `modes`（`ModeSettings[] = { name, tools, approval }`），与 `tools`、`hiddenWorkspaces` 同属整表设置；`PATCH /api/settings` 一次替换整份，无独立 CRUD 端点。旧文件无此字段即没有用户模式，零迁移。
- 内置「默认」模式**不被存储**：它就是全局默认（`settings.tools ?? 全量` + `settings.approval`）的活视图。选「默认」= 会话回到全局默认，与会话级面板的「沿用全局」是同一件事。
- 会话选模式**不写新 entry kind、不加会话端点**：施加 = 现有 `PUT /api/sessions/{id}/tools` + 审批 `PATCH` 两个命令的组合（窗口发出，与「沿用全局」同一对），落既有 `tool_config` entry。分支重放、follow-global 判断全部原样工作。
- 名字是身份：与内置「默认」或彼此重名在客户端与控制器双重拒绝；`SubAgent` 等无审批键的工具只有开关、没有审批下拉。

**实现**：

- core：`ModeSettings`/`DEFAULT_MODE_NAME`（config.ts）、`modes` 归一化（坏条目按条丢、重名留第一份、审批缺键落标准默认、空表是选择不是缺失）。
- server：`SystemController.updateSettings` 校验 `modes`（名字非空、不与内置冲突、不重名、形状检查），`GET /api/settings` 带出。
- web：
  - 设置面板新增「模式」页：内置默认卡（带「内置」徽标、无删除，开关与审批下拉**就地生效**——即原「默认」页那两组控件）+ 用户模式卡（新建/内联编辑/一次确认删除，复用模型行的卡片骨架）。新模式初始全工具关闭、审批全部自动允许（01 号确认的决策）。
  - 「默认」页的「运行前先询问」「默认启用的工具」两组控件**移入**模式页的默认卡——它们就是默认模式，两扇门改一个值只会各自漂移；「默认」页保留默认模型与 bash 超时。
  - 输入框左下角新增模式座位（滑杆图标 + 名字 + 下拉箭头），菜单复用唯一的自绘菜单（`MenuItem` 新增两行式 `detail`）：内置默认 + 各模式（名字 + 「N 个工具 · M 项询问」摘要 + ✓）+ 分隔线 + 「去设置 › 模式」。座位按值匹配显示当前模式，未命中显示「自定义」。
- 会话内仍可在会话设置里手动微调（一次普通 `tool_config` 变更）；模式只读，符合票面。

**验证**：`npm run check` 全绿；smoke 全绿（`smoke-settings` 增 modes 往返与归一化、`smoke-boot` 增 modes 的 HTTP 往返与名字拒绝、新增 `smoke-modes` 驱动模式页/座位/菜单，README 清单已登记）；`build:web` 通过。文档：ADR-0005、architecture.md（装配与设置 + API 表）、AGENTS.md 术语、README。

**有意偏差**：默认卡就地生效而非「取消/保存」（原型画的是保存制）——它编辑的是全局默认两个字段，这两组控件此前就是即时生效；为不引入同一值的第二种保存路径而保留原行为。
