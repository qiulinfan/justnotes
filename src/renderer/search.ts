import type { CachedMetadata } from "../api/metadata";
import { getAllTags, parseFrontMatterTags } from "../api/metadata-utils";
import { isIndexedNote } from "../api/note-files";
import { debounce } from "../api/util";
import type { TFile } from "../api/vault";
import { ItemView } from "../api/view";
import type { WorkspaceLeaf } from "../api/workspace";

const MAX_FILES = 200;
const MAX_MATCHES_PER_FILE = 20;

// A match: characters [from, to) of a 0-based line.
export interface SearchMatch {
	line: number;
	from: number;
	to: number;
}

// Builds a line matcher: `/re/` is a regex, anything else a plain string,
// case-sensitive only when it contains an uppercase letter, unless
// `caseSensitive` says (the command line's `case` flag).
export function compileSearch(query: string, caseSensitive?: boolean): RegExp | null {
	const re = /^\/(.+)\/([a-z]*)$/.exec(query);
	try {
		if (re) return new RegExp(re[1], re[2].includes("g") ? re[2] : `${re[2]}g`);
		const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(escaped, (caseSensitive ?? /[A-Z]/.test(query)) ? "g" : "gi");
	} catch {
		return null;
	}
}

// The tag a `tag:#x` (or `tag:x`) query asks for, lowercased and without '#';
// rendered tags and Bases search this way.
export function tagQuery(query: string) {
	return /^tag:#?([^\s#]+)$/i.exec(query)?.[1].toLowerCase() ?? null;
}

// Whether `name` (with or without '#') is `tag` or a tag nested under it
// (#tag/sub), ignoring case.
export function isTag(name: string, tag: string) {
	const t = name.replace(/^#/, "").toLowerCase();
	return t === tag || t.startsWith(`${tag}/`);
}

// Where a note carries `tag` (see isTag): each tag in the text, and each
// value of the frontmatter's tags key.
export function tagMatches(cache: CachedMetadata | null, text: string, tag: string): SearchMatch[] {
	const named = (name: string) => isTag(name, tag);
	const matches: SearchMatch[] = [];
	const fm = cache?.frontmatterPosition;
	if (fm && parseFrontMatterTags(cache.frontmatter)?.some(named)) {
		// The cache keeps no positions for frontmatter values; the lines of the
		// tags key (`tags: a, b`, `tags: [a]`, or a list under it) hold them.
		const lines = text.split(/\r?\n/);
		let inTags = false;
		for (let line = fm.start.line + 1; line < fm.end.line; line++) {
			const key = /^([^\s#:-][^:]*):/.exec(lines[line]);
			if (key) inTags = /^tags?$/i.test(key[1].trim());
			if (!inTags) continue;
			const start = key ? key[0].length : 0;
			for (const m of lines[line].slice(start).matchAll(/#?[^\s,[\]'"#]+/g)) {
				if (named(m[0])) matches.push({ line, from: start + m.index, to: start + m.index + m[0].length });
			}
		}
	}
	for (const t of cache?.tags ?? []) {
		if (named(t.tag)) matches.push({ line: t.position.start.line, from: t.position.start.col, to: t.position.end.col });
	}
	return matches;
}

// The matches of `re` on each line, one per line.
export function textMatches(text: string, re: RegExp): SearchMatch[] {
	const matches: SearchMatch[] = [];
	for (const [line, content] of text.split("\n").entries()) {
		re.lastIndex = 0;
		const m = re.exec(content);
		if (m && m[0].length) matches.push({ line, from: m.index, to: m.index + m[0].length });
	}
	return matches;
}

// A result row's text: the match marked, with a little of the line around it.
export function appendMatch(el: HTMLElement, content: string, match: { from: number; to: number }) {
	const start = Math.max(0, match.from - 30);
	el.appendText((start > 0 ? "…" : "") + content.slice(start, match.from));
	el.createEl("mark", { text: content.slice(match.from, match.to) });
	el.appendText(content.slice(match.to, match.to + 80));
}

// Full-text search that reads the Markdown files directly; no index. A
// `tag:` query finds tags through the metadata cache instead.
export class SearchView extends ItemView {
	inputEl!: HTMLInputElement;
	#summaryEl!: HTMLElement;
	#resultsEl!: HTMLElement;
	#run = debounce(() => this.#search(), 200, true);
	#generation = 0;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "search";
	}

	getViewType() {
		return "search";
	}

	getDisplayText() {
		return "Search";
	}

	async onOpen() {
		this.headerEl.hide();
		const row = this.contentEl.createDiv("search-input-row");
		this.inputEl = row.createEl("input", { type: "search", placeholder: "Search files... (/regex/ and tag:#tag work)" });
		this.inputEl.addEventListener("input", () => this.#run());
		this.#summaryEl = this.contentEl.createDiv("search-summary");
		this.#resultsEl = this.contentEl.createDiv("search-results");
	}

	async #search() {
		const generation = ++this.#generation;
		const query = this.inputEl.value.trim();
		this.#resultsEl.empty();
		this.#summaryEl.empty();
		if (!query) return;
		const tag = tagQuery(query);
		const re = tag === null ? compileSearch(query) : null;
		if (tag === null && !re) {
			this.#summaryEl.setText("Invalid regular expression");
			return;
		}
		const nameRe = re && new RegExp(re.source, re.flags.replace("g", ""));
		let files = 0;
		let matches = 0;
		// TeX and text notes have no tags, so a tag query reads Markdown only.
		const all = this.app.vault
			.getFiles()
			.filter((f) => (tag === null ? isIndexedNote(f) : f.extension === "md"))
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
		for (const file of all) {
			const cache = tag === null ? null : this.app.metadataCache.getFileCache(file);
			// Only a tagged note is worth reading for a tag.
			if (tag !== null && !getAllTags(cache)?.some((name) => isTag(name, tag))) continue;
			const text = await this.app.vault.cachedRead(file);
			if (generation !== this.#generation) return;
			const found = tag !== null ? tagMatches(cache, text, tag) : textMatches(text, re!);
			const nameHit = !!nameRe && file.basename.search(nameRe) >= 0;
			if (!found.length && !nameHit && tag === null) continue;
			this.#show(file, text, found.slice(0, MAX_MATCHES_PER_FILE));
			files++;
			matches += found.length || 1;
			if (files >= MAX_FILES) break;
		}
		this.#summaryEl.setText(`${matches} matches in ${files} files${files >= MAX_FILES ? " (showing the first 200 files)" : ""}`);
	}

	#show(file: TFile, text: string, found: SearchMatch[]) {
		const group = this.#resultsEl.createDiv("search-result");
		const title = group.createDiv({ cls: "search-result-file-title", text: file.extension === "md" ? file.path.slice(0, -3) : file.path });
		title.addEventListener("click", () => this.#open(file, null));
		const drag = this.app.dragManager;
		drag.handleDrag(title, (evt) => drag.dragFile(evt, file, "search"));
		const lines = text.split("\n");
		for (const match of found) {
			const el = group.createDiv("search-result-match");
			appendMatch(el, lines[match.line] ?? "", match);
			el.addEventListener("click", () => this.#open(file, match));
			drag.handleDrag(el, (evt) => drag.dragFile(evt, file, "search"));
		}
	}

	// The view scrolls to the match and selects it, in reading view too.
	async #open(file: TFile, match: SearchMatch | null) {
		const leaf = this.app.workspace.getLeaf(false);
		const eState = match ? { cursor: { from: { line: match.line, ch: match.from }, to: { line: match.line, ch: match.to } }, line: match.line } : undefined;
		await leaf.openFile(file, { active: true, eState });
	}
}
