import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { classHighlighter, tags as t } from "@lezer/highlight";
import { bindEditorFields, Editor, editorEditorField, editorInfoField, editorLivePreviewField } from "./editor";
import { Menu } from "./ui/menu";
import { TFile } from "./vault";
import { TextFileView } from "./view";
import type { WorkspaceLeaf } from "./workspace";

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
]);

export class MarkdownView extends TextFileView {
	editor: Editor;
	sourceEl: HTMLElement;
	previewMode = { containerEl: createDiv("markdown-preview-view"), rerender: () => {} };
	currentMode: { type: "source"; editor?: Editor };
	#plugins = new Compartment();

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.contentEl.addClass("markdown-view");
		this.sourceEl = this.contentEl.createDiv("markdown-source-view cm-s-obsidian mod-cm6 is-live-preview is-readable-line-width");
		const cm = new EditorView({ state: this.#createState(""), parent: this.sourceEl });
		this.editor = new Editor(cm);
		this.currentMode = { type: "source", editor: this.editor };
		bindEditorFields(cm, this);
	}

	getViewType() {
		return "markdown";
	}

	getIcon() {
		return "lucide-file-text";
	}

	getMode() {
		return "source" as const;
	}

	canAcceptExtension(extension: string) {
		return extension === "md";
	}

	onload() {
		this.registerEvent(
			this.app.vault.on("modify", async (file: TFile) => {
				if (file !== this.file || this.getViewData() !== this.data) return;
				const text = await this.app.vault.read(file);
				if (text !== this.data) {
					this.data = text;
					this.setViewData(text, false);
				}
			}),
		);
	}

	#baseExtensions(): Extension[] {
		const ext: Extension[] = [
			editorInfoField.init(() => this),
			editorEditorField.init(() => this.editor?.cm ?? null),
			editorLivePreviewField,
			this.#plugins.of(this.app.workspace.editorExtensions),
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
			markdown({ base: markdownLanguage, codeLanguages: languages }),
			syntaxHighlighting(obsidianHighlight),
			syntaxHighlighting(classHighlighter),
			keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
			EditorView.updateListener.of((u) => {
				const suggest = this.app.workspace.editorSuggest;
				// Suggests re-check after the update finishes: a suggest that is
				// itself inserting text must not be closed mid-insert.
				const retrigger = () => queueMicrotask(() => suggest.trigger(this.editor, this.file));
				if (u.docChanged) {
					this.requestSave();
					this.app.workspace.trigger("editor-change", this.editor, this);
					if (u.transactions.some((tr) => tr.isUserEvent("input.type") || tr.isUserEvent("delete"))) retrigger();
				} else if (u.selectionSet && suggest.isShowingSuggestion()) {
					retrigger();
				}
				if (u.focusChanged) {
					if (u.view.hasFocus) this.app.workspace.setActiveLeaf(this.leaf);
					else suggest.close();
				}
			}),
			EditorView.domEventHandlers({
				contextmenu: (evt) => {
					evt.preventDefault();
					this.#showContextMenu(evt);
					return true;
				},
				paste: (evt) => {
					this.app.workspace.trigger("editor-paste", evt, this.editor, this);
					return evt.defaultPrevented;
				},
				drop: (evt) => {
					this.app.workspace.trigger("editor-drop", evt, this.editor, this);
					return evt.defaultPrevented;
				},
			}),
		];
		if (this.app.vault.getConfig("showLineNumber")) ext.push(lineNumbers());
		return ext;
	}

	#createState(doc: string) {
		return EditorState.create({ doc, extensions: this.#baseExtensions() });
	}

	reconfigureExtensions() {
		this.editor.cm.dispatch({ effects: this.#plugins.reconfigure(this.app.workspace.editorExtensions) });
	}

	#showContextMenu(evt: MouseEvent) {
		const menu = new Menu();
		const editor = this.editor;
		menu.addItem((i) =>
			i
				.setTitle("Cut")
				.setIcon("scissors")
				.setSection("clipboard")
				.onClick(() => {
					navigator.clipboard.writeText(editor.getSelection());
					editor.replaceSelection("");
				}),
		);
		menu.addItem((i) =>
			i
				.setTitle("Copy")
				.setIcon("copy")
				.setSection("clipboard")
				.onClick(() => navigator.clipboard.writeText(editor.getSelection())),
		);
		menu.addItem((i) =>
			i
				.setTitle("Paste")
				.setIcon("clipboard-type")
				.setSection("clipboard")
				.onClick(async () => editor.replaceSelection(await navigator.clipboard.readText())),
		);
		menu.addItem((i) =>
			i
				.setTitle("Select all")
				.setIcon("text-select")
				.setSection("selection")
				.onClick(() => editor.setSelection({ line: 0, ch: 0 }, editor.offsetToPos(editor.getValue().length))),
		);
		this.app.workspace.trigger("editor-menu", menu, editor, this);
		menu.showAtMouseEvent(evt);
	}

	getViewData() {
		return this.editor.getValue();
	}

	setViewData(data: string, clear: boolean) {
		const cm = this.editor.cm;
		if (clear) {
			cm.setState(this.#createState(data));
			bindEditorFields(cm, this);
		} else {
			const head = Math.min(cm.state.selection.main.head, data.length);
			cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: data }, selection: { anchor: head } });
		}
	}

	clear() {
		this.editor.cm.setState(this.#createState(""));
		bindEditorFields(this.editor.cm, this);
	}

	async onLoadFile(file: TFile) {
		await super.onLoadFile(file);
		this.containerEl.setAttr("data-type", "markdown");
	}

	showSearch(_replace?: boolean) {
		openSearchPanel(this.editor.cm);
	}

	onResize() {
		this.editor.cm.requestMeasure();
	}

	setEphemeralState(state: any) {
		if (state?.line !== undefined) {
			const pos = { line: state.line, ch: 0 };
			this.editor.setCursor(pos);
			this.editor.scrollIntoView({ from: pos, to: pos }, true);
		}
	}
}
