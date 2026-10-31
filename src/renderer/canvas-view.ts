import type { CorePluginHost } from "../api/internal-plugins";
// The canvas core plugin: the view of .canvas files (JSON Canvas), with
// Obsidian's `view.canvas` object that plugins reach for (QuickAdd's capture
// reads `canvas.selection`, a node's `text` and `file`, calls `setText`,
// `getData` and `requestSave`), and its commands and menus.
import type { App } from "../api/app";
import { importFile } from "../api/attachments";
import { DragManager } from "../api/drag-manager";
import { setIcon, setTooltip } from "../api/icons";
import { Scope } from "../api/keymap";
import { parseLinktext } from "../api/metadata-utils";
import { Menu } from "../api/ui/menu";
import { Modal } from "../api/ui/modal";
import { Notice } from "../api/ui/notice";
import { FuzzySuggestModal } from "../api/ui/suggest";
import { type TAbstractFile, TFile, TFolder } from "../api/vault";
import { mergeWith, TextFileView, type ViewStateResult } from "../api/view";
import type { WorkspaceLeaf } from "../api/workspace";
import {
	type AllCanvasNodeData,
	boundingBox,
	type CanvasData,
	type CanvasEdgeData,
	edgeGeometry,
	facingSides,
	intersects,
	contains,
	dropLayout,
	fitSize,
	mergeCanvas,
	nearestSide,
	type NodeSide,
	parseCanvas,
	type Point,
	randomId,
	readViewport,
	type Rect,
	renameInCanvas,
	type Size,
	sidePoint,
	stringifyCanvas,
	type Viewport,
} from "./canvas-data";
import { AUDIO, CanvasEdge, CanvasFileNode, CanvasGroupNode, CanvasLinkNode, type CanvasNode, CanvasTextNode, createNode, IMAGE, VIDEO } from "./canvas-nodes";

export { CanvasEdge, CanvasFileNode, CanvasGroupNode, CanvasLinkNode, type CanvasNode, CanvasTextNode };

const NEW_CANVAS = "{}";
const TEXT_SIZE = { width: 250, height: 60 };
const FILE_SIZE = { width: 400, height: 400 };
const AUDIO_SIZE = { width: 400, height: 100 };
const MIN_SIZE = { width: 50, height: 30 };
const GRID = 20;
const MIN_ZOOM = -3.3;
const MAX_ZOOM = 1;
const HISTORY = 100;
const COLORS: [string, string][] = [
	["1", "Red"],
	["2", "Orange"],
	["3", "Yellow"],
	["4", "Green"],
	["5", "Cyan"],
	["6", "Purple"],
];
const MEDIA = new Set(["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif", "mp3", "wav", "m4a", "ogg", "flac", "mp4", "webm", "ogv", "mov", "mkv", "pdf"]);
const SVG = "http://www.w3.org/2000/svg";
// What a button of the card menu carries when dragged onto the canvas.
const CARD_TYPE = "application/x-justnotes-canvas-card";
const URL_ONLY = /^[a-z][\w+.-]*:\/\/\S+$/i;

type Item = CanvasNode | CanvasEdge;

type Drag =
	| { kind: "pan"; client: Point; x: number; y: number; moved: boolean }
	| { kind: "move"; client: Point; start: Point; items: { node: CanvasNode; x: number; y: number }[]; moved: boolean; reselect: CanvasNode | null }
	| { kind: "resize"; client: Point; start: Point; node: CanvasNode; dir: string; rect: Rect; moved: boolean }
	| { kind: "connect"; client: Point; node: CanvasNode; side: NodeSide; el: SVGGElement; moved: boolean }
	| { kind: "select"; client: Point; start: Point; base: Set<Item>; moved: boolean };

// The canvas of one view: its items, selection, viewport and undo history.
// Member names follow Obsidian's canvas where plugins read them.
export class Canvas {
	view: CanvasView;
	app: App;
	nodes = new Map<string, CanvasNode>();
	edges = new Map<string, CanvasEdge>();
	selection = new Set<Item>();
	// The text node whose Markdown is being edited.
	editing: CanvasTextNode | null = null;
	// The viewport: the canvas point at the middle of the view, and the zoom
	// level as a power of two.
	x = 0;
	y = 0;
	zoom = 0;
	wrapperEl: HTMLElement;
	backgroundEl: HTMLElement;
	canvasEl: HTMLElement;
	edgesEl: SVGSVGElement;
	selectionEl: HTMLElement;
	messageEl: HTMLElement;
	// The file's top-level fields other than nodes and edges.
	#extra: Record<string, unknown> = {};
	#undo: string[] = [];
	#redo: string[] = [];
	#drag: Drag | null = null;
	#space = false;
	#fitPending = false;
	// A viewport from the leaf's state, shown instead of fitting when the
	// file it belongs to loads.
	pendingViewport: Viewport | null = null;

