import type { EditorView } from "@codemirror/view";
import type { App } from "../api/app";
import { setIcon } from "../api/icons";
import { Keymap } from "../api/keymap";
import { MarkdownView } from "../api/markdown-view";
import type { CachedMetadata, HeadingCache, Pos, Reference } from "../api/metadata";
import { parseFrontMatterAliases } from "../api/metadata-utils";
import { Notice } from "../api/ui/notice";
import { debounce } from "../api/util";
import type { TAbstractFile, TFile } from "../api/vault";
import { ItemView } from "../api/view";
import type { WorkspaceLeaf } from "../api/workspace";
import { appendMatch, type SearchMatch } from "./search";

// Letters that make a word with the letters next to them. Chinese and
// Japanese put no spaces between words, so a name next to one of their
// characters still stands alone.
const WORD = /[\p{L}\p{N}_]/u;
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

// The names a note goes by: its file name and its aliases.
export function namesOf(file: TFile, cache: CachedMetadata | null) {
	const names = [file.basename, ...(parseFrontMatterAliases(cache?.frontmatter) ?? [])];
	return [...new Set(names.map((name) => String(name).trim()).filter(Boolean))];
}

// The parts of a note where a name is no mention: its frontmatter, links and
// embeds, and code blocks. Offsets, end excluded.
export function mentionSkips(cache: CachedMetadata | null): [number, number][] {
	const skips: [number, number][] = [];
	const add = (pos?: Pos) => {
		if (pos) skips.push([pos.start.offset, pos.end.offset]);
	};
	add(cache?.frontmatterPosition);
	for (const ref of [...(cache?.links ?? []), ...(cache?.embeds ?? [])]) add(ref.position);
	for (const section of cache?.sections ?? []) if (section.type === "code" || section.type === "yaml") add(section.position);
	return skips;
}

