# 04 · 模型：字段改名 + 客户端内置默认模型

Type: task
Status: resolved

## Question

**A. 字段名（`优化/7.png` 的设置 → 模型表单）**
现在是「名称 / 模型 ID / 服务地址 / API 密钥 / 上下文窗口 / 最大输出 / 该模型支持推理·思考档位 / 默认思考等级」。用户要的八个标签，逐字：

| 现在 | 改成 |
| --- | --- |
| 名称 | 名称 |
| 模型 ID | 模型 |
| 服务地址 | BASE URL |
| API 密钥 | API KEY |
| 上下文窗口 | 上下文长度 |
| 最大输出 | 最大输出长度 |
| 该模型支持推理 / 思考档位 | 思考模式 |
| 默认思考等级 | 默认思考强度 |

提示文案（`model-hint`）可以保留并顺一遍措辞；“思考模式”是复选（支持/不支持），不是下拉，别把语义改掉。

**B. 默认模型（客户端写死，可删除）**
用户定的机制：常量定义在 `packages/web`，**不碰服务端**。模型列表为空时，客户端用现有 `PUT /api/models` 把这行种进去：

- 名称 `deepseek-flash`、模型 `deepseek-flash`、BASE URL `https://api.deepseek.com/anthropic`、**apiKey 空**（留给用户填）、上下文长度 `1000000`、最大输出长度 `384000`、思考模式开、默认思考强度 `high`。

“用户也可以删除这个默认的”：种过之后不再种回。删掉列表里唯一一行时也不应复活——需要一个持久的“已删除”标记；`Settings` 里没有这个字段，优先复用客户端能持久化的东西（注意 `localStorage` 按端口隔离，桌面壳每次新端口会丢，见 `config.ts` 的注释），必要时给 `Settings` 加一个布尔字段并同步 `mergeSettings`。这条选择在实现时按最小改动定，并在票据答案里记下理由。

**C. 本机数据修正**
当前 `~/.my-agent/models.json` 第一行是 `scripted`（占位端点），`settings.json` 的 `model` 是 `deepseek/deepseek-flash`——解析不到，`selectModel()` 静默回落到第一行，所以“默认模型”看起来是 Scripted。修完 B 之后：删掉 scripted 行、deepseek-flash 的上下文/最大输出改成 1,000,000 / 384,000（**保留已存的 apiKey，绝不打印、绝不写进票据**）、`settings.model` 改成 `deepseek-flash/deepseek-flash`。

验收：设置 → 模型里八个标签与上表一致，新建表单八个字段齐全；清空 `~/.my-agent/models.json` 后启动窗口，列表里出现一行 deepseek-flash（key 空），填 key 后能发请求；删掉它再重启不会复活。`npm run check` 与 `scripts/smoke-models.ts` 通过。

## Answer

A、B、C 三部分全部落地。A 只动设置面板的两个函数；B 是纯客户端的常量加一条“已种过”的设置标记，
**没有碰 wire、没有加端点**；C 是一次性的本机数据修正。为了记住“删掉就不再种”，`Settings` /
`SettingsPatch` / `SettingsSnapshot` / 客户端的 `PanelSettingsPatch` 各多了一个布尔字段
`defaultModelSeeded`——这是本次唯一的协议面变化。

### A. 八个标签

设置 → 模型的新建/编辑表单，逐字改成下表；提示语顺过一遍，**「思考模式」仍是复选**（支持/不支持），
没有变成下拉：

| 字段 | 标签 |
| --- | --- |
| 名称 | 名称 |
| 模型 id | 模型 |
| 端点 | BASE URL |
| 密钥 | API KEY |
| 上下文窗口 | 上下文长度 |
| 输出上限 | 最大输出长度 |
| 是否支持推理 | 思考模式 |
| 新建会话的起点档位 | 默认思考强度 |

「思考模式」原来把复选框和文字平铺在 `model-check` 一行里；现在它包在 `model-field` 里，复选、标签、
提示各就各位，和其余七个字段同一列。`scripts/smoke-model-form.ts` 用 dom-shim 驱动生产
`SettingsPanel`，逐字断言八个标签、复选语义、唯一的下拉（默认思考强度），并检查六个旧标签没有残留。

### B. 客户端内置默认模型

新增 `packages/web/src/default-model.ts`：

- `DEFAULT_MODEL`：名称/模型 `deepseek-flash`、BASE URL `https://api.deepseek.com/anthropic`、
  上下文 `1_000_000`、最大输出 `384_000`、`reasoning: true`、`defaultThinkingLevel: "high"`，
  **不带 `apiKey` 字段**。缺字段而不是 `apiKey: ""` 是有意的：端点把“该字段缺席”读成“保留已存密钥”，
  所以这一行永远不会覆盖谁存过的凭据；同时仓库里不出现任何密钥字符串。
- `defaultModelDue(models, seeded)`：**一行都没有**且**从没种过**才为真。
- `seedDefaultModel(host)`：先 `save([DEFAULT_MODEL])`，再 `markSeeded()`。顺序是断言过的：
  存行失败会先抛，标记不落，下次启动重试；反过来先落标记会让一台空机器永远不再种。
