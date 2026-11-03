# Map：会话的打开与切换只走 mux 基线

Status: done

## Destination

窗口对会话的打开、切换、页面加载只依赖 mux 订阅：`retain` 即导航，`baseline` 帧即第一次绘制；REST 读从前端导航路径退场。终点 = 决定与行为语义见 [ADR-0010](../../docs/adr/0010-open-session-over-mux.md)（**施工前必读**，本图不重复它的理由），落地清单八行全做，验收边五条成立，`npm run check` 与相关 smoke 全绿，`docs/architecture.md` 与 ADR 状态行与实况一致。

## Notes

**2026-11-03 用户拍板**：只用 mux baseline，双源结构（REST 读先画 + channel 基线替换）拆除。理由、代价、被放弃的选项全在 ADR-0010，票内不得重开。

**施工顺序是硬约束**：票 01（服务端 `open()` 幂等）必须先于票 02（客户端恒发 `open`）——顺序反了，"send 持有引用时切走再切回"会永远等不到基线。

**动手前必读**：`docs/adr/0010-open-session-over-mux.md`；`packages/web/src/main.ts` 的 `openSession()`（含其四条 load-bearing 顺序注释）；`packages/web/src/client.ts` 的 `retain` / `release` / `replaySubscriptions`；`packages/server/src/mux.ts` 的 `open()` / `writeBaseline` / `pushBaseline`。

**验证命令**（每张票收账时跑，04 号票全量跑）：

```bash
npm run check                            # 类型 + token 审计
node scripts/smoke-mux-client.ts
node scripts/smoke-projection.ts
npm run build:web                        # web 客户端要能打包
```

**惯例**：文档中文、源码注释英文；编辑源码用编辑器工具、绝不走 shell 文本往返；相对 import 带 `.ts` 扩展名；不用 `any`。

**ADR 纪律**：决定已由 ADR-0010 记录，本图只扛执行；落地完成后把 ADR 状态行「尚未落地」改掉，并在 `docs/adr/README.md` 清单行补「已落地」。

## Decisions so far

- [01 - 服务端 open 幂等](issues/01-server-mux.md)：重复订阅分支拒绝 → `pushBaseline`
- [02 - 客户端 pending-open 状态机](issues/02-client-pending-open.md)：`retain` 恒发 `open`；promise + series + 超时
- [03 - openSession 重写与页面加载](issues/03-web-open-session.md)：`main.ts` 单源化；`api.read` 调用点删除
- [04 - smoke 与文档收账](issues/04-smokes-docs.md)：smoke-mux-client 新增「两份基线，谁该画」一节（重复 open 再送一份 + 迟到的那份不画不报）；architecture.md 三节改为单源说法；ADR 状态、README 清单行、本图状态三处翻转

## Not yet specified

- ~~**超时取值**~~ **已定稿：保留 3 s**（见 [02](issues/02-client-pending-open.md)）。实测的是基线信封的 `JSON.parse`（1.93 MiB 约 3.5 ms），所以 CPU 不是约束——3 s 买的是基线排在大帧后面的**排队余量**，收紧只会把"忙"报成"坏"。真实大会话 + 流式刷屏下的写侧排队时长仍未测，ADR 那条从"随手写的初始值"变成"有下限论证的初始值"。
- ~~**迟到基线 + 超时报错同时发生**~~ **没有新坑**：按"series 作废只管画与报错，不管订阅"落地——[04](issues/04-smokes-docs.md) 把这条做成了 smoke 里的一节（迟到的基线仍答清自己那次导航、不画、不报错，两条订阅都还在）。

## Out of scope

- REST 读端点 `GET /api/sessions/{id}` / `GET /api/sessions/current` 的删除与否——ADR 已定**保留**（资源式命令面的读一半），前端退场即可。
- 断线期间的浏览能力（REST 后备）——ADR 已明确**不留**，用户拍板接受。
- mux 的背压、心跳、重连机制本身——[0001](../../docs/adr/0001-transport-websocket-mux.md) 原样，本图不动。
