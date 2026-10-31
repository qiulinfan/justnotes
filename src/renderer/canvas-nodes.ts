// The items of a canvas: text, file, link and group nodes, and edges. Each
// keeps its data record (every field, known or not) and its own elements,
// with Obsidian's class names, so themes and snippets written for Obsidian's
// canvas apply.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { embeddedMarkdownExtensions } from "../api/editor-extensions";
import { Component } from "../api/events";
import { setIcon } from "../api/icons";
import { MarkdownRenderer } from "../api/markdown";
import { resolveSubpath } from "../api/metadata-utils";
import { TFile } from "../api/vault";
import { textChanges } from "../api/view";
import { type AllCanvasNodeData, type CanvasEdgeData, edgeGeometry, facingSides, type NodeSide, parseColor, type Point, type Rect, SIDES, sidePoint } from "./canvas-data";
import type { Canvas } from "./canvas-view";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif"]);
const AUDIO = new Set(["mp3", "wav", "m4a", "ogg", "3gp", "flac", "webm"]);
const VIDEO = new Set(["mp4", "webm", "ogv", "mov", "mkv"]);
const RESIZERS = ["top", "right", "bottom", "left", "top-left", "top-right", "bottom-left", "bottom-right"];

function applyColor(el: Element, color: unknown) {
	for (let i = 1; i <= 6; i++) el.classList.remove(`mod-canvas-color-${i}`);
	const parsed = parseColor(color);
	el.classList.toggle("is-themed", !!parsed);
	const style = (el as HTMLElement | SVGElement).style;
	style.removeProperty("--canvas-color");
	if (parsed && "preset" in parsed) el.classList.add(`mod-canvas-color-${parsed.preset}`);
	else if (parsed) style.setProperty("--canvas-color", parsed.rgb);
}

export abstract class CanvasNode {
	canvas: Canvas;
	id: string;
	x = 0;
	y = 0;
	width = 0;
	height = 0;
	color = "";
	nodeEl: HTMLElement;
	containerEl: HTMLElement;
	contentEl: HTMLElement;
	// The record as read: getData writes the known fields back into a copy,
	// so unknown ones survive in their places.
	#data: Record<string, any> = {};
	// What renders the content; replaced on each render.
	#child: Component | null = null;

	constructor(canvas: Canvas, data: AllCanvasNodeData) {
		this.canvas = canvas;
		this.id = data.id;
		this.nodeEl = createDiv("canvas-node");
		this.nodeEl.dataset.nodeId = data.id;
		this.containerEl = this.nodeEl.createDiv("canvas-node-container");
		this.contentEl = this.containerEl.createDiv("canvas-node-content");
		for (const dir of RESIZERS) this.nodeEl.createDiv({ cls: "canvas-node-resizer", attr: { "data-resize": dir } });
		for (const side of SIDES) this.nodeEl.createDiv({ cls: "canvas-node-connection-point", attr: { "data-side": side } }).createDiv("canvas-node-connection-point-inner");
	}

	abstract get type(): string;

	get app() {
		return this.canvas.app;
	}

	get sourcePath() {
		return this.canvas.view.file?.path ?? "";
	}

