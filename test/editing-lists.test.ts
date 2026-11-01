import { describe, expect, test } from "bun:test";
import { deleteCharBackward, history, insertNewlineAndIndent, moveLineDown, moveLineUp, undo } from "@codemirror/commands";
import { deleteMarkupBackward, insertNewlineContinueMarkup, markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, foldEffect, codeFolding, indentUnit } from "@codemirror/language";
import { EditorSelection, EditorState, type StateCommand, type Transaction, type TransactionSpec } from "@codemirror/state";
import { cycleListChecklist, toggleBulletList, toggleNumberedList } from "../src/api/editor-commands";
import { exitEmptyQuote, obsidianMarkdown } from "../src/api/editor-extensions";
import { deleteListMarkup, indentListItems, insertListContinuation, insertListNewline, listEdit, listRenumbering, outdentListItems } from "../src/api/editor-lists";

// Documents use `|` for each cursor and `«` `»` for a selection. `tab: false`
// is a vault with useTab off (4 spaces).
function stateOf(marked: string, opts: { tab?: boolean } = {}) {
	const ranges: { anchor: number; head: number }[] = [];
	let doc = "";
	let anchor = -1;
	let cr = 0; // CodeMirror drops the \r of CRLF line breaks
	for (const ch of marked) {
		if (ch === "\r") cr++;
		if (ch === "|") ranges.push({ anchor: doc.length - cr, head: doc.length - cr });
		else if (ch === "«") anchor = doc.length - cr;
		else if (ch === "»") ranges.push({ anchor, head: doc.length - cr });
		else doc += ch;
	}
	if (!ranges.length) ranges.push({ anchor: 0, head: 0 });
	const state = EditorState.create({
		doc,
		selection: EditorSelection.create(ranges.map((r) => EditorSelection.range(r.anchor, r.head))),
		extensions: [
			EditorState.allowMultipleSelections.of(true),
			markdown({ base: markdownLanguage, extensions: obsidianMarkdown }),
			indentUnit.of(opts.tab === false ? "    " : "\t"),
			listRenumbering,
			history(),
			codeFolding(),
		],
	});
	ensureSyntaxTree(state, doc.length, 5000);
	return state;
}

function show(state: EditorState) {
	const doc = state.doc.toString();
	let out = "";
	let at = 0;
	for (const r of state.selection.ranges) {
		out += doc.slice(at, r.from) + (r.empty ? "|" : `«${doc.slice(r.from, r.to)}»`);
		at = r.to;
	}
	return out + doc.slice(at);
}

// Run commands in the editor's order for a key, the first that applies wins.
function press(state: EditorState, ...commands: StateCommand[]) {
	let next = state;
	const target = { state, dispatch: (tr: Transaction) => (next = tr.state) };
	for (const command of commands) if (command(target)) break;
	return next;
}

const keys = {
	Tab: [indentListItems],
	"Shift-Tab": [outdentListItems],
	Enter: [exitEmptyQuote, insertListNewline, insertNewlineContinueMarkup, insertNewlineAndIndent],
	"Shift-Enter": [insertListContinuation, insertNewlineAndIndent],
	Backspace: [deleteListMarkup, deleteMarkupBackward, deleteCharBackward],
} satisfies Record<string, StateCommand[]>;

function key(name: keyof typeof keys, marked: string, opts?: { tab?: boolean }) {
	return show(press(stateOf(marked, opts), ...keys[name]));
}

// A user edit as the editor makes one (paste, cut, typing).
function edit(marked: string, spec: (state: EditorState) => TransactionSpec, opts?: { tab?: boolean }) {
	const state = stateOf(marked, opts);
	const next = state.update(spec(state)).state;
	return /[|«]/.test(marked) ? show(next) : next.doc.toString();
}

// How many list items line `n` is nested in, as lezer's CommonMark parser
// reads the document (0: not in a list).
function nesting(text: string, n: number) {
	const state = EditorState.create({ doc: text.replace(/[|«»]/g, ""), extensions: markdown({ base: markdownLanguage, extensions: obsidianMarkdown }) });
	const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
	const line = state.doc.line(n);
	let depth = 0;
	for (let node = tree.resolveInner(line.to, -1) as typeof tree.topNode | null; node; node = node.parent) if (node.name === "ListItem") depth++;
	return depth;
}

