import { DEFAULT_MODEL_NAME, type ModelChoice, type ModelConfig } from "../models.ts";
import type { SettingManager } from "../setting-manager.ts";
import type { Session, SessionManager } from "./session-manager.ts";

/**
 * 一个 session 打开并运行所用的行，从 transcript 和设置推导。
 *
 * 这是「这个 session 在哪个模型上」的唯一答案，而且它是*推导*出来的，不是谁持有的值（ADR-0019）。
 * 之前，装配环节只解析一次，把结果种到它挂载的袋上；留在表里的袋可能终身带着那颗种子。现在每次
 * 读取都重放一个新袋然后丢掉，种子会连同它所在的副本一起被扔掉——第二次读取就会回答「从未选择过」。
 * 所以这个选择在每次被问时重新计算：transcript 记录的，其次设置自己的默认值指名的，再其次内置行。
 * 这和装配环节的顺序一致，因为它*就是*装配环节的顺序，只是搬到这里供需要它的两方共用。
 *
 * `chosen` 是第二级：调用方打开 session 时指名的行——`openAgent` 上仅测试用的覆盖，文件里没有
 * 任何东西能复现它。它只对文件还没说话的 session 有效，所以不需要清除：第一个到达 transcript 的
 * 选择会接管，双方不必知道对方存在。
 */
export function modelChoiceOf(
	sessions: SessionManager,
	session: Session,
	settings: SettingManager,
	chosen?: ModelChoice,
): ModelChoice {
	const recorded = sessions.getRecordedSettings(session);
	const rows = settings.modelCatalog();
	// 记录的选择是设置文件拼写的那种引用——`<name>/<model-id>`——而且是第一级：已选择的 session
	// 用自己的文件回答，它下面的一切只对还没选择的 session 有效。设置的读取做短路而不是提前提升，
	// 记录过任何东西的 session 就不用为它付代价。
	const recordedRef =
		recorded.model === undefined ? undefined : `${recorded.model.name}/${recorded.model.modelId}`;
	const ref = recordedRef ?? chosen?.name ?? settings.getSettings(session.sessionSetting.workDirAbsPath).model;
	const row = selectModelRow(rows, ref);
	// 一台没有任何行的机器仍然给出格式完好的选择：空的那个，所有构建方会把它变成传输层拒绝发送的
	// placeholder。这里不抛任何异常。
	if (row === undefined) return {};
	const level = chosen?.thinkingLevel ?? recorded.thinkingLevel;
	return { name: row.name, ...(level === undefined ? {} : { thinkingLevel: level }) };
}

/**
 * 引用所指名的行：调用方要求的，其次内置默认，再其次第一行。
 *
 * 两个调用方传入的是 *ref* 而不是名字——修复脚本写下的 `settings.model`，和 session 记录的模型
 * 选择——两者都拼成 `<name>/<model-id>`。名字才是标识行的东西，所以两种拼写都在这里解析，而不是
 * 在每个调用方各自解析；之前 ref 直接匹配不到任何行，session 会悄悄开在别人的行上。
 *
 * {@link DEFAULT_MODEL_NAME} 是第三级，硬编码而不是猜用户有哪家的 key：它是这个应用围绕构建的
 * 模型，所以默认值指名了一行已被删除的行、或设置文件什么都没指名时，session 仍然开在它上面。只有
 * 机器上没有那一行才落到 `rows[0]`，只有一行都没有的机器才得到 `undefined`——调用方用 placeholder
 * 回答而不是抛异常，因为 session 必须能构建出来，窗口才能打开到足以说出缺什么的地步。
 */
export function selectModelRow(rows: readonly ModelConfig[], ref: string | undefined): ModelConfig | undefined {
	const name = ref?.split("/")[0];
	if (name !== undefined) {
		const named = rows.find((row) => row.name === name);
		if (named) return named;
	}
	return rows.find((row) => row.name === DEFAULT_MODEL_NAME) ?? rows[0];
}
