# 04:SettingsManager 同形状——删每工作区私有袋,方法首参收 SettingsState

Type: task
Status: open
Blocked by: 01

## Question

`packages/core/src/settings-manager.ts`:与 02 票同形状——

- 删私有状态字段;每个方法改首参收 `SettingsState`(转发既有的文件级函数族);
  类保留,可构造注入。
- 类内部按**工作区**键控的缓存(前作票 09 的形态:hubs 缓存共享引用)收编进
  Manager 自身,失效时机(设置文件被写回、工作区关闭)一并定。
- 调用方迁移:core / server 里持有 SettingsManager 实例读值的调用点,改为
  「现取 SettingsState + 首参传袋」;`Agent.settingsManager` 属性本票不动(06 票拆)。
- 合并语义不变:变更写回**已经提供该字段**的那一份(全局 vs 工作区)。

完成后 `npm run check` + 相关 smoke(settings / modes)。
