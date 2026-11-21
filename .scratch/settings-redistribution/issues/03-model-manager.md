# 03 - 模型目录的归属：新建 ModelManager

Type: grilling
Status: resolved

## Question

`SettingManager` 还独占 `models.json`（`modelCatalog` / `replaceModels`）+ 默认模型选择，而
没有 `ModelManager` 存在。归谁：(a) 新建 `ModelManager`；(b) 归 `SessionManager`；(c) 暂留
某个壳。

## Answer

**(a) 新建 `ModelManager`**（用户采纳推荐）：

- 拥有 `models.json` 整个文件：模型行 + 迁移进来的 `defaultModel`（原 `GlobalSettings.model`）
  与 `defaultModelSeeded` 两个可选键。文件已是 `{ models: [...] }` 包裹对象，可选键向后兼容，
  旧文件缺键即「未设置」。
- `ModelConfigStore` 被吸收（它今天只被 SettingManager 私有使用）。
- 公开面：读行、换行、读默认 ref、写默认 ref 与 seeded 标记（细节见 spec §5）。

细节见 [spec.md](../spec.md) §3、§5。
