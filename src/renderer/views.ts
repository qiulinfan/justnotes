import type { App } from "../api/app";
import { setIcon } from "../api/icons";
import { Keymap } from "../api/keymap";
import { attempt, MoveModal, PromptModal } from "../api/ui/file-modals";
import { Menu } from "../api/ui/menu";
import { fileDisplayName, isNoteExtension } from "../api/note-files";
import { type FuzzyMatch, FuzzySuggestModal } from "../api/ui/suggest";
import { excludedLast, isFileShown } from "../api/file-visibility";
import { debounce, prepareFuzzySearch } from "../api/util";
import { type TAbstractFile, TFile, TFolder } from "../api/vault";
import { ItemView } from "../api/view";
import type { WorkspaceLeaf } from "../api/workspace";

export class EmptyView extends ItemView {
	// A "New tab" is replaced by the next file opened in it.
	navigation = true;

	getViewType() {
		return "empty";
	}

	getDisplayText() {
		return "New tab";
	}

	getIcon() {
		return "file";
	}

	async onOpen() {
		this.headerEl.hide();
		const empty = this.contentEl.createDiv("empty-state");
		empty.createDiv({ cls: "empty-state-title", text: "No file is open" });
		const actions = empty.createDiv("empty-state-action-list");
		const action = (text: string, cmd: string) =>
			actions.createDiv({ cls: "empty-state-action", text }).addEventListener("click", () => this.app.commands.executeCommandById(cmd));
		action("Open a file (⌘ O)", "switcher:open");
		action("Run a command (⌘ P)", "command-palette:open");
	}
}