	constructor(view: CanvasView) {
		this.view = view;
		this.app = view.app;
		this.wrapperEl = view.contentEl.createDiv({ cls: "canvas-wrapper", attr: { tabindex: "-1" } });
		this.backgroundEl = this.wrapperEl.createDiv("canvas-background");
		this.canvasEl = this.wrapperEl.createDiv("canvas");
		this.edgesEl = this.canvasEl.appendChild(document.createElementNS(SVG, "svg"));
		this.edgesEl.classList.add("canvas-edges");
		this.selectionEl = this.canvasEl.createDiv("canvas-selection");
		this.selectionEl.hide();
		this.messageEl = this.wrapperEl.createDiv("canvas-message");
		this.messageEl.hide();
		this.#buildControls();
		this.#buildCardMenu();
		this.wrapperEl.addEventListener("pointerdown", (evt) => this.#onPointerDown(evt));
		this.wrapperEl.addEventListener("dblclick", (evt) => this.#onDoubleClick(evt));
		this.wrapperEl.addEventListener("wheel", (evt) => this.#onWheel(evt), { passive: false });
		this.wrapperEl.addEventListener("contextmenu", (evt) => this.#onContextMenu(evt));
		this.wrapperEl.addEventListener("dragover", (evt) => this.#onDragOver(evt));
		this.wrapperEl.addEventListener("drop", (evt) => this.#onDrop(evt));
		// Focusing a card's editor near the edge would scroll the wrapper; the
		// viewport alone places the canvas.
		this.wrapperEl.addEventListener("scroll", () => {
			this.wrapperEl.scrollTop = 0;
			this.wrapperEl.scrollLeft = 0;
		});
		this.wrapperEl.addEventListener("keydown", (evt) => {
			if (evt.code === "Space" && !this.editing && !this.#isTyping(evt)) {
				this.#space = true;
				this.wrapperEl.addClass("is-space-held");
				evt.preventDefault();
			}
		});
		this.wrapperEl.addEventListener("keyup", (evt) => {
			if (evt.code === "Space") {
				this.#space = false;
				this.wrapperEl.removeClass("is-space-held");
			}
		});
		this.applyTransform();
	}

	get scale() {
		return 2 ** this.zoom;
	}

	#isTyping(evt: Event) {
		const el = evt.target as HTMLElement;
		return el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
	}

	// ---- data ----

	getData(): CanvasData {
		return { nodes: [...this.nodes.values()].map((n) => n.getData()), edges: [...this.edges.values()].map((e) => e.getData()), ...this.#extra } as CanvasData;
	}

	setData(data: CanvasData) {
		this.importData(data, false);
	}

	// Shows `data`. Items already shown with the same id are updated in place
	// (a plugin holding a node keeps a live one); `clear` (another file) also
	// resets the viewport and the undo history.
	importData(data: CanvasData, clear: boolean) {
		const { nodes, edges, ...extra } = data;
		this.#extra = extra;
		if (clear) {
			this.clear();
			this.#undo = [];
			this.#redo = [];
		}
		const nextNodes = new Map<string, CanvasNode>();
		for (const d of nodes) {
			if (nextNodes.has(d.id)) continue;
			const old = this.nodes.get(d.id);
			let node: CanvasNode;
			if (old && old.type === (d.type === "file" || d.type === "link" || d.type === "group" ? d.type : "text")) {
				old.setData(d);
				node = old;
			} else {
				old?.destroy();
				node = createNode(this, d);
			}
			nextNodes.set(d.id, node);
		}
		for (const [id, node] of this.nodes) {
			if (!nextNodes.has(id)) {
				this.selection.delete(node);
				node.destroy();
			}
		}
		this.nodes = nextNodes;
		const nextEdges = new Map<string, CanvasEdge>();
		for (const d of edges) {
			const from = this.nodes.get(d.fromNode);
			const to = this.nodes.get(d.toNode);
			if (!from || !to || nextEdges.has(d.id)) continue;
			const old = this.edges.get(d.id);
			if (old) old.setData(d, from, to);
			nextEdges.set(d.id, old ?? new CanvasEdge(this, d, from, to));
		}
		for (const [id, edge] of this.edges) {
			if (!nextEdges.has(id)) {
				this.selection.delete(edge);
				edge.destroy();
			}
		}
		this.edges = nextEdges;
		this.#placeElements();
		this.#markSelection();
		if (clear) {
			const viewport = this.pendingViewport;
			this.pendingViewport = null;
			if (viewport) this.setViewport(viewport.x, viewport.y, viewport.zoom);
			else this.zoomToFit();
		}
	}

	// Groups lie under the edges, which lie under the other nodes; within each
	// layer the file's order is the stacking order.
	#placeElements() {
		const groups = [...this.nodes.values()].filter((n) => n instanceof CanvasGroupNode);
		const others = [...this.nodes.values()].filter((n) => !(n instanceof CanvasGroupNode));
		this.canvasEl.insertBefore(this.edgesEl, this.canvasEl.firstChild);
		for (const node of groups) this.canvasEl.insertBefore(node.nodeEl, this.edgesEl);
		for (const node of others) this.canvasEl.appendChild(node.nodeEl);
		for (const edge of this.edges.values()) {
			this.edgesEl.appendChild(edge.lineGroupEl);
			this.canvasEl.appendChild(edge.labelElement);
		}
		this.canvasEl.appendChild(this.selectionEl);
	}

	clear() {
		this.editing?.stopEditing();
		for (const node of this.nodes.values()) node.destroy();
		for (const edge of this.edges.values()) edge.destroy();
		this.nodes.clear();
		this.edges.clear();
		this.selection.clear();
	}

	// The canvas changed: the view saves it like any text file view.
	requestSave() {
		this.view.onCanvasChange();
	}

	// ---- undo ----

	// Records the canvas as it is before a change, for undo.
	checkpoint() {
		this.#undo.push(stringifyCanvas(this.getData()));
		if (this.#undo.length > HISTORY) this.#undo.shift();
		this.#redo = [];
	}

	dropCheckpoint() {
		this.#undo.pop();
	}

	undo() {
		this.#step(this.#undo, this.#redo);
	}

	redo() {
		this.#step(this.#redo, this.#undo);
	}

	#step(from: string[], to: string[]) {
		this.editing?.stopEditing();
		const text = from.pop();
		if (text === undefined) return;
		to.push(stringifyCanvas(this.getData()));
		this.importData(parseCanvas(text), false);
		this.requestSave();
	}

	// ---- items ----

	addNode(data: AllCanvasNodeData, save = true): CanvasNode {
		this.checkpoint();
		const node = createNode(this, data);
		this.nodes.set(node.id, node);
		this.#placeElements();
		if (save) this.requestSave();
		return node;
	}

	createTextNode({ pos, size = TEXT_SIZE, text = "", focus = false, save = true }: { pos: Point; size?: { width: number; height: number }; text?: string; focus?: boolean; save?: boolean }) {
		const node = this.addNode({ id: randomId(), type: "text", text, x: Math.round(pos.x), y: Math.round(pos.y), width: size.width, height: size.height }, save) as CanvasTextNode;
		if (focus) {
			this.selectOnly(node);
			node.startEditing();
		}
		return node;
	}

	createFileNode({ file, subpath, pos, size = FILE_SIZE, save = true }: { file: TFile; subpath?: string; pos: Point; size?: { width: number; height: number }; save?: boolean }) {
		const data: AllCanvasNodeData = { id: randomId(), type: "file", file: file.path, x: Math.round(pos.x), y: Math.round(pos.y), width: size.width, height: size.height };
		if (subpath) data.subpath = subpath;
		return this.addNode(data, save) as CanvasFileNode;
	}

	createGroupNode({ pos, size, label, save = true }: { pos: Point; size: { width: number; height: number }; label?: string; save?: boolean }) {
		const data: AllCanvasNodeData = { id: randomId(), type: "group", x: Math.round(pos.x), y: Math.round(pos.y), width: Math.round(size.width), height: Math.round(size.height) };
		if (label) data.label = label;
		return this.addNode(data, save) as CanvasGroupNode;
	}

	addEdge(data: CanvasEdgeData) {
		const from = this.nodes.get(data.fromNode);
		const to = this.nodes.get(data.toNode);
		if (!from || !to) return null;
		this.checkpoint();
		const edge = new CanvasEdge(this, data, from, to);
		this.edges.set(edge.id, edge);
		this.#placeElements();
		this.requestSave();
		return edge;
	}

	removeNode(node: CanvasNode) {
		if (this.editing === node) this.editing.stopEditing();
		for (const edge of [...this.edges.values()]) if (edge.from.node === node || edge.to.node === node) this.removeEdge(edge);
		this.selection.delete(node);
		this.nodes.delete(node.id);
		node.destroy();
	}

	removeEdge(edge: CanvasEdge) {
		this.selection.delete(edge);
		this.edges.delete(edge.id);
		edge.destroy();
	}

	deleteSelection() {
		if (!this.selection.size) return;
		this.checkpoint();
		for (const item of [...this.selection]) {
			if (item instanceof CanvasEdge) this.removeEdge(item);
			else this.removeNode(item);
		}
		this.requestSave();
	}

	onNodeMoved(node: CanvasNode) {
		for (const edge of this.edges.values()) if (edge.from.node === node || edge.to.node === node) edge.render();
	}

	// The topmost node at a canvas point; groups only where no other node is.
	nodeAt(pos: Point, except?: CanvasNode): CanvasNode | null {
		const at = (n: CanvasNode) => n !== except && pos.x >= n.x && pos.x <= n.x + n.width && pos.y >= n.y && pos.y <= n.y + n.height;
		const all = [...this.nodes.values()].reverse();
		return all.find((n) => !(n instanceof CanvasGroupNode) && at(n)) ?? all.find(at) ?? null;
	}

	// Selecting a card moves it to the front, as in Obsidian: last in its layer
	// (groups stay under the other cards) and last in the file's node list,
	// which the next save writes. Cards already in front are not moved, so a
	// click on one leaves its element (a playing video) alone.
	bringToFront(nodes: CanvasNode[]) {
		const all = [...this.nodes.values()];
		const raise = all.filter((n) => nodes.includes(n));
		const inFront = (layer: CanvasNode[]) => {
			const moved = layer.filter((n) => raise.includes(n));
			return moved.every((n, i) => layer[layer.length - moved.length + i] === n);
		};
		const groups = all.filter((n) => n instanceof CanvasGroupNode);
		const others = all.filter((n) => !(n instanceof CanvasGroupNode));
		if (inFront(groups) && inFront(others)) return;
		for (const node of raise) {
			this.nodes.delete(node.id);
			this.nodes.set(node.id, node);
			const before = node instanceof CanvasGroupNode ? this.edgesEl : ([...this.edges.values()][0]?.labelElement ?? this.selectionEl);
			this.canvasEl.insertBefore(node.nodeEl, before);
		}
	}

	// Moving a group moves what lies inside it.
	#withContents(nodes: CanvasNode[]) {
		const out = new Set(nodes);
		for (const group of nodes) {
			if (!(group instanceof CanvasGroupNode)) continue;
			for (const node of this.nodes.values()) if (node !== group && contains(group.getBBox(), node.getBBox())) out.add(node);
		}
		return [...out];
	}

	// Called for every vault file event the view hears: file nodes find their
	// files again and notes they show render anew.
	refreshFiles(changed?: TFile) {
		for (const node of this.nodes.values()) {
			if (!(node instanceof CanvasFileNode)) continue;
			const file = this.app.vault.getFileByPath(node.file?.path ?? node.filePath);
			// The vault renames a TFile in place: a renamed file is the same
			// object under a new path.
			if (file !== node.file || (changed && file === changed) || node.shownPath !== (file?.path ?? node.filePath)) {
				node.file = file;
				if (file) node.filePath = file.path;
				node.render();
			}
		}
	}

	// ---- selection ----

	select(item: Item) {
		this.selection.add(item);
		this.#markSelection();
	}

	deselect(item: Item) {
		this.selection.delete(item);
		this.#markSelection();
	}

	selectOnly(item: Item) {
		this.selection = new Set([item]);
		this.#markSelection();
	}

	deselectAll() {
		if (!this.selection.size) return;
		this.selection = new Set();
		this.#markSelection();
	}

	selectAll() {
		this.selection = new Set([...this.nodes.values(), ...this.edges.values()]);
		this.#markSelection();
	}

	#markSelection() {
		for (const node of this.nodes.values()) node.nodeEl.toggleClass("is-selected", this.selection.has(node));
		for (const edge of this.edges.values()) {
			edge.lineGroupEl.classList.toggle("is-selected", this.selection.has(edge));
			edge.labelElement.toggleClass("is-selected", this.selection.has(edge));
		}
		this.wrapperEl.toggleClass("has-single-selection", this.selection.size === 1);
	}

	// ---- viewport ----

	applyTransform() {
		const s = this.scale;
		const w = this.wrapperEl.clientWidth;
		const h = this.wrapperEl.clientHeight;
		const tx = w / 2 - this.x * s;
		const ty = h / 2 - this.y * s;
		this.canvasEl.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
		const step = GRID * s;
		this.backgroundEl.style.backgroundSize = `${step}px ${step}px`;
		this.backgroundEl.style.backgroundPosition = `${tx}px ${ty}px`;
		this.backgroundEl.toggleClass("is-hidden", step < 6);
		this.wrapperEl.style.setProperty("--zoom-multiplier", String(1 / s));
	}

	// The canvas point under a mouse event.
	posFromEvt(evt: { clientX: number; clientY: number }): Point {
		const r = this.wrapperEl.getBoundingClientRect();
		const s = this.scale;
		return { x: (evt.clientX - r.left - r.width / 2) / s + this.x, y: (evt.clientY - r.top - r.height / 2) / s + this.y };
	}

	setViewport(x: number, y: number, zoom: number) {
		this.x = x;
		this.y = y;
		this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
		this.applyTransform();
		this.view.onViewportChange();
	}

	getViewport(): Viewport {
		return { x: this.x, y: this.y, zoom: this.zoom };
	}

	// Zooms by `delta` levels keeping the canvas point under `around` (client
	// coordinates; the middle of the view by default) in place.
	zoomBy(delta: number, around?: { clientX: number; clientY: number }) {
		const r = this.wrapperEl.getBoundingClientRect();
		const client = around ?? { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
		const p = this.posFromEvt(client);
		this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom + delta));
		const s = this.scale;
		this.x = p.x - (client.clientX - r.left - r.width / 2) / s;
		this.y = p.y - (client.clientY - r.top - r.height / 2) / s;
		this.applyTransform();
		this.view.onViewportChange();
	}

	zoomToBbox(box: Rect) {
		const w = this.wrapperEl.clientWidth;
		const h = this.wrapperEl.clientHeight;
		if (!w || !h) {
			this.#fitPending = true;
			return;
		}
		const pad = 60;
		const s = Math.min((w - pad * 2) / Math.max(box.width, 1), (h - pad * 2) / Math.max(box.height, 1), 1);
		this.setViewport(box.x + box.width / 2, box.y + box.height / 2, Math.log2(Math.max(s, 2 ** MIN_ZOOM)));
	}

	zoomToFit() {
		const box = boundingBox([...this.nodes.values()].map((n) => n.getBBox()));
		if (box) this.zoomToBbox(box);
		else if (!this.wrapperEl.clientWidth) this.#fitPending = true;
		else this.setViewport(0, 0, 0);
	}

	zoomToSelection() {
		const box = boundingBox([...this.selection].filter((i): i is CanvasNode => !(i instanceof CanvasEdge)).map((n) => n.getBBox()));
		if (box) this.zoomToBbox(box);
	}

	onResize() {
		if (this.#fitPending && this.wrapperEl.clientWidth) {
			this.#fitPending = false;
			this.zoomToFit();
		} else this.applyTransform();
	}

	// The middle of the view, where cards added from the menus go.
	#centered(size: { width: number; height: number }): Point {
		return { x: this.x - size.width / 2, y: this.y - size.height / 2 };
	}

	// ---- controls ----

	#buildControls() {
		const controls = this.wrapperEl.createDiv("canvas-controls");
		const group = () => controls.createDiv("canvas-control-group");
		const item = (parent: HTMLElement, icon: string, title: string, run: () => void) => {
			const el = parent.createDiv({ cls: "canvas-control-item", attr: { "aria-label": title } });
			setIcon(el, icon);
			setTooltip(el, title, { placement: "left" });
			el.addEventListener("click", () => run());
			el.addEventListener("pointerdown", (evt) => evt.stopPropagation());
			el.addEventListener("dblclick", (evt) => evt.stopPropagation());
		};
		const zoom = group();
		item(zoom, "plus", "Zoom in", () => this.zoomBy(0.5));
		item(zoom, "rotate-ccw", "Reset zoom", () => this.setViewport(this.x, this.y, 0));
		item(zoom, "maximize", "Zoom to fit", () => this.zoomToFit());
		item(zoom, "minus", "Zoom out", () => this.zoomBy(-0.5));
		const history = group();
		item(history, "undo-2", "Undo", () => this.undo());
		item(history, "redo-2", "Redo", () => this.redo());
	}

