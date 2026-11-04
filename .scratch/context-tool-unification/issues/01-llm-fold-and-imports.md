# 01 llm 折叠与 import 改线

Type: task
Status: resolved

## Question

把 `packages/llm` 原样折叠进 `packages/core/src/llm/`,并让全树 import 面跟上——本票做完,
`npm run check` 必须全绿,而**类型与行为一个字没变**。

范围(定案 1、2、5):

- `packages/llm/src` 整体搬到 `packages/core/src/llm/`(api/、model.ts、types.ts、utils/ 结构
  原样,文件头 `@ts-nocheck` 保留);
- 撤销 llm 的 workspace 成员资格(`package.json`)、删除 `packages/llm/package.json` 与
  `packages/llm/tsconfig.json`;
- 根 tsconfig 的 `@my-agent/llm` 与 `@my-agent/llm/api/*` 别名删除;
- core、server(boot.ts、hub.ts)、web(state.ts)、scripts(fake-transport.ts、smoke-* 等
  约 8 个文件)里的 `@my-agent/llm` 导入全部改指新位置(core 内部相对导入走相对路径;
  server/web/scripts 改从 core 出口),**禁止**把别名悄悄改指 core 内部路径;
- `npm run check` 删掉 `tsc -p packages/llm/tsconfig.json` 那一棒;
- 跑 `node scripts/install-deps.ts .` 重解析,`npm run check` 全绿。

验收:`npm run check` 绿;`grep -r "@my-agent/llm"` 全仓清零;`packages/llm` 目录不存在;
smoke 全套行为与改动前一致(本票不动任何类型定义,只搬家改线)。

## Answer

落地于 045140a(前置:511fc09 把工作区里在制的 loop-manager/SettingManager 线先原样入库,
让出干净基线)。

- 搬迁、workspace/别名/check 棒、依赖并入(`@anthropic-ai/sdk` 0.124.0、`partial-json`
  0.1.7 进 core 的 package.json)、install-deps 硬编码 workspace 表撤 llm,全按票面;
  core 16 处导入改相对、server/web/scripts 改从 `@my-agent/core` 出口(core index 补一段
  传输面出口),无一处假包名。
- 验收核对:check 绿;代码内 `@my-agent/llm` 清零(**docs 里的引用留给票 03**,验收的
  「全仓清零」要到票 03 才字面成立);`packages/llm` 目录已删;smoke 全套除 smoke-boot
  一次偶发句柄报警(复跑绿)与 smoke-api(环境依赖,票 15 已记录)外全绿。
- 票面外顺手两件:26 个折叠文件头注释里「Checked by packages/llm/tsconfig.json」的假
  引用修正(tsconfig 本票已删);`node_modules/@my-agent/llm` 死链手工清除——install-deps
  只重建不清理,死链清理未入脚本,若再现可考虑给 install-deps 补 prune。
- code-review(Standards/Spec 双轴)通过:无硬违规;唯一张力即上述 docs 归票 03。
