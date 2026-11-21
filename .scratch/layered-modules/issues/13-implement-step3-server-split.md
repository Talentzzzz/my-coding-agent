# 实施步 3：server 三分（case / trigger / app）+ 依赖方向守卫

Type: task
Status: resolved
Blocked by: 12

## Question

按 [spec.md](../spec.md) §7 步 3 落地：hub → case、传输面 → trigger、boot 主半 → app 的
`start(options)`、serve.ts 薄脚本、desktop 对接、server 退役、两处子进程 spawn 点换指、
scripts 相对 import 重指、`check-layering.ts` 诞生（R1/R1b）。
验收 = §7 步 3 附加清单全绿。

## Answer

`lm/step3-server-split`（541c6e2），已并入 `layered-modules`。验收全单全绿（基线先跑一遍
确认无先天失败项）；check-layering 做过负测试（四类违例全被抓）。已登记偏离：

1. `agent-home.ts` 留步 5（§7 步 3 移动清单不含它）；本步 start() 对 homes 纯透传。
2. StartOptions 按 §5.1 补 `modelsHome` 透传（行为中性）。
3. 守卫额外拒绝跨包相对 import（R1 的机械补强，现网无此类 import）。
4. boot.ts→start.ts 超默认 50% 相似度阈值显示 D+A，`git log --follow -M20%` 验证历史连通。

**先坏项**：smoke-approval 的「the model's closing answer is in the session」间歇失败
（基线 A/B 各 5 轮证实先坏，~2/5）——`scripts/wire/client.ts` 的 waitFor 会命中 parked run
遗留的旧帧，与恢复运行收尾竞速。非本步引入，未修。
