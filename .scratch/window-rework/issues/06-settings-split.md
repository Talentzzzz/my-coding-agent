# 06 「设置」拆成会话级与应用级

Type: grilling
Status: resolved
Blocked by: （无）

## Question

用户的要求：输入框上那一栏，把"完全权限"换成**「设置」**，在里面**单独**设置工具与审批；**没单独选过就
沿用全局设置里设置好的**。左下角那个「设置」则是应用级的。

**现状（已读代码）。** 现在只有**一个**设置弹窗（`packages/web/src/render/settings.ts`），三个标签页
「外观 / 模型 / 会话」。其中"会话"页里**混着**两类东西：

- **会话级**：工具开关走 `PUT /api/sessions/:id/tools`；审批开关走 `PATCH /api/sessions/:id`
  （`main.ts` 的 `onApproval` 就是这么接的）。
- **全局级**：默认模型、bash 超时走 `/api/settings`。

而两个"默认值"的来源**并不对称**：审批的全局默认来自 `SettingsManager`（按工作区），**工具根本没有全局
默认**——它默认就是注册表全量（`packages/core/src/tools/*` 的 `createToolRegistry`）。

**要一起定下来的（这一票的产出就是这些决定本身）：**

1. **两个入口各自叫什么、各装什么。** 确认「会话设置 / 全局设置」这个分法：会话级放工具 + 审批 + 一句
   "沿用全局"；全局级放外观、模型清单、默认模型、bash 超时、以及**全局默认的工具与审批**。
2. **"本会话没单独选过"如何定义？** 会话的 `tool_config` entry 已经记着它自己的活跃工具与审批映射
   （见 `AGENTS.md` 术语的 `tool set`）。所以要确定一个**可判定**的说法——是"有没有那条 entry"，还是
   "那条 entry 的每个字段是不是都等于全局值"——并且它能显示在 UI 上（"当前沿用全局"）。
3. **"沿用全局 / 复位"这个动作的语义**：把会话现有的 `tool_config` 撤掉，还是写一条等于全局值的 entry？
   前者更干净，但要先确认会话层支不支持"撤销"。**去代码里查，别猜。**
4. **要不要新增"全局默认工具集"这个设置字段？** 现在没有。不加，"沿用全局"对工具就等于"全部启用"；
   加了，就要动 `settings.json` 的 schema 与 `SettingsManager`（以及 `SystemController.settings()` /
   `updateSettings()` 的读写）。
5. **运行中修改会话级设置的安全性**：现有面板已经有这条路径，确认边界没变（工具集合替换是原子的——
   未知名字抛错并保持原状）。

**产出**：每个问题的答案写成 resolution。需要时更新根 `CONTEXT.md`（"设置"这个词从此要分两级）。
决定之后 10 号才知道两个入口各装什么。

## Answer

每个决定都先去代码里查证过，出处随条附上。

### 1. 两个入口各装什么 —— 确认「会话设置 / 全局设置」的分法

- **会话级**（输入框上方那一行的「设置」，顶替参考图里的"完全权限"栏）：工具开关 + 审批开关 +
  每节一个"沿用全局"的显示和一个总复位动作。数据通路不变：工具走 `PUT /api/sessions/:id/tools`，
  审批走 `PATCH /api/sessions/:id`（`main.ts` 的 `onApproval` / `onActiveTools` 原样搬家）。
- **应用级**（左下角「设置」）：外观、模型清单（`PUT /api/models`）、默认模型、bash 超时，**外加
  两个全局默认**——全局默认审批（六个 `APPROVAL_TOOLS` 的勾选，写 settings 的 `approval`；这个面
  现在 UI 里根本没有，全局审批只能手改文件）和全局默认工具集（见 4）。现有「会话」页就此拆掉：
  `defaultModelSection` / `bashSection` 留在应用级，`toolList` / `approvalList` 搬进会话级。
- 命名：会话级面板标题「**会话设置**」，应用级维持「**设置**」，两个按钮文案都是「设置」——
  位置（输入框上 / 左下角）已经把级别说清了，标题再带"应用级"就是冗余。

### 2. "本会话没单独选过" = **字段等值**，不是"有没有 entry"

判据：branch 上最后一条 `tool_config` 的 `activeTools` 与 `approval` **逐字段等于当前全局值** →
沿用全局；branch 上**没有** entry 也算沿用全局（会话从未选过，生效值就是全局值）。

