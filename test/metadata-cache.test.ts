import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MetadataCache } from "../src/api/metadata";
import { Vault } from "../src/api/vault";

const open: { vault: Vault; dir: string }[] = [];

async function makeCache(files: Record<string, string>, config: Record<string, unknown> = {}) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-cache-")));
	for (const [p, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
		fs.writeFileSync(path.join(dir, p), text);
	}
	const vault = new Vault(dir);
	const cache = new MetadataCache(vault);
	await vault.load();
	for (const [k, v] of Object.entries(config)) vault.setConfig(k, v);
	open.push({ vault, dir });
	const events: string[] = [];
	cache.on("resolve", (f: { path: string }) => events.push(`resolve ${f.path}`));
	cache.on("resolved", () => events.push("resolved"));
	await cache.initialize();
	events.length = 0;
	return { vault, cache, events };
}

afterEach(() => {
	for (const { vault, dir } of open.splice(0)) {
		vault.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const settle = () => Bun.sleep(10);

describe("getFirstLinkpathDest", () => {
	test("a dotted name still resolves to the note with '.md' appended", async () => {
		const { cache } = await makeCache({ "songs/daisies.en.md": "", "Lecture 3.1.md": "" });
		expect(cache.getFirstLinkpathDest("daisies.en", "x.md")?.path).toBe("songs/daisies.en.md");
		expect(cache.getFirstLinkpathDest("Lecture 3.1", "x.md")?.path).toBe("Lecture 3.1.md");
	});

	test("matching ignores case, and an empty linkpath is the source note", async () => {
		const { cache } = await makeCache({ "Folder/Note.md": "", "src.md": "" });
		expect(cache.getFirstLinkpathDest("folder/NOTE", "src.md")?.path).toBe("Folder/Note.md");
		expect(cache.getFirstLinkpathDest("note", "src.md")?.path).toBe("Folder/Note.md");
		expect(cache.getFirstLinkpathDest("", "src.md")?.path).toBe("src.md");
	});

	// d.ts: getFirstLinkpathDest('foo/bar', 'baz/qux.md') prefers 'baz/foo/bar.md'.
	test("a path relative to the source folder wins, then the vault path, then any matching suffix", async () => {
		const { cache } = await makeCache({ "baz/foo/bar.md": "", "foo/bar.md": "", "deep/path/foo/baz.md": "" });
		expect(cache.getFirstLinkpathDest("foo/bar", "baz/qux.md")?.path).toBe("baz/foo/bar.md");
		expect(cache.getFirstLinkpathDest("foo/bar", "other/qux.md")?.path).toBe("foo/bar.md");
		expect(cache.getFirstLinkpathDest("foo/baz", "other/qux.md")?.path).toBe("deep/path/foo/baz.md");
		expect(cache.getFirstLinkpathDest("../foo/bar", "baz/qux.md")?.path).toBe("foo/bar.md");
	});

	// The notes vault has dozens of notes named review.md, one per source folder.
	test("among notes that share a name, one in the source's folder wins, then the shortest path, then the first by name", async () => {
		const { cache } = await makeCache({ "z/sub/review.md": "", "qq/sub/review.md": "", "b/sub/review.md": "", "a/deeper/review.md": "" });
		expect(cache.getFirstLinkpathDest("sub/review", "qq/sub/x.md")?.path).toBe("qq/sub/review.md");
		expect(cache.getLinkpathDest("sub/review", "qq/sub/x.md").map((f) => f.path)).toEqual(["qq/sub/review.md", "b/sub/review.md", "z/sub/review.md"]);
		expect(cache.getFirstLinkpathDest("sub/review", "c/x.md")?.path).toBe("b/sub/review.md");
		expect(cache.getFirstLinkpathDest("review", "c/x.md")?.path).toBe("b/sub/review.md");
		expect(cache.getLinkpathDest("review", "c/x.md").map((f) => f.path)).toEqual(["b/sub/review.md", "z/sub/review.md", "qq/sub/review.md", "a/deeper/review.md"]);
	});
});

describe("fileToLinktext", () => {
	test("shortest gives the name when no other file has it, regardless of case", async () => {
		const { cache, vault } = await makeCache({ "a/Note.md": "", "b/note.md": "", "a/unique.md": "", "img.png": "" });
		expect(cache.fileToLinktext(vault.getFileByPath("a/unique.md")!, "x.md")).toBe("unique");
		expect(cache.fileToLinktext(vault.getFileByPath("a/Note.md")!, "x.md")).toBe("a/Note");
		expect(cache.fileToLinktext(vault.getFileByPath("a/unique.md")!, "x.md", false)).toBe("unique.md");
		expect(cache.fileToLinktext(vault.getFileByPath("img.png")!, "x.md")).toBe("img.png");
	});

	test("relative and absolute formats follow newLinkFormat", async () => {
		const { cache, vault } = await makeCache({ "posts/a/x.md": "", "posts/b/y.md": "" });
		const x = vault.getFileByPath("posts/a/x.md")!;
		vault.setConfig("newLinkFormat", "relative");
		expect(cache.fileToLinktext(x, "posts/b/y.md")).toBe("../a/x");
		expect(cache.fileToLinktext(x, "posts/a/z.md", false)).toBe("x.md");
		vault.setConfig("newLinkFormat", "absolute");
		expect(cache.fileToLinktext(x, "posts/b/y.md")).toBe("posts/a/x");
	});
});

describe("incremental resolution", () => {
	// QuickAdd rebuilds its unresolved-link suggestions on 'resolved'.
	test("creating a note resolves other notes' links to it, and deleting it unresolves them", async () => {
		const { cache, vault, events } = await makeCache({ "a.md": "see [[Later]] and [[Later#h]]" });
		expect(cache.unresolvedLinks["a.md"]).toEqual({ Later: 2 });
		await vault.create("sub/later.md", "");
		await settle();
		expect(cache.resolvedLinks["a.md"]).toEqual({ "sub/later.md": 2 });
		expect(cache.unresolvedLinks["a.md"]).toEqual({});
		expect(events).toContain("resolve a.md");
		expect(events.filter((e) => e === "resolved")).toHaveLength(1);
		events.length = 0;
		const deleted: (string | null)[] = [];
		cache.on("deleted", (_f: unknown, prev: unknown) => deleted.push(prev ? "had cache" : null));
		await vault.delete(vault.getFileByPath("sub/later.md")!);
		await settle();
		expect(cache.unresolvedLinks["a.md"]).toEqual({ Later: 2 });
		expect(cache.resolvedLinks["a.md"]).toEqual({});
		expect(deleted).toEqual(["had cache"]);
		expect(events).toContain("resolved");
	});

	test("a folder rename keeps every child's cache and moves the link maps to the new paths", async () => {
		const { cache, vault } = await makeCache({ "f/x.md": "[[y]] #in-f", "f/y.md": "", "out.md": "[[f/x]]" });
		await vault.rename(vault.getFolderByPath("f")!, "g");
		await settle();
		expect(cache.getFileCache(vault.getFileByPath("g/x.md")!)?.tags?.[0].tag).toBe("#in-f");
		expect(cache.getCache("f/x.md")).toBeNull();
		expect(cache.resolvedLinks["g/x.md"]).toEqual({ "g/y.md": 1 });
		expect(cache.resolvedLinks["f/x.md"]).toBeUndefined();
		// 'f/x' no longer names a file, so the outside link is unresolved now.
		expect(cache.unresolvedLinks["out.md"]).toEqual({ "f/x": 1 });
		expect(cache.getBacklinksForFile(vault.getFileByPath("g/y.md")!).keys()).toEqual(["g/x.md"]);
	});

	// Backlinks and the graph read these maps: a renamed-in note must show its
	// links at once, a renamed-out one must stop counting as a note.
	test("a file renamed to a note is read, and a note renamed to another type drops its cache and links", async () => {
		const { cache, vault } = await makeCache({ "a.txt": "[[b]] #t", "c.md": "[[b]]", "b.md": "" });
		await vault.rename(vault.getFileByPath("a.txt")!, "a.md");
		await vault.rename(vault.getFileByPath("c.md")!, "c.txt");
		await settle();
		expect(cache.getCache("a.md")?.tags?.[0].tag).toBe("#t");
		expect(cache.resolvedLinks["a.md"]).toEqual({ "b.md": 1 });
		expect(cache.getCache("c.txt")).toBeNull();
		expect(cache.resolvedLinks["c.txt"]).toBeUndefined();
		expect(cache.getBacklinksForFile(vault.getFileByPath("b.md")!).keys()).toEqual(["a.md"]);
	});

	test("frontmatter links count as links", async () => {
		const { cache } = await makeCache({ "a.md": '---\nup: "[[b]]"\n---\n', "b.md": "" });
		expect(cache.resolvedLinks["a.md"]).toEqual({ "b.md": 1 });
	});
});

describe("MetadataCache startup and tags", () => {
	test("initialize() resolves once every note is parsed, and fires 'resolved' once", async () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-cache-")));
		for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(dir, `n${i}.md`), `# N${i}\n[[n${(i + 1) % 120}]]`);
		const vault = new Vault(dir);
		open.push({ vault, dir });
		const cache = new MetadataCache(vault);
		await vault.load();
		let resolvedCount = 0;
		cache.on("resolved", () => resolvedCount++);
		await cache.initialize();
		await settle();
		expect(vault.getMarkdownFiles().every((f) => cache.getFileCache(f)?.headings?.length === 1)).toBe(true);
		expect(cache.resolvedLinks["n119.md"]).toEqual({ "n0.md": 1 });
		expect(resolvedCount).toBe(1);
	});

	test("getTags counts frontmatter and body tags, merging spellings that differ in case", async () => {
		const { cache } = await makeCache({ "a.md": "---\ntags: [Project, solo]\n---\n#project", "b.md": "#project/sub" });
		expect(cache.getTags()).toEqual({ "#Project": 2, "#solo": 1, "#project/sub": 1 });
	});
});