describe("Tab indents an item with its children", () => {
	test("bullets nest under the previous item's content column, with a tab", () => {
		expect(key("Tab", "- a\n- b|\n- c")).toBe("- a\n\t- b|\n- c");
		expect(key("Tab", "- a\n- |b")).toBe("- a\n\t- |b");
	});

	test("children move with the item", () => {
		expect(key("Tab", "- a\n- b|\n\t- b1\n\t\t- b2\n- c")).toBe("- a\n\t- b|\n\t\t- b1\n\t\t\t- b2\n- c");
	});

	test("with spaces, children go exactly under the content: 2 under '- ', 3 under '1. ', 4 under '10. '", () => {
		expect(key("Tab", "- a\n- b|", { tab: false })).toBe("- a\n  - b|");
		expect(key("Tab", "1. a\n2. b|", { tab: false })).toBe("1. a\n   1. b|");
		expect(key("Tab", "9. a\n10. b\n11. c|", { tab: false })).toBe("9. a\n10. b\n    1. c|");
		expect(nesting("9. a\n10. b\n    1. c", 3)).toBe(2);
		expect(nesting("1. a\n   1. b", 2)).toBe(2);
	});

	test("with tabs, a marker wider than a tab stop needs two tabs, or it would stay a sibling", () => {
		expect(key("Tab", "100. a\n101. b|")).toBe("100. a\n\t\t1. b|");
		expect(nesting("100. a\n\t\t1. b", 2)).toBe(2);
		// What one tab would give: still a sibling.
		expect(nesting("100. a\n\t1. b", 2)).toBe(1);
	});

	test("the list's own indentation wins over the setting", () => {
		// A space-indented list in a vault that uses tabs.
		expect(key("Tab", "- a\n  - x\n- b\n- c|")).toBe("- a\n  - x\n- b\n  - c|");
		// A tab-indented list in a vault that uses spaces.
		expect(key("Tab", "- a\n\t- x\n- b\n- c|", { tab: false })).toBe("- a\n\t- x\n- b\n\t- c|");
	});

	test("an item joins the children the previous item already has", () => {
		expect(key("Tab", "- a\n    - x\n- b|")).toBe("- a\n    - x\n    - b|");
		expect(key("Tab", "1. a\n\t1. x\n\t2. y\n2. b|")).toBe("1. a\n\t1. x\n\t2. y\n\t3. b|");
	});

	test("the first item of a list has nothing to nest under and stays", () => {
		expect(key("Tab", "- a|\n- b")).toBe("- a|\n- b");
		expect(key("Tab", "para\n\n- a|")).toBe("para\n\n- a|");
		expect(key("Tab", "- a\n\t- b|")).toBe("- a\n\t- b|");
	});

	test("a selection moves every selected item, each run under its previous sibling", () => {
		expect(key("Tab", "- a\n- «b\n- c»\n- d")).toBe("- a\n\t- «b\n\t- c»\n- d");
		// A run that starts at the first item cannot move.
		expect(key("Tab", "- «a\n- b»")).toBe("- «a\n- b»");
	});

	test("outside lists Tab is not a list key", () => {
		const state = stateOf("text|");
		expect(press(state, indentListItems)).toBe(state);
		// A continuation line of an item is not its marker line.
		const cont = stateOf("- a\n  more|");
		expect(press(cont, indentListItems)).toBe(cont);
	});

	test("a selection reaching outside the list is not a list move", () => {
		const state = stateOf("«para\n- a\n- b»");
		expect(press(state, indentListItems)).toBe(state);
	});

	test("tasks nest like bullets and keep their box", () => {
		expect(key("Tab", "- [ ] a\n- [x] b|")).toBe("- [ ] a\n\t- [x] b|");
	});
});

describe("Shift+Tab outdents an item with its children", () => {
	test("the item goes to its parent's level, children along", () => {
		expect(key("Shift-Tab", "- a\n\t- b|\n\t\t- b1\n- c")).toBe("- a\n- b|\n\t- b1\n- c");
	});

	test("siblings after it become its children", () => {
		expect(key("Shift-Tab", "- a\n\t- b|\n\t- c")).toBe("- a\n- b|\n\t- c");
		// Under a wider marker the sibling moves to the new content column.
		expect(key("Shift-Tab", "- a\n  1. b|\n  2. c", { tab: false })).toBe("- a\n1. b|\n   1. c");
	});

	test("a top-level item stays", () => {
		expect(key("Shift-Tab", "- a|\n- b")).toBe("- a|\n- b");
	});

	test("in a blockquote and a callout", () => {
		expect(key("Shift-Tab", "> - a\n>   - b|", { tab: false })).toBe("> - a\n> - b|");
		expect(key("Tab", "> [!note] Title\n> 1. a\n> 2. b|", { tab: false })).toBe("> [!note] Title\n> 1. a\n>    1. b|");
		// A tab after "> " reaches only column 4, short of the content of "> 1. ".
		const quoted = key("Tab", "> [!note] Title\n> 1. a\n> 2. b|");
		expect(quoted).toBe("> [!note] Title\n> 1. a\n> \t\t1. b|");
		expect(nesting(quoted, 3)).toBe(2);
	});
});

