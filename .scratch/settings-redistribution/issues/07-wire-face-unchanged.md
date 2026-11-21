# 07 - wire 与 REST 面不变

Type: grilling
Status: resolved

## Question

设置拆到五个持有者之后，`/api/settings` 端点、`SettingsPatch` 补丁形状、`GlobalSettingsSnapshot`
要不要跟着拆？

## Answer

**不拆，wire 与 REST 面形状不变**（用户委托推荐）：

- `protocol.ts` 的 wire 类型（`GlobalSettingsSnapshot`、`ConfigPatch`、`SettingsPatch`、
  `ModelSelection`）形状不动；`GET /api/settings` 与补丁端点不拆。
- `Agent` 门面动词形状不变（`getSettings` / `applySettings` / `modelCatalog` / `replaceModels`
  等，ADR-0012 的消费边界原样）：`getSettings()` 从五个持有者**现读组装**一份
  `GlobalSettings` 形状的视图——这是设置面板的读模型，不是所有权壳；`applySettings(patch)`
  按字段名路由到拥有该字段的持有者。
- 结果：`packages/server` 与 `packages/web` 零改动（除 smoke 的 home 传递随接缝微调）。

细节见 [spec.md](../spec.md) §7。
