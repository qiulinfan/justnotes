// The graph view's data: its options (Obsidian's graph.json and the local
// graph's view state), the search language its filter and groups use, and the
// nodes and links it shows. No DOM here; the view lives in graph-view.ts.

export interface ColorGroup {
	query: string;
	// Obsidian's shape: the colour as a 24-bit integer, and its alpha.
	color: { a: number; rgb: number };
}

export interface GraphOptions {
	search: string;
	showTags: boolean;
	showAttachments: boolean;
	hideUnresolved: boolean;
	showOrphans: boolean;
	colorGroups: ColorGroup[];
	showArrow: boolean;
	textFadeMultiplier: number;
	nodeSizeMultiplier: number;
	lineSizeMultiplier: number;
	centerStrength: number;
	repelStrength: number;
	linkStrength: number;
	linkDistance: number;
	scale: number;
	close: boolean;
	"collapse-filter": boolean;
	"collapse-color-groups": boolean;
	"collapse-display": boolean;
	"collapse-forces": boolean;
	// The local graph's own.
	localJumps: number;
	localBacklinks: boolean;
	localForelinks: boolean;
	localInterlinks: boolean;
}

// Obsidian's defaults, those of a vault without graph.json.
export const DEFAULT_OPTIONS: GraphOptions = {
	search: "",
	showTags: false,
	showAttachments: false,
	hideUnresolved: false,
	showOrphans: true,
	colorGroups: [],
	showArrow: false,
	textFadeMultiplier: 0,
	nodeSizeMultiplier: 1,
	lineSizeMultiplier: 1,
	centerStrength: 0.518713248970312,
	repelStrength: 10,
	linkStrength: 1,
	linkDistance: 250,
	scale: 1,
	close: true,
	"collapse-filter": true,
	"collapse-color-groups": true,
	"collapse-display": true,
	"collapse-forces": true,
	localJumps: 1,
	localBacklinks: true,
	localForelinks: true,
	localInterlinks: false,
};

// The sliders' ranges, as in Obsidian's graph controls; options outside them
// are clamped.
export const LIMITS = {
	textFadeMultiplier: [-3, 3, 0.1],
	nodeSizeMultiplier: [0.1, 5, 0.01],
	lineSizeMultiplier: [0.1, 5, 0.01],
	centerStrength: [0, 1, 0.01],
	repelStrength: [0, 20, 0.01],
	linkStrength: [0, 1, 0.01],
	linkDistance: [30, 500, 1],
	localJumps: [1, 5, 1],
	scale: [1 / 64, 16, 0],
} as const satisfies Partial<Record<keyof GraphOptions, readonly [number, number, number]>>;

// Options from graph.json or a saved view state over `base`: fields of the
// wrong type are ignored, numbers clamped, groups without a query dropped.
export function readOptions(raw: unknown, base: GraphOptions = DEFAULT_OPTIONS): GraphOptions {
	const options: GraphOptions = { ...base, colorGroups: base.colorGroups.map((g) => ({ query: g.query, color: { ...g.color } })) };
	if (!raw || typeof raw !== "object") return options;
	const record = raw as Record<string, unknown>;
	const target = options as unknown as Record<string, unknown>;
	for (const key of Object.keys(DEFAULT_OPTIONS) as (keyof GraphOptions)[]) {
		const value = record[key];
		const kind = typeof DEFAULT_OPTIONS[key];
		if (key === "colorGroups" || typeof value !== kind) continue;
		if (kind === "number") {
			if (!Number.isFinite(value)) continue;
			const limits = (LIMITS as Record<string, readonly number[]>)[key];
			target[key] = limits ? Math.min(limits[1], Math.max(limits[0], value as number)) : value;
		} else target[key] = value;
	}
	if (Array.isArray(record.colorGroups)) {
		options.colorGroups = record.colorGroups.flatMap((g) => {
			if (!g || typeof g.query !== "string") return [];
			const rgb = Number(g.color?.rgb);
			const a = Number(g.color?.a ?? 1);
			return [{ query: g.query, color: { rgb: Number.isFinite(rgb) ? rgb & 0xffffff : 0, a: Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 1 } }];
		});
	}
	return options;
}

