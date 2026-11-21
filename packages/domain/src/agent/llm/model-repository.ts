// 模型簇的端口声明（分层重构 spec §4.2）：`models.json` 的行、默认模型与 retry（ADR-0028 修正）
// 所在 home JSON 文件族的读与写，由组合根注入——文件名与迁移编排是簇知识，归消费方
// （ModelManager）；实现负责 join home + temp+rename 落盘。三个设置簇同形（spec §4.2），infra
// 的一个实现满足三份声明。
//
// `file` 是**文件名**（`"models.json"`，以及迁移源 `"settings.json"` 与退场持有者的
// `"engine.json"`）——迁移按「键」走、engine.json 优先于旧 settings.json 的裁决原样留在
// ModelManager 里；实现不懂哪份是 legacy。
export interface ModelRepository {
	/**
	 * 一份文件的 JSON 对象内容，按它写下的原样——未知键也在。
	 *
	 * `undefined` = 文件不存在（正常的首次运行，缺文件 = 空目录）；空文件是一个空层（`{}`）；读
	 * 不出的 JSON 以普通错误拒绝，从不被覆盖。其余读错误（权限、挡在路上的目录）同样拒绝。
	 */
	read(file: string): Record<string, unknown> | undefined;

	/** 原子落盘：目录不存在时创建，同目录 temp + rename——读者要么看到旧文件要么看到新文件。 */
	write(file: string, layer: Record<string, unknown>): void;
}
