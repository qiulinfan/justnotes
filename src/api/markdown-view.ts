import { openSearchPanel } from "@codemirror/search";
import { EditorSelection, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Editor, EditorPosition } from "./editor";
import type { Component } from "./events";
import { setIcon, setTooltip } from "./icons";
import { locateFrontmatter } from "./frontmatter-edit";
import { Keymap, Scope } from "./keymap";
import { addUrlMenuItems } from "./markdown";
import { MarkdownEditView, MarkdownPreviewView, type MarkdownSubView, subpathLine } from "./markdown-preview";
import { editorMetadataHost, metadataEditorOf } from "./metadata-editor";
import { Menu } from "./ui/menu";
import type { HoverPopover } from "./ui/popover";
import { mirrorEdits, TextFileView, type ViewStateResult } from "./view";
import type { WorkspaceLeaf } from "./workspace";

const SCHEME = /^[a-z][\w+.-]*:/i;

// The backlinks shown under a note, made by the backlink core plugin's
// instance (`createEmbeddedBacklinks`) while it is enabled.
export interface EmbeddedBacklinks extends Component {
	containerEl: HTMLElement;
	// The view's file changed.
	update(): void;
}

export class MarkdownView extends TextFileView {
	editor: Editor;
	editMode: MarkdownEditView;
	previewMode: MarkdownPreviewView;
	currentMode: MarkdownSubView;
	modes: { source: MarkdownEditView; preview: MarkdownPreviewView };
	sourceEl: HTMLElement;
	hoverPopover: HoverPopover | null = null;
	scope: Scope;
	// Source mode: editing with Live Preview off.
	#source: boolean;
	// Backlinks under the note: backlink.json's backlinkInDocument for a new
	// view, then the leaf's own state.
	#backlinks: boolean;
	backlinks: EmbeddedBacklinks | null = null;
	#crlf = false;
	// The exact text the editor's document stands for while unedited, so an
	// untouched file saves back byte for byte (line endings included).
	#pristine: { doc: Text; text: string } | null = null;
	#modeButton: HTMLElement;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		// Panes of one note show one document: each edit reaches the others.
		mirrorEdits(this);
		this.scope = new Scope(this.app.scope);
		this.contentEl.addClass("markdown-view");
		this.editMode = new MarkdownEditView(this);
		this.editor = this.editMode.editor;
		this.sourceEl = this.editMode.containerEl;
		this.previewMode = this.addChild(new MarkdownPreviewView(this));
		this.modes = { source: this.editMode, preview: this.previewMode };
		this.currentMode = this.editMode;
		this.#backlinks = !!this.app.internalPlugins?.getEnabledPluginById("backlink")?.options.backlinkInDocument;
		this.#source = this.app.vault.getConfig("livePreview") === false;
		if (this.#source) this.editMode.setLivePreview(false);
		this.#modeButton = this.addAction("book-open", "", () => this.toggleMode());
		if (this.app.vault.getConfig("defaultViewMode") === "preview") this.#showMode(this.previewMode);
		this.#syncModeUi();
	}

	getViewType() {
		return "markdown";
	}

	getIcon() {
		return "lucide-file";
	}

	getMode(): "source" | "preview" {
		return this.currentMode === this.previewMode ? "preview" : "source";
	}

	canAcceptExtension(extension: string) {
		return extension === "md";
	}

