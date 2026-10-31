// The graph view's canvas: a d3-force simulation drawn with Canvas 2D, with
// hover highlighting, node dragging, panning and zooming. Frames run only
// while the layout moves or an animation plays.
import {
	type ForceLink,
	type ForceManyBody,
	type ForceX,
	type ForceY,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	type Simulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from "d3-force";
import type { GraphData, GraphOptions, NodeType } from "./graph-data";

export interface RenderNode extends SimulationNodeDatum {
	id: string;
	type: NodeType;
	weight: number;
	label: string;
	// A colour group's fill, else the type's.
	color: string | null;
	focused: boolean;
	x: number;
	y: number;
}

interface RenderLink extends SimulationLinkDatum<RenderNode> {
	source: RenderNode;
	target: RenderNode;
}

export type Decorate = (id: string, type: NodeType) => { label: string; color: string | null; focused?: boolean };

type Display = Pick<GraphOptions, "showArrow" | "textFadeMultiplier" | "nodeSizeMultiplier" | "lineSizeMultiplier">;
type Forces = Pick<GraphOptions, "centerStrength" | "repelStrength" | "linkStrength" | "linkDistance">;

export interface RendererCallbacks {
	click(node: RenderNode, evt: MouseEvent): void;
	menu(node: RenderNode, evt: MouseEvent): void;
	zoom(scale: number): void;
}

// Colours read from the theme through Obsidian's probe classes.
const PROBES = {
	fill: "color-fill",
	focused: "color-fill-focused",
	tag: "color-fill-tag",
	attachment: "color-fill-attachment",
	unresolved: "color-fill-unresolved",
	arrow: "color-arrow",
	line: "color-line",
	text: "color-text",
	fillHighlight: "color-fill-highlight",
	lineHighlight: "color-line-highlight",
} as const;

type Palette = Record<keyof typeof PROBES, string>;

// The probe's colour with its opacity folded into the alpha.
function probeColor(parent: HTMLElement, cls: string) {
	const el = parent.createDiv(`graph-view ${cls}`);
	const style = getComputedStyle(el);
	const opacity = Number(style.opacity || 1);
	const m = /rgba?\(([^)]+)\)/.exec(style.color);
	el.remove();
	if (!m) return style.color;
	const [r, g, b, a = "1"] = m[1].split(/[,\s/]+/).filter(Boolean);
	return `rgba(${r}, ${g}, ${b}, ${Number(a) * opacity})`;
}

export function nodeRadius(weight: number, multiplier: number) {
	return multiplier * Math.min(30, 4 + 2 * Math.sqrt(weight));
}

// How opaque labels are at zoom `scale`: fully from about 0.8 with the
// default threshold, gone below about 0.45; each step of the threshold moves
// the fade by one zoom octave.
export function labelAlpha(scale: number, textFade: number) {
	return Math.min(1, Math.max(0, (Math.log2(scale) + textFade) * 1.2 + 1.4));
}

const FONT_SIZE = 12;
const MIN_SCALE = 1 / 64;
const MAX_SCALE = 16;
// The layout cools over about 500 steps (d3's default is 300).
const ALPHA_DECAY = 1 - 0.001 ** (1 / 500);
const MAX_STEPS = 4;
const STEP_BUDGET_MS = 6;

export class GraphRenderer {
	containerEl: HTMLElement;
	canvas: HTMLCanvasElement;
	nodes: RenderNode[] = [];
	links: RenderLink[] = [];
	// The view transform: world origin at the canvas centre plus (x, y), scaled by k.
	transform = { x: 0, y: 0, k: 1 };
	// Timings of recent frames in milliseconds, for checking smoothness.
	stats = { frames: 0, drawMs: 0, tickMs: 0, maxDrawMs: 0 };
	#ctx: CanvasRenderingContext2D;
	#callbacks: RendererCallbacks;
	#sim: Simulation<RenderNode, RenderLink>;
	#linkForce: ForceLink<RenderNode, RenderLink>;
	#charge: ForceManyBody<RenderNode>;
	#centerX: ForceX<RenderNode>;
	#centerY: ForceY<RenderNode>;
	#neighbours = new Map<RenderNode, Set<RenderNode>>();
	#display: Display;
	#palette!: Palette;
	#font = "sans-serif";
	#width = 0;
	#height = 0;
	#dpr = 1;
	#frame = 0;
	#dirty = true;
	#hovered: RenderNode | null = null;
	// The hovered node's highlight, faded in and out.
	#highlight: RenderNode | null = null;
	#fade = 0;
	#pointer: { id: number; x: number; y: number; node: RenderNode | null; moved: boolean; button: number } | null = null;
	#resize: ResizeObserver;

