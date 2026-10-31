import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { App } from "./app";
import type { Component } from "./events";
import { setIcon } from "./icons";
import { Keymap } from "./keymap";
import { finishRenderMath, MarkdownPreviewRenderer, MarkdownRenderChild, MarkdownRenderer, renderMath } from "./markdown";
import { getLinkpath } from "./metadata-utils";
import { parseYaml } from "./util";

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
		const win = this.#view.dom.ownerDocument.defaultView ?? window;
		if (down) {
			win.addEventListener("mouseup", this.#release, true);
			win.addEventListener("blur", this.#release);
		} else {
			win.removeEventListener("mouseup", this.#release, true);
			win.removeEventListener("blur", this.#release);
		}
		this.#view.dispatch({ effects: setMousedown.of(down) });
	}

	destroy() {
		const win = this.#view.dom.ownerDocument.defaultView ?? window;
		win.removeEventListener("mouseup", this.#release, true);
		win.removeEventListener("blur", this.#release);
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
			const url = n.getChild("URL");
			if (!url) return null;
			const href = text(url);
			return SCHEME.test(href)
				? { type: "external-link", text: href, from: n.from, to: n.to }
				: { type: "internal-link", text: safeDecode(href), from: n.from, to: n.to };
		}
		case "URL": {
			const parent = n.parent?.name;
			if (parent === "Link" || parent === "Image") return null;
			return { type: "external-link", text: text(n), from: n.from, to: n.to };
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

// Typora-style `<img src="Assets/x.png" style="zoom:50%">`: the src is a path
// relative to the note (backslashes allowed) or a URL; other attributes
// carry over except event handlers.
const HTML_ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const IMG_ATTRS = new Set(["alt", "title", "width", "height", "style", "align", "class"]);

function htmlImage(tag: string, host: LivePreviewHost): HtmlImageWidget | null {
	const attrs: [string, string][] = [];
	let src = "";
	for (const m of tag.replace(/^<img\b/i, "").matchAll(HTML_ATTR)) {
		const name = m[1].toLowerCase();
		const value = m[2] ?? m[3] ?? m[4] ?? "";
		if (name === "src") src = value;
		else if (IMG_ATTRS.has(name)) attrs.push([name, value]);
	}
	if (!src) return null;
	let url: string | null = src;
	if (!SCHEME.test(src)) {
		let path = src.replace(/\\/g, "/").replace(/^\.\//, "");
		try {
			path = decodeURIComponent(path);
		} catch {}
		// An absolute path from another machine still finds the file by name.
		url = host.resolveImage(path) ?? (path.includes("/") ? host.resolveImage(path.slice(path.lastIndexOf("/") + 1)) : null);
	}
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

function propertyValue(el: HTMLElement, value: unknown) {
	if (Array.isArray(value)) {
		const list = el.createDiv("multi-select-container");
		for (const v of value) list.createDiv("multi-select-pill").createDiv({ cls: "multi-select-pill-content", text: String(v) });
	} else if (typeof value === "boolean") {
		el.createEl("input", { type: "checkbox", cls: "metadata-input-checkbox", attr: { disabled: true } }).checked = value;
	} else if (value !== null && value !== undefined) {
		el.createDiv({ cls: "metadata-input-longtext", text: typeof value === "object" ? JSON.stringify(value) : String(value) });
	}
}

// A read-only stand-in for Obsidian's Properties editor. A click reveals
// the YAML for editing.
class PropertiesWidget extends WidgetType {
	constructor(readonly yaml: string) {
		super();
	}

	eq(other: PropertiesWidget) {
		return other.yaml === this.yaml;
	}

	toDOM(view: EditorView) {
		const el = createDiv("metadata-container");
		el.createDiv("metadata-properties-heading").createDiv({ cls: "metadata-properties-title", text: "Properties" });
		const content = el.createDiv("metadata-content");
		let data: unknown = null;
		try {
			data = this.yaml.trim() ? parseYaml(this.yaml) : {};
		} catch {}
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			content.createDiv({ cls: "metadata-error", text: "Invalid properties" });
		} else {
			const list = content.createDiv("metadata-properties");
			const entries = Object.entries(data);
			el.setAttr("data-property-count", entries.length);
			for (const [key, value] of entries) {
				const row = list.createDiv({ cls: "metadata-property", attr: { "data-property-key": key, tabindex: 0 } });
				const keyEl = row.createDiv("metadata-property-key");
				setIcon(keyEl.createSpan("metadata-property-icon"), Array.isArray(value) ? "list" : typeof value === "boolean" ? "check-square" : "text");
				keyEl.createSpan({ cls: "metadata-property-key-input", text: key });
				propertyValue(row.createDiv("metadata-property-value"), value);
			}
		}
		el.addEventListener("mousedown", (evt) => {
			evt.preventDefault();
			reveal(view, innerStart(view, el));
		});
		return el;
	}

	ignoreEvent() {
		return true;
	}
}

const renderChildren = new WeakMap<HTMLElement, Component>();

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

// A block rendered with MarkdownRenderer: tables and callouts.
class RenderedBlockWidget extends WidgetType {
	constructor(
		readonly source: string,
		readonly kind: "table" | "callout",
		readonly host: LivePreviewHost,
	) {
		super();
	}

	eq(other: RenderedBlockWidget) {
		return other.source === this.source && other.kind === this.kind;
	}

	toDOM(view: EditorView) {
		const el = createDiv(`cm-embed-block markdown-rendered ${this.kind === "table" ? "cm-table-widget" : "cm-callout"}`);
		const body = el.createDiv();
		const child = new MarkdownRenderChild(el);
		child.load();
		renderChildren.set(el, child);
		MarkdownRenderer.render(this.host.app, this.source, body, this.host.sourcePath(), child)
			.then(() => {
				for (const table of body.findAll("table")) table.addClass("table-editor");
				view.requestMeasure();
			})
			.catch((err) => console.error(err));
		el.addEventListener("click", (evt) => this.#followLink(evt));
		if (this.kind === "callout") editButton(view, el, (v) => v.posAtDOM(el));
		else el.addEventListener("mousedown", (evt) => this.#editCell(view, el, evt));
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

	// Rendered links must not navigate the window.
	#followLink(evt: MouseEvent) {
		const a = (evt.target as HTMLElement).closest("a");
		if (!a || evt.defaultPrevented) return;
		evt.preventDefault();
		const { app } = this.host;
		if (a.hasClass("tag")) return searchTag(app, a.textContent ?? "");
		const href = a.getAttribute("data-href") ?? a.getAttribute("href");
		if (!href) return;
		if (SCHEME.test(href)) require("electron").shell.openExternal(href);
		else app.workspace.openLinkText(safeDecode(href), this.host.sourcePath(), Keymap.isModEvent(evt));
	}

	destroy(dom: HTMLElement) {
		renderChildren.get(dom)?.unload();
	}

	ignoreEvent(evt: Event) {
		// Links inside follow; other clicks reveal the source (tables handle
		// their own clicks).
		return evt.type === "mousedown" && (this.kind === "table" || !!(evt.target as HTMLElement).closest?.("a, [data-href]"));
	}
}

type CodeBlockProcessor = (source: string, el: HTMLElement, ctx: any) => any;

// Code-block processors live in the Markdown renderer's registry.
function codeBlockProcessor(language: string): CodeBlockProcessor | undefined {
	return (MarkdownPreviewRenderer as any).codeBlockPostProcessors?.[language];
}

// A fenced block whose language a plugin renders, as in Obsidian's Live
// Preview: the processor's output plus an edit button.
class CodeBlockWidget extends WidgetType {
	constructor(
		readonly language: string,
		readonly source: string,
		readonly from: number,
		readonly host: LivePreviewHost,
	) {
		super();
	}

	eq(other: CodeBlockWidget) {
		return other.language === this.language && other.source === this.source;
	}

	toDOM(view: EditorView) {
		const el = createDiv("cm-preview-code-block cm-embed-block markdown-rendered");
		const block = el.createDiv(`block-language-${this.language}`);
		const child = new MarkdownRenderChild(block);
		child.load();
		renderChildren.set(el, child);
		const ctx = {
			docId: Math.random().toString(36).slice(2),
			sourcePath: this.host.sourcePath(),
			frontmatter: this.host.app.metadataCache.getCache(this.host.sourcePath())?.frontmatter,
			addChild: (c: Component) => child.addChild(c),
			// The fence lines; processors that run while the widget is being
			// built ask before it is in the document.
			getSectionInfo: () => {
				const first = view.state.doc.lineAt(el.isConnected ? view.posAtDOM(el) : this.from);
				const last = first.number + this.source.split("\n").length + (this.source ? 1 : 0);
				return { text: view.state.doc.toString(), lineStart: first.number - 1, lineEnd: Math.min(last, view.state.doc.lines) - 1 };
			},
		};
		try {
			Promise.resolve(codeBlockProcessor(this.language)?.(this.source, block, ctx))
				.then(() => view.requestMeasure())
				.catch((err) => console.error(err));
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

const hide = Decoration.replace({});

function ancestors(node: SyntaxNode, ...names: string[]) {
	let n = 0;
	for (let p = node.parent; p; p = p.parent) if (names.includes(p.name)) n++;
	return n;
}

interface BuildContext {
	host: LivePreviewHost;
	isResolved(linkpath: string): boolean;
}

// Syntax stays visible wherever the selection touches; elsewhere it is hidden
// or rendered, as in Obsidian's Live Preview. Line classes follow Obsidian's
// HyperMD names, which themes and plugin CSS target.
function build(state: EditorState, cx: BuildContext): DecorationSet {
	const { host } = cx;
	const doc = state.doc;
	const decos: Range<Decoration>[] = [];
	const ranges = state.selection.ranges;
	const touches = (from: number, to: number) => ranges.some((r) => r.from <= to && r.to >= from);
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
					if (mode === "source" || touchesLines(from, to)) return false;
					const yaml = doc.sliceString(doc.line(1).to + 1, doc.lineAt(to).from);
					decos.push(Decoration.replace({ block: true, widget: mode === "hidden" ? undefined : new PropertiesWidget(yaml) }).range(from, to));
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
					if (closed && language && codeBlockProcessor(language) && ownsLines(node)) {
						const source = last.number - first.number > 1 ? doc.sliceString(first.to + 1, last.from - 1) : "";
						decos.push(Decoration.replace({ block: true, widget: new CodeBlockWidget(language, source, first.from, host) }).range(first.from, last.to));
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
					decos.push(Decoration.replace({ block: true, widget: new RenderedBlockWidget(doc.sliceString(first.from, last.to), "callout", host) }).range(first.from, last.to));
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
					const mark = node.parent?.parent?.firstChild;
					const start = mark?.name === "ListMark" ? mark.from : from;
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
					decos.push(Decoration.replace({ block: true, widget: new RenderedBlockWidget(doc.sliceString(first.from, last.to), "table", host) }).range(first.from, last.to));
					return false;
				}
				case "Link": {
					if (touches(from, to)) return;
					const url = node.getChild("URL");
					const marks = node.getChildren("LinkMark");
					if (!url || marks.length < 2) return;
					const textEnd = marks[1].from;
					const href = state.sliceDoc(url.from, url.to);
					const unresolved = !SCHEME.test(href) && !cx.isResolved(getLinkpath(safeDecode(href)));
					decos.push(hide.range(from, marks[0].to));
					if (textEnd > marks[0].to) {
						decos.push(Decoration.mark({ class: unresolved ? "cm-underline is-unresolved" : "cm-underline", attributes: { "data-href": href } }).range(marks[0].to, textEnd));
					}
					decos.push(hide.range(textEnd, to));
					return false;
				}
				case "Autolink": {
					if (touches(from, to)) return false;
					const url = node.getChild("URL");
					if (!url) return false;
					decos.push(hide.range(from, url.from));
					decos.push(Decoration.mark({ class: "cm-underline", attributes: { "data-href": state.sliceDoc(url.from, url.to) } }).range(url.from, url.to));
					decos.push(hide.range(url.to, to));
					return false;
				}
				case "URL": {
					const parent = node.parent?.name;
					if (parent === "Link" || parent === "Image" || touches(from, to)) return;
					decos.push(Decoration.mark({ class: "cm-underline", attributes: { "data-href": state.sliceDoc(from, to) } }).range(from, to));
					return;
				}
				case "Image": {
					if (touches(from, to)) return;
					const url = node.getChild("URL");
					const marks = node.getChildren("LinkMark");
					const target = url ? safeDecode(state.sliceDoc(url.from, url.to)) : null;
					const src = target ? host.resolveImage(target) : null;
					const alt = marks.length >= 2 ? state.sliceDoc(marks[0].to, marks[1].from) : "";
					if (src && target) decos.push(Decoration.replace({ widget: new ImageWidget(src, target, alt) }).range(from, to));
					return false;
				}
				case "HTMLTag": {
					if (touches(from, to)) return;
					const tag = state.sliceDoc(from, to);
					const widget = /^<img\b/i.test(tag) ? htmlImage(tag, host) : null;
					if (widget) decos.push(Decoration.replace({ widget }).range(from, to));
					return;
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
						const src = IMAGE.test(path) ? host.resolveImage(path) : null;
						const alt = alias ? state.sliceDoc(alias.from, alias.to) : "";
						if (src) decos.push(Decoration.replace({ widget: new ImageWidget(src, target, alt) }).range(from, to));
						return false;
					}
					const shown = alias ?? targetNode;
					const unresolved = !cx.isResolved(getLinkpath(target));
					decos.push(hide.range(from, shown.from));
					decos.push(
						Decoration.mark({ class: unresolved ? "cm-underline is-unresolved" : "cm-underline", attributes: { "data-href": target } }).range(shown.from, shown.to),
					);
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
					decos.push(Decoration.replace({ widget: new MathWidget(content ? state.sliceDoc(content.from, content.to) : "", display) }).range(from, to));
					return false;
				}
				case "BlockMath": {
					if (touchesLines(from, to)) return false;
					const content = node.getChild("math");
					const widget = new MathWidget(content ? state.sliceDoc(content.from, content.to).trim() : "", true);
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
	// Link resolution is cached per editor until the vault's file set changes.
	const resolved = new Map<string, boolean>();
	const cx: BuildContext = {
		host,
		isResolved(linkpath) {
			const key = `${host.sourcePath()}\n${linkpath}`;
			let hit = resolved.get(key);
			if (hit === undefined) {
				hit = !!host.app.metadataCache.getFirstLinkpathDest(linkpath, host.sourcePath());
				resolved.set(key, hit);
			}
			return hit;
		},
	};
	const field = StateField.define<DecorationSet>({
		create: (state) => build(state, cx),
		update(decos, tr) {
			if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState) || tr.effects.some((e) => e.is(refresh))) return build(tr.state, cx);
			if (tr.effects.some((e) => e.is(setMousedown) && !e.value)) return build(tr.state, cx);
			if (tr.selection && !tr.state.field(mousedownField, false)) return build(tr.state, cx);
			return decos;
		},
		provide: (f) => EditorView.decorations.from(f),
	});
	const watcher = ViewPlugin.define((view) => {
		let timer = 0;
		const changed = () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				resolved.clear();
				view.dispatch({ effects: refresh.of(null) });
			}, 300);
		};
		const { vault } = host.app;
		const refs = ["create", "delete", "rename"].map((name) => vault.on(name, changed));
		return {
			destroy() {
				window.clearTimeout(timer);
				for (const ref of refs) vault.offref(ref);
			},
		};
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
	return [field, watcher, tagClicks];
}