	getState(): Record<string, any> {
		return { ...super.getState(), mode: this.getMode(), source: this.#source, backlinks: this.#backlinks };
	}

	// A state without a mode (a file opened in this leaf) keeps the leaf's mode.
	async setState(state: any, result: ViewStateResult) {
		await super.setState(state, result);
		if (typeof state?.source === "boolean") this.setSource(state.source);
		if (typeof state?.backlinks === "boolean") this.setBacklinks(state.backlinks);
		if (state?.mode === "preview") await this.setMode(this.previewMode);
		else if (state?.mode === "source") await this.setMode(this.editMode);
	}

	async setMode(mode: MarkdownSubView) {
		if (mode === this.currentMode || (mode !== this.editMode && mode !== this.previewMode)) return;
		const scroll = this.currentMode.getScroll();
		const focused = this.containerEl.contains(this.containerEl.doc.activeElement);
		if (mode === this.previewMode) this.previewMode.set(this.editor.getValue(), false);
		await this.#showMode(mode);
		mode.applyScroll(scroll);
		if (focused) this.#focusMode();
		this.app.workspace.trigger("layout-change");
		this.app.workspace.requestSaveLayout();
	}

	setBacklinks(on: boolean) {
		if (on === this.#backlinks) return;
		this.#backlinks = on;
		this.#syncBacklinks();
		this.app.workspace.requestSaveLayout();
	}

	toggleBacklinks() {
		this.setBacklinks(!this.#backlinks);
	}

	// The backlink core plugin was turned on or off.
	refreshBacklinks() {
		this.#syncBacklinks();
	}

	// Creates or drops the backlinks under the note and puts them in the
	// current mode: under the editor's last line or in the reading view's
	// footer.
	#syncBacklinks() {
		const factory = this.app.internalPlugins?.getEnabledPluginById("backlink")?.createEmbeddedBacklinks as ((view: MarkdownView) => EmbeddedBacklinks) | undefined;
		const want = this.#backlinks && !!this.file && !!factory;
		if (!want) {
			if (this.backlinks) {
				this.editMode.setFooter(null);
				this.backlinks.containerEl.remove();
				this.removeChild(this.backlinks);
				this.backlinks = null;
			}
			return;
		}
		if (!this.backlinks) this.backlinks = this.addChild(factory!(this));
		else this.backlinks.update();
		const el = this.backlinks.containerEl;
		if (this.getMode() === "preview") {
			this.editMode.setFooter(null);
			this.previewMode.renderer.footerEl.append(el);
		} else this.editMode.setFooter(el);
	}

	toggleMode() {
		return this.setMode(this.getMode() === "preview" ? this.editMode : this.previewMode);
	}

	setSource(source: boolean) {
		if (source === this.#source) return;
		this.#source = source;
		this.editMode.setLivePreview(!source);
		this.app.workspace.requestSaveLayout();
	}

	toggleSource() {
		this.setSource(!this.#source);
	}

	#showMode(mode: MarkdownSubView) {
		this.currentMode = mode;
		const preview = mode === this.previewMode;
		this.editMode.containerEl.toggle(!preview);
		this.#syncModeUi();
		if (this.backlinks) this.#syncBacklinks();
		if (preview) return this.previewMode.show();
		this.previewMode.hide();
	}

	#syncModeUi() {
		const preview = this.getMode() === "preview";
		this.containerEl.setAttr("data-mode", this.getMode());
		setIcon(this.#modeButton, preview ? "pencil" : "book-open");
		setTooltip(this.#modeButton, preview ? "Current view: reading. Click to edit." : "Current view: editing. Click to read.");
	}

	#focusMode() {
		if (this.getMode() === "preview") this.previewMode.focus();
		else this.editor.focus();
	}

	resolveImage(link: string) {
		if (/^[a-z][\w+.-]*:/i.test(link)) return link;
		const file = this.app.metadataCache.getFirstLinkpathDest(link, this.file?.path ?? "");
		return file ? this.app.vault.getResourcePath(file) : null;
	}

	// Rendered links open on click, as in Obsidian's Live Preview; a link to a
	// heading or block of this note (even in a pinned tab) moves within it. A
	// URL goes through window.open to the main process, which decides where
	// each scheme opens. A note link's data-href is its link text as written
	// in a wikilink, or decoded from a Markdown link, as in the reading view.
	onLinkClick(evt: MouseEvent) {
		const el = evt.button === 0 ? (evt.target as HTMLElement).closest("[data-href]") : null;
		if (!el) return false;
		evt.preventDefault();
		const href = el.getAttribute("data-href")!;
		const newLeaf = Keymap.isModEvent(evt);
		if (SCHEME.test(href)) window.open(href, "_blank");
		else if (href.startsWith("#") && !newLeaf) this.setEphemeralState({ subpath: href });
		else this.app.workspace.openLinkText(href, this.file?.path ?? "", newLeaf);
		return true;
	}

	reconfigureExtensions() {
		this.editMode.reconfigure();
	}

	showContextMenu(evt: MouseEvent) {
		const menu = new Menu();
		menu.addSections(["selection-link", "selection", "selection.format", "clipboard", "action", "info", "view", "system"]);
		const editor = this.editor;
		// A link under the pointer: a note link gets the workspace's link menu,
		// a URL its own items and the 'url-menu' event.
		const href = (evt.target as Element | null)?.closest?.("[data-href]")?.getAttribute("data-href");
		if (href && SCHEME.test(href)) addUrlMenuItems(this.app, menu, href);
		else if (href) this.app.workspace.handleLinkContextMenu(menu, href, this.file?.path ?? "", this.leaf);
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

	onPaneMenu(menu: Menu, source: string) {
		if (source === "more-options") {
			const preview = this.getMode() === "preview";
			menu.addItem((i) =>
				i
					.setTitle(preview ? "Editing view" : "Reading view")
					.setIcon(preview ? "pencil" : "book-open")
					.setSection("view")
					.onClick(() => this.toggleMode()),
			);
			if (!preview) {
				menu.addItem((i) =>
					i
						.setTitle("Source mode")
						.setIcon("code")
						.setChecked(this.#source)
						.setSection("view")
						.onClick(() => this.toggleSource()),
				);
			}
			menu.addItem((i) =>
				i
					.setTitle("Add file property")
					.setIcon("plus-circle")
					.setSection("action")
					.onClick(() => this.addProperty()),
			);
			menu.addItem((i) =>
				i
					.setTitle("Find...")
					.setIcon("search")
					.setSection("find")
					.onClick(() => this.showSearch(false)),
			);
			if (!preview) {
				menu.addItem((i) =>
					i
						.setTitle("Replace...")
						.setIcon("replace")
						.setSection("find")
						.onClick(() => this.showSearch(true)),
				);
			}
		}
		super.onPaneMenu(menu, source);
	}

	getViewData() {
		const doc = this.editor.cm.state.doc;
		if (this.#pristine?.doc === doc) return this.#pristine.text;
		const text = doc.toString();
		return this.#crlf ? text.replace(/\n/g, "\r\n") : text;
	}

	// CodeMirror keeps LF line breaks; a file whose first line break is CRLF
	// is written back with CRLF.
	setViewData(data: string, clear: boolean) {
		if (clear) this.#crlf = /^[^\n]*\r\n/.test(data);
		const text = data.replace(/\r\n?/g, "\n");
		this.editMode.set(text, clear);
		if (clear) this.previewMode.set(text, true);
		this.#pristine = { doc: this.editor.cm.state.doc, text: data };
		if (clear) this.#syncBacklinks();
	}

	clear() {
		this.editMode.clear();
		this.previewMode.clear();
		this.#pristine = null;
	}

	// "Add file property": a new row in the Properties block, which a note
	// without frontmatter gets first. Where the block does not show (source
	// mode, or properties shown as source or hidden) the caret goes to a new
	// line at the end of the YAML.
	addProperty() {
		const cm = this.editor.cm;
		const host = editorMetadataHost(cm, this.app, () => this.file?.path ?? "");
		if (host.getYaml() === null) cm.dispatch({ changes: { from: 0, insert: "---\n---\n" }, userEvent: "input.properties" });
		const preview = this.getMode() === "preview";
		const visible = (this.app.vault.getConfig("propertiesInDocument") ?? "visible") === "visible";
		const editor = !visible ? undefined : preview ? this.previewMode.metadataEditor : metadataEditorOf(cm.contentDOM.querySelector(".metadata-container"));
		if (editor) return editor.addProperty();
		if (preview) return;
		const fm = locateFrontmatter(cm.state.doc.toString());
		if (!fm) return;
		cm.dispatch({ changes: { from: fm.yamlTo, insert: "\n" }, selection: { anchor: fm.yamlTo }, scrollIntoView: true });
		cm.focus();
	}

	showSearch(replace = false) {
		if (this.getMode() === "preview") return this.previewMode.showSearch();
		const cm = this.editor.cm;
		openSearchPanel(cm);
		if (replace) cm.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]")?.focus();
	}

	onResize() {
		this.editor.cm.requestMeasure();
	}

	// The editor is destroyed with the view, so plugin ViewPlugins stop.
	onunload() {
		const suggest = this.app.workspace.editorSuggest;
		if ((suggest.currentSuggest as { context?: { editor?: unknown } | null } | null)?.context?.editor === this.editor) suggest.close();
		this.editMode.destroy();
		super.onunload();
	}

	getEphemeralState(): Record<string, any> {
		const state: Record<string, any> = {};
		if (this.getMode() === "source") state.cursor = { from: this.editor.getCursor("anchor"), to: this.editor.getCursor("head") };
		state.scroll = this.currentMode.getScroll();
		return state;
	}

	// cursor {from, to}, scroll (a top line), line, subpath (#heading or
	// #^block) and focus, as Obsidian's openFile/openLinkText eState carries them.
	setEphemeralState(state: any) {
		if (!state || typeof state !== "object") return;
		const subpath = typeof state.subpath === "string" && state.subpath ? this.#subpathLine(state.subpath) : null;
		const line = subpath ?? (typeof state.line === "number" ? state.line : null);
		const cursor = isRange(state.cursor) ? state.cursor : null;
		const scroll = typeof state.scroll === "number" ? state.scroll : null;
		const cm = this.editor.cm;
		const doc = cm.state.doc;
		const offset = (pos: EditorPosition) => {
			const l = doc.line(Math.min(Math.max(Math.floor(pos.line) + 1, 1), doc.lines));
			return Math.min(l.from + Math.max(0, pos.ch), l.to);
		};
		const selection = cursor
			? EditorSelection.single(offset(cursor.from), offset(cursor.to))
			: line !== null
				? EditorSelection.single(offset({ line, ch: 0 }))
				: null;
		if (this.getMode() === "preview") {
			if (selection) cm.dispatch({ selection });
			const top = scroll ?? line;
			if (top !== null) this.previewMode.applyScroll(top);
		} else if (scroll !== null) {
			if (selection) cm.dispatch({ selection });
			this.editMode.applyScroll(scroll);
		} else if (selection) {
			cm.dispatch({ selection, effects: EditorView.scrollIntoView(selection.main.head, { y: subpath !== null ? "start" : "center" }) });
		}
		if (state.focus) this.#focusMode();
	}

	#subpathLine(subpath: string) {
		return subpathLine(this.file ? this.app.metadataCache.getFileCache(this.file) : null, subpath);
	}
}

function isRange(value: any): value is { from: EditorPosition; to: EditorPosition } {
	const pos = (p: any) => typeof p?.line === "number" && typeof p?.ch === "number";
	return !!value && pos(value.from) && pos(value.to);
}
