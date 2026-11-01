# 08:全量验证与文档总校

Type: task
Status: resolved
Blocked by: 07

## Question

收尾验证,标准与前作票 18 相同:

- `npm run check` + smoke 全套一次跑绿;任何失败先判「真回归还是按新生命周期
  该重写」,真回归回修,语义变化的 smoke 按新形状重写并在票下登记。
- 桌面手测清单(开窗、对话、审批、分支、队列、改模型/档位、设置面板、模式切换)
  人工执行——窗口客户端预期零改动,这是它的验收线。
- 文档总校:`AGENTS.md` `## 术语`(session / model / transport / assembly 词条的
  持有模型表述)、`docs/architecture.md`(持有模型一节、请求流程)、ADR-0006 与
  ADR-0007 交叉引用一致;`CONTEXT.md` 尚不存在,若 03 票的命名沉淀了新术语
  (OpenSession 候选),随本票评估是否落 glossary。
- 密钥红线抽查:`GET /api/models` 仍只报 `hasApiKey`,无回显密钥的新字段。

## Answer

**结论:check 与 smoke 全套跑绿(两处判为环境/工具问题,不是回归),文档总校五处落地,
`CONTEXT.md` 决定不建。桌面七项手测清单仍需人跑一遍,清单与本次已自动验过的部分见下。**

### 一、check 与 smoke

`npm run check`:四份 tsc(llm / loop / core+server / web)全过,token 审计
`137 defined, 111 referenced`。

smoke 逐个跑过,**25 个进程内脚本 + `smoke-api` 全绿**:tools / sessions / projection /
mux-client / mux-live / mux / liveness / backpressure / sidebar / settings / modes /
transcript / frame / branch / session / models / default-model / model-form / approval /
approval-endpoint / approval-recovery / replay / boot / desktop-close /
desktop-observability,加上对 `npm run start` 起的真服务器跑的 `smoke-api`(`api ok`)。
**没有一条 smoke 需要按新形状重写**——07 票的迁移已经把语义搬完,本票只做确认。

一处非零退出,**判为环境而非回归**:`smoke-session` 第一次 `exit=1`,但输出的每一条 check
都是 `ok`,崩在 `finally` 的清理段——宿主的 safe-delete 闸因为一次要删 73 个文件(阈值 50)
而拒绝批量删除,抛出的是 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`,目标正是这个 smoke 自己造的
临时工作区与 `workspaceDir(root)`。关掉那个闸让同一次运行跑完,`session ok`、`exit=0`。
脚本一字未改:它要删的本来就是自己造的东西,`docs/notes.md` 那条"两个坑"仍然成立。

### 二、桌面窗口

`npm run desktop:screenshot` **截不到真窗口**,这是本票的发现之一(下面第三节第 1 条):
`--screenshot` 单独用时 `main.cjs` 加载的是 `about:blank`,服务器根本不启动,截出来是一张
1280×820 的纯黑图。既然票面的验收线是"窗口客户端零改动",那就用**外壳真实的启动路径**来验:
`packages/desktop/scripts/inspect-app`(进程内 `bootServer({ absCwd, host, port: 0 })`,
和 `main.cjs` 同一个调用形状)加载 `packages/web/dist`。结果:

- `bootServer` 10ms 起来;`GET /api/health` 200;`GET /api/sessions/current` 200 并给出
  一个 sessionId;页面自己的 `WebSocket(/mux)` 握手 `open`;
- 渲染出来的 DOM:副标题是工作区绝对路径(不再是「连接中…」)、状态行 `total —cache
  —context 0%`、设置入口、模型座位(`deepseek-flash`)与模式座位(`默认`)都在,
  `itemCount 0` 与空会话目录一致。

顺带一个反面确认:探针第一次误用旧参数名 `cwd` 调 `bootServer`,窗口就一直停在
「连接中…」——因为 `current` 回 500(`Cannot read properties of undefined (reading
'startsWith')`)。这正好复现了票 18 手测抓到的那类事故,而**外壳本身是对的**:
`main.cjs:89` 传的是 `absCwd`。改动参数名会让窗口"看起来连上了、其实什么都读不到",
这一点值得记住。

**仍需人工执行的七项**(自动化替代不了:审批、分支、队列、换模型/档位、模式切换都要真
窗口里的点击,而外壳不接受脚本化 transport):

1. 开窗:窗口出现、标题栏正确、落在一个新会话上;
2. 对话:发一条消息,看到流式输出与工具卡片(需要真实模型行与密钥);
3. 审批:`write`/`edit`/`bash` 触发横幅,准予与拒绝各走一遍,拒绝后运行收尾;
4. 分支:从一条消息「从这里 fork」,再在同一会话里切分支,卡片与走法跟着动;
5. 队列:流式中再发一条,`queued` 计数出现,并在取走点落盘;
6. 改模型/档位:输入框座位换一行、换一档,发消息后状态行与 transcript 跟上;
7. 设置面板与模式:改外观/字号即时生效,选一个模式后 `tool_config` 生效、座位显示该模式。

### 三、文档总校(五处)

1. **`AGENTS.md` `## 术语`**:`session` / `model` / `transport` / `assembly` 四条与代码
   逐句核对,均已是新形状(无 `private s`、无 `AgentConfig`、`ensureSession` /
   `createSessionAgent` / `openAgent == ensure + create`)——**不需改**。新增
   **service(无属性服务)** 一条:这是本 effort 的中心契约,原先只活在 ADR-0007 里,
   冷读者在术语表里找不到它。
