import type { App } from "../app";
import { Component } from "../events";
import type { Menu } from "../ui/menu";
import { debounce } from "../util";
import { type TAbstractFile, TFile } from "../vault";
import { BaseDocument, type BasesConfigFileView, BasesViewConfig, type ViewConfigHooks, viewData } from "./config";
import { type BasesEntry, QueryRun } from "./entry";
import { invalidateLinkIndex } from "./file-fields";
import { loadPropertyTypes } from "./frontmatter";
import type { BasesPropertyId } from "./property";
import { BasesQueryResult, executeQuery } from "./query";
import { BasesToolbar } from "./toolbar";
import { impliedByFilters, type NewNote } from "./new-note";
import type { Value } from "./values";
import { type BasesView, basesViewTypes, getBasesViewType } from "./view";

// Where a base comes from: a .base file, a ```base block, or an embed.
export interface BasesSource {
	text: string;
	// The .base file, when there is one.
	file: TFile | null;
	// Where links in formulas resolve from.
	sourcePath: string;
	// The file `this` refers to.
	thisFile(): TFile | null;
	viewName?: string | null;
	// Write edited YAML back. Without it, toolbar edits last until the base closes.
	save?(text: string): void | Promise<void>;
	viewChanged?(name: string): void;
	// `this` is the active file, so the base reruns when it changes.
	followActiveFile?: boolean;
	// Extra entries for the toolbar's menu, such as opening the YAML as text.
	addMenuItems?(menu: Menu): void;
}