export function colorCss(color: ColorGroup["color"]) {
	return `rgba(${(color.rgb >> 16) & 255}, ${(color.rgb >> 8) & 255}, ${color.rgb & 255}, ${color.a})`;
}

export function colorHex(rgb: number) {
	return `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`;
}

// What a query tests a file by. `text` is null when the file was not read
// (attachments), so content terms fail on it.
export interface QuerySubject {
	path: string;
	tags: string[];
	frontmatter: Record<string, unknown> | null;
	text: string | null;
}

export interface Query {
	// Whether the query looks at file contents, which the caller must read.
	needsText: boolean;
	test(subject: QuerySubject): boolean;
}

type Node =
	| { kind: "and" | "or"; items: Node[] }
	| { kind: "not"; item: Node }
	| { kind: "term"; op: string; value: string | RegExp; caseSensitive: boolean }
	| { kind: "prop"; name: string; value: string | null };

// Obsidian's search syntax, as far as the graph needs it: words and "quoted
// phrases" (all must match), OR, -negation, (groups), /regex/, the operators
// file:, path:, tag:, content:, line:, block:, section:, match-case: and
// ignore-case:, and [property] / [property:value]. A plain term matches the
// path or the contents, ignoring case.
export function compileQuery(query: string): Query | null {
	const tokens = tokenize(query);
	if (!tokens.length) return null;
	let pos = 0;
	const parseOr = (): Node => {
		const items = [parseAnd()];
		while (tokens[pos] === "OR") {
			pos++;
			items.push(parseAnd());
		}
		return items.length === 1 ? items[0] : { kind: "or", items };
	};
	const parseAnd = (): Node => {
		const items: Node[] = [];
		while (pos < tokens.length && tokens[pos] !== ")" && tokens[pos] !== "OR") items.push(parseUnary());
		return items.length === 1 ? items[0] : { kind: "and", items };
	};
	const parseUnary = (): Node => {
		const token = tokens[pos++];
		if (token === "-") return { kind: "not", item: pos < tokens.length ? parseUnary() : { kind: "and", items: [] } };
		if (token === "(") {
			const inner = parseOr();
			if (tokens[pos] === ")") pos++;
			return inner;
		}
		return atom(token);
	};
	const root = parseOr();
	const needsText = usesText(root);
	return { needsText, test: (subject) => evaluate(root, subject) };
}

// Tokens: ( ) - OR, [property...], and terms with an optional `op:` prefix,
// whose value may be quoted or a /regex/.
function tokenize(query: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < query.length) {
		const ch = query[i];
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (ch === "(" || ch === ")") {
			tokens.push(ch);
			i++;
			continue;
		}
		if (ch === "-" && i + 1 < query.length && !/\s/.test(query[i + 1])) {
			tokens.push("-");
			i++;
			continue;
		}
		if (ch === "[") {
			const end = query.indexOf("]", i);
			const stop = end < 0 ? query.length : end + 1;
			tokens.push(query.slice(i, stop));
			i = stop;
			continue;
		}
		const start = i;
		const op = /^([a-z-]+):/i.exec(query.slice(i));
		if (op) i += op[0].length;
		if (query[i] === '"') {
			const end = query.indexOf('"', i + 1);
			i = end < 0 ? query.length : end + 1;
		} else if (query[i] === "/") {
			const end = query.indexOf("/", i + 1);
			i = end < 0 ? query.length : end + 1;
			while (i < query.length && /[a-z]/.test(query[i])) i++;
		} else {
			while (i < query.length && !/[\s()]/.test(query[i])) i++;
		}
		if (i === start) i++;
		tokens.push(query.slice(start, i));
	}
	return tokens;
}

const OPS = new Set(["file", "path", "tag", "content", "line", "block", "section", "match-case", "ignore-case"]);

