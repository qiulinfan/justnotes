import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, Prec, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { App } from "./app";
import { AppResizeObserver } from "./dom";
import type { Component } from "./events";
import { setIcon } from "./icons";
import { finishRenderMath, MarkdownPreviewRenderer, MarkdownRenderChild, MarkdownRenderer, onCodeBlockProcessorsChange, renderMath, resolveHtmlSrc, toggledTask } from "./markdown";
import { editorMetadataHost, MetadataEditor, type MetadataEditorHost, metadataEditorOf } from "./metadata-editor";
import { destinationText, getLinkpath } from "./metadata-utils";
import type { TFile } from "./vault";

export interface LivePreviewHost {
	app: App;
	sourcePath(): string;
	resolveImage(linkpath: string): string | null;
}

const SCHEME = /^[a-z][\w+.-]*:/i;
const IMAGE = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;

function safeDecode(text: string) {
	try {
		return decodeURI(text);
	} catch {
		return text;
	}
}

// Whether the editor is in Live Preview; false in source mode, where all
// syntax shows and nothing renders. The view that owns the editor sets it
// with editorLivePreviewField.init().
export const editorLivePreviewField = StateField.define<boolean>({
	create: () => true,
	update: (v) => v,
});

// livePreviewState: whether the left button is held in the editor. While
// it is (a drag-select), Live Preview keeps its decorations, so syntax does
// not reveal under the pointer; it catches up on release.
const setMousedown = StateEffect.define<boolean>();
const mousedownField = StateField.define<boolean>({
	create: () => false,
	update: (v, tr) => {
		for (const e of tr.effects) if (e.is(setMousedown)) v = e.value;
		return v;
	},
});

// A text drag ends without a mouseup, so drag end and drop also release.
const RELEASE_EVENTS = ["mouseup", "dragend", "drop"];

class LivePreviewState {
	mousedown = false;
	#view: EditorView;
	#release = () => this.press(false);

	constructor(view: EditorView) {
		this.#view = view;
	}

	press(down: boolean) {
		if (down === this.mousedown) return;
		this.mousedown = down;
		this.#listen(down);
		this.#view.dispatch({ effects: setMousedown.of(down) });
	}

	#listen(on: boolean) {
		const win = this.#view.dom.ownerDocument.defaultView ?? window;
		for (const type of RELEASE_EVENTS) {
			if (on) win.addEventListener(type, this.#release, true);
			else win.removeEventListener(type, this.#release, true);
		}
		// The window losing focus also releases. Listening without capture
		// sees only the window's own blur: element blurs do not bubble, and
		// the press itself blurs whatever had focus before the editor.
		if (on) win.addEventListener("blur", this.#release);
		else win.removeEventListener("blur", this.#release);
	}

	destroy() {
		this.#listen(false);
	}
}

export const livePreviewState = ViewPlugin.fromClass(LivePreviewState, {
	eventHandlers: {
		mousedown(evt) {
			if (evt.button === 0) this.press(true);
		},
	},
	provide: () => mousedownField,
});

// The link, URL or tag at a position, for open-link commands and
// Editor.getClickableTokenAt.
export interface ClickableToken {
	type: "internal-link" | "external-link" | "tag";
	text: string;
	from: number;
	to: number;
}

// The address a URL node outside a link opens. GFM links bare www. text and
// email addresses, and an angle-bracket autolink without a scheme is an email
// address; they open as https: and mailto: links, through window.open like any
// other URL, where main's policy decides. Bare www. text is checked before the
// scheme, which "www.example.com:8080" would seem to have. A link reference
// definition's destination is not an autolink and stays as written.
function autolinkHref(node: SyntaxNode, url: string) {
	const parent = node.parent?.name;
	if (parent === "LinkReference") return url;
	if (parent !== "Autolink" && /^www\./i.test(url)) return `https://${url}`;
	return SCHEME.test(url) ? url : `mailto:${url}`;
}

// A Markdown link's or image's destination, as the reading view reads it:
// the URL after the text's closing bracket, not one in the text itself
// ([a@b.co](mailto:a@b.co), [www.x.com](https://x.com)), read by
// destinationText. Null for a reference link, whose destination is elsewhere.
function destination(state: EditorState, node: SyntaxNode) {
	const textEnd = node.getChildren("LinkMark")[1]?.to;
	const url = textEnd === undefined ? undefined : node.getChildren("URL").find((u) => u.from >= textEnd);
	return url ? destinationText(state.sliceDoc(url.from, url.to)) : null;
}

function tokenOf(state: EditorState, n: SyntaxNode): ClickableToken | null {
	const text = (node: SyntaxNode) => state.sliceDoc(node.from, node.to);
	switch (n.name) {
		case "internal-link":
		case "internal-embed": {
			const target = n.getChild("hmd-internal-link");
			return target ? { type: "internal-link", text: text(target).trim(), from: n.from, to: n.to } : null;
		}
		case "Link":
		case "Image": {
			const href = destination(state, n);
			if (href === null) return null;
			return SCHEME.test(href)
				? { type: "external-link", text: href, from: n.from, to: n.to }
				: { type: "internal-link", text: safeDecode(href), from: n.from, to: n.to };
		}
		case "URL": {
			const parent = n.parent?.name;
			if (parent === "Link" || parent === "Image") return null;
			return { type: "external-link", text: autolinkHref(n, text(n)), from: n.from, to: n.to };
		}
		case "hashtag":
			return { type: "tag", text: text(n), from: n.from, to: n.to };
	}
	return null;
}

export function clickableTokenAt(state: EditorState, pos: number): ClickableToken | null {
	const tree = syntaxTree(state);
	for (const side of [-1, 1] as const) {
		for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
			const token = tokenOf(state, n);
			if (token) return token;
		}
	}
	return null;
}

// Moves the cursor into a rendered block so its source shows.
function reveal(view: EditorView, pos: number) {
	view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) }, scrollIntoView: true });
	view.focus();
}

