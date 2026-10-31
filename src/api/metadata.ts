import * as nodePath from "node:path";
import { Events } from "./events";
import { getLinkpath } from "./metadata-utils";
import { parseYaml } from "./util";
import { type TAbstractFile, TFile, type Vault } from "./vault";

interface Loc {
	line: number;
	col: number;
	offset: number;
}
interface Pos {
	start: Loc;
	end: Loc;
}
export interface LinkCache {
	link: string;
	original: string;
	displayText?: string;
	position: Pos;
}

export interface CachedMetadata {
	frontmatter?: Record<string, any>;
	frontmatterPosition?: Pos;
	frontmatterLinks?: { key: string; link: string; original: string; displayText?: string }[];
	headings?: { heading: string; level: number; position: Pos }[];
	links?: LinkCache[];
	embeds?: LinkCache[];
	tags?: { tag: string; position: Pos }[];
	sections?: { type: string; position: Pos }[];
	listItems?: { parent: number; task?: string; position: Pos }[];
	blocks?: Record<string, { id: string; position: Pos }>;
}

function locator(text: string) {
	const lineStarts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
	return (offset: number): Loc => {
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return { line: lo, col: offset - lineStarts[lo], offset };
	};
}

// A line-based Markdown scan good enough for links, headings, tags and
// frontmatter; code blocks and inline code are skipped.
export function parseMetadata(text: string): CachedMetadata {
	const at = locator(text);
	const pos = (s: number, e: number): Pos => ({ start: at(s), end: at(e) });
	const cache: CachedMetadata = {};
	let bodyStart = 0;

	const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (fm) {
		bodyStart = fm[0].length;
		cache.frontmatterPosition = pos(0, fm[0].trimEnd().length);
		try {
			const data = parseYaml(fm[1]);
			if (data && typeof data === "object") cache.frontmatter = data;
		} catch {}
	}

	const headings: CachedMetadata["headings"] = [];
	const links: LinkCache[] = [];
	const embeds: LinkCache[] = [];
	const tags: CachedMetadata["tags"] = [];
	const listItems: CachedMetadata["listItems"] = [];
	const sections: CachedMetadata["sections"] = [];
	const blocks: NonNullable<CachedMetadata["blocks"]> = {};
	let inFence: string | null = null;
	let inMath = false;
	let offset = bodyStart;

	for (const line of text.slice(bodyStart).split("\n")) {
		const start = offset;
		offset += line.length + 1;
		const fence = /^\s*(`{3,}|~{3,})/.exec(line);
		if (inFence) {
			if (fence && fence[1][0] === inFence[0] && fence[1].length >= inFence.length) inFence = null;
			continue;
		}
		if (fence) {
			inFence = fence[1];
			sections.push({ type: "code", position: pos(start, start + line.length) });
			continue;
		}
		if (/^\s*\$\$/.test(line)) {
			const single = /^\s*\$\$.*\$\$\s*$/.test(line) && line.trim().length > 4;
			if (!single) inMath = !inMath;
			continue;
		}
		if (inMath) continue;

		const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (h) {
			headings.push({ heading: h[2], level: h[1].length, position: pos(start, start + line.length) });
			sections.push({ type: "heading", position: pos(start, start + line.length) });
		}
		const li = /^(\s*)([-*+]|\d+[.)])\s+(\[(.)\]\s)?/.exec(line);
		if (li) listItems.push({ parent: -1, task: li[4], position: pos(start, start + line.length) });
		const block = /\s\^([\w-]+)\s*$/.exec(line);
		if (block) blocks[block[1].toLowerCase()] = { id: block[1], position: pos(start, start + line.length) };

		// Blank out inline code so its contents are not read as links or tags.
		const masked = line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length)).replace(/\$[^$]+\$/g, (m) => " ".repeat(m.length));
		for (const m of masked.matchAll(/(!?)\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g)) {
			const s = start + m.index!;
			const ref: LinkCache = { link: m[2].trim(), original: m[0], position: pos(s, s + m[0].length) };
			if (m[3] !== undefined) ref.displayText = m[3];
			(m[1] ? embeds : links).push(ref);
		}
		for (const m of masked.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g)) {
			if (/^[a-z]+:/i.test(m[3])) continue;
			const s = start + m.index!;
			const link = decodeURI(m[3]);
			(m[1] ? embeds : links).push({ link, original: m[0], displayText: m[2], position: pos(s, s + m[0].length) });
		}
		for (const m of masked.matchAll(/(^|\s)(#[^\s#!@$%^&*(),.?":{}|<>[\]\\`'~;=+]+)/g)) {
			if (/^#\d+$/.test(m[2])) continue;
			const s = start + m.index! + m[1].length;
			tags.push({ tag: m[2], position: pos(s, s + m[2].length) });
		}
	}

	if (headings.length) cache.headings = headings;
	if (links.length) cache.links = links;
	if (embeds.length) cache.embeds = embeds;
	if (tags.length) cache.tags = tags;
	if (listItems.length) cache.listItems = listItems;
	if (sections.length) cache.sections = sections;
	if (Object.keys(blocks).length) cache.blocks = blocks;
	return cache;
}

export class MetadataCache extends Events {
	vault: Vault;
	resolvedLinks: Record<string, Record<string, number>> = {};
	unresolvedLinks: Record<string, Record<string, number>> = {};
	#cache = new Map<string, CachedMetadata>();
	resolved = false;

	constructor(vault: Vault) {
		super();
		this.vault = vault;
		vault.on("create", (f: TAbstractFile) => f instanceof TFile && this.#index(f));
		vault.on("modify", (f: TAbstractFile) => f instanceof TFile && this.#index(f));
		vault.on("delete", (f: TAbstractFile) => {
			const prev = this.#cache.get(f.path);
			this.#cache.delete(f.path);
			delete this.resolvedLinks[f.path];
			delete this.unresolvedLinks[f.path];
			if (f instanceof TFile) this.trigger("deleted", f, prev ?? null);
		});
		vault.on("rename", (f: TAbstractFile, oldPath: string) => {
			const prev = this.#cache.get(oldPath);
			this.#cache.delete(oldPath);
			if (prev) this.#cache.set(f.path, prev);
			this.resolvedLinks[f.path] = this.resolvedLinks[oldPath] ?? {};
			delete this.resolvedLinks[oldPath];
		});
	}

	// Index every Markdown file in the background, then announce "resolved".
	async initialize() {
		const files = this.vault.getMarkdownFiles();
		for (let i = 0; i < files.length; i += 50) {
			await Promise.all(files.slice(i, i + 50).map((f) => this.#index(f, true)));
		}
		this.resolved = true;
		this.trigger("resolved");
	}

	async #index(file: TFile, initial = false) {
		if (file.extension !== "md") return;
		let text: string;
		try {
			text = await this.vault.cachedRead(file);
		} catch {
			return;
		}
		const cache = parseMetadata(text);
		this.#cache.set(file.path, cache);
		this.#resolve(file, cache);
		this.trigger("changed", file, text, cache);
		if (!initial) {
			this.trigger("resolve", file);
			if (this.resolved) this.trigger("resolved");
		}
	}

	#resolve(file: TFile, cache: CachedMetadata) {
		const resolved: Record<string, number> = {};
		const unresolved: Record<string, number> = {};
		for (const ref of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
			const dest = this.getFirstLinkpathDest(getLinkpath(ref.link), file.path);
			const bucket = dest ? resolved : unresolved;
			const key = dest ? dest.path : getLinkpath(ref.link);
			bucket[key] = (bucket[key] ?? 0) + 1;
		}
		this.resolvedLinks[file.path] = resolved;
		this.unresolvedLinks[file.path] = unresolved;
	}

	getFileCache(file: TFile) {
		return this.#cache.get(file.path) ?? null;
	}

	getCache(path: string) {
		return this.#cache.get(path) ?? null;
	}

	// Resolve a link the way Obsidian does: exact path, then relative to the
	// source, then the shortest path whose name matches.
	getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
		if (!linkpath) return this.vault.getFileByPath(sourcePath);
		const candidates = /\.[^/]+$/.test(linkpath) ? [linkpath] : [linkpath, `${linkpath}.md`];
		for (const c of candidates) {
			const exact = this.vault.getFileByPath(c);
			if (exact) return exact;
			const rel = this.vault.getFileByPath(nodePath.posix.join(nodePath.posix.dirname(sourcePath), c));
			if (rel) return rel;
		}
		const names = candidates.map((c) => nodePath.posix.basename(c).toLowerCase());
		const suffixes = candidates.map((c) => `/${c.toLowerCase()}`);
		let best: TFile | null = null;
		for (const f of this.vault.getFiles()) {
			const lower = f.path.toLowerCase();
			if (!names.includes(f.name.toLowerCase())) continue;
			if (candidates.some((c) => c.includes("/")) && !suffixes.some((s) => `/${lower}`.endsWith(s))) continue;
			if (!best || f.path.length < best.path.length) best = f;
		}
		return best;
	}

	// The shortest unambiguous link: the bare name when it is unique.
	fileToLinktext(file: TFile, _sourcePath: string, omitMdExtension = true) {
		const strip = omitMdExtension && file.extension === "md";
		const unique = this.vault.getFiles().filter((f) => f.name === file.name).length === 1;
		if (unique) return strip ? file.basename : file.name;
		return strip ? file.path.slice(0, -3) : file.path;
	}

	getLinkpathDest(linkpath: string, sourcePath: string) {
		const f = this.getFirstLinkpathDest(linkpath, sourcePath);
		return f ? [f] : [];
	}

	getTags() {
		const counts: Record<string, number> = {};
		for (const c of this.#cache.values()) for (const t of c.tags ?? []) counts[t.tag] = (counts[t.tag] ?? 0) + 1;
		return counts;
	}
}