	#buildCardMenu() {
		const menu = this.wrapperEl.createDiv("canvas-card-menu");
		// A button adds its card in the middle of the view, or, dragged onto
		// the canvas, where it is dropped.
		const button = (kind: string, icon: string, title: string) => {
			const el = menu.createDiv({ cls: "canvas-card-menu-button", attr: { "aria-label": title, draggable: "true" } });
			setIcon(el, icon);
			setTooltip(el, title, { placement: "top" });
			el.addEventListener("click", () => this.#addCard(kind));
			el.addEventListener("pointerdown", (evt) => evt.stopPropagation());
			el.addEventListener("dblclick", (evt) => evt.stopPropagation());
			el.addEventListener("dragstart", (evt) => {
				if (!evt.dataTransfer) return;
				evt.dataTransfer.setData(CARD_TYPE, kind);
				evt.dataTransfer.effectAllowed = "copy";
			});
		};
		button("text", "sticky-note", "Add card");
		button("note", "file-text", "Add note from vault");
		button("media", "image", "Add media from vault");
	}

	// A card of the menu's `kind`, centred on `at` (else the middle of the view).
	#addCard(kind: string, at?: Point) {
		if (kind === "note") this.#pickFile((f) => f.extension === "md", at);
		else if (kind === "media") this.#pickFile((f) => MEDIA.has(f.extension.toLowerCase()), at);
		else this.createTextNode({ pos: at ? { x: at.x - TEXT_SIZE.width / 2, y: at.y - TEXT_SIZE.height / 2 } : this.#centered(TEXT_SIZE), focus: true });
	}

	#pickFile(filter: (file: TFile) => boolean, at?: Point) {
		new FilePickModal(this.app, filter, (file) => {
			const pos = at ? { x: at.x - FILE_SIZE.width / 2, y: at.y - FILE_SIZE.height / 2 } : this.#centered(FILE_SIZE);
			this.selectOnly(this.createFileNode({ file, pos }));
		}).open();
	}

