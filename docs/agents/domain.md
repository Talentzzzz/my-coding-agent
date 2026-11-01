# 领域文档

工程类 skill 在探索本仓库代码库时，应当如何消费本仓库的领域文档。

## 探索之前，先读这些

- 仓库根目录的 **`CONTEXT.md`**；或者
- 仓库根目录的 **`CONTEXT-MAP.md`**（如果存在）：它指向每个上下文各自的 `CONTEXT.md`。把与当前主题相关的每一份都读掉。
- **`docs/adr/`**：读那些触及你即将动手的领域的 ADR。在多上下文仓库里，还要检查 `src/<context>/docs/adr/` 里的上下文级决定。
- **`docs/architecture.md`**：本仓库的设计参考——请求流程、wire、以及每个选择背后的理由。改哪个子系统，就读它对应的章节。

如果其中任何文件不存在，**静默继续**。不要指出它们缺失，也不要主动建议创建它们。`/domain-modeling` skill（经由 `/grill-with-docs` 和 `/improve-codebase-architecture` 触达）会在术语或决定**真正**被敲定时惰性创建它们。

## 文件结构

本仓库是**单上下文**：

```
/
├── CONTEXT.md
├── docs/
│   ├── adr/
│   │   ├── 0001-event-sourced-orders.md
│   │   └── 0002-postgres-for-write-model.md
│   └── architecture.md
└── packages/
    ├── ai/
    ├── agent/
    ├── core/
    ├── server/
    ├── desktop/
    └── web/
```

这六个 package 是**一个产品**，不是六个上下文：根目录的 `CONTEXT.md` 覆盖它们全部。

多上下文仓库则会在根目录带一个 `CONTEXT-MAP.md`、每个上下文一份 `CONTEXT.md`，并且除了 `docs/adr/` 放系统级决定之外，还有 `<context>/docs/adr/` 放该上下文特有的决定。本仓库没有这样的 map，也不应该在没有明确决定要拆分之前长出这么一个。

## 使用术语表里的词汇

当你的产出命名一个领域概念时（issue 标题、重构提案、假设、测试名），就按 `CONTEXT.md` 里定义的那个词来用。不要漂移到术语表明确避开的同义词上。

如果你需要的概念还不在术语表里，那是一个信号：要么你在发明项目不使用的语言（重新考虑），要么这是一个真实的空缺（记下来交给 `/domain-modeling`）。

本仓库当前的术语索引是 `AGENTS.md` 的 `## 术语` 章节——**service**、**tool**、**session**、**settings**、**model**、**thinking level**、**model selection**、**transport**、**claim**、**approval**、**tool set**、**mode**、**fork**、**branch**、**compaction**、**hook**、**retry**、**subagent**、**queue**、**assembly**、**OpenSessions**、**workspace**、**event**——每个词在那一节有一句话，定义与理由在 `docs/architecture.md` 和 `README.md` 里。在 `CONTEXT.md` 取代它们之前，把那些当作术语表。

## 标出 ADR 冲突

如果你的产出与某条已有 ADR 矛盾，明确把它摆出来，而不是静默覆盖：

> _与 ADR-0007（event-sourced orders）矛盾，但值得重开，因为……_

本仓库从 2026-10-12 起有 ADR（`docs/adr/`，到 2026-11-01 为止七条；清单与门槛见 [`docs/adr/README.md`](../adr/README.md)）。所以这条规则有两半：与某条 ADR 矛盾时**引用它的编号**摆出来；与 `docs/architecture.md` 里写下的某个设计决定矛盾、而那个决定还没有 ADR 时，同样明确说出来，而不是悄悄改掉它。

**ADR 的门槛**：不是每个结论都够格写一条 ADR——"难以逆转 + 没有上下文会让人困惑 + 是一次真实取舍的结果"三条要同时成立，不够格的写进 `docs/notes.md`。三条各自的含义、编号规则与写法只有一处：`docs/adr/README.md`。
