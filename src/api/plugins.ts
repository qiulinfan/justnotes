import * as cmAutocomplete from "@codemirror/autocomplete";
import * as cmCollab from "@codemirror/collab";
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
import { getElectron } from "./dom";
import * as obsidian from "./index";
import type { Plugin, PluginManifest } from "./plugin";
import { Notice } from "./ui/notice";
import { debounce } from "./util";

// Modules Obsidian provides to plugins instead of letting them bundle their
// own copies; CodeMirror in particular must be the editor's own instance.
const SHARED_MODULES: Record<string, unknown> = {
	obsidian,
	"@codemirror/autocomplete": cmAutocomplete,
	"@codemirror/collab": cmCollab,
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

// Anything else resolves through the page's own Node require.
function pluginRequire(id: string) {
	if (id in SHARED_MODULES) return SHARED_MODULES[id];
	if (id === "electron") return getElectron();
	return (window as any).require(id);
}

// The user's own enable/disable choices, applied over the vault's
// community-plugins.json, which justnotes reads but never writes.
interface EnabledOverlay {
	enabled: string[];
	disabled: string[];
}

export class Plugins {
	app: App;
	manifests: Record<string, PluginManifest> = {};
	plugins: Record<string, Plugin> = {};
	enabledPlugins = new Set<string>();
	// The id of the plugin whose code is being evaluated or loaded.
	loadingPluginId: string | null = null;
	#styles = new Map<string, HTMLStyleElement>();
	#overlay: EnabledOverlay = { enabled: [], disabled: [] };

	constructor(app: App) {
		this.app = app;
	}

	getPluginFolder() {
		return `${this.app.vault.configDir}/plugins`;
	}

	// Restricted mode does not exist in justnotes: community plugins always run.
	isEnabled() {
		return true;
	}

	async loadManifest(dir: string) {
		const manifest: PluginManifest = JSON.parse(await this.app.vault.adapter.read(`${dir}/manifest.json`));
		manifest.dir = dir;
		this.manifests[manifest.id] = manifest;
		return manifest;
	}

	async loadManifests() {
		let folders: string[] = [];
		try {
			folders = (await this.app.vault.adapter.list(this.getPluginFolder())).folders;
		} catch {
			return;
		}
		for (const dir of folders) {
			try {
				await this.loadManifest(dir);
			} catch {}
		}
	}

	// Enable the plugins listed in the vault's community-plugins.json, with the
	// user's own choices applied on top. Boot initializes core plugins first, as
	// Obsidian does, so plugins can read their options while loading.
	async initialize() {
		await this.loadManifests();
		let ids: string[] = [];
		try {
			ids = JSON.parse(await this.app.vault.adapter.read(`${this.app.vault.configDir}/community-plugins.json`));
		} catch {}
		const saved = this.app.loadLocalStorage("enabled-plugins");
		this.#overlay = { enabled: saved?.enabled ?? [], disabled: saved?.disabled ?? [] };
		for (const id of applyOverlay(ids, this.#overlay)) {
			const start = performance.now();
			await this.enablePlugin(id);
			// Each plugin's load time, for profiles and startup measurements.
			performance.measure(`justnotes:plugin:${id}`, { start });
		}
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
		if (manifest.minAppVersion && !obsidian.requireApiVersion(manifest.minAppVersion)) {
			new Notice(`Plugin "${manifest.name}" needs app version ${manifest.minAppVersion} or newer.`);
			return false;
		}
		this.loadingPluginId = id;
		try {
			const plugin = await this.#instantiate(manifest);
			this.plugins[id] = plugin;
			this.enabledPlugins.add(id);
			await this.#loadStyles(manifest);
			await plugin.load();
			return true;
		} catch (err) {
			console.error(`Plugin "${id}" failed to load`, err);
			new Notice(`Failed to load plugin ${id}`);
			const plugin = this.plugins[id];
			delete this.plugins[id];
			this.enabledPlugins.delete(id);
			this.#removeStyles(id);
			try {
				plugin?.unload();
			} catch {}
			return false;
		} finally {
			this.loadingPluginId = null;
		}
	}

	async disablePlugin(id: string) {
		const plugin = this.plugins[id];
		if (!plugin) return;
		delete this.plugins[id];
		this.enabledPlugins.delete(id);
		this.#removeStyles(id);
		try {
			plugin.unload();
		} catch (err) {
			console.error(`Plugin "${id}" failed to unload`, err);
		}
	}

	// What the Community plugins toggles call: the choice survives a restart.
	async enablePluginAndSave(id: string) {
		if (!(await this.enablePlugin(id))) return false;
		this.#remember(id, true);
		try {
			this.plugins[id]?.onUserEnable();
		} catch (err) {
			console.error(`Plugin "${id}" failed in onUserEnable`, err);
		}
		return true;
	}

	async disablePluginAndSave(id: string) {
		await this.disablePlugin(id);
		this.#remember(id, false);
	}

	saveConfig() {
		this.app.saveLocalStorage("enabled-plugins", this.#overlay);
	}

	requestSaveConfig = debounce(() => this.saveConfig(), 100);

	#remember(id: string, enabled: boolean) {
		const { enabled: on, disabled: off } = this.#overlay;
		on.remove(id);
		off.remove(id);
		(enabled ? on : off).push(id);
		this.saveConfig();
	}

	async #instantiate(manifest: PluginManifest) {
		const code = await this.app.vault.adapter.read(`${manifest.dir}/main.js`);
		const module = { exports: {} as any };
		const fn = window.eval(`(function anonymous(require, module, exports){${code}\n})\n//# sourceURL=plugin:${manifest.id}`);
		fn(pluginRequire, module, module.exports);
		const PluginClass = module.exports.default ?? module.exports;
		return new PluginClass(this.app, manifest) as Plugin;
	}

	// Adding or removing a plugin's styles.css is a css-change, as in Obsidian.
	async #loadStyles(manifest: PluginManifest) {
		let css: string;
		try {
			css = await this.app.vault.adapter.read(`${manifest.dir}/styles.css`);
		} catch {
			return;
		}
		const style = createEl("style", { text: css, attr: { "data-plugin": manifest.id } });
		this.app.customCss.insertPluginStyle(style);
		this.#styles.set(manifest.id, style);
		this.app.workspace.trigger("css-change");
	}

	#removeStyles(id: string) {
		const style = this.#styles.get(id);
		if (!style) return;
		style.remove();
		this.#styles.delete(id);
		this.app.workspace.trigger("css-change");
	}
}

// The ids to enable at startup: the vault's list plus what the user turned on,
// minus what the user turned off, in the vault's order.
export function applyOverlay(ids: string[], overlay: EnabledOverlay) {
	const result = ids.filter((id) => !overlay.disabled.includes(id));
	for (const id of overlay.enabled) if (!result.includes(id)) result.push(id);
	return result;
}