// Runs a base's query and keeps its view up to date. It owns the toolbar and
// the element views render into, reruns after vault and metadata changes, and
// writes view settings back to the YAML.
export class QueryController extends Component {
	app: App;
	containerEl: HTMLElement;
	document: BaseDocument;
	configs: BasesViewConfig[] = [];
	viewIndex = 0;
	view: BasesView | null = null;
	// What a view sees while it is constructed, then on every run.
	currentConfig: BasesViewConfig | null = null;
	currentResult = new BasesQueryResult();
	allProperties: BasesPropertyId[] = [];
	errors: string[] = [];
	source: BasesSource;
	#toolbar: BasesToolbar;
	#messageEl: HTMLElement;
	#viewEl: HTMLElement;
	#run: QueryRun | null = null;
	#rerun = debounce(() => this.run(), 250);
	#hooks: ViewConfigHooks = {
		changed: (config, key, value) => this.#viewChanged(config, key, value),
		evaluate: (formula) => this.evaluate(formula),
	};

	constructor(app: App, containerEl: HTMLElement, source: BasesSource) {
		super();
		this.app = app;
		this.source = source;
		this.containerEl = containerEl;
		containerEl.addClass("bases-container");
		containerEl.addEventListener("click", (evt) => this.#openTag(evt));
		this.#toolbar = new BasesToolbar(this, containerEl.createDiv("bases-header"));
		this.#messageEl = containerEl.createDiv("bases-message");
		this.#viewEl = containerEl.createDiv("bases-view");
		this.document = this.#parse(source.text, source.viewName ?? null);
	}

	onload() {
		const rerun = () => this.requestRun();
		this.registerEvent(this.app.metadataCache.on("changed", rerun));
		this.registerEvent(this.app.metadataCache.on("resolved", rerun));
		for (const name of ["create", "delete", "rename"]) this.registerEvent(this.app.vault.on(name, rerun));
		this.registerEvent(this.app.vault.on("modify", (f: TAbstractFile) => f instanceof TFile && f.extension !== "md" && rerun()));
		if (this.source.followActiveFile) this.registerEvent(this.app.workspace.on("file-open", rerun));
		this.registerEvent(
			basesViewTypes.on("changed", (id: string) => {
				if (viewData(this.configs[this.viewIndex]).type === id) this.#mount();
			}),
		);
		loadPropertyTypes(this.app).then(rerun);
		this.#mount();
	}

	onunload() {
		this.#rerun.cancel();
		this.view = null;
		this.containerEl.empty();
	}

	get viewName() {
		return this.configs[this.viewIndex]?.name ?? "";
	}

	requestRun() {
		this.#rerun();
	}

	// Replace the YAML, as when the .base file changes on disk. The view stays
	// selected if one of the same name exists.
	setSource(text: string) {
		if (text === this.document.text) return;
		this.source.text = text;
		this.document = this.#parse(text, this.viewName);
		this.#mount();
	}

	#parse(text: string, viewName: string | null) {
		const document = new BaseDocument(text);
		this.configs = document.views.map((view) => new BasesViewConfig(view, document.config, this.#hooks));
		const named = viewName ? this.configs.findIndex((c) => c.name === viewName) : -1;
		this.viewIndex = Math.max(0, named);
		return document;
	}

	selectView(index: number) {
		if (index === this.viewIndex || !this.configs[index]) return;
		this.viewIndex = index;
		this.source.viewChanged?.(this.viewName);
		this.#mount();
	}

	addView(type: string) {
		const names = new Set(this.configs.map((c) => c.name));
		const base = getBasesViewType(type)?.name ?? type;
		let name = base;
		for (let i = 2; names.has(name); i++) name = `${base} ${i}`;
		const view: BasesConfigFileView = { type, name };
		this.#persist(this.document.addView(view));
		this.configs.push(new BasesViewConfig(view, this.document.config, this.#hooks));
		this.selectView(this.configs.length - 1);
	}

	removeView(index: number) {
		if (this.configs.length < 2) return;
		this.#persist(this.document.removeView(index));
		this.configs.splice(index, 1);
		if (this.viewIndex >= this.configs.length || index === this.viewIndex) {
			this.viewIndex = Math.min(this.viewIndex, this.configs.length - 1);
			this.source.viewChanged?.(this.viewName);
			this.#mount();
		} else if (index < this.viewIndex) this.viewIndex--;
		this.#toolbar.update();
	}

	// Change a top-level key such as `formulas` or `properties`.
	setBaseKey(path: string[], value: unknown) {
		this.#persist(this.document.setIn(path, value));
		this.run();
	}

	#viewChanged(config: BasesViewConfig, key: string, value: unknown) {
		const index = this.configs.indexOf(config);
		if (index < 0) return;
		this.#persist(this.document.setViewKey(index, key, value));
		if (key === "name") {
			this.#toolbar.update();
			if (index === this.viewIndex) this.source.viewChanged?.(this.viewName);
		}
		if (index !== this.viewIndex) return;
		if (key === "type") this.#mount();
		else this.requestRun();
	}

	#persist(text: string) {
		this.source.text = text;
		Promise.resolve(this.source.save?.(text)).catch((err) => console.error("Could not save the base", err));
	}

	// Create the selected view's instance from its type's factory.
	#mount() {
		if (this.view) this.removeChild(this.view);
		this.view = null;
		this.#viewEl.empty();
		this.#toolbar.update();
		if (this.document.error) {
			this.#showMessages();
			return;
		}
		const config = this.configs[this.viewIndex];
		const type = viewData(config).type;
		const registration = getBasesViewType(type);
		if (!registration) {
			this.#viewEl.createDiv({ cls: "bases-view-missing", text: `No view type "${type}" is installed. Pick another layout in the view menu.` });
			this.run();
			return;
		}
		this.currentConfig = config;
		try {
			this.view = this.addChild(registration.factory(this, this.#viewEl));
		} catch (err) {
			console.error(`Bases view "${type}" failed to start`, err);
			this.#viewEl.createDiv({ cls: "bases-view-missing", text: `The "${registration.name}" view failed to start.` });
		}
		this.run();
	}

	run() {
		this.#rerun.cancel();
		const config = this.configs[this.viewIndex];
		if (this.document.error || !config) {
			this.#showMessages();
			return;
		}
		invalidateLinkIndex(this.app);
		const thisFile = this.source.thisFile();
		this.#run = new QueryRun(this.app, this.document.config.formulas, thisFile, this.source.sourcePath);
		const out = executeQuery(this.#run, this.document.config, config, this.app.vault.getFiles());
		this.currentConfig = config;
		this.currentResult = out.result;
		this.allProperties = out.allProperties;
		this.errors = out.errors;
		this.#toolbar.update();
		this.#showMessages();
		const view = this.view;
		if (!view) return;
		view.data = out.result;
		view.allProperties = out.allProperties;
		try {
			view.onDataUpdated();
		} catch (err) {
			console.error(`Bases view "${view.type}" failed to render`, err);
		}
	}

	#showMessages() {
		this.#messageEl.empty();
		const messages = this.document.error ? [this.document.error] : this.errors;
		for (const text of messages) this.#messageEl.createDiv({ cls: "bases-message-item mod-warning", text });
	}

	// A tag in any view searches the vault for it: through the global search
	// core plugin when there is one, else the search pane.
	#openTag(evt: MouseEvent) {
		const tag = (evt.target as HTMLElement).closest("a.tag")?.textContent;
		if (!tag) return;
		evt.preventDefault();
		const search = (this.app.internalPlugins.getPluginById("global-search") as { instance?: { openGlobalSearch?(q: string): void } } | null)?.instance;
		if (search?.openGlobalSearch) return search.openGlobalSearch(`tag:${tag}`);
		const leaf = this.app.workspace.getLeavesOfType("search")[0];
		const input = (leaf?.view as { inputEl?: HTMLInputElement } | undefined)?.inputEl;
		if (!leaf || !input) return;
		this.app.workspace.revealLeaf(leaf);
		input.value = tag;
		input.dispatchEvent(new Event("input"));
	}

	#currentRun() {
		this.#run ??= new QueryRun(this.app, this.document.config.formulas, this.source.thisFile(), this.source.sourcePath);
		return this.#run;
	}

	// Evaluate a formula against `this`, as view options of type formula are.
	evaluate(formula: string): Value {
		const run = this.#currentRun();
		return run.evaluate(formula, run.thisEntry);
	}

	evaluateFor(entry: BasesEntry, formula: string): Value {
		return this.#currentRun().evaluate(formula, entry);
	}

	async createFileForView(baseFileName?: string, frontmatterProcessor?: (frontmatter: any, file: TFile) => void) {
		const config = this.configs[this.viewIndex];
		const implied: NewNote = { frontmatter: {}, tags: [] };
		impliedByFilters([this.document.config.filters, config ? viewData(config).filters : undefined], implied);
		const folder = (implied.folder && this.app.vault.getFolderByPath(implied.folder)) || this.app.fileManager.getNewFileParent(this.source.sourcePath);
		const file = await this.app.fileManager.createNewMarkdownFile(folder, baseFileName ?? "Untitled");
		if (Object.keys(implied.frontmatter).length || implied.tags.length || frontmatterProcessor) {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				Object.assign(fm, implied.frontmatter);
				if (implied.tags.length) fm.tags = [...new Set([...(Array.isArray(fm.tags) ? fm.tags : []), ...implied.tags])];
				frontmatterProcessor?.(fm, file);
			});
		}
		await this.app.workspace.getLeaf("tab").openFile(file);
	}
}