// Where `text` names one of `names` outside `skips`, ignoring case: the name
// must stand alone (see WORD), and of overlapping names the longer one counts.
export function findMentions(text: string, names: string[], skips: [number, number][]): SearchMatch[] {
	const found: [number, number][] = [];
	const loose = (ch: string | undefined, edge: string) => !ch || !WORD.test(ch) || UNSPACED.test(ch) || UNSPACED.test(edge);
	for (const name of names) {
		const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
		for (const m of text.matchAll(re)) {
			const from = m.index;
			const to = from + m[0].length;
			if (!loose(text[from - 1], m[0][0]) || !loose(text[to], m[0][m[0].length - 1])) continue;
			if (skips.some(([a, b]) => from < b && to > a)) continue;
			found.push([from, to]);
		}
	}
	found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	const starts = [0];
	for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
	const matches: SearchMatch[] = [];
	let end = -1;
	for (const [from, to] of found) {
		if (from < end) continue;
		end = to;
		let line = 0;
		for (let lo = 0, hi = starts.length - 1; lo <= hi; ) {
			const mid = (lo + hi) >> 1;
			if (starts[mid] <= from) {
				line = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		matches.push({ line, from: from - starts[line], to: to - starts[line] });
	}
	return matches;
}

export interface OutlineNode {
	heading: HeadingCache;
	children: OutlineNode[];
}

// The headings as a tree: each one holds the deeper headings after it.
export function headingTree(headings: HeadingCache[]): OutlineNode[] {
	const roots: OutlineNode[] = [];
	const stack: OutlineNode[] = [];
	for (const heading of headings) {
		const node = { heading, children: [] };
		while (stack.length && stack[stack.length - 1].heading.level >= heading.level) stack.pop();
		(stack.length ? stack[stack.length - 1].children : roots).push(node);
		stack.push(node);
	}
	return roots;
}

// Opens `file` where a pane's row points: in the tab that shows it already,
// else in the current one; Mod-click opens a new tab.
async function openAt(app: App, file: TFile, eState: Record<string, unknown>, evt: MouseEvent) {
	const where = Keymap.isModEvent(evt);
	let leaf: WorkspaceLeaf | null = where ? app.workspace.getLeaf(where) : null;
	if (!leaf) {
		const recent = app.workspace.getMostRecentLeaf();
		if ((recent?.view as { file?: TFile } | undefined)?.file === file) leaf = recent;
		app.workspace.iterateRootLeaves((l) => {
			if (!leaf && (l.view as { file?: TFile }).file === file) leaf = l;
		});
	}
	await (leaf ?? app.workspace.getLeaf(false)).openFile(file, { active: true, eState });
}

const byName = (a: TFile, b: TFile) => a.basename.localeCompare(b.basename, undefined, { numeric: true }) || a.path.localeCompare(b.path);

// A section with a heading that folds it; `onToggle` hears the new state.
// A row that drags its file, as Obsidian's search results and link panes do.
function dragFile(app: App, el: HTMLElement, file: TFile, source: string) {
	app.dragManager.handleDrag(el, (evt) => app.dragManager.dragFile(evt, file, source));
}

function section(parent: HTMLElement, title: string, collapsed: boolean, onToggle: (collapsed: boolean) => void) {
	const el = parent.createDiv("link-pane-section");
	const header = el.createDiv("link-pane-section-header");
	const icon = header.createDiv("link-pane-collapse");
	header.createSpan({ text: title });
	const count = header.createSpan("link-pane-count");
	const body = el.createDiv("link-pane-section-body");
	const set = (value: boolean) => {
		el.toggleClass("is-collapsed", value);
		setIcon(icon, value ? "chevron-right" : "chevron-down");
	};
	set(collapsed);
	header.addEventListener("click", () => {
		const next = !el.hasClass("is-collapsed");
		set(next);
		onToggle(next);
	});
	return { count, body };
}

// A pane in the sidebar that shows something about the active file and
// follows it, as Obsidian's backlinks, outgoing links and outline do.
abstract class ActiveFilePane extends ItemView {
	file: TFile | null = null;
	// Where `fill` renders, under what `buildHeader` adds.
	bodyEl!: HTMLElement;
	#generation = 0;
	#refresh = debounce(() => this.#render(), 300, true);

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.navigation = false;
	}

	getDisplayText() {
		return this.file ? `${this.title} of ${this.file.basename}` : this.title;
	}

	abstract readonly title: string;

	// Fills `el`; `current()` turns false once a later render has begun.
	abstract fill(file: TFile, el: HTMLElement, current: () => boolean): Promise<void>;

	// Adds what stays above the rendered part.
	buildHeader(_el: HTMLElement) {}

	// The rendered part is in place.
	rendered() {}

	async onOpen() {
		this.headerEl.hide();
		this.contentEl.addClass("link-pane");
		this.buildHeader(this.contentEl);
		this.bodyEl = this.contentEl.createDiv("link-pane-body");
		const follow = () => {
			const file = this.app.workspace.getActiveFile();
			if (file === this.file) return;
			this.file = file;
			this.#render();
		};
		this.registerEvent(this.app.workspace.on("file-open", follow));
		this.registerEvent(this.app.workspace.on("active-leaf-change", follow));
		this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile) => this.changed(file) && this.refresh()));
		this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => this.changed(file) && this.refresh()));
		this.file = this.app.workspace.getActiveFile();
		this.#render();
	}

	// Whether a change to `file` can change what the pane shows.
	changed(_file: TAbstractFile) {
		return true;
	}

	refresh() {
		this.#refresh();
	}

	async #render() {
		const generation = ++this.#generation;
		const el = createDiv();
		if (this.file) await this.fill(this.file, el, () => generation === this.#generation);
		else el.createDiv({ cls: "link-pane-empty", text: "No file is open." });
		if (generation !== this.#generation) return;
		const scroll = this.contentEl.scrollTop;
		this.bodyEl.empty();
		this.bodyEl.append(...Array.from(el.childNodes));
		this.contentEl.scrollTop = scroll;
		this.leaf.updateHeader();
		this.rendered();
	}
}

// A note's linked and unlinked mentions, as the backlinks pane shows them and
// the backlinks under a note do. `refresh` asks the owner to render again.
export class BacklinkList {
	app: App;
	sources = new Set<string>();
	linkedCollapsed = false;
	unlinkedCollapsed = true;
	#refresh: () => void;

	constructor(app: App, refresh: () => void) {
		this.app = app;
		this.#refresh = refresh;
	}

	// Whether a 'resolve' of `file` can change the list of `shown`: a note's
	// own edits change only its self-links; other notes' edits change its
	// mentions.
	affectedBy(file: TFile, shown: TFile | null) {
		return file !== shown || this.sources.has(file.path);
	}

	getState() {
		return { collapseAll: this.linkedCollapsed, unlinkedCollapsed: this.unlinkedCollapsed };
	}

