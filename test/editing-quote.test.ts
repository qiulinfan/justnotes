import { describe, expect, test } from "bun:test";
import { insertNewlineContinueMarkup, markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { exitEmptyQuote, obsidianMarkdown } from "../src/api/editor-extensions";

// Enter at the `|` in a note, with the editor's Enter bindings in their
// order, then typing "typed": the new text, and where the typed text sits in
// the syntax tree, which Live Preview and the reading view both follow.
function enterAndType(marked: string) {
	const doc = marked.replace("|", "");
	let state = EditorState.create({
		doc,
		selection: EditorSelection.cursor(marked.indexOf("|")),
		extensions: markdown({ base: markdownLanguage, extensions: obsidianMarkdown }),
	});
	ensureSyntaxTree(state, doc.length, 5000);
	const target = { state, dispatch: (tr: Transaction) => (state = tr.state) };
	if (!exitEmptyQuote(target)) insertNewlineContinueMarkup(target);
	const at = state.selection.main.head;
	state = state.update({ changes: { from: at, insert: "typed" } }).state;
	let quotes = 0;
	let inList = false;
	for (let node = ensureSyntaxTree(state, state.doc.length, 5000)?.resolveInner(at + 1, 1) ?? null; node; node = node.parent) {
		if (node.name === "Blockquote") quotes++;
		if (node.name === "ListItem") inList = true;
	}
	return { text: state.doc.toString(), quotes, inList };
}

// Typora's Enter on an empty quote line: the line steps out one quote level,
// and what is typed next stays out, instead of continuing the quote's last
// paragraph as a lazy continuation line.
describe("Enter on an empty quote line", () => {
	test("leaving the last level starts a paragraph after the quote", () => {
		expect(enterAndType("> abc\n> |")).toEqual({ text: "> abc\n\ntyped", quotes: 0, inList: false });
		expect(enterAndType("> [!note] Title\n> body\n> |")).toEqual({ text: "> [!note] Title\n> body\n\ntyped", quotes: 0, inList: false });
	});

	test("leaving an inner level starts a paragraph in the outer quote", () => {
		expect(enterAndType("> > abc\n> > |")).toEqual({ text: "> > abc\n>\n> typed", quotes: 1, inList: false });
		expect(enterAndType("> outer\n> > [!tip] Title\n> > body\n> > |")).toEqual({ text: "> outer\n> > [!tip] Title\n> > body\n>\n> typed", quotes: 1, inList: false });
	});

	test("leaving a quote in a list item stays in the item", () => {
		expect(enterAndType("- item\n\t> quote\n\t> |")).toEqual({ text: "- item\n\t> quote\n\n\ttyped", quotes: 0, inList: true });
	});

	// Nothing of the quote's text is right above, so no blank line is added.
	test("a quote line with no text above steps out in place", () => {
		expect(enterAndType("para\n\n> |")).toEqual({ text: "para\n\ntyped", quotes: 0, inList: false });
		expect(enterAndType("> > abc\n>\n> > |")).toEqual({ text: "> > abc\n>\n> typed", quotes: 1, inList: false });
	});

	test("Enter in or after a quote line's text continues the quote", () => {
		expect(enterAndType("> ab|c").text).toBe("> ab\n> typedc");
		expect(enterAndType("> > abc|").text).toBe("> > abc\n> > typed");
	});
});
