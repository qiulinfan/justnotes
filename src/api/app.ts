import { getElectron } from "./dom";
import { FileManager } from "./file-manager";
import { InternalPlugins } from "./internal-plugins";
import { Commands, HotkeyManager, Keymap, Scope } from "./keymap";
import { MetadataCache } from "./metadata";
import type { CliFlags, CliHandler } from "./plugin";
import { Plugins } from "./plugins";
import { type SecretBackend, SecretStorage } from "./secret-storage";
import { SettingModal } from "./setting-modal";
import { normalizePath } from "./util";
import { type TFile, Vault } from "./vault";
import { ViewRegistry } from "./view";
import { Workspace } from "./workspace";

// Secrets live with the main process (main/ipc.ts), per vault.
function ipcSecretBackend(vaultId: string): SecretBackend {
	const { ipcRenderer } = getElectron();
	return {
		load: () => ipcRenderer.sendSync("justnotes:secrets-load", vaultId),
		set: (id, secret) => {
			const error: string | null = ipcRenderer.sendSync("justnotes:secret-set", vaultId, id, secret);
			if (error) throw new Error(error);
		},
	};
}

// An app-level hover parent, for markdown rendered or hover links triggered
// outside any view.
export class RenderContext {
	hoverPopover: any = null;
}

interface AppDom {
	appContainerEl: HTMLElement;
	readonly horizontalMainContainerEl: HTMLElement;
	workspaceEl: HTMLElement;
	statusBarEl: HTMLElement;
}

// User interaction events App.lastEvent tracks, so commands can read the
// modifier keys that triggered them.
const USER_EVENTS = ["keydown", "mousedown", "pointerdown", "click", "auxclick", "contextmenu", "touchstart"];

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
	internalPlugins: InternalPlugins;
	setting: SettingModal;
	statusBar: HTMLElement;
	protocolHandlers: Record<string, (params: any) => any> = {};
	// Handlers plugins register with registerCliHandler, by command id. There
	// is no command-line transport yet.
	cliHandlers = new Map<string, { description: string; flags: CliFlags | null; handler: CliHandler; pluginId: string }>();
	renderContext = new RenderContext();
	secretStorage: SecretStorage;
	isMobile = false;
	lastEvent: UIEvent | null = null;
	dom: AppDom;

	constructor(basePath: string) {
		// Before the keymap's listener, so a command run by a hotkey sees its own
		// keydown as lastEvent.
		for (const type of USER_EVENTS) window.addEventListener(type, (e) => (this.lastEvent = e as UIEvent), true);
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
		this.internalPlugins = new InternalPlugins(this);
		this.setting = new SettingModal(this);
		this.secretStorage = new SecretStorage(ipcSecretBackend(this.appId));
		this.statusBar = createDiv("status-bar");
		this.dom = {
			appContainerEl: createDiv("app-container"),
			get horizontalMainContainerEl() {
				return this.appContainerEl.querySelector<HTMLElement>(":scope > .horizontal-main-container")!;
			},
			workspaceEl: this.workspace.containerEl,
			statusBarEl: this.statusBar,
		};
	}

	// The theme classes on body are written only by the theme code at boot, so
	// this and the css-change event agree.
	isDarkMode() {
		return document.body.hasClass("theme-dark");
	}

	openWithDefaultApp(path: string) {
		void getElectron().shell.openPath(this.vault.adapter.getFullPath(normalizePath(path)));
	}

	showInFolder(path: string) {
		getElectron().shell.showItemInFolder(this.vault.adapter.getFullPath(normalizePath(path)));
	}

	// Overrides the theme's accent with a #rrggbb color, or restores it.
	setAccentColor(color?: string | null) {
		const hsl = color ? hexToHsl(color) : null;
		const style = document.body.style;
		for (const [i, name] of ["--accent-h", "--accent-s", "--accent-l"].entries()) {
			if (hsl) style.setProperty(name, i === 0 ? String(hsl[0]) : `${hsl[i]}%`);
			else style.removeProperty(name);
		}
		this.workspace.trigger("css-change");
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

function hexToHsl(hex: string): [number, number, number] | null {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return null;
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return [0, 0, Math.round(l * 100)];
	const s = d / (1 - Math.abs(2 * l - 1));
	const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [Math.round((h * 60 + 360) % 360), Math.round(s * 100), Math.round(l * 100)];
}

// A short stable id for per-vault localStorage keys.
function vaultId(text: string) {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	return (h >>> 0).toString(16);
}
