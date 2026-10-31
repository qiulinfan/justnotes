// Obsidian's .obsidian/bookmarks.json: `{ "items": [...] }`, each item a
// `type` and `ctime` followed by its own fields and an optional `title`:
// file (`path`, `subpath` for #heading or #^block), folder (`path`), search
// (`query`), graph (`options`), url (`url`) and group (`items`). Unknown
// fields and unknown item types are kept as they are.

import { droppedSchemes } from "../main/link-policy";

export interface BookmarkItem {
	type: string;
	ctime?: number;
	title?: string;
	path?: string;
	subpath?: string;
	query?: string;
	url?: string;
	options?: unknown;
	items?: BookmarkItem[];
	[field: string]: unknown;
}

export interface BookmarksData {
	items: BookmarkItem[];
	[field: string]: unknown;
}

const isItem = (value: unknown): value is BookmarkItem => !!value && typeof value === "object" && typeof (value as BookmarkItem).type === "string";

// The file's text as data; null when it is not a bookmarks file (half
// written, or broken by hand), which must then be left alone.
export function parseBookmarks(text: string): BookmarksData | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const data = raw as BookmarksData;
	if (data.items === undefined) data.items = [];
	if (!Array.isArray(data.items)) return null;
	const clean = (items: unknown[]): BookmarkItem[] =>
		items.filter(isItem).map((item) => {
			if (item.type === "group") item.items = Array.isArray(item.items) ? clean(item.items) : [];
			return item;
		});
	data.items = clean(data.items);
	return data;
}

// Obsidian writes its config files with two-space indentation.
export function serializeBookmarks(data: BookmarksData) {
	return JSON.stringify(data, null, 2);
}

export function cloneBookmarks<T>(data: T): T {
	return JSON.parse(JSON.stringify(data));
}

// A new item with its fields in Obsidian's order; undefined fields are left out.
export function newBookmark(type: string, ctime: number, fields: Omit<BookmarkItem, "type" | "ctime"> = {}): BookmarkItem {
	const item: BookmarkItem = { type, ctime };
	const all: Record<string, unknown> = { ...fields, items: fields.items ?? (type === "group" ? [] : undefined) };
	const order = ["path", "subpath", "query", "url", "options", "items", "title"];
	for (const key of [...order, ...Object.keys(all).filter((k) => !order.includes(k))]) {
		if (all[key] !== undefined) item[key] = all[key];
	}
	return item;
}

const SCHEME = /^[a-z][\w+.-]*:/i;
// A host with a dot (or localhost), an optional port, then a path or nothing:
// what a URL typed without its scheme starts with.
const BARE_HOST = /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]|$)/i;

// The URL of a URL bookmark, from what was typed, dropped or linked: a bare
// host such as example.com/page gets https:// (only when `bare` allows it);
// null for text that is no URL, a web URL without a host, or a scheme the
// external-link policy drops (file:, javascript:, ...), which the bookmark
// could never open. The URL is kept as written, not normalized.
export function bookmarkUrl(text: string, bare = true): string | null {
	const url = text.trim();
	if (!url || /\s/.test(url)) return null;
	const full = BARE_HOST.test(url) && bare ? `https://${url}` : SCHEME.test(url) ? url : null;
	if (!full) return null;
	let parsed: URL;
	try {
		parsed = new URL(full);
	} catch {
		return null;
	}
	if (droppedSchemes.has(parsed.protocol)) return null;
	if (/^https?:$/.test(parsed.protocol) && !parsed.hostname) return null;
	return full;
}

// A URL bookmark's default title: its host and path (example.com/docs/page),
// decoded for reading; a URL without a host (mailto:) shows what follows the
// scheme.
export function urlTitle(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}
	const text = parsed.host ? `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}` : parsed.pathname || url;
	try {
		return decodeURI(text);
	} catch {
		return text;
	}
}

// The URLs a drop from outside the app's drag manager carries: the
// `text/uri-list` entries, else plain text whose every line is a URL with a
// scheme (a word such as node.js is no link). Each URL once.
export function droppedUrls(uriList: string, plain: string): string[] {
	const fromList = uriList
		.split(/\r?\n/)
		.filter((line) => line.trim() && !line.startsWith("#"))
		.map((line) => bookmarkUrl(line, false))
		.filter((url): url is string => !!url);
	let urls = fromList;
	if (!urls.length) {
		const lines = plain.split(/\r?\n/).filter((line) => line.trim());
		const parsed = lines.map((line) => bookmarkUrl(line, false));
		urls = parsed.every(Boolean) ? (parsed as string[]) : [];
	}
	return [...new Set(urls)];
}

// Every item, depth first, with the list holding it and its group.
export function walkBookmarks(items: BookmarkItem[], cb: (item: BookmarkItem, list: BookmarkItem[], parent: BookmarkItem | null) => void, parent: BookmarkItem | null = null) {
	for (const item of [...items]) {
		cb(item, items, parent);
		if (item.type === "group" && item.items) walkBookmarks(item.items, cb, item);
	}
}

// The bookmarks themselves, groups left out.
export function flattenBookmarks(items: BookmarkItem[]) {
	const out: BookmarkItem[] = [];
	walkBookmarks(items, (item) => item.type !== "group" && out.push(item));
	return out;
}

export function findParent(items: BookmarkItem[], target: BookmarkItem): { list: BookmarkItem[]; parent: BookmarkItem | null } | null {
	let found: { list: BookmarkItem[]; parent: BookmarkItem | null } | null = null;
	walkBookmarks(items, (item, list, parent) => {
		if (item === target) found = { list, parent };
	});
	return found;
}

// Whether `inner` is `outer` or lies inside it (a group).
export function contains(outer: BookmarkItem, inner: BookmarkItem): boolean {
	return outer === inner || (outer.type === "group" && !!outer.items?.some((child) => contains(child, inner)));
}

