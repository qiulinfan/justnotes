import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withoutVault } from "../src/cli/vaults";
import { createVaultFolder, tildePath, vaultFolderProblem, vaultNameProblem, vaultRows } from "../src/main/vault-switcher";

// The vault switcher's list, its new-vault names and the folders it accepts
// as vaults (main/vault-switcher.ts), and removing a vault from vaults.json.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jn-switcher-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("vaultRows", () => {
	const exists = (dir: string) => !dir.endsWith("gone");

	test("lists known and open vaults once each, by name, marking the current, open and missing ones", () => {
		const rows = vaultRows(["/v/notes", "/v/Blogs", "/v/gone"], ["/v/notes", "/w/work"], "/v/notes", exists);
		expect(rows.map((r) => [r.name, r.current, r.open, r.missing])).toEqual([
			["Blogs", false, false, false],
			["gone", false, false, true],
			["notes", true, true, false],
			["work", false, true, false],
		]);
	});

	test("vaults sharing a folder name are told apart by the folder above them", () => {
		const home = os.homedir();
		const rows = vaultRows([path.join(home, "a/notes"), "/srv/notes", "/srv/other"], [], null, exists);
		expect(rows.map((r) => r.label).sort()).toEqual([`notes (${path.join("~", "a")})`, "notes (/srv)", "other"].sort());
	});
});

test("tildePath shortens only paths under home", () => {
	expect(tildePath("/home/me/notes", "/home/me")).toBe(path.join("~", "notes"));
	expect(tildePath("/home/me", "/home/me")).toBe("~");
	expect(tildePath("/home/meadow/notes", "/home/me")).toBe("/home/meadow/notes");
});

describe("vaultNameProblem", () => {
	test("a plain name, in any script, is fine", () => {
		expect(vaultNameProblem("Notes 2026")).toBeNull();
		expect(vaultNameProblem("笔记")).toBeNull();
	});

	test("empty, padded, hidden, path-like and Windows-illegal names are refused", () => {
		for (const name of ["", "   ", " notes", "notes ", ".notes", "notes.", "a/b", "a\\b", "..", "a:b", "a?b"]) {
			expect(vaultNameProblem(name)).not.toBeNull();
		}
	});
});

describe("vaultFolderProblem", () => {
	const folder = path.join(root, "plain");
	const config = path.join(root, "vault/.obsidian/plugins");
	fs.mkdirSync(folder, { recursive: true });
	fs.mkdirSync(config, { recursive: true });
	fs.writeFileSync(path.join(root, "note.md"), "");
	fs.symlinkSync(config, path.join(root, "into-config"));

	test("an existing folder, with or without .obsidian, can be a vault", () => {
		expect(vaultFolderProblem(folder)).toBeNull();
		expect(vaultFolderProblem(path.join(root, "vault"))).toBeNull();
	});

	test("a missing path, a file, a relative path and the disk's root cannot", () => {
		expect(vaultFolderProblem(path.join(root, "nowhere"))).toContain("does not exist");
		expect(vaultFolderProblem(path.join(root, "note.md"))).toContain("not a folder");
		expect(vaultFolderProblem("plain")).not.toBeNull();
		expect(vaultFolderProblem(path.parse(root).root)).toContain("root");
	});

	test("a folder inside a vault's .obsidian, also through a symlink, cannot", () => {
		expect(vaultFolderProblem(config)).toContain(".obsidian");
		expect(vaultFolderProblem(path.join(root, "into-config"))).toContain(".obsidian");
	});
});

describe("createVaultFolder", () => {
	const parent = path.join(root, "parent");
	fs.mkdirSync(parent);

	test("makes an empty folder, without .obsidian, and returns its real path", () => {
		const made = createVaultFolder(parent, "New vault");
		expect(made).toEqual({ vault: path.join(parent, "New vault") });
		expect(fs.readdirSync(path.join(parent, "New vault"))).toEqual([]);
	});

	test("an existing folder or file of that name is left alone", () => {
		fs.mkdirSync(path.join(parent, "taken"));
		fs.writeFileSync(path.join(parent, "taken/keep.md"), "keep");
		expect(createVaultFolder(parent, "taken")).toHaveProperty("error");
		expect(fs.readFileSync(path.join(parent, "taken/keep.md"), "utf8")).toBe("keep");
	});

	test("a bad name or a missing location creates nothing", () => {
		expect(createVaultFolder(parent, "../escape")).toHaveProperty("error");
		expect(fs.existsSync(path.join(root, "escape"))).toBe(false);
		expect(createVaultFolder(path.join(root, "missing"), "x")).toHaveProperty("error");
		expect(fs.existsSync(path.join(root, "missing"))).toBe(false);
	});
});

test("withoutVault takes off a vault by real path, whatever spelling names it", () => {
	const a = path.join(root, "a");
	const b = path.join(root, "b");
	fs.mkdirSync(a);
	fs.mkdirSync(b);
	fs.symlinkSync(a, path.join(root, "a-link"));
	expect(withoutVault([a, b], path.join(root, "a-link"))).toEqual([b]);
	expect(withoutVault([a, b], path.join(root, "c"))).toEqual([a, b]);
	expect(fs.existsSync(a)).toBe(true);
});
