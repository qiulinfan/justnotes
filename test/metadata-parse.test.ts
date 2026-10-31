import { describe, expect, test } from "bun:test";
import { parseMetadata } from "../src/api/metadata";
import { getAllTags, getFrontMatterInfo, parseFrontMatterAliases, parseFrontMatterStringArray, parseFrontMatterTags, resolveSubpath, stripHeadingForLink } from "../src/api/metadata-utils";

const lines = (p: { start: { line: number }; end: { line: number } }) => [p.start.line, p.end.line];

describe("parseMetadata sections", () => {
	// Plugins slice notes by section (block embeds, getSectionInfo, outlines).
	test("each root block is one section spanning all its lines", () => {
		const c = parseMetadata(
			["---", "a: 1", "---", "# Title", "para one", "para two", "", "```js", "[[x]]", "```", "", "- a", "  - b", "", "> [!note] c", "> d", "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "$$", "x", "$$", "", "%%", "c", "%%", "", "***"].join("\n"),
		);
		expect(c.sections!.map((s) => [s.type, ...lines(s.position)])).toEqual([
			["yaml", 0, 2],
			["heading", 3, 3],
			["paragraph", 4, 5],
			["code", 7, 9],
			["list", 11, 12],
			["callout", 14, 15],
			["table", 17, 19],
			["math", 21, 23],
			["comment", 25, 27],
			["thematicBreak", 29, 29],
		]);
	});

	test("an empty frontmatter block is frontmatter and does not swallow a later rule", () => {
		const c = parseMetadata("---\n---\nbody\n\n---\nmore");
		expect(lines(c.frontmatterPosition!)).toEqual([0, 1]);
		expect(c.sections!.map((s) => s.type)).toEqual(["yaml", "paragraph", "thematicBreak", "paragraph"]);
		expect(getFrontMatterInfo("---\n---\nbody")).toEqual({ exists: true, frontmatter: "", from: 4, to: 4, contentStart: 7 });
	});

	// Obsidian, its editor and its reading view take only a line of exactly
	// '---' as the frontmatter's fences; '--- ' is a rule and text.
	test("a fence line with trailing spaces opens or closes no frontmatter", () => {
		expect(getFrontMatterInfo("--- \na: 1\n---\nbody").exists).toBe(false);
		expect(getFrontMatterInfo("---\na: 1\n--- \nbody").exists).toBe(false);
		expect(parseMetadata("--- \na: 1\n---\nbody").frontmatter).toBeUndefined();
		expect(getFrontMatterInfo("---\r\na: 1\r\n---\r\nbody")).toMatchObject({ exists: true, frontmatter: "a: 1" });
	});
});

describe("parseMetadata list items", () => {
	// ListItemCache.parent: a root item holds -(first line of its list), a child its parent's line.
	test("parents follow indentation, tasks and ids are read", () => {
		const c = parseMetadata(["intro", "", "- a", "  - b", "    - c", "  - [x] d ^d-id", "- [ ]", "", "1. one", "   - nested"].join("\n"));
		expect(c.listItems!.map((l) => [l.position.start.line, l.parent, l.task ?? null, l.id ?? null])).toEqual([
			[2, -2, null, null],
			[3, 2, null, null],
			[4, 3, null, null],
			[5, 2, "x", "d-id"],
			[6, -2, " ", null],
			[8, -8, null, null],
			[9, 8, null, null],
		]);
		expect(c.blocks!["d-id"].position.start.line).toBe(5);
	});

	test("items inside a callout are list items; a thematic break is not", () => {
		const c = parseMetadata("> [!todo]\n> - [ ] task\n\n- - -\n* * *");
		expect(c.listItems!.map((l) => [l.position.start.line, l.task])).toEqual([[1, " "]]);
	});

	// Obsidian indents with tabs by default; a tab reaches the next multiple of
	// four columns, so tab-indented items nest, whatever their marker.
	test("tab-indented children with another marker stay in the list with their links and tags", () => {
		const c = parseMetadata("- steps [[a]]\n\t1. first [[b]] #t1\n\t2. second ![[img.png]]\n- next\n\n1. one\n\t- sub #t2");
		expect(c.sections!.map((s) => [s.type, ...lines(s.position)])).toEqual([
			["list", 0, 3],
			["list", 5, 6],
		]);
		expect(c.listItems!.map((l) => [l.position.start.line, l.parent])).toEqual([
			[0, -0],
			[1, 0],
			[2, 0],
			[3, -0],
			[5, -5],
			[6, 5],
		]);
		expect(c.links!.map((l) => l.link)).toEqual(["a", "b"]);
		expect(c.embeds!.map((l) => l.link)).toEqual(["img.png"]);
		expect(c.tags!.map((t) => t.tag)).toEqual(["#t1", "#t2"]);
		const loose = parseMetadata("- a\n\n\tpara of a\n- b");
		expect(loose.listItems!.map((l) => [l.position.start.line, l.position.end.line, l.parent])).toEqual([
			[0, 2, -0],
			[3, 3, -0],
		]);
	});

	test("a fence after an item's marker is code until its closing fence or a less indented line", () => {
		const c = parseMetadata("1. first [[a]]\n2. ```c++\n   int x; // [[no]] #no\n   ```\n3. third [[c]] #t3\n\n- ```\n  [[in fence]]\n- after [[d]]");
		expect(c.links!.map((l) => l.link)).toEqual(["a", "c", "d"]);
		expect(c.tags!.map((t) => t.tag)).toEqual(["#t3"]);
		expect(c.listItems!.map((l) => l.position.start.line)).toEqual([0, 1, 4, 6, 8]);
		// Backticks in the info string make it inline code, not a fence.
		expect(parseMetadata("```a``` [[x]]").links!.map((l) => l.link)).toEqual(["x"]);
	});

	test("a marker indented four columns continues a paragraph instead of starting a list", () => {
		const c = parseMetadata("text\n\t- more [[x]]\n4. not a list");
		expect(c.listItems).toBeUndefined();
		expect(c.sections!.map((s) => [s.type, ...lines(s.position)])).toEqual([["paragraph", 0, 2]]);
		expect(c.links!.map((l) => l.link)).toEqual(["x"]);
	});
});

describe("parseMetadata blocks and headings", () => {
	test("a trailing ^id names the whole paragraph; a standalone ^id names the block before it", () => {
		const c = parseMetadata("line one\nline two ^p1\n\n| a |\n|---|\n| b |\n\n^table1\n\nnot_an_id ^bad_id");
		expect(lines(c.blocks!.p1.position)).toEqual([0, 1]);
		expect(lines(c.blocks!.table1.position)).toEqual([3, 5]);
		expect(c.sections![1].id).toBe("table1");
		expect(c.blocks!.bad_id).toBeUndefined();
	});

	test("headings follow CommonMark: closing hashes need a space, setext underlines, indent up to 3", () => {
		const c = parseMetadata("# C#\n## Title ##\n   ### Indented\n#\nSetext one\n===\nSetext two\n---\n\n---\n    #### code");
		expect(c.headings!.map((h) => [h.level, h.heading])).toEqual([
			[1, "C#"],
			[2, "Title"],
			[3, "Indented"],
			[1, ""],
			[1, "Setext one"],
			[2, "Setext two"],
		]);
		expect(c.sections!.filter((s) => s.type === "thematicBreak")).toHaveLength(1);
	});
});

describe("parseMetadata links and tags", () => {
	// Reference.displayText examples from the d.ts.
	test("displayText follows Obsidian's Reference examples", () => {
		const c = parseMetadata("[[foo|bar]] [[foo]] [foo](bar.md) ![](bar.jpg) [[note#Heading]]");
		expect(c.links!.map((l) => [l.link, l.displayText])).toEqual([
			["foo", "bar"],
			["foo", "foo"],
			["bar.md", "foo"],
			["note#Heading", "note > Heading"],
		]);
		expect(c.embeds!.map((l) => [l.link, l.displayText])).toEqual([["bar.jpg", ""]]);
	});

	test("Markdown destinations are decoded safely and may be in angle brackets or carry a title", () => {
		const c = parseMetadata('[a](100%.md) [b](<my note.md>) [c](sub/my%20note.md "Title") [d](https://x.org) [e](mailto:x@y.z)');
		expect(c.links!.map((l) => l.link)).toEqual(["100%.md", "my note.md", "sub/my note.md"]);
	});

	test("code, math and comments hide links and tags", () => {
		const c = parseMetadata("`[[a]] #a` $[[b]]$ %%[[c]] #c%% <!-- [[d]] --> [[e]] #e\n```\n[[f]]\n```\n%% open\n[[g]]\n%%");
		expect(c.links!.map((l) => l.link)).toEqual(["e"]);
		expect(c.tags!.map((t) => t.tag)).toEqual(["#e"]);
	});

	// A Jupyter or shell %% line in such a fence once opened a comment that
	// hid the rest of the block from the index, as the reading view did (6f22dce).
	test("fences in callouts, list items and quotes nested in items hide their links and keep their %%", () => {
		const text = [
			"> [!note]",
			"> ```bash",
			"> %%bash [[c1]] #c1",
			"> ```",
			"> [[q1]]",
			"",
			"- item",
			"\t```py",
			"\t%%timeit [[c2]]",
			"\t```",
			"- ```m",
			"  %% cell [[c3]]",
			"  ```",
			"- quoted",
			"  > ```sh",
			"  > %% [[c4]]",
			"  > ```",
			"  > [[q2]] #q2",
			"- [[q3]]",
		].join("\n");
		const c = parseMetadata(text);
		expect(c.links!.map((l) => l.link)).toEqual(["q1", "q2", "q3"]);
		expect(c.tags!.map((t) => t.tag)).toEqual(["#q2"]);
	});

	test("tags take letters of any script and stop at other punctuation", () => {
		const c = parseMetadata("#标签，然后 #über/sub-tag_1 #2024 x#notatag #a.b (#paren)");
		expect(c.tags!.map((t) => t.tag)).toEqual(["#标签", "#über/sub-tag_1", "#a"]);
	});

	test("wikilinks in frontmatter values become frontmatterLinks keyed by property", () => {
		const c = parseMetadata('---\nup: "[[Parent|p]]"\nrelated:\n  - "[[A]]"\n  - "[[B#h]]"\n---\n');
		expect(c.frontmatterLinks!.map((l) => [l.key, l.link, l.displayText])).toEqual([
			["up", "Parent", "p"],
			["related.0", "A", "A"],
			["related.1", "B#h", "B > h"],
		]);
	});

	test("footnote definitions, references and reference links are recorded", () => {
		const c = parseMetadata("text[^1] and [^note]\n\n[^1]: one\n[^note]: two\n\n[site]: https://example.com");
		expect(c.footnoteRefs!.map((f) => f.id)).toEqual(["1", "note"]);
		expect(c.footnotes!.map((f) => f.id)).toEqual(["1", "note"]);
		expect(c.referenceLinks!.map((r) => [r.id, r.link])).toEqual([["site", "https://example.com"]]);
	});
});

describe("metadata helpers", () => {
	test("resolveSubpath finds nested headings, blocks and footnotes", () => {
		const c = parseMetadata("# A\n## B: x\ntext ^blk\n# C\n- item ^li\n\n[^n]: note");
		const h = resolveSubpath(c, "#A#B x");
		expect(h?.type === "heading" && [h.current.heading, h.next.heading, h.end?.line]).toEqual(["B: x", "C", 3]);
		expect(resolveSubpath(c, "#C#B x")).toBeNull();
		const b = resolveSubpath(c, "#^BLK");
		expect(b?.type === "block" && b.block.id).toBe("blk");
		const li = resolveSubpath(c, "#^li");
		expect(li?.type === "block" && li.list?.position.start.line).toBe(4);
		const f = resolveSubpath(c, "#[^n]");
		expect(f?.type === "footnote" && f.footnote.id).toBe("n");
		const last = resolveSubpath(c, "#c");
		expect(last?.type === "heading" && last.end).toBeNull();
	});

	test("stripHeadingForLink drops the characters that break a link", () => {
		expect(stripHeadingForLink("foo:#|^\\\r\n%%[[]]bar")).toBe("foo bar");
	});

	test("frontmatter string arrays are not split; tags and aliases split on their own separators", () => {
		expect(parseFrontMatterStringArray({ foo: "bar baz" }, "foo")).toEqual(["bar baz"]);
		expect(parseFrontMatterStringArray({ foo: [" a ", null, "b"] }, "foo")).toEqual(["a", "b"]);
		expect(parseFrontMatterAliases({ aliases: "Machine Learning, ML" })).toEqual(["Machine Learning", "ML"]);
		expect(parseFrontMatterAliases({ aliases: ["Smith, John", "JS"] })).toEqual(["Smith, John", "JS"]);
		expect(parseFrontMatterTags({ tag: "x", tags: ["foo", "#bar"] })).toEqual(["#x", "#foo", "#bar"]);
		expect(parseFrontMatterStringArray({}, "foo")).toBeNull();
		expect(getAllTags(parseMetadata("no tags"))).toBeNull();
		expect(getAllTags(parseMetadata("---\ntags: a\n---\n#b"))).toEqual(["#a", "#b"]);
	});
});

// [x](a\_b.md) opens a_b.md (the reading view and Live Preview unescape the
// target); the cache kept the backslash, so backlinks and the graph called
// the link unresolved.
describe("parseMetadata Markdown link targets", () => {
	test("backslash escapes in a destination are unescaped, as CommonMark reads them", () => {
		const links = parseMetadata("[x](a\\_b.md) and ![y](<my\\_pic.png>)");
		expect(links.links?.map((l) => l.link)).toEqual(["a_b.md"]);
		expect(links.embeds?.map((l) => l.link)).toEqual(["my_pic.png"]);
	});
});

describe("parseMetadata paths with bare spaces", () => {
	test("Typora-style links and images with spaces count as links, prose in parentheses does not", () => {
		const c = parseMetadata("![Shot](a.assets/Screenshot 2025.png) [N](My Note.md#Part one) (a b c)");
		expect(c.embeds?.map((e) => e.link)).toEqual(["a.assets/Screenshot 2025.png"]);
		expect(c.links?.map((l) => l.link)).toEqual(["My Note.md#Part one"]);
	});
});