export class FileExplorerView extends ItemView {
	#treeEl!: HTMLElement;
	#expanded = new Set<string>();
	// Items picked with Alt-click and Shift-click, for one menu on all of them;
	// a Shift range starts at the anchor, the item clicked before.
	#selected = new Set<TAbstractFile>();
	#anchor: TAbstractFile | null = null;
	#refresh = debounce(() => this.#render(), 100, true);

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "folder-closed";
		this.navigation = false;
	}

	getViewType() {
		return "file-explorer";
	}

	getDisplayText() {
		return "Files";
	}

	async onOpen() {
		this.headerEl.hide();
		const nav = this.contentEl.createDiv("nav-header");
		const buttons = nav.createDiv("nav-buttons-container");
		const button = (icon: string, title: string, cb: () => any) => {
			const el = buttons.createDiv({ cls: "clickable-icon nav-action-button", attr: { "aria-label": title } });
			setIcon(el, icon);
			el.addEventListener("click", cb);
		};
		button("square-pen", "New note", () => newNote(this.app, this.app.vault.getRoot()));
		button("folder-plus", "New folder", () => newFolder(this.app, this.app.vault.getRoot()));
		this.#treeEl = this.contentEl.createDiv("nav-files-container");
		this.#treeEl.addEventListener("contextmenu", (evt) => {
			if (evt.target === this.#treeEl) this.#showMenu(evt, this.app.vault.getRoot());
		});
		for (const name of ["create", "delete", "rename"]) this.registerEvent(this.app.vault.on(name, () => this.#refresh()));
		// "Detect all file extensions" shows or hides files at once.
		let showAll = this.app.vault.getConfig("showUnsupportedFiles");
		this.registerEvent(
			this.app.vault.on("config-changed", () => {
				if (this.app.vault.getConfig("showUnsupportedFiles") === showAll) return;
				showAll = this.app.vault.getConfig("showUnsupportedFiles");
				this.#refresh();
			}),
		);
		this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => this.#retargetExpanded(oldPath, file.path)));
		this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => this.#retargetExpanded(file.path, null)));
		this.registerEvent(this.app.workspace.on("file-open", () => this.#markActive()));
		// The explorer's file actions also appear in a note's tab and More options
		// menus and in file menus plugins open (obsidian-git's source control view),
		// as Obsidian's do; its own menu adds them itself, link menus go without.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile, source: string) => {
				if (source !== "file-explorer-context-menu" && source !== "link-context-menu") this.#addFileItems(menu, file);
			}),
		);
		this.#expanded = new Set(this.app.loadLocalStorage("justnotes-expanded") ?? []);
		this.#render();
	}

	// Shows `file` in the tree: the folders above it open (and stay open), and
	// its row is marked and scrolled into view.
	revealInFolder(file: TAbstractFile) {
		for (let folder = file.parent; folder && !folder.isRoot(); folder = folder.parent) this.#expanded.add(folder.path);
		this.app.saveLocalStorage("justnotes-expanded", [...this.#expanded]);
		this.#render();
		const row = this.#treeEl.find(`.tree-item-self[data-path="${CSS.escape(file.path)}"]`);
		if (!row) return;
		for (const el of this.#treeEl.findAll(".tree-item-self.is-active")) el.removeClass("is-active");
		row.addClass("is-active");
		row.scrollIntoView({ block: "nearest" });
	}

	#retargetExpanded(oldPath: string, newPath: string | null) {
		const next = retargetFolders(this.#expanded, oldPath, newPath);
		if (next.size === this.#expanded.size && [...next].every((p) => this.#expanded.has(p))) return;
		this.#expanded = next;
		this.app.saveLocalStorage("justnotes-expanded", [...next]);
	}

	#render() {
		const scroll = this.#treeEl.scrollTop;
		this.#treeEl.empty();
		this.#renderFolder(this.app.vault.getRoot(), this.#treeEl);
		this.#treeEl.scrollTop = scroll;
		this.#markActive();
		this.#markSelected();
	}

	#renderFolder(folder: TFolder, el: HTMLElement) {
		const sorted = folder.children.filter((c) => !(c instanceof TFile) || isFileShown(this.app, c)).sort((a, b) => {
			if (a instanceof TFolder !== b instanceof TFolder) return a instanceof TFolder ? -1 : 1;
			return a.name.localeCompare(b.name, undefined, { numeric: true });
		});
		for (const child of sorted) {
			if (child instanceof TFolder) {
				// Obsidian's classes: `is-collapsed` on the item and its icon (a
				// down arrow the stylesheet turns aside), which themes style.
				const collapsed = !this.#expanded.has(child.path);
				const item = el.createDiv({ cls: ["tree-item", "nav-folder", ...(collapsed ? ["is-collapsed"] : [])] });
				const self = item.createDiv({ cls: "tree-item-self nav-folder-title is-clickable mod-collapsible", attr: { "data-path": child.path } });
				const icon = self.createDiv({ cls: ["tree-item-icon", "collapse-icon", ...(collapsed ? ["is-collapsed"] : [])] });
				self.createDiv({ cls: "tree-item-inner nav-folder-title-content", text: child.name });
				setIcon(icon, "right-triangle");
				const children = item.createDiv("tree-item-children nav-folder-children");
				if (!collapsed) this.#renderFolder(child, children);
				self.addEventListener("click", (evt) => {
					if (this.#select(evt, child)) return;
					if (this.#expanded.has(child.path)) this.#expanded.delete(child.path);
					else this.#expanded.add(child.path);
					this.app.saveLocalStorage("justnotes-expanded", [...this.#expanded]);
					this.#render();
				});
				self.addEventListener("contextmenu", (evt) => this.#showMenu(evt, child));
				this.#makeDraggable(self, child);
			} else if (child instanceof TFile) {
				const item = el.createDiv("tree-item nav-file");
				const self = item.createDiv({ cls: "tree-item-self nav-file-title is-clickable", attr: { "data-path": child.path } });
				self.createDiv({ cls: "tree-item-inner nav-file-title-content", text: fileDisplayName(child) });
				// TeX and text notes show their whole name, so they need no badge.
				if (!isNoteExtension(child.extension)) self.createDiv({ cls: "nav-file-tag", text: child.extension });
				self.addEventListener("click", (evt) => {
					if (!this.#select(evt, child)) this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(child);
				});
				// A middle click opens a new tab, as Mod-click does.
				self.addEventListener("auxclick", (evt) => {
					if (evt.button === 1) this.app.workspace.getLeaf("tab").openFile(child);
				});
				self.addEventListener("contextmenu", (evt) => this.#showMenu(evt, child));
				this.#makeDraggable(self, child);
			}
		}
	}

	// Items drag through app.dragManager, as Obsidian's explorer does: into a
	// note as links, or into a plugin view that reads the drag (terminal types
	// the paths). Dragging a selected item takes the whole selection.
	#makeDraggable(el: HTMLElement, file: TAbstractFile) {
		el.draggable = true;
		el.addEventListener("dragstart", (evt) => {
			const drag = this.app.dragManager;
			const data =
				this.#selected.size > 1 && this.#selected.has(file)
					? drag.dragFiles(evt, [...this.#selected], "file-explorer")
					: file instanceof TFile
						? drag.dragFile(evt, file, "file-explorer")
						: drag.dragFolder(evt, file as TFolder, "file-explorer");
			drag.onDragStart(evt, data);
		});
	}

	#markActive() {
		const active = this.app.workspace.getActiveFile()?.path;
		for (const el of this.#treeEl.findAll(".nav-file-title")) el.toggleClass("is-active", el.getAttr("data-path") === active);
	}

	// Alt-click adds the item to the selection or takes it out; Shift-click
	// selects the rows from the anchor (else the open file) to it. True when
	// the click selected; a plain click ends the selection and anchors there,
	// and so does a Mod-click, which opens a new tab, split or window.
	#select(evt: MouseEvent, item: TAbstractFile) {
		const mod = Keymap.isModifier(evt, "Mod");
		const anchor = this.#anchor ?? this.app.workspace.getActiveFile();
		const range = !mod && evt.shiftKey && anchor ? this.#rowsBetween(anchor, item) : null;
		const toggle = !mod && !range && Keymap.isModifier(evt, "Alt");
		if (range) this.#selected = new Set(range);
		else {
			if (!toggle) this.#selected.clear();
			else if (!this.#selected.delete(item)) this.#selected.add(item);
			this.#anchor = item;
		}
		this.#markSelected();
		return !!range || toggle;
	}

	// The items of the shown rows from `a` to `b`, in either order.
	#rowsBetween(a: TAbstractFile, b: TAbstractFile) {
		const paths = this.#treeEl.findAll(".tree-item-self").map((el) => el.getAttr("data-path") ?? "");
		const i = paths.indexOf(a.path);
		const j = paths.indexOf(b.path);
		if (i < 0 || j < 0) return null;
		return paths.slice(Math.min(i, j), Math.max(i, j) + 1).flatMap((p) => this.app.vault.getAbstractFileByPath(p) ?? []);
	}

	// Items deleted or gone from the vault leave the selection.
	#markSelected() {
		for (const item of this.#selected) if (this.app.vault.getAbstractFileByPath(item.path) !== item) this.#selected.delete(item);
		const paths = new Set([...this.#selected].map((f) => f.path));
		for (const el of this.#treeEl.findAll(".tree-item-self")) el.toggleClass("is-selected", paths.has(el.getAttr("data-path") ?? ""));
	}

	#showMenu(evt: MouseEvent, file: TAbstractFile) {
		evt.preventDefault();
		evt.stopPropagation();
		const menu = new Menu();
		menu.addSections(["title", "action-primary", "open", "action", "info", "view", "system", "danger"]);
		// On one of several selected items the menu is for all of them.
		if (this.#selected.size > 1 && this.#selected.has(file)) {
			const files = [...this.#selected];
			menu.addItem((i) =>
				i
					.setTitle(`Move ${files.length} items to...`)
					.setIcon("folder-input")
					.setSection("action")
					.onClick(() => new MoveModal(this.app, files).open()),
			);
			this.app.workspace.trigger("files-menu", menu, files, "file-explorer-context-menu", this.leaf);
			menu.showAtMouseEvent(evt);
			return;
		}
		this.#selected.clear();
		this.#markSelected();
		if (file instanceof TFolder) {
			menu.addItem((i) => i.setTitle("New note").setIcon("square-pen").setSection("action-primary").onClick(() => newNote(this.app, file)));
			menu.addItem((i) => i.setTitle("New TeX file").setIcon("sigma").setSection("action-primary").onClick(() => newNote(this.app, file, "tex")));
			menu.addItem((i) => i.setTitle("New text file").setIcon("file-text").setSection("action-primary").onClick(() => newNote(this.app, file, "txt")));
			menu.addItem((i) => i.setTitle("New folder").setIcon("folder-plus").setSection("action-primary").onClick(() => newFolder(this.app, file)));
		} else if (file instanceof TFile) {
			menu.addItem((i) =>
				i
					.setTitle("Open in new tab")
					.setIcon("file-plus")
					.setSection("open")
					.onClick(() => this.app.workspace.getLeaf("tab").openFile(file)),
			);
			menu.addItem((i) =>
				i
					.setTitle("Open to the right")
					.setIcon("separator-vertical")
					.setSection("open")
					.onClick(() => this.app.workspace.getLeaf("split").openFile(file)),
			);
			menu.addItem((i) =>
				i
					.setTitle("Open in new window")
					.setIcon("picture-in-picture-2")
					.setSection("open")
					.onClick(() => this.app.workspace.getLeaf("window").openFile(file)),
			);
		}
		this.#addFileItems(menu, file);
		this.app.workspace.trigger("file-menu", menu, file, "file-explorer-context-menu", this.leaf);
		menu.showAtMouseEvent(evt);
	}

	#addFileItems(menu: Menu, file: TAbstractFile) {
		if (file instanceof TFolder && file.isRoot()) return;
		menu.addItem((i) => i.setTitle("Rename...").setIcon("pencil").setSection("action").onClick(() => renameFile(this.app, file)));
		menu.addItem((i) =>
			i
				.setTitle(file instanceof TFolder ? "Move folder to..." : "Move file to...")
				.setIcon("folder-input")
				.setSection("action")
				.onClick(() => new MoveModal(this.app, [file]).open()),
		);
		if (file instanceof TFile) menu.addItem((i) => i.setTitle("Open in default app").setIcon("arrow-up-right").setSection("system").onClick(() => this.app.openWithDefaultApp(file.path)));
		menu.addItem((i) => i.setTitle("Show in system explorer").setIcon("arrow-up-right").setSection("system").onClick(() => this.app.showInFolder(file.path)));
		menu.addItem((i) =>
			i
				.setTitle("Delete")
				.setIcon("trash-2")
				.setWarning(true)
				.setSection("danger")
				.onClick(() => attempt(() => this.app.fileManager.promptForDeletion(file))),
		);
	}
}

// The explorer's open folders after a folder at `oldPath` moved to `newPath`
// (or was deleted, null): it and the folders inside it stay open where they
// went, or are forgotten.
export function retargetFolders(expanded: Iterable<string>, oldPath: string, newPath: string | null) {
	const next = new Set<string>();
	for (const path of expanded) {
		const inside = path === oldPath || path.startsWith(`${oldPath}/`);
		if (!inside) next.add(path);
		else if (newPath !== null) next.add(newPath + path.slice(oldPath.length));
	}
	return next;
}

// A file operation that fails (a name taken, a file in use) says why.
async function newNote(app: App, folder: TFolder, extension = "md") {
	const file = await app.fileManager.createNewNoteFile(folder, extension);
	await app.workspace.getLeaf(false).openFile(file);
}

function newFolder(app: App, parent: TFolder) {
	new PromptModal(app, "New folder", "Untitled", (name) => attempt(() => app.vault.createFolder(parent.isRoot() ? name : `${parent.path}/${name}`))).open();
}

function renameFile(app: App, file: TAbstractFile) {
	const isMd = file instanceof TFile && file.extension === "md";
	const current = isMd ? (file as TFile).basename : file.name;
	new PromptModal(app, "Rename", current, (name) => {
		const dir = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
		return attempt(() => app.fileManager.renameFile(file, `${dir}${name}${isMd ? ".md" : ""}`));
	}).open();
}

export class CommandPalette extends FuzzySuggestModal<any> {
	constructor(app: App) {
		super(app);
		this.setPlaceholder("Select a command...");
	}

	getItems() {
		return this.app.commands
			.listCommands()
			.filter((c) => this.app.commands.isAvailable(c))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	getItemText(cmd: any) {
		return cmd.name;
	}

	renderSuggestion(item: any, el: HTMLElement) {
		el.addClass("mod-complex");
		super.renderSuggestion(item, el.createDiv("suggestion-content"));
		const hotkey = this.app.hotkeyManager.printHotkeyForCommand(item.item.id);
		if (hotkey) el.createDiv("suggestion-aux").createEl("kbd", { cls: "suggestion-hotkey", text: hotkey });
	}

	onChooseItem(cmd: any) {
		this.app.commands.executeCommand(cmd);
	}
}

export class QuickSwitcher extends FuzzySuggestModal<TFile> {
	constructor(app: App) {
		super(app);
		this.setPlaceholder("Find or create a note...");
	}

	getItems() {
		const recent = this.app.workspace.getLastOpenFiles();
		const files = this.app.vault
			.getFiles()
			.filter((file) => isFileShown(this.app, file))
			.sort((a, b) => {
				const ra = recent.indexOf(a.path);
				const rb = recent.indexOf(b.path);
				if (ra !== rb) return (ra < 0 ? 1e9 : ra) - (rb < 0 ? 1e9 : rb);
				return b.stat.mtime - a.stat.mtime;
			});
		// Excluded files are less noticeable: after the others.
		return excludedLast(this.app, files, (file) => file.path);
	}

	getItemText(file: TFile) {
		return file.extension === "md" ? file.path.slice(0, -3) : file.path;
	}

	// Files whose name holds the query (spaces aside) rank above the rest,
	// which match by their whole path as before: "resnet" finds 00-resnet before
	// a long path that happens to hold its letters, while a folder's name still
	// finds the files in it rather than names with its letters scattered. Among
	// the names an exact one leads, and names that score alike (every name that
	// starts with the query does) rank by their whole path as before, so the
	// vault's README comes before the nested ones. The highlights stay on the
	// whole path.
	getSuggestions(query: string) {
		const search = prepareFuzzySearch(query.trim());
		const typed = query.toLowerCase().replace(/\s+/g, "");
		const byName: (FuzzyMatch<TFile> & { exact: boolean; path: number })[] = [];
		const byPath: FuzzyMatch<TFile>[] = [];
		for (const file of this.getItems()) {
			const text = this.getItemText(file);
			// The name ends the path, so a file whose name matches matches here too.
			const match = search(text);
			if (!match) continue;
			const name = file.extension === "md" ? file.basename : file.name;
			const flat = name.toLowerCase().replace(/\s+/g, "");
			const inName = flat.includes(typed) ? search(name) : null;
			if (inName) {
				const start = text.length - name.length;
				const matches = inName.matches.map(([from, to]): [number, number] => [from + start, to + start]);
				byName.push({ item: file, match: { score: inName.score, matches }, exact: flat === typed, path: match.score });
			} else byPath.push({ item: file, match });
		}
		if (typed) {
			byName.sort((a, b) => Number(b.exact) - Number(a.exact) || b.match.score - a.match.score || b.path - a.path);
			byPath.sort((a, b) => b.match.score - a.match.score);
		}
		return excludedLast(this.app, [...byName, ...byPath], (m) => m.item.path);
	}

	onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent) {
		this.app.workspace.getLeaf(evt.metaKey || evt.ctrlKey ? "tab" : false).openFile(file);
	}
}
