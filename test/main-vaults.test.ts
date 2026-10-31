import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { vaultOf } from "../src/main/ipc";

// The vault whose window an obsidian://open?path= (or new?path=) URL for a
// file outside the current vault goes to.
describe("vaultOf", () => {
	// outer/ is a vault with a nested vault outer/inner/; plain/ is no vault, and
	// fake/ holds a file, not a folder, named .obsidian.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "jn-vaults-"));
	for (const dir of ["outer/.obsidian", "outer/notes", "outer/inner/.obsidian", "outer/inner/deep", "plain/notes", "fake"]) {
		fs.mkdirSync(path.join(root, dir), { recursive: true });
	}
	fs.writeFileSync(path.join(root, "fake/.obsidian"), "");
	afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

	test("a file belongs to the nearest folder above it that has a .obsidian folder", () => {
		expect(vaultOf(path.join(root, "outer/notes/a.md"))).toBe(path.join(root, "outer"));
		expect(vaultOf(path.join(root, "outer/inner/deep/b.md"))).toBe(path.join(root, "outer/inner"));
	});

	test("a vault folder is its own vault, and a file not created yet still finds its vault", () => {
		expect(vaultOf(path.join(root, "outer/inner"))).toBe(path.join(root, "outer/inner"));
		expect(vaultOf(path.join(root, "outer/new folder/new.md"))).toBe(path.join(root, "outer"));
	});

	test("no vault without a .obsidian folder above the path", () => {
		expect(vaultOf(path.join(root, "plain/notes/c.md"))).toBeNull();
		expect(vaultOf(path.join(root, "fake/d.md"))).toBeNull();
	});

	test("a relative path names no vault, whatever folder the app runs in", () => {
		const cwd = process.cwd();
		process.chdir(path.join(root, "outer"));
		try {
			expect(vaultOf("notes/a.md")).toBeNull();
		} finally {
			process.chdir(cwd);
		}
	});
});
