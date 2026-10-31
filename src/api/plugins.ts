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

// Community plugins a core plugin of justnotes' own replaces: while that core
// plugin is on, the community one is not loaded (both would register the same
// views, extensions and commands). In Obsidian it keeps working unchanged.
export const REPLACED_BY: Record<string, string> = {};

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
	// community-plugins.json's ids, before the overlay.
	#listed: string[] = [];

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
		this.#listed = Array.isArray(ids) ? ids : [];
		for (const id of applyOverlay(this.#listed, this.#overlay)) await this.enablePlugin(id);
	}

	// The core plugin that keeps this community plugin from loading now, if any.
	replacedBy(id: string) {
		const core = REPLACED_BY[id];
		return core && this.app.internalPlugins.getPluginById(core)?.enabled ? core : null;
	}

	// A replacing core plugin turned on: the community plugins it replaces go
	// (their enabled choice stays); turned off, the enabled ones load again.
	async coreReplacementStarted(core: string) {
		for (const [id, by] of Object.entries(REPLACED_BY)) if (by === core && this.plugins[id]) await this.disablePlugin(id);
	}

	coreReplacementStopped(core: string) {
		const wanted = applyOverlay(this.#listed, this.#overlay);
		for (const [id, by] of Object.entries(REPLACED_BY)) if (by === core && wanted.includes(id)) void this.enablePlugin(id);
	}

	getPlugin(id: string) {
		return this.plugins[id] ?? null;
	}

	// Each plugin's enables and disables run one at a time, in call order: a
	// toggle flipped on and off quickly, or `justnotes plugin:enable` during
	// one, must neither load a second instance (the first would keep its
	// listeners forever) nor end in the state of an earlier call. A call made
	// while the plugin's own code runs inside one (a plugin turning itself off
	// in onload) runs at once instead, since waiting would wait for itself.
	#ops = new Map<string, Promise<unknown>>();
	#inPluginCode = new Set<string>();

	#serial<T>(id: string, task: () => Promise<T>): Promise<T> {
		if (this.#inPluginCode.has(id)) return task();
		const run = (this.#ops.get(id) ?? Promise.resolve()).then(task);
		const tail = run.then(
			() => {},
			() => {},
		);
		this.#ops.set(id, tail);
		void tail.then(() => {
			if (this.#ops.get(id) === tail) this.#ops.delete(id);
		});
		return run;
	}

	async #pluginCode<T>(id: string, run: () => T): Promise<Awaited<T>> {
		this.#inPluginCode.add(id);
		try {
			return await run();
		} finally {
			this.#inPluginCode.delete(id);
		}
	}

	enablePlugin(id: string) {
		return this.#serial(id, () => this.#enable(id));
	}

	disablePlugin(id: string) {
		return this.#serial(id, () => this.#disable(id));
	}

	// False when it did not load, or was turned off while loading.
	async #enable(id: string) {
		if (this.plugins[id]) return true;
		if (this.replacedBy(id)) return false;
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
		let plugin: Plugin | undefined;
		try {
			plugin = await this.#instantiate(manifest);
			this.plugins[id] = plugin;
			this.enabledPlugins.add(id);
			await this.#loadStyles(manifest);
			const loading = plugin;
			await this.#pluginCode(id, () => loading.load());
			return this.plugins[id] === plugin;
		} catch (err) {
			console.error(`Plugin "${id}" failed to load`, err);
			new Notice(`Failed to load plugin ${id}`);
			if (plugin && this.plugins[id] === plugin) {
				delete this.plugins[id];
				this.enabledPlugins.delete(id);
				this.#removeStyles(id);
			}
			try {
				plugin?.unload();
			} catch {}
			return false;
		} finally {
			this.loadingPluginId = null;
		}
	}

	async #disable(id: string) {
		const plugin = this.plugins[id];
		if (!plugin) return;
		delete this.plugins[id];
		this.enabledPlugins.delete(id);
		this.#removeStyles(id);
		try {
			await this.#pluginCode(id, () => plugin.unload());
		} catch (err) {
			console.error(`Plugin "${id}" failed to unload`, err);
		}
	}

	// What the Community plugins toggles call: the choice survives a restart.
	enablePluginAndSave(id: string) {
		return this.#serial(id, async () => {
			if (!(await this.#enable(id))) return false;
			this.#remember(id, true);
			try {
				this.plugins[id]?.onUserEnable();
			} catch (err) {
				console.error(`Plugin "${id}" failed in onUserEnable`, err);
			}
			return true;
		});
	}

	disablePluginAndSave(id: string) {
		return this.#serial(id, async () => {
			await this.#disable(id);
			this.#remember(id, false);
		});
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
