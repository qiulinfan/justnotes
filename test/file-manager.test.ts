import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { App } from "../src/api/app";
import { FileManager } from "../src/api/file-manager";
import { MetadataCache } from "../src/api/metadata";
import { TFile, Vault } from "../src/api/vault";

const open: { vault: Vault; dir: string }[] = [];

async function setup(files: Record<string, string>, config: Record<string, unknown> = { alwaysUpdateLinks: true }) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-fm-")));
	for (const [p, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
		fs.writeFileSync(path.join(dir, p), text);
	}
	const vault = new Vault(dir);
	const metadataCache = new MetadataCache(vault);
	await vault.load();
	for (const [k, v] of Object.entries(config)) vault.setConfig(k, v);
	await metadataCache.initialize();
	open.push({ vault, dir });
	const app = { vault, metadataCache, workspace: { getActiveFile: () => null } } as unknown as App;
	const read = (p: string) => fs.readFileSync(path.join(dir, p), "utf8");
	return { vault, metadataCache, fm: new FileManager(app), read, dir };
}

afterEach(() => {
	for (const { vault, dir } of open.splice(0)) {
		vault.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("FileManager.renameFile", () => {
	// All owner vaults set alwaysUpdateLinks; a rename must not break links.
	test("links, embeds, Markdown links and frontmatter links follow a renamed note, keeping subpath and alias", async () => {
		const { vault, fm, read } = await setup({
			"old.md": "# H\n",
			"src.md": '---\nup: "[[old]]"\n---\n[[old]] [[old#H|see]] ![[old#^b]] [md](old.md#H) `[[old]]` [[other]]',
		});
		await fm.renameFile(vault.getFileByPath("old.md")!, "dir/new name.md");
		expect(read("src.md")).toBe('---\nup: "[[new name]]"\n---\n[[new name]] [[new name#H|see]] ![[new name#^b]] [md](new%20name.md#H) `[[old]]` [[other]]');
	});

	test("a folder move rewrites links into it and the moved notes' relative links out of it", async () => {
		const { vault, fm, read } = await setup(
			{ "posts/a/x.md": "[pic](../img/p.png) [y](y.md)", "posts/a/y.md": "", "posts/img/p.png": "", "index.md": "[x](posts/a/x.md)" },
			{ alwaysUpdateLinks: true, useMarkdownLinks: true, newLinkFormat: "relative" },
		);
		await fm.renameFile(vault.getFolderByPath("posts/a")!, "archive/a");
		expect(read("archive/a/x.md")).toBe("[pic](../../posts/img/p.png) [y](y.md)");
		expect(read("index.md")).toBe("[x](archive/a/x.md)");
	});

	test("links that still reach the note after a move are left as written", async () => {
		const { vault, fm, read } = await setup({ "a/note.md": "", "src.md": "[[note]] [[a/note]]" });
		await fm.renameFile(vault.getFileByPath("a/note.md")!, "b/note.md");
		expect(read("src.md")).toBe("[[note]] [[note]]");
	});

	test("renaming onto an existing note fails and rewrites nothing", async () => {
		const { vault, fm, read } = await setup({ "a.md": "A", "b.md": "B", "src.md": "[[a]]" });
		await expect(fm.renameFile(vault.getFileByPath("a.md")!, "b.md")).rejects.toThrow("Destination file already exists!");
		expect([read("a.md"), read("b.md"), read("src.md")]).toEqual(["A", "B", "[[a]]"]);
	});
});

describe("FileManager.generateMarkdownLink", () => {
	test("wikilinks carry the subpath and a non-empty alias; attachments are embeds", async () => {
		const { vault, fm } = await setup({ "foo/bar.md": "", "img.png": "" });
		const bar = vault.getFileByPath("foo/bar.md")!;
		expect(fm.generateMarkdownLink(bar, "x.md", "#Head", "Shown")).toBe("[[bar#Head|Shown]]");
		expect(fm.generateMarkdownLink(bar, "x.md", "", "")).toBe("[[bar]]");
		expect(fm.generateMarkdownLink(vault.getFileByPath("img.png")!, "x.md")).toBe("![[img.png]]");
	});

	// QuickAdd passes a heading subpath; the '.md' must come before it.
	test("Markdown links encode the path, keep '.md' before the subpath and use the name for an empty alias", async () => {
		const { vault, fm } = await setup({ "foo/my bar.md": "", "other/my bar.md": "" }, { useMarkdownLinks: true });
		const bar = vault.getFileByPath("foo/my bar.md")!;
		expect(fm.generateMarkdownLink(bar, "x.md", "#A heading", "")).toBe("[my bar](foo/my%20bar.md#A%20heading)");
		vault.setConfig("newLinkFormat", "relative");
		expect(fm.generateMarkdownLink(bar, "other/x.md", "#^blk")).toBe("[my bar](../foo/my%20bar.md#^blk)");
	});
});

describe("FileManager.processFrontMatter", () => {
	test("keeps key order and line endings, and adds a block when there is none", async () => {
		const { vault, fm, read } = await setup({ "a.md": "---\r\nz: 1\r\na: old\r\n---\r\nbody\r\n", "b.md": "body" });
		await fm.processFrontMatter(vault.getFileByPath("a.md")!, (f) => {
			f.a = "new";
			f.m = null;
		});
		expect(read("a.md")).toBe("---\r\nz: 1\r\na: new\r\nm:\r\n---\r\nbody\r\n");
		await fm.processFrontMatter(vault.getFileByPath("b.md")!, (f) => {
			f.tags = ["x", "y"];
		});
		expect(read("b.md")).toBe("---\ntags:\n  - x\n  - y\n---\nbody");
	});

	test("an empty block is reused, an emptied block is removed, and no change means no write", async () => {
		const { vault, fm, read } = await setup({ "e.md": "---\n---\ntext\n\n---\nafter", "r.md": "---\nk: v\n---\nrest", "u.md": "---\nk: [a, b]\n---\n" });
		await fm.processFrontMatter(vault.getFileByPath("e.md")!, (f) => {
			f.k = 1;
		});
		expect(read("e.md")).toBe("---\nk: 1\n---\ntext\n\n---\nafter");
		await fm.processFrontMatter(vault.getFileByPath("r.md")!, (f) => {
			delete f.k;
		});
		expect(read("r.md")).toBe("rest");
		const modified: string[] = [];
		vault.on("modify", (f: TFile) => modified.push(f.path));
		await fm.processFrontMatter(vault.getFileByPath("u.md")!, (f) => {
			f.k = [...f.k];
		});
		expect(read("u.md")).toBe("---\nk: [a, b]\n---\n");
		expect(modified).toEqual([]);
	});

	test("invalid YAML throws and leaves the note unchanged", async () => {
		const { vault, fm, read } = await setup({ "bad.md": "---\nk: [1\n---\nx" });
		await expect(fm.processFrontMatter(vault.getFileByPath("bad.md")!, (f) => (f.k = 2))).rejects.toThrow();
		expect(read("bad.md")).toBe("---\nk: [1\n---\nx");
	});
});

describe("FileManager paths", () => {
	// The blogs vault stores attachments in './附件' next to each post.
	test("attachments go to a folder next to the note, created when missing, under a free name", async () => {
		const { vault, fm } = await setup({ "posts/p.md": "", "posts/附件/img.png": "" }, { attachmentFolderPath: "./附件" });
		expect(await fm.getAvailablePathForAttachment("img.png", "posts/p.md")).toBe("posts/附件/img 1.png");
		expect(await fm.getAvailablePathForAttachment("a.png", "notes/n.md")).toBe("notes/附件/a.png");
		expect(vault.getFolderByPath("notes/附件")).not.toBeNull();
	});

	test("newFileLocation 'current' uses the source path's folder; an empty source is the root", async () => {
		const { vault, fm } = await setup({ "a/b/n.md": "" }, { newFileLocation: "current" });
		expect(fm.getNewFileParent("a/b/n.md").path).toBe("a/b");
		expect(fm.getNewFileParent("").path).toBe("/");
		vault.setConfig("newFileLocation", "folder");
		vault.setConfig("newFileFolderPath", "a");
		expect(fm.getNewFileParent("a/b/n.md").path).toBe("a");
	});

	test("trashOption 'local' moves to .trash and 'none' deletes permanently", async () => {
		const { vault, fm, dir } = await setup({ "keep.md": "", "gone.md": "" }, { trashOption: "local" });
		await fm.trashFile(vault.getFileByPath("keep.md")!);
		vault.setConfig("trashOption", "none");
		await fm.trashFile(vault.getFileByPath("gone.md")!);
		expect(fs.readdirSync(path.join(dir, ".trash"))).toEqual(["keep.md"]);
		expect(fs.existsSync(path.join(dir, "gone.md"))).toBe(false);
	});
});