	setState(state: any) {
		if (typeof state?.unlinkedCollapsed === "boolean") this.unlinkedCollapsed = state.unlinkedCollapsed;
		if (typeof state?.collapseAll === "boolean") this.linkedCollapsed = state.collapseAll;
	}

	async fill(file: TFile, el: HTMLElement, current: () => boolean) {
		const { vault, metadataCache } = this.app;
		const backlinks = metadataCache.getBacklinksForFile(file);
		this.sources = new Set(backlinks.keys());
		const linked = section(el, "Linked mentions", this.linkedCollapsed, (c) => {
			this.linkedCollapsed = c;
		});
		const sources = backlinks
			.keys()
			.map((path) => vault.getFileByPath(path))
			.filter((f): f is TFile => !!f)
			.sort(byName);
		linked.count.setText(String(sources.length));
		if (!sources.length) linked.body.createDiv({ cls: "link-pane-empty", text: "No backlinks found." });
		for (const source of sources) {
			const text = await vault.cachedRead(source);
			if (!current()) return;
			const group = this.#group(linked.body, source);
			const lines = text.split("\n");
			for (const ref of backlinks.get(source.path) ?? []) this.#reference(group, source, lines, ref);
		}
		const unlinked = section(el, "Unlinked mentions", this.unlinkedCollapsed, (c) => {
			this.unlinkedCollapsed = c;
			if (!c) this.#refresh();
		});
		if (this.unlinkedCollapsed || file.extension !== "md") return;
		const names = namesOf(file, metadataCache.getFileCache(file));
		let count = 0;
		for (const source of vault.getMarkdownFiles().sort(byName)) {
			if (source === file) continue;
			const text = await vault.cachedRead(source);
			if (!current()) return;
			const found = findMentions(text, names, mentionSkips(metadataCache.getFileCache(source)));
			if (!found.length) continue;
			count++;
			const group = this.#group(unlinked.body, source);
			const lines = text.split("\n");
			for (const match of found) {
				const row = this.#row(group, source, lines[match.line] ?? "", match, { line: match.line, from: match.from, to: match.to });
				const button = row.createEl("button", { cls: "link-pane-link-button", text: "Link" });
				button.addEventListener("click", (evt) => {
					evt.stopPropagation();
					this.#link(source, file, match, (lines[match.line] ?? "").slice(match.from, match.to));
				});
			}
		}
		unlinked.count.setText(String(count));
		if (!count) unlinked.body.createDiv({ cls: "link-pane-empty", text: "No unlinked mentions found." });
	}

	#group(parent: HTMLElement, file: TFile) {
		const group = parent.createDiv("link-pane-group");
		const title = group.createDiv({ cls: "search-result-file-title", text: file.basename });
		title.setAttr("aria-label", file.path);
		title.addEventListener("click", (evt) => openAt(this.app, file, {}, evt));
		dragFile(this.app, title, file, "backlink");
		return group;
	}

	#row(group: HTMLElement, file: TFile, content: string, match: { from: number; to: number }, at: { line: number; from: number; to: number }) {
		const row = group.createDiv("search-result-match");
		appendMatch(row.createSpan("link-pane-match-text"), content, match);
		const eState = { cursor: { from: { line: at.line, ch: at.from }, to: { line: at.line, ch: at.to } }, line: at.line };
		row.addEventListener("click", (evt) => openAt(this.app, file, eState, evt));
		dragFile(this.app, row, file, "backlink");
		return row;
	}

	// A frontmatter link has no position; its row shows the property.
	#reference(group: HTMLElement, source: TFile, lines: string[], ref: Reference & { position?: Pos; key?: string }) {
		if (!ref.position) {
			const content = `${ref.key ?? ""}: ${ref.original}`;
			this.#row(group, source, content, { from: content.length - ref.original.length, to: content.length }, { line: 0, from: 0, to: 0 });
			return;
		}
		const { start, end } = ref.position;
		const content = lines[start.line] ?? "";
		const to = end.line === start.line ? end.col : content.length;
		this.#row(group, source, content, { from: start.col, to }, { line: start.line, from: start.col, to });
	}

	// Turns a mention into a link, if the note still has it where it was found.
	async #link(source: TFile, target: TFile, match: SearchMatch, text: string) {
		const link = this.app.fileManager.generateMarkdownLink(target, source.path, "", text === target.basename ? undefined : text);
		let done = false;
		await this.app.vault.process(source, (data) => {
			let offset = 0;
			for (let i = 0; i < match.line; i++) offset = data.indexOf("\n", offset) + 1;
			if (data.slice(offset + match.from, offset + match.to) !== text) return data;
			done = true;
			return data.slice(0, offset + match.from) + link + data.slice(offset + match.to);
		});
		if (!done) new Notice(`${source.basename} changed; the mention is no longer there.`);
		this.#refresh();
	}
}