function editButton(view: EditorView, dom: HTMLElement, revealAt: (view: EditorView) => number) {
	const button = dom.createDiv({ cls: "edit-block-button", attr: { "aria-label": "Edit this block" } });
	setIcon(button, "code-2");
	button.addEventListener("mousedown", (evt) => {
		evt.preventDefault();
		evt.stopPropagation();
		reveal(view, revealAt(view));
	});
}

// The start of the line after the widget's first line: inside the block.
function innerStart(view: EditorView, dom: HTMLElement) {
	const pos = view.posAtDOM(dom);
	const line = view.state.doc.lineAt(pos);
	return line.number < view.state.doc.lines ? line.to + 1 : line.to;
}

class MathWidget extends WidgetType {
	constructor(
		readonly tex: string,
		readonly display: boolean,
	) {
		super();
	}

	eq(other: MathWidget) {
		return other.tex === this.tex && other.display === this.display;
	}

	toDOM() {
		const el = createEl(this.display ? "div" : "span", { cls: this.display ? ["math", "math-block", "cm-embed-block"] : ["math", "math-inline"] });
		el.appendChild(renderMath(this.tex, this.display));
		el.addClass("is-loaded");
		queueMicrotask(() => finishRenderMath());
		return el;
	}

	ignoreEvent() {
		return false;
	}
}

class CheckboxWidget extends WidgetType {
	constructor(
		readonly status: string,
		readonly pos: number,
	) {
		super();
	}

	eq(other: CheckboxWidget) {
		return other.status === this.status && other.pos === this.pos;
	}

	toDOM(view: EditorView) {
		const label = createEl("label", "task-list-label");
		const box = label.createEl("input", { type: "checkbox", cls: "task-list-item-checkbox", attr: { "data-task": this.status } });
		box.checked = this.status !== " ";
		label.addEventListener("mousedown", (evt) => {
			evt.preventDefault();
			view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.status === " " ? "x" : " " } });
		});
		return label;
	}

	ignoreEvent() {
		return true;
	}
}

class RuleWidget extends WidgetType {
	eq() {
		return true;
	}

	toDOM() {
		return createEl("hr", "cm-hr");
	}
}

// `![[img.png|300]]` and `![alt|300x200](img.png)`: a trailing number or
// WxH sets the size, anything else is the alt text.
function imageSize(alt: string) {
	const m = /(?:^|\|)\s*(\d+)(?:x(\d+))?\s*$/.exec(alt);
	return m ? { alt: alt.slice(0, m.index), width: m[1], height: m[2] } : { alt, width: undefined, height: undefined };
}

class ImageWidget extends WidgetType {
	constructor(
		readonly src: string,
		readonly target: string,
		readonly alt: string,
	) {
		super();
	}

	eq(other: ImageWidget) {
		return other.src === this.src && other.alt === this.alt;
	}

	toDOM() {
		const { alt, width, height } = imageSize(this.alt);
		const embed = createSpan({ cls: "internal-embed media-embed image-embed is-loaded", attr: { src: this.target, alt: alt || null } });
		embed.createEl("img", { attr: { src: this.src, alt: alt || null, width: width ?? null, height: height ?? null } });
		return embed;
	}

	ignoreEvent() {
		return false;
	}
}

// Typora-style `<img src="Assets/x.png" style="zoom:50%">`: the src is a URL
// or a path the renderer's resolveHtmlSrc finds; other attributes carry over
// except event handlers.
const HTML_ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const IMG_ATTRS = new Set(["alt", "title", "width", "height", "style", "align", "class"]);

function htmlImage(tag: string, resolveImage: (link: string) => string | null): HtmlImageWidget | null {
	const attrs: [string, string][] = [];
	let src = "";
	for (const m of tag.replace(/^<img\b/i, "").matchAll(HTML_ATTR)) {
		const name = m[1].toLowerCase();
		const value = m[2] ?? m[3] ?? m[4] ?? "";
		if (name === "src") src = value;
		else if (IMG_ATTRS.has(name)) attrs.push([name, value]);
	}
	if (!src) return null;
	const url = resolveHtmlSrc(src, resolveImage) ?? (SCHEME.test(src) ? src : null);
	return url ? new HtmlImageWidget(url, attrs) : null;
}

class HtmlImageWidget extends WidgetType {
	constructor(
		readonly src: string,
		readonly attrs: [string, string][],
	) {
		super();
	}

	eq(other: HtmlImageWidget) {
		return other.src === this.src && JSON.stringify(other.attrs) === JSON.stringify(this.attrs);
	}

	toDOM() {
		const wrap = createSpan("cm-html-embed");
		const img = wrap.createEl("img", { attr: { src: this.src } });
		for (const [name, value] of this.attrs) img.setAttribute(name, value);
		return wrap;
	}

	ignoreEvent() {
		return false;
	}
}

class FlairWidget extends WidgetType {
	constructor(readonly language: string) {
		super();
	}

	eq(other: FlairWidget) {
		return other.language === this.language;
	}

	toDOM() {
		return createSpan({ cls: "code-block-flair", text: this.language, attr: { "aria-label": "Code block language" } });
	}
}