	// ---- pointer ----

	#onPointerDown(evt: PointerEvent) {
		if (this.view.broken) return;
		const target = evt.target as HTMLElement;
		if (this.editing?.nodeEl.contains(target) && !target.closest(".canvas-node-resizer, .canvas-node-connection-point")) return;
		if (!target.closest(".canvas-controls, .canvas-card-menu")) this.wrapperEl.focus({ preventScroll: true });
		const client = { x: evt.clientX, y: evt.clientY };
		if (evt.button === 1 || (evt.button === 0 && this.#space)) {
			evt.preventDefault();
			this.#startDrag({ kind: "pan", client, x: this.x, y: this.y, moved: false });
			return;
		}
		if (evt.button !== 0) return;
		const pos = this.posFromEvt(evt);
		const nodeEl = target.closest<HTMLElement>(".canvas-node");
		const node = nodeEl ? (this.nodes.get(nodeEl.dataset.nodeId ?? "") ?? null) : null;
		const resizer = target.closest<HTMLElement>(".canvas-node-resizer");
		if (node && resizer) {
			evt.preventDefault();
			this.selectOnly(node);
			this.#startDrag({ kind: "resize", client, start: pos, node, dir: resizer.dataset.resize ?? "bottom-right", rect: node.getBBox(), moved: false });
			return;
		}
		const point = target.closest<HTMLElement>(".canvas-node-connection-point");
		if (node && point) {
			evt.preventDefault();
			const el = this.edgesEl.appendChild(document.createElementNS(SVG, "g"));
			el.classList.add("canvas-path", "is-creating");
			el.appendChild(document.createElementNS(SVG, "path")).classList.add("canvas-display-path");
			el.appendChild(document.createElementNS(SVG, "polygon")).classList.add("canvas-path-end");
			this.#startDrag({ kind: "connect", client, node, side: point.dataset.side as NodeSide, el, moved: false });
			return;
		}
		if (node) {
			let reselect: CanvasNode | null = null;
			if (evt.shiftKey) {
				if (this.selection.has(node)) {
					this.deselect(node);
					return;
				}
				this.select(node);
			} else if (!this.selection.has(node)) this.selectOnly(node);
			else reselect = node;
			this.bringToFront([...this.selection].filter((i): i is CanvasNode => !(i instanceof CanvasEdge)));
			// Text inside a card is not selected by dragging it.
			if (!target.closest("input, textarea, video, audio")) evt.preventDefault();
			const nodes = this.#withContents([...this.selection].filter((i): i is CanvasNode => !(i instanceof CanvasEdge)));
			this.#startDrag({ kind: "move", client, start: pos, items: nodes.map((n) => ({ node: n, x: n.x, y: n.y })), moved: false, reselect });
			return;
		}
		const edgeEl = target.closest<Element>("[data-edge-id]");
		const edge = edgeEl ? this.edges.get((edgeEl as HTMLElement).dataset.edgeId ?? "") : undefined;
		if (edge) {
			if (evt.shiftKey) this.selection.has(edge) ? this.deselect(edge) : this.select(edge);
			else this.selectOnly(edge);
			return;
		}
		if (target.closest(".canvas-controls, .canvas-card-menu")) return;
		evt.preventDefault();
		if (!evt.shiftKey) this.deselectAll();
		this.#startDrag({ kind: "select", client, start: pos, base: new Set(this.selection), moved: false });
	}