describe("ordered lists renumber", () => {
	test("after indenting: the nested list starts at 1, the rest closes up", () => {
		expect(key("Tab", "1. a\n2. b|\n3. c\n4. d")).toBe("1. a\n\t1. b|\n2. c\n3. d");
	});

	test("after outdenting: the item continues the parent's list", () => {
		expect(key("Shift-Tab", "1. a\n\t1. x\n\t2. b|\n2. c")).toBe("1. a\n\t1. x\n2. b|\n3. c");
		// The siblings that become its children start again at 1.
		expect(key("Shift-Tab", "1. a\n\t1. b|\n\t2. c\n\t3. d")).toBe("1. a\n2. b|\n\t1. c\n\t2. d");
	});

	test("a list starting at 5 keeps 5, and the delimiter stays", () => {
		expect(key("Enter", "5) a|\n6) b")).toBe("5) a\n6) |\n7) b");
		expect(key("Tab", "5. a\n6. b|\n7. c")).toBe("5. a\n\t1. b|\n6. c");
	});

	test("lazily numbered lists are numbered once they change", () => {
		expect(key("Enter", "1. a\n1. b|\n1. c")).toBe("1. a\n2. b\n3. |\n4. c");
	});

	test("lists separated by a heading or a paragraph stay separate", () => {
		expect(key("Shift-Tab", "1. a\n2. b\n\t1. c|\n# Header\n1. d\n2. e")).toBe("1. a\n2. b\n3. c|\n# Header\n1. d\n2. e");
		expect(key("Enter", "1. a|\n\ntext\n\n1. d\n2. e")).toBe("1. a\n2. |\n\ntext\n\n1. d\n2. e");
	});

	test("each level separately, other levels untouched", () => {
		expect(key("Enter", "1. a\n\t1. x|\n\t2. y\n2. b")).toBe("1. a\n\t1. x\n\t2. |\n\t3. y\n2. b");
	});

	test("deleting an item closes the gap", () => {
		expect(edit("1. a\n2. b\n3. c\n4. d", (s) => ({ changes: { from: s.doc.line(2).from, to: s.doc.line(3).from }, userEvent: "delete.cut" }))).toBe("1. a\n2. c\n3. d");
		// Deleting the first item: the next takes its number.
		expect(edit("5. a\n6. b\n7. c", (s) => ({ changes: { from: 0, to: s.doc.line(2).from }, userEvent: "delete.selection" }))).toBe("5. b\n6. c");
		// Backspace at a line start joining two items.
		const joined = press(stateOf("1. a\n2. b\n|3. c\n4. d"), ...keys.Backspace);
		expect(show(joined)).toBe("1. a\n2. b|3. c\n3. d");
	});

	test("moving lines", () => {
		expect(show(press(stateOf("1. a\n2. b\n3. c|"), moveLineUp))).toBe("1. a\n2. c|\n3. b");
		expect(show(press(stateOf("5. a|\n6. b"), moveLineDown))).toBe("5. b\n6. a|");
	});

	test("pasting items into a list", () => {
		const paste = (s: EditorState) => ({ ...s.replaceSelection("1. x\n2. y\n"), userEvent: "input.paste" });
		expect(edit("1. a\n2. b\n|3. c", paste)).toBe("1. a\n2. b\n3. x\n4. y\n|5. c");
		// Pasted into a new list, the items keep their numbers.
		expect(edit("text\n\n|", (s) => ({ ...s.replaceSelection("3. x\n4. y"), userEvent: "input.paste" }))).toBe("text\n\n3. x\n4. y|");
	});

	test("pasting two separate lists keeps them separate", () => {
		const text = "## One\n1. a\n2. b\n\n## Two\ntext between\n\n1. x\n2. y";
		expect(edit("|", (s) => ({ ...s.replaceSelection(text), userEvent: "input.paste" }))).toBe(`${text}|`);
	});

	test("typing a number is left alone", () => {
		expect(edit("1. a\n2. b\n|3. c", (s) => ({ changes: { from: s.selection.main.head, to: s.selection.main.head + 1, insert: "9" }, userEvent: "input.type" }))).toBe("1. a\n2. b\n|9. c");
	});

	test("edits without a user event (reloads, plugins) are left alone", () => {
		expect(edit("1. a\n2. b\n3. c", (s) => ({ changes: { from: s.doc.line(2).from, to: s.doc.line(3).from } }))).toBe("1. a\n3. c");
	});

	test("toggling list types", () => {
		const toggle = (cmd: (s: EditorState) => TransactionSpec | null, marked: string) => {
			const state = stateOf(marked);
			const spec = cmd(state)!;
			return show(state.update(spec, { annotations: listEdit.of(true) }).state);
		};
		// A bullet between two ordered items splits the list; the part after keeps what it shows.
		expect(toggle(toggleBulletList, "1. a\n2. b|\n3. c")).toBe("1. a\n- b|\n3. c");
		// Lines numbered after a list continue it.
		expect(toggle(toggleNumberedList, "1. a\n2. b\n«c\nd»")).toBe("1. a\n2. b\n«3. c\n4. d»");
		// Back to an ordered item, the three join again.
		expect(toggle(toggleNumberedList, "1. a\n- b|\n3. c")).toBe("1. a\n2. b|\n3. c");
		expect(toggle(cycleListChecklist, "1. a\n2. b|")).toBe("1. a\n2. [ ] b|");
	});

	test("renumbering is part of the same undo step", () => {
		const state = stateOf("1. a\n2. b|\n3. c");
		const indented = press(state, indentListItems);
		expect(show(indented)).toBe("1. a\n\t1. b|\n2. c");
		let undone = indented;
		undo({ state: indented, dispatch: (tr) => (undone = tr.state) });
		expect(undone.doc.toString()).toBe("1. a\n2. b\n3. c");
	});

	test("a number growing a digit moves the item's children to its new content column", () => {
		expect(key("Enter", "8. h|\n9. i\n   - child", { tab: false })).toBe("8. h\n9. |\n10. i\n    - child");
		expect(key("Backspace", "8. h\n9. |i\n10. j\n    - child", { tab: false })).toBe("8. h\n   |i\n9. j\n   - child");
	});

	test("numbers in code blocks are not list items", () => {
		expect(key("Enter", "1. a|\n2. b\n\n```\n3. code\n```")).toBe("1. a\n2. |\n3. b\n\n```\n3. code\n```");
		expect(key("Enter", "1. a|\n   ```\n   5. code\n   ```\n2. b", { tab: false })).toBe("1. a\n2. |\n   ```\n   5. code\n   ```\n3. b");
	});

	test("a nested list not starting at 1 right under its parent's text is text, not a list", () => {
		// CommonMark: `3. x` cannot interrupt the paragraph "a", so it continues it.
		expect(key("Enter", "- a\n  3. x|")).toBe("- a\n  3. x\n- |");
	});
});