// Each editor's Properties block talks to the note through one host, which
// also remembers whether the block is collapsed while CodeMirror re-creates
// the widget.
const metadataHosts = new WeakMap<EditorView, MetadataEditorHost>();

function metadataHost(view: EditorView, host: LivePreviewHost): MetadataEditorHost {
	let h = metadataHosts.get(view);
	if (!h) metadataHosts.set(view, (h = editorMetadataHost(view, host.app, () => host.sourcePath())));
	return h;
}

// Obsidian's Properties editor over the frontmatter. The editor lives with
// the widget's DOM: a new YAML updates it in place, so a field being edited
// keeps its focus.
class PropertiesWidget extends WidgetType {
	constructor(
		readonly yaml: string,
		readonly host: LivePreviewHost,
	) {
		super();
	}

	eq(other: PropertiesWidget) {
		return other.yaml === this.yaml;
	}

	toDOM(view: EditorView) {
		const editor = new MetadataEditor(metadataHost(view, this.host));
		editor.load();
		editor.sync(this.yaml);
		return editor.containerEl;
	}

	updateDOM(dom: HTMLElement) {
		const editor = metadataEditorOf(dom);
		if (!editor) return false;
		editor.sync(this.yaml);
		return true;
	}

	destroy(dom: HTMLElement) {
		metadataEditorOf(dom)?.unload();
	}

	ignoreEvent() {
		return true;
	}
}

const renderChildren = new WeakMap<HTMLElement, Component>();

// The component of a rendered widget: what its render adds belongs to it,
// and it unloads when CodeMirror destroys the widget's DOM. CodeMirror
// measures block heights once; content that loads later (images, embeds,
// processors) changes the size, so each change asks for a new measure.
function widgetComponent(view: EditorView, el: HTMLElement) {
	const child = new MarkdownRenderChild(el);
	child.load();
	renderChildren.set(el, child);
	const observer = new AppResizeObserver(() => view.requestMeasure());
	observer.observe(el);
	child.register(() => observer.disconnect());
	return child;
}

// The offset in a table's source of the text of cell `col` in rendered row
// `row` (the header is row 0; the delimiter line is skipped).
export function tableCellOffset(source: string, row: number, col: number) {
	const lines = source.split("\n");
	const index = Math.min(row === 0 ? 0 : row + 1, lines.length - 1);
	let offset = 0;
	for (let i = 0; i < index; i++) offset += lines[i].length + 1;
	const line = lines[index];
	const pipes: number[] = [];
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "\\") i++;
		else if (line[i] === "|") pipes.push(i);
	}
	const starts = line.trimStart().startsWith("|") ? pipes.map((p) => p + 1) : [0, ...pipes.map((p) => p + 1)];
	let at = starts[Math.min(col, starts.length - 1)] ?? 0;
	while (line[at] === " " || line[at] === "\t") at++;
	return offset + Math.min(at, line.length);
}

// A line of an indented block without the block's own indentation: all of
// it, or as much leading whitespace as the line has.
function dedent(line: string, indent: string) {
	if (line.startsWith(indent)) return line.slice(indent.length);
	return line.slice(Math.min(/^[ \t]*/.exec(line)![0].length, indent.length));
}

// The title of a foldable callout, which folds it on a click.
const FOLD_TITLE = ".callout.is-collapsible > .callout-title";
// A task's box in a rendered callout, which ticks the task in place.
const TASK_BOX = "input.task-list-item-checkbox";

// Ticks or unticks the task whose box was pressed in a block rendered from
// the lines starting at `firstLine`: the box's data-line counts from there.
export function toggleRenderedTask(view: EditorView, firstLine: number, box: HTMLElement) {
	const doc = view.state.doc;
	const n = firstLine + Number(box.dataset.line);
	if (!Number.isInteger(n) || n < 1 || n > doc.lines) return;
	const line = doc.line(n);
	const task = toggledTask(line.text);
	if (task) view.dispatch({ changes: { from: line.from + task.ch, to: line.from + task.ch + 1, insert: task.status }, userEvent: "input" });
}

// A block rendered with MarkdownRenderer, as the reading view renders it:
// tables (in .table-wrapper), callouts (.cm-callout > .callout) and HTML
// blocks (.cm-html-embed, sanitized, vault sources resolved). The
// renderer's own handlers follow links and fold callouts. A block in a list
// item renders without the item's indentation, which alone would make it an
// indented code block; `source` keeps the note's lines, for cell offsets.
class RenderedBlockWidget extends WidgetType {
	constructor(
		readonly source: string,
		readonly indent: string,
		readonly kind: "table" | "callout" | "html",
		readonly host: LivePreviewHost,
	) {
		super();
	}

	eq(other: RenderedBlockWidget) {
		return other.source === this.source && other.kind === this.kind;
	}

	// The block as the renderer gets it.
	get markdown() {
		return this.source.split("\n").map((line) => dedent(line, this.indent)).join("\n");
	}