	#startDrag(drag: Drag) {
		this.#drag = drag;
		const doc = this.wrapperEl.doc;
		const move = (evt: PointerEvent) => this.#onDragMove(evt);
		const end = (evt: PointerEvent) => {
			doc.removeEventListener("pointermove", move);
			doc.removeEventListener("pointerup", end);
			doc.removeEventListener("pointercancel", end);
			this.#onDragEnd(evt);
		};
		doc.addEventListener("pointermove", move);
		doc.addEventListener("pointerup", end);
		doc.addEventListener("pointercancel", end);
		this.wrapperEl.addClass("is-dragging");
	}

	#onDragMove(evt: PointerEvent) {
		const drag = this.#drag;
		if (!drag) return;
		if (!drag.moved) {
			if (Math.hypot(evt.clientX - drag.client.x, evt.clientY - drag.client.y) < 3) return;
			drag.moved = true;
			if (drag.kind === "move" || drag.kind === "resize") this.checkpoint();
		}
		const s = this.scale;
		const pos = this.posFromEvt(evt);
		switch (drag.kind) {
			case "pan":
				this.setViewport(drag.x - (evt.clientX - drag.client.x) / s, drag.y - (evt.clientY - drag.client.y) / s, this.zoom);
				break;
			case "move": {
				const dx = pos.x - drag.start.x;
				const dy = pos.y - drag.start.y;
				for (const item of drag.items) item.node.moveTo({ x: item.x + dx, y: item.y + dy });
				break;
			}
			case "resize":
				this.#resize(drag, pos);
				break;
			case "connect":
				this.#drawConnection(drag, pos);
				break;
			case "select": {
				const rect = { x: Math.min(drag.start.x, pos.x), y: Math.min(drag.start.y, pos.y), width: Math.abs(pos.x - drag.start.x), height: Math.abs(pos.y - drag.start.y) };
				const style = this.selectionEl.style;
				style.transform = `translate(${rect.x}px, ${rect.y}px)`;
				style.width = `${rect.width}px`;
				style.height = `${rect.height}px`;
				this.selectionEl.show();
				this.selection = new Set(drag.base);
				for (const node of this.nodes.values()) if (intersects(rect, node.getBBox())) this.selection.add(node);
				this.#markSelection();
				break;
			}
		}
	}

	#resize(drag: Extract<Drag, { kind: "resize" }>, pos: Point) {
		const { rect, dir } = drag;
		const dx = pos.x - drag.start.x;
		const dy = pos.y - drag.start.y;
		let { x, y, width, height } = rect;
		if (dir.includes("left")) {
			x = Math.min(rect.x + dx, rect.x + rect.width - MIN_SIZE.width);
			width = rect.x + rect.width - x;
		} else if (dir.includes("right")) width = Math.max(MIN_SIZE.width, rect.width + dx);
		if (dir.includes("top")) {
			y = Math.min(rect.y + dy, rect.y + rect.height - MIN_SIZE.height);
			height = rect.y + rect.height - y;
		} else if (dir.includes("bottom")) height = Math.max(MIN_SIZE.height, rect.height + dy);
		drag.node.x = Math.round(x);
		drag.node.y = Math.round(y);
		drag.node.resize({ width, height });
	}

	#drawConnection(drag: Extract<Drag, { kind: "connect" }>, pos: Point) {
		const from = drag.node.getBBox();
		const target = this.nodeAt(pos, drag.node);
		const toSide = target ? nearestSide(target.getBBox(), pos) : facingSides(from, { ...pos, width: 0, height: 0 })[1];
		const to = target ? sidePoint(target.getBBox(), toSide) : pos;
		const g = edgeGeometry(sidePoint(from, drag.side), drag.side, to, toSide, { from: false, to: true });
		drag.el.querySelector("path")?.setAttribute("d", g.path);
		drag.el.querySelector("polygon")?.setAttribute("points", g.toArrow ?? "");
	}

	#onDragEnd(evt: PointerEvent) {
		const drag = this.#drag;
		this.#drag = null;
		this.wrapperEl.removeClass("is-dragging");
		if (!drag) return;
		// A drag ends in a click on whatever is under the pointer; it must not
		// follow a link or press a button there. The click comes in the
		// canvas's own window, a popout's included.
		if (drag.moved) {
			const win = this.wrapperEl.win;
			const swallow = (e: MouseEvent) => {
				e.stopPropagation();
				e.preventDefault();
			};
			win.addEventListener("click", swallow, { capture: true, once: true });
			win.setTimeout(() => win.removeEventListener("click", swallow, { capture: true }), 0);
		}
		switch (drag.kind) {
			case "move":
				if (drag.moved) this.requestSave();
				else if (drag.reselect) this.selectOnly(drag.reselect);
				break;
			case "resize":
				if (drag.moved) this.requestSave();
				break;
			case "connect":
				drag.el.remove();
				if (drag.moved) this.#connect(drag, this.posFromEvt(evt));
				break;
			case "select":
				this.selectionEl.hide();
				break;
		}
	}

	// An edge dragged out of a node's side: to the node it was dropped on, or
	// to a new card where it was dropped on empty canvas.
	#connect(drag: Extract<Drag, { kind: "connect" }>, pos: Point) {
		let target = this.nodeAt(pos, drag.node);
		let toSide: NodeSide;
		if (target) toSide = nearestSide(target.getBBox(), pos);
		else {
			toSide = facingSides(drag.node.getBBox(), { ...pos, width: 0, height: 0 })[1];
			const box = { ...TEXT_SIZE, x: 0, y: 0 };
			const anchor = sidePoint(box, toSide);
			target = this.createTextNode({ pos: { x: pos.x - anchor.x, y: pos.y - anchor.y }, save: false });
			this.dropCheckpoint();
		}
		this.addEdge({ id: randomId(), fromNode: drag.node.id, fromSide: drag.side, toNode: target.id, toSide });
		if (target instanceof CanvasTextNode && !target.text) {
			this.selectOnly(target);
			target.startEditing();
		}
	}

	#onDoubleClick(evt: MouseEvent) {
		if (this.view.broken) return;
		const target = evt.target as HTMLElement;
		if (target.closest(".canvas-controls, .canvas-card-menu, .canvas-node-resizer, .canvas-node-connection-point")) return;
		const nodeEl = target.closest<HTMLElement>(".canvas-node");
		const node = nodeEl ? this.nodes.get(nodeEl.dataset.nodeId ?? "") : undefined;
		if (node) {
			if (node instanceof CanvasTextNode) node.startEditing();
			else if (node instanceof CanvasFileNode) node.open(true);
			else if (node instanceof CanvasLinkNode) node.open();
			else if (node instanceof CanvasGroupNode) this.editGroupLabel(node);
			return;
		}
		const edgeEl = target.closest<HTMLElement>("[data-edge-id]");
		const edge = edgeEl ? this.edges.get(edgeEl.dataset.edgeId ?? "") : undefined;
		if (edge) {
			this.editEdgeLabel(edge);
			return;
		}
		const pos = this.posFromEvt(evt);
		this.createTextNode({ pos: { x: pos.x - TEXT_SIZE.width / 2, y: pos.y - TEXT_SIZE.height / 2 }, focus: true });
	}

	#onWheel(evt: WheelEvent) {
		if (this.view.broken) return;
		const target = evt.target as HTMLElement;
		if (target.closest(".canvas-controls, .canvas-card-menu")) return;
		// Ctrl is also what a trackpad pinch sends.
		const zoom = evt.ctrlKey || evt.metaKey || this.view.wheelZooms;
		// A selected card's content scrolls itself while it can.
		const content = target.closest<HTMLElement>(".canvas-node.is-selected .canvas-node-content, .canvas-node.is-editing .canvas-node-content");
		if (!zoom && content && content.scrollHeight > content.clientHeight) return;
		evt.preventDefault();
		if (zoom) this.zoomBy(Math.max(-0.5, Math.min(0.5, -evt.deltaY * (evt.deltaMode === 1 ? 0.05 : 0.01))), evt);
		else {
			const s = this.scale;
			const line = evt.deltaMode === 1 ? 16 : 1;
			this.setViewport(this.x + (evt.deltaX * line) / s, this.y + (evt.deltaY * line) / s, this.zoom);
		}
	}

	// ---- drops ----

	// What a drag over the canvas would add: files, folders or a link dragged
	// inside the app (app.dragManager), a card from the card menu, files from
	// the OS, or text and URLs from another app. A drag over the card being
	// edited goes to its editor.
	#dropKind(evt: DragEvent): "drag" | "card" | "files" | "text" | null {
		if (this.view.broken || this.editing?.nodeEl.contains(evt.target as Node)) return null;
		const drag = this.app.dragManager.draggable;
		if (drag) return drag.type === "link" || DragManager.files(drag).length ? "drag" : null;
		const types = evt.dataTransfer?.types ?? [];
		if (types.includes(CARD_TYPE)) return "card";
		if (types.includes("Files")) return "files";
		if (types.includes("text/uri-list") || types.includes("text/plain")) return "text";
		return null;
	}

	#onDragOver(evt: DragEvent) {
		const kind = this.#dropKind(evt);
		if (!kind || evt.defaultPrevented) return;
		evt.preventDefault();
		if (evt.dataTransfer) evt.dataTransfer.dropEffect = kind === "drag" ? "link" : "copy";
		if (kind === "drag") this.app.dragManager.setAction("Add to canvas");
	}

	#onDrop(evt: DragEvent) {
		const kind = this.#dropKind(evt);
		if (!kind || evt.defaultPrevented) return;
		evt.preventDefault();
		const at = this.posFromEvt(evt);
		this.wrapperEl.focus({ preventScroll: true });
		const failed = (err: unknown) => {
			console.error(err);
			new Notice(`Could not add to the canvas: ${err instanceof Error ? err.message : err}`);
		};
		const data = evt.dataTransfer;
		if (kind === "drag") this.#dropDragged(at).catch(failed);
		else if (kind === "card") this.#addCard(data?.getData(CARD_TYPE) ?? "text", at);
		else if (kind === "files") this.#dropOsFiles([...(data?.files ?? [])], at).catch(failed);
		else this.#dropText(data?.getData("text/uri-list") ?? "", data?.getData("text/plain") ?? "", at);
	}

	// Files dragged from the explorer, a search result or a link pane become
	// file cards; a folder adds the files directly in it. A dragged link adds
	// a card for the file (and heading or block) it points to; an unresolved
	// one, a text card holding the link.
	async #dropDragged(at: Point) {
		const drag = this.app.dragManager.draggable;
		if (drag?.type === "link" && drag.linktext) {
			const { path, subpath } = parseLinktext(drag.linktext);
			const sourcePath = drag.sourcePath ?? "";
			const file = path ? this.app.metadataCache.getFirstLinkpathDest(path, sourcePath) : this.app.vault.getFileByPath(sourcePath);
			if (file) await this.addFiles([file], at, subpath);
			else this.selectOnly(this.createTextNode({ pos: { x: at.x - TEXT_SIZE.width / 2, y: at.y - TEXT_SIZE.height / 2 }, text: `[[${drag.linktext}]]` }));
			return;
		}
		const files = new Set<TFile>();
		for (const item of DragManager.files(drag)) {
			if (item instanceof TFile) files.add(item);
			else if (item instanceof TFolder) for (const child of sortedFiles(item)) files.add(child);
		}
		await this.addFiles([...files], at);
	}

	// Files dropped from the OS are copied into the attachment folder for
	// this canvas (app.json's attachmentFolderPath); a file already in the
	// vault is used where it is.
	async #dropOsFiles(dropped: File[], at: Point) {
		const sourcePath = this.view.file?.path ?? "";
		const files: TFile[] = [];
		for (const file of dropped) {
			try {
				files.push(await importFile(this.app, file, sourcePath));
			} catch (err) {
				console.error(err);
				new Notice(`Could not import ${file.name}: ${err instanceof Error ? err.message : err}`);
			}
		}
		await this.addFiles(files, at);
	}

	// A URL becomes a link card; other text a text card.
	#dropText(uriList: string, plain: string, at: Point) {
		const url = uriList.split(/\r?\n/).find((line) => line && !line.startsWith("#"))?.trim() ?? (URL_ONLY.test(plain.trim()) ? plain.trim() : "");
		if (url) {
			const node = this.addNode({ id: randomId(), type: "link", url, x: Math.round(at.x - FILE_SIZE.width / 2), y: Math.round(at.y - FILE_SIZE.height / 2), ...FILE_SIZE });
			this.selectOnly(node);
			return;
		}
		if (!plain.trim()) return;
		const size = textCardSize(plain);
		this.selectOnly(this.createTextNode({ pos: { x: at.x - size.width / 2, y: at.y - size.height / 2 }, size, text: plain }));
	}

	// File cards for `files` laid out around `at`, sized for what they show
	// (media keep their aspect ratio), added as one undo step and selected.
	async addFiles(files: TFile[], at: Point, subpath?: string) {
		if (!files.length) return [];
		const sizes = await Promise.all(files.map((f) => this.#fileCardSize(f)));
		const rects = dropLayout(at, sizes, GRID);
		this.checkpoint();
		const added = files.map((file, i) => {
			const { x, y, width, height } = rects[i];
			const data: AllCanvasNodeData = { id: randomId(), type: "file", file: file.path, x, y, width, height };
			if (subpath) data.subpath = subpath;
			const node = createNode(this, data);
			this.nodes.set(node.id, node);
			return node;
		});
		this.#placeElements();
		this.requestSave();
		this.selection = new Set(added);
		this.#markSelection();
		return added;
	}

	async #fileCardSize(file: TFile): Promise<Size> {
		const ext = file.extension.toLowerCase();
		if (IMAGE.has(ext) || VIDEO.has(ext)) return fitSize(await mediaSize(this.app.vault.getResourcePath(file), VIDEO.has(ext)), FILE_SIZE);
		if (AUDIO.has(ext)) return AUDIO_SIZE;
		return FILE_SIZE;
	}

	// ---- menus ----

	#onContextMenu(evt: MouseEvent) {
		if (this.view.broken) return;
		const target = evt.target as HTMLElement;
		if (this.editing?.nodeEl.contains(target)) return;
		evt.preventDefault();
		const menu = new Menu();
		menu.addSections(["canvas", "action", "color", "view", "danger"]);
		const nodeEl = target.closest<HTMLElement>(".canvas-node");
		const node = nodeEl ? this.nodes.get(nodeEl.dataset.nodeId ?? "") : undefined;
		const edgeEl = target.closest<HTMLElement>("[data-edge-id]");
		const edge = edgeEl ? this.edges.get(edgeEl.dataset.edgeId ?? "") : undefined;
		const item = node ?? edge;
		if (item) {
			if (!this.selection.has(item)) this.selectOnly(item);
			if (node instanceof CanvasTextNode) menu.addItem((i) => i.setTitle("Edit").setIcon("pencil").setSection("action").onClick(() => node.startEditing()));
			if (node instanceof CanvasFileNode && node.file) menu.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus").setSection("action").onClick(() => node.open(true)));
			if (node instanceof CanvasLinkNode) menu.addItem((i) => i.setTitle("Open link").setIcon("globe").setSection("action").onClick(() => node.open()));
			if (node instanceof CanvasGroupNode) menu.addItem((i) => i.setTitle("Edit label").setIcon("pencil").setSection("action").onClick(() => this.editGroupLabel(node)));
			if (edge) {
				menu.addItem((i) => i.setTitle("Edit label").setIcon("pencil").setSection("action").onClick(() => this.editEdgeLabel(edge)));
				const ends = (title: string, end: "from" | "to") =>
					menu.addItem((i) =>
						i
							.setTitle(title)
							.setSection("action")
							.setChecked(edge[end].end === "arrow")
							.onClick(() => {
								this.checkpoint();
								edge[end].end = edge[end].end === "arrow" ? "none" : "arrow";
								edge.render();
								this.requestSave();
							}),
					);
				ends("Arrow at start", "from");
				ends("Arrow at end", "to");
			}
			this.#colorItems(menu);
			menu.addItem((i) => i.setTitle("Zoom to selection").setIcon("scan").setSection("view").onClick(() => this.zoomToSelection()));
			menu.addItem((i) =>
				i
					.setTitle("Remove")
					.setIcon("trash-2")
					.setWarning(true)
					.setSection("danger")
					.onClick(() => this.deleteSelection()),
			);
		} else {
			const pos = this.posFromEvt(evt);
			menu.addItem((i) =>
				i
					.setTitle("Add card")
					.setIcon("sticky-note")
					.setSection("canvas")
					.onClick(() => this.createTextNode({ pos: { x: pos.x - TEXT_SIZE.width / 2, y: pos.y - TEXT_SIZE.height / 2 }, focus: true })),
			);
			menu.addItem((i) =>
				i
					.setTitle("Add note from vault")
					.setIcon("file-text")
					.setSection("canvas")
					.onClick(() => this.#pickFile((f) => f.extension === "md", pos)),
			);
			menu.addItem((i) =>
				i
					.setTitle("Add media from vault")
					.setIcon("image")
					.setSection("canvas")
					.onClick(() => this.#pickFile((f) => MEDIA.has(f.extension.toLowerCase()), pos)),
			);
			const selected = [...this.selection].filter((n): n is CanvasNode => !(n instanceof CanvasEdge));
			if (selected.length) menu.addItem((i) => i.setTitle("Create group").setIcon("box-select").setSection("action").onClick(() => this.groupSelection()));
			menu.addItem((i) => i.setTitle("Zoom to fit").setIcon("maximize").setSection("view").onClick(() => this.zoomToFit()));
		}
		menu.showAtMouseEvent(evt);
	}

	#colorItems(menu: Menu) {
		const items = [...this.selection];
		const current = items.length === 1 ? items[0].color : null;
		const paint = (color: string) => {
			this.checkpoint();
			for (const item of this.selection) item.setColor(color);
			this.requestSave();
		};
		menu.addItem((i) =>
			i
				.setTitle("No color")
				.setSection("color")
				.setChecked(current === "")
				.onClick(() => paint("")),
		);
		for (const [color, name] of COLORS) {
			menu.addItem((i) =>
				i
					.setTitle(name)
					.setSection("color")
					.setChecked(current === color)
					.onClick(() => paint(color)),
			);
		}
	}

	// A group around the selected nodes.
	groupSelection() {
		const nodes = [...this.selection].filter((n): n is CanvasNode => !(n instanceof CanvasEdge));
		const box = boundingBox(nodes.map((n) => n.getBBox()));
		if (!box) return;
		const pad = 20;
		const group = this.createGroupNode({ pos: { x: box.x - pad, y: box.y - pad }, size: { width: box.width + pad * 2, height: box.height + pad * 2 }, label: "" });
		this.selectOnly(group);
	}

	async editGroupLabel(group: CanvasGroupNode) {
		const label = await promptText(this.app, "Group label", group.label);
		if (label === null || label === group.label) return;
		this.checkpoint();
		group.setLabel(label);
		this.requestSave();
	}

	async editEdgeLabel(edge: CanvasEdge) {
		const label = await promptText(this.app, "Edge label", edge.label);
		if (label === null || label === edge.label) return;
		this.checkpoint();
		edge.setLabel(label);
		this.requestSave();
	}

	// ---- keys ----

	installKeys(scope: Scope) {
		const idle = () => !this.editing && !this.view.broken;
		const run = (action: () => void) => () => {
			if (!idle()) return true;
			action();
			return false;
		};
		scope.register([], "Delete", run(() => this.deleteSelection()));
		scope.register([], "Backspace", run(() => this.deleteSelection()));
		scope.register(["Mod"], "z", run(() => this.undo()));
		scope.register(["Mod", "Shift"], "z", run(() => this.redo()));
		scope.register(["Mod"], "y", run(() => this.redo()));
		scope.register(["Mod"], "a", run(() => this.selectAll()));
		scope.register([], "Enter", () => {
			const [only] = this.selection;
			if (!idle() || this.selection.size !== 1 || !(only instanceof CanvasTextNode)) return true;
			only.startEditing();
			return false;
		});
		scope.register([], "Escape", () => {
			if (this.editing) {
				this.editing.stopEditing();
				return false;
			}
			if (!this.selection.size) return true;
			this.deselectAll();
			return false;
		});
	}
}

