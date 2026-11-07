import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { syntaxHighlighting } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap } from "@codemirror/view";
import * as fs from "node:fs";
import type { App } from "../../api/app";
import { getElectron } from "../../api/dom";
import { codeHighlight } from "../../api/editor-extensions";
import { Keymap } from "../../api/keymap";
import { IMAGE_EXTENSIONS } from "../../api/markdown";
import { attempt, PromptModal } from "../../api/ui/file-modals";
import { Menu } from "../../api/ui/menu";
import { Modal } from "../../api/ui/modal";
import { Notice } from "../../api/ui/notice";
import { Setting } from "../../api/ui/setting";
import { FuzzySuggestModal } from "../../api/ui/suggest";
import { setTooltip } from "../../api/ui/tooltip";
import { setIcon } from "../../api/icons";
import { debounce } from "../../api/util";
import type { TAbstractFile, TFile } from "../../api/vault";
import { FileView } from "../../api/view";
import type { Tasks, WorkspaceLeaf } from "../../api/workspace";
import { type BookMetadata, dirname, EpubBook, isExternalHref, METADATA_FIELDS, parseXml, relativeHref, resolvePath, type SearchHit, type TocEntry } from "./book";
import { type Chapter, commitBody, loadChapter, rewriteCss } from "./chapter";
import { kindOf, LANDMARKS } from "./landmarks";
import { type Note, noteFor, noteRoot } from "./notes";
import { occurrences, rangeAt, textIndex } from "./text-index";

export const EPUB_VIEW = "epub";

// read: the chapter rendered; edit: the same page, editable in place;
// source: the chapter's XHTML in CodeMirror.
type Mode = "read" | "edit" | "source";

// Per viewer, by vault path: where each book was left, the text size and
// whether the contents pane shows.
const POSITIONS = "justnotes-epub-positions";
const TEXT_SIZE = "justnotes-epub-text-size";
const TOC_SHOWN = "justnotes-epub-toc";
const LAYOUT = "justnotes-epub-layout";
const SIZES = [70, 80, 90, 100, 110, 120, 135, 150, 170, 200];
const UNDO_LIMIT = 20;

// The edit toolbar's paragraph styles (execCommand formatBlock values).
const BLOCKS: [string, string][] = [
	["p", "Paragraph"],
	["h1", "Heading 1"],
	["h2", "Heading 2"],
	["h3", "Heading 3"],
	["h4", "Heading 4"],
	["blockquote", "Quote"],
	["pre", "Preformatted"],
];

// The frame starts as an empty standards-mode page; each chapter's own
// document root replaces its root. The sandbox lets this page reach into it
// and keeps the book's scripts and forms from running.
const FRAME_PAGE = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
const XHTML = "http://www.w3.org/1999/xhtml";
// The note shown over the page: an element of the frame's own, outside its
// <body> (which is all a commit writes back), so the book's styles apply.
const NOTE_ID = "justnotes-note";
const NOTE_DELAY = 250;
const NOTE_LINGER = 300;

interface Position {
	index: number;
	fraction: number;
}

interface Place {
	fraction?: number;
	fragment?: string;
	hit?: SearchHit;
}

