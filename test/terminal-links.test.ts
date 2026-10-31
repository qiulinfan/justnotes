import { describe, expect, test } from "bun:test";
import { appCommandAllowed, terminalKeyAction } from "../src/renderer/terminal/keys";
import { findPathCandidates, osc7Path, shellQuote, vaultPathOf } from "../src/renderer/terminal/links";

const paths = (line: string) => findPathCandidates(line).map((c) => [c.path, line.slice(c.start, c.end), c.line ?? null, c.column ?? null]);

describe("paths in terminal output", () => {
	test("ls, git status and compiler lines name paths, with their line and column", () => {
		expect(paths("Hello.md  notes  中文笔记.md")).toEqual([
			["Hello.md", "Hello.md", null, null],
			["中文笔记.md", "中文笔记.md", null, null],
		]);
		expect(paths("\tmodified:   notes/sub/deep.md")).toEqual([["notes/sub/deep.md", "notes/sub/deep.md", null, null]]);
		expect(paths("src/a.ts:12:5: error TS2304")).toEqual([["src/a.ts", "src/a.ts:12:5:", 12, 5]]);
		expect(paths("see (./notes/x.md), then ~/w.txt.")).toEqual([
			["./notes/x.md", "./notes/x.md", null, null],
			["~/w.txt", "~/w.txt", null, null],
		]);
	});

	test("URLs, flags, bare words and dots are no paths", () => {
		expect(paths("open https://example.com/a.md --flag=x.md -v done . .. 1.")).toEqual([]);
	});

	test("a path resolves from the shell's folder into the vault, or not at all", () => {
		expect(vaultPathOf("deep.md", "/v/notes/sub", "/v", "/h")).toBe("notes/sub/deep.md");
		expect(vaultPathOf("/v/Hello.md", "/elsewhere", "/v", "/h")).toBe("Hello.md");
		expect(vaultPathOf("~/v/a.md", "/", "/h/v", "/h")).toBe("a.md");
		expect(vaultPathOf("../x.md", "/v", "/v", "/h")).toBeNull();
		expect(vaultPathOf(".", "/v", "/v", "/h")).toBeNull();
	});

	test("dropped paths are quoted for the shell only when they need it", () => {
		expect(shellQuote("/v/notes/a.md", "darwin")).toBe("/v/notes/a.md");
		expect(shellQuote("/v/my notes/it's.md", "darwin")).toBe(`'/v/my notes/it'\\''s.md'`);
		expect(shellQuote("C:\\v\\my notes\\a.md", "win32")).toBe('"C:\\v\\my notes\\a.md"');
	});

	test("OSC 7 reports the shell's folder", () => {
		expect(osc7Path("file://host/Users/me/my%20vault")).toBe("/Users/me/my vault");
		expect(osc7Path("file:///C:/Users/me")).toBe("C:/Users/me");
		expect(osc7Path("http://x/y")).toBeNull();
	});
});

describe("keys in a focused terminal", () => {
	const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
		key: k,
		code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...mods,
	});

	test("macOS: Cmd keys are the terminal's, Ctrl keys the shell's", () => {
		expect(terminalKeyAction(key("k", { metaKey: true }), true, false)).toBe("clear");
		expect(terminalKeyAction(key("f", { metaKey: true }), true, false)).toBe("find");
		expect(terminalKeyAction(key("c", { metaKey: true }), true, false)).toBeNull();
		expect(terminalKeyAction(key("c", { metaKey: true }), true, true)).toBe("copy");
		expect(terminalKeyAction(key("c", { ctrlKey: true }), true, true)).toBeNull();
		expect(terminalKeyAction(key("ArrowLeft", { altKey: true }), true, false)).toEqual({ send: "\x1bb" });
		expect(terminalKeyAction(key("Backspace", { metaKey: true }), true, false)).toEqual({ send: "\x15" });
	});

	test("Windows and Linux: Ctrl+Shift keys are the terminal's; Ctrl+C copies only a selection", () => {
		expect(terminalKeyAction(key("v", { ctrlKey: true, shiftKey: true }), false, false)).toBe("paste");
		expect(terminalKeyAction(key("c", { ctrlKey: true }), false, false)).toBeNull();
		expect(terminalKeyAction(key("c", { ctrlKey: true }), false, true)).toBe("copy");
		expect(terminalKeyAction(key("v", { ctrlKey: true }), false, false)).toBeNull();
	});

	test("only window-level and terminal commands run, plus any Cmd shortcut on macOS", () => {
		expect(appCommandAllowed("command-palette:open", { metaKey: false }, false)).toBe(true);
		expect(appCommandAllowed("terminal:toggle", { metaKey: false }, true)).toBe(true);
		expect(appCommandAllowed("editor:toggle-bold", { metaKey: false }, false)).toBe(false);
		expect(appCommandAllowed("editor:toggle-bold", { metaKey: true }, true)).toBe(true);
	});
});
