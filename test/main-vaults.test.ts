import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { vaultOf } from "../src/main/ipc";

// The vault whose window an obsidian://open?path= (or new?path=) URL for a
// file outside the current vault goes to: one of the vaults the user opened
// with --vault or the folder picker, since opening a vault runs its plugins.
describe("vaultOf", () => {
	// outer/ and outer/inner/ are known vaults, one inside the other. stranger/
	// has a .obsidian folder but was never opened, outer-2/ starts with outer's
	// name, and link/ is a symlink to outer/.
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jn-vaults-")));
	for (const dir of ["outer/notes", "outer/inner/deep", "stranger/.obsidian", "outer-2"]) {
		fs.mkdirSync(path.join(root, dir), { recursive: true });
	}
	fs.symlinkSync(path.join(root, "outer"), path.join(root, "link"));
	const outer = path.join(root, "outer");
	const inner = path.join(root, "outer/inner");
	const known = [outer, inner];
	afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

	test("a file belongs to the most specific known vault that holds it", () => {
		expect(vaultOf(path.join(root, "outer/notes/a.md"), known)).toBe(outer);
		expect(vaultOf(path.join(root, "outer/inner/deep/b.md"), known)).toBe(inner);
	});

	test("a folder with a .obsidian folder is no vault until the user opens it", () => {
		expect(vaultOf(path.join(root, "stranger/c.md"), known)).toBeNull();
		expect(vaultOf(path.join(root, "stranger/c.md"), [...known, path.join(root, "stranger")])).toBe(path.join(root, "stranger"));
	});

	test("a folder whose name starts with a vault's name is not in that vault", () => {
		expect(vaultOf(path.join(root, "outer-2/d.md"), known)).toBeNull();
	});

	test("a vault folder is its own vault, and a file not created yet still finds its vault", () => {
		expect(vaultOf(inner, known)).toBe(inner);
		expect(vaultOf(path.join(root, "outer/new folder/new.md"), known)).toBe(outer);
	});

	test("paths spelled through a symlink find the vault it leads to", () => {
		expect(vaultOf(path.join(root, "link/new folder/new.md"), known)).toBe(outer);
		expect(vaultOf(path.join(root, "outer/notes/a.md"), [path.join(root, "link")])).toBe(outer);
	});

	test("a known vault that no longer exists holds nothing", () => {
		expect(vaultOf(path.join(root, "gone/e.md"), [...known, path.join(root, "gone")])).toBeNull();
	});

	test("a relative path names no vault, whatever folder the app runs in", () => {
		const cwd = process.cwd();
		process.chdir(outer);
		try {
			expect(vaultOf("notes/a.md", known)).toBeNull();
		} finally {
			process.chdir(cwd);
		}
	});
});