// Asks for a line of text; an empty answer counts (it clears a label).
function promptText(app: App, title: string, value: string): Promise<string | null> {
	let resolve: (value: string | null) => void = () => {};
	const promise = new Promise<string | null>((r) => {
		resolve = r;
	});
	const modal = new Modal(app);
	modal.setTitle(title);
	const input = modal.contentEl.createEl("input", { type: "text", value, cls: "prompt-modal-input" });
	let answer: string | null = null;
	modal.scope.register([], "Enter", () => {
		answer = input.value;
		modal.close();
		return false;
	});
	modal.onOpen = () => {
		input.focus();
		input.select();
	};
	modal.onClose = () => resolve(answer);
	modal.open();
	return promise;
}

// The files directly in a folder, in name order.
function sortedFiles(folder: TFolder): TFile[] {
	return folder.children.filter((c): c is TFile => c instanceof TFile).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// A media file's own size, or null when it does not load within a few
// seconds.
async function mediaSize(src: string, video: boolean): Promise<Size | null> {
	let resolve: (size: Size | null) => void = () => {};
	const promise = new Promise<Size | null>((r) => {
		resolve = r;
	});
	const timer = setTimeout(() => resolve(null), 3000);
	const done = (size: Size | null) => {
		clearTimeout(timer);
		resolve(size);
	};
	if (video) {
		const el = document.createElement("video");
		el.preload = "metadata";
		el.onloadedmetadata = () => done({ width: el.videoWidth, height: el.videoHeight });
		el.onerror = () => done(null);
		el.src = src;
	} else {
		const img = new Image();
		img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
		img.onerror = () => done(null);
		img.src = src;
	}
	return promise;
}

// A text card wide and tall enough for dropped text, roughly: short text
// takes a small card, longer text a wider one, up to a height that scrolls.
function textCardSize(text: string): Size {
	const width = text.length > 60 || text.includes("\n") ? FILE_SIZE.width : TEXT_SIZE.width;
	const perLine = Math.floor((width - 40) / 8);
	const lines = text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / perLine)), 0);
	return { width, height: Math.min(600, Math.max(TEXT_SIZE.height, lines * 26 + 28)) };
}

