# 22 空态里的模型位读作「（已丢失）」

Type: task
Status: resolved
Blocked by:

## Question

19 号核验时在截图 `research/v19-a5-deleted.png` 上看到的：**删掉正在读的那条会话之后**，窗口按
08 号定的规矩回到空态（hero），可输入框右下那个模型位写着

> 齿轮 `（已丢失）` ▾

名字是空的，只剩「（已丢失）」四个字——**没有任何模型丢失**，是这里根本没有会话，也就没有选过
任何模型。同一时刻头部副标题写「连接中…」，那是空态的正常文案，不是这一条要管的。

**来路**（`packages/web/src`）：

- `main.ts:806-813` 的 `selectionForSend()`：`const model = chosen.model ?? snapshot?.model ?? "";`
  ——空态下 `snapshot` 与 `chosen.model` 都为空，于是 `model` 就是**空串**；
- `composer.ts:154-157`：空串不在 `selection.models` 里，所以补一行
  `option(selection.model, \`${selection.model}（已丢失）\`)`，而它的另一半是
  `selection.models.length === 0 ? "未配置模型" : …`——**空串既不是"有模型但丢了"，也不等于
  "一个模型都没配"，两个分支都没接住它**。

换句话说这是个边界：`model === ""` 是「还没轮到选」这个第三态，被塞进了「选过、但那一行没了」
这一支。

要拍板并落地的：

1. 空态（`snapshot === undefined`）这一位该读什么——「未配置模型」/「选择模型」/别的，还是干脆
   收起不显示。参考实现与本窗口空态其它文案（「想做点什么？」）的调子要对齐。
2. 判定条件怎么改：是 `selectionForSend()` 在空态返回一个明确的「未选」标记，还是
   `composer.ts` 把 `selection.model === ""` 单独分一支——哪一种都不会再让空串走进「已丢失」。
3. 顺手核对同一分支在别处有没有同样被误喂的第三态（`render/settings.ts:457` 的
   `${current}（已丢失）` 是同一个写法，但那边 `current` 是配置里的真值，应当不受影响——
   核一下即止）。

不在本票范围：21 号（删除后给已删会话补发 `open` 的红横幅），两条来路不同、互不覆盖。

## Answer

### 三项拍板

1. **空态座位读「选择模型」。** 与 hero 的「想做点什么？」同为轻声邀请式文案——座位在空态是
   活的（还有模型可选、可以选），「收起不显示」与这个事实矛盾；「未配置模型」留给
   `models.length === 0` 那一支不动（那一支没病，但本票的判定条件动过它的次序，verify-22 的
   C 段把它原样钉住：文案不变、座位禁用、横幅照出）。
2. **判定条件改在 `composer.ts` 单独分支**，`selectionForSend()` 一字未动——空串本来就**是**
   「还没轮到选」的标记，窗口没有第二个第三态。新分支序 `未配置模型 → 选择模型 → （已丢失）`
   把 `model === ""` 挡在「已丢失」之前，空串永远到不了那一支。
3. **`render/settings.ts:457` 核过，不受影响，未改**：它有 `current.length > 0` 守卫，而
   `current = settings?.model ?? ""`——空默认渲染成「第一个导入的模型」占位项，到不了
   「已丢失」；且那边 `current` 非空时是配置文件里的真值，与票面预判一致。

### 红绿与覆盖（`research/verify-22.ts`，真 UI 断言 + 出图）

`npm run build:web && node .scratch/window-polish/research/verify-22.ts`，8 条断言：

- **A 段（修正票面的一个隐含假设）**：新装配的会话快照里**已经有**装配时采纳的默认行，所以
  第三态并不在「新会话还没发话」时现形——它只在 `snapshot === undefined` 的空态出现。A 段把
  「座位跟装配行」钉成基线。
- **B 段**：删掉正在读的会话 → 空态座位值是空串、读「选择模型」而不是「（已丢失）」、座位可用
  （图 `v22-b1-empty-seat.png`；修复前这一条 FAIL，读的正是「（已丢失）」）。随即在空态选一次
  占位项再新建会话，座位跟上新会话自己的装配行——`chosen` 不会被压在空串上（`openSession` 的
  `chosen = {}` 兜底，`main.ts:1064`）。`onSelectModel("")` 不设守卫是量过的：`change` 只在值
  变化时触发，而占位项只在它已是选中值时存在于 DOM，真 UI 到不了那条路。
- **C 段**：零模型时座位读「未配置模型」且禁用（本票改动了该支的判定次序，原样回归）。

`npm run check` 绿（token 审计 127/101）。

### 执行期发现：核验脚本覆盖了真实的 `~/.my-agent/models.json`（已恢复 + 已堵）

**本票红跑撞出比票面更重的事**：`setUserModels` → `UserModelStore.replace()` 是**整文件覆写**
`AGENT_HOME/models.json`，而核验脚本从不隔离 agent home——19 号昨天起的每次运行加本票第一次
红跑，都把用户自己的模型清单整份替换成假行 `scripted`。已做三件事：

1. **恢复**：`~/.my-agent/models.json` 已清回 `{"models": []}`。**密钥与 baseUrl 无法从本地
   痕迹恢复**（会话文件只记 ref，不记 key）；从会话 `model_change` 条目能看到的真实行名：
   `anthropic / claude-sonnet-4-5`、`deepseek / deepseek-flash`（rafflex 工作区，10-14 在用），
   需要用户在设置面板重录。卷影副本要管理员权限，未尝试成。
2. **堵漏**：`verify-19.ts` 与 `verify-22.ts` 都加了 agent home 隔离——`MY_AGENT_HOME` 指向
   临时目录，且因为 `AGENT_HOME` 在 config.ts 装载时求值，core 模块改走动态 import、立环境
   变量在先。19 号脚本是已解决票的产物，本应另开票，但留着就是继续损坏用户数据的活隐患，
   且修复是纯 `.scratch` 脚本隔离、零产品代码——就地修了，特此登记这次越界。
3. 顺带修正 19 号脚本里「会话清单是整机的」那条注释的前提：清单随 agent home 一起隔离了。

### code-review（两轴，2026-10-15）

- **Standards**：composer.ts 无违规（英文注释、中文文案、token 零新增）。空串哨兵被判为
  Primitive Obsession 的判断题——接口 JSDoc 已把空串记载为合法态，按仓库既有形状走，不改。
  verify 脚本的中文注释按 20 号已立的先例处理：research/ 目录既有惯例，不改。
- **Spec**：三项裁决均判与票面约束连贯；指出的一处证据缺口（第 3 条核对无留痕）已由本
  Answer 补上；verify-19 的搭车改动判为「良性越界、应登记」——即上节。