	constructor(containerEl: HTMLElement, options: GraphOptions, callbacks: RendererCallbacks) {
		this.containerEl = containerEl;
		this.#callbacks = callbacks;
		this.#display = options;
		this.transform.k = options.scale;
		this.canvas = containerEl.createEl("canvas", { cls: "graph-canvas" });
		this.#ctx = this.canvas.getContext("2d")!;
		this.#linkForce = forceLink<RenderNode, RenderLink>().id((n) => n.id);
		this.#charge = forceManyBody<RenderNode>();
		this.#centerX = forceX<RenderNode>(0);
		this.#centerY = forceY<RenderNode>(0);
		this.#sim = forceSimulation<RenderNode, RenderLink>()
			.stop()
			.force("link", this.#linkForce)
			.force("charge", this.#charge)
			.force("x", this.#centerX)
			.force("y", this.#centerY)
			.alphaDecay(ALPHA_DECAY);
		this.setForces(options);
		this.readTheme();
		this.#resize = new ResizeObserver(() => this.#measure());
		this.#resize.observe(containerEl);
		this.#bindInput();
	}

	destroy() {
		cancelAnimationFrame(this.#frame);
		this.#frame = 0;
		this.#resize.disconnect();
		this.#sim.stop();
		this.canvas.remove();
	}

	readTheme() {
		this.#palette = Object.fromEntries(Object.entries(PROBES).map(([key, cls]) => [key, probeColor(this.containerEl, cls)])) as Palette;
		this.#font = getComputedStyle(this.containerEl).getPropertyValue("--font-interface").trim() || getComputedStyle(this.containerEl).fontFamily || "sans-serif";
		this.#wake();
	}

	// New nodes and links; nodes that stay keep their place, new ones start
	// next to a node they link to.
	setData(data: GraphData, decorate: Decorate) {
		const old = new Map(this.nodes.map((n) => [n.id, n]));
		const first = !this.nodes.length;
		const nodes = data.nodes.map((n) => {
			const prev = old.get(n.id);
			const look = decorate(n.id, n.type);
			const node: RenderNode = prev ?? { id: n.id, type: n.type, weight: 0, label: "", color: null, focused: false, x: Number.NaN, y: Number.NaN };
			Object.assign(node, { type: n.type, weight: n.weight, label: look.label, color: look.color, focused: !!look.focused });
			return node;
		});
		const byId = new Map(nodes.map((n) => [n.id, n]));
		const links = data.links.map((l) => ({ source: byId.get(l.source)!, target: byId.get(l.target)! }));
		this.#neighbours = new Map(nodes.map((n) => [n, new Set()]));
		for (const l of links) {
			this.#neighbours.get(l.source)!.add(l.target);
			this.#neighbours.get(l.target)!.add(l.source);
		}
		let added = false;
		for (const node of nodes) {
			if (!Number.isNaN(node.x)) continue;
			added = true;
			const anchor = [...this.#neighbours.get(node)!].find((n) => !Number.isNaN(n.x));
			const spread = first ? 0 : 30;
			if (anchor) {
				node.x = anchor.x + (Math.random() - 0.5) * spread;
				node.y = anchor.y + (Math.random() - 0.5) * spread;
			} else if (!first) {
				node.x = (Math.random() - 0.5) * 200;
				node.y = (Math.random() - 0.5) * 200;
			}
		}
		// d3 places nodes without a position on its phyllotaxis spiral.
		for (const node of nodes) {
			if (Number.isNaN(node.x)) {
				delete (node as Partial<RenderNode>).x;
				delete (node as Partial<RenderNode>).y;
			}
		}
		if (this.#hovered && !byId.has(this.#hovered.id)) this.#hovered = null;
		if (this.#highlight && !byId.has(this.#highlight.id)) this.#highlight = null;
		this.nodes = nodes;
		this.links = links;
		this.#sim.nodes(nodes);
		this.#linkForce.links(links);
		const changed = first || added || nodes.length !== old.size;
		this.#sim.alpha(first ? 1 : changed ? Math.max(this.#sim.alpha(), 0.3) : this.#sim.alpha());
		this.#wake();
	}

	// Moves the layout so `id` sits at the origin, in the middle of the view.
	centerOn(id: string) {
		const focus = this.nodes.find((n) => n.id === id);
		if (!focus) return;
		const { x, y } = focus;
		for (const n of this.nodes) {
			n.x -= x;
			n.y -= y;
		}
		this.transform.x = 0;
		this.transform.y = 0;
		this.#wake();
	}

	setDisplay(display: Display) {
		this.#display = { ...display };
		this.#wake();
	}

	setForces(forces: Forces) {
		// Obsidian's sliders mapped onto d3's units: link distance in world
		// units, repulsion as a many-body charge, the centre force as a pull
		// towards the origin, the link force scaling d3's degree-based default.
		const degree = (n: RenderNode) => Math.max(1, this.#neighbours.get(n)?.size ?? 1);
		this.#linkForce.distance(forces.linkDistance * 0.4).strength((l) => forces.linkStrength / Math.min(degree(l.source), degree(l.target)));
		this.#charge.strength(-forces.repelStrength * 40).theta(0.9);
		this.#centerX.strength(forces.centerStrength * 0.15);
		this.#centerY.strength(forces.centerStrength * 0.15);
		this.reheat();
	}

	reheat(alpha = 0.3) {
		this.#sim.alpha(Math.max(this.#sim.alpha(), alpha));
		this.#wake();
	}

	// Zooms by `factor` keeping the screen point (sx, sy) in place.
	zoomAt(factor: number, sx = this.#width / 2, sy = this.#height / 2) {
		const { x, y, k } = this.transform;
		const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, k * factor));
		const wx = (sx - this.#width / 2 - x) / k;
		const wy = (sy - this.#height / 2 - y) / k;
		this.transform = { x: sx - this.#width / 2 - wx * next, y: sy - this.#height / 2 - wy * next, k: next };
		this.#callbacks.zoom(next);
		this.#wake();
	}

	toWorld(sx: number, sy: number) {
		const { x, y, k } = this.transform;
		return { x: (sx - this.#width / 2 - x) / k, y: (sy - this.#height / 2 - y) / k };
	}

	toScreen(wx: number, wy: number) {
		const { x, y, k } = this.transform;
		return { x: wx * k + this.#width / 2 + x, y: wy * k + this.#height / 2 + y };
	}

	radius(node: RenderNode) {
		return nodeRadius(node.weight, this.#display.nodeSizeMultiplier);
	}

	// The node under the screen point, the topmost (last drawn) first.
	nodeAt(sx: number, sy: number) {
		const p = this.toWorld(sx, sy);
		const slop = 3 / this.transform.k;
		for (let i = this.nodes.length - 1; i >= 0; i--) {
			const n = this.nodes[i];
			const r = this.radius(n) + slop;
			const dx = n.x - p.x;
			const dy = n.y - p.y;
			if (dx * dx + dy * dy <= r * r) return n;
		}
		return null;
	}

	get hovered() {
		return this.#hovered;
	}

	#measure() {
		const rect = this.containerEl.getBoundingClientRect();
		this.#dpr = window.devicePixelRatio || 1;
		this.#width = rect.width;
		this.#height = rect.height;
		this.canvas.width = Math.max(1, Math.round(rect.width * this.#dpr));
		this.canvas.height = Math.max(1, Math.round(rect.height * this.#dpr));
		this.canvas.style.width = `${rect.width}px`;
		this.canvas.style.height = `${rect.height}px`;
		this.#wake();
	}

	#wake() {
		this.#dirty = true;
		if (!this.#frame) this.#frame = requestAnimationFrame(() => this.#loop());
	}

	#loop() {
		this.#frame = 0;
		// A hidden view (another tab in front) draws nothing until it shows.
		if (!this.#width || !this.#height || !this.canvas.isConnected) return;
		const moving = this.#sim.alpha() >= this.#sim.alphaMin();
		if (moving) {
			// Several steps a frame while time allows, so a big graph settles in
			// a few seconds without dropping frames.
			const start = performance.now();
			let steps = 0;
			do {
				this.#sim.tick();
				steps++;
			} while (steps < MAX_STEPS && this.#sim.alpha() >= this.#sim.alphaMin() && !this.#pointer?.node && performance.now() - start < STEP_BUDGET_MS);
			this.stats.tickMs = this.stats.tickMs * 0.9 + ((performance.now() - start) / steps) * 0.1;
		}
		const target = this.#hovered ? 1 : 0;
		if (this.#hovered) this.#highlight = this.#hovered;
		const fading = this.#fade !== target;
		if (fading) this.#fade = target ? Math.min(1, this.#fade + 0.15) : Math.max(0, this.#fade - 0.15);
		if (!this.#fade) this.#highlight = null;
		if (moving || fading || this.#dirty) {
			const t = performance.now();
			this.#draw();
			const ms = performance.now() - t;
			this.stats.frames++;
			this.stats.drawMs = this.stats.drawMs * 0.9 + ms * 0.1;
			this.stats.maxDrawMs = Math.max(this.stats.maxDrawMs, ms);
		}
		this.#dirty = false;
		if (moving || fading || this.#pointer?.node) this.#frame = requestAnimationFrame(() => this.#loop());
	}

	#draw() {
		const ctx = this.#ctx;
		const { x, y, k } = this.transform;
		const dpr = this.#dpr;
		const palette = this.#palette;
		const display = this.#display;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (this.#width / 2 + x), dpr * (this.#height / 2 + y));
		// The visible world rectangle, for culling.
		const left = (-this.#width / 2 - x) / k;
		const top = (-this.#height / 2 - y) / k;
		const right = left + this.#width / k;
		const bottom = top + this.#height / k;
		const visible = (n: RenderNode, margin: number) => n.x + margin >= left && n.x - margin <= right && n.y + margin >= top && n.y - margin <= bottom;

		const focus = this.#highlight;
		const near = focus ? this.#neighbours.get(focus) : null;
		const lit = (n: RenderNode) => !focus || n === focus || !!near?.has(n);
		const dim = 1 - 0.8 * this.#fade;

		// Links: the ones off the highlighted node first, then its own on top.
		const lineWidth = Math.max(display.lineSizeMultiplier, 0.6 / k);
		ctx.lineWidth = lineWidth;
		const own: RenderLink[] = [];
		ctx.beginPath();
		for (const l of this.links) {
			const a = l.source;
			const b = l.target;
			if (Math.max(a.x, b.x) < left || Math.min(a.x, b.x) > right || Math.max(a.y, b.y) < top || Math.min(a.y, b.y) > bottom) continue;
			if (focus && (a === focus || b === focus)) {
				own.push(l);
				continue;
			}
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(b.x, b.y);
		}
		ctx.globalAlpha = focus ? dim : 1;
		ctx.strokeStyle = palette.line;
		ctx.stroke();
		ctx.globalAlpha = 1;
		if (own.length) {
			ctx.beginPath();
			for (const l of own) {
				ctx.moveTo(l.source.x, l.source.y);
				ctx.lineTo(l.target.x, l.target.y);
			}
			ctx.strokeStyle = this.#fade < 1 ? palette.line : palette.lineHighlight;
			ctx.lineWidth = lineWidth * (1 + this.#fade);
			ctx.stroke();
			ctx.lineWidth = lineWidth;
		}
		// Arrows show once they are big enough to see.
		if (display.showArrow && k > 0.3) {
			const size = Math.max(4, 3 * display.lineSizeMultiplier + 3);
			ctx.beginPath();
			for (const l of this.links) {
				const a = l.source;
				const b = l.target;
				if (!visible(b, 0)) continue;
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const len = Math.hypot(dx, dy);
				if (len < 1) continue;
				const ux = dx / len;
				const uy = dy / len;
				const r = this.radius(b);
				const tipX = b.x - ux * r;
				const tipY = b.y - uy * r;
				ctx.moveTo(tipX, tipY);
				ctx.lineTo(tipX - ux * size * 2 - uy * size, tipY - uy * size * 2 + ux * size);
				ctx.lineTo(tipX - ux * size * 2 + uy * size, tipY - uy * size * 2 - ux * size);
				ctx.closePath();
			}
			ctx.globalAlpha = focus ? dim : 1;
			ctx.fillStyle = palette.arrow;
			ctx.fill();
			ctx.globalAlpha = 1;
		}

		// Nodes, batched by colour; dimmed ones in a pass of their own.
		const batches = new Map<string, RenderNode[]>();
		const dimmed = new Map<string, RenderNode[]>();
		for (const n of this.nodes) {
			if (!visible(n, 30)) continue;
			const fill = this.#fill(n);
			const into = lit(n) ? batches : dimmed;
			let list = into.get(fill);
			if (!list) into.set(fill, (list = []));
			list.push(n);
		}
		const paint = (groups: Map<string, RenderNode[]>, alpha: number) => {
			ctx.globalAlpha = alpha;
			for (const [fill, list] of groups) {
				ctx.beginPath();
				for (const n of list) {
					const r = Math.max(this.radius(n), 1.5 / k);
					ctx.moveTo(n.x + r, n.y);
					ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
				}
				ctx.fillStyle = fill;
				ctx.fill();
			}
		};
		paint(dimmed, dim);
		paint(batches, 1);
		if (focus && this.#fade > 0) {
			ctx.beginPath();
			const r = Math.max(this.radius(focus), 1.5 / k);
			ctx.arc(focus.x, focus.y, r, 0, Math.PI * 2);
			ctx.globalAlpha = this.#fade;
			ctx.fillStyle = palette.fillHighlight;
			ctx.fill();
		}
		ctx.globalAlpha = 1;

		// Labels fade with zoom; the highlighted node's and its neighbours'
		// always show.
		const base = labelAlpha(k, display.textFadeMultiplier);
		if (base <= 0 && !focus) return;
		ctx.font = `${FONT_SIZE}px ${this.#font}`;
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		ctx.fillStyle = palette.text;
		for (const n of this.nodes) {
			let alpha = base;
			if (focus) alpha = lit(n) ? Math.max(base, this.#fade) : base * dim;
			if (alpha <= 0.02 || !visible(n, 200)) continue;
			ctx.globalAlpha = alpha;
			ctx.fillText(n.label, n.x, n.y + this.radius(n) + 4);
		}
		ctx.globalAlpha = 1;
	}

	#fill(n: RenderNode) {
		const p = this.#palette;
		if (n.focused) return p.focused;
		if (n.color) return n.color;
		if (n.type === "tag") return p.tag;
		if (n.type === "attachment") return p.attachment;
		if (n.type === "unresolved") return p.unresolved;
		return p.fill;
	}

	#bindInput() {
		const canvas = this.canvas;
		const local = (evt: MouseEvent) => {
			const rect = canvas.getBoundingClientRect();
			return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
		};
		canvas.addEventListener("pointerdown", (evt) => {
			if (this.#pointer || (evt.button !== 0 && evt.button !== 1)) return;
			const p = local(evt);
			const node = this.nodeAt(p.x, p.y);
			this.#pointer = { id: evt.pointerId, x: p.x, y: p.y, node, moved: false, button: evt.button };
			canvas.setPointerCapture(evt.pointerId);
			if (node) {
				node.fx = node.x;
				node.fy = node.y;
				this.#sim.alphaTarget(0.3);
				this.reheat();
			}
		});
		canvas.addEventListener("pointermove", (evt) => {
			const p = local(evt);
			const drag = this.#pointer;
			if (drag && drag.id === evt.pointerId) {
				if (!drag.moved && Math.hypot(p.x - drag.x, p.y - drag.y) < 3) return;
				if (drag.node) {
					const w = this.toWorld(p.x, p.y);
					drag.node.fx = w.x;
					drag.node.fy = w.y;
				} else {
					this.transform.x += p.x - drag.x;
					this.transform.y += p.y - drag.y;
				}
				drag.moved = true;
				drag.x = p.x;
				drag.y = p.y;
				canvas.addClass("is-dragging");
				this.#wake();
				return;
			}
			this.#hover(this.nodeAt(p.x, p.y));
		});
		const end = (evt: PointerEvent, cancelled: boolean) => {
			const drag = this.#pointer;
			if (!drag || drag.id !== evt.pointerId) return;
			this.#pointer = null;
			canvas.removeClass("is-dragging");
			if (drag.node) {
				drag.node.fx = null;
				drag.node.fy = null;
				this.#sim.alphaTarget(0);
				this.#wake();
				if (!drag.moved && !cancelled) this.#callbacks.click(drag.node, evt);
			}
		};
		canvas.addEventListener("pointerup", (evt) => end(evt, false));
		canvas.addEventListener("pointercancel", (evt) => end(evt, true));
		canvas.addEventListener("pointerleave", () => {
			if (!this.#pointer) this.#hover(null);
		});
		canvas.addEventListener("contextmenu", (evt) => {
			const p = local(evt);
			const node = this.nodeAt(p.x, p.y);
			if (!node) return;
			evt.preventDefault();
			this.#callbacks.menu(node, evt);
		});
		canvas.addEventListener(
			"wheel",
			(evt) => {
				evt.preventDefault();
				const p = local(evt);
				const lines = evt.deltaMode === 1 ? 16 : evt.deltaMode === 2 ? this.#height : 1;
				// A pinch arrives as a wheel with ctrlKey and small deltas.
				const speed = evt.ctrlKey ? 0.01 : 0.002;
				this.zoomAt(Math.exp(-evt.deltaY * lines * speed), p.x, p.y);
			},
			{ passive: false },
		);
	}

	#hover(node: RenderNode | null) {
		if (node === this.#hovered) return;
		this.#hovered = node;
		this.canvas.toggleClass("is-hovering", !!node);
		this.#wake();
	}
}
