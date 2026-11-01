# 04:SettingsManager 同形状——删每工作区私有袋,方法首参收 SettingsState

Type: task
Status: resolved
Blocked by: 01

## Question

`packages/core/src/settings-manager.ts`:与 02 票同形状——

- 删私有状态字段;每个方法改首参收 `SettingsState`(转发既有的文件级函数族);
  类保留,可构造注入。
- 类内部按**工作区**键控的缓存(前作票 09 的形态:hubs 缓存共享引用)收编进
  Manager 自身,失效时机(设置文件被写回、工作区关闭)一并定。
- 调用方迁移:core / server 里持有 SettingsManager 实例读值的调用点,改为
  「现取 SettingsState + 首参传袋」;`Agent.settingsManager` 属性本票不动(06 票拆)。
- 合并语义不变:变更写回**已经提供该字段**的那一份(全局 vs 工作区)。

完成后 `npm run check` + 相关 smoke(settings / modes)。

## Answer

与 02 票同形状落地,14 个文件。

- **首参收袋**:类里每个方法改 `(s: SettingsState, …)` 一行转发到同名文件级函数;
  `private s`、私有构造器与三个静态工厂(`create`/`fromStorage`/`inMemory`)删除——
  它们的全部职责就是围着私有袋转,袋没了壳也没有存在方式;三扇门各自直达
  `fillSettings`/`settingsStateFromStorage`/`inMemorySettingsState`(均为既有导出)。
  类保留为无状态服务,`new SettingsManager()` 公开构造、零参(ADR-0007 §2)。转发
  方法在迁移后暂无调用者——这是票面形状本身(「每个方法改首参收袋、类保留」),
  Middle Man 的观感由 06 票拆 `Agent.settingsManager` 时一并裁决。
- **缓存收编**:hub 的 `settingsManagers` Map 删除,缓存进了 Manager 内部的
  `states` Map,`stateOf(absWorkspaceRoot, agentDir?)` fill-at-open、复用同一引用。
  键是**家 + 根**的复合,不只是根:两个文件都按一个 agent home 查找,同一进程服务
  两个家时不得拿一个家的合并答另一个家的工作区。**失效时机(票面要求在此定)**:
  写回**不失效**——`applySettings` 原地改缓存袋,`persist` 写前重读所触文件,手改
  随写折入、不回退,每次写后袋与文件相等;工作区关闭**无失效可做**——本进程没有
  关闭工作区的命令(「删除」是存下来的 `hiddenWorkspaces` 事实,不是收摊),条目活
  到进程结束,与前作 hub 的 Map 相同;宿主若真有了收摊,删条目落在那里。手改一个
  本进程永不写的字段,重启前不可见——与缓存住在 hub 时同价,共享视图的代价。
- **调用方迁移**:Agent 保持 `settingsManager` 属性(票 06 拆),新增 `settingsState`
  袋并公开,内部全部调用改显式传袋;`AgentConfig` 收 `settingsState`(必填),
  `OpenAgentOptions` 收可选的 `settingsState`(`settingsManager` 保持可选,缺省一套
  一服务;assemble 里解析一次,缺省袋走服务的 `stateOf` 缓存);tool-config 三函数
  (`defaultToolNames`/`globalDefaultToolState`/`followsGlobalOf`)签名改收袋;hub 的
  `settingsFor` 改 `settingsStateOf` 返回袋,`agentOptions` 同时交出自己的服务实例
  与袋;controllers/sessions 的 `settingsOf`/`listing` 与五个端点改传袋;子代理改
  `inMemorySettingsState`。`s` 命名随文件级函数族既有风格,未另起名。
- **合并语义不变**:`persist`/`scopeOf`/`mergeLayers` 一行未动——字段落在**已经
  提供它**的那一份,冒烟逐条复验(项目文件拥有 approval、无名新字段落全局、手改
  不被下一次写回退)。
- **smoke-settings 的形状更新**:第 1–4 段迁到传袋;第 5 段的「门面旧实例握着自己
  的快照」检查随私有袋消失,换成新形状的三条:同键 `stateOf` 复用同一引用、写穿
  缓存服务的袋跟得上、另一个 agent home 是另一只袋。

**验证**:`npm run check` 绿;smoke 全套 26 个跑绿——settings / sessions / session /
tools / models / modes / mux / mux-live / mux-client / frame / backpressure /
projection / stream / branch / replay / transcript / liveness / sidebar / model-form /
default-model / boot / desktop-close / desktop-observability / approval×3,以及
smoke-api 对临时 server(端口 5188、scratch agent home)跑绿后收摊。

**code-review 记录**:两轴评审,三处已修(hunk 内两处 mojibake 的 em dash 还原、
restoreWorkspace 文档块丢的 tab、`OpenAgentOptions.settingsManager` 补一句「非默认
home 必须连袋一起交」的文档——`assemble` 缺省袋走默认 home,是给下一个宿主的陷阱,
现无调用者踩到)。两个判断题按票面保留:转发方法零调用者(票面形状,06 裁决)、
`Agent.settingsState` 公开袋(与 02 票 `sessionState` 同形,「属性不动」指不删
`settingsManager` 而非不添袋)。评审另指出「工作区关闭失效只有决定没有机制」——
这是决定本身:今天没有可挂机制的调用点,不预造无人调用的 `forget`。
