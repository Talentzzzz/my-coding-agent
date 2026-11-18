# 06 - 审查修复：注释里的旧主人、死代码、`FrameSink` 的转发口、删除顺序的触发链

Type: task
Status: in-progress
Blocked-by: 05

## 背景与指针

code review 在集成分支 `wire-stream-split` 上跑了两轴（Standards / Spec），以下是两边都点名、或只被一边点名但成立的问题。规格：`spec.md`；实施票：同目录 `01`–`05`。

## 改动（逐条，一条一个提交也行、一个提交也行）

1. **`packages/server/src/hub.ts` 三处注释仍把收尾算在 mux 名下**（`remove` 与 `close` 的 JSDoc，约 L462 / L468 / L473）：「让 mux 对观看中的流发 end」「mux 在其中结束流」「`gone()` 里的 mux 会退订」。现在发 `end`、退订的是 `SessionStream`。按 spec 的分层表改写（hub 不知道帧、不知道连接）。**只改注释。**

2. **core 源码里四处过时注释还指着已经退场的名字**：`packages/core/src/agent.ts:150`、`:346`（「hub 的 feedMap」）、`packages/core/src/session/events.ts:153`、`packages/core/src/protocol.ts:365`（`announce(...)`）。ADR-0024 的「这些名字在代码里都不再存在」目前不成立。改成新名字（按会话的订阅表 / `publishFailure`）。**只改注释，一行逻辑都不许动**（spec Out of Scope 说的是 core 编排层的行为与持久化格式，注释跟随不是行为变更）。

3. **`scripts/smoke-backpressure.ts` 的死代码**：`ApprovalAnswers` 的 import 与 `answers` 桩（约 L22 与 L74-82）在 `Wire` 不再接收它之后已无消费点。删掉（tsconfig 不开 `noUnusedLocals`，机器不会报）。

4. **`packages/server/src/mux.ts` 的 `export type { FrameSink } from "./wire.ts"`**：这是给 smoke 的旧 import 路径留的转发口，与票 02「`FrameSink` 的家在 wire」相悖，也让 `mux` 的公开面比 spec 的保留清单多一样东西。删掉它，把 `scripts/smoke-subscribe.ts`（L16）与 `scripts/smoke-backpressure.ts`（L40）的 `FrameSink` 导入改到 `../packages/server/src/wire.ts`。

5. **`packages/server/src/boot.ts` 的 `mux?: MuxOptions` 注释**（约 L46-51）仍写「mux 自己的定时器和预算」——那是 wire 的五个预算，mux 只是透传。改这句注释（键名 `mux` 与 `MuxOptions` 别名保留：它们是 boot 的公开选项与 mux 服务器自己的选项名，改名会波及全部 smoke 的装配）。

6. **ADR-0024 的偏离清单少一条**：`subscribeGlobal(sub): () => void` 也是 spec 公开面清单之外的成员——spec 只给了「一个全局通道 `Set<全局订阅>`」，没给登记它的动词。在「与 spec 的偏离」里补一条（编号顺延），说明它是那个通道的唯一入口、不登记就收不到 `rows`。

7. **`packages/server/src/stream.ts` 的 `failure` 回调里那个 `if (!subscriptions.has(sessionId)) return;` 守卫不可达**：这个回调是按订阅元素逐个调用的，元素在表里才会被调到；退订与 `subscriptions.delete` 同时发生。删掉守卫并留一句注释说明为什么不需要它（`hub` 只把 `failure` 交给这个会话的订阅者）。

8. **删除顺序的那条 smoke 断言没走生产链**（spec `不变量` 第 3 条点名的路径是 `hub.remove` → `gone()` → controller 的 `onRemoved` → projection `forget` → `hub.publishGone`）。`scripts/smoke-subscribe.ts` 的 `rig.forgetRow()` 直接调 `projection.forget`，把中间两拍跳过了——于是把 `boot.ts` 的 `onRemoved` 接线删掉，断言照样绿。改装配：`openRig()` 里按生产的样子造 `new SessionController(hub, sessionListeners({ hub, answers }, projection))`（`packages/server/src/boot.ts` 的 `sessionListeners` 是公开的），删除走 `controller.delete(id)`；`Rig` 的驱动面换成 `deleteSession(id)`，断言区相应改调用（**断言的文字与判据不变**，仍断言"该流先 end、随后的 `session_gone` 才到"）。若 `SessionController.delete` 的签名需要 body 或返回 promise，按它的实际形状用。

## 测试

- `npm run check` 绿。
- 全绿：`node scripts/smoke-subscribe.ts`、`smoke-backpressure.ts`、`smoke-mux.ts`、`smoke-stream.ts`、`smoke-approval.ts`、`smoke-approval-endpoint.ts`、`smoke-sessions.ts`、`smoke-projection.ts`、`smoke-boot.ts`、`smoke-mux-client.ts`、`smoke-liveness.ts`、`smoke-sidecar`（不存在就跳过）。
- 反向验证第 8 条：**临时**把 `boot.ts` 里 `onRemoved` 的 `projection.forget(sessionId)` 注释掉，`smoke-subscribe.ts` 必须变红；确认之后把它改回来（这一次改动不要提交）。
- grep 自查：`grep -rn "feedMap\|isWatched\|SessionFeeds\|rebaseline\|MuxServer.announce" packages/ scripts/` → 零命中（注释也算）。

## Comments
