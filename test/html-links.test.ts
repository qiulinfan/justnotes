import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { App } from "../src/api/app";
import { FileManager } from "../src/api/file-manager";
import { htmlMediaSrcs, rewrittenSrc, srcVaultPath } from "../src/api/html-links";
import { MetadataCache } from "../src/api/metadata";
import { Vault } from "../src/api/vault";

const open: { vault: Vault; dir: string }[] = [];

async function setup(files: Record<string, string>) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-html-")));
	for (const [p, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
		fs.writeFileSync(path.join(dir, p), text);
	}
	const vault = new Vault(dir);
	const metadataCache = new MetadataCache(vault);
	await vault.load();
	vault.setConfig("alwaysUpdateLinks", true);
	await metadataCache.initialize();
	open.push({ vault, dir });
	const app = { vault, metadataCache, workspace: { getActiveFile: () => null } } as unknown as App;
	const read = (p: string) => fs.readFileSync(path.join(dir, p), "utf8");
	return { vault, fm: new FileManager(app), read };
}

afterEach(() => {
	for (const { vault, dir } of open.splice(0)) {
		vault.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// Typora's <img src> paths keep working when images or notes move.
describe("renameFile and raw HTML srcs", () => {
	const note = [
		'<img src="note-assets/a b.png" alt="a b" style="zoom:50%;" />',
		"<img src='note-assets/a%20b.png'>",
		'<img src="note-assets\\a b.png">',
		"`<img src=\"note-assets/a b.png\">`",
		"```",
		'<img src="note-assets/a b.png">',
		"```",
		'<img src="/Users/someone/note-assets/a b.png">',
		'<img src="old/a b.png">',
	].join("\n");

	test("renaming an image rewrites the srcs that named it, as each was written, and leaves code, absolute and loose paths", async () => {
		const { vault, fm, read } = await setup({ "sub/note.md": note, "sub/note-assets/a b.png": "", "other.md": '<img src="sub/note-assets/a b.png">' });
		await fm.renameFile(vault.getFileByPath("sub/note-assets/a b.png")!, "sub/note-assets/c d.png");
		expect(read("sub/note.md").split("\n")).toEqual([
			'<img src="note-assets/c d.png" alt="a b" style="zoom:50%;" />',
			"<img src='note-assets/c%20d.png'>",
			'<img src="note-assets\\c d.png">',
			"`<img src=\"note-assets/a b.png\">`",
			"```",
			'<img src="note-assets/a b.png">',
			"```",
			'<img src="/Users/someone/note-assets/a b.png">',
			'<img src="old/a b.png">',
		]);
		expect(read("other.md")).toBe('<img src="sub/note-assets/c d.png">');
	});

	test("moving an image to another folder writes the new relative path", async () => {
		const { vault, fm, read } = await setup({ "sub/note.md": '<img src="note-assets/a b.png" />', "sub/note-assets/a b.png": "", "Assets/.keep": "" });
		await fm.renameFile(vault.getFileByPath("sub/note-assets/a b.png")!, "Assets/a b.png");
		expect(read("sub/note.md")).toBe('<img src="../Assets/a b.png" />');
	});

	test("moving a note rewrites its own relative srcs; moving a folder holding both changes nothing", async () => {
		const { vault, fm, read } = await setup({ "sub/note.md": '<img src="note-assets/x.png">', "sub/note-assets/x.png": "" });
		await fm.renameFile(vault.getFileByPath("sub/note.md")!, "deep/er/note.md");
		expect(read("deep/er/note.md")).toBe('<img src="../../sub/note-assets/x.png">');
		await fm.renameFile(vault.getFileByPath("deep/er/note.md")!, "sub/note.md");
		expect(read("sub/note.md")).toBe('<img src="note-assets/x.png">');
		await fm.renameFile(vault.getAbstractFileByPath("sub")!, "moved");
		expect(read("moved/note.md")).toBe('<img src="note-assets/x.png">');
	});
});

describe("html-links helpers", () => {
	test("srcVaultPath reads Typora's paths and refuses URLs and absolute paths", () => {
		expect(srcVaultPath("note-assets\\{A}.png", "c/n.md")).toBe("c/note-assets/{A}.png");
		expect(srcVaultPath("./x%20y.png", "n.md")).toBe("x y.png");
		expect(srcVaultPath("../../x.png", "a/n.md")).toBe(null);
		expect(srcVaultPath("https://e.com/x.png", "n.md")).toBe(null);
		expect(srcVaultPath("/Users/me/x.png", "n.md")).toBe(null);
	});

	test("rewrittenSrc keeps a leading ./ and %-escapes", () => {
		expect(rewrittenSrc("./a.png", "n.md", "b c.png")).toBe("./b c.png");
		expect(rewrittenSrc("a%20b.png", "x/n.md", "y/b c.png")).toBe("../y/b%20c.png");
	});

	test("htmlMediaSrcs gives the value's place for video and source tags too", () => {
		const text = '<video src="v.mp4"></video><source src=s.webm>';
		expect(htmlMediaSrcs(text).map((s) => [s.value, text.slice(s.from, s.to)])).toEqual([
			["v.mp4", "v.mp4"],
			["s.webm", "s.webm"],
		]);
	});
});
