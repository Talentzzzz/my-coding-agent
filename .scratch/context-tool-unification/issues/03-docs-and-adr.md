# 03 文档收账:AGENTS/architecture/新 ADR

Type: task
Status: open
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
