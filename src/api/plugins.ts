import * as cmAutocomplete from "@codemirror/autocomplete";
import * as cmCommands from "@codemirror/commands";
import * as cmLanguage from "@codemirror/language";
import * as cmLint from "@codemirror/lint";
import * as cmSearch from "@codemirror/search";
import * as cmState from "@codemirror/state";
import * as cmView from "@codemirror/view";
import * as lezerCommon from "@lezer/common";
import * as lezerHighlight from "@lezer/highlight";
import * as lezerLr from "@lezer/lr";
import type { App } from "./app";
import * as obsidian from "./index";
import type { Plugin, PluginManifest } from "./plugin";

// Modules Obsidian provides to plugins instead of letting them bundle their
// own copies; CodeMirror in particular must be the editor's own instance.
const SHARED_MODULES: Record<string, unknown> = {
	obsidian,
	"@codemirror/autocomplete": cmAutocomplete,
	"@codemirror/commands": cmCommands,
	"@codemirror/language": cmLanguage,
	"@codemirror/lint": cmLint,
	"@codemirror/search": cmSearch,
	"@codemirror/state": cmState,
	"@codemirror/view": cmView,
	"@lezer/common": lezerCommon,
	"@lezer/highlight": lezerHighlight,
	"@lezer/lr": lezerLr,
};

const nodeRequire: NodeJS.Require = (window as any).require;

function pluginRequire(id: string) {
	if (id in SHARED_MODULES) return SHARED_MODULES[id];
	return nodeRequire(id);
}

export class Plugins {
	app: App;
	manifests: Record<string, PluginManifest> = {};
	plugins: Record<string, Plugin> = {};
	enabledPlugins = new Set<string>();
	#styles = new Map<string, HTMLStyleElement>();

	constructor(app: App) {
		this.app = app;
	}

	get #dir() {
		return `${this.app.vault.configDir}/plugins`;
	}

	async loadManifests() {
		const adapter = this.app.vault.adapter;
		let folders: string[] = [];
		try {
			folders = (await adapter.list(this.#dir)).folders;
		} catch {
			return;
		}
		for (const dir of folders) {
			try {
				const manifest: PluginManifest = JSON.parse(await adapter.read(`${dir}/manifest.json`));
				manifest.dir = dir;
				this.manifests[manifest.id] = manifest;
			} catch {}
		}
	}

	// Enable the plugins listed in the vault's community-plugins.json. This
	// reads Obsidian's list but never writes it.
	async initialize() {
		await this.loadManifests();
		let ids: string[] = [];
		try {
			ids = JSON.parse(await this.app.vault.adapter.read(`${this.app.vault.configDir}/community-plugins.json`));
		} catch {}
		for (const id of ids) await this.enablePlugin(id);
	}

	getPlugin(id: string) {
		return this.plugins[id] ?? null;
	}

	async enablePlugin(id: string) {
		if (this.plugins[id]) return true;
		const manifest = this.manifests[id];
		if (!manifest) {
			console.warn(`Plugin "${id}" is enabled but not installed`);
			return false;
		}
		try {
			const plugin = await this.#instantiate(manifest);
			this.plugins[id] = plugin;
			this.enabledPlugins.add(id);
			await this.#loadStyles(manifest);
			await plugin.load();
			return true;
		} catch (err) {
			console.error(`Plugin "${id}" failed to load`, err);
			delete this.plugins[id];
			this.enabledPlugins.delete(id);
			return false;
		}
	}

	async disablePlugin(id: string) {
		const plugin = this.plugins[id];
		if (!plugin) return;
		delete this.plugins[id];
		this.enabledPlugins.delete(id);
		this.#styles.get(id)?.remove();
		this.#styles.delete(id);
		try {
			plugin.unload();
		} catch (err) {
			console.error(`Plugin "${id}" failed to unload`, err);
		}
	}

	async #instantiate(manifest: PluginManifest) {
		const code = await this.app.vault.adapter.read(`${manifest.dir}/main.js`);
		const module = { exports: {} as any };
		const fn = window.eval(`(function anonymous(require, module, exports){${code}\n})\n//# sourceURL=plugin:${manifest.id}`);
		fn(pluginRequire, module, module.exports);
		const PluginClass = module.exports.default ?? module.exports;
		return new PluginClass(this.app, manifest) as Plugin;
	}

	async #loadStyles(manifest: PluginManifest) {
		try {
			const css = await this.app.vault.adapter.read(`${manifest.dir}/styles.css`);
			const style = document.head.createEl("style", { attr: { "data-plugin": manifest.id } });
			style.textContent = css;
			this.#styles.set(manifest.id, style);
		} catch {}
	}
}
