import * as nodePath from "node:path";
import { Commands, HotkeyManager, Keymap, Scope } from "./keymap";
import { MetadataCache } from "./metadata";
import type { SettingTab } from "./plugin";
import { Plugins } from "./plugins";
import { Modal } from "./ui/modal";
import { normalizePath, parseYaml, stringifyYaml } from "./util";
import { type TAbstractFile, TFile, TFolder, Vault } from "./vault";
import { ViewRegistry } from "./view";
import { Workspace } from "./workspace";

export class FileManager {
	app: App;

	constructor(app: App) {
		this.app = app;
	}

	getNewFileParent(_sourcePath: string, _newFilePath?: string): TFolder {
		const location = this.app.vault.getConfig("newFileLocation");
		const folder = this.app.vault.getConfig("newFileFolderPath");
		if (location === "folder" && folder) return this.app.vault.getFolderByPath(folder) ?? this.app.vault.getRoot();
		if (location === "current") {
			const active = this.app.workspace.getActiveFile();
			if (active?.parent) return active.parent;
		}
		return this.app.vault.getRoot();
	}

	async createNewMarkdownFile(folder: TFolder, name = "Untitled", content = "") {
		const base = folder.isRoot() ? "" : `${folder.path}/`;
		let path = `${base}${name}.md`;
		for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) path = `${base}${name} ${i}.md`;
		return this.app.vault.create(path, content);
	}

	async createNewMarkdownFileFromLinktext(linktext: string, sourcePath: string) {
		const parent = this.getNewFileParent(sourcePath);
		const dir = nodePath.posix.dirname(linktext);
		const folderPath = dir === "." ? parent.path : normalizePath(`${parent.isRoot() ? "" : parent.path}/${dir}`);
		const folder = this.app.vault.getFolderByPath(folderPath) ?? (await this.app.vault.createFolder(folderPath));
		return this.createNewMarkdownFile(folder, nodePath.posix.basename(linktext));
	}

	async renameFile(file: TAbstractFile, newPath: string) {
		await this.app.vault.rename(file, newPath);
	}

	async trashFile(file: TAbstractFile) {
		await this.app.vault.trash(file, this.app.vault.getConfig("trashOption") !== "local");
	}

	generateMarkdownLink(file: TFile, sourcePath: string, subpath = "", alias?: string) {
		const linktext = this.app.metadataCache.fileToLinktext(file, sourcePath, true) + subpath;
		if (this.app.vault.getConfig("useMarkdownLinks")) {
			return `[${alias ?? file.basename}](${encodeURI(linktext)}${file.extension === "md" && !linktext.endsWith(".md") ? ".md" : ""})`;
		}
		return alias ? `[[${linktext}|${alias}]]` : `[[${linktext}]]`;
	}

	async processFrontMatter(file: TFile, fn: (frontmatter: any) => void) {
		await this.app.vault.process(file, (text) => {
			const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
			const data = (m ? parseYaml(m[1]) : null) ?? {};
			fn(data);
			const yaml = Object.keys(data).length ? `---\n${stringifyYaml(data)}---\n` : "";
			return m ? yaml + text.slice(m[0].length) : yaml + text;
		});
	}

	async getAvailablePathForAttachment(filename: string, sourcePath?: string) {
		const configured: string = this.app.vault.getConfig("attachmentFolderPath") ?? "/";
		let dir = configured;
		if (configured.startsWith("./")) dir = nodePath.posix.join(nodePath.posix.dirname(sourcePath ?? ""), configured.slice(2));
		dir = normalizePath(dir);
		const ext = nodePath.posix.extname(filename);
		const stem = filename.slice(0, filename.length - ext.length);
		const prefix = dir === "/" ? "" : `${dir}/`;
		let path = `${prefix}${filename}`;
		for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) path = `${prefix}${stem} ${i}${ext}`;
		return path;
	}
}

class SettingModal extends Modal {
	pluginTabs: SettingTab[] = [];
	activeTab: SettingTab | null = null;
	#navEl: HTMLElement;
	#contentEl: HTMLElement;

	constructor(app: App) {
		super(app);
		this.modalEl.addClass("mod-settings");
		const container = this.contentEl.createDiv("vertical-tabs-container");
		this.#navEl = container.createDiv("vertical-tab-header");
		this.#contentEl = container.createDiv("vertical-tab-content-container");
	}

	addSettingTab(tab: SettingTab) {
		this.pluginTabs.push(tab);
		if (this.isOpen) this.#renderNav();
	}

	removeSettingTab(tab: SettingTab) {
		this.pluginTabs.remove(tab);
		if (this.activeTab === tab) this.activeTab = null;
		if (this.isOpen) this.#renderNav();
	}

	onOpen() {
		this.#renderNav();
		this.openTab(this.activeTab ?? this.pluginTabs[0] ?? null);
	}

	onClose() {
		this.activeTab?.hide();
	}

