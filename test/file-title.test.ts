import { describe, expect, test } from "bun:test";
import { titleRenamePath } from "../src/api/file-title";
import { TFile, TFolder, type Vault } from "../src/api/vault";

const vault = {} as Vault;
const fileIn = (folder: string, name: string) => {
	const file = new TFile(vault, folder ? `${folder}/${name}` : name);
	file.parent = new TFolder(vault, folder || "/");
	return file;
};

// The tab title bar and the inline title rename a file in place, as in
// Obsidian: in its folder, keeping the extension a title does not show.
describe("titleRenamePath", () => {
	test("a note's title is its basename: the extension stays", () => {
		const note = fileIn("notes", "Draft.md");
		expect(titleRenamePath(note, "Draft", "Final")).toBe("notes/Final.md");
		expect(titleRenamePath(fileIn("", "Draft.md"), "Draft", "  Final ")).toBe("Final.md");
	});

	test("a title showing the whole name is the whole name", () => {
		const tex = fileIn("paper", "main.tex");
		expect(titleRenamePath(tex, "main.tex", "thesis.tex")).toBe("paper/thesis.tex");
		expect(titleRenamePath(tex, "main.tex", "thesis")).toBe("paper/thesis");
	});

	test("an unchanged or empty title renames nothing; line breaks are dropped", () => {
		const note = fileIn("", "Draft.md");
		expect(titleRenamePath(note, "Draft", "Draft")).toBeNull();
		expect(titleRenamePath(note, "Draft", "   ")).toBeNull();
		expect(titleRenamePath(note, "Draft", "Fi\nnal")).toBe("Final.md");
	});

	test("names Obsidian refuses throw with the reason", () => {
		const note = fileIn("", "Draft.md");
		for (const bad of ["a/b", "a\\b", "a:b", "a?", "a*", 'a"', "a<b>", "a|b"]) expect(() => titleRenamePath(note, "Draft", bad)).toThrow(/cannot contain/);
		expect(() => titleRenamePath(note, "Draft", ".hidden")).toThrow(/dot/);
	});
});
