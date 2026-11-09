# 02 createSessionAgent 吸收构造与注入接缝

Type: grilling
Status: closed

## Question

方向已定（map Notes Q3）：`createSessionAgent()` 吸收 Manager 构造。要定的是落地形状：

1. 新签名：`createSessionAgent({ settingsHome, modelsHome, api })`？homes 都可省（省略 = 真实
   home）还是必填？`AgentConfig` / `Agent` 构造器是否同步改、还是工厂内部造好三个 Manager 再走
   现有构造器？
2. `HubOptions` 最终形状：`{ workDirAbsPath, sessionId, settingsHome, modelsHome, api }`——
   `options.settings`（in-memory 注入口）删除后，smoke 的 in-memory settings 从哪个缝进来？
   （候选：工厂加测试缝；或 Agent 构造器继续可选收 Manager、但只有工厂与 smoke 用。）
3. `boot.ts` 与各 smoke（smoke-api、smoke-mux、smoke-approval、smoke-sessions、smoke-projection）
   的构造调用点逐个怎么改？
4. `Agent` 上的 `readonly sessionManager` / `readonly settings` 公开字段去留：server 侧不再用
   之后，core 内部与 smoke 还需要它们公开吗，还是收成 private / 删掉？

## Answer

构造调用点对账（票问 3）：boot.ts **零改动**（新 HubOptions 五字段覆盖它传的全部）；
hub.ts 构造器缩成 `createSessionAgent({settingsHome, modelsHome, api})` 一行，
`this.sessions` / `this.settings` / `this.tools` 三字段删除；四个 hub 级 smoke
（smoke-approval ×3、smoke-approval-endpoint）迁移（见下）；八个 openAgent 级 smoke
调用点几乎不变；smoke-sessions:887 改 `createSessionAgent({settings})`（工厂不再收
sessionManager）；smoke-settings 直接 `new SettingManager` 不受影响。

### 工厂新签名（票问 1，裁定 a）

```ts
createSessionAgent(options: {
  settingsHome?: string;   // 生产面：可省 = 真实 home，与 SettingManager 自己的缺省一致
  modelsHome?: string;
  api?: ChatTransport;
  settings?: SettingManager; // test-only 缝（in-memory），生产不传
  tools?: ToolManager;       // test-only 缝（自定义工具表）
}): Agent
```

- `SessionAgentServices` 类型退役；`settings` / `tools` 就是原接缝的迁入地——map Q3
  「注入接缝迁到新构造口，不丢失」的落点。
- **一条构造路**：工厂内部造好三个 Manager，走现有 `AgentConfig` 构造器；
  `Agent` 构造器本票不动。`openAgent` 纯转发（`OpenAgentOptions` 本来就是测试缝集合，
  形状不动）。
- 严格三参（裁定 b 的两条构造路）被否。

### hub 级 smoke 的迁移机制（票问 2，裁定 a）

HubOptions 已定无 `settings` 缝。smoke-approval ×3、smoke-approval-endpoint 改为：
临时目录 homes + **throwaway SettingManager 播种**——开跑前
`new SettingManager({home: tmp, modelsHome: tmp})` 调 `applySettings({approval: …})` +
`replaceModels(rows)` 写进临时文件，再 `new SessionHub({workDirAbsPath, settingsHome: tmp,
modelsHome: tmp, api})`。复用 coercion、不手写 JSON；门面每读现取，盘上临时文件与内存
存储语义等价。手写 JSON（b）与重开 HubOptions 底线（c）被否。

### `Agent.sessionManager` / `Agent.settings` 公开字段（票问 4，裁定 a）

**本票保持公开不动**。目的地只约束 server 包，scripts/ 不在内；这两个字段的仅剩消费者
是 smoke（smoke-session 的 `getEntries` / `getRecordedSettings`、smoke-approval-recovery
的 `appendMessage` 播种、smoke-stream 的 sabotage、smoke-projection 的 `resetLeaf`）。
断言改写在票 03/07，`agentState()` 的收口在票 04——三个一起看，本票不顺手改出半吊子。

