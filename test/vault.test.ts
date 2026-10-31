import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TAbstractFile, TFile, TFolder, Vault } from "../src/api/vault";

const open: { vault: Vault; dir: string }[] = [];

async function makeVault(files: Record<string, string> = {}) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-vault-")));
	for (const [p, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
		fs.writeFileSync(path.join(dir, p), text);
	}
	const vault = new Vault(dir);
	await vault.load();
	open.push({ vault, dir });
	const events: string[] = [];
	for (const name of ["create", "modify", "delete", "rename"]) {
		vault.on(name, (f: TAbstractFile, old?: string) => events.push(old ? `${name} ${f.path} <- ${old}` : `${name} ${f.path}`));
	}
	return { vault, dir, events, full: (p: string) => path.join(dir, p) };
}

afterEach(() => {
	for (const { vault, dir } of open.splice(0)) {
		vault.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

async function until(check: () => boolean, ms = 3000) {
	for (let t = 0; t < ms && !check(); t += 20) await Bun.sleep(20);
	return check();
}

// Every path in the vault's file tree, sorted.
function tree(vault: Vault) {
	const paths: string[] = [];
	Vault.recurseChildren(vault.getRoot(), (f) => paths.push(f.path));
	return paths.sort();
}

describe("FileSystemAdapter listing", () => {
	// Plugins.loadManifests reads only `folders`; a plugin symlinked into the
	// vault (the usual dev setup) must be found.
	test("a symlinked folder is listed as a folder", async () => {
		const { vault, dir } = await makeVault({ "repo/manifest.json": "{}" });
		fs.mkdirSync(path.join(dir, ".obsidian/plugins"), { recursive: true });
		fs.symlinkSync(path.join(dir, "repo"), path.join(dir, ".obsidian/plugins/linked"));
		const listed = await vault.adapter.list(".obsidian/plugins");
		expect(listed.folders).toEqual([".obsidian/plugins/linked"]);
		expect(listed.files).toEqual([]);
	});

	// A link back to an ancestor would make the tree infinite; a link elsewhere is part of the vault.
	test("a symlinked folder joins the vault unless it points at an ancestor", async () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-vault-")));
		fs.mkdirSync(path.join(dir, "notes/real"), { recursive: true });
		fs.writeFileSync(path.join(dir, "notes/real/a.md"), "a");
		fs.symlinkSync("real", path.join(dir, "notes/alias"));
		fs.symlinkSync("..", path.join(dir, "notes/up"));
		const vault = new Vault(dir);
		open.push({ vault, dir });
		await vault.load();
		expect(vault.getFileByPath("notes/alias/a.md")).toBeInstanceOf(TFile);
		expect(vault.getAbstractFileByPath("notes/up")).toBeNull();
	});
});

describe("Vault folder operations", () => {
	// Plugins index files by path and handle only TFile events, so each
	// descendant needs its own event; handlers must see the moved tree.
	test("a folder rename fires 'rename' for the folder and each descendant with its old path", async () => {
		const { vault, events } = await makeVault({ "a/b/n.md": "n", "a/x.md": "x" });
		const seen: (string | null)[] = [];
		vault.on("rename", (f: TAbstractFile) => seen.push(vault.getAbstractFileByPath(f.path)?.path ?? null));
		await vault.rename(vault.getAbstractFileByPath("a")!, "c");
		expect(events.sort()).toEqual(["rename c <- a", "rename c/b <- a/b", "rename c/b/n.md <- a/b/n.md", "rename c/x.md <- a/x.md"]);
		expect(seen).not.toContain(null);
		expect(vault.getAbstractFileByPath("a/x.md")).toBeNull();
	});

	test("moving a file into a folder that does not exist yet keeps one file and fires one rename", async () => {
		const { vault, events } = await makeVault({ "n.md": "n" });
		const file = vault.getFileByPath("n.md")!;
		await vault.rename(file, "new/dir/n.md");
		expect(events).toEqual(["create new", "create new/dir", "rename new/dir/n.md <- n.md"]);
		expect(vault.getFolderByPath("new/dir")!.children).toEqual([file]);
		expect(vault.getFiles()).toEqual([file]);
	});

	test("deleting a folder fires 'delete' for every descendant before the folder", async () => {
		const { vault, events, full } = await makeVault({ "a/b/n.md": "n", "a/x.md": "x" });
		await vault.delete(vault.getAbstractFileByPath("a")!, true);
		expect(events.indexOf("delete a")).toBe(3);
		expect(events.indexOf("delete a/b")).toBeGreaterThan(events.indexOf("delete a/b/n.md"));
		expect(events.sort()).toEqual(["delete a", "delete a/b", "delete a/b/n.md", "delete a/x.md"]);
		expect(fs.existsSync(full("a"))).toBe(false);
	});

	// Without force, hidden files keep their folder instead of being deleted unseen.
	test("deleting a folder without force refuses to remove hidden leftovers", async () => {
		const { vault, full } = await makeVault({ "a/n.md": "n", "a/.hidden": "h", "b/n.md": "n" });
		await expect(vault.delete(vault.getAbstractFileByPath("a")!)).rejects.toThrow();
		expect(fs.existsSync(full("a/.hidden"))).toBe(true);
		await vault.delete(vault.getAbstractFileByPath("b")!);
		expect(fs.existsSync(full("b"))).toBe(false);
		expect(vault.getAbstractFileByPath("b")).toBeNull();
	});

	test("rmdir without recursive removes an empty folder and refuses a non-empty one", async () => {
		const { vault, full } = await makeVault({ "full/n.md": "n" });
		fs.mkdirSync(full("empty"));
		await vault.adapter.rmdir("empty", false);
		expect(fs.existsSync(full("empty"))).toBe(false);
		await expect(vault.adapter.rmdir("full", false)).rejects.toThrow();
	});
});

describe("Vault collisions", () => {
	test("renaming onto an existing file fails and keeps both files", async () => {
		const { vault, full } = await makeVault({ "a.md": "A", "b.md": "B" });
		await expect(vault.rename(vault.getFileByPath("a.md")!, "b.md")).rejects.toThrow("Destination file already exists!");
		await expect(vault.adapter.rename("a.md", "b.md")).rejects.toThrow("Destination file already exists!");
		expect(fs.readFileSync(full("b.md"), "utf8")).toBe("B");
		expect(vault.getRoot().children.map((f) => f.path).sort()).toEqual(["a.md", "b.md"]);
	});

	// Hidden paths are not in the index; the disk says they exist.
	test("creating, copying or renaming onto an existing hidden path fails and keeps its bytes", async () => {
		const { vault, full } = await makeVault({ ".obsidian/x.json": "keep", ".obsidian/bin": "bin", "a.md": "A" });
		fs.mkdirSync(full(".obsidian/dir"));
		await expect(vault.create(".obsidian/x.json", "new")).rejects.toThrow("File already exists.");
		await expect(vault.createBinary(".obsidian/bin", new ArrayBuffer(2))).rejects.toThrow("File already exists.");
		await expect(vault.createFolder(".obsidian/dir")).rejects.toThrow("Folder already exists.");
		await expect(vault.copy(vault.getFileByPath("a.md")!, ".obsidian/x.json")).rejects.toThrow("File already exists.");
		await expect(vault.rename(vault.getFileByPath("a.md")!, ".obsidian/x.json")).rejects.toThrow("already exists");
		expect(fs.readFileSync(full(".obsidian/x.json"), "utf8")).toBe("keep");
		expect(fs.readFileSync(full(".obsidian/bin"), "utf8")).toBe("bin");
		expect(fs.readFileSync(full("a.md"), "utf8")).toBe("A");
		const made = await vault.create(".obsidian/new.json", "{}");
		expect(made.path).toBe(".obsidian/new.json");
		expect(fs.readFileSync(full(".obsidian/new.json"), "utf8")).toBe("{}");
	});

	test("on a case-insensitive volume a case variant cannot be created but a case-only rename works", async () => {
		const { vault, full } = await makeVault({ "Note.md": "N" });
		if (!vault.adapter.insensitive) return;
		await expect(vault.create("note.md", "x")).rejects.toThrow("File already exists.");
		expect(fs.readFileSync(full("Note.md"), "utf8")).toBe("N");
		await vault.rename(vault.getFileByPath("Note.md")!, "note.md");
		expect(fs.readdirSync(vault.adapter.basePath)).toContain("note.md");
		expect(vault.getFileByPath("note.md")).toBeInstanceOf(TFile);
		expect(vault.getFileByPath("Note.md")).toBeNull();
		expect(await vault.adapter.exists("NOTE.md", true)).toBe(false);
		expect(await vault.adapter.exists("NOTE.md")).toBe(true);
	});

	// The owner's APFS volume ignores case: 'Daily/x.md' is a file in 'daily'.
	// A second spelling of the folder would list its files twice, and deleting
	// one of those copies would delete the real file.
	test("on a case-insensitive volume a new path goes into the folder spelled in another case", async () => {
		const { vault, events } = await makeVault({ "daily/old.md": "o" });
		if (!vault.adapter.insensitive) return;
		expect((await vault.create("Daily/new.md", "n")).path).toBe("daily/new.md");
		expect((await vault.createFolder("DAILY/sub")).path).toBe("daily/sub");
		await vault.adapter.write("Daily/sub/w.md", "w");
		expect(vault.getAvailablePath("DAILY/sub/w", "md")).toBe("daily/sub/w 1.md");
		await Bun.sleep(300);
		expect(tree(vault)).toEqual(["/", "daily", "daily/new.md", "daily/old.md", "daily/sub", "daily/sub/w.md"]);
		expect(events).toEqual(["create daily/new.md", "create daily/sub", "create daily/sub/w.md"]);
	});

	test("a case-only folder rename leaves no copy under the old spelling", async () => {
		const { vault, events, full } = await makeVault({ "CaseThree/a.md": "a", "CaseThree/b.md": "b" });
		if (!vault.adapter.insensitive) return;
		const write = vault.modify(vault.getFileByPath("CaseThree/a.md")!, "edited");
		await Promise.all([write, vault.rename(vault.getFolderByPath("CaseThree")!, "casethree")]);
		// The watcher may still report the old spelling afterwards.
		await vault.adapter.reconcileFile("CaseThree/b.md", "CaseThree/b.md");
		const renamed = ["/", "casethree", "casethree/a.md", "casethree/b.md"];
		expect(tree(vault)).toEqual(renamed);
		await Bun.sleep(300);
		expect(tree(vault)).toEqual(renamed);
		expect(events.filter((e) => !e.startsWith("rename"))).toEqual(["modify CaseThree/a.md"]);
		expect(fs.readFileSync(full("casethree/a.md"), "utf8")).toBe("edited");
	});

	test("copy refuses an existing destination and vault.copy keeps binary bytes", async () => {
		const { vault, full } = await makeVault({ "a.md": "A", "b.md": "B" });
		await expect(vault.adapter.copy("a.md", "b.md")).rejects.toThrow();
		expect(fs.readFileSync(full("b.md"), "utf8")).toBe("B");
		const bytes = new Uint8Array([0, 255, 128, 10, 13, 0xc3]);
		const img = await vault.createBinary("img.bin", bytes.buffer);
		const copy = await vault.copy(img, "copy.bin");
		expect(copy).toBeInstanceOf(TFile);
		expect([...fs.readFileSync(full("copy.bin"))]).toEqual([...bytes]);
	});
});

describe("Vault change reconciliation", () => {
	// obsidian-git's diff view writes through the adapter and expects the vault to know.
	test("an adapter write to a visible path is in the vault when it resolves, with one 'create'", async () => {
		const { vault, events } = await makeVault();
		await vault.adapter.write("new/n.md", "x");
		expect(vault.getFileByPath("new/n.md")).toBeInstanceOf(TFile);
		await Bun.sleep(300);
		expect(events).toEqual(["create new", "create new/n.md"]);
	});

	test("two watcher events for one new path create the file once", async () => {
		const { vault, events, full } = await makeVault();
		fs.writeFileSync(full("ext.md"), "e");
		await Promise.all([vault.adapter.reconcileFile("ext.md", "ext.md"), vault.adapter.reconcileFile("ext.md", "ext.md")]);
		expect(events.filter((e) => e === "create ext.md")).toHaveLength(1);
		expect(vault.getRoot().children.filter((f) => f.path === "ext.md")).toHaveLength(1);
	});

	// The vault rescans after its watcher fails, and kgdistiller rescans its hidden folder.
	test("a rescan drops what left the disk, folder contents first, and adds what arrived", async () => {
		const { vault, events, full } = await makeVault({ "keep/k.md": "k", "gone/sub/n.md": "n", "gone/m.md": "m", "old.md": "o" });
		fs.rmSync(full("gone"), { recursive: true });
		fs.rmSync(full("old.md"));
		fs.writeFileSync(full("keep/new.md"), "new");
		await vault.adapter.listRecursive("");
		expect(tree(vault)).toEqual(["/", "keep", "keep/k.md", "keep/new.md"]);
		expect(events.indexOf("delete gone")).toBeGreaterThan(events.indexOf("delete gone/sub"));
		expect(events.indexOf("delete gone/sub")).toBeGreaterThan(events.indexOf("delete gone/sub/n.md"));
		expect(events.sort()).toEqual(["create keep/new.md", "delete gone", "delete gone/m.md", "delete gone/sub", "delete gone/sub/n.md", "delete old.md"]);
	});

	test("a folder created outside the app announces itself and every file in it", async () => {
		const { vault, events, full } = await makeVault();
		fs.mkdirSync(full("pulled/sub"), { recursive: true });
		fs.writeFileSync(full("pulled/sub/n.md"), "n");
		fs.writeFileSync(full("pulled/m.md"), "m");
		await vault.adapter.reconcileFile("pulled", "pulled");
		expect(events.sort()).toEqual(["create pulled", "create pulled/m.md", "create pulled/sub", "create pulled/sub/n.md"]);
	});

	// An editor or git replacing a file by delete-then-create must not close it.
	test("a file deleted and recreated within the grace period reads as one modification", async () => {
		const { vault, events, full } = await makeVault({ "n.md": "old" });
		fs.unlinkSync(full("n.md"));
		await vault.adapter.reconcileFile("n.md", "n.md");
		fs.writeFileSync(full("n.md"), "new text");
		await Bun.sleep(150);
		expect(events).toEqual(["modify n.md"]);
		expect(await vault.cachedRead(vault.getFileByPath("n.md")!)).toBe("new text");
	});

	test("the watcher reports changes in hidden folders as 'raw' and keeps them out of the tree", async () => {
		const { vault, full } = await makeVault();
		const raw: string[] = [];
		vault.on("raw", (p: string) => raw.push(p));
		fs.mkdirSync(full(".obsidian/plugins/p"), { recursive: true });
		fs.writeFileSync(full(".obsidian/plugins/p/data.json"), "{}");
		expect(await until(() => raw.includes(".obsidian/plugins/p/data.json"))).toBe(true);
		expect(vault.getAbstractFileByPath(".obsidian")).toBeNull();
	});

	test("a file stored under a decomposed Unicode name is found by its NFC path", async () => {
		const nfd = "café.md";
		const { vault, full } = await makeVault({ [nfd]: "accent" });
		const file = vault.getFileByPath("café.md");
		expect(file).toBeInstanceOf(TFile);
		expect(fs.existsSync(full(nfd))).toBe(true);
		expect(await vault.read(file!)).toBe("accent");
	});
});

describe("Vault hooks", () => {
	// kgdistiller swaps these two methods to index its hidden .knowledge folder.
	test("wrappers installed on listRecursiveChild and reconcileFile index a hidden folder", async () => {
		const { vault, full } = await makeVault({ ".knowledge/entries/r.md": "r", "n.md": "n" });
		const adapter = vault.adapter;
		const originalList = adapter.listRecursiveChild;
		const originalReconcile = adapter.reconcileFile;
		const under = (p: string) => p === ".knowledge" || p.startsWith(".knowledge/");
		adapter.listRecursiveChild = async (parent: string, name: string) => {
			const p = parent ? `${parent}/${name}` : name;
			if (!under(p)) return originalList.call(adapter, parent, name);
			await adapter.reconcileFileInternal(p, p);
		};
		adapter.reconcileFile = async (real: string, norm: string, skip?: boolean) => {
			if (!under(norm)) return originalReconcile.call(adapter, real, norm, skip);
			await adapter.reconcileFileInternal(real, norm);
		};
		await adapter.reconcileFileInternal(".knowledge", ".knowledge");
		expect(vault.getMarkdownFiles().map((f) => f.path).sort()).toEqual([".knowledge/entries/r.md", "n.md"]);
		expect(adapter.files[".knowledge/entries"].type).toBe("folder");
		await adapter.write(".knowledge/entries/s.md", "s");
		expect(vault.getFileByPath(".knowledge/entries/s.md")).toBeInstanceOf(TFile);
		fs.rmSync(full(".knowledge/entries/r.md"));
		await adapter.reconcileDeletion(".knowledge/entries/r.md", ".knowledge/entries/r.md", true);
		expect(vault.getFileByPath(".knowledge/entries/r.md")).toBeNull();
	});
});

describe("Vault files", () => {
	test("trash falls back to the local trash and never overwrites an earlier trashed file", async () => {
		const { vault, full, events } = await makeVault({ "a/n.md": "first", "b/n.md": "second" });
		await vault.trash(vault.getFileByPath("a/n.md")!, true);
		await vault.trash(vault.getFileByPath("b/n.md")!, false);
		expect(fs.readFileSync(full(".trash/n.md"), "utf8")).toBe("first");
		expect(fs.readFileSync(full(".trash/n 1.md"), "utf8")).toBe("second");
		expect(events).toEqual(["delete a/n.md", "delete b/n.md"]);
	});

	// Live Preview compares image src to decide whether to rebuild the widget.
	test("getResourcePath is stable until the file changes and escapes '#' and '?'", async () => {
		const { vault } = await makeVault({ "img #1?.png": "x" });
		const file = vault.getFileByPath("img #1?.png")!;
		const first = vault.getResourcePath(file);
		expect(vault.getResourcePath(file)).toBe(first);
		expect(first).toContain("img%20%231%3F.png?");
		await Bun.sleep(5);
		await vault.modifyBinary(file, new Uint8Array([1, 2]).buffer);
		expect(vault.getResourcePath(file)).not.toBe(first);
	});

	test("cachedRead serves the last read until the file changes on disk", async () => {
		const { vault, full } = await makeVault({ "n.md": "one" });
		const file = vault.getFileByPath("n.md")!;
		expect(await vault.cachedRead(file)).toBe("one");
		fs.writeFileSync(full("n.md"), "two!");
		expect(await vault.cachedRead(file)).toBe("one");
		await vault.adapter.reconcileFile("n.md", "n.md");
		expect(await vault.cachedRead(file)).toBe("two!");
	});

	test("a write with an mtime option sets the file's modification time and stat", async () => {
		const { vault, full } = await makeVault();
		const mtime = Date.UTC(2020, 0, 2);
		const file = await vault.create("n.md", "x", { mtime, ctime: Date.UTC(2019, 0, 1) });
		expect(Math.round(fs.statSync(full("n.md")).mtimeMs)).toBe(mtime);
		expect(file.stat.mtime).toBe(mtime);
		expect(file.stat.ctime).toBe(Date.UTC(2019, 0, 1));
	});

	test("recurseChildren visits a folder before its children, in order", async () => {
		const { vault } = await makeVault();
		await vault.createFolder("f");
		await vault.create("f/1.md", "");
		await vault.create("f/2.md", "");
		const order: string[] = [];
		Vault.recurseChildren(vault.getFolderByPath("f")!, (f) => order.push(f.path));
		expect(order).toEqual(["f", "f/1.md", "f/2.md"]);
	});
});

test("folders created through the vault are TFolders in the tree", async () => {
	const { vault } = await makeVault();
	const folder = await vault.createFolder("x/y");
	expect(folder).toBeInstanceOf(TFolder);
	expect(vault.getFolderByPath("x")!.children).toContain(folder);
	await expect(vault.createFolder("x/y")).rejects.toThrow("Folder already exists.");
});
