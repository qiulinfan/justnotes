import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { App } from "../src/api/app";
import { FileManager } from "../src/api/file-manager";
import { MetadataCache } from "../src/api/metadata";
import { parseTexMetadata, parseTextMetadata } from "../src/api/metadata-text";
import { TEXT_NOTE_INDEX_LIMIT } from "../src/api/note-files";
import { Vault } from "../src/api/vault";

// TeX and text files are notes in justnotes (api/note-files.ts): the
// metadata cache indexes them, links reach them and follow their renames.

const open: { vault: Vault; dir: string }[] = [];

async function setup(files: Record<string, string>) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-text-notes-")));
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
	return { vault, metadataCache, fm: new FileManager(app), read };
}

afterEach(() => {
	for (const { vault, dir } of open.splice(0)) {
		vault.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("parseTexMetadata", () => {
	test("sectioning commands are headings, the outermost at level 1; comments, verbatim and \\iffalse hide theirs", () => {
		const text = [
			"\\chapter{Linear $\\mathbb{R}^n$ maps}",
			"% \\section{Commented}",
			"\\section*[Short]{Kernel and \\emph{image}}",
			"\\begin{verbatim}",
			"\\section{Verbatim}",
			"\\end{verbatim}",
			"\\iffalse",
			"\\section{Skipped}",
			"\\fi",
			"\\subsection{Rank}",
		].join("\n");
		const headings = parseTexMetadata(text).headings!.map((h) => [h.heading, h.level, h.position.start.line]);
		expect(headings).toEqual([
			["Linear R^n maps", 1, 0],
			["Kernel and image", 2, 2],
			["Rank", 3, 9],
		]);
	});

	test("\\input, \\include, \\subfile and \\import are links; a name without an extension is a .tex file", () => {
		const text = "\\input{chapters/01-intro}\n\\include{appendix.tex}\n% \\input{old}\n\\import{parts/}{body}\n\\input{\\macro}";
		const links = parseTexMetadata(text).links!.map((l) => [l.link, l.position.start.line]);
		expect(links).toEqual([
			["chapters/01-intro.tex", 0],
			["appendix.tex", 1],
			["parts/body.tex", 3],
		]);
	});

	test("a text file's links are its wikilinks, embeds apart", () => {
		const meta = parseTextMetadata("see [[main.tex]] and [[Note#Part|that part]]\n![[fig.png]]");
		expect(meta.links!.map((l) => [l.link, l.displayText])).toEqual([
			["main.tex", "main.tex"],
			["Note#Part", "that part"],
		]);
		expect(meta.embeds!.map((l) => l.link)).toEqual(["fig.png"]);
	});
});

describe("TeX and text notes in the metadata cache", () => {
	test("wikilinks reach TeX files and count as backlinks; a TeX root links to its inputs; a text file's wikilinks resolve", async () => {
		const { vault, metadataCache } = await setup({
			"book/main.tex": "\\documentclass{book}\n\\begin{document}\n\\input{chapters/one}\n\\end{document}\n",
			"book/chapters/one.tex": "\\chapter{One}\n\\section{First}\n",
			"index.md": "[[main.tex]] and [[one.tex#First]]",
			"todo.txt": "read [[index]]",
		});
		expect(metadataCache.resolvedLinks["index.md"]).toEqual({ "book/main.tex": 1, "book/chapters/one.tex": 1 });
		expect(metadataCache.resolvedLinks["book/main.tex"]).toEqual({ "book/chapters/one.tex": 1 });
		expect(metadataCache.resolvedLinks["todo.txt"]).toEqual({ "index.md": 1 });
		expect(metadataCache.getBacklinksForFile(vault.getFileByPath("book/chapters/one.tex")!).keys().sort()).toEqual(["book/main.tex", "index.md"]);
		expect(metadataCache.getFileCache(vault.getFileByPath("book/chapters/one.tex")!)?.headings?.map((h) => h.heading)).toEqual(["One", "First"]);
	});

	test("a text file past the index limit is not read", async () => {
		const { vault, metadataCache } = await setup({ "data.txt": `[[index]]\n${"x".repeat(TEXT_NOTE_INDEX_LIMIT)}`, "index.md": "" });
		expect(metadataCache.getFileCache(vault.getFileByPath("data.txt")!)).toBeNull();
		expect(metadataCache.resolvedLinks["data.txt"]).toBeUndefined();
	});

	test("an edit to a TeX file re-reads its headings and links", async () => {
		const { vault, metadataCache } = await setup({ "a.tex": "\\section{Old}\n", "b.tex": "" });
		const a = vault.getFileByPath("a.tex")!;
		await vault.modify(a, "\\section{New}\n\\input{b}\n");
		await new Promise<void>((resolve) => metadataCache.onCleanCache(resolve));
		expect(metadataCache.getFileCache(a)?.headings?.map((h) => h.heading)).toEqual(["New"]);
		expect(metadataCache.resolvedLinks["a.tex"]).toEqual({ "b.tex": 1 });
	});
});

describe("renaming TeX files", () => {
	test("a renamed chapter: \\input keeps its style (no extension, root-relative), wikilinks to it follow", async () => {
		const { vault, fm, read } = await setup({
			"book/main.tex": "\\input{chapters/one}\n\\include{chapters/one.tex}\n",
			"book/chapters/two.tex": "\\input{chapters/one}\n",
			"book/chapters/one.tex": "\\section{One}\n",
			"index.md": "[[one.tex]]",
		});
		await fm.renameFile(vault.getFileByPath("book/chapters/one.tex")!, "book/parts/first.tex");
		expect(read("book/main.tex")).toBe("\\input{parts/first}\n\\include{parts/first.tex}\n");
		// A chapter's \input is relative to the root's folder, as TeX reads it.
		expect(read("book/chapters/two.tex")).toBe("\\input{parts/first}\n");
		expect(read("index.md")).toBe("[[first.tex]]");
	});

	test("a moved root document's inputs are rewritten relative to its new folder", async () => {
		const { vault, fm, read } = await setup({
			"book/main.tex": "\\input{chapters/one}\n",
			"book/chapters/one.tex": "",
		});
		await fm.renameFile(vault.getFileByPath("book/main.tex")!, "book/build/main.tex");
		expect(read("book/build/main.tex")).toBe("\\input{../chapters/one}\n");
	});
});
