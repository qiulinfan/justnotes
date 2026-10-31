import { beforeAll, describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { markdownSupport, obsidianMarkdown } from "../src/api/editor-extensions";
import { clickableTokenAt } from "../src/api/live-preview";

function stateOf(doc: string) {
	return EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, extensions: obsidianMarkdown }) });
}

// [name, text] for every node, in document order.
function nodes(doc: string) {
	const state = stateOf(doc);
	const out: [string, string][] = [];
	ensureSyntaxTree(state, doc.length, 5000)!.iterate({ enter: (n) => void out.push([n.name, doc.slice(n.from, n.to)]) });
	return out;
}

const texts = (doc: string, name: string) => nodes(doc).filter(([n]) => n === name).map(([, t]) => t);

describe("inline math", () => {
	// Dollar amounts in prose must not turn into formulas.
	test("follows pandoc's rules for the delimiters", () => {
		expect(texts("costs $5 and $10", "InlineMath")).toEqual([]);
		expect(texts("$ x$ and $x $ and $x$5", "InlineMath")).toEqual([]);
		expect(texts("so $x^2$ and \\$y$ and $a$$b$", "InlineMath")).toEqual(["$x^2$", "$a$", "$b$"]);
	});

	// Latex Suite and similar plugins find math by testing node names for
	// these words, as in Obsidian's own tree.
	test("names its delimiters and content the way Obsidian's tree does", () => {
		const names = nodes("$x$ and $$y$$").map(([n]) => n);
		const begin = names.filter((n) => n.includes("math-begin"));
		expect(begin).toHaveLength(2);
		expect(begin[0]).not.toContain("math-block");
		expect(begin[1]).toContain("math-block");
		expect(names.filter((n) => n.includes("math-end"))).toHaveLength(2);
		expect(names).toContain("math");
	});
});

describe("frontmatter", () => {
	// lezer-markdown alone reads it as a rule plus a setext heading.
	test("a leading --- block is one frontmatter node", () => {
		const parsed = nodes("---\ntitle: x\ntags: [a]\n---\ntext");
		expect(texts("---\ntitle: x\ntags: [a]\n---\ntext", "hmd-frontmatter")).toEqual(["---\ntitle: x\ntags: [a]\n---"]);
		expect(parsed.map(([n]) => n)).not.toContain("SetextHeading2");
		expect(parsed.map(([n]) => n)).not.toContain("HorizontalRule");
	});

	test("--- after the first line is still a rule", () => {
		expect(texts("text\n\n---\nmore", "hmd-frontmatter")).toEqual([]);
		expect(texts("text\n\n---\nmore", "HorizontalRule")).toEqual(["---"]);
	});
});

describe("Obsidian syntax", () => {
	test("any single character between the brackets makes a task", () => {
		expect(texts("- [-] cancelled\n- [/] half\n- [ ] open", "TaskMarker")).toEqual(["[-]", "[/]", "[ ]"]);
	});

	test("%% comments hide their contents from other syntax, inline or across paragraphs", () => {
		expect(texts("a %%[[Hidden]]%% b", "comment")).toEqual(["%%[[Hidden]]%%"]);
		expect(texts("a %%[[Hidden]]%% b", "internal-link")).toEqual([]);
		expect(texts("%%\nfirst\n\nsecond\n%%\nafter", "comment-block")).toEqual(["%%\nfirst\n\nsecond\n%%"]);
	});

	test("==text== is a highlight, a spaced == is not", () => {
		expect(texts("an ==important== word", "highlight")).toEqual(["==important=="]);
		expect(texts("a == b == c", "highlight")).toEqual([]);
	});

	test("#tags start a word and are not all digits", () => {
		expect(texts("#start and #nested/tag, a#mid, #123, `#code`", "hashtag")).toEqual(["#start", "#nested/tag"]);
	});

	test("footnote references are their own nodes, not reference links", () => {
		const doc = "Text[^1] and [^long-id].\n\n[^1]: definition";
		expect(texts(doc, "footref")).toEqual(["[^1]", "[^long-id]", "[^1]"]);
		expect(texts(doc, "Link")).toEqual([]);
	});

	test("wikilinks and embeds split into target, pipe and alias", () => {
		const parsed = nodes("[[Note#Head|shown]] ![[img.png|300]]");
		expect(parsed.filter(([n]) => n === "internal-link" || n === "internal-embed")).toEqual([
			["internal-link", "[[Note#Head|shown]]"],
			["internal-embed", "![[img.png|300]]"],
		]);
		expect(texts("[[Note#Head|shown]]", "hmd-internal-link")).toEqual(["Note#Head"]);
		expect(texts("[[Note#Head|shown]]", "hmd-internal-link_link-alias")).toEqual(["shown"]);
	});
});

// A script or style in a note's HTML parses as its type or lang says, as in
// lang-html: one of another language (MathJax's math/tex, a template, SCSS)
// stays text instead of being highlighted and edited as JavaScript or CSS.
describe("code in a note's HTML", () => {
	// Loaded, as in an editor that has shown fenced code of these languages.
	beforeAll(async () => {
		for (const name of ["javascript", "typescript", "css"]) await LanguageDescription.matchLanguageName(languages, name, true)?.load();
	});

	test("scripts and styles parse by their type or lang", () => {
		const doc = ['<script type="math/tex">', "x^2", "</script>", "", '<script lang="ts">', "interface I {}", "</script>", "", '<script type="application/json">', '{"a": 1}', "</script>", "", '<style lang="scss">', "$c: red;", "</style>", "", "<script>", "let b = 1;", "</script>"].join("\n");
		const tree = ensureSyntaxTree(EditorState.create({ doc, extensions: markdownSupport({ heading: true, indent: true }) }), doc.length, 5000)!;
		const at = (text: string) => tree.resolveInner(doc.indexOf(text) + 1, 1);
		const top = (node: SyntaxNode | null) => {
			while (node && !node.type.isTop) node = node.parent;
			return node?.name;
		};
		expect(at("x^2").name).toBe("ScriptText");
		expect(at("I {}").name).toBe("InterfaceDeclaration");
		expect(top(at('"a"'))).toBe("SingleExpression");
		expect(at("$c").name).toBe("StyleText");
		expect(top(at("let b"))).toBe("Script");
	});
});

// Open-link commands and Editor.getClickableTokenAt act on what is under
// the cursor.
describe("clickableTokenAt", () => {
	const doc = "see [[Note|alias]], [site](https://a.b), [rel](Other%20note.md), https://c.d and #tag";
	const at = (needle: string) => clickableTokenAt(stateOf(doc), doc.indexOf(needle) + 1);

	test("finds internal links by their target, decoding Markdown paths", () => {
		expect(at("alias")).toMatchObject({ type: "internal-link", text: "Note" });
		expect(at("rel")).toMatchObject({ type: "internal-link", text: "Other note.md" });
	});

	test("finds external links, bare URLs and tags", () => {
		expect(at("site")).toMatchObject({ type: "external-link", text: "https://a.b" });
		expect(at("https://c.d")).toMatchObject({ type: "external-link", text: "https://c.d" });
		expect(at("#tag")).toMatchObject({ type: "tag", text: "#tag" });
	});

	test("finds nothing in plain text", () => {
		expect(at("see")).toBeNull();
	});
});
