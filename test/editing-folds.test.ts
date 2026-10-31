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
function folds(heading: boolean, indent: boolean) {
	const state = EditorState.create({ doc: note, extensions: markdownSupport({ heading, indent }) });
	ensureSyntaxTree(state, note.length, 5000);
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
	// The code block's language is loaded, as in an editor that has shown it,
	// so its own syntax folds would be offered if they were kept.
	beforeAll(async () => {
		await LanguageDescription.matchLanguageName(languages, "js", true)?.load();
	});

	// A list item's own text wrapping onto more lines folds no more than a
	// paragraph does; what is nested in it folds from the end of that text.
	test("heading sections and what is nested in list items fold; paragraphs, quotes, code and tables do not", () => {
		expect(folds(true, true)).toEqual(["# Heading -> text", "- item -> \t- child", "  wrapped -> \t- nested", "## Sub -> text"]);
	});

	test("foldHeading and foldIndent each turn off their own folds", () => {
		expect(folds(false, true)).toEqual(["- item -> \t- child", "  wrapped -> \t- nested"]);
		expect(folds(true, false)).toEqual(["# Heading -> text", "## Sub -> text"]);
	});
});
