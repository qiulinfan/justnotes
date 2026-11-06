import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { App } from "../../api/app";
import { getElectron } from "../../api/dom";
import { setIcon } from "../../api/icons";
import { Keymap } from "../../api/keymap";
import { loadPdfJs } from "../../api/markdown";
import { Menu } from "../../api/ui/menu";
import { Modal } from "../../api/ui/modal";
import { Notice } from "../../api/ui/notice";
import { Setting } from "../../api/ui/setting";
import { FuzzySuggestModal } from "../../api/ui/suggest";
import { setTooltip } from "../../api/ui/tooltip";
import { debounce, Platform } from "../../api/util";
import { type TAbstractFile, TFile } from "../../api/vault";
import { FileView } from "../../api/view";
import type { Tasks, WorkspaceLeaf } from "../../api/workspace";
import { bridgeToMain } from "./popout-bridge";
import { NO_PRINTERS, printPdf } from "./print";
import { SignatureModal } from "./signature";
import {
	addNote,
	deleteAnnotation,
	listAnnotations,
	type PdfAnnotation,
	relocate,
	setAnnotationContents,
	deletePages,
	duplicatePages,
	extractPages,
	INFO_FIELDS,
	insertBlankPage,
	insertPdf,
	movedOrder,
	type PdfInfo,
	readInfo,
	reorderPages,
	rotatePages,
	writeInfo,
} from "./pages";

export const PDF_VIEW = "pdf";

// pdf.js's viewer components (web/pdf_viewer.mjs) read the library from
// globalThis.pdfjsLib, which loadPdfJs sets; their stylesheet goes first in
// <head>, so the app's and the theme's rules win where both style a thing.
let viewerModule: Promise<{ lib: any; web: any }> | null = null;

function loadViewer() {
	viewerModule ??= (async () => {
		const lib = await loadPdfJs();
		const base = new URL("lib/pdfjs/web/", document.baseURI).href;
		if (!document.getElementById("justnotes-pdf-viewer-css")) {
			const link = document.createElement("link");
			link.id = "justnotes-pdf-viewer-css";
			link.rel = "stylesheet";
			link.href = `${base}pdf_viewer.css`;
			document.head.prepend(link);
		}
		const web = await import(`${base}pdf_viewer.mjs`);
		return { lib, web };
	})();
	viewerModule.catch(() => (viewerModule = null));
	return viewerModule;
}

// Annotation tools: pdf.js's editor modes, and the parameters each takes.
type Tool = "select" | "highlight" | "text" | "draw" | "image" | "note";
const TOOLS: { tool: Tool; icon: string; title: string }[] = [
	{ tool: "select", icon: "mouse-pointer-2", title: "Select text" },
	{ tool: "highlight", icon: "highlighter", title: "Highlight" },
	{ tool: "text", icon: "type", title: "Add text" },
	{ tool: "draw", icon: "pen-line", title: "Draw" },
	{ tool: "image", icon: "image-plus", title: "Add an image or a signature" },
	{ tool: "note", icon: "message-square-plus", title: "Add a note (click where it goes)" },
];
const COLORS: Record<Exclude<Tool, "select" | "image" | "note">, string[]> = {
	highlight: ["#FFFF98", "#53FFBC", "#80EBFF", "#FFCBE6", "#FF4F5F"],
	text: ["#000000", "#E03131", "#1971C2", "#2F9E44", "#F08C00"],
	draw: ["#E03131", "#000000", "#1971C2", "#2F9E44", "#F08C00"],
};
const HIGHLIGHT_COLORS = "yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F";
const SIZES: Record<"text" | "draw" | "highlight", number[]> = { text: [10, 12, 16, 20, 28], draw: [1, 2, 4, 8, 12], highlight: [8, 12, 16, 24, 32] };
const ZOOMS = [
	["auto", "Automatic"],
	["page-width", "Page width"],
	["page-fit", "Whole page"],
	["page-actual", "Actual size"],
	["0.5", "50%"],
	["0.75", "75%"],
	["1", "100%"],
	["1.25", "125%"],
	["1.5", "150%"],
	["2", "200%"],
	["3", "300%"],
] as const;

// Per viewer: where each PDF was left, the tool settings, the sidebar.
const POSITIONS = "justnotes-pdf-positions";
const TOOL_SETTINGS = "justnotes-pdf-tools";
const SIDEBAR = "justnotes-pdf-sidebar";
const DARK_PAGES = "justnotes-pdf-dark-pages";
const UNDO_LIMIT = 10;

// Without left and top, the top of the page.
interface Position {
	page: number;
	scale: string;
	left?: number;
	top?: number;
}

// A PDF in a tab: pdf.js's viewer (text selection, links, forms, search)
// with its annotation editors (highlight, text, drawing, images), a sidebar
// of page thumbnails, where pages are selected, dragged into a new order and
// turned, duplicated, deleted, extracted, or have blank pages and other PDFs
// put between them, and the outline. Annotations and form values save
// through pdf.js (an incremental update, two seconds after the last change,
// on Mod+S, when the tab closes and before the window does); page changes
// and document info rewrite the file through pdf-lib at once, after saving
// pending annotations into it, and can be undone.
export class PdfView extends FileView {
	#pdf: any = null;
	#doc: any = null;
	#viewer: any = null;
	#uiManager: any = null;
	#canUndo = false;
	#canRedo = false;
	#eventBus: any = null;
	#linkService: any = null;
	#web: any = null;
	#lib: any = null;
	#tool: Tool = "select";
	#dirty = false;
	#busy: Promise<unknown> | null = null;
	#mtime = 0;
	#undo: Uint8Array[] = [];
	#selected = new Set<number>();
	#anchor = -1;
	#pendingPage: number | null = null;
	#deferred: Position | null = null;
	#loadId = 0;
	#thumbObserver: IntersectionObserver | null = null;

	#toolbarEl: HTMLElement;
	#pageInput: HTMLInputElement;
	#pageCount: HTMLElement;
	#zoomSelect: HTMLSelectElement;
	#toolButtons = new Map<Tool, HTMLElement>();
	#paramsEl: HTMLElement;
	#undoButton: HTMLElement;
	#findEl: HTMLElement;
	#findInput: HTMLInputElement;
	#findCount: HTMLElement;
	#findCase = false;
	#findWord = false;
	#sidebarEl: HTMLElement;
	#thumbsEl: HTMLElement;
	#outlineEl: HTMLElement;
	#notesEl: HTMLElement;
	#unbridge: () => void = () => {};
	#bridged: Window | null = null;
	#noteDown: { x: number; y: number } | null = null;
	// The path this view's position is stored under (onRename moves it).
	#path = "";
	#containerEl: HTMLElement;
	#viewerEl: HTMLElement;
	#messageEl: HTMLElement;
	#autosave = debounce(() => void this.save(), 2000, true);
	#storePosition = debounce((location: any) => this.#rememberPosition(location), 300, true);

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "file-text";
		this.contentEl.addClass("pdf-view");

