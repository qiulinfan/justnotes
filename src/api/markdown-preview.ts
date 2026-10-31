import { Annotation, Compartment, EditorState, type Text, Transaction } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { App } from "./app";
import { bindEditorFields, Editor, editorLivePreviewField } from "./editor";
import { markdownEditorExtensions } from "./editor-extensions";
import { Component } from "./events";
import { setIcon, setTooltip } from "./icons";
import { Keymap } from "./keymap";
import { MarkdownRenderer } from "./markdown";
import type { MarkdownView } from "./markdown-view";
import type { CachedMetadata } from "./metadata";
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
	#scroll = 0;
	#destroyed = false;

	constructor(view: MarkdownView) {
		this.view = view;
		this.app = view.app;
		this.containerEl = view.contentEl.createDiv("markdown-source-view cm-s-obsidian mod-cm6 is-live-preview is-readable-line-width");
		this.editor = new Editor(new EditorView({ state: this.#createState(""), parent: this.containerEl }));
		bindEditorFields(this.editor.cm, view);
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

	destroy() {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.editor.cm.destroy();
	}

	#onUpdate(u: ViewUpdate) {
		if (!u.docChanged) return;
		if (!u.transactions.some((tr) => tr.annotation(mirrored))) this.#forward(u);
		const preview = this.view.previewMode;
		if (this.view.currentMode === preview) preview.set(u.state.doc.toString(), false);
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

// The reading mode: the note rendered as HTML, in Obsidian's reading view DOM
// (.markdown-reading-view > .markdown-preview-view > .markdown-preview-sizer).
export class MarkdownPreviewView extends MarkdownRenderer implements MarkdownSubView {
	view: MarkdownView;
	type = "preview" as const;
	hoverPopover: Component | null = null;
	previewEl: HTMLElement;
	sizerEl: HTMLElement;
	#footerEl: HTMLElement;
	#bodyEl: HTMLElement | null = null;
	#renderer: Component | null = null;
	#data = "";
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
		this.sizerEl = this.previewEl.createDiv("markdown-preview-sizer markdown-preview-section");
		this.sizerEl.createDiv("markdown-preview-pusher");
		this.#footerEl = this.sizerEl.createDiv("mod-footer");
		this.previewEl.addEventListener("click", (evt) => this.#onClick(evt));
		this.previewEl.addEventListener("auxclick", (evt) => this.#onClick(evt));
	}

	get file(): TFile {
		return this.view.file as TFile;
	}

	get() {
		return this.#data;
	}

	// A different file (`clear`) starts at the top.
	set(data: string, clear: boolean) {
		this.#data = data;
		if (clear) {
			this.#scroll = 0;
			this.#pendingScroll = 0;
		}
		if (!this.#shown) return;
		if (clear) this.rerender(true);
		else this.#renderSoon();
	}

	clear() {
		this.#generation++;
		this.#renderSoon.cancel();
		this.#data = "";
		this.#rendered = null;
		this.#bodyEl?.detach();
		this.#bodyEl = null;
		if (this.#renderer) this.removeChild(this.#renderer);
		this.#renderer = null;
	}

	// Renders the whole note again (the renderer has no partial updates yet).
	rerender(_full?: boolean) {
		if (!this.#shown) return;
		this.#rendering = this.#render();
	}

	async show() {
		this.#shown = true;
		this.containerEl.show();
		if (this.#rendered !== this.#data) this.rerender(true);
		await this.#rendering;
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
		if (query && this.#bodyEl) {
			const walker = document.createTreeWalker(this.#bodyEl, NodeFilter.SHOW_TEXT);
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
		const body = createDiv();
		const renderer = this.addChild(new Component());
		try {
			await MarkdownRenderer.render(this.app, data, body, this.view.file?.path ?? "", renderer);
		} catch (err) {
			console.error(err);
		}
		if (generation !== this.#generation) {
			this.removeChild(renderer);
			return;
		}
		const top = this.previewEl.scrollTop;
		if (this.#bodyEl) this.#bodyEl.replaceWith(body);
		else this.sizerEl.insertBefore(body, this.#footerEl);
		this.#bodyEl = body;
		if (this.#renderer) this.removeChild(this.#renderer);
		this.#renderer = renderer;
		this.#rendered = data;
		const pending = this.#pendingScroll;
		this.#pendingScroll = null;
		if (pending !== null) this.applyScroll(pending);
		else this.previewEl.scrollTop = top;
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
		return (this.#rendered ?? "").split("\n").length;
	}

	// Rendered headings matched in order to the source's heading lines, when
	// both counts agree; otherwise none, and positions are proportional.
	#anchors(): [number, number][] {
		if (!this.#bodyEl || this.#rendered === null) return [];
		const lines = headingLines(this.#rendered);
		const headings = this.#bodyEl.findAll("h1, h2, h3, h4, h5, h6").filter((el) => !el.closest(".internal-embed, .markdown-embed"));
		if (lines.length !== headings.length) return [];
		const origin = this.previewEl.getBoundingClientRect().top - this.previewEl.scrollTop;
		const anchors: [number, number][] = [];
		headings.forEach((el, i) => {
			if (el.getClientRects().length) anchors.push([lines[i], el.getBoundingClientRect().top - origin]);
		});
		return anchors;
	}

	// Links open in the workspace; nothing in a note may navigate the app page.
	#onClick(evt: MouseEvent) {
		if (evt.defaultPrevented || evt.button > 1) return;
		const link = (evt.target as Element).closest("a");
		if (!link) return;
		evt.preventDefault();
		const href = link.getAttr("data-href") ?? link.getAttr("href") ?? "";
		if (!href || link.hasClass("tag")) return;
		if (/^[a-z][\w+.-]*:/i.test(href) && !link.hasClass("internal-link")) require("electron").shell.openExternal(href);
		else this.app.workspace.openLinkText(safeDecode(href), this.view.file?.path ?? "", Keymap.isModEvent(evt));
	}
}

function safeDecode(href: string) {
	try {
		return decodeURI(href);
	} catch {
		return href;
	}
}

// 0-based lines of the headings in Markdown source, outside frontmatter,
// code and math blocks; headings in quotes and callouts count, as they render.
export function headingLines(text: string): number[] {
	const lines = text.split("\n");
	const out: number[] = [];
	let i = 0;
	if (/^---\s*$/.test(lines[0] ?? "")) {
		const end = lines.findIndex((l, n) => n > 0 && /^(---|\.\.\.)\s*$/.test(l));
		if (end > 0) i = end + 1;
	}
	let fence: string | null = null;
	let math = false;
	let paragraph = false;
	for (; i < lines.length; i++) {
		const line = lines[i].replace(/^(\s{0,3}>)+\s?/, "");
		const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
			continue;
		}
		if (marker) {
			fence = marker;
			paragraph = false;
			continue;
		}
		if (/^\s*\$\$/.test(line)) {
			if (!/^\s*\$\$.*\$\$\s*$/.test(line) || line.trim().length <= 4) math = !math;
			paragraph = false;
			continue;
		}
		if (math) continue;
		if (/^ {0,3}#{1,6}(\s|$)/.test(line)) {
			out.push(i);
			paragraph = false;
		} else if (paragraph && /^ {0,3}(=+|-+)\s*$/.test(line)) {
			out.push(i - 1);
			paragraph = false;
		} else paragraph = line.trim() !== "" && !/^\s{0,3}([-*+]\s|\d+[.)]\s|\||<)/.test(line);
	}
	return out;
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

const normalizeHeading = (s: string) => s.replace(/[#^|:%[\]\\]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

// The 0-based line a link subpath points at: `#Heading` (or nested
// `#Parent#Child`) or `#^block`, from the file's metadata cache.
export function subpathLine(cache: CachedMetadata | null, subpath: string): number | null {
	if (!cache) return null;
	if (subpath.startsWith("#^")) return cache.blocks?.[subpath.slice(2).toLowerCase()]?.position.start.line ?? null;
	let line: number | null = null;
	for (const part of subpath.split("#").filter(Boolean)) {
		const want = normalizeHeading(part);
		const heading = cache.headings?.find((h) => h.position.start.line > (line ?? -1) && normalizeHeading(h.heading) === want);
		if (!heading) return line;
		line = heading.position.start.line;
	}
	return line;
}
