/** 在当前平台启动 shell 命令的方式。 */
export interface Launcher {
	file: string;
	args: string[];
}

/** 平台自己的 shell：Windows 上是 `cmd.exe`，其余平台是 `$SHELL` 或 `/bin/sh`。 */
export function defaultLauncher(): Launcher {
	if (process.platform === "win32") {
		return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] };
	}
	return { file: process.env.SHELL ?? "/bin/sh", args: ["-c"] };
}
