import type { App } from "./app";
import { Component } from "./events";
import type { Command } from "./keymap";
import type { TFile } from "./vault";
import type { ViewCreator } from "./view";

// Obsidian's core plugins. Each has a wrapper whether enabled or not, as in
// Obsidian; `options` holds the plugin's <configDir>/<id>.json, read only.
const CORE_PLUGINS = [
	"file-explorer",
	"global-search",
	"switcher",
	"graph",
	"backlink",
	"canvas",
	"outgoing-link",
	"tag-pane",
	"footnotes",
	"properties",
	"page-preview",
	"daily-notes",
	"templates",
	"note-composer",
	"command-palette",
	"slash-command",
	"editor-status",
	"bookmarks",
	"markdown-importer",
	"zk-prefixer",
	"random-note",
	"outline",
	"word-count",
	"slides",
	"audio-recorder",
	"workspaces",
	"file-recovery",
	"publish",
	"sync",
	"bases",
	"webviewer",
];

// The core plugins whose instances justnotes backs with its own features
// (src/renderer/core-plugins.ts). Plugins also read the options of
// daily-notes and templates (periodic notes, QuickAdd, Templater).
// Anything else stays disabled, so plugins that probe it take their fallbacks:
// that includes switcher and command-palette, which justnotes has as commands
// but whose instances would have none of Obsidian's members.
const IMPLEMENTED = new Set([
	"file-explorer",
	"global-search",
	"graph",
	"backlink",
	"canvas",
	"outgoing-link",
	"tag-pane",
	"outline",
	"properties",
	"daily-notes",
	"templates",
	"note-composer",
	"word-count",
	"slides",
	"audio-recorder",
	"file-recovery",
	"bookmarks",
]);

// File explorer and Search are part of justnotes' window: they stay on.
export const ALWAYS_ON = new Set(["file-explorer", "global-search"]);

// Names and descriptions for the Core plugins settings, as Obsidian words them.
export const CORE_PLUGIN_INFO: Record<string, { name: string; description: string }> = {
	"file-explorer": { name: "Files", description: "See all files in your vault." },
	"global-search": { name: "Search", description: "Search for keywords in your vault." },
	graph: { name: "Graph view", description: "Shows a graph view of your notes." },
	backlink: { name: "Backlinks", description: "Shows links to the active note, and backlinks under each note." },
	canvas: { name: "Canvas", description: "Lay out notes, files and cards on an infinite canvas." },
	"outgoing-link": { name: "Outgoing links", description: "Shows the links in the active note." },
	"tag-pane": { name: "Tags view", description: "Shows all tags with the number of notes using each." },
	properties: { name: "Properties view", description: "Shows all properties used in the vault." },
	"daily-notes": { name: "Daily notes", description: "Opens today's daily note, creating it from a template." },
	templates: { name: "Templates", description: "Inserts templates into the active note." },
	"note-composer": { name: "Note composer", description: "Merges notes and extracts parts of a note into a new one." },
	bookmarks: { name: "Bookmarks", description: "Bookmark files, folders, headings, blocks, searches and graphs." },
	outline: { name: "Outline", description: "Shows the headings of the active note." },
	"word-count": { name: "Word count", description: "Shows the word and character count in the status bar." },
	slides: { name: "Slides", description: "Presents a note as a slide deck." },
	"audio-recorder": { name: "Audio recorder", description: "Record audio and save it as an attachment in a note." },
	"file-recovery": { name: "File recovery", description: "Keeps snapshots of your notes to restore lost work." },
};

export interface InternalPluginInstance {
	id: string;
	options: Record<string, any>;
	[member: string]: any;
}

// What a core plugin's features register while it is enabled: disabling it
// unloads the host, which takes them all away again (commands, ribbon
// buttons, status bar items, views, events, intervals).
export class CorePluginHost extends Component {
	app: App;
	id: string;
	// True when the user turned the plugin on in Settings, not at startup.
	userEnabled: boolean;

