# 文档索引

本目录是本仓库的文档入口。**除 `docs/agents/` 外，文档正文用中文；代码标识符、路径、命令、API 名与线上协议一律保持英文。**

## 我会先读哪一份

| 你的目的 | 读这份 |
|---|---|
| 改代码前搞清楚子系统怎么设计的 | [architecture.md](architecture.md) |
| 搞清楚装什么、怎么启动、怎么配 key | [`../README.md`](../README.md) |
| 知道哪些决定不得重开、哪些已经被重开过、踩过哪些坑 | [notes.md](notes.md) |
| 知道某个决定**为什么**是现在这样、以及它被改过没有 | [adr/](adr/) |
| 让工程类 skill（triage / to-tickets / code-review）知道本仓库的约定 | [agents/](agents/) |

## 文档清单

### [architecture.md](architecture.md) — 设计参考

本仓库唯一的设计参考：请求流程、wire、以及每个选择背后的理由。**改哪个子系统，就读它对应的章节。** 含 20 个章节，从各 package 的职责划分一直到"与原计划偏离之处"和"未构建的东西"。

### [notes.md](notes.md) — 实施记录与遗留问题

从三份已删除的 handoff 文档中救出的内容，分七节：

1. **重开过的，与不得重开的决定** —— 传输形态、不做游标、`claim` 的语义，以及 D0–D3 四个已拍板的决定；其中被 2026-10-12 那次重开推翻的条目**当场划掉并标注**，理由在对应的 ADR 或它引的票里
2. **验证过的陷阱**（8 条）—— 带行号的行为事实，每条都能省下一次调试
3. **已解决** —— 会话无持有者时发生的分支移动（leaf 落盘为一条状态 entry）
4. **技术债** —— `packages/core/src/agent.ts` 是忠实重建，不是原文
5. **实施阶段查出的三个 bug**
6. **被否决方案为什么输了**（与 DSH 的对比）
7. 一处刻意留下的客户端不一致

修改 `claim`、传输（mux 订阅与连接层）、分支、或审批相关代码之前，**先读这份**。

### [adr/](adr/) — 决定记录

一条 ADR 只回答一个问题：**这个决定为什么是现在这样，以及它被改过没有。** 正文的实况在 [architecture.md](architecture.md)，结论清单在 [notes.md](notes.md)，术语在 [`../AGENTS.md`](../AGENTS.md) 的 `## 术语`——三处都不重复理由。门槛、编号规则与写法见 [adr/README.md](adr/README.md)。

- [0001-transport-websocket-mux.md](adr/0001-transport-websocket-mux.md) — 传输从"每会话一条 SSE"改为"每标签页一条常驻 WebSocket mux"（取代 `notes.md` 第一节的若干条）

### [agents/](agents/) — 工程 skill 的仓库配置

由 `/setup-matt-pocock-skills` 生成，供 triage、to-tickets、to-spec、code-review、domain-modeling 等 skill 读取。**这部分是英文**，因为它是写给 skill 执行的机器可读配置，不是给人读的正文。

- [agents/issue-tracker.md](agents/issue-tracker.md) — issue 与 spec 以本地 markdown 形式存放于 `.scratch/<feature>/`，含 `/wayfinder` 的 map / claim / resolve 规则
- [agents/triage-labels.md](agents/triage-labels.md) — 五个规范分诊角色到实际标签字符串的映射（当前是恒等映射）
- [agents/domain.md](agents/domain.md) — 领域文档的使用规则；本仓库是**单上下文**（根目录一份 `CONTEXT.md` + `docs/adr/`）

## 还没有的文件

`CONTEXT.md` 与 `CONTEXT-MAP.md` 目前都不存在，这是预期状态：两者与 ADR 一样，由 `/domain-modeling` skill **按需惰性创建**——等术语或决定真正被敲定时才写，不提前铺空架子。术语的索引在 [`../AGENTS.md`](../AGENTS.md) 的 `## 术语` 章节（每条一句话），定义与理由在 [architecture.md](architecture.md) 和 [`../README.md`](../README.md) 里。

这条规则已经兑现过一次：`docs/adr/` 由 2026-10-12 的第一条 ADR 惰性创建。`CONTEXT.md` 仍空着，因为术语至今没有出现一份术语表才能解决的歧义。

## 仓库目录里不属于本仓库的东西

`deepseek-harness-master/`、`pi-main/`、`deepseek-harness-java-main/` 等是**第三方参考树**，用于对照实现，不是本项目的文档。本索引不覆盖它们。
