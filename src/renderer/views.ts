import type { App } from "../api/app";
import { setIcon } from "../api/icons";
import { Menu } from "../api/ui/menu";
import { Modal } from "../api/ui/modal";
import { FuzzySuggestModal } from "../api/ui/suggest";
import { debounce } from "../api/util";
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
		this.registerEvent(this.app.workspace.on("file-open", () => this.#markActive()));
		// The explorer's file actions also appear in a note's tab and More options menus.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile, source: string) => {
				if (source === "more-options" || source === "tab-header") this.#addFileItems(menu, file);
			}),
		);
		this.#expanded = new Set(this.app.loadLocalStorage("justnotes-expanded") ?? []);
		this.#render();
	}

	#render() {
		const scroll = this.#treeEl.scrollTop;
		this.#treeEl.empty();
		this.#renderFolder(this.app.vault.getRoot(), this.#treeEl);
		this.#treeEl.scrollTop = scroll;
		this.#markActive();
	}

	#renderFolder(folder: TFolder, el: HTMLElement) {
		const sorted = [...folder.children].sort((a, b) => {
			if (a instanceof TFolder !== b instanceof TFolder) return a instanceof TFolder ? -1 : 1;
			return a.name.localeCompare(b.name, undefined, { numeric: true });
		});
		for (const child of sorted) {
			if (child instanceof TFolder) {
				const item = el.createDiv("tree-item nav-folder");
				const self = item.createDiv({ cls: "tree-item-self nav-folder-title is-clickable", attr: { "data-path": child.path } });
				const icon = self.createDiv("tree-item-icon collapse-icon");
				self.createDiv({ cls: "tree-item-inner nav-folder-title-content", text: child.name });
				const collapsed = !this.#expanded.has(child.path);
				setIcon(icon, collapsed ? "chevron-right" : "chevron-down");
				const children = item.createDiv("tree-item-children nav-folder-children");
				if (!collapsed) this.#renderFolder(child, children);
				self.addEventListener("click", () => {
					if (this.#expanded.has(child.path)) this.#expanded.delete(child.path);
					else this.#expanded.add(child.path);
					this.app.saveLocalStorage("justnotes-expanded", [...this.#expanded]);
					this.#render();
				});
				self.addEventListener("contextmenu", (evt) => this.#showMenu(evt, child));
			} else if (child instanceof TFile) {
				const item = el.createDiv("tree-item nav-file");
				const self = item.createDiv({ cls: "tree-item-self nav-file-title is-clickable", attr: { "data-path": child.path } });
				self.createDiv({ cls: "tree-item-inner nav-file-title-content", text: child.extension === "md" ? child.basename : child.name });
				if (child.extension !== "md") self.createDiv({ cls: "nav-file-tag", text: child.extension });
				self.addEventListener("click", (evt) => this.app.workspace.getLeaf(evt.metaKey || evt.ctrlKey ? "tab" : false).openFile(child));
				self.addEventListener("contextmenu", (evt) => this.#showMenu(evt, child));
			}
		}
	}

	#markActive() {
		const active = this.app.workspace.getActiveFile()?.path;
		for (const el of this.#treeEl.findAll(".nav-file-title")) el.toggleClass("is-active", el.getAttr("data-path") === active);
	}

	#showMenu(evt: MouseEvent, file: TAbstractFile) {
		evt.preventDefault();
		evt.stopPropagation();
		const menu = new Menu();
		if (file instanceof TFolder) {
			menu.addItem((i) => i.setTitle("New note").setIcon("square-pen").setSection("action-primary").onClick(() => newNote(this.app, file)));
			menu.addItem((i) => i.setTitle("New folder").setIcon("folder-plus").setSection("action-primary").onClick(() => newFolder(this.app, file)));
		} else if (file instanceof TFile) {
			menu.addItem((i) =>
				i
					.setTitle("Open in new tab")
					.setIcon("file-plus")
					.setSection("open")
					.onClick(() => this.app.workspace.getLeaf("tab").openFile(file)),
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
				.setTitle("Delete")
				.setIcon("trash-2")
				.setWarning(true)
				.setSection("danger")
				.onClick(() => this.app.fileManager.trashFile(file)),
		);
	}
}

async function newNote(app: App, folder: TFolder) {
	const file = await app.fileManager.createNewMarkdownFile(folder);
	await app.workspace.getLeaf(false).openFile(file);
}

function newFolder(app: App, parent: TFolder) {
	new PromptModal(app, "New folder", "Untitled", async (name) => {
		await app.vault.createFolder(parent.isRoot() ? name : `${parent.path}/${name}`);
	}).open();
}

function renameFile(app: App, file: TAbstractFile) {
	const isMd = file instanceof TFile && file.extension === "md";
	const current = isMd ? (file as TFile).basename : file.name;
	new PromptModal(app, "Rename", current, async (name) => {
		const dir = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
		await app.fileManager.renameFile(file, `${dir}${name}${isMd ? ".md" : ""}`);
	}).open();
}

class PromptModal extends Modal {
	constructor(app: App, title: string, value: string, onSubmit: (value: string) => any) {
		super(app);
		this.setTitle(title);
		const input = this.contentEl.createEl("input", { type: "text", value, cls: "prompt-modal-input" });
		const submit = () => {
			const v = input.value.trim();
			this.close();
			if (v && v !== value) onSubmit(v);
		};
		this.scope.register([], "Enter", () => {
			submit();
			return false;
		});
		this.onOpen = () => {
			input.focus();
			input.select();
		};
	}
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
		return this.app.vault.getFiles().sort((a, b) => {
			const ra = recent.indexOf(a.path);
			const rb = recent.indexOf(b.path);
			if (ra !== rb) return (ra < 0 ? 1e9 : ra) - (rb < 0 ? 1e9 : rb);
			return b.stat.mtime - a.stat.mtime;
		});
	}

	getItemText(file: TFile) {
		return file.extension === "md" ? file.path.slice(0, -3) : file.path;
	}

	onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent) {
		this.app.workspace.getLeaf(evt.metaKey || evt.ctrlKey ? "tab" : false).openFile(file);
	}
}
