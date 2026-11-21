// 工具簇设置的端口声明（分层重构 spec §4.2）：`tools.json`（全局默认工具集、模式表、审批与
// bash 超时）所在 home JSON 文件族的读与写，由组合根注入——文件名与迁移编排是簇知识，归消费方
// （ToolManager）；实现负责 join home + temp+rename 落盘。三个设置簇同形（spec §4.2），infra
// 的一个实现满足三份声明。
//
// `file` 是**文件名**（`"tools.json"`，以及 legacy 迁移源 `"settings.json"`）——「tools.json 不在
// 而旧文件在时捡走工具簇」的一次性迁移原样留在持有者里；实现不懂「settings.json 是 legacy」。
export interface ToolDefaultsRepository {
	/**
	 * 一份文件的 JSON 对象内容，按它写下的原样——未知键也在。
	 *
	 * `undefined` = 文件不存在（正常的首次运行）；空文件是一个空层（`{}`）；读不出的 JSON 以普通
	 * 错误拒绝，从不被覆盖——本构建无法解析的设置文件不得以「未配置设置」的形态抵达调用方。其余
	 * 读错误（权限、挡在路上的目录）同样拒绝。
	 */
	read(file: string): Record<string, unknown> | undefined;

	/** 原子落盘：目录不存在时创建，同目录 temp + rename——读者要么看到旧文件要么看到新文件。 */
	write(file: string, layer: Record<string, unknown>): void;
}
