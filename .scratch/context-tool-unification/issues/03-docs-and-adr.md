# 03 文档收账:AGENTS/architecture/新 ADR

Type: task
Status: resolved
Blocked by: 02

## Question

代码落地后把账记平:三处文档同步 + 一条新 ADR,让文档不再描述一个已经不存在的 llm 层。

范围(定案 7):

- 新 ADR(`docs/adr/` 下一号):记录「llm 折叠进 core + 全树单一 Context/Tool」——包边界消失
  的理由(痛点是三层 Context/llm Tool 的重复声明)、取舍(传输层**看见** execute 但不调用,
  职责边界靠约定保持)、与 ADR-0008 的关系(上游对照放弃后由本仓库维护,才有资格折叠);
- `docs/architecture.md`:请求流程、wire、涉及 `LlmContext`/`AgentContext`/`AgentTool` 的
  小节逐句核到新形状;
- `AGENTS.md`:布局节(`packages/llm` 行消失)、术语表 transport/engine 词条里的类型名;
- `README.md`:布局与验证一节(check 不再跑 llm 棒)同步;
- 文档一律中文、代码标识符与路径保持英文。

验收:`grep -rn "packages/llm\|@my-agent/llm\|LlmContext\|AgentContext\|AgentTool" docs/ README.md AGENTS.md`
仅剩 ADR 历史叙述(豁免:记录过去的 ADR 不改写历史,新 ADR 引用旧决策除外)。

## Answer

落地于本笔(前置:票 01 的 045140a、票 02 的 b2f1a70)。

- **新 ADR** `docs/adr/0015-llm-folded-into-core.md`:背景记「同一件事有两个名字,而分界画在
  『谁执行』上」(`Tool` / `AgentTool extends Tool` 两层、`LlmContext` / `AgentContext` 差在同一个
  `tools` 字段的元素类型、`AgentToolCall` 重写了一遍 `Extract<…>`、结果那一族另起了一套名字)与
  「包边界只买到一个独立编译设置」;决定七条(目录折叠并撤 workspace/tsconfig/别名/check/install-deps、
  `Tool` 合一、`Context` 合一且 `tools` 必填、撞名前缀清零、`@my-agent/llm` 清零、`@ts-nocheck` 保留、
  传输层**看见** `execute` 但不调用);后果分两栏——换来的一次请求一个 `Context`/一个概念一个类型/
  依赖图少一层,背上的三项代价(职责边界只剩约定、类型检查屏障从「另一个包」换成「逐文件 nocheck」、
  `toToolDeclaration` 的标注不再诚实);不可逆性与代价三条门槛逐条成立。**与 0008 的关系**写在
  *被取代的是什么*:上游对照放弃是因、折叠是果——只有副本不必再与上游逐文件同形,它才有资格住进
  我们的目录;具体取代决定 6 里的两处(`AgentContext` 命名、「工具与上下文形状住 `types.ts`」那一半),
  决定 6 的另一半(引擎契约仍住 `types.ts`、wire 不进那里)明确留着。
  `docs/adr/README.md` 清单补一行;0008 头部加「取代者」前向指针(按编号规则只加指针、不改原文)。
- **architecture.md 逐句核**:ASCII 图去掉 llm 一跳(传输层并进 core 那句)、各 package 职责的 core
  段落(重写为 ADR-0014 的形状 + 「`llm/` 是 core 的一个目录而不是一个包」)、依赖段(core 只有
  `@anthropic-ai/sdk`/`partial-json`/`typebox`;护栏说明改为「nocheck 是唯一屏障」)、ai 子集段
  (`llm/models.ts`)、目录布局(core 行加 `llm/`;`setting-manager.ts` 更正)、package 表
  (认证/流式/wire 归「core(`llm/`)」并指向工具契约,不在此复述)、请求流程(第 4 步改 `Model.stream`,
  流程图加一行 `core/llm/model.ts`)、
  工具契约(`Tool` 一个类型 + 传输层只读那一半)、重试段(`llm/utils/retry.ts`)、桌面外壳
  (客户端不 import core 的传输层)、与原计划偏离三行。