	toDOM(view: EditorView) {
		const kindClass = { table: "cm-table-widget", callout: "cm-callout", html: "cm-html-embed" }[this.kind];
		const el = createDiv(`cm-embed-block markdown-rendered ${kindClass}`);
		const body = this.kind === "table" ? el.createDiv("table-wrapper") : el;
		const child = widgetComponent(view, el);
		MarkdownRenderer.render(this.host.app, this.markdown, body, this.host.sourcePath(), child).catch((err) => console.error(err));
		for (const table of body.findAll("table")) table.addClass("table-editor");
		if (this.kind === "html") editButton(view, el, (v) => v.posAtDOM(el));
		else if (this.kind === "callout") {
			editButton(view, el, (v) => v.posAtDOM(el));
			// A press on a fold title must not put the caret beside the block,
			// which would reveal its source; the click then folds it. A press
			// on a task's box ticks the task, as in the reading view.
			el.addEventListener("mousedown", (evt) => {
				const target = evt.target as HTMLElement;
				if (target.closest(FOLD_TITLE)) evt.preventDefault();
				const box = evt.button === 0 ? target.closest<HTMLElement>(TASK_BOX) : null;
				if (!box) return;
				evt.preventDefault();
				toggleRenderedTask(view, view.state.doc.lineAt(view.posAtDOM(el)).number, box);
			});
		} else el.addEventListener("mousedown", (evt) => this.#editCell(view, el, evt));
		return el;
	}

	// A click in a rendered table reveals its source with the cursor in the
	// clicked cell.
	#editCell(view: EditorView, el: HTMLElement, evt: MouseEvent) {
		const target = evt.target as HTMLElement;
		if (evt.button !== 0 || target.closest("a")) return;
		evt.preventDefault();
		const cell = target.closest("td, th");
		const row = cell?.parentElement;
		let offset = 0;
		if (cell && row) {
			const index = row.parentElement?.tagName === "THEAD" ? 0 : [...row.parentElement!.children].indexOf(row) + 1;
			offset = tableCellOffset(this.source, index, [...row.children].indexOf(cell));
		}
		reveal(view, view.posAtDOM(el) + offset);
	}

	destroy(dom: HTMLElement) {
		renderChildren.get(dom)?.unload();
	}

	ignoreEvent(evt: Event) {
		// Links inside follow, a foldable callout's title folds it and a
		// task's box ticks it; other clicks reveal the source (tables handle
		// their own clicks).
		const target = evt.target as HTMLElement;
		return evt.type === "mousedown" && (this.kind === "table" || !!target.closest?.(`a, [data-href], ${FOLD_TITLE}, ${TASK_BOX}`));
	}
}

type CodeBlockProcessor = (source: string, el: HTMLElement, ctx: any) => any;

// Code-block processors live in the Markdown renderer's registry.
function codeBlockProcessor(language: string): CodeBlockProcessor | undefined {
	const processors = MarkdownPreviewRenderer.codeBlockPostProcessors;
	return Object.hasOwn(processors, language) ? processors[language] : undefined;
}

// A fenced block whose language has a code-block processor (a plugin's,
// mermaid, base), as in Obsidian's Live Preview: the processor's output plus
// an edit button. The processor gets the fence's content without the fence's
// indentation, as the renderer passes it. `lines` counts the lines after the
// opening fence, for getSectionInfo: `source` is empty both for an empty
// fence and for one that holds a blank line.
class CodeBlockWidget extends WidgetType {
	constructor(
		readonly language: string,
		readonly source: string,
		readonly lines: number,
		readonly from: number,
		readonly handler: CodeBlockProcessor,
		readonly host: LivePreviewHost,
	) {
		super();
	}

	eq(other: CodeBlockWidget) {
		return other.language === this.language && other.source === this.source && other.lines === this.lines && other.handler === this.handler;
	}

	toDOM(view: EditorView) {
		const el = createDiv("cm-preview-code-block cm-embed-block markdown-rendered");
		const block = el.createDiv(`block-language-${this.language}`);
		const child = widgetComponent(view, el);
		const ctx = {
			docId: Math.random().toString(36).slice(2),
			sourcePath: this.host.sourcePath(),
			frontmatter: this.host.app.metadataCache.getCache(this.host.sourcePath())?.frontmatter,
			addChild: (c: Component) => child.addChild(c),
			// The fence lines; processors that run while the widget is being
			// built ask before it is in the document.
			getSectionInfo: () => {
				const first = view.state.doc.lineAt(el.isConnected ? view.posAtDOM(el) : this.from);
				return { text: view.state.doc.toString(), lineStart: first.number - 1, lineEnd: Math.min(first.number + this.lines, view.state.doc.lines) - 1 };
			},
		};
		try {
			Promise.resolve(this.handler(this.source, block, ctx)).catch((err) => console.error(err));
		} catch (err) {
			console.error(err);
		}
		editButton(view, el, (v) => innerStart(v, el));
		return el;
	}

	destroy(dom: HTMLElement) {
		renderChildren.get(dom)?.unload();
	}

	ignoreEvent() {
		return true;
	}
}

// An embed other than a found image: a note or one of its sections, a PDF, a
// base, media, or a missing file. The renderer renders its source through
// its own embed path and post processors, so it is the reading view's embed.
// `target` is the file the link resolves to, so a created or renamed target
// renders again. A block widget when the embed is alone on its line.
class EmbedWidget extends WidgetType {
	constructor(
		readonly source: string,
		readonly target: string,
		readonly block: boolean,
		readonly host: LivePreviewHost,
	) {
		super();
	}

	eq(other: EmbedWidget) {
		return other.source === this.source && other.target === this.target && other.block === this.block;
	}

	toDOM(view: EditorView) {
		const el = this.block ? createDiv("cm-embed-block markdown-rendered") : createSpan("cm-inline-embed markdown-rendered");
		const child = widgetComponent(view, el);
		MarkdownRenderer.render(this.host.app, this.source, el, this.host.sourcePath(), child).catch((err) => console.error(err));
		if (this.block) editButton(view, el, (v) => v.posAtDOM(el));
		return el;
	}

	destroy(dom: HTMLElement) {
		renderChildren.get(dom)?.unload();
	}

