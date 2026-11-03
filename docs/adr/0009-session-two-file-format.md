# 0009：会话是两个文件——`.json` 快照管「是什么」，`.jsonl` 日志管「说过什么」

- 状态：**已接受**（[session-split 02 号](../../.scratch/session-split/issues/02-session-manager.md)拍板并落地，[06 号](../../.scratch/session-split/issues/06-docs-adr.md)入档）
- 取代或失效：取代 v≤4 的单文件格式（header 是第一行的 JSONL）；取代 [ADR-0002](0002-session-rename-entry.md) 的「rename 是一条 entry」存储机制——「标题可写」这个决定本身保留，只是存储位置变了
- 取代者：尚无。这份 ADR 本身若被推翻，**不要**悄悄改它——新开一条 ADR，并说明反转的代价

## 为什么会有这份 ADR

v4 及以前，一个会话就是**一个** JSONL 文件：第一行 header（`{type, version, id, timestamp, workDir, parentSession}`）是身份，之后每一行是一条 entry。这个形状有一处含糊：**当前值和历史用同一种机制存**。标题、模型选择、thinking level、工具与审批配置全是「状态 entry」——追加一条记录、读取方按文件序取最后一条赢。这能工作，但读一次当前配置要重放整个文件；而且同类问题被两种机制回答——身份五字段住在 header 行里，标题这种同样「当前值」的事实却住在一条要重放的 entry 里。header 是只写一次的身份，entry 是只追加的历史，「当前值」在这两者之间没有自己的位置。

session-split 的 01 号票把全仓 entry kind 触点列完之后，02 号拍板把这两类数据分家。

## 决定

**一个会话是一对共享 stem 的文件：`<id>.json` 与 `<id>.jsonl`。**

### 1. 分界标准：变更是「覆盖」还是「追加」

- **`.json` 是快照**（`SessionMeta`），存会话**是什么**：五个身份字段（`version`、`id`、`timestamp`、`workDir`、`parentSession`）加五个当前值（`title`、`model`、`thinkingLevel`、`activeTools`、`approval`）。判据是变更的语义：这些值都是**覆盖**语义——新值取代旧值，旧值没有读者；「文件序最后一条赢」的重放只是为了把当前值读出来，是在为一种不存在的读者付账。缺席的字段意味着「从未选择」，这是区分「选了 off」和「没选过」的东西。
- **`.jsonl` 是日志**，存**说过什么**：不可变的 entry 流，只剩六种 kind——`message`、`compaction`、`clear_tool_result`、`trim_tool_call_arg`、`leaf`、`usage`。判据同上：这些是**追加**语义的事实——对话本身、压缩检查点、命名了视图改写的记录、leaf 去了哪、账目——每一种都改「之前写了的东西现在意味着什么」而不是取代它，文件永远保留全文。

配置类的**历史**由此有意消失：`rename`、`model_change`、`thinking_level_change`、`tool_config` 四种状态 entry 删除，快照只留当前值。那四段历史从来无人读——这是删除的理由，不是代价。

### 2. 快照整体原子重写

快照是快照不是日志，一次变更一次整写：同目录 temp 文件 + `renameSync` 覆盖，读者要么看到旧快照要么看到新快照，永不撕裂。写侧四个方法（`setTitle` / `setModel` / `setThinkingLevel` / `setToolConfig`）先改内存 meta，文件在手则当场重写，值没变不重写。

### 3. 「没说过话的会话不落盘」纪律不变，`.json` 是 commit marker

首条 user/assistant 消息时**两份文件同时出生**：先 `.jsonl`（`wx` 全量写），后 `.json` 快照。快照**最后**写，所以 `.json` 的存在就是「会话存在」的标志——出生半途而废只会留下一个单边文件，由扫描清掉。此前的 meta 变更只留内存，随出生一起写出。

### 4. 没有迁移：打不开的配对直接删

配对按 stem 进行（`settleSessionFiles`），`.json` 是权威侧。只有一半、版本不是本构建的、`.jsonl` 空而 `.json` 在——一律**删两边**（`pruneSessionFiles`），触发点是 store 扫描与 `fillSession`。v≤4 的单文件就是「版本不是本构建的」的一种，同样下场。

