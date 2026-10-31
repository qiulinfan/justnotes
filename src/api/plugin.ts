import * as fs from "node:fs";
import type { Extension } from "@codemirror/state";
import type { App } from "./app";
import { type BasesViewRegistration, registerBasesViewType, unregisterBasesViewType } from "./bases/view";
import { Component } from "./events";
import type { Command } from "./keymap";
import { MarkdownPreviewRenderer } from "./markdown";
import type { EditorSuggest } from "./ui/suggest";
import type { ViewCreator } from "./view";

export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
	author: string;
	description: string;
	dir?: string;
	isDesktopOnly?: boolean;
}

// A settings tab renders from getSettingDefinitions() when that returns
// items (Obsidian 1.13); display() is the imperative fallback. Rendering
// belongs to the settings window, app.setting.
export abstract class SettingTab {
	app: App;
	containerEl: HTMLElement;
	id = "";
	name = "";
	// Unset by default, as in Obsidian: the sidebar then shows no icon.
	icon = "";
	settingItems: import("./ui/setting-definitions").SettingDefinitionItem[] = [];

	constructor(app: App) {
		this.app = app;
		this.containerEl = createDiv("vertical-tab-content");
	}

	getSettingDefinitions(): SettingTab["settingItems"] {
		return [];
	}

	// Re-reads the definitions and redraws the tab if it is on screen.
	update() {
		this.settingItems = this.getSettingDefinitions();
		this.app.setting.redrawTab(this);
	}

	getControlValue(key: string): unknown {
		return this.app.vault.getConfig(key);
	}

	setControlValue(key: string, value: unknown): void | Promise<void> {
		this.app.vault.setConfig(key, value);
	}

	// Re-evaluates visible/disabled predicates in place.
	refreshDomState() {
		this.app.setting.refreshTabDomState(this);
	}

	display() {}

	// Leaves the container as display() left it: a tab that builds its settings
	// once must find them again on the next display().
	hide() {}
}

export abstract class PluginSettingTab extends SettingTab {
	plugin: Plugin;

	constructor(app: App, plugin: Plugin) {
		super(app);
		this.plugin = plugin;
		this.id = plugin.manifest.id;
		this.name = plugin.manifest.name;
	}

	getControlValue(key: string): unknown {
		return (this.plugin as Plugin & { settings?: Record<string, unknown> }).settings?.[key];
	}

	async setControlValue(key: string, value: unknown) {
		const plugin = this.plugin as Plugin & { settings?: Record<string, unknown> };
		plugin.settings ??= {};
		plugin.settings[key] = value;
		await plugin.saveData(plugin.settings);
	}
}

export interface CliFlag {
	value?: string;
	description: string;
	required?: boolean;
}

export type CliFlags = Record<string, CliFlag>;
export type CliData = Record<string, string>;
export type CliHandler = (params: CliData) => string | Promise<string>;

export class Plugin extends Component {
	app: App;
	manifest: PluginManifest;
	// Plugins assign their loaded data here (Obsidian 1.13).
	declare settings?: unknown;
	// The data.json text this plugin last read or wrote, to tell its own
	// writes apart from external ones.
	#dataText: string | undefined;

	constructor(app: App, manifest: PluginManifest) {
		super();
		this.app = app;
		this.manifest = manifest;
	}

	// Obsidian awaits a plugin's async onload before loading the next one.
	async load() {
		if (this._loaded) return;
		this._loaded = true;
		await this.onload();
		for (const child of [...this._children]) child.load();
		if (typeof this.onExternalSettingsChange === "function") this.#watchData();
	}

	onUserEnable() {}

	// Optional, as in Obsidian: called when data.json changes on disk from
	// outside the app (git, sync, an editor).
	onExternalSettingsChange?(): any;

