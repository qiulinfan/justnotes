import { beforeAll, describe, expect, test } from "bun:test";
import { ensureSyntaxTree, foldable, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorState } from "@codemirror/state";
import { markdownSupport } from "../src/api/editor-extensions";

const note = [
	"# Heading",
	"",
	"Paragraph one",
	"paragraph two",
	"",
	"> quote one",
	"> quote two",
	"",
	"- item",
	"\t- child",
	"- single",
	"- wrapped",
	"continued",
	"- parent",
	"  wrapped",
	"\t- nested",
	"",
	"```js",
	"function a() {",
	"  return 1;",
	"}",
	"```",
	"",
	"| a | b |",
	"|---|---|",
	"| 1 | 2 |",
	"",
	"## Sub",
	"",
	"text",
].join("\n");

// The lines the fold gutter and the fold commands offer, each with the last
// line its fold hides.
function folds(doc: string, heading: boolean, indent: boolean) {
	const state = EditorState.create({ doc, extensions: markdownSupport({ heading, indent }) });
	ensureSyntaxTree(state, doc.length, 5000);
	const out: string[] = [];
	for (let n = 1; n <= state.doc.lines; n++) {
		const line = state.doc.line(n);
		const range = foldable(state, line.from, line.to);
		if (range) out.push(`${line.text} -> ${state.doc.lineAt(range.to).text}`);
	}
	return out;
}

// Obsidian folds headings and indented lists only; justnotes reads the same
// two settings.
describe("folding", () => {
	// The languages of the code here (in fenced blocks, styles and scripts)
	// are loaded, as in an editor that has shown them, so their own syntax
	// folds would be offered if they were kept.
	beforeAll(async () => {
		for (const name of ["js", "css", "html", "markdown", "vue", "angular", "php", "liquid", "jinja"]) await LanguageDescription.matchLanguageName(languages, name, true)?.load();
	});

	// A list item's own text wrapping onto more lines folds no more than a
	// paragraph does; what is nested in it folds from the end of that text.
	test("heading sections and what is nested in list items fold; paragraphs, quotes, code and tables do not", () => {
		expect(folds(note, true, true)).toEqual(["# Heading -> text", "- item -> \t- child", "  wrapped -> \t- nested", "## Sub -> text"]);
	});

	test("foldHeading and foldIndent each turn off their own folds", () => {
		expect(folds(note, false, true)).toEqual(["- item -> \t- child", "  wrapped -> \t- nested"]);
		expect(folds(note, true, false)).toEqual(["# Heading -> text", "## Sub -> text"]);
	});

	test("HTML blocks, with the CSS and JavaScript in them, do not fold", () => {
		const html = ["<div>", "<p>text</p>", "</div>", "", "<style>", ".a {", "  color: red;", "}", "</style>", "", "<script>", "function a() {", "  return 1;", "}", "</script>"].join("\n");
		expect(folds(html, true, true)).toEqual([]);
	});

	// lang-html parses a style attribute's value as CSS and an event handler's
	// as JavaScript, whose syntax folds where a value spans lines. With both
	// settings off the fold commands still run.
	test("style and event handler attribute values in HTML do not fold", () => {
		const attrs = ['<button onclick="if (a) {', "  run();", '}">go</button>', "", '<p style="@media (width > 1px) {', "  color: red;", '}">t</p>', "", "```html", '<b onkeyup="keys([', "  1", '])">x</b>', "```"].join("\n");
		expect(folds(attrs, true, true)).toEqual([]);
		expect(folds(attrs, false, false)).toEqual([]);
	});

	// A heading in a markdown fence is code, not a section of the note.
	test("HTML and Markdown fences, with what is nested in them, do not fold", () => {
		const fences = ["```html", "<style>", ".a {", "  color: red;", "}", "</style>", "<script>", "function a() {", "  return 1;", "}", "</script>", "```", "", "```markdown", "# Inside", "text", "<div>", "<p>text</p>", "</div>", "```"].join("\n");
		expect(folds(fences, true, true)).toEqual([]);
	});

	// Template languages nest HTML (with its CSS and JavaScript) and, in Vue
	// and Angular, JavaScript expressions in interpolations and bound
	// attributes; none of it folds, as in any other fence.
	test("Vue, Angular, PHP, Liquid and Jinja fences, with what is nested in them, do not fold", () => {
		const html = ["<div>", "<p>text</p>", "</div>", "<style>", ".a {", "  color: red;", "}", "</style>", "<script>", "function a() {", "  return 1;", "}", "</script>"];
		const fence = (lang: string, ...lines: string[]) => ["```" + lang, ...html, ...lines, "```"].join("\n");
		const fences = [
			fence("vue", '<p :class="{', '  a: true,', '  b: false', '}">{{ [', '  1,', '  2', '] }}</p>'),
			fence("angular", '<p [class]="{', '  a: true', '}">{{ [', '  1', '] }}</p>'),
			fence("php", "<?php", "function f() {", "  return [", "    1,", "  ];", "}", "?>"),
			fence("liquid", "{% if a %}", "<b>x</b>", "{% endif %}", "{% comment %}", "c", "{% endcomment %}"),
			fence("jinja", "{% if a %}", "<b>x</b>", "{% endif %}", "{% for x in y %}", "z", "{% endfor %}"),
		];
		for (const doc of fences) expect(folds(doc, true, true)).toEqual([]);
	});
});