	constructor(app: App, id: string, userEnabled: boolean) {
		super();
		this.app = app;
		this.id = id;
		this.userEnabled = userEnabled;
	}

	addCommand(command: Command) {
		this.app.commands.addCommand(command);
		this.register(() => this.app.commands.removeCommand(command.id));
		return command;
	}

	// An editor command is also listed in commands.editorCommands.
	addEditorCommand(command: Command) {
		this.addCommand(command);
		this.app.commands.editorCommands[command.id] = command;
		return command;
	}

	addRibbonIcon(id: string, icon: string, title: string, callback: (evt: MouseEvent) => any) {
		const ribbon = this.app.workspace.leftRibbon;
		const el = ribbon.addRibbonItemButton(id, icon, title, callback);
		this.register(() => {
			ribbon.items = ribbon.items.filter((item) => item.buttonEl !== el);
			el.detach();
		});
		return el;
	}

	addStatusBarItem(cls: string) {
		const el = this.app.statusBar.createDiv(`status-bar-item ${cls}`);
		this.register(() => el.detach());
		return el;
	}

	// Open leaves of the type become placeholders while the plugin is off and
	// come back when it is turned on again, as a community plugin's do.
	registerView(type: string, creator: ViewCreator) {
		this.app.viewRegistry.registerView(type, creator);
		this.register(() => this.app.viewRegistry.unregisterView(type));
	}

	registerExtensions(extensions: string[], viewType: string) {
		this.app.viewRegistry.registerExtensions(extensions, viewType);
		this.register(() => this.app.viewRegistry.unregisterExtensions(extensions));
	}
}

export type CorePluginInstaller = (app: App, host: CorePluginHost) => void;

export class InternalPlugin {
	app: App;
	id: string;
	enabled = false;
	instance: InternalPluginInstance;
	// Set by installCorePlugins for the plugins justnotes implements.
	installer: CorePluginInstaller | null = null;
	#host: CorePluginHost | null = null;

	constructor(app: App, id: string, instance: InternalPluginInstance) {
		this.app = app;
		this.id = id;
		this.instance = instance;
	}

	// `save` records the choice in justnotes' overlay (the Core plugins
	// settings); core-plugins.json is never written.
	enable(save = false) {
		if (!IMPLEMENTED.has(this.id)) return false;
		this.enabled = true;
		if (save) this.app.internalPlugins.remember(this.id, true);
		this.start(save);
		return true;
	}

	disable(save = false) {
		this.enabled = false;
		if (save) this.app.internalPlugins.remember(this.id, false);
		const host = this.#host;
		this.#host = null;
		host?.unload();
	}

	// Installs the features of an enabled plugin, once.
	start(userEnabled = false) {
		if (!this.enabled || this.#host || !this.installer) return;
		const host = new CorePluginHost(this.app, this.id, userEnabled);
		this.#host = host;
		host.load();
		try {
			this.installer(this.app, host);
		} catch (err) {
			console.error(`Core plugin "${this.id}" failed to load`, err);
		}
	}
}

// The user's enable/disable choices from the Core plugins settings, applied
// over the vault's core-plugins.json.
export interface CoreOverlay {
	enabled: string[];
	disabled: string[];
}

export class InternalPlugins {
	app: App;
	plugins: Record<string, InternalPlugin> = {};
	// core-plugins.json as an id -> enabled map.
	config: Record<string, boolean> = {};
	#overlay: CoreOverlay = { enabled: [], disabled: [] };

	constructor(app: App) {
		this.app = app;
		for (const id of CORE_PLUGINS) this.plugins[id] = new InternalPlugin(app, id, createInstance(app, id));
	}