	ignoreEvent() {
		return true;
	}
}

// The text of a math node without the quote marks of the lines it goes on
// to, which are its children inside a quote.
function mathText(state: EditorState, node: SyntaxNode) {
	let text = "";
	let at = node.from;
	for (let mark = node.getChild("QuoteMark"); mark; mark = mark.nextSibling) {
		if (mark.name !== "QuoteMark") continue;
		text += state.sliceDoc(at, mark.from);
		at = /[ \t]/.test(state.sliceDoc(mark.to, mark.to + 1)) ? mark.to + 1 : mark.to;
	}
	return text + state.sliceDoc(at, node.to);
}

// The frontmatter shows as YAML once the selection enters it, and until the
// selection leaves it. A note opens with the cursor at offset 0, which is
// inside the frontmatter, so a cursor there that the user did not move
// (opening the note, or code) keeps the Properties block.
function touchesFrontmatter(state: EditorState) {
	const node = syntaxTree(state).topNode.firstChild;
	if (node?.name !== "hmd-frontmatter") return false;
	const end = state.doc.lineAt(node.to).to;
	return state.selection.ranges.some((r) => r.from <= end);
}

function atDocStart({ selection }: EditorState) {
	return selection.ranges.length === 1 && selection.main.empty && selection.main.head === 0;
}

const frontmatterRevealed = StateField.define<boolean>({
	create: (state) => touchesFrontmatter(state) && !atDocStart(state),
	update(revealed, tr) {
		if (!tr.docChanged && !tr.selection) return revealed;
		return touchesFrontmatter(tr.state) && (revealed || !atDocStart(tr.state) || tr.isUserEvent("select"));
	},
});

const hide = Decoration.replace({});

function ancestors(node: SyntaxNode, ...names: string[]) {
	let n = 0;
	for (let p = node.parent; p; p = p.parent) if (names.includes(p.name)) n++;
	return n;
}

interface BuildContext {
	host: LivePreviewHost;
	// The file a link path names, or null.
	linkDest(linkpath: string): TFile | null;
	resolveImage(link: string): string | null;
}

// A rendered link: the editor's underline, dimmed with is-unresolved when no
// file has the name, and the attributes of the renderer's link element, its
// class (internal-link, external-link) and the data-href that the click and
// hover handlers read. Inclusive, so a widget filling the link text (a badge
// image) sits inside the link element and clicks on it open the link.
function linkMark(kind: "internal-link" | "external-link", href: string, resolved = true) {
	return Decoration.mark({ class: resolved ? "cm-underline" : "cm-underline is-unresolved", attributes: { class: kind, "data-href": href }, inclusive: true });
}

