import type { App } from "../api/app";
import { DragManager } from "../api/drag-manager";
import type { Editor } from "../api/editor";
import { Events } from "../api/events";
import { setIcon } from "../api/icons";
import type { CorePluginHost } from "../api/internal-plugins";
import { Keymap } from "../api/keymap";
import { parseMetadata } from "../api/metadata";
import { MarkdownView } from "../api/markdown-view";
import { Menu } from "../api/ui/menu";
import { Modal } from "../api/ui/modal";
import { Notice } from "../api/ui/notice";
import { Setting } from "../api/ui/setting";
import { debounce } from "../api/util";
import { type TAbstractFile, TFile, TFolder } from "../api/vault";
import { FileView, ItemView, type View } from "../api/view";
import type { PaneType, WorkspaceLeaf } from "../api/workspace";
import {
	type BookmarkItem,
	type BookmarksData,
	cloneBookmarks,
	contains,
	findParent,
	flattenBookmarks,
	mergeBookmarks,
	moveBookmark,
	newBookmark,
	parseBookmarks,
	removeDeletedFromBookmarks,
	renameInBookmarks,
	serializeBookmarks,
	walkBookmarks,
} from "./bookmarks-data";
import { PromptModal } from "./views";

const ICONS: Record<string, string> = { file: "file", folder: "folder", search: "search", graph: "git-fork", url: "globe", group: "folder-closed" };

// The bookmarks core plugin's instance, with the members plugins read in
// Obsidian (`items`, `getBookmarks`, `addItem`, `removeItem`, the `changed`
// event, ...). Its items mirror <configDir>/bookmarks.json, the one Obsidian
// config file justnotes writes: only when bookmarks change, in Obsidian's
// format, merging what Obsidian or git wrote meanwhile.
export class BookmarksInstance extends Events {
	app: App;
	id = "bookmarks";
	options: Record<string, any> = {};
	items: BookmarkItem[] = [];
	// File and folder bookmarks by path, as Obsidian keeps them.
	bookmarkLookup: Record<string, BookmarkItem> = {};
	urlBookmarkLookup: Record<string, BookmarkItem> = {};
	loaded = false;
	#data: BookmarksData = { items: this.items };
	// What the file held when last read or written; null when there was none.
	#baseText: string | null = null;
	#base: BookmarksData = { items: [] };
	#dirty = false;
	#queue: Promise<void> = Promise.resolve();
	#lastCtime = 0;

	constructor(app: App) {
		super();
		this.app = app;
	}

	get path() {
		return `${this.app.vault.configDir}/bookmarks.json`;
	}

	async load() {
		this.loaded = true;
		await this.saveData();
		this.onItemsChanged(false);
	}

	unload() {
		this.loaded = false;
		this.#adopt({ items: [] });
		this.#baseText = null;
		this.#base = { items: [] };
		this.#dirty = false;
		this.trigger("changed");
	}

	getBookmarks() {
		return flattenBookmarks(this.items);
	}

	getItemTitle(item: BookmarkItem): string {
		if (item.title) return item.title;
		switch (item.type) {
			case "file": {
				const path = item.path ?? "";
				const file = this.app.vault.getAbstractFileByPath(path);
				const name = file instanceof TFile ? (file.extension === "md" ? file.basename : file.name) : (path.split("/").pop() ?? path).replace(/\.md$/, "");
				const sub = item.subpath ?? "";
				return sub.startsWith("#^") ? `${name} > ${sub.slice(1)}` : sub.startsWith("#") ? `${name} > ${sub.slice(1)}` : name;
			}
			case "folder":
				return item.path?.split("/").pop() || "/";
			case "search":
				return item.query ?? "";
			case "graph":
				return "Graph view";
			case "url":
				return item.url ?? "";
			case "group":
				return "Untitled group";
			default:
				return item.type;
		}
	}