- `host.save` 走的就是现有的 `PUT /api/models`（`api.updateModels`），没有新端点、没有服务端常量。

“删掉后不复活”的标记放在 `Settings` 而不是 `localStorage`：桌面壳每次启动换端口，`localStorage`
按 origin 隔离，标记会恰好丢在它要防的那次重启里（`config.ts` 里早有同一结论的注释）。代价就是上面说的
四个接口各加一个布尔字段：`config.ts` 的 `Settings` + `mergeSettings`（`false` 也保留，手写 `false`
= 再种一次）、`protocol.ts` 的 `SettingsSnapshot`、`settings-manager.ts` 的 `SettingsPatch`、客户端的
`PanelSettingsPatch`，以及 `server/src/controllers/sessions.ts` 的上报与布尔校验。

`main.ts` 把原来的 `api.listModels()` 换成 `importedModels()`：读列表 → 需要时 seed → 返回要显示的行。
启动顺序是 **settings → models → current-session**，所以种子行在会话装配之前就已进店，输入框的座位直接
落在 `deepseek-flash/deepseek-flash` 上；种入失败只 `report`，空列表照常落地，设置面板仍是修法。

### C. 本机数据

`.scratch/ui-fix-pass/research/fix-04-local-data.ts` 走生产 store/manager 重放了这次修正：删掉
`scripted` 占位行，放入 `deepseek-flash`（ctx 1,000,000 / max 384,000 / reasoning / level high），
`settings.model` 改成 `deepseek-flash/deepseek-flash`，并把 `defaultModelSeeded` 写成 `true`。
最后这一步是审阅补的：这一行是脚本种的、不是窗口种的，不落标记的话删掉它再重启会被当成“空机器”
又种回来，恰好违反本票“删掉不复活”。执行后 `~/.my-agent/models.json` 只剩一行，密钥状态是**空**，
`models.json` / `settings.json` 与窗口首启后该有的状态一致。

原 `scripted` 行确实带过一个字符串密钥；经 sha256 比对，它就是脚本夹具
`unused-by-the-scripted-transport`，所以删掉它没有丢弃真凭据（值从未打印）。这台机器上**没有** DeepSeek
key，因此新行的 key 留空——这正是票据要求的“留给用户填”。“填 key 后能发请求”在本机只能用脚本化传输
验证到“这一行能走通发送路径”，不能验证 DeepSeek 真的应答。

### 验证

```
npm run check
node scripts/smoke-default-model.ts   # 常量每个字段、coerceModel 收下的形状、due 四种组合、先存后标、失败不标
node scripts/smoke-model-form.ts      # 生产面板的八个标签、复选语义、无旧标签残留
node scripts/smoke-settings.ts        # 第 4 节：标记写→新 manager 重读→磁盘字段→手写 false 留得住
node scripts/smoke-modes.ts
node scripts/smoke-models.ts
npm run smoke:boot
npm run build:web && node .scratch/ui-fix-pass/research/verify-04.ts
```

`smoke-model-form.ts` 也加进了 `packages/web/tsconfig.json` 的 include：它 import 本包源码和
dom-shim，理应像其余 UI smoke 一样被 `npm run check` 检查（否则新脚本逃过 tsc）。

`verify-04.ts` 在真 Chromium + 临时 `MY_AGENT_HOME` 上跑完整条验收：空列表启动 → 列表里出现
`deepseek-flash`（key 空、数字与端点逐项一致、`defaultModelSeeded: true`）→ 输入框座位就在这行上 →
设置面板八个标签逐字一致 → 表单里填 key 保存后 `hasApiKey: true` 且其他字段没被动 → 发一条消息，
脚本化传输收到 1 次请求、回答落屏 → 面板里删除 → 列表与 `models.json` 都空、标记仍在 → **换一个新
端口重启** → 列表仍空、座位回到占位模型 `my-agent:unconfigured/no-model`，这一行没有复活。

### 诚实边界

- **没有向 DeepSeek 发过真实请求**：本机没有 key。发送路径是用 `scripts/fake-transport.ts` 验证的，
  证明的是“种下的行 + 填的 key 走到了请求”，不是供应商真的应答。
- `markSeeded` 走 `saveSettings`，而它按既有设计吞掉失败只上报。理论上“行存成功、标记写失败、随后又
  删掉行、再重启”会重种一次；本次接受，没有冒烟能构造这个顺序，收紧它会改动 settings 写入链的失败语义。
- 种入是窗口**未经请求的写**。边界写死在 `defaultModelDue`：只在列表为空、且标记不是 `true` 时发生，
  一行一个字段都可改，删掉即最终。它不会在列表非空时发请求，也不会覆盖已存的同名密钥（字段缺席）。
  但 `PUT /api/models` 是整表替换，所以“读到空”与“写回”之间若另一个窗口刚存了自己的行，理论上会被
  这次种入覆盖——只存在于同机两窗口同时首启的窗口期，单窗口桌面壳里不出现；要根治得给服务端一个
  “空表才写入”的原子命令，那超出本票“不碰服务端”的约束。
- 这个默认只存在于客户端；CLI / 服务器启动不会种。这是票据指定的“常量定义在 `packages/web`，不碰服务端”。
