import { ensureSyntaxTree, foldedRanges, indentUnit, syntaxTree } from "@codemirror/language";
import { Annotation, type ChangeSet, type ChangeSpec, EditorSelection, EditorState, type Extension, MapMode, type StateCommand, type Text, type Transaction, type TransactionSpec } from "@codemirror/state";
import type { KeyBinding } from "@codemirror/view";

// List editing: Tab and Shift+Tab move an item with its children, Enter,
// Shift+Enter and Backspace follow the item's markup, and ordered lists keep
// their numbers in sequence after any edit that changes their lines.
//
// The structure comes from the text, read as CommonMark reads it (tab stops
// every 4 columns, an item's children at or past its content column, at most
// 3 columns past it for a list item, lazy continuation lines, an ordered list
// interrupting a paragraph only from 1). Obsidian's reading view follows the
// same rules, so the edits never turn a list into code or text there.

const TAB = 4;
const nextStop = (col: number) => col + TAB - (col % TAB);

function columnAt(text: string, end: number, from = 0, col = 0) {
	for (let i = from; i < end; i++) col = text.charCodeAt(i) === 9 ? nextStop(col) : col + 1;
	return col;
}

const QUOTE = /^[ \t]*>[ \t]?/;

// The length of the first `depth` quote markers of a line, or null when it
// has fewer.
function quotePrefix(text: string, depth: number): number | null {
	let at = 0;
	for (let i = 0; i < depth; i++) {
		const m = QUOTE.exec(text.slice(at));
		if (!m) return null;
		at += m[0].length;
	}
	return at;
}

function quoteDepth(text: string) {
	let depth = 0;
	let at = 0;
	for (let m = QUOTE.exec(text); m; m = QUOTE.exec(text.slice(at))) {
		depth++;
		at += m[0].length;
	}
	return depth;
}

