# Map：会话存储两文件拆分——JSONL 只留不可变 entry

Status: working

## Destination

一个会话两个文件：`<id>.json`（**会话是什么**：header 字段、title、model、thinkingLevel、activeTools、approval 的当前值，原子重写的快照）+ `<id>.jsonl`（**会话说了什么**：纯不可变 entry 流，只留 `message`、`compaction`、`clear_tool_result`、`trim_tool_call_arg`、`leaf`、`usage` 六种 kind）。版本升 5，旧文件删除不迁移。终点 = core / server / web 全部读写点落地，fork 与 listing 按两文件运作，文档（新 ADR、ADR-0002 superseded 注记、`docs/architecture.md`、`AGENTS.md`）与实况一致，`npm run check` 与相关 smoke 全绿。

## Notes

**2026-11-03 用户拍板的六条决定**（charting 当面定，其余票不再重开）：

1. **目的地 = 落地**：本图把执行扛上（override planning-only），task 票即落地票。
2. **Header 进 JSON**：JSONL 变纯 entry 流，`SessionHeader` 不再是文件第一行。
3. **三种未点名 kind**：`thinking_level_change`、`tool_config` 进 JSON、只存**当前值**（last-wins 历史消失，无信息损失）；`tool_result_view` 彻底删除（本构建已不写，连同 `applyToolResultViews` 重放逻辑一起）。
4. **JSON 形态**：与 JSONL 同目录同名不同扩展名（`<id>.json` + `<id>.jsonl`）；每次变更**整体原子重写**（temp + rename），不走 append——它是快照不是日志。
5. **版本 5，旧文件直接删**：`CURRENT_SESSION_VERSION = 5`；遇到 v≤4 的会话文件**删除**，不迁移不保留（用户原话「老的直接删了就行」——比既有「拒开」政策更进一步）。
6. **fork 与 listing**：fork 原样复制两个文件（`parentSession` 仍指源文件路径）；listing 元数据从 JSON 读，消息统计才碰 JSONL。

**动手前必读**：`docs/architecture.md` 会话一节；`docs/adr/0002`（rename 的文件序语义，本图将其取代）；`research/touchpoints.md`（票 01 的触点清单，票 02–05 的划分依据）。

**惯例**：文档中文、源码注释英文；编辑源码用编辑器工具、绝不走 shell 文本往返；改完 `npm run check` + 对应 smoke。

**ADR 纪律**：新磁盘格式值得一份新 ADR（难回退、无上下文会奇怪、真实取舍——三条全中）；ADR-0002 加 superseded 注记。

## Decisions so far

- [全仓 entry kind 触点清单](issues/01-touchpoints.md): 五种留 JSONL、四种迁 JSON、tool_result_view 消失、header 进 JSON；触点集中在 core 的 session-manager/agent，web 零文件触点，注意 usage 无写点与 branch 语义变化（清单：research/touchpoints.md）
- [SessionManager 两文件重写](issues/02-session-manager.md): `SessionMeta` v5 schema + temp/rename 原子重写；JSON 诞生 = 首条消息 gate 时两文件同写（`.json` 是 commit marker）；版本判定落 `.json`；v≤4/配对残缺在扫描与 fillSession 两处即删；类型缩到六种、四个迁值方法 setTitle/setModel/setThinkingLevel/setToolConfig；dangling 与审批恢复确认成立无新票；branch 不再切换选择（applyBranchSelection/emitBranchToolConfig 删）；票 03 的时机/失败/gate 三问已拍板
- [写侧改造：agent 与 JSON 快照写点](issues/03-writers.md): 核对收账——recordSelection/rename/tool_config 三类写点全走 recordMeta 快照重写，append 路径六种 kind 原样；三问按票 02 拍板确认（即时写 / 失败抛调用方 / gate 不变）；零代码改动，只清了 server 侧五处「rename append 一条 entry」的滞留注释
- [server 连带：listing、fork、删除与 protocol](issues/04-server-fork-listing.md): 核对收账——listing 拆两半（settleSessionFiles 配对 + buildSessionInfo 身份从 meta、统计从 JSONL）、fork 复制两文件且 parentSession 指源 `.jsonl`、remove 删两文件、tools/approvals 路由走 setToolConfig 快照且 config_changed 照发；全部已在票 02/03 落地，本票零代码改动，`npm run check` + 相关 smoke（含起服 smoke-api）全绿
- [web 连带清点与修复](issues/05-web.md): 核对收账——四文件（transcript/sidebar/state/main）逐一核对确认 web 渲染与 state 分支零代码改动（与票 01 第 8 条校准一致），只改四处说旧话的注释（main.ts 三处 + settings.ts 一处，`tool_config` entry 措辞改为 `.json` snapshot/recorded choice）；`npm run check` + 窗口面 smoke（transcript/sidebar/frame/replay）+ 会话系 smoke + 起服 smoke-api 全绿，窗口行为无回归

## Not yet specified

- ~~**旧文件删除的触发点**与**配对残缺**怎么算~~——已钉死（票 02）：触发点 = store 扫描（`settleSessionFiles`）+ 打开（`fillSession`）两处；配对以 stem 为单位、`.json` 为权威，缺一边 / 版本不对 / 流空 = 删两边。
- ~~**`dangling.ts` 与审批恢复机器**的连带面~~——已核对（票 02）：二者只消费 `buildContextEntries` 的 message entries，两文件合并读下路径等价，成立，无需新票。
- **web 侧受影响的精确清单**——票 01 清单已校准：web 对文件形态零触点，只消费 SessionSnapshot 与事件帧；受影响面仅 snapshot.createdAt/parentSession 的数据源换到 `.json`（wire 字段不变，web 代码零改动），加上 branch 不再切换 tool_config/thinkingLevel/model 后 config_changed 触发频率的语义变化（state.ts:718-719 应用逻辑本身不动）。票 05 的实际工作量主要是 smoke fixture 与文档，不是渲染代码。

## Out of scope

- 任何向后兼容 / 迁移 / 旧文件保留——用户拍板：不考虑兼容，全用最新版。
- 会话格式的其他演进（压缩策略调整、跨进程并发写、加密等）——不在本图。
- `packages/llm` 传输层；插件 / MCP 机制。