// Syntax stays visible wherever the selection touches; elsewhere it is hidden
// or rendered, as in Obsidian's Live Preview. Line classes follow Obsidian's
// HyperMD names, which themes and plugin CSS target. In source mode every
// element counts as touched, so only the classes remain.
function build(state: EditorState, cx: BuildContext): DecorationSet {
	const { host } = cx;
	const doc = state.doc;
	const decos: Range<Decoration>[] = [];
	const ranges = state.selection.ranges;
	const live = state.field(editorLivePreviewField, false) !== false;
	const touches = (from: number, to: number) => !live || ranges.some((r) => r.from <= to && r.to >= from);
	const touchesLines = (from: number, to: number) => touches(doc.lineAt(from).from, doc.lineAt(to).to);
	const lineClasses = new Map<number, string[]>();
	const lineAttrs = new Map<number, Record<string, string>>();
	const quoteDepth = new Map<number, number>();
	const addLine = (pos: number, cls: string) => {
		const from = doc.lineAt(pos).from;
		const list = lineClasses.get(from);
		if (list) list.push(cls);
		else lineClasses.set(from, [cls]);
	};
	const eachLine = (from: number, to: number, f: (line: { from: number; to: number; number: number }) => void) => {
		for (let pos = from; pos <= to; ) {
			const line = doc.lineAt(pos);
			f(line);
			pos = line.to + 1;
		}
	};
	// Block widgets replace whole lines, so the block must be alone on them.
	const ownsLines = (node: SyntaxNode) => !doc.sliceString(doc.lineAt(node.from).from, node.from).trim() && !ancestors(node, "Blockquote");
	// An embed that is not a found image renders through the renderer: as a
	// block when it is alone on its line, else within the line.
	const embed = (node: SyntaxNode, linkpath: string) => {
		const line = doc.lineAt(node.from);
		const block = ownsLines(node) && node.to <= line.to && !doc.sliceString(node.to, line.to).trim();
		if (block && touchesLines(node.from, node.to)) return;
		const widget = new EmbedWidget(state.sliceDoc(node.from, node.to), cx.linkDest(linkpath)?.path ?? "", block, host);
		decos.push(block ? Decoration.replace({ widget, block: true }).range(line.from, line.to) : Decoration.replace({ widget }).range(node.from, node.to));
	};

	syntaxTree(state).iterate({
		enter: (ref) => {
			const { from, to, name } = ref;
			const node = ref.node;
			const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
			if (heading) {
				eachLine(from, to, (l) => addLine(l.from, `HyperMD-header HyperMD-header-${heading[1]}`));
				return;
			}
			switch (name) {
				case "hmd-frontmatter": {
					eachLine(from, to, (l) => addLine(l.from, "HyperMD-frontmatter"));
					addLine(from, "HyperMD-frontmatter-begin");
					const closed = node.getChildren("formatting_hmd-frontmatter").length > 1;
					if (!closed) return false;
					addLine(to, "HyperMD-frontmatter-end");
					const mode = host.app.vault.getConfig("propertiesInDocument") ?? "visible";
					if (!live || mode === "source" || state.field(frontmatterRevealed)) return false;
					const yaml = doc.sliceString(doc.line(1).to + 1, doc.lineAt(to).from);
					decos.push(Decoration.replace({ block: true, widget: mode === "hidden" ? undefined : new PropertiesWidget(yaml, host) }).range(from, to));
					return false;
				}
				case "HeaderMark": {
					if (node.parent?.name.startsWith("SetextHeading") || touchesLines(from, to)) return;
					const end = state.sliceDoc(to, to + 1) === " " ? to + 1 : to;
					decos.push(hide.range(from, end));
					return;
				}
				case "EmphasisMark":
				case "StrikethroughMark":
				case "formatting-highlight": {
					const parent = node.parent!;
					if (!touches(parent.from, parent.to)) decos.push(hide.range(from, to));
					return;
				}
				case "CodeMark": {
					const parent = node.parent!;
					if (parent.name === "InlineCode" && !touches(parent.from, parent.to)) decos.push(hide.range(from, to));
					return;
				}
				case "Escape": {
					if (!touches(from, to)) decos.push(hide.range(from, from + 1));
					return;
				}
				case "FencedCode": {
					const first = doc.lineAt(from);
					const last = doc.lineAt(to);
					const marks = node.getChildren("CodeMark");
					const closed = marks.length > 1 && last.number > first.number;
					eachLine(from, to, (l) => addLine(l.from, "HyperMD-codeblock HyperMD-codeblock-bg"));
					addLine(from, "HyperMD-codeblock-begin HyperMD-codeblock-begin-bg");
					if (closed) addLine(to, "HyperMD-codeblock-end HyperMD-codeblock-end-bg");
					if (touchesLines(from, to)) return false;
					const info = node.getChild("CodeInfo");
					const language = info ? state.sliceDoc(info.from, info.to).trim().split(/\s/)[0] : "";
					const handler = language ? codeBlockProcessor(language) : undefined;
					if (closed && handler && ownsLines(node)) {
						const indent = doc.sliceString(first.from, from);
						const lines = last.number - first.number > 1 ? doc.sliceString(first.to + 1, last.from - 1).split("\n") : [];
						const source = lines.map((line) => dedent(line, indent)).join("\n");
						const widget = new CodeBlockWidget(language, source, last.number - first.number, first.from, handler, host);
						decos.push(Decoration.replace({ block: true, widget }).range(first.from, last.to));
						return false;
					}
					if (marks[0].from < first.to) decos.push(hide.range(marks[0].from, first.to));
					if (closed) decos.push(hide.range(marks[marks.length - 1].from, marks[marks.length - 1].to));
					if (language) decos.push(Decoration.widget({ widget: new FlairWidget(language), side: 1 }).range(first.to));
					return false;
				}
				case "Blockquote": {
					const depth = ancestors(node, "Blockquote") + 1;
					eachLine(from, to, (l) => quoteDepth.set(l.from, Math.max(quoteDepth.get(l.from) ?? 0, depth)));
					const first = doc.lineAt(from);
					if (depth > 1 || !/^\s*>\s*\[![^\]]+\][+-]?/.test(first.text)) return;
					eachLine(from, to, (l) => addLine(l.from, "HyperMD-callout"));
					if (touchesLines(from, to) || !ownsLines(node)) return;
					const last = doc.lineAt(to);
					const widget = new RenderedBlockWidget(doc.sliceString(first.from, last.to), doc.sliceString(first.from, from), "callout", host);
					decos.push(Decoration.replace({ block: true, widget }).range(first.from, last.to));
					return false;
				}
				case "QuoteMark": {
					if (touchesLines(from, to)) {
						const depth = ancestors(node, "Blockquote");
						decos.push(Decoration.mark({ class: `cm-formatting-quote-${depth}` }).range(from, to));
						return;
					}
					const end = state.sliceDoc(to, to + 1) === " " ? to + 1 : to;
					decos.push(hide.range(from, end));
					return;
				}
				case "ListItem": {
					const depth = ancestors(node, "BulletList", "OrderedList");
					const first = doc.lineAt(from);
					addLine(first.from, `HyperMD-list-line HyperMD-list-line-${depth}`);
					let nested: SyntaxNode | null = null;
					for (let c = node.firstChild; c && !nested; c = c.nextSibling) if (c.name === "BulletList" || c.name === "OrderedList") nested = c;
					const end = nested ? doc.lineAt(nested.from).from - 1 : to;
					if (end > first.to) {
						eachLine(first.to + 1, end, (l) => {
							if (l.to > l.from) addLine(l.from, `HyperMD-list-line HyperMD-list-line-${depth} HyperMD-list-line-nobullet`);
						});
					}
					if (end > from) decos.push(Decoration.mark({ class: `cm-list-${((depth - 1) % 3) + 1}` }).range(from, end));
					return;
				}
				case "ListMark": {
					if (node.parent?.parent?.name !== "BulletList" || node.nextSibling?.name === "Task" || touchesLines(from, to)) return;
					decos.push(Decoration.mark({ class: "list-bullet" }).range(from, to));
					return;
				}
				case "Task": {
					const status = state.sliceDoc(from + 1, from + 2);
					addLine(from, "HyperMD-task-line");
					lineAttrs.set(doc.lineAt(from).from, { "data-task": status });
					return;
				}
				case "TaskMarker": {
					if (touchesLines(from, to)) return;
					// A bullet gives way to the box; an ordered task keeps its number.
					const mark = node.parent?.parent?.firstChild;
					const start = mark?.name === "ListMark" && node.parent?.parent?.parent?.name === "BulletList" ? mark.from : from;
					decos.push(Decoration.replace({ widget: new CheckboxWidget(state.sliceDoc(from + 1, from + 2), from) }).range(start, to));
					return;
				}
				case "HorizontalRule": {
					if (!touchesLines(from, to)) decos.push(Decoration.replace({ widget: new RuleWidget() }).range(from, to));
					return;
				}
				case "Table": {
					let row = 0;
					eachLine(from, to, (l) => addLine(l.from, `HyperMD-table-row HyperMD-table-row-${row++}`));
					if (touchesLines(from, to) || !ownsLines(node)) return false;
					const first = doc.lineAt(from);
					const last = doc.lineAt(to);
					const widget = new RenderedBlockWidget(doc.sliceString(first.from, last.to), doc.sliceString(first.from, from), "table", host);
					decos.push(Decoration.replace({ block: true, widget }).range(first.from, last.to));
					return false;
				}
				case "Link": {
					if (touches(from, to)) return;
					const marks = node.getChildren("LinkMark");
					const href = destination(state, node);
					if (href === null) return;
					const textEnd = marks[1].from;
					decos.push(hide.range(from, marks[0].to));
					if (textEnd > marks[0].to) {
						// A note link carries its decoded path, as the reading view's does.
						const path = safeDecode(href);
						const mark = SCHEME.test(href) ? linkMark("external-link", href) : linkMark("internal-link", path, !!cx.linkDest(getLinkpath(path)));
						decos.push(mark.range(marks[0].to, textEnd));
					}
					decos.push(hide.range(textEnd, to));
					// The link text's own syntax (emphasis, code, math, a badge
					// image) renders inside the link, as in the reading view.
					return;
				}
				case "Autolink": {
					if (touches(from, to)) return false;
					const url = node.getChild("URL");
					if (!url) return false;
					decos.push(hide.range(from, url.from));
					decos.push(linkMark("external-link", autolinkHref(url, state.sliceDoc(url.from, url.to))).range(url.from, url.to));
					decos.push(hide.range(url.to, to));
					return false;
				}
				case "URL": {
					const parent = node.parent?.name;
					if (parent === "Link" || parent === "Image" || touches(from, to)) return;
					decos.push(linkMark("external-link", autolinkHref(node, state.sliceDoc(from, to))).range(from, to));
					return;
				}
				case "Image": {
					if (touches(from, to)) return;
					const marks = node.getChildren("LinkMark");
					const href = destination(state, node);
					const target = href === null ? null : safeDecode(href);
					if (!target) return false;
					const alt = marks.length >= 2 ? state.sliceDoc(marks[0].to, marks[1].from) : "";
					const local = !SCHEME.test(target);
					const src = !local || IMAGE.test(getLinkpath(target)) ? cx.resolveImage(target) : null;
					if (src) decos.push(Decoration.replace({ widget: new ImageWidget(src, target, alt) }).range(from, to));
					else if (local) embed(node, getLinkpath(target));
					return false;
				}
				case "HTMLTag": {
					if (touches(from, to)) return;
					const tag = state.sliceDoc(from, to);
					const widget = /^<img\b/i.test(tag) ? htmlImage(tag, cx.resolveImage) : null;
					if (widget) decos.push(Decoration.replace({ widget }).range(from, to));
					return;
				}
				// An <img> on a line of its own, without a closing slash, is an
				// HTML block rather than an inline tag.
				// Any other HTML block renders as the reading view renders it, until
				// the cursor enters its lines.
				case "HTMLBlock": {
					const block = state.sliceDoc(from, to);
					if (/^\s*<img\b[^>]*>\s*$/i.test(block)) {
						if (touches(from, to)) return;
						const widget = htmlImage(block.trim(), cx.resolveImage);
						if (widget) decos.push(Decoration.replace({ widget }).range(from, to));
						return false;
					}
					if (touchesLines(from, to) || !ownsLines(node)) return;
					const first = doc.lineAt(from);
					const last = doc.lineAt(to);
					const widget = new RenderedBlockWidget(doc.sliceString(first.from, last.to), doc.sliceString(first.from, from), "html", host);
					decos.push(Decoration.replace({ block: true, widget }).range(first.from, last.to));
					return false;
				}
				case "internal-link":
				case "internal-embed": {
					if (touches(from, to)) return false;
					const targetNode = node.getChild("hmd-internal-link");
					if (!targetNode) return false;
					const target = state.sliceDoc(targetNode.from, targetNode.to).trim();
					const alias = node.getChild("hmd-internal-link_link-alias");
					if (name === "internal-embed") {
						const path = getLinkpath(target);
						const src = IMAGE.test(path) ? cx.resolveImage(path) : null;
						const alt = alias ? state.sliceDoc(alias.from, alias.to) : "";
						if (src) decos.push(Decoration.replace({ widget: new ImageWidget(src, target, alt) }).range(from, to));
						else embed(node, path);
						return false;
					}
					const shown = alias ?? targetNode;
					decos.push(hide.range(from, shown.from));
					decos.push(linkMark("internal-link", target, !!cx.linkDest(getLinkpath(target))).range(shown.from, shown.to));
					decos.push(hide.range(shown.to, to));
					return false;
				}
				case "footref": {
					if (doc.lineAt(from).from === from && state.sliceDoc(to, to + 1) === ":") addLine(from, "HyperMD-footnote");
					return;
				}
				case "hashtag": {
					const tag = state.sliceDoc(from, to);
					const attributes: Record<string, string> = touches(from, to) ? {} : { "data-tag": tag };
					decos.push(Decoration.mark({ class: `cm-tag-${tag.slice(1)}`, attributes }).range(from, to));
					return false;
				}
				case "InlineMath": {
					if (touches(from, to)) return false;
					const content = node.getChild("math");
					const display = state.sliceDoc(from, from + 2) === "$$";
					decos.push(Decoration.replace({ widget: new MathWidget(content ? mathText(state, content) : "", display) }).range(from, to));
					return false;
				}
				case "BlockMath": {
					if (touchesLines(from, to)) return false;
					const content = node.getChild("math");
					const widget = new MathWidget(content ? mathText(state, content).trim() : "", true);
					if (ownsLines(node)) decos.push(Decoration.replace({ widget, block: true }).range(doc.lineAt(from).from, doc.lineAt(to).to));
					else decos.push(Decoration.replace({ widget }).range(from, to));
					return false;
				}
			}
		},
	});

	for (const [from, depth] of quoteDepth) {
		addLine(from, `HyperMD-quote HyperMD-quote-${depth}`);
		const line = doc.lineAt(from);
		if (line.to > line.from) decos.push(Decoration.mark({ class: `cm-quote-${depth}` }).range(line.from, line.to));
	}
	for (const [from, classes] of lineClasses) {
		decos.push(Decoration.line({ class: classes.join(" "), attributes: lineAttrs.get(from) }).range(from));
	}
	return Decoration.set(decos, true);
}

