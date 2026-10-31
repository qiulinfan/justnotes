import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { type Compartment, type Extension, Prec } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { classHighlighter, tags as t } from "@lezer/highlight";
import { editorEditorField, editorInfoField, editorLivePreviewField } from "./editor";
import { livePreview, mathSyntax, mathTag } from "./live-preview";
import type { MarkdownView } from "./markdown-view";

// Obsidian's editor token classes, which themes and plugin CSS target.
const obsidianHighlight = HighlightStyle.define([
	{ tag: t.heading1, class: "cm-header cm-header-1" },
	{ tag: t.heading2, class: "cm-header cm-header-2" },
	{ tag: t.heading3, class: "cm-header cm-header-3" },
	{ tag: t.heading4, class: "cm-header cm-header-4" },
	{ tag: t.heading5, class: "cm-header cm-header-5" },
	{ tag: t.heading6, class: "cm-header cm-header-6" },
	{ tag: t.strong, class: "cm-strong" },
	{ tag: t.emphasis, class: "cm-em" },
	{ tag: t.strikethrough, class: "cm-strikethrough" },
	{ tag: t.link, class: "cm-link" },
	{ tag: t.url, class: "cm-url" },
	{ tag: t.monospace, class: "cm-inline-code" },
	{ tag: t.quote, class: "cm-quote" },
	{ tag: t.list, class: "cm-list" },
	{ tag: [t.processingInstruction, t.contentSeparator], class: "cm-formatting" },
	{ tag: t.meta, class: "cm-meta" },
	{ tag: t.comment, class: "cm-comment" },
	{ tag: mathTag, class: "cm-math" },
]);

// Enter on an empty quote line steps out one quote level, as in Typora,
// instead of CodeMirror's default of continuing the quote.
function exitEmptyQuote(view: EditorView) {
	const { state } = view;
	const sel = state.selection;
	if (sel.ranges.length !== 1 || !sel.main.empty) return false;
	const line = state.doc.lineAt(sel.main.head);
	if (sel.main.head !== line.to || !/^\s*(>\s*)+$/.test(line.text)) return false;
	const outer = line.text.replace(/>\s*$/, "").trimEnd();
	const insert = outer ? `${outer} ` : "";
	view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + insert.length }, userEvent: "input" });
	return true;
}

// The CodeMirror configuration of a Markdown editor: language, highlighting,
// keymaps, Live Preview, and the hooks that connect it to its view.
// `plugins` holds the extensions plugins registered.
export function markdownEditorExtensions(view: MarkdownView, plugins: Compartment): Extension[] {
		const ext: Extension[] = [
			editorInfoField.init(() => view),
			editorEditorField.init(() => view.editor?.cm ?? null),
			editorLivePreviewField,
			plugins.of(view.app.workspace.editorExtensions),
			Prec.high(keymap.of([{ key: "Enter", run: exitEmptyQuote }])),
			history(),
			drawSelection(),
			dropCursor(),
			indentOnInput(),
			bracketMatching(),
			closeBrackets(),
			highlightSelectionMatches(),
			search({ top: true }),
			autocompletion({ override: [], activateOnTyping: false }),
			EditorView.lineWrapping,
			markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [mathSyntax] }),
			livePreview({ resolveImage: (link) => view.resolveImage(link) }),
			syntaxHighlighting(obsidianHighlight),
			syntaxHighlighting(classHighlighter),
			keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
			EditorView.updateListener.of((u) => {
				const suggest = view.app.workspace.editorSuggest;
				// Suggests re-check after the update finishes: a suggest that is
				// itself inserting text must not be closed mid-insert.
				const retrigger = () => queueMicrotask(() => suggest.trigger(view.editor, view.file));
				if (u.docChanged) {
					view.requestSave();
					view.app.workspace.trigger("editor-change", view.editor, view);
					if (u.transactions.some((tr) => tr.isUserEvent("input.type") || tr.isUserEvent("delete"))) retrigger();
				} else if (u.selectionSet && suggest.isShowingSuggestion()) {
					retrigger();
				}
				if (u.focusChanged) {
					if (u.view.hasFocus) view.app.workspace.setActiveLeaf(view.leaf);
					else suggest.close();
				}
			}),
			EditorView.domEventHandlers({
				mousedown: (evt) => view.onLinkClick(evt),
				contextmenu: (evt) => {
					evt.preventDefault();
					view.showContextMenu(evt);
					return true;
				},
				paste: (evt) => {
					view.app.workspace.trigger("editor-paste", evt, view.editor, view);
					return evt.defaultPrevented;
				},
				drop: (evt) => {
					view.app.workspace.trigger("editor-drop", evt, view.editor, view);
					return evt.defaultPrevented;
				},
			}),
		];
		if (view.app.vault.getConfig("showLineNumber")) ext.push(lineNumbers());
		return ext;
	}
