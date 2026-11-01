import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import type { App } from "../api/app";
import { isCodeFile } from "../api/code-files";
import { codeHighlight } from "../api/editor-extensions";
import { TextFileView } from "../api/view";
import type { WorkspaceLeaf } from "../api/workspace";

// Marks the edits setViewData makes, which are the file's text, not the user's.
const fromFile = Annotation.define<boolean>();

// Source and data files (api/code-files.ts) in a plain CodeMirror editor with
// line numbers, folding, search and the language's highlighting, chosen from
// the file name through @codemirror/language-data. Saving, outside changes and
// the quit flush go through TextFileView, as for notes.
export class CodeView extends TextFileView {
	#editor: EditorView;
	#language = new Compartment();
	#loaded: string | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "file-code";
		const host = this.contentEl.createDiv("markdown-source-view cm-s-obsidian mod-cm6 code-file-view");
		this.#editor = new EditorView({ parent: host, state: this.#state("") });
	}

	getViewType() {
		return "code";
	}

	// The whole name: "main.rs", not "main", since the extension says what it is.
	getDisplayText() {
		return this.file?.name ?? "Code";
	}

	canAcceptExtension(extension: string) {
		return isCodeFile({ name: "", extension });
	}

	getViewData() {
		return this.#editor.state.doc.toString();
	}

	// A new file starts fresh (its own undo history); the same file's text
	// from outside replaces only what changed, so the cursor stays put.
	setViewData(data: string, clear: boolean) {
		if (clear) {
			this.#editor.setState(this.#state(data));
			this.#loadLanguage(data);
			return;
		}
		const old = this.#editor.state.doc.toString();
		if (old === data) return;
		let from = 0;
		while (from < old.length && from < data.length && old[from] === data[from]) from++;
		let end = 0;
		while (end < old.length - from && end < data.length - from && old[old.length - 1 - end] === data[data.length - 1 - end]) end++;
		this.#editor.dispatch({ changes: { from, to: old.length - end, insert: data.slice(from, data.length - end) }, annotations: fromFile.of(true) });
	}

	clear() {
		this.#editor.setState(this.#state(""));
	}

	onunload() {
		this.#editor.destroy();
		super.onunload();
	}

	#state(doc: string) {
		const extensions: Extension[] = [
			lineNumbers(),
			highlightActiveLineGutter(),
			foldGutter(),
			history(),
			drawSelection(),
			indentOnInput(),
			bracketMatching(),
			highlightActiveLine(),
			highlightSelectionMatches(),
			search({ top: true }),
			syntaxHighlighting(codeHighlight),
			this.#language.of([]),
			keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap, indentWithTab]),
			EditorView.updateListener.of((update) => {
				if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromFile))) this.requestSave();
			}),
		];
		return EditorState.create({ doc, extensions });
	}

	// Languages load on demand; a file opened meanwhile wins. A name that says
	// nothing (a plugin's own format) is read as JSON when its text is JSON.
	#loadLanguage(text: string) {
		const name = this.file?.name ?? "";
		this.#loaded = name;
		const description = LanguageDescription.matchFilename(languages, name) ?? languageByExtension(this.file?.extension ?? "") ?? languageByText(text);
		if (!description) return;
		description
			.load()
			.then((support) => {
				if (this.#loaded === name) this.#editor.dispatch({ effects: this.#language.reconfigure(support) });
			})
			.catch((err) => console.error("Could not load the language of", name, err));
	}
}

// Extensions language-data does not list under their own name.
const ALIASES: Record<string, string> = { jsonc: "JSON", json5: "JSON", lock: "JSON", mts: "TypeScript", cts: "TypeScript", zsh: "Shell", fish: "Shell", bash: "Shell", env: "Properties files", conf: "Properties files", cfg: "Properties files", plist: "XML", tsv: "CSV" };

function languageByExtension(extension: string) {
	const alias = ALIASES[extension.toLowerCase()];
	return alias ? (LanguageDescription.matchLanguageName(languages, alias, true) ?? null) : null;
}

function languageByText(text: string) {
	if (!/^\s*[[{]/.test(text)) return null;
	try {
		JSON.parse(text);
	} catch {
		return null;
	}
	return LanguageDescription.matchLanguageName(languages, "JSON", true) ?? null;
}

export function registerCodeView(app: App) {
	app.viewRegistry.registerView("code", (leaf) => new CodeView(leaf));
}
