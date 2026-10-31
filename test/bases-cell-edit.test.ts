import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { App } from "../src/api/app";
import { cellEditor, writeCell } from "../src/api/bases/cell-edit";
import { FileManager } from "../src/api/file-manager";
import { Vault } from "../src/api/vault";

// Saving a table cell rewrites that property in the note's frontmatter, so a
// wrong round trip through text corrupts the note.
describe("editing a property in a table cell", () => {
	test("a list is edited one item per line, so an item may hold a comma", () => {
		const editor = cellEditor(["Smith, John", "Doe, Jane"], null)!;
		expect(editor.multiline).toBe(true);
		expect(editor.text).toBe("Smith, John\nDoe, Jane");
		expect(editor.parse(`${editor.text}\nRoe, Rick\n`, ["Smith, John", "Doe, Jane"])).toEqual(["Smith, John", "Doe, Jane", "Roe, Rick"]);
		expect(editor.changed(" Smith, John \n\nDoe, Jane\n")).toBe(false);
		expect(editor.parse("\n \n", ["Smith, John", "Doe, Jane"])).toBeUndefined();
	});

	test("items the edit leaves alone keep their values", () => {
		const raw = [3, "[[Note|Smith, J.]]", "draft", null];
		const editor = cellEditor(raw, "multitext")!;
		expect(editor.text).toBe("3\n[[Note|Smith, J.]]\ndraft");
		expect(editor.parse("[[Note|Smith, J.]]\n3\nfinal", raw)).toEqual(["[[Note|Smith, J.]]", 3, "final"]);
		// A new line in a list of numbers is a number, not text.
		expect(cellEditor([1, 2], null)!.parse("1\n2\n3", [1, 2])).toEqual([1, 2, 3]);
		// A tags string shows its tags one per line and saves them as a list.
		expect(cellEditor("work, home", "tags")!.parse("work\nhome\nurgent", "work, home")).toEqual(["work", "home", "urgent"]);
	});

	test("values a line of text cannot show are not edited in a cell", () => {
		expect(cellEditor({ name: "x" }, null)).toBeNull();
		expect(cellEditor([{ name: "x" }, "y"], null)).toBeNull();
		expect(cellEditor(["two\nlines"], "multitext")).toBeNull();
		// Text over several lines is edited in a textarea and keeps its lines.
		const prose = cellEditor("first line\nsecond line", "text")!;
		expect(prose.multiline).toBe(true);
		expect(prose.parse("first line\nsecond line, edited\n", "first line\nsecond line")).toBe("first line\nsecond line, edited");
		// A list that gained an object while the cell was open is kept as it is.
		const current = ["a", { b: 1 }];
		expect(cellEditor(["a"], null)!.parse("a\nc", current)).toBe(current);
	});

	test("a single value keeps its type and an empty cell clears it", () => {
		const editor = cellEditor(2, null)!;
		expect(editor.multiline).toBe(false);
		expect(editor.parse(" 5 ", 2)).toBe(5);
		expect(editor.parse("about 5", 2)).toBe("about 5");
		expect(cellEditor("todo", "text")!.parse("  ", "todo")).toBeUndefined();
	});
});

// processFrontMatter refuses frontmatter it would corrupt; a cell edit must
// report that instead of leaving an unhandled rejection.
test("a cell edit on a note whose frontmatter is not a map reports why and writes nothing", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-cell-")));
	fs.writeFileSync(path.join(dir, "list.md"), "---\n- a\n---\nText\n");
	fs.writeFileSync(path.join(dir, "ok.md"), "---\nk: 1\n---\n");
	const vault = new Vault(dir);
	try {
		await vault.load();
		const fm = new FileManager({ vault } as unknown as App);
		const failure = await writeCell(fm, vault.getFileByPath("list.md")!, (f) => (f.k = 2));
		expect(failure).toContain("list.md");
		expect(failure).toContain("not a map");
		expect(fs.readFileSync(path.join(dir, "list.md"), "utf8")).toBe("---\n- a\n---\nText\n");
		expect(await writeCell(fm, vault.getFileByPath("ok.md")!, (f) => (f.k = 2))).toBeNull();
		expect(fs.readFileSync(path.join(dir, "ok.md"), "utf8")).toBe("---\nk: 2\n---\n");
	} finally {
		vault.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