## 为什么旧文件直接删

这个决定单独一节，因为它是这份 ADR 里最容易被读成「丢了用户数据」的一条，而它是有意的：

1. **格式由本构建拥有。** 没有第二个读者，没有别的工具承诺能打开这些文件——不存在「留着一个 v4 文件等哪个程序来收养」的选项。
2. **收养等于把已删的代码加回来。** v≤4 的读法依赖 header 行重放与 `LEGACY_ENTRY_KINDS` 归一化那一组代码，随两文件重写一并删除了；读旧文件的前提是把删掉的东西重新写一遍、并从此养着第二套格式。
3. **保留的唯一效果是给每次扫描上税。** 一个永远打不开的会话躺在 store 里，让每一次 listing、每一次 `findMostRecentSession` 都为它付费。store 是会话的清单，不是坟场。
4. **丢失的代价是有限的、且被承认的。** 会话是可丢弃的对话历史，不是用户的源代码；删掉一段打不开的旧对话，代价是「那段对话没了」，而这是诚实的回答——比起静默拒绝、让它在每次启动时制造一个错误要清楚。

## 被取代的是什么

| 原事实 | 本次 |
|---|---|
| v≤4：一个会话是一个 JSONL，header 是第一行 | **取代**。身份与当前值进 `.json` 快照，entry 流进 `.jsonl`，`CURRENT_SESSION_VERSION = 5`。 |
| [ADR-0002](0002-session-rename-entry.md)：标题是一条 `rename` entry，文件序最后一条赢 | **机制被取代**：标题是快照里的 `title` 字段，最后一次写入就是值，不再有重放。**决定本身保留**：标题可写、派生只作兜底、`（N）` 后缀仍是派生事实。 |
| `model_change` / `thinking_level_change` / `tool_config` 状态 entry | **取代**。快照的 `model`、`thinkingLevel`、`activeTools`、`approval` 四个字段；配置历史不复存在。 |
| 「未知 entry kind 原样带过」的文件内前向兼容 | **保留**，但范围缩小到 `.jsonl` 内部；**跨版本**兼容改为「整对删除」。`prune` / `argtrim` 的归一化层随 v≤4 文件一起消失。 |
| 「这种格式从不重写一行」 | **对 `.jsonl` 保留**；快照是那个有意的例外——它每次变更都整写。 |

## 没有被取代的

- 追加式日志本身、entry 的父链接与树、`leaf` entry 的形状、压缩的「视图改写」形状（clear / trim / 检查点）、`usage` 的按文件记账——全在 `.jsonl` 里原样活着。
- [ADR-0006](0006-stateless-session-architecture.md) 的骨架：`fillSession` 是磁盘到状态的唯一入口、host 在手时是文件的唯一写者、「没人说过话的会话不落盘」的延迟创建纪律。
- [ADR-0005](0005-modes-are-a-tool-config-choice.md)：施加一个模式仍是 `PUT /tools` 与审批 `PATCH` 两个既有命令的组合——只是落点从 entry 变成了快照字段。

## 代价与后果

- **快照是第二份事实**，必须与日志一致。一致性靠出生顺序（先日志后快照）+ commit marker 语义 + 「残缺即删」来保证**可判定**，而不是靠同步逻辑。
- **配置变更史没了**（有意为之，见决定 1）。
- **读取分了价位**：身份、标题、时间戳从快照来，listing 不必打开 JSONL；消息统计才开日志。侧边栏因此便宜了。
- `version` 判定落在 `.json`——`.jsonl` 不再自带版本号，它单独不构成一个会话。
- fork 现在写**一对**文件：日志复制分支 entries，快照带新 id 与随拷的五个当前值；`parentSession` 语义不变，仍指源 `.jsonl` 路径。
- 改回来要动 `SessionManager` 读写两侧、listing、fork、删除与全部 session smoke——不止一处，这是不可逆性的量度。