	async initialize() {
		const read = async (name: string) => {
			try {
				return JSON.parse(await this.app.vault.adapter.read(`${this.app.vault.configDir}/${name}.json`));
			} catch {
				return null;
			}
		};
		this.config = parseCoreConfig(await read("core-plugins"));
		const saved = this.app.loadLocalStorage?.("enabled-core-plugins");
		this.#overlay = { enabled: saved?.enabled ?? [], disabled: saved?.disabled ?? [] };
		const enabled = applyCoreOverlay(this.config, this.#overlay);
		await Promise.all(
			Object.values(this.plugins).map(async (plugin) => {
				const options = await read(plugin.id);
				if (options && typeof options === "object") plugin.instance.options = options;
				if (enabled[plugin.id]) plugin.enable();
			}),
		);
	}

	// The plugins justnotes implements get their installers; the enabled
	// ones install their features now.
	install(installers: Record<string, CorePluginInstaller>) {
		for (const [id, installer] of Object.entries(installers)) {
			const plugin = this.plugins[id];
			if (!plugin) continue;
			plugin.installer = installer;
			plugin.start();
		}
	}

	remember(id: string, enabled: boolean) {
		const { enabled: on, disabled: off } = this.#overlay;
		on.remove(id);
		off.remove(id);
		(enabled ? on : off).push(id);
		this.app.saveLocalStorage("enabled-core-plugins", this.#overlay);
	}

	getPluginById(id: string) {
		return this.plugins[id] ?? null;
	}

	getEnabledPluginById(id: string) {
		const plugin = this.plugins[id];
		return plugin?.enabled ? plugin.instance : null;
	}

	getEnabledPlugins() {
		return Object.values(this.plugins)
			.filter((p) => p.enabled)
			.map((p) => p.instance);
	}
}

// The implemented core plugins a vault without core-plugins.json starts
// with off, as Obsidian does.
const OFF_BY_DEFAULT = new Set(["slides", "audio-recorder"]);

// Whether each core plugin starts enabled: core-plugins.json, then the
// user's choices made in justnotes.
export function applyCoreOverlay(config: Record<string, boolean>, overlay: CoreOverlay) {
	const result = { ...config };
	for (const id of overlay.disabled) result[id] = false;
	for (const id of overlay.enabled) result[id] = true;
	return result;
}

// The core plugins justnotes implements, in Obsidian's order.
export function implementedCorePlugins() {
	return CORE_PLUGINS.filter((id) => IMPLEMENTED.has(id));
}

// core-plugins.json is an object of id -> boolean, or, in older vaults, an
// array of enabled ids. Without the file Obsidian's defaults apply.
export function parseCoreConfig(raw: unknown): Record<string, boolean> {
	if (Array.isArray(raw)) return Object.fromEntries(raw.filter((id) => typeof id === "string").map((id) => [id, true]));
	if (raw && typeof raw === "object") return Object.fromEntries(Object.entries(raw).map(([id, on]) => [id, on === true]));
	return Object.fromEntries([...IMPLEMENTED].filter((id) => !OFF_BY_DEFAULT.has(id)).map((id) => [id, true]));
}

function createInstance(app: App, id: string): InternalPluginInstance {
	const instance: InternalPluginInstance = { id, options: {} };
	if (id === "file-explorer") {
		instance.revealInFolder = async (file: TFile) => {
			const leaf = await app.workspace.ensureSideLeaf("file-explorer", "left", { reveal: true });
			(leaf.view as { revealInFolder?(file: TFile): void }).revealInFolder?.(file);
		};
	} else if (id === "global-search") {
		instance.openGlobalSearch = async (query: string) => {
			const leaf = await app.workspace.ensureSideLeaf("search", "left", { reveal: true });
			const input = (leaf.view as { inputEl?: HTMLInputElement }).inputEl;
			if (!input) return;
			input.value = query;
			input.dispatchEvent(new Event("input"));
			input.focus();
		};
		instance.getGlobalSearchQuery = () => {
			const leaf = app.workspace.getLeavesOfType("search")[0];
			return (leaf?.view as { inputEl?: HTMLInputElement } | undefined)?.inputEl?.value ?? "";
		};
	}
	return instance;
}
