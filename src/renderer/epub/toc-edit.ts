// Edits to a book's table of contents, applied the same way to EPUB 3's nav
// document and EPUB 2's NCX (a book often has both). An entry is a nav <li>
// or an NCX <navPoint>; each kind's adapter says how to read and make one.
import { resolvePath } from "./book";

const OPS = "http://www.idpf.org/2007/ops";
const NCX = "http://www.daisy.org/z3986/2005/ncx/";
const XHTML = "http://www.w3.org/1999/xhtml";

export interface TocAdapter {
	// The top list: the toc nav's <ol>, or <navMap>.
	root(doc: Document): Element | null;
	// The entries directly in a list (an <ol>, <navMap> or <navPoint>).
	items(list: Element): Element[];
	// The list that holds an entry's children, made when `make` is set.
	children(item: Element, make: boolean): Element | null;
	path(item: Element, dir: string): string;
	setLabel(item: Element, label: string): void;
	create(doc: Document, href: string, label: string): Element;
	// After any edit (the NCX renumbers its playOrder).
	finish(doc: Document): void;
}

const kids = (el: Element, name: string) => Array.from(el.children).filter((c) => c.localName === name);

export const navAdapter: TocAdapter = {
	root(doc) {
		const navs = Array.from(doc.getElementsByTagName("nav"));
		const nav = navs.find((el) => (el.getAttributeNS(OPS, "type") ?? el.getAttribute("epub:type") ?? "").split(/\s+/).includes("toc")) ?? navs[0];
		return nav ? (kids(nav, "ol")[0] ?? null) : null;
	},
	items: (list) => kids(list, "li"),
	children(item, make) {
		const existing = kids(item, "ol")[0];
		if (existing || !make) return existing ?? null;
		return item.appendChild(item.ownerDocument.createElementNS(item.namespaceURI ?? XHTML, "ol"));
	},
	path(item, dir) {
		const href = kids(item, "a")[0]?.getAttribute("href");
		return href ? resolvePath(dir, href) : "";
	},
	setLabel(item, label) {
		const head = kids(item, "a")[0] ?? kids(item, "span")[0];
		if (head) head.textContent = label;
	},
	create(doc, href, label) {
		const ns = doc.documentElement.namespaceURI ?? XHTML;
		const li = doc.createElementNS(ns, "li");
		const a = li.appendChild(doc.createElementNS(ns, "a"));
		a.setAttribute("href", href);
		a.textContent = label;
		return li;
	},
	finish() {},
};

export const ncxAdapter: TocAdapter = {
	root: (doc) => doc.getElementsByTagName("navMap")[0] ?? null,
	items: (list) => kids(list, "navPoint"),
	children: (item) => item,
	path(item, dir) {
		const src = kids(item, "content")[0]?.getAttribute("src");
		return src ? resolvePath(dir, src) : "";
	},
	setLabel(item, label) {
		const text = kids(item, "navLabel")[0]?.getElementsByTagName("text")[0];
		if (text) text.textContent = label;
	},
	create(doc, href, label) {
		const ns = doc.documentElement.namespaceURI ?? NCX;
		const point = doc.createElementNS(ns, "navPoint");
		const ids = new Set(Array.from(doc.getElementsByTagName("navPoint")).map((p) => p.getAttribute("id")));
		let n = ids.size + 1;
		while (ids.has(`navPoint-${n}`)) n++;
		point.setAttribute("id", `navPoint-${n}`);
		const navLabel = point.appendChild(doc.createElementNS(ns, "navLabel"));
		navLabel.appendChild(doc.createElementNS(ns, "text")).textContent = label;
		point.appendChild(doc.createElementNS(ns, "content")).setAttribute("src", href);
		return point;
	},
	// The book renumbers playOrder (renumberPlayOrder): it needs the spine.
	finish() {},
};

interface Placed {
	item: Element;
	list: Element;
}

// Every entry with the list it is in, in reading order.
function walk(adapter: TocAdapter, list: Element, out: Placed[] = []) {
	for (const item of adapter.items(list)) {
		out.push({ item, list });
		const sub = adapter.children(item, false);
		if (sub) walk(adapter, sub, out);
	}
	return out;
}

// A new entry for a chapter put in at spine index `index`: right before the
// first entry (in reading order) of a chapter after it, in that entry's
// list, so the contents keep the reading order; with none, right after the
// last entry of a chapter before it, in its list.
export function insertEntry(adapter: TocAdapter, doc: Document, dir: string, index: number, href: string, label: string, spineIndexOf: (path: string) => number) {
	const root = adapter.root(doc);
	if (!root) return false;
	const entry = adapter.create(doc, href, label);
	const placed = walk(adapter, root).map((p) => ({ ...p, at: spineIndexOf(adapter.path(p.item, dir)) }));
	const next = placed.find((p) => p.at > index);
	const prev = placed.filter((p) => p.at >= 0 && p.at < index).pop();
	if (next) next.list.insertBefore(entry, next.item);
	else if (prev) prev.list.insertBefore(entry, prev.item.nextSibling);
	else root.appendChild(entry);
	adapter.finish(doc);
	return true;
}

