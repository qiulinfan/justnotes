import { defaultKeymap, history, historyKeymap, indentLess, indentMore, insertTab } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, highlightActiveLine, keymap } from "@codemirror/view";
import type { App } from "../api/app";
import { Editor } from "../api/editor";
import { TextFileView } from "../api/view";
import type { WorkspaceLeaf } from "../api/workspace";

export const PLAIN_TEXT_VIEW = "plain-text";
export const PLAIN_TEXT_EXTENSIONS = ["txt"];

// Tab indents a selection of lines and types a tab anywhere else, as a plain
// text editor does.
function tab(view: EditorView) {
	return view.state.selection.ranges.some((r) => !r.empty) ? indentMore(view) : insertTab(view);
}

// A `.txt` file as text: CodeMirror without a language or Markdown
// decorations, soft-wrapped, saved through TextFileView like a note. Its
// `textEditor` is an Editor for the app's editor commands that make sense in
// plain text (those registered with `plainText`); it is not the view's
// `editor`, so it never becomes the workspace's active Markdown editor, which
// plugins expect to be a MarkdownView.
export class PlainTextView extends TextFileView {
	editorView: EditorView;
	textEditor: Editor;
	// Set while setViewData replaces the document, which is no edit to save.
	#loading = false;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.contentEl.addClass("plain-text-view");
		this.contentEl.toggleClass("is-readable-line-width", this.app.vault.getConfig("readableLineLength") !== false);
		this.editorView = new EditorView({ state: this.#state(""), parent: this.contentEl });
		this.textEditor = new Editor(this.editorView);
	}

	getViewType() {
		return PLAIN_TEXT_VIEW;
	}

	getIcon() {
		return "file-text";
	}

	canAcceptExtension(extension: string) {
		return PLAIN_TEXT_EXTENSIONS.includes(extension);
	}

	getViewData() {
		return this.editorView.state.doc.toString();
	}

	// A new file gets a fresh state (its own undo history); text merged in from
	// outside replaces only what changed, keeping the cursor and history.
	setViewData(data: string, clear: boolean) {
		this.#loading = true;
		try {
			if (clear) this.editorView.setState(this.#state(data));
			else {
				const current = this.editorView.state.doc.toString();
				if (current !== data) {
					let from = 0;
					while (from < current.length && from < data.length && current[from] === data[from]) from++;
					let a = current.length;
					let b = data.length;
					while (a > from && b > from && current[a - 1] === data[b - 1]) {
						a--;
						b--;
					}
					this.editorView.dispatch({ changes: { from, to: a, insert: data.slice(from, b) } });
				}
			}
		} finally {
			this.#loading = false;
		}
	}

	clear() {
		this.setViewData("", true);
	}

	onResize() {
		this.editorView.requestMeasure();
	}

	focus() {
		this.editorView.focus();
	}

	#state(doc: string) {
		return EditorState.create({ doc, extensions: this.#extensions() });
	}

	#extensions(): Extension[] {
		return [
			history(),
			drawSelection(),
			dropCursor(),
			EditorState.allowMultipleSelections.of(true),
			EditorView.clickAddsSelectionRange.of((evt) => evt.altKey),
			highlightActiveLine(),
			highlightSelectionMatches(),
			search({ top: true }),
			EditorView.lineWrapping,
			EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
			keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, { key: "Tab", run: tab, shift: indentLess }]),
			EditorView.updateListener.of((u) => {
				if (u.docChanged && !this.#loading) {
					this.requestSave();
					this.app.workspace.trigger("editor-change", this.textEditor, this);
				}
				if (u.focusChanged && u.view.hasFocus) this.app.workspace.setActiveLeaf(this.leaf);
			}),
		];
	}

	// Opening at a place (search results, links, the CLI): eState's cursor
	// {from, to} or line, scrolled to the middle; `focus` focuses the editor.
	setEphemeralState(state: any) {
		if (!state || typeof state !== "object") return;
		const doc = this.editorView.state.doc;
		const offset = (pos: { line: number; ch: number }) => {
			const line = doc.line(Math.min(Math.max(Math.floor(pos.line) + 1, 1), doc.lines));
			return Math.min(line.from + Math.max(0, pos.ch), line.to);
		};
		const cursor = state.cursor;
		const selection =
			typeof cursor?.from?.line === "number" && typeof cursor?.to?.line === "number"
				? EditorSelection.single(offset(cursor.from), offset(cursor.to))
				: typeof state.line === "number"
					? EditorSelection.single(offset({ line: state.line, ch: 0 }))
					: null;
		if (selection) this.editorView.dispatch({ selection, effects: EditorView.scrollIntoView(selection.main.head, { y: "center" }) });
		if (state.focus) this.editorView.focus();
	}
}

export function registerPlainTextView(app: App) {
	app.viewRegistry.registerViewWithExtensions(PLAIN_TEXT_EXTENSIONS, PLAIN_TEXT_VIEW, (leaf) => new PlainTextView(leaf));
}

// The active text editor that is no Markdown editor (a `.txt` file), for
// the editor commands registered with `plainText`.
export function activePlainTextView(app: App): PlainTextView | null {
	const view = app.workspace.activeLeaf?.view;
	return view instanceof PlainTextView ? view : null;
}