	// A creation time no other item has, so items stay apart in a merge.
	ctime() {
		const now = Math.max(Date.now(), this.#lastCtime + 1);
		this.#lastCtime = now;
		return now;
	}

	// Adds an item to a group (the top level by default), at the end or at
	// `index`.
	addItem(item: BookmarkItem, group: BookmarkItem | null = null, index?: number) {
		if (!item.ctime) item.ctime = this.ctime();
		const list = group ? (group.items ??= []) : this.items;
		list.splice(index ?? list.length, 0, item);
		this.onItemsChanged(true);
		return item;
	}

	removeItem(item: BookmarkItem) {
		const found = findParent(this.items, item);
		if (!found) return;
		found.list.remove(item);
		this.onItemsChanged(true);
	}

	moveItem(item: BookmarkItem, group: BookmarkItem | null, index: number) {
		if (moveBookmark(this.items, item, group, index)) this.onItemsChanged(true);
	}

	// Sets fields of an item; undefined or empty ones are removed.
	updateItem(item: BookmarkItem, fields: Partial<BookmarkItem>) {
		for (const [key, value] of Object.entries(fields)) {
			if (value === undefined || value === "") delete item[key];
			else item[key] = value;
		}
		this.onItemsChanged(true);
	}

	editItem(item: BookmarkItem) {
		new BookmarkModal(this.app, this, [item], true).open();
	}

	// The bookmark of a file (with this subpath) or folder, if any.
	findBookmark(path: string, subpath?: string) {
		let found: BookmarkItem | null = null;
		walkBookmarks(this.items, (item) => {
			if (!found && (item.type === "file" || item.type === "folder") && item.path === path && (item.subpath ?? "") === (subpath ?? "")) found = item;
		});
		return found as BookmarkItem | null;
	}

	// What a view would be bookmarked as: its file, its search or its graph.
	itemForView(view: View | null | undefined): BookmarkItem | null {
		if (!view) return null;
		if (view instanceof FileView && view.file) return newBookmark("file", 0, { path: view.file.path });
		const type = view.getViewType();
		if (type === "search") {
			const query = (view as View & { inputEl?: HTMLInputElement }).inputEl?.value.trim();
			return query ? newBookmark("search", 0, { query }) : null;
		}
		if (type === "graph") return newBookmark("graph", 0, { options: cloneBookmarks(view.getState().options ?? {}) });
		return null;
	}

	findBookmarkForView(view: View | null | undefined) {
		const item = this.itemForView(view);
		return item?.type === "file" ? this.findBookmark(item.path!) : null;
	}

	// Opens a bookmark: a file at its heading or block, a folder in the file
	// explorer, a search in Search, a graph with its options, a link outside.
	async openBookmark(item: BookmarkItem, newLeaf: PaneType | boolean = false) {
		const { app } = this;
		switch (item.type) {
			case "file": {
				const file = app.vault.getFileByPath(item.path ?? "");
				if (!file) {
					new Notice(`"${item.path}" does not exist.`);
					return;
				}
				await app.workspace.getLeaf(newLeaf).openFile(file, { active: true, eState: item.subpath ? { subpath: item.subpath } : undefined });
				return;
			}
			case "folder": {
				const folder = app.vault.getAbstractFileByPath(item.path ?? "");
				if (!(folder instanceof TFolder)) new Notice(`"${item.path}" does not exist.`);
				else await app.internalPlugins.getPluginById("file-explorer")?.instance.revealInFolder(folder);
				return;
			}
			case "search":
				await app.internalPlugins.getPluginById("global-search")?.instance.openGlobalSearch(item.query ?? "");
				return;
			case "graph": {
				const existing = newLeaf ? null : app.workspace.getLeavesOfType("graph")[0];
				const leaf = existing ?? app.workspace.getLeaf(newLeaf || "tab");
				await leaf.setViewState({ type: "graph", state: { options: cloneBookmarks(item.options ?? {}) }, active: true });
				await app.workspace.revealLeaf(leaf);
				return;
			}
			case "url":
				if (item.url) window.open(item.url, "_blank");
				return;
			case "group":
				for (const child of item.items ?? []) if (child.type !== "group") await this.openBookmark(child, "tab");
				return;
		}
	}

	// Rebuilds the lookups, tells views and plugins, and saves when asked.
	onItemsChanged(save = false) {
		this.bookmarkLookup = {};
		this.urlBookmarkLookup = {};
		walkBookmarks(this.items, (item) => {
			if ((item.type === "file" || item.type === "folder") && item.path && !item.subpath) this.bookmarkLookup[item.path] ??= item;
			if (item.type === "url" && item.url) this.urlBookmarkLookup[item.url] ??= item;
		});
		this.trigger("changed");
		if (save) {
			this.#dirty = true;
			void this.saveData();
		}
	}

	// Brings the items and the file together, one sync at a time: a file
	// that changed since the last read is merged with the items (taken as it
	// is when justnotes has no changes of its own), and the items are written
	// only when justnotes changed them. A file that does not parse is left
	// alone and nothing is saved until it does.
	saveData() {
		const run = this.#queue.then(() => this.#sync());
		this.#queue = run.catch((err) => console.error("Bookmarks: could not sync bookmarks.json", err));
		return this.#queue;
	}

	// The file changed on disk (vault `raw` event).
	onExternalChange = debounce(() => void this.saveData(), 100, true);

	async #sync() {
		if (!this.loaded) return;
		const adapter = this.app.vault.adapter;
		let text: string | null;
		try {
			text = await adapter.read(this.path);
		} catch {
			text = null;
		}
		if (text !== this.#baseText) {
			const theirs = text === null ? { items: [] } : parseBookmarks(text);
			if (!theirs) {
				if (this.#dirty) new Notice("bookmarks.json could not be read; bookmark changes are not saved until it can.");
				return;
			}
			const merged = this.#dirty ? mergeBookmarks(this.#base, this.#data, theirs) : theirs;
			this.#adopt(merged);
			this.#baseText = text;
			this.#base = cloneBookmarks(theirs);
			this.onItemsChanged(false);
		}
		if (!this.#dirty) return;
		this.#dirty = false;
		const out = serializeBookmarks(this.#data);
		if (out === text || (text === null && !this.items.length)) return;
		await adapter.write(this.path, out);
		this.#baseText = out;
		this.#base = cloneBookmarks(this.#data);
	}

	// Takes data in, keeping the `items` array plugins may hold.
	#adopt(data: BookmarksData) {
		this.items.splice(0, this.items.length, ...data.items);
		// The file's other fields keep their place around `items`.
		this.#data = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, key === "items" ? this.items : value])) as BookmarksData;
		for (const item of flattenBookmarks(this.items)) if (typeof item.ctime === "number") this.#lastCtime = Math.max(this.#lastCtime, item.ctime);
	}
}

// The group choices of the bookmark dialog: the top level and every group,
// named by their path.
function groupChoices(instance: BookmarksInstance, exclude: BookmarkItem[]) {
	const groups: [BookmarkItem | null, string][] = [[null, "(Top level)"]];
	const visit = (items: BookmarkItem[], prefix: string) => {
		for (const item of items) {
			if (item.type !== "group" || exclude.some((e) => contains(e, item))) continue;
			const name = `${prefix}${instance.getItemTitle(item)}`;
			groups.push([item, name]);
			visit(item.items ?? [], `${name} / `);
		}
	};
	visit(instance.items, "");
	return groups;
}

// Obsidian's Add bookmark / Edit bookmark dialog: an optional title and a
// group; editing also removes. Several new items share the group choice.
export class BookmarkModal extends Modal {
	constructor(app: App, instance: BookmarksInstance, items: BookmarkItem[], editing: boolean) {
		super(app);
		const one = items.length === 1 ? items[0] : null;
		this.setTitle(editing ? "Edit bookmark" : one ? "Add bookmark" : `Bookmark ${items.length} items`);
		let title = one?.title ?? "";
		let url = one?.url ?? "";
		let query = one?.query ?? "";
		const current = editing && one ? (findParent(instance.items, one)?.parent ?? null) : null;
		const choices = groupChoices(instance, editing ? items : []);
		let group = Math.max(0, choices.findIndex(([g]) => g === current));
		if (one) {
			new Setting(this.contentEl).setName("Title").addText((t) => {
				t.setPlaceholder(instance.getItemTitle({ ...one, title: undefined })).setValue(title).onChange((v) => (title = v));
				t.inputEl.addClass("bookmark-title-input");
				this.onOpen = () => {
					t.inputEl.focus();
					t.inputEl.select();
				};
			});
		}
		if (one?.type === "url") new Setting(this.contentEl).setName("URL").addText((t) => t.setValue(url).onChange((v) => (url = v)));
		if (one?.type === "search") new Setting(this.contentEl).setName("Search").addText((t) => t.setValue(query).onChange((v) => (query = v)));
		if (one?.type !== "group" || choices.length > 1) {
			new Setting(this.contentEl).setName("Bookmark group").addDropdown((d) => {
				choices.forEach(([, name], i) => d.addOption(String(i), name));
				d.setValue(String(group)).onChange((v) => (group = Number(v)));
			});
		}
		const save = () => {
			this.close();
			const target = choices[group]?.[0] ?? null;
			if (!editing) {
				if (one) one.title = title.trim() || undefined;
				if (one && !one.title) delete one.title;
				for (const item of items) instance.addItem(item, target);
				return;
			}
			if (!one) return;
			const fields: Partial<BookmarkItem> = { title: title.trim() };
			if (one.type === "url") fields.url = url.trim();
			if (one.type === "search") fields.query = query.trim();
			if (target !== current) moveBookmark(instance.items, one, target, target ? (target.items?.length ?? 0) : instance.items.length);
			instance.updateItem(one, fields);
		};
		const buttons = new Setting(this.contentEl);
		if (editing && one)
			buttons.addButton((b) =>
				b
					.setButtonText("Remove")
					.setWarning()
					.onClick(() => {
						this.close();
						instance.removeItem(one);
					}),
			);
		buttons.addButton((b) => b.setButtonText("Save").setCta().onClick(save));
		this.scope.register([], "Enter", () => {
			save();
			return false;
		});
	}
}

// The heading the cursor is in (on its line or below it).
function headingAt(text: string, line: number) {
	const headings = parseMetadata(text).headings ?? [];
	let found: (typeof headings)[number] | null = null;
	for (const h of headings) if (h.position.start.line <= line) found = h;
	return found;
}

// The block under the cursor as a `#^id` subpath, giving it an id when it
// has none, as Obsidian does. Null on a heading, code, frontmatter or blank.
function blockSubpath(editor: Editor, line: number): string | null {
	const text = editor.getValue();
	const cache = parseMetadata(text);
	const item = cache.listItems?.findLast((i) => i.position.start.line <= line && i.position.end.line >= line);
	const section = cache.sections?.find((s) => s.position.start.line <= line && s.position.end.line >= line);
	if (!section || ["heading", "code", "yaml", "thematicBreak", "html", "math"].includes(section.type)) return null;
	const end = item ? item.position.end.line : section.position.end.line;
	const existing = Object.values(cache.blocks ?? {}).find((b) => b.position.end.line === end);
	if (existing) return `#^${existing.id}`;
	const id = Math.random().toString(36).slice(2, 8);
	const content = editor.getLine(end);
	editor.replaceRange(`${content.endsWith(" ") ? "" : " "}^${id}`, { line: end, ch: content.length });
	return `#^${id}`;
}

// The Bookmarks view: groups and items as a tree, opened by a click,
// reordered and grouped by dragging, edited from their menu.
export class BookmarksView extends ItemView {
	instance: BookmarksInstance;
	#treeEl!: HTMLElement;
	#collapsed = new Set<string>();
	#dragged: BookmarkItem | null = null;

	constructor(leaf: WorkspaceLeaf, instance: BookmarksInstance) {
		super(leaf);
		this.instance = instance;
		this.icon = "bookmark";
		this.navigation = false;
	}

	getViewType() {
		return "bookmarks";
	}

	getDisplayText() {
		return "Bookmarks";
	}

	getState() {
		return { collapsed: [...this.#collapsed] };
	}

	async setState(state: any) {
		if (Array.isArray(state?.collapsed)) this.#collapsed = new Set(state.collapsed.filter((k: unknown) => typeof k === "string"));
		if (this.#treeEl) this.render();
	}

	async onOpen() {
		this.headerEl.hide();
		const buttons = this.contentEl.createDiv("nav-header").createDiv("nav-buttons-container");
		const button = (icon: string, title: string, cb: () => any) => {
			const el = buttons.createDiv({ cls: "clickable-icon nav-action-button", attr: { "aria-label": title } });
			setIcon(el, icon);
			el.addEventListener("click", cb);
		};
		button("bookmark-plus", "Bookmark the active tab", () => bookmarkView(this.app, this.instance, this.app.workspace.getMostRecentLeaf()?.view));
		button("folder-plus", "New bookmark group", () => newGroup(this.app, this.instance, null));
		button("chevrons-up-down", "Expand all / collapse all", () => {
			const groups: string[] = [];
			walkBookmarks(this.instance.items, (item) => item.type === "group" && groups.push(groupKey(item)));
			const collapse = groups.some((k) => !this.#collapsed.has(k));
			this.#collapsed = new Set(collapse ? groups : []);
			this.render();
			this.app.workspace.requestSaveLayout();
		});
		this.#treeEl = this.contentEl.createDiv("nav-files-container bookmarks-tree");
		this.#treeEl.addEventListener("dragover", (evt) => {
			if (evt.target !== this.#treeEl || !this.#accepts()) return;
			evt.preventDefault();
			this.#clearDrop();
			this.app.dragManager.setAction("Move to the end");
		});
		this.#treeEl.addEventListener("drop", (evt) => {
			if (evt.target !== this.#treeEl) return;
			evt.preventDefault();
			this.#drop(null, this.instance.items.length);
		});
		this.registerEvent(this.instance.on("changed", () => this.render()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.#markActive()));
		this.render();
	}

	render() {
		const scroll = this.#treeEl.scrollTop;
		this.#treeEl.empty();
		if (!this.instance.loaded) this.#treeEl.createDiv({ cls: "pane-empty", text: "Bookmarks is turned off." });
		else if (!this.instance.items.length) this.#treeEl.createDiv({ cls: "pane-empty", text: "No bookmarks yet." });
		this.#renderItems(this.instance.items, null, this.#treeEl);
		this.#treeEl.scrollTop = scroll;
		this.#markActive();
	}

	#renderItems(items: BookmarkItem[], group: BookmarkItem | null, el: HTMLElement) {
		items.forEach((item, index) => {
			const isGroup = item.type === "group";
			const itemEl = el.createDiv(`tree-item ${isGroup ? "nav-folder" : "nav-file"} bookmark`);
			const self = itemEl.createDiv({ cls: `tree-item-self is-clickable bookmark-item ${isGroup ? "nav-folder-title" : "nav-file-title"}` });
			if (item.type === "file" && item.path) self.setAttr("data-path", item.path);
			const collapsed = isGroup && this.#collapsed.has(groupKey(item));
			if (isGroup) setIcon(self.createDiv("tree-item-icon collapse-icon"), collapsed ? "chevron-right" : "chevron-down");
			const subpath = item.subpath ?? "";
			setIcon(self.createDiv("tree-item-icon bookmark-icon"), item.type === "file" && subpath ? (subpath.startsWith("#^") ? "box" : "heading") : (ICONS[item.type] ?? "bookmark"));
			self.createDiv({ cls: "tree-item-inner", text: this.instance.getItemTitle(item) });
			if (this.#missing(item)) self.addClass("is-unresolved");
			self.addEventListener("click", (evt) => {
				if (!isGroup) return void this.instance.openBookmark(item, Keymap.isModEvent(evt));
				const key = groupKey(item);
				if (!this.#collapsed.delete(key)) this.#collapsed.add(key);
				this.render();
				this.app.workspace.requestSaveLayout();
			});
			self.addEventListener("auxclick", (evt) => {
				if (evt.button === 1 && !isGroup) void this.instance.openBookmark(item, "tab");
			});
			self.addEventListener("contextmenu", (evt) => this.#showMenu(evt, item));
			this.#makeDraggable(self, item, group, index);
			if (isGroup) {
				const children = itemEl.createDiv("tree-item-children nav-folder-children");
				if (!collapsed) this.#renderItems(item.items ?? [], item, children);
			}
		});
	}

	#missing(item: BookmarkItem) {
		if (item.type === "file") return !this.app.vault.getFileByPath(item.path ?? "");
		if (item.type === "folder") return !(this.app.vault.getAbstractFileByPath(item.path ?? "") instanceof TFolder);
		return false;
	}

	#markActive() {
		const active = this.app.workspace.getActiveFile()?.path;
		for (const el of this.#treeEl.findAll(".bookmark-item[data-path]")) el.toggleClass("is-active", el.getAttr("data-path") === active);
	}

	#accepts() {
		const drag = this.app.dragManager.draggable;
		return !!this.#dragged || (!!drag && drag.type !== "bookmarks" && DragManager.files(drag).length > 0);
	}

	#clearDrop() {
		for (const el of this.#treeEl.findAll(".is-drop-before, .is-drop-after, .is-drop-into")) el.removeClass("is-drop-before", "is-drop-after", "is-drop-into");
	}

	// Rows drag through app.dragManager, so a drop on a note links the file
	// and terminal types its path. Dropped on a row, an item goes before or
	// after it, or into it when it is a group; files dragged from the
	// explorer become bookmarks there.
	#makeDraggable(el: HTMLElement, item: BookmarkItem, group: BookmarkItem | null, index: number) {
		el.draggable = true;
		el.addEventListener("dragstart", (evt) => {
			this.#dragged = item;
			const file = item.path ? this.app.vault.getAbstractFileByPath(item.path) : null;
			const files = (item.type === "file" || item.type === "folder") && file && !item.subpath ? [file] : [];
			this.app.dragManager.onDragStart(evt, {
				type: "bookmarks",
				icon: `lucide-${ICONS[item.type] ?? "bookmark"}`,
				title: this.instance.getItemTitle(item),
				source: "bookmarks",
				items: [{ item }],
				files,
			});
		});
		el.addEventListener("dragend", () => {
			this.#dragged = null;
			this.#clearDrop();
		});
		const zone = (evt: DragEvent) => {
			const rect = el.getBoundingClientRect();
			const y = (evt.clientY - rect.top) / rect.height;
			if (item.type === "group" && y > 0.25 && y < 0.75) return "into";
			return y < 0.5 ? "before" : "after";
		};
		el.addEventListener("dragover", (evt) => {
			if (!this.#accepts()) return;
			const where = zone(evt);
			if (this.#dragged && where === "into" && contains(this.#dragged, item)) return;
			evt.preventDefault();
			evt.stopPropagation();
			this.#clearDrop();
			el.addClass(`is-drop-${where}`);
			this.app.dragManager.setAction(where === "into" ? `Move into ${this.instance.getItemTitle(item)}` : this.#dragged ? "Move here" : "Bookmark here");
		});
		el.addEventListener("dragleave", () => el.removeClass("is-drop-before", "is-drop-after", "is-drop-into"));
		el.addEventListener("drop", (evt) => {
			if (!this.#accepts()) return;
			evt.preventDefault();
			evt.stopPropagation();
			const where = zone(evt);
			if (where === "into") this.#drop(item, item.items?.length ?? 0);
			else this.#drop(group, where === "before" ? index : index + 1);
		});
	}

	#drop(group: BookmarkItem | null, index: number) {
		this.#clearDrop();
		if (this.#dragged) {
			this.instance.moveItem(this.#dragged, group, index);
			this.#dragged = null;
			return;
		}
		const files = DragManager.files(this.app.dragManager.draggable);
		files.forEach((file, i) => {
			const type = file instanceof TFolder ? "folder" : "file";
			this.instance.addItem(newBookmark(type, this.instance.ctime(), { path: file.path }), group, index + i);
		});
	}

	#showMenu(evt: MouseEvent, item: BookmarkItem) {
		evt.preventDefault();
		evt.stopPropagation();
		const { app, instance } = this;
		const menu = new Menu();
		menu.addSections(["title", "open", "action", "view", "info", "system", "danger"]);
		if (item.type === "group") {
			menu.addItem((i) => i.setTitle("Open all").setIcon("files").setSection("open").onClick(() => instance.openBookmark(item)));
			menu.addItem((i) => i.setTitle("New bookmark group").setIcon("folder-plus").setSection("action").onClick(() => newGroup(app, instance, item)));
		} else if (item.type === "file") {
			menu.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus").setSection("open").onClick(() => instance.openBookmark(item, "tab")));
			menu.addItem((i) => i.setTitle("Open to the right").setIcon("separator-vertical").setSection("open").onClick(() => instance.openBookmark(item, "split")));
			menu.addItem((i) => i.setTitle("Open in new window").setIcon("picture-in-picture-2").setSection("open").onClick(() => instance.openBookmark(item, "window")));
		} else if (item.type === "graph") {
			menu.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus").setSection("open").onClick(() => instance.openBookmark(item, "tab")));
		}
		menu.addItem((i) =>
			i
				.setTitle(item.type === "group" ? "Rename..." : "Edit...")
				.setIcon("pencil")
				.setSection("action")
				.onClick(() => {
					if (item.type === "group") renameGroup(app, instance, item);
					else instance.editItem(item);
				}),
		);
		menu.addItem((i) =>
			i
				.setTitle("Remove")
				.setIcon("trash-2")
				.setWarning(true)
				.setSection("danger")
				.onClick(() => instance.removeItem(item)),
		);
		const file = (item.type === "file" || item.type === "folder") && item.path ? app.vault.getAbstractFileByPath(item.path) : null;
		if (file) app.workspace.trigger("file-menu", menu, file, "bookmarks", this.leaf);
		menu.showAtMouseEvent(evt);
	}
}

const groupKey = (item: BookmarkItem) => `${item.type}|${item.ctime ?? item.title ?? ""}`;

function newGroup(app: App, instance: BookmarksInstance, parent: BookmarkItem | null) {
	new PromptModal(app, "New bookmark group", "", (title) => instance.addItem(newBookmark("group", instance.ctime(), { items: [], title }), parent)).open();
}

function renameGroup(app: App, instance: BookmarksInstance, group: BookmarkItem) {
	new PromptModal(app, "Rename bookmark group", group.title ?? "", (title) => instance.updateItem(group, { title })).open();
}

// The Bookmark... action for a view: the dialog for its bookmark, Edit
// bookmark when it has one.
function bookmarkView(app: App, instance: BookmarksInstance, view: View | null | undefined) {
	const existing = instance.findBookmarkForView(view);
	if (existing) return instance.editItem(existing);
	const item = instance.itemForView(view);
	if (!item) {
		new Notice("This tab cannot be bookmarked.");
		return;
	}
	new BookmarkModal(app, instance, [item], false).open();
}

function bookmarkFiles(app: App, instance: BookmarksInstance, files: TAbstractFile[]) {
	const fresh = files.filter((f) => !instance.findBookmark(f.path));
	if (files.length === 1 && !fresh.length) return instance.editItem(instance.findBookmark(files[0].path)!);
	if (!fresh.length) return;
	const items = fresh.map((f) => newBookmark(f instanceof TFolder ? "folder" : "file", 0, { path: f.path }));
	new BookmarkModal(app, instance, items, false).open();
}

function bookmarkSection(app: App, instance: BookmarksInstance, file: TFile, subpath: string) {
	const existing = instance.findBookmark(file.path, subpath);
	if (existing) return instance.editItem(existing);
	new BookmarkModal(app, instance, [newBookmark("file", 0, { path: file.path, subpath })], false).open();
}

// Obsidian's Bookmarks core plugin: its view in the left sidebar, its
// commands with Obsidian's ids, and its file, editor and tab menu items.
export function installBookmarks(app: App, host: CorePluginHost) {
	const instance = app.internalPlugins.getPluginById("bookmarks")?.instance as BookmarksInstance;
	const { workspace, vault } = app;
	host.registerView("bookmarks", (leaf) => new BookmarksView(leaf, instance));
	void instance.load();
	host.register(() => instance.unload());
	host.registerEvent(vault.on("raw", (path: string) => path === instance.path && instance.onExternalChange()));
	host.registerEvent(
		vault.on("rename", (file: TAbstractFile, oldPath: string) => {
			if (renameInBookmarks(instance.items, oldPath, file.path)) instance.onItemsChanged(true);
		}),
	);
	host.registerEvent(
		vault.on("delete", (file: TAbstractFile) => {
			if (removeDeletedFromBookmarks(instance.items, file.path)) instance.onItemsChanged(true);
		}),
	);
	if (host.userEnabled) workspace.onLayoutReady(() => !workspace.getLeavesOfType("bookmarks").length && workspace.ensureSideLeaf("bookmarks", "left", { reveal: false }));

	// The active tab when it can be bookmarked (a search in the sidebar can),
	// else the last main-area tab.
	const mainView = () => {
		const active = workspace.activeLeaf?.view;
		return instance.itemForView(active) ? active : workspace.getMostRecentLeaf()?.view;
	};
	host.addCommand({
		id: "bookmarks:open",
		name: "Bookmarks: Show bookmarks",
		callback: () => workspace.ensureSideLeaf("bookmarks", "left", { reveal: true, active: true }),
	});
	host.addCommand({
		id: "bookmarks:bookmark-current-view",
		name: "Bookmarks: Bookmark...",
		checkCallback: (checking) => {
			const view = mainView();
			if (!instance.itemForView(view)) return false;
			if (!checking) bookmarkView(app, instance, view);
			return true;
		},
	});
	host.addCommand({
		id: "bookmarks:bookmark-current-search",
		name: "Bookmarks: Bookmark current search...",
		checkCallback: (checking) => {
			const query = app.internalPlugins.getPluginById("global-search")?.instance.getGlobalSearchQuery?.().trim();
			if (!query) return false;
			if (!checking) {
				const existing = flattenBookmarks(instance.items).find((i) => i.type === "search" && i.query === query);
				if (existing) instance.editItem(existing);
				else new BookmarkModal(app, instance, [newBookmark("search", 0, { query })], false).open();
			}
			return true;
		},
	});
	const editorCommand = (id: string, name: string, subpath: (editor: Editor, line: number) => string | null) =>
		host.addEditorCommand({
			id,
			name,
			editorCheckCallback: (checking: boolean, editor: unknown, view: unknown) => {
				if (!(view instanceof MarkdownView) || !view.file || view.getMode() === "preview") return false;
				const ed = view.editor;
				const line = ed.getCursor().line;
				if (checking) return id.endsWith("heading") ? !!headingAt(ed.getValue(), line) : !!ed.getLine(line).trim() && !headingLine(ed, line);
				const sub = subpath(ed, line);
				if (sub) bookmarkSection(app, instance, view.file, sub);
				return true;
			},
		});
	editorCommand("bookmarks:bookmark-current-heading", "Bookmarks: Bookmark heading under cursor...", (editor, line) => {
		const heading = headingAt(editor.getValue(), line);
		return heading ? `#${heading.heading}` : null;
	});
	editorCommand("bookmarks:bookmark-current-section", "Bookmarks: Bookmark block under cursor...", (editor, line) => blockSubpath(editor, line));
	host.addCommand({
		id: "bookmarks:bookmark-all-tabs",
		name: "Bookmarks: Bookmark all tabs...",
		checkCallback: (checking) => {
			// Each file once, however many tabs show it.
			const items: BookmarkItem[] = [];
			workspace.iterateRootLeaves((leaf) => {
				const item = instance.itemForView(leaf.view);
				if (item && !items.some((other) => item.type === "file" && other.path === item.path)) items.push(item);
			});
			if (!items.length) return false;
			if (!checking) {
				new PromptModal(app, "Bookmark all tabs in a new group", "", (title) => {
					const group = instance.addItem(newBookmark("group", instance.ctime(), { items: [], title }));
					for (const item of items) {
						item.ctime = instance.ctime();
						group.items!.push(item);
					}
					instance.onItemsChanged(true);
				}).open();
			}
			return true;
		},
	});
	host.addCommand({
		id: "bookmarks:unbookmark-current-view",
		name: "Bookmarks: Remove bookmark for the current tab",
		checkCallback: (checking) => {
			const existing = instance.findBookmarkForView(mainView());
			if (!existing) return false;
			if (!checking) instance.removeItem(existing);
			return true;
		},
	});

	host.registerEvent(
		workspace.on("file-menu", (menu: Menu, file: TAbstractFile, source: string) => {
			if (source === "bookmarks" || (file instanceof TFolder && file.isRoot())) return;
			const bookmarked = !!instance.findBookmark(file.path);
			menu.addItem((i) =>
				i
					.setTitle(bookmarked ? "Edit bookmark..." : "Bookmark...")
					.setIcon("bookmark")
					.setSection("action")
					.onClick(() => bookmarkFiles(app, instance, [file])),
			);
		}),
	);
	host.registerEvent(
		workspace.on("files-menu", (menu: Menu, files: TAbstractFile[]) => {
			menu.addItem((i) =>
				i
					.setTitle(`Bookmark ${files.length} items...`)
					.setIcon("bookmark")
					.setSection("action")
					.onClick(() => bookmarkFiles(app, instance, files)),
			);
		}),
	);
	host.registerEvent(
		workspace.on("editor-menu", (menu: Menu, editor: Editor, view: unknown) => {
			if (!(view instanceof MarkdownView) || !view.file) return;
			const line = editor.getCursor().line;
			if (!headingLine(editor, line)) return;
			const heading = headingAt(editor.getValue(), line);
			if (!heading) return;
			const file = view.file;
			menu.addItem((i) =>
				i
					.setTitle("Bookmark this heading...")
					.setIcon("bookmark")
					.setSection("action")
					.onClick(() => bookmarkSection(app, instance, file, `#${heading.heading}`)),
			);
		}),
	);
	// Graphs and searches are bookmarked from their tab's menu.
	host.registerEvent(
		workspace.on("leaf-menu", (menu: Menu, leaf: WorkspaceLeaf) => {
			if (leaf.view instanceof FileView) return;
			if (!instance.itemForView(leaf.view)) return;
			menu.addItem((i) =>
				i
					.setTitle("Bookmark...")
					.setIcon("bookmark")
					.setSection("action")
					.onClick(() => bookmarkView(app, instance, leaf.view)),
			);
		}),
	);
}

function headingLine(editor: Editor, line: number) {
	return /^ {0,3}#{1,6}(\s|$)/.test(editor.getLine(line));
}
