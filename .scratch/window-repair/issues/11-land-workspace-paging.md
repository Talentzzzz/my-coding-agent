# 11 落地工作区分页 + 表头收起（09 号拍板的形态）

Type: task
Status: resolved
Blocked by:

## Question

09 号原型已在用户面前拍板三处形态（见该票的 Answer），本票把形态落进真的左栏
（`packages/web/src/render/sidebar.ts`）。用户原话的行为今天已经是半个机制、单向的：默认 4 条、
「more」只加不收、表头没接事件、状态关窗即忘。

**拍板的三处（照 09 号，不再议）：**

1. 默认**5 条**（今天的 `COLLAPSED_COUNT = 4` 要改）；「展开其余 N 个会话」点一次 +5。
2. 点工作区表头收起全部、只留表头；从收起点表头展开，回到**上次展开到的那一页**
   （页码记在收展状态里，收起时保存）。
3. 全部展开之后按钮变**「收起」**：点了回到 5 条、**不动**页码记忆；只在会话数超过 5 的工作区出现。
4. 收展状态**跟 appearance 走**（`SettingsManager` 合并的那两份 `settings.json`），**不用
   localStorage**——桌面外壳每次启动挑新端口，origin 一变它就死。appearance 的真实
   序列化→恢复路径在本票里要真验一遍（原型里的「记住」只是内存模拟，09 号已声明这条没验到）。

**落地时要跟着改的（09 号票里记的，动手前重读一遍）：**

- **`main.ts:708` 的重画签名** `${rows.version}|${followed ?? ""}|${directory}|${pickedWorkspace}|${collapsed ? 1 : 0}|${channel}`
  要把收展状态带上——签名里没有它，收起 / 展开根本不会重画；
- **`pickedWorkspace`（`main.ts:81`）驱动的「当前」标记**（`sidebar.ts:347-352`）要与收起态共存：
  收起的工作区照样可能是当前；
- 展开计数照真实现**按会话走**（`collapsedRows()`：根 + 它的派生算一个，派生不占别的会话的名额、
  正在看的那位永远在场）——原型为看得清按行数演示，落地不许照抄行数版；
- 表头从 `div` 变真按钮：`[aria-expanded]`、收起时 chevron 常显并转向右（`style.css:429-437` 那个
  hover 假承诺由此兑现）、键盘可达。

**验收**：`npm run check` 全绿；`scripts/smoke-sidebar.ts`（或它演化后的名字）盖住三个拍板行为——
+5 翻页、表头收起只剩表头、收起重开回「上次那一页」；appearance 那条用真 `SettingsManager` 驱一遍
（写 → 重读 → 状态还在）。参考形态以
[`prototype/09-workspace-paging.html`](../../../prototype/09-workspace-paging.html) 为准（浅深两套都看）。

## Answer

2026-10-16 落地完成。三处拍板全部进了真的左栏，逐条对着票面：

1. **默认 5 条、点一次 +5**：`sidebar.ts` 的 `COLLAPSED_COUNT = 4` 改成 `PAGE_SIZE = 5`，`collapsedRows()`
   泛化为 `pagedRows(rows, active, pageCount)`——按**会话**（根）计页，活跃者的根永远在场，`Infinity`
   是过滤态的页数。计数不是原型的行数版。
2. **表头收起 / 重开回上次那一页**：表头从 `div` 变成真 `button`（Enter/Space 可达，`[aria-expanded]`
   驱动 chevron 常显右转 + focus-visible，`style.css` 里那个 hover 假承诺兑现）；页码记忆三字段
   `WorkspacePaging { collapsed, page, savedPage }`——展开落在 `savedPage`，收起时写 `savedPage`，
   「收起」按钮回第 1 页但**不动** `savedPage`，只在会话数超过 5 的工作区出现。
3. **收展状态跟 appearance 走**：`AppearanceSettings.workspaces`（按 cwd 键控），core 里
   `clampWorkspacePaging()` 逐条归一（坏条目丢、坏页码落回 1、空表钳成 undefined 即字段缺席），
   server 的 appearance patch 接受它，客户端 `PanelSettingsPatch` 发整表。`main.ts` 的 `setPaging()`
   本地先动、立即重画、再经 `saveSettings` 落盘；**重画签名**加上了 `JSON.stringify(paging)`。
   localStorage 一处都没碰。

「当前」标记与收起态共存（收起的工作区照样标「当前」）；过滤态照旧翻出全部匹配，分页与收起都不拦。

**验收与评审**：`npm run check` 全绿（token 133 defined / 107 referenced）；`smoke-sidebar.ts` 新增
4 节盖住 +5 翻页、表头收起只剩表头、重开回「上次那一页」、按会话计数，另加过滤翻越收起态一节；
新增 `scripts/smoke-settings.ts` 用真 `SettingsManager` + 真文件走「写 → 新 manager 重读 → 状态还在」，
连磁盘内容一起断言（README 清单已登记）。双轴 code review 抓到一个真缺陷——**收起态下表头下面会
多画一个「展开其余 N 个会话」按钮**（hidden 没被 open 拦住，smoke 也没断言到）——已修
（`paged = open && filter === ""` 门控 + smoke 14 补「没有 session-more」断言）。全量 README 清单
（check + 16 条 smoke，不含需活服务器的 smoke-api）全绿。
