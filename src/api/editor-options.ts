// The Editor settings that shape a Markdown editor's CodeMirror
// configuration (app.json keys, Obsidian's names). Each editor holds them in
// a compartment and reconfigures it when the vault's settings change.
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { markdownKeymap } from "@codemirror/lang-markdown";
import { getIndentUnit, syntaxTree } from "@codemirror/language";
import { EditorSelection, type Extension, Prec, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { App } from "./app";
import { getElectron } from "./dom";
import { listKeymap, listRenumbering } from "./editor-lists";
import type { Menu } from "./ui/menu";

export interface EditorOptions {
	lineNumbers: boolean;
	autoPairBrackets: boolean;
	autoPairMarkdown: boolean;
	smartLists: boolean;
	spellcheck: boolean;
	rightToLeft: boolean;
	indentGuides: boolean;
}

export function editorOptions(app: App): EditorOptions {
	const on = (key: string) => app.vault.getConfig(key) === true;
	const notOff = (key: string) => app.vault.getConfig(key) !== false;
	return {
		lineNumbers: on("showLineNumber"),
		autoPairBrackets: notOff("autoPairBrackets"),
		autoPairMarkdown: notOff("autoPairMarkdown"),
		smartLists: notOff("smartIndentList"),
		spellcheck: notOff("spellcheck"),
		rightToLeft: on("rightToLeft"),
		indentGuides: notOff("showIndentGuide"),
	};
}

export function editorOptionExtensions(options: EditorOptions): Extension[] {
	const ext: Extension[] = [
		EditorView.contentAttributes.of({
			spellcheck: String(options.spellcheck),
			autocorrect: options.spellcheck ? "on" : "off",
			dir: options.rightToLeft ? "rtl" : "ltr",
		}),
	];
	if (options.lineNumbers) ext.push(lineNumbers());
	if (options.autoPairBrackets) ext.push(closeBrackets(), keymap.of(closeBracketsKeymap));
	if (options.autoPairMarkdown) ext.push(markdownPairs);
	// "Smart lists": list editing (editor-lists.ts: Enter, Shift+Enter,
	// Backspace and renumbering) first, then lang-markdown's keymap for what is
	// not a list (quote marks). Off, Enter and Backspace edit plain text.
	if (options.smartLists) ext.push(Prec.high(keymap.of(listKeymap)), listRenumbering, Prec.high(keymap.of(markdownKeymap)));
	if (options.indentGuides) ext.push(indentGuides);
	return ext;
}

// "Auto-pair Markdown syntax": a formatting mark typed over selected text
// wraps the text in it (`*` makes it italic, again bold), keeping the text
// selected.
const PAIRED_MARKS = new Set(["*", "_", "~", "=", "`", "$", "%"]);

export const markdownPairs = EditorView.inputHandler.of((view, _from, _to, text) => {
	const { state } = view;
	if (!PAIRED_MARKS.has(text) || state.readOnly || state.selection.ranges.some((r) => r.empty)) return false;
	view.dispatch(
		state.changeByRange((range) => ({
			changes: [
				{ from: range.from, insert: text },
				{ from: range.to, insert: text },
			],
			range: EditorSelection.range(range.anchor + text.length, range.head + text.length),
		})),
		{ userEvent: "input.type", scrollIntoView: true },
	);
	return true;
});

// "Show indentation guides" in the editor: the indentation of a list's
// lines is marked one indent (a tab, or an indent unit of spaces) at a time
// with `cm-indent`, whose border draws the guide.
const indentMark = Decoration.mark({ class: "cm-indent" });

function guideMarks(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const unit = Math.max(1, getIndentUnit(view.state));
	const tree = syntaxTree(view.state);
	for (const { from, to } of view.visibleRanges) {
		for (let pos = from; pos <= to; ) {
			const line = view.state.doc.lineAt(pos);
			pos = line.to + 1;
			const indent = /^[ \t]+/.exec(line.text)?.[0];
			if (!indent || indent.length === line.text.length) continue;
			let inList = false;
			for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(line.from + indent.length, 1); node; node = node.parent) {
				if (node.name === "ListItem") {
					inList = true;
					break;
				}
			}
			if (!inList) continue;
			let start = 0;
			let spaces = 0;
			for (let i = 0; i < indent.length; i++) {
				if (indent[i] === "\t") {
					builder.add(line.from + start, line.from + i + 1, indentMark);
					start = i + 1;
					spaces = 0;
				} else if (++spaces === unit) {
					builder.add(line.from + start, line.from + i + 1, indentMark);
					start = i + 1;
					spaces = 0;
				}
			}
		}
	}
	return builder.finish();
}

const indentGuides = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = guideMarks(view);
		}
		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) this.decorations = guideMarks(update.view);
		}
	},
	{ decorations: (plugin) => plugin.decorations },
);

// With Spellcheck on, a right-click on a misspelled word offers Chromium's
// suggestions and adding the word to the dictionary (the editor's menu is
// justnotes' own, so Electron's context-menu event never sees it).
export function addSpellingItems(app: App, menu: Menu, cm: EditorView, evt: MouseEvent) {
	if (app.vault.getConfig("spellcheck") === false) return;
	const pos = cm.posAtCoords({ x: evt.clientX, y: evt.clientY });
	const range = pos === null ? null : cm.state.wordAt(pos);
	if (!range) return;
	const word = cm.state.sliceDoc(range.from, range.to);
	const electron = getElectron();
	if (!electron.webFrame?.isWordMisspelled(word)) return;
	const suggestions: string[] = electron.webFrame.getWordSuggestions(word).slice(0, 5);
	for (const suggestion of suggestions) {
		menu.addItem((item) =>
			item
				.setTitle(suggestion)
				.setSection("spellcheck")
				.onClick(() => cm.dispatch({ changes: { from: range.from, to: range.to, insert: suggestion }, userEvent: "input.complete" })),
		);
	}
	if (!suggestions.length) menu.addItem((item) => item.setTitle("No suggestions").setSection("spellcheck").setDisabled(true));
	menu.addItem((item) =>
		item
			.setTitle("Add to dictionary")
			.setIcon("book-plus")
			.setSection("spellcheck")
			.onClick(() => electron.remote.getCurrentWebContents().session.addWordToSpellCheckerDictionary(word)),
	);
}
