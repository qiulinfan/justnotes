// The JSON Canvas format (jsoncanvas.org, obsidian/canvas.d.ts) as the canvas
// view reads, writes and merges it, and the geometry of its nodes and edges.
// Nodes, edges and the file itself keep every field, known or not, in order.
import type { AllCanvasNodeData, CanvasData, CanvasEdgeData, NodeSide } from "obsidian/canvas";

export type { AllCanvasNodeData, CanvasData, CanvasEdgeData, NodeSide };

export interface Point {
	x: number;
	y: number;
}

export interface Rect extends Point {
	width: number;
	height: number;
}

export const SIDES: NodeSide[] = ["top", "right", "bottom", "left"];

const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const isNode = (value: unknown): value is AllCanvasNodeData => isRecord(value) && typeof value.id === "string";
const isEdge = (value: unknown): value is CanvasEdgeData => isNode(value) && typeof value.fromNode === "string" && typeof value.toNode === "string";

// A canvas file's data. An empty file is an empty canvas. Text that is not
// JSON but holds Obsidian's one-item-per-line layout (a line merge of two
// versions, which leaves commas out of place) is read line by line. Anything
// else throws.
export function parseCanvas(text: string): CanvasData {
	if (!text.trim()) return { nodes: [], edges: [] };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		const lines = parseLines(text);
		if (!lines) throw err;
		raw = lines;
	}
	if (!isRecord(raw)) throw new Error("A canvas file holds a JSON object");
	const nodes = Array.isArray(raw.nodes) ? raw.nodes.filter(isNode) : [];
	const ids = new Set(nodes.map((n) => n.id));
	const edges = Array.isArray(raw.edges) ? raw.edges.filter((e) => isEdge(e) && ids.has(e.fromNode) && ids.has(e.toNode)) : [];
	return { ...raw, nodes, edges };
}

// Obsidian's layout: `"nodes":[` and `"edges":[` open their lists, each item
// is one line, and other fields are one line each.
function parseLines(text: string): CanvasData | null {
	const data: CanvasData = { nodes: [], edges: [] };
	let list: "nodes" | "edges" | null = null;
	let found = false;
	for (const raw of text.split("\n")) {
		const line = raw.trim().replace(/,$/, "");
		const open = /^"(nodes|edges)":\[(\])?$/.exec(line);
		if (open) {
			list = open[2] ? null : (open[1] as "nodes" | "edges");
			found = true;
			continue;
		}
		if (line === "]") {
			list = null;
			continue;
		}
		if (line.startsWith("{") && line.endsWith("}") && line !== "{}") {
			let item: unknown;
			try {
				item = JSON.parse(line);
			} catch {
				return null;
			}
			if (!isNode(item)) return null;
			(list === "edges" || (!list && isEdge(item)) ? data.edges : data.nodes).push(item as any);
			found = true;
			continue;
		}
		const field = /^"([^"]+)":(.+)$/.exec(line);
		if (field && !list) {
			try {
				data[field[1]] = JSON.parse(field[2]);
			} catch {
				return null;
			}
			continue;
		}
		if (line && line !== "{" && line !== "}") return null;
	}
	return found ? data : null;
}