// Moves `item` into `group` (the top level for null) before index `index`
// of the list as it is now; a group never moves into itself.
export function moveBookmark(items: BookmarkItem[], item: BookmarkItem, group: BookmarkItem | null, index: number) {
	if (group && contains(item, group)) return false;
	const from = findParent(items, item);
	if (!from) return false;
	const target = group ? (group.items ??= []) : items;
	let at = Math.max(0, Math.min(index, target.length));
	const old = from.list.indexOf(item);
	if (from.list === target && old < at) at--;
	from.list.splice(old, 1);
	target.splice(at, 0, item);
	return true;
}

const pathMoved = (path: string, oldPath: string, newPath: string) =>
	path === oldPath ? newPath : path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length) : null;

// File and folder bookmarks follow a renamed or moved file or folder, as in
// Obsidian. True when any changed.
export function renameInBookmarks(items: BookmarkItem[], oldPath: string, newPath: string) {
	let changed = false;
	walkBookmarks(items, (item) => {
		if ((item.type !== "file" && item.type !== "folder") || typeof item.path !== "string") return;
		const next = pathMoved(item.path, oldPath, newPath);
		if (next === null) return;
		item.path = next;
		changed = true;
	});
	return changed;
}

// Bookmarks of a deleted file or folder, and of everything in the folder,
// go with it. True when any did.
export function removeDeletedFromBookmarks(items: BookmarkItem[], path: string) {
	let changed = false;
	walkBookmarks(items, (item, list) => {
		if ((item.type !== "file" && item.type !== "folder") || typeof item.path !== "string") return;
		if (item.path !== path && !item.path.startsWith(`${path}/`)) return;
		list.remove(item);
		changed = true;
	});
	return changed;
}

// Items have no ids; type and ctime (the creation time in milliseconds) tell
// them apart, and a repeat counts up in tree order.
function identity(item: BookmarkItem) {
	if (typeof item.ctime === "number") return `${item.type}|${item.ctime}`;
	return `${item.type}|${item.path ?? item.query ?? item.url ?? item.title ?? ""}|${item.subpath ?? ""}`;
}

interface Placed {
	item: BookmarkItem;
	parent: string | null;
	// Every earlier item of the same list, nearest first.
	prevs: string[];
}

function keyed(items: BookmarkItem[]) {
	const map = new Map<string, Placed>();
	const seen = new Map<string, number>();
	const keyOf = new Map<BookmarkItem, string>();
	walkBookmarks(items, (item, list, parent) => {
		const id = identity(item);
		const n = seen.get(id) ?? 0;
		seen.set(id, n + 1);
		const key = n ? `${id}#${n}` : id;
		keyOf.set(item, key);
		const prevs = list
			.slice(0, list.indexOf(item))
			.reverse()
			.map((other) => keyOf.get(other)!);
		map.set(key, { item, parent: parent ? keyOf.get(parent)! : null, prevs });
	});
	return map;
}

const fieldsOf = (item: BookmarkItem) => Object.keys(item).filter((k) => k !== "items");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// A three-way merge for when the file changed on disk (Obsidian, git) while
// justnotes had changes of its own: `theirs` (the file) gets the changes
// `ours` made since `base` (the text last read or written). Items we added
// or removed, fields we changed and moves we made apply; everything else,
// unknown fields included, is the file's. With no changes of ours the
// result is the file as it is.
export function mergeBookmarks(base: BookmarksData, ours: BookmarksData, theirs: BookmarksData): BookmarksData {
	const result = cloneBookmarks(theirs);
	const B = keyed(base.items);
	const O = keyed(ours.items);
	let R = keyed(result.items);
	const listOf = (parent: string | null) => {
		const group = parent === null ? null : R.get(parent)?.item;
		return group?.type === "group" ? (group.items ??= []) : result.items;
	};
	const place = (item: BookmarkItem, at: Placed) => {
		const list = listOf(at.parent !== null && R.has(at.parent) ? at.parent : null);
		// After the nearest earlier item that is still in that list.
		const prev = at.prevs.map((k) => R.get(k)?.item).find((p) => p && list.includes(p));
		if (prev) list.splice(list.indexOf(prev) + 1, 0, item);
		else if (!at.prevs.length) list.unshift(item);
		else list.push(item);
		R = keyed(result.items);
	};
	const detach = (key: string) => {
		const node = R.get(key);
		if (!node) return;
		listOf(node.parent).remove(node.item);
		R = keyed(result.items);
	};
	for (const key of B.keys()) if (!O.has(key)) detach(key);
	for (const [key, node] of O) {
		if (B.has(key) || R.has(key)) continue;
		// A new group comes empty; what it holds is placed as its own entry.
		const copy = Object.fromEntries(Object.entries(node.item).map(([k, v]) => [k, k === "items" ? [] : cloneBookmarks(v)])) as BookmarkItem;
		place(copy, node);
	}
	for (const [key, node] of O) {
		const old = B.get(key);
		const target = R.get(key);
		if (!old || !target) continue;
		for (const field of new Set([...fieldsOf(old.item), ...fieldsOf(node.item)])) {
			if (same(old.item[field], node.item[field])) continue;
			if (node.item[field] === undefined) delete target.item[field];
			else target.item[field] = cloneBookmarks(node.item[field]);
		}
		// Moved when its group or the item before it changed, counting only
		// items both sides have: one we added or removed next to it moves nothing.
		const before = (at: Placed, other: Map<string, Placed>) => at.prevs.find((k) => other.has(k)) ?? null;
		if (old.parent !== node.parent || before(old, O) !== before(node, B)) {
			detach(key);
			place(target.item, node);
		}
	}
	return result;
}
