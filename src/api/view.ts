import type { App } from "./app";
import { Component } from "./events";
import { setIcon, setTooltip } from "./icons";
import { Scope } from "./keymap";
import type { Menu } from "./ui/menu";
import { debounce } from "./util";
import { TFile } from "./vault";
import type { WorkspaceLeaf } from "./workspace";

export interface ViewState {
	type: string;
	state?: Record<string, any>;
	active?: boolean;
	pinned?: boolean;
	group?: WorkspaceLeaf;
}

export abstract class View extends Component {
	app: App;
	leaf: WorkspaceLeaf;
	containerEl: HTMLElement;
	scope: Scope | null = null;
	icon = "document";
	navigation = false;

	constructor(leaf: WorkspaceLeaf) {
		super();
		this.leaf = leaf;
		this.app = leaf.app;
		this.containerEl = createDiv("view-content-container workspace-leaf-content");
	}

	async open(_parentEl: HTMLElement) {
		this.load();
		await this.onOpen();
	}

	async close() {
		await this.onClose();
		this.unload();
	}

	async onOpen() {}
	async onClose() {}

	abstract getViewType(): string;

	getState(): Record<string, any> {
		return {};
	}

	async setState(_state: any, _result: { history: boolean }) {}

	getEphemeralState(): Record<string, any> {
		return {};
	}

	setEphemeralState(_state: any) {}

	getIcon() {
		return this.icon;
	}

	onResize() {}

	getDisplayText() {
		return "";
	}

	onPaneMenu(_menu: Menu, _source: string) {}
}

export abstract class ItemView extends View {
	contentEl: HTMLElement;
	headerEl: HTMLElement;
	titleEl: HTMLElement;
	actionsEl: HTMLElement;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.containerEl.setAttr("data-type", "");
		this.headerEl = this.containerEl.createDiv("view-header");
		const titleWrap = this.headerEl.createDiv("view-header-title-container");
		this.titleEl = titleWrap.createDiv("view-header-title");
		this.actionsEl = this.headerEl.createDiv("view-actions");
		this.contentEl = this.containerEl.createDiv("view-content");
	}

	addAction(icon: string, title: string, callback: (evt: MouseEvent) => any) {
		const el = this.actionsEl.createEl("button", { cls: "clickable-icon view-action" });
		setIcon(el, icon);
		setTooltip(el, title);
		el.addEventListener("click", callback);
		return el;
	}
}

export abstract class FileView extends ItemView {
	file: TFile | null = null;
	allowNoFile = false;
	navigation = true;

	getDisplayText() {
		return this.file?.basename ?? "No file";
	}

	canAcceptExtension(_extension: string) {
		return false;
	}

	getState() {
		return { file: this.file?.path ?? null };
	}

	async setState(state: any, _result: { history: boolean }) {
		const file = state?.file ? this.app.vault.getFileByPath(state.file) : null;
		if (file && file !== this.file) await this.loadFile(file);
	}

	async loadFile(file: TFile) {
		if (this.file) await this.onUnloadFile(this.file);
		this.file = file;
		this.titleEl.setText(file.basename);
		await this.onLoadFile(file);
		this.leaf.updateHeader();
	}

	async onLoadFile(_file: TFile) {}
	async onUnloadFile(_file: TFile) {}

	async onRename(file: TFile) {
		this.titleEl.setText(file.basename);
		this.leaf.updateHeader();
	}

	async onClose() {
		if (this.file) await this.onUnloadFile(this.file);
	}
}

export abstract class EditableFileView extends FileView {}

export abstract class TextFileView extends EditableFileView {
	data = "";
	requestSave = debounce(() => this.save(), 2000, true);

	async onLoadFile(file: TFile) {
		this.data = await this.app.vault.read(file);
		this.setViewData(this.data, true);
	}

	async onUnloadFile(_file: TFile) {
		await this.save();
		this.clear();
	}

	async save(_clear?: boolean) {
		this.requestSave.cancel();
		if (!this.file) return;
		const data = this.getViewData();
		if (data === this.data) return;
		this.data = data;
		await this.app.vault.modify(this.file, data);
	}

	abstract getViewData(): string;
	abstract setViewData(data: string, clear: boolean): void;
	abstract clear(): void;
}

export interface ViewCreator {
	(leaf: WorkspaceLeaf): View;
}

export class ViewRegistry {
	viewByType: Record<string, ViewCreator> = {};
	typeByExtension: Record<string, string> = {};

	registerView(type: string, creator: ViewCreator) {
		if (this.viewByType[type]) throw new Error(`Attempting to register an existing view type "${type}"`);
		this.viewByType[type] = creator;
	}

	unregisterView(type: string) {
		delete this.viewByType[type];
	}

	registerExtensions(extensions: string[], type: string) {
		for (const ext of extensions) this.typeByExtension[ext] = type;
	}

	unregisterExtensions(extensions: string[]) {
		for (const ext of extensions) delete this.typeByExtension[ext];
	}

	getTypeByExtension(ext: string) {
		return this.typeByExtension[ext];
	}

	isExtensionRegistered(ext: string) {
		return ext in this.typeByExtension;
	}

	getViewCreatorByType(type: string) {
		return this.viewByType[type];
	}
}