const MARKER = /^(?:([-*+])|(\d{1,9})([.)]))(?=[ \t]|$)/;
const RULE = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const TASK = /^\[(.)\](?=[ \t]|$)[ \t]?/;
const FENCE = /^(`{3,}|~{3,})/;
const BLOCK_START = /^(?:`{3,}|~{3,}|\$\$|#{1,6}(?:[ \t]|$)|>)/;

export interface ListItem {
	n: number; // line number
	from: number; // line start
	q: number; // length of the quote prefix
	base: number; // column after the quote prefix
	ie: number; // index where the indentation ends: the marker
	col: number; // marker column
	bullet: string | null;
	number: number | null;
	digits: string;
	delim: string;
	markerEnd: number; // index after the marker
	space: string; // what separates marker and content
	contentCol: number;
	contentAt: number; // index of the content (the task box, if any)
	task: string | null;
	bodyAt: number; // index of the text after the task box
	empty: boolean; // no text after the marker and task box
	list: List;
	parent: ListItem | null;
	kids: List[];
	last: number; // last non-blank line of the item
}

export interface List {
	items: ListItem[];
	parent: ListItem | null;
	ordered: boolean;
	bullet: string;
	delim: string;
	prev: List | null; // an adjacent list of another kind at the same level
}

type Kind = "item" | "para" | "code" | "fence" | "other" | "blank" | "out";

export interface ListStructure {
	depth: number;
	items: ListItem[];
	lists: List[];
	kinds: Map<number, Kind>;
	byLine: Map<number, ListItem>;
}

interface Marker {
	bullet: string | null;
	number: number | null;
	digits: string;
	delim: string;
	markerEnd: number;
	space: string;
	contentCol: number;
	contentAt: number;
	task: string | null;
	bodyAt: number;
	empty: boolean;
}

function parseMarker(text: string, ie: number, col: number): Marker | null {
	const rest = text.slice(ie);
	if (RULE.test(rest)) return null;
	const m = MARKER.exec(rest);
	if (!m) return null;
	const markerEnd = ie + m[0].length;
	const markerEndCol = col + m[0].length;
	let sp = markerEnd;
	while (sp < text.length && (text[sp] === " " || text[sp] === "\t")) sp++;
	const spCol = columnAt(text, sp, markerEnd, markerEndCol);
	let contentCol = spCol;
	let contentAt = sp;
	const atEnd = sp === text.length;
	if (atEnd || spCol - markerEndCol > 4) {
		// An empty item, or content starting with indented code: the content
		// column is one past the marker.
		contentCol = markerEndCol + 1;
		contentAt = atEnd ? sp : markerEnd + 1;
	}
	let task: string | null = null;
	let bodyAt = contentAt;
	const t = atEnd ? null : TASK.exec(text.slice(contentAt));
	if (t) {
		task = t[1];
		bodyAt = contentAt + t[0].length;
	}
	return {
		bullet: m[1] ?? null,
		number: m[2] ? Number(m[2]) : null,
		digits: m[2] ?? "",
		delim: m[3] ?? "",
		markerEnd,
		space: text.slice(markerEnd, contentAt),
		contentCol,
		contentAt,
		task,
		bodyAt,
		empty: !text.slice(bodyAt).trim(),
	};
}

const compatible = (list: List, m: Marker) => (m.bullet ? !list.ordered && list.bullet === m.bullet : list.ordered && list.delim === m.delim);

// Read the lists of the lines at quote depth `depth` from line `start` until
// the structure open after line `until` ends.
export function scanLists(doc: Text, start: number, depth: number, until: number): ListStructure {
	const items: ListItem[] = [];
	const lists: List[] = [];
	const kinds = new Map<number, Kind>();
	const byLine = new Map<number, ListItem>();
	let stack: ListItem[] = [];
	let para = false;
	let fence: { ch: string; len: number } | null = null;
	let math = false;
	let comment = false;
	const touch = (n: number) => {
		for (const item of stack) item.last = n;
	};
	let n = start;
	if (n === 1 && doc.lines > 1 && /^---[ \t]*$/.test(doc.line(1).text)) {
		for (n = 2; n <= doc.lines; n++) {
			if (/^(?:---|\.\.\.)[ \t]*$/.test(doc.line(n).text)) {
				n++;
				break;
			}
		}
	}
	for (; n <= doc.lines; n++) {
		if (n > until && !stack.length && !fence && !math && !comment) break;
		const line = doc.line(n);
		const text = line.text;
		const q = quotePrefix(text, depth);
		if (q === null) {
			stack = [];
			para = false;
			fence = null;
			math = comment = false;
			kinds.set(n, "out");
			continue;
		}
		let ie = q;
		while (ie < text.length && (text[ie] === " " || text[ie] === "\t")) ie++;
		const base = columnAt(text, q);
		const col = columnAt(text, ie, q, base);
		const rest = text.slice(ie);
		if (fence || math || comment) {
			kinds.set(n, "fence");
			if (fence) {
				const close = FENCE.exec(rest);
				if (close && close[1][0] === fence.ch && close[1].length >= fence.len && !rest.slice(close[1].length).trim()) fence = null;
			} else if (math) {
				if (rest.includes("$$")) math = false;
			} else if (rest.includes("%%")) comment = false;
			if (rest) touch(n);
			continue;
		}
		if (!rest) {
			para = false;
			kinds.set(n, "blank");
			continue;
		}
		let k = 0;
		while (k < stack.length && stack[k].contentCol <= col) k++;
		const parentCol = k ? stack[k - 1].contentCol : base;
		const m = col - parentCol < 4 ? parseMarker(text, ie, col) : null;
		const sibling = k < stack.length ? stack[k] : null;
		const joins = !!(m && sibling && compatible(sibling.list, m));
		// A new ordered list may interrupt a paragraph only from 1; otherwise
		// the line continues the paragraph. (CommonMark also keeps an empty item
		// from interrupting one, but an empty item is being typed: Enter and Tab
		// on it act on the item.)
		if (m && (joins || !para || m.number === null || m.number === 1)) {
			const parent = k ? stack[k - 1] : null;
			let list: List;
			if (joins) list = sibling!.list;
			else {
				list = { items: [], parent, ordered: m.number !== null, bullet: m.bullet ?? "", delim: m.delim, prev: sibling?.list ?? null };
				lists.push(list);
				parent?.kids.push(list);
			}
			const item: ListItem = { n, from: line.from, q, base, ie, col, ...m, list, parent, kids: [], last: n };
			list.items.push(item);
			items.push(item);
			byLine.set(n, item);
			stack = stack.slice(0, k);
			stack.push(item);
			touch(n);
			kinds.set(n, "item");
			const body = text.slice(m.bodyAt);
			para = !m.empty && !BLOCK_START.test(body);
			const f = FENCE.exec(body);
			if (f) fence = { ch: f[1][0], len: f[1].length };
			else if (/^\$\$/.test(body) && !body.slice(2).includes("$$")) math = true;
			continue;
		}
		if (k < stack.length) {
			if (para && !BLOCK_START.test(rest) && !RULE.test(rest)) {
				// A lazy continuation line.
				touch(n);
				kinds.set(n, "para");
				continue;
			}
			stack = stack.slice(0, k);
		}
		touch(n);
		if (col - parentCol >= 4 && !para) {
			kinds.set(n, "code");
			continue;
		}
		const f = FENCE.exec(rest);
		if (f) {
			fence = { ch: f[1][0], len: f[1].length };
			kinds.set(n, "fence");
			para = false;
		} else if (/^\$\$/.test(rest) && !rest.slice(2).includes("$$")) {
			math = true;
			kinds.set(n, "fence");
			para = false;
		} else if (/^%%/.test(rest) && !rest.slice(2).includes("%%")) {
			comment = true;
			kinds.set(n, "fence");
			para = false;
		} else if (BLOCK_START.test(rest) || RULE.test(rest)) {
			kinds.set(n, "other");
			para = false;
		} else {
			kinds.set(n, "para");
			para = true;
		}
	}
	return { depth, items, lists, kinds, byLine };
}

// The first line of the blocks a list around `pos` can belong to: the
// top-level block holding it and the lists right before that block. The
// syntax tree knows where code blocks and frontmatter are, which reading
// the text upwards cannot.
function regionStart(state: EditorState, pos: number, ensure: boolean): number {
	const doc = state.doc;
	const line = doc.lineAt(pos);
	const tree = (ensure ? ensureSyntaxTree(state, line.to, 50) : null) ?? syntaxTree(state);
	if (tree.length >= line.to) {
		let block = tree.topNode.childBefore(line.from + 1);
		if (!block) return 1;
		for (let prev = block.prevSibling; prev && (prev.name === "BulletList" || prev.name === "OrderedList"); prev = prev.prevSibling) block = prev;
		return doc.lineAt(block.from).number;
	}
	// Past the parsed text: from the nearest unindented line of text that
	// follows a blank line.
	const stop = Math.max(1, line.number - 5000);
	for (let n = line.number; n > stop; n--) {
		if (/^[^\s>\-*+\d]/.test(doc.line(n).text) && !doc.line(n - 1).text.trim()) return n;
	}
	return stop;
}

export function listStructure(state: EditorState, fromLine: number, toLine: number, depth: number, ensure = true) {
	return scanLists(state.doc, regionStart(state, state.doc.line(fromLine).from, ensure), depth, toLine);
}

// The item whose subtree holds line `n`, innermost first.
function ownerOf(s: ListStructure, n: number): ListItem | null {
	let found: ListItem | null = null;
	for (const item of s.items) {
		if (item.n > n) break;
		if (item.last >= n) found = item;
	}
	return found;
}

const isAncestor = (a: ListItem, b: ListItem) => {
	for (let p = b.parent; p; p = p.parent) if (p === a) return true;
	return false;
};

// Indentation follows what the list already uses; a list with no indented
// lines follows the vault's setting.
type Style = "tab" | "space";
function listStyle(state: EditorState, s: ListStructure, item: ListItem): Style {
	let top = item;
	while (top.parent) top = top.parent;
	const list = top.list;
	const first = list.items[0].n;
	const last = list.items[list.items.length - 1].last;
	let tabs = 0;
	let spaces = 0;
	for (let n = first; n <= last; n++) {
		const text = state.doc.line(n).text;
		const q = quotePrefix(text, s.depth);
		if (q === null || q >= text.length) continue;
		if (text[q] === "\t") tabs++;
		else if (text[q] === " " && text.slice(q).trim()) spaces++;
	}
	if (tabs !== spaces) return tabs > spaces ? "tab" : "space";
	return state.facet(indentUnit) === "\t" ? "tab" : "space";
}

// Indentation from column `from` to column `to`.
function renderIndent(from: number, to: number, style: Style) {
	let out = "";
	let col = from;
	if (style === "tab") {
		while (nextStop(col) <= to) {
			out += "\t";
			col = nextStop(col);
		}
	}
	return out + " ".repeat(Math.max(0, to - col));
}

// The column a child of `item` starts at.
// With tabs, the first tab stop at or past its content column.
const roundUp = (col: number) => col + ((TAB - (col % TAB)) % TAB);
const childColumn = (item: ListItem, style: Style) => (style === "tab" ? roundUp(item.contentCol) : item.contentCol);

// Move line `n` by `delta` columns, after its quote prefix.
function shiftLine(doc: Text, n: number, depth: number, delta: number, style: Style): ChangeSpec | null {
	const line = doc.line(n);
	const text = line.text;
	const q = quotePrefix(text, depth);
	if (q === null || !delta) return null;
	let ie = q;
	while (ie < text.length && (text[ie] === " " || text[ie] === "\t")) ie++;
	if (ie === text.length) return null;
	const base = columnAt(text, q);
	const col = columnAt(text, ie, q, base);
	const target = Math.max(base, col + delta);
	if (delta > 0) {
		if (style === "space") return { from: line.from + ie, insert: " ".repeat(target - col) };
		return { from: line.from + q, to: line.from + ie, insert: renderIndent(base, target, "tab") };
	}
	let keep = q;
	let at = base;
	while (keep < ie) {
		const next = columnAt(text, keep + 1, keep, at);
		if (next > target) break;
		keep++;
		at = next;
	}
	const insert = renderIndent(at, target, "space");
	if (keep + insert.length === ie && text.slice(keep, ie) === insert) return null;
	return { from: line.from + keep, to: line.from + ie, insert };
}

function shiftLines(doc: Text, shifts: Map<number, number>, depth: number, style: Style) {
	const changes: ChangeSpec[] = [];
	for (const [n, delta] of [...shifts].sort((a, b) => a[0] - b[0])) {
		const c = shiftLine(doc, n, depth, delta, style);
		if (c) changes.push(c);
	}
	return changes;
}

const addShift = (shifts: Map<number, number>, from: number, to: number, delta: number) => {
	for (let n = from; n <= to; n++) shifts.set(n, (shifts.get(n) ?? 0) + delta);
};

// Line moves by line number, and number rewrites, of one edit.
interface Edits {
	shifts: Map<number, number>;
	numbers: ChangeSpec[];
}

const newEdits = (): Edits => ({ shifts: new Map(), numbers: [] });

// Give an ordered item another number. When the number gains or loses a
// digit, the item's own lines follow its content column: space-indented
// lines by the same amount, tab-indented ones only when they would fall
// short of it.
function renumberItem(doc: Text, depth: number, item: ListItem, number: number, edits: Edits) {
	if (item.number === null || item.number === number) return;
	const digits = String(number);
	edits.numbers.push({ from: item.from + item.ie, to: item.from + item.ie + item.digits.length, insert: digits });
	const widen = digits.length - item.digits.length;
	if (!widen) return;
	for (let n = item.n + 1; n <= item.last; n++) {
		const text = doc.line(n).text;
		const q = quotePrefix(text, depth);
		if (q === null) continue;
		let ie = q;
		while (ie < text.length && (text[ie] === " " || text[ie] === "\t")) ie++;
		if (ie === text.length) continue;
		const col = columnAt(text, ie, q, columnAt(text, q));
		if (col < item.contentCol) continue;
		if (!text.slice(q, ie).includes("\t")) addShift(edits.shifts, n, n, widen);
		else if (widen > 0 && col < item.contentCol + widen) addShift(edits.shifts, n, n, item.contentCol + widen - col);
	}
}

function editChanges(doc: Text, edits: Edits, depth: number, style: Style) {
	return [...shiftLines(doc, edits.shifts, depth, style), ...edits.numbers];
}

// Marks a transaction whose ordered lists must be renumbered even though no
// line break changed (indenting, list toggles).
export const listEdit = Annotation.define<boolean>();

// The previous item at the same level: in the same list, or the last item of
// an adjacent list of another kind.
function previousSibling(item: ListItem) {
	const at = item.list.items.indexOf(item);
	if (at > 0) return item.list.items[at - 1];
	const prev = item.list.prev;
	return prev ? prev.items[prev.items.length - 1] : null;
}

// Group items by the runs of consecutive siblings they form, in order.
function siblingRuns(roots: ListItem[]) {
	const runs: ListItem[][] = [];
	for (const item of roots) {
		const run = runs[runs.length - 1];
		const lastItem = run?.[run.length - 1];
		if (lastItem && lastItem.list === item.list && item.list.items.indexOf(item) === item.list.items.indexOf(lastItem) + 1) run.push(item);
		else runs.push([item]);
	}
	return runs;
}

// Indenting nests items under the item before them: joining the children
// it already has at its end, or starting a list of children, which starts
// at 1 when ordered (CommonMark reads a nested `2.` right under its parent's
// text as more of that text).
function indentEdits(state: EditorState, s: ListStructure, roots: ListItem[], edits: Edits) {
	for (const run of siblingRuns(roots)) {
		const prev = previousSibling(run[0]);
		if (!prev) continue;
		const style = listStyle(state, s, run[0]);
		const kids = prev.kids[prev.kids.length - 1];
		const tail = kids?.items[kids.items.length - 1];
		const joins = !!tail && tail.last === prev.last;
		const target = joins ? tail.col : childColumn(prev, style);
		for (const item of run) addShift(edits.shifts, item.n, item.last, target - item.col);
		if (!joins) renumberItem(state.doc, s.depth, run[0], 1, edits);
	}
}

// Outdenting moves an item to its parent's level; the siblings after it
// become its children, moved to its content column when they would not be,
// and numbered from 1.
function outdentEdits(state: EditorState, s: ListStructure, roots: ListItem[], edits: Edits) {
	for (const run of siblingRuns(roots)) {
		const parent = run[0].list.parent;
		if (!parent) continue;
		const style = listStyle(state, s, run[0]);
		for (const item of run) addShift(edits.shifts, item.n, item.last, parent.col - item.col);
		const lastRoot = run[run.length - 1];
		const contentCol = parent.col + (lastRoot.contentCol - lastRoot.col);
		const items = lastRoot.list.items;
		const after = items.slice(items.indexOf(lastRoot) + 1);
		for (const item of after) {
			if (item.col >= contentCol && item.col < contentCol + 4) continue;
			const target = style === "tab" ? roundUp(contentCol) : contentCol;
			addShift(edits.shifts, item.n, item.last, target - item.col);
		}
		if (after.length) renumberItem(state.doc, s.depth, after[0], 1, edits);
	}
}

// The structures for the lines of the selection, one per quote depth.
function structuresFor(state: EditorState, lines: number[]) {
	const byDepth = new Map<number, number[]>();
	for (const n of lines) {
		const d = quoteDepth(state.doc.line(n).text);
		byDepth.set(d, [...(byDepth.get(d) ?? []), n]);
	}
	return [...byDepth].map(([depth, ns]) => ({ s: listStructure(state, ns[0], ns[ns.length - 1], depth), lines: ns }));
}

function selectedLineNumbers(state: EditorState) {
	const lines = new Set<number>();
	for (const r of state.selection.ranges) {
		const first = state.doc.lineAt(r.from).number;
		const last = state.doc.lineAt(r.to).number;
		for (let n = first; n <= last; n++) {
			if (n === last && n > first && r.to === state.doc.line(n).from) break;
			lines.add(n);
		}
	}
	return [...lines].sort((a, b) => a - b);
}

// Tab and Shift+Tab on list items. Null when the selection is not on list
// items (the caller then indents as for other text); a spec without changes
// when nothing can move (the first item of a list, a top-level item).
export function moveListItems(state: EditorState, dir: 1 | -1): TransactionSpec | null {
	const lines = selectedLineNumbers(state).filter((n) => state.doc.line(n).text.trim());
	if (!lines.length) return null;
	const changes: ChangeSpec[] = [];
	let anyItem = false;
	for (const { s, lines: ns } of structuresFor(state, lines)) {
		const marked = ns.map((n) => s.byLine.get(n)).filter((i): i is ListItem => !!i);
		if (!marked.length || ns.some((n) => !ownerOf(s, n))) return null;
		anyItem = true;
		const roots = marked.filter((item) => !marked.some((other) => other !== item && isAncestor(other, item)));
		const edits = newEdits();
		if (dir > 0) indentEdits(state, s, roots, edits);
		else outdentEdits(state, s, roots, edits);
		changes.push(...editChanges(state.doc, edits, s.depth, listStyle(state, s, roots[0])));
	}
	if (!anyItem) return null;
	if (!changes.length) return {};
	const set = state.changes(changes);
	const ranges = state.selection.ranges.map((r) => {
		if (r.empty) return EditorSelection.cursor(set.mapPos(r.head, 1));
		const forward = r.anchor < r.head;
		return EditorSelection.range(set.mapPos(r.anchor, forward ? -1 : 1), set.mapPos(r.head, forward ? 1 : -1));
	});
	return {
		changes: set,
		selection: EditorSelection.create(ranges, state.selection.mainIndex),
		annotations: listEdit.of(true),
		userEvent: dir > 0 ? "input.indent" : "delete.dedent",
	};
}

export const indentListItems: StateCommand = ({ state, dispatch }) => {
	const spec = moveListItems(state, 1);
	if (!spec) return false;
	if (spec.changes) dispatch(state.update(spec, { scrollIntoView: true }));
	return true;
};

export const outdentListItems: StateCommand = ({ state, dispatch }) => {
	const spec = moveListItems(state, -1);
	if (!spec) return false;
	if (spec.changes) dispatch(state.update(spec, { scrollIntoView: true }));
	return true;
};

// The start of a new item next to `item`: its quote prefix and indentation,
// the same bullet or the next number, its spacing, and an open task box when
// it is a task.
function itemPrefix(doc: Text, item: ListItem, number = (item.number ?? 0) + 1) {
	const text = doc.line(item.n).text;
	const marker = item.bullet ?? `${number}${item.delim}`;
	const space = /^ {1,4}$/.test(item.space) ? item.space : " ";
	return text.slice(0, item.ie) + marker + space + (item.task !== null ? "[ ] " : "");
}

const isLoose = (list: List) => list.items.some((item, i) => i > 0 && item.n > list.items[i - 1].last + 1);

function blankLine(doc: Text, item: ListItem) {
	return doc.line(item.n).text.slice(0, item.q).trimEnd();
}

// Where the text of line `n` starts, past its quote prefix and indentation.
function textStart(doc: Text, n: number, depth: number) {
	const text = doc.line(n).text;
	let at = quotePrefix(text, depth) ?? 0;
	while (at < text.length && (text[at] === " " || text[at] === "\t")) at++;
	return at;
}

type RangeEdit = { changes: ChangeSpec[]; cursor: (set: ChangeSet) => number };

// A new item at `pos` on line `n` of item `owner`, taking the rest of the
// line: the next sibling, or the first child when the item has children
// below the line.
function splitInto(state: EditorState, owner: ListItem, n: number, pos: number, from: number): RangeEdit {
	const doc = state.doc;
	const line = doc.line(n);
	let start = pos;
	while (start > from && /[ \t]/.test(doc.sliceString(start - 1, start))) start--;
	let end = pos;
	while (end < line.to && /[ \t]/.test(doc.sliceString(end, end + 1))) end++;
	const kids = owner.kids.find((k) => k.items[0].n > n);
	const next = kids?.items[0];
	const prefix = next ? itemPrefix(doc, next, next.number ?? 1) : itemPrefix(doc, owner);
	const loose = isLoose(kids ?? owner.list);
	const insert = `\n${loose ? `${blankLine(doc, next ?? owner)}\n` : ""}${prefix}`;
	return { changes: [{ from: start, to: end, insert }], cursor: () => start + insert.length };
}

function outdentEdit(state: EditorState, s: ListStructure, item: ListItem, pos: number): RangeEdit {
	const edits = newEdits();
	outdentEdits(state, s, [item], edits);
	return { changes: editChanges(state.doc, edits, s.depth, listStyle(state, s, item)), cursor: (set) => set.mapPos(pos, 1) };
}

function enterEdit(state: EditorState, s: ListStructure, pos: number): RangeEdit | null {
	const doc = state.doc;
	const line = doc.lineAt(pos);
	const item = s.byLine.get(line.number);
	if (item) {
		if (pos < line.from + item.bodyAt) return null;
		if (item.empty && !item.kids.length) {
			if (item.parent) return outdentEdit(state, s, item, line.to);
			// Leaving the list: the line keeps only its quote prefix, below a
			// blank line, or text typed on it would continue the item above.
			const keep = line.text.slice(0, item.q);
			const above = line.number > 1 ? doc.line(line.number - 1) : null;
			const aboveBlank = !above || !above.text.slice(quotePrefix(above.text, s.depth) ?? 0).trim();
			const insert = aboveBlank ? keep : `${keep.trimEnd()}\n${keep}`;
			return { changes: [{ from: line.from, to: line.to, insert }], cursor: () => line.from + insert.length };
		}
		const folded = item.last > item.n && pos === line.to && hasFoldAt(state, line.to);
		if (folded) {
			const end = doc.line(item.last).to;
			const insert = `\n${isLoose(item.list) ? `${blankLine(doc, item)}\n` : ""}${itemPrefix(doc, item)}`;
			return { changes: [{ from: end, insert }], cursor: () => end + insert.length };
		}
		if (pos === line.from + item.bodyAt && !item.empty) {
			// At the start of the text: an empty item above, the text stays.
			const insert = `${itemPrefix(doc, item, item.number ?? 1)}\n${isLoose(item.list) ? `${blankLine(doc, item)}\n` : ""}`;
			return { changes: [{ from: line.from, insert }], cursor: (set) => set.mapPos(pos, 1) };
		}
		return splitInto(state, item, line.number, pos, line.from + item.bodyAt);
	}
	// A paragraph line continuing an item.
	if (s.kinds.get(line.number) !== "para") return null;
	const owner = ownerOf(s, line.number);
	if (!owner) return null;
	const at = line.from + textStart(doc, line.number, s.depth);
	if (pos < at || at === line.to) return null;
	return splitInto(state, owner, line.number, pos, at);
}

function hasFoldAt(state: EditorState, pos: number) {
	let found = false;
	foldedRanges(state).between(pos, pos, (from) => {
		if (from === pos) found = true;
	});
	return found;
}

// Run `edit` for every cursor; false unless every cursor is on a list item.
function perCursor(state: EditorState, dispatch: (tr: Transaction) => void, edit: (s: ListStructure, pos: number) => RangeEdit | null, userEvent: string) {
	if (state.selection.ranges.some((r) => !r.empty)) return false;
	const lines = state.selection.ranges.map((r) => state.doc.lineAt(r.head).number).sort((a, b) => a - b);
	const structures = structuresFor(state, lines);
	const structureOf = (n: number) => structures.find((x) => x.lines.includes(n))!.s;
	let failed = false;
	const spec = state.changeByRange((range) => {
		const result = failed ? null : edit(structureOf(state.doc.lineAt(range.head).number), range.head);
		if (!result) {
			failed = true;
			return { range };
		}
		const set = state.changes(result.changes);
		return { changes: set, range: EditorSelection.cursor(result.cursor(set)) };
	});
	if (failed) return false;
	dispatch(state.update(spec, { scrollIntoView: true, userEvent, annotations: listEdit.of(true) }));
	return true;
}

// Enter in a list item: a new item with the same bullet, the next number or
// an open task box, taking the text after the cursor; on an empty item, one
// level out, and out of the list from the top level.
export const insertListNewline: StateCommand = ({ state, dispatch }) => perCursor(state, dispatch, (s, pos) => enterEdit(state, s, pos), "input");

// Shift+Enter: a new line in the same item, at its content column.
export const insertListContinuation: StateCommand = ({ state, dispatch }) =>
	perCursor(
		state,
		dispatch,
		(s, pos) => {
			const doc = state.doc;
			const line = doc.lineAt(pos);
			const item = s.byLine.get(line.number);
			const owner = item ?? (s.kinds.get(line.number) === "para" ? ownerOf(s, line.number) : null);
			if (!owner) return null;
			const from = item ? line.from + item.bodyAt : line.from + textStart(doc, line.number, s.depth);
			if (pos < from) return null;
			let start = pos;
			while (start > from && /[ \t]/.test(doc.sliceString(start - 1, start))) start--;
			let end = pos;
			while (end < line.to && /[ \t]/.test(doc.sliceString(end, end + 1))) end++;
			const style = listStyle(state, s, owner);
			const q = quotePrefix(line.text, s.depth) ?? 0;
			const base = columnAt(line.text, q);
			const insert = `\n${line.text.slice(0, q)}${renderIndent(base, childColumn(owner, style), style)}`;
			return { changes: [{ from: start, to: end, insert }], cursor: () => start + insert.length };
		},
		"input",
	);

// Backspace at the start of an item's text: a task box goes first; then an
// empty item moves one level out, or loses its marker at the top level; an
// item with text becomes a continuation line of the item above it, or a
// paragraph when no item is above.
export const deleteListMarkup: StateCommand = ({ state, dispatch }) =>
	perCursor(
		state,
		dispatch,
		(s, pos) => {
			const doc = state.doc;
			const line = doc.lineAt(pos);
			const item = s.byLine.get(line.number);
			if (!item || pos !== line.from + item.bodyAt) return null;
			if (item.task !== null) {
				return { changes: [{ from: line.from + item.contentAt, to: pos }], cursor: () => line.from + item.contentAt };
			}
			if (item.empty && item.parent) return outdentEdit(state, s, item, pos);
			let above: ListItem | null = null;
			if (!item.empty) {
				for (let n = line.number - 1; n > 0 && !above; n--) {
					const kind = s.kinds.get(n);
					if (kind === "blank") continue;
					if (kind === undefined || kind === "out") break;
					above = ownerOf(s, n);
					break;
				}
			}
			const q = item.q;
			const base = item.base;
			const insert = above ? renderIndent(base, childColumn(above, listStyle(state, s, above)), listStyle(state, s, above)) : "";
			const from = line.from + q;
			return { changes: [{ from, to: pos, insert }], cursor: () => from + insert.length };
		},
		"delete.backward",
	);

// Renumbering: after an edit that changes lines of ordered lists, every list
// whose items changed is numbered again from its start, each level on its
// own. The start is the list's first number as it was: an item that becomes
// the first keeps the old first number, a list split off keeps the numbers
// it shows, a newly nested list starts at 1, and pasted or typed items keep
// the number they bring.

const ORDERED_NEAR = /^(?:[ \t]*>)*[ \t]*\d{1,9}[.)](?:[ \t]|$)/;

