import type { App } from "../api/app";
import { AppResizeObserver } from "../api/dom";
import { Component } from "../api/events";
import { setIcon } from "../api/icons";
import { Scope } from "../api/keymap";
import { MarkdownRenderer, renderMarkdownSections } from "../api/markdown";
import type { CorePluginHost } from "../api/internal-plugins";
import { MarkdownView } from "../api/markdown-view";
import { locateFrontMatter } from "../api/metadata-utils";
import type { Menu } from "../api/ui/menu";
import type { TAbstractFile, TFile } from "../api/vault";
import type { WorkspaceLeaf } from "../api/workspace";

// The logical slide, as reveal.js (which Obsidian's Slides uses) sizes it:
// 960 by 700, scaled as a whole to the window with a 4% margin.
const SLIDE_WIDTH = 960;
const SLIDE_HEIGHT = 700;
const MARGIN = 0.04;
// Content taller or wider than its slide shrinks to fit, down to this scale;
// below it the slide scrolls instead of turning unreadable.
const MIN_CONTENT_SCALE = 0.5;

// A note's slides: the Markdown between its top-level `---` rules. The
// frontmatter is no slide, and a `---` under a paragraph (a setext heading),
// in a code block, in math or in a list or quote divides nothing. Empty
// slides are dropped; a note with no text is one empty slide.
export function slideSources(markdown: string): string[] {
	const lines = markdown.split(/\r?\n/);
	const fm = locateFrontMatter(markdown);
	// Blank the frontmatter instead of cutting it, so its lines keep their
	// numbers and the parser cannot take a rule after it for frontmatter.
	if (fm) {
		const fmLines = markdown.slice(0, fm.end).split(/\r?\n/).length;
		for (let i = 0; i < fmLines; i++) lines[i] = "";
	}
	const breaks = renderMarkdownSections(lines.join("\n"))
		.sections.filter((s) => s.lineStart === s.lineEnd && s.html.startsWith("<hr") && /^ {0,3}-[ \t]*-[ \t]*-[ \t-]*$/.test(lines[s.lineStart]))
		.map((s) => s.lineStart);
	const slides: string[] = [];
	let start = 0;
	for (const line of [...breaks, lines.length]) {
		const text = lines.slice(start, line).join("\n").trim();
		if (text) slides.push(text);
		start = line + 1;
	}
	return slides.length ? slides : [""];
}

// The scale that fits content of a natural size into a box, never above 1;
// past the minimum the content keeps the minimum and scrolls.
export function contentScale(width: number, height: number, boxWidth: number, boxHeight: number) {
	const scale = Math.min(1, boxWidth / Math.max(width, 1), boxHeight / Math.max(height, 1));
	return { scale: Math.max(scale, MIN_CONTENT_SCALE), scrolls: scale < MIN_CONTENT_SCALE };
}

// The scale of the whole slide in a window of this size, as reveal.js
// computes it (minScale 0.2, maxScale 2).
export function viewportScale(width: number, height: number) {
	const scale = Math.min(width / (SLIDE_WIDTH * (1 + 2 * MARGIN)), height / (SLIDE_HEIGHT * (1 + 2 * MARGIN)));
	return Math.min(2, Math.max(0.2, scale));
}

let current: Presentation | null = null;

