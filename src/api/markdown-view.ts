import { openSearchPanel } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { bindEditorFields, Editor } from "./editor";
import { markdownEditorExtensions } from "./editor-extensions";
import { Keymap } from "./keymap";
import { Menu } from "./ui/menu";
import { TFile } from "./vault";
import { TextFileView } from "./view";
import type { WorkspaceLeaf } from "./workspace";

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

	#createState(doc: string) {
		return EditorState.create({ doc, extensions: markdownEditorExtensions(this, this.#plugins) });
	}

	resolveImage(link: string) {
		if (/^[a-z][\w+.-]*:/i.test(link)) return link;
		const file = this.app.metadataCache.getFirstLinkpathDest(link, this.file?.path ?? "");
		return file ? this.app.vault.getResourcePath(file) : null;
	}

	// Rendered links open on click, as in Obsidian's Live Preview.
	onLinkClick(evt: MouseEvent) {
		const el = evt.button === 0 ? (evt.target as HTMLElement).closest("[data-href]") : null;
		if (!el) return false;
		evt.preventDefault();
		const href = el.getAttribute("data-href")!;
		if (/^[a-z][\w+.-]*:/i.test(href)) require("electron").shell.openExternal(href);
		else this.app.workspace.openLinkText(decodeURI(href), this.file?.path ?? "", Keymap.isModEvent(evt));
		return true;
	}

	reconfigureExtensions() {
		this.editor.cm.dispatch({ effects: this.#plugins.reconfigure(this.app.workspace.editorExtensions) });
	}

	showContextMenu(evt: MouseEvent) {
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