class FilePickModal extends FuzzySuggestModal<TFile> {
	#filter: (file: TFile) => boolean;
	#choose: (file: TFile) => void;

	constructor(app: App, filter: (file: TFile) => boolean, choose: (file: TFile) => void) {
		super(app);
		this.#filter = filter;
		this.#choose = choose;
		this.setPlaceholder("Find a file...");
	}

	getItems() {
		return this.app.vault.getFiles().filter((f) => this.#filter(f));
	}

	getItemText(file: TFile) {
		return file.path;
	}

	onChooseItem(file: TFile) {
		this.#choose(file);
	}
}

const canvasMerge = {
	merge: mergeCanvas,
	conflictNotice: (name: string) => `${name} changed on disk while it had unsaved edits. Where both changed the same card, the file's version was kept.`,
};

// A .canvas file. Its text is the view's data, saved through the vault like
// any text file view's; the canvas re-serializes it only after a change, so
// a file that is only looked at keeps its bytes.
export class CanvasView extends TextFileView {
	canvas: Canvas;
	// The file is not a canvas: shown empty, never saved.
	broken = false;
	#text = "";

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "layout-dashboard";
		this.contentEl.addClass("canvas-view");
		mergeWith(this, canvasMerge);
		this.canvas = new Canvas(this);
		this.scope = new Scope(this.app.scope);
		this.canvas.installKeys(this.scope);
	}