为什么不能取"有没有 entry"：会话文件只追加，`SessionManager` 只有 `append*` 与 `branch`/`resetLeaf`
（session-manager.ts），删除 entry 的 API 不存在——而 3 的复位必然写成一条等于全局的新 entry，
此时"有 entry"会把刚复位的会话错报成"已单独设置"。等值判据在两种情况下都给出正确答案。

边界要诚实说出：等值对照的是**当前**全局。复位之后全局默认又改了，会话会显示"已单独设置"——
这是真话（它的 entry 确实不再等于全局），再点一次「沿用全局」即可重新对齐。

显示载体：`SessionSnapshot` 加 `toolsFollowGlobal` / `approvalsFollowGlobal` 两个布尔，**分半判定**——
两张映射同住一条 entry，但用户可能只动过其中一半。服务端在 `Agent.snapshot` 与
`readSessionSnapshot` 各算一次（两处都拿得到 `settingsManager`）。

### 3. 「沿用全局」复位 = 写一条等于全局值的 entry

查证结论：**会话层不支持"撤销"**。文件只追加；`branch()` 能把 leaf 挪到某条 entry 之前，但那会把
对话一起回退，不是复位工具设置该借用的手段。

所以复位走现有两个端点就够了，不新增端点：`PUT /tools` 传全局默认工具集 + `PATCH` 传全局审批表，
合并起来就是一条等于全局值的 `tool_config`。与 2 组合后，复位完 UI 显示"沿用全局"。
顺带的好性质：`Agent.setActiveTools` 对等值集合是 no-op（agent.ts:988），已经等于全局时再点复位
不写 entry，零成本。

### 4. 全局默认工具集：**加**

不加则"沿用全局"对工具恒等于"全量启用"，全局设置里也无从配置工具——与"没单独选过就沿用全局
设置里设置好的"直接矛盾。审批那半张图有全局默认（`settings.approval`），工具这半张图没有，两个
入口的对称性也要求补上。

- **schema**：`Settings` 加可选 `tools?: string[]`（全局默认活跃工具名）；**缺省 = 全部启用**，即
  今天的注册表默认（`createToolRegistry` 六个全激活），老 settings 文件零迁移。同路加
  `SettingsPatch.tools` 与 `SettingsSnapshot.tools`；`SettingsManager` 当普通字段读写，写回提供了
  该字段的那一层，无需特判。
- **归一化**：settings.json 手可编辑，装配件照 `applyRecordedToolConfig` 的既有先例**过滤**掉本构建
  不认识的名字（filter，不 throw）——一个升级后消失的工具不能拒绝会话打开。REST 提交侧仍校验
  字符串数组。
- **装配顺序**：`assemble()` 里 subagent 工具注册之后、`applyRecordedToolConfig` 之前——branch 上
  没有 entry 且 `settings.tools` 有值时 `setActive(过滤后的全局默认)`；有 entry 时照旧 entry 优先。
  `applyBranchToolConfig` 注释里"the settings files say nothing about which tools are active"一句
  随实现一并改写（设置文件从此说了）。

### 5. 运行中修改会话级设置：边界查证未变，拆分不动通路

- `Registry.setActive` 先验全量名字、未知即抛且**不动原集合**（registry.ts:74-80），服务端
  `updateTools` 把它翻成 409——半套集合不可表达，这条不变。
- `Agent.setActiveTools` 变更后重写 leading system message 并 `publish`，下一次请求生效；正在执行
  的调用不受影响。审批闸门 `authorize` 每次现读 `getApprovals()`（全局映射 + 会话 `approvalOverride`）；
  `applyConfig` 的审批补丁显式剥离 `approval` 再落 settings 文件，不会把会话选择漏成全局默认。
- 切分支时 `applyBranchToolConfig` 把两张映射整体换成目标 branch 的记录，旧 branch 的选择不残留。

### 交给 10 号的结论

两个入口各装什么见 1；会话级需要 `SessionSnapshot` 的两个 followGlobal 布尔做显示，复位用现有
端点组合；应用级要新渲染全局审批与全局工具两节、`/api/settings` 收 `tools` 字段（见 4）。
"完全权限"照 map.md 的 Out of scope 不做成档位选择器，由会话级「设置」顶替。

### 落点

- 本 Answer；术语表更新在 `AGENTS.md` 的 **settings** 词条（根目录没有 `CONTEXT.md`，术语表目前
  住在 `AGENTS.md`——见 `docs/agents/domain.md`；"设置"从此分两级）。
- map.md 的 Decisions so far 加一行。代码改动（schema、面板拆分、快照布尔）全部归 10 号。
