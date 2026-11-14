# ADR-0014：store 改平——id 就是会话文件的地址

日期：2026-11-10。已落地（本次改动直接提交，未跑全量 smoke——见文末）。

## 决定

1. 会话 store 从「每工作目录一个子目录、文件名 `<ISO 时间戳>_<id>.{json,jsonl}`」改为**一个平目录**：
   `<agent home>/sessions/<id>.jsonl` 配同 stem 的 `<id>.json`。id **就是**地址，
   `sessionPath(id)` 是 id → 路径这条规则的唯一住址。
2. `SessionManager.findSessionFilePathById(id)` 因此从「递归遍历整个 store、按文件名后缀匹配」
   变成**一次存在性检查**：`.json` 快照仍是出生的 commit marker，它在，配对就在。
3. `Agent` 不再持有 `paths: Map<id, path>`，`pathOf` 整个删除：`getSessionBySessionId(id)` 现在就是一句
   `sessionManager.open(id)`。定位会话是 store 的格式知识（0006 的分界线），编排层此前复制了
   它，还替它付失效的账——`remove` 手动删表项、每次命中一次 `existsSync` 兜底、表无界增长。
4. 侧边栏的目录分组改为**从每个会话快照的 `workDir` 派生**（`listDirectories` 一遍扫描按
   `workDir` 分组），不再依赖目录名——那个把路径的分隔符换成短横的目录名本来就不可逆，
   只能读不能还原。
5. 旧布局由**惰性迁移**收编：进程内第一次触碰 store（查找或列表）时，把每个旧目录里能读出
   快照的配对改名搬进平 store（流先、快照后——两次改名之间目标只有一个孤儿流，所有读取者
   都把它读成「没有这个会话」，而不是半个会话），搬空即删目录。**什么都不删**：读不出的、
   目标 id 已被占的，原样留在原地。
6. 新增 `setSessionsDir(absDir)`：进程级的 store 根覆盖，给 smoke 与嵌入方指一块临时地盘。
   它取代了旧布局「每工作目录一个子目录」无意中提供的测试隔离——旧 smoke 靠删
   `sessionDir(root)` 清场，现在靠把 store 指到临时目录、结束时整体删掉。

## 理由

旧布局的两个事实——「哪个工作目录的目录」「哪个时间戳前缀」——都不在 id 里，所以按 id 定位
必然是一次 O(全店文件数) 的遍历；而 ADR-0013 之后会话不驻留内存，这个遍历落在**每次
操作**上。`Agent.paths` 是为它打的补丁，但补丁放错了家：它只服务 `getSessionBySessionId()` 一个调用点，却让
编排层持有了 store 的格式知识，`forkFrom` 与 `fileAbsPathOf` 各自绕开它直接问
`findSessionFilePathById`——一张没有统一任何东西的表。

代价是真实的：目录不再按项目分组、文件管理器里不再按时间排序（uuidv7 本身按创建时间递增，
损失有限）；原「目录名即项目」的可读性没有了，项目归属只活在快照里。换来的是：id → 路径
成为纯函数，按 id 定位与 store 的规模无关；编排层少一张表、一个私有方法、一处手动失效。

## 与其他 ADR 的关系

- 取代 0008 中「每个工作目录一个 store 目录」的布局条款；两个文件、stem 配对、
  `.json` 是 commit marker、打不开的配对直接删——这些全部不变。
- 0013「会话每次操作现读」不变；本条移除的是它前面那次全店遍历。
- 0006 的分界线是本条的准绳：按 id 键控、可从磁盘重建、藏在自己内部的缓存是 Manager 的
  合法形态——而「id 就是地址」让这条缓存根本不需要存在。

## 落地与验证

`npm run check` 全绿（两个 tsc、tokens、server 门面守卫——`hasSessionsFor` 经 `Agent` 门面
转发，server 不触碰 Manager）。另有一段针对新路径的验证脚本（临时 store 上跑完即删）确认：
id → 路径是一次存在性检查、未知 id 拒绝、列表按 `workDir` 过滤、`listDirectories` 按快照
分组、惰性迁移把旧布局配对搬进平 store 并搬空旧目录、fork 默认落进平 store。

smoke 套件做了**机械改写**（store 根指向临时目录、清理行改指 store 根）但未执行。
smoke-sessions 的 legacy 段改为直接向平 store 写 v4/残缺副本；smoke-tools 的文件格式段断言
改为「store 根即本进程所指」。
