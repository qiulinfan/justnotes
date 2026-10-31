import { describe, expect, test } from "bun:test";
import { shellCommand, shellEnvironment } from "../src/main/pty";

describe("the terminal's shell", () => {
	test("the login shell runs as a login shell; the settings' shell wins; Windows runs PowerShell", () => {
		expect(shellCommand("", { SHELL: "/opt/homebrew/bin/fish" }, "darwin", "/bin/zsh")).toEqual({ file: "/opt/homebrew/bin/fish", args: ["-l"] });
		expect(shellCommand(undefined, {}, "darwin", "/bin/zsh")).toEqual({ file: "/bin/zsh", args: ["-l"] });
		expect(shellCommand(" /bin/bash ", { SHELL: "/bin/zsh" }, "linux", "")).toEqual({ file: "/bin/bash", args: ["-l"] });
		expect(shellCommand("", { SHELL: "/bin/zsh" }, "win32", "")).toEqual({ file: "powershell.exe", args: [] });
	});

	test("the environment is the app's, as a terminal declares it, without Electron's own variables", () => {
		const env = shellEnvironment({ PATH: "/bin", HOME: "/h", ELECTRON_RUN_AS_NODE: "1", TERM: "dumb", fish_private_mode: "1" }, "0.1.0", "darwin");
		expect(env).toEqual({
			PATH: "/bin",
			HOME: "/h",
			fish_private_mode: "1",
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			TERM_PROGRAM: "justnotes",
			TERM_PROGRAM_VERSION: "0.1.0",
			LANG: "en_US.UTF-8",
		});
		// A LANG of the user's own is kept.
		expect(shellEnvironment({ LANG: "zh_CN.UTF-8" }, "0.1.0", "darwin").LANG).toBe("zh_CN.UTF-8");
	});
});