	#dataPath() {
		return `${this.manifest.dir}/data.json`;
	}

	async loadData() {
		try {
			const text = await this.app.vault.adapter.read(this.#dataPath());
			this.#dataText = text;
			return JSON.parse(text);
		} catch {
			return null;
		}
	}

	async saveData(data: any) {
		const text = JSON.stringify(data, null, 2);
		this.#dataText = text;
		await this.app.vault.adapter.write(this.#dataPath(), text);
	}

	#watchData() {
		let watcher: fs.FSWatcher;
		try {
			watcher = fs.watch(this.app.vault.adapter.getFullPath(this.manifest.dir ?? ""));
		} catch {
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		watcher.on("change", (_type, name) => {
			if (String(name) !== "data.json") return;
			clearTimeout(timer);
			timer = setTimeout(() => this.#onDataChanged(), 200);
		});
		watcher.on("error", () => watcher.close());
		this.register(() => {
			clearTimeout(timer);
			watcher.close();
		});
	}

	async #onDataChanged() {
		let text: string;
		try {
			text = await this.app.vault.adapter.read(this.#dataPath());
		} catch {
			return;
		}
		if (text === this.#dataText || !this._loaded) return;
		this.#dataText = text;
		try {
			await this.onExternalSettingsChange?.();
		} catch (err) {
			console.error(`Plugin "${this.manifest.id}" failed to reload its settings`, err);
		}
	}

	// Like Obsidian, prefixes the given object in place (accessors on it see
	// the assignments) and registers and returns that same object.
	addCommand(command: Command) {
		command.id = `${this.manifest.id}:${command.id}`;
		command.name = `${this.manifest.name}: ${command.name}`;
		const id = command.id;
		this.app.commands.addCommand(command);
		this.register(() => this.app.commands.removeCommand(id));
		return command;
	}

	removeCommand(id: string) {
		this.app.commands.removeCommand(`${this.manifest.id}:${id}`);
	}

	// Command ids are global; a duplicate throws, as in Obsidian.
	registerCliHandler(command: string, description: string, flags: CliFlags | null, handler: CliHandler) {
		const handlers = this.app.cliHandlers;
		if (handlers.has(command)) throw new Error(`CLI command "${command}" is already registered`);
		const entry = { description, flags, handler, pluginId: this.manifest.id };
		handlers.set(command, entry);
		this.register(() => {
			if (handlers.get(command) === entry) handlers.delete(command);
		});
	}

	addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any) {
		const ribbon = this.app.workspace.leftRibbon;
		const el = ribbon.addRibbonItemButton(`${this.manifest.id}:${title}`, icon, title, callback);
		this.register(() => {
			if ("removeRibbonAction" in ribbon && typeof ribbon.removeRibbonAction === "function") ribbon.removeRibbonAction(title);
			el.detach();
		});
		return el;
	}

	addStatusBarItem() {
		const el = this.app.statusBar.createDiv(`status-bar-item plugin-${this.manifest.id.replace(/[^\w-]/g, "-")}`);
		this.register(() => el.detach());
		return el;
	}

	addSettingTab(tab: SettingTab) {
		this.app.setting.addSettingTab(tab);
		this.register(() => this.app.setting.removeSettingTab(tab));
	}

	// Like Obsidian, leaves of the type stay open when the plugin unloads: the
	// workspace turns them into placeholders that keep their state until the
	// type is registered again.
	registerView(type: string, creator: ViewCreator) {
		this.app.viewRegistry.registerView(type, creator);
		this.register(() => this.app.viewRegistry.unregisterView(type));
	}

	registerExtensions(extensions: string[], viewType: string) {
		this.app.viewRegistry.registerExtensions(extensions, viewType);
		this.register(() => this.app.viewRegistry.unregisterExtensions(extensions));
	}

	registerMarkdownPostProcessor(postProcessor: any, sortOrder?: number) {
		MarkdownPreviewRenderer.registerPostProcessor(postProcessor, sortOrder);
		this.register(() => MarkdownPreviewRenderer.unregisterPostProcessor(postProcessor));
		return postProcessor;
	}

	// Unloading removes this plugin's handler only; another plugin's handler for
	// the same language stays.
	registerMarkdownCodeBlockProcessor(language: string, handler: any, sortOrder?: number) {
		const processor = MarkdownPreviewRenderer.registerCodeBlockPostProcessor(language, handler, sortOrder);
		this.register(() => MarkdownPreviewRenderer.unregisterCodeBlockPostProcessor(language, handler));
		return processor;
	}

	// A Bases view type for the view picker, removed when the plugin unloads.
	// False when the id is taken.
	registerBasesView(viewId: string, registration: BasesViewRegistration) {
		if (!registerBasesViewType(viewId, registration)) return false;
		this.register(() => unregisterBasesViewType(viewId));
		return true;
	}

	registerEditorExtension(extension: Extension) {
		this.app.workspace.registerEditorExtension(extension);
		this.register(() => this.app.workspace.unregisterEditorExtension(extension));
	}

	registerEditorSuggest(suggest: EditorSuggest<any>) {
		this.app.workspace.editorSuggest.addSuggest(suggest);
		this.register(() => this.app.workspace.editorSuggest.removeSuggest(suggest));
	}

	// Unloading removes the registration only while it is still this one.
	registerObsidianProtocolHandler(action: string, handler: (params: any) => any) {
		const handlers = this.app.protocolHandlers;
		handlers[action] = handler;
		this.register(() => {
			if (handlers[action] === handler) delete handlers[action];
		});
	}

	registerHoverLinkSource(id: string, info: any) {
		const sources = this.app.workspace.hoverLinkSources;
		sources[id] = info;
		this.register(() => {
			if (sources[id] === info) delete sources[id];
		});
	}

	// CodeMirror 5 hooks only ran in Obsidian's legacy editor.
	registerCodeMirror(_callback: (cm: any) => any) {}
}
