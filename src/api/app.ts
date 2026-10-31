import * as nodePath from "node:path";
import { getElectron } from "./dom";
import { FileManager } from "./file-manager";
import { InternalPlugins } from "./internal-plugins";
import { Commands, HotkeyManager, Keymap, Scope } from "./keymap";
import { MetadataCache } from "./metadata";
import type { CliFlags, CliHandler } from "./plugin";
import { Plugins } from "./plugins";
import { type SecretBackend, SecretStorage } from "./secret-storage";
import { SettingModal } from "./setting-modal";
import { Notice } from "./ui/notice";
import { normalizePath } from "./util";
import { type TFile, Vault } from "./vault";
import { ViewRegistry } from "./view";
import { type PaneType, Workspace } from "./workspace";

export interface ObsidianProtocolData {
	action: string;
	[key: string]: string;
}

function decodeUriPart(text: string) {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

// Parses an obsidian:// URL into Obsidian's handler argument: the action plus
// URI-decoded query parameters, where a key without a value is "true" ("+"
// stays a plus, as encodeURIComponent writes it). The shorthands
// obsidian://vault/<vault>/<file> and obsidian:///<absolute path> become open
// actions. Returns null for other URLs.
export function parseObsidianUrl(url: string): ObsidianProtocolData | null {
	const m = /^obsidian:\/\/([^?#]*)(?:\?([^#]*))?/i.exec(url);
	if (!m) return null;
	const params: Record<string, string> = {};
	for (const part of (m[2] ?? "").split("&")) {
		if (!part) continue;
		const eq = part.indexOf("=");
		const value = eq < 0 ? "" : decodeUriPart(part.slice(eq + 1));
		params[decodeUriPart(eq < 0 ? part : part.slice(0, eq))] = value === "" ? "true" : value;
	}
	const target = m[1];
	if (target.startsWith("/")) return { ...params, action: "open", path: decodeUriPart(target) };
	const [action, ...rest] = target.split("/");
	if (action === "vault" && rest[0]) {
		const file = decodeUriPart(rest.slice(1).join("/"));
		return { ...params, action: "open", vault: decodeUriPart(rest[0]), ...(file ? { file } : {}) };
	}
	return { ...params, action: decodeUriPart(action) };
}

function splitSubpath(linktext: string): [string, string] {
	const i = linktext.indexOf("#");
	return i < 0 ? [linktext, ""] : [linktext.slice(0, i), linktext.slice(i)];
}

function paneTypeOf(value: string | undefined): PaneType | false {
	return value === "tab" || value === "split" || value === "window" ? value : false;
}

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
		const electron = getElectron();
		const takeUrl = (url: string) => this.workspace.onLayoutReady(() => this.handleObsidianUrl(url));
		electron.ipcRenderer.on("justnotes:obsidian-url", (_evt: unknown, url: string) => takeUrl(url));
		// Then collect the URLs that arrived before this page listened (launch
		// arguments, macOS open-url during startup).
		void electron.ipcRenderer.invoke("justnotes:obsidian-urls").then((urls: string[]) => urls.forEach(takeUrl));
		// Host code and plugins open links with shell.openExternal, which runs in
		// this process and would hand obsidian:// URLs to the OS, so to Obsidian.
		const shell = electron.shell;
		const openExternal = shell.openExternal;
		shell.openExternal = (url: string, options?: unknown) =>
			parseObsidianUrl(url) ? this.handleObsidianUrl(url).then(() => undefined) : openExternal.call(shell, url, options);
	}

	// Dispatches an obsidian:// URL inside this window: a plugin's protocol
	// handler, or the built-in open, new and search actions for this vault.
	// Returns whether the URL was handled.
	async handleObsidianUrl(url: string) {
		const params = parseObsidianUrl(url);
		if (!params) return false;
		try {
			const handler = this.protocolHandlers[params.action];
			if (handler) {
				await handler(params);
				return true;
			}
			if (!["open", "new", "search"].includes(params.action)) {
				new Notice(`justnotes does not support obsidian://${params.action}`);
				return false;
			}
			if (params.vault && params.vault !== this.vault.getName() && params.vault !== this.appId) {
				new Notice(`The vault "${params.vault}" is not open in justnotes`);
				return false;
			}
			if (params.path) {
				const file = this.#vaultPathOf(params.path);
				if (file === null) {
					new Notice(`${params.path} is not in this vault`);
					return false;
				}
				params.file = file;
			}
			// A URL from a note or a web page must not reach files outside the vault.
			const outside = [params.file, params.name].find((p) => p?.split(/[\\/]/).includes(".."));
			if (outside) {
				new Notice(`${outside} is not in this vault`);
				return false;
			}
			if (params.action === "search") await this.internalPlugins.getPluginById("global-search")?.instance.openGlobalSearch(params.query ?? "");
			else if (params.action === "open") await this.#uriOpen(params);
			else await this.#uriNew(params);
			return true;
		} catch (err) {
			console.error(`obsidian:// URL failed: ${url}`, err);
			new Notice(`Could not open ${url}`);
			return false;
		}
	}

	#vaultPathOf(fullPath: string) {
		const rel = nodePath.relative(this.vault.adapter.getBasePath(), fullPath);
		return rel.startsWith("..") || nodePath.isAbsolute(rel) ? null : normalizePath(rel);
	}

	async #uriOpen(params: ObsidianProtocolData) {
		if (!params.file) return;
		const [path, subpath = ""] = splitSubpath(params.file);
		const file = this.vault.getFileByPath(path) ?? this.vault.getFileByPath(`${path}.md`) ?? this.metadataCache.getFirstLinkpathDest(path, "");
		if (!file) {
			new Notice(`File not found: ${params.file}`);
			return;
		}
		if (params.append || params.prepend) await this.#insertText(file, { append: params.append, prepend: params.prepend });
		await this.workspace.openLinkText(file.path + subpath, "", paneTypeOf(params.paneType));
	}

	async #uriNew(params: ObsidianProtocolData) {
		const content = params.clipboard ? getElectron().clipboard.readText() : (params.content ?? "");
		const path = params.file ? normalizePath(/\.[^/]+$/.test(params.file) ? params.file : `${params.file}.md`) : null;
		const existing = path ? this.vault.getFileByPath(path) : null;
		let file: TFile;
		if (existing && params.append) {
			await this.#insertText(existing, { append: content });
			file = existing;
		} else if (existing && params.overwrite) {
			await this.vault.modify(existing, content);
			file = existing;
		} else if (path) file = await this.#createAt(path, content);
		else {
			const name = (params.name ?? "Untitled").replace(/\.md$/, "");
			file = await this.fileManager.createNewMarkdownFile(this.fileManager.getNewFileParent(""), name, content);
		}
		if (!params.silent) await this.workspace.getLeaf(paneTypeOf(params.paneType)).openFile(file);
	}

	// Creates the file and its folders, under a free name if the path is taken.
	async #createAt(path: string, content: string) {
		const dir = nodePath.posix.dirname(path);
		if (dir !== "." && !this.vault.getFolderByPath(dir)) await this.vault.createFolder(dir);
		const ext = nodePath.posix.extname(path);
		let target = path;
		for (let i = 1; this.vault.getAbstractFileByPath(target); i++) target = `${path.slice(0, -ext.length)} ${i}${ext}`;
		return this.vault.create(target, content);
	}

	// Appended text goes on a new line at the end; prepended text after any
	// frontmatter.
	async #insertText(file: TFile, params: { append?: string; prepend?: string }) {
		await this.vault.process(file, (text) => {
			if (params.append) text = `${text}${text && !text.endsWith("\n") ? "\n" : ""}${params.append}`;
			if (params.prepend) {
				const fm = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.exec(text)?.[0] ?? "";
				text = `${fm}${params.prepend}\n${text.slice(fm.length)}`;
			}
			return text;
		});
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
