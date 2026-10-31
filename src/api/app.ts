import * as fs from "node:fs";
import * as nodePath from "node:path";
import { getElectron, onWindowAdded } from "./dom";
import { DragManager } from "./drag-manager";
import { FileManager } from "./file-manager";
import { InternalPlugins } from "./internal-plugins";
import { Commands, HotkeyManager, Keymap, Scope } from "./keymap";
import { MetadataCache } from "./metadata";
import { MetadataTypeManager } from "./metadata-types";
import type { CliFlags, CliHandler } from "./plugin";
import { Plugins } from "./plugins";
import { type SecretBackend, SecretStorage } from "./secret-storage";
import { SettingModal } from "./setting-modal";
import { Notice } from "./ui/notice";
import { debounce, normalizePath } from "./util";
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

// Parses an obsidian: URL into Obsidian's handler argument: the action plus
// URI-decoded query parameters, where a key without "=" is "true" and `key=`
// is empty ("+" stays a plus, as encodeURIComponent writes it). The shorthands
// obsidian://vault/<vault>/<file> and obsidian:///<absolute path> become open
// actions. Any obsidian: URL parses, with or without the slashes, because the
// OS would hand all of them to Obsidian. Returns null for other URLs.
export function parseObsidianUrl(url: string): ObsidianProtocolData | null {
	const m = /^obsidian:(?:\/\/)?([^?#]*)(?:\?([^#]*))?/i.exec(url);
	if (!m) return null;
	const params: Record<string, string> = {};
	for (const part of (m[2] ?? "").split("&")) {
		if (!part) continue;
		const eq = part.indexOf("=");
		if (eq < 0) params[decodeUriPart(part)] = "true";
		else params[decodeUriPart(part.slice(0, eq))] = decodeUriPart(part.slice(eq + 1));
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

// The file= or name= of an obsidian: URL that names no note of the vault, or
// undefined. A URL from a note or a web page must not reach files outside the
// vault, nor its hidden folders: the config folder holds plugins' code and
// settings, and `new` would write main.js or data.json there, which the vault
// index (hidden paths stay out of it) does not see as taken.
export function urlPathOutsideNotes(params: ObsidianProtocolData) {
	return [params.file, params.name].find((p) => p?.split(/[\\/]/).some((part) => part.startsWith(".")));
}

function splitSubpath(linktext: string): [string, string] {
	const i = linktext.indexOf("#");
	return i < 0 ? [linktext, ""] : [linktext.slice(0, i), linktext.slice(i)];
}

function paneTypeOf(value: string | undefined): PaneType | false {
	return value === "tab" || value === "split" || value === "window" ? value : false;
}

// The vault path of an absolute path inside `folder`, or null outside it.
function pathInside(folder: string, fullPath: string) {
	const rel = nodePath.relative(folder, fullPath);
	return rel === ".." || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel) ? null : normalizePath(rel);
}

// The real path of a file that may not exist yet: its nearest existing
// folder's real path, with the rest of the path, each name in its case on
// disk (the native realpath, as main matches vaults: cli/vaults.ts).
function realPathOf(file: string): string {
	try {
		return fs.realpathSync.native(file);
	} catch {
		const parent = nodePath.dirname(file);
		return parent === file ? file : nodePath.join(realPathOf(parent), nodePath.basename(file));
	}
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

// The theme and CSS snippets in the config folder, applied like Obsidian's.
// appearance.json (cssTheme, enabledCssSnippets) is read as the default and
// never written: choices made in justnotes persist in localStorage. The styles
// stay last in <head>, after plugin styles, so they override them.
class CustomCss {
	app: App;
	snippets: string[] = [];
	enabledSnippets = new Set<string>();
	theme = "";
	themes: Record<string, { name: string; version?: string; author?: string }> = {};
	csscache = new Map<string, string>();
	styleEl = createEl("style", { attr: { "data-justnotes": "theme" } });
	extraStyleEls: HTMLStyleElement[] = [];
	requestLoadSnippets = debounce(() => this.readSnippets(), 100, true);
	requestLoadTheme = debounce(() => this.readThemes(), 100, true);
	#watchers = new Map<string, fs.FSWatcher>();

	constructor(app: App) {
		this.app = app;
	}

	getSnippetsFolder() {
		return `${this.app.vault.configDir}/snippets`;
	}

	getSnippetPath(name: string) {
		return `${this.getSnippetsFolder()}/${name}.css`;
	}

	getThemeFolder() {
		return `${this.app.vault.configDir}/themes`;
	}

	getThemePath(name: string) {
		return `${this.getThemeFolder()}/${name}`;
	}

	// The theme and the enabled snippets are appearance.json's `cssTheme` and
	// `enabledCssSnippets`, followed when the file changes.
	async load() {
		await this.app.vault.loadConfig();
		this.#fromConfig();
		this.app.vault.on("config-changed", () => {
			const theme = this.theme;
			const snippets = [...this.enabledSnippets].join("\n");
			this.#fromConfig();
			if (this.theme !== theme) this.requestLoadTheme();
			if ([...this.enabledSnippets].join("\n") !== snippets) this.requestLoadSnippets();
		});
		await Promise.all([this.readSnippets(), this.readThemes()]);
		this.#watchFolders();
	}

	#fromConfig() {
		const theme = this.app.vault.getConfig("cssTheme");
		const snippets = this.app.vault.getConfig("enabledCssSnippets");
		this.theme = typeof theme === "string" ? theme : "";
		this.enabledSnippets = new Set(Array.isArray(snippets) ? snippets.filter((s): s is string => typeof s === "string") : []);
	}

	// Each folder is watched while it exists. The config folder's own watcher
	// sees snippets/ or themes/ appear, disappear or be replaced, which a
	// watcher on the folder itself cannot (the first snippet or theme of a vault
	// creates its folder).
	#watchFolders() {
		const folders = {
			snippets: [this.getSnippetsFolder(), () => this.requestLoadSnippets()],
			themes: [this.getThemeFolder(), () => this.requestLoadTheme()],
		} as const;
		const watch = (folder: string, reload: () => void) => {
			try {
				const watcher = fs.watch(this.app.vault.adapter.getFullPath(folder), { recursive: true }, reload);
				watcher.on("error", () => {
					watcher.close();
					if (this.#watchers.get(folder) === watcher) this.#watchers.delete(folder);
				});
				this.#watchers.set(folder, watcher);
			} catch {}
		};
		for (const [folder, reload] of Object.values(folders)) watch(folder, reload);
		try {
			const configWatcher = fs.watch(this.app.vault.adapter.getFullPath(this.app.vault.configDir), (_type, name) => {
				const entry = name === "snippets" || name === "themes" ? folders[name] : null;
				if (!entry) return;
				const [folder, reload] = entry;
				this.#watchers.get(folder)?.close();
				this.#watchers.delete(folder);
				watch(folder, reload);
				reload();
			});
			configWatcher.on("error", () => configWatcher.close());
		} catch {}
	}

	async readSnippets() {
		const read = await this.#readCss(this.getSnippetsFolder(), (name) => name.endsWith(".css"));
		this.snippets = [...read.keys()].map((name) => name.slice(0, -4)).sort();
		for (const el of this.extraStyleEls) el.remove();
		this.extraStyleEls = this.snippets
			.filter((name) => this.enabledSnippets.has(name))
			.map((name) => createEl("style", { text: read.get(`${name}.css`), attr: { "data-justnotes": `snippet:${name}` } }));
		this.#applyStyles();
	}

	async readThemes() {
		const adapter = this.app.vault.adapter;
		this.themes = {};
		try {
			for (const dir of (await adapter.list(this.getThemeFolder())).folders) {
				try {
					const manifest = JSON.parse(await adapter.read(`${dir}/manifest.json`));
					this.themes[manifest.name ?? dir.split("/").pop()] = manifest;
				} catch {}
			}
		} catch {}
		let css = "";
		if (this.theme && this.themes[this.theme]) {
			const path = `${this.getThemePath(this.theme)}/theme.css`;
			try {
				css = await adapter.read(path);
				this.csscache.set(path, css);
			} catch {}
		}
		this.styleEl.textContent = css;
		this.#applyStyles();
	}

	// Saved in appearance.json, whose config-changed reloads the styles.
	setCssEnabledStatus(name: string, enabled: boolean) {
		const snippets = (this.app.vault.getConfig("enabledCssSnippets") as unknown[]).filter((s) => s !== name);
		if (enabled) snippets.push(name);
		this.app.vault.setConfig("enabledCssSnippets", snippets);
	}

	setTheme(name: string) {
		this.app.vault.setConfig("cssTheme", name);
	}

	// Inserts plugin styles before the theme and snippets.
	insertPluginStyle(style: HTMLStyleElement) {
		document.head.insertBefore(style, this.styleEl.isConnected ? this.styleEl : (this.extraStyleEls.find((el) => el.isConnected) ?? null));
	}

	async #readCss(folder: string, wanted: (name: string) => boolean) {
		const read = new Map<string, string>();
		try {
			for (const path of (await this.app.vault.adapter.list(folder)).files) {
				const name = path.split("/").pop()!;
				if (!wanted(name)) continue;
				try {
					const css = await this.app.vault.adapter.read(path);
					this.csscache.set(path, css);
					read.set(name, css);
				} catch {}
			}
		} catch {}
		return read;
	}

	#applyStyles() {
		document.head.append(this.styleEl, ...this.extraStyleEls);
		this.app.workspace.trigger("css-change");
	}
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

export interface CliHandlerEntry {
	description: string;
	flags: CliFlags | null;
	handler: CliHandler;
	pluginId: string;
}

// The registered CLI handlers. `onChange` hears every registration and
// removal, so the app can keep the command's completion cache current
// (renderer/cli.ts).
export class CliHandlers extends Map<string, CliHandlerEntry> {
	onChange: (() => void) | null = null;

	set(command: string, entry: CliHandlerEntry) {
		super.set(command, entry);
		this.onChange?.();
		return this;
	}

	delete(command: string) {
		const had = super.delete(command);
		if (had) this.onChange?.();
		return had;
	}

	clear() {
		super.clear();
		this.onChange?.();
	}
}

export class App {
	appId: string;
	vault: Vault;
	workspace: Workspace;
	metadataCache: MetadataCache;
	metadataTypeManager: MetadataTypeManager;
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
	// Handlers plugins register with registerCliHandler, by command id; the
	// `justnotes` command runs them (renderer/cli.ts).
	cliHandlers = new CliHandlers();
	renderContext = new RenderContext();
	customCss: CustomCss;
	secretStorage: SecretStorage;
	dragManager: DragManager;
	isMobile = false;
	lastEvent: UIEvent | null = null;
	dom: AppDom;

	constructor(basePath: string) {
		// Before the keymap's listener, so a command run by a hotkey sees its own
		// keydown as lastEvent.
		const trackEvents = (win: Window) => {
			for (const type of USER_EVENTS) win.addEventListener(type, (e) => (this.lastEvent = e as UIEvent), true);
		};
		trackEvents(window);
		this.appId = vaultId(basePath);
		this.vault = new Vault(basePath);
		this.scope = new Scope();
		this.keymap = new Keymap(this.scope);
		// Popout windows: the same order, events first, then keys.
		onWindowAdded((win) => {
			trackEvents(win);
			this.keymap.attachWindow(win);
		});
		this.hotkeyManager = new HotkeyManager(this);
		this.commands = new Commands(this);
		this.scope.register(null, null, (evt, ctx) => this.hotkeyManager.onTrigger(evt, ctx));
		this.metadataCache = new MetadataCache(this.vault);
		this.metadataTypeManager = new MetadataTypeManager(this);
		this.workspace = new Workspace(this);
		this.fileManager = new FileManager(this);
		this.plugins = new Plugins(this);
		this.internalPlugins = new InternalPlugins(this);
		this.setting = new SettingModal(this);
		this.secretStorage = new SecretStorage(ipcSecretBackend(this.appId));
		this.dragManager = new DragManager(this);
		// Read straight from the config folder, so it can start before the vault
		// is scanned.
		this.customCss = new CustomCss(this);
		void this.customCss.load();
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
		// this process and would hand any obsidian: URL to the OS, so to Obsidian.
		const shell = electron.shell;
		const openExternal = shell.openExternal;
		shell.openExternal = (url: string, options?: unknown) =>
			parseObsidianUrl(url) ? this.handleObsidianUrl(url).then(() => undefined) : openExternal.call(shell, url, options);
	}

	// Dispatches an obsidian: URL inside this window: a plugin's protocol
	// handler, or the built-in open, new and search actions for this vault. A
	// path in another vault justnotes has opened goes to that vault's window.
	// Returns whether the URL was handled.
	async handleObsidianUrl(url: string) {
		const params = parseObsidianUrl(url);
		if (!params) return false;
		// Obsidian runs a URL in the vault it names: another vault justnotes has
		// opened takes it in its own window (main.ts). The path of open and new
		// overrides vault and finds its own vault below.
		const byPath = Boolean(params.path) && (params.action === "open" || params.action === "new");
		if (params.vault && !byPath && params.vault !== this.vault.getName() && params.vault !== this.appId) {
			if (await getElectron().ipcRenderer.invoke("justnotes:open-vault-named", url, params.vault)) return true;
			new Notice(`The vault "${params.vault}" is not one justnotes has opened`);
			return false;
		}
		try {
			if (Object.hasOwn(this.protocolHandlers, params.action)) {
				await this.protocolHandlers[params.action](params);
				return true;
			}
			if (!["open", "new", "search"].includes(params.action)) {
				new Notice(`justnotes does not support obsidian://${params.action}`);
				return false;
			}
			if (params.path) {
				const file = this.#vaultPathOf(params.path);
				if (file === null) {
					// Another vault that holds the path opens in its own window, if
					// it was once opened with --vault or the folder picker (main.ts).
					if (await getElectron().ipcRenderer.invoke("justnotes:open-in-vault", url, params.path)) return true;
					new Notice(`${params.path} is not in a vault justnotes has opened`);
					return false;
				}
				params.file = file;
			}
			const outside = urlPathOutsideNotes(params);
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

	// A path spelled through a symlink (/tmp for /private/tmp) is in this vault
	// too, when its real path is inside the vault's real path, as main matches
	// vaults (main/ipc.ts vaultOf).
	#vaultPathOf(fullPath: string) {
		const base = this.vault.adapter.getBasePath();
		return pathInside(base, fullPath) ?? pathInside(realPathOf(base), realPathOf(fullPath));
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

	// clipboard, append, overwrite and silent are switches: present, with a
	// value or without.
	async #uriNew(params: ObsidianProtocolData) {
		const has = (key: string) => params[key] !== undefined;
		const content = has("clipboard") ? getElectron().clipboard.readText() : (params.content ?? "");
		const path = params.file ? normalizePath(/\.[^/]+$/.test(params.file) ? params.file : `${params.file}.md`) : null;
		const existing = path ? this.vault.getFileByPath(path) : null;
		let file: TFile;
		if (existing && has("append")) {
			await this.#insertText(existing, { append: content });
			file = existing;
		} else if (existing && has("overwrite")) {
			await this.vault.modify(existing, content);
			file = existing;
		} else if (path) file = await this.#createAt(path, content);
		else {
			const name = (params.name || "Untitled").replace(/\.md$/, "");
			file = await this.fileManager.createNewMarkdownFile(this.fileManager.getNewFileParent(""), name, content);
		}
		if (!has("silent")) await this.workspace.getLeaf(paneTypeOf(params.paneType)).openFile(file);
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

	// justnotes keeps its own layout, in workspace.json's shape, instead of
	// writing Obsidian's file, so running both on one vault never fights over it.
	saveLayoutState() {
		try {
			this.saveLocalStorage("justnotes-layout", this.workspace.getLayout());
		} catch (err) {
			console.error("Could not save the workspace layout", err);
		}
	}

	// `fallback` is the layout of a vault opened for the first time.
	async restoreLayoutState(fallback?: unknown) {
		const saved = this.loadLocalStorage("justnotes-layout");
		await this.workspace.changeLayout(saved?.main?.type === "split" ? saved : fallback);
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
