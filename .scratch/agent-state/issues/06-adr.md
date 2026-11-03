# 06：ADR——Agent 持有会话状态

Type: task
Status: resolved
Blocked by: 01, 02, 03, 04, 05

## Question

写 `docs/adr/0011-agent-holds-session-state.md`，并把被它推翻的文字改对。

ADR 要记的（按 01–05 的答案落笔）：

- **决定**：会话状态从 hub 的登记处搬进 `Agent` 的一张 `Map<id, AgentState>`；`Agent` 仍是进程唯一单例，
  仍是编排层，只是多一个 Map 属性；`SessionManager` / `SettingsManager` 不再持有任何缓存。
- **代价**：`jsonlEntries` 常驻内存（原本每请求重放）；同目录两个活会话各有一份设置快照；驱逐会丢队列。
- **被放弃的选项**：保持无状态 + 每请求重放（ADR-0006 B 路线）；表留在 hub、Agent 只借读。
- **不做的事**：不是把 `Agent` 变成 per-session 实例（ADR-0006 的 A 路线仍然否掉）。

要改的文字：

- `docs/adr/0007-services-drop-instance-state.md` §4 / §6：「登记处只装磁盘上没有的东西」「Agent 不持有会话
  状态」两句标 Superseded，指到 0011；§3 关于 `SessionManager` state 的表述同时失效。
- `AGENTS.md` `## 术语`：**service**（无属性服务）为 Agent 破例并写清破例范围；**OpenSessions** 整条换成
  **AgentState**；**assembly**（种子→补齐）改写为「打开即建、切走即清」；**claim** 条目补一句驱逐不拿 claim。
- `docs/architecture.md`：:19（core 段）、:21（server 段）、:67（Agent 段）、:259（hub 段）、:266 的图，五处。
- `docs/adr/README.md` 清单行；`README.md` 若提到登记处。
- 0011 自己的状态行：落地前写「尚未落地」，14 号票完成后翻转。

## Answer

### 落了什么

- **`docs/adr/0011-agent-holds-session-state.md`** 已写，按 01–05 的答案落笔：调子按地图 Notes——
  「登记处从 hub 搬进 Agent」，不是「Agent 变成会话」。决定八条：一张表四层合一（`AgentState` 形状归 07
  落地）、`adopt` 唯一门且先到先得（不注入 `sessions?: Map`）、装配点唯一留在工厂（`assembleSession`）、
  表装「丢了就没了的那一份」（重写 0007 §4 判据；建 id 即入表、`hosts ⊆ 表`、活会话永不走冷路、
  `open(id)` 冷读一段同步块、fork 不 fill 不入表）、两个 Manager 缓存清零且 `stateOf` 换源不是改名、
  删除权随表（六条判据、边沿试全量查、`evict`/`drop` 两动词、`clear()` 取消）、设置是打开时读到的一份
  快照、宽限与 reap deny 删。代价六笔照实记（含「审批可悬空到进程重启」与 `jsonlEntries` 常驻）；被放弃
  六条（B 路线、表留 hub、注入表、cancel 即删、目录扇出、A 路线）。
- **`docs/adr/0007`**：头行加「取代者：0011（部分）」；决定 3（Manager 键控缓存）与决定 4（活登记处
  归属与判据）原文保留、就地追加 Superseded 标记指到 0011——按 ADR README「不改原文」的编号规则。
- **`docs/adr/README.md`**：清单加 0011 行，状态「已接受（拍板）；尚未落地」。

### 票面「要改的文字」的改口：AGENTS.md / architecture.md / README.md 归 14

票面列了这几处，但 01 §8、03 §7、05 §3 三张答案一致把它们改派给 14 号票，理由是 05 写明的那条：
**文档不跑在代码前面**。「Agent 不持有会话状态」「只装进行中且磁盘上没有」「两个会话读到同一个对象」
这些句子描述的是**今天的代码、今天仍然为真**——代码没动（07–13 未落地）之前把它们改掉，文档就先撒谎了。
本票只改了决策层的两处（0011 本体、0007 的标记），实况层（AGENTS.md 术语四条、architecture.md 五处、
README.md 的登记处句）随 14 号票与最终代码逐句核对落地。**0007 里没有「Agent 不持有会话状态」的原文**——
票面 §4/§6 里的第二句实际住在 architecture.md :19/:67 与 AGENTS.md :111，跟着实况层走。

### 给 14 的交接

- 0011 状态行与 README 清单行的「尚未落地」由 14 翻转。
- architecture.md 五处（:19、:21、:67、:259、:266 图）+ :233 的 `pending` 句，按 0011 §决定 4/6 与
  03 §3/§4 的形状改；AGENTS.md 四条术语（service 破例、OpenSessions→AgentState、assembly、claim 补驱逐）
  按 01/03 的措辞改；README.md 那句「两个会话读到的永远是同一个对象」按 05 的快照句改。
- 收账跑的是 `npm run check`（绿）；本票纯文档，无 smoke。
