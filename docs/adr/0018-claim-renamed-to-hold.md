# 0018：`claim` 改名为 `hold`——同一个引用计数，一个说得准的名字

- 状态：**已接受**，已落地（2026-11-10——全仓机械改名，`npm run check` 绿，`smoke-sessions` / `smoke-stream` / `smoke-mux` / `smoke-approval` / `smoke-projection` / `smoke-boot` 全 PASS，零行为变化）
- 取代：[0001](0001-transport-websocket-mux.md)（部分，2026-11-10——「不要重命名 `claim`、`HostedSession`、`SessionHub`」里的 **`claim`** 一项；`HostedSession` 与 `SessionHub` 两个名字不动，`claim` 的语义、wire、以及「订阅不拿」全部原样）
- 取代者：无

## 背景

`claim` 是 ADR-0001 定下的词：一个请求对活跃会话的握持，回答"这个请求必须跑在活跃会话上"，与订阅回答的"这条连接要不要这个会话的内容"永不互相换算。机制本身没错，它一直是那张 `HostedSession` 上的一个引用计数：改变会话的请求与在飞的运行各在其长度内加一，`release` 减一，归零就触发一次回收判定。

问题在名字，三处：

1. **它暗示排他，机制不排他。** claim a task、claim a seat——日常英语里 claim 是"占为己有、别人别碰"。而这里 `holds` 可以是 2，两条请求同时持有是正常状态，谁也没被挡住。名字承诺互斥，代码给的是引用计数。
2. **它和 `release` 不成对。** `claim(id)` / `release(host)`：不是同源反义，认领的是 id、释放的是 host。`release` 反向暗示的是 hold / acquire / seize，从来不是 claim。
3. **它把"拥有"与"暂时占用"混了。** 持有者并没有得到会话，也没有改变它的归属，只是让它在这条请求期间别被回收——一个临时的、可叠加的、自动归还的引用。

0001 那句"不要重命名"的理由是**迁移期不要混入无谓改名**，不是这个名字好。迁移早已结束，而每个读代码的人仍要在脑子里翻译一次。

## 决定

1. **动词与计数一起改，语义一字不动。**
   - `SessionHub.claim(id)` → `SessionHub.hold(id)`；
   - `HostedSession.claims` → `HostedSession.holds`；
   - 私有自增 `hold(host)` → `count(host)`（原名与新的公开动词撞车；不选 `retain`，那是 ADR-0010 的订阅词汇）；
   - 控制器包装 `claiming()` → `holding()`；
   - **`release(host)` 一字不改**——它本来就是这对动词的另一半，改的只是对面那个词。
2. **叙述里的映射**：claim → hold、claims → holds、claimed → held、unclaimed → unheld、claiming → holding。`held` 在仓库里本来就指"被编排层持有"，两者同源。
3. **不属于机制的 claim 一律不动**：路由 claim 一个 URL、两行 claim 一个名字、断言（"the snapshot never claims to be retrying"）——这些是另一层意思，机械替换在它们上面是错的。
4. **文档三层分开处理**：`AGENTS.md` 术语表与 `architecture.md`（实况）就地改名；ADR 正文保留当时用词，由本条指回；`docs/notes.md` 的"不要重命名"那条就地划线并标注。

## 后果

换来的：

- **名字与机制一致。** 读 `hub.hold(id)` / `hub.release(host)` 不需要先相信一段关于"claim 在这里不是那个意思"的解释。
- **一对同源动词。** `hold` / `release`、`holds` / `held` 三处用词合流；此前 `claim` 与 `held`（会话状态那一侧）是两个词描述同一件事。
- **排他性误读消失。** `holds = 2` 不再需要一句注释来解释为什么"认领"可以被认领两次。

背上的：

- **约 280 处代码 + 90 余处文档的机械 diff**，全部是名字，没有一行行为变化——这也意味着 review 只能靠"逐行确认它只是改名"。
- **旧文档里 `claim` 仍在**：0001、0006、0008、0011、0015、0016、0017 的正文都写着 claim，`notes.md` 里还写着"不要重命名"。读那些文档的人需要这条 ADR 做桥，否则会以为代码违反了决定。
- **未来的"改名"仍要付同样的账**：这条没有建立任何别名或兼容层（`claim` 不保留转发），所以也没有第二次机会悄悄改回来。

## 不可逆性与代价

- **难逆转。** 改回去要再扫一遍全仓与全部 ADR，而且第二次改名会让两份历史文档都指向一个不存在的词。
- **没有上下文会让人困惑。** 0001 的决定表里写着"`claim` 保留原义"，0011 的六条驱逐判据里有一条直接叫 `claims === 0`——两处都还是旧词，且都不会自己更新。
- **是真实取舍。** 放弃的是一个已经被 wire 文档、七份 ADR 与全部 smoke 用熟的词，换来的是一个说得准的词。不改也能活，代价是每次阅读都要翻译一次；改的代价是一次横跨全仓的机械 diff 加一条 ADR。这次选了后者。

## 被取代的是什么

- **0001 的"不要重命名 `claim`、`HostedSession`、`SessionHub`"里的 `claim` 一项。** 只这一项。`HostedSession` 与 `SessionHub` 不动——本条只改"握持"这个动作与它的计数，不改持有者与容器的名字。

## 没有被取代的

- **`claim` 的语义**（0001）：一个请求必须跑在活跃会话上；读 transcript 不拿、**订阅也不拿**；订阅表与 hold 永不互相换算。归零触发一次全量重查的回收判定，边沿试、全量查，原样。
- **wire。** 没有任何帧、字段或状态码提到这个词，客户端不认识它——`OpenAgentOptions`、mux 帧、REST 形状全部不变。
- **0001 的其余全部。** 常驻 WebSocket mux、有界写侧、命令留 REST、`cancel` 只取消订阅不中止运行、订阅从快照恢复而不从游标恢复。
- **`retain`。** web 客户端与 ADR-0010 的 `retain` 是订阅侧的导航动词，与本条的 `hold` 无关；这也是私有自增方法没有叫 `retain` 的原因。
