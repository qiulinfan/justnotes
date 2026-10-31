import { describe, expect, test } from "bun:test";
import { cellEditor } from "../src/api/bases/cell-edit";

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
