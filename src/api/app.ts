import { FileManager } from "./file-manager";
import { InternalPlugins } from "./internal-plugins";
import { Commands, HotkeyManager, Keymap, Scope } from "./keymap";
import { MetadataCache } from "./metadata";
import { Plugins } from "./plugins";
import { SettingModal } from "./setting-modal";
import { type TFile, Vault } from "./vault";
import { ViewRegistry } from "./view";
import { Workspace } from "./workspace";

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
