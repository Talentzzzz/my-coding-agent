# 04 终验:全套绿 + 清零断言

Type: task
Status: resolved
Blocked by: 03

## Question

终点站验收:确认目的地达成,图可以收口。

清单:

- `npm run check` 绿(core/server/web tsc + token 审计,无 llm 棒);
- smoke 全套绿:smoke-tools、smoke-models、smoke-sessions、smoke-api、smoke-mux,以及
  approval/queue/recovery/session/boot 等库内其余 smoke(与上一张绿基线比,零新红);
- `npm run build:web` 绿;
- 清零断言:`AgentContext`、`AgentTool`、`LlmContext`、`@my-agent/llm`、`packages/llm`
  在源码、脚本、配置里 grep 清零(文档只许 ADR 历史叙述豁免);
- 行为零变化抽查:挑一条 smoke 的输出与改动前基线对照(diff 为空);
- 全部通过后:在本 map 的 Decisions so far 逐票补行,图收口,交接执行完毕的仓库状态。

任何一条红:按 map 的 Not yet specified 约定登记升级,不顺手改行为。

## Answer

终验完成(前置:票 03 的 `fa66354`),四道关口全部过关,图收口。

**对照方法**:不看文字记录,而是在同一台机器、同一套宿主垫片下把**改动前那棵树**拉起来跑同一批脚本
——`git worktree` 于 `511fc09`(票 01 的父提交)到临时目录,`node_modules` 用 junction 接回
(`.scratch/context-tool-unification/smoke-runs/` 里有三个脚手架脚本,不属于仓库)。这样两边输出现成的
diff 就是行为差异本身,而不是"我记得当时是绿的"。

### 1. `npm run check` 绿

两棒 tsc(core+server、web 客户端)+ 设计 token 审计一次过:`tokens ok: 137 defined, 111 referenced`。
`packages/llm` 那一棒确实不在了(见 4)。

### 2. smoke 全套:零新红

28 个脚本逐条串行跑,两边同一套环境:

| | 绿 | 红 |
|---|---|---|
| HEAD(无服务器) | 26 | `smoke-api`、`smoke-liveness` |
| 基线 `511fc09`(无服务器) | 26 | `smoke-api`、`smoke-liveness` |

(HEAD 早一轮是 25 绿,差的那一条是 `smoke-approval-endpoint`,即下面那条宿主垫片的偶发崩,复跑
即绿;头一轮还有一批因宿主的「一次 rm 目标数」限额挡在清理那一步,把阈值放开后不再出现。)

- **`smoke-api`**:按 README 的样子起一只服务器(`node packages/server/src/main.ts --workDir …`,
  `MY_AGENT_HOME` 指到临时目录)后,HEAD 与基线都 `api ok`。它要的只是那只服务器。
- **`smoke-approval-endpoint`**:HEAD 有一轮崩在
  `ERR_INVALID_ARG_VALUE … 'C:\\User\x00s\\…'` —— 宿主 `node-brokered-fs-shim` 往路径里插了空字节,
  和代码无关;单独复跑两次都 `approval endpoint ok`。
- **`smoke-liveness`**:两边**同红、同一条断言**——`within three of the heartbeats it was promised,
  plus margin for the runtime` 实测 1967 / 1974 / 1982 ms,预算 1650 ms(3×50 + 1500)。去掉宿主垫片
  (`NODE_OPTIONS=`)复跑仍红(2212 ms),基线树也红(1970 ms),所以它是**改动前就在**的断言/环境问题。
- 其余 26 条两边同为绿,耗时量级也一致(`smoke-sessions` ~55 s、`smoke-mux-live` ~17 s、
  `smoke-approval` ~21 s)。

结论:两条红都不是这次引入的,零新红成立。

### 3. `npm run build:web` 绿

vite 7.3.6:`index.html` 1.49 kB、`index-L0rhCtf5.css` 52.98 kB、`index-DG-PbtuT.js` 116.90 kB。资产
hash 与基线树的构建**一模一样**(基线那棵补建一次后也是同两个文件名),只有 `index.html` 的字节数差
37(基线工作树是 CRLF 检出),内容逐行相同。

### 4. 清零断言

- `packages/`、`scripts/`、根 `package.json` / `tsconfig*.json` / `install-deps` 的 workspace 表:
  `AgentContext`、`AgentTool`、`LlmContext`、`@my-agent/llm`、`packages/llm` **0 处**;