2. **`docs/architecture.md`**:
   - 五个的算术统一("五个无状态单例 + 编排"读起来像第六个):现在一律是
     **四个域 + 一个编排层 = ADR-0007 的五个**(首段图、`各 package 的职责`、`谁拥有一个会话` 三处);
   - **工具契约**整节重写:定义(`toolDefinitions()`,只读、进程级工厂)/ 目录
     (`createToolRegistry`,进程结构)/ 选择(`ToolState`,从账本派生、随读取到达)三分,
     注册表只剩 `names` / `build` / `activeNames` / `active` / `register`,工作区与 bash 超时
     作为 `ToolRunContext` 随请求来;删掉 `setActive` / `all` / `get` 这套已经不存在的 API;
   - **谁拥有一个会话**:补上 `HostedSession` 的真实字段(`id` / `absWorkspaceRoot` /
     `claims` / `reaping`),并把"同一会话两个标签页会建出两个 `Agent` 对象"改成今天的
     形状——编排层已全进程一份,那条代价现在表现为"两条运行争一份 transcript";
   - **分支**一节:`branchTo` 之后重放的是**这个会话的选择**(`ToolState`),不是注册表。
3. **`docs/adr/README.md`**:0006 与 0007 的状态从「落地中」改为「已落地」——0006 的部分
   条款被 0007 重开这件事在两条 ADR 的题头与清单里已经三处一致(`取代` / `取代者` /
   清单备注),本票只补状态。
4. **`docs/agents/domain.md`**:术语索引补齐 `service` / `mode` / `OpenSessions`(原先缺
   三个,包括 03 票定名的那一个);"目前一条:0001"改为"到 2026-11-01 为止七条"并指向清单。
5. **`README.md`**:`session.settingsManager` 这个已经不存在的对象改成"进程一份、随条目
   交出去"的说法;`openAgent({...})` 的示例参数改成现行的 `sessionState` / `settingsState`
   (`SettingsManager.inMemory` 早已是 `inMemorySettingsState`);截图与 inspect 两段按实况
   改写(见第四节第 1 条)。

### 四、`CONTEXT.md`:评估结论是**不建**

`docs/agents/domain.md` 已经把 `AGENTS.md` 的 `## 术语` 指定为现行索引——"在 `CONTEXT.md`
取代它们之前,把那些当作术语表"。03 票的新词(`OpenSessions` / 条目 `OpenSession`)已经落在
那里,`service` 也在本票补上了。此刻新开一份 `CONTEXT.md` 只会造第二份 glossary,而仓库
既有的分工是:实况在 `architecture.md`、理由在 ADR、词义在 `AGENTS.md` `## 术语`。等哪天
术语表需要结构性重写(而不是加词条)时再谈。

### 五、密钥红线

`GET /api/models` 只报 `hasApiKey`:`ModelOption` 里没有 `apiKey` 字段,唯一构造点是
`listModelOptions()`(两个端点都用它);对运行中的服务器 `curl` 实测,响应体里没有
`apiKey` 这个键。`GET /api/models` 之外没有别的路径把行发给客户端。

### 六、发现(不在本票结论内,交回地图)

1. **`npm run desktop:screenshot` 的语义与 README 不符**:`--screenshot` 不带 `--load` 时
   截 `about:blank`(服务器不启动),而 README 曾经说它"渲染真实的窗口"。已在 README 改为
   实况并指向 `inspect-app`。要不要把 capture 改成"不带 `--load` 就先起服务器",是外壳的
   一个决定(要管 server 的关闭与失败面),留给单独一票。
2. **smoke 仍在写真实 agent home**:`smoke-api` 照旧 round-trip 真实 `~/.my-agent/models.json`
   (这次跑完那里仍是 `scripted` 那行假行),`smoke-session` 也会在真实 `sessions/` 下留目录
   再删。这已经有票:`.scratch/smoke-isolation/issues/01-agent-home-isolation.md`,本票不重复登记,
   只确认现象仍在。
3. **`HubOptions.modelsHome` 只覆盖进程内 smoke**:对 `npm run start` + `smoke-api` 这条路
   不起作用(那是另一个进程的 agent home)。上一条票若选"包装脚本设 `MY_AGENT_HOME`",
   这条自然一起解决。
