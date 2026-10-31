import { describe, expect, test } from "bun:test";
import { parseObsidianUrl } from "../src/api/app";

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

	test("a key without a value is 'true'", () => {
		expect(parseObsidianUrl("obsidian://new?name=Inbox&silent&append=")).toEqual({ action: "new", name: "Inbox", silent: "true", append: "true" });
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

	test("other URLs are not obsidian URLs", () => {
		expect(parseObsidianUrl("https://obsidian.md/open?file=x")).toBeNull();
	});
});