export class BacklinkView extends ActiveFilePane {
	readonly title = "Backlinks";
	list = new BacklinkList(this.app, () => this.refresh());

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "links-coming-in";
	}

	getViewType() {
		return "backlink";
	}

	async onOpen() {
		this.registerEvent(this.app.metadataCache.on("resolve", (file: TFile) => this.list.affectedBy(file, this.file) && this.refresh()));
		await super.onOpen();
	}

	getState() {
		return { file: this.file?.path ?? null, ...this.list.getState() };
	}

	async setState(state: any) {
		this.list.setState(state);
	}

	fill(file: TFile, el: HTMLElement, current: () => boolean) {
		return this.list.fill(file, el, current);
	}
}

export class OutgoingLinkView extends ActiveFilePane {
	readonly title = "Outgoing links";
	#linksCollapsed = false;
	#unlinkedCollapsed = true;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "links-going-out";
	}

	getViewType() {
		return "outgoing-link";
	}

	async onOpen() {
		this.registerEvent(this.app.metadataCache.on("resolve", (file: TFile) => file === this.file && this.refresh()));
		await super.onOpen();
	}

	changed(file: TAbstractFile) {
		return file === this.file || !this.#unlinkedCollapsed;
	}

	getState() {
		return { file: this.file?.path ?? null, linksCollapsed: this.#linksCollapsed, unlinkedCollapsed: this.#unlinkedCollapsed };
	}

	async setState(state: any) {
		if (typeof state?.linksCollapsed === "boolean") this.#linksCollapsed = state.linksCollapsed;
		if (typeof state?.unlinkedCollapsed === "boolean") this.#unlinkedCollapsed = state.unlinkedCollapsed;
	}

	async fill(file: TFile, el: HTMLElement, current: () => boolean) {
		const { vault, metadataCache } = this.app;
		const links = section(el, "Links", this.#linksCollapsed, (c) => {
			this.#linksCollapsed = c;
		});
		const resolved = Object.keys(metadataCache.resolvedLinks[file.path] ?? {})
			.map((path) => vault.getFileByPath(path))
			.filter((f): f is TFile => !!f)
			.sort(byName);
		const unresolved = Object.keys(metadataCache.unresolvedLinks[file.path] ?? {}).sort((a, b) => a.localeCompare(b));
		links.count.setText(String(resolved.length + unresolved.length));
		for (const dest of resolved) {
			const row = links.body.createDiv({ cls: "search-result-file-title", text: dest.extension === "md" ? dest.basename : dest.name });
			row.setAttr("aria-label", dest.path);
			row.addEventListener("click", (evt) => openAt(this.app, dest, {}, evt));
			dragFile(this.app, row, dest, "outgoing-link");
		}
		for (const link of unresolved) {
			const row = links.body.createDiv({ cls: "search-result-file-title is-unresolved", text: link });
			row.addEventListener("click", (evt) => this.app.workspace.openLinkText(link, file.path, Keymap.isModEvent(evt)));
			const drag = this.app.dragManager;
			drag.handleDrag(row, (evt) => drag.dragLink(evt, link, file.path, link, "outgoing-link"));
		}
		if (!resolved.length && !unresolved.length) links.body.createDiv({ cls: "link-pane-empty", text: "No links found." });
		const unlinked = section(el, "Unlinked mentions", this.#unlinkedCollapsed, (c) => {
			this.#unlinkedCollapsed = c;
			if (!c) this.refresh();
		});
		if (this.#unlinkedCollapsed || file.extension !== "md") return;
		const text = await vault.cachedRead(file);
		if (!current()) return;
		const skips = mentionSkips(metadataCache.getFileCache(file));
		let count = 0;
		for (const dest of vault.getMarkdownFiles().sort(byName)) {
			if (dest === file) continue;
			const found = findMentions(text, namesOf(dest, metadataCache.getFileCache(dest)), skips);
			if (!found.length) continue;
			count++;
			const row = unlinked.body.createDiv({ cls: "search-result-file-title", text: dest.basename });
			row.createSpan({ cls: "link-pane-count", text: String(found.length) });
			row.setAttr("aria-label", dest.path);
			row.addEventListener("click", (evt) => openAt(this.app, dest, {}, evt));
			dragFile(this.app, row, dest, "outgoing-link");
		}
		unlinked.count.setText(String(count));
		if (!count) unlinked.body.createDiv({ cls: "link-pane-empty", text: "No unlinked mentions found." });
	}
}