	#renderNav() {
		this.#navEl.empty();
		this.#navEl.createDiv({ cls: "vertical-tab-header-group-title", text: "Community plugins" });
		const items = this.#navEl.createDiv("vertical-tab-header-group-items");
		for (const tab of [...this.pluginTabs].sort((a, b) => a.name.localeCompare(b.name))) {
			const item = items.createDiv({ cls: "vertical-tab-nav-item", text: tab.name });
			item.toggleClass("is-active", tab === this.activeTab);
			item.addEventListener("click", () => this.openTab(tab));
		}
	}

	openTab(tab: SettingTab | null) {
		this.activeTab?.hide();
		this.#contentEl.empty();
		this.activeTab = tab;
		this.#renderNav();
		if (!tab) return;
		this.#contentEl.appendChild(tab.containerEl);
		tab.containerEl.empty();
		try {
			tab.display();
		} catch (err) {
			console.error(`Settings tab ${tab.id} failed`, err);
		}
	}

	openTabById(id: string) {
		const tab = this.pluginTabs.find((t) => t.id === id) ?? null;
		if (!this.isOpen) {
			this.activeTab = tab;
			this.open();
		} else this.openTab(tab);
		return tab;
	}
}

// Core plugins Obsidian ships. justnotes implements none of them yet, so each
// reports disabled; plugins that probe them (QuickAdd's templates and daily
// notes) take their fallback path.
class InternalPlugins {
	plugins: Record<string, { enabled: boolean; instance: any }> = {};

	getPluginById(_id: string) {
		return null;
	}

	getEnabledPluginById(_id: string) {
		return null;
	}
}

export class App {
	appId: string;
	vault: Vault;
	workspace: Workspace;
	metadataCache: MetadataCache;
	fileManager: FileManager;
	viewRegistry = new ViewRegistry();
	scope: Scope;
	keymap: Keymap;
	hotkeyManager: HotkeyManager;
	commands: Commands;
	plugins: Plugins;
	internalPlugins = new InternalPlugins();
	setting: SettingModal;
	statusBar: HTMLElement;
	protocolHandlers: Record<string, (params: any) => any> = {};
	isMobile = false;
	lastEvent: UIEvent | null = null;
	dom: { appContainerEl: HTMLElement; workspaceEl: HTMLElement; statusBarEl: HTMLElement };

	constructor(basePath: string) {
		this.appId = vaultId(basePath);
		this.vault = new Vault(basePath);
		this.scope = new Scope();
		this.keymap = new Keymap(this.scope);
		this.hotkeyManager = new HotkeyManager(this);
		this.commands = new Commands(this);
		this.scope.register(null, null, (evt, ctx) => this.hotkeyManager.onTrigger(evt, ctx));
		this.metadataCache = new MetadataCache(this.vault);
		this.workspace = new Workspace(this);
		this.fileManager = new FileManager(this);
		this.plugins = new Plugins(this);
		this.setting = new SettingModal(this);
		this.statusBar = createDiv("status-bar");
		const appContainerEl = createDiv("app-container");
		this.dom = { appContainerEl, workspaceEl: this.workspace.containerEl, statusBarEl: this.statusBar };
		for (const type of ["mousedown", "keydown"]) window.addEventListener(type, (e) => (this.lastEvent = e as UIEvent), true);
	}

	loadLocalStorage(key: string) {
		try {
			const raw = localStorage.getItem(`${this.appId}-${key}`);
			return raw === null ? null : JSON.parse(raw);
		} catch {
			return null;
		}
	}

	saveLocalStorage(key: string, data: unknown) {
		if (data === undefined || data === null) localStorage.removeItem(`${this.appId}-${key}`);
		else localStorage.setItem(`${this.appId}-${key}`, JSON.stringify(data));
	}

	// justnotes keeps its own layout instead of Obsidian's workspace.json, so
	// running both on one vault never fights over that file.
	saveLayoutState() {
		this.saveLocalStorage("justnotes-layout", this.workspace.getLayout());
	}

	async restoreLayoutState(layout = this.loadLocalStorage("justnotes-layout")) {
		const files: string[] = (layout?.main ?? [])
			.map((s: any) => s?.state?.file)
			.filter((p: unknown): p is string => typeof p === "string" && this.vault.getFileByPath(p) !== null);
		if (layout?.left?.collapsed) this.workspace.leftSplit.collapse();
		if (layout?.right?.collapsed !== false) this.workspace.rightSplit.collapse();
		for (const [i, path] of files.entries()) {
			const leaf = i === 0 ? this.workspace.getLeaf(false) : this.workspace.getLeaf("tab");
			await leaf.openFile(this.vault.getFileByPath(path) as TFile, { active: i === files.length - 1 });
		}
	}
}

// A short stable id for per-vault localStorage keys.
function vaultId(text: string) {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	return (h >>> 0).toString(16);
}
