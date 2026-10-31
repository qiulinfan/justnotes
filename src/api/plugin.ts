import type { Extension } from "@codemirror/state";
import type { App } from "./app";
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

export abstract class SettingTab {
	app: App;
	containerEl: HTMLElement;
	id = "";
	name = "";
	icon = "settings";

	constructor(app: App) {
		this.app = app;
		this.containerEl = createDiv("vertical-tab-content");
	}

	abstract display(): void;

	hide() {
		this.containerEl.empty();
	}
}

export abstract class PluginSettingTab extends SettingTab {
	plugin: Plugin;

	constructor(app: App, plugin: Plugin) {
		super(app);
		this.plugin = plugin;
		this.id = plugin.manifest.id;
		this.name = plugin.manifest.name;
	}
}

export class Plugin extends Component {
	app: App;
	manifest: PluginManifest;

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
	}

	onUserEnable() {}

	#dataPath() {
		return `${this.manifest.dir}/data.json`;
	}

	async loadData() {
		try {
			return JSON.parse(await this.app.vault.adapter.read(this.#dataPath()));
		} catch {
			return null;
		}
	}

	async saveData(data: any) {
		await this.app.vault.adapter.write(this.#dataPath(), JSON.stringify(data, null, 2));
	}

	onExternalSettingsChange() {}

	addCommand(command: Command) {
		const full: Command = { ...command, id: `${this.manifest.id}:${command.id}`, name: `${this.manifest.name}: ${command.name}` };
		this.app.commands.addCommand(full);
		this.register(() => this.app.commands.removeCommand(full.id));
		return full;
	}

	removeCommand(id: string) {
		this.app.commands.removeCommand(`${this.manifest.id}:${id}`);
	}

	addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any) {
		const el = this.app.workspace.leftRibbon.addRibbonItemButton(`${this.manifest.id}:${title}`, icon, title, callback);
		this.register(() => el.detach());
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

	registerView(type: string, creator: ViewCreator) {
		this.app.viewRegistry.registerView(type, creator);
		this.register(() => {
			this.app.workspace.detachLeavesOfType(type);
			this.app.viewRegistry.unregisterView(type);
		});
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

	registerMarkdownCodeBlockProcessor(language: string, handler: any, _sortOrder?: number) {
		MarkdownPreviewRenderer.registerCodeBlockPostProcessor(language, handler);
		this.register(() => MarkdownPreviewRenderer.unregisterCodeBlockPostProcessor(language));
	}

	// Obsidian returns false when Bases is not enabled in the vault; Bases views
	// already handle that.
	registerBasesView(_viewId: string, _registration: unknown) {
		return false;
	}

	registerEditorExtension(extension: Extension) {
		this.app.workspace.registerEditorExtension(extension);
		this.register(() => this.app.workspace.unregisterEditorExtension(extension));
	}

	registerEditorSuggest(suggest: EditorSuggest<any>) {
		this.app.workspace.editorSuggest.addSuggest(suggest);
		this.register(() => this.app.workspace.editorSuggest.removeSuggest(suggest));
	}

	registerObsidianProtocolHandler(action: string, handler: (params: any) => any) {
		this.app.protocolHandlers[action] = handler;
		this.register(() => delete this.app.protocolHandlers[action]);
	}

	registerHoverLinkSource(id: string, info: any) {
		this.app.workspace.hoverLinkSources[id] = info;
		this.register(() => delete this.app.workspace.hoverLinkSources[id]);
	}

	// CodeMirror 5 hooks only ran in Obsidian's legacy editor.
	registerCodeMirror(_callback: (cm: any) => any) {}
}
