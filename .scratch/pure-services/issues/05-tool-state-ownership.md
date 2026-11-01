# 05:ToolState 的归属——账本派生,还是键控缓存?

Type: grilling
Status: open
Blocked by: 01

## Question

`ToolState`(活跃工具集 + 审批覆盖,前作票 11 的纯数据袋)在新形状下住哪?这是
五单例里唯一悬而未决的归属问题:

- **账本派生(候选,更彻底)**:`getRecordedToolConfig` 已能从 `tool_config`
  entry 读回活跃集与审批映射,且 `setActiveTools` / `applyConfig` / 审批 grant
  都**立即**落 entry——活性似乎从不久存于账本之外。若成立,ToolState 连键控缓存
  都不需要:谁用谁现派生,与 modelState 消失同理;全局默认的 fallback
  (`globalDefaultToolState`)照旧是派生链的一步。
- **键控缓存(保底)**:若存在「活性超前于账本」的窗口(分支移动
  `applyBranchToolConfig` 的中途态?subagent 的收窄注册表?),则按 id 键控,
  形状同 02/04 票。

先裁决,后实施:`ToolManager`(定义注册表,全局只读)无属性化,按结论改造
ToolState 的读写路径。裁决要对照代码逐条过:每一个今天写 `ToolState` 的位置,
是否同栈内就有一条 entry 落账本。

完成后 `npm run check` + `smoke-tools.ts`。