// A full-window presentation of a note, in reveal.js's markup (the class
// names Obsidian's slides carry and theme snippets style): `.slides-container`
// > `.reveal` > `.slides` > one `section.slide` per slide, `aside.controls`
// with `.navigate-left`/`.navigate-right`, `.slide-number` and `.progress`.
// Every slide renders at once with the app's MarkdownRenderer, so math,
// embeds and plugin code blocks are in place before the slide shows.
export class Presentation {
	app: App;
	file: TFile;
	// The note's leaf, focused again on close when nothing else had focus.
	leaf: WorkspaceLeaf | null;
	index = 0;
	containerEl: HTMLElement;
	slidesEl: HTMLElement;
	sections: HTMLElement[] = [];
	#scope = new Scope();
	#component = new Component();
	#resize: AppResizeObserver;
	#restoreFocus: Element | null = null;
	#prevEl: HTMLElement;
	#nextEl: HTMLElement;
	#numberEl: HTMLElement;
	#progressEl: HTMLElement;
	#onFullscreenChange = () => {
		if (!this.containerEl.doc.fullscreenElement) this.close();
	};
	// The window the presentation shows in; closing it (a popout) closes the
	// presentation, whose parentless scope would otherwise keep app hotkeys off.
	#win: Window | null = null;
	#onWindowGone = () => this.close();

	constructor(app: App, file: TFile, sources: string[], leaf: WorkspaceLeaf | null = null) {
		this.app = app;
		this.file = file;
		this.leaf = leaf;
		const doc = activeDocument;
		this.containerEl = doc.body.createDiv("slides-container");
		const reveal = this.containerEl.createDiv("reveal");
		this.slidesEl = reveal.createDiv("slides");
		for (const source of sources) {
			const section = this.slidesEl.createEl("section", "slide markdown-rendered future");
			const content = section.createDiv("slide-content");
			this.sections.push(section);
			MarkdownRenderer.render(app, source, content, file.path, this.#component).then(() => this.#fit(section));
			// Images and embeds grow the slide after the render settles.
			section.addEventListener("load", () => this.#fit(section), true);
		}
		const controls = reveal.createEl("aside", "controls");
		// A clicked arrow must not keep the focus: Space would press it again.
		controls.addEventListener("mousedown", (evt) => evt.preventDefault());
		this.#prevEl = controls.createEl("button", { cls: "navigate-left", attr: { "aria-label": "Previous slide" } });
		setIcon(this.#prevEl, "chevron-left");
		this.#prevEl.addEventListener("click", () => this.prev());
		this.#nextEl = controls.createEl("button", { cls: "navigate-right", attr: { "aria-label": "Next slide" } });
		setIcon(this.#nextEl, "chevron-right");
		this.#nextEl.addEventListener("click", () => this.next());
		this.#numberEl = reveal.createDiv("slide-number");
		this.#progressEl = reveal.createDiv("progress").createSpan();
		const close = this.containerEl.createDiv({ cls: "slides-close-btn clickable-icon", attr: { "aria-label": "Close" } });
		setIcon(close, "x");
		close.addEventListener("click", () => this.close());

		this.#resize = new AppResizeObserver((entries) => {
			for (const entry of entries) {
				const el = entry.target as HTMLElement;
				if (el === this.containerEl) this.#layout();
				else if (el.parentElement) this.#fit(el.parentElement);
			}
		});
		this.#resize.observe(this.containerEl);
		for (const section of this.sections) this.#resize.observe(section.firstElementChild as HTMLElement);

		this.#scope.register(null, null, (evt) => this.#onKey(evt));
	}

	open() {
		current?.close();
		current = this;
		const doc = this.containerEl.doc;
		this.#restoreFocus = doc.activeElement;
		(doc.activeElement as HTMLElement | null)?.blur?.();
		this.#win = doc.defaultView;
		this.#win?.addEventListener("pagehide", this.#onWindowGone);
		this.#component.load();
		this.app.keymap.pushScope(this.#scope);
		this.go(0);
		this.#layout();
		// Fullscreen as in Obsidian; where the window refuses (no user
		// gesture) the presentation still covers the whole window.
		this.containerEl
			.requestFullscreen?.()
			.then(() => doc.addEventListener("fullscreenchange", this.#onFullscreenChange))
			.catch(() => {});
	}

	close() {
		if (current !== this) return;
		current = null;
		const doc = this.containerEl.doc;
		this.#win?.removeEventListener("pagehide", this.#onWindowGone);
		this.#win = null;
		doc.removeEventListener("fullscreenchange", this.#onFullscreenChange);
		if (doc.fullscreenElement === this.containerEl) doc.exitFullscreen().catch(() => {});
		this.app.keymap.popScope(this.#scope);
		this.#resize.unobserve(this.containerEl);
		for (const section of this.sections) this.#resize.unobserve(section.firstElementChild as HTMLElement);
		this.#component.unload();
		this.containerEl.detach();
		const focus = this.#restoreFocus;
		if (focus?.instanceOf(HTMLElement) && focus.isConnected && focus !== doc.body) focus.focus();
		else if (this.leaf?.view) this.app.workspace.setActiveLeaf(this.leaf, { focus: true });
	}

	go(index: number) {
		this.index = Math.max(0, Math.min(this.sections.length - 1, index));
		this.sections.forEach((section, i) => {
			section.toggleClass("past", i < this.index);
			section.toggleClass("present", i === this.index);
			section.toggleClass("future", i > this.index);
			if (i === this.index) section.removeAttribute("aria-hidden");
			else section.setAttribute("aria-hidden", "true");
		});
		const last = this.sections.length - 1;
		this.#prevEl.toggleClass("enabled", this.index > 0);
		this.#nextEl.toggleClass("enabled", this.index < last);
		this.#numberEl.setText(`${this.index + 1} / ${this.sections.length}`);
		this.#progressEl.style.width = `${last ? (this.index / last) * 100 : 100}%`;
	}

	next() {
		this.go(this.index + 1);
	}

	prev() {
		this.go(this.index - 1);
	}

	#onKey(evt: KeyboardEvent): false | undefined {
		const mods = evt.altKey || evt.ctrlKey || evt.metaKey;
		if (evt.key === "Escape") this.close();
		else if (mods) return;
		else if (evt.key === " ") evt.shiftKey ? this.prev() : this.next();
		else if (evt.shiftKey) return;
		else if (["ArrowRight", "ArrowDown", "PageDown", "n"].includes(evt.key)) this.next();
		else if (["ArrowLeft", "ArrowUp", "PageUp", "p"].includes(evt.key)) this.prev();
		else if (evt.key === "Home") this.go(0);
		else if (evt.key === "End") this.go(this.sections.length - 1);
		else return;
		return false;
	}

	#layout() {
		const { clientWidth, clientHeight } = this.containerEl;
		this.slidesEl.style.setProperty("--slides-scale", String(viewportScale(clientWidth, clientHeight)));
	}

	// Shrinks a slide's content to the slide. A zoomed box still reports its
	// own unzoomed size, so the zoom never feeds back into the observer.
	#fit(section: HTMLElement) {
		const content = section.firstElementChild as HTMLElement | null;
		if (!content || !this.containerEl.isConnected) return;
		const { scale, scrolls } = contentScale(content.scrollWidth, content.offsetHeight, section.clientWidth, section.clientHeight);
		content.style.setProperty("--slide-content-scale", String(scale));
		section.toggleClass("is-scrollable", scrolls);
	}
}

// The note's text as its open view has it, unsaved edits included.
export async function startPresentation(app: App, file: TFile, leaf?: WorkspaceLeaf) {
	const leaves = [...(leaf ? [leaf] : []), ...app.workspace.getLeavesOfType("markdown")];
	const shown = leaves.find((l) => l.view instanceof MarkdownView && l.view.file === file) ?? null;
	const text = shown ? (shown.view as MarkdownView).getViewData() : await app.vault.cachedRead(file);
	const presentation = new Presentation(app, file, slideSources(text), shown);
	presentation.open();
	return presentation;
}

// Obsidian's Slides: the command (with its id) on the active note, and
// Start presentation in a note's More options and tab menus.
export function installSlides(app: App, host: CorePluginHost) {
	host.addCommand({
		id: "slides:start",
		name: "Slides: Start presentation",
		icon: "presentation",
		checkCallback: (checking: boolean) => {
			const file = app.workspace.getActiveFile();
			if (file?.extension !== "md") return false;
			if (!checking) startPresentation(app, file, app.workspace.activeLeaf ?? undefined);
			return true;
		},
	});
	host.registerEvent(
		app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile, source: string, leaf?: WorkspaceLeaf) => {
			if (source !== "more-options" && source !== "tab-header") return;
			if (!(leaf?.view instanceof MarkdownView) || leaf.view.file !== file) return;
			const note = leaf.view.file;
			menu.addItem((item) =>
				item
					.setTitle("Start presentation")
					.setIcon("presentation")
					.setSection("view")
					.onClick(() => startPresentation(app, note, leaf)),
			);
		}),
	);
}