- `packages/llm` 目录不存在;workspace 四项;`tsconfig.json` 的 `paths` 只剩三条 `@my-agent/core*`;
  `check` 只剩两棒 tsc + token;
- 全仓剩余 **37 处,全在文档**:`adr/0001`(3)、`adr/0008`(12,含「取代者」前向指针)、
  `adr/0015`(17,本 ADR 的主题就是那个包)、`adr/README`(1,清单行)、`docs/notes.md`(4,第一节
  「结论清单」)。前四项是 ADR 历史叙述,notes 按票 03 记下的票 14 扩免先例;`architecture.md`、
  `AGENTS.md`、`README.md` 为 0,与票 03 的账一致、没有反弹。

### 5. 行为零变化抽查:28 份输出逐份 diff

- `smoke-tools` 的 223 行输出与基线**逐字节相同**(票面要求的那一条)。
- 另补一条票面没要求但更硬的证据:把两棵树的 `@my-agent/core` 导进来比运行时出口面——基线 108 个名字,
  HEAD 111 个,多的三个是 `anthropicMessages`、`createAssistantMessageEventStream`、
  `getSystemMessageText`,正是决定 5 要求补的那段传输面出口(server 与 `scripts/fake-transport.ts`
  从 `@my-agent/core` 取它们),**没有任何一个名字消失**。
- 25 / 28 份**完全相同**;3 份有差异,逐份解释清楚:
  - `smoke-boot`:端口号、临时目录、会话 id 是随机的;另有一处真实差异——基线工作树没有 `dist`
    (gitignore),`index` 报 503 而不是 200,在基线补建一次 `build:web` 后同为 200。产品代码无关。
  - `smoke-liveness`:只有那行毫秒数(1974 / 1982)。
  - `smoke-approval-endpoint`:宿主垫片那一次崩(上面已记)。

### 6. 账与收口

- 本票 Answer 落账;ADR-0015 的状态行与*没有被取代的*里的验收句按今天的实测收紧(不再写「除
  `smoke-api` 外全套绿」那句——它在今天这台机器上不可复现),`adr/README` 的清单行同步;其余不动;
- map 的 Decisions so far 补第四条,图收口。

### 7. code-review 双轴(511fc09..本笔)

**Standards 轴:零硬违规。** 六条判断项,逐条结论:

- 头注释里的「25 个折叠文件」实为 **23** 个(我按 `grep -rl` 数的),已按实修正,并把两处仍把
  `core/src/llm/` 叫「this package」的句子(`llm/index.ts` 开头、`llm/model.ts` 的 `transport` 字段)
  并进同一张待微票——与票 03 记的那张是同一件事,只是清单要准;
- `ToolCallOutcome` 的 `{ result, isError }` 与 `ExecutedToolCallOutcome` 撞字段(data clumps)、
  `llm/types.ts` 与 `types.ts` 两处都转出同一个名字、少量机械重复的 type import:都是**改动前就在**的
  形状或纯风格,动它们等于顺手改结构,本图不做;
- 出口面上 `ToolExecutionMode`、`ToolUpdateCallback`、`ToolResult` 三个名字零消费者:那是票 02 为了
  与原 `agents` 出口一一对应而保留的公共面,不是死代码。

**Spec 轴:一处定案偏离,已记账。** `ToolCallOutcome` 住在 `packages/core/src/types.ts`,而定案 3 的
名单把它列在 `llm/types.ts`。复核后**不动代码**:它只有 `Agent` 一个读者、是钩子跑完之后的定稿形状,
搬进传输契约会与 ADR-0015 保留下来的 0008 决定 6 分界(引擎契约住 `types.ts`)打架。ADR-0015 决定 4
补了这一笔,map 同记。其余 Spec 轴意见(README 文件名更正、architecture 同步 ADR-0014、
`toToolDeclaration` 的类型不诚实)都是已记账或已记在 ADR 的项,复核无新问题。

### 登记升级(本图不处理)

`smoke-liveness` 那条时序断言在本机改动前后同为红:客户端判活实测 ~2.0 s 落到 1.65 s 的预算之外。
它不是本图引入的,修它要么动客户端判活、要么动断言预算——两者都越过「零行为」红线,所以按 map 的
*Not yet specified* 约定登记在案,留给下一次专门处理(与 `smoke-api` 的环境依赖同一类:rig 与宿主,
不是产品)。票 02 留的 `toToolDeclaration` 类型诚实性一票也已复核:ADR-0015 *后果*一节第三项已经写明,
无需另加备注。