describe("Enter in a list item", () => {
	test("continues with the same bullet, the next number, an open task box", () => {
		expect(key("Enter", "* a|")).toBe("* a\n* |");
		expect(key("Enter", "+ a|")).toBe("+ a\n+ |");
		expect(key("Enter", "1. a|")).toBe("1. a\n2. |");
		expect(key("Enter", "- [x] done|")).toBe("- [x] done\n- [ ] |");
		expect(key("Enter", "1. [/] doing|")).toBe("1. [/] doing\n2. [ ] |");
	});

	test("carries the indentation of the item", () => {
		expect(key("Enter", "- a\n\t- b|")).toBe("- a\n\t- b\n\t- |");
		expect(key("Enter", "> - a|")).toBe("> - a\n> - |");
	});

	test("in the middle of the text splits it, the rest on the new item", () => {
		expect(key("Enter", "- ab|cd")).toBe("- ab\n- |cd");
		expect(key("Enter", "- [x] ab| cd")).toBe("- [x] ab\n- [ ] |cd");
	});

	test("at the start of the text adds an empty item above and keeps the text", () => {
		expect(key("Enter", "1. |a\n2. b")).toBe("1. \n2. |a\n3. b");
	});

	test("an item with children gets its new item as the first child", () => {
		expect(key("Enter", "- a|\n\t- x")).toBe("- a\n\t- |\n\t- x");
	});

	test("a folded item gets its new sibling after its children", () => {
		const state = stateOf("- a|\n\t- x\n- b");
		const line = state.doc.line(1);
		const folded = state.update({ effects: foldEffect.of({ from: line.to, to: state.doc.line(2).to }) }).state;
		expect(show(press(folded, ...keys.Enter))).toBe("- a\n\t- x\n- |\n- b");
	});

	test("an empty nested item moves one level out", () => {
		expect(key("Enter", "- a\n\t- |")).toBe("- a\n- |");
		expect(key("Enter", "1. a\n\t1. x\n\t2. |\n2. b")).toBe("1. a\n\t1. x\n2. |\n3. b");
	});

	test("an empty top-level item ends the list, with a blank line so typing stays out", () => {
		expect(key("Enter", "- a\n- |")).toBe("- a\n\n|");
		expect(key("Enter", "- a\n\n- |")).toBe("- a\n\n|");
		expect(key("Enter", "> - a\n> - |")).toBe("> - a\n>\n> |");
		expect(key("Enter", "- a\n- [ ] |")).toBe("- a\n\n|");
	});

	test("loose lists stay loose", () => {
		expect(key("Enter", "- a\n\n- b|")).toBe("- a\n\n- b\n\n- |");
	});

	test("a continuation line of an item starts the next item", () => {
		expect(key("Enter", "- a\n  more|\n- b")).toBe("- a\n  more\n- |\n- b");
	});

	test("multiple cursors", () => {
		expect(key("Enter", "1. a|\n2. b|")).toBe("1. a\n2. |\n3. b\n4. |");
	});

	test("list-like lines in the frontmatter are not list items", () => {
		const state = stateOf("---\ntags:\n  - a|\n---\n1. x");
		expect(press(state, insertListNewline)).toBe(state);
	});

	test("outside lists Enter is not a list key", () => {
		const state = stateOf("text|");
		expect(press(state, insertListNewline)).toBe(state);
		const code = stateOf("```\n- a|\n```");
		expect(press(code, insertListNewline)).toBe(code);
	});

	test("CRLF notes", () => {
		expect(key("Enter", "1. a\r\n2. b|\r\n3. c")).toBe("1. a\n2. b\n3. |\n4. c");
	});
});