function hasOrdered(doc: Text, from: number, to: number) {
	for (let n = Math.max(1, from); n <= Math.min(doc.lines, to); n++) if (ORDERED_NEAR.test(doc.line(n).text)) return true;
	return false;
}

export function renumberChanges(startState: EditorState, newDoc: Text, changes: ChangeSet): ChangeSpec[] {
	const oldDoc = startState.doc;
	let fromA = Number.POSITIVE_INFINITY;
	let toA = -1;
	let fromB = Number.POSITIVE_INFINITY;
	let toB = -1;
	changes.iterChangedRanges((fa, ta, fb, tb) => {
		fromA = Math.min(fromA, fa);
		toA = Math.max(toA, ta);
		fromB = Math.min(fromB, fb);
		toB = Math.max(toB, tb);
	});
	if (toA < 0) return [];
	const old0 = oldDoc.lineAt(fromA).number;
	const old1 = oldDoc.lineAt(toA).number;
	const new0 = newDoc.lineAt(fromB).number;
	const new1 = newDoc.lineAt(toB).number;
	if (!hasOrdered(oldDoc, old0 - 2, old1 + 2) && !hasOrdered(newDoc, new0 - 2, new1 + 2)) return [];
	const start = regionStart(startState, fromA, false);
	const depths = new Set<number>();
	for (let n = new0; n <= new1 && depths.size < 4; n++) depths.add(quoteDepth(newDoc.line(n).text));
	for (let n = old0; n <= old1 && depths.size < 4; n++) depths.add(quoteDepth(oldDoc.line(n).text));
	const out: ChangeSpec[] = [];
	for (const depth of depths) {
		const before = scanLists(oldDoc, start, depth, old1 + 1);
		const after = scanLists(newDoc, start, depth, new1 + 1);
		out.push(...renumberStructure(newDoc, before, after, changes));
	}
	return out;
}