// An EPUB in a tab: one spine item (chapter) at a time in a sandboxed frame,
// with the book's own stylesheets, fonts and images served from the zip, the
// table of contents beside it, and links inside the book followed. Edits (in
// place, or the chapter's XHTML source, and the book's metadata) go into the
// zip, written back to the file in place a couple of seconds after the last
// change, when the tab closes and before the window does.
export class EpubView extends FileView {
	#book: EpubBook | null = null;
	#chapter: Chapter | null = null;
	#index = 0;
	#mode: Mode = "read";
	// The book holds edits the file does not; the frame or the source holds
	// edits the book does not.
	#dirty = false;
	#chapterDirty = false;
	#mtime = 0;
	#saving: Promise<void> | null = null;
	#urls = new Map<string, string>();
	#building = new Set<string>();
	#path = "";
	#frameReady: Promise<void>;
	#source: EditorView;
	#sideEl: HTMLElement;
	#tocEl: HTMLElement;
	#resultsEl: HTMLElement;
	#searchEl: HTMLElement;
	#searchInput: HTMLInputElement;
	#searchCount: HTMLElement;
	#searchCase = false;
	#hits: SearchHit[] = [];
	#hit = -1;
	#formatEl: HTMLElement;
	#blockSelect: HTMLSelectElement;
	#undo: Map<string, Uint8Array>[] = [];
	#frame: HTMLIFrameElement;
	#sourceEl: HTMLElement;
	#messageEl: HTMLElement;
	#labelEl: HTMLElement;
	#prevEl: HTMLButtonElement;
	#nextEl: HTMLButtonElement;
	#modeActions: Record<Exclude<Mode, "read">, HTMLElement>;
	#tocAction: HTMLElement;
	#autosave = debounce(() => void this.save(), 2000, true);
	#storePosition = debounce(() => this.#rememberPosition(), 300, true);
	#searchSoon = debounce(() => this.#runSearch(), 250, true);
	// The note over the page, the link it belongs to and where it is.
	#note: { el: Element; link: Element; path: string; found: Note; pinned: boolean } | null = null;
	#noteTimer = 0;
	#noteDocs = new Map<string, { text: string; doc: Document }>();
	// Where each link followed in the text was read from, for Back (by
	// path: chapters added or moved since leave it right).
	#jumps: { path: string; fraction: number }[] = [];
	#backEl: HTMLButtonElement;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "book-open";
		this.contentEl.addClass("epub-view");
		this.#sideEl = this.contentEl.createDiv("epub-toc");
		this.#tocEl = this.#sideEl.createDiv("epub-toc-list");
		this.#resultsEl = this.#sideEl.createDiv("epub-results");
		this.#resultsEl.hide();
		const main = this.contentEl.createDiv("epub-main");
		this.#searchEl = main.createDiv("epub-searchbar");
		this.#searchEl.hide();
		this.#searchInput = this.#searchEl.createEl("input", { cls: "epub-search-input", attr: { type: "search", placeholder: "Search the book", spellcheck: "false" } });
		this.#searchInput.addEventListener("input", () => this.#searchSoon());
		this.#searchInput.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				this.#searchSoon.cancel();
				if (!this.#hits.length || this.#hitsQuery !== this.#searchInput.value) this.#runSearch();
				void this.#goHit(this.#hit + (evt.shiftKey ? -1 : 1));
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				this.closeSearch();
			}
		});
		const caseButton = this.#searchEl.createEl("button", { cls: "epub-search-toggle", text: "Aa" });
		setTooltip(caseButton, "Match case");
		caseButton.addEventListener("click", () => {
			this.#searchCase = !this.#searchCase;
			caseButton.toggleClass("is-active", this.#searchCase);
			this.#runSearch();
		});
		const searchButton = (icon: string, title: string, cb: () => void) => {
			const el = this.#searchEl.createEl("button", { cls: "clickable-icon" });
			setIcon(el, icon);
			setTooltip(el, title);
			el.addEventListener("click", cb);
		};
		searchButton("arrow-up", "Previous match", () => void this.#goHit(this.#hit - 1));
		searchButton("arrow-down", "Next match", () => void this.#goHit(this.#hit + 1));
		this.#searchCount = this.#searchEl.createDiv("epub-search-count");
		searchButton("x", "Close", () => this.closeSearch());
		this.#formatEl = main.createDiv("epub-format");
		this.#formatEl.hide();
		this.#blockSelect = this.#buildFormatBar();
		this.#messageEl = main.createDiv("epub-message");
		this.#messageEl.hide();
		this.#frame = main.createEl("iframe", { cls: "epub-frame", attr: { sandbox: "allow-same-origin", title: "Book page" } });
		this.#frameReady = new Promise((resolve) => this.#frame.addEventListener("load", () => resolve(), { once: true }));
		// Moving the tab to another window reloads the frame: it gets the
		// chapter again.
		this.#frame.addEventListener("load", () => this.#onFrameLoad());
		this.#frame.srcdoc = FRAME_PAGE;
		this.#sourceEl = main.createDiv("epub-source markdown-source-view cm-s-obsidian mod-cm6");
		this.#sourceEl.hide();
		this.#source = new EditorView({ parent: this.#sourceEl, state: this.#sourceState("") });
		const footer = main.createDiv("epub-footer");
		this.#prevEl = footer.createEl("button", { cls: "epub-nav", text: "‹ Previous" });
		this.#backEl = footer.createEl("button", { cls: "epub-nav epub-back", text: "↩ Back" });
		this.#backEl.hide();
		this.#backEl.addEventListener("click", () => void this.#back());
		this.#labelEl = footer.createDiv("epub-label");
		this.#nextEl = footer.createEl("button", { cls: "epub-nav", text: "Next ›" });
		this.#prevEl.addEventListener("click", () => void this.#step(-1));
		this.#nextEl.addEventListener("click", () => void this.#step(1));
		this.contentEl.addEventListener("keydown", (evt) => this.#onKey(evt));

		this.addAction("info", "Book info", () => this.#editInfo());
		this.#modeActions = {
			source: this.addAction("code-xml", "Edit chapter source", () => void this.setMode("source")),
			edit: this.addAction("pencil", "Edit chapter text", () => void this.setMode("edit")),
		};
		this.#tocAction = this.addAction("list", "Contents", () => this.#toggleToc());
		this.#showToc(this.app.loadLocalStorage(TOC_SHOWN) !== false);
	}

	getViewType() {
		return EPUB_VIEW;
	}

	getIcon() {
		return "book-open";
	}

	canAcceptExtension(extension: string) {
		return extension === "epub";
	}

	getMode() {
		return this.#mode;
	}

	onload() {
		super.onload();
		this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile) => void this.#onModify(file)));
		this.registerEvent(this.app.workspace.on("quit", (tasks: Tasks) => tasks.add(() => this.save())));
		this.registerEvent(this.app.workspace.on("css-change", () => this.#applyStyle()));
		// A reload the workspace did not flush (nothing async finishes during
		// unload) writes the edits synchronously, as text views do.
		this.registerDomEvent(window, "beforeunload", () => this.#saveNow());
	}

	onunload() {
		this.#source.destroy();
		super.onunload();
	}

	async onLoadFile(file: TFile) {
		this.#path = file.path;
		this.#book = null;
		this.#chapter = null;
		this.#dirty = this.#chapterDirty = false;
		this.#undo = [];
		this.#hits = [];
		this.#jumps = [];
		this.#noteDocs.clear();
		this.#updateBack();
		try {
			const book = EpubBook.read(await this.app.vault.readBinary(file));
			if (!book.spine.length) throw new Error("The book's spine lists no chapters");
			this.#book = book;
		} catch (err) {
			this.#showMessage(`Could not open ${file.name}: ${err instanceof Error ? err.message : err}`);
			return;
		}
		this.#mtime = file.stat.mtime;
		this.#messageEl.hide();
		this.#renderToc();
		const saved = this.#positions()[file.path];
		// A book opened for the first time starts where its "Start of text"
		// landmark says, else at its first linear chapter.
		const start = this.#book.landmarks().find((l) => l.type === "bodymatter");
		const startIndex = start ? this.#book.spineIndexOf(start.path) : -1;
		const first = startIndex >= 0 ? startIndex : Math.max(0, this.#book.spine.findIndex((item) => item.linear));
		await this.#show(saved && saved.index < this.#book.spine.length ? saved.index : first, { fraction: saved?.fraction ?? 0 });
	}

	async onUnloadFile(_file: TFile) {
		await this.save();
		this.#autosave.cancel();
		this.#book = null;
		this.#chapter = null;
		this.#dropUrls();
	}

	async onRename(file: TFile) {
		const positions = this.#positions();
		if (positions[this.#path]) {
			positions[file.path] = positions[this.#path];
			delete positions[this.#path];
			this.app.saveLocalStorage(POSITIONS, positions);
		}
		this.#path = file.path;
		await super.onRename(file);
	}

	onPaneMenu(menu: Menu, source: string) {
		const pages = this.app.loadLocalStorage(LAYOUT) === "pages";
		menu.addItem((i) =>
			i
				.setTitle(pages ? "Scroll the chapter" : "Turn pages")
				.setIcon(pages ? "scroll-text" : "book-open")
				.setSection("view")
				.onClick(() => this.#setLayout(pages ? "scroll" : "pages")),
		);
		menu.addItem((i) => i.setTitle("Larger text").setIcon("a-arrow-up").setSection("view").onClick(() => this.#resizeText(1)));
		menu.addItem((i) => i.setTitle("Smaller text").setIcon("a-arrow-down").setSection("view").onClick(() => this.#resizeText(-1)));
		menu.addItem((i) => i.setTitle("Edit book info...").setIcon("info").setSection("action").onClick(() => this.#editInfo()));
		menu.addItem((i) => i.setTitle("Search the book").setIcon("search").setSection("action").onClick(() => this.showSearch()));
		if (this.#book && this.#chapter) this.#chapterMenu(menu, this.#index);
		if (this.#undo.length) menu.addItem((i) => i.setTitle("Undo the last chapter change").setIcon("undo-2").setSection("chapter").onClick(() => void this.undoChapterChange()));
		super.onPaneMenu(menu, source);
	}

	// Mod+F: the source's own search in the source, else the book's.
	showSearch() {
		if (this.#mode === "source") {
			openSearchPanel(this.#source);
			return;
		}
		this.#searchEl.show();
		this.#searchInput.focus();
		this.#searchInput.select();
		if (this.#searchInput.value) this.#runSearch();
	}

	closeSearch() {
		this.#searchEl.hide();
		this.#resultsEl.hide();
		this.#resultsEl.empty();
		this.#tocEl.show();
		this.#hits = [];
		this.#hit = -1;
		this.#hitsQuery = "";
		this.#showToc(this.app.loadLocalStorage(TOC_SHOWN) !== false);
		this.#markMatches();
		this.#frame.contentWindow?.focus();
	}

	// --- Search -------------------------------------------------------------

	#hitsQuery = "";

	#runSearch() {
		const book = this.#book;
		const query = this.#searchInput.value;
		this.#hitsQuery = query;
		this.#hit = -1;
		if (!book || !query.trim()) {
			this.#hits = [];
			this.#searchCount.setText("");
			this.#resultsEl.hide();
			this.#tocEl.show();
			this.#markMatches();
			return;
		}
		this.#commitChapter();
		this.#hits = book.search(query, this.#searchCase);
		this.#searchCount.setText(this.#hits.length ? `${this.#hits.length >= 500 ? "500+" : this.#hits.length} matches` : "No matches");
		this.#renderResults();
		this.#markMatches();
	}

	#renderResults() {
		const book = this.#book;
		this.#resultsEl.empty();
		this.#tocEl.hide();
		this.#resultsEl.show();
		this.#sideEl.show();
		if (!book) return;
		let last = -1;
		for (const [i, hit] of this.#hits.entries()) {
			if (hit.index !== last) {
				last = hit.index;
				this.#resultsEl.createDiv({ cls: "epub-result-chapter", text: this.#chapterLabel(hit.index) });
			}
			const row = this.#resultsEl.createDiv({ cls: "epub-result tree-item-self is-clickable", attr: { "data-hit": String(i) } });
			row.createSpan({ text: (hit.before.length >= 40 ? "…" : "") + hit.before.trimStart() });
			row.createSpan({ cls: "epub-result-match", text: hit.match });
			row.createSpan({ text: hit.after + (hit.after.length >= 60 ? "…" : "") });
			row.addEventListener("click", () => void this.#goHit(i));
		}
	}

	async #goHit(i: number) {
		if (!this.#hits.length) return;
		this.#hit = ((i % this.#hits.length) + this.#hits.length) % this.#hits.length;
		const hit = this.#hits[this.#hit];
		this.#searchCount.setText(`${this.#hit + 1} / ${this.#hits.length >= 500 ? "500+" : this.#hits.length}`);
		for (const el of this.#resultsEl.findAll(".epub-result")) el.toggleClass("is-active", el.dataset.hit === String(this.#hit));
		this.#resultsEl.find(".epub-result.is-active")?.scrollIntoView({ block: "nearest" });
		if (this.#mode === "source") await this.setMode("source");
		if (hit.index !== this.#index) await this.#show(hit.index, { hit });
		else this.#markMatches(hit);
	}

	// The matches in the page, and the current one, as CSS highlights (they
	// change nothing in the document, so editing and saving never see them);
	// the current one is scrolled to.
	#markMatches(current?: SearchHit) {
		const win = this.#frame.contentWindow as (Window & typeof globalThis) | null;
		const doc = this.#frame.contentDocument;
		const highlights = (win as any)?.CSS?.highlights;
		if (!win || !doc?.body || !highlights) return;
		highlights.delete("justnotes-search");
		highlights.delete("justnotes-search-current");
		const query = this.#hitsQuery.replace(/\s+/g, " ");
		if (!this.#hits.length || !query.trim()) return;
		const index = textIndex(doc.body);
		const ranges = occurrences(index.text, query, this.#searchCase).map((at) => rangeAt(index, at, query.length, doc));
		const Highlight = (win as any).Highlight;
		highlights.set("justnotes-search", new Highlight(...ranges.filter(Boolean)));
		const range = current && current.index === this.#index ? ranges[current.occurrence] : null;
		if (!range) return;
		highlights.set("justnotes-search-current", new Highlight(range));
		const rect = range.getBoundingClientRect();
		if (this.#paged()) this.#turnTo(this.#pageOf(rect.left));
		else win.scrollBy(0, rect.top - win.innerHeight / 3);
	}

	// Writes the book when it holds edits the file does not. Saves run one at
	// a time; a failed one keeps the edits and says why.
	async save() {
		this.#autosave.cancel();
		while (this.#saving) await this.#saving;
		this.#commitChapter();
		const file = this.file;
		const book = this.#book;
		if (!this.#dirty || !file || !book) return;
		// Never to a file the vault no longer has: a deleted book must not
		// come back from a pending save.
		if (this.app.vault.getAbstractFileByPath(file.path) !== file) return;
		this.#dirty = false;
		this.#saving = (async () => {
			const bytes = book.toBytes();
			await this.app.vault.modifyBinary(file, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
			this.#mtime = (await this.app.vault.adapter.stat(file.path))?.mtime ?? file.stat.mtime;
		})();
		try {
			await this.#saving;
		} catch (err) {
			this.#dirty = true;
			new Notice(`Could not save ${file.path}: ${err instanceof Error ? err.message : err}`);
		} finally {
			this.#saving = null;
		}
	}

	async setMode(mode: Mode) {
		if (!this.#book || !this.#chapter) return;
		const next = mode === this.#mode ? "read" : mode;
		const fraction = this.#fraction();
		this.#hideNote();
		this.#commitChapter();
		const prev = this.#mode;
		this.#mode = next;
		for (const [key, el] of Object.entries(this.#modeActions)) el.toggleClass("is-active", key === next);
		this.#formatEl.toggle(next === "edit");
		if (next === "source") {
			this.#frame.hide();
			this.#sourceEl.show();
			this.#source.setState(this.#sourceState(this.#book.text(this.#chapter.path)));
			this.#source.focus();
		} else {
			this.#sourceEl.hide();
			this.#frame.show();
			if (prev === "source") {
				this.#chapter = loadChapter(this.#book, this.#chapter.path, (path) => this.#url(path));
				await this.#fill({ fraction });
			} else {
				this.#setEditable();
				this.#applyStyle();
				// Pages and scrolling place the text differently.
				if (this.app.loadLocalStorage(LAYOUT) === "pages") await this.#fill({ fraction });
			}
			if (next === "edit") this.#frame.contentWindow?.focus();
		}
		// The footer's page count is the reading layout's only.
		this.#updateChrome();
	}

	// --- Chapters -------------------------------------------------------

	async #show(index: number, at: Place = {}) {
		const book = this.#book;
		if (!book) return;
		this.#commitChapter();
		this.#index = Math.max(0, Math.min(book.spine.length - 1, index));
		const path = book.spine[this.#index].path;
		try {
			this.#chapter = loadChapter(book, path, (p) => this.#url(p));
		} catch (err) {
			this.#chapter = null;
			this.#showMessage(`Could not read ${path}: ${err instanceof Error ? err.message : err}`);
			return;
		}
		this.#messageEl.hide();
		this.#updateChrome();
		if (this.#mode === "source") {
			this.#source.setState(this.#sourceState(book.text(path)));
			this.#rememberPosition();
			return;
		}
		await this.#fill(at);
	}

	#step(delta: number) {
		return this.#show(this.#index + delta);
	}

	// Puts the current chapter into the frame and scrolls to `at`.
	async #fill(at: Place = {}) {
		await this.#frameReady;
		const doc = this.#frame.contentDocument;
		let chapter = this.#chapter;
		if (!doc || !chapter) return;
		// The display copy is the chapter as it was loaded; edits since go to
		// the book only, so a page filled again (pages, a popout) is rebuilt
		// from the book's text.
		const book = this.#book;
		if (book?.has(chapter.path) && book.text(chapter.path) !== chapter.shown) chapter = this.#chapter = loadChapter(book, chapter.path, (p) => this.#url(p));
		this.#hideNote();
		const root = doc.importNode(chapter.display.documentElement, true);
		doc.replaceChild(root, doc.documentElement);
		if (!doc.head) root.prepend(doc.createElement("head"));
		if (!doc.body) root.append(doc.createElement("body"));
		this.#applyStyle();
		this.#setEditable();
		await stylesheetsLoaded(doc);
		const win = this.#frame.contentWindow;
		if (!win || this.#chapter !== chapter) return;
		const target = at.fragment ? (doc.getElementById(at.fragment) ?? doc.getElementsByName(at.fragment)[0]) : null;
		if (this.#paged()) {
			if (target) this.#turnTo(this.#pageOf(target.getBoundingClientRect().left));
			else this.#turnTo(Math.round((at.fraction ?? 0) * (this.#pageCount() - 1)));
		} else if (target) target.scrollIntoView();
		else win.scrollTo(0, (at.fraction ?? 0) * Math.max(0, doc.documentElement.scrollHeight - win.innerHeight));
		// The search's matches are marked again; a hit scrolls to itself.
		this.#markMatches(at.hit);
		this.#rememberPosition();
	}

	#onFrameLoad() {
		const win = this.#frame.contentWindow;
		const doc = this.#frame.contentDocument;
		if (!win || !doc) return;
		// App hotkeys work while the page has the focus.
		this.app.keymap.attachWindow(win);
		doc.addEventListener("click", (evt) => this.#onClick(evt));
		doc.addEventListener("mouseover", (evt) => this.#onHover(evt));
		doc.addEventListener("mouseout", (evt) => this.#onHoverOut(evt));
		doc.addEventListener("keydown", (evt) => this.#onKey(evt));
		doc.addEventListener("input", () => this.#edited());
		doc.addEventListener("paste", (evt) => this.#onPaste(evt));
		doc.addEventListener("drop", (evt) => this.#onDrop(evt));
		doc.addEventListener("selectionchange", () => this.#updateBlockSelect());
		doc.addEventListener("focusin", () => this.app.workspace.setActiveLeaf(this.leaf));
		win.addEventListener("scroll", () => {
			this.#storePosition();
			this.#hideNote();
		});
		win.addEventListener("wheel", (evt) => this.#onWheel(evt), { passive: false });
		if (this.#chapter && doc.body && !doc.body.childNodes.length) void this.#fill({ fraction: this.#positions()[this.#path]?.fraction ?? 0 });
	}

	#setEditable() {
		const doc = this.#frame.contentDocument;
		if (!doc) return;
		doc.designMode = this.#mode === "edit" ? "on" : "off";
		// Enter starts a paragraph, as books are written.
		if (this.#mode === "edit") doc.execCommand("defaultParagraphSeparator", false, "p");
	}

	// The book's edits so far (the frame's body or the source text) into the
	// zip's entry for the chapter.
	#commitChapter() {
		const book = this.#book;
		const chapter = this.#chapter;
		if (!this.#chapterDirty || !book || !chapter) return;
		this.#chapterDirty = false;
		let text: string;
		if (this.#mode === "source") {
			text = this.#source.state.doc.toString();
			try {
				parseXml(text, chapter.path);
			} catch {
				new Notice(`${chapter.path} is not well-formed XHTML; it is saved as typed and shown as HTML.`);
			}
		} else {
			const body = this.#frame.contentDocument?.body;
			if (!body) return;
			text = commitBody(chapter, body);
		}
		book.setText(chapter.path, text);
		chapter.text = text;
		this.#dirty = true;
	}

	// The page's edits go into the book at once: a closing tab or a move to
	// another window takes the frame's document away before the view hears of
	// it (a few milliseconds for the largest chapters). The source editor
	// lives in this page, so its text is taken when needed.
	#edited() {
		if (this.#mode === "read") return;
		this.#chapterDirty = true;
		// A structure undo restores the whole book: after other edits it
		// would take them back too, so it is no longer offered.
		this.#forgetUndo();
		if (this.#mode === "edit") this.#commitChapter();
		this.#autosave();
	}

	// Pasted text comes in plain: styled HTML from elsewhere does not belong
	// in the book's markup.
	// A pasted image goes into the book as one.
	#onPaste(evt: ClipboardEvent) {
		if (this.#mode !== "edit") return;
		evt.preventDefault();
		const image = Array.from(evt.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
		if (image) {
			void image.arrayBuffer().then((buf) => this.#insertImage(image.name || `pasted.${image.type.split("/")[1] || "png"}`, new Uint8Array(buf)));
			return;
		}
		const text = evt.clipboardData?.getData("text/plain") ?? "";
		this.#frame.contentDocument?.execCommand("insertText", false, text);
	}

	// Image files dropped on the page go in where they land; anything else
	// dropped is refused (the browser would put markup or a file URL there).
	#onDrop(evt: DragEvent) {
		if (this.#mode !== "edit") return;
		evt.preventDefault();
		const doc = this.#frame.contentDocument;
		const images = Array.from(evt.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
		if (!doc || !images.length) return;
		const caret = (doc as any).caretRangeFromPoint?.(evt.clientX, evt.clientY) as Range | null;
		if (caret) {
			const sel = doc.getSelection();
			sel?.removeAllRanges();
			sel?.addRange(caret);
		}
		void (async () => {
			for (const f of images) this.#insertImage(f.name, new Uint8Array(await f.arrayBuffer()));
		})();
	}

	#onClick(evt: MouseEvent) {
		const el = evt.target as Element | null;
		const note = this.#note;
		if (note && el && note.el.contains(el) && el.closest?.(".justnotes-note-go")) {
			evt.preventDefault();
			void this.#goToNote();
			return;
		}
		const link = el?.closest?.("a[href]");
		// A click away from the note puts it away.
		if (note && !(el && note.el.contains(el)) && link !== note.link) this.#hideNote();
		if (!link) return;
		// While editing, a click places the cursor; Mod-click follows the link.
		if (this.#mode === "edit" && !Keymap.isModEvent(evt)) return;
		evt.preventDefault();
		// A note's mark shows the note and stays where it is; Mod-click goes
		// to the note.
		if (this.#mode === "read" && !Keymap.isModEvent(evt) && this.#showNote(link, true)) return;
		void this.#follow(link.getAttribute("href") ?? "", this.#linkBase(link));
	}

	// The chapter a link's href is relative to: a note's own, for a link in
	// the note shown over the page.
	#linkBase(link: Element) {
		const note = this.#note;
		return note && note.el.contains(link) ? note.path : (this.#chapter?.path ?? "");
	}

	// Follows a link in the text; Back returns to where it was read from.
	async #follow(href: string, base: string) {
		const book = this.#book;
		const chapter = this.#chapter;
		if (!book || !chapter || !href) return;
		if (isExternalHref(href)) {
			await getElectron().shell.openExternal(href);
			return;
		}
		const hash = href.indexOf("#");
		const fragment = hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1));
		const target = hash === 0 ? base : resolvePath(dirname(base), href);
		if (book.spineIndexOf(target) < 0) {
			new Notice(`${target} is not a chapter of this book`);
			return;
		}
		this.#pushJump();
		await this.#go(target, fragment);
	}

	async #go(path: string, fragment: string) {
		const book = this.#book;
		if (!book) return;
		const index = book.spineIndexOf(path);
		if (index < 0) {
			new Notice(`${path} is not a chapter of this book`);
			return;
		}
		if (index === this.#index && this.#mode !== "source") {
			const doc = this.#frame.contentDocument;
			const target = fragment ? (doc?.getElementById(fragment) ?? doc?.getElementsByName(fragment)[0]) : null;
			if (this.#paged()) this.#turnTo(target ? this.#pageOf(target.getBoundingClientRect().left) : 0);
			else if (target) target.scrollIntoView();
			else this.#frame.contentWindow?.scrollTo(0, 0);
			return;
		}
		await this.#show(index, { fragment });
	}

	// --- Notes and Back ------------------------------------------------------

	// Hovering a note's mark shows the note over the page, after a moment.
	#onHover(evt: MouseEvent) {
		const el = evt.target as Element | null;
		if (this.#mode !== "read" || !el?.closest) return;
		const note = this.#note;
		if (note && (note.el.contains(el) || note.link.contains(el))) {
			window.clearTimeout(this.#noteTimer);
			return;
		}
		// A pinned note stays until a click elsewhere.
		if (note?.pinned) return;
		const link = el.closest("a[href]");
		if (!link) return;
		window.clearTimeout(this.#noteTimer);
		this.#noteTimer = window.setTimeout(() => this.#showNote(link, false), NOTE_DELAY);
	}

	#onHoverOut(evt: MouseEvent) {
		const note = this.#note;
		const to = evt.relatedTarget as Element | null;
		if (note && to && (note.el.contains(to) || note.link.contains(to))) return;
		const from = evt.target as Element | null;
		// Leaving a link before its note showed: it does not.
		if (!note) {
			if (from?.closest?.("a[href]")) window.clearTimeout(this.#noteTimer);
			return;
		}
		if (note.pinned || !(note.el.contains(from) || note.link.contains(from))) return;
		window.clearTimeout(this.#noteTimer);
		this.#noteTimer = window.setTimeout(() => this.#hideNote(), NOTE_LINGER);
	}

	// The note `link` is the mark of, from this chapter or another; null
	// when it marks none.
	#findNote(link: Element): { found: Note; path: string; fragment: string } | null {
		const book = this.#book;
		const chapter = this.#chapter;
		const href = link.getAttribute("href") ?? "";
		const hash = href.indexOf("#");
		if (!book || !chapter || hash < 0 || isExternalHref(href)) return null;
		let fragment = href.slice(hash + 1);
		try {
			fragment = decodeURIComponent(fragment);
		} catch {}
		if (!fragment) return null;
		const base = this.#linkBase(link);
		const path = hash === 0 ? base : resolvePath(dirname(base), href);
		let doc: Document | null;
		if (path === chapter.path) doc = this.#frame.contentDocument;
		else if (book.has(path) && book.spineIndexOf(path) >= 0) doc = this.#noteDoc(path);
		else return null;
		const target = doc?.getElementById(fragment) ?? doc?.getElementsByName(fragment)[0];
		if (!target || target.closest(`#${NOTE_ID}`)) return null;
		const found = noteFor(link, base, target, path);
		return found ? { found, path, fragment } : null;
	}

	// Another chapter, parsed with its images served, for its notes; parsed
	// again once the book's text for it changes.
	#noteDoc(path: string) {
		const book = this.#book;
		if (!book) return null;
		const text = book.text(path);
		const known = this.#noteDocs.get(path);
		if (known?.text === text) return known.doc;
		try {
			const doc = loadChapter(book, path, (p) => this.#url(p)).display;
			this.#noteDocs.set(path, { text, doc });
			return doc;
		} catch {
			return null;
		}
	}

	// Shows the note `link` marks over the page, beside the link; pinned, it
	// stays until a click elsewhere. False when the link marks no note.
	#showNote(link: Element, pinned: boolean) {
		const doc = this.#frame.contentDocument;
		const win = this.#frame.contentWindow;
		if (!doc || !win || this.#mode !== "read" || !link.isConnected) return false;
		if (this.#note?.link === link) {
			this.#note.pinned ||= pinned;
			return true;
		}
		const hit = this.#findNote(link);
		if (!hit) return false;
		this.#hideNote();
		const el = doc.createElementNS(XHTML, "div");
		el.id = NOTE_ID;
		el.setAttribute("role", "note");
		el.append(doc.importNode(hit.found.content, true));
		const go = el.appendChild(doc.createElementNS(XHTML, "div"));
		go.setAttribute("class", "justnotes-note-go");
		go.setAttribute("role", "button");
		go.textContent = "Go to note ›";
		// Outside <body>, the note takes the book's face from it.
		if (doc.body) el.style.setProperty("font-family", win.getComputedStyle(doc.body).fontFamily);
		doc.documentElement.append(el);
		this.#note = { el, link, path: hit.path, found: hit.found, pinned };
		this.#placeNote();
		return true;
	}

	// Below the link, or above it when there is more room there, inside the page.
	#placeNote() {
		const note = this.#note;
		const win = this.#frame.contentWindow;
		if (!note || !win) return;
		const style = (note.el as HTMLElement).style;
		const at = note.link.getClientRects()[0] ?? note.link.getBoundingClientRect();
		const width = note.el.getBoundingClientRect().width;
		const height = note.el.getBoundingClientRect().height;
		const margin = 8;
		const left = Math.max(margin, Math.min(at.left - 16, win.innerWidth - width - margin));
		const below = win.innerHeight - at.bottom;
		const top = below >= height + margin * 2 || below >= at.top ? at.bottom + 6 : Math.max(margin, at.top - 6 - height);
		style.setProperty("left", `${left}px`, "important");
		style.setProperty("top", `${top}px`, "important");
		style.setProperty("visibility", "visible", "important");
	}

	#hideNote() {
		window.clearTimeout(this.#noteTimer);
		this.#note?.el.remove();
		this.#note = null;
	}

	// Goes to the note shown, marking it for a moment; Back returns to its mark.
	async #goToNote() {
		const note = this.#note;
		if (!note) return;
		const fragment = note.link.getAttribute("href")?.split("#")[1] ?? "";
		let id = fragment;
		try {
			id = decodeURIComponent(fragment);
		} catch {}
		this.#hideNote();
		this.#pushJump();
		await this.#go(note.path, id);
		const doc = this.#frame.contentDocument;
		const target = doc?.getElementById(id) ?? doc?.getElementsByName(id)[0];
		if (target) this.#markArrival(target);
	}

	#markArrival(target: Element) {
		const win = this.#frame.contentWindow as (Window & typeof globalThis) | null;
		const doc = this.#frame.contentDocument;
		if (!win?.CSS?.highlights || !doc) return;
		const roots = noteRoot(target);
		const range = doc.createRange();
		range.setStartBefore(roots[0]);
		range.setEndAfter(roots[roots.length - 1]);
		win.CSS.highlights.set("justnotes-arrival", new win.Highlight(range));
		window.setTimeout(() => win.CSS.highlights.delete("justnotes-arrival"), 1800);
	}

	#pushJump() {
		if (!this.#book) return;
		this.#jumps.push({ path: this.#book.spine[this.#index].path, fraction: this.#fraction() });
		if (this.#jumps.length > 50) this.#jumps.shift();
		this.#updateBack();
	}

	// Back to where the last link followed was read from.
	async #back() {
		const place = this.#jumps.pop();
		this.#updateBack();
		const index = place && this.#book ? this.#book.spineIndexOf(place.path) : -1;
		if (!place || index < 0) return;
		this.#hideNote();
		if (index !== this.#index || this.#mode === "source") {
			await this.#show(index, { fraction: place.fraction });
			return;
		}
		const win = this.#frame.contentWindow;
		const doc = this.#frame.contentDocument;
		if (!win || !doc) return;
		if (this.#paged()) this.#turnTo(Math.round(place.fraction * (this.#pageCount() - 1)));
		else win.scrollTo(0, place.fraction * Math.max(0, doc.documentElement.scrollHeight - win.innerHeight));
	}

	#updateBack() {
		const place = this.#jumps[this.#jumps.length - 1];
		const index = place && this.#book ? this.#book.spineIndexOf(place.path) : -1;
		this.#backEl.toggle(index >= 0);
		if (index >= 0) setTooltip(this.#backEl, `Back to ${this.#chapterLabel(index)} (Backspace)`);
	}

	#onKey(evt: KeyboardEvent) {
		if (Keymap.isModifier(evt, "Mod") && !evt.shiftKey && !evt.altKey && evt.key.toLowerCase() === "s") {
			evt.preventDefault();
			void this.save();
			return;
		}
		const typing = evt.target instanceof HTMLElement && !!evt.target.closest("input, textarea, select, .cm-editor");
		if (this.#mode === "read" && !typing && Keymap.isModifier(evt, "Mod") && !evt.shiftKey && !evt.altKey && evt.key.toLowerCase() === "z" && this.#undo.length) {
			evt.preventDefault();
			void this.undoChapterChange();
			return;
		}
		if (this.#mode !== "read" || typing || evt.metaKey || evt.ctrlKey || evt.altKey) return;
		if (evt.key === "Escape" && this.#note) {
			evt.preventDefault();
			this.#hideNote();
			return;
		}
		if (evt.key === "Backspace" && this.#jumps.length) {
			evt.preventDefault();
			void this.#back();
			return;
		}
		if (evt.target instanceof HTMLElement && evt.target.closest(".epub-toc") && evt.key !== "ArrowLeft" && evt.key !== "ArrowRight") return;
		// In pages, the arrows, Page Up/Down and Space turn pages (and go on
		// into the next or previous chapter); scrolled, the arrows sideways
		// change chapter.
		if (this.#paged()) {
			const forward = evt.key === "ArrowRight" || evt.key === "PageDown" || (evt.key === " " && !evt.shiftKey) || evt.key === "ArrowDown";
			const back = evt.key === "ArrowLeft" || evt.key === "PageUp" || (evt.key === " " && evt.shiftKey) || evt.key === "ArrowUp";
			if (forward || back) {
				evt.preventDefault();
				void this.#turn(forward ? 1 : -1);
			}
			return;
		}
		if (evt.shiftKey) return;
		if (evt.key === "ArrowLeft" || evt.key === "ArrowRight") {
			evt.preventDefault();
			void this.#step(evt.key === "ArrowLeft" ? -1 : 1);
		}
	}

	// --- Pages ---------------------------------------------------------------

	// Pages (CSS columns one page wide, turned sideways) while reading; editing
	// and the source always scroll.
	#paged() {
		return this.#mode === "read" && this.app.loadLocalStorage(LAYOUT) === "pages";
	}

	#pageWidth() {
		return this.#frame.contentWindow?.innerWidth || 1;
	}

	#pageCount() {
		const doc = this.#frame.contentDocument;
		return doc ? Math.max(1, Math.round(doc.documentElement.scrollWidth / this.#pageWidth())) : 1;
	}

	#page() {
		return Math.round((this.#frame.contentWindow?.scrollX ?? 0) / this.#pageWidth());
	}

	// The page a point `left` pixels from the frame's left edge is on.
	#pageOf(left: number) {
		const x = (this.#frame.contentWindow?.scrollX ?? 0) + left;
		return Math.max(0, Math.floor(x / this.#pageWidth()));
	}

	#turnTo(page: number) {
		const win = this.#frame.contentWindow;
		if (!win) return;
		win.scrollTo(Math.max(0, Math.min(this.#pageCount() - 1, page)) * this.#pageWidth(), 0);
		this.#updatePageLabel();
		this.#storePosition();
	}

	async #turn(delta: number) {
		const page = this.#page() + delta;
		if (page < 0) {
			if (this.#index > 0) await this.#show(this.#index - 1, { fraction: 1 });
		} else if (page >= this.#pageCount()) {
			if (this.#book && this.#index < this.#book.spine.length - 1) await this.#show(this.#index + 1);
		} else this.#turnTo(page);
	}

	#wheel = 0;
	#wheelAt = 0;

	// A wheel or trackpad swipe turns one page per gesture.
	#onWheel(evt: WheelEvent) {
		if (!this.#paged() || evt.ctrlKey) return;
		evt.preventDefault();
		const now = performance.now();
		if (now - this.#wheelAt < 350) return;
		this.#wheel += Math.abs(evt.deltaX) > Math.abs(evt.deltaY) ? evt.deltaX : evt.deltaY;
		if (Math.abs(this.#wheel) < 40) return;
		const delta = this.#wheel > 0 ? 1 : -1;
		this.#wheel = 0;
		this.#wheelAt = now;
		void this.#turn(delta);
	}

	#setLayout(layout: "scroll" | "pages") {
		const fraction = this.#fraction();
		this.app.saveLocalStorage(LAYOUT, layout);
		this.#applyStyle();
		void this.#fill({ fraction });
	}

	#updatePageLabel() {
		this.#updateChrome();
	}

	onResize() {
		if (!this.#paged()) return;
		const fraction = this.#fraction();
		this.#applyStyle();
		this.#turnTo(Math.round(fraction * (this.#pageCount() - 1)));
	}

	#chapterLabel(index: number) {
		const book = this.#book;
		if (!book) return "";
		for (let i = index; i >= 0; i--) {
			const label = book.tocLabel(book.spine[i].path);
			if (label) return label;
		}
		return `Chapter ${index + 1}`;
	}

	// --- Chapters: add, rename, move, delete ---------------------------------

	// One change to the book's structure: edits so far go in first, the book
	// before it goes on the undo stack, and the chapter `show` names opens.
	async #restructure(change: (book: EpubBook) => number, done: string) {
		const book = this.#book;
		if (!book) return;
		this.#commitChapter();
		const before = book.snapshot();
		let show: number;
		try {
			show = change(book);
		} catch (err) {
			book.restore(before);
			new Notice(err instanceof Error ? err.message : String(err));
			return;
		}
		this.#undo.push(before);
		if (this.#undo.length > UNDO_LIMIT) this.#undo.shift();
		this.#dirty = true;
		this.#renderToc();
		await this.#show(show);
		this.#autosave();
		new Notice(done);
	}

	#forgetUndo() {
		this.#undo = [];
	}

	async undoChapterChange() {
		const book = this.#book;
		const before = this.#undo.pop();
		if (!book || !before) return;
		this.#commitChapter();
		const path = book.spine[this.#index]?.path;
		book.restore(before);
		this.#dirty = true;
		this.#renderToc();
		const back = path ? book.spineIndexOf(path) : -1;
		await this.#show(back >= 0 ? back : Math.min(this.#index, book.spine.length - 1));
		this.#autosave();
		new Notice("Undid the chapter change");
	}

	// Chapter actions act on the section `index` is in: the contents entry's
	// files, up to the next entry's.
	#chapterMenu(menu: Menu, index: number) {
		const book = this.#book;
		if (!book) return;
		const { start, end } = book.sectionOf(index);
		const label = this.#chapterLabel(start);
		menu.addItem((i) =>
			i
				.setTitle("New chapter after this")
				.setIcon("file-plus")
				.setSection("chapter")
				.onClick(() => new PromptModal(this.app, "New chapter title", "", (title) => this.#restructure((b) => b.addChapter(end, title), `Added "${title}"`)).open()),
		);
		menu.addItem((i) =>
			i
				.setTitle("Rename chapter...")
				.setIcon("pencil")
				.setSection("chapter")
				.onClick(() => new PromptModal(this.app, "Chapter title", label, (title) => this.#restructure((b) => (b.renameChapter(start, title), start), "Renamed")).open()),
		);
		// Mark as: a landmark kind on this section's first file (again: unmarks).
		const marked = new Map(book.landmarks().map((l) => [l.type, book.spineIndexOf(l.path)]));
		menu.addItem((i) => {
			i.setTitle("Mark as").setIcon("bookmark").setSection("chapter");
			const sub = i.setSubmenu();
			for (const kind of LANDMARKS) {
				const here = marked.get(kind.type) === start;
				sub.addItem((s) =>
					s
						.setTitle(kind.label)
						.setChecked(here)
						.onClick(() => this.#restructure((b) => (b.setLandmark(kind.type, here ? null : start), start), here ? `Unmarked ${kind.label}` : `Marked as ${kind.label}`)),
				);
			}
		});
		const depth = book.tocDepth(book.spine[start].path);
		if (depth >= 0) {
			menu.addItem((i) => i.setTitle("Indent in the contents").setIcon("indent").setSection("chapter").onClick(() => this.#restructure((b) => (nested(b.nestChapter(start, 1)), start), "Indented")));
			if (depth > 0) menu.addItem((i) => i.setTitle("Outdent in the contents").setIcon("outdent").setSection("chapter").onClick(() => this.#restructure((b) => (nested(b.nestChapter(start, -1)), start), "Outdented")));
		}
		if (start > 0) menu.addItem((i) => i.setTitle("Move chapter up").setIcon("arrow-up").setSection("chapter").onClick(() => this.#restructure((b) => moved(b.moveSection(start, -1)), "Moved")));
		if (end < book.spine.length - 1) menu.addItem((i) => i.setTitle("Move chapter down").setIcon("arrow-down").setSection("chapter").onClick(() => this.#restructure((b) => moved(b.moveSection(start, 1)), "Moved")));
		menu.addItem((i) =>
			i
				.setTitle(end > start ? `Delete chapter (${end - start + 1} files)` : "Delete chapter")
				.setIcon("trash-2")
				.setWarning(true)
				.setSection("danger")
				.onClick(() => this.#restructure((b) => b.deleteSection(start), `Deleted "${label}"`)),
		);
	}

	// --- Edit toolbar ----------------------------------------------------------

	#buildFormatBar() {
		const bar = this.#formatEl;
		const button = (icon: string, title: string, run: () => void) => {
			const el = bar.createEl("button", { cls: "clickable-icon epub-format-button" });
			setIcon(el, icon);
			setTooltip(el, title);
			// The page keeps its selection: the button never takes the focus.
			el.addEventListener("mousedown", (evt) => evt.preventDefault());
			el.addEventListener("click", run);
			return el;
		};
		const exec = (command: string, value?: string) => () => this.#exec(command, value);
		button("undo-2", "Undo", exec("undo"));
		button("redo-2", "Redo", exec("redo"));
		bar.createDiv("epub-format-sep");
		const select = bar.createEl("select", { cls: "dropdown epub-format-block" });
		for (const [value, label] of BLOCKS) select.createEl("option", { value, text: label });
		select.addEventListener("change", () => this.#exec("formatBlock", `<${select.value}>`));
		button("bold", "Bold", exec("bold"));
		button("italic", "Italic", exec("italic"));
		button("strikethrough", "Strikethrough", exec("strikeThrough"));
		button("superscript", "Superscript", exec("superscript"));
		button("subscript", "Subscript", exec("subscript"));
		bar.createDiv("epub-format-sep");
		button("list", "Bulleted list", exec("insertUnorderedList"));
		button("list-ordered", "Numbered list", exec("insertOrderedList"));
		button("minus", "Separator", exec("insertHorizontalRule"));
		bar.createDiv("epub-format-sep");
		button("link", "Link", () => this.#insertLink());
		button("unlink", "Remove link", exec("unlink"));
		button("image-plus", "Insert image", () => this.#pickImage());
		button("remove-formatting", "Clear formatting", exec("removeFormat"));
		return select;
	}

	#exec(command: string, value?: string) {
		const win = this.#frame.contentWindow;
		const doc = this.#frame.contentDocument;
		if (this.#mode !== "edit" || !win || !doc) return;
		win.focus();
		doc.execCommand(command, false, value);
		this.#updateBlockSelect();
	}

	// The paragraph style select follows the cursor.
	#updateBlockSelect() {
		const doc = this.#frame.contentDocument;
		if (!doc || this.#mode !== "edit") return;
		let node: Node | null = doc.getSelection()?.anchorNode ?? null;
		while (node && node.nodeType !== 1) node = node.parentNode;
		const block = (node as Element | null)?.closest?.(BLOCKS.map(([tag]) => tag).join(","));
		this.#blockSelect.value = block?.localName ?? "p";
	}

	// The selection is kept while the prompt has the focus, then the link
	// wraps it (or, with nothing selected, the address becomes its text).
	#insertLink() {
		const doc = this.#frame.contentDocument;
		const win = this.#frame.contentWindow;
		if (!doc || !win || this.#mode !== "edit") return;
		const sel = doc.getSelection();
		const range = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
		const current = (sel?.anchorNode?.parentElement?.closest("a")?.getAttribute("href")) ?? "";
		new PromptModal(this.app, "Link address", current, (href) => {
			win.focus();
			if (range) {
				sel?.removeAllRanges();
				sel?.addRange(range);
			}
			if (!range || range.collapsed) {
				// The address becomes the link's text, selected, then linked.
				doc.execCommand("insertText", false, href);
				const after = sel?.rangeCount ? sel.getRangeAt(0) : null;
				if (after && after.startContainer.nodeType === 3 && after.startOffset >= href.length) {
					const linked = doc.createRange();
					linked.setStart(after.startContainer, after.startOffset - href.length);
					linked.setEnd(after.startContainer, after.startOffset);
					sel?.removeAllRanges();
					sel?.addRange(linked);
				}
			}
			doc.execCommand("createLink", false, href);
		}).open();
	}

	#pickImage() {
		const doc = this.#frame.contentDocument;
		const sel = doc?.getSelection();
		const range = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
		new ImagePicker(this.app, async (file) => {
			const data = new Uint8Array(await this.app.vault.readBinary(file));
			this.#frame.contentWindow?.focus();
			if (range) {
				sel?.removeAllRanges();
				sel?.addRange(range);
			}
			this.#insertImage(file.name, data);
		}).open();
	}

	// An image goes into the book (the book's image folder, the manifest)
	// and at the cursor; its served URL maps back to its path for saving.
	#insertImage(name: string, data: Uint8Array) {
		const book = this.#book;
		const chapter = this.#chapter;
		const doc = this.#frame.contentDocument;
		if (!book || !chapter || !doc || this.#mode !== "edit") return;
		this.#commitChapter();
		const path = book.addResource(book.imageDir(), name.replace(/[^\w.\-]+/g, "_"), data);
		const url = this.#url(path);
		if (!url) return;
		chapter.urls.set(url, relativeHref(dirname(chapter.path), path));
		// Put in by hand: insertImage and insertHTML copy the computed style
		// around the cursor (the reader's own colours included) onto the image.
		const img = doc.createElement("img");
		img.setAttribute("src", url);
		img.setAttribute("alt", name.replace(/\.[^.]+$/, ""));
		const sel = doc.getSelection();
		const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
		if (range && doc.body.contains(range.startContainer)) {
			range.deleteContents();
			range.insertNode(img);
			range.setStartAfter(img);
			range.collapse(true);
			sel?.removeAllRanges();
			sel?.addRange(range);
		} else doc.body.append(img);
		this.#dirty = true;
		this.#edited();
	}

	// --- Resources --------------------------------------------------------

	// A URL the frame loads a zip entry from; stylesheets come with their own
	// references pointed at served URLs too. Null for what the book lacks.
	#url(path: string): string | null {
		const book = this.#book;
		if (!book?.has(path)) return null;
		const known = this.#urls.get(path);
		if (known) return known;
		const type = book.mediaType(path);
		let blob: Blob;
		if (type === "text/css") {
			// An @import cycle gets no URL for the stylesheet already being built.
			if (this.#building.has(path)) return null;
			this.#building.add(path);
			try {
				blob = new Blob([rewriteCss(book.text(path), dirname(path), (p) => this.#url(p))], { type });
			} finally {
				this.#building.delete(path);
			}
		} else blob = new Blob([book.resource(path) as Uint8Array<ArrayBuffer>], { type });
		const url = URL.createObjectURL(blob);
		this.#urls.set(path, url);
		return url;
	}

	#dropUrls() {
		for (const url of this.#urls.values()) URL.revokeObjectURL(url);
		this.#urls.clear();
	}

	// The reader's look on top of the book's: the theme's text colour and
	// selection, a readable width, the text size, images that fit. On the
	// dark theme the book's own text colours and backgrounds give way.
	#applyStyle() {
		const doc = this.#frame.contentDocument;
		if (!doc?.head) return;
		const css = getComputedStyle(document.body);
		const v = (name: string) => css.getPropertyValue(name).trim();
		const dark = document.body.hasClass("theme-dark");
		let style = doc.getElementById("justnotes-epub-style");
		if (!style) {
			style = doc.createElement("style");
			style.id = "justnotes-epub-style";
		}
		doc.head.append(style);
		style.textContent = `
:root { color-scheme: ${dark ? "dark" : "light"}; font-size: ${this.#textSize()}% !important; }
html { background: transparent !important; }
body { color: ${v("--text-normal")}; margin: 0 auto !important; padding: 2em 2.5em 4em !important; max-width: ${v("--file-line-width") || "700px"} !important; box-sizing: border-box; overflow-wrap: break-word; }
:where(body) { font-family: ${v("--font-text") || "serif"}; line-height: 1.7; }
img, svg, video { max-width: 100%; height: auto; }
a { color: ${v("--text-accent")}; }
::selection { background: ${v("--text-selection")}; }
${dark ? `body { color: ${v("--text-normal")} !important; background-color: transparent !important; }
body :not(a):not(a *) { color: inherit !important; background-color: transparent !important; border-color: ${v("--background-modifier-border")} !important; }
a, a * { color: ${v("--text-accent")} !important; }` : ""}
html.is-editing body { outline: none; caret-color: ${v("--text-accent")}; }
::highlight(justnotes-search) { background-color: ${dark ? "rgba(255, 208, 0, 0.3)" : "rgba(255, 208, 0, 0.45)"}; }
::highlight(justnotes-search-current) { background-color: rgb(255, 150, 0); color: black; }
::highlight(justnotes-arrival) { background-color: ${dark ? "rgba(255, 208, 0, 0.22)" : "rgba(255, 208, 0, 0.35)"}; }
#${NOTE_ID} { position: fixed !important; z-index: 2147483647 !important; visibility: hidden; box-sizing: border-box !important; margin: 0 !important; width: max-content !important; max-width: min(30em, calc(100vw - 16px)) !important; max-height: min(24em, 50vh) !important; overflow: auto !important; padding: 0.7em 1em 0.55em !important; background: ${v("--background-primary")} !important; color: ${v("--text-normal")} !important; border: 1px solid ${v("--background-modifier-border-hover") || v("--background-modifier-border")} !important; border-radius: 8px !important; box-shadow: 0 6px 24px rgba(0, 0, 0, ${dark ? 0.5 : 0.18}) !important; font-family: ${v("--font-text") || "serif"}; font-size: 0.92rem !important; line-height: 1.65 !important; text-align: start !important; columns: auto !important; }
#${NOTE_ID} * { text-indent: 0 !important; max-width: 100%; }
#${NOTE_ID} > div > :first-child, #${NOTE_ID} > div > :first-child > :first-child { margin-top: 0 !important; }
#${NOTE_ID} p, #${NOTE_ID} dd, #${NOTE_ID} li { margin: 0 0 0.4em !important; }
#${NOTE_ID} :not(a):not(a *) { color: inherit !important; background-color: transparent !important; }
#${NOTE_ID} .justnotes-note-go { margin-top: 0.35em; font-family: ${v("--font-interface") || "sans-serif"}; font-size: 0.8rem; color: ${v("--text-accent")} !important; cursor: pointer; user-select: none; }
#${NOTE_ID} .justnotes-note-go:hover { text-decoration: underline; }
`;
		doc.documentElement.classList.toggle("is-editing", this.#mode === "edit");
		doc.documentElement.classList.toggle("is-paged", this.#paged());
		if (this.#paged()) {
			// One column per page, the readable width centred: the gap between
			// columns is the page's two margins, so pages are the frame's width.
			const width = this.#pageWidth();
			const line = Number.parseInt(v("--file-line-width"), 10) || 700;
			const column = Math.max(200, Math.min(line, width - 64));
			const gap = width - column;
			style.textContent += `
html.is-paged { height: 100%; overflow: hidden; }
html.is-paged body { box-sizing: border-box; height: 100vh; margin: 0 !important; max-width: none !important; width: ${width}px; padding: 2.5em ${gap / 2}px !important; column-width: ${column}px; column-gap: ${gap}px; column-fill: auto; }
html.is-paged img, html.is-paged svg, html.is-paged video { max-height: calc(100vh - 6em); object-fit: contain; break-inside: avoid; }
`;
		}
		// The class above is the frame's own; commitBody serializes <body> only.
	}

	#textSize() {
		const size = Number(this.app.loadLocalStorage(TEXT_SIZE));
		return SIZES.includes(size) ? size : 100;
	}

	#resizeText(delta: number) {
		const i = SIZES.indexOf(this.#textSize());
		const next = SIZES[Math.max(0, Math.min(SIZES.length - 1, i + delta))];
		this.app.saveLocalStorage(TEXT_SIZE, next);
		this.#applyStyle();
	}

	// --- Contents, footer, positions ---------------------------------------

	#renderToc() {
		this.#tocEl.empty();
		const book = this.#book;
		if (!book) return;
		const title = book.metadata().title;
		if (title) this.#tocEl.createDiv({ cls: "epub-toc-title", text: title });
		const entries: TocEntry[] = book.toc.length
			? book.toc
			: book.spine.map((item, i) => ({ label: `Chapter ${i + 1}`, path: item.path, fragment: "", children: [] }));
		const add = (list: TocEntry[], depth: number) => {
			for (const entry of list) {
				const el = this.#tocEl.createDiv({ cls: "epub-toc-item tree-item-self is-clickable", text: entry.label || "Untitled", attr: { "data-path": entry.path } });
				el.style.paddingInlineStart = `${0.75 + depth * 1}em`;
				if (entry.path) el.addEventListener("click", () => void this.#go(entry.path, entry.fragment));
				else el.addClass("is-disabled");
				el.addEventListener("contextmenu", (evt) => {
					const index = book.spineIndexOf(entry.path);
					if (index < 0) return;
					evt.preventDefault();
					const menu = new Menu();
					menu.addSections(["chapter", "danger"]);
					this.#chapterMenu(menu, index);
					menu.showAtMouseEvent(evt);
				});
				add(entry.children, depth + 1);
			}
		};
		add(entries, 0);
		// The landmarks, below the contents.
		const marks = book.landmarks().filter((l) => book.spineIndexOf(l.path) >= 0);
		if (marks.length) {
			this.#tocEl.createDiv({ cls: "epub-toc-title epub-landmarks-title", text: "Landmarks" });
			for (const mark of marks) {
				const el = this.#tocEl.createDiv({ cls: "epub-landmark tree-item-self is-clickable", text: kindOf(mark.type)?.label ?? mark.label });
				el.addEventListener("click", () => void this.#go(mark.path, mark.fragment));
			}
		}
	}

	#toggleToc() {
		const shown = !this.#sideEl.isShown();
		this.app.saveLocalStorage(TOC_SHOWN, shown);
		this.#showToc(shown);
	}

	#showToc(shown: boolean) {
		this.#sideEl.toggle(shown || this.#resultsEl.isShown());
		this.#tocAction.toggleClass("is-active", shown);
	}

	#updateChrome() {
		const book = this.#book;
		if (!book) return;
		// The entry of this chapter, else of the nearest chapter before it that
		// has one (a book's contents often skip its interludes and notes).
		let current: HTMLElement | null = null;
		let best = -1;
		const items = this.#tocEl.findAll(".epub-toc-item");
		for (const el of items) {
			const at = book.spineIndexOf(el.getAttr("data-path") ?? "");
			if (at > best && at <= this.#index) {
				best = at;
				current = el;
			}
		}
		for (const el of items) el.toggleClass("is-active", el === current);
		current?.scrollIntoView({ block: "nearest" });
		const label = current?.textContent ?? `Chapter ${this.#index + 1}`;
		const page = this.#paged() ? ` · p. ${this.#page() + 1}/${this.#pageCount()}` : "";
		this.#labelEl.setText(`${label} · ${this.#index + 1} / ${book.spine.length}${page}`);
		this.#prevEl.disabled = this.#index === 0;
		this.#nextEl.disabled = this.#index === book.spine.length - 1;
	}

	#positions(): Record<string, Position> {
		const stored = this.app.loadLocalStorage(POSITIONS);
		return stored && typeof stored === "object" ? stored : {};
	}

	#fraction() {
		const win = this.#frame.contentWindow;
		const doc = this.#frame.contentDocument;
		if (!win || !doc || this.#mode === "source") return this.#positions()[this.#path]?.fraction ?? 0;
		if (this.#paged()) {
			const pages = this.#pageCount();
			return pages > 1 ? Math.min(1, this.#page() / (pages - 1)) : 0;
		}
		const range = doc.documentElement.scrollHeight - win.innerHeight;
		return range > 0 ? Math.min(1, win.scrollY / range) : 0;
	}

	#rememberPosition() {
		if (!this.#book || !this.file) return;
		const positions = this.#positions();
		positions[this.file.path] = { index: this.#index, fraction: this.#fraction() };
		this.app.saveLocalStorage(POSITIONS, positions);
	}

	#showMessage(text: string) {
		this.#messageEl.setText(text);
		this.#messageEl.show();
		this.#tocEl.empty();
	}

	// --- Saving ------------------------------------------------------------

	// A change on disk from elsewhere reloads the book, unless it holds edits:
	// those stay and the next save writes over the outside change.
	async #onModify(file: TAbstractFile) {
		if (file !== this.file || this.#saving || (file as TFile).stat.mtime === this.#mtime) return;
		if (this.#dirty || this.#chapterDirty) {
			new Notice(`${file.path} changed on disk. Your unsaved edits are kept and will replace it when saved.`);
			this.#mtime = (file as TFile).stat.mtime;
			return;
		}
		const index = this.#index;
		const fraction = this.#fraction();
		try {
			this.#book = EpubBook.read(await this.app.vault.readBinary(file as TFile));
		} catch (err) {
			this.#showMessage(`Could not read ${file.path}: ${err instanceof Error ? err.message : err}`);
			return;
		}
		this.#mtime = (file as TFile).stat.mtime;
		this.#forgetUndo();
		this.#dropUrls();
		this.#renderToc();
		await this.#show(index, { fraction });
	}

	#saveNow() {
		try {
			this.#commitChapter();
			if (!this.#dirty || !this.file || !this.#book || this.app.vault.getAbstractFileByPath(this.file.path) !== this.file) return;
			fs.writeFileSync(this.app.vault.adapter.getFullPath(this.file.path), this.#book.toBytes());
			this.#dirty = false;
		} catch (err) {
			console.error(err);
		}
	}

	#sourceState(doc: string) {
		return EditorState.create({
			doc,
			extensions: [
				history(),
				drawSelection(),
				EditorView.lineWrapping,
				search({ top: true }),
				html(),
				syntaxHighlighting(codeHighlight),
				keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) this.#edited();
				}),
			],
		});
	}

	#editInfo() {
		const book = this.#book;
		if (!book) return;
		new BookInfoModal(this.app, book.metadata(), async (changes) => {
			this.#commitChapter();
			if (!book.setMetadata(changes)) return;
			this.#forgetUndo();
			this.#dirty = true;
			this.#renderToc();
			this.#updateChrome();
			await this.save();
		}).open();
	}
}

const LABELS: Record<keyof BookMetadata, string> = { title: "Title", creator: "Author", language: "Language", publisher: "Publisher", description: "Description" };

class BookInfoModal extends Modal {
	#values: BookMetadata;
	#onSave: (changes: BookMetadata) => Promise<void>;

	constructor(app: App, values: BookMetadata, onSave: (changes: BookMetadata) => Promise<void>) {
		super(app);
		this.#values = { ...values };
		this.#onSave = onSave;
	}

	onOpen() {
		this.titleEl.setText("Book info");
		for (const field of METADATA_FIELDS) {
			const setting = new Setting(this.contentEl).setName(LABELS[field]);
			const bind = (c: { setValue: (v: string) => unknown; onChange: (cb: (v: string) => void) => unknown }) => {
				c.setValue(this.#values[field]);
				c.onChange((value) => (this.#values[field] = value));
			};
			if (field === "description") setting.addTextArea(bind);
			else setting.addText(bind);
		}
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText("Save")
				.setCta()
				.onClick(async () => {
					this.close();
					await this.#onSave(this.#values);
				}),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// A move that could not happen says why (it is undone).
function moved(index: number) {
	if (index < 0) throw new Error("There is no chapter to move past at this level of the contents");
	return index;
}

// A nesting change that could not happen says why (it is undone).
function nested(done: boolean) {
	if (!done) throw new Error("There is no entry before this one at its level to go under");
}

class ImagePicker extends FuzzySuggestModal<TFile> {
	#onChoose: (file: TFile) => void;

	constructor(app: App, onChoose: (file: TFile) => void) {
		super(app);
		this.#onChoose = onChoose;
		this.setPlaceholder("Insert an image from the vault...");
	}

	getItems() {
		return this.app.vault.getFiles().filter((f) => IMAGE_EXTENSIONS.has(f.extension.toLowerCase()));
	}

	getItemText(file: TFile) {
		return file.path;
	}

	onChooseItem(file: TFile) {
		this.#onChoose(file);
	}
}

// Waits for the page's stylesheets, so a scroll position lands where it was;
// a sheet that never loads waits a second at most.
function stylesheetsLoaded(doc: Document) {
	const links = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')).filter((link) => !link.sheet);
	const loaded = Promise.all(links.map((link) => new Promise((resolve) => (link.onload = link.onerror = resolve))));
	return Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 1000))]);
}

export function registerEpubView(app: App) {
	app.viewRegistry.registerViewWithExtensions(["epub"], EPUB_VIEW, (leaf) => new EpubView(leaf));
}