// The heading a note's line is under: the last one starting at or before it.
export function headingAt(headings: HeadingCache[], line: number) {
	let found = -1;
	for (let i = 0; i < headings.length && headings[i].position.start.line <= line; i++) found = i;
	return found;
}

// Which outline nodes a search shows: those whose heading contains the query,
// ignoring case, and the headings above them. Empty shows everything.
export function outlineMatches(nodes: OutlineNode[], query: string): Set<OutlineNode> | null {
	const q = query.trim().toLowerCase();
	if (!q) return null;
	const shown = new Set<OutlineNode>();
	const visit = (node: OutlineNode): boolean => {
		let hit = node.heading.heading.toLowerCase().includes(q);
		for (const child of node.children) if (visit(child)) hit = true;
		if (hit) shown.add(node);
		return hit;
	};
	for (const node of nodes) visit(node);
	return shown;
}

interface OutlineItem {
	node: OutlineNode;
	el: HTMLElement;
	self: HTMLElement;
}

export class OutlineView extends ActiveFilePane {
	readonly title = "Outline";
	#collapsed = new Set<string>();
	#showSearch = false;
	#query = "";
	#searchEl!: HTMLElement;
	#inputEl!: HTMLInputElement;
	#searchButton!: HTMLElement;
	#roots: OutlineNode[] = [];
	// In document order, as the cache lists the headings.
	#items: OutlineItem[] = [];
	#active: OutlineItem | null = null;
	#follow = debounce(() => this.#highlight(), 100, true);

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "list";
	}

	getViewType() {
		return "outline";
	}

	async onOpen() {
		this.registerEvent(this.app.metadataCache.on("changed", (file: TFile) => file === this.file && this.refresh()));
		// The cursor in the editor, the scroll position in the reading view.
		this.registerDomEvent(document, "selectionchange", () => this.#follow());
		this.registerDomEvent(document, "scroll", (evt: Event) => (evt.target as HTMLElement).closest?.(".markdown-reading-view") && this.#follow(), { capture: true, passive: true });
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.#follow()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.#follow()));
		await super.onOpen();
	}

	buildHeader(el: HTMLElement) {
		const nav = el.createDiv("nav-header");
		const buttons = nav.createDiv("nav-buttons-container");
		this.#searchButton = buttons.createDiv({ cls: "clickable-icon nav-action-button", attr: { "aria-label": "Show search filter" } });
		setIcon(this.#searchButton, "search");
		this.#searchButton.addEventListener("click", () => this.#setShowSearch(!this.#showSearch, true));
		this.#searchEl = el.createDiv("search-input-container outline-search");
		this.#inputEl = this.#searchEl.createEl("input", { type: "search", placeholder: "Search..." });
		this.#inputEl.value = this.#query;
		this.#inputEl.addEventListener("input", () => {
			this.#query = this.#inputEl.value;
			this.#applyFilter();
			this.app.workspace.requestSaveLayout();
		});
		this.#inputEl.addEventListener("keydown", (evt) => {
			if (evt.key !== "Escape") return;
			evt.preventDefault();
			this.#setShowSearch(false, false);
		});
		this.#setShowSearch(this.#showSearch, false);
	}

	// Hiding the box drops its filter, as in Obsidian.
	#setShowSearch(show: boolean, focus: boolean) {
		this.#showSearch = show;
		this.#searchButton?.toggleClass("is-active", show);
		this.#searchEl?.toggle(show);
		if (!show && this.#query) {
			this.#query = "";
			if (this.#inputEl) this.#inputEl.value = "";
			this.#applyFilter();
		}
		if (show && focus) this.#inputEl.focus();
		this.app.workspace.requestSaveLayout();
	}

	changed(file: TAbstractFile) {
		return file === this.file;
	}

	getState() {
		return { file: this.file?.path ?? null, showSearch: this.#showSearch, searchQuery: this.#query };
	}

	async setState(state: any) {
		if (typeof state?.searchQuery === "string") this.#query = state.searchQuery;
		if (typeof state?.showSearch === "boolean") {
			this.#showSearch = state.showSearch;
			if (this.#searchEl) {
				this.#inputEl.value = this.#query;
				this.#setShowSearch(this.#showSearch, false);
				this.#applyFilter();
			}
		}
	}

	async fill(file: TFile, el: HTMLElement) {
		this.#items = [];
		this.#active = null;
		const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
		this.#roots = headingTree(headings);
		if (!headings.length) {
			el.createDiv({ cls: "link-pane-empty", text: "No headings found." });
			return;
		}
		const add = (parent: HTMLElement, nodes: OutlineNode[]) => {
			for (const node of nodes) {
				const { heading } = node;
				// A heading's place in the note keys its folded state.
				const key = `${file.path}:${heading.position.start.line}`;
				const item = parent.createDiv("outline-item");
				const self = item.createDiv("outline-item-self");
				this.#items.push({ node, el: item, self });
				const icon = self.createDiv("link-pane-collapse");
				self.createSpan({ text: heading.heading });
				const children = item.createDiv("outline-item-children");
				if (node.children.length) {
					const set = (collapsed: boolean) => {
						item.toggleClass("is-collapsed", collapsed);
						setIcon(icon, collapsed ? "chevron-right" : "chevron-down");
					};
					set(this.#collapsed.has(key));
					icon.addEventListener("click", (evt) => {
						evt.stopPropagation();
						if (!this.#collapsed.delete(key)) this.#collapsed.add(key);
						set(this.#collapsed.has(key));
					});
					add(children, node.children);
				}
				self.addEventListener("click", (evt) => openAt(this.app, file, { line: heading.position.start.line }, evt));
				// A heading drags as a link to it.
				const drag = this.app.dragManager;
				drag.handleDrag(self, (evt) => drag.dragLink(evt, `${this.app.metadataCache.fileToLinktext(file, "")}#${heading.heading}`, "", heading.heading, "outline"));
			}
		};
		add(el, this.#roots);
		this.#items.sort((a, b) => a.node.heading.position.start.line - b.node.heading.position.start.line);
	}

	rendered() {
		this.#applyFilter();
		this.#highlight();
	}

	// While searching, matching headings show with the headings above them,
	// unfolded.
	#applyFilter() {
		const shown = outlineMatches(this.#roots, this.#query);
		this.bodyEl?.toggleClass("is-filtering", !!shown);
		for (const item of this.#items) item.el.toggle(!shown || shown.has(item.node));
	}

	// The view showing this pane's file: the active one, else the most recent.
	// The 0-based line the note's view is at: a Markdown editor's cursor or
	// reading view's top line, or the cursor of a TeX or text note's editor
	// (its CodeMirror `editorView`). Null when no view shows the note.
	#viewLine(): number | null {
		const ofView = (view: unknown) => {
			if (view instanceof MarkdownView) return view.file === this.file ? (view.getMode() === "preview" ? Math.floor(view.previewMode.getScroll()) : view.editor.getCursor().line) : null;
			const v = view as { file?: TFile | null; editorView?: EditorView | null } | undefined;
			if (!v?.editorView || v.file !== this.file) return null;
			const state = v.editorView.state;
			return state.doc.lineAt(state.selection.main.head).number - 1;
		};
		return ofView(this.app.workspace.activeLeaf?.view) ?? ofView(this.app.workspace.getMostRecentLeaf()?.view);
	}

	// Marks the heading the cursor is under (the top of the reading view).
	#highlight() {
		const line = this.#viewLine();
		let item: OutlineItem | null = null;
		if (line !== null && this.#items.length) item = this.#items[headingAt(this.#items.map((i) => i.node.heading), line)] ?? null;
		if (item === this.#active) return;
		this.#active?.self.removeClass("is-active");
		this.#active = item;
		if (!item) return;
		item.self.addClass("is-active");
		if (item.el.isShown()) item.self.scrollIntoView({ block: "nearest" });
	}
}

export function registerLinkPanes(app: App) {
	app.viewRegistry.registerView("backlink", (leaf) => new BacklinkView(leaf));
	app.viewRegistry.registerView("outgoing-link", (leaf) => new OutgoingLinkView(leaf));
	app.viewRegistry.registerView("outline", (leaf) => new OutlineView(leaf));
}
