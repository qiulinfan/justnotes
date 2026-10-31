import { describe, expect, test } from "bun:test";
import { parseObsidianUrl, urlPathOutsideNotes } from "../src/api/app";

// What protocol handlers registered with registerObsidianProtocolHandler, and
// the built-in open/new/search actions, receive.
describe("parseObsidianUrl", () => {
	test("decodes the action and parameters, keeping + as a plus", () => {
		expect(parseObsidianUrl("obsidian://open?vault=my%20vault&file=C%2B%2B%20notes%2Fa+b")).toEqual({
			action: "open",
			vault: "my vault",
			file: "C++ notes/a+b",
		});
	});

	test("a key without '=' is 'true', and an empty value stays empty", () => {
		// obsidian://new?content=&overwrite once wrote the word "true" into the note.
		expect(parseObsidianUrl("obsidian://new?name=Inbox&silent&content=")).toEqual({ action: "new", name: "Inbox", silent: "true", content: "" });
	});

	test("the vault shorthand opens a file in a named vault", () => {
		expect(parseObsidianUrl("obsidian://vault/my vault/folder/my%20note")).toEqual({ action: "open", vault: "my vault", file: "folder/my note" });
	});

	test("the absolute path shorthand opens a file by path", () => {
		expect(parseObsidianUrl("obsidian:///Users/me/vault/my%20note.md")).toEqual({ action: "open", path: "/Users/me/vault/my note.md" });
	});

	test("a query parameter cannot replace the action", () => {
		expect(parseObsidianUrl("obsidian://quickadd?action=run&choice=Inbox")?.action).toBe("quickadd");
	});

	test("an obsidian: URL without the slashes is still one, so it never reaches the OS", () => {
		expect(parseObsidianUrl("obsidian:open?vault=Work")).toEqual({ action: "open", vault: "Work" });
	});

	test("other URLs are not obsidian URLs", () => {
		expect(parseObsidianUrl("https://obsidian.md/open?file=x")).toBeNull();
	});
});

// The built-in open and new actions refuse these, so a link clicked in a note
// cannot write outside the notes: obsidian://new once overwrote a plugin's
// main.js (code the next start runs) because hidden paths are not in the
// vault index, so the file did not count as existing.
describe("urlPathOutsideNotes", () => {
	const target = (url: string) => urlPathOutsideNotes(parseObsidianUrl(url)!);

	test("the config folder and other hidden folders are refused, by file= or name=", () => {
		expect(target("obsidian://new?file=.obsidian/plugins/demo/main.js&content=x&silent")).toBe(".obsidian/plugins/demo/main.js");
		expect(target("obsidian://new?file=notes%5C.git%5Cconfig")).toBe("notes\\.git\\config");
		expect(target("obsidian://new?name=.obsidian%2Fsnippets%2Fx.css")).toBe(".obsidian/snippets/x.css");
	});

	test("parent folders are refused; notes in nested folders are not", () => {
		expect(target("obsidian://open?file=..%2Foutside")).toBe("../outside");
		expect(target("obsidian://new?file=Projects%2FAlpha%20v1.2&content=x")).toBeUndefined();
		expect(target("obsidian://open?file=Home%23Section")).toBeUndefined();
	});
});
