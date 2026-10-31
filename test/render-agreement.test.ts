import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { type Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { obsidianMarkdown } from "../src/api/editor-extensions";
import { type LivePreviewHost, livePreview, tableCellOffset } from "../src/api/live-preview";
import { MarkdownPreviewRenderer, renderMarkdownSections } from "../src/api/markdown";

// Live Preview and the reading view must show the same thing for the same
// text: a formula that renders in one and not the other, or a code-block
// processor that gets other source in the editor, is what a user notices.

const host = {
	app: {
		vault: { getConfig: () => undefined },
		metadataCache: { getFirstLinkpathDest: () => null, getCache: () => null },
	},
	sourcePath: () => "note.md",
	resolveImage: () => null,
} as unknown as LivePreviewHost;

// The widgets Live Preview shows with the cursor at the end of the text, on
// a line of its own.
function widgets(doc: string) {
	const state = EditorState.create({
		doc,
		selection: { anchor: doc.length },
		extensions: [markdown({ base: markdownLanguage, extensions: obsidianMarkdown }), livePreview(host)],
	});
	ensureSyntaxTree(state, state.doc.length, 5000);
	const out: any[] = [];
	for (const set of state.facet(EditorView.decorations) as DecorationSet[]) {
		set.between(0, state.doc.length, (_from, _to, value: Decoration) => {
			if (value.spec.widget) out.push(value.spec.widget);
		});
	}
	return out;
}

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Formulas as `$tex$` (inline) and `$$tex$$` (display).
function readingViewMath(doc: string) {
	const html = renderMarkdownSections(doc)
		.sections.map((s) => s.html)
		.join("");
	return [...html.matchAll(/class="math (math-inline|math-block)" data-tex="([^"]*)"/g)].map((m) =>
		m[1] === "math-inline" ? `$${unescape(m[2])}$` : `$$${unescape(m[2])}$$`,
	);
}

const livePreviewMath = (doc: string) =>
	widgets(doc)
		.filter((w) => w.constructor.name === "MathWidget")
		.map((w) => (w.display ? `$$${w.tex.trim()}$$` : `$${w.tex}$`));

describe("math", () => {
	// Each case is a line pattern from the owner's notes.
	const cases: [string, string, string[]][] = [
		["prices and escaped dollars", "costs $5 and $6, and \\$7 too", []],
		// A closing `$` after a space is no closer; the next one does not rescue
		// the formula, so the later `$X$` still renders.
		["a space before the first closer", "- **bytes $ [X, X+1]$**\n\tfrom $X$ to $X+B$.", ["$X$", "$X+B$"]],
		["spaces inside both delimiters", "从 $ W/2 $增加到 $ W$；", []],
		[
			"display math and text on one list line",
			"- $$\\text{S}_{i} = Q_i$$, 就是第 $i$ 个\n- 第 $j$ 个\n\n# Later",
			["$$\\text{S}_{i} = Q_i$$", "$i$", "$j$"],
		],
		["a block right under a paragraph line, with a blank line in it", "Then:\n$$\na = b\n\n$$\nafter $c$", ["$$a = b$$", "$c$"]],
		["a block inside a quote", "> Quoted:\n> $$\n> a^2\n> = b\n> $$", ["$$a^2\n= b$$"]],
	];

	for (const [name, text, formulas] of cases) {
		test(name, () => {
			const doc = `${text}\n\nend`;
			expect(readingViewMath(doc)).toEqual(formulas);
			expect(livePreviewMath(doc)).toEqual(formulas);
		});
	}
});

describe("callouts and tables in list items", () => {
	// Indented by a tab or four spaces under a list item, these are still a
	// callout and a table in the reading view; Live Preview must not render
	// them as indented code. A click in a cell maps through the note's lines.
	const html = (markdown: string) =>
		renderMarkdownSections(markdown)
			.sections.map((s) => s.html)
			.join("");
	const block = (doc: string) => widgets(doc).find((w) => w.constructor.name === "RenderedBlockWidget");

	test("a tab-indented callout", () => {
		const doc = "- item\n\t> [!note] Title\n\t> body\n\nend";
		expect(html(doc)).toMatch(/class="callout"/);
		expect(html(block(doc).markdown)).toMatch(/class="callout"/);
	});

	test("a table indented by four spaces", () => {
		const doc = "- item\n    | a | b |\n    | - | - |\n    | 1 | 2 |\n\nend";
		const widget = block(doc);
		expect(html(doc)).toMatch(/<table/);
		expect(html(widget.markdown)).toMatch(/<table/);
		expect(html(widget.markdown)).not.toMatch(/<pre/);
		const tableStart = doc.indexOf("    | a");
		expect(doc.slice(tableStart + tableCellOffset(widget.source, 1, 1))).toStartWith("2 |");
	});
});

describe("code-block processors", () => {
	// bases' replaceBaseBlock finds a block by the source its processor got,
	// so a fence in a list item must reach the processor without its indent.
	test("a fence in a list item hands the processor the reading view's source", () => {
		const processor = () => {};
		MarkdownPreviewRenderer.registerCodeBlockPostProcessor("agree-lang", processor);
		try {
			const doc = "- item\n\n\t```agree-lang\n\tviews:\n\t  - name: A\n\t```\n\nend";
			const html = renderMarkdownSections(doc)
				.sections.map((s) => s.html)
				.join("");
			const readingSource = unescape(/<code class="language-agree-lang is-loaded">([^<]*)<\/code>/.exec(html)![1]);
			const widget = widgets(doc).find((w) => w.constructor.name === "CodeBlockWidget");
			expect(readingSource).toBe("views:\n  - name: A");
			expect(widget.source).toBe(readingSource);
		} finally {
			MarkdownPreviewRenderer.unregisterCodeBlockPostProcessor("agree-lang", processor);
		}
	});
});
