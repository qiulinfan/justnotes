import type { App } from "./app";
import type { TFile } from "./vault";

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
	"file-recovery",
]);

export interface InternalPluginInstance {
	id: string;
	options: Record<string, any>;
	[member: string]: any;
}

export class InternalPlugin {
	app: App;
	id: string;
	enabled = false;
	instance: InternalPluginInstance;

	constructor(app: App, id: string, instance: InternalPluginInstance) {
		this.app = app;
		this.id = id;
		this.instance = instance;
	}

	// In memory only: justnotes never writes core-plugins.json.
	enable() {
		if (IMPLEMENTED.has(this.id)) this.enabled = true;
		return this.enabled;
	}

	disable() {
		this.enabled = false;
	}
}

export class InternalPlugins {
	app: App;
	plugins: Record<string, InternalPlugin> = {};
	// core-plugins.json as an id -> enabled map.
	config: Record<string, boolean> = {};

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
		await Promise.all(
			Object.values(this.plugins).map(async (plugin) => {
				const options = await read(plugin.id);
				if (options && typeof options === "object") plugin.instance.options = options;
				if (this.config[plugin.id]) plugin.enable();
			}),
		);
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
const OFF_BY_DEFAULT = new Set(["slides"]);

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