// Obsidian's layout of a canvas file: tab-indented, one node or edge per
// line, so a line diff (git, a merge) works item by item.
export function stringifyCanvas(data: CanvasData): string {
	const list = (items: unknown[]) => (items.length ? `[\n${items.map((item) => `\t\t${JSON.stringify(item)}`).join(",\n")}\n\t]` : "[]");
	const fields = [`\t"nodes":${list(data.nodes ?? [])}`, `\t"edges":${list(data.edges ?? [])}`];
	for (const [key, value] of Object.entries(data)) {
		if (key !== "nodes" && key !== "edges" && value !== undefined) fields.push(`\t${JSON.stringify(key)}:${JSON.stringify(value)}`);
	}
	return `{\n${fields.join(",\n")}\n}`;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

// A three-way merge of two records' fields: a field changed on one side takes
// that change; a field changed differently on both sides takes `theirs` and
// counts as a conflict. Undefined fields are absent.
function mergeFields(base: Record<string, any>, ours: Record<string, any>, theirs: Record<string, any>, conflicts: { count: number }, skip: string[] = []) {
	const out: Record<string, any> = {};
	for (const key of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
		if (skip.includes(key)) continue;
		const [b, o, t] = [base[key], ours[key], theirs[key]];
		let value: unknown;
		if (same(o, t) || same(b, t)) value = o;
		else if (same(b, o)) value = t;
		else {
			value = t;
			conflicts.count++;
		}
		if (value !== undefined) out[key] = value;
	}
	return out;
}

// Merges lists of items by id: an item added on either side is kept, one
// removed on one side and left alone on the other is removed, one removed on
// one side and changed on the other is kept with the change, and one kept on
// both sides merges field by field. The order is `theirs`, then items only
// `ours` has.
function mergeItems<T extends { id: string }>(base: T[], ours: T[], theirs: T[], conflicts: { count: number }): T[] {
	const byId = (items: T[]) => new Map(items.map((item) => [item.id, item]));
	const [b, o, t] = [byId(base), byId(ours), byId(theirs)];
	const out: T[] = [];
	for (const item of theirs) {
		const was = b.get(item.id);
		const mine = o.get(item.id);
		if (mine) out.push(mergeFields(was ?? {}, mine, item, conflicts) as T);
		else if (!was || !same(was, item)) out.push(item);
	}
	for (const item of ours) {
		if (t.has(item.id)) continue;
		const was = b.get(item.id);
		if (!was || !same(was, item)) out.push(item);
	}
	return out;
}

// The canvas view's merge of unsaved edits (`ours`) with a change on disk
// (`theirs`), both made from `base`: by node and edge id, field by field, so
// the result is always a valid canvas (a line merge of JSON is not). Edges
// left without one of their nodes are dropped. Text that is no canvas at all
// cannot merge: a broken file on disk loses to the view's edits.
export function mergeCanvas(base: string, ours: string, theirs: string): { text: string; conflicts: number } {
	const read = (text: string) => {
		try {
			return parseCanvas(text);
		} catch {
			return null;
		}
	};
	const [b, o, t] = [read(base) ?? { nodes: [], edges: [] }, read(ours), read(theirs)];
	if (!o) return { text: theirs, conflicts: 1 };
	if (!t) return { text: ours, conflicts: 1 };
	const conflicts = { count: 0 };
	const nodes = mergeItems(b.nodes, o.nodes, t.nodes, conflicts);
	const ids = new Set(nodes.map((n) => n.id));
	const edges = mergeItems(b.edges, o.edges, t.edges, conflicts).filter((e) => ids.has(e.fromNode) && ids.has(e.toNode));
	const data = { nodes, edges, ...mergeFields(b, o, t, conflicts, ["nodes", "edges"]) } as CanvasData;
	const text = stringifyCanvas(data);
	// Unchanged content keeps the file's own bytes.
	if (same(data, t)) return { text: theirs, conflicts: conflicts.count };
	return { text, conflicts: conflicts.count };
}

// Obsidian's node and edge ids: 16 hex digits.
export function randomId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// A canvas color: "1" to "6" are the theme's preset colors, "#rrggbb" a
// custom one (as the "r, g, b" channels CSS reads).
export function parseColor(color: unknown): { preset: string } | { rgb: string } | null {
	if (typeof color !== "string" || !color) return null;
	if (/^[1-6]$/.test(color)) return { preset: color };
	const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
	if (!hex) return null;
	const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join("") : hex[1];
	const n = Number.parseInt(digits, 16);
	return { rgb: `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}` };
}

export function sidePoint(rect: Rect, side: NodeSide): Point {
	switch (side) {
		case "top":
			return { x: rect.x + rect.width / 2, y: rect.y };
		case "bottom":
			return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
		case "left":
			return { x: rect.x, y: rect.y + rect.height / 2 };
		default:
			return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
	}
}

const NORMAL: Record<NodeSide, Point> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

// The side of `rect` whose middle is closest to `point`: where an edge
// dropped there attaches.
export function nearestSide(rect: Rect, point: Point): NodeSide {
	let best: NodeSide = "top";
	let distance = Number.POSITIVE_INFINITY;
	for (const side of SIDES) {
		const p = sidePoint(rect, side);
		const d = Math.hypot(p.x - point.x, p.y - point.y);
		if (d < distance) [best, distance] = [side, d];
	}
	return best;
}

// The sides an edge without stored sides uses (the spec makes them
// optional): the facing sides along the axis the nodes are farther apart on.
export function facingSides(from: Rect, to: Rect): [NodeSide, NodeSide] {
	const dx = to.x + to.width / 2 - (from.x + from.width / 2);
	const dy = to.y + to.height / 2 - (from.y + from.height / 2);
	if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
	return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

export interface EdgeGeometry {
	// The SVG path of the line, ending where the arrowheads begin.
	path: string;
	// Arrowhead polygons ("x,y x,y x,y"), at either end that has one.
	fromArrow: string | null;
	toArrow: string | null;
	// Where the label sits: the middle of the curve.
	middle: Point;
}

const ARROW_LENGTH = 12;
const ARROW_WIDTH = 10;

function arrowAt(tip: Point, side: NodeSide): { base: Point; polygon: string } {
	const n = NORMAL[side];
	const base = { x: tip.x + n.x * ARROW_LENGTH, y: tip.y + n.y * ARROW_LENGTH };
	const half = ARROW_WIDTH / 2;
	const corners = [
		{ x: base.x - n.y * half, y: base.y + n.x * half },
		{ x: base.x + n.y * half, y: base.y - n.x * half },
	];
	return { base, polygon: [tip, ...corners].map((p) => `${round(p.x)},${round(p.y)}`).join(" ") };
}

const round = (n: number) => Math.round(n * 10) / 10;

// An edge as a cubic curve leaving each node straight out of its side.
export function edgeGeometry(from: Point, fromSide: NodeSide, to: Point, toSide: NodeSide, ends: { from: boolean; to: boolean }): EdgeGeometry {
	const fromArrow = ends.from ? arrowAt(from, fromSide) : null;
	const toArrow = ends.to ? arrowAt(to, toSide) : null;
	const start = fromArrow?.base ?? from;
	const end = toArrow?.base ?? to;
	const reach = Math.min(150, Math.max(40, Math.hypot(end.x - start.x, end.y - start.y) / 2));
	const [n1, n2] = [NORMAL[fromSide], NORMAL[toSide]];
	const c1 = { x: start.x + n1.x * reach, y: start.y + n1.y * reach };
	const c2 = { x: end.x + n2.x * reach, y: end.y + n2.y * reach };
	const middle = { x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8, y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8 };
	const path = `M${round(start.x)},${round(start.y)} C${round(c1.x)},${round(c1.y)} ${round(c2.x)},${round(c2.y)} ${round(end.x)},${round(end.y)}`;
	return { path, fromArrow: fromArrow?.polygon ?? null, toArrow: toArrow?.polygon ?? null, middle };
}

export function boundingBox(rects: Rect[]): Rect | null {
	if (!rects.length) return null;
	const x = Math.min(...rects.map((r) => r.x));
	const y = Math.min(...rects.map((r) => r.y));
	const right = Math.max(...rects.map((r) => r.x + r.width));
	const bottom = Math.max(...rects.map((r) => r.y + r.height));
	return { x, y, width: right - x, height: bottom - y };
}

export const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// A canvas's text with the paths of file nodes and group backgrounds that
// pointed at `oldPath` (a file, or a folder and everything in it) moved to
// `newPath`; null when nothing pointed there or the text is no canvas.
export function renameInCanvas(text: string, oldPath: string, newPath: string): string | null {
	let data: CanvasData;
	try {
		data = parseCanvas(text);
	} catch {
		return null;
	}
	const moved = (path: unknown) => {
		if (typeof path !== "string") return null;
		if (path === oldPath) return newPath;
		return path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length) : null;
	};
	let changed = false;
	for (const node of data.nodes) {
		for (const key of node.type === "file" ? ["file"] : node.type === "group" ? ["background"] : []) {
			const path = moved(node[key]);
			if (path !== null) {
				node[key] = path;
				changed = true;
			}
		}
	}
	return changed ? stringifyCanvas(data) : null;
}

export interface Size {
	width: number;
	height: number;
}

// Where cards dropped together go: next to each other in a row (up to four),
// more of them in a grid of about as many columns as rows, `gap` apart, the
// whole block centred on the drop point. Each card keeps its own size inside
// a cell as wide as its column's widest card and as tall as its row's
// tallest.
export function dropLayout(at: Point, sizes: Size[], gap = 20): Rect[] {
	if (!sizes.length) return [];
	const columns = sizes.length <= 4 ? sizes.length : Math.ceil(Math.sqrt(sizes.length));
	const rows = Math.ceil(sizes.length / columns);
	const widths = Array.from({ length: columns }, (_, c) => Math.max(...sizes.filter((_, i) => i % columns === c).map((s) => s.width)));
	const heights = Array.from({ length: rows }, (_, r) => Math.max(...sizes.slice(r * columns, (r + 1) * columns).map((s) => s.height)));
	const total = { width: widths.reduce((a, b) => a + b, 0) + gap * (columns - 1), height: heights.reduce((a, b) => a + b, 0) + gap * (rows - 1) };
	const left = at.x - total.width / 2;
	const top = at.y - total.height / 2;
	return sizes.map((size, i) => {
		const c = i % columns;
		const r = Math.floor(i / columns);
		const x = left + widths.slice(0, c).reduce((a, b) => a + b, 0) + gap * c;
		const y = top + heights.slice(0, r).reduce((a, b) => a + b, 0) + gap * r;
		return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height };
	});
}

// A card for media of `natural` size: its aspect ratio, as large as fits in
// `box`. Unknown sizes take the whole box.
export function fitSize(natural: Size | null, box: Size): Size {
	if (!natural?.width || !natural.height) return box;
	const scale = Math.min(box.width / natural.width, box.height / natural.height);
	return { width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) };
}

// The viewport a canvas leaf keeps in its view state (`viewState`, as
// Obsidian's workspace.json has it): the canvas point at the middle of the
// view and the zoom level. Null for anything else, so a hand-edited or
// foreign layout falls back to fitting the canvas.
export interface Viewport {
	x: number;
	y: number;
	zoom: number;
}

export function readViewport(value: unknown, minZoom: number, maxZoom: number): Viewport | null {
	if (!value || typeof value !== "object") return null;
	const { x, y, zoom } = value as Record<string, unknown>;
	if (![x, y, zoom].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
	return { x: x as number, y: y as number, zoom: Math.min(maxZoom, Math.max(minZoom, zoom as number)) };
}
