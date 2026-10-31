import { Annotation, Compartment, EditorState, type Extension, StateField, type Text, Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { App } from "./app";
import { bindEditorFields, Editor, editorLivePreviewField } from "./editor";
import { markdownEditorExtensions } from "./editor-extensions";
import type { Component } from "./events";
import { setIcon, setTooltip } from "./icons";
import { Keymap } from "./keymap";
import { locateFrontmatter } from "./frontmatter-edit";
import { MarkdownPreviewRenderer, MarkdownRenderer, toggledTask } from "./markdown";
import type { MarkdownView } from "./markdown-view";
import { editorMetadataHost, MetadataEditor } from "./metadata-editor";
import type { CachedMetadata } from "./metadata";
import { resolveSubpath } from "./metadata-utils";
import type { HoverPopover } from "./ui/popover";
import { debounce } from "./util";
import type { TFile } from "./vault";
import { mergeText, mirrorsOf, textChanges } from "./view";

// One of a MarkdownView's two modes: editing (MarkdownEditView) and reading
// (MarkdownPreviewView). Scroll positions are 0-based source lines, so they
// carry over between the modes.
export interface MarkdownSubView {
	getScroll(): number;
	applyScroll(scroll: number): void;
	get(): string;
	set(data: string, clear: boolean): void;
}

// Marks edits copied from another pane of the note: they are not undoable
// here and are not passed on again.
const mirrored = Annotation.define<boolean>();

// The reading view whose find results own the document's search highlights.
let searching: MarkdownPreviewView | null = null;

// An element shown under the last line of the editor, scrolling with the
// text (the backlinks under a note). CodeMirror leaves events inside it alone.
class FooterWidget extends WidgetType {
	constructor(readonly el: HTMLElement) {
		super();
	}

	eq(other: FooterWidget) {
		return other.el === this.el;
	}

	toDOM() {
		return this.el;
	}

	get estimatedHeight() {
		return this.el.offsetHeight || 100;
	}

	ignoreEvent() {
		return true;
	}

	destroy() {}
}

function footerField(el: HTMLElement | null): Extension {
	if (!el) return [];
	const deco = Decoration.widget({ widget: new FooterWidget(el), block: true, side: 1 });
	const at = (state: EditorState) => Decoration.set(deco.range(state.doc.length));
	return StateField.define<DecorationSet>({
		create: at,
		update: (value, tr) => (tr.docChanged ? at(tr.state) : value),
		provide: (field) => EditorView.decorations.from(field),
	});
}

// The editing mode: the CodeMirror editor, in Live Preview or source mode.
export class MarkdownEditView implements MarkdownSubView {
	app: App;
	view: MarkdownView;
	type = "source" as const;
	hoverPopover: Component | null = null;
	containerEl: HTMLElement;
	editor: Editor;
	#plugins = new Compartment();
	#livePreview = new Compartment();
	#isLivePreview = true;
	#footer = new Compartment();
	#footerEl: HTMLElement | null = null;
	#footerObserver = new ResizeObserver(() => {
		if (!this.#destroyed) this.editor.cm.requestMeasure();
	});
	#scroll = 0;
	#destroyed = false;
	#stopMigration: () => void;
	// Plugins follow the active note's unsaved text through 'quick-preview'.
	#quickPreview = debounce(
		(file: TFile) => {
			if (!this.#destroyed && this.view.file === file) this.app.workspace.trigger("quick-preview", file, this.editor.getValue());
		},
		300,
		true,
	);

	constructor(view: MarkdownView) {
		this.view = view;
		this.app = view.app;
		this.containerEl = view.contentEl.createDiv("markdown-source-view cm-s-obsidian mod-cm6 is-live-preview is-readable-line-width");
		this.editor = new Editor(new EditorView({ state: this.#createState(""), parent: this.containerEl }));
		bindEditorFields(this.editor.cm, view);
		// CodeMirror reads the selection and listens to the window of its root;
		// a view moved to or from a popout window takes the new document.
		this.#stopMigration = this.containerEl.onWindowMigrated(() => this.editor.cm.setRoot(this.containerEl.doc));
	}

	get file(): TFile | null {
		return this.view.file;
	}

	// editorLivePreviewField follows the mode through its own compartment:
	// reconfiguring with a new init re-creates the field's value.
	#createState(doc: string) {
		return EditorState.create({
			doc,
			extensions: [
				this.#livePreview.of(editorLivePreviewField.init(() => this.#isLivePreview)),
				markdownEditorExtensions(this.view, this.#plugins),
				this.#footer.of(footerField(this.#footerEl)),
				EditorView.updateListener.of((u) => this.#onUpdate(u)),
			],
		});
	}

	get() {
		return this.editor.getValue();
	}

	// A different file resets the editor (and its undo history). New text for
	// the same file arrives as a minimal change that maps the selection, is not
	// undoable, and reaches the other panes of the note like an edit.
	set(data: string, clear: boolean) {
		if (this.#destroyed) return;
		const cm = this.editor.cm;
		if (clear) {
			cm.setState(this.#createState(data));
			bindEditorFields(cm, this.view);
			return;
		}
		const changes = textChanges(cm.state.doc.toString(), data);
		if (changes.length) cm.dispatch({ changes, annotations: Transaction.addToHistory.of(false) });
	}

	clear() {
		this.set("", true);
	}

	getSelection() {
		return this.editor.getSelection();
	}

	// The first line at the top of the visible area; a line with only a few
	// pixels left in view counts as scrolled past.
	getScroll() {
		const cm = this.editor.cm;
		if (this.#destroyed || cm.scrollDOM.clientHeight === 0) return this.#scroll;
		const top = cm.scrollDOM.getBoundingClientRect().top - cm.documentTop;
		let block = cm.lineBlockAtHeight(top);
		if (block.bottom - top < 4 && block.to < cm.state.doc.length) block = cm.lineBlockAt(block.to + 1);
		this.#scroll = cm.state.doc.lineAt(block.from).number - 1;
		return this.#scroll;
	}

	applyScroll(scroll: number) {
		if (this.#destroyed) return;
		const cm = this.editor.cm;
		const doc = cm.state.doc;
		this.#scroll = scroll;
		// Rounded: the reading view reports lines as fractions.
		const line = doc.line(Math.min(Math.max(Math.round(scroll) + 1, 1), doc.lines));
		cm.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 0 }) });
	}

	setLivePreview(on: boolean) {
		this.#isLivePreview = on;
		this.containerEl.toggleClass("is-live-preview", on);
		if (!this.#destroyed) this.editor.cm.dispatch({ effects: this.#livePreview.reconfigure(editorLivePreviewField.init(() => on)) });
	}

	reconfigure() {
		if (!this.#destroyed) this.editor.cm.dispatch({ effects: this.#plugins.reconfigure(this.app.workspace.editorExtensions) });
	}

	// Shows `el` under the last line, or nothing.
	setFooter(el: HTMLElement | null) {
		if (el === this.#footerEl || this.#destroyed) return;
		if (this.#footerEl) this.#footerObserver.unobserve(this.#footerEl);
		this.#footerEl = el;
		if (el) this.#footerObserver.observe(el);
		this.editor.cm.dispatch({ effects: this.#footer.reconfigure(footerField(el)) });
	}

	destroy() {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#footerObserver.disconnect();
		this.#stopMigration();
		this.#quickPreview.cancel();
		this.editor.cm.destroy();
	}

	#onUpdate(u: ViewUpdate) {
		if (!u.docChanged) return;
		if (!u.transactions.some((tr) => tr.annotation(mirrored))) this.#forward(u);
		const preview = this.view.previewMode;
		if (this.view.currentMode === preview) preview.set(u.state.doc.toString(), false);
		const file = this.view.file;
		if (file && this.app.workspace.activeLeaf === this.view.leaf) this.#quickPreview(file);
	}

	// The other panes of the note follow every change here as it happens.
	#forward(u: ViewUpdate) {
		for (const view of mirrorsOf(this.view)) {
			const other = (view as MarkdownView).editMode;
			if (other instanceof MarkdownEditView && other !== this) other.#follow(u.startState.doc, u);
		}
	}

	// A change made in another pane of the note. That pane saves it.
	#follow(start: Text, u: ViewUpdate) {
		if (this.#destroyed) return;
		const cm = this.editor.cm;
		if (cm.state.doc.eq(start)) {
			cm.dispatch({ changes: u.changes, annotations: [mirrored.of(true), Transaction.addToHistory.of(false)] });
			this.view.requestSave.cancel();
			this.view.dirty = false;
			return;
		}
		// The panes went apart (a plugin reset one of them): keep the edits of
		// both, and once this update is done, show the result in every pane.
		// Each pane then saves it.
		this.#mirror(mergeText(start.toString(), cm.state.doc.toString(), u.state.doc.toString()).text);
		queueMicrotask(() => {
			if (this.#destroyed) return;
			const text = this.editor.cm.state.doc.toString();
			for (const view of mirrorsOf(this.view)) {
				const other = (view as MarkdownView).editMode;
				if (other instanceof MarkdownEditView) other.#mirror(text);
			}
		});
	}

	#mirror(text: string) {
		if (this.#destroyed) return;
		const cm = this.editor.cm;
		const changes = textChanges(cm.state.doc.toString(), text);
		if (changes.length) cm.dispatch({ changes, annotations: [mirrored.of(true), Transaction.addToHistory.of(false)] });
	}
}

// The reading mode: the note rendered by a MarkdownPreviewRenderer into
// Obsidian's reading view DOM (.markdown-reading-view > .markdown-preview-view
// > .markdown-preview-sizer > one div.el-* per top-level block). New text
// re-renders only the sections whose output changed.
export class MarkdownPreviewView extends MarkdownRenderer implements MarkdownSubView {
	view: MarkdownView;
	type = "preview" as const;
	hoverPopover: HoverPopover | null = null;
	previewEl: HTMLElement;
	renderer: MarkdownPreviewRenderer;
	metadataEditor: MetadataEditor;
	#data = "";
	// The text whose render last finished; null until the file has one.
	#rendered: string | null = null;
	#rendering: Promise<void> | null = null;
	#generation = 0;
	#shown = false;
	#scroll = 0;
	#pendingScroll: number | null = null;
	#renderSoon = debounce(() => this.rerender(), 250, true);
	#search: { el: HTMLElement; input: HTMLInputElement; count: HTMLElement; matches: Range[]; index: number; open: boolean } | null = null;

	constructor(view: MarkdownView) {
		super(view.app, view.contentEl.createDiv("markdown-reading-view"));
		this.view = view;
		this.containerEl.hide();
		this.previewEl = this.containerEl.createDiv({
			cls: "markdown-preview-view markdown-rendered node-insert-event is-readable-line-width allow-fold-headings allow-fold-lists show-indentation-guide show-properties",
			attr: { tabindex: -1 },
		});
		// It hands clicks, hovers and context menus in the sections to this view.
		this.renderer = new MarkdownPreviewRenderer(this, this.previewEl);
		// Properties edit the note here too, through the editor's document.
		const cm = view.editor.cm;
		const host = editorMetadataHost(cm, this.app, () => this.view.file?.path ?? "");
		const showSource = host.showSource;
		host.focusBody = () => this.focus();
		host.showSource = () => void this.view.setMode(this.view.editMode).then(() => showSource?.());
		this.metadataEditor = this.addChild(new MetadataEditor(host));
		this.renderer.headerEl.appendChild(this.metadataEditor.containerEl);
		this.registerEvent(this.app.vault.on("config-changed", () => this.#syncProperties()));
	}

	// "Properties in document": visible shows the editor, source the YAML.
	#syncProperties() {
		const mode = this.app.vault.getConfig("propertiesInDocument") ?? "visible";
		const fm = locateFrontmatter(this.#data);
		this.previewEl.toggleClass("show-properties", mode === "visible");
		this.previewEl.toggleClass("show-frontmatter", mode === "source");
		this.metadataEditor.containerEl.toggle(mode === "visible" && !!fm);
		if (mode === "visible" && fm) this.metadataEditor.sync(this.#data.slice(fm.yamlFrom, fm.yamlTo));
	}

	get file(): TFile {
		return this.view.file as TFile;
	}

	get() {
		return this.#data;
	}

	// A different file (`clear`) starts at the top, rendered afresh.
	set(data: string, clear: boolean) {
		this.#data = data;
		this.#syncProperties();
		if (clear) {
			this.#reset();
			this.#scroll = 0;
			this.#pendingScroll = 0;
		}
		if (!this.#shown) return;
		if (clear) this.rerender();
		else this.#renderSoon();
	}

	clear() {
		this.#data = "";
		this.#syncProperties();
		this.#reset();
	}

	// Drops the rendered sections, and with them what their post processors
	// and embeds added; a render under way is abandoned.
	#reset() {
		this.#generation++;
		this.#renderSoon.cancel();
		this.#rendered = null;
		this.renderer.clear();
	}

	// Renders the sections whose output changed, or, `full`, every section,
	// keeping the reading position.
	rerender(full = false) {
		if (full) {
			if (this.#shown && this.#rendered !== null) this.#pendingScroll ??= this.getScroll();
			this.#reset();
		}
		if (this.#shown) this.#rendering = this.#render();
	}

	async show() {
		this.#shown = true;
		this.containerEl.show();
		if (this.#rendered !== this.#data) this.rerender();
		await this.#rendering;
		// A position set while hidden over text already rendered.
		const pending = this.#pendingScroll;
		if (pending !== null && this.#rendered === this.#data) {
			this.#pendingScroll = null;
			this.applyScroll(pending);
		}
	}

	hide() {
		if (this.#shown) this.#scroll = this.getScroll();
		this.#shown = false;
		this.#renderSoon.cancel();
		this.closeSearch();
		this.containerEl.hide();
	}

	focus() {
		this.previewEl.focus({ preventScroll: true });
	}

	// The document's search highlights must not outlive the view.
	onunload() {
		this.closeSearch();
		super.onunload();
	}

	// Find in the rendered note: matches are CSS highlights, so the rendered
	// DOM is never rewritten.
	showSearch() {
		if (!this.#search) {
			const el = createDiv("document-search-container");
			this.containerEl.prepend(el);
			const box = el.createDiv("document-search");
			const input = box.createEl("input", { type: "text", cls: "document-search-input", attr: { placeholder: "Find..." } });
			const count = box.createDiv("document-search-count");
			const buttons = box.createDiv("document-search-buttons");
			const button = (icon: string, title: string, onClick: () => void) => {
				const b = buttons.createEl("button", { cls: "clickable-icon document-search-button" });
				setIcon(b, icon);
				setTooltip(b, title);
				b.addEventListener("click", onClick);
			};
			button("arrow-up", "Previous", () => this.#step(-1));
			button("arrow-down", "Next", () => this.#step(1));
			button("x", "Close", () => this.closeSearch(true));
			input.addEventListener("input", () => this.#find());
			input.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") this.#step(evt.shiftKey ? -1 : 1);
				else if (evt.key === "Escape") this.closeSearch(true);
				else return;
				evt.preventDefault();
			});
			this.#search = { el, input, count, matches: [], index: -1, open: false };
		}
		this.#search.open = true;
		this.#search.el.show();
		this.#search.input.focus();
		this.#search.input.select();
		this.#find();
	}

	closeSearch(refocus = false) {
		if (!this.#search?.open) return;
		this.#search.open = false;
		this.#search.el.hide();
		this.#search.matches = [];
		if (searching === this) {
			CSS.highlights.delete("justnotes-search");
			CSS.highlights.delete("justnotes-search-current");
			searching = null;
		}
		if (refocus) this.focus();
	}

	#find() {
		const search = this.#search;
		if (!search) return;
		const query = search.input.value.toLowerCase();
		search.matches = [];
		if (query && this.#rendered !== null) {
			const walker = document.createTreeWalker(this.renderer.sizerEl, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				if (node.parentElement?.closest("mjx-container, style, script")) continue;
				const text = (node.nodeValue ?? "").toLowerCase();
				for (let i = text.indexOf(query); i >= 0; i = text.indexOf(query, i + query.length)) {
					const range = document.createRange();
					range.setStart(node, i);
					range.setEnd(node, i + query.length);
					search.matches.push(range);
				}
			}
		}
		const top = this.previewEl.getBoundingClientRect().top;
		search.index = search.matches.length ? Math.max(0, search.matches.findIndex((r) => r.getBoundingClientRect().top >= top)) : -1;
		this.#showMatch();
	}

	#step(delta: number) {
		const search = this.#search;
		if (!search?.matches.length) return;
		search.index = (search.index + delta + search.matches.length) % search.matches.length;
		this.#showMatch();
	}

	#showMatch() {
		const search = this.#search!;
		const current = search.matches[search.index];
		searching = this;
		CSS.highlights.set("justnotes-search", new Highlight(...search.matches));
		if (current) CSS.highlights.set("justnotes-search-current", new Highlight(current));
		else CSS.highlights.delete("justnotes-search-current");
		search.count.setText(search.matches.length ? `${search.index + 1} / ${search.matches.length}` : search.input.value ? "No results" : "");
		if (!current) return;
		const r = current.getBoundingClientRect();
		const box = this.previewEl.getBoundingClientRect();
		if (r.top < box.top || r.bottom > box.bottom) this.previewEl.scrollTop += r.top - box.top - box.height / 3;
	}

	async #render() {
		this.#renderSoon.cancel();
		const generation = ++this.#generation;
		const data = this.#data;
		try {
			await this.renderer.set(data);
		} catch (err) {
			console.error(err);
		}
		if (generation !== this.#generation) return;
		this.#rendered = data;
		const pending = this.#pendingScroll;
		this.#pendingScroll = null;
		if (pending !== null) this.applyScroll(pending);
		if (this.#search?.open) this.#find();
	}

	getScroll() {
		if (!this.#shown || this.#rendered === null || this.previewEl.clientHeight === 0) return this.#pendingScroll ?? this.#scroll;
		this.#scroll = lineAtOffset(this.#anchors(), this.previewEl.scrollTop, this.#lines(), this.previewEl.scrollHeight);
		return this.#scroll;
	}

	applyScroll(scroll: number) {
		this.#scroll = scroll;
		if (!this.#shown || this.#rendered !== this.#data || this.#rendering === null) {
			this.#pendingScroll = scroll;
			return;
		}
		this.previewEl.scrollTop = offsetOfLine(this.#anchors(), scroll, this.#lines(), this.previewEl.scrollHeight);
	}

	#lines() {
		return this.renderer.text.split("\n").length;
	}

	// Each rendered section's first line at its top and the line after it at
	// its bottom, as offsets into the scrolled content.
	#anchors(): [number, number][] {
		const origin = this.previewEl.getBoundingClientRect().top - this.previewEl.scrollTop;
		const anchors: [number, number][] = [];
		for (const section of this.renderer.sections) {
			if (!section.el?.getClientRects().length) continue;
			const r = section.el.getBoundingClientRect();
			anchors.push([section.lineStart, r.top - origin], [section.lineEnd + 1, r.bottom - origin]);
		}
		return anchors;
	}

	// A link to a heading or block of this note (#Heading, #^block) moves
	// within the view, which resolves it as openLinkText's subpath; with Mod
	// held it opens in a new tab, split or window, as in Live Preview. A bare
	// "#" (a plugin's button) is left to the base, which ignores it.
	onInternalLinkClick(evt: MouseEvent, target: HTMLElement, linktext: string, sourcePath: string) {
		if (!linktext.startsWith("#") || linktext === "#") return super.onInternalLinkClick(evt, target, linktext, sourcePath);
		evt.preventDefault();
		const newLeaf = Keymap.isModEvent(evt);
		if (newLeaf) this.app.workspace.openLinkText(linktext, sourcePath, newLeaf);
		else this.view.setEphemeralState({ subpath: linktext });
	}

	// A task ticked here changes the note's text in the editor, which the view
	// then saves: the file gets the tick together with any unsaved edits. The
	// click answers what is rendered, so a line changed since is left alone.
	onCheckboxClick(evt: MouseEvent, _target: HTMLInputElement, line: number | null) {
		const editor = this.view.editor;
		const text = line === null ? undefined : this.renderer.text.split("\n")[line];
		const task = text === undefined ? null : toggledTask(text);
		if (line === null || !task || !this.view.file || line >= editor.lineCount() || editor.getLine(line) !== text) return evt.preventDefault();
		editor.replaceRange(task.status, { line, ch: task.ch }, { line, ch: task.ch + 1 });
		this.view.save().catch((err) => console.error(err));
	}
}

// Maps between source lines and pixel offsets of rendered content, linearly
// between anchors ([line, offset] pairs in order), with line 0 at the top and
// the last line at the bottom.
function points(anchors: [number, number][], lines: number, height: number) {
	const out: [number, number][] = [[0, 0]];
	for (const [line, offset] of anchors) {
		const last = out[out.length - 1];
		if (line > last[0] && offset >= last[1] && line < lines && offset <= height) out.push([line, offset]);
	}
	const last = out[out.length - 1];
	out.push([Math.max(lines, last[0]), Math.max(height, last[1])]);
	return out;
}

export function lineAtOffset(anchors: [number, number][], offset: number, lines: number, height: number) {
	const ps = points(anchors, lines, height);
	for (let k = 1; k < ps.length; k++) {
		const [l0, y0] = ps[k - 1];
		const [l1, y1] = ps[k];
		if (offset <= y1 || k === ps.length - 1) return y1 === y0 ? l0 : l0 + ((Math.min(Math.max(offset, y0), y1) - y0) / (y1 - y0)) * (l1 - l0);
	}
	return 0;
}

export function offsetOfLine(anchors: [number, number][], line: number, lines: number, height: number) {
	const ps = points(anchors, lines, height);
	for (let k = 1; k < ps.length; k++) {
		const [l0, y0] = ps[k - 1];
		const [l1, y1] = ps[k];
		if (line <= l1 || k === ps.length - 1) return l1 === l0 ? y0 : y0 + ((Math.min(Math.max(line, l0), l1) - l0) / (l1 - l0)) * (y1 - y0);
	}
	return 0;
}

// The 0-based line a link subpath points at (`#Heading`, nested
// `#Parent#Child`, `#^block`), as resolveSubpath finds it in the file's
// metadata cache.
export function subpathLine(cache: CachedMetadata | null, subpath: string): number | null {
	return cache ? (resolveSubpath(cache, subpath)?.start.line ?? null) : null;
}