		const bar = (this.#toolbarEl = this.contentEl.createDiv("pdf-toolbar"));
		const button = (parent: HTMLElement, icon: string, title: string, cb: (evt: MouseEvent) => any) => {
			const el = parent.createEl("button", { cls: "clickable-icon pdf-toolbar-button" });
			setIcon(el, icon);
			setTooltip(el, title);
			el.addEventListener("click", cb);
			return el;
		};
		const left = bar.createDiv("pdf-toolbar-group");
		button(left, "panel-left", "Pages and outline", () => this.#toggleSidebar());
		button(left, "chevron-up", "Previous page", () => this.#viewer?.previousPage());
		button(left, "chevron-down", "Next page", () => this.#viewer?.nextPage());
		this.#pageInput = left.createEl("input", { cls: "pdf-page-input", attr: { type: "text", inputmode: "numeric", "aria-label": "Page" } });
		this.#pageCount = left.createDiv({ cls: "pdf-page-count" });
		this.#pageInput.addEventListener("change", () => this.#goToPageInput());
		this.#pageInput.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") this.#goToPageInput();
		});

		const zoom = bar.createDiv("pdf-toolbar-group");
		button(zoom, "zoom-out", "Zoom out", () => this.#viewer?.decreaseScale());
		this.#zoomSelect = zoom.createEl("select", { cls: "dropdown pdf-zoom-select" });
		for (const [value, label] of ZOOMS) this.#zoomSelect.createEl("option", { value, text: label });
		this.#zoomSelect.createEl("option", { value: "custom", text: "" }).hidden = true;
		this.#zoomSelect.addEventListener("change", () => {
			if (this.#viewer && this.#zoomSelect.value !== "custom") this.#viewer.currentScaleValue = this.#zoomSelect.value;
		});
		button(zoom, "zoom-in", "Zoom in", () => this.#viewer?.increaseScale());

		const tools = bar.createDiv("pdf-toolbar-group pdf-tools");
		for (const { tool, icon, title } of TOOLS) this.#toolButtons.set(tool, button(tools, icon, title, (evt) => (tool === "image" ? this.#imageMenu(evt) : void this.setTool(tool))));
		this.#paramsEl = bar.createDiv("pdf-toolbar-group pdf-tool-params");

		const right = bar.createDiv("pdf-toolbar-group pdf-toolbar-end");
		this.#undoButton = button(right, "undo-2", "Undo the last page change", () => void this.undoPageChange());
		this.#undoButton.hide();
		button(right, "printer", "Print", () => void this.print());
		button(right, "search", "Search", () => this.showSearch());

		this.#findEl = this.contentEl.createDiv("pdf-findbar");
		this.#findEl.hide();
		this.#findInput = this.#findEl.createEl("input", { cls: "pdf-find-input", attr: { type: "search", placeholder: "Find in document", spellcheck: "false" } });
		this.#findInput.addEventListener("input", () => this.#find(""));
		this.#findInput.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				this.#find("again", evt.shiftKey);
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				this.#closeFind();
			}
		});
		const toggle = (text: string, title: string, get: () => boolean, set: (on: boolean) => void) => {
			const el = this.#findEl.createEl("button", { cls: "pdf-find-toggle", text });
			setTooltip(el, title);
			el.addEventListener("click", () => {
				set(!get());
				el.toggleClass("is-active", get());
				this.#find("");
			});
		};
		toggle("Aa", "Match case", () => this.#findCase, (on) => (this.#findCase = on));
		toggle("W", "Whole words", () => this.#findWord, (on) => (this.#findWord = on));
		button(this.#findEl, "arrow-up", "Previous match", () => this.#find("again", true));
		button(this.#findEl, "arrow-down", "Next match", () => this.#find("again", false));
		this.#findCount = this.#findEl.createDiv("pdf-find-count");
		button(this.#findEl, "x", "Close", () => this.#closeFind());

		const body = this.contentEl.createDiv("pdf-body");
		this.#sidebarEl = body.createDiv("pdf-sidebar");
		const tabs = this.#sidebarEl.createDiv("pdf-sidebar-tabs");
		this.#thumbsEl = this.#sidebarEl.createDiv("pdf-thumbs");
		this.#outlineEl = this.#sidebarEl.createDiv("pdf-outline");
		// Focusable, so Delete and Backspace reach the selected thumbnails.
		this.#thumbsEl.tabIndex = 0;
		this.#notesEl = this.#sidebarEl.createDiv("pdf-notes");
		const panes = [this.#thumbsEl, this.#outlineEl, this.#notesEl];
		const tab = (text: string, pane: HTMLElement) => {
			const el = tabs.createDiv({ cls: "pdf-sidebar-tab", text });
			el.addEventListener("click", () => {
				for (const p of panes) p.toggle(p === pane);
				for (const t of tabs.findAll(".pdf-sidebar-tab")) t.toggleClass("is-active", t === el);
			});
			return el;
		};
		tab("Pages", this.#thumbsEl).addClass("is-active");
		tabs.firstElementChild?.addEventListener("click", () => this.#thumbsEl.find(".pdf-thumb.is-current")?.scrollIntoView({ block: "nearest" }));
		tab("Outline", this.#outlineEl);
		tab("Notes", this.#notesEl).addEventListener("click", () => void this.#renderNotes());
		this.#outlineEl.hide();
		this.#notesEl.hide();
		this.#sidebarEl.toggle(this.app.loadLocalStorage(SIDEBAR) !== false);

		const main = body.createDiv("pdf-main");
		this.#messageEl = main.createDiv("pdf-message");
		this.#messageEl.hide();
		this.#containerEl = main.createDiv("pdf-container");
		this.#containerEl.tabIndex = 0;
		this.#viewerEl = this.#containerEl.createDiv("pdfViewer");
		this.#containerEl.addEventListener("wheel", (evt) => this.#onWheel(evt), { passive: false });
		// A press and release in one place, not "click": pdf.js's text layer
		// moves an element under the pointer on press, so the click event
		// often never comes.
		this.#containerEl.addEventListener("pointerdown", (evt) => (this.#noteDown = evt.button === 0 ? { x: evt.clientX, y: evt.clientY } : null), true);
		this.#containerEl.addEventListener("pointerup", (evt) => {
			const down = this.#noteDown;
			this.#noteDown = null;
			if (down && Math.hypot(evt.clientX - down.x, evt.clientY - down.y) < 5) this.#onNoteClick(evt);
		}, true);
		this.contentEl.addEventListener("keydown", (evt) => this.#onKey(evt));
		this.#applyDarkPages();
	}

	getViewType() {
		return PDF_VIEW;
	}

	getIcon() {
		return "file-text";
	}

	canAcceptExtension(extension: string) {
		return extension === "pdf";
	}

	onload() {
		super.onload();
		this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile) => void this.#onModify(file)));
		this.registerEvent(this.app.workspace.on("quit", (tasks: Tasks) => tasks.add(() => this.save())));
		// In a popout window pdf.js's editors still hear the vault window.
		this.#ensureBridge();
		const stop = this.containerEl.onWindowMigrated(() => this.#ensureBridge());
		this.register(() => {
			stop?.();
			this.#unbridge();
		});
	}

	// The bridge follows the window the view is in (a view restored into a
	// popout may load before it is there).
	#ensureBridge() {
		const win = this.containerEl.win;
		if (win === this.#bridged) return;
		this.#unbridge();
		this.#bridged = win;
		this.#unbridge = bridgeToMain(win, this.contentEl, () => this.#uiManager, () => this.app.workspace.activeLeaf === this.leaf);
	}

	onResize() {
		this.#ensureBridge();
		if (!this.#containerEl.offsetParent) return;
		if (this.#deferred) {
			this.#onPagesInit(this.#deferred);
			return;
		}
		if (this.#pendingPage && this.#viewer?.pagesCount) {
			this.#viewer.currentPageNumber = Math.min(this.#pendingPage, this.#viewer.pagesCount);
			this.#pendingPage = null;
		}
		// "Automatic" and the fitted zooms depend on the pane's size.
		const value = this.#viewer?.currentScaleValue;
		if (typeof value === "string" && Number.isNaN(Number(value))) this.#viewer.currentScaleValue = value;
	}

	onPaneMenu(menu: Menu, source: string) {
		menu.addItem((i) =>
			i
				.setTitle("Dark pages")
				.setIcon("moon")
				.setChecked(this.app.loadLocalStorage(DARK_PAGES) === true)
				.setSection("view")
				.onClick(() => {
					this.app.saveLocalStorage(DARK_PAGES, this.app.loadLocalStorage(DARK_PAGES) !== true);
					this.#applyDarkPages();
				}),
		);
		menu.addItem((i) => i.setTitle("Rotate all pages clockwise").setIcon("rotate-cw").setSection("action").onClick(() => void this.#rotate(this.#allPages(), 90)));
		menu.addItem((i) => i.setTitle("Insert pages from a PDF...").setIcon("file-plus").setSection("action").onClick(() => this.#pickPdf(this.#pageCountNow())));
		menu.addItem((i) => i.setTitle("Document info...").setIcon("info").setSection("action").onClick(() => void this.#editInfo()));
		menu.addItem((i) => i.setTitle("Print...").setIcon("printer").setSection("action").onClick(() => void this.print()));
		super.onPaneMenu(menu, source);
	}

	// The search bar (Mod+F, editor:open-search).
	showSearch() {
		this.#findEl.show();
		this.#findInput.focus();
		this.#findInput.select();
		if (this.#findInput.value) this.#find("");
	}

	// A link's #page=N (Obsidian's syntax for PDF links).
	setEphemeralState(state: any) {
		const page = typeof state?.page === "number" ? state.page : Number(/[#&]?page=(\d+)/.exec(state?.subpath ?? "")?.[1]);
		if (!page) return;
		if (this.#viewer?.pagesCount && !this.#deferred && this.#containerEl.offsetParent) this.#viewer.currentPageNumber = Math.min(page, this.#viewer.pagesCount);
		else this.#pendingPage = page;
	}

	getEphemeralState() {
		return this.#viewer?.pagesCount ? { page: this.#viewer.currentPageNumber } : {};
	}

	async onLoadFile(file: TFile) {
		this.#path = file.path;
		this.#undo = [];
		this.#undoButton.hide();
		this.#selected.clear();
		await this.#open(file, await this.app.vault.readBinary(file), this.#positions()[file.path]);
	}

	async onUnloadFile(_file: TFile) {
		await this.save();
		this.#autosave.cancel();
		await this.#close();
	}

	async onRename(file: TFile) {
		const positions = this.#positions();
		if (this.#path && this.#path !== file.path && positions[this.#path]) {
			positions[file.path] = positions[this.#path];
			delete positions[this.#path];
			this.app.saveLocalStorage(POSITIONS, positions);
		}
		this.#path = file.path;
		await super.onRename(file);
	}

	async setTool(tool: Tool) {
		this.#ensureBridge();
		const viewer = this.#viewer;
		const types = this.#lib?.AnnotationEditorType;
		if (!viewer || !types) return;
		// The note tool is the view's own: pdf.js selects text meanwhile.
		const mode = { select: types.NONE, highlight: types.HIGHLIGHT, text: types.FREETEXT, draw: types.INK, image: types.STAMP, note: types.NONE }[tool];
		try {
			viewer.annotationEditorMode = { mode };
		} catch (err) {
			new Notice(`This PDF cannot be annotated: ${err instanceof Error ? err.message : err}`);
			return;
		}
		this.#tool = tool;
		for (const [t, el] of this.#toolButtons) el.toggleClass("is-active", t === tool);
		this.contentEl.toggleClass("is-note-tool", tool === "note");
		this.#renderParams();
		// A new tool's colour and size are its defaults: an annotation still
		// selected from the last tool would take them instead.
		this.#uiManager?.unselectAll?.();
		this.#applyParams();
	}

	// Prints every page with the annotations as they stand.
	// `options` go to Electron's webContents.print (none: the system's dialog).
	async print(options: Record<string, unknown> = {}) {
		const doc = this.#doc;
		if (!doc || !this.#lib) return null;
		const notice = new Notice("Preparing to print...", 0);
		try {
			const result = await printPdf(doc, this.#lib, (done, total) => notice.setMessage(`Preparing page ${done} of ${total}...`), options);
			if (result.reason === NO_PRINTERS) new Notice(`No printer is set up on this computer. Add one in ${Platform.isMacOS ? "System Settings → Printers & Scanners" : "Settings → Bluetooth & devices → Printers & scanners"}, then print again.`);
			else if (!result.printed && result.reason !== "cancelled") new Notice(`Could not print: ${result.reason || "the printer refused the job"}`);
			return result;
		} catch (err) {
			new Notice(`Could not print: ${err instanceof Error ? err.message : err}`);
			return null;
		} finally {
			notice.hide();
		}
	}

	// --- Images and signatures ---------------------------------------------

	#imageMenu(evt: MouseEvent) {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Image from the vault...").setIcon("image").onClick(() => this.#pickVaultImage()));
		menu.addItem((i) => i.setTitle("Image file...").setIcon("folder-open").onClick(() => void this.#pickImageFile()));
		menu.addItem((i) => i.setTitle("Signature...").setIcon("signature").onClick(() => new SignatureModal(this.app, (png) => void this.addImage(png, "signature.png", "image/png")).open()));
		menu.showAtMouseEvent(evt);
	}

	#pickVaultImage() {
		new VaultImagePicker(this.app, async (file) => {
			const bytes = new Uint8Array(await this.app.vault.readBinary(file));
			await this.addImage(bytes, file.name, IMAGE_TYPES[file.extension.toLowerCase()] ?? "image/png");
		}).open();
	}

	// main's file dialog, not pdf.js's own <input type=file>.
	async #pickImageFile() {
		const { remote } = getElectron();
		const result = await remote.dialog.showOpenDialog(remote.getCurrentWindow(), {
			properties: ["openFile"],
			filters: [{ name: "Images", extensions: Object.keys(IMAGE_TYPES) }],
		});
		const path: string | undefined = result?.filePaths?.[0];
		if (result?.canceled || !path) return;
		const ext = nodePath.extname(path).slice(1).toLowerCase();
		await this.addImage(new Uint8Array(fs.readFileSync(path)), nodePath.basename(path), IMAGE_TYPES[ext] ?? "image/png");
	}

	// An image annotation in the middle of the page in view, selected so it
	// can be moved and resized; the image tool stays on.
	async addImage(bytes: Uint8Array, name: string, type: string) {
		if (!this.#viewer || !this.#lib) return;
		if (this.#tool !== "image") await this.setTool("image");
		await sleep(50);
		const file = new File([bytes as Uint8Array<ArrayBuffer>], name, { type });
		this.#eventBus.dispatch("switchannotationeditorparams", { source: this, type: this.#lib.AnnotationEditorParamsType.CREATE, value: { bitmapFile: file } });
	}

	// --- Notes ----------------------------------------------------------------

	// With the note tool, a click on a page puts a note there.
	#onNoteClick(evt: MouseEvent) {
		if (this.#tool !== "note" || !this.#viewer) return;
		const doc = this.containerEl.doc;
		const target = (doc.elementFromPoint(evt.clientX, evt.clientY) ?? evt.target) as Element;
		if (target.closest(".annotationLayer section, .annotationLayer .popup")) return;
		const pageEl = target.closest(".page") as HTMLElement | null;
		const number = Number(pageEl?.dataset.pageNumber);
		if (!pageEl || !number) return;
		const view = this.#viewer.getPageView(number - 1);
		const rect = pageEl.getBoundingClientRect();
		const [x, y] = view.viewport.convertToPdfPoint(evt.clientX - rect.left, evt.clientY - rect.top);
		new NoteModal(this.app, "Add a note", "", (text) => this.#change((b) => addNote(b, number - 1, x, y, text), "Added a note").then(() => this.#refreshNotes())).open();
	}

	#refreshNotes() {
		if (this.#notesEl.isShown()) return this.#renderNotes();
	}

	// Every annotation with something to say: notes, highlights, text,
	// drawings, images; a note's text can be edited, any of them deleted.
	async #renderNotes() {
		const doc = this.#doc;
		if (!doc) return;
		let list: PdfAnnotation[];
		try {
			list = await listAnnotations(await this.#currentBytes());
		} catch (err) {
			this.#notesEl.empty();
			this.#notesEl.createDiv({ cls: "pdf-outline-empty", text: `Could not read the annotations: ${err instanceof Error ? err.message : err}` });
			return;
		}
		if (doc !== this.#doc) return;
		this.#notesEl.empty();
		if (!list.length) {
			this.#notesEl.createDiv({ cls: "pdf-outline-empty", text: "No notes or annotations yet. Pick the note tool and click on a page to add one." });
			return;
		}
		for (const annot of list) {
			const row = this.#notesEl.createDiv("pdf-note");
			const head = row.createDiv("pdf-note-head");
			head.createSpan({ cls: "pdf-note-kind", text: KINDS[annot.subtype] ?? annot.subtype });
			head.createSpan({ cls: "pdf-note-page", text: `p. ${annot.page + 1}` });
			const actions = head.createDiv("pdf-note-actions");
			// A note's text, or a comment on any other annotation (pdf.js shows
			// it in the annotation's popup); a text box's contents are its text.
			if (annot.subtype !== "FreeText") {
				const note = annot.subtype === "Text";
				const edit = actions.createDiv({ cls: "clickable-icon", attr: { "aria-label": note ? "Edit" : annot.contents ? "Edit the comment" : "Add a comment" } });
				setIcon(edit, note ? "pencil" : "message-square");
				edit.addEventListener("click", (e) => {
					e.stopPropagation();
					const title = note ? "Edit the note" : `Comment on the ${(KINDS[annot.subtype] ?? annot.subtype).toLowerCase()}`;
					new NoteModal(this.app, title, annot.contents, (text) => this.#change(async (b) => setAnnotationContents(b, await relocate(b, annot), text), note ? "Saved the note" : "Saved the comment").then(() => this.#refreshNotes()), !note).open();
				});
			}
			const del = actions.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Delete" } });
			setIcon(del, "trash-2");
			del.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.#change(async (b) => deleteAnnotation(b, await relocate(b, annot)), "Deleted").then(() => this.#refreshNotes());
			});
			if (annot.contents) row.createDiv({ cls: "pdf-note-text", text: annot.contents });
			row.addEventListener("click", () => {
				const [x1, , , y2] = annot.rect;
				this.#viewer?.scrollPageIntoView({ pageNumber: annot.page + 1, destArray: [null, { name: "XYZ" }, x1 ?? null, (y2 ?? 0) + 40, null] });
			});
		}
	}

	// Writes annotations and form values when there are unsaved ones.
	async save() {
		this.#autosave.cancel();
		while (this.#busy) await this.#busy.catch(() => {});
		const file = this.file;
		const doc = this.#doc;
		if (!this.#dirty || !file || !doc) return;
		if (this.app.vault.getAbstractFileByPath(file.path) !== file) return;
		this.#dirty = false;
		const run = (async () => {
			const bytes: Uint8Array = await doc.saveDocument();
			await this.#write(file, bytes);
		})();
		this.#busy = run;
		try {
			await run;
		} catch (err) {
			this.#dirty = true;
			new Notice(`Could not save ${file.path}: ${err instanceof Error ? err.message : err}`);
		} finally {
			this.#busy = null;
		}
	}

	// Waits for a save or change in progress, and holds off outside-change
	// reloads while it writes (its own write fires the vault's modify).
	async undoPageChange() {
		while (this.#busy) await this.#busy.catch(() => {});
		const previous = this.#undo.pop();
		const file = this.file;
		if (!previous || !file) return;
		this.#autosave.cancel();
		const run = this.#replace(file, previous, false);
		this.#busy = run;
		try {
			await run;
		} catch (err) {
			this.#undo.push(previous);
			new Notice(`Could not undo: ${err instanceof Error ? err.message : err}`);
		} finally {
			this.#busy = null;
		}
		this.#undoButton.toggle(this.#undo.length > 0);
	}

	// --- Loading ----------------------------------------------------------

	async #open(file: TFile, data: ArrayBuffer | Uint8Array, at?: Position) {
		const id = ++this.#loadId;
		let modules: { lib: any; web: any };
		try {
			modules = await loadViewer();
		} catch (err) {
			this.#showMessage(`Could not load the PDF viewer: ${err instanceof Error ? err.message : err}`);
			return;
		}
		if (id !== this.#loadId) return;
		this.#lib = modules.lib;
		this.#web = modules.web;
		this.#ensureViewer();
		await this.#close();
		this.#mtime = file.stat.mtime;
		// getDocument takes the bytes over (to its worker); it gets a copy.
		const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
		let doc: any;
		try {
			this.#pdf = this.#lib.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false });
			this.#pdf.onPassword = (update: (password: string) => void, reason: number) => this.#askPassword(update, reason);
			doc = await this.#pdf.promise;
		} catch (err) {
			if (id === this.#loadId) this.#showMessage(`Could not open ${file.name}: ${err instanceof Error ? err.message : err}`);
			return;
		}
		if (id !== this.#loadId) {
			void doc.destroy();
			return;
		}
		this.#messageEl.hide();
		this.#doc = doc;
		this.#dirty = false;
		doc.annotationStorage.onSetModified = () => {
			this.#dirty = true;
			// Undoing a page change writes the bytes from before it: after
			// annotation edits it would take them back too.
			this.#undo = [];
			this.#undoButton.hide();
			this.#autosave();
		};
		const restore = at ?? null;
		this.#eventBus._on("pagesinit", () => this.#onPagesInit(restore), { once: true });
		this.#viewer.setDocument(doc);
		this.#linkService.setDocument(doc);
		this.#pageCount.setText(`/ ${doc.numPages}`);
		void this.#renderOutline(doc);
		this.#renderThumbs(doc);
	}

	// A tab in the background has no layout to scroll in: its place is set
	// when it first shows (onResize).
	#onPagesInit(at: Position | null) {
		if (!this.#containerEl.offsetParent) {
			this.#deferred = at ?? { page: 1, scale: "auto" };
			return;
		}
		this.#deferred = null;
		const viewer = this.#viewer;
		viewer.currentScaleValue = at?.scale ?? "auto";
		if (this.#pendingPage) {
			viewer.currentPageNumber = Math.min(this.#pendingPage, viewer.pagesCount);
			this.#pendingPage = null;
		} else if (at && at.top === undefined) {
			// After a page change the same page number, or the last page.
			viewer.currentPageNumber = Math.min(at.page, viewer.pagesCount);
		} else if (at && at.page <= viewer.pagesCount) {
			viewer.scrollPageIntoView({ pageNumber: at.page, destArray: [null, { name: "XYZ" }, at.left ?? null, at.top, null], allowNegativeOffset: true });
		}
		if (this.#tool !== "select") void this.setTool(this.#tool);
	}

	#ensureViewer() {
		if (this.#viewer) return;
		const web = this.#web;
		const lib = this.#lib;
		const eventBus = (this.#eventBus = new web.EventBus());
		const linkService = (this.#linkService = new web.PDFLinkService({ eventBus, externalLinkTarget: web.LinkTarget.BLANK }));
		const findController = new web.PDFFindController({ eventBus, linkService });
		this.#viewer = new web.PDFViewer({
			container: this.#containerEl,
			viewer: this.#viewerEl,
			eventBus,
			linkService,
			findController,
			l10n: new web.GenericL10n(),
			textLayerMode: 1,
			annotationMode: lib.AnnotationMode.ENABLE_FORMS,
			annotationEditorMode: lib.AnnotationEditorType.NONE,
			annotationEditorHighlightColors: HIGHLIGHT_COLORS,
			enableHighlightFloatingButton: true,
			imageResourcesPath: new URL("lib/pdfjs/web/images/", document.baseURI).href,
			maxCanvasPixels: 2 ** 25,
		});
		linkService.setViewer(this.#viewer);
		eventBus._on("pagechanging", ({ pageNumber }: { pageNumber: number }) => this.#onPageChanging(pageNumber));
		eventBus._on("scalechanging", ({ presetValue, scale }: { presetValue?: string; scale: number }) => this.#onScaleChanging(presetValue, scale));
		eventBus._on("updateviewarea", ({ location }: { location: any }) => this.#storePosition(location));
		eventBus._on("updatefindmatchescount", ({ matchesCount }: any) => this.#showMatches(matchesCount));
		eventBus._on("updatefindcontrolstate", ({ state, matchesCount }: any) => this.#showMatches(matchesCount, state));
		eventBus._on("annotationeditormodechanged", ({ mode }: { mode: number }) => this.#onModeChanged(mode));
		eventBus._on("annotationeditoruimanager", ({ uiManager }: { uiManager: any }) => (this.#uiManager = uiManager));
		eventBus._on("editingstateschanged", ({ details }: { details: { hasSomethingToUndo?: boolean; hasSomethingToRedo?: boolean } }) => {
			if (details.hasSomethingToUndo !== undefined) this.#canUndo = details.hasSomethingToUndo;
			if (details.hasSomethingToRedo !== undefined) this.#canRedo = details.hasSomethingToRedo;
		});
	}

	async #close() {
		const doc = this.#doc;
		const task = this.#pdf;
		this.#doc = null;
		this.#pdf = null;
		this.#uiManager = null;
		this.#canUndo = this.#canRedo = false;
		this.#thumbObserver?.disconnect();
		this.#thumbsEl.empty();
		this.#outlineEl.empty();
		if (this.#viewer) {
			this.#viewer.setDocument(null);
			this.#linkService.setDocument(null);
		}
		if (doc) await doc.destroy().catch(() => {});
		else if (task) await task.destroy().catch(() => {});
	}

	#askPassword(update: (password: string) => void, reason: number) {
		const wrong = reason === this.#lib?.PasswordResponses?.INCORRECT_PASSWORD;
		// Cancelling ends the load (its promise rejects), so nothing waits on it.
		new PasswordModal(this.app, wrong, (password) => {
			if (password !== null) return update(password);
			this.#showMessage("The PDF needs a password.");
			void this.#pdf?.destroy();
		}).open();
	}

	#showMessage(text: string) {
		this.#messageEl.setText(text);
		this.#messageEl.show();
	}

	// --- Toolbar, find, keys ------------------------------------------------

	#onPageChanging(page: number) {
		if (document.activeElement !== this.#pageInput) this.#pageInput.value = String(page);
		for (const el of this.#thumbsEl.findAll(".pdf-thumb")) el.toggleClass("is-current", Number(el.dataset.index) === page - 1);
		this.#thumbsEl.find(".pdf-thumb.is-current")?.scrollIntoView({ block: "nearest" });
	}

	#onScaleChanging(preset: string | undefined, scale: number) {
		const known = ZOOMS.find(([value]) => value === preset || value === String(scale));
		const custom = this.#zoomSelect.find('option[value="custom"]') as HTMLOptionElement;
		if (known) {
			custom.hidden = true;
			this.#zoomSelect.value = known[0];
		} else {
			custom.text = `${Math.round(scale * 100)}%`;
			custom.hidden = false;
			this.#zoomSelect.value = "custom";
		}
	}

	#goToPageInput() {
		const page = Number.parseInt(this.#pageInput.value, 10);
		const viewer = this.#viewer;
		if (!viewer?.pagesCount) return;
		if (page >= 1 && page <= viewer.pagesCount) viewer.currentPageNumber = page;
		else this.#pageInput.value = String(viewer.currentPageNumber);
	}

	#find(type: "" | "again", previous = false) {
		if (!this.#eventBus) return;
		this.#eventBus.dispatch("find", {
			source: this,
			type,
			query: this.#findInput.value,
			caseSensitive: this.#findCase,
			entireWord: this.#findWord,
			highlightAll: true,
			findPrevious: previous,
			matchDiacritics: false,
		});
	}

	#closeFind() {
		this.#findEl.hide();
		this.#eventBus?.dispatch("findbarclose", { source: this });
		this.#containerEl.focus();
	}

	#showMatches(count: { current: number; total: number } | undefined, state?: number) {
		const notFound = state === this.#web?.FindState?.NOT_FOUND;
		this.#findInput.toggleClass("is-not-found", notFound && !!this.#findInput.value);
		if (!this.#findInput.value) this.#findCount.setText("");
		else if (notFound) this.#findCount.setText("No matches");
		else if (count?.total) this.#findCount.setText(`${count.current} / ${count.total}`);
	}

	// Mod+wheel and trackpad pinches zoom about the pointer.
	#onWheel(evt: WheelEvent) {
		if (!this.#viewer || !(evt.ctrlKey || evt.metaKey)) return;
		evt.preventDefault();
		const factor = Math.exp(-evt.deltaY / 200);
		this.#viewer.updateScale({ scaleFactor: factor, drawingDelay: 200, origin: [evt.clientX, evt.clientY] });
	}

	#onKey(evt: KeyboardEvent) {
		const mod = Keymap.isModifier(evt, "Mod");
		if (mod && !evt.altKey && !evt.shiftKey && evt.key.toLowerCase() === "s") {
			evt.preventDefault();
			void this.save();
			return;
		}
		if (mod && !evt.altKey && (evt.key === "=" || evt.key === "+" || evt.key === "-" || evt.key === "0")) {
			if (!this.#viewer) return;
			evt.preventDefault();
			if (evt.key === "-") this.#viewer.decreaseScale();
			else if (evt.key === "0") this.#viewer.currentScaleValue = "auto";
			else this.#viewer.increaseScale();
			return;
		}
		const target = evt.target as HTMLElement;
		const typing = !!target.closest("input, select, textarea, [contenteditable]");
		// Mod+Z undoes annotation edits (pdf.js handles it itself while a tool
		// is on), then page changes; Mod+Shift+Z redoes annotation edits.
		if (mod && !evt.altKey && evt.key.toLowerCase() === "z" && !typing && this.#viewer) {
			const ui = this.#uiManager;
			if (evt.shiftKey) {
				if (this.#tool === "select" && this.#canRedo) {
					evt.preventDefault();
					ui.redo();
				}
			} else if (this.#canUndo) {
				if (this.#tool === "select") {
					evt.preventDefault();
					ui.undo();
				}
			} else if (this.#undo.length) {
				evt.preventDefault();
				void this.undoPageChange();
			}
			return;
		}
		if (typing || mod || evt.altKey) return;
		if (evt.key === "Escape" && this.#tool !== "select") {
			void this.setTool("select");
			return;
		}
		// Pages turn with the arrow keys sideways and Home/End, unless an
		// annotation is selected (the arrows move it).
		const viewer = this.#viewer;
		if (viewer?.pagesCount && !this.#uiManager?.hasSelection && target.closest(".pdf-container")) {
			const go = { ArrowLeft: viewer.currentPageNumber - 1, ArrowRight: viewer.currentPageNumber + 1, Home: 1, End: viewer.pagesCount }[evt.key];
			if (go !== undefined) {
				evt.preventDefault();
				viewer.currentPageNumber = Math.max(1, Math.min(viewer.pagesCount, go));
				return;
			}
		}
		if (target.closest(".pdf-thumbs") && this.#selected.size) {
			if (evt.key === "Delete" || evt.key === "Backspace") {
				evt.preventDefault();
				void this.#delete(this.#selectedPages());
			}
		}
	}

	// --- Annotation tools -----------------------------------------------------

	#toolSettings(): Record<string, { color?: string; size?: number }> {
		const stored = this.app.loadLocalStorage(TOOL_SETTINGS);
		return stored && typeof stored === "object" ? stored : {};
	}

	#setting(tool: "highlight" | "text" | "draw") {
		const saved = this.#toolSettings()[tool] ?? {};
		return { color: saved.color ?? COLORS[tool][0], size: saved.size ?? SIZES[tool][tool === "highlight" ? 1 : 1] };
	}

	#renderParams() {
		this.#paramsEl.empty();
		const tool = this.#tool;
		if (tool !== "highlight" && tool !== "text" && tool !== "draw") return;
		const current = this.#setting(tool);
		for (const color of COLORS[tool]) {
			const swatch = this.#paramsEl.createDiv({ cls: "pdf-swatch", attr: { "aria-label": color } });
			swatch.style.background = color;
			swatch.toggleClass("is-active", color.toLowerCase() === current.color.toLowerCase());
			swatch.addEventListener("click", () => this.#saveSetting(tool, { color }));
		}
		const size = this.#paramsEl.createEl("select", { cls: "dropdown pdf-size-select" });
		setTooltip(size, tool === "text" ? "Font size" : "Thickness");
		for (const value of SIZES[tool]) size.createEl("option", { value: String(value), text: tool === "text" ? `${value} pt` : `${value} px` });
		size.value = String(current.size);
		size.addEventListener("change", () => this.#saveSetting(tool, { size: Number(size.value) }));
	}

	#saveSetting(tool: "highlight" | "text" | "draw", change: { color?: string; size?: number }) {
		const all = this.#toolSettings();
		all[tool] = { ...this.#setting(tool), ...change };
		this.app.saveLocalStorage(TOOL_SETTINGS, all);
		this.#renderParams();
		this.#applyParams();
	}

	// The chosen colour and size go to the tool, and to the selected
	// annotations of that kind.
	#applyParams() {
		const P = this.#lib?.AnnotationEditorParamsType;
		const tool = this.#tool;
		if (!P || !this.#eventBus || (tool !== "highlight" && tool !== "text" && tool !== "draw")) return;
		const { color, size } = this.#setting(tool);
		const send = (type: number, value: unknown) => this.#eventBus.dispatch("switchannotationeditorparams", { source: this, type, value });
		if (tool === "highlight") {
			send(P.HIGHLIGHT_COLOR, color);
			send(P.HIGHLIGHT_THICKNESS, size);
		} else if (tool === "text") {
			send(P.FREETEXT_COLOR, color);
			send(P.FREETEXT_SIZE, size);
		} else {
			send(P.INK_COLOR, color);
			send(P.INK_THICKNESS, size);
		}
	}

	#onModeChanged(mode: number) {
		const types = this.#lib?.AnnotationEditorType;
		if (!types) return;
		const tool = ({ [types.NONE]: "select", [types.HIGHLIGHT]: "highlight", [types.FREETEXT]: "text", [types.INK]: "draw", [types.STAMP]: "image" } as Record<number, Tool>)[mode];
		// The note tool runs over NONE: pdf.js reporting NONE leaves it on.
		if (!tool || tool === this.#tool || (tool === "select" && this.#tool === "note")) return;
		this.#tool = tool;
		for (const [t, el] of this.#toolButtons) el.toggleClass("is-active", t === tool);
		this.contentEl.toggleClass("is-note-tool", false);
		this.#renderParams();
	}

	#applyDarkPages() {
		this.contentEl.toggleClass("is-dark-pages", this.app.loadLocalStorage(DARK_PAGES) === true);
	}

	// --- Sidebar ------------------------------------------------------------

	#toggleSidebar() {
		const shown = !this.#sidebarEl.isShown();
		this.#sidebarEl.toggle(shown);
		this.app.saveLocalStorage(SIDEBAR, shown);
		this.onResize();
	}

	#renderThumbs(doc: any) {
		this.#thumbsEl.empty();
		this.#thumbObserver?.disconnect();
		const pending = new Map<Element, number>();
		this.#thumbObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const index = pending.get(entry.target);
					if (index === undefined) continue;
					pending.delete(entry.target);
					this.#thumbObserver?.unobserve(entry.target);
					void this.#drawThumb(doc, index, entry.target as HTMLElement);
				}
			},
			{ root: this.#thumbsEl, rootMargin: "300px 0px" },
		);
		for (let i = 0; i < doc.numPages; i++) {
			const el = this.#thumbsEl.createDiv({ cls: "pdf-thumb", attr: { draggable: "true", "data-index": String(i) } });
			const frame = el.createDiv("pdf-thumb-frame");
			frame.createEl("canvas");
			el.createDiv({ cls: "pdf-thumb-label", text: String(i + 1) });
			el.toggleClass("is-selected", this.#selected.has(i));
			el.addEventListener("click", (evt) => this.#onThumbClick(evt, i));
			el.addEventListener("contextmenu", (evt) => this.#onThumbMenu(evt, i));
			el.addEventListener("dragstart", (evt) => this.#onThumbDragStart(evt, i));
			el.addEventListener("dragover", (evt) => this.#onThumbDragOver(evt, el));
			el.addEventListener("dragleave", () => el.removeClass("is-drop-before", "is-drop-after"));
			el.addEventListener("drop", (evt) => void this.#onThumbDrop(evt, el, i));
			pending.set(el, i);
			this.#thumbObserver.observe(el);
		}
		this.#onPageChanging(this.#viewer?.currentPageNumber || 1);
	}

	async #drawThumb(doc: any, index: number, el: HTMLElement) {
		try {
			const page = await doc.getPage(index + 1);
			if (doc !== this.#doc) return;
			const base = page.getViewport({ scale: 1 });
			const scale = 140 / base.width;
			const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
			const canvas = el.find("canvas") as HTMLCanvasElement;
			canvas.width = Math.ceil(viewport.width);
			canvas.height = Math.ceil(viewport.height);
			canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
			await page.render({ canvasContext: canvas.getContext("2d"), viewport, annotationMode: this.#lib.AnnotationMode.ENABLE }).promise;
		} catch (err) {
			if ((err as Error)?.name !== "RenderingCancelledException") console.error(err);
		}
	}

	#onThumbClick(evt: MouseEvent, index: number) {
		if (evt.shiftKey && this.#anchor >= 0) {
			const [a, b] = [Math.min(this.#anchor, index), Math.max(this.#anchor, index)];
			this.#selected = new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k));
		} else if (Keymap.isModifier(evt, "Mod")) {
			if (!this.#selected.delete(index)) this.#selected.add(index);
			this.#anchor = index;
		} else {
			this.#selected = new Set([index]);
			this.#anchor = index;
			this.#viewer.currentPageNumber = index + 1;
		}
		this.#markSelected();
	}

	#markSelected() {
		for (const el of this.#thumbsEl.findAll(".pdf-thumb")) el.toggleClass("is-selected", this.#selected.has(Number(el.dataset.index)));
	}

	// The pages an action from a thumbnail means: the selection, when the
	// thumbnail is in it, else that page alone.
	#pagesFor(index: number) {
		if (!this.#selected.has(index)) {
			this.#selected = new Set([index]);
			this.#anchor = index;
			this.#markSelected();
		}
		return this.#selectedPages();
	}

	#selectedPages() {
		return [...this.#selected].sort((a, b) => a - b);
	}

	#allPages() {
		return Array.from({ length: this.#pageCountNow() }, (_, i) => i);
	}

	#pageCountNow() {
		return this.#doc?.numPages ?? 0;
	}

	#onThumbMenu(evt: MouseEvent, index: number) {
		evt.preventDefault();
		const pages = this.#pagesFor(index);
		const what = pages.length > 1 ? `${pages.length} pages` : "page";
		const menu = new Menu();
		menu.addSections(["turn", "add", "file", "danger"]);
		menu.addItem((i) => i.setTitle(`Rotate ${what} clockwise`).setIcon("rotate-cw").setSection("turn").onClick(() => void this.#rotate(pages, 90)));
		menu.addItem((i) => i.setTitle(`Rotate ${what} counterclockwise`).setIcon("rotate-ccw").setSection("turn").onClick(() => void this.#rotate(pages, -90)));
		menu.addItem((i) => i.setTitle(`Duplicate ${what}`).setIcon("copy").setSection("add").onClick(() => void this.#change((b) => duplicatePages(b, pages), "Duplicated")));
		menu.addItem((i) => i.setTitle("Insert blank page before").setIcon("file-plus-2").setSection("add").onClick(() => void this.#change((b) => insertBlankPage(b, pages[0]), "Inserted a blank page")));
		menu.addItem((i) => i.setTitle("Insert blank page after").setIcon("file-plus-2").setSection("add").onClick(() => void this.#change((b) => insertBlankPage(b, pages[pages.length - 1] + 1), "Inserted a blank page")));
		menu.addItem((i) => i.setTitle("Insert pages from a PDF after...").setIcon("file-plus").setSection("add").onClick(() => this.#pickPdf(pages[pages.length - 1] + 1)));
		menu.addItem((i) => i.setTitle(`Extract ${what} to a new PDF`).setIcon("file-output").setSection("file").onClick(() => void this.#extract(pages)));
		menu.addItem((i) =>
			i
				.setTitle(`Delete ${what}`)
				.setIcon("trash-2")
				.setWarning(true)
				.setSection("danger")
				.onClick(() => void this.#delete(pages)),
		);
		menu.showAtMouseEvent(evt);
	}

	#onThumbDragStart(evt: DragEvent, index: number) {
		const pages = this.#pagesFor(index);
		evt.dataTransfer?.setData("application/x-justnotes-pdf-pages", JSON.stringify({ file: this.file?.path, pages }));
		if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
	}

	#dropSide(evt: DragEvent, el: HTMLElement) {
		const rect = el.getBoundingClientRect();
		return evt.clientY < rect.top + rect.height / 2 ? "before" : "after";
	}

	#onThumbDragOver(evt: DragEvent, el: HTMLElement) {
		const types = evt.dataTransfer?.types ?? [];
		if (!types.includes("application/x-justnotes-pdf-pages") && !types.includes("Files")) return;
		evt.preventDefault();
		const side = this.#dropSide(evt, el);
		el.toggleClass("is-drop-before", side === "before");
		el.toggleClass("is-drop-after", side === "after");
	}

	// Thumbnails dropped between pages move there; PDF files dropped from
	// outside (Finder, the file explorer) go in there.
	async #onThumbDrop(evt: DragEvent, el: HTMLElement, index: number) {
		evt.preventDefault();
		el.removeClass("is-drop-before", "is-drop-after");
		const target = this.#dropSide(evt, el) === "before" ? index : index + 1;
		const moved = evt.dataTransfer?.getData("application/x-justnotes-pdf-pages");
		if (moved) {
			const { file: from, pages } = JSON.parse(moved) as { file?: string; pages: number[] };
			// Thumbnails from another PDF's view: copies of those pages go in here.
			if (from && from !== this.file?.path) {
				const source = this.app.vault.getFileByPath(from);
				if (!source) return;
				const other = new Uint8Array(await this.app.vault.readBinary(source));
				await this.#change((b) => insertPdf(b, other, target, pages), `Inserted ${pages.length > 1 ? `${pages.length} pages` : "a page"} of ${source.name}`);
				return;
			}
			const order = movedOrder(this.#pageCountNow(), pages, target);
			if (order.every((v, i) => v === i)) return;
			await this.#change((b) => reorderPages(b, order), "Moved");
			const first = order.indexOf(pages[0]);
			this.#selected = new Set(pages.map((_, k) => first + k));
			this.#markSelected();
			return;
		}
		// Several files keep their order: each goes in at the same place, last first.
		const files = Array.from(evt.dataTransfer?.files ?? []).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
		const { webUtils } = getElectron();
		for (const f of files.reverse()) {
			const fsPath: string | undefined = webUtils?.getPathForFile?.(f) ?? (f as any).path;
			if (!fsPath) continue;
			const other = new Uint8Array(fs.readFileSync(fsPath));
			await this.#change((b) => insertPdf(b, other, target), `Inserted ${nodePath.basename(fsPath)}`);
		}
	}

	async #renderOutline(doc: any) {
		this.#outlineEl.empty();
		let outline: any[] | null = null;
		try {
			outline = await doc.getOutline();
		} catch (err) {
			console.error(err);
		}
		if (doc !== this.#doc) return;
		if (!outline?.length) {
			this.#outlineEl.createDiv({ cls: "pdf-outline-empty", text: "This PDF has no outline." });
			return;
		}
		const add = (items: any[], parent: HTMLElement, depth: number) => {
			for (const item of items) {
				const row = parent.createDiv("pdf-outline-item");
				const self = row.createDiv({ cls: "pdf-outline-title tree-item-self is-clickable" });
				self.style.paddingInlineStart = `${0.5 + depth}em`;
				const children = item.items?.length ? row.createDiv("pdf-outline-children") : null;
				const toggle = self.createDiv("pdf-outline-toggle");
				if (children) {
					setIcon(toggle, "chevron-down");
					toggle.addEventListener("click", (evt) => {
						evt.stopPropagation();
						const collapsed = children.isShown();
						children.toggle(!collapsed);
						setIcon(toggle, collapsed ? "chevron-right" : "chevron-down");
					});
				}
				const text = self.createSpan({ text: item.title || "Untitled" });
				if (item.bold) text.style.fontWeight = "bold";
				if (item.italic) text.style.fontStyle = "italic";
				self.addEventListener("click", () => {
					if (item.dest) void this.#linkService.goToDestination(item.dest);
					else if (item.url) void getElectron().shell.openExternal(item.url);
				});
				if (children) add(item.items, children, depth + 1);
			}
		};
		add(outline, this.#outlineEl, 0);
	}

	// --- Page changes ---------------------------------------------------------

	// The file's bytes as they stand, with annotations not yet written.
	async #currentBytes(): Promise<Uint8Array> {
		const doc = this.#doc;
		if (!doc) throw new Error("No PDF is open");
		if (doc.annotationStorage.size > 0) return doc.saveDocument();
		return doc.getData();
	}

	// One page change: pending annotations first, then `op` on the bytes,
	// written in place and shown at the same page; the bytes before go on
	// the undo stack.
	async #change(op: (bytes: Uint8Array) => Promise<Uint8Array>, done: string) {
		const file = this.file;
		if (!file || !this.#doc) return;
		while (this.#busy) await this.#busy.catch(() => {});
		this.#autosave.cancel();
		const run = (async () => {
			const before = await this.#currentBytes();
			const after = await op(before.slice());
			this.#undo.push(before);
			if (this.#undo.length > UNDO_LIMIT) this.#undo.shift();
			this.#undoButton.show();
			await this.#replace(file, after, true);
		})();
		this.#busy = run;
		try {
			await run;
			new Notice(done);
		} catch (err) {
			new Notice(`Could not change ${file.name}: ${err instanceof Error ? err.message : err}`);
		} finally {
			this.#busy = null;
		}
	}

	async #replace(file: TFile, bytes: Uint8Array, keepSelection: boolean) {
		const page = this.#viewer?.currentPageNumber ?? 1;
		const scale = String(this.#viewer?.currentScaleValue ?? "auto");
		await this.#write(file, bytes);
		if (!keepSelection) this.#selected.clear();
		await this.#open(file, bytes, { page, scale });
		const count = this.#pageCountNow();
		this.#selected = new Set([...this.#selected].filter((i) => i < count));
		this.#markSelected();
	}

	// Never to a file the vault no longer has: a deleted PDF must not come
	// back from a pending save.
	async #write(file: TFile, bytes: Uint8Array) {
		if (this.app.vault.getAbstractFileByPath(file.path) !== file) throw new Error(`${file.path} is no longer in the vault`);
		await this.app.vault.modifyBinary(file, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
		this.#mtime = (await this.app.vault.adapter.stat(file.path))?.mtime ?? file.stat.mtime;
	}

	#rotate(pages: number[], delta: number) {
		return this.#change((b) => rotatePages(b, pages, delta), delta > 0 ? "Rotated clockwise" : "Rotated counterclockwise");
	}

	async #delete(pages: number[]) {
		if (!pages.length) return;
		this.#selected.clear();
		await this.#change((b) => deletePages(b, pages), pages.length > 1 ? `Deleted ${pages.length} pages` : `Deleted page ${pages[0] + 1}`);
	}

	async #extract(pages: number[]) {
		const file = this.file;
		if (!file || !this.#doc) return;
		try {
			const bytes = await extractPages(await this.#currentBytes(), pages);
			const span = pages.length === 1 ? `p${pages[0] + 1}` : contiguous(pages) ? `p${pages[0] + 1}-${pages[pages.length - 1] + 1}` : `${pages.length} pages`;
			const dir = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
			let path = `${dir}${file.basename} (${span}).pdf`;
			for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = `${dir}${file.basename} (${span}) ${n}.pdf`;
			const created = await this.app.vault.createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
			await this.app.workspace.getLeaf("tab").openFile(created);
		} catch (err) {
			new Notice(`Could not extract pages: ${err instanceof Error ? err.message : err}`);
		}
	}

	#pickPdf(at: number) {
		const file = this.file;
		new PdfPicker(this.app, file, async (other) => {
			const bytes = new Uint8Array(await this.app.vault.readBinary(other));
			await this.#change((b) => insertPdf(b, bytes, at), `Inserted ${other.name}`);
		}).open();
	}

	async #editInfo() {
		const file = this.file;
		if (!file || !this.#doc) return;
		let info: PdfInfo;
		try {
			info = await readInfo(await this.#currentBytes());
		} catch (err) {
			new Notice(`Could not read the document info: ${err instanceof Error ? err.message : err}`);
			return;
		}
		new PdfInfoModal(this.app, info, (changes) => this.#change((b) => writeInfo(b, changes), "Saved the document info")).open();
	}

	// --- Positions, outside changes --------------------------------------------

	#positions(): Record<string, Position> {
		const stored = this.app.loadLocalStorage(POSITIONS);
		return stored && typeof stored === "object" ? stored : {};
	}

	#rememberPosition(location: any) {
		const file = this.file;
		if (!file || !location || !this.#viewer) return;
		const positions = this.#positions();
		positions[file.path] = { page: location.pageNumber, scale: String(this.#viewer.currentScaleValue), left: location.left, top: location.top };
		this.app.saveLocalStorage(POSITIONS, positions);
	}

	// A PDF rewritten elsewhere (a TeX build, a sync) reloads at the same
	// place, unless annotations are waiting to be saved: those stay and the
	// next save writes over the outside change.
	async #onModify(file: TAbstractFile) {
		if (file !== this.file || this.#busy || !(file instanceof TFile) || file.stat.mtime === this.#mtime) return;
		if (this.#dirty) {
			new Notice(`${file.path} changed on disk. Your unsaved annotations are kept and will replace it when saved.`);
			this.#mtime = file.stat.mtime;
			return;
		}
		const page = this.#viewer?.currentPageNumber ?? 1;
		const scale = String(this.#viewer?.currentScaleValue ?? "auto");
		this.#undo = [];
		this.#undoButton.hide();
		await this.#open(file, await this.app.vault.readBinary(file), { page, scale });
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif" };

const KINDS: Record<string, string> = { Text: "Note", Highlight: "Highlight", FreeText: "Text", Ink: "Drawing", Stamp: "Image", Underline: "Underline", StrikeOut: "Strikeout", Squiggly: "Squiggly", Square: "Box", Circle: "Circle", Line: "Line", Polygon: "Polygon", PolyLine: "Polyline", FileAttachment: "Attachment", Caret: "Caret" };

class VaultImagePicker extends FuzzySuggestModal<TFile> {
	#onChoose: (file: TFile) => void;

	constructor(app: App, onChoose: (file: TFile) => void) {
		super(app);
		this.#onChoose = onChoose;
		this.setPlaceholder("Put an image from the vault on the page...");
	}

	getItems() {
		return this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() in IMAGE_TYPES);
	}

	getItemText(file: TFile) {
		return file.path;
	}

	onChooseItem(file: TFile) {
		this.#onChoose(file);
	}
}

class NoteModal extends Modal {
	#title: string;
	#value: string;
	#onSave: (text: string) => unknown;
	#allowEmpty: boolean;

	// A comment may be emptied (removed); a note needs its text.
	constructor(app: App, title: string, value: string, onSave: (text: string) => unknown, allowEmpty = false) {
		super(app);
		this.#title = title;
		this.#value = value;
		this.#onSave = onSave;
		this.#allowEmpty = allowEmpty;
	}

	onOpen() {
		this.titleEl.setText(this.#title);
		const area = this.contentEl.createEl("textarea", { cls: "pdf-note-input", attr: { rows: "5" } });
		area.value = this.#value;
		const submit = () => {
			const text = area.value.trim();
			this.close();
			if ((text || this.#allowEmpty) && text !== this.#value) this.#onSave(text);
		};
		// Mod+Enter saves; Enter alone is a new line.
		area.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" && (evt.metaKey || evt.ctrlKey)) {
				evt.preventDefault();
				submit();
			}
		});
		const buttons = this.contentEl.createDiv("modal-button-container");
		buttons.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", submit);
		setTimeout(() => area.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}

const contiguous = (pages: number[]) => pages.every((p, i) => i === 0 || p === pages[i - 1] + 1);

class PdfPicker extends FuzzySuggestModal<TFile> {
	#exclude: TFile | null;
	#onChoose: (file: TFile) => void;

	constructor(app: App, exclude: TFile | null, onChoose: (file: TFile) => void) {
		super(app);
		this.#exclude = exclude;
		this.#onChoose = onChoose;
		this.setPlaceholder("Insert the pages of a PDF...");
	}

	getItems() {
		return this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === "pdf" && f !== this.#exclude);
	}

	getItemText(file: TFile) {
		return file.path;
	}

	onChooseItem(file: TFile) {
		this.#onChoose(file);
	}
}

const INFO_LABELS: Record<keyof PdfInfo, string> = { title: "Title", author: "Author", subject: "Subject", keywords: "Keywords" };

class PdfInfoModal extends Modal {
	#values: PdfInfo;
	#onSave: (info: PdfInfo) => Promise<void>;

	constructor(app: App, values: PdfInfo, onSave: (info: PdfInfo) => Promise<void>) {
		super(app);
		this.#values = { ...values };
		this.#onSave = onSave;
	}

	onOpen() {
		this.titleEl.setText("Document info");
		for (const field of INFO_FIELDS) {
			new Setting(this.contentEl)
				.setName(INFO_LABELS[field])
				.setDesc(field === "keywords" ? "Separated by commas" : "")
				.addText((t) => t.setValue(this.#values[field]).onChange((v) => (this.#values[field] = v)));
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

class PasswordModal extends Modal {
	#wrong: boolean;
	#done: (password: string | null) => void;
	#answered = false;

	constructor(app: App, wrong: boolean, done: (password: string | null) => void) {
		super(app);
		this.#wrong = wrong;
		this.#done = done;
	}

	onOpen() {
		this.titleEl.setText(this.#wrong ? "Wrong password, try again" : "This PDF is protected");
		let value = "";
		const submit = () => {
			this.#answered = true;
			this.close();
			this.#done(value);
		};
		new Setting(this.contentEl).setName("Password").addText((t) => {
			t.inputEl.type = "password";
			t.onChange((v) => (value = v));
			t.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") submit();
			});
			setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(this.contentEl).addButton((b) => b.setButtonText("Open").setCta().onClick(submit));
	}

	onClose() {
		this.contentEl.empty();
		if (!this.#answered) this.#done(null);
	}
}

export function registerPdfView(app: App) {
	app.viewRegistry.registerViewWithExtensions(["pdf"], PDF_VIEW, (leaf) => new PdfView(leaf));
}