describe("Shift+Enter in a list item", () => {
	test("adds a line in the same item, at its content column", () => {
		expect(key("Shift-Enter", "- a|", { tab: false })).toBe("- a\n  |");
		expect(key("Shift-Enter", "1. a|\n2. b", { tab: false })).toBe("1. a\n   |\n2. b");
		expect(key("Shift-Enter", "- a|")).toBe("- a\n\t|");
		expect(key("Shift-Enter", "> - a|", { tab: false })).toBe("> - a\n>   |");
	});
});

describe("Backspace in a list item", () => {
	test("after an empty task's box removes the box", () => {
		expect(key("Backspace", "- [ ] |")).toBe("- |");
		expect(key("Backspace", "- [x] |done")).toBe("- |done");
	});

	test("after the marker of an empty nested item moves it one level out", () => {
		expect(key("Backspace", "- a\n\t- |")).toBe("- a\n- |");
	});

	test("after the marker of an empty top-level item removes the marker", () => {
		expect(key("Backspace", "- a\n- |")).toBe("- a\n|");
		expect(key("Backspace", "> - a\n> - |")).toBe("> - a\n> |");
	});

	test("at the start of an item's text makes it a continuation line of the item above", () => {
		expect(key("Backspace", "- a\n- |b", { tab: false })).toBe("- a\n  |b");
		expect(key("Backspace", "1. a\n2. |b\n3. c", { tab: false })).toBe("1. a\n   |b\n2. c");
		expect(key("Backspace", "- a\n\t- a1\n- |b")).toBe("- a\n\t- a1\n\t\t|b");
	});

	test("the first item of a list becomes a paragraph", () => {
		expect(key("Backspace", "- |a\n- b")).toBe("|a\n- b");
	});
});

describe("very long lists", () => {
	// A wall-clock budget fails on slow CI runners (8× slower than a laptop),
	// so the guard is the growth: linear work is about 5× from 2,000 to 10,000
	// items, a quadratic renumbering about 25×.
	test("Enter in a long list renumbers it in time linear in the list's length", () => {
		const run = (n: number) => {
			const doc = Array.from({ length: n }, (_, i) => `${i + 1}. item`).join("\n");
			const state = stateOf(`1. first|\n${doc}`);
			const t = performance.now();
			const next = press(state, ...keys.Enter);
			const elapsed = performance.now() - t;
			expect(next.doc.line(n + 2).text).toBe(`${n + 2}. item`);
			return elapsed;
		};
		run(2000); // warms up the parser and the JIT
		const small = Math.min(run(2000), run(2000));
		const large = Math.min(run(10000), run(10000));
		expect(large / small).toBeLessThan(12);
	});
});
