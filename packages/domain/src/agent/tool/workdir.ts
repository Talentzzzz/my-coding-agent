import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

/**
 * 工具路径如何对照会话的工作目录来解读。
 *
 * 这里没有围栏。相对路径按工作目录解析；绝对路径原样接受，指向机器上的任何位置都行。这就是全部
 * 职责：目录只决定一个裸路径是什么意思、命令从哪里开始，不管束 agent 能碰什么。模型被要求改项目
 * 旁边一台机器上的某个文件时，它必须能说得出来。
 */

/**
 * 解析工具提供的路径：绝对路径保持原样，相对路径并入工作目录。
 *
 * 空路径和内嵌 NUL 被拒绝，因为两者都不指名任何文件——其余形状都交给调用方，包括走出目录的 `..`。
 */
export function resolveToolPath(workDirAbsPath: string, pathInput: string): string {
	if (pathInput.length === 0) throw new Error("Path must not be empty");
	if (pathInput.includes("\0")) throw new Error(`Invalid path: ${pathInput}`);
	return isAbsolute(pathInput) ? normalize(pathInput) : resolve(workDirAbsPath, pathInput);
}

/**
 * 路径如何展示给模型和窗口。
 *
 * 工作目录之内显示为相对路径，因为那是模型能交还给工具的名字，也是读者对照自己项目时用的名字。
 * 目录之外，绝对路径是唯一诚实的答案：`../../..` 链算起来更短、读起来更差，而且它会暗示目录仍是
 * 参照系。
 */
export function displayToolPath(workDirAbsPath: string, absPath: string): string {
	const relPath = relative(workDirAbsPath, absPath);
	if (relPath.length === 0) return ".";
	if (relPath === ".." || relPath.startsWith(`..${sep}`) || isAbsolute(relPath)) return toSlashes(normalize(absPath));
	return toSlashes(relPath);
}

/** 统一用正斜杠，让路径在消息里于所有平台上读起来一致。 */
function toSlashes(path: string): string {
	return path.split(sep).join("/");
}
