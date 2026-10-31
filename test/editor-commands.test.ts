import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
	clearFormatting,
	cycleListChecklist,
	insertMarkdownLink,
	MARKUP,
	type StateEdit,
	setHeading,
	toggleBlockquote,
	toggleBulletList,
	toggleChecklistStatus,
	toggleMarkup,
	toggleNumberedList,
} from "../src/api/editor-commands";
import { obsidianMarkdown } from "../src/api/editor-extensions";

// A document with `|` marking the cursor or `«` `»` marking a selection.
function stateOf(marked: string) {
	const anchor = marked.includes("«") ? marked.indexOf("«") : marked.indexOf("|");
	const doc = marked.replace(/[|«»]/g, "");
	const head = marked.includes("»") ? marked.indexOf("»") - 1 : anchor;
	const state = EditorState.create({
		doc,
		selection: EditorSelection.single(anchor, head),
		extensions: markdown({ base: markdownLanguage, extensions: obsidianMarkdown }),
	});
	ensureSyntaxTree(state, doc.length, 5000);
	return state;
}

// The edited document, with the cursor or selection marked the same way.
function run(edit: StateEdit, marked: string) {
	const state = stateOf(marked);
	const spec = edit(state);
	const next = spec ? state.update(spec).state : state;
	const { from, to, empty } = next.selection.main;
	const doc = next.doc.toString();
	return empty ? `${doc.slice(0, from)}|${doc.slice(from)}` : `${doc.slice(0, from)}«${doc.slice(from, to)}»${doc.slice(to)}`;
}

describe("toggleMarkup", () => {
	const bold = toggleMarkup(MARKUP.bold);

	test("wraps the word at the cursor, or inserts a pair at a space", () => {
		expect(run(bold, "say he|llo now")).toBe("say **he|llo** now");
		expect(run(bold, "say | now")).toBe("say **|** now");
	});

	test("unwraps the span around the cursor or selection", () => {
		expect(run(bold, "say **he|llo** now")).toBe("say he|llo now");
		expect(run(bold, "say **«hello»** now")).toBe("say «hello» now");
	});

	test("wraps a selection without its outer whitespace", () => {
		expect(run(bold, "say« hello »now")).toBe("say **«hello»** now");
	});

	// Inside bold, the italics command must add `*`, not eat one of the `**`.
	test("toggles only its own kind of span", () => {
		expect(run(toggleMarkup(MARKUP.italic), "**«bold»**")).toBe("***«bold»***");
	});

	test("comments use %% as in Obsidian", () => {
		expect(run(toggleMarkup(MARKUP.comment), "«note»")).toBe("%%«note»%%");
	});
});

describe("clearFormatting", () => {
	test("removes every inline mark inside the selection", () => {
		expect(run(clearFormatting, "«**a** *b* ~~c~~ ==d== `e`»")).toBe("«a b c d e»");
	});
});

describe("insertMarkdownLink", () => {
	test("links selected text with the cursor in the parentheses", () => {
		expect(run(insertMarkdownLink, "«text»")).toBe("[text](|)");
	});

	test("puts a selected URL in the parentheses, cursor in the brackets", () => {
		expect(run(insertMarkdownLink, "«https://a.b»")).toBe("[|](https://a.b)");
	});
});

describe("line commands", () => {
	test("toggle checklist status turns lines into tasks and flips their box", () => {
		expect(run(toggleChecklistStatus, "plain|")).toBe("- [ ] plain|");
		expect(run(toggleChecklistStatus, "- item|")).toBe("- [ ] item|");
		expect(run(toggleChecklistStatus, "- [ ] open|")).toBe("- [x] open|");
		expect(run(toggleChecklistStatus, "- [-] cancelled|")).toBe("- [ ] cancelled|");
	});

	test("cycle bullet/checkbox goes plain, bullet, task, plain", () => {
		expect(run(cycleListChecklist, "a|")).toBe("- a|");
		expect(run(cycleListChecklist, "- a|")).toBe("- [ ] a|");
		expect(run(cycleListChecklist, "- [x] a|")).toBe("a|");
	});

	test("bullet list removes bullets only when every selected line has one", () => {
		expect(run(toggleBulletList, "«- a\n\n- b»")).toBe("«a\n\nb»");
		expect(run(toggleBulletList, "«- a\nb\n1. c»")).toBe("«- a\n- b\n- c»");
	});

	test("numbered list numbers the selected lines from one", () => {
		expect(run(toggleNumberedList, "«a\n- b\nc»")).toBe("«1. a\n2. b\n3. c»");
	});

	test("blockquote adds a level, or removes one when all lines are quoted", () => {
		expect(run(toggleBlockquote, "«a\nb»")).toBe("«> a\n> b»");
		expect(run(toggleBlockquote, "«> > a\n> b»")).toBe("«> a\nb»");
	});

	test("set heading replaces existing heading marks", () => {
		expect(run(setHeading(2), "### Title|")).toBe("## Title|");
		expect(run(setHeading(0), "# Title|")).toBe("Title|");
	});
});