- **AGENTS.md**:导语、布局(`packages/llm` 行撤、core 行补 `llm/` 与「没有 HTTP 传输层」)、术语
  `tool`(`Tool` 一个类型装两半)、`model`(`llm/model.ts` + `stream` 收合并后的 `Context`)、
  `transport`(补一句消歧:命令面 vs 模型侧的 `ChatTransport`)、`engine`(补 `Tool.execute` 与
  带 `tools` 的 `Context`)。
- **README.md**:开头一段(裁剪副本已并进 core、不再是独立的包;引擎是 `agent.ts` 里 `Agent` 的私有
  方法,顺手修掉原文还写着 `loop-manager.ts` 对象的那句)。验证一节 `npm run check` 那行本来就没提
  llm 棒,核对后不动。另修两处陈旧事实:设置管理器文件名 `settings-manager.ts`→`setting-manager.ts`
  (ADR-0011 记过这次改名,架构目录布局同改),状态节「六个工具与那对委派工具」→「六个工具」
  (委派已在第一版删除)。
- **notes.md** 第一节的 llm 条加「2026-11-06 补:那个包本身也退场了」并指向 0015;原文按该文件
  「原文一律保留、当场标注」的规矩不动。
- **验收 grep**(`docs/ README.md AGENTS.md`):`architecture.md`、`AGENTS.md`、`README.md` **清零**。
  剩余 37 处全在 ADR 历史叙述与 0015 引用旧决策里:`0001`(3)、`0008`(12,含新加的「取代者」指针)、
  `0015`(17,本 ADR 的主题就是那个包)、`adr/README`(1,清单行)、`notes.md`(4,第一节「结论清单」)。
  notes.md 不在 ADR 之列,但 adr/README 把第一节定义为「哪些结论作废」的那份清单,与 ADR 历史叙述
  同类;按票 14 的「同一理由扩免」先例记在这里,不逐句改写。
- `npm run check` 绿(20 s,tokens 137 defined / 111 referenced)。纯文档改动,smoke 与 `build:web`
  按零行为前提不重跑,全套留给票 04;ADR 的状态行因此写「除 `smoke-api` 外的 smoke 全套绿」(票 02
  的绿基线)。
- code-review(Standards/Spec 双轴)修掉五处硬问题:①AD 「四个别名、各写一次」的说法不成立——
  `AgentTool` 是 `extends Tool<TParameters>`、结果那一族是 core 自己的定义而不是别名,背景段按
  `045140a^` 的实际形状重写(`Tool` 两层、`Context` 差在 `tools` 的元素类型);②「9 个 script」实为
  **7**(加 server 两个文件才是 9,票 01 的记数是合计数);③ `types.ts`「删掉全部定义」→ 只删撞名的
  那几个(`AgentEvent`/`AgentState` 仍在);④状态行与清单行的「smoke 全套绿」改为「除 `smoke-api`
  外」;⑤README「不是完整的 package,也不是一个单独的包」同义反复,改成一句。另按评审收尾:「只读声明、
  不调 execute」原本在 AGENTS 与 architecture 里各说三遍,按「三处不重复理由」压到工具契约一处 +
  术语表一句;notes.md 的新补注补空行独立成段;`@ts-nocheck` 那句「理由同 0008 决定 7 的反面」改成
  直说。0008 的前向指针与取代关系同步补上「类型住 `types.ts` 那一半」。评审无剩余硬违规。
- 留观(不在本票范围):25 个折叠文件的头注释仍写着「every import into packages/core stays fully
  checked」——包边界撤掉后这句不再成立,它属于源码注释(票 01 修的是指向已删 tsconfig 的假引用),
  建议另开一张微票统一改写。另:architecture.md 顺手修掉四处与 ADR-0014 不同步的陈旧句(core 段落的
  `LoopManager`、重试段的「引擎现在是 `loop-manager.ts` 的 `LoopManager.run`」、「委派对」、
  「提示词对搬进了 `loop-manager.ts`」),不改任何行为。