// The entries of a removed chapter go; their own children take their place.
export function removeEntries(adapter: TocAdapter, doc: Document, dir: string, path: string) {
	const root = adapter.root(doc);
	if (!root) return false;
	let changed = false;
	for (const { item, list } of walk(adapter, root).reverse()) {
		if (adapter.path(item, dir) !== path) continue;
		const sub = adapter.children(item, false);
		if (sub && sub !== item) for (const child of adapter.items(sub)) list.insertBefore(child, item);
		else if (sub === item) for (const child of adapter.items(item)) list.insertBefore(child, item);
		item.remove();
		changed = true;
	}
	adapter.finish(doc);
	return changed;
}

// After a chapter moved in the spine, the lists holding its entries are put
// in spine order again: the entries for spine items trade places among
// themselves; an entry for something outside the spine keeps its place.
export function resortEntries(adapter: TocAdapter, doc: Document, dir: string, path: string, spineIndexOf: (path: string) => number) {
	const root = adapter.root(doc);
	if (!root) return false;
	const lists = new Set(
		walk(adapter, root)
			.filter((p) => adapter.path(p.item, dir) === path)
			.map((p) => p.list),
	);
	for (const list of lists) {
		const items = adapter.items(list);
		const linked = items.map((item, i) => ({ item, i, at: spineIndexOf(adapter.path(item, dir)) })).filter((e) => e.at >= 0);
		const order = [...linked].sort((a, b) => a.at - b.at || a.i - b.i);
		// Each slot gets its new entry; placeholders keep the slots while moving.
		const marks = linked.map(({ item }) => {
			const mark = doc.createComment("");
			list.replaceChild(mark, item);
			return mark;
		});
		marks.forEach((mark, k) => list.replaceChild(order[k].item, mark));
	}
	adapter.finish(doc);
	return lists.size > 0;
}

// The label of a chapter's first entry; false when it has none.
export function renameEntry(adapter: TocAdapter, doc: Document, dir: string, path: string, label: string) {
	const root = adapter.root(doc);
	const first = root ? walk(adapter, root).find((p) => adapter.path(p.item, dir) === path) : null;
	if (!first) return false;
	adapter.setLabel(first.item, label);
	return true;
}

// The entry a list belongs to (null for the top list).
function owner(list: Element) {
	if (list.localName === "navPoint") return list;
	const parent = list.parentElement;
	return list.localName === "ol" && parent?.localName === "li" ? parent : null;
}

// A chapter's first entry becomes the last child of the entry before it.
export function indentEntry(adapter: TocAdapter, doc: Document, dir: string, path: string) {
	const root = adapter.root(doc);
	const found = root ? walk(adapter, root).find((p) => adapter.path(p.item, dir) === path) : null;
	if (!found) return false;
	const siblings = adapter.items(found.list);
	const prev = siblings[siblings.indexOf(found.item) - 1];
	if (!prev) return false;
	adapter.children(prev, true)!.appendChild(found.item);
	adapter.finish(doc);
	return true;
}

// A chapter's first entry moves up a level, right after the entry it was
// under; the entries after it in its list become its children, so the
// reading order stays.
export function outdentEntry(adapter: TocAdapter, doc: Document, dir: string, path: string) {
	const root = adapter.root(doc);
	const found = root ? walk(adapter, root).find((p) => adapter.path(p.item, dir) === path) : null;
	const parent = found ? owner(found.list) : null;
	if (!found || !parent?.parentElement) return false;
	const siblings = adapter.items(found.list);
	const after = siblings.slice(siblings.indexOf(found.item) + 1);
	parent.parentElement.insertBefore(found.item, parent.nextSibling);
	if (after.length) {
		const children = adapter.children(found.item, true)!;
		for (const item of after) children.appendChild(item);
	}
	// A nav list left empty goes.
	if (found.list.localName === "ol" && !adapter.items(found.list).length) found.list.remove();
	adapter.finish(doc);
	return true;
}

// The NCX's playOrder after an edit: navPoints and pageTargets numbered by
// where their targets are in the spine (document order within a file), one
// number for every entry with the same target, as the NCX requires.
export function renumberPlayOrder(doc: Document, dir: string, spineIndexOf: (path: string) => number) {
	const points = Array.from(doc.getElementsByTagName("*")).filter((el) => el.localName === "navPoint" || el.localName === "pageTarget");
	const keyed = points.map((el, i) => {
		const src = Array.from(el.children).find((c) => c.localName === "content")?.getAttribute("src") ?? "";
		const at = src ? spineIndexOf(resolvePath(dir, src)) : -1;
		return { el, src, at: at < 0 ? Number.MAX_SAFE_INTEGER : at, i };
	});
	keyed.sort((a, b) => a.at - b.at || a.i - b.i);
	const numbers = new Map<string, number>();
	let next = 1;
	for (const { el, src } of keyed) {
		let n = src ? numbers.get(src) : undefined;
		if (n === undefined) {
			n = next++;
			if (src) numbers.set(src, n);
		}
		el.setAttribute("playOrder", String(n));
	}
}
