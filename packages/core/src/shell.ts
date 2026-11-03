/** How to launch a shell command on this platform. */
export interface Launcher {
	file: string;
	args: string[];
}

/** The platform's own shell: `cmd.exe` on Windows, `$SHELL` or `/bin/sh` everywhere else. */
export function defaultLauncher(): Launcher {
	if (process.platform === "win32") {
		return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] };
	}
	return { file: process.env.SHELL ?? "/bin/sh", args: ["-c"] };
}