	getData(): AllCanvasNodeData {
		const out: Record<string, any> = { ...this.#data, id: this.id, type: this.type, ...this.fields(), x: this.x, y: this.y, width: this.width, height: this.height };
		if (this.color) out.color = this.color;
		else delete out.color;
		for (const [key, value] of Object.entries(out)) if (value === undefined) delete out[key];
		return out as AllCanvasNodeData;
	}

	// The fields of the node's type, in the order a new record lists them.
	protected abstract fields(): Record<string, unknown>;

	// Takes a record for this node: from the file, a merge or an undo.
	setData(data: AllCanvasNodeData) {
		const changed = JSON.stringify(data) !== JSON.stringify(this.getData());
		this.#data = { ...data };
		this.x = Number(data.x) || 0;
		this.y = Number(data.y) || 0;
		this.width = Math.max(1, Number(data.width) || 0);
		this.height = Math.max(1, Number(data.height) || 0);
		this.color = typeof data.color === "string" ? data.color : "";
		this.readFields(data);
		this.updatePosition();
		applyColor(this.nodeEl, this.color);
		if (changed || !this.#child) this.render();
	}

	protected abstract readFields(data: AllCanvasNodeData): void;

	getBBox(): Rect {
		return { x: this.x, y: this.y, width: this.width, height: this.height };
	}

	moveTo({ x, y }: Point) {
		this.x = Math.round(x);
		this.y = Math.round(y);
		this.updatePosition();
		this.canvas.onNodeMoved(this);
	}

	resize({ width, height }: { width: number; height: number }) {
		this.width = Math.round(width);
		this.height = Math.round(height);
		this.updatePosition();
		this.canvas.onNodeMoved(this);
	}

	setColor(color: string) {
		this.color = color;
		applyColor(this.nodeEl, color);
	}

	updatePosition() {
		const style = this.nodeEl.style;
		style.transform = `translate(${this.x}px, ${this.y}px)`;
		style.width = `${this.width}px`;
		style.height = `${this.height}px`;
	}

	// A fresh component for this render's content: the previous render's
	// children (embeds, plugin code blocks) unload with it.
	protected renderChild() {
		this.#child?.unload();
		this.#child = new Component();
		this.#child.load();
		return this.#child;
	}

	abstract render(): void;

	destroy() {
		this.#child?.unload();
		this.#child = null;
		this.nodeEl.remove();
	}

	protected renderMarkdown(text: string, el: HTMLElement, child: Component) {
		const view = el.createDiv("markdown-preview-view markdown-rendered node-insert-event");
		const sizer = view.createDiv("markdown-preview-sizer markdown-preview-section");
		MarkdownRenderer.render(this.app, text, sizer, this.sourcePath, child).catch((err) => console.error(err));
	}
}

export class CanvasTextNode extends CanvasNode {
	#text = "";
	#editor: EditorView | null = null;
	#textBefore = "";

	get type() {
		return "text";
	}

	get text() {
		return this.#text;
	}

	set text(text: string) {
		this.setText(text);
	}

	get isEditing() {
		return !!this.#editor;
	}

	protected fields() {
		return { text: this.#text };
	}

	protected readFields(data: AllCanvasNodeData) {
		const text = typeof data.text === "string" ? data.text : "";
		if (text !== this.#text) {
			this.#text = text;
			this.#syncEditor();
		}
	}

	// Obsidian's setText, which QuickAdd's capture calls before requestSave:
	// the card shows the new text at once, and it can be undone.
	setText(text: string) {
		if (text === this.#text) return;
		this.canvas.checkpoint();
		this.#text = text;
		if (this.#editor) this.#syncEditor();
		else this.render();
	}

	#syncEditor() {
		const cm = this.#editor;
		if (!cm) return;
		const changes = textChanges(cm.state.doc.toString(), this.#text);
		if (changes.length) cm.dispatch({ changes });
	}

	render() {
		if (this.#editor) return;
		const child = this.renderChild();
		this.contentEl.empty();
		this.contentEl.className = "canvas-node-content markdown-embed";
		this.renderMarkdown(this.#text, this.contentEl.createDiv("markdown-embed-content node-insert-event"), child);
	}

	// Edits the card's Markdown in place, in Live Preview.
	startEditing() {
		if (this.#editor) {
			this.#editor.focus();
			return;
		}
		this.canvas.checkpoint();
		this.#textBefore = this.#text;
		this.renderChild();
		this.contentEl.empty();
		this.nodeEl.addClass("is-editing", "is-focused");
		const host = this.contentEl.createDiv("markdown-source-view cm-s-obsidian mod-cm6 is-live-preview node-insert-event");
		const node = this;
		const cm = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: this.#text,
				extensions: [
					embeddedMarkdownExtensions({
						app: this.app,
						sourcePath: () => node.sourcePath,
						resolveImage: (link) => {
							const file = node.app.metadataCache.getFirstLinkpathDest(link, node.sourcePath);
							return file ? node.app.vault.getResourcePath(file) : null;
						},
					}),
					EditorView.updateListener.of((u) => {
						if (!u.docChanged || this.#editor !== u.view) return;
						this.#text = u.state.doc.toString();
						this.#fitHeight();
						this.canvas.requestSave();
					}),
					EditorView.domEventHandlers({
						blur: (evt) => {
							if (!this.nodeEl.contains(evt.relatedTarget as Node | null)) this.stopEditing();
							return false;
						},
					}),
				],
			}),
		});
		this.#editor = cm;
		this.canvas.editing = this;
		cm.focus();
		cm.dispatch({ selection: { anchor: cm.state.doc.length } });
	}

	// A card grows to show what is typed into it, as in Obsidian; it never
	// shrinks on its own.
	#fitHeight() {
		requestAnimationFrame(() => {
			const content = this.contentEl;
			const extra = content.scrollHeight - content.clientHeight;
			if (extra > 0 && this.#editor) this.resize({ width: this.width, height: this.height + extra });
		});
	}

	stopEditing() {
		const cm = this.#editor;
		if (!cm) return;
		this.#editor = null;
		if (this.canvas.editing === this) this.canvas.editing = null;
		cm.destroy();
		this.nodeEl.removeClass("is-editing", "is-focused");
		// An edit session that changed nothing leaves nothing to undo.
		if (this.#text === this.#textBefore) this.canvas.dropCheckpoint();
		this.render();
		this.canvas.wrapperEl.focus({ preventScroll: true });
	}

	destroy() {
		this.#editor?.destroy();
		this.#editor = null;
		super.destroy();
	}
}

export class CanvasFileNode extends CanvasNode {
	// The vault's file, or null when the path finds none.
	file: TFile | null = null;
	filePath = "";
	subpath = "";
	labelEl: HTMLElement;
	// The path the last render showed.
	shownPath = "";

	constructor(canvas: Canvas, data: AllCanvasNodeData) {
		super(canvas, data);
		this.labelEl = createDiv("canvas-node-label");
		this.nodeEl.prepend(this.labelEl);
		this.labelEl.addEventListener("click", (evt) => {
			if (this.file) this.app.workspace.getLeaf(evt.metaKey || evt.ctrlKey ? "tab" : false).openFile(this.file);
		});
	}

	get type() {
		return "file";
	}

	protected fields() {
		return { file: this.file?.path ?? this.filePath, subpath: this.subpath || undefined };
	}

	protected readFields(data: AllCanvasNodeData) {
		this.filePath = typeof data.file === "string" ? data.file : "";
		this.subpath = typeof data.subpath === "string" ? data.subpath : "";
		this.file = this.app.vault.getFileByPath(this.filePath);
	}

	render() {
		const child = this.renderChild();
		const file = this.file;
		const content = this.contentEl;
		content.empty();
		this.shownPath = file?.path ?? this.filePath;
		this.labelEl.setText(file ? `${file.basename}${this.subpath}` : this.filePath);
		content.className = "canvas-node-content";
		if (!file) {
			content.addClass("canvas-node-placeholder");
			content.createDiv({ cls: "canvas-node-placeholder-text", text: `File not found: ${this.filePath}` });
			return;
		}
		const ext = file.extension.toLowerCase();
		const src = this.app.vault.getResourcePath(file);
		if (ext === "md") {
			content.addClass("markdown-embed");
			const el = content.createDiv("markdown-embed-content node-insert-event");
			this.#renderNote(file, el, child).catch((err) => console.error(err));
		} else if (IMAGE.has(ext)) {
			content.addClass("image-embed");
			content.createEl("img", { attr: { src, alt: file.name, draggable: "false" } });
		} else if (VIDEO.has(ext)) {
			content.addClass("media-embed");
			content.createEl("video", { attr: { src, controls: true } });
		} else if (AUDIO.has(ext)) {
			content.addClass("media-embed");
			content.createEl("audio", { attr: { src, controls: true } });
		} else {
			content.addClass("canvas-file-card");
			setIcon(content.createDiv("canvas-file-card-icon"), "file");
			content.createDiv({ cls: "canvas-file-card-name", text: file.name });
		}
	}

	async #renderNote(file: TFile, el: HTMLElement, child: Component) {
		let text = await this.app.vault.cachedRead(file);
		if (this.subpath) {
			const cache = this.app.metadataCache.getFileCache(file);
			const found = cache && resolveSubpath(cache, this.subpath);
			if (found) text = text.slice(found.start.offset, found.end?.offset ?? text.length);
		}
		// A newer render replaced this one meanwhile.
		if (!child._loaded) return;
		this.renderMarkdown(text, el, child);
	}

	// Opens the file: a note in a tab, other files as the vault opens them.
	open(newLeaf: boolean) {
		if (!this.file) return;
		this.app.workspace.getLeaf(newLeaf ? "tab" : false).openFile(this.file, { eState: this.subpath ? { subpath: this.subpath } : undefined });
	}
}

export class CanvasLinkNode extends CanvasNode {
	url = "";

	get type() {
		return "link";
	}

	protected fields() {
		return { url: this.url };
	}

	protected readFields(data: AllCanvasNodeData) {
		this.url = typeof data.url === "string" ? data.url : "";
	}

	// A card, not the page: a web page inside the vault window would run with
	// the app's privileges in reach.
	render() {
		this.renderChild();
		const content = this.contentEl;
		content.empty();
		content.className = "canvas-node-content canvas-link-card";
		setIcon(content.createDiv("canvas-link-card-icon"), "globe");
		let host = this.url;
		try {
			host = new URL(this.url).host || this.url;
		} catch {}
		content.createDiv({ cls: "canvas-link-card-host", text: host });
		content.createEl("a", { cls: "external-link canvas-link-card-url", text: this.url, attr: { href: this.url, target: "_blank", rel: "noopener" } });
	}

	open() {
		if (this.url) window.open(this.url, "_blank");
	}
}

export class CanvasGroupNode extends CanvasNode {
	label = "";
	labelEl: HTMLElement;

	constructor(canvas: Canvas, data: AllCanvasNodeData) {
		super(canvas, data);
		this.nodeEl.addClass("canvas-node-group");
		this.labelEl = createDiv("canvas-group-label");
		this.nodeEl.prepend(this.labelEl);
	}

	get type() {
		return "group";
	}

	protected fields() {
		return { label: this.label || undefined };
	}

	protected readFields(data: AllCanvasNodeData) {
		this.label = typeof data.label === "string" ? data.label : "";
	}

	setLabel(label: string) {
		this.label = label;
		this.render();
	}

	render() {
		this.renderChild();
		this.labelEl.setText(this.label);
		this.labelEl.toggle(!!this.label);
		const data = this.getData();
		const style = this.contentEl.style;
		this.contentEl.className = "canvas-node-content";
		const file = typeof data.background === "string" ? this.app.vault.getFileByPath(data.background) : null;
		if (!file) {
			style.backgroundImage = "";
			return;
		}
		const mode = data.backgroundStyle ?? "cover";
		style.backgroundImage = `url("${this.app.vault.getResourcePath(file)}")`;
		style.backgroundSize = mode === "ratio" ? "contain" : mode === "repeat" ? "auto" : "cover";
		style.backgroundRepeat = mode === "repeat" ? "repeat" : "no-repeat";
		style.backgroundPosition = "center";
	}
}

export function createNode(canvas: Canvas, data: AllCanvasNodeData): CanvasNode {
	const node =
		data.type === "file" ? new CanvasFileNode(canvas, data) : data.type === "link" ? new CanvasLinkNode(canvas, data) : data.type === "group" ? new CanvasGroupNode(canvas, data) : new CanvasTextNode(canvas, data);
	node.setData(data);
	return node;
}

const SVG = "http://www.w3.org/2000/svg";

export interface EdgeEnd {
	node: CanvasNode;
	side?: NodeSide;
	end: "none" | "arrow";
}

export class CanvasEdge {
	canvas: Canvas;
	id: string;
	from!: EdgeEnd;
	to!: EdgeEnd;
	color = "";
	label = "";
	#data: Record<string, any> = {};
	lineGroupEl: SVGGElement;
	pathEl: SVGPathElement;
	interactionEl: SVGPathElement;
	fromLineEndEl: SVGPolygonElement;
	toLineEndEl: SVGPolygonElement;
	labelElement: HTMLElement;
	labelEl: HTMLElement;

	constructor(canvas: Canvas, data: CanvasEdgeData, from: CanvasNode, to: CanvasNode) {
		this.canvas = canvas;
		this.id = data.id;
		this.lineGroupEl = document.createElementNS(SVG, "g");
		this.lineGroupEl.classList.add("canvas-path");
		this.lineGroupEl.dataset.edgeId = data.id;
		this.pathEl = this.lineGroupEl.appendChild(document.createElementNS(SVG, "path"));
		this.pathEl.classList.add("canvas-display-path");
		this.interactionEl = this.lineGroupEl.appendChild(document.createElementNS(SVG, "path"));
		this.interactionEl.classList.add("canvas-interaction-path");
		this.fromLineEndEl = this.lineGroupEl.appendChild(document.createElementNS(SVG, "polygon"));
		this.toLineEndEl = this.lineGroupEl.appendChild(document.createElementNS(SVG, "polygon"));
		for (const el of [this.fromLineEndEl, this.toLineEndEl]) el.classList.add("canvas-path-end");
		this.labelElement = createDiv("canvas-path-label-wrapper");
		this.labelElement.dataset.edgeId = data.id;
		this.labelEl = this.labelElement.createDiv("canvas-path-label");
		this.setData(data, from, to);
	}

	setData(data: CanvasEdgeData, from: CanvasNode, to: CanvasNode) {
		this.#data = { ...data };
		const side = (s: unknown) => (SIDES.includes(s as NodeSide) ? (s as NodeSide) : undefined);
		this.from = { node: from, side: side(data.fromSide), end: data.fromEnd === "arrow" ? "arrow" : "none" };
		this.to = { node: to, side: side(data.toSide), end: data.toEnd === "none" ? "none" : "arrow" };
		this.color = typeof data.color === "string" ? data.color : "";
		this.label = typeof data.label === "string" ? data.label : "";
		this.render();
	}

	getData(): CanvasEdgeData {
		const out: Record<string, any> = {
			...this.#data,
			id: this.id,
			fromNode: this.from.node.id,
			fromSide: this.from.side,
			fromEnd: this.from.end === "arrow" ? "arrow" : this.#data.fromEnd === "none" ? "none" : undefined,
			toNode: this.to.node.id,
			toSide: this.to.side,
			toEnd: this.to.end === "none" ? "none" : this.#data.toEnd === "arrow" ? "arrow" : undefined,
			color: this.color || undefined,
			label: this.label || undefined,
		};
		for (const [key, value] of Object.entries(out)) if (value === undefined) delete out[key];
		return out as CanvasEdgeData;
	}

	setColor(color: string) {
		this.color = color;
		this.render();
	}

	setLabel(label: string) {
		this.label = label;
		this.render();
	}

	render() {
		const [a, b] = [this.from.node.getBBox(), this.to.node.getBBox()];
		const [autoFrom, autoTo] = facingSides(a, b);
		const fromSide = this.from.side ?? autoFrom;
		const toSide = this.to.side ?? autoTo;
		const geometry = edgeGeometry(sidePoint(a, fromSide), fromSide, sidePoint(b, toSide), toSide, { from: this.from.end === "arrow", to: this.to.end === "arrow" });
		this.pathEl.setAttribute("d", geometry.path);
		this.interactionEl.setAttribute("d", geometry.path);
		this.fromLineEndEl.setAttribute("points", geometry.fromArrow ?? "");
		this.toLineEndEl.setAttribute("points", geometry.toArrow ?? "");
		this.fromLineEndEl.style.display = geometry.fromArrow ? "" : "none";
		this.toLineEndEl.style.display = geometry.toArrow ? "" : "none";
		applyColor(this.lineGroupEl, this.color);
		applyColor(this.labelElement, this.color);
		this.labelEl.setText(this.label);
		this.labelElement.toggle(!!this.label);
		this.labelElement.style.transform = `translate(${geometry.middle.x}px, ${geometry.middle.y}px) translate(-50%, -50%)`;
	}

	destroy() {
		this.lineGroupEl.remove();
		this.labelElement.remove();
	}
}