	getViewType() {
		return "canvas";
	}

	canAcceptExtension(extension: string) {
		return extension === "canvas";
	}

	// The viewport goes into the leaf's state, as Obsidian keeps it in
	// workspace.json (`viewState`), so the layout and history bring it back.
	getState() {
		return { ...super.getState(), viewState: this.canvas.getViewport() };
	}

	async setState(state: any, result: ViewStateResult) {
		const viewport = readViewport(state?.viewState, MIN_ZOOM, MAX_ZOOM);
		const before = this.file;
		this.canvas.pendingViewport = viewport;
		await super.setState(state, result);
		// The same file stays open: no load takes the viewport.
		if (this.file === before) {
			this.canvas.pendingViewport = null;
			if (viewport) this.canvas.setViewport(viewport.x, viewport.y, viewport.zoom);
		}
	}

	onViewportChange() {
		this.app.workspace.requestSaveLayout();
	}

	// Obsidian's canvas option: "zoom" makes the plain wheel zoom.
	get wheelZooms() {
		return this.app.internalPlugins.getEnabledPluginById("canvas")?.options?.defaultWheelBehavior === "zoom";
	}

	onload() {
		super.onload();
		const refresh = (file?: TFile) => this.canvas.refreshFiles(file);
		for (const name of ["create", "delete", "rename"]) this.registerEvent(this.app.vault.on(name, () => refresh()));
		this.registerEvent(this.app.metadataCache.on("changed", (file: TFile) => refresh(file)));
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension !== "md" && file !== this.file) refresh(file);
			}),
		);
		this.register(() => this.canvas.clear());
	}

	getViewData() {
		return this.#text;
	}

	setViewData(data: string, clear: boolean) {
		this.#text = data;
		let parsed: CanvasData;
		try {
			parsed = parseCanvas(data);
			this.broken = false;
		} catch (err) {
			parsed = { nodes: [], edges: [] };
			this.broken = true;
			this.canvas.messageEl.setText(`This canvas file could not be read: ${err instanceof Error ? err.message : err}`);
		}
		this.canvas.messageEl.toggle(this.broken);
		this.canvas.wrapperEl.toggleClass("is-broken", this.broken);
		this.canvas.importData(parsed, clear);
	}

	clear() {
		this.#text = "";
		this.canvas.clear();
	}

	// The canvas changed: its text now is its data, written on the next save.
	onCanvasChange() {
		if (this.broken) return;
		this.#text = stringifyCanvas(this.canvas.getData());
		this.requestSave();
	}

	onResize() {
		this.canvas.onResize();
	}
}

// Where "Create new canvas" puts the file: the canvas plugin's own location
// option when set, else the vault's new-file location.
function newCanvasFolder(app: App): TFolder {
	const options = app.internalPlugins.getEnabledPluginById("canvas")?.options ?? {};
	if (options.newFileLocation === "root") return app.vault.getRoot();
	if (options.newFileLocation === "folder" && typeof options.newFileFolderPath === "string") {
		const folder = app.vault.getAbstractFileByPath(options.newFileFolderPath.replace(/^\/+|\/+$/g, ""));
		if (folder instanceof TFolder) return folder;
	}
	if (options.newFileLocation === "current") {
		const parent = app.workspace.getActiveFile()?.parent;
		if (parent) return parent;
	}
	return app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? "");
}

export async function createCanvas(app: App, folder?: TFolder) {
	const parent = folder ?? newCanvasFolder(app);
	const file = await app.vault.create(app.vault.getAvailablePath(parent.isRoot() ? "Untitled" : `${parent.path}/Untitled`, "canvas"), NEW_CANVAS);
	await app.workspace.getLeaf(false).openFile(file);
	return file;
}

// Canvases follow the files they show when one is renamed or moved, open or
// not, as in Obsidian.
async function followRename(app: App, file: TAbstractFile, oldPath: string) {
	for (const canvas of app.vault.getFiles()) {
		if (canvas.extension !== "canvas") continue;
		try {
			await app.vault.process(canvas, (text) => renameInCanvas(text, oldPath, file.path) ?? text);
		} catch (err) {
			console.error(err);
		}
	}
}

export function installCanvas(app: App, host: CorePluginHost) {
	host.registerView("canvas", (leaf) => new CanvasView(leaf));
	host.registerExtensions(["canvas"], "canvas");
	host.addCommand({ id: "canvas:new-file", name: "Canvas: Create new canvas", icon: "layout-dashboard", callback: () => createCanvas(app) });
	host.addRibbonIcon("canvas:new-file", "layout-dashboard", "Create new canvas", () => {
		createCanvas(app).catch((err) => new Notice(err instanceof Error ? err.message : String(err)));
	});
	host.registerEvent(
		app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
			if (file instanceof TFolder) menu.addItem((item) => item.setTitle("New canvas").setIcon("layout-dashboard").setSection("action-primary").onClick(() => createCanvas(app, file)));
		}),
	);
	host.registerEvent(
		app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
			followRename(app, file, oldPath).catch((err) => console.error(err));
		}),
	);
}