function atom(token: string): Node {
	const prop = /^\[([^:\]]*)(?::([^\]]*))?\]?$/.exec(token);
	if (token.startsWith("[") && prop) return { kind: "prop", name: prop[1].trim().toLowerCase(), value: prop[2] === undefined ? null : unquote(prop[2].trim()).toLowerCase() };
	const m = /^([a-z-]+):(.*)$/i.exec(token);
	let op = "";
	let raw = token;
	if (m && OPS.has(m[1].toLowerCase())) {
		op = m[1].toLowerCase();
		raw = m[2];
	}
	const caseSensitive = op === "match-case";
	if (op === "match-case" || op === "ignore-case") op = "";
	const re = /^\/(.+)\/([a-z]*)$/.exec(raw);
	if (re) {
		try {
			return { kind: "term", op, value: new RegExp(re[1], re[2].replace("g", "")), caseSensitive };
		} catch {
			// An unfinished regex is a plain term while it is being typed.
		}
	}
	const value = unquote(raw);
	return { kind: "term", op, value: caseSensitive ? value : value.toLowerCase(), caseSensitive };
}

function unquote(value: string) {
	return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value.replace(/^"/, "");
}

function usesText(node: Node): boolean {
	if (node.kind === "and" || node.kind === "or") return node.items.some(usesText);
	if (node.kind === "not") return usesText(node.item);
	if (node.kind !== "term") return false;
	return node.op !== "file" && node.op !== "path" && node.op !== "tag";
}

function evaluate(node: Node, s: QuerySubject): boolean {
	switch (node.kind) {
		case "and":
			return node.items.every((n) => evaluate(n, s));
		case "or":
			return node.items.some((n) => evaluate(n, s));
		case "not":
			return !evaluate(node.item, s);
		case "prop":
			return propMatches(s.frontmatter, node.name, node.value);
		case "term":
			return termMatches(node, s);
	}
}

function termMatches(node: Extract<Node, { kind: "term" }>, s: QuerySubject) {
	const has = (text: string | null) => {
		if (text === null) return false;
		if (node.value instanceof RegExp) return node.value.test(text);
		return (node.caseSensitive ? text : text.toLowerCase()).includes(node.value);
	};
	if (node.value === "") return true;
	switch (node.op) {
		case "file":
			return has(s.path.slice(s.path.lastIndexOf("/") + 1));
		case "path":
			return has(s.path);
		case "tag": {
			if (node.value instanceof RegExp) return s.tags.some((t) => (node.value as RegExp).test(`#${t}`));
			const tag = node.value.replace(/^#/, "").toLowerCase();
			return s.tags.some((t) => t === tag || t.startsWith(`${tag}/`));
		}
		case "":
			return has(s.path) || has(s.text);
		default:
			return has(s.text);
	}
}

function propMatches(frontmatter: Record<string, unknown> | null, name: string, value: string | null) {
	if (!frontmatter) return false;
	const key = Object.keys(frontmatter).find((k) => k.toLowerCase() === name);
	if (key === undefined) return false;
	if (value === null) return true;
	const values = ([] as unknown[]).concat(frontmatter[key]);
	return values.some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(value));
}

export type NodeType = "file" | "attachment" | "tag" | "unresolved";

// What a colour group's query tests a tag or unresolved node by, as Obsidian
// colours them: a tag node is a subject carrying that tag (and named by it),
// an unresolved node one at the link's text. Neither has contents or
// properties, so content and property terms never match them.
export function nodeSubject(id: string, type: "tag" | "unresolved"): QuerySubject {
	return { path: id, tags: type === "tag" ? [id.replace(/^#/, "").toLowerCase()] : [], frontmatter: null, text: null };
}

export interface GraphNode {
	id: string;
	type: NodeType;
	// The number of links touching it, which sets its size.
	weight: number;
}

export interface GraphLink {
	source: string;
	target: string;
}

export interface GraphData {
	nodes: GraphNode[];
	links: GraphLink[];
}

export interface GraphFile {
	path: string;
	extension: string;
	// Lowercased, without '#'.
	tags: string[];
}

export interface GraphSource {
	files: GraphFile[];
	resolvedLinks: Record<string, Record<string, number>>;
	unresolvedLinks: Record<string, Record<string, number>>;
	// The search filter; files failing it are left out.
	filter?: (file: GraphFile) => boolean;
}

// The global graph: Markdown notes, attachments when shown, a node per
// unresolved link text unless "existing files only", a node per tag when
// shown; then, without orphans, every node no link touches is dropped.
export function buildGraph(source: GraphSource, options: Pick<GraphOptions, "showTags" | "showAttachments" | "hideUnresolved" | "showOrphans">): GraphData {
	const nodes = new Map<string, GraphNode>();
	const add = (id: string, type: NodeType) => {
		let node = nodes.get(id);
		if (!node) nodes.set(id, (node = { id, type, weight: 0 }));
		return node;
	};
	const notes: GraphFile[] = [];
	for (const file of source.files) {
		const isNote = file.extension === "md";
		if (!isNote && !options.showAttachments) continue;
		if (source.filter && !source.filter(file)) continue;
		add(file.path, isNote ? "file" : "attachment");
		if (isNote) notes.push(file);
	}
	const links: GraphLink[] = [];
	const seen = new Set<string>();
	const link = (from: string, to: string) => {
		if (from === to) return;
		const key = `${from}\n${to}`;
		if (seen.has(key)) return;
		seen.add(key);
		links.push({ source: from, target: to });
		nodes.get(from)!.weight++;
		nodes.get(to)!.weight++;
	};
	for (const note of notes) {
		for (const dest of Object.keys(source.resolvedLinks[note.path] ?? {})) if (nodes.has(dest)) link(note.path, dest);
		if (!options.hideUnresolved) {
			for (const text of Object.keys(source.unresolvedLinks[note.path] ?? {})) {
				if (!nodes.has(text)) add(text, "unresolved");
				if (nodes.get(text)!.type === "unresolved") link(note.path, text);
			}
		}
		if (options.showTags) {
			for (const tag of note.tags) {
				const id = `#${tag}`;
				if (!nodes.has(id)) add(id, "tag");
				if (nodes.get(id)!.type === "tag") link(note.path, id);
			}
		}
	}
	let list = [...nodes.values()];
	if (!options.showOrphans) list = list.filter((n) => n.weight > 0);
	return { nodes: list, links };
}

// The local graph of `center`: the nodes within `localJumps` links of it,
// following outgoing links, incoming ones, or both. A link between two of
// them shows when it leads one step outward along an enabled direction;
// "neighbor links" adds every other link among them. Weights stay the global
// graph's, so a node keeps its size.
export function localGraph(graph: GraphData, center: string, options: Pick<GraphOptions, "localJumps" | "localBacklinks" | "localForelinks" | "localInterlinks">): GraphData {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const centerNode = byId.get(center);
	if (!centerNode) return { nodes: [], links: [] };
	const out = new Map<string, string[]>();
	const into = new Map<string, string[]>();
	for (const l of graph.links) {
		(out.get(l.source) ?? out.set(l.source, []).get(l.source)!).push(l.target);
		(into.get(l.target) ?? into.set(l.target, []).get(l.target)!).push(l.source);
	}
	const depth = new Map([[center, 0]]);
	let frontier = [center];
	for (let step = 1; step <= options.localJumps && frontier.length; step++) {
		const next: string[] = [];
		for (const id of frontier) {
			const near = [...(options.localForelinks ? (out.get(id) ?? []) : []), ...(options.localBacklinks ? (into.get(id) ?? []) : [])];
			for (const other of near) {
				if (depth.has(other)) continue;
				depth.set(other, step);
				next.push(other);
			}
		}
		frontier = next;
	}
	const links = graph.links.filter((l) => {
		const a = depth.get(l.source);
		const b = depth.get(l.target);
		if (a === undefined || b === undefined) return false;
		if (options.localForelinks && b === a + 1) return true;
		if (options.localBacklinks && a === b + 1) return true;
		return options.localInterlinks;
	});
	return { nodes: graph.nodes.filter((n) => depth.has(n.id)), links };
}