function renumberStructure(doc: Text, before: ListStructure, after: ListStructure, changes: ChangeSet): ChangeSpec[] {
	// Old items that are still there, by where their marker is now.
	const moved = new Map<number, ListItem>();
	for (const item of before.items) {
		const at = changes.mapPos(item.from + item.ie, 1, MapMode.TrackDel);
		if (at !== null) moved.set(at, item);
	}
	const oldOf = (item: ListItem) => moved.get(item.from + item.ie) ?? null;
	const sameParent = (item: ListItem, old: ListItem) => (item.parent ? oldOf(item.parent) === old.parent && old.parent !== null : old.parent === null);
	const survivors = new Set(moved.values());
	const newOf = new Map<ListItem, ListItem>();
	for (const item of after.items) {
		const old = oldOf(item);
		if (old) newOf.set(old, item);
	}
	const numbers: [ListItem, number][] = [];
	for (const list of after.lists) {
		if (!list.ordered) continue;
		const olds = list.items.map(oldOf);
		const first = olds[0];
		const unchanged =
			first?.list.ordered &&
			first.list.items.length === list.items.length &&
			olds.every((old, i) => old && old.list === first.list && old.list.items[i] === old && sameParent(list.items[i], old));
		if (unchanged) continue;
		let startAt: number;
		const anchorIndex = olds.findIndex((old, i) => old && old.list.ordered && sameParent(list.items[i], old));
		if (anchorIndex >= 0) {
			const anchor = olds[anchorIndex]!;
			const oldFirst = anchor.list.items[0];
			const firstNow = survivors.has(oldFirst) ? newOf.get(oldFirst) : undefined;
			if (!firstNow || firstNow.list === list) startAt = oldFirst.number!;
			else startAt = Math.max(0, list.items[anchorIndex].number! - anchorIndex);
		} else if (first) startAt = 1;
		else startAt = list.items[0].number!;
		list.items.forEach((item, i) => numbers.push([item, startAt + i]));
	}
	const edits = newEdits();
	for (const [item, number] of numbers) renumberItem(doc, after.depth, item, number, edits);
	return editChanges(doc, edits, after.depth, "space");
}

// Renumbers ordered lists after user edits that add or remove line breaks
// (Enter, deleting lines, pasting, moving lines) and after list commands. A
// change inside one line (typing a number) is left alone, and so is a
// change without a user event (a reload, a plugin's edit).
export const listRenumbering: Extension = EditorState.transactionFilter.of((tr) => {
	if (!tr.docChanged || tr.isUserEvent("undo") || tr.isUserEvent("redo")) return tr;
	if (!tr.annotation(listEdit)) {
		if (!tr.isUserEvent("input") && !tr.isUserEvent("delete") && !tr.isUserEvent("move")) return tr;
		let lineBreaks = false;
		const doc = tr.startState.doc;
		tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
			if (inserted.lines > 1 || doc.lineAt(fromA).number !== doc.lineAt(toA).number) lineBreaks = true;
		});
		if (!lineBreaks) return tr;
	}
	const extra = renumberChanges(tr.startState, tr.newDoc, tr.changes);
	if (!extra.length) return tr;
	return [tr, { changes: extra, sequential: true }];
});

export const listKeymap: KeyBinding[] = [
	{ key: "Enter", run: insertListNewline, shift: insertListContinuation },
	{ key: "Backspace", run: deleteListMarkup },
];