const refresh = StateEffect.define<null>();

// Resolves links and images again, after the vault's files changed.
export function refreshLivePreview(view: EditorView) {
	view.dispatch({ effects: refresh.of(null) });
}

// A tag click opens search for it, as in Obsidian.
export async function searchTag(app: App, tag: string) {
	const search = (app as any).internalPlugins?.getPluginById?.("global-search")?.instance;
	if (search?.openGlobalSearch) return search.openGlobalSearch(`tag:${tag}`);
	const leaf = await app.workspace.ensureSideLeaf("search", "left", { reveal: true });
	const input: HTMLInputElement | undefined = (leaf.view as any).inputEl;
	if (!input) return;
	input.value = tag;
	input.dispatchEvent(new Event("input"));
}

export function livePreview(host: LivePreviewHost): Extension {
	// Link and image resolution scan the vault, so each is cached per editor
	// until refreshLivePreview.
	const dests = new Map<string, TFile | null>();
	const images = new Map<string, string | null>();
	const cached = <T>(cache: Map<string, T>, link: string, resolve: () => T) => {
		const key = `${host.sourcePath()}\n${link}`;
		if (!cache.has(key)) cache.set(key, resolve());
		return cache.get(key) as T;
	};
	const cx: BuildContext = {
		host,
		linkDest: (linkpath) => cached(dests, linkpath, () => host.app.metadataCache.getFirstLinkpathDest(linkpath, host.sourcePath())),
		resolveImage: (link) => cached(images, link, () => host.resolveImage(link)),
	};
	const field = StateField.define<DecorationSet>({
		create: (state) => build(state, cx),
		update(decos, tr) {
			if (tr.effects.some((e) => e.is(refresh))) {
				dests.clear();
				images.clear();
				return build(tr.state, cx);
			}
			if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state, cx);
			if (tr.state.field(editorLivePreviewField, false) !== tr.startState.field(editorLivePreviewField, false)) return build(tr.state, cx);
			if (tr.effects.some((e) => e.is(setMousedown) && !e.value)) return build(tr.state, cx);
			if (tr.selection && !tr.state.field(mousedownField, false)) return build(tr.state, cx);
			return decos;
		},
		provide: (f) => EditorView.decorations.from(f),
	});
	const tagClicks = EditorView.domEventHandlers({
		mousedown(evt) {
			const el = evt.button === 0 ? (evt.target as HTMLElement).closest?.("[data-tag]") : null;
			if (!el) return false;
			evt.preventDefault();
			searchTag(host.app, el.getAttribute("data-tag")!);
			return true;
		},
	});
	return [frontmatterRevealed, field, tagClicks, processorRefresh, Prec.high(keymap.of([{ key: "ArrowUp", run: enterProperties }]))];
}

// ArrowUp out of the note's first line goes to the Properties block above it.
function enterProperties(view: EditorView) {
	const { state } = view;
	const sel = state.selection.main;
	const node = syntaxTree(state).topNode.firstChild;
	if (!sel.empty || node?.name !== "hmd-frontmatter") return false;
	const end = state.doc.lineAt(node.to).to;
	if (sel.head <= end || view.moveVertically(sel, false).head > end) return false;
	const editor = metadataEditorOf(view.contentDOM.querySelector(".metadata-container"));
	if (!editor) return false;
	editor.focusLast();
	return true;
}

// A plugin that loads or unloads a code-block processor changes which fences
// render: the decorations are rebuilt once its registrations are done.
const processorRefresh = ViewPlugin.fromClass(
	class {
		#stop: () => void;
		#queued = false;
		#destroyed = false;

		constructor(view: EditorView) {
			this.#stop = onCodeBlockProcessorsChange(() => {
				if (this.#queued) return;
				this.#queued = true;
				queueMicrotask(() => {
					this.#queued = false;
					if (!this.#destroyed) refreshLivePreview(view);
				});
			});
		}

		destroy() {
			this.#destroyed = true;
			this.#stop();
		}
	},
);
