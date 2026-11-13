---
status: closed
closed: 2026-11-14
assignee: workbuddy
Blocked-by: 004
---

# 005 收尾验证

## 一、静态

```bash
npm run check
```

判据：全绿。`check` 现在剩四条——`tsc -p tsconfig.json`、`tsc -p packages/web/tsconfig.json`、
`check-tokens`、`check-server-facade`。`check-loop-boundary` 那一条随文件一起消失，不是被跳过。

## 二、行为

与基线**同色**，不是「全绿」——干净 HEAD 上 `smoke-tools` 与 `smoke-desktop-observability` 本来
就是红的；这次不许变红也不许变绿（变绿说明改了不该改的东西）。

直接受影响的四个必须先跑：

```bash
node scripts/smoke-session.ts            # 流式、排队、重试、压缩、委派
node scripts/smoke-approval-recovery.ts  # 恢复机器：grant / deny / 孤儿 / 恢复中 abort——直接驱动搬过家的两个函数
node scripts/smoke-approval.ts           # 经 API 与 wire 的审批往返、宽限与重启继承
node scripts/smoke-tools.ts              # 工具、会话存储、压缩（基线：红，比对同一失败）
```

其余按 README 的清单全跑一遍，逐条与基线比对。`smoke-api` 需要先 `npm run start &`。

## 三、文本残留

```bash
grep -rn "LoopManager\|loop-manager\|loopOptions\|LoopOptions\|CompactOptions\|CompactCallbacks\|回调白名单\|check-loop-boundary" \
  --include=*.ts --include=*.json packages scripts
```

判据：**零命中**。命中即漏改——最可能的几处是 `agent.ts` 里描述运行的方法注释（`runEngine` 的
「它是零字段 `LoopManager` 的方法」、`dispatchEvent` 的「白名单 sink `emit` 的实现侧」、
`maybeCompact` 的 Pick 链、类头 docblock 的 19 动词）。

`--include=*.md` 的那一半归票 006，本票不查。

## 四、形状抽查

不必逐行读 2820 行，只确认四件事：

1. `grep -n "this.loop" packages/core/src/agent.ts` → 零命中。
2. `grep -n "private readonly loop" packages/core/src/agent.ts` → 零命中。
3. `ls packages/core/src/loop-manager.ts` → 不存在。
4. `git diff --stat` 里 `agent.ts` 的增删大致对称（约 +1600 / −40，加上搬入的 1886 行）——
   删除行数异常大，多半是行尾被改成 LF 了（票 004「坑 1」）。

## 五、记账

把实测行数（`wc -l packages/core/src/agent.ts`）与任何落地偏差写回票 004 与 ADR-0024 的「后果」。
偏差指形状级的东西（签名多退/少退一个参数、注释改了论证），不是语义——语义这次一字不改。

## Comments

### 2026-11-14 · workbuddy（验证实况，五节全过，票关闭）

- **§一**：`npm run check` 全绿，恰好四条（core tsc / web tsc / check-tokens / check-server-facade），
  `check-loop-boundary` 随文件消失。
- **§二**：直接受影响的四个——session / approval-recovery / approval 全绿，smoke-tools 红在与基线
  同一处（`exercisePruning` 的 `UnknownSessionError: idle-session`）。其余按 README 清单全跑：
  sessions / models / default-model / approval-endpoint / projection / mux / mux-client / mux-live /
  liveness / backpressure / boot / sidebar / settings / modes / transcript / frame / branch /
  model-form / desktop-close / api 全绿；smoke-desktop-observability 红在 `observability.cjs:207`
  的 `ReferenceError: bootWithinBudget is not defined`。两个基线红都取了证：detach 到工作前提交
  `c667b9f` 现跑，逐字同处同错——同色，未变绿。
- **§三**：残留 grep 零命中（EXIT=1）。
- **§四**：`this.loop` / `private readonly loop` 零命中；`loop-manager.ts` 不存在；行尾 CRLF
  2928/2928 无损，diff +1809/−132（净 +1677 = 2928−1251）。
- **§五**：实测 2928 行写回票 004 与 ADR-0024；顺带修正 ADR 后果里的行数——`Agent` 类终态实测
  1795 行（204–1998），票 001 §F 的「约 2450」与其自己的 2820 总数对不上，已按终态改写。
  形状级偏差：无新增。
