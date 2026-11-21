# 01 - 目的地的字面程度：无壳全删

Type: grilling
Status: resolved

## Question

「去掉 SettingManager」是字面意义的——类和文件彻底消失、能力分散到各自持有者？还是允许留一个
薄壳（例如只协调文件 I/O 的存储层）？

## Answer

**字面意义的删除**（用户裁定：没有壳子，全删了）：

- `setting-manager.ts` 整个文件退场：类、`SettingManagerOptions`、`inMemorySettingManager`。
- 不留任何统一设置门面或协调壳——设置的门就是各关注点自己的持有者。
- 存储后端抽象（`SettingsStorage` / `FileSettingsStorage` / `InMemorySettingsStorage`）一并
  退场：每个持有者直接读写自己的文件（各约十几行），测试接缝改走 home 指向（临时目录），与
  现有 `settingsHome` / `modelsHome` 约定同形。

细节见 [spec.md](../spec.md) §3、§8。
