# 04 - docs：no-gap「两半保证」写进 architecture.md，文档与新公开面对齐

Type: task
Status: done
Blocked-by: 02, 03

## 背景与指针

- Spec：`Z:/my-coding-agent/.scratch/hub-subscribe-baseline/spec.md`（User Stories 15 + Further Notes）。
- 终态代码：`packages/server/src/hub.ts`（subscribe 契约与 hub 半论证，票 01）、`packages/server/src/mux.ts`（mux 半论证，票 03）、`scripts/smoke-subscribe.ts`（票 02）。
- ADR 门槛：`docs/adr/README.md` 的三条门槛。spec 倾向：**不写新 ADR**（公开面变化可逆、取舍已在 spec 记录），更新 architecture.md 对应章节 + 必要时 `docs/notes.md`。

**本票只动 `docs/`（及 AGENTS.md 需要对齐的行）。不碰 packages/ 与 scripts/。**

## 改动

### 1. `docs/architecture.md` 的 no-gap 段落

找到讲 open 帧 / baseline / no-gap 的段落（「谁拥有一个会话」节讲 `SessionHub.watch` 的两段、mux 相关小节、以及任何提到「watch 之后必须在同一同步块内写 baseline」或「约定」的地方），按两半保证重写：

- hub 半（机制）：`subscribe` 在 hub 内部一体完成注册 + 活冷分岔 + baseline 交付；活半同步交付、冷半异步恰好一次；「想违反都没有违反的写法」。
- mux 半（帧序）：baseline 帧先于 backlog 中任何帧写出，JS 单线程下由同步写成立。
- 缝：hub 交付结果，mux 决定帧序；冷读取期间的扣帧（backlog）是单条流上的帧秩序、留 mux（分层判据：离开 HTTP/WS 还成立的问题归 hub）。
- 读盘归 hub、错误归因措辞留 mux。

### 2. `docs/adr/README.md` 门槛自查（记录判断过程，倾向不写 ADR）

对照三条门槛自查并留下结论（若判断为不写新 ADR，在 `docs/notes.md` 补一段为什么本次够不上——公开面变化可逆、取舍在 spec——以及 ADR-0013 延伸关系的一句话）。

### 3. `AGENTS.md` 对齐

术语索引里凡指名 `watch` / `snapshotNow` /「mux 的约定」的行（如 fanout 条目的 `snapshotOf` / `snapshot`、transport 条目），按新公开面改字——subscribe 是 hub 公开面新成员、watch 已退场。只改指名处，不重写条目。

### 4. 一致性

- grep 全文档确认没有残留「watch 之后同一同步块」「mux 的 no-gap 约定」旧表述。
- 文档里的代码形状（方法名、契约描述）与终态代码逐一对得上。
